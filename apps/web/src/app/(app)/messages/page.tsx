"use client";

import { useCallback, useEffect, useState } from "react";

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
  const [convs, setConvs] = useState<Conversation[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newAgent, setNewAgent] = useState(false);

  const loadConvs = useCallback(async () => {
    const res = await fetch("/api/conversations");
    if (!res.ok) return;
    const data = await res.json();
    setConvs(data.conversations);
    if (!activeId && data.conversations[0]) setActiveId(data.conversations[0].id);
  }, [activeId]);

  useEffect(() => {
    loadConvs();
  }, [loadConvs]);

  useEffect(() => {
    if (!activeId) return;
    fetch(`/api/conversations/${activeId}/messages`)
      .then((r) => r.json())
      .then((d) => setMsgs(d.messages ?? []));
  }, [activeId]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!activeId || !draft.trim() || sending) return;
    setSending(true);
    const body = draft.trim();
    setDraft("");
    try {
      const res = await fetch(`/api/conversations/${activeId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      // refresh thread (includes the agent's reply if the conversation has one)
      const refreshed = await fetch(`/api/conversations/${activeId}/messages`).then((r) => r.json());
      setMsgs(refreshed.messages ?? []);
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
      setNewAgent(false);
      const data = await res.json();
      await loadConvs();
      setActiveId(data.conversation.id);
    }
  }

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Messages</h1>
      <p className="mb-6 text-sm text-neutral-500">
        Team channels and DMs. Conversations with the Chaste toggle let your AI co-worker read the
        thread and act when colleagues ask.
      </p>

      <div className="grid grid-cols-[280px_1fr] gap-6">
        <aside className="space-y-4">
          <div className="rounded-xl border border-neutral-200 bg-white shadow-sm">
            {convs === null && <p className="p-4 text-sm text-neutral-400">Loading…</p>}
            {convs?.map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveId(c.id)}
                className={`block w-full border-b border-neutral-100 px-4 py-3 text-left last:border-0 hover:bg-neutral-50 ${
                  activeId === c.id ? "bg-emerald-50/60" : ""
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-neutral-400">{c.kind === "dm" ? "DM" : "#"}</span>
                  <span className="truncate text-sm font-medium">{c.title}</span>
                  {c.agentEnabled && (
                    <span className="ml-auto rounded-full bg-indigo-100 px-1.5 py-0.5 font-mono text-[10px] text-indigo-700">
                      chaste
                    </span>
                  )}
                </div>
                {c.lastMessage && (
                  <p className="mt-0.5 truncate text-xs text-neutral-400">{c.lastMessage.body}</p>
                )}
              </button>
            ))}
          </div>

          <form onSubmit={createConv} className="space-y-2 rounded-xl border border-dashed border-neutral-300 p-4">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="New channel name…"
              className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
            />
            <label className="flex items-center gap-2 text-xs text-neutral-600">
              <input type="checkbox" checked={newAgent} onChange={(e) => setNewAgent(e.target.checked)} />
              Include Chaste (AI co-worker)
            </label>
            <button
              type="submit"
              className="w-full rounded-lg bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800"
            >
              Create channel
            </button>
          </form>
        </aside>

        <section className="flex h-[70vh] flex-col rounded-xl border border-neutral-200 bg-white shadow-sm">
          <div className="flex-1 space-y-3 overflow-y-auto p-5">
            {msgs.map((m) => (
              <div key={m.id} className={`flex ${m.senderType === "human" ? "justify-start" : "justify-start"}`}>
                <div>
                  <p className="mb-0.5 font-mono text-[10px] uppercase tracking-wide text-neutral-400">
                    {m.senderType === "agent" ? "Chaste · AI" : m.senderType}
                    {" · "}
                    {new Date(m.createdAt).toLocaleTimeString()}
                  </p>
                  <div
                    className={`max-w-[85%] whitespace-pre-wrap rounded-xl px-3.5 py-2 text-sm ${
                      m.senderType === "agent" ? "bg-indigo-50 text-indigo-950" : "bg-neutral-100"
                    }`}
                  >
                    {m.body}
                  </div>
                </div>
              </div>
            ))}
            {msgs.length === 0 && <p className="pt-8 text-center text-sm text-neutral-400">No messages yet.</p>}
          </div>
          <form onSubmit={send} className="flex gap-2 border-t border-neutral-200 p-3">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={!activeId}
              placeholder={activeId ? "Write a message…" : "Select a conversation"}
              className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
            />
            <button
              type="submit"
              disabled={sending || !draft.trim()}
              className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-40"
            >
              Send
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
