import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { DocumentIngestMode, UploadJobProgress } from "../api/types";
import { Layout } from "../components/Layout";

/** Rotating arc; use while ingest is in flight (server % can plateau before 100). */
function IngestWorkingSpinner() {
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 50 50"
      aria-hidden
      style={{ flexShrink: 0, display: "block", color: "#333" }}
    >
      <circle
        cx="25"
        cy="25"
        r="20"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        opacity={0.2}
      />
      <circle
        cx="25"
        cy="25"
        r="20"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray="31.4 125.6"
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 25 25"
          to="360 25 25"
          dur="0.75s"
          repeatCount="indefinite"
        />
      </circle>
    </svg>
  );
}

export function ConfigPage() {
  const qc = useQueryClient();
  const configQ = useQuery({ queryKey: ["serverConfig"], queryFn: api.getServerConfig });
  const vectorsCountQ = useQuery({
    queryKey: ["documents", "vectors", "count"],
    queryFn: api.getDocumentVectorCount,
  });

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [ingestMode, setIngestMode] = useState<DocumentIngestMode>("text");
  const [uploadJob, setUploadJob] = useState<UploadJobProgress | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const uploadMutation = useMutation({
    mutationFn: ({ file, mode }: { file: File; mode: DocumentIngestMode }) =>
      api.uploadDocument(file, mode, {
        onProgress: (p) => setUploadJob(p),
      }),
    onSuccess: () => {
      setSelectedFile(null);
      setUploadJob(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      qc.invalidateQueries({ queryKey: ["documents", "vectors", "count"] });
    },
    onError: () => {
      setUploadJob(null);
    },
  });

  const clearVectorsMutation = useMutation({
    mutationFn: () => api.clearDocumentVectors(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["documents", "vectors", "count"] });
    },
  });

  return (
    <Layout title="Config">
      <section style={{ marginBottom: 28 }}>
        <h3 style={{ marginBottom: 8 }}>Server configuration</h3>
        <p style={{ fontSize: 12, opacity: 0.8, marginTop: -4 }}>
          Values from the API process environment (secrets such as DB URL, encryption key, and LLM API key are redacted).
        </p>
        {configQ.isLoading && <div>Loading…</div>}
        {configQ.error && (
          <div style={{ color: "crimson" }}>{String(configQ.error)}</div>
        )}
        {configQ.data && (
          <pre
            style={{
              marginTop: 12,
              padding: 12,
              background: "#f6f6f6",
              borderRadius: 8,
              overflow: "auto",
              fontSize: 12,
              maxHeight: "42vh",
            }}
          >
            {JSON.stringify(configQ.data, null, 2)}
          </pre>
        )}
      </section>

      <hr style={{ margin: "28px 0" }} />

      <section>
        <h3 style={{ marginBottom: 8 }}>Knowledge base (RAG)</h3>
        <div
          style={{
            marginBottom: 12,
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 14 }}>
            Vectors stored:{" "}
            {vectorsCountQ.isLoading ? "…" : vectorsCountQ.data?.count ?? 0}
          </span>
          <button
            type="button"
            onClick={() => clearVectorsMutation.mutate()}
            disabled={
              clearVectorsMutation.isPending || (vectorsCountQ.data?.count ?? 0) === 0
            }
          >
            {clearVectorsMutation.isPending ? "Clearing…" : "Clear all vectors"}
          </button>
        </div>
        {clearVectorsMutation.data !== undefined && (
          <div style={{ marginBottom: 8, fontSize: 14, color: "green" }}>
            Cleared {clearVectorsMutation.data.deleted} vector(s).
          </div>
        )}
        {clearVectorsMutation.error && (
          <div style={{ marginBottom: 8, color: "crimson" }}>
            {String(clearVectorsMutation.error)}
          </div>
        )}
        <div
          style={{
            marginBottom: 12,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            fontSize: 14,
          }}
        >
          <span style={{ fontWeight: 600 }}>Ingest mode</span>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="radio"
              name="ingestMode"
              checked={ingestMode === "text"}
              onChange={() => setIngestMode("text")}
            />
            Plain text or markdown (.txt, .md, or .zip of those files) — chunked for RAG
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="radio"
              name="ingestMode"
              checked={ingestMode === "slack_archive"}
              onChange={() => setIngestMode("slack_archive")}
            />
            Slack export (.zip with per-channel JSON) — one embedding per message object
          </label>
        </div>
        <p style={{ fontSize: 12, opacity: 0.8, marginBottom: 12 }}>
          {ingestMode === "text"
            ? "Text uploads are split into chunks, embedded, and stored for retrieval-augmented chat."
            : "Upload the Slack workspace export zip. JSON logs are scanned for objects with type \"message\"; each becomes one stored vector with channel, time, author, and text."}
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.md,.markdown,.zip"
          style={{ display: "none" }}
          onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <button type="button" onClick={() => fileInputRef.current?.click()} style={{ marginRight: 8 }}>
            Choose file
          </button>
          {selectedFile && (
            <>
              <span style={{ fontSize: 14 }}>{selectedFile.name}</span>
              <button
                type="button"
                onClick={() =>
                  uploadMutation.mutate({ file: selectedFile, mode: ingestMode })
                }
                disabled={uploadMutation.isPending}
              >
                {uploadMutation.isPending ? "Uploading..." : "Upload"}
              </button>
            </>
          )}
        </div>
        {uploadMutation.isPending && (
          <div
            style={{ marginTop: 8, fontSize: 13, opacity: 0.9 }}
            role="status"
            aria-live="polite"
            aria-busy="true"
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
              <IngestWorkingSpinner />
              <div style={{ minWidth: 0 }}>
                {uploadJob ? (
                  <>
                    <div>
                      {uploadJob.stage} — {uploadJob.percent}%
                      {uploadJob.filesProcessed !== undefined
                        ? ` · ${uploadJob.filesProcessed} item(s) seen`
                        : null}
                      {uploadJob.chunksStored !== undefined && uploadJob.chunksStored > 0
                        ? ` · ${uploadJob.chunksStored} vector(s) stored`
                        : null}
                    </div>
                    <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>
                      The percent can stay flat while embeddings or DB writes run—the spinner means the job
                      is still active. Job <code>{uploadJob.jobId.slice(0, 8)}…</code>.
                    </div>
                  </>
                ) : (
                  <div>Starting ingest… (waiting for job id from the server)</div>
                )}
              </div>
            </div>
          </div>
        )}
        {uploadMutation.data && (
          <>
            <div style={{ marginTop: 10, fontSize: 14, color: "green" }}>
              Processed{" "}
              {(uploadMutation.variables?.mode ?? ingestMode) === "slack_archive"
                ? `${uploadMutation.data.filesProcessed} message(s)`
                : `${uploadMutation.data.filesProcessed} file(s)`}
              , stored {uploadMutation.data.chunksStored} new vector(s).
              {uploadMutation.data.skippedDuplicates > 0
                ? ` (${uploadMutation.data.skippedDuplicates} duplicate(s) skipped.)`
                : ""}
            </div>
            {uploadMutation.data.warnings?.length ? (
              <div style={{ marginTop: 8, fontSize: 13, color: "#b45309" }}>
                {uploadMutation.data.warnings.join(" ")}
              </div>
            ) : null}
            {uploadMutation.data.errors?.length ? (
              <div style={{ marginTop: 8, fontSize: 13, color: "crimson" }}>
                {uploadMutation.data.errors.join("; ")}
              </div>
            ) : null}
          </>
        )}
        {uploadMutation.error && (
          <div style={{ marginTop: 10, color: "crimson" }}>{String(uploadMutation.error)}</div>
        )}
      </section>
    </Layout>
  );
}
