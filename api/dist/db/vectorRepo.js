import pg from "pg";
import pgvector from "pgvector/pg";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { summarizeRagChunkSearchFilters } from "../utils/ragFiltersLog.js";
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
/** Lightweight connectivity check (matches docker-compose `skb-postgres` / `PG_CONNECTION_STRING`). */
export async function pingPostgres() {
    const start = Date.now();
    try {
        const p = getPool();
        const client = await p.connect();
        try {
            await client.query("SELECT 1");
            return { ok: true, latencyMs: Date.now() - start };
        }
        finally {
            client.release();
        }
    }
    catch (e) {
        return {
            ok: false,
            latencyMs: Date.now() - start,
            error: e?.message ?? String(e),
        };
    }
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
    await client.query("ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS slack_message_at timestamptz");
    await client.query("ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS slack_channel text");
    await client.query("ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS slack_user_id text");
    await client.query("ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS slack_user_label text");
    await client.query(`
    CREATE INDEX IF NOT EXISTS idx_rag_chunks_org_slack_time
    ON rag_chunks (org_id, slack_message_at)
    WHERE slack_message_at IS NOT NULL
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS idx_rag_chunks_org_slack_channel
    ON rag_chunks (org_id, slack_channel)
    WHERE slack_channel IS NOT NULL
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS idx_rag_chunks_org_slack_user
    ON rag_chunks (org_id, slack_user_id)
    WHERE slack_user_id IS NOT NULL
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
          ingest_key,
          slack_message_at,
          slack_channel,
          slack_user_id,
          slack_user_label
        )
         VALUES ($1, $2, $3::vector, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (org_id, ingest_key) WHERE (ingest_key IS NOT NULL) DO NOTHING`, [
                orgId,
                c.text,
                pgvector.toSql(c.embedding),
                c.embeddingModel,
                c.embeddingDimensions,
                c.sourceName ?? null,
                c.ingestKey,
                c.slackMessageAt ?? null,
                c.slackChannel ?? null,
                c.slackUserId ?? null,
                c.slackUserLabel ?? null,
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
 * Optional filters narrow to Slack-indexed rows (null slack columns never match list filters).
 */
export async function searchChunks(orgId, embedding, embeddingDimensions, embeddingModel, limit = 5, filters) {
    await ensureSchemaInitialized();
    const client = await getPool().connect();
    await pgvector.registerTypes(client);
    try {
        const params = [orgId, embeddingDimensions];
        const where = ["org_id = $1", "embedding_dimensions = $2"];
        let i = 2;
        if (embeddingModel?.trim()) {
            i += 1;
            where.push(`(embedding_model = $${i} OR embedding_model IS NULL)`);
            params.push(embeddingModel.trim());
        }
        if (filters?.timeFrom != null) {
            i += 1;
            where.push(`slack_message_at IS NOT NULL AND slack_message_at >= $${i}`);
            params.push(filters.timeFrom);
        }
        if (filters?.timeToExclusive != null) {
            i += 1;
            where.push(`slack_message_at IS NOT NULL AND slack_message_at < $${i}`);
            params.push(filters.timeToExclusive);
        }
        if (filters?.channels?.length) {
            i += 1;
            where.push(`slack_channel = ANY($${i}::text[])`);
            params.push(filters.channels);
        }
        if (filters?.userIds?.length) {
            i += 1;
            where.push(`slack_user_id = ANY($${i}::text[])`);
            params.push(filters.userIds);
        }
        i += 1;
        params.push(pgvector.toSql(embedding));
        const vecRef = `$${i}::vector`;
        i += 1;
        params.push(limit);
        const limitRef = `$${i}`;
        const sql = `SELECT id, org_id, content_text, source_name
         FROM rag_chunks
         WHERE ${where.join(" AND ")}
         ORDER BY embedding <=> ${vecRef}
         LIMIT ${limitRef}`;
        logger.debug({
            orgId,
            embeddingDimensions,
            embeddingModel: embeddingModel?.trim() || null,
            limit,
            ...summarizeRagChunkSearchFilters(filters),
        }, "vector search: rag_chunks query");
        const res = await client.query(sql, params);
        logger.debug({ orgId, rowCount: res.rows.length, ...summarizeRagChunkSearchFilters(filters) }, "vector search: rag_chunks result");
        return res.rows;
    }
    finally {
        client.release();
    }
}
/**
 * Distinct Slack channel folder names with at least one chunk for the org.
 */
export async function listDistinctSlackChannels(orgId) {
    await ensureSchemaInitialized();
    const client = await getPool().connect();
    try {
        const res = await client.query(`SELECT DISTINCT slack_channel
       FROM rag_chunks
       WHERE org_id = $1 AND slack_channel IS NOT NULL
       ORDER BY 1`, [orgId]);
        return res.rows.map((r) => r.slack_channel);
    }
    finally {
        client.release();
    }
}
/**
 * Distinct Slack user ids with a representative display label.
 */
export async function listDistinctSlackUsers(orgId) {
    await ensureSchemaInitialized();
    const client = await getPool().connect();
    try {
        const res = await client.query(`SELECT DISTINCT ON (slack_user_id) slack_user_id, slack_user_label
       FROM rag_chunks
       WHERE org_id = $1 AND slack_user_id IS NOT NULL
       ORDER BY slack_user_id, slack_user_label NULLS LAST`, [orgId]);
        return res.rows.map((r) => ({
            id: r.slack_user_id,
            label: (r.slack_user_label && r.slack_user_label.trim()) || r.slack_user_id,
        }));
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
