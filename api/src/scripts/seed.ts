import pg from "pg";
import { config } from "../config.js";
import { logger } from "../logger.js";

type SeedConfig = {

  orgLlmProvider: {
    type: string;
    model: string;
    temperature: number;
    baseUrl?: string;
  };
  orgLlmCredential?: { apiKey: string };

  orgEmbeddingConfig?: {
    provider: string;
    model: string;
    dimensions: number;
    host?: string;
  };
};

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

const seed: SeedConfig = {

  orgLlmProvider: {
    type: env("SEED_LLM_PROVIDER_TYPE", "OLLAMA"),
    model: env("SEED_LLM_MODEL", "gpt-oss:latest"),
    temperature: Number(optionalEnv("SEED_LLM_TEMPERATURE") ?? "0.2"),
    baseUrl: optionalEnv("SEED_LLM_BASE_URL"),
  },
  orgLlmCredential: optionalEnv("SEED_LLM_API_KEY")
    ? { apiKey: env("SEED_LLM_API_KEY") }
    : undefined,

  orgEmbeddingConfig: {
    provider: env("SEED_EMBEDDING_PROVIDER", "ollama"),
    model: env("SEED_EMBEDDING_MODEL", "nomic-embed-text"),
    dimensions: Number(env("SEED_EMBEDDING_DIMENSIONS", "768")),
    host: env("SEED_EMBEDDING_HOST", "http://localhost:9012/embed"),
  },
};

/** Run pgvector + rag_chunks init if not already applied. Skips if Postgres is unavailable. */
async function ensurePgVectorInit(): Promise<void> {
  const client = new pg.Client({ connectionString: config.pg.connectionString });
  try {
    await client.connect();
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    await client.query(`
      CREATE TABLE IF NOT EXISTS rag_chunks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id text NOT NULL,
        content_text text NOT NULL,
        embedding vector NOT NULL,
        embedding_model text,
        embedding_dimensions integer,
        source_name text,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query("ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS embedding_model text");
    await client.query("ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS embedding_dimensions integer");
    await client.query("ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS ingest_key text");
    await client.query("ALTER TABLE rag_chunks ALTER COLUMN embedding TYPE vector");
    await client.query(`
      UPDATE rag_chunks
      SET embedding_dimensions = vector_dims(embedding)
      WHERE embedding_dimensions IS NULL
    `);
    await client.query("DROP INDEX IF EXISTS idx_rag_chunks_embedding");
    await client.query("CREATE INDEX IF NOT EXISTS idx_rag_chunks_org_id ON rag_chunks (org_id)");
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_rag_chunks_org_dim_model ON rag_chunks (org_id, embedding_dimensions, embedding_model)"
    );
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rag_chunks_org_ingest_key
      ON rag_chunks (org_id, ingest_key)
      WHERE ingest_key IS NOT NULL
    `);
    logger.info("seed: pgvector and rag_chunks initialized");
  } catch (err: any) {
    logger.warn({ err }, "seed: pgvector init skipped");
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  await ensurePgVectorInit();
}

main().catch((err) => {
  logger.error({ err }, "seed: failed");
  process.exit(1);
});
