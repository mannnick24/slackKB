/**
 * Produce embeddings using org-level config (from OrgItem.embeddingConfig).
 * Fallback: env OPENAI_API_KEY and default model when org has no config.
 */
import OpenAI from "openai";
import * as vectorRepo from "../db/vectorRepo.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { summarizeRagChunkSearchFilters } from "../utils/ragFiltersLog.js";
const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_DIMENSIONS = 768;
const DEFAULT_SEARCH_LIMIT = 5;
/**
 * Ollama's current API is POST /api/embed with body { model, input }.
 * Older docs used /api/embeddings and a single `embedding` field — we normalize the URL
 * and parse both response shapes.
 */
function normalizeOllamaEmbedUrl(host) {
    const trimmed = host.trim();
    if (!trimmed)
        return "http://localhost:11434/api/embed";
    try {
        const u = new URL(trimmed);
        if (u.pathname === "/api/embeddings" || u.pathname.endsWith("/api/embeddings")) {
            u.pathname = u.pathname.replace(/\/api\/embeddings\/?$/, "/api/embed");
        }
        if (u.pathname === "/" || u.pathname === "") {
            u.pathname = "/api/embed";
        }
        return u.toString();
    }
    catch {
        return trimmed.replace(/\/api\/embeddings\/?$/, "/api/embed");
    }
}
/** Parses Ollama /api/embed or simple HTTP servers that return { embeddings } / { embedding }. */
function parseEmbeddingsJsonResponse(json, expectedCount) {
    if (!json || typeof json !== "object") {
        throw new Error("Unexpected embedding response: not an object");
    }
    const o = json;
    if (Array.isArray(o.embeddings)) {
        const emb = o.embeddings;
        const vectors = [];
        for (const row of emb) {
            if (!Array.isArray(row)) {
                throw new Error("Unexpected embedding response: embeddings row is not an array");
            }
            vectors.push(row.map((n) => Number(n)));
        }
        if (vectors.length !== expectedCount) {
            throw new Error(`Embedding server returned ${vectors.length} vector(s), expected ${expectedCount}`);
        }
        return vectors;
    }
    if (Array.isArray(o.embedding)) {
        if (expectedCount !== 1) {
            throw new Error("Embedding response had single `embedding` but batch was requested");
        }
        return [o.embedding.map((n) => Number(n))];
    }
    throw new Error("Unexpected embedding response: expected `embeddings` or `embedding` array");
}
/**
 * Simple embedding service: POST JSON `{ "texts": string[] }`, response `{ "embeddings": number[][] }`
 * (e.g. packages/nomic-embed/server.py).
 */
