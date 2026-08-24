"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, EmptyState, LoadingPage, PageHeader } from "@/components/ui";
import { IconAlertTriangle, IconBot, IconChevronRight, IconListTree } from "@/components/icons";
import { cn, timeAgo } from "@/lib/format";
import { callApi } from "@/lib/api";

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

const roleCard: Record<string, string> = {
  user: "bg-maroon-50/70 border-maroon-100",
  assistant: "bg-white border-stone-200",
  tool_call: "bg-violet-50/70 border-violet-200",
  tool_result: "bg-amber-50/60 border-amber-200",
  system: "bg-stone-950 border-stone-900 text-stone-300 font-mono text-xs",
};

export default function SessionsPage() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [events, setEvents] = useState<TrajectoryEvent[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cache, setCache] = useState<{ totals?: { sessionsTracked: number; inputTokens: number; cachedInputTokens: number; cacheHitRatePct: number | null } } | null>(null);

  const loadSessions = useCallback(async () => {
    setLoadError(null);
    const res = await callApi<{ sessions?: SessionRow[] }>("/api/sessions");
    if (!res.ok) {
      setLoadError(res.error?.title ?? "Couldn't load sessions");
      setSessions([]);
      return;
    }
    setSessions(res.data?.sessions ?? []);
  }, []);

  useEffect(() => {
    void loadSessions();
    void callApi<typeof cache>("/api/metrics").then((r) => setCache(r.data ?? null));
  }, [loadSessions]);

  useEffect(() => {
    if (!activeId) return;
    setEvents(null);
    callApi<{ events?: TrajectoryEvent[] }>(`/api/sessions/${activeId}`).then((res) =>
      setEvents(res.data?.events ?? []),
    );
  }, [activeId]);

  if (loadError && sessions === null) {
    return (
      <div>
        <PageHeader title="Agent sessions" />
        <EmptyState icon={<IconAlertTriangle />} title={loadError} hint="Check your connection, then retry."
          action={<Button tone="secondary" onClick={() => void loadSessions()}>Retry</Button>} />
      </div>
    );
  }
  if (sessions === null) return <LoadingPage />;

  return (
    <div>
      <PageHeader
        title="Agent sessions"
        description="Every conversation with your AI co-worker, replayable event by event, what it saw, called, and answered."
      />

      {cache?.totals && (
        <div className="mb-4 rounded-xl border border-stone-200 bg-white px-4 py-3 text-xs text-stone-600 shadow-xs">
          <span className="font-medium text-stone-800">Context efficiency:</span>{" "}
          {cache.totals.cacheHitRatePct === null
            ? "no token usage recorded yet"
            : `${cache.totals.cacheHitRatePct}% of prompt tokens served from provider cache`}
          {" · "}
          {(cache.totals.inputTokens / 1000).toFixed(1)}k input /{" "}
          {(cache.totals.cachedInputTokens / 1000).toFixed(1)}k cached across{" "}
          {cache.totals.sessionsTracked} session{cache.totals.sessionsTracked === 1 ? "" : "s"}
        </div>
      )}

      {sessions.length === 0 ? (
        <EmptyState
          icon={<IconBot />}
          title="No sessions yet"
          hint="Talk to your co-worker in the Console, every exchange is recorded here for replay and audit."
        />
      ) : (
        <div className="grid h-[calc(100vh-240px)] min-h-[420px] gap-4 lg:grid-cols-[320px_1fr]">
          <aside className="card min-h-0 overflow-y-auto p-2">
            {sessions.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-current={activeId === s.id ? "true" : undefined}
                onClick={() => setActiveId(s.id)}
                className={cn(
                  "block w-full rounded-lg px-3 py-2.5 text-left transition-colors duration-75",
                  activeId === s.id ? "bg-maroon-50" : "hover:bg-stone-50",
                )}
              >
                <p className={cn("truncate text-sm font-medium", activeId === s.id ? "text-maroon-900" : "text-stone-800")}>
                  {s.title ?? "Untitled session"}
                </p>
                <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-stone-400">
                  <span>{timeAgo(s.createdAt)}</span>·<Badge tone={s.mode === "creator" ? "violet" : "neutral"}>{s.mode}</Badge>
                  <span>{s.status}</span>
                </p>
              </button>
            ))}
          </aside>

          <section className="card min-h-0 overflow-y-auto p-4 sm:p-5">
            {!activeId && (
              <div className="flex h-full items-center justify-center">
                <EmptyState icon={<IconListTree />} title="Pick a session" hint="Select a session on the left to replay its full trajectory." />
              </div>
            )}
            {events === null && activeId && <LoadingPage />}
            {events?.length === 0 && (
              <p className="pt-10 text-center text-sm text-stone-400">This session has no recorded events.</p>
            )}
            <div className="space-y-3">
              {events?.map((e) => {
                const content = e.content as { text?: string; name?: string; args?: unknown; ok?: boolean; error?: string };
                let body: React.ReactNode = null;
                if (e.role === "user") {
                  body = <p className="text-sm leading-relaxed whitespace-pre-wrap text-stone-800">{content.text}</p>;
                } else if (e.role === "assistant") {
                  body = <p className="text-sm leading-relaxed whitespace-pre-wrap text-stone-800">{content.text}</p>;
                } else if (e.role === "tool_call") {
                  body = (
                    <>
                      <span className="mb-1 block font-mono text-[11px] font-semibold tracking-wide text-violet-600 uppercase">
                        tool call · {content.name}
                      </span>
                      <details>
                        <summary className="cursor-pointer text-xs text-violet-700 select-none hover:text-violet-900">
                          arguments
                        </summary>
                        <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-white/70 p-2 font-mono text-[11px] text-stone-700">
                          {JSON.stringify(content.args ?? {}, null, 1)}
                        </pre>
                      </details>
                    </>
                  );
                } else if (e.role === "tool_result") {
                  body = (
                    <>
                      <span
                        className={cn(
                          "mr-2 inline-flex items-center gap-1 font-mono text-[11px] font-semibold tracking-wide uppercase",
                          content.ok ? "text-emerald-700" : "text-red-700",
                        )}
                      >
                        <IconChevronRight className="size-3" />
                        {content.ok ? "ok" : "blocked"} · {content.name}
                      </span>
                      {content.error && <span className="text-xs text-red-800">{content.error}</span>}
                    </>
                  );
                } else {
                  body = <pre className="overflow-auto">{JSON.stringify(e.content)}</pre>;
                }
                if (!body && e.role !== "assistant") return null;
                return (
                  <div key={e.seq} className="flex flex-col items-start gap-1">
                    <span className="font-mono text-[10px] text-stone-300">
                      #{e.seq} · {new Date(e.at).toLocaleTimeString()}
                    </span>
                    <div className={cn("max-w-full rounded-xl border px-4 py-2.5", roleCard[e.role] ?? "bg-stone-50 border-stone-200")}>
                      {body}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
