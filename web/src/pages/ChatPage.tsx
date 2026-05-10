import React, { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import type { ChatCompletionMessage } from "../api/types";
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

export function ChatPage() {
  const [messages, setMessages] = useState<ChatCompletionMessage[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pending]);

  async function send() {
    const text = input.trim();
    if (!text || pending) return;
    setError(null);
    const history: ChatCompletionMessage[] = [...messages, { role: "user", content: text }];
    setMessages(history);
    setInput("");
    setPending(true);
    try {
      const { reply } = await api.chatCompletion(history);
      setMessages([...history, { role: "assistant", content: reply }]);
    } catch (e) {
      setError(parseApiErrorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Layout title="Chat">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "calc(100vh - 120px)",
          maxWidth: 720,
        }}
      >
        <p style={{ fontSize: 12, opacity: 0.8, marginTop: -8 }}>
          Messages are completed by the server using your configured LLM and RAG tools when relevant.
        </p>

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
          {pending && (
            <div style={{ fontSize: 13, opacity: 0.7 }}>Thinking…</div>
          )}
          <div ref={bottomRef} />
        </div>

        {error && (
          <div style={{ color: "crimson", marginTop: 8, fontSize: 14 }}>{error}</div>
        )}

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
