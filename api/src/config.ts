export enum LlmProviderType {
  OPENAI = "OPENAI",
  ANTHROPIC = "ANTHROPIC",
  CUSTOM = "CUSTOM",
  OLLAMA = "OLLAMA",
}

/** Stored on org as lowercase: openai | ollama | default | other */
export enum EmbeddingProviderType {
  OPENAI = "OPENAI",
  OLLAMA = "OLLAMA",
  /** HTTP POST JSON `{ texts: string[] }`, response `{ embeddings }` (e.g. nomic-embed service) */
  DEFAULT = "DEFAULT",
  /** OpenAI-compatible embeddings API (requires API key) */
  OTHER = "OTHER",
}

export interface LlmProvider {
  type: string;
  model: string;
  temperature?: number;
  baseUrl?: string;
  apiKey?: string;
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

/** Pino log levels; `silent` disables logging. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";

export interface AppConfig {
  nodeEnv: string;
  port: number;

  defaultOrg: string;

  /** Pino logging (LOG_LEVEL, LOG_PRETTY). */
  logging: {
    level: LogLevel;
    /** Human-readable logs via pino-pretty (default on in non-production when LOG_PRETTY unset). */
    pretty: boolean;
  };

  /** Postgres + pgvector for RAG chunks */
  pg: {
    connectionString: string;
  };

  corsOrigin?: string;
  systemPrompt?: string;

  // 32-byte base64 key
  encKeyB64: string;


  /** Chunking for RAG document ingestion */
  chunking: {
    /** "fixed" = fixed-size with overlap; "paragraph" = by paragraph/section */
    strategy: "fixed" | "paragraph";
    /** Target chunk size in tokens (used for "fixed" strategy) */
    chunkSizeTokens: number;
    /** Overlap in tokens between consecutive chunks (used for "fixed" strategy) */
    overlapTokens: number;
    /** Approx chars per token for "fixed" (e.g. 4); used when no tokenizer available */
    charsPerToken: number;
  };

  llmConfig: LlmProvider;

  ingestEmbedBatchSize: number;
  ingestEmbedConcurrency: number;
  /** Max `.json` message files per Slack zip; `0` = no limit. Env: `SLACK_ARCHIVE_MAX_JSON_FILES` */
  slackArchiveMaxJsonFiles: number;
  embeddingRequestTimeoutMs: number;
  embeddingRetryCount: number;
  embeddingRetryBackoffMs: number;

  /** Max multipart file size for document upload (bytes). Env: MAX_UPLOAD_FILE_BYTES */
  maxMultipartFileBytes: number;

  defaultAgentPrompt?: string;

  llmProviderType: LlmProviderType;
  embeddingProviderType: EmbeddingProviderType;

