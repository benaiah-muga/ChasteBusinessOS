"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ActionNotice,
  type ActionNoticeState,
  Badge,
  Button,
  EmptyState,
  LoadingPage,
  PageHeader,
  StatCard,
} from "@/components/ui";
import { IconAlertTriangle, IconArrowRight, IconTrendingUp, IconUndo, IconX } from "@/components/icons";
import { cn, formatMoneyWhole, toMinor } from "@/lib/format";
import { callApi, postApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";

const STAGES = ["lead", "qualified", "proposal", "negotiation", "won", "lost"] as const;
type Stage = (typeof STAGES)[number];

interface Deal {
  id: string;
  title: string;
  stage: Stage;
  valueMinor: number;
  note: string | null;
  updatedAt: string;
}

const stageMeta: Record<Stage, { dot: string; label: string }> = {
  lead: { dot: "bg-stone-400", label: "Lead" },
  qualified: { dot: "bg-sky-500", label: "Qualified" },
  proposal: { dot: "bg-blue-500", label: "Proposal" },
  negotiation: { dot: "bg-violet-500", label: "Negotiation" },
  won: { dot: "bg-emerald-600", label: "Won" },
  lost: { dot: "bg-red-500", label: "Lost" },
};

const weights: Record<Stage, number> = { lead: 0.1, qualified: 0.3, proposal: 0.5, negotiation: 0.7, won: 1, lost: 0 };

export default function CrmPage() {
  const __enabled = useModuleEnabled("crm");
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newValue, setNewValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    const res = await callApi<{ deals?: Deal[] }>("/api/deals");
    if (!res.ok) {
      setLoadError(res.error?.title ?? "Couldn't load your pipeline");
      setDeals([]);
      return;
    }
    setDeals(res.data?.deals ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setBusy(true);
    try {
      const res = await postApi("/api/deals", { action: "create", title: newTitle.trim(), valueMinor: toMinor(newValue) });
      if (!res.ok && res.error) setNotice({ tone: "error", error: res.error });
      else {
        setNewTitle("");
        setNewValue("");
      }
      void load();
    } finally {
      setBusy(false);
    }
  }

  async function move(dealId: string, stage: Stage) {
    setBusy(true);
    try {
      const res = await postApi("/api/deals", { action: "move", dealId, stage });
      if (!res.ok && res.error) setNotice({ tone: "error", error: res.error });
      void load();
    } finally {
      setBusy(false);
    }
  }

  if (loadError && deals === null) {
    return (
      <div>
        <PageHeader title="Pipeline" />
        <EmptyState
          icon={<IconAlertTriangle />}
          title={loadError}
          hint="Check your connection, then retry."
          action={
            <Button tone="secondary" onClick={() => void load()}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }
  if (!deals) return <LoadingPage />;

  const openDeals = deals.filter((d) => d.stage !== "won" && d.stage !== "lost");
  const openValue = openDeals.reduce((s, d) => s + d.valueMinor, 0);
  const forecast = openDeals.reduce((s, d) => s + Math.round(d.valueMinor * weights[d.stage]), 0);
  const wonValue = deals.filter((d) => d.stage === "won").reduce((s, d) => s + d.valueMinor, 0);

  if (!__enabled) return <ModuleDisabled label="Pipeline" />;

  return (
    <div>
      <PageHeader
        title="Pipeline"
        description="Deal lifecycle across six stages. Weighted forecast applies each stage's probability to its open value."
        actions={
          <form onSubmit={create} className="flex items-center gap-2">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="New deal…"
              aria-label="New deal name"
              className="input h-9 w-40 sm:w-48"
            />
            <input
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder="$ value"
              aria-label="New deal value in dollars"
              inputMode="decimal"
              className="input h-9 w-24"
            />
            <Button type="submit" loading={busy} disabled={!newTitle.trim()}>
              Add
            </Button>
          </form>
        }
      />

      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Open deals" value={openDeals.length} />
        <StatCard label="Pipeline" value={formatMoneyWhole(openValue)} />
        <StatCard label="Weighted forecast" value={formatMoneyWhole(forecast)} tone="accent" />
        <StatCard label="Won to date" value={formatMoneyWhole(wonValue)} tone="success" />
      </div>

      {deals.length === 0 ? (
        <EmptyState
          icon={<IconTrendingUp />}
          title="No deals yet"
          hint="Add your first deal above, or ask your co-worker to create one from a conversation."
        />
      ) : (
        <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-3 sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10">
          {STAGES.map((stage) => {
            const column = deals.filter((d) => d.stage === stage);
            return (
              <section
                key={stage}
                className="flex w-64 shrink-0 snap-start flex-col rounded-xl border border-stone-200 bg-stone-50/70 p-2.5"
                aria-label={`${stageMeta[stage].label} stage`}
              >
                <div className="mb-2.5 flex items-center gap-2 px-1.5 pt-1">
                  <span className={cn("size-2 rounded-full", stageMeta[stage].dot)} aria-hidden="true" />
                  <h2 className="text-[13px] font-semibold text-stone-700">{stageMeta[stage].label}</h2>
                  <span className="tnum ml-auto rounded-full bg-stone-200/80 px-1.5 py-px text-[11px] font-medium text-stone-600">
                    {column.length}
                  </span>
                </div>
                <div className="flex min-h-16 flex-col gap-2">
                  {column.map((deal) => (
                    <article key={deal.id} className="rounded-lg border border-stone-200 bg-white p-3 shadow-xs transition-shadow duration-150 hover:shadow-sm">
                      <p className="text-sm leading-snug font-medium text-stone-800">{deal.title}</p>
                      {deal.valueMinor > 0 && (
                        <p className="tnum mt-1 text-xs font-medium text-stone-500">{formatMoneyWhole(deal.valueMinor)}</p>
                      )}
                      {stage !== "won" && stage !== "lost" && (
                        <div className="mt-2.5 flex items-center justify-between gap-1 border-t border-stone-100 pt-2">
                          <button
                            type="button"
                            onClick={() => move(deal.id, STAGES[Math.min(STAGES.indexOf(stage) + 1, STAGES.length - 2)]!)}
                            disabled={busy}
                            aria-label={`Move “${deal.title}” forward`}
                            title="Advance stage"
                            className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-stone-500 transition-colors duration-150 hover:bg-emerald-50 hover:text-emerald-700 disabled:pointer-events-none disabled:opacity-40"
                          >
                            Advance <IconArrowRight className="size-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => move(deal.id, "lost")}
                            disabled={busy}
                            aria-label={`Mark “${deal.title}” as lost`}
                            title="Mark lost"
                            className="icon-btn size-6 hover:bg-red-50 hover:text-red-700"
                          >
                            <IconX className="size-3.5" />
                          </button>
                        </div>
                      )}
                      {(stage === "lost" || stage === "won") && (
                        <div className="mt-2.5 border-t border-stone-100 pt-2">
                          <button
                            type="button"
                            onClick={() => move(deal.id, "lead")}
                            disabled={busy}
                            className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-stone-400 transition-colors duration-150 hover:bg-stone-100 hover:text-stone-700 disabled:pointer-events-none disabled:opacity-40"
                          >
                            <IconUndo className="size-3" /> Reopen
                          </button>
                        </div>
                      )}
                    </article>
                  ))}
                  {column.length === 0 && (
                    <p className="rounded-lg border border-dashed border-stone-200 py-4 text-center text-xs text-stone-300">-</p>
                  )}
                </div>
              </section>
            );
          })}
          {busy && (
            <span className="sr-only" role="status">
              Updating board
            </span>
          )}
        </div>
      )}

      {deals.some((d) => d.stage === "won") && (
        <p className="mt-2 text-xs text-stone-400">
          <Badge tone="green">tip</Badge> Won deals post nothing by themselves, invoice them from the Console when you're ready.
        </p>
      )}
    </div>
  );
}
