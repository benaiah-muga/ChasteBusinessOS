import { useEffect, useState } from "react";
import { chatStore, useChat } from "../chat-store";
import { navigate } from "../navigation";
import { ChatComposer, MessageList, formatTokens, useAutoScroll } from "./ChatTranscript";
import "./ChatDock.css";

/**
 * Floating workmate dock: a bubble on every page that expands into a panel
 * sharing the chat page's store. History and an in-flight stream survive
 * shrinking or expanding because both surfaces render the same conversation.
 */
export function ChatDock({ pathname, organizationId = null }: { pathname: string; organizationId?: string | null }) {
  const { messages, busy, creator, queue, step, lastTool, sessionUsage } = useChat();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const scrollRef = useAutoScroll(messages);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // The chat page is the expanded form of this dock; showing both at once
  // would put two composers on the same conversation.
  if (pathname === "/chat") return null;

  const statusLine = busy
    ? step
      ? `Step ${step.step}/${step.maxSteps}${lastTool ? ` · ${lastTool.split(".").pop() ?? lastTool}` : ""}`
      : "Working…"
    : creator
      ? "Creator mode"
      : "Assist mode";

  function submit() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    void chatStore.send(text);
  }

  return (
    <>
      {!open && (
        <button
          type="button"
          className="chat-dock-bubble"
          aria-label="Open chat"
          title="Chat with your workmate"
          onClick={() => setOpen(true)}
        >
          ✦
          {busy && <span className="chat-dock-bubble-pulse" aria-hidden="true" />}
        </button>
      )}

      {open && (
        <section className="chat-dock-panel" role="dialog" aria-label="Chat with your workmate">
          <header className="chat-dock-head">
            <span aria-hidden="true" className="chat-dock-avatar">
              ✦
              {busy && <span className="chat-dock-avatar-pulse" />}
            </span>
            <div className="chat-dock-title">
              <p>Workmate</p>
              <span className={busy ? "chat-dock-status chat-dock-status-busy" : "chat-dock-status"}>{statusLine}</span>
            </div>
            <button
              type="button"
              className="chat-dock-icon-button"
              aria-label="Open the full chat page"
              title="Open the full chat page"
              onClick={() => {
                setOpen(false);
                navigate("/chat");
              }}
            >
              ⤢
            </button>
            <button
              type="button"
              className="chat-dock-icon-button"
              aria-label="Close chat"
              title="Close chat"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </header>

          <div ref={scrollRef} className="chat-dock-scroll">
            <MessageList messages={messages} busy={busy} compact organizationId={organizationId} />
          </div>

          {busy && (
            <div className="chat-console-strip" role="status">
              <span className="chat-strip-light" aria-hidden="true" />
              <span className="chat-strip-working">working</span>
              {step && (
                <span>
                  step {step.step}/{step.maxSteps}
                </span>
              )}
              {lastTool && <span className="chat-strip-tool">{lastTool}</span>}
              <span className="chat-strip-tokens">{formatTokens(sessionUsage.input + sessionUsage.output)} tok</span>
            </div>
          )}

          {queue.length > 0 && (
            <div className="chat-queue" aria-label="Queued messages">
              <span className="chat-queue-label">queued</span>
              {queue.map((queued, index) => (
                <span key={`${index}:${queued}`} className="chat-queue-chip">
                  <span className="chat-queue-text">{queued}</span>
                  <button
                    type="button"
                    onClick={() => chatStore.removeQueued(index)}
                    aria-label={`Remove queued message: ${queued}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="chat-dock-composer">
            <ChatComposer
              value={input}
              onChange={setInput}
              onSend={submit}
              onStop={() => chatStore.stop()}
              busy={busy}
              autoFocus
            />
          </div>
        </section>
      )}
    </>
  );
}
