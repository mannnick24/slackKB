/**
 * Produce embeddings using org-level config (from OrgItem.embeddingConfig).
 * Fallback: env OPENAI_API_KEY and default model when org has no config.
 */

import OpenAI from "openai";
import { CryptoService } from "./crypto.service.js";
import * as vectorRepo from "../db/vectorRepo.js";

const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_DIMENSIONS = 768;

type EmbeddingProviderType = "OPENAI" | "OLLAMA" | "DEFAULT" | "OTHER";
const DEFAULT_SEARCH_LIMIT = 5;

/**
 * Ollama's current API is POST /api/embed with body { model, input }.
 * Older docs used /api/embeddings and a single `embedding` field — we normalize the URL
 * and parse both response shapes.
 */
function normalizeOllamaEmbedUrl(host: string): string {
  const trimmed = host.trim();
  if (!trimmed) return "http://localhost:11434/api/embed";
  try {
    const u = new URL(trimmed);
    if (u.pathname === "/api/embeddings" || u.pathname.endsWith("/api/embeddings")) {
      u.pathname = u.pathname.replace(/\/api\/embeddings\/?$/, "/api/embed");
    }
    if (u.pathname === "/" || u.pathname === "") {
      u.pathname = "/api/embed";
    }
    return u.toString();
  } catch {
    return trimmed.replace(/\/api\/embeddings\/?$/, "/api/embed");
  }
}

/** Parses Ollama /api/embed or simple HTTP servers that return { embeddings } / { embedding }. */
function parseEmbeddingsJsonResponse(json: unknown, expectedCount: number): number[][] {
  if (!json || typeof json !== "object") {
    throw new Error("Unexpected embedding response: not an object");
  }
  const o = json as Record<string, unknown>;
  if (Array.isArray(o.embeddings)) {
    const emb = o.embeddings as unknown[];
    const vectors: number[][] = [];
    for (const row of emb) {
      if (!Array.isArray(row)) {
        throw new Error("Unexpected embedding response: embeddings row is not an array");
      }
      vectors.push(row.map((n) => Number(n)));
    }
    if (vectors.length !== expectedCount) {
      throw new Error(
        `Embedding server returned ${vectors.length} vector(s), expected ${expectedCount}`
      );
    }
    return vectors;
  }
  if (Array.isArray(o.embedding)) {
    if (expectedCount !== 1) {
      throw new Error(
        "Embedding response had single `embedding` but batch was requested"
      );
    }
    return [o.embedding.map((n) => Number(n))];
  }
  throw new Error(
    "Unexpected embedding response: expected `embeddings` or `embedding` array"
  );
}

/**
 * Simple embedding service: POST JSON `{ "texts": string[] }`, response `{ "embeddings": number[][] }`
 * (e.g. packages/nomic-embed/server.py).
 */
function normalizeDefaultEmbedUrl(host: string): string {
  const trimmed = host.trim();
  if (!trimmed) return "http://localhost:9012/embed";
  try {
    const u = new URL(trimmed);
    if (u.pathname === "/" || u.pathname === "") {
      u.pathname = "/embed";
    }
    return u.toString();
  } catch {
    return trimmed;
  }
}

export interface EmbeddingConfigResolved {
  /** Logical provider type used to select the client implementation. */
  type: EmbeddingProviderType;
  /** Optional API key (required for OpenAI, not used for Ollama). */
  apiKey?: string;
  model: string;
  dimensions: number;
  /**
   * Optional HTTP host/base URL for the embedding endpoint.
   * Ollama: POST /api/embed. DEFAULT: POST body `{ texts }` (e.g. http://host:9012/embed).
   */
  host?: string;
}

export class EmbeddingService {
  constructor(
    private cryptoService: CryptoService
  ) {}

