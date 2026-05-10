/**
 * Aggregated health for vector DB, embedding HTTP service, and LLM endpoint (from env).
 */

import { config, EmbeddingProviderType, LlmProviderType } from "../config.js";
import { pingPostgres } from "../db/vectorRepo.js";

export interface ComponentStatus {
  id: string;
  displayName: string;
  ok: boolean;
  latencyMs?: number;
  endpoint?: string;
  detail?: string;
  meta?: Record<string, string>;
}

function defaultEmbedUrl(host?: string): string {
  const trimmed = (host ?? "http://localhost:9012/embed").trim();
  try {
    const u = new URL(trimmed);
    if (u.pathname === "/" || u.pathname === "") u.pathname = "/embed";
    return u.toString();
  } catch {
    return trimmed;
  }
}

function ollamaEmbedProbeUrl(host?: string): string {
  const raw = host?.trim() || process.env.OLLAMA_EMBEDDING_HOST || "http://localhost:11434/api/embed";
  try {
    const u = new URL(raw);
    if (u.pathname === "/" || u.pathname === "") u.pathname = "/api/embed";
    return u.toString();
  } catch {
    return raw.replace(/\/api\/embeddings\/?$/, "/api/embed");
  }
}

function ollamaLlmOriginFromBaseUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return baseUrl.replace(/\/v1\/?$/, "");
  }
}

async function checkEmbeddingNomicDefault(): Promise<ComponentStatus> {
  const url = defaultEmbedUrl(config.embeddingConfig.host);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts: ["__kb_status__"] }),
      signal: AbortSignal.timeout(15_000),
    });
    const rawText = await res.text();
    if (!res.ok) {
      return {
        id: "skb-nomic-embed",
        displayName: "Embedding (nomic HTTP)",
        ok: false,
        latencyMs: Date.now() - start,
        endpoint: url,
        detail: `HTTP ${res.status}: ${rawText.slice(0, 180)}`,
      };
    }
    let json: unknown;
    try {
      json = rawText ? JSON.parse(rawText) : null;
    } catch {
      return {
        id: "skb-nomic-embed",
        displayName: "Embedding (nomic HTTP)",
        ok: false,
        latencyMs: Date.now() - start,
        endpoint: url,
        detail: "Response was not JSON",
      };
    }
    const o = json as Record<string, unknown>;
    const emb = o.embeddings ?? o.embedding;
    const ok =
      (Array.isArray(emb) && emb.length > 0) ||
      (Array.isArray(o.embedding) && o.embedding.length > 0);
    if (!ok) {
      return {
        id: "skb-nomic-embed",
        displayName: "Embedding (nomic HTTP)",
        ok: false,
        latencyMs: Date.now() - start,
        endpoint: url,
        detail: "Missing embeddings array in response",
      };
    }
    return {
      id: "skb-nomic-embed",
      displayName: "Embedding (skb-nomic-embed)",
      ok: true,
      latencyMs: Date.now() - start,
      endpoint: url,
      meta: {
        model: config.embeddingConfig.model,
        dimensions: String(config.embeddingConfig.dimensions),
      },
    };
  } catch (e: any) {
    return {
      id: "skb-nomic-embed",
      displayName: "Embedding (skb-nomic-embed)",
      ok: false,
      latencyMs: Date.now() - start,
      endpoint: url,
      detail: e?.message ?? String(e),
    };
  }
}

async function checkEmbeddingOllama(): Promise<ComponentStatus> {
  const url = ollamaEmbedProbeUrl(config.embeddingConfig.host);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.embeddingConfig.model,
        input: ["__kb_status__"],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const rawText = await res.text();
    if (!res.ok) {
      return {
        id: "embedding-ollama",
        displayName: "Embedding (Ollama)",
        ok: false,
        latencyMs: Date.now() - start,
        endpoint: url,
        detail: `HTTP ${res.status}: ${rawText.slice(0, 180)}`,
      };
    }
    return {
      id: "embedding-ollama",
      displayName: "Embedding (Ollama)",
      ok: true,
      latencyMs: Date.now() - start,
      endpoint: url,
      meta: { model: config.embeddingConfig.model },
    };
  } catch (e: any) {
    return {
      id: "embedding-ollama",
      displayName: "Embedding (Ollama)",
      ok: false,
      latencyMs: Date.now() - start,
      endpoint: url,
      detail: e?.message ?? String(e),
    };
  }
}

