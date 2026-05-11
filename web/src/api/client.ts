import type {
  ChatCompletionMessage,
  ChatCompletionResponse,
  DocumentIngestMode,
  PublicAppConfig,
  RagFilterUserOption,
  RagFiltersPayload,
  SystemStatusResponse,
  UploadDocumentResponse,
  UploadJobProgress,
} from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const body = init.body;
  const jsonHeaders =
    typeof body === "string" ? { "Content-Type": "application/json" } : {};

  const res = await fetch(path, {
    ...init,
    headers: {
      ...jsonHeaders,
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, text || res.statusText);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  getServerConfig: () => request<PublicAppConfig>("/api/v1/config"),

  getSystemStatus: () => request<SystemStatusResponse>("/api/v1/status"),

  /** Non-streaming chat; server merges system prompt + RAG tools. */
  chatCompletion: (messages: ChatCompletionMessage[], ragFilters?: RagFiltersPayload) =>
    request<ChatCompletionResponse>("/api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(
        ragFilters && Object.keys(ragFilters).length > 0 ? { messages, ragFilters } : { messages }
      ),
    }),

  getRagFilterChannels: () => request<{ channels: string[] }>("/api/v1/rag/filters/channels"),

  getRagFilterUsers: () => request<{ users: RagFilterUserOption[] }>("/api/v1/rag/filters/users"),

  getDocumentVectorCount: () => request<{ count: number }>("/api/v1/documents/vectors/count"),

  clearDocumentVectors: () =>
    request<{ deleted: number }>("/api/v1/documents/vectors", { method: "DELETE" }),

  getUploadJobProgress: (jobId: string) =>
    request<UploadJobProgress>(
      `/api/v1/documents/upload/jobs/${encodeURIComponent(jobId)}/progress`
    ),

  /**
   * POST multipart returns 202 + `{ jobId }`; polls progress until completed or failed.
   */
  uploadDocument: async (
    file: File,
    ingestMode: DocumentIngestMode = "text",
    options?: {
      /** First delay between progress polls; then backs off until `maxPollMs` (default 1000). */
      pollMs?: number;
      /** Upper bound on delay between polls (default 5000). */
      maxPollMs?: number;
      /** Called after each successful progress poll while the job is queued or running */
      onProgress?: (p: UploadJobProgress) => void;
      /** Max time to wait for the job (default 4 hours) */
      maxWaitMs?: number;
    }
  ): Promise<UploadDocumentResponse> => {
    const formData = new FormData();
    formData.append("ingestMode", ingestMode);
    formData.append("file", file);
    const res = await fetch("/api/v1/documents/upload", {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(res.status, text || res.statusText);
    }

    const initialPollMs = options?.pollMs ?? 1000;
    const maxPollMs = options?.maxPollMs ?? 5000;
    const maxWaitMs = options?.maxWaitMs ?? 4 * 60 * 60 * 1000;
    const deadline = Date.now() + maxWaitMs;
    const onProgress = options?.onProgress;
    let nextPollDelayMs = initialPollMs;

    if (res.status === 200) {
      return (await res.json()) as UploadDocumentResponse;
    }

    if (res.status !== 202) {
      const text = await res.text().catch(() => "");
      throw new ApiError(res.status, text || res.statusText);
    }

    const { jobId } = (await res.json()) as { jobId: string };

    while (Date.now() < deadline) {
      let p: UploadJobProgress;
      try {
        p = await request<UploadJobProgress>(
          `/api/v1/documents/upload/jobs/${encodeURIComponent(jobId)}/progress`
        );
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          throw new ApiError(
            404,
            "Ingest job not found (server may have restarted while processing)."
          );
        }
        throw e;
      }

      onProgress?.(p);

      if (p.status === "completed" && p.result) {
        return p.result;
      }
      if (p.status === "failed") {
        const msg =
          p.details?.length && p.error
            ? `${p.error}: ${p.details.join("; ")}`
            : p.error ?? "Ingest failed";
        throw new ApiError(400, msg);
      }

      await new Promise((r) => setTimeout(r, nextPollDelayMs));
      nextPollDelayMs = Math.min(
        maxPollMs,
        Math.round(nextPollDelayMs * 1.35)
      );
    }

    throw new ApiError(504, "Timed out waiting for ingest job to finish.");
  },
};
