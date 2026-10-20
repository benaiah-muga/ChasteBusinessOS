import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { answerChatAsk, chatStore, useChat, type AskPayload, type ChatMsg } from "../chat-store";
import { CHAT_MESSAGE_MAX_UNITS, type ChatUsage } from "../api/chat";
import { ProposalCard } from "./ProposalCard";
import { WorkmateRecordCard } from "./WorkmateRecordCard";
import "./ChatTranscript.css";

/** Compact token counts for chips: 1234 -> "1.2k". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Models occasionally answer with markdown and the odd em dash. The legacy
 * helper targeted the ASCII hyphen (mangling hyphenated words and list
 * bullets) instead of the em dash; this replaces the real dash characters so
 * no em dash ever reaches the screen and hyphens survive untouched.
 */
export function sanitizeReply(text: string): string {
  return text.replace(/\u2014/g, ", ").replace(/\u2013/g, "-");
}

export function UsageChip({ usage }: { usage: ChatUsage }) {
  const cachedPct = usage.input > 0 ? Math.min(100, Math.round((usage.cachedInput / usage.input) * 100)) : 0;
  return (
    <span
      title={`${formatTokens(usage.input)} prompt tokens, ${formatTokens(usage.output)} reply tokens${usage.cachedInput ? `, ${formatTokens(usage.cachedInput)} served from provider cache` : ""}`}
      className="chat-usage-chip"
    >
      <span>in {formatTokens(usage.input)}</span>
      <span aria-hidden="true">·</span>
      <span>out {formatTokens(usage.output)}</span>
      {cachedPct > 0 && (
        <>
          <span aria-hidden="true">·</span>
          <span>{cachedPct}% cached</span>
        </>
      )}
    </span>
  );
}

/** Clarification card: options to tap, or free text; locks after answering. */
function AskCard({ ask, answered }: { ask: AskPayload; answered?: string }) {
  const [other, setOther] = useState("");
  const done = answered !== undefined;
  return (
    <div className="chat-ask">
      <p className="chat-ask-question">{ask.question}</p>
      {done ? (
        <p className="chat-ask-answered">{answered}</p>
      ) : (
        <>
          {ask.options.length > 0 && (
            <div className="chat-ask-options">
              {ask.options.map((option) => (
                <button key={option} type="button" onClick={() => answerChatAsk(ask.id, option)}>
                  {option}
                </button>
              ))}
            </div>
          )}
          {ask.allowOther && (
            <form
              className="chat-ask-other"
              onSubmit={(event) => {
                event.preventDefault();
                const text = other.trim();
                if (text) answerChatAsk(ask.id, text);
              }}
            >
              <input
                value={other}
                onChange={(event) => setOther(event.target.value)}
                placeholder="Other…"
                aria-label="Other answer"
              />
              <button type="submit" disabled={!other.trim()} aria-label="Send answer">
                →
              </button>
            </form>
          )}
        </>
      )}
    </div>
  );
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  // Order matters: code spans first so their contents are untouched.
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(__[^_]+__)|(_[^_\n]+_)/g;
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Block-level: paragraphs, bullets, numbered lists; inline styling within. */
function MarkdownLite({ text }: { text: string }) {
  const lines = sanitizeReply(text).split("\n");
  const blocks: React.ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushList = (key: string) => {
    if (!list) return;
    const items = list.items.map((item, index) => (
      <li key={index} className="leading-relaxed">
        {renderInline(item, `${key}-${index}`)}
      </li>
    ));
    blocks.push(list.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
    list = null;
  };

  lines.forEach((rawLine, index) => {
    const line = rawLine.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list || list.ordered) flushList(`b${index}`);
      list = list ?? { ordered: false, items: [] };
      list.items.push(bullet[1]!);
      return;
    }
    if (numbered) {
      if (!list || !list.ordered) flushList(`b${index}`);
      list = list ?? { ordered: true, items: [] };
      list.items.push(numbered[2]!);
      return;
    }
    flushList(`b${index}`);
    if (!line.trim()) return;
    blocks.push(
      <p key={`p${index}`} className="whitespace-pre-wrap leading-relaxed">
        {renderInline(line, `p${index}`)}
      </p>,
    );
  });
  flushList("b-end");

  return <div className="chat-markdown">{blocks}</div>;
}

