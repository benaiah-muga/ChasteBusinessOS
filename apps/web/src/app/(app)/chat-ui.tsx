"use client";

import { useEffect, useRef, type RefObject } from "react";
import { ErrorDetails, ToolChip } from "@/components/ui";
import { IconArrowRight, IconSparkle } from "@/components/icons";
import { chatStore, useChat, type ChatMsg } from "./chat-store";

export function scrollChatToBottom(ref: RefObject<HTMLDivElement | null>) {
  requestAnimationFrame(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  });
}

/**
 * Models occasionally answer with markdown (bold, code, lists) and the odd
 * em dash. Render structure instead of leaking raw "**", and normalize
 * dashes so no em dash ever reaches the screen, whatever the model emits.
 */
export function sanitizeReply(text: string): string {
  return text.replace(/—/g, ", ").replace(/–/g, "-");
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  // Order matters: code spans first so their contents are untouched.
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(__[^_]+__)|(_[^_\n]+_)/g;
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith("`")) {
      nodes.push(
        <code key={key} className="rounded bg-stone-100 px-1 py-0.5 font-mono text-[0.85em] text-stone-800">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(
        <strong key={key} className="font-semibold text-stone-900">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      nodes.push(
        <em key={key} className="italic">
          {token.slice(1, -1)}
        </em>,
      );
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
    const items = list.items.map((item, i) => (
      <li key={i} className="leading-relaxed">
        {renderInline(item, `${key}-${i}`)}
      </li>
    ));
    blocks.push(
      list.ordered ? (
        <ol key={key} className="ml-4 list-decimal space-y-1">
          {items}
        </ol>
      ) : (
        <ul key={key} className="ml-4 list-disc space-y-1">
          {items}
        </ul>
      ),
    );
    list = null;
  };

  lines.forEach((rawLine, idx) => {
    const line = rawLine.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list || list.ordered) flushList(`b${idx}`);
      list = list ?? { ordered: false, items: [] };
      list.items.push(bullet[1]!);
      return;
    }
    if (numbered) {
      if (!list || !list.ordered) flushList(`b${idx}`);
      list = list ?? { ordered: true, items: [] };
      list.items.push(numbered[2]!);
      return;
    }
    flushList(`b${idx}`);
    if (!line.trim()) return;
    blocks.push(
      <p key={`p${idx}`} className="leading-relaxed whitespace-pre-wrap">
        {renderInline(line, `p${idx}`)}
      </p>,
    );
  });
  flushList("b-end");

  return <div className="space-y-2 text-sm">{blocks}</div>;
}

export function useAutoScroll(dependency: unknown) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollChatToBottom(scrollRef);
  }, [dependency]);
  return scrollRef;
}

/** Message transcript shared by the console page and the corner widget. */
export function MessageList({ messages, busy, compact = false }: { messages: ChatMsg[]; busy: boolean; compact?: boolean }) {
  return (
    <div className={compact ? "space-y-4 p-4" : "space-y-6 p-5 sm:p-6"}>
      {messages.map((m, i) => {
        const isLast = i === messages.length - 1;
        if (m.role === "user") {
          return (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-md bg-maroon-700 px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-white">
                {m.text}
              </div>
            </div>
          );
        }
        return (
          <div key={i} className="flex gap-3">
            <span
              aria-hidden="true"
              className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-maroon-800 text-white shadow-xs [&_svg]:size-3.5"
            >
              <IconSparkle />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              {(m.activity?.length ?? 0) > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {m.activity!.map((a, j) => (
                    <ToolChip key={j} name={a} done={!busy || !isLast} />
                  ))}
                </div>
              )}
              {m.text ? (
                <div className={m.error ? "text-red-700" : undefined}>
                  {m.role === "assistant" ? <MarkdownLite text={m.text} /> : (
                    <p className="text-sm leading-relaxed whitespace-pre-wrap">{sanitizeReply(m.text)}</p>
                  )}
                  {m.detail && <ErrorDetails text={m.detail} />}
                </div>
              ) : (
                !m.activity?.length && (
                  <span className="inline-flex items-center gap-2 text-sm text-stone-400">
                    <span className="flex gap-1" aria-hidden="true">
                      <span className="size-1.5 animate-bounce rounded-full bg-stone-300 [animation-delay:-200ms]" />
                      <span className="size-1.5 animate-bounce rounded-full bg-stone-300 [animation-delay:-100ms]" />
                      <span className="size-1.5 animate-bounce rounded-full bg-stone-300" />
                    </span>
                    Thinking…
                  </span>
                )
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Horizontal message input: single-line textarea that grows with content,
 * send on Enter, stop button while streaming.
 */
export function ChatInput({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  placeholder = "Ask anything, or describe what you need done…",
  autoFocus = false,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function autosize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  return (
    <div className="flex items-end gap-2 rounded-xl border border-stone-200 bg-white p-2 shadow-xs transition-colors duration-150 focus-within:border-maroon-500 focus-within:ring-[3px] focus-within:ring-maroon-600/10">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          autosize();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        }}
        rows={1}
        aria-label="Message your co-worker"
        placeholder={placeholder}
        className="max-h-40 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-stone-400"
      />
      {busy ? (
        <button
          type="button"
          onClick={onStop}
          className="shrink-0 cursor-pointer rounded-lg border border-stone-200 px-3 py-2 text-xs font-medium text-stone-600 transition-colors duration-150 hover:border-stone-300 hover:text-stone-900"
        >
          Stop
        </button>
      ) : (
        <button
          type="button"
          onClick={onSend}
          disabled={!value.trim()}
          aria-label="Send message"
          className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-maroon-700 text-white transition-colors duration-150 hover:bg-maroon-800 disabled:pointer-events-none disabled:opacity-35"
        >
          <IconArrowRight className="size-4" />
        </button>
      )}
    </div>
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
