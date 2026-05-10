/**
 * Parse uploaded files into raw text. Supports .txt, .md, and .zip (of txt/md).
 * Extension point: register additional parsers for PDF, DOCX, etc.
 */

import fs from "node:fs";
import path from "node:path";
import unzipper from "unzipper";

export interface ParsedDocument {
    /** Display name (filename or archive entry path). */
    name: string;
    /** Plain text content. */
    text: string;
    /**
     * Stable id for dedupe within an org (e.g. Slack client_msg_id). When set, DB skips duplicates.
     */
    ingestKey?: string;
}

export type DocumentHandler = (doc: ParsedDocument) => Promise<void> | void;
export type DocumentParser =
    | ((buffer: Buffer, filename: string) => Promise<ParsedDocument[]> | ParsedDocument[])
    | ((filePath: string, filename: string) => Promise<ParsedDocument[]> | ParsedDocument[]);

const TEXT_EXT = new Set([".txt", ".text", ".md", ".markdown"]);

function isTextExt(ext: string): boolean {
    return TEXT_EXT.has(ext.toLowerCase());
}

/** Parse a single .txt or .md file. */
function parseText(buffer: Buffer, filename: string): ParsedDocument[] {
    const text = buffer.toString("utf-8");
    return [{ name: filename, text }];
}

/** Parse .zip: each .txt/.md entry becomes one ParsedDocument (collected in memory). */
async function parseZipFromPath(filePath: string, _filename: string): Promise<ParsedDocument[]> {
    const stat = await fs.promises.stat(filePath);
    // Basic safety limit: e.g. 200 MB
    const MAX_ZIP_SIZE_BYTES = 200 * 1024 * 1024;
    if (stat.size > MAX_ZIP_SIZE_BYTES) {
        throw new Error("Zip file too large to ingest");
    }

    const out: ParsedDocument[] = [];
    const directory = await unzipper.Open.file(filePath);

    // Optional safety: limit number of entries processed
    const MAX_ENTRIES = 1000;
    let processed = 0;

    for (const entry of directory.files) {
        if (entry.type === "Directory") continue;
        if (processed >= MAX_ENTRIES) {
            throw new Error("Zip contains too many entries to ingest");
        }

        const name = entry.path;
        const ext = path.extname(name) || "";
        if (!isTextExt(ext)) continue;

        const stream = entry.stream();
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
            stream.on("data", (chunk: Buffer) => chunks.push(chunk));
            stream.on("end", () => resolve());
            stream.on("error", reject);
        });
        const text = Buffer.concat(chunks).toString("utf-8");
        out.push({ name, text });
        processed += 1;
    }

    return out;
}

/** Parse .zip and invoke a handler per ParsedDocument, without holding all in memory at once. */
async function parseZipFromPathStreaming(
    filePath: string,
    _filename: string,
    handle: DocumentHandler
): Promise<void> {
    console.log("Parsing zip from path streaming: ", filePath);
    const stat = await fs.promises.stat(filePath);
    const MAX_ZIP_SIZE_BYTES = 200 * 1024 * 1024;
    if (stat.size > MAX_ZIP_SIZE_BYTES) {
        throw new Error("Zip file too large to ingest");
    }

    const directory = await unzipper.Open.file(filePath);

    const MAX_ENTRIES = 1000;
    let processed = 0;

    for (const entry of directory.files) {
        if (entry.type === "Directory") continue;
        if (processed >= MAX_ENTRIES) {
            throw new Error("Zip contains too many entries to ingest");
        }

        const name = entry.path;
        const ext = path.extname(name) || "";
        if (!isTextExt(ext)) continue;

        const stream = entry.stream();
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
            stream.on("data", (chunk: Buffer) => chunks.push(chunk));
            stream.on("end", () => resolve());
            stream.on("error", reject);
        });
        const text = Buffer.concat(chunks).toString("utf-8");
        await handle({ name, text });
        processed += 1;
    }
}

const parsersByExt: Record<string, DocumentParser> = {
    ".txt": parseText,
    ".text": parseText,
    ".md": parseText,
    ".markdown": parseText,
    // For .zip we expect a file path to be passed to parseDocumentFromPath
    ".zip": parseZipFromPath as any,
};

/**
 * Register a parser for additional extensions (e.g. PDF, DOCX).
 * Overwrites any existing parser for that extension.
 */
export function registerParser(ext: string, parser: DocumentParser): void {
    parsersByExt[ext.toLowerCase()] = parser;
}

/**
 * Parse a file buffer by filename (extension). Returns one or more documents.
 * @throws if extension is unsupported
 */
export async function parseDocument(buffer: Buffer, filename: string): Promise<ParsedDocument[]> {
    const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";
    const parser = parsersByExt[ext.toLowerCase()];
    if (!parser) {
        throw new Error(`Unsupported document format: ${ext || "(no extension)"}. Supported: .txt, .md, .zip`);
    }
    // @ts-expect-error we know this parser takes (buffer, filename)
    return parser(buffer, filename);
}

/**
 * Parse a file by path and filename (for streaming from disk, e.g. large zips).
 */
export async function parseDocumentFromPath(filePath: string, filename: string): Promise<ParsedDocument[]> {
    const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";
    const parser = parsersByExt[ext.toLowerCase()];
    if (!parser) {
        throw new Error(`Unsupported document format: ${ext || "(no extension)"}. Supported: .txt, .md, .zip`);
    }
    if (ext.toLowerCase() === ".zip") {
        // For zips we call the streaming parser with the file path.
        return (parser as any)(filePath, filename);
    }
    // For non-zip, fall back to reading the whole file (still from disk, not request memory).
    const buffer = await fs.promises.readFile(filePath);
    // @ts-expect-error parser is buffer-based here
    return parser(buffer, filename);
}

/**
 * Parse a file by path and call a handler for each ParsedDocument as it is produced.
 * For .zip files this streams entries one by one; for others it parses then iterates.
 */
export async function parseAndHandleFromPath(
    filePath: string,
    filename: string,
    handle: DocumentHandler
): Promise<void> {
    const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";
    const lower = ext.toLowerCase();
    if (lower === ".zip") {
        await parseZipFromPathStreaming(filePath, filename, handle);
        return;
    }
    const docs = await parseDocumentFromPath(filePath, filename);
    for (const doc of docs) {
        await handle(doc);
    }
}

export function getSupportedExtensions(): string[] {
    return [...new Set(Object.keys(parsersByExt))];
}
