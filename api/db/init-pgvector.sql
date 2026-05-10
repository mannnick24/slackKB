-- Align with api/src/db/vectorRepo.ts (ensureRagChunksSchema).
-- Docker (api/docker-compose.yml mounts ./init): copy this file to api/init/01-pgvector.sql so Postgres runs it on first boot only.
-- Existing volumes: API startup still runs ALTERs via vectorRepo; or apply this manually / recreate volume.
--
-- Notes:
-- - Unconstrained `vector` (not vector(768)) so mixed embedding dimensions/models are supported.
-- - No ivfflat on embedding alone (legacy index removed at runtime); search filters by org + dimensions + model.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS rag_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  content_text text NOT NULL,
  embedding vector NOT NULL,
  embedding_model text,
  embedding_dimensions integer,
  source_name text,
  ingest_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Idempotent upgrades if an older init script created rag_chunks without these columns:
ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS embedding_model text;
ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS embedding_dimensions integer;
ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS ingest_key text;

-- Normalize legacy vector(n) installs to unconstrained vector (safe if already unconstrained).
ALTER TABLE rag_chunks ALTER COLUMN embedding TYPE vector;

UPDATE rag_chunks
SET embedding_dimensions = vector_dims(embedding)
WHERE embedding_dimensions IS NULL;

DROP INDEX IF EXISTS idx_rag_chunks_embedding;

CREATE INDEX IF NOT EXISTS idx_rag_chunks_org_id ON rag_chunks (org_id);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_org_dim_model ON rag_chunks (org_id, embedding_dimensions, embedding_model);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rag_chunks_org_ingest_key
ON rag_chunks (org_id, ingest_key)
WHERE ingest_key IS NOT NULL;