export function scrollChatToBottom(ref: RefObject<HTMLDivElement | null>) {
  requestAnimationFrame(() => {
    // scrollTop assignment works in jsdom too, where scrollTo does not exist.
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  });
}

export function useAutoScroll(dependency: unknown) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    scrollChatToBottom(scrollRef);
  }, [dependency]);
  return scrollRef;
}

/** Message transcript shared by the chat page and the dock. */
export function MessageList({
  messages,
  busy,
  compact = false,
  organizationId = null,
}: {
  messages: ChatMsg[];
  busy: boolean;
  compact?: boolean;
  organizationId?: string | null;
}) {
  return (
    <div className={`chat-transcript${compact ? " chat-transcript-compact" : ""}`}>
      {messages.map((message, index) => {
        const isLast = index === messages.length - 1;
        if (message.role === "user") {
          return (
            <div key={index} className="chat-row chat-row-user">
              <div className="chat-bubble-user">
                {message.text}
                {message.steered && <span className="chat-steered-note">steered into the running turn</span>}
              </div>
            </div>
          );
        }
        return (
          <div key={index} className="chat-row">
            <span aria-hidden="true" className="chat-avatar">
              ✦
            </span>
            <div className="chat-message-body">
              {(message.activity?.length ?? 0) > 0 && (
                <div className="chat-activity">
                  {message.activity!.map((activity, activityIndex) => {
                    const pending = busy && isLast && activityIndex === message.activity!.length - 1;
                    return (
                      <span key={activityIndex} className={pending ? "chat-activity-chip chat-activity-chip-pending" : "chat-activity-chip"}>
                        {activity}
                      </span>
                    );
                  })}
                </div>
              )}
              {message.text ? (
                <div className={message.error ? "chat-error-text" : undefined}>
                  {message.role === "assistant" ? (
                    <MarkdownLite text={message.text} />
                  ) : (
                    <p className="whitespace-pre-wrap leading-relaxed">{sanitizeReply(message.text)}</p>
                  )}
                </div>
              ) : (
                !(message.activity?.length ?? 0) && (
                  <span className="chat-thinking" role="status">
                    <span className="chat-thinking-dots" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                    Thinking…
                  </span>
                )
              )}
              {message.ask && <AskCard ask={message.ask} answered={message.answered} />}
              {message.card && <WorkmateRecordCard card={message.card} />}
              {message.proposal && <ProposalCard proposal={message.proposal} organizationId={organizationId} />}
              {message.usage && <UsageChip usage={message.usage} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  placeholder,
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function autosize() {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }

  useLayoutEffect(() => {
    autosize();
  }, [value]);

  useLayoutEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  return (
    <form
      className="chat-composer"
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
      <textarea
        ref={textareaRef}
        value={value}
        maxLength={CHAT_MESSAGE_MAX_UNITS}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSend();
          }
        }}
        rows={1}
        aria-label="Message your workmate"
        placeholder={placeholder ?? (busy ? "Steer the run: it joins the next step…" : "Ask anything, or describe what you need done…")}
      />
      {busy && (
        <button type="button" className="chat-stop-button" onClick={onStop}>
          Stop
        </button>
      )}
      <button
        type="submit"
        className="chat-send-button"
        disabled={!value.trim()}
        aria-label={busy ? "Steer the running turn" : "Send message"}
      >
        →
      </button>
    </form>
  );
}

export function useChatSend() {
  const { busy } = useChat();
  return {
    busy,
    send: (text: string) => chatStore.send(text),
    stop: () => chatStore.stop(),
  };
}
