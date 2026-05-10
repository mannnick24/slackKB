export var LlmProviderType;
(function (LlmProviderType) {
    LlmProviderType["OPENAI"] = "OPENAI";
    LlmProviderType["ANTHROPIC"] = "ANTHROPIC";
    LlmProviderType["CUSTOM"] = "CUSTOM";
    LlmProviderType["OLLAMA"] = "OLLAMA";
})(LlmProviderType || (LlmProviderType = {}));
/** Stored on org as lowercase: openai | ollama | default | other */
export var EmbeddingProviderType;
(function (EmbeddingProviderType) {
    EmbeddingProviderType["OPENAI"] = "OPENAI";
    EmbeddingProviderType["OLLAMA"] = "OLLAMA";
    /** HTTP POST JSON `{ texts: string[] }`, response `{ embeddings }` (e.g. nomic-embed service) */
    EmbeddingProviderType["DEFAULT"] = "DEFAULT";
    /** OpenAI-compatible embeddings API (requires API key) */
    EmbeddingProviderType["OTHER"] = "OTHER";
})(EmbeddingProviderType || (EmbeddingProviderType = {}));
function requireEnv(name) {
    const v = process.env[name];
    if (!v)
        throw new Error(`Missing env var: ${name}`);
    return v;
}
function parseLlmProviderTypeFromEnv() {
    const raw = (process.env.LLM_PROVIDER_TYPE ?? "OPENAI").trim().toUpperCase();
    if (raw === "OLLAMA")
        return LlmProviderType.OLLAMA;
    if (raw === "ANTHROPIC")
        return LlmProviderType.ANTHROPIC;
    if (raw === "CUSTOM")
        return LlmProviderType.CUSTOM;
    return LlmProviderType.OPENAI;
}
/** Accepts EMBEDDING_PROVIDER_TYPE or EMBEDDING_PROVIDER (e.g. `default` from .env). */
function parseEmbeddingProviderTypeFromEnv() {
    const raw = (process.env.EMBEDDING_PROVIDER_TYPE ??
        process.env.EMBEDDING_PROVIDER ??
        "default")
        .trim()
        .toLowerCase();
    if (raw === "openai")
        return EmbeddingProviderType.OPENAI;
    if (raw === "ollama")
        return EmbeddingProviderType.OLLAMA;
    if (raw === "other")
        return EmbeddingProviderType.OTHER;
    return EmbeddingProviderType.DEFAULT;
}
const resolvedLlmProviderType = parseLlmProviderTypeFromEnv();
const resolvedEmbeddingProviderType = parseEmbeddingProviderTypeFromEnv();
export const config = {
    defaultOrg: "default_org",
    nodeEnv: process.env.NODE_ENV ?? "development",
    port: Number(process.env.PORT ?? "3001"),
    pg: {
        connectionString: process.env.PG_CONNECTION_STRING ?? "postgres://admin:supersecurepassword@localhost:5432/aic-db",
    },
    corsOrigin: process.env.CORS_ORIGIN || undefined,
    encKeyB64: requireEnv("APP_ENC_KEY_B64"),
    systemPrompt: process.env.SYSTEM_PROMPT || undefined,
    chunking: {
        strategy: (process.env.CHUNKING_STRATEGY ?? "fixed"),
        chunkSizeTokens: Number(process.env.CHUNK_SIZE_TOKENS ?? "750"),
        overlapTokens: Number(process.env.CHUNK_OVERLAP_TOKENS ?? "100"),
        charsPerToken: Number(process.env.CHARS_PER_TOKEN ?? "4"),
    },
    ingestEmbedBatchSize: (() => {
        const n = Math.floor(Number(process.env.INGEST_EMBED_BATCH_SIZE ?? "64"));
        return Number.isFinite(n) && n >= 1 ? n : 64;
    })(),
    llmConfig: {
        model: process.env.LLM_MODEL ?? "gpt-4o-mini",
        type: (process.env.LLM_PROVIDER_TYPE ?? "openai").toLowerCase(),
        temperature: Number(process.env.LLM_TEMPERATURE ?? "0.7"),
        baseUrl: process.env.LLM_BASE_URL ??
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
            if (process.env.EMBEDDING_HOST?.trim())
                return process.env.EMBEDDING_HOST.trim();
            if (resolvedEmbeddingProviderType === EmbeddingProviderType.OPENAI ||
                resolvedEmbeddingProviderType === EmbeddingProviderType.OTHER) {
                return "https://api.openai.com/v1";
            }
            return "http://localhost:9012/embed";
        })(),
        apiKey: process.env.EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
    },
};
