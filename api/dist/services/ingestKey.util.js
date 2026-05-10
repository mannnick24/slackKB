import { createHash } from "node:crypto";
/**
 * Deterministic key for plain-text / markdown chunks so re-uploading the same bytes skips duplicates.
 */
export function ingestKeyForTextChunk(orgId, uploadLabel, documentPath, chunkIndex, text) {
    const h = createHash("sha256")
        .update(orgId, "utf8")
        .update("\0", "utf8")
        .update(uploadLabel, "utf8")
        .update("\0", "utf8")
        .update(documentPath, "utf8")
        .update("\0", "utf8")
        .update(String(chunkIndex), "utf8")
        .update("\0", "utf8")
        .update(text, "utf8")
        .digest("hex");
    return `txt:${h}`;
}
