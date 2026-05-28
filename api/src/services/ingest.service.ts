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

/** Optional hook for upload job progress (in-memory job id on the API). */
export type IngestProgressReporter = (update: {
    stage: string;
    percent: number;
    filesProcessed?: number;
    chunksStored?: number;
}) => void;

export interface IngestDocumentsOptions {
    /** One embedding per parsed document (no chunking). Used for Slack messages. */
    singleChunkPerDocument?: boolean;
    onProgress?: IngestProgressReporter;
}

/** Multipart field `ingestMode` for `/documents/upload`. */
export type DocumentIngestMode = "text" | "slack_archive";

/**
 * Ingest one or more documents (from parsed list). Chunks are created,
 * embedded, and inserted for the given org.
 */
export async function ingestDocuments(
    orgId: string,
    documents: ParsedDocument[],
    embeddingService: EmbeddingService,
    sourceName?: string,
    options?: IngestDocumentsOptions
): Promise<IngestResult> {
    logger.debug({ documentCount: documents.length }, "ingest: documents batch");
    const errors: string[] = [];
    const report = options?.onProgress;
    if (documents.length === 0) {
        report?.({ stage: "Done", percent: 100, filesProcessed: 0, chunksStored: 0 });
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

    report?.({ stage: "Chunking", percent: 12, filesProcessed: 0, chunksStored: 0 });

    // Process one document at a time to reduce peak memory usage:
    // - chunk per document
    // - embed that document's chunks
    // - insert those chunks
    const singleChunk = options?.singleChunkPerDocument === true;
    const n = documents.length;

    for (let docIndex = 0; docIndex < documents.length; docIndex++) {
        const doc = documents[docIndex]!;
        const pctBase = 15 + (docIndex / Math.max(n, 1)) * 75;
        report?.({
            stage: "Embedding",
            percent: Math.round(pctBase),
            filesProcessed: docIndex,
            chunksStored: totalChunksStored,
        });
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
        const slack = doc.slack;
        const toInsert = docChunks
            .map((c, i) => ({
                text: c.text,
                embedding: embeddings[i] ?? [],
                sourceName: sourceName ?? c.sourceName,
                embeddingModel: embeddingConfig.model,
                embeddingDimensions: embeddingConfig.dimensions,
                ingestKey: ingestKeyForTextChunk(orgId, uploadLabel, doc.name, c.index, c.text),
                slackMessageAt: slack?.messageAt ?? null,
                slackChannel: slack?.channel ?? null,
                slackUserId: slack?.userId ?? null,
                slackUserLabel: slack?.userLabel ?? null,
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
        report?.({
            stage: "Storing",
            percent: Math.round(15 + ((docIndex + 1) / Math.max(n, 1)) * 80),
            filesProcessed: docIndex + 1,
            chunksStored: totalChunksStored,
        });
    }

    report?.({
        stage: "Done",
        percent: 100,
        filesProcessed: documents.length,
        chunksStored: totalChunksStored,
    });

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
    embeddingService: EmbeddingService,
    onProgress?: IngestProgressReporter
): Promise<IngestResult> {
    onProgress?.({ stage: "Parsing", percent: 4, filesProcessed: 0, chunksStored: 0 });
    let documents: ParsedDocument[];
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
    onProgress?.({
        stage: "Parsed",
        percent: 10,
        filesProcessed: documents.length,
        chunksStored: 0,
    });
    return ingestDocuments(orgId, documents, embeddingService, filename, { onProgress });
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
    let documents: ParsedDocument[];
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
    embeddingService: EmbeddingService,
    onProgress?: IngestProgressReporter
): Promise<IngestResult> {
    logger.info({ filename }, "ingest: streamed zip from path");
    onProgress?.({ stage: "Parsing archive", percent: 6, filesProcessed: 0, chunksStored: 0 });
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
        onProgress?.({
            stage: "Processing files",
            percent: Math.min(96, Math.round(8 + 22 * Math.log2(filesProcessed + 1))),
            filesProcessed,
            chunksStored,
        });

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
        const slack = doc.slack;
        const toInsert = docChunks
            .map((c, i) => ({
                text: c.text,
                embedding: embeddings[i] ?? [],
                sourceName: filename ?? c.sourceName,
                embeddingModel: embeddingConfig.model,
                embeddingDimensions: embeddingConfig.dimensions,
                ingestKey: ingestKeyForTextChunk(orgId, uploadLabel, doc.name, c.index, c.text),
                slackMessageAt: slack?.messageAt ?? null,
                slackChannel: slack?.channel ?? null,
                slackUserId: slack?.userId ?? null,
                slackUserLabel: slack?.userLabel ?? null,
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

    onProgress?.({
        stage: "Done",
        percent: 100,
        filesProcessed,
        chunksStored,
    });

    return {
        filesProcessed,
        chunksStored,
        skippedDuplicates,
        errors,
    };
}

type SlackPendingRow = {
    text: string;
    sourceName: string;
    ingestKey: string;
    slackMessageAt: Date | null;
    slackChannel: string | null;
    slackUserId: string | null;
    slackUserLabel: string | null;
};

function bumpCounter(map: Map<string, number>, key: string | null | undefined, by: number = 1): void {
    const k = key && key.trim() ? key.trim() : "unknown";
    map.set(k, (map.get(k) ?? 0) + by);
}

function summarizeCounter(map: Map<string, number>, limit: number = 25): Array<{ key: string; count: number }> {
    return [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([key, count]) => ({ key, count }));
}

/**
 * Slack export zip: one vector per message object (no chunking). Streams JSON files from the archive.
 * Embeddings are requested in batches (see config.ingestEmbedBatchSize).
 */
export async function ingestSlackArchiveStreamedFromPath(
    orgId: string,
    filePath: string,
    filename: string,
    embeddingService: EmbeddingService,
    onProgress?: IngestProgressReporter
): Promise<IngestResult> {
    logger.info({ filename, orgId }, "ingest: Slack archive from path");
    onProgress?.({ stage: "Parsing Slack export", percent: 5, filesProcessed: 0, chunksStored: 0 });
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
    const embedConcurrency = config.ingestEmbedConcurrency;
    logger.debug(
        {
            orgId,
            filename,
            batchSize,
            embedConcurrency,
            embeddingModel: embeddingConfig.model,
            embeddingDimensions: embeddingConfig.dimensions,
        },
        "ingest: slack pipeline config"
    );

    const pending: SlackPendingRow[] = [];
    const inFlight = new Set<Promise<void>>();
    const seenByChannel = new Map<string, number>();
    const queuedByChannel = new Map<string, number>();
    const insertAttemptByChannel = new Map<string, number>();
    const embedFailureByChannel = new Map<string, number>();
    const insertFailureByChannel = new Map<string, number>();

    const insertRows = async (rows: SlackPendingRow[], embeddings: number[][]) => {
        const toInsert = rows
            .map((row, i) => ({
                text: row.text,
                embedding: embeddings[i] ?? [],
                sourceName: row.sourceName,
                embeddingModel: embeddingConfig.model,
                embeddingDimensions: embeddingConfig.dimensions,
                ingestKey: row.ingestKey,
                slackMessageAt: row.slackMessageAt,
                slackChannel: row.slackChannel,
                slackUserId: row.slackUserId,
                slackUserLabel: row.slackUserLabel,
            }))
            .filter((row) => row.embedding.length > 0);
        if (toInsert.length === 0) return;
        for (const row of toInsert) bumpCounter(insertAttemptByChannel, row.slackChannel);
        const ins = await vectorRepo.insertChunks(orgId, toInsert);
        chunksStored += ins.inserted;
        skippedDuplicates += ins.skippedDuplicates;
        onProgress?.({
            stage: "Embedding and storing",
            percent: Math.min(97, Math.round(10 + 18 * Math.log2(filesProcessed + 1))),
            filesProcessed,
            chunksStored,
        });
        logger.debug(
            {
                rowCount: rows.length,
                inserted: ins.inserted,
                skippedDuplicates: ins.skippedDuplicates,
            },
            "ingest: slack vectors persisted"
        );
    };

    /** Embed texts; on failure split the batch in half until size 1, then rethrow. */
    const embedTextsWithSplit = async (texts: string[]): Promise<number[][]> => {
        try {
            return await embeddingService.embed(orgId, texts);
        } catch (err) {
            if (texts.length <= 1) throw err;
            const mid = Math.ceil(texts.length / 2);
            logger.debug(
                { count: texts.length, left: mid, right: texts.length - mid },
                "ingest: slack embed batch split after failure"
            );
            const left = await embedTextsWithSplit(texts.slice(0, mid));
            const right = await embedTextsWithSplit(texts.slice(mid));
            return [...left, ...right];
        }
    };

    /** Embed a batch; on failure fall back to single-message calls so partial progress still lands. */
    const flushBatch = async (batch: SlackPendingRow[]) => {
        if (batch.length === 0) return;
        logger.debug({ batchSize: batch.length, pendingAfter: pending.length }, "ingest: slack embed batch start");
        let embeddings: number[][];
        try {
            embeddings = await embedTextsWithSplit(batch.map((b) => b.text));
        } catch (batchErr: any) {
            logger.debug(
                { batchSize: batch.length, err: batchErr?.message ?? String(batchErr) },
                "ingest: slack batch embed failed, falling back to single-message embeds"
            );
            errors.push(`Batch embed (${batch.length}): ${batchErr?.message ?? String(batchErr)}`);
            for (const row of batch) bumpCounter(embedFailureByChannel, row.slackChannel);
            for (const row of batch) {
                try {
                    const rowEmbeddings = await embeddingService.embed(orgId, [row.text]);
                    try {
                        await insertRows([row], rowEmbeddings);
                    } catch (insertErr: any) {
                        bumpCounter(insertFailureByChannel, row.slackChannel);
                        errors.push(insertErr?.message ?? String(insertErr));
                    }
                } catch (e: any) {
                    logger.debug(
                        { ingestKey: row.ingestKey, err: e?.message ?? String(e) },
                        "ingest: slack single-message embed failed"
                    );
                    bumpCounter(embedFailureByChannel, row.slackChannel);
                    errors.push(e?.message ?? String(e));
                }
            }
            return;
        }

        if (embeddings.length !== batch.length) {
            const err = `Embedding count mismatch: got ${embeddings.length}, expected ${batch.length}`;
            errors.push(err);
            logger.warn({ batchSize: batch.length, err }, "ingest: slack batch embed mismatch");
            for (const row of batch) bumpCounter(embedFailureByChannel, row.slackChannel);
            return;
        }

        try {
            await insertRows(batch, embeddings);
        } catch (insertErr: any) {
            logger.warn(
                { batchSize: batch.length, err: insertErr?.message ?? String(insertErr) },
                "ingest: slack batch insert failed, falling back to per-message insert"
            );
            errors.push(`Batch insert (${batch.length}): ${insertErr?.message ?? String(insertErr)}`);
            for (const row of batch) bumpCounter(insertFailureByChannel, row.slackChannel);
            for (let i = 0; i < batch.length; i++) {
                const row = batch[i]!;
                try {
                    await insertRows([row], [embeddings[i] ?? []]);
                } catch (singleInsertErr: any) {
                    bumpCounter(insertFailureByChannel, row.slackChannel);
                    errors.push(singleInsertErr?.message ?? String(singleInsertErr));
                }
            }
        }
    };

    const enqueueBatch = async (batch: SlackPendingRow[]) => {
        const task = flushBatch(batch).finally(() => {
            inFlight.delete(task);
        });
        inFlight.add(task);
        if (inFlight.size >= embedConcurrency) {
            await Promise.race(inFlight);
        }
    };

    const handleDoc = async (doc: ParsedDocument) => {
        filesProcessed += 1;
        onProgress?.({
            stage: "Reading messages",
            percent: Math.min(92, Math.round(6 + 16 * Math.log2(filesProcessed + 1))),
            filesProcessed,
            chunksStored,
        });
        const trimmed = doc.text.trim();
        if (!trimmed) {
            logger.debug({ sourceName: doc.name, ingestKey: doc.ingestKey }, "ingest: slack skip empty message body");
            return;
        }
        const sm = doc.slack;
        const channel = sm?.channel ?? "unknown";
        bumpCounter(seenByChannel, channel);
        pending.push({
            text: trimmed,
            sourceName: doc.name,
            ingestKey: doc.ingestKey ?? `slack:loc:${doc.name}`,
            slackMessageAt: sm?.messageAt ?? null,
            slackChannel: sm?.channel ?? null,
            slackUserId: sm?.userId ?? null,
            slackUserLabel: sm?.userLabel ?? null,
        });
        bumpCounter(queuedByChannel, channel);

        if (filesProcessed % 5000 === 0) {
            logger.info(
                {
                    orgId,
                    filename,
                    messagesSeen: filesProcessed,
                    pendingCount: pending.length,
                    inFlightBatches: inFlight.size,
                    chunksStored,
                    topSeenChannels: summarizeCounter(seenByChannel, 10),
                    topQueuedChannels: summarizeCounter(queuedByChannel, 10),
                },
                "ingest: slack progress checkpoint"
            );
        }

        while (pending.length >= batchSize) {
            const batch = pending.splice(0, batchSize);
            await enqueueBatch(batch);
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
        await enqueueBatch(pending.splice(0, pending.length));
    }
    await Promise.all(inFlight);

    const channelsSeen = new Set(seenByChannel.keys());
    const channelsQueued = new Set(queuedByChannel.keys());
    const channelsWithInsertAttempts = new Set(insertAttemptByChannel.keys());
    const channelsWithEmbedFailures = new Set(embedFailureByChannel.keys());
    const channelsWithInsertFailures = new Set(insertFailureByChannel.keys());
    const channelsSeenButNeverQueued = [...channelsSeen].filter((c) => !channelsQueued.has(c));
    const channelsQueuedButNoInsertAttempt = [...channelsQueued].filter((c) => !channelsWithInsertAttempts.has(c));

    logger.info(
        {
            orgId,
            filename,
            messagesSeen: filesProcessed,
            chunksStored,
            skippedDuplicates,
            errorCount: errors.length,
            uniqueChannelsSeen: channelsSeen.size,
            uniqueChannelsQueued: channelsQueued.size,
            uniqueChannelsWithInsertAttempts: channelsWithInsertAttempts.size,
            channelsWithEmbedFailures: [...channelsWithEmbedFailures],
            channelsWithInsertFailures: [...channelsWithInsertFailures],
            channelsSeenButNeverQueued,
            channelsQueuedButNoInsertAttempt,
            topChannelsSeen: summarizeCounter(seenByChannel),
            topChannelsQueued: summarizeCounter(queuedByChannel),
            topChannelsInsertAttempted: summarizeCounter(insertAttemptByChannel),
            topChannelsEmbedFailures: summarizeCounter(embedFailureByChannel),
            topChannelsInsertFailures: summarizeCounter(insertFailureByChannel),
        },
        "ingest: slack archive finished"
    );

    onProgress?.({
        stage: "Done",
        percent: 100,
        filesProcessed,
        chunksStored,
    });

    return {
        filesProcessed,
        chunksStored,
        skippedDuplicates,
        errors,
    };
}
