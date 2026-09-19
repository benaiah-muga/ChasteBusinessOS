"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, EmptyState, LoadingPage, PageHeader } from "@/components/ui";
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
interface DurableRunRow {
  id: string;
  sessionId: string | null;
  goal: string;
  status: string;
  currentStep: number;
  modelRef: string | null;
  harnessProfileId: string | null;
  harnessProfileVersion: string | null;
  harnessCompositionDigest: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
interface DurableRunDetail {
  run: DurableRunRow & { registryVersion: string; contractRevision: number };
  steps: Array<{
    id: string;
    stepIndex: number;
    capabilityId: string | null;
    status: string;
    inputHash: string | null;
    error: string | null;
    receiptId: string | null;
    approvalId: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
}
interface ReplayTrace {
  eventCount: number;
  finalMessage: string;
  observations: Array<{ seq: number; name: string; result: string }>;
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
  const [replay, setReplay] = useState<ReplayTrace | null>(null);
  const [runs, setRuns] = useState<DurableRunRow[] | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<DurableRunDetail | null>(null);
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
    void callApi<{ runs?: DurableRunRow[] }>("/api/durable-runs").then((r) => setRuns(r.data?.runs ?? []));
    void callApi<typeof cache>("/api/metrics").then((r) => setCache(r.data ?? null));
  }, [loadSessions]);

  useEffect(() => {
    if (!activeId) return;
    setEvents(null);
    setReplay(null);
    void Promise.all([
      callApi<{ events?: TrajectoryEvent[] }>(`/api/sessions/${activeId}`),
      callApi<{ trace?: ReplayTrace }>(`/api/sessions/${activeId}/replay`),
    ]).then(([eventsRes, replayRes]) => {
      setEvents(eventsRes.data?.events ?? []);
      setReplay(replayRes.data?.trace ?? null);
    });
  }, [activeId]);

  useEffect(() => {
    if (!activeRunId) {
      setRunDetail(null);
      return;
    }
    setRunDetail(null);
    void callApi<DurableRunDetail>(`/api/durable-runs/${activeRunId}`).then((res) => setRunDetail(res.data ?? null));
  }, [activeRunId]);

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
        description="Every conversation and durable piece of work, replayable event by event with its governed checkpoints."
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

      {runs && runs.length > 0 && (
        <Card className="mb-4">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="section-title">Durable work</h2>
              <p className="mt-1 text-xs text-stone-500">Resumable tasks are separate from the conversation that records them.</p>
            </div>
            <span className="text-xs text-stone-400">{runs.length} recent run{runs.length === 1 ? "" : "s"}</span>
          </div>
          <div className="grid gap-2 lg:grid-cols-2">
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => setActiveRunId(run.id)}
                className={cn(
                  "rounded-lg border px-3.5 py-3 text-left transition-colors",
                  activeRunId === run.id ? "border-maroon-200 bg-maroon-50/70" : "border-stone-200 hover:bg-stone-50",
                )}
              >
                <div className="flex items-center gap-2">
                  <Badge tone={run.status === "completed" ? "green" : run.status === "failed" ? "red" : "amber"}>{run.status.replaceAll("_", " ")}</Badge>
                  <span className="text-[11px] text-stone-400">step {run.currentStep}</span>
                  <span className="ml-auto text-[11px] text-stone-400">{timeAgo(run.updatedAt)}</span>
                </div>
                <p className="mt-2 line-clamp-2 text-sm font-medium text-stone-800">{run.goal}</p>
                {run.harnessProfileId && <p className="mt-1 text-[11px] text-stone-500">{run.harnessProfileId} · {run.harnessProfileVersion}</p>}
              </button>
            ))}
          </div>
          {runDetail && (
            <div className="mt-3 rounded-lg border border-stone-200 bg-stone-50/70 p-3.5 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-stone-800">Run dossier</span>
                <Badge tone="neutral">{runDetail.steps.length} checkpoint{runDetail.steps.length === 1 ? "" : "s"}</Badge>
                <span className="text-stone-500">registry {runDetail.run.registryVersion}</span>
                {runDetail.run.lastError && <span className="text-red-700">{runDetail.run.lastError}</span>}
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {runDetail.steps.map((step) => (
                  <div key={step.id} className="rounded-md border border-stone-200 bg-white px-2.5 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[10px] text-stone-400">#{step.stepIndex}</span>
                      <Badge tone={step.status === "committed" ? "green" : step.status === "failed" ? "red" : "neutral"}>{step.status}</Badge>
                    </div>
                    <p className="mt-1 truncate font-mono text-[11px] text-stone-700">{step.capabilityId ?? "unassigned step"}</p>
                    {step.receiptId && <p className="mt-1 text-[10px] text-stone-400">receipt-backed</p>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      {sessions.length === 0 ? (
        <EmptyState
          icon={<IconBot />}
          title="No sessions yet"
          hint="Talk to your workmate in the Console, every exchange is recorded here for replay and audit."
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
            {replay && (
              <div className="mb-4 rounded-lg border border-violet-200 bg-violet-50/60 px-3.5 py-3 text-xs text-violet-950">
                <div className="flex flex-wrap items-center gap-2 font-medium">
                  <span>Canonical replay</span>
                  <Badge tone="violet">{replay.eventCount} events</Badge>
                  <span className="font-normal text-violet-800">read-only · no model or capability invoked</span>
                </div>
                {replay.finalMessage && <p className="mt-2 line-clamp-3 leading-relaxed text-violet-900">{replay.finalMessage}</p>}
              </div>
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
