"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, CardTitle, ConfirmDialog } from "@/components/ui";
import { IconCircleCheck, IconLock } from "@/components/icons";
import { callApi, postApi } from "@/lib/api";

type CloseTask = {
  key: string;
  label: string;
  detail: string;
  completed: boolean;
  note: string | null;
  blocking: boolean;
  status: string;
};
type CloseState = {
  year: number;
  month: number;
  start: string;
  end: string;
  tasks: CloseTask[];
  blockers: string[];
  readyToClose: boolean;
  unmatchedLineCount: number;
  currenciesWithExposure: string[];
};
type CloseApiResponse = { ok?: boolean; data?: CloseState; error?: string; pendingApproval?: boolean; reason?: string };

const MANUAL_CHECKS = new Set(["review_journal", "review_receivables", "review_payables", "review_tax"]);
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function defaultPeriod(): string {
  const prior = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1));
  return `${prior.getUTCFullYear()}-${String(prior.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function CloseWorkbench({ closedPeriods, onRefresh }: { closedPeriods: { year: number; month: number }[]; onRefresh: () => void }) {
  const [period, setPeriod] = useState(defaultPeriod);
  const [state, setState] = useState<CloseState | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "pending"; text: string } | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [refresh, setRefresh] = useState(0);

  const [yearText, monthText] = period.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const closed = closedPeriods.some((entry) => entry.year === year && entry.month === month);

  const load = useCallback(async () => {
    if (!year || !month) return;
    setLoading(true);
    setLoadError("");
    const res = await callApi<CloseApiResponse>(`/api/accounting/close?year=${year}&month=${month}`);
    if (!res.ok || !res.data?.data) {
      setLoadError(res.error?.title ?? res.data?.error ?? "Couldn't load close readiness.");
      setState(null);
      setLoading(false);
      return;
    }
    setState(res.data.data);
    setNotes(Object.fromEntries(res.data.data.tasks.filter((task) => task.note).map((task) => [task.key, task.note ?? ""])));
    setLoading(false);
  }, [year, month, refresh]);

  useEffect(() => { void load(); }, [load]);

  async function runAction(action: "checklist" | "revalue" | "close", extra: Record<string, unknown> = {}) {
    setBusyAction(action === "checklist" ? String(extra.taskKey ?? "checklist") : action);
    setNotice(null);
    try {
      const res = await postApi<CloseApiResponse>("/api/accounting/close", {
        action,
        intentId: crypto.randomUUID(),
        year,
        month,
        ...extra,
      });
      if (res.status === 202) {
        setNotice({ tone: "pending", text: res.data?.reason ?? "This close action needs approval. Refresh after approval to update the checklist." });
      } else if (!res.ok) {
        setNotice({ tone: "error", text: res.error?.title ?? res.data?.error ?? "The close action could not be completed." });
      } else {
        setNotice({ tone: "success", text: action === "checklist" ? "Review saved." : action === "revalue" ? "FX revaluation posted." : "Period close requested." });
        setConfirmClose(false);
        if (action === "close") onRefresh();
      }
    } catch {
      setNotice({ tone: "error", text: "Couldn't save this close action. Check your connection and try again." });
    } finally {
      setBusyAction("");
      setRefresh((value) => value + 1);
    }
  }

  const fxTask = state?.tasks.find((task) => task.key === "fx_revaluation");
  const blockers = state?.tasks.filter((task) => task.blocking) ?? [];

  return (
    <section className="space-y-5">
      {notice && <div role={notice.tone === "error" ? "alert" : "status"} className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${notice.tone === "error" ? "border-rose-200 bg-rose-50 text-rose-800" : notice.tone === "pending" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}><span>{notice.text}</span>{notice.tone === "pending" && <Button size="sm" tone="secondary" onClick={() => setRefresh((value) => value + 1)}>Refresh checklist</Button>}</div>}

      <Card>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <CardTitle right={closed ? <Badge>Closed</Badge> : state?.readyToClose ? <Badge>Ready to close</Badge> : <Badge>{blockers.length} checks need attention</Badge>}>Month-end close workbench</CardTitle>
            <p className="mt-1 max-w-3xl text-sm text-stone-600">Work through reconciliation, FX, and review sign-offs. The period stays open until every required check is complete.</p>
          </div>
          <label className="text-xs font-medium text-stone-600">Close period
            <input aria-label="Choose month to close" className="input mt-1 block w-40" type="month" value={period} onChange={(event) => setPeriod(event.target.value)} />
          </label>
        </div>

        {closed && <p className="mt-4 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-600">This period is already sealed. Reopen it from the closed-period history below if a correction is needed.</p>}
        {loadError && <div className="mt-4 flex flex-wrap items-center gap-3"><p role="alert" className="text-sm text-red-700">{loadError}</p><Button size="sm" tone="secondary" onClick={() => setRefresh((value) => value + 1)}>Retry</Button></div>}
        {loading && !loadError && <p className="mt-4 text-sm text-stone-600">Checking reconciliations and close tasks…</p>}

        {state && !loading && (
          <>
            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              <div className="rounded-lg bg-stone-50 p-3"><p className="text-xs text-stone-600">Period</p><p className="mt-1 text-sm font-medium text-stone-800">{MONTH_NAMES[month - 1]} {year}</p></div>
              <div className="rounded-lg bg-stone-50 p-3"><p className="text-xs text-stone-600">Unmatched bank lines</p><p className="mt-1 text-sm font-medium text-stone-800">{state.unmatchedLineCount}</p></div>
              <div className="rounded-lg bg-stone-50 p-3"><p className="text-xs text-stone-600">Foreign receivables</p><p className="mt-1 text-sm font-medium text-stone-800">{state.currenciesWithExposure.length ? state.currenciesWithExposure.join(", ") : "None"}</p></div>
            </div>
            <div className="mt-5 divide-y divide-stone-200 rounded-xl border border-stone-200">
              {state.tasks.map((task) => {
                const manual = MANUAL_CHECKS.has(task.key);
                const actionBusy = busyAction === task.key || (task.key === "fx_revaluation" && busyAction === "revalue");
                return <div key={task.key} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 gap-3">
                    <span className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full ${task.completed ? "bg-emerald-50 text-emerald-700" : task.blocking ? "bg-amber-50 text-amber-700" : "bg-stone-100 text-stone-600"}`}>
                      {task.completed ? <IconCircleCheck className="size-4" /> : <span aria-hidden="true" className="text-xs font-semibold">{task.blocking ? "!" : "•"}</span>}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold text-stone-800">{task.label}</h3><Badge>{task.completed ? "Complete" : task.status.replaceAll("_", " ")}</Badge></div>
                      <p className="mt-1 text-sm text-stone-600">{task.detail}</p>
                      {manual && <label className="mt-3 block text-xs font-medium text-stone-600">Review note <span className="font-normal text-stone-600">(optional)</span><textarea className="input mt-1 min-h-16 w-full resize-y" maxLength={500} value={notes[task.key] ?? ""} placeholder="Add a short note for the close record" onChange={(event) => setNotes((current) => ({ ...current, [task.key]: event.target.value }))} /></label>}
                    </div>
                  </div>
                  {manual ? <label className="flex shrink-0 items-center gap-2 text-sm font-medium text-stone-700 sm:pt-1"><input type="checkbox" className="size-4 accent-emerald-700" checked={task.completed} disabled={closed || actionBusy} onChange={(event) => void runAction("checklist", { taskKey: task.key, completed: event.target.checked, note: notes[task.key] ?? "" })} />Reviewed</label>
                    : task.key === "fx_revaluation" && fxTask?.blocking ? <Button size="sm" tone="secondary" disabled={closed || !!busyAction} loading={actionBusy} onClick={() => void runAction("revalue")}>Revalue foreign receivables</Button>
                    : null}
                </div>;
              })}
            </div>
            {blockers.length > 0 && !closed && <p className="mt-3 text-xs text-stone-600">Complete each blocking item to enable period close. Bank lines clear automatically when they are matched in Bank.</p>}
            <div className="mt-5 flex flex-col gap-3 border-t border-stone-200 pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-stone-600">Closing is approval-gated and prevents new entries from posting into this month.</p>
              <Button tone="danger" disabled={!state.readyToClose || closed || !!busyAction} onClick={() => setConfirmClose(true)}><IconLock className="size-3.5" /> Close {MONTH_NAMES[month - 1]}</Button>
            </div>
          </>
        )}
      </Card>

      <ConfirmDialog open={confirmClose} onClose={() => setConfirmClose(false)} onConfirm={() => void runAction("close")} title={`Close ${MONTH_NAMES[month - 1]} ${year}`} body={<>The checks are complete. Request approval to seal this month? New postings to {year}-{String(month).padStart(2, "0")} will be blocked until it is reopened.</>} confirmLabel="Request period close" busy={busyAction === "close"} />
    </section>
  );
}
