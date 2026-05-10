import type {
  ChatCompletionMessage,
  ChatCompletionResponse,
  DocumentIngestMode,
  PublicAppConfig,
  SystemStatusResponse,
  UploadDocumentResponse,
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
  chatCompletion: (messages: ChatCompletionMessage[]) =>
    request<ChatCompletionResponse>("/api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages }),
    }),

  getDocumentVectorCount: () => request<{ count: number }>("/api/v1/documents/vectors/count"),

  clearDocumentVectors: () =>
    request<{ deleted: number }>("/api/v1/documents/vectors", { method: "DELETE" }),

  uploadDocument: async (
    file: File,
    ingestMode: DocumentIngestMode = "text"
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
    return res.json() as Promise<UploadDocumentResponse>;
  },
};
