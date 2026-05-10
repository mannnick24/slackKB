export type UploadDocumentResponse = {
  filesProcessed: number;
  chunksStored: number;
  skippedDuplicates: number;
  warnings?: string[];
  errors?: string[];
};

/** Matches multipart field `ingestMode` on POST `/documents/upload`. */
export type DocumentIngestMode = "text" | "slack_archive";

/** Mirrors `/api/v1/config` (secrets redacted server-side). */
export type ComponentHealth = {
  id: string;
  displayName: string;
  ok: boolean;
  latencyMs?: number;
  endpoint?: string;
  detail?: string;
  meta?: Record<string, string>;
};

export type SystemStatusResponse = {
  vectorStore: ComponentHealth;
  embedding: ComponentHealth;
  llm: ComponentHealth;
};

export type PublicAppConfig = {
  nodeEnv: string;
  port: number;
  defaultOrg: string;
  pg: { connectionString: string };
  corsOrigin?: string;
  systemPrompt?: string;
  encKeyB64: string;
  chunking: {
    strategy: "fixed" | "paragraph";
    chunkSizeTokens: number;
    overlapTokens: number;
    charsPerToken: number;
  };
  llmConfig: {
    type: string;
    model: string;
    temperature?: number;
    baseUrl?: string;
    apiKey: string;
  };
  defaultAgentPrompt?: string;
  llmProviderType: string;
  embeddingProviderType: string;
};

export type ChatCompletionMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type ChatCompletionResponse = {
  reply: string;
};
