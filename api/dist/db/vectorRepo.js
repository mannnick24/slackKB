import pg from "pg";
import pgvector from "pgvector/pg";
import { config } from "../config.js";
let pool = null;
let schemaInitPromise = null;
function getPool() {
    if (!pool) {
        pool = new pg.Pool({ connectionString: config.pg.connectionString });
        pool.on("connect", async (client) => {
            await pgvector.registerTypes(client);
        });
    }
    return pool;
}
async function ensureRagChunksSchema(client) {
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
    // If embedding was created as vector(n), convert to unconstrained vector for mixed dimensions.
    await client.query("ALTER TABLE rag_chunks ALTER COLUMN embedding TYPE vector");
    // Backfill dimensions for legacy rows to support dimension-safe search.
    await client.query(`
    UPDATE rag_chunks
    SET embedding_dimensions = vector_dims(embedding)
    WHERE embedding_dimensions IS NULL
  `);
    // Legacy ivfflat index assumes a single dimension, so it must be removed for mixed-model support.
    await client.query("DROP INDEX IF EXISTS idx_rag_chunks_embedding");
    await client.query("CREATE INDEX IF NOT EXISTS idx_rag_chunks_org_id ON rag_chunks (org_id)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_rag_chunks_org_dim_model ON rag_chunks (org_id, embedding_dimensions, embedding_model)");
    await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rag_chunks_org_ingest_key
    ON rag_chunks (org_id, ingest_key)
    WHERE ingest_key IS NOT NULL
  `);
}
async function ensureSchemaInitialized() {
    if (!schemaInitPromise) {
        schemaInitPromise = (async () => {
            const client = await getPool().connect();
            try {
                await pgvector.registerTypes(client);
                await ensureRagChunksSchema(client);
            }
            finally {
                client.release();
            }
        })().catch((err) => {
            schemaInitPromise = null;
            throw err;
        });
    }
    await schemaInitPromise;
}
/**
 * Insert chunks for an org. Rows with duplicate (org_id, ingest_key) are skipped.
 */
export async function insertChunks(orgId, chunks) {
    await ensureSchemaInitialized();
    const client = await getPool().connect();
    await pgvector.registerTypes(client);
    let inserted = 0;
    let skippedDuplicates = 0;
    try {
        for (const c of chunks) {
            const res = await client.query(`INSERT INTO rag_chunks (
          org_id,
          content_text,
          embedding,
          embedding_model,
          embedding_dimensions,
          source_name,
          ingest_key
        )
         VALUES ($1, $2, $3::vector, $4, $5, $6, $7)
         ON CONFLICT (org_id, ingest_key) WHERE (ingest_key IS NOT NULL) DO NOTHING`, [
                orgId,
                c.text,
                pgvector.toSql(c.embedding),
                c.embeddingModel,
                c.embeddingDimensions,
                c.sourceName ?? null,
                c.ingestKey,
            ]);
            if ((res.rowCount ?? 0) >= 1)
                inserted += 1;
            else
                skippedDuplicates += 1;
        }
    }
    finally {
        client.release();
    }
    return { inserted, skippedDuplicates };
}
/**
 * Search by embedding; returns top-k chunks for the org only.
 */
export async function searchChunks(orgId, embedding, embeddingDimensions, embeddingModel, limit = 5) {
    await ensureSchemaInitialized();
    const client = await getPool().connect();
    await pgvector.registerTypes(client);
    try {
        const sql = embeddingModel?.trim()
            ? `SELECT id, org_id, content_text, source_name
         FROM rag_chunks
         WHERE org_id = $1
           AND embedding_dimensions = $2
           AND (embedding_model = $3 OR embedding_model IS NULL)
         ORDER BY embedding <=> $4::vector
         LIMIT $5`
            : `SELECT id, org_id, content_text, source_name
         FROM rag_chunks
         WHERE org_id = $1
           AND embedding_dimensions = $2
         ORDER BY embedding <=> $3::vector
         LIMIT $4`;
        const res = await client.query(sql, embeddingModel?.trim()
            ? [orgId, embeddingDimensions, embeddingModel.trim(), pgvector.toSql(embedding), limit]
            : [orgId, embeddingDimensions, pgvector.toSql(embedding), limit]);
        return res.rows;
    }
    finally {
        client.release();
    }
}
/**
 * Return the number of chunks (vectors) stored for an org.
 */
export async function getChunkCountByOrg(orgId) {
    const client = await getPool().connect();
    try {
        const res = await client.query("SELECT COUNT(*)::text AS count FROM rag_chunks WHERE org_id = $1", [orgId]);
        return parseInt(res.rows[0]?.count ?? "0", 10);
    }
    finally {
        client.release();
    }
}
/**
 * Delete all chunks for an org (e.g. when re-ingesting or clearing).
 */
export async function deleteChunksByOrg(orgId) {
    const client = await getPool().connect();
    await pgvector.registerTypes(client);
    try {
        const res = await client.query("DELETE FROM rag_chunks WHERE org_id = $1", [orgId]);
        return res.rowCount ?? 0;
    }
    finally {
        client.release();
    }
}
