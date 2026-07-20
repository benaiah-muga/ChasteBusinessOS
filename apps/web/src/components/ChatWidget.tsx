"use client";

import type { ChatMessage, UiPart } from "@chaste/api-client";
import {
  Bot,
  Check,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  Info,
  Maximize2,
  MessageSquareText,
  Minimize2,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getApiClient } from "@/lib/api";

function PartView({
  part,
  onConfirm,
  onCancel,
  onSuggestion,
  busy,
}: {
  part: UiPart;
  onConfirm: (id: string) => void;
  onCancel: (id: string) => void;
  onSuggestion: (message: string) => void;
  busy: boolean;
}) {
  switch (part.type) {
    case "text":
      return <p className="part-text">{part.text}</p>;
    case "explanation":
      return (
        <details className="part-explain" open>
          <summary>
            <Info size={15} />
            Why this is allowed
          </summary>
          <p>{part.summary}</p>
          {part.reasons.length ? (
            <ul>
              {part.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
          {part.rulesApplied.length ? (
            <div className="mono">rules: {part.rulesApplied.join(", ")}</div>
          ) : null}
        </details>
      );
    case "confirm_action":
      return (
        <div className="part-confirm">
          <div className="confirm-icon">
            <ClipboardCheck size={18} />
          </div>
          <div>
            <strong>{part.title}</strong>
            {part.description ? <p className="muted">{part.description}</p> : null}
            <div className="mono command-name">{part.command}</div>
            <div className="row">
              <button
                className="btn"
                type="button"
                disabled={busy || part.confirmLabel === "Disabled"}
                onClick={() => onConfirm(part.id)}
              >
                <Check size={16} />
                {part.confirmLabel}
              </button>
              <button className="btn secondary" type="button" disabled={busy} onClick={() => onCancel(part.id)}>
                <X size={16} />
                {part.cancelLabel}
              </button>
            </div>
          </div>
        </div>
      );
    case "table":
      return (
        <div className="table-wrap compact">
          <table className="table">
            <thead>
              <tr>
                {part.columns.map((column) => (
                  <th key={column.key}>{column.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {part.rows.map((row, index) => (
                <tr key={index}>
                  {part.columns.map((column) => (
                    <td key={column.key}>{String(row[column.key] ?? "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "metric":
      return (
        <div className="metric-part">
          <span>{part.label}</span>
          <strong>{part.value}</strong>
          {part.hint ? <small>{part.hint}</small> : null}
        </div>
      );
    case "clarify":
      return (
        <div className="part-callout">
          {part.questions.map((question) => (
            <p key={question}>{question}</p>
          ))}
        </div>
      );
    case "plan":
      return (
        <div className="part-plan">
          <strong>{part.title}</strong>
          {part.steps.map((step, index) => (
            <div key={`${step.command}-${index}`} className="plan-step">
              <span>{index + 1}</span>
              <div>
                <p>{step.description}</p>
                <small className="mono">{step.command}</small>
              </div>
            </div>
          ))}
        </div>
      );
    case "suggestions":
      return (
        <div className="suggestion-row">
          {part.suggestions.map((suggestion) => (
            <button key={suggestion} className="chip" type="button" onClick={() => onSuggestion(suggestion)}>
              {suggestion}
              <ChevronRight size={14} />
            </button>
          ))}
        </div>
      );
    case "error":
      return (
        <div className="part-error">
          <strong>{part.code ?? "Error"}</strong>
          <p>{part.message}</p>
        </div>
      );
    default:
      return (
        <pre className="mono part-raw">
          {JSON.stringify(part, null, 2)}
        </pre>
      );
  }
}

export function ChatWidget({ floating = false }: { floating?: boolean }) {
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [panelOpen, setPanelOpen] = useState(!floating);
  const [capsuleOpen, setCapsuleOpen] = useState(!floating);
  const [error, setError] = useState<string | null>(null);

  const statusLines = useMemo(() => {
    if (!busy) return ["Ready for a command"];
    return ["Thinking", "Analyzing intent", "Checking autonomy", "Routing through command bus"];
  }, [busy]);

  async function send(payload: { message?: string; confirmId?: string; cancelId?: string }) {
    setBusy(true);
    setError(null);
    setPanelOpen(true);
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

  function submitMessage(message = text) {
    const next = message.trim();
    if (!next) return;
    setText("");
    void send({ message: next });
  }

  useEffect(() => {
    function onPrompt(event: Event) {
      const detail = (event as CustomEvent<{ prompt?: string }>).detail;
      if (detail?.prompt) {
        setCapsuleOpen(true);
        void send({ message: detail.prompt });
      }
    }
    window.addEventListener("chaste-agent-message", onPrompt);
    return () => window.removeEventListener("chaste-agent-message", onPrompt);
  }, [sessionId]);

  const composer = (
    <form
      className="agent-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submitMessage();
      }}
    >
      <MessageSquareText size={18} />
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        onFocus={() => setCapsuleOpen(true)}
        placeholder="Ask the agent to create, prepare, list, or explain..."
      />
      <button className="icon-btn send-btn" type="submit" disabled={busy || !text.trim()} title="Send">
        <Send size={17} />
      </button>
    </form>
  );

  return (
    <>
      <aside className={panelOpen ? "agent-panel open" : "agent-panel"} aria-label="AI agent conversation">
        <header className="agent-panel-head">
          <div>
            <div className="eyebrow">
              <Sparkles size={14} />
              AI command surface
            </div>
            <h2>Operations agent</h2>
          </div>
          <button className="icon-btn" type="button" onClick={() => setPanelOpen(false)} title="Close agent panel">
            <X size={18} />
          </button>
        </header>
        <div className="agent-status">
          {statusLines.map((line, index) => (
            <div key={line} className={index === statusLines.length - 1 ? "current" : ""}>
              {busy && index === statusLines.length - 1 ? <Clock3 size={14} /> : <Check size={14} />}
              <span>{line}</span>
            </div>
          ))}
        </div>
        <div className="chat-log">
          {messages.length === 0 ? (
            <div className="agent-empty">
              <Bot size={34} />
              <strong>Tell the agent what business action you want.</strong>
              <p>It will validate intent, explain rules, and execute only through the backend command path.</p>
              <div className="suggestion-row">
                {["Create customer Acme Ltd in Nairobi", "List invoices", "Prepare payroll for July 2026"].map(
                  (suggestion) => (
                    <button key={suggestion} className="chip" type="button" onClick={() => submitMessage(suggestion)}>
                      {suggestion}
                    </button>
                  ),
                )}
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <div key={message.id} className={`bubble ${message.role}`}>
                {message.parts.map((part, index) => (
                  <PartView
                    key={`${message.id}-${index}`}
                    part={part}
                    busy={busy}
                    onConfirm={(id) => send({ confirmId: id })}
                    onCancel={(id) => send({ cancelId: id })}
                    onSuggestion={submitMessage}
                  />
                ))}
              </div>
            ))
          )}
          {error ? <div className="part-error">{error}</div> : null}
        </div>
        {composer}
      </aside>
      {floating && !panelOpen ? (
        <div className={capsuleOpen ? "agent-capsule expanded" : "agent-capsule"}>
          {capsuleOpen ? (
            <>
              {composer}
              <button className="icon-btn" type="button" onClick={() => setPanelOpen(true)} title="Open full agent">
                <Maximize2 size={17} />
              </button>
              <button className="icon-btn" type="button" onClick={() => setCapsuleOpen(false)} title="Minimize agent">
                <Minimize2 size={17} />
              </button>
            </>
          ) : (
            <button className="agent-orb" type="button" onClick={() => setCapsuleOpen(true)} title="AI Agent">
              <Bot size={24} />
            </button>
          )}
        </div>
      ) : null}
    </>
  );
}