  embeddingConfig: EmbeddingConfigResolved;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function parseLlmProviderTypeFromEnv(): LlmProviderType {
  const raw = (process.env.LLM_PROVIDER_TYPE ?? "OPENAI").trim().toUpperCase();
  if (raw === "OLLAMA") return LlmProviderType.OLLAMA;
  if (raw === "ANTHROPIC") return LlmProviderType.ANTHROPIC;
  if (raw === "CUSTOM") return LlmProviderType.CUSTOM;
  return LlmProviderType.OPENAI;
}

/** Accepts EMBEDDING_PROVIDER_TYPE or EMBEDDING_PROVIDER (e.g. `default` from .env). */
function parseEmbeddingProviderTypeFromEnv(): EmbeddingProviderType {
  const raw = (
    process.env.EMBEDDING_PROVIDER_TYPE ??
    process.env.EMBEDDING_PROVIDER ??
    "default"
  )
    .trim()
    .toLowerCase();
  if (raw === "openai") return EmbeddingProviderType.OPENAI;
  if (raw === "ollama") return EmbeddingProviderType.OLLAMA;
  if (raw === "other") return EmbeddingProviderType.OTHER;
  return EmbeddingProviderType.DEFAULT;
}

const resolvedLlmProviderType = parseLlmProviderTypeFromEnv();
const resolvedEmbeddingProviderType = parseEmbeddingProviderTypeFromEnv();

const nodeEnv = process.env.NODE_ENV ?? "development";

function parseLogLevel(raw: string | undefined): LogLevel {
  const allowed: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal", "silent"];
  const v = (raw ?? "").trim().toLowerCase() as LogLevel;
  if (allowed.includes(v)) return v;
  return nodeEnv === "production" ? "info" : "debug";
}

function parseLogPretty(): boolean {
  const e = process.env.LOG_PRETTY?.trim().toLowerCase();
  if (e === "true" || e === "1") return true;
  if (e === "false" || e === "0") return false;
  return nodeEnv !== "production";
}

export const config: AppConfig = {
  defaultOrg: "default_org",
  nodeEnv,
  port: Number(process.env.PORT ?? "3001"),

  logging: {
    // "trace", "debug", "info", "warn", "error", "fatal", "silent"
    level: parseLogLevel(process.env.LOG_LEVEL),
    pretty: parseLogPretty(),
  },

  pg: {
    connectionString: process.env.PG_CONNECTION_STRING ?? "postgres://admin:supersecurepassword@localhost:5432/aic-db",
  },

  corsOrigin: process.env.CORS_ORIGIN || undefined,

  encKeyB64: requireEnv("APP_ENC_KEY_B64"),

  systemPrompt: process.env.SYSTEM_PROMPT || undefined,

  chunking: {
    strategy: (process.env.CHUNKING_STRATEGY ?? "fixed") as "fixed" | "paragraph",
    chunkSizeTokens: Number(process.env.CHUNK_SIZE_TOKENS ?? "750"),
    overlapTokens: Number(process.env.CHUNK_OVERLAP_TOKENS ?? "100"),
    charsPerToken: Number(process.env.CHARS_PER_TOKEN ?? "4"),
  },

  ingestEmbedBatchSize: (() => {
    const n = Math.floor(Number(process.env.INGEST_EMBED_BATCH_SIZE ?? "16"));
    if (!Number.isFinite(n) || n < 1) return 16;
    return Math.min(n, 64);
  })(),
  ingestEmbedConcurrency: (() => {
    const n = Math.floor(Number(process.env.INGEST_EMBED_CONCURRENCY ?? "2"));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, 8) : 2;
  })(),
  slackArchiveMaxJsonFiles: (() => {
    const n = Math.floor(Number(process.env.SLACK_ARCHIVE_MAX_JSON_FILES ?? "0"));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  })(),
  embeddingRequestTimeoutMs: (() => {
    const n = Math.floor(Number(process.env.EMBEDDING_REQUEST_TIMEOUT_MS ?? "120000"));
    return Number.isFinite(n) && n >= 1_000 ? n : 120000;
  })(),
  embeddingRetryCount: (() => {
    const n = Math.floor(Number(process.env.EMBEDDING_RETRY_COUNT ?? "2"));
    return Number.isFinite(n) && n >= 0 ? n : 2;
  })(),
  embeddingRetryBackoffMs: (() => {
    const n = Math.floor(Number(process.env.EMBEDDING_RETRY_BACKOFF_MS ?? "1000"));
    return Number.isFinite(n) && n >= 0 ? n : 1000;
  })(),

  maxMultipartFileBytes: (() => {
    const raw = process.env.MAX_UPLOAD_FILE_BYTES?.trim();
    if (raw) {
      const n = Math.floor(Number(raw));
      if (Number.isFinite(n) && n >= 1_048_576) return n;
    }
    return 512 * 1024 * 1024;
  })(),

  llmConfig: {
    model: process.env.LLM_MODEL ?? "gpt-4o-mini",
    type: (process.env.LLM_PROVIDER_TYPE ?? "openai").toLowerCase(),
    temperature: Number(process.env.LLM_TEMPERATURE ?? "0.7"),
    baseUrl:
      process.env.LLM_BASE_URL ??
      (resolvedLlmProviderType === LlmProviderType.OLLAMA
        ? "http://localhost:11434/v1"
        : "https://api.openai.com/v1"),
    apiKey: process.env.LLM_API_KEY ?? "",
  },
  defaultAgentPrompt: process.env.DEFAULT_AGENT_PROMPT ?? "",
  llmProviderType: resolvedLlmProviderType,
  embeddingProviderType: resolvedEmbeddingProviderType,
  embeddingConfig: {
    type: resolvedEmbeddingProviderType,
    /** Matches docker-compose `skb-nomic-embed` image / typical local nomic service name */
    model: process.env.EMBEDDING_MODEL ?? "nomic-embed-text",
    dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? "768"),
    /** DEFAULT/nomic (docker skb-nomic-embed): `9012:8000` → POST `/embed`. OpenAI-compatible: set `EMBEDDING_HOST` to API base (e.g. `https://api.openai.com/v1`). */
    host: (() => {
      if (process.env.EMBEDDING_HOST?.trim()) return process.env.EMBEDDING_HOST.trim();
      if (
        resolvedEmbeddingProviderType === EmbeddingProviderType.OPENAI ||
        resolvedEmbeddingProviderType === EmbeddingProviderType.OTHER
      ) {
        return "https://api.openai.com/v1";
      }
      return "http://localhost:9012/embed";
    })(),
    apiKey: process.env.EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
  },
};
