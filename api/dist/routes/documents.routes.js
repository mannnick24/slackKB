import { getChunkCountByOrg, deleteChunksByOrg } from "../db/vectorRepo.js";
import { CryptoService } from "../services/crypto.service.js";
import { EmbeddingService } from "../services/embedding.service.js";
import { ingestFile, ingestFileStreamedFromPath, ingestSlackArchiveStreamedFromPath, } from "../services/ingest.service.js";
import { getSupportedExtensions } from "../services/documentParser.service.js";
import { config } from "../config.js";
function parseIngestMode(raw) {
    const v = String(raw ?? "")
        .trim()
        .toLowerCase()
        .replace(/-/g, "_");
    if (v === "slack_archive")
        return "slack_archive";
    return "text";
}
export async function documentsRoutes(app) {
    const defaultOrg = config.defaultOrg;
    const cryptoService = new CryptoService();
    const embeddingService = new EmbeddingService(cryptoService);
    app.post("/documents/upload", async (req, reply) => {
        let ingestMode = "text";
        let filePart;
        for await (const part of req.parts()) {
            if (part.type === "field" && part.fieldname === "ingestMode") {
                ingestMode = parseIngestMode(part.value);
            }
            else if (part.type === "file" && part.fieldname === "file") {
                filePart = part;
            }
        }
        if (!filePart) {
            return reply.code(400).send({ error: "No file uploaded. Use multipart with field `file`." });
        }
        const filename = filePart.filename ?? "unknown";
        console.log("Uploading file: ", filename, " ingestMode: ", ingestMode);
        const isZip = filename.toLowerCase().endsWith(".zip");
        if (ingestMode === "slack_archive" && !isZip) {
            return reply.code(400).send({
                error: "Slack archive ingest requires a .zip file (Slack export).",
            });
        }
        let result;
        if (isZip) {
            const { tmpdir } = await import("node:os");
            const { join } = await import("node:path");
            const fs = await import("node:fs");
            const tmpPath = join(tmpdir(), `upload-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
            await new Promise((resolve, reject) => {
                const ws = fs.createWriteStream(tmpPath);
                filePart.file.pipe(ws);
                ws.on("finish", () => resolve());
                ws.on("error", (err) => reject(err));
            });
            try {
                if (ingestMode === "slack_archive") {
                    result = await ingestSlackArchiveStreamedFromPath(defaultOrg, tmpPath, filename, embeddingService);
                }
                else {
                    result = await ingestFileStreamedFromPath(defaultOrg, tmpPath, filename, embeddingService);
                }
            }
            finally {
                await fs.promises.unlink(tmpPath).catch(() => { });
            }
        }
        else {
            const buffer = await filePart.toBuffer();
            result = await ingestFile(defaultOrg, buffer, filename, embeddingService);
        }
        if (result.errors.length > 0 && result.chunksStored === 0) {
            return reply.code(400).send({
                error: "Ingest failed",
                details: result.errors,
            });
        }
        const warnings = [];
        if (result.skippedDuplicates > 0) {
            warnings.push(`Skipped ${result.skippedDuplicates} duplicate vector(s) (same ingest key already stored for this org).`);
        }
        return reply.send({
            filesProcessed: result.filesProcessed,
            chunksStored: result.chunksStored,
            skippedDuplicates: result.skippedDuplicates,
            warnings: warnings.length > 0 ? warnings : undefined,
            errors: result.errors.length > 0 ? result.errors : undefined,
        });
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
        return reply.send({ deleted });
    });
}
