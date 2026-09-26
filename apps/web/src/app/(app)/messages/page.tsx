"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, LoadingPage, Notice, Switch } from "@/components/ui";
import { IconAlertTriangle, IconBot, IconChevronLeft, IconHash, IconPlus, IconSend, IconSettings, IconTrash, IconUser, IconX } from "@/components/icons";
import { cn, timeAgo } from "@/lib/format";
import { callApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";
import { AppFrame } from "../_shell/app-frame";

interface Conversation {
  id: string;
  kind: string;
  title: string;
  agentEnabled: boolean;
  archivedAt: string | null;
  createdByMe: boolean;
  lastMessage: { at: string; body: string } | null;
}
interface Message {
  id: string;
  senderType: string;
  senderUserId: string | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
  mentions?: { type: string; id: string }[] | null;
}
interface Person {
  type: "user" | "agent";
  id: string;
  name: string;
}

/** The composer inserts this short alias for the agent; it contains no spaces. */
const AGENT_ALIAS = "Chaste";

function personAlias(p: Person): string {
  return p.type === "agent" ? AGENT_ALIAS : p.name.split(" ")[0] ?? p.name;
}

/** Scans a draft for @aliases that resolve to real people/agents. */
function extractMentions(body: string, people: Person[]): { type: "user" | "agent"; id: string }[] {
  const lower = body.toLowerCase();
  const seen = new Map<string, { type: "user" | "agent"; id: string }>();
  for (const p of people) {
    const alias = personAlias(p).toLowerCase();
    if (alias && lower.includes(`@${alias}`) && !seen.has(p.id)) {
      seen.set(p.id, { type: p.type, id: p.id });
    }
  }
  return [...seen.values()];
}

/** Renders a message body with @mentions accented. */
function Body({ body }: { body: string }) {
  const parts = body.split(/(@[A-Za-z0-9_.-]+)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("@") ? (
          <span key={i} className="font-medium text-gold-700 underline decoration-gold-300 underline-offset-2">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
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
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const newTitleRef = useRef<HTMLInputElement>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [me, setMe] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [addUserId, setAddUserId] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState("");
  const [confirmDeleteConv, setConfirmDeleteConv] = useState(false);
  const [confirmDeleteMsg, setConfirmDeleteMsg] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const mentionCandidates =
    mentionQuery == null
      ? []
      : people.filter((p) => personAlias(p).toLowerCase().startsWith(mentionQuery.toLowerCase()));

  useEffect(() => {
    void callApi<{ people?: Person[] }>("/api/conversations/people").then((res) => {
      if (res.data?.people) setPeople(res.data.people);
    });
  }, []);

  /** Detects an @token immediately before the caret and opens the picker. */
  function syncMentionQuery() {
    const el = composerRef.current;
    if (!el) return;
    const upto = el.value.slice(0, el.selectionStart ?? el.value.length);
    const m = /@([A-Za-z0-9_.-]*)$/.exec(upto);
    if (m?.[1] != null) {
      setMentionQuery(m[1]);
      setMentionIndex(0);
    } else {
      setMentionQuery(null);
    }
  }

  function pickMention(p: Person) {
    const el = composerRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, caret).replace(/@[A-Za-z0-9_.-]*$/, `@${personAlias(p)} `);
    setDraft(before + el.value.slice(caret));
    setMentionQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      const pos = before.length;
      el.setSelectionRange(pos, pos);
    });
  }

  const activeConv = convs?.find((c) => c.id === activeId) ?? null;

  const loadConvs = useCallback(async () => {
    setLoadError(null);
    const res = await callApi<{ conversations?: Conversation[]; me?: string }>("/api/conversations");
    if (!res.ok) {
      setLoadError(res.error?.title ?? "Couldn't load conversations");
      setConvs([]);
      return;
    }
    const conversations = res.data?.conversations ?? [];
    setConvs(conversations);
    if (res.data?.me) setMe(res.data.me);
    setActiveId((cur) => cur ?? conversations.filter((c) => !c.archivedAt)[0]?.id ?? null);
  }, []);

  function startConversation() {
    setComposerOpen(true);
    requestAnimationFrame(() => newTitleRef.current?.focus());
  }

  useEffect(() => {
    void loadConvs();
  }, [loadConvs]);

  const refreshThread = useCallback(async (conversationId: string) => {
    const d = await fetch(`/api/conversations/${conversationId}/messages`).then((r) => r.json());
    setMsgs(d.messages ?? []);
  }, []);

  useEffect(() => {
    if (!activeId) return;
    void refreshThread(activeId);
  }, [activeId, refreshThread]);

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
        body: JSON.stringify({ body, mentions: extractMentions(body, people) }),
      });
      // Refresh the thread, includes the agent's reply when it participates.
      await refreshThread(activeId);
      void loadConvs();
    } finally {
      setSending(false);
    }
  }

  /** Conversation lifecycle (rename, archive, leave, delete, add member). */
  async function convAction(action: string, extra: Record<string, unknown> = {}) {
    if (!activeId) return null;
    const res = await fetch(`/api/conversations/${activeId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
    });
    const d = (await res.json().catch(() => ({}))) as { error?: string; pendingApproval?: boolean };
    if (!res.ok) {
      setActionNotice(d.error ?? "That didn't work.");
      return null;
    }
    setActionNotice(null);
    await loadConvs();
    return d;
  }

  async function saveEdit() {
    if (!editingId || !editingBody.trim()) return;
    const res = await fetch(`/api/messages/${editingId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: editingBody.trim() }),
    });
    if (res.ok && activeId) await refreshThread(activeId);
    setEditingId(null);
  }

  async function deleteMessage(messageId: string) {
    const res = await fetch(`/api/messages/${messageId}`, { method: "DELETE" });
    if (res.ok && activeId) await refreshThread(activeId);
    setConfirmDeleteMsg(null);
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
      setActiveId(data.conversationId);
    }
  }

  const visibleConvs = (convs ?? []).filter((c) => (showArchived ? true : !c.archivedAt));

  if (convs === null) return <LoadingPage />;

  if (!__enabled) return <ModuleDisabled label="Messages" />;

  return (
    <AppFrame
      appId="messaging"
      description="Team channels and DMs. Conversations with Chaste enabled let your AI workmate read the thread and act when colleagues ask."
    >

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
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-pressed={showArchived}
                onClick={() => setShowArchived((v) => !v)}
                title={showArchived ? "Hide archived" : "Show archived"}
                className={cn("icon-btn size-6 text-[10px] font-medium", showArchived && "text-gold-800")}
              >
                ARCH
              </button>
              <button
                type="button"
                aria-label="New conversation"
                onClick={() => composerOpen ? setComposerOpen(false) : startConversation()}
                className="icon-btn size-6"
              >
                {composerOpen ? <IconX className="size-3.5" /> : <IconPlus className="size-4" />}
              </button>
            </div>
          </div>

          {composerOpen && (
            <form onSubmit={createConv} className="space-y-2.5 border-b border-stone-100 bg-stone-50/60 p-3">
              <input
                ref={newTitleRef}
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Channel name…"
                aria-label="New channel name"
                className="input h-8 text-xs"
              />
              <label className="flex cursor-pointer items-center gap-2 text-xs text-stone-600">
                <input type="checkbox" checked={newAgent} onChange={(e) => setNewAgent(e.target.checked)} className="accent-gold-700" />
                Include Chaste (AI workmate)
              </label>
              <Button type="submit" size="sm" className="w-full" disabled={!newTitle.trim()}>
                Create
              </Button>
            </form>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Conversations">
            {visibleConvs.length === 0 && (
              <div className="space-y-3 p-4">
                <p className="text-sm text-stone-500">{loadError ? "Conversation list unavailable." : convs.length === 0 ? "No conversations yet." : "No active conversations."}</p>
                {convs.length === 0 && !loadError && (
                  <Button tone="secondary" size="sm" className="w-full" onClick={startConversation}>
                    <IconPlus className="size-3.5" /> Start a conversation
                  </Button>
                )}
              </div>
            )}
            {visibleConvs.map((c) => (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={activeId === c.id}
                onClick={() => setActiveId(c.id)}
                className={cn(
                  "block w-full border-b border-stone-50 px-4 py-3 text-left transition-colors duration-75",
                  activeId === c.id ? "bg-gold-50/70" : "hover:bg-stone-50",
                )}
              >
                <div className="flex items-center gap-2">
                  {c.kind === "dm" ? (
                    <IconBot className={cn("size-3.5 shrink-0", activeId === c.id ? "text-gold-700" : "text-stone-400")} />
                  ) : (
                    <IconHash className={cn("size-3.5 shrink-0", activeId === c.id ? "text-gold-700" : "text-stone-400")} />
                  )}
                  <span className={cn("truncate text-sm font-medium text-stone-800", c.archivedAt && "text-stone-400 line-through")}>
                    {c.title}
                  </span>
                  {c.archivedAt ? (
                    <Badge tone="neutral" className="ml-auto shrink-0">
                      archived
                    </Badge>
                  ) : (
                    c.agentEnabled && (
                      <Badge tone="violet" className="ml-auto shrink-0">
                        chaste
                      </Badge>
                    )
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
        <section className={cn("card flex min-h-0 flex-col overflow-hidden p-0", !activeId ? "hidden lg:flex" : "flex")}>
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
                {activeConv.archivedAt && <Badge tone="neutral">archived</Badge>}
                {activeConv.agentEnabled && (
                  <Badge tone="violet">
                    <IconBot className="size-3" /> Chaste reads & acts here
                  </Badge>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setRenameValue(activeConv.title);
                    setAddUserId("");
                    setActionNotice(null);
                    setSettingsOpen(true);
                  }}
                  aria-label="Conversation settings"
                  title="Rename, members, archive"
                  className="icon-btn ml-auto"
                >
                  <IconSettings className="size-4" />
                </button>
              </header>

              <div ref={threadRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
                {msgs.length === 0 && (
                  <p className="pt-10 text-center text-sm text-stone-400">No messages yet, start the thread below.</p>
                )}
                {msgs.map((m) => {
                  const isAgent = m.senderType === "agent";
                  const mine = m.senderType === "human" && me != null && m.senderUserId === me;
                  return (
                    <div key={m.id} className="group flex gap-2.5">
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
                      <div className="min-w-0 flex-1">
                        <p className="mb-0.5 text-[11px] font-medium tracking-wide text-stone-400 uppercase">
                          {isAgent ? "Chaste · AI" : m.senderType} · {timeAgo(m.createdAt)}
                          {m.editedAt && <span className="ml-1 normal-case">(edited)</span>}
                        </p>
                        {editingId === m.id ? (
                          <div className="max-w-[85%] space-y-1.5">
                            <textarea
                              value={editingBody}
                              onChange={(e) => setEditingBody(e.target.value)}
                              rows={2}
                              aria-label="Edit message"
                              className="textarea text-sm"
                              autoFocus
                            />
                            <div className="flex gap-1.5">
                              <Button size="sm" onClick={() => void saveEdit()} disabled={!editingBody.trim()}>
                                Save
                              </Button>
                              <Button size="sm" tone="ghost" onClick={() => setEditingId(null)}>
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-start gap-1.5">
                            <div
                              className={cn(
                                "max-w-[85%] rounded-xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap",
                                isAgent ? "bg-violet-50 text-violet-950" : "bg-stone-100 text-stone-800",
                              )}
                            >
                              <Body body={m.body} />
                            </div>
                            {mine && (
                              <span className="mt-1 hidden shrink-0 gap-0.5 group-hover:flex">
                                <button
                                  type="button"
                                  aria-label="Edit message"
                                  title="Edit"
                                  onClick={() => {
                                    setEditingId(m.id);
                                    setEditingBody(m.body);
                                  }}
                                  className="icon-btn size-6"
                                >
                                  <IconSettings className="size-3" />
                                </button>
                                <button
                                  type="button"
                                  aria-label="Delete message"
                                  title="Delete"
                                  onClick={() => setConfirmDeleteMsg(m.id)}
                                  className="icon-btn size-6 hover:text-red-700"
                                >
                                  <IconTrash className="size-3" />
                                </button>
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <form onSubmit={send} className="relative flex items-end gap-2 border-t border-stone-100 p-3">
                {mentionQuery != null && mentionCandidates.length > 0 && (
                  <ul
                    role="listbox"
                    aria-label="Mention someone"
                    className="absolute bottom-full left-3 z-10 mb-1 w-64 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-lg"
                  >
                    {mentionCandidates.map((p, i) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={i === mentionIndex}
                          onMouseEnter={() => setMentionIndex(i)}
                          onClick={() => pickMention(p)}
                          className={cn(
                            "flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm",
                            i === mentionIndex ? "bg-gold-50 text-gold-900" : "text-stone-700 hover:bg-stone-50",
                          )}
                        >
                          {p.type === "agent" ? (
                            <IconBot className="size-3.5 shrink-0 text-violet-600" />
                          ) : (
                            <IconUser className="size-3.5 shrink-0 text-stone-400" />
                          )}
                          <span className="truncate">
                            @{personAlias(p)}
                            <span className="ml-1.5 text-xs font-normal text-stone-400">
                              {p.type === "agent" ? "pulls the AI in" : p.name}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <textarea
                  ref={composerRef}
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    syncMentionQuery();
                  }}
                  onKeyDown={(e) => {
                    if (mentionQuery != null && mentionCandidates.length > 0) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setMentionIndex((i) => Math.min(i + 1, mentionCandidates.length - 1));
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setMentionIndex((i) => Math.max(i - 1, 0));
                        return;
                      }
                      if (e.key === "Enter" || e.key === "Tab") {
                        e.preventDefault();
                        pickMention(mentionCandidates[mentionIndex]!);
                        return;
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setMentionQuery(null);
                        return;
                      }
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send(e);
                    }
                  }}
                  rows={1}
                  aria-label={`Message ${activeConv.title}`}
                  placeholder="Write a message… type @ to mention a colleague or the agent"
                  className="textarea max-h-32 flex-1 resize-none py-2"
                />
                <button
                  type="submit"
                  disabled={sending || !draft.trim()}
                  aria-label="Send message"
                  className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-gold-700 text-white transition-colors duration-150 hover:bg-gold-800 disabled:pointer-events-none disabled:opacity-35"
                >
                  <IconSend className="size-4" />
                </button>
              </form>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-6 text-sm text-stone-400">
              {convs.length === 0 && !loadError ? (
                <div className="max-w-sm space-y-3 text-center">
                  <p className="text-base font-semibold text-stone-800">Start your first conversation</p>
                  <p>Bring your team together in a channel, with Chaste available when you include the AI workmate.</p>
                  <Button tone="secondary" onClick={startConversation}>Create conversation</Button>
                </div>
              ) : (
                "Select a conversation to read it."
              )}
            </div>
          )}
        </section>
      </div>

      {activeConv && (
        <Dialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          title={activeConv.kind === "dm" ? "Conversation" : `#${activeConv.title}`}
          description="Membership and lifecycle for this conversation."
        >
          <div className="space-y-4">
            {actionNotice && <Notice tone="error">{actionNotice}</Notice>}

            {activeConv.kind === "channel" && (
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-medium text-stone-700">Name</span>
                <div className="flex gap-2">
                  <input
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    aria-label="Channel name"
                    className="input"
                  />
                  <Button
                    size="sm"
                    disabled={!renameValue.trim() || renameValue.trim() === activeConv.title}
                    onClick={async () => {
                      const r = await convAction("update", { title: renameValue.trim() });
                      if (r) setActionNotice(null);
                    }}
                  >
                    Rename
                  </Button>
                </div>
              </label>
            )}

            <div className="flex items-center justify-between gap-3 rounded-xl border border-stone-200 px-3 py-2.5">
              <div>
                <p className="text-[13px] font-medium text-stone-900">Chaste participates</p>
                <p className="text-[11px] leading-snug text-stone-400">
                  The workmate reads this thread and acts when colleagues ask.
                </p>
              </div>
              <Switch
                checked={activeConv.agentEnabled}
                onChange={(v) => void convAction("update", { agentEnabled: v })}
                label=""
              />
            </div>

            {activeConv.kind === "channel" && (
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-medium text-stone-700">Add a colleague</span>
                <div className="flex gap-2">
                  <select className="select" value={addUserId} onChange={(e) => setAddUserId(e.target.value)} aria-label="Person to add">
                    <option value="">Choose person…</option>
                    {people
                      .filter((p) => p.type === "user")
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                  <Button
                    size="sm"
                    disabled={!addUserId}
                    onClick={async () => {
                      const r = await convAction("addMember", { userId: addUserId });
                      if (r) setAddUserId("");
                    }}
                  >
                    Add
                  </Button>
                </div>
              </label>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t border-stone-100 pt-3">
              {activeConv.kind === "channel" && (
                <Button
                  size="sm"
                  tone="secondary"
                  onClick={async () => {
                    const r = await convAction("archive", { archived: !activeConv.archivedAt });
                    if (r) setSettingsOpen(false);
                  }}
                >
                  {activeConv.archivedAt ? "Restore" : "Archive"}
                </Button>
              )}
              <Button
                size="sm"
                tone="secondary"
                onClick={async () => {
                  const r = await convAction("leave");
                  if (r) {
                    setSettingsOpen(false);
                    setActiveId(null);
                  }
                }}
              >
                Leave
              </Button>
              {activeConv.kind === "channel" && activeConv.createdByMe && (
                <Button size="sm" tone="danger" onClick={() => setConfirmDeleteConv(true)}>
                  <IconTrash className="size-3.5" />
                  Delete channel
                </Button>
              )}
            </div>
          </div>
        </Dialog>
      )}

      <ConfirmDialog
        open={confirmDeleteConv}
        onClose={() => setConfirmDeleteConv(false)}
        onConfirm={async () => {
          const r = await convAction("delete");
          setConfirmDeleteConv(false);
          if (r) {
            setSettingsOpen(false);
            setActiveId(null);
          }
        }}
        title={`Delete #${activeConv?.title ?? ""}?`}
        body="It disappears from everyone's list. The audit trail keeps the record; this cannot be undone from the UI."
        confirmLabel="Delete channel"
      />

      <ConfirmDialog
        open={confirmDeleteMsg != null}
        onClose={() => setConfirmDeleteMsg(null)}
        onConfirm={() => confirmDeleteMsg && void deleteMessage(confirmDeleteMsg)}
        title="Delete this message?"
        body="It is replaced by a deletion marker for everyone. The audit trail keeps the original."
        confirmLabel="Delete message"
      />
    </AppFrame>
  );
}