  /**
   * Resolve embedding config for an org. Uses OrgItem.embeddingConfig if present,
   * otherwise fallback to OPENAI_API_KEY env and default model.
   */
  async getConfig(orgId: string): Promise<EmbeddingConfigResolved> {
    // TODO from config
    const enc: any = {provider: "default", model: ""};

    if (enc) {
      const provider = enc.provider.toLowerCase();
      if (provider === "openai") {
        const apiKey = enc.apiKeyEnc
          ? this.cryptoService.openJson<string>(enc.apiKeyEnc)
          : process.env.OPENAI_API_KEY;
        if (!apiKey) {
          throw new Error("OpenAI embedding config requires an API key");
        }
        return {
          type: "OPENAI",
          apiKey,
          model: enc.model || DEFAULT_MODEL,
          dimensions: enc.dimensions || DEFAULT_DIMENSIONS,
          host: enc.host,
        };
      }
      if (provider === "ollama") {
        return {
          type: "OLLAMA",
          model: enc.model || DEFAULT_MODEL,
          dimensions: enc.dimensions || DEFAULT_DIMENSIONS,
          host: enc.host || process.env.OLLAMA_EMBEDDING_HOST || "http://localhost:11434/api/embed",
        };
      }
      if (provider === "default") {
        return {
          type: "DEFAULT",
          model: enc.model || "nomic-embed-text-v1.5",
          dimensions: enc.dimensions || DEFAULT_DIMENSIONS,
          host:
            enc.host ||
            process.env.DEFAULT_EMBEDDING_HOST ||
            "http://localhost:9012/embed",
        };
      }
      if (provider === "other") {
        const apiKey = enc.apiKeyEnc
          ? this.cryptoService.openJson<string>(enc.apiKeyEnc)
          : process.env.OPENAI_API_KEY;
        if (!apiKey) {
          throw new Error(
            "OTHER embedding provider requires an API key (org or OPENAI_API_KEY)"
          );
        }
        return {
          type: "OTHER",
          apiKey,
          model: enc.model || DEFAULT_MODEL,
          dimensions: enc.dimensions || DEFAULT_DIMENSIONS,
          host: enc.host,
        };
      }
      // Unknown provider: fall back to OpenAI semantics if possible.
      const apiKey =
        enc.apiKeyEnc !== undefined
          ? this.cryptoService.openJson<string>(enc.apiKeyEnc)
          : process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error(
          `Unsupported embedding provider "${enc.provider}" and no OPENAI_API_KEY fallback is configured`
        );
      }
      return {
        type: "OPENAI",
        apiKey,
        model: enc.model || DEFAULT_MODEL,
        dimensions: enc.dimensions || DEFAULT_DIMENSIONS,
        host: enc.host,
      };
    }
    const fallbackKey = process.env.OPENAI_API_KEY;
    if (!fallbackKey) {
      throw new Error("No embedding config for org and OPENAI_API_KEY not set");
    }
    return {
      type: "OPENAI",
      apiKey: fallbackKey,
      model: DEFAULT_MODEL,
      dimensions: DEFAULT_DIMENSIONS,
      host: undefined,
    };
  }

  /**
   * Embed a list of texts for the given org. Returns one vector per text.
   */
  async embed(orgId: string, texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
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
      const rawHost =
        cfg.host || process.env.OLLAMA_EMBEDDING_HOST || "http://localhost:11434/api/embed";
      const url = normalizeOllamaEmbedUrl(rawHost);
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: cfg.model,
          input: texts.length === 1 ? texts[0] : texts,
        }),
      });
      const rawText = await resp.text();
      if (!resp.ok) {
        throw new Error(
          `Ollama embedding request failed: ${resp.status} ${resp.statusText} ${rawText || "(empty body)"}`
        );
      }
      let json: unknown;
      try {
        json = rawText ? JSON.parse(rawText) : null;
      } catch {
        throw new Error(`Ollama embedding response is not JSON: ${rawText.slice(0, 200)}`);
      }
      const vectors = parseEmbeddingsJsonResponse(json, texts.length);
      return vectors;
    }

    if (cfg.type === "DEFAULT") {
      const rawHost =
        cfg.host ||
        process.env.DEFAULT_EMBEDDING_HOST ||
        "http://localhost:9012/embed";
      const url = normalizeDefaultEmbedUrl(rawHost);
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts }),
      });
      const rawText = await resp.text();
      if (!resp.ok) {
        throw new Error(
          `DEFAULT embedding request failed: ${resp.status} ${resp.statusText} ${rawText || "(empty body)"}`
        );
      }
      let json: unknown;
      try {
        json = rawText ? JSON.parse(rawText) : null;
      } catch {
        throw new Error(`DEFAULT embedding response is not JSON: ${rawText.slice(0, 200)}`);
      }
      return parseEmbeddingsJsonResponse(json, texts.length);
    }

    throw new Error(`Unsupported embedding provider type: ${cfg.type}`);
  }

  /**
   * Embed a single query (e.g. for search). Returns one vector.
   */
  async embedQuery(orgId: string, query: string): Promise<number[]> {
    const vectors = await this.embed(orgId, [query]);
    return vectors[0] ?? [];
  }

  
/**
 * Retrieve context for dynamic prompt enhancement (e.g. prepend to system prompt).
 */
 async getRagContextForPrompt(
  orgId: string,
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT
): Promise<string> {
  if (!query.trim()) return "";
  try {
      const embeddingCfg = await this.getConfig(orgId);
      const embedding = await this.embedQuery(orgId, query);
      const rows = await vectorRepo.searchChunks(
          orgId,
          embedding,
          embeddingCfg.dimensions,
          embeddingCfg.model,
          limit
      );
      if (rows.length === 0) return "";
      return "Relevant knowledge base excerpts:\n" + rows.map((r) => r.content_text).join("\n\n---\n\n");
  } catch {
      return "";
  }
}
}
