"use client";

import { useEffect, useState } from "react";
import { Switch } from "@/components/ui";
import {
  IconArrowRight,
  IconMaximize,
  IconMinimize,
  IconPin,
  IconPinOff,
  IconSparkle,
  IconX,
} from "@/components/icons";
import { chatStore, useChat } from "./chat-store";
import { MessageList, useAutoScroll, useChatSend } from "./chat-ui";
import { chatDock, chatDraft, useChatDockMode } from "./chat-widget-state";

const DOCK_Z = "z-50";

/**
 * The chat dock: one continuous conversation across four states.
 * - "input": horizontal bar floating at the lower center of every page
 * - "bubble": shrunk to a bubble at the lower right
 * - "open": expanded panel overlaying the lower right
 * - "pinned": docked to the right edge; AppShell reserves the width so
 *   nothing behind it is obstructed
 */
export function ChatWidget() {
  // Rehydrate the user's last chosen dock state after mount (SSR-safe).
  useEffect(() => {
    chatDock.restore();
  }, []);

  return <ChatDockBody />;
}

function ChatDockBody() {
  const mode = useChatDockMode();
  const { messages, busy, creator } = useChat();
  const { send, stop } = useChatSend();
  const [input, setInput] = useState("");
  const scrollRef = useAutoScroll(messages);

  // Dashboard quick actions drop a prompt into the shared draft; adopt it.
  const draft = chatDraft.get();
  useEffect(() => {
    if (draft) {
      setInput(draft);
      chatDraft.set("");
    }
  }, [draft]);

  function submit() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    void send(text);
  }

  const transcript = (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      <MessageList messages={messages} busy={busy} compact />
    </div>
  );
  const composer = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="border-t border-stone-100 p-3"
    >
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={1}
        aria-label="Message your co-worker"
        placeholder="Message…"
        className="max-h-28 min-w-0 flex-1 resize-none rounded-lg border border-stone-200 bg-white px-2.5 py-2 text-sm outline-none placeholder:text-stone-400 focus:border-maroon-500"
      />
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <Switch checked={creator} onChange={(v) => chatStore.setCreator(v)} label="Creator mode" />
        {busy ? (
          <button
            type="button"
            onClick={stop}
            className="shrink-0 cursor-pointer rounded-lg border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-600 hover:text-stone-900"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim()}
            aria-label="Send message"
            className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-maroon-700 text-white transition-colors duration-150 hover:bg-maroon-800 disabled:pointer-events-none disabled:opacity-35"
          >
            <IconArrowRight className="size-4" />
          </button>
        )}
      </div>
    </form>
  );
  const header = (sub: string, actions: React.ReactNode) => (
    <div className="flex items-center gap-2.5 border-b border-stone-100 px-4 py-2.5">
      <span aria-hidden="true" className="flex size-7 items-center justify-center rounded-lg bg-maroon-800 text-white shadow-xs [&_svg]:size-3.5">
        <IconSparkle className="size-3.5" />
      </span>
      <div className="flex-1 leading-tight">
        <p className="text-sm font-semibold text-stone-900">Business co-worker</p>
        <p className="text-[11px] text-stone-400">{sub}</p>
      </div>
      {actions}
    </div>
  );

  if (mode === "pinned") {
    return (
      <aside
        aria-label="Chat with your co-worker"
        className={`fixed inset-y-0 right-0 ${DOCK_Z} flex w-[380px] flex-col border-l border-stone-200 bg-white pt-12 lg:pt-0`}
      >
        {header(
          busy ? "Working…" : "Ready · pinned",
          <>
            <button type="button" onClick={() => chatDock.set("open")} title="Unpin (float over page)" aria-label="Unpin chat" className="icon-btn">
              <IconPinOff className="size-4" />
            </button>
            <button type="button" onClick={() => chatDock.set("input")} title="Collapse to input bar" aria-label="Collapse chat to input bar" className="icon-btn">
              <IconX className="size-4" />
            </button>
          </>,
        )}
        {transcript}
        {composer}
      </aside>
    );
  }

  if (mode === "open") {
    return (
      <div
        role="dialog"
        aria-label="Chat with your co-worker"
        className={`fixed right-4 bottom-4 ${DOCK_Z} flex w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-2xl ring-1 ring-black/5 sm:right-6 sm:bottom-6`}
        style={{ height: "min(600px, calc(100vh - 6rem))" }}
      >
        {header(
          busy ? "Working…" : "Ready",
          <>
            <button type="button" onClick={() => chatDock.set("pinned")} title="Pin to right edge (page content moves aside)" aria-label="Pin chat to right edge" className="icon-btn hidden lg:flex">
              <IconPin className="size-4" />
            </button>
            <button type="button" onClick={() => chatDock.set("bubble")} title="Shrink to bubble" aria-label="Shrink chat to bubble" className="icon-btn">
              <IconMinimize className="size-4" />
            </button>
          </>,
        )}
        {transcript}
        {composer}
      </div>
    );
  }

  if (mode === "bubble") {
    return (
      <button
        type="button"
        onClick={() => chatDock.set("open")}
        aria-label="Open chat"
        title="Chat with your co-worker"
        className={`fixed right-5 bottom-5 ${DOCK_Z} flex size-14 cursor-pointer items-center justify-center rounded-full bg-maroon-800 text-white shadow-xl ring-1 ring-black/10 transition-transform duration-150 hover:scale-105 hover:bg-maroon-900`}
      >
        <IconSparkle className="size-6" />
        {busy && <span aria-hidden="true" className="absolute -top-0.5 -right-0.5 size-3.5 animate-pulse rounded-full border-2 border-white bg-emerald-500" />}
      </button>
    );
  }

  // Default: horizontal input bar floating at the lower center of every page.
  return (
    <div className={`pointer-events-none fixed inset-x-0 bottom-5 ${DOCK_Z} flex justify-center px-4`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="pointer-events-auto flex w-full max-w-2xl items-center gap-2 rounded-2xl border border-stone-200 bg-white/90 p-2 pl-3 shadow-2xl ring-1 ring-black/5 backdrop-blur-md transition-all duration-150 focus-within:border-maroon-400 focus-within:shadow-xl focus-within:ring-[4px] focus-within:ring-maroon-600/10"
      >
        <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-maroon-800 text-white shadow-xs [&_svg]:size-4">
          <IconSparkle className="size-4" />
        </span>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          aria-label="Message your co-worker"
          placeholder="Ask your co-worker anything…"
          className="max-h-24 min-w-0 flex-1 resize-none bg-transparent px-1 py-2 text-sm outline-none placeholder:text-stone-400"
        />
        {input.trim() && !busy && (
          <button
            type="submit"
            aria-label="Send message"
            className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-maroon-700 text-white transition-colors duration-150 hover:bg-maroon-800"
          >
            <IconArrowRight className="size-4" />
          </button>
        )}
        <span className="mx-0.5 h-6 w-px shrink-0 bg-stone-200" aria-hidden="true" />
        <button
          type="button"
          onClick={() => chatDock.set("open")}
          title="Open chat panel"
          aria-label="Open chat panel"
          className="icon-btn mr-0.5 shrink-0"
        >
          <IconMaximize className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => chatDock.set("bubble")}
          title="Shrink to bubble"
          aria-label="Shrink chat to bubble"
          className="icon-btn mr-1 shrink-0"
        >
          <IconMinimize className="size-4" />
        </button>
      </form>
    </div>
  );
}
