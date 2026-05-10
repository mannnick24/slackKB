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
        type: "openai",
        temperature: Number(process.env.LLM_TEMPERATURE ?? "0.7"),
        baseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
        apiKey: process.env.LLM_API_KEY ?? "",
    },
    defaultAgentPrompt: process.env.DEFAULT_AGENT_PROMPT ?? "",
    llmProviderType: LlmProviderType.OPENAI,
    embeddingProviderType: EmbeddingProviderType.DEFAULT,
    embeddingConfig: {
        type: process.env.EMBEDDING_PROVIDER_TYPE ? process.env.EMBEDDING_PROVIDER_TYPE : EmbeddingProviderType.DEFAULT,
        model: process.env.EMBEDDING_MODEL ?? "nomic-embed-text-v1.5",
        dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? "768"),
        host: process.env.EMBEDDING_HOST ?? "http://localhost:9012/embed",
        apiKey: process.env.EMBEDDING_API_KEY ?? "",
    },
};
