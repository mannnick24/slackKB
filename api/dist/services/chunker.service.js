/**
 * Chunk text for RAG. Strategy and limits come from config.
 */
import { config } from "../config.js";
/**
 * Rough token count from chars (when no tokenizer available).
 */
function charsToTokens(chars) {
    const safeCharsPerToken = Math.max(config.chunking.charsPerToken || 4, 1);
    return Math.ceil(chars / safeCharsPerToken);
}
/**
 * Split text into paragraphs/sections (double newline or heading-like lines).
 */
function splitByParagraphs(text) {
    const normalized = text.replace(/\r\n/g, "\n").trim();
    const blocks = normalized.split(/\n\s*\n/).filter((b) => b.trim().length > 0);
    return blocks;
}
/**
 * Fixed-size chunking with overlap. Uses char count and charsPerToken.
 */
function chunkFixed(text) {
    const safeCharsPerToken = Math.max(config.chunking.charsPerToken || 4, 1);
    const safeChunkSizeTokens = Math.max(config.chunking.chunkSizeTokens || 1, 1);
    const safeOverlapTokens = Math.max(config.chunking.overlapTokens || 0, 0);
    const targetChars = safeChunkSizeTokens * safeCharsPerToken;
    const overlapChars = safeOverlapTokens * safeCharsPerToken;
    const chunks = [];
    let start = 0;
    let index = 0;
    while (start < text.length) {
        let end = Math.min(start + targetChars, text.length);
        let slice = text.slice(start, end);
        if (end < text.length) {
            const lastSpace = slice.lastIndexOf(" ");
            if (lastSpace > targetChars * 0.5) {
                end = start + lastSpace + 1;
                slice = text.slice(start, end);
            }
        }
        const trimmed = slice.trim();
        if (trimmed.length > 0) {
            chunks.push({ text: trimmed, index: index++ });
        }
        if (end >= text.length || overlapChars <= 0) {
            break;
        }
        // Ensure we always make forward progress; if overlap would keep us at the same
        // or a previous position, move start to end instead (no overlap for this step).
        const effectiveOverlap = Math.min(overlapChars, Math.max(slice.length - 1, 0));
        const nextStart = end - effectiveOverlap;
        if (nextStart <= start) {
            start = end;
        }
        else {
            start = nextStart;
        }
    }
    return chunks;
}
/**
 * Chunk by paragraph/section: group paragraphs until ~chunkSizeTokens, then emit.
 */
function chunkByParagraph(text) {
    const paragraphs = splitByParagraphs(text);
    const safeChunkSizeTokens = Math.max(config.chunking.chunkSizeTokens || 1, 1);
    const safeOverlapTokens = Math.max(config.chunking.overlapTokens || 0, 0);
    const charsPerToken = Math.max(config.chunking.charsPerToken || 4, 1);
    const chunks = [];
    let current = [];
    let currentTokens = 0;
    let index = 0;
    for (const p of paragraphs) {
        const pTokens = charsToTokens(p.length);
        if (currentTokens + pTokens > safeChunkSizeTokens && current.length > 0) {
            const textChunk = current.join("\n\n").trim();
            if (textChunk.length > 0) {
                chunks.push({ text: textChunk, index: index++ });
            }
            const overlapChars = safeOverlapTokens * charsPerToken;
            const overlapParas = [];
            let overlapCount = 0;
            for (let i = current.length - 1; i >= 0 && overlapCount < overlapChars; i--) {
                overlapParas.unshift(current[i]);
                overlapCount += current[i].length;
            }
            current = overlapParas;
            currentTokens = overlapCount / charsPerToken;
        }
        current.push(p);
        currentTokens += pTokens;
    }
    if (current.length > 0) {
        const textChunk = current.join("\n\n").trim();
        if (textChunk.length > 0) {
            chunks.push({ text: textChunk, index: index++ });
        }
    }
    return chunks;
}
/**
 * Chunk a single document text using config strategy.
 */
export function chunkText(text) {
    const strategy = config.chunking.strategy;
    if (strategy === "paragraph") {
        return chunkByParagraph(text);
    }
    return chunkFixed(text);
}
/**
 * Chunk multiple documents (e.g. from a zip); each chunk keeps optional source name.
 */
export function chunkDocuments(documents) {
    const out = [];
    let globalIndex = 0;
    for (const doc of documents) {
        const chunks = chunkText(doc.text);
        for (const c of chunks) {
            out.push({ sourceName: doc.name, text: c.text, index: globalIndex++ });
        }
    }
    return out;
}