function normalizeDefaultEmbedUrl(host) {
    const trimmed = host.trim();
    if (!trimmed)
        return "http://localhost:9012/embed";
    try {
        const u = new URL(trimmed);
        if (u.pathname === "/" || u.pathname === "") {
            u.pathname = "/embed";
        }
        return u.toString();
    }
    catch {
        return trimmed;
    }
}
/** Low-level fetch failures (ECONNREFUSED, DNS, TLS) surface as `fetch failed`; include URL and errno. */
function embeddingFetchFailed(url, err) {
    const e = err;
    const base = e?.message ?? String(err);
    const code = e?.code ? ` ${e.code}` : "";
    const cause = e?.cause != null ? ` cause=${String(e.cause)}` : "";
    return new Error(`Embedding HTTP request failed (${url}):${code} ${base}${cause}`);
}
function sleep(ms) {
    if (ms <= 0)
        return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export class EmbeddingService {
    cryptoService;
    constructor(cryptoService) {
        this.cryptoService = cryptoService;
    }
    /**
     * Resolve embedding config for an org. Uses OrgItem.embeddingConfig if present,
     * otherwise fallback to OPENAI_API_KEY env and default model.
     */
    async getConfig(orgId) {
        return config.embeddingConfig;
    }
    /**
     * Embed a list of texts for the given org. Returns one vector per text.
     */
    async embed(orgId, texts) {
        if (texts.length === 0)
            return [];
        const cfg = await this.getConfig(orgId);
        if (cfg.type === "OPENAI" || cfg.type === "OTHER") {
            if (!cfg.apiKey) {
                throw new Error("Missing API key for OpenAI-compatible embeddings");
            }
            const openai = new OpenAI({
                apiKey: cfg.apiKey,
                ...(cfg.host?.trim() ? { baseURL: cfg.host.trim() } : {}),
            });
            const res = await openai.embeddings.create({
                model: cfg.model,
                input: texts,
            });
            const order = res.data.sort((a, b) => a.index - b.index);
            return order.map((d) => d.embedding);
        }
        if (cfg.type === "OLLAMA") {
            const rawHost = cfg.host || process.env.OLLAMA_EMBEDDING_HOST || "http://localhost:11434/api/embed";
            const url = normalizeOllamaEmbedUrl(rawHost);
            const resp = await this.fetchWithRetry(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: cfg.model,
                    input: texts.length === 1 ? texts[0] : texts,
                }),
            });
            const rawText = await resp.text();
            if (!resp.ok) {
                throw new Error(`Ollama embedding request failed: ${resp.status} ${resp.statusText} ${rawText || "(empty body)"}`);
            }
            let json;
            try {
                json = rawText ? JSON.parse(rawText) : null;
            }
            catch {
                throw new Error(`Ollama embedding response is not JSON: ${rawText.slice(0, 200)}`);
            }
            const vectors = parseEmbeddingsJsonResponse(json, texts.length);
            return vectors;
        }
        if (cfg.type === "DEFAULT") {
            const rawHost = cfg.host ||
                process.env.DEFAULT_EMBEDDING_HOST ||
                "http://localhost:9012/embed";
            const url = normalizeDefaultEmbedUrl(rawHost);
            const resp = await this.fetchWithRetry(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ texts }),
            });
            const rawText = await resp.text();
            if (!resp.ok) {
                throw new Error(`DEFAULT embedding request failed: ${resp.status} ${resp.statusText} ${rawText || "(empty body)"}`);
            }
            let json;
            try {
                json = rawText ? JSON.parse(rawText) : null;
            }
            catch {
                throw new Error(`DEFAULT embedding response is not JSON: ${rawText.slice(0, 200)}`);
            }
            return parseEmbeddingsJsonResponse(json, texts.length);
        }
        throw new Error(`Unsupported embedding provider type: ${cfg.type}`);
    }
    /**
     * Embed a single query (e.g. for search). Returns one vector.
     */
    async embedQuery(orgId, query) {
        const vectors = await this.embed(orgId, [query]);
        return vectors[0] ?? [];
    }
    async fetchWithRetry(url, init) {
        const timeoutMs = config.embeddingRequestTimeoutMs;
        const maxAttempts = Math.max(1, config.embeddingRetryCount + 1);
        const baseBackoffMs = config.embeddingRetryBackoffMs;
        let lastErr;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const response = await fetch(url, {
                    ...init,
                    signal: AbortSignal.timeout(timeoutMs),
                });
                return response;
            }
            catch (err) {
                lastErr = err;
                if (attempt >= maxAttempts)
                    break;
                const delay = baseBackoffMs * attempt;
                logger.warn({
                    url,
                    attempt,
                    maxAttempts,
                    delayMs: delay,
                    timeoutMs,
                    err: err?.message ?? String(err),
                }, "embed: request failed, retrying");
                await sleep(delay);
            }
        }
        throw embeddingFetchFailed(url, lastErr);
    }
    /**
     * Retrieve context for dynamic prompt enhancement (e.g. prepend to system prompt).
     */
    async getRagContextForPrompt(orgId, query, limit = DEFAULT_SEARCH_LIMIT, filters) {
        if (!query.trim())
            return "";
        try {
            logger.debug({
                orgId,
                limit,
                queryChars: query.length,
                queryPreview: query.slice(0, 120),
                ...summarizeRagChunkSearchFilters(filters),
            }, "embed: getRagContextForPrompt");
            const embeddingCfg = await this.getConfig(orgId);
            const embedding = await this.embedQuery(orgId, query);
            const rows = await vectorRepo.searchChunks(orgId, embedding, embeddingCfg.dimensions, embeddingCfg.model, limit, filters);
            logger.debug({
                orgId,
                rowCount: rows.length,
                ...summarizeRagChunkSearchFilters(filters),
            }, "embed: getRagContextForPrompt result");
            if (rows.length === 0)
                return "";
            return "Relevant knowledge base excerpts:\n" + rows.map((r) => r.content_text).join("\n\n---\n\n");
        }
        catch {
            return "";
        }
    }
}
