"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, EmptyState, LoadingPage, PageHeader } from "@/components/ui";
import { IconAlertTriangle, IconBot, IconChevronLeft, IconHash, IconPlus, IconSend, IconX } from "@/components/icons";
import { cn, timeAgo } from "@/lib/format";
import { callApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";

interface Conversation {
  id: string;
  kind: string;
  title: string;
  agentEnabled: boolean;
  lastMessage: { at: string; body: string } | null;
}
interface Message {
  id: string;
  senderType: string;
  body: string;
  createdAt: string;
}

export default function MessagesPage() {
  const __enabled = useModuleEnabled("messaging");
  const [convs, setConvs] = useState<Conversation[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newAgent, setNewAgent] = useState(true);
  const [composerOpen, setComposerOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  const activeConv = convs?.find((c) => c.id === activeId) ?? null;

  const loadConvs = useCallback(async () => {
    setLoadError(null);
    const res = await callApi<{ conversations?: Conversation[] }>("/api/conversations");
    if (!res.ok) {
      setLoadError(res.error?.title ?? "Couldn't load conversations");
      return;
    }
    const conversations = res.data?.conversations ?? [];
    setConvs(conversations);
    setActiveId((cur) => cur ?? conversations[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void loadConvs();
  }, [loadConvs]);

  useEffect(() => {
    if (!activeId) return;
    fetch(`/api/conversations/${activeId}/messages`)
      .then((r) => r.json())
      .then((d) => setMsgs(d.messages ?? []));
  }, [activeId]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [msgs]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!activeId || !draft.trim() || sending) return;
    setSending(true);
    const body = draft.trim();
    setDraft("");
    try {
      await fetch(`/api/conversations/${activeId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      // Refresh the thread, includes the agent's reply when it participates.
      const refreshed = await fetch(`/api/conversations/${activeId}/messages`).then((r) => r.json());
      setMsgs(refreshed.messages ?? []);
      void loadConvs();
    } finally {
      setSending(false);
    }
  }

  async function createConv(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    const res = await fetch("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: newTitle.trim(), agentEnabled: newAgent }),
    });
    if (res.ok) {
      setNewTitle("");
      setComposerOpen(false);
      const data = await res.json();
      await loadConvs();
      setActiveId(data.conversation.id);
    }
  }

  if (convs === null) return <LoadingPage />;

  if (!__enabled) return <ModuleDisabled label="Messages" />;

  return (
    <div>
      <PageHeader
        title="Messages"
        description="Team channels and DMs. Conversations with Chaste enabled let your AI workmate read the thread and act when colleagues ask."
      />

      {loadError && (
        <EmptyState
          icon={<IconAlertTriangle />}
          title={loadError}
          hint="Check your connection, then retry."
          action={
            <Button tone="secondary" onClick={() => void loadConvs()}>
              Retry
            </Button>
          }
        />
      )}

      <div className="grid h-[calc(100vh-240px)] min-h-[420px] gap-4 lg:grid-cols-[290px_1fr]">
        {/* Conversation list */}
        <aside
          className={cn(
            "card flex min-h-0 flex-col overflow-hidden p-0",
            activeId && "hidden lg:flex",
          )}
        >
          <div className="flex items-center justify-between border-b border-stone-100 px-4 py-2.5">
            <h2 className="section-title">Conversations</h2>
            <button
              type="button"
              aria-label="New conversation"
              onClick={() => setComposerOpen((v) => !v)}
              className="icon-btn size-6"
            >
              {composerOpen ? <IconX className="size-3.5" /> : <IconPlus className="size-4" />}
            </button>
          </div>

          {composerOpen && (
            <form onSubmit={createConv} className="space-y-2.5 border-b border-stone-100 bg-stone-50/60 p-3">
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Channel name…"
                aria-label="New channel name"
                className="input h-8 text-xs"
              />
              <label className="flex cursor-pointer items-center gap-2 text-xs text-stone-600">
                <input type="checkbox" checked={newAgent} onChange={(e) => setNewAgent(e.target.checked)} className="accent-maroon-700" />
                Include Chaste (AI workmate)
              </label>
              <Button type="submit" size="sm" className="w-full" disabled={!newTitle.trim()}>
                Create
              </Button>
            </form>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Conversations">
            {convs.length === 0 && <p className="p-4 text-sm text-stone-400">No conversations yet.</p>}
            {convs.map((c) => (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={activeId === c.id}
                onClick={() => setActiveId(c.id)}
                className={cn(
                  "block w-full border-b border-stone-50 px-4 py-3 text-left transition-colors duration-75",
                  activeId === c.id ? "bg-maroon-50/70" : "hover:bg-stone-50",
                )}
              >
                <div className="flex items-center gap-2">
                  {c.kind === "dm" ? (
                    <IconBot className={cn("size-3.5 shrink-0", activeId === c.id ? "text-maroon-700" : "text-stone-400")} />
                  ) : (
                    <IconHash className={cn("size-3.5 shrink-0", activeId === c.id ? "text-maroon-700" : "text-stone-400")} />
                  )}
                  <span className="truncate text-sm font-medium text-stone-800">{c.title}</span>
                  {c.agentEnabled && (
                    <Badge tone="violet" className="ml-auto shrink-0">
                      chaste
                    </Badge>
                  )}
                </div>
                {c.lastMessage && (
                  <p className="mt-1 truncate text-xs text-stone-400">{c.lastMessage.body}</p>
                )}
              </button>
            ))}
          </div>
        </aside>

        {/* Thread */}
        <section className={cn("card flex min-h-0 flex-col overflow-hidden p-0", !activeId && convs.length > 0 ? "hidden lg:flex" : "flex")}>
          {activeConv ? (
            <>
              <header className="flex items-center gap-2 border-b border-stone-100 px-4 py-2.5">
                <button
                  type="button"
                  onClick={() => setActiveId(null)}
                  aria-label="Back to conversations"
                  className="icon-btn lg:hidden"
                >
                  <IconChevronLeft className="size-4" />
                </button>
                <h2 className="truncate text-sm font-semibold text-stone-800">
                  {activeConv.kind === "dm" ? "" : "#"}
                  {activeConv.title}
                </h2>
                {activeConv.agentEnabled && (
                  <Badge tone="violet">
                    <IconBot className="size-3" /> Chaste reads & acts here
                  </Badge>
                )}
              </header>

              <div ref={threadRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
                {msgs.length === 0 && (
                  <p className="pt-10 text-center text-sm text-stone-400">No messages yet, start the thread below.</p>
                )}
                {msgs.map((m) => {
                  const isAgent = m.senderType === "agent";
                  return (
                    <div key={m.id} className="flex gap-2.5">
                      {isAgent ? (
                        <span
                          aria-hidden="true"
                          className="mt-1 flex size-6 shrink-0 items-center justify-center rounded-md bg-violet-600 text-white [&_svg]:size-3"
                        >
                          <IconBot />
                        </span>
                      ) : (
                        <span
                          aria-hidden="true"
                          className="mt-1 flex size-6 shrink-0 items-center justify-center rounded-md bg-stone-300 text-[9px] font-bold text-stone-600 uppercase"
                        >
                          {m.senderType.slice(0, 2)}
                        </span>
                      )}
                      <div className="min-w-0">
                        <p className="mb-0.5 text-[11px] font-medium tracking-wide text-stone-400 uppercase">
                          {isAgent ? "Chaste · AI" : m.senderType} · {timeAgo(m.createdAt)}
                        </p>
                        <div
                          className={cn(
                            "max-w-[85%] rounded-xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap",
                            isAgent ? "bg-violet-50 text-violet-950" : "bg-stone-100 text-stone-800",
                          )}
                        >
                          {m.body}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <form onSubmit={send} className="flex items-end gap-2 border-t border-stone-100 p-3">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send(e);
                    }
                  }}
                  rows={1}
                  aria-label={`Message ${activeConv.title}`}
                  placeholder="Write a message…"
                  className="textarea max-h-32 flex-1 resize-none py-2"
                />
                <button
                  type="submit"
                  disabled={sending || !draft.trim()}
                  aria-label="Send message"
                  className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-maroon-700 text-white transition-colors duration-150 hover:bg-maroon-800 disabled:pointer-events-none disabled:opacity-35"
                >
                  <IconSend className="size-4" />
                </button>
              </form>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-6 text-sm text-stone-400">
              Select a conversation to read it.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
