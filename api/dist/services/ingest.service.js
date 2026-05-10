/**
 * Ingest pipeline: parse file -> chunk -> embed -> store in pgvector.
 * All data scoped by org_id.
 */
import { parseDocument, parseDocumentFromPath, parseAndHandleFromPath, } from "./documentParser.service.js";
import { parseSlackArchiveZipStreaming } from "./slackArchiveParser.service.js";
import { chunkText } from "./chunker.service.js";
import * as vectorRepo from "../db/vectorRepo.js";
import { config } from "../config.js";
import { ingestKeyForTextChunk } from "./ingestKey.util.js";
/**
 * Ingest one or more documents (from parsed list). Chunks are created,
 * embedded, and inserted for the given org.
 */
export async function ingestDocuments(orgId, documents, embeddingService, sourceName, options) {
    console.log("Ingesting documents: ", documents.length);
    const errors = [];
    if (documents.length === 0) {
        return { filesProcessed: 0, chunksStored: 0, skippedDuplicates: 0, errors };
    }
    let totalChunksStored = 0;
    let skippedDuplicates = 0;
    let embeddingConfig;
    try {
        embeddingConfig = await embeddingService.getConfig(orgId);
    }
    catch (e) {
        return {
            filesProcessed: 0,
            chunksStored: 0,
            skippedDuplicates: 0,
            errors: [e?.message ?? String(e)],
        };
    }
    // Process one document at a time to reduce peak memory usage:
    // - chunk per document
    // - embed that document's chunks
    // - insert those chunks
    const singleChunk = options?.singleChunkPerDocument === true;
    for (const doc of documents) {
        console.log("Ingesting document: ", doc.name);
        const docChunks = singleChunk
            ? (() => {
                const t = doc.text.trim();
                return t.length === 0 ? [] : [{ text: t, index: 0, sourceName: doc.name }];
            })()
            : chunkText(doc.text).map((c) => ({
                sourceName: doc.name,
                text: c.text,
                index: c.index,
            }));
        if (docChunks.length === 0)
            continue;
        const texts = docChunks.map((c) => c.text);
        let embeddings;
        try {
            embeddings = await embeddingService.embed(orgId, texts);
        }
        catch (e) {
            errors.push(e?.message ?? String(e));
            console.error("Error embedding document: ", e);
            // Skip this document but continue with others.
            continue;
        }
        const uploadLabel = sourceName ?? "";
        const toInsert = docChunks
            .map((c, i) => ({
            text: c.text,
            embedding: embeddings[i] ?? [],
            sourceName: sourceName ?? c.sourceName,
            embeddingModel: embeddingConfig.model,
            embeddingDimensions: embeddingConfig.dimensions,
            ingestKey: ingestKeyForTextChunk(orgId, uploadLabel, doc.name, c.index, c.text),
        }))
            .filter((row) => row.embedding.length > 0);
        if (toInsert.length === 0)
            continue;
        try {
            const ins = await vectorRepo.insertChunks(orgId, toInsert);
            totalChunksStored += ins.inserted;
            skippedDuplicates += ins.skippedDuplicates;
        }
        catch (e) {
            errors.push(e?.message ?? String(e));
            // Skip this document's chunks but continue with others.
            continue;
        }
    }
    return {
        filesProcessed: documents.length,
        chunksStored: totalChunksStored,
        skippedDuplicates,
        errors,
    };
}
/**
 * Ingest a single uploaded file buffer (e.g. from multipart).
 * Parses by filename, then runs ingestDocuments.
 */
export async function ingestFile(orgId, buffer, filename, embeddingService) {
    let documents;
    try {
        console.log("Parsing document from buffer for filename: ", filename);
        documents = await parseDocument(buffer, filename);
    }
    catch (e) {
        return {
            filesProcessed: 0,
            chunksStored: 0,
            skippedDuplicates: 0,
            errors: [e?.message ?? String(e)],
        };
    }
    console.log("Ingesting documents from filename: ", filename, " documents: ", documents.length);
    return ingestDocuments(orgId, documents, embeddingService, filename);
}
/**
 * Ingest a single uploaded file from disk (e.g. large zip streamed to a temp file).
 */
export async function ingestFileFromPath(orgId, filePath, filename, embeddingService) {
    let documents;
    try {
        console.log("Parsing document from path for filename: ", filename);
        documents = await parseDocumentFromPath(filePath, filename);
    }
    catch (e) {
        return {
            filesProcessed: 0,
            chunksStored: 0,
            skippedDuplicates: 0,
            errors: [e?.message ?? String(e)],
        };
    }
    return ingestDocuments(orgId, documents, embeddingService, filename);
}
/**
 * Streamed ingest from a file path: parse documents one by one and ingest
 * each document's chunks immediately. Useful for large zip archives.
 */
