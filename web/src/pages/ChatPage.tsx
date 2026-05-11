import React, { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import type { ChatCompletionMessage, RagFiltersPayload } from "../api/types";
import { Layout } from "../components/Layout";

function parseApiErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const j = JSON.parse(err.message) as { error?: string };
      if (typeof j?.error === "string") return j.error;
    } catch {
      /* raw text */
    }
    return err.message || String(err);
  }
  return String(err);
}

function buildRagFilters(
  timeFromLocal: string,
  timeToLocal: string,
  selectedChannels: string[],
  selectedUserIds: string[]
): RagFiltersPayload | undefined {
  const out: RagFiltersPayload = {};
  if (timeFromLocal.trim()) {
    const d = new Date(timeFromLocal);
    if (!Number.isNaN(d.getTime())) out.timeFrom = d.toISOString();
  }
  if (timeToLocal.trim()) {
    const d = new Date(timeToLocal);
    if (!Number.isNaN(d.getTime())) out.timeToExclusive = d.toISOString();
  }
  if (selectedChannels.length) out.channels = [...selectedChannels];
  if (selectedUserIds.length) out.userIds = [...selectedUserIds];
  return Object.keys(out).length > 0 ? out : undefined;
}

export function ChatPage() {
  const [messages, setMessages] = useState<ChatCompletionMessage[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const [channels, setChannels] = useState<string[]>([]);
  const [users, setUsers] = useState<{ id: string; label: string }[]>([]);
  const [filtersLoading, setFiltersLoading] = useState(true);
  const [filterLoadError, setFilterLoadError] = useState<string | null>(null);
  const [timeFromLocal, setTimeFromLocal] = useState("");
  const [timeToLocal, setTimeToLocal] = useState("");
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pending]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setFiltersLoading(true);
      setFilterLoadError(null);
      try {
        const [chRes, uRes] = await Promise.all([
          api.getRagFilterChannels(),
          api.getRagFilterUsers(),
        ]);
        if (cancelled) return;
        setChannels([...chRes.channels].sort((a, b) => a.localeCompare(b)));
        setUsers(uRes.users);
      } catch (e) {
        if (!cancelled) setFilterLoadError(parseApiErrorMessage(e));
      } finally {
        if (!cancelled) setFiltersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function clearRagFilters() {
    setTimeFromLocal("");
    setTimeToLocal("");
    setSelectedChannels([]);
    setSelectedUserIds([]);
  }

  async function send() {
    const text = input.trim();
    if (!text || pending) return;
    setError(null);
    const history: ChatCompletionMessage[] = [...messages, { role: "user", content: text }];
    setMessages(history);
    setInput("");
    setPending(true);
    const ragFilters = buildRagFilters(
      timeFromLocal,
      timeToLocal,
      selectedChannels,
      selectedUserIds
    );
    try {
      const { reply } = await api.chatCompletion(history, ragFilters);
      setMessages([...history, { role: "assistant", content: reply }]);
    } catch (e) {
      setError(parseApiErrorMessage(e));
    } finally {
      setPending(false);
    }
  }

  const hasActiveFilters = Boolean(
    buildRagFilters(timeFromLocal, timeToLocal, selectedChannels, selectedUserIds)
  );

  return (
    <Layout title="Chat">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "calc(100vh - 120px)",
          maxWidth: 920,
        }}
      >
        <p style={{ fontSize: 12, opacity: 0.8, marginTop: -8 }}>
          Messages are completed by the server using your configured LLM and RAG tools when relevant.
          Optional filters narrow retrieval to Slack time range, channels, and users.
        </p>

        <div
          style={{
            marginTop: 10,
            padding: 12,
            border: "1px solid #ddd",
            borderRadius: 8,
            background: "#fff",
            fontSize: 13,
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              From (local)
              <input
                type="datetime-local"
                value={timeFromLocal}
                onChange={(e) => setTimeFromLocal(e.target.value)}
                disabled={filtersLoading}
                style={{ fontSize: 13 }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              To (exclusive, local)
              <input
                type="datetime-local"
                value={timeToLocal}
                onChange={(e) => setTimeToLocal(e.target.value)}
                disabled={filtersLoading}
                style={{ fontSize: 13 }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 140 }}>
              Channels
              <select
                multiple
                size={Math.min(6, Math.max(3, channels.length || 1))}
                value={selectedChannels}
                onChange={(e) => {
                  const opts = Array.from(e.target.selectedOptions).map((o) => o.value);
                  setSelectedChannels(opts);
                }}
                disabled={filtersLoading || channels.length === 0}
                style={{ fontSize: 13 }}
              >
                {channels.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 160 }}>
              Users
              <select
                multiple
                size={Math.min(6, Math.max(3, users.length || 1))}
                value={selectedUserIds}
                onChange={(e) => {
                  const opts = Array.from(e.target.selectedOptions).map((o) => o.value);
                  setSelectedUserIds(opts);
                }}
                disabled={filtersLoading || users.length === 0}
                style={{ fontSize: 13 }}
              >
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={clearRagFilters}
              disabled={!hasActiveFilters || pending}
              style={{ padding: "8px 12px", fontSize: 13, alignSelf: "center" }}
            >
              Clear filters
            </button>
          </div>
          <p style={{ margin: "8px 0 0", fontSize: 11, opacity: 0.75 }}>
            Hold Ctrl/Cmd to select multiple channels or users. “To” is exclusive (messages strictly before
            that instant).
          </p>
          {filterLoadError && (
            <p style={{ margin: "6px 0 0", fontSize: 12, color: "crimson" }}>{filterLoadError}</p>
          )}
          {hasActiveFilters && (
            <p style={{ margin: "6px 0 0", fontSize: 12, opacity: 0.85 }}>
              RAG is limited to the current filter selection for this chat.
            </p>
          )}
        </div>

        <div
          style={{
            flex: 1,
            overflowY: "auto",
            border: "1px solid #ddd",
            borderRadius: 8,
            padding: 12,
            marginTop: 12,
            background: "#fafafa",
          }}
        >
          {messages.length === 0 && !pending && (
            <div style={{ opacity: 0.6, fontSize: 14 }}>Send a message to start.</div>
          )}
          {messages.map((m, i) => (
            <div
              key={i}
              style={{
                marginBottom: 12,
                textAlign: m.role === "user" ? "right" : "left",
              }}
            >
              <div
                style={{
                  display: "inline-block",
                  maxWidth: "85%",
                  padding: "8px 12px",
                  borderRadius: 8,
                  background: m.role === "user" ? "#2563eb" : "#e5e7eb",
                  color: m.role === "user" ? "#fff" : "#111",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontSize: 14,
                }}
              >
                {m.content}
              </div>
            </div>
          ))}
          {pending && <div style={{ fontSize: 13, opacity: 0.7 }}>Thinking…</div>}
          <div ref={bottomRef} />
        </div>

        {error && <div style={{ color: "crimson", marginTop: 8, fontSize: 14 }}>{error}</div>}

        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Message… (Enter to send, Shift+Enter for newline)"
            rows={3}
            style={{
              flex: 1,
              resize: "vertical",
              padding: 10,
              borderRadius: 8,
              border: "1px solid #ccc",
              fontFamily: "inherit",
              fontSize: 14,
            }}
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={pending || !input.trim()}
            style={{ alignSelf: "flex-end", padding: "10px 16px" }}
          >
            Send
          </button>
        </div>
      </div>
    </Layout>
  );
}
