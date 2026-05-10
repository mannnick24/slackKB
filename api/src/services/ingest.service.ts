/**
 * Ingest pipeline: parse file -> chunk -> embed -> store in pgvector.
 * All data scoped by org_id.
 */

import {
    parseDocument,
    parseDocumentFromPath,
    parseAndHandleFromPath,
    type ParsedDocument,
} from "./documentParser.service.js";
import { parseSlackArchiveZipStreaming } from "./slackArchiveParser.service.js";
import { chunkText } from "./chunker.service.js";
import { EmbeddingService } from "./embedding.service.js";
import * as vectorRepo from "../db/vectorRepo.js";
import type { EmbeddingConfigResolved } from "./embedding.service.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { ingestKeyForTextChunk } from "./ingestKey.util.js";

export interface IngestResult {
    filesProcessed: number;
    chunksStored: number;
    skippedDuplicates: number;
    errors: string[];
}

export interface IngestDocumentsOptions {
    /** One embedding per parsed document (no chunking). Used for Slack messages. */
    singleChunkPerDocument?: boolean;
}

/** Multipart field `ingestMode` for `/documents/upload`. */
export type DocumentIngestMode = "text" | "slack_archive";

/**
 * Ingest one or more documents (from parsed list). Chunks are created,
 * embedded, and inserted for the given org.
 */
