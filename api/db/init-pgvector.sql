-- Enable pgvector extension. Run once (e.g. in docker init or manually).
CREATE EXTENSION IF NOT EXISTS vector;

-- Chunks only (no source document table); all queries filter by org_id.
-- Embedding dimension 768 matches nomic-embed-text; make configurable per org later.
CREATE TABLE IF NOT EXISTS rag_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  content_text text NOT NULL,
  embedding vector(768) NOT NULL,
  source_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rag_chunks_org_id ON rag_chunks (org_id);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_embedding ON rag_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
