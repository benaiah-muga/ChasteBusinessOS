"use client";

import { useEffect, useState } from "react";
import { Switch } from "@/components/ui";
import {
  IconArrowRight,
  IconHistory,
  IconMaximize,
  IconMessage,
  IconMinimize,
  IconPin,
  IconPinOff,
  IconSettings,
  IconSparkle,
  IconX,
} from "@/components/icons";
import { chatStore, useChat } from "./chat-store";
import { MessageList, useAutoScroll, useChatSend } from "./chat-ui";
import { chatDock, chatDraft, useChatDockMode, type ChatDockMode } from "./chat-widget-state";
import { cn, timeAgo } from "@/lib/format";

const DOCK_Z = "z-50";

/** Tracks one media query; SSR-safe (defaults to false until mounted). */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const sync = () => setMatches(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [query]);
  return matches;
}

/**
 * The chat dock: one continuous conversation across four states.
 * - "input": horizontal bar floating at the lower center of every page
 * - "bubble": shrunk to a bubble at the lower right
 * - "open": expanded panel overlaying the lower right
 * - "pinned": docked to the right edge; AppShell reserves the width so
 *   nothing behind it is obstructed. On phones a pinned dock would cover
 *   the screen, so it falls back to the floating panel there.
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
  const isPhone = useMediaQuery("(max-width: 1023px)");
  const effective: ChatDockMode = mode === "pinned" && isPhone ? "open" : mode;
  return <ChatDockInner mode={effective} />;
}

function ChatDockInner({ mode }: { mode: "input" | "bubble" | "open" | "pinned" }) {
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
        aria-label="Message your workmate"
        placeholder="Message…"
        className="max-h-28 min-w-0 flex-1 resize-none rounded-lg border border-stone-200 bg-white px-2.5 py-2 text-sm outline-none placeholder:text-stone-400 focus:border-maroon-500"
      />
      <div className="mt-1.5 flex items-center justify-between gap-2 pl-1">
        <span className="flex items-center gap-1.5 text-[10px] text-stone-400">
          {creator && (
            <button
              type="button"
              onClick={() => setTab("prefs")}
              className="cursor-pointer rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-800 transition-colors duration-150 hover:bg-violet-200"
            >
              creator
            </button>
          )}
          <span className="hidden sm:inline">
            <kbd className="kbd">⏎</kbd> send · <kbd className="kbd">⇧⏎</kbd> newline
          </span>
        </span>
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
  const [tab, setTab] = useState<"chat" | "history" | "prefs">("chat");

  const header = (actions: React.ReactNode) => (
    <div className="border-b border-stone-100">
      <div className="flex items-center gap-2.5 px-4 pt-3 pb-2">
        <span
          aria-hidden="true"
          className="relative flex size-7 shrink-0 items-center justify-center rounded-lg bg-maroon-950 text-white shadow-xs [&_svg]:size-3.5"
        >
          <IconSparkle className="size-3.5" />
          {busy && (
            <span className="absolute -top-0.5 -right-0.5 size-2 animate-pulse rounded-full border border-white bg-emerald-500" />
          )}
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-[13px] font-semibold text-stone-900">Workmate</p>
          <button
            type="button"
            onClick={() => setTab("prefs")}
            title="Switch mode in preferences"
            className="flex cursor-pointer items-center gap-1.5 text-[11px] text-stone-400 transition-colors duration-150 hover:text-stone-600"
          >
            <span
              aria-hidden="true"
              className={`size-1.5 rounded-full ${busy ? "animate-pulse bg-emerald-500" : "bg-emerald-500"}`}
            />
            {busy ? "Working…" : creator ? "Creator mode" : "Assist mode"}
          </button>
        </div>
        {actions}
      </div>
      <div role="tablist" aria-label="Console sections" className="flex items-center gap-0.5 px-3 pb-1.5">
        {(
          [
            ["chat", "New conversation", IconMessage],
            ["history", "History", IconHistory],
            ["prefs", "Preferences", IconSettings],
          ] as const
        ).map(([id, label, TabIcon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            title={label}
            className={cn(
              "flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors duration-100",
              tab === id ? "bg-stone-100 text-stone-900" : "text-stone-400 hover:bg-stone-50 hover:text-stone-600",
            )}
          >
            <TabIcon className="size-3.5" />
            <span className="hidden sm:inline">{label.split(" ")[0]}</span>
          </button>
        ))}
      </div>
    </div>
  );

  const body =
    tab === "chat" ? (
      <>
        {transcript}
        {composer}
      </>
    ) : tab === "history" ? (
      <SessionHistory />
    ) : (
      <ConsolePreferences onDone={() => setTab("chat")} />
    );

  if (mode === "pinned") {
    return (
      <aside
        aria-label="Chat with your workmate"
        className={`fixed inset-y-0 right-0 ${DOCK_Z} flex w-[380px] flex-col border-l border-stone-200 bg-white pt-12 lg:pt-0`}
      >
        {header(
          <>
            <button type="button" onClick={() => chatDock.set("open")} title="Unpin (float over page)" aria-label="Unpin chat" className="icon-btn">
              <IconPinOff className="size-4" />
            </button>
            <button type="button" onClick={() => chatDock.set("input")} title="Collapse to input bar" aria-label="Collapse chat to input bar" className="icon-btn">
              <IconX className="size-4" />
            </button>
          </>,
        )}
        {body}
      </aside>
    );
  }

  if (mode === "open") {
    return (
      <div
        role="dialog"
        aria-label="Chat with your workmate"
        className={`fixed right-4 bottom-4 ${DOCK_Z} flex w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-2xl ring-1 ring-black/5 sm:right-6 sm:bottom-6`}
        style={{ height: "min(600px, calc(100vh - 6rem))" }}
      >
        {header(
          <>
            <button type="button" onClick={() => chatDock.set("pinned")} title="Pin to right edge (page content moves aside)" aria-label="Pin chat to right edge" className="icon-btn hidden lg:flex">
              <IconPin className="size-4" />
            </button>
            <button type="button" onClick={() => chatDock.set("bubble")} title="Shrink to bubble" aria-label="Shrink chat to bubble" className="icon-btn">
              <IconMinimize className="size-4" />
            </button>
          </>,
        )}
        {body}
      </div>
    );
  }

  if (mode === "bubble") {
    return (
      <button
        type="button"
        onClick={() => chatDock.set("open")}
        aria-label="Open chat"
        title="Chat with your workmate"
        className={`fixed right-5 bottom-20 lg:bottom-5 ${DOCK_Z} flex size-14 cursor-pointer items-center justify-center rounded-full bg-maroon-800 text-white shadow-xl ring-1 ring-black/10 transition-transform duration-150 hover:scale-105 hover:bg-maroon-900`}
      >
        <IconSparkle className="size-6" />
        {busy && <span aria-hidden="true" className="absolute -top-0.5 -right-0.5 size-3.5 animate-pulse rounded-full border-2 border-white bg-emerald-500" />}
      </button>
    );
  }

  // Default: horizontal input bar floating at the lower center of every page.
  return (
    <div className={`pointer-events-none fixed inset-x-0 bottom-20 lg:bottom-5 ${DOCK_Z} flex justify-center px-4`}>
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
          aria-label="Message your workmate"
          placeholder="Ask your workmate anything…"
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

/* ------------------------------------------------------- history + prefs -- */