export async function ingestDocuments(
    orgId: string,
    documents: Array<{ name: string; text: string }>,
    embeddingService: EmbeddingService,
    sourceName?: string,
    options?: IngestDocumentsOptions
): Promise<IngestResult> {
    logger.debug({ documentCount: documents.length }, "ingest: documents batch");
    const errors: string[] = [];
    if (documents.length === 0) {
        return { filesProcessed: 0, chunksStored: 0, skippedDuplicates: 0, errors };
    }

    let totalChunksStored = 0;
    let skippedDuplicates = 0;
    let embeddingConfig: EmbeddingConfigResolved;
    try {
        embeddingConfig = await embeddingService.getConfig(orgId);
    } catch (e: any) {
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
        logger.debug({ documentName: doc.name }, "ingest: document");
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
        if (docChunks.length === 0) continue;

        const texts = docChunks.map((c) => c.text);
        let embeddings: number[][];
        try {
            embeddings = await embeddingService.embed(orgId, texts);
        } catch (e: any) {
            errors.push(e?.message ?? String(e));
            logger.error({ err: e, documentName: doc.name }, "ingest: embed failed");
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

        if (toInsert.length === 0) continue;

        try {
            const ins = await vectorRepo.insertChunks(orgId, toInsert);
            totalChunksStored += ins.inserted;
            skippedDuplicates += ins.skippedDuplicates;
        } catch (e: any) {
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
export async function ingestFile(
    orgId: string,
    buffer: Buffer,
    filename: string,
    embeddingService: EmbeddingService
): Promise<IngestResult> {
    let documents: Array<{ name: string; text: string }>;
    try {
        logger.debug({ filename }, "ingest: parse buffer");
        documents = await parseDocument(buffer, filename);
    } catch (e: any) {
        return {
            filesProcessed: 0,
            chunksStored: 0,
            skippedDuplicates: 0,
            errors: [e?.message ?? String(e)],
        };
    }
    logger.info({ filename, documentCount: documents.length }, "ingest: from buffer");
    return ingestDocuments(orgId, documents, embeddingService, filename);
}

/**
 * Ingest a single uploaded file from disk (e.g. large zip streamed to a temp file).
 */
export async function ingestFileFromPath(
    orgId: string,
    filePath: string,
    filename: string,
    embeddingService: EmbeddingService
): Promise<IngestResult> {
    let documents: Array<{ name: string; text: string }>;
    try {
        logger.debug({ filename }, "ingest: parse path");
        documents = await parseDocumentFromPath(filePath, filename);
    } catch (e: any) {
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
export async function ingestFileStreamedFromPath(
    orgId: string,
    filePath: string,
    filename: string,
    embeddingService: EmbeddingService
): Promise<IngestResult> {
    logger.info({ filename }, "ingest: streamed zip from path");
    const errors: string[] = [];
    let filesProcessed = 0;
    let chunksStored = 0;
    let skippedDuplicates = 0;
    let embeddingConfig: EmbeddingConfigResolved;
    try {
        embeddingConfig = await embeddingService.getConfig(orgId);
    } catch (e: any) {
        return {
            filesProcessed: 0,
            chunksStored: 0,
            skippedDuplicates: 0,
            errors: [e?.message ?? String(e)],
        };
    }

    const handleDoc = async (doc: ParsedDocument) => {
        logger.debug({ documentName: doc.name }, "ingest: zip entry");
        filesProcessed += 1;

        const docChunks = chunkText(doc.text).map((c) => ({
            sourceName: doc.name,
            text: c.text,
            index: c.index,
        }));
        logger.debug({ documentName: doc.name, chunkCount: docChunks.length }, "ingest: chunks");
        if (docChunks.length === 0) return;

        const texts = docChunks.map((c) => c.text);
        let embeddings: number[][];
        try {
            embeddings = await embeddingService.embed(orgId, texts);
        } catch (e: any) {
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

        if (toInsert.length === 0) return;

        try {
            const ins = await vectorRepo.insertChunks(orgId, toInsert);
            chunksStored += ins.inserted;
            skippedDuplicates += ins.skippedDuplicates;
        } catch (e: any) {
            errors.push(e?.message ?? String(e));
        }
    };

    try {
        await parseAndHandleFromPath(filePath, filename, handleDoc);
    } catch (e: any) {
        errors.push(e?.message ?? String(e));
    }

    return {
        filesProcessed,
        chunksStored,
        skippedDuplicates,
        errors,
    };
}

type SlackPendingRow = { text: string; sourceName: string; ingestKey: string };

/**
 * Slack export zip: one vector per message object (no chunking). Streams JSON files from the archive.
 * Embeddings are requested in batches (see config.ingestEmbedBatchSize).
 */
export async function ingestSlackArchiveStreamedFromPath(
    orgId: string,
    filePath: string,
    filename: string,
    embeddingService: EmbeddingService
): Promise<IngestResult> {
    logger.info({ filename, orgId }, "ingest: Slack archive from path");
    const errors: string[] = [];
    let filesProcessed = 0;
    let chunksStored = 0;
    let skippedDuplicates = 0;
    let embeddingConfig: EmbeddingConfigResolved;
    try {
        embeddingConfig = await embeddingService.getConfig(orgId);
    } catch (e: any) {
        return {
            filesProcessed: 0,
            chunksStored: 0,
            skippedDuplicates: 0,
            errors: [e?.message ?? String(e)],
        };
    }

    const batchSize = config.ingestEmbedBatchSize;
    logger.debug(
        {
            orgId,
            filename,
            batchSize,
            embeddingModel: embeddingConfig.model,
            embeddingDimensions: embeddingConfig.dimensions,
        },
        "ingest: slack pipeline config"
    );

    const pending: SlackPendingRow[] = [];

    const insertRows = async (rows: SlackPendingRow[], embeddings: number[][]) => {
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
        if (toInsert.length === 0) return;
        const ins = await vectorRepo.insertChunks(orgId, toInsert);
        chunksStored += ins.inserted;
        skippedDuplicates += ins.skippedDuplicates;
        logger.debug(
            {
                rowCount: rows.length,
                inserted: ins.inserted,
                skippedDuplicates: ins.skippedDuplicates,
            },
            "ingest: slack vectors persisted"
        );
    };

    /** Embed a batch; on failure fall back to single-message calls so partial progress still lands. */
    const flushBatch = async (batch: SlackPendingRow[]) => {
        if (batch.length === 0) return;
        logger.debug({ batchSize: batch.length, pendingAfter: pending.length }, "ingest: slack embed batch start");
        try {
            const embeddings = await embeddingService.embed(
                orgId,
                batch.map((b) => b.text)
            );
            if (embeddings.length !== batch.length) {
                throw new Error(
                    `Embedding count mismatch: got ${embeddings.length}, expected ${batch.length}`
                );
            }
            await insertRows(batch, embeddings);
        } catch (batchErr: any) {
            logger.debug(
                { batchSize: batch.length, err: batchErr?.message ?? String(batchErr) },
                "ingest: slack batch embed failed, falling back to single-message embeds"
            );
            errors.push(`Batch embed (${batch.length}): ${batchErr?.message ?? String(batchErr)}`);
            for (const row of batch) {
                try {
                    const embeddings = await embeddingService.embed(orgId, [row.text]);
                    await insertRows([row], embeddings);
                } catch (e: any) {
                    logger.debug(
                        { ingestKey: row.ingestKey, err: e?.message ?? String(e) },
                        "ingest: slack single-message embed failed"
                    );
                    errors.push(e?.message ?? String(e));
                }
            }
        }
    };

    const handleDoc = async (doc: ParsedDocument) => {
        filesProcessed += 1;
        const trimmed = doc.text.trim();
        if (!trimmed) {
            logger.debug({ sourceName: doc.name, ingestKey: doc.ingestKey }, "ingest: slack skip empty message body");
            return;
        }
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
    } catch (e: any) {
        logger.debug({ err: e?.message ?? String(e) }, "ingest: slack parse/zip failed");
        errors.push(e?.message ?? String(e));
    }

    if (pending.length > 0) {
        logger.debug({ remainder: pending.length }, "ingest: slack flushing final partial batch");
        await flushBatch(pending.splice(0, pending.length));
    }

    logger.debug(
        {
            orgId,
            filename,
            messagesSeen: filesProcessed,
            chunksStored,
            skippedDuplicates,
            errorCount: errors.length,
        },
        "ingest: slack archive finished"
    );

    return {
        filesProcessed,
        chunksStored,
        skippedDuplicates,
        errors,
    };
}
