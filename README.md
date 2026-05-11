# slackKB

slackKB is a small **knowledge-base + chat** stack: a **Fastify** API (`api/`) stores **embedded text** in **Postgres with pgvector**, and a **Vite + React** UI (`web/`) drives configuration, health checks, document ingest, and **RAG-aware chat** (optional **Slack-scoped filters** on retrieval).

The API merges a configurable **system prompt** and **tooling** so the LLM can answer using retrieved chunks when appropriate.

---

## Web UI overview

| Area | Purpose |
|------|--------|
| **Config** | Shows **non-secret** server config from `GET /api/v1/config` (DB URL, API keys, and encryption key are redacted). **Knowledge base**: vector count, clear-all-vectors, **ingest mode** (plain text vs Slack export zip), file upload. Upload returns **`202` + `jobId`**; the client polls **`GET /api/v1/documents/upload/jobs/:jobId/progress`** with backoff (up to 5s between polls) until the job completes or fails. |
| **Status** | Refreshes **`GET /api/v1/status` every 15s** and shows **vector store** (Postgres ping), **embedding** (provider-specific probe), and **LLM** (OpenAI-compatible `models` or Ollama `api/tags`). Latency and error text help debug misconfigured `PG_CONNECTION_STRING`, `EMBEDDING_*`, or `LLM_*` env vars. |
| **Chat** | Simple **non-streaming** chat: message history is sent to **`POST /api/v1/chat/completions`**; the server returns a single assistant **`reply`**. Optional **RAG filter** controls (time range, channels, users) are sent as **`ragFilters`** in the same JSON body when you send a message. |

Dev server: the web app proxies **`/api`** to **`http://localhost:3001`** (see `web/vite.config.ts`). The API listens on **`PORT`** (default **3001**).

---

## Ingest functionality

### Modes

1. **Plain text / markdown** — `.txt`, `.md`, or a **`.zip`** of those files. Content is **parsed**, **chunked** (strategy from env, e.g. `CHUNKING_STRATEGY`, token sizes), **embedded**, and inserted into **`rag_chunks`** for the configured **default org** (`config.defaultOrg`, typically `default_org` unless overridden in code/env).

2. **Slack archive** — A **Slack workspace export** `.zip`. JSON is scanned for **`type: "message"`** objects; each becomes **one chunk** (one embedding per message). **Slack metadata** (message time, channel id/name, user id/label) is stored on the row for later **filtering in chat** (see below).

### Async jobs and progress

- **`POST /api/v1/documents/upload`** (multipart: `file`, `ingestMode`) responds with **`202 Accepted`** and **`{ "jobId": "<uuid>" }`** after the file is fully received.
- Ingest runs **in memory** in the API process; progress is keyed by **`jobId`** in an in-process store (lost on restart).
- **`GET /api/v1/documents/upload/jobs/:jobId/progress`** returns `status` (`queued` \| `running` \| `completed` \| `failed`), `stage`, `percent`, optional counters, and on success a **`result`** object (files/messages processed, vectors stored, duplicates skipped, warnings/errors).

Other useful endpoints: **`GET /api/v1/documents/vectors/count`**, **`DELETE /api/v1/documents/vectors`** (clears chunks for the default org; **omit** `Content-Type: application/json` if you send no body).

After successful ingest or after clearing vectors, the API **invalidates the in-memory RAG filter cache** so channel/user picklists refresh on next load.

---

## Chat page and RAG filter metadata

### UI behaviour

- **Filters** load once from **`GET /api/v1/rag/filters/channels`** and **`GET /api/v1/rag/filters/users`** (multi-select lists, datetime range **From** / **To (exclusive)**).
- On **Send**, the client builds an optional **`ragFilters`** payload: ISO **`timeFrom`**, **`timeToExclusive`**, **`channels[]`**, **`userIds[]`** — only non-empty fields are sent.
- **Rows without Slack metadata** (e.g. from plain-text ingest) **do not match** channel, user, or time constraints; filters then effectively narrow retrieval to **Slack-ingested** chunks only.

### Where metadata lives

Stored on **`rag_chunks`** (Postgres), alongside **`content_text`**, **`embedding`**, **`source_name`**, **`ingest_key`**, and model/dimension fields:

