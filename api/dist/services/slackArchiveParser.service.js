/**
 * Parse Slack export / dump zip archives: JSON arrays or NDJSON lines of message objects
 * (same shape as api/sample/slack.json). Emits one ParsedDocument per message for ingest.
 */
import fs from "node:fs";
import path from "node:path";
import unzipper from "unzipper";
import { logger } from "../logger.js";
function detectSlackJsonShape(raw) {
    const t = raw.trim();
    if (!t)
        return "empty";
    if (t.startsWith("["))
        return "array";
    if (t.startsWith("{"))
        return "object";
    return "ndjson";
}
/** Known Slack export root JSON files that are not per-channel message logs. */
const SKIP_JSON_BASENAMES = new Set([
    "users.json",
    "channels.json",
    "integration_logs.json",
    "emoji.json",
]);
const MAX_ZIP_SIZE_BYTES = 200 * 1024 * 1024;
/** Slack exports can contain many daily JSON files across channels. */
const MAX_JSON_ENTRIES = 8000;
function channelLabelFromPath(entryPath) {
    const parts = entryPath.split("/").filter(Boolean);
    if (parts.length >= 2)
        return parts[parts.length - 2];
    if (parts.length === 1)
        return path.basename(parts[0], ".json");
    return "slack";
}
/** Slack message ts is Unix seconds with fractional part as string. */
function slackTsToMessageAt(ts) {
    const n = parseFloat(ts);
    if (!Number.isFinite(n))
        return null;
    return new Date(n * 1000);
}
function formatMessageDoc(obj, entryPath) {
    const text = typeof obj.text === "string" ? obj.text : "";
    const trimmed = text.trim();
    if (!trimmed)
        return null;
    const tsRaw = obj.ts;
    const ts = typeof tsRaw === "string" ? tsRaw : tsRaw != null ? String(tsRaw) : "";
    const prof = obj.user_profile;
    const userLabel = (prof && typeof prof.display_name === "string" && prof.display_name.trim()) ||
        (prof && typeof prof.real_name === "string" && prof.real_name.trim()) ||
        (typeof obj.user === "string" ? obj.user : "unknown");
    const userIdRaw = typeof obj.user === "string" ? obj.user.trim() : "";
    const userId = userIdRaw.length > 0 ? userIdRaw : null;
    const channel = channelLabelFromPath(entryPath);
    const body = [
        `Channel: ${channel}`,
        `Timestamp: ${ts}`,
        `Author: ${userLabel}`,
        "",
        trimmed,
    ].join("\n");
    const safeTs = ts.replace(/\./g, "_");
    const name = `${entryPath}#${safeTs}`;
    const normPath = entryPath.replace(/\\/g, "/");
    const clientMsgId = typeof obj.client_msg_id === "string" ? obj.client_msg_id.trim() : "";
    const ingestKey = clientMsgId
        ? `slack:msg:${clientMsgId}`
        : `slack:loc:${normPath}#${ts}`;
    const messageAt = slackTsToMessageAt(ts);
    return {
        name,
        text: body,
        ingestKey,
        slack: {
            messageAt,
            channel,
            userId,
            userLabel: String(userLabel),
        },
    };
}
function extractMessagesFromJsonContent(raw, entryPath, stats) {
    const trimmed = raw.trim();
    const out = [];
    if (!trimmed)
        return out;
    const pushIfMessage = (obj) => {
        if (!obj || typeof obj !== "object")
            return;
        const o = obj;
        if (o.type !== "message") {
            if (stats)
                stats.nonMessageObjects += 1;
            return;
        }
        const doc = formatMessageDoc(o, entryPath);
        if (doc)
            out.push(doc);
        else if (stats)
            stats.emptyTextSkipped += 1;
    };
    if (trimmed.startsWith("[")) {
        try {
            const arr = JSON.parse(trimmed);
            if (Array.isArray(arr)) {
                for (const item of arr)
                    pushIfMessage(item);
            }
        }
        catch {
            return out;
        }
        return out;
    }
    if (trimmed.startsWith("{")) {
        try {
            pushIfMessage(JSON.parse(trimmed));
        }
        catch {
            return out;
        }
        return out;
    }
    const lines = trimmed.split("\n");
    for (const line of lines) {
        const ln = line.trim();
        if (!ln)
            continue;
        try {
            pushIfMessage(JSON.parse(ln));
        }
        catch {
            /* skip malformed line */
        }
    }
    return out;
}
function shouldParseSlackJsonEntry(entryPath) {
    const lower = entryPath.toLowerCase();
    if (!lower.endsWith(".json"))
        return false;
    const base = path.basename(lower);
    if (SKIP_JSON_BASENAMES.has(base))
        return false;
    return true;
}
/**
 * Walk a Slack-style zip on disk and invoke handler once per message document.
 */
export async function parseSlackArchiveZipStreaming(filePath, archiveFilename, handle) {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > MAX_ZIP_SIZE_BYTES) {
        throw new Error("Zip file too large to ingest");
    }
    const directory = await unzipper.Open.file(filePath);
    const allEntries = directory.files.filter((e) => e.type !== "Directory");
    const candidateJson = allEntries.filter((e) => shouldParseSlackJsonEntry(e.path));
    logger.debug({
        archiveFilename,
        filePath,
        zipSizeBytes: stat.size,
        zipEntryCount: allEntries.length,
        slackJsonCandidateCount: candidateJson.length,
    }, "slack parser: opened archive");
    let jsonFilesProcessed = 0;
    let messagesEmitted = 0;
    let entriesSkippedNotJson = 0;
    let entriesSkippedMetadata = 0;
    for (const entry of directory.files) {
        if (entry.type === "Directory")
            continue;
        const name = entry.path;
        const lower = name.toLowerCase();
        if (!lower.endsWith(".json")) {
            entriesSkippedNotJson += 1;
            continue;
        }
        const base = path.basename(lower);
        if (SKIP_JSON_BASENAMES.has(base)) {
            entriesSkippedMetadata += 1;
            logger.debug({ entryPath: name, reason: "metadata_json" }, "slack parser: skip file");
            continue;
        }
        if (jsonFilesProcessed >= MAX_JSON_ENTRIES) {
            throw new Error("Slack archive contains too many JSON files to ingest");
        }
        const stream = entry.stream();
        const chunks = [];
        await new Promise((resolve, reject) => {
            stream.on("data", (chunk) => chunks.push(chunk));
            stream.on("end", () => resolve());
            stream.on("error", reject);
        });
        const raw = Buffer.concat(chunks).toString("utf-8");
        const shape = detectSlackJsonShape(raw);
        const lineStats = { nonMessageObjects: 0, emptyTextSkipped: 0 };
        const docs = extractMessagesFromJsonContent(raw, name, lineStats);
        logger.debug({
            entryPath: name,
            jsonShape: shape,
            rawChars: raw.length,
            messagesInFile: docs.length,
            nonMessageObjects: lineStats.nonMessageObjects,
            emptyTextSkipped: lineStats.emptyTextSkipped,
        }, "slack parser: parsed JSON log file");
        for (const doc of docs) {
            await handle(doc);
            messagesEmitted += 1;
        }
        jsonFilesProcessed += 1;
    }
    logger.debug({
        archiveFilename,
        jsonFilesProcessed,
        messagesEmitted,
        entriesSkippedNotJson,
        entriesSkippedMetadata,
    }, "slack parser: archive walk complete");
}
