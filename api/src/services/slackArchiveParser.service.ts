/**
 * Parse Slack export / dump zip archives: JSON arrays or NDJSON lines of message objects
 * (same shape as api/sample/slack.json). Emits one ParsedDocument per message for ingest.
 */

import fs from "node:fs";
import path from "node:path";
import unzipper from "unzipper";
import type { DocumentHandler, ParsedDocument } from "./documentParser.service.js";
import { logger } from "../logger.js";

type SlackJsonShape = "array" | "object" | "ndjson" | "empty";

function detectSlackJsonShape(raw: string): SlackJsonShape {
    const t = raw.trim();
    if (!t) return "empty";
    if (t.startsWith("[")) return "array";
    if (t.startsWith("{")) return "object";
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

function channelLabelFromPath(entryPath: string): string {
    const parts = entryPath.split("/").filter(Boolean);
    if (parts.length >= 2) return parts[parts.length - 2];
    if (parts.length === 1) return path.basename(parts[0], ".json");
    return "slack";
}

function formatMessageDoc(obj: Record<string, unknown>, entryPath: string): ParsedDocument | null {
    const text = typeof obj.text === "string" ? obj.text : "";
    const trimmed = text.trim();
    if (!trimmed) return null;

    const tsRaw = obj.ts;
    const ts = typeof tsRaw === "string" ? tsRaw : tsRaw != null ? String(tsRaw) : "";
    const prof = obj.user_profile as Record<string, unknown> | undefined;
    const userLabel =
        (prof && typeof prof.display_name === "string" && prof.display_name.trim()) ||
        (prof && typeof prof.real_name === "string" && prof.real_name.trim()) ||
        (typeof obj.user === "string" ? obj.user : "unknown");

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
    const clientMsgId =
        typeof obj.client_msg_id === "string" ? obj.client_msg_id.trim() : "";
    const ingestKey = clientMsgId
        ? `slack:msg:${clientMsgId}`
        : `slack:loc:${normPath}#${ts}`;
    return { name, text: body, ingestKey };
}

function extractMessagesFromJsonContent(
    raw: string,
    entryPath: string,
    stats?: { nonMessageObjects: number; emptyTextSkipped: number }
): ParsedDocument[] {
    const trimmed = raw.trim();
    const out: ParsedDocument[] = [];
    if (!trimmed) return out;

    const pushIfMessage = (obj: unknown) => {
        if (!obj || typeof obj !== "object") return;
        const o = obj as Record<string, unknown>;
        if (o.type !== "message") {
            if (stats) stats.nonMessageObjects += 1;
            return;
        }
        const doc = formatMessageDoc(o, entryPath);
        if (doc) out.push(doc);
        else if (stats) stats.emptyTextSkipped += 1;
    };

    if (trimmed.startsWith("[")) {
        try {
            const arr = JSON.parse(trimmed) as unknown;
            if (Array.isArray(arr)) {
                for (const item of arr) pushIfMessage(item);
            }
        } catch {
            return out;
        }
        return out;
    }

    if (trimmed.startsWith("{")) {
        try {
            pushIfMessage(JSON.parse(trimmed));
        } catch {
            return out;
        }
        return out;
    }

    const lines = trimmed.split("\n");
    for (const line of lines) {
        const ln = line.trim();
        if (!ln) continue;
        try {
            pushIfMessage(JSON.parse(ln));
        } catch {
            /* skip malformed line */
        }
    }
    return out;
}

function shouldParseSlackJsonEntry(entryPath: string): boolean {
    const lower = entryPath.toLowerCase();
    if (!lower.endsWith(".json")) return false;
    const base = path.basename(lower);
    if (SKIP_JSON_BASENAMES.has(base)) return false;
    return true;
}

/**
 * Walk a Slack-style zip on disk and invoke handler once per message document.
 */
export async function parseSlackArchiveZipStreaming(
    filePath: string,
    archiveFilename: string,
    handle: DocumentHandler
): Promise<void> {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > MAX_ZIP_SIZE_BYTES) {
        throw new Error("Zip file too large to ingest");
    }

    const directory = await unzipper.Open.file(filePath);
    const allEntries = directory.files.filter((e) => e.type !== "Directory");
    const candidateJson = allEntries.filter((e) => shouldParseSlackJsonEntry(e.path));

    logger.debug(
        {
            archiveFilename,
            filePath,
            zipSizeBytes: stat.size,
            zipEntryCount: allEntries.length,
            slackJsonCandidateCount: candidateJson.length,
        },
        "slack parser: opened archive"
    );

    let jsonFilesProcessed = 0;
    let messagesEmitted = 0;
    let entriesSkippedNotJson = 0;
    let entriesSkippedMetadata = 0;

    for (const entry of directory.files) {
        if (entry.type === "Directory") continue;
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
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
            stream.on("data", (chunk: Buffer) => chunks.push(chunk));
            stream.on("end", () => resolve());
            stream.on("error", reject);
        });
        const raw = Buffer.concat(chunks).toString("utf-8");
        const shape = detectSlackJsonShape(raw);
        const lineStats = { nonMessageObjects: 0, emptyTextSkipped: 0 };
        const docs = extractMessagesFromJsonContent(raw, name, lineStats);

        logger.debug(
            {
                entryPath: name,
                jsonShape: shape,
                rawChars: raw.length,
                messagesInFile: docs.length,
                nonMessageObjects: lineStats.nonMessageObjects,
                emptyTextSkipped: lineStats.emptyTextSkipped,
            },
            "slack parser: parsed JSON log file"
        );

        for (const doc of docs) {
            await handle(doc);
            messagesEmitted += 1;
        }
        jsonFilesProcessed += 1;
    }

    logger.debug(
        {
            archiveFilename,
            jsonFilesProcessed,
            messagesEmitted,
            entriesSkippedNotJson,
            entriesSkippedMetadata,
        },
        "slack parser: archive walk complete"
    );
}
