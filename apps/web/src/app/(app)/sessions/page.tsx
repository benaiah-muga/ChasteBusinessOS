"use client";

import { useEffect, useState } from "react";

interface SessionRow {
  id: string;
  title: string | null;
  mode: string;
  status: string;
  modelRef: string | null;
  createdAt: string;
}
interface TrajectoryEvent {
  seq: number;
  role: string;
  content: unknown;
  at: string;
}

const roleStyles: Record<string, string> = {
  user: "bg-emerald-700 text-white",
  assistant: "bg-neutral-100",
  tool_call: "bg-indigo-50 border border-indigo-200",
  tool_result: "bg-orange-50 border border-orange-200",
  system: "bg-neutral-950 text-emerald-200 font-mono text-xs",
};

export default function SessionsPage() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [events, setEvents] = useState<TrajectoryEvent[] | null>(null);

  useEffect(() => {
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((d) => setSessions(d.sessions ?? []));
  }, []);

  useEffect(() => {
    if (!activeId) return;
    setEvents(null);
    fetch(`/api/sessions/${activeId}`)
      .then((r) => r.json())
      .then((d) => setEvents(d.events ?? []));
  }, [activeId]);

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Agent sessions</h1>
      <p className="mb-6 text-sm text-neutral-500">
        Every conversation with your AI co-worker, replayable event by event — what it saw, called,
        and answered.
      </p>

      {!sessions?.length && (
        <p className="rounded-xl border border-dashed border-neutral-300 px-6 py-10 text-center text-sm text-neutral-400">
          No sessions yet. Talk to the agent in the Console.
        </p>
      )}

      {sessions && sessions.length > 0 && (
        <div className="grid grid-cols-[320px_1fr] gap-6">
          <aside className="max-h-[75vh] space-y-2 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-3 shadow-sm">
            {sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => setActiveId(s.id)}
                className={`block w-full rounded-lg px-3 py-2.5 text-left hover:bg-neutral-50 ${activeId === s.id ? "bg-emerald-50" : ""}`}
              >
                <p className="truncate text-sm font-medium">{s.title ?? "Untitled session"}</p>
                <p className="mt-0.5 font-mono text-[10px] text-neutral-400">
                  {new Date(s.createdAt).toLocaleString()} · {s.mode} · {s.status}
                </p>
              </button>
            ))}
          </aside>

          <section className="max-h-[75vh] space-y-3 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
            {events === null && activeId && <p className="text-sm text-neutral-400">Loading trajectory…</p>}
            {!activeId && <p className="pt-10 text-center text-sm text-neutral-400">Select a session to replay it.</p>}
            {events?.map((e) => {
              const style = roleStyles[e.role] ?? "bg-neutral-100";
              let body: React.ReactNode = null;
              if (e.role === "user") body = (e.content as { text?: string }).text;
              else if (e.role === "assistant") body = (e.content as { text?: string }).text;
              else if (e.role === "tool_call") {
                const c = e.content as { name?: string; args?: unknown };
                body = (
                  <>
                    <span className="font-mono text-[11px] uppercase tracking-wide text-indigo-500">tool call</span>{" "}
                    <span className="font-mono text-sm">{c.name}</span>
                    <pre className="mt-1 max-h-32 overflow-auto rounded bg-white/60 p-2 text-[11px]">{JSON.stringify(c.args ?? {}, null, 1)}</pre>
                  </>
                );
              } else if (e.role === "tool_result") {
                const c = e.content as { name?: string; ok?: boolean; error?: string };
                body = (
                  <>
                    <span className={`font-mono text-[11px] uppercase ${c.ok ? "text-emerald-600" : "text-red-600"}`}>
                      {c.ok ? "ok" : "blocked"}
                    </span>{" "}
                    <span className="font-mono text-sm">{c.name}</span>
                    {c.error && <span className="ml-2 text-xs text-red-700">{c.error}</span>}
                  </>
                );
              } else body = JSON.stringify(e.content);
              if (!body && e.role !== "assistant") return null;
              return (
                <div key={e.seq} className="flex flex-col items-start gap-1">
                  <span className="font-mono text-[10px] text-neutral-300">
                    #{e.seq} · {new Date(e.at).toLocaleTimeString()}
                  </span>
                  <div className={`max-w-full whitespace-pre-wrap rounded-xl px-4 py-2.5 text-sm leading-relaxed ${style}`}>
                    {body}
                  </div>
                </div>
              );
            })}
          </section>
        </div>
      )}
    </div>
  );
}
