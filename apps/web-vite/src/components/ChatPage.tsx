import { useEffect, useRef, useState } from "react";
import {
  chatStore,
  refreshChatCreatorAvailability,
  resetChat,
  setChatCreator,
  useChat,
} from "../chat-store";
import { CHAT_MESSAGE_MAX_UNITS } from "../api/chat";
import { ChatComposer, MessageList, formatTokens, useAutoScroll } from "./ChatTranscript";
import "./ChatPage.css";

/** Dashboard shortcuts arrive as ?prompt=; mirror MessagesPage's single-param rule. */
function readChatPrompt(): string | null {
  const prompts = new URLSearchParams(window.location.search).getAll("prompt");
  if (prompts.length !== 1) return null;
  const prompt = prompts[0] ?? "";
  return prompt.trim().length > 0 && prompt.length <= CHAT_MESSAGE_MAX_UNITS ? prompt : null;
}

function clearChatPromptFromUrl() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("prompt");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // The param stays; the applied guard below still prevents a resend.
  }
}

export function ChatPage() {
  const { messages, busy, creator, creatorAvailable, queue, step, lastTool, sessionUsage } = useChat();
  const [input, setInput] = useState("");
  const promptAppliedRef = useRef(false);
  const scrollRef = useAutoScroll(messages);

  useEffect(() => {
    void refreshChatCreatorAvailability();
  }, []);

  useEffect(() => {
    // StrictMode double-invokes effects; the ref makes applying the prompt
    // exactly once, even across the double mount.
    if (promptAppliedRef.current) return;
    const prompt = readChatPrompt();
    if (!prompt) return;
    promptAppliedRef.current = true;
    clearChatPromptFromUrl();
    const current = chatStore.getState();
    // A dashboard shortcut means "do this now", so it auto-sends only into an
    // untouched, idle conversation; otherwise it prefills the composer so an
    // existing conversation is never interrupted by surprise.
    if (!current.busy && current.messages.length === 1) {
      void chatStore.send(prompt);
    } else {
      setInput(prompt);
    }
  }, []);

  function submit() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    void chatStore.send(text);
  }

  const sessionTokens = sessionUsage.input + sessionUsage.output;
  const showUsageFooter = sessionTokens > 0 || sessionUsage.cachedInput > 0;

  return (
    <main className="chat-page">
      <div className="chat-page-panel">
        <header className="chat-page-head">
          <div>
            <p className="section-kicker">Assistant</p>
            <h1>Your workmate</h1>
            <p className="chat-page-copy">
              Ask about your books, your team, or the work in motion. Every action runs through the same governed, audited path as you.
            </p>
          </div>
          <div className="chat-page-controls">
            {creatorAvailable && (
              <button
                type="button"
                role="switch"
                aria-checked={creator}
                className={`chat-creator-switch${creator ? " chat-creator-switch-on" : ""}`}
                title="Let the workmate propose new capabilities, not just use existing ones"
                onClick={() => setChatCreator(!creator)}
              >
                <span className="chat-creator-track" aria-hidden="true">
                  <span className="chat-creator-thumb" />
                </span>
                Creator mode
              </button>
            )}
            <button type="button" className="chat-new-button" onClick={() => resetChat()}>
              New conversation
            </button>
          </div>
        </header>

        <div ref={scrollRef} className="chat-page-scroll">
          <MessageList messages={messages} busy={busy} />
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
            <span className="chat-strip-tokens">{formatTokens(sessionTokens)} tok</span>
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

        <div className="chat-page-composer">
          <ChatComposer
            value={input}
            onChange={setInput}
            onSend={submit}
            onStop={() => chatStore.stop()}
            busy={busy}
            autoFocus
          />
          <div className="chat-page-composer-meta">
            <span className="chat-key-hint">
              <kbd>⏎</kbd> send · <kbd>⇧⏎</kbd> newline
            </span>
            {showUsageFooter && (
              <span className="chat-usage-footer" aria-label="Session token usage">
                this session: in {formatTokens(sessionUsage.input)} · out {formatTokens(sessionUsage.output)}
                {sessionUsage.cachedInput > 0 && ` · ${Math.min(100, Math.round((sessionUsage.cachedInput / Math.max(1, sessionUsage.input)) * 100))}% cached`}
              </span>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
