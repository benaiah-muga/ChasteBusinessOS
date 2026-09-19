"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ActionNotice,
  type ActionNoticeState,
  Badge,
  Button,
  Dialog,
  EmptyState,
  LoadingPage,
  StatCard,
} from "@/components/ui";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconHistory,
  IconTrendingUp,
  IconUndo,
  IconUser,
  IconX,
} from "@/components/icons";
import { cn, formatDate, formatMoneyWhole, timeAgo, toMinor } from "@/lib/format";
import { callApi, postApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";
import { AppFrame } from "../_shell/app-frame";
import { TasksTab } from "./tasks-tab";

const STAGES = ["lead", "qualified", "proposal", "negotiation", "won", "lost"] as const;
type Stage = (typeof STAGES)[number];

interface Deal {
  id: string;
  title: string;
  stage: Stage;
  valueMinor: number;
  note: string | null;
  customerId: string | null;
  customerName: string | null;
  updatedAt: string;
}

interface Customer {
  id: string;
  name: string;
  email: string | null;
  deactivatedAt: string | null;
}

const stageMeta: Record<Stage, { dot: string; bar: string; label: string }> = {
  lead: { dot: "bg-stone-400", bar: "bg-stone-300", label: "Lead" },
  qualified: { dot: "bg-sky-500", bar: "bg-sky-300", label: "Qualified" },
  proposal: { dot: "bg-blue-500", bar: "bg-blue-300", label: "Proposal" },
  negotiation: { dot: "bg-violet-500", bar: "bg-violet-300", label: "Negotiation" },
  won: { dot: "bg-emerald-600", bar: "bg-emerald-600", label: "Won" },
  lost: { dot: "bg-red-500", bar: "bg-red-300", label: "Lost" },
};

const weights: Record<Stage, number> = { lead: 0.1, qualified: 0.3, proposal: 0.5, negotiation: 0.7, won: 1, lost: 0 };

const timelineKindTone: Record<string, "neutral" | "amber" | "blue" | "violet" | "green"> = {
  quote: "neutral",
  invoice: "blue",
  payment: "green",
  deal: "violet",
  task: "amber",
};

interface TimelineEntry {
  kind: string;
  date: string;
  refId: string;
  summary: string;
}
interface TimelineState {
  customerId: string;
  name: string;
  entries?: TimelineEntry[];
}

// __MAIN__
export default function CrmPage() {
  const __enabled = useModuleEnabled("crm");
  const [tab, setTab] = useState("overview");
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newCustomerId, setNewCustomerId] = useState("");
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerEmail, setNewCustomerEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineState | null>(null);

  async function openTimeline(customerId: string, name: string): Promise<void> {
    setTimeline({ customerId, name });
    const res = await callApi<{ entries?: TimelineEntry[] }>(`/api/crm?timeline=${encodeURIComponent(customerId)}`);
    setTimeline(res.ok && res.data ? { customerId, name, entries: res.data.entries ?? [] } : { customerId, name, entries: [] });
  }

  const load = useCallback(async () => {
    setLoadError(null);
    const [dealsRes, customersRes] = await Promise.all([
      callApi<{ deals?: Deal[] }>("/api/deals"),
      callApi<{ customers?: Customer[] }>("/api/customers"),
    ]);
    if (!dealsRes.ok) {
      setLoadError(dealsRes.error?.title ?? "Couldn't load your pipeline");
      setDeals([]);
    } else {
      setDeals(dealsRes.data?.deals ?? []);
    }
    setCustomers(customersRes.ok ? (customersRes.data?.customers ?? []) : []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function createDeal(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setBusy(true);
    try {
      const res = await postApi("/api/deals", {
        action: "create",
        title: newTitle.trim(),
        valueMinor: toMinor(newValue),
        ...(newCustomerId ? { customerId: newCustomerId } : {}),
      });
      if (!res.ok && res.error) setNotice({ tone: "error", error: res.error });
      else {
        setNewTitle("");
        setNewValue("");
        setNewCustomerId("");
      }
      void load();
    } finally {
      setBusy(false);
    }
  }

  async function createCustomer(e: React.FormEvent) {
    e.preventDefault();
    if (!newCustomerName.trim()) return;
    setBusy(true);
    try {
      const res = await postApi("/api/customers", {
        action: "create",
        name: newCustomerName.trim(),
        ...(newCustomerEmail.trim() ? { email: newCustomerEmail.trim() } : {}),
      });
      if (!res.ok && res.error) setNotice({ tone: "error", error: res.error });
      else {
        setNewCustomerName("");
        setNewCustomerEmail("");
      }
      void load();
    } finally {
      setBusy(false);
    }
  }

  /** Optimistic stage move: the board responds instantly; failure rolls back. */
  async function move(dealId: string, stage: Stage) {
    const prev = deals;
    const deal = deals?.find((d) => d.id === dealId);
    if (!deal || deal.stage === stage) return;
    setDeals((ds) => ds?.map((d) => (d.id === dealId ? { ...d, stage } : d)) ?? ds);
    setLiveStatus(`Moved “${deal.title}” to ${stageMeta[stage].label}`);
    setBusy(true);
    try {
      const res = await postApi("/api/deals", { action: "move", dealId, stage });
      if (!res.ok && res.error) {
        setDeals(prev ?? null);
        setNotice({ tone: "error", error: res.error });
      } else void load();
    } finally {
      setBusy(false);
    }
  }

  async function deactivate(customerId: string) {
    setBusy(true);
    try {
      const res = await postApi("/api/customers", { action: "deactivate", customerId });
      if (!res.ok && res.error) setNotice({ tone: "error", error: res.error });
      void load();
    } finally {
      setBusy(false);
    }
  }

  if (loadError && deals === null) {
    return (
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
    );
  }
  if (!deals || !customers) return <LoadingPage />;
  if (!__enabled) return <ModuleDisabled label="CRM" />;

  const activeCustomers = customers.filter((c) => !c.deactivatedAt);

  const openDeals = deals.filter((d) => d.stage !== "won" && d.stage !== "lost");
  const forecast = openDeals.reduce((s, d) => s + Math.round(d.valueMinor * weights[d.stage]), 0);
  const wonValue = deals.filter((d) => d.stage === "won").reduce((s, d) => s + d.valueMinor, 0);

  return (
    <div>
      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}
      <span aria-live="polite" className="sr-only" role="status">
        {liveStatus}
      </span>

      <AppFrame
        appId="crm"
        description="Your customer directory and deal lifecycle across six stages."
        persistKey="crm"
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "pipeline", label: "Pipeline", count: deals.length },
          { id: "customers", label: "Customers", count: activeCustomers.length },
          { id: "tasks", label: "Tasks" },
        ]}
        activeTab={tab}
        onTabChange={setTab}
      >
        {tab === "overview" && <OverviewTab deals={deals} customers={customers} />}
        {tab === "pipeline" && (
          <DealsTab
            deals={deals}
            customers={activeCustomers}
            busy={busy}
            newTitle={newTitle}
            newValue={newValue}
            newCustomerId={newCustomerId}
            onTitleChange={setNewTitle}
            onValueChange={setNewValue}
            onCustomerChange={setNewCustomerId}
            onCreate={(e) => void createDeal(e)}
            onMove={(id, stage) => void move(id, stage)}
            onNotice={setNotice}
            onReload={load}
          />
        )}
        {tab === "customers" && (
          <CustomersTab
            customers={customers}
            busy={busy}
            newName={newCustomerName}
            newEmail={newCustomerEmail}
            onNameChange={setNewCustomerName}
            onEmailChange={setNewCustomerEmail}
            onCreate={(e) => void createCustomer(e)}
            onDeactivate={(id) => void deactivate(id)}
            onTimeline={(customerId, name) => void openTimeline(customerId, name)}
          />
        )}
        {tab === "tasks" && <TasksTab notice={setNotice} />}
      </AppFrame>

      <Dialog
        open={timeline !== null}
        onClose={() => setTimeline(null)}
        title={timeline ? `History - ${timeline.name}` : "History"}
        description="Everything that happened with this customer, newest first."
        width="max-w-xl"
      >
        {timeline?.entries === undefined ? (
          <p className="py-4 text-sm text-stone-400">Loading…</p>
        ) : timeline.entries.length === 0 ? (
          <p className="py-4 text-sm text-stone-500">Nothing recorded yet - quotes, invoices, payments, deals and tasks will appear here.</p>
        ) : (
          <ul className="max-h-96 divide-y overflow-auto text-sm">
            {timeline.entries.map((e, i) => (
              <li key={i} className="flex items-center gap-3 py-2">
                <Badge tone={timelineKindTone[e.kind] ?? "neutral"}>{e.kind}</Badge>
                <span className="min-w-0 flex-1 truncate text-stone-700">{e.summary}</span>
                <span className="shrink-0 text-xs whitespace-nowrap text-stone-400">{formatDate(e.date)}</span>
              </li>
            ))}
          </ul>
        )}
      </Dialog>

      {/* KPIs stay reachable for screen readers regardless of tab */}
      <p className="sr-only">
        {openDeals.length} open deals, weighted forecast {formatMoneyWhole(forecast)}, won to date{" "}
        {formatMoneyWhole(wonValue)}.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------- overview --- */

function OverviewTab({ deals, customers }: { deals: Deal[]; customers: Customer[] }) {
  const open = deals.filter((d) => d.stage !== "won" && d.stage !== "lost");
  const openValue = open.reduce((s, d) => s + d.valueMinor, 0);
  const forecast = open.reduce((s, d) => s + Math.round(d.valueMinor * weights[d.stage]), 0);
  const won = deals.filter((d) => d.stage === "won");
  const wonValue = won.reduce((s, d) => s + d.valueMinor, 0);
  const active = customers.filter((c) => !c.deactivatedAt);
  const idleDays = 14;
  const idleCutoff = Date.now() - idleDays * 24 * 60 * 60 * 1000;
  const idle = open
    .filter((d) => new Date(d.updatedAt).getTime() < idleCutoff)
    .sort((a, b) => b.valueMinor - a.valueMinor)
    .slice(0, 3);
  const total = Math.max(1, deals.length);

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Open deals" value={open.length} />
        <StatCard label="Pipeline" value={formatMoneyWhole(openValue)} />
        <StatCard label="Weighted forecast" value={formatMoneyWhole(forecast)} tone="accent" />
        <StatCard label="Won to date" value={formatMoneyWhole(wonValue)} tone="success" />
        <StatCard label="Active customers" value={active.length} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <section aria-label="Stage distribution" className="rounded-xl border border-stone-200 bg-white p-5 shadow-xs">
          <p className="figure-label mb-3">Where the pipeline stands</p>
          <div className="flex h-2.5 overflow-hidden rounded-full bg-stone-100">
            {STAGES.map((s) => {
              const n = deals.filter((d) => d.stage === s).length;
              return (
                n > 0 && (
                  <div
                    key={s}
                    className={cn("h-full transition-[width] duration-500", stageMeta[s].bar)}
                    style={{ width: `${(n / total) * 100}%` }}
                    title={`${stageMeta[s].label}: ${n}`}
                  />
                )
              );
            })}
          </div>
          <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs text-stone-500 sm:grid-cols-3">
            {STAGES.map((s) => {
              const n = deals.filter((d) => d.stage === s).length;
              const v = deals.filter((d) => d.stage === s).reduce((sum, d) => sum + d.valueMinor, 0);
              return (
                <li key={s} className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5">
                    <span aria-hidden="true" className={cn("size-2 rounded-full", stageMeta[s].dot)} />
                    {stageMeta[s].label}
                  </span>
                  <span className="tnum">
                    {n} · {formatMoneyWhole(v)}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-label="Needs attention" className="rounded-xl border border-stone-200 bg-white p-5 shadow-xs">
          <p className="figure-label mb-3">Needs attention</p>
          {idle.length === 0 ? (
            <p className="text-sm leading-relaxed text-stone-500">
              Every open deal moved in the last {idleDays} days. The pipeline is warm.
            </p>
          ) : (
            <ol className="divide-y divide-stone-100">
              {idle.map((d) => (
                <li key={d.id} className="flex items-center gap-3 py-2.5 text-sm first:pt-0 last:pb-0">
                  <IconHistory aria-hidden="true" className="size-3.5 shrink-0 text-amber-500" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-stone-800">{d.title}</span>
                    <span className="text-xs text-stone-400">
                      {d.customerName ? `${d.customerName} · ` : ""}idle since {timeAgo(d.updatedAt)}
                    </span>
                  </span>
                  <span className="tnum shrink-0 text-xs font-medium text-stone-600">
                    {formatMoneyWhole(d.valueMinor)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {won.length > 0 && (
        <p className="mt-4 text-xs text-stone-400">
          <Badge tone="green">tip</Badge> Won deals post nothing by themselves - invoice them from the Console when
          you&apos;re ready.
        </p>
      )}
    </div>
  );
}

// __DEALS_TAB__
function DealsTab(props: {
  deals: Deal[];
  customers: Customer[];
  busy: boolean;
  newTitle: string;
  newValue: string;
  newCustomerId: string;
  onTitleChange: (v: string) => void;
  onValueChange: (v: string) => void;
  onCustomerChange: (v: string) => void;
  onCreate: (e: React.FormEvent) => void;
  onMove: (dealId: string, stage: Stage) => void;
  onNotice: (n: ActionNoticeState) => void;
  onReload: () => Promise<void> | void;
}) {
  const { deals, busy } = props;
  const openDeals = deals.filter((d) => d.stage !== "won" && d.stage !== "lost");
  const openValue = openDeals.reduce((s, d) => s + d.valueMinor, 0);
  const forecast = openDeals.reduce((s, d) => s + Math.round(d.valueMinor * weights[d.stage]), 0);
  const wonValue = deals.filter((d) => d.stage === "won").reduce((s, d) => s + d.valueMinor, 0);

  // Drag state lives at board level: one dragged card, one hovered column.
  const [dragging, setDragging] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<Stage | null>(null);

  // Convert lead
  const [convertTarget, setConvertTarget] = useState<Deal | null>(null);
  const [convertMode, setConvertMode] = useState<"new" | "existing">("new");
  const [convertCustomerId, setConvertCustomerId] = useState("");
  const [convertCustomerName, setConvertCustomerName] = useState("");
  const [converting, setConverting] = useState(false);

  async function convert(): Promise<void> {
    if (!convertTarget) return;
    if (convertMode === "existing" && !convertCustomerId) return;
    if (convertMode === "new" && !convertCustomerName.trim()) return;
    setConverting(true);
    try {
      const res = await postApi("/api/crm", {
        action: "convertLead",
        dealId: convertTarget.id,
        ...(convertMode === "existing"
          ? { customerId: convertCustomerId }
          : { createCustomer: true, customerName: convertCustomerName.trim() }),
      });
      if (res.status === 202) props.onNotice({ tone: "pending", text: "Converting the lead needs approval." });
      else if (!res.ok && res.error) props.onNotice({ tone: "error", error: res.error });
      else {
        props.onNotice({ tone: "success", text: `“${convertTarget.title}” is now qualified.` });
        setConvertTarget(null);
        setConvertCustomerId("");
        setConvertCustomerName("");
        await props.onReload();
      }
    } finally {
      setConverting(false);
    }
  }

  function onDrop(stage: Stage) {
    if (dragging) props.onMove(dragging, stage);
    setDragging(null);
    setOverStage(null);
  }

  return (
    <div>
      <form onSubmit={props.onCreate} className="mb-6 flex flex-wrap items-center gap-2">
        <input
          value={props.newTitle}
          onChange={(e) => props.onTitleChange(e.target.value)}
          placeholder="New deal…"
          aria-label="New deal name"
          className="input h-9 w-40 sm:w-48"
        />
        <input
          value={props.newValue}
          onChange={(e) => props.onValueChange(e.target.value)}
          placeholder="$ value"
          aria-label="New deal value in dollars"
          inputMode="decimal"
          className="input h-9 w-24"
        />
        <select
          value={props.newCustomerId}
          onChange={(e) => props.onCustomerChange(e.target.value)}
          aria-label="Link a customer"
          className="input h-9 w-44"
        >
          <option value="">No customer linked</option>
          {props.customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <Button type="submit" loading={busy} disabled={!props.newTitle.trim()}>
          Add deal
        </Button>
      </form>

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
          hint="Add your first deal above, or ask your workmate to create one from a conversation."
        />
      ) : (
        <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-3 sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10">
          {STAGES.map((stage) => {
            const column = deals.filter((d) => d.stage === stage);
            const isOver = overStage === stage;
            return (
              <section
                key={stage}
                aria-label={`${stageMeta[stage].label} stage`}
                aria-dropeffect={dragging ? "move" : undefined}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOverStage(stage);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverStage((s) => (s === stage ? null : s));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  onDrop(stage);
                }}
                className={cn(
                  "flex w-64 shrink-0 snap-start flex-col rounded-xl border p-2.5 transition-colors duration-100",
                  isOver && dragging
                    ? "border-gold-400 bg-gold-50/50"
                    : "border-stone-200 bg-stone-50/70",
                )}
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
                    <article
                      key={deal.id}
                      draggable
                      onDragStart={() => setDragging(deal.id)}
                      onDragEnd={() => {
                        setDragging(null);
                        setOverStage(null);
                      }}
                      className={cn(
                        "cursor-grab rounded-lg border border-stone-200 bg-white p-3 shadow-xs transition-shadow duration-150 hover:shadow-sm active:cursor-grabbing",
                        dragging === deal.id && "opacity-40",
                      )}
                    >
                      <p className="text-sm leading-snug font-medium text-stone-800">{deal.title}</p>
                      {deal.customerName && (
                        <p className="mt-0.5 truncate text-[11px] text-stone-400">{deal.customerName}</p>
                      )}
                      {deal.valueMinor > 0 && (
                        <p className="tnum mt-1 text-xs font-medium text-stone-500">{formatMoneyWhole(deal.valueMinor)}</p>
                      )}
                      {stage !== "won" && stage !== "lost" && (
                        <div className="mt-2.5 flex items-center justify-between gap-1 border-t border-stone-100 pt-2">
                          <button
                            type="button"
                            onClick={() => props.onMove(deal.id, STAGES[Math.min(STAGES.indexOf(stage) + 1, STAGES.length - 2)]!)}
                            disabled={busy}
                            aria-label={`Move “${deal.title}” forward`}
                            title="Advance stage"
                            className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-stone-500 transition-colors duration-150 hover:bg-emerald-50 hover:text-emerald-700 disabled:pointer-events-none disabled:opacity-40"
                          >
                            Advance <IconArrowRight className="size-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => props.onMove(deal.id, "lost")}
                            disabled={busy}
                            aria-label={`Mark “${deal.title}” as lost`}
                            title="Mark lost"
                            className="icon-btn size-6 hover:bg-red-50 hover:text-red-700"
                          >
                            <IconX className="size-3.5" />
                          </button>
                        </div>
                      )}
                      {stage === "lead" && (
                        <div className="mt-2 border-t border-stone-100 pt-2">
                          <button
                            type="button"
                            onClick={() => {
                              setConvertTarget(deal);
                              setConvertMode(deal.customerId ? "existing" : "new");
                              setConvertCustomerId(deal.customerId ?? "");
                              setConvertCustomerName("");
                            }}
                            disabled={busy}
                            className="inline-flex w-full cursor-pointer items-center justify-center gap-1 rounded-md bg-stone-50 px-2 py-1 text-[11px] font-medium text-stone-600 transition-colors duration-150 hover:bg-emerald-50 hover:text-emerald-700 disabled:pointer-events-none disabled:opacity-40"
                          >
                            <IconArrowRight className="size-3" /> Convert lead
                          </button>
                        </div>
                      )}
                      {(stage === "lost" || stage === "won") && (
                        <div className="mt-2.5 border-t border-stone-100 pt-2">
                          <button
                            type="button"
                            onClick={() => props.onMove(deal.id, "lead")}
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
                    <p
                      className={cn(
                        "rounded-lg border border-dashed py-4 text-center text-xs transition-colors duration-100",
                        isOver && dragging ? "border-gold-300 text-gold-400" : "border-stone-200 text-stone-300",
                      )}
                    >
                      {isOver && dragging ? "Drop to move here" : "-"}
                    </p>
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

      <p className="mt-2 text-xs text-stone-400">
        Drag a card to any stage - every move is recorded in the ledger and reversible. Keyboard: use Advance, Mark
        lost, or Reopen on each card.
      </p>

      <Dialog
        open={convertTarget !== null}
        onClose={() => setConvertTarget(null)}
        title={`Convert “${convertTarget?.title ?? ""}”`}
        description="Promotes the deal to qualified and attaches the customer it belongs to - creating one on the fly when asked."
        footer={
          <>
            <Button tone="secondary" onClick={() => setConvertTarget(null)} disabled={converting}>
              Cancel
            </Button>
            <Button
              onClick={() => void convert()}
              loading={converting}
              disabled={convertMode === "existing" ? !convertCustomerId : !convertCustomerName.trim()}
            >
              Convert
            </Button>
          </>
        }
      >
        <div className="mb-3 flex gap-2 text-sm">
          <Button tone={convertMode === "new" ? "primary" : "secondary"} size="sm" onClick={() => setConvertMode("new")}>
            New customer
          </Button>
          <Button tone={convertMode === "existing" ? "primary" : "secondary"} size="sm" onClick={() => setConvertMode("existing")}>
            Existing
          </Button>
        </div>
        {convertMode === "new" ? (
          <input
            className="input"
            placeholder={`Customer name (defaults to “${convertTarget?.title ?? ""}”)`}
            aria-label="New customer name"
            value={convertCustomerName}
            onChange={(e) => setConvertCustomerName(e.target.value)}
          />
        ) : (
          <select
            className="input"
            aria-label="Attach to existing customer"
            value={convertCustomerId}
            onChange={(e) => setConvertCustomerId(e.target.value)}
          >
            <option value="">Choose customer…</option>
            {props.customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
      </Dialog>
    </div>
  );
}

function CustomersTab(props: {
  customers: Customer[];
  busy: boolean;
  newName: string;
  newEmail: string;
  onNameChange: (v: string) => void;
  onEmailChange: (v: string) => void;
  onCreate: (e: React.FormEvent) => void;
  onDeactivate: (customerId: string) => void;
  onTimeline: (customerId: string, name: string) => void;
}) {
  const active = props.customers.filter((c) => !c.deactivatedAt);
  const deactivated = props.customers.filter((c) => c.deactivatedAt);

  return (
    <div>
      <form onSubmit={props.onCreate} className="mb-6 flex flex-wrap items-center gap-2">
        <input
          value={props.newName}
          onChange={(e) => props.onNameChange(e.target.value)}
          placeholder="Customer name…"
          aria-label="New customer name"
          className="input h-9 w-44 sm:w-56"
        />
        <input
          value={props.newEmail}
          onChange={(e) => props.onEmailChange(e.target.value)}
          placeholder="email (optional)"
          aria-label="New customer email"
          type="email"
          className="input h-9 w-52"
        />
        <Button type="submit" loading={props.busy} disabled={!props.newName.trim()}>
          Add customer
        </Button>
      </form>

      {active.length === 0 && deactivated.length === 0 ? (
        <EmptyState
          icon={<IconUser />}
          title="No customers yet"
          hint="Add your first customer above, or ask your workmate in chat; invoices need a customer record."
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-stone-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50/80 text-left text-xs tracking-wide text-stone-500 uppercase">
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Email</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {[...active, ...deactivated].map((c) => (
                <tr key={c.id} className="border-b border-stone-100 last:border-0">
                  <td className="px-4 py-2.5 font-medium text-stone-800">{c.name}</td>
                  <td className="px-4 py-2.5 text-stone-500">{c.email ?? "-"}</td>
                  <td className="px-4 py-2.5">
                    {c.deactivatedAt ? <Badge tone="neutral">Inactive</Badge> : <Badge tone="green">Active</Badge>}
                  </td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => props.onTimeline(c.id, c.name)}
                      disabled={props.busy}
                      className="mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-stone-400 transition-colors duration-150 hover:bg-stone-100 hover:text-stone-700 disabled:pointer-events-none disabled:opacity-40"
                    >
                      <IconHistory className="size-3" /> Timeline
                    </button>
                    {!c.deactivatedAt && (
                      <button
                        type="button"
                        onClick={() => props.onDeactivate(c.id)}
                        disabled={props.busy}
                        className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-stone-400 transition-colors duration-150 hover:bg-red-50 hover:text-red-700 disabled:pointer-events-none disabled:opacity-40"
                      >
                        <IconX className="size-3" /> Deactivate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-stone-400">
        Deactivating hides a customer from pickers and the agent&apos;s lookups; their invoices and history stay intact.
      </p>
    </div>
  );
}