| Column | Role |
|--------|------|
| `slack_message_at` | Message timestamp for time-range filters |
| `slack_channel` | Channel identifier / folder name for channel filter (**OR** across selected channels) |
| `slack_user_id` | Slack user id (e.g. `U…`) for user filter (**OR** across selected users) |
| `slack_user_label` | Display label stored for UI / debugging |

Indexes exist on **org + time**, **org + channel**, and **org + user** (partial, where the Slack columns are non-null) to support filtered vector search.

### How filters are used at query time

- **`POST /api/v1/chat/completions`** accepts **`ragFilters`** (validated server-side into **`RagChunkSearchFilters`**).
- The agent path resolves the user’s latest query, **embeds** it with the same org embedding config, and runs **similarity search** over **`rag_chunks`** with **SQL pre-filters** derived from `ragFilters` (time bounds, channel list, user id list).
- **Channel and user picklists** are built from **distinct values** in the DB for the default org (`vectorRepo.listDistinctSlackChannels` / `listDistinctSlackUsers`), cached in memory for **`RAG_FILTER_CACHE_TTL_MS`** (default 90s) unless invalidated after ingest/clear.

---

## Building and running

### Prerequisites

| Dependency | Role |
|------------|------|
| **Postgres + pgvector** | Primary **vector store** (`rag_chunks`). Repo includes **`api/docker-compose.yml`** with **`pgvector/pgvector:pg16`** (`skb-postgres`), default DB/user/password aligned with `api/src/config.ts` when `PG_CONNECTION_STRING` is unset. Mount **`api/db/init-pgvector.sql`** (or equivalent) under **`api/init/`** as **`docker-entrypoint-initdb.d`** on **first** volume create — see comments in `api/db/init-pgvector.sql`. The API also **ensures schema** at runtime via `vectorRepo`. |
| **Embedding service** | Must match **`EMBEDDING_PROVIDER_TYPE`** / related env: **`default`** → HTTP **`POST { "texts": [...] }`** returning **`embeddings`** (default host **`http://localhost:9012/embed`**); **`ollama`** → Ollama embed API; **`openai`** / **`other`** → OpenAI-compatible **`/v1/embeddings`**. Set **`EMBEDDING_MODEL`**, **`EMBEDDING_DIMENSIONS`**, and **`EMBEDDING_HOST`** / keys as required. |
| **LLM** | **`LLM_PROVIDER_TYPE`**: OpenAI-compatible (**`LLM_BASE_URL`**, e.g. `https://api.openai.com/v1`, + **`LLM_API_KEY`**) or **`OLLAMA`** (probed via **`/api/tags`** on the inferred origin). **`LLM_MODEL`** selects the model name sent to the provider. |

### Required API secret

- **`APP_ENC_KEY_B64`** — 32-byte key (base64), required at startup (used with crypto services for org-scoped embedding config).

### Typical local flow

1. **Start Postgres** (from `api/`):

   ```bash
   docker compose up -d
   ```

   Ensure `PG_CONNECTION_STRING` matches the container (see `api/docker-compose.yml` and `api/src/config.ts` defaults).

2. **Run an embedding server** reachable at `EMBEDDING_HOST` (and matching provider type), and an **LLM** at `LLM_BASE_URL` if not using defaults.

3. **API** (from `api/`):

   ```bash
   # Create api/.env with at least APP_ENC_KEY_B64 (and PG / LLM / embedding overrides if needed)
   npm install
   npm run build
   npm start              # or: npm run dev after build, uses .env
   ```

   Default port **3001** (`PORT`).

4. **Web** (from `web/`):

   ```bash
   npm install
   npm run dev
   ```

   Open the dev URL (e.g. **http://localhost:5173**). API calls go to **`/api/...`** and are proxied to the backend.

### Production-ish notes

- Set **`NODE_ENV=production`**, tighten **`CORS_ORIGIN`**, and supply real secrets for DB, LLM, and embedding keys.
- Ingest jobs and RAG filter caches are **in-process only**; horizontal scaling would need a shared store / sticky sessions (not implemented here).

---

## Repository layout

- **`api/`** — Fastify app: `src/routes/*`, `src/services/*`, `src/db/vectorRepo.ts`, `docker-compose.yml`, `db/init-pgvector.sql`.
- **`web/`** — React SPA: `src/pages/*`, `src/api/client.ts`, Vite proxy for `/api`.