async function checkEmbeddingOpenAiLike(): Promise<ComponentStatus> {
  const apiKey = config.embeddingConfig.apiKey?.trim();
  const base =
    config.embeddingConfig.host?.trim() ||
    "https://api.openai.com/v1";
  const url = `${base.replace(/\/$/, "")}/embeddings`;
  const start = Date.now();
  if (!apiKey) {
    return {
      id: "embedding-openai",
      displayName: "Embedding (OpenAI-compatible)",
      ok: false,
      endpoint: url,
      detail: "No embedding API key configured",
    };
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.embeddingConfig.model,
        input: "ping",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const rawText = await res.text();
    if (!res.ok) {
      return {
        id: "embedding-openai",
        displayName: "Embedding (OpenAI-compatible)",
        ok: false,
        latencyMs: Date.now() - start,
        endpoint: url,
        detail: `HTTP ${res.status}: ${rawText.slice(0, 180)}`,
      };
    }
    return {
      id: "embedding-openai",
      displayName: "Embedding (OpenAI-compatible)",
      ok: true,
      latencyMs: Date.now() - start,
      endpoint: url,
      meta: { model: config.embeddingConfig.model },
    };
  } catch (e: any) {
    return {
      id: "embedding-openai",
      displayName: "Embedding (OpenAI-compatible)",
      ok: false,
      latencyMs: Date.now() - start,
      endpoint: url,
      detail: e?.message ?? String(e),
    };
  }
}

async function checkLlm(): Promise<ComponentStatus> {
  const baseUrl = config.llmConfig.baseUrl ?? "";
  const apiKey = config.llmConfig.apiKey ?? "";
  const provider = config.llmProviderType;
  const start = Date.now();

  if (provider === LlmProviderType.OLLAMA) {
    const origin = ollamaLlmOriginFromBaseUrl(baseUrl || "http://localhost:11434/v1");
    const tagsUrl = `${origin.replace(/\/$/, "")}/api/tags`;
    try {
      const res = await fetch(tagsUrl, { signal: AbortSignal.timeout(8000) });
      const rawText = await res.text();
      if (!res.ok) {
        return {
          id: "llm",
          displayName: "LLM (Ollama)",
          ok: false,
          latencyMs: Date.now() - start,
          endpoint: tagsUrl,
          detail: `HTTP ${res.status}: ${rawText.slice(0, 120)}`,
          meta: { model: config.llmConfig.model },
        };
      }
      return {
        id: "llm",
        displayName: "LLM (Ollama)",
        ok: true,
        latencyMs: Date.now() - start,
        endpoint: tagsUrl,
        meta: { model: config.llmConfig.model, baseUrl },
      };
    } catch (e: any) {
      return {
        id: "llm",
        displayName: "LLM (Ollama)",
        ok: false,
        latencyMs: Date.now() - start,
        endpoint: tagsUrl,
        detail: e?.message ?? String(e),
        meta: { model: config.llmConfig.model },
      };
    }
  }

  const modelsUrl = `${baseUrl.replace(/\/$/, "")}/models`;
  try {
    const headers: Record<string, string> = {};
    if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(12_000) });
    const rawText = await res.text();
    if (!res.ok) {
      return {
        id: "llm",
        displayName: "LLM (OpenAI-compatible)",
        ok: false,
        latencyMs: Date.now() - start,
        endpoint: modelsUrl,
        detail: `HTTP ${res.status}: ${rawText.slice(0, 160)}`,
        meta: { model: config.llmConfig.model },
      };
    }
    return {
      id: "llm",
      displayName: "LLM (OpenAI-compatible)",
      ok: true,
      latencyMs: Date.now() - start,
      endpoint: modelsUrl,
      meta: {
        model: config.llmConfig.model,
        baseUrl,
        apiKeyPresent: apiKey.trim() ? "yes" : "no",
      },
    };
  } catch (e: any) {
    return {
      id: "llm",
      displayName: "LLM",
      ok: false,
      latencyMs: Date.now() - start,
      endpoint: modelsUrl,
      detail: e?.message ?? String(e),
      meta: { model: config.llmConfig.model },
    };
  }
}

export async function getSystemStatus(): Promise<{
  vectorStore: ComponentStatus;
  embedding: ComponentStatus;
  llm: ComponentStatus;
}> {
  const pg = await pingPostgres();
  let pgHostPort = "localhost:5432";
  try {
    const s = config.pg.connectionString;
    const u = new URL(s.replace(/^postgres(ql)?:\/\//i, "http://"));
    pgHostPort = `${u.hostname}:${u.port || "5432"}`;
  } catch {
    /* keep default */
  }
  const vectorStore: ComponentStatus = {
    id: "skb-postgres",
    displayName: "Vector store (skb-postgres)",
    ok: pg.ok,
    latencyMs: pg.latencyMs,
    endpoint: pgHostPort,
    detail: pg.ok ? undefined : pg.error,
  };

  let embedding: ComponentStatus;
  switch (config.embeddingProviderType) {
    case EmbeddingProviderType.OLLAMA:
      embedding = await checkEmbeddingOllama();
      break;
    case EmbeddingProviderType.OPENAI:
    case EmbeddingProviderType.OTHER:
      embedding = await checkEmbeddingOpenAiLike();
      break;
    case EmbeddingProviderType.DEFAULT:
    default:
      embedding = await checkEmbeddingNomicDefault();
      break;
  }

  const llm = await checkLlm();

  return { vectorStore, embedding, llm };
}