interface AgentSessionRow {
  id: string;
  title: string;
  mode: string;
  status: string;
  createdAt: string;
}

/** Past workmate sessions, freshest first; full trajectories live in /sessions. */
function SessionHistory() {
  const [rows, setRows] = useState<AgentSessionRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/sessions");
        if (!res.ok) throw new Error(String(res.status));
        const j = (await res.json()) as { sessions?: AgentSessionRow[] };
        setRows(j.sessions ?? []);
      } catch {
        setFailed(true);
      }
    })();
  }, []);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      {failed && (
        <p className="px-3 py-8 text-center text-sm text-stone-400">Couldn't load history. Check your connection.</p>
      )}
      {!failed && rows === null && (
        <div className="space-y-2 p-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-stone-100" />
          ))}
        </div>
      )}
      {rows?.length === 0 && (
        <div className="px-4 py-10 text-center">
          <IconHistory className="mx-auto size-5 text-stone-300" />
          <p className="mt-2 text-sm leading-relaxed text-stone-500">
            No conversations yet.
            <br />
            Everything you and your workmate do is logged here.
          </p>
        </div>
      )}
      {rows && rows.length > 0 && (
        <ul className="space-y-0.5">
          {rows.map((s) => (
            <li key={s.id}>
              <a
                href="/sessions"
                className="flex items-center gap-2.5 rounded-lg px-3 py-2 transition-colors duration-100 hover:bg-stone-50"
              >
                <span
                  aria-hidden="true"
                  title={s.status}
                  className={`size-1.5 shrink-0 rounded-full ${
                    s.status === "active" ? "bg-emerald-500" : s.status === "failed" ? "bg-red-400" : "bg-stone-300"
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-stone-800">{s.title || "Untitled session"}</span>
                  <span className="block text-[11px] text-stone-400">
                    {s.mode} · {timeAgo(s.createdAt)}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {rows && rows.length > 0 && (
        <p className="px-3 pt-3 pb-1 text-[11px] leading-relaxed text-stone-400">
          Showing the last {rows.length}. Full trajectories, every tool call and decision, live in{" "}
          <a href="/sessions" className="font-medium text-maroon-800 hover:underline">
            Sessions
          </a>
          .
        </p>
      )}
    </div>
  );
}

function ConsolePreferences({ onDone }: { onDone: () => void }) {
  const { creator } = useChat();
  const dockMode = useChatDockMode();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <section aria-label="Conversation mode">
        <p className="figure-label mb-2">Conversation mode</p>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-stone-200 px-3 py-2.5">
          <div>
            <p className="text-[13px] font-medium text-stone-900">Creator mode</p>
            <p className="text-[11px] leading-snug text-stone-400">
              Let the workmate propose new capabilities, not just use existing ones.
            </p>
          </div>
          <Switch checked={creator} onChange={(v) => chatStore.setCreator(v)} label="" />
        </div>
      </section>

      <section aria-label="Dock behavior" className="mt-6">
        <p className="figure-label mb-2">Dock</p>
        <div className="grid grid-cols-2 gap-1.5">
          {(
            [
              ["input", "Floating bar"],
              ["bubble", "Bubble"],
              ["open", "Panel"],
              ["pinned", "Pinned edge"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => chatDock.set(id)}
              aria-pressed={dockMode === id}
              className={cn(
                "cursor-pointer rounded-lg border px-3 py-2 text-[13px] font-medium transition-all duration-150",
                dockMode === id
                  ? "border-maroon-500 bg-maroon-50/60 text-maroon-900"
                  : "border-stone-200 text-stone-600 hover:border-stone-300 hover:bg-stone-50",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section aria-label="New conversation" className="mt-6">
        <p className="figure-label mb-2">Fresh start</p>
        <button
          type="button"
          onClick={() => {
            chatStore.reset();
            onDone();
          }}
          className="w-full cursor-pointer rounded-lg border border-stone-200 px-3 py-2 text-[13px] font-medium text-stone-700 transition-colors duration-150 hover:border-stone-300 hover:bg-stone-50"
        >
          Start a new conversation
        </button>
        <p className="mt-1.5 text-[11px] leading-relaxed text-stone-400">
          Clears this view. Everything already done stays in the session log — nothing is ever erased.
        </p>
      </section>
    </div>
  );
}
