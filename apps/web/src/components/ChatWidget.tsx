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
import { useEffect, useId, useMemo, useState } from "react";
import { getApiClient } from "@/lib/api";

function confirmStatus(part: Extract<UiPart, { type: "confirm_action" }>): "pending" | "confirmed" | "cancelled" | "superseded" {
  return part.status ?? "pending";
}

function PartView({
  part,
  onConfirm,
  onCancel,
  onSuggestion,
  busy,
  liveConfirmId,
}: {
  part: UiPart;
  onConfirm: (id: string) => void;
  onCancel: (id: string) => void;
  onSuggestion: (message: string) => void;
  busy: boolean;
  /** Only this confirmation id may render live Confirm/Cancel controls. */
  liveConfirmId?: string;
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
            <div className="muted" style={{ fontSize: "0.78rem" }}>
              Policy used: {part.rulesApplied.join(", ")}
            </div>
          ) : null}
        </details>
      );
    case "confirm_action": {
      const status = confirmStatus(part);
      const isLive =
        status === "pending" &&
        part.confirmLabel !== "Disabled" &&
        liveConfirmId === part.id;
      const statusLabel =
        status === "confirmed"
          ? "Confirmed"
          : status === "cancelled"
            ? "Cancelled"
            : status === "superseded"
              ? "Superseded"
              : part.confirmLabel === "Disabled"
                ? "Recommendation only"
                : liveConfirmId && liveConfirmId !== part.id
                  ? "No longer pending"
                  : null;

      return (
        <div
          className={isLive ? "part-confirm" : "part-confirm resolved"}
          data-confirm-id={part.id}
          data-confirm-status={status}
          data-confirm-live={isLive ? "true" : "false"}
        >
          <div className="confirm-icon">
            <ClipboardCheck size={18} />
          </div>
          <div>
            <strong>{part.title}</strong>
            {part.description ? <p className="muted">{part.description}</p> : null}
            <div className="muted" style={{ fontSize: "0.78rem" }}>{part.command.replace(/\./g, " · ")}</div>
            {isLive ? (
              <div className="row">
                <button
                  className="btn"
                  type="button"
                  disabled={busy}
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
            ) : statusLabel ? (
              <div className="confirm-status" aria-label={`Action ${statusLabel.toLowerCase()}`}>
                <Check size={14} />
                {statusLabel}
              </div>
            ) : null}
          </div>
        </div>
      );
    }
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
                <small className="muted">{step.command.replace(/\./g, " · ")}</small>
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

function Composer({
  text,
  setText,
  busy,
  onSubmit,
  onFocus,
  inputId,
}: {
  text: string;
  setText: (value: string) => void;
  busy: boolean;
  onSubmit: () => void;
  onFocus?: () => void;
  inputId: string;
}) {
  return (
    <form
      className="agent-composer"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <MessageSquareText size={18} aria-hidden />
      <input
        id={inputId}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onFocus={onFocus}
        placeholder="Ask the assistant to create, prepare, list, or explain..."
        autoComplete="off"
      />
      <button className="icon-btn send-btn" type="submit" disabled={busy || !text.trim()} title="Send">
        <Send size={17} />
      </button>
    </form>
  );
}

export function ChatWidget({ floating = false }: { floating?: boolean }) {
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pendingConfirmationId, setPendingConfirmationId] = useState<string | undefined>();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [panelOpen, setPanelOpen] = useState(!floating);
  const [capsuleOpen, setCapsuleOpen] = useState(!floating);
  const [error, setError] = useState<string | null>(null);
  const composerInputId = useId();

  const statusLines = useMemo(() => {
    if (!busy) return ["Ready"];
    return ["Thinking", "Analyzing request", "Checking permissions", "Running"];
  }, [busy]);

  // Exactly one composer surface at a time: full panel when open, otherwise
  // the floating capsule (when expanded). Never both — the closed panel stays
  // in the DOM (slide-off animation) but must not expose a second input.
  const showPanelComposer = panelOpen;
  const showCapsuleComposer = floating && !panelOpen && capsuleOpen;

  async function send(payload: { message?: string; confirmId?: string; cancelId?: string }) {
    setBusy(true);
    setError(null);
    setPanelOpen(true);
    try {
      const api = getApiClient();
      const res = await api.chat({ sessionId, ...payload });
      setSessionId(res.sessionId);
      setMessages(res.messages);
      setPendingConfirmationId(res.pendingConfirmationId);
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

  const composerProps = {
    text,
    setText,
    busy,
    onSubmit: () => submitMessage(),
    inputId: composerInputId,
  };

  return (
    <>
      <aside
        className={panelOpen ? "agent-panel open" : "agent-panel"}
        aria-label="Operations assistant conversation"
        aria-hidden={!panelOpen}
        // Closed floating panel is only CSS-translated off-screen; keep it out
        // of the accessibility tree and non-interactive so automation/users
        // never see a second composer or stale confirm controls.
        inert={!panelOpen ? true : undefined}
      >
        <header className="agent-panel-head">
          <div>
            <div className="eyebrow">
              <Sparkles size={14} />
              Operations assistant
            </div>
            <h2>Assistant</h2>
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
              <strong>Tell the assistant what you want to do.</strong>
              <p>It checks permissions, explains its reasoning, and performs actions safely.</p>
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
                    liveConfirmId={pendingConfirmationId}
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
        {showPanelComposer ? <Composer {...composerProps} /> : null}
      </aside>
      {floating && !panelOpen ? (
        <div className={capsuleOpen ? "agent-capsule expanded" : "agent-capsule"}>
          {capsuleOpen ? (
            <>
              {showCapsuleComposer ? (
                <Composer {...composerProps} onFocus={() => setCapsuleOpen(true)} />
              ) : null}
              <button className="icon-btn" type="button" onClick={() => setPanelOpen(true)} title="Open full assistant">
                <Maximize2 size={17} />
              </button>
              <button className="icon-btn" type="button" onClick={() => setCapsuleOpen(false)} title="Minimize assistant">
                <Minimize2 size={17} />
              </button>
            </>
          ) : (
            <button className="agent-orb" type="button" onClick={() => setCapsuleOpen(true)} title="Assistant">
              <Bot size={24} />
            </button>
          )}
        </div>
      ) : null}
    </>
  );
}
