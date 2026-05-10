import React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ComponentHealth } from "../api/types";
import { Layout } from "../components/Layout";

function HealthRow({ item }: { item: ComponentHealth }) {
  return (
    <tr>
      <td style={{ padding: "10px 8px", verticalAlign: "top" }}>
        <div style={{ fontWeight: 600 }}>{item.displayName}</div>
        <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>{item.id}</div>
      </td>
      <td style={{ padding: "10px 8px" }}>
        <span
          style={{
            display: "inline-block",
            padding: "2px 8px",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            background: item.ok ? "#d1fae5" : "#fee2e2",
            color: item.ok ? "#065f46" : "#991b1b",
          }}
        >
          {item.ok ? "Up" : "Down"}
        </span>
        {item.latencyMs != null && (
          <span style={{ marginLeft: 10, fontSize: 13, opacity: 0.85 }}>{item.latencyMs} ms</span>
        )}
      </td>
      <td style={{ padding: "10px 8px", fontSize: 13, wordBreak: "break-all" }}>
        {item.endpoint && (
          <div style={{ marginBottom: 6 }}>
            <span style={{ opacity: 0.7 }}>Probe: </span>
            {item.endpoint}
          </div>
        )}
        {item.detail && (
          <div style={{ color: "crimson", marginBottom: 6, whiteSpace: "pre-wrap" }}>{item.detail}</div>
        )}
        {item.meta && Object.keys(item.meta).length > 0 && (
          <pre
            style={{
              margin: 0,
              padding: 8,
              background: "#f6f6f6",
              borderRadius: 6,
              fontSize: 12,
              overflow: "auto",
              maxWidth: "100%",
            }}
          >
            {JSON.stringify(item.meta, null, 2)}
          </pre>
        )}
      </td>
    </tr>
  );
}

export function StatusPage() {
  const q = useQuery({
    queryKey: ["systemStatus"],
    queryFn: api.getSystemStatus,
    refetchInterval: 15_000,
  });

  return (
    <Layout title="Status">
      <p style={{ fontSize: 14, opacity: 0.85, marginBottom: 16 }}>
        Health checks use the API process environment: Postgres (
        <code>PG_CONNECTION_STRING</code>, docker service <strong>skb-postgres</strong>), embedding HTTP (
        <code>EMBEDDING_HOST</code> / provider type, docker <strong>skb-nomic-embed</strong> on port{" "}
        <strong>9012</strong>), and LLM (<code>LLM_BASE_URL</code>, <code>LLM_PROVIDER_TYPE</code>,{" "}
        <code>LLM_MODEL</code>).
      </p>
      {q.isLoading && <div>Loading…</div>}
      {q.error && <div style={{ color: "crimson" }}>{String(q.error)}</div>}
      {q.data && (
        <table
          style={{
            width: "100%",
            maxWidth: 960,
            borderCollapse: "collapse",
            border: "1px solid #ddd",
          }}
        >
          <thead>
            <tr style={{ background: "#f0f0f0", textAlign: "left" }}>
              <th style={{ padding: 10 }}>Service</th>
              <th style={{ padding: 10 }}>State</th>
              <th style={{ padding: 10 }}>Details</th>
            </tr>
          </thead>
          <tbody>
            <HealthRow item={q.data.vectorStore} />
            <HealthRow item={q.data.embedding} />
            <HealthRow item={q.data.llm} />
          </tbody>
        </table>
      )}
    </Layout>
  );
}
