import { createWriteStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { getChunkCountByOrg, deleteChunksByOrg } from "../db/vectorRepo.js";
import { CryptoService } from "../services/crypto.service.js";
import { EmbeddingService } from "../services/embedding.service.js";
import { ingestFile, ingestFileStreamedFromPath, ingestSlackArchiveStreamedFromPath, } from "../services/ingest.service.js";
import { createIngestJob, getIngestJob, ingestJobComplete, ingestJobFail, ingestJobProgress, ingestJobStart, } from "../services/ingestJobStore.js";
import { getSupportedExtensions } from "../services/documentParser.service.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { invalidateRagFilterCache } from "../services/ragFilterCache.service.js";
function parseIngestMode(raw) {
    const v = String(raw ?? "")
        .trim()
        .toLowerCase()
        .replace(/-/g, "_");
    if (v === "slack_archive")
        return "slack_archive";
    return "text";
}
async function runIngestJob(jobId, orgId, embeddingService, ctx) {
    ingestJobStart(jobId);
    const report = (patch) => ingestJobProgress(jobId, patch);
    try {
        let result;
        if (ctx.isZip && ctx.zipTmpPath) {
            try {
                if (ctx.ingestMode === "slack_archive") {
                    result = await ingestSlackArchiveStreamedFromPath(orgId, ctx.zipTmpPath, ctx.filename, embeddingService, report);
                }
                else {
                    result = await ingestFileStreamedFromPath(orgId, ctx.zipTmpPath, ctx.filename, embeddingService, report);
                }
            }
            finally {
                await unlink(ctx.zipTmpPath).catch(() => { });
                logger.debug({ tmpPath: ctx.zipTmpPath, ingestMode: ctx.ingestMode }, "documents: temp zip removed");
            }
        }
        else if (ctx.fileBuffer) {
            result = await ingestFile(orgId, ctx.fileBuffer, ctx.filename, embeddingService, report);
        }
        else {
            ingestJobFail(jobId, "No file uploaded");
            return;
        }
        if (result.errors.length > 0 && result.chunksStored === 0) {
            ingestJobFail(jobId, "Ingest failed", result.errors);
            return;
        }
        const warnings = [];
        if (result.skippedDuplicates > 0) {
            warnings.push(`Skipped ${result.skippedDuplicates} duplicate vector(s) (same ingest key already stored for this org).`);
        }
        logger.debug({
            ingestMode: ctx.ingestMode,
            filename: ctx.filename,
            filesProcessed: result.filesProcessed,
            chunksStored: result.chunksStored,
            skippedDuplicates: result.skippedDuplicates,
            warningCount: warnings.length,
            errorCount: result.errors.length,
            jobId,
        }, "documents: ingest complete");
        ingestJobComplete(jobId, result, warnings.length > 0 ? warnings : undefined);
        invalidateRagFilterCache(orgId, "ingest_complete");
    }
    catch (err) {
        logger.error({ err, jobId }, "documents: ingest job error");
        ingestJobFail(jobId, err?.message ?? String(err));
    }
}
export async function documentsRoutes(app) {
    const defaultOrg = config.defaultOrg;
    const cryptoService = new CryptoService();
    const embeddingService = new EmbeddingService(cryptoService);
    app.get("/documents/upload/jobs/:jobId/progress", async (req, reply) => {
        const { jobId } = req.params;
        const snapshot = getIngestJob(jobId);
        if (!snapshot) {
            return reply.code(404).send({ error: "Unknown job id", jobId });
        }
        return reply.send(snapshot);
    });
    app.post("/documents/upload", async (req, reply) => {
        let ingestMode = "text";
        /** Multipart file streams must be consumed inside the parts loop or busboy blocks further parts. */
        let filename = "unknown";
        let zipTmpPath;
        let fileBuffer;
        let partIndex = 0;
        for await (const part of req.parts()) {
            partIndex += 1;
            logger.debug({ partIndex, partType: part.type, fieldname: part.fieldname }, "documents: multipart part");
            if (part.type === "field" && part.fieldname === "ingestMode") {
                ingestMode = parseIngestMode(part.value);
            }
            else if (part.type === "file" && part.fieldname === "file") {
                filename = part.filename ?? "unknown";
                const isZip = filename.toLowerCase().endsWith(".zip");
                if (isZip) {
                    zipTmpPath = join(tmpdir(), `upload-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
                    await pipeline(part.file, createWriteStream(zipTmpPath));
                    try {
                        const st = await stat(zipTmpPath);
                        logger.debug({
                            tmpPath: zipTmpPath,
                            tmpBytes: st.size,
                            ingestMode,
                            filename,
                        }, "documents: zip spooled to temp file");
                    }
                    catch {
                        /* ignore stat failure */
                    }
                }
                else {
                    fileBuffer = await part.toBuffer();
                }
            }
            else if (part.type === "file") {
                await part.toBuffer();
                logger.debug({ fieldname: part.fieldname }, "documents: discarded unexpected file field");
            }
        }
        const hasFile = zipTmpPath !== undefined || fileBuffer !== undefined;
        if (!hasFile) {
            return reply.code(400).send({ error: "No file uploaded. Use multipart with field `file`." });
        }
        const isZip = zipTmpPath !== undefined;
        logger.info({ filename, ingestMode, orgId: defaultOrg }, "documents: upload");
        if (ingestMode === "slack_archive" && !isZip) {
            logger.debug({ filename }, "documents: rejected slack_archive without zip");
            return reply.code(400).send({
                error: "Slack archive ingest requires a .zip file (Slack export).",
            });
        }
        const jobId = createIngestJob({ filename, ingestMode });
        const work = {
            ingestMode,
            filename,
            isZip,
            zipTmpPath,
            fileBuffer,
        };
        void runIngestJob(jobId, defaultOrg, embeddingService, work).catch((err) => {
            logger.error({ err, jobId }, "documents: ingest job unhandled rejection");
            ingestJobFail(jobId, err?.message ?? String(err));
        });
        logger.info({ filename, ingestMode, orgId: defaultOrg, jobId }, "documents: upload accepted, ingest started");
        return reply.code(202).send({ jobId });
    });
    app.get("/documents/supported-formats", async (req, reply) => {
        return reply.send({ extensions: getSupportedExtensions() });
    });
    app.get("/documents/vectors/count", async (req, reply) => {
        const count = await getChunkCountByOrg(defaultOrg);
        return reply.send({ count });
    });
    app.delete("/documents/vectors", async (req, reply) => {
        const deleted = await deleteChunksByOrg(defaultOrg);
        invalidateRagFilterCache(defaultOrg, "vectors_cleared");
        return reply.send({ deleted });
    });
}
