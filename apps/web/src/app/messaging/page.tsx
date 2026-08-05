"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  LogOut,
  MessageSquare,
  Pencil,
  Plus,
  Send,
  UserPlus,
  Users,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { Modal } from "@/components/ui/Modal";
import { getApiClient } from "@/lib/api";
import type {
  MessagingMessage,
  MessagingThreadDetail,
  MessagingThreadSummary,
} from "@chaste/api-client";

type DirectoryUser = { id: string; email: string; displayName: string; isActive: boolean };

const EMPTY_DETAIL: MessagingThreadDetail = {
  id: "",
  organizationId: "",
  type: "direct",
  name: null,
  isArchived: false,
  members: [],
  createdAt: "",
  updatedAt: "",
};

export default function MessagingPage() {
  const api = getApiClient();

  const [threads, setThreads] = useState<MessagingThreadSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MessagingThreadDetail>(EMPTY_DETAIL);
  const [messages, setMessages] = useState<MessagingMessage[]>([]);
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const [composeOpen, setComposeOpen] = useState(false);
  const [kind, setKind] = useState<"direct" | "group">("direct");
  const [groupName, setGroupName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [composeErr, setComposeErr] = useState("");

  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [addPick, setAddPick] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  const scrollRef = useRef<HTMLDivElement>(null);

  const loadThreads = useCallback(async () => {
    const res = await api.listMessagingThreads();
    setThreads(res.items ?? []);
  }, [api]);

  const loadUnread = useCallback(async () => {
    try {
      const res = await api.messagingUnreadCount();
      setUnreadTotal(res.unread ?? 0);
    } catch {
      setUnreadTotal(0);
    }
  }, [api]);

  const openThread = useCallback(
    async (id: string) => {
      setErr("");
      setActiveId(id);
      try {
        const res = await api.getMessagingThread(id);
        setDetail(res.thread);
        setMessages(res.messages ?? []);
        await api.markMessagingThreadRead({ threadId: id });
        void loadThreads();
        void loadUnread();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Failed to load conversation");
      }
    },
    [api, loadThreads, loadUnread],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = await api.session();
        if (!cancelled) setMe(session.userId);
      } catch {
        /* not signed in */
      }
      try {
        const dir = await api.listDirectoryUsers();
        if (!cancelled) setDirectory(dir.users ?? []);
      } catch {
        /* directory not readable */
      }
      try {
        const res = await api.listMessagingThreads();
        if (cancelled) return;
        setThreads(res.items ?? []);
        await loadUnread();
        if (res.items.length > 0) {
          void openThread(res.items[0].id);
        }
      } catch {
        if (!cancelled) setErr("Failed to load conversations");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, loadUnread, openThread]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const otherNames = useMemo(
    () => detail.members.map((m) => m.displayName).join(", "),
    [detail.members],
  );
  const threadTitle = detail.name ?? (detail.type === "group" ? "Group chat" : otherNames);

  async function send() {
    const body = draft.trim();
    if (!body || !activeId) return;
    setErr("");
    setBusy(true);
    try {
      await api.sendMessagingMessage({ threadId: activeId, body });
      setDraft("");
      const res = await api.getMessagingThread(activeId);
      setMessages(res.messages ?? []);
      void loadThreads();
      void loadUnread();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to send message");
    } finally {
      setBusy(false);
    }
  }

  async function createThread() {
    setComposeErr("");
    if (kind === "group" && !groupName.trim()) {
      setComposeErr("A group conversation needs a name.");
      return;
    }
    if (picked.length === 0) {
      setComposeErr("Pick at least one person.");
      return;
    }
    if (kind === "direct" && picked.length !== 1) {
      setComposeErr("A direct conversation has exactly one other person.");
      return;
    }
    setBusy(true);
    try {
      const res = await api.createMessagingThread({
        kind,
        name: kind === "group" ? groupName.trim() : undefined,
        memberIds: picked,
      });
      setComposeOpen(false);
      setKind("direct");
      setGroupName("");
      setPicked([]);
      await loadThreads();
      await openThread(res.data.id);
    } catch (e) {
      setComposeErr(e instanceof Error ? e.message : "Failed to start conversation");
    } finally {
      setBusy(false);
    }
  }

  async function addMember() {
    if (!activeId || !addPick) return;
    setErr("");
    try {
      const res = await api.addMessagingMember({ threadId: activeId, userId: addPick });
      setDetail(res.data);
      setAddMemberOpen(false);
      setAddPick("");
      void loadThreads();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to add member");
    }
  }

  async function removeMember(userId: string) {
    if (!activeId) return;
    setErr("");
    try {
      const res = await api.removeMessagingMember({ threadId: activeId, userId });
      setDetail(res.data);
      void loadThreads();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to remove member");
    }
  }

  async function renameThread() {
    if (!activeId || !renameValue.trim()) return;
    setErr("");
    try {
      const res = await api.renameMessagingThread({ threadId: activeId, name: renameValue.trim() });
      setDetail(res.data);
      setRenameOpen(false);
      void loadThreads();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to rename");
    }
  }

  async function toggleArchive() {
    if (!activeId) return;
    setErr("");
    try {
      const res = await api.archiveMessagingThread({ threadId: activeId, archived: !detail.isArchived });
      setDetail(res.data);
      void loadThreads();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to update conversation");
    }
  }

  async function leaveThread() {
    if (!activeId) return;
    setErr("");
    try {
      await api.leaveMessagingThread({ threadId: activeId });
      setActiveId(null);
      setDetail(EMPTY_DETAIL);
      setMessages([]);
      void loadThreads();
      void loadUnread();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to leave conversation");
    }
  }

  const addable = directory.filter(
    (u) => u.isActive && u.id !== me && !detail.members.some((m) => m.userId === u.id),
  );

  return (
    <AppShell subtitle="Direct messages and group conversations — shared with your AI team.">
      <section className="card stack">
        <div className="section-head">
          <div>
            <h2>Messaging</h2>
            <p className="muted">
              {threads.length} conversations · {unreadTotal} unread
            </p>
          </div>
          <button className="btn" type="button" onClick={() => setComposeOpen(true)}>
            <Plus size={15} /> New conversation
          </button>
        </div>

        {err ? <span className="error">{err}</span> : null}

        <div className="messages-layout">
          <div className="thread-list-pane">
            {threads.length === 0 ? (
              <div className="empty-state">
                <MessageSquare size={24} />
                <p>No conversations yet. Start one to say hello.</p>
              </div>
            ) : (
              threads.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`thread-item${t.id === activeId ? " active" : ""}`}
                  onClick={() => openThread(t.id)}
                >
                  <div className="thread-item-head">
                    <span className="thread-title">
                      {t.name ?? (t.type === "group" ? "Group chat" : t.otherMemberNames.join(", "))}
                    </span>
                    {t.unreadCount > 0 ? <span className="unread-pill">{t.unreadCount}</span> : null}
                  </div>
                  <span className="thread-preview">
                    {t.lastMessageBody
                      ? `${t.lastSenderName ? `${t.lastSenderName}: ` : ""}${t.lastMessageBody}`
                      : "No messages yet"}
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="conversation-pane">
            {!activeId ? (
              <div className="empty-state" style={{ flex: 1 }}>
                <Users size={24} />
                <p>Select a conversation or start a new one.</p>
              </div>
            ) : (
              <>
                <div className="conversation-header">
                  <div className="stack" style={{ gap: 2, minWidth: 0 }}>
                    <strong>{threadTitle}</strong>
                    <span className="muted small">{detail.members.length} members</span>
                  </div>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    {detail.type === "group" ? (
                      <>
                        <button className="btn secondary btn-sm" type="button" onClick={() => setRenameOpen(true)}>
                          <Pencil size={14} /> Rename
                        </button>
                        <button
                          className="btn secondary btn-sm"
                          type="button"
                          onClick={() => {
                            setAddPick("");
                            setAddMemberOpen(true);
                          }}
                        >
                          <UserPlus size={14} /> Add
                        </button>
                      </>
                    ) : null}
                    <button className="btn secondary btn-sm" type="button" onClick={toggleArchive}>
                      {detail.isArchived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                      {detail.isArchived ? "Unarchive" : "Archive"}
                    </button>
                    <button className="btn secondary btn-sm" type="button" onClick={leaveThread}>
                      <LogOut size={14} /> Leave
                    </button>
                  </div>
                </div>

                <div className="recipient-grid">
                  {detail.members.map((m) => (
                    <span className="member-token" key={m.userId}>
                      {m.displayName}
                      <span className="muted">{m.role}</span>
                      {m.userId !== me && detail.type === "group" ? (
                        <button type="button" aria-label={`Remove ${m.displayName}`} onClick={() => removeMember(m.userId)}>
                          ×
                        </button>
                      ) : null}
                    </span>
                  ))}
                </div>

                <div className="messages-scroll" ref={scrollRef}>
                  {messages.length === 0 ? (
                    <div className="empty-state" style={{ flex: 1 }}>
                      <MessageSquare size={22} />
                      <p>No messages yet — say hi.</p>
                    </div>
                  ) : (
                    messages.map((m) =>
                      m.kind === "system" ? (
                        <span className="msg-system" key={m.id}>
                          {m.body}
                        </span>
                      ) : (
                        <div key={m.id} className={`msg-row${m.senderId === me ? " me" : " them"}`}>
                          <div className="msg-bubble">{m.body}</div>
                          <div className="msg-meta">
                            <span>{m.senderName ?? "Colleague"}</span>
                            <span>{new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                          </div>
                        </div>
                      ),
                    )
                  )}
                </div>

                <div className="composer">
                  <textarea
                    aria-label="Message"
                    value={draft}
                    placeholder="Write a message…"
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                  />
                  <button className="btn" type="button" disabled={busy || !draft.trim()} onClick={send}>
                    <Send size={15} /> Send
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      <Modal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        title="New conversation"
        footer={
          <button className="btn" type="button" disabled={busy} onClick={createThread}>
            <Plus size={15} /> Start
          </button>
        }
      >
        <div className="stack" style={{ gap: 12 }}>
          <div className="row" style={{ gap: 8 }}>
            <label className="checkbox-label">
              <input type="radio" name="kind" checked={kind === "direct"} onChange={() => setKind("direct")} />
              Direct message
            </label>
            <label className="checkbox-label">
              <input type="radio" name="kind" checked={kind === "group"} onChange={() => setKind("group")} />
              Group conversation
            </label>
          </div>
          {kind === "group" ? (
            <div className="field">
              <span>Group name</span>
              <input
                value={groupName}
                placeholder="e.g. Ops"
                onChange={(e) => setGroupName(e.target.value)}
              />
            </div>
          ) : null}
          <div className="field">
            <span>{kind === "group" ? "Members" : "Who"}</span>
            <div className="recipient-grid">
              {directory.length === 0 ? (
                <span className="muted small">No directory available to pick from.</span>
              ) : (
                directory
                  .filter((u) => u.isActive && u.id !== me)
                  .map((u) => {
                    const selected = picked.includes(u.id);
                    return (
                      <button
                        key={u.id}
                        type="button"
                        className={`recipient-option${selected ? " selected" : ""}`}
                        onClick={() =>
                          setPicked((cur) =>
                            selected ? cur.filter((id) => id !== u.id) : [...cur, u.id],
                          )
                        }
                      >
                        <input type="checkbox" checked={selected} readOnly style={{ pointerEvents: "none" }} />
                        {u.displayName}
                      </button>
                    );
                  })
              )}
            </div>
          </div>
          {composeErr ? <span className="error">{composeErr}</span> : null}
        </div>
      </Modal>

      <Modal
        open={addMemberOpen}
        onClose={() => setAddMemberOpen(false)}
        title="Add member"
        footer={
          <button className="btn" type="button" disabled={!addPick} onClick={addMember}>
            <UserPlus size={15} /> Add
          </button>
        }
      >
        <div className="stack" style={{ gap: 12 }}>
          <div className="recipient-grid">
            {addable.length === 0 ? (
              <span className="muted small">Everyone in the directory is already in this conversation.</span>
            ) : (
              addable.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  className={`recipient-option${addPick === u.id ? " selected" : ""}`}
                  onClick={() => setAddPick(u.id)}
                >
                  {u.displayName}
                </button>
              ))
            )}
          </div>
        </div>
      </Modal>

      <Modal
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        title="Rename conversation"
        footer={
          <button className="btn" type="button" disabled={!renameValue.trim()} onClick={renameThread}>
            <Pencil size={15} /> Save
          </button>
        }
      >
        <div className="field">
          <span>Name</span>
          <input
            value={renameValue}
            placeholder={threadTitle}
            onChange={(e) => setRenameValue(e.target.value)}
          />
        </div>
      </Modal>
    </AppShell>
  );
}