export async function ingestFileStreamedFromPath(orgId, filePath, filename, embeddingService) {
    console.log("Ingesting file streamed from path: ", filename);
    const errors = [];
    let filesProcessed = 0;
    let chunksStored = 0;
    let skippedDuplicates = 0;
    let embeddingConfig;
    try {
        embeddingConfig = await embeddingService.getConfig(orgId);
    }
    catch (e) {
        return {
            filesProcessed: 0,
            chunksStored: 0,
            skippedDuplicates: 0,
            errors: [e?.message ?? String(e)],
        };
    }
    const handleDoc = async (doc) => {
        console.log(`Handling document: ${doc.name}`);
        filesProcessed += 1;
        const docChunks = chunkText(doc.text).map((c) => ({
            sourceName: doc.name,
            text: c.text,
            index: c.index,
        }));
        console.log(`Document chunks: ${docChunks.length}`);
        if (docChunks.length === 0)
            return;
        const texts = docChunks.map((c) => c.text);
        let embeddings;
        try {
            embeddings = await embeddingService.embed(orgId, texts);
        }
        catch (e) {
            errors.push(e?.message ?? String(e));
            return;
        }
        const uploadLabel = filename ?? "";
        const toInsert = docChunks
            .map((c, i) => ({
            text: c.text,
            embedding: embeddings[i] ?? [],
            sourceName: filename ?? c.sourceName,
            embeddingModel: embeddingConfig.model,
            embeddingDimensions: embeddingConfig.dimensions,
            ingestKey: ingestKeyForTextChunk(orgId, uploadLabel, doc.name, c.index, c.text),
        }))
            .filter((row) => row.embedding.length > 0);
        if (toInsert.length === 0)
            return;
        try {
            const ins = await vectorRepo.insertChunks(orgId, toInsert);
            chunksStored += ins.inserted;
            skippedDuplicates += ins.skippedDuplicates;
        }
        catch (e) {
            errors.push(e?.message ?? String(e));
        }
    };
    try {
        await parseAndHandleFromPath(filePath, filename, handleDoc);
    }
    catch (e) {
        errors.push(e?.message ?? String(e));
    }
    return {
        filesProcessed,
        chunksStored,
        skippedDuplicates,
        errors,
    };
}
/**
 * Slack export zip: one vector per message object (no chunking). Streams JSON files from the archive.
 * Embeddings are requested in batches (see config.ingestEmbedBatchSize).
 */
export async function ingestSlackArchiveStreamedFromPath(orgId, filePath, filename, embeddingService) {
    console.log("Ingesting Slack archive from path: ", filename);
    const errors = [];
    let filesProcessed = 0;
    let chunksStored = 0;
    let skippedDuplicates = 0;
    let embeddingConfig;
    try {
        embeddingConfig = await embeddingService.getConfig(orgId);
    }
    catch (e) {
        return {
            filesProcessed: 0,
            chunksStored: 0,
            skippedDuplicates: 0,
            errors: [e?.message ?? String(e)],
        };
    }
    const batchSize = config.ingestEmbedBatchSize;
    const pending = [];
    const insertRows = async (rows, embeddings) => {
        const toInsert = rows
            .map((row, i) => ({
            text: row.text,
            embedding: embeddings[i] ?? [],
            sourceName: row.sourceName,
            embeddingModel: embeddingConfig.model,
            embeddingDimensions: embeddingConfig.dimensions,
            ingestKey: row.ingestKey,
        }))
            .filter((row) => row.embedding.length > 0);
        if (toInsert.length === 0)
            return;
        const ins = await vectorRepo.insertChunks(orgId, toInsert);
        chunksStored += ins.inserted;
        skippedDuplicates += ins.skippedDuplicates;
    };
    /** Embed a batch; on failure fall back to single-message calls so partial progress still lands. */
    const flushBatch = async (batch) => {
        if (batch.length === 0)
            return;
        try {
            const embeddings = await embeddingService.embed(orgId, batch.map((b) => b.text));
            if (embeddings.length !== batch.length) {
                throw new Error(`Embedding count mismatch: got ${embeddings.length}, expected ${batch.length}`);
            }
            await insertRows(batch, embeddings);
        }
        catch (batchErr) {
            errors.push(`Batch embed (${batch.length}): ${batchErr?.message ?? String(batchErr)}`);
            for (const row of batch) {
                try {
                    const embeddings = await embeddingService.embed(orgId, [row.text]);
                    await insertRows([row], embeddings);
                }
                catch (e) {
                    errors.push(e?.message ?? String(e));
                }
            }
        }
    };
    const handleDoc = async (doc) => {
        filesProcessed += 1;
        const trimmed = doc.text.trim();
        if (!trimmed)
            return;
        pending.push({
            text: trimmed,
            sourceName: doc.name,
            ingestKey: doc.ingestKey ?? `slack:loc:${doc.name}`,
        });
        while (pending.length >= batchSize) {
            const batch = pending.splice(0, batchSize);
            await flushBatch(batch);
        }
    };
    try {
        await parseSlackArchiveZipStreaming(filePath, filename, handleDoc);
    }
    catch (e) {
        errors.push(e?.message ?? String(e));
    }
    if (pending.length > 0) {
        await flushBatch(pending.splice(0, pending.length));
    }
    return {
        filesProcessed,
        chunksStored,
        skippedDuplicates,
        errors,
    };
}
