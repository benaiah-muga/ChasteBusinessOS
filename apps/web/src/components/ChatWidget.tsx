"use client";

import type { ChatMessage, UiPart } from "@chaste/api-client";
import { useMemo, useState } from "react";
import { getApiClient } from "@/lib/api";

function PartView({
  part,
  onConfirm,
  onCancel,
  busy,
}: {
  part: UiPart;
  onConfirm: (id: string) => void;
  onCancel: (id: string) => void;
  busy: boolean;
}) {
  switch (part.type) {
    case "text":
      return <p className="part-text">{part.text}</p>;
    case "explanation":
      return (
        <div className="part-explain">
          <strong>Why</strong>
          <div>{part.summary}</div>
          {part.reasons.length ? (
            <ul>
              {part.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ) : null}
          {part.rulesApplied.length ? (
            <div className="mono" style={{ marginTop: "0.4rem" }}>
              rules: {part.rulesApplied.join(", ")}
            </div>
          ) : null}
        </div>
      );
    case "confirm_action":
      return (
        <div className="part-confirm">
          <strong>{part.title}</strong>
          {part.description ? <div className="muted">{part.description}</div> : null}
          <div className="mono" style={{ margin: "0.4rem 0" }}>
            {part.command}
          </div>
          <div className="row">
            <button
              className="btn"
              type="button"
              disabled={busy || part.confirmLabel === "Disabled"}
              onClick={() => onConfirm(part.id)}
            >
              {part.confirmLabel}
            </button>
            <button
              className="btn secondary"
              type="button"
              disabled={busy}
              onClick={() => onCancel(part.id)}
            >
              {part.cancelLabel}
            </button>
          </div>
        </div>
      );
    case "table":
      return (
        <table className="table" style={{ marginTop: "0.5rem" }}>
          <thead>
            <tr>
              {part.columns.map((c) => (
                <th key={c.key}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {part.rows.map((row, i) => (
              <tr key={i}>
                {part.columns.map((c) => (
                  <td key={c.key}>{String(row[c.key] ?? "")}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "error":
      return <p className="error">{part.message}</p>;
    default:
      return (
        <pre className="mono" style={{ whiteSpace: "pre-wrap" }}>
          {JSON.stringify(part, null, 2)}
        </pre>
      );
  }
}

export function ChatWidget() {
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("Create customer Acme Ltd in Nairobi");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hint = useMemo(
    () => "AI prepares actions; confirm runs the same command as the manual form.",
    [],
  );

  async function send(payload: {
    message?: string;
    confirmId?: string;
    cancelId?: string;
  }) {
    setBusy(true);
    setError(null);
    try {
      const api = getApiClient();
      const res = await api.chat({ sessionId, ...payload });
      setSessionId(res.sessionId);
      setMessages(res.messages);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chat failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card chat">
      <div>
        <h2>Operations chat</h2>
        <p className="muted" style={{ margin: 0 }}>
          {hint} Endpoint: <span className="mono">POST /api/v1/ai/chat</span>
        </p>
      </div>

      <div className="chat-log">
        {messages.length === 0 ? (
          <div className="muted">No messages yet. Try the suggested prompt.</div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`bubble ${m.role}`}>
              {m.parts.map((part, idx) => (
                <PartView
                  key={`${m.id}-${idx}`}
                  part={part}
                  busy={busy}
                  onConfirm={(id) => send({ confirmId: id })}
                  onCancel={(id) => send({ cancelId: id })}
                />
              ))}
            </div>
          ))
        )}
      </div>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const message = text.trim();
          if (!message) return;
          void send({ message });
        }}
      >
        <input
          style={{ flex: 1 }}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Describe what you want…"
        />
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "…" : "Send"}
        </button>
      </form>
      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}
