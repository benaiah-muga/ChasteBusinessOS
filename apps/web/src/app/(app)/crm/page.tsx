"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ActionNotice,
  type ActionNoticeState,
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  LoadingPage,
  StatCard,
} from "@/components/ui";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconFileText,
  IconHistory,
  IconSearch,
  IconTrendingUp,
  IconUndo,
  IconUser,
  IconX,
} from "@/components/icons";
import { cn, formatMoney, formatMoneyWhole, timeAgo, toMinor } from "@/lib/format";
import { useMoneySync } from "@/lib/money";
import { QuickCreateButton } from "../quick-create";
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
  ownerUserId: string | null;
  ownerName: string | null;
  tags: string[];
  notes: string | null;
  lastActivityAt: string;
  deactivatedAt: string | null;
}

interface TeamMember {
  userId: string;
  name: string | null;
  email: string;
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
  error?: string;
}

// __MAIN__
export default function CrmPage() {
  useMoneySync();
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
  const [profileCustomerId, setProfileCustomerId] = useState<string | null>(null);
  const [profileTab, setProfileTab] = useState<"overview" | "activity" | "invoices" | "documents">("overview");
  const [teamMembers, setTeamMembers] = useState<TeamMember[] | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<Customer | null>(null);

  async function openTimeline(customerId: string, name: string): Promise<void> {
    setTimeline({ customerId, name });
    const res = await callApi<{ entries?: TimelineEntry[] }>(`/api/crm?timeline=${encodeURIComponent(customerId)}`);
    setTimeline(
      res.ok && res.data
        ? { customerId, name, entries: res.data.entries ?? [] }
        : { customerId, name, error: res.error?.title ?? "Couldn't load customer history" },
    );
  }

  const load = useCallback(async () => {
    setLoadError(null);
    const [dealsRes, customersRes] = await Promise.all([
      callApi<{ deals?: Deal[] }>("/api/deals"),
      callApi<{ customers?: Customer[] }>("/api/customers"),
    ]);
    if (!dealsRes.ok) {
      setLoadError(dealsRes.error?.title ?? "Couldn't load your pipeline");
      setDeals(null);
    } else {
      setDeals(dealsRes.data?.deals ?? []);
    }
    if (!customersRes.ok) {
      setLoadError(customersRes.error?.title ?? "Couldn't load customers");
      setCustomers(null);
    } else {
      setCustomers(customersRes.data?.customers ?? []);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (tab !== "customers" || teamMembers !== null) return;
    void callApi<{ members?: TeamMember[] }>("/api/team").then((res) => {
      if (!res.ok) {
        setTeamError(res.error?.title ?? "Team members couldn't load");
        setTeamMembers([]);
      } else {
        setTeamError(null);
        setTeamMembers(res.data?.members ?? []);
      }
    });
  }, [tab, teamMembers]);

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
      if (res.status === 202) {
        setNotice({ tone: "pending", text: "Creating this deal is waiting for approval." });
      } else if (!res.ok && res.error) {
        setNotice({ tone: "error", error: res.error });
      } else {
        setNewTitle("");
        setNewValue("");
        setNewCustomerId("");
        setNotice({ tone: "success", text: "Deal added to the pipeline." });
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function createCustomer(e: React.FormEvent) {
    e.preventDefault();
    if (!newCustomerName.trim()) return;
    setBusy(true);
    try {
      const res = await postApi<{ data?: { duplicateWarning?: string | null } }>("/api/customers", {
        action: "create",
        name: newCustomerName.trim(),
        ...(newCustomerEmail.trim() ? { email: newCustomerEmail.trim() } : {}),
      });
      if (res.status === 202) {
        setNotice({ tone: "pending", text: "Creating this customer is waiting for approval." });
      } else if (!res.ok && res.error) {
        setNotice({ tone: "error", error: res.error });
      } else {
        setNewCustomerName("");
        setNewCustomerEmail("");
        setNotice(res.data?.data?.duplicateWarning
          ? { tone: "pending", text: `Customer added. ${res.data.data.duplicateWarning}` }
          : { tone: "success", text: "Customer added." });
        await load();
      }
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
      if (res.status === 202) {
        setDeals(prev ?? null);
        setNotice({ tone: "pending", text: "That stage change is waiting for approval." });
      } else if (!res.ok && res.error) {
        setDeals(prev ?? null);
        setNotice({ tone: "error", error: res.error });
      } else {
        setNotice({ tone: "success", text: `“${deal.title}” moved to ${stageMeta[stage].label}.` });
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function deactivate(customerId: string) {
    setBusy(true);
    try {
      const res = await postApi("/api/customers", { action: "deactivate", customerId });
      if (res.status === 202) {
        setNotice({ tone: "pending", text: "Deactivation is waiting for approval." });
      } else if (!res.ok && res.error) {
        setNotice({ tone: "error", error: res.error });
      } else {
        setNotice({ tone: "success", text: "Customer deactivated. Their invoices and history are unchanged." });
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function updateCustomerProfiles(input: {
    customerIds: string[];
    ownerUserId?: string | null;
    addTags?: string[];
    removeTags?: string[];
    notes?: string | null;
  }): Promise<boolean> {
    setBusy(true);
    try {
      const res = await postApi<{ data?: { updatedCount: number } }>("/api/customers", { action: "updateProfile", ...input });
      if (res.status === 202) {
        setNotice({ tone: "pending", text: "Profile changes are waiting for approval. The customer records have not changed yet." });
        return false;
      }
      if (!res.ok) {
        setNotice({ tone: "error", error: res.error! });
        return false;
      }
      setNotice({ tone: "success", text: `Updated ${res.data?.data?.updatedCount ?? input.customerIds.length} customer profile${input.customerIds.length === 1 ? "" : "s"}.` });
      await load();
      if (profileCustomerId) {
        const customer = customers?.find((entry) => entry.id === profileCustomerId);
        if (customer) await openTimeline(customer.id, customer.name);
      }
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function createCustomerTask(input: { customerId: string; title: string; dueAt?: string; note?: string }): Promise<boolean> {
    setBusy(true);
    try {
      const res = await postApi("/api/crm", {
        action: "createTask",
        title: input.title,
        ...(input.dueAt ? { dueAt: input.dueAt } : {}),
        refType: "customer",
        refId: input.customerId,
        ...(input.note ? { note: input.note } : {}),
      });
      if (res.status === 202) {
        setNotice({ tone: "pending", text: "This follow-up task is waiting for approval." });
        return false;
      }
      if (!res.ok) {
        setNotice({ tone: "error", error: res.error! });
        return false;
      }
      setNotice({ tone: "success", text: "Follow-up task added to the CRM." });
      await load();
      await openTimeline(input.customerId, customers?.find((customer) => customer.id === input.customerId)?.name ?? "Customer");
      setProfileTab("activity");
      return true;
    } finally {
      setBusy(false);
    }
  }

  function openCustomerProfile(customerId: string, name: string, initialTab: typeof profileTab = "overview") {
    setProfileCustomerId(customerId);
    setProfileTab(initialTab);
    void openTimeline(customerId, name);
  }

  if (loadError) {
    return (
      <EmptyState
        icon={<IconAlertTriangle />}
        title={loadError}
        hint="Your records are still on file. Check your connection, then retry."
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
        {tab === "overview" && (
          <OverviewTab
            deals={deals}
            customers={customers}
            onOpenPipeline={() => setTab("pipeline")}
            onOpenCustomers={() => setTab("customers")}
          />
        )}
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
            onDataChanged={load}
          />
        )}
        {tab === "customers" && (
          <CustomersTab
            customers={customers}
            deals={deals}
            teamMembers={teamMembers}
            teamError={teamError}
            busy={busy}
            newName={newCustomerName}
            newEmail={newCustomerEmail}
            onNameChange={setNewCustomerName}
            onEmailChange={setNewCustomerEmail}
            onCreate={(e) => void createCustomer(e)}
            onDeactivate={(customer) => setDeactivateTarget(customer)}
            onRetryTeam={() => { setTeamMembers(null); setTeamError(null); }}
            onOpenProfile={(customerId, name) => openCustomerProfile(customerId, name)}
            onUpdateProfile={updateCustomerProfiles}
            onCreateTask={createCustomerTask}
          />
        )}
        {tab === "tasks" && <TasksTab notice={setNotice} />}
      </AppFrame>

      <Customer360Dialog
        key={profileCustomerId ?? "no-customer"}
        customer={customers.find((customer) => customer.id === profileCustomerId) ?? null}
        deals={deals}
        members={teamMembers ?? []}
        busy={busy}
        timeline={timeline}
        activeTab={profileTab}
        onTabChange={setProfileTab}
        onClose={() => { setProfileCustomerId(null); setTimeline(null); }}
        onRetryActivity={() => {
          if (profileCustomerId) {
            const customer = customers.find((entry) => entry.id === profileCustomerId);
            if (customer) void openTimeline(customer.id, customer.name);
          }
        }}
        onUpdateProfile={updateCustomerProfiles}
        onCreateTask={createCustomerTask}
      />

      <ConfirmDialog
        open={deactivateTarget !== null}
        onClose={() => setDeactivateTarget(null)}
        onConfirm={async () => {
          if (deactivateTarget) await deactivate(deactivateTarget.id);
          setDeactivateTarget(null);
        }}
        title={`Deactivate ${deactivateTarget?.name ?? "customer"}?`}
        body="This removes the customer from active pickers and agent lookups. Existing invoices and history stay available."
        confirmLabel="Deactivate customer"
        busy={busy}
      />

      {/* KPIs stay reachable for screen readers regardless of tab */}
      <p className="sr-only">
        {openDeals.length} open deals, weighted forecast {formatMoneyWhole(forecast)}, won total{" "}
        {formatMoneyWhole(wonValue)}.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------- overview --- */

function OverviewTab({
  deals,
  customers,
  onOpenPipeline,
  onOpenCustomers,
}: {
  deals: Deal[];
  customers: Customer[];
  onOpenPipeline: () => void;
  onOpenCustomers: () => void;
}) {
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
      {deals.length === 0 && active.length === 0 && (
        <div className="mb-5 rounded-xl border border-gold-200 bg-gold-50/60 p-5 sm:flex sm:items-center sm:justify-between sm:gap-6">
          <div>
            <p className="text-sm font-semibold text-stone-900">Start with a customer or a deal</p>
            <p className="mt-1 max-w-xl text-sm leading-relaxed text-stone-600">
              Add a customer first, or capture a lead now and connect it to a customer later.
            </p>
          </div>
          <div className="mt-4 flex shrink-0 gap-2 sm:mt-0">
            <Button onClick={onOpenCustomers}>Add a customer</Button>
            <Button tone="secondary" onClick={onOpenPipeline}>Add a deal</Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Open deals" value={open.length} />
        <StatCard label="Open pipeline" value={formatMoneyWhole(openValue)} />
        <StatCard label="Weighted forecast" value={formatMoneyWhole(forecast)} tone="accent" />
        <StatCard label="Won total" value={formatMoneyWhole(wonValue)} tone="success" />
        <StatCard label="Active customers" value={active.length} />
      </div>
      <p className="mt-2 text-xs text-stone-400">
        Forecast uses stage estimates: Lead 10%, Qualified 30%, Proposal 50%, Negotiation 70%, Won 100%, Lost 0%.
      </p>

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
              {open.length === 0
                ? "No open deals yet. Add a deal to start tracking follow-ups here."
                : `No open deals have been idle for ${idleDays} days or more.`}
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
  onDataChanged?: () => void;
}) {
  const { deals, busy } = props;
  const openDeals = deals.filter((d) => d.stage !== "won" && d.stage !== "lost");
  const openValue = openDeals.reduce((s, d) => s + d.valueMinor, 0);
  const forecast = openDeals.reduce((s, d) => s + Math.round(d.valueMinor * weights[d.stage]), 0);
  const wonValue = deals.filter((d) => d.stage === "won").reduce((s, d) => s + d.valueMinor, 0);
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const visibleDeals = query
    ? deals.filter((d) => `${d.title} ${d.customerName ?? ""} ${d.note ?? ""}`.toLowerCase().includes(query))
    : deals;

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
          className="input h-9 w-full sm:w-48"
        />
        <input
          value={props.newValue}
          onChange={(e) => props.onValueChange(e.target.value)}
          placeholder={formatMoney(0)}
          aria-label="New deal value in the workspace currency"
          inputMode="decimal"
          className="input h-9 w-full sm:w-32"
        />
        <select
          value={props.newCustomerId}
          onChange={(e) => props.onCustomerChange(e.target.value)}
          aria-label="Link a customer"
          className="input h-9 w-full sm:w-44"
        >
          <option value="">No customer linked</option>
          {props.customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <Button type="submit" className="w-full sm:w-auto" loading={busy} disabled={!props.newTitle.trim()}>
          Add deal
        </Button>
      </form>

      <label className="relative mb-4 block max-w-md">
        <IconSearch aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Find a deal, customer, or note"
          aria-label="Search deals, customers, and notes"
          className="input pl-9"
        />
      </label>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Open deals" value={openDeals.length} />
        <StatCard label="Open pipeline" value={formatMoneyWhole(openValue)} />
        <StatCard label="Weighted forecast" value={formatMoneyWhole(forecast)} tone="accent" />
        <StatCard label="Won total" value={formatMoneyWhole(wonValue)} tone="success" />
      </div>
      <p className="-mt-4 mb-5 text-xs text-stone-400">
        Forecast uses stage estimates: Lead 10%, Qualified 30%, Proposal 50%, Negotiation 70%, Won 100%, Lost 0%.
      </p>

      {visibleDeals.length === 0 ? (
        <EmptyState
          icon={<IconTrendingUp />}
          title={deals.length === 0 ? "No deals yet" : "No deals match that search"}
          hint={deals.length === 0 ? "Add your first deal above, or ask your workmate to create one from a conversation." : "Try a different deal, customer, or note."}
          action={deals.length > 0 ? <Button tone="secondary" size="sm" onClick={() => setSearch("")}>Clear search</Button> : undefined}
        />
      ) : (
        <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-3 sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10">
          {STAGES.map((stage) => {
            const column = visibleDeals.filter((d) => d.stage === stage);
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
                      {deal.note && <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-stone-500">{deal.note}</p>}
                      <p className="mt-1.5 text-[11px] text-stone-400">Updated {timeAgo(deal.updatedAt)}</p>
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
                      {isOver && dragging ? "Drop to move here" : "No deals yet"}
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
          <div className="flex items-center gap-2">
            <select
              className="select"
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
            <QuickCreateButton
              entity="customer"
              onCreated={(r) => {
                props.onDataChanged?.();
                setConvertCustomerId(r.id);
              }}
            />
          </div>
        )}
      </Dialog>
    </div>
  );
}

interface CustomerFilter {
  status: "active" | "inactive" | "all";
  owner: string;
  staleOnly: boolean;
  duplicateOnly: boolean;
  tag: string;
}

interface SavedCustomerView {
  name: string;
  filter: CustomerFilter;
}

function CustomersTab(props: {
  customers: Customer[];
  deals: Deal[];
  teamMembers: TeamMember[] | null;
  teamError: string | null;
  busy: boolean;
  newName: string;
  newEmail: string;
  onNameChange: (v: string) => void;
  onEmailChange: (v: string) => void;
  onCreate: (e: React.FormEvent) => void;
  onDeactivate: (customer: Customer) => void;
  onRetryTeam: () => void;
  onOpenProfile: (customerId: string, name: string) => void;
  onUpdateProfile: (input: { customerIds: string[]; ownerUserId?: string | null; addTags?: string[] }) => Promise<boolean>;
  onCreateTask: (input: { customerId: string; title: string; dueAt?: string; note?: string }) => Promise<boolean>;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<CustomerFilter>({ status: "active", owner: "all", staleOnly: false, duplicateOnly: false, tag: "" });
  const [savedViews, setSavedViews] = useState<SavedCustomerView[]>([]);
  const [saveName, setSaveName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkOwner, setBulkOwner] = useState("unchanged");
  const [bulkTag, setBulkTag] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem("chaste.crm.customer-views.v1");
      if (stored) {
        const parsed: unknown = JSON.parse(stored);
        if (Array.isArray(parsed)) setSavedViews(parsed as SavedCustomerView[]);
      }
    } catch {
      setSavedViews([]);
    }
  }, []);

  const active = props.customers.filter((customer) => !customer.deactivatedAt);
  const inactive = props.customers.filter((customer) => customer.deactivatedAt);
  const emailGroups = new Map<string, string[]>();
  const nameGroups = new Map<string, string[]>();
  for (const customer of active) {
    const email = customer.email?.trim().toLowerCase();
    const name = customer.name.trim().toLowerCase();
    if (email) emailGroups.set(email, [...(emailGroups.get(email) ?? []), customer.id]);
    if (name && name !== "walk-in customer") nameGroups.set(name, [...(nameGroups.get(name) ?? []), customer.id]);
  }
  const duplicateIds = new Set([...emailGroups.values(), ...nameGroups.values()].filter((group) => group.length > 1).flat());
  const query = search.trim().toLowerCase();
  const visible = props.customers.filter((customer) => {
    const matchesStatus = filter.status === "all" || (filter.status === "active" ? !customer.deactivatedAt : Boolean(customer.deactivatedAt));
    const haystack = `${customer.name} ${customer.email ?? ""} ${customer.tags.join(" ")}`.toLowerCase();
    const matchesSearch = !query || haystack.includes(query);
    const matchesOwner = filter.owner === "all" || (filter.owner === "unassigned" ? !customer.ownerUserId : customer.ownerUserId === filter.owner);
    const stale = !customer.deactivatedAt && Date.now() - new Date(customer.lastActivityAt).getTime() >= 30 * 86400000;
    const matchesTag = !filter.tag || customer.tags.some((tag) => tag.toLowerCase() === filter.tag.toLowerCase());
    return matchesStatus && matchesSearch && matchesOwner && (!filter.staleOnly || stale) && (!filter.duplicateOnly || duplicateIds.has(customer.id)) && matchesTag;
  });
  const staleCount = active.filter((customer) => Date.now() - new Date(customer.lastActivityAt).getTime() >= 30 * 86400000).length;

  function saveView() {
    const name = saveName.trim();
    if (!name) return;
    const next = [...savedViews.filter((view) => view.name.toLowerCase() !== name.toLowerCase()), { name, filter: { ...filter } }];
    setSavedViews(next);
    localStorage.setItem("chaste.crm.customer-views.v1", JSON.stringify(next));
    setSaveName("");
  }

  function exportSelected() {
    const rows = props.customers.filter((customer) => selected.includes(customer.id));
    const csvCell = (raw: string) => {
      const value = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
      return `"${value.replaceAll('"', '""')}"`;
    };
    const csv = ["Name,Email,Owner,Tags,Status", ...rows.map((customer) => [customer.name, customer.email ?? "", customer.ownerName ?? "", customer.tags.join("; "), customer.deactivatedAt ? "Inactive" : "Active"].map(csvCell).join(","))].join("\n");
    const href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = "customers.csv";
    anchor.click();
    URL.revokeObjectURL(href);
  }

  async function applyBulk() {
    const ids = selected;
    const tag = bulkTag.trim();
    if (!ids.length || (bulkOwner === "unchanged" && !tag)) return;
    setBulkBusy(true);
    const ok = await props.onUpdateProfile({
      customerIds: ids,
      ...(bulkOwner !== "unchanged" ? { ownerUserId: bulkOwner === "unassigned" ? null : bulkOwner } : {}),
      ...(tag ? { addTags: [tag] } : {}),
    });
    if (ok) {
      setSelected([]);
      setBulkOwner("unchanged");
      setBulkTag("");
    }
    setBulkBusy(false);
  }

  const allVisibleSelected = visible.length > 0 && visible.every((customer) => selected.includes(customer.id));
  const filterButtonClass = "min-h-9 rounded-md border border-stone-200 bg-white px-3 text-xs font-medium text-stone-600 hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-gold-600";

  return (
    <div>
      <form onSubmit={props.onCreate} className="mb-6 flex flex-wrap items-center gap-2">
        <input value={props.newName} onChange={(event) => props.onNameChange(event.target.value)} placeholder="Customer name" aria-label="New customer name" className="input h-9 w-full sm:w-56" />
        <input value={props.newEmail} onChange={(event) => props.onEmailChange(event.target.value)} placeholder="Email (optional)" aria-label="New customer email" type="email" className="input h-9 w-full sm:w-52" />
        <Button type="submit" className="w-full sm:w-auto" loading={props.busy} disabled={!props.newName.trim()}>Add customer</Button>
      </form>

      <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <label className="relative block w-full lg:max-w-md">
          <IconSearch aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, email, or tag" aria-label="Search customers by name, email, or tag" className="input pl-9" />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <select className={filterButtonClass} aria-label="Customer status" value={filter.status} onChange={(event) => setFilter((current) => ({ ...current, status: event.target.value as CustomerFilter["status"] }))}>
            <option value="active">Active ({active.length})</option><option value="inactive">Inactive ({inactive.length})</option><option value="all">All ({props.customers.length})</option>
          </select>
          <select className={filterButtonClass} aria-label="Filter by owner" value={filter.owner} onChange={(event) => setFilter((current) => ({ ...current, owner: event.target.value }))}>
            <option value="all">Any owner</option><option value="unassigned">Unassigned</option>{(props.teamMembers ?? []).map((member) => <option key={member.userId} value={member.userId}>{member.name || member.email}</option>)}
          </select>
          <button type="button" className={cn(filterButtonClass, filter.staleOnly && "border-amber-300 bg-amber-50 text-amber-900")} aria-pressed={filter.staleOnly} onClick={() => setFilter((current) => ({ ...current, staleOnly: !current.staleOnly }))}>No activity 30d · {staleCount}</button>
          <button type="button" className={cn(filterButtonClass, filter.duplicateOnly && "border-amber-300 bg-amber-50 text-amber-900")} aria-pressed={filter.duplicateOnly} onClick={() => setFilter((current) => ({ ...current, duplicateOnly: !current.duplicateOnly }))}>Possible duplicates · {duplicateIds.size}</button>
          <input className="input h-9 w-32" value={filter.tag} onChange={(event) => setFilter((current) => ({ ...current, tag: event.target.value }))} placeholder="Filter by tag" aria-label="Filter by exact tag" />
        </div>
      </div>

      <div className="mb-4 flex flex-col gap-2 rounded-lg border border-stone-200 bg-stone-50/70 p-3 sm:flex-row sm:items-center">
        <div className="flex flex-wrap items-center gap-2">
          <select className="select h-9 min-w-40" aria-label="Saved customer view" value="" onChange={(event) => { const found = savedViews.find((view) => view.name === event.target.value); if (found) setFilter(found.filter); }}>
            <option value="">Saved views on this device</option>{savedViews.map((view) => <option key={view.name} value={view.name}>{view.name}</option>)}
          </select>
          <input className="input h-9 w-40" value={saveName} onChange={(event) => setSaveName(event.target.value)} placeholder="Name this view" aria-label="Saved view name" />
          <Button tone="secondary" size="sm" disabled={!saveName.trim()} onClick={saveView}>Save view</Button>
          {props.teamError && <button type="button" className="text-xs text-amber-800 underline" onClick={props.onRetryTeam}>Owner list unavailable. Retry</button>}
        </div>
        <span className="text-xs text-stone-500 sm:ml-auto">Views are saved in this browser. {visible.length} shown.</span>
      </div>

      {selected.length > 0 && (
        <div className="mb-3 flex flex-col gap-2 rounded-lg border border-gold-200 bg-gold-50/70 p-3 sm:flex-row sm:items-center" aria-live="polite">
          <span className="text-sm font-medium text-stone-800">{selected.length} selected</span>
          <select className="select h-9 sm:w-48" aria-label="Bulk assign owner" value={bulkOwner} onChange={(event) => setBulkOwner(event.target.value)}>
            <option value="unchanged">Keep current owner</option><option value="unassigned">Unassign</option>{(props.teamMembers ?? []).map((member) => <option key={member.userId} value={member.userId}>Assign to {member.name || member.email}</option>)}
          </select>
          <input className="input h-9 sm:w-40" value={bulkTag} onChange={(event) => setBulkTag(event.target.value)} placeholder="Add a tag" aria-label="Tag selected customers" />
          <Button size="sm" loading={bulkBusy} disabled={bulkOwner === "unchanged" && !bulkTag.trim()} onClick={() => void applyBulk()}>Apply changes</Button>
          <Button tone="secondary" size="sm" onClick={exportSelected}>Export CSV</Button>
          <Button tone="ghost" size="sm" onClick={() => setSelected([])}>Clear selection</Button>
        </div>
      )}

      {props.customers.length === 0 ? (
        <EmptyState icon={<IconUser />} title="No customers yet" hint="Add a customer here, or create one while recording a sale or invoice." />
      ) : visible.length === 0 ? (
        <EmptyState icon={<IconSearch />} title="No customers match these filters" hint="Clear a filter or try another search." action={<Button tone="secondary" size="sm" onClick={() => { setSearch(""); setFilter({ status: "active", owner: "all", staleOnly: false, duplicateOnly: false, tag: "" }); }}>Clear filters</Button>} />
      ) : (
        <>
          <ul className="space-y-2 sm:hidden" aria-label="Customers">
            {visible.map((customer) => (
              <li key={customer.id} className="rounded-xl border border-stone-200 bg-white p-3 shadow-xs">
                <div className="flex items-start gap-3">
                  <input type="checkbox" aria-label={`Select ${customer.name}`} checked={selected.includes(customer.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, customer.id] : current.filter((id) => id !== customer.id))} className="mt-1 size-4 accent-gold-700" />
                  <div className="min-w-0 flex-1">
                    <button type="button" className="block max-w-full truncate text-left text-sm font-semibold text-stone-900 hover:underline" onClick={() => props.onOpenProfile(customer.id, customer.name)}>{customer.name}</button>
                    {customer.email ? <a className="mt-0.5 block truncate text-xs text-stone-500 hover:text-gold-800 hover:underline" href={`mailto:${customer.email}`}>{customer.email}</a> : <p className="mt-0.5 text-xs text-stone-400">No email</p>}
                    <div className="mt-2 flex flex-wrap gap-1">{customer.deactivatedAt ? <Badge tone="neutral">Inactive</Badge> : <Badge tone="green">Active</Badge>}{duplicateIds.has(customer.id) && <Badge tone="amber">Possible duplicate</Badge>}{customer.ownerName && <Badge tone="blue">{customer.ownerName}</Badge>}{customer.tags.map((tag) => <Badge key={tag} tone="neutral">{tag}</Badge>)}</div>
                    <p className="mt-2 text-[11px] text-stone-400">Last activity {timeAgo(customer.lastActivityAt)}</p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2 border-t border-stone-100 pt-2">
                  <Button tone="secondary" size="sm" disabled={props.busy} onClick={() => props.onOpenProfile(customer.id, customer.name)}><IconHistory className="size-3.5" /> Open profile</Button>
                  {!customer.deactivatedAt && <Button tone="ghost" size="sm" disabled={props.busy} onClick={() => props.onDeactivate(customer)}><IconX className="size-3.5" /> Deactivate</Button>}
                </div>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-x-auto rounded-xl border border-stone-200 bg-white sm:block">
            <table className="w-full min-w-[850px] text-sm">
              <thead><tr className="border-b border-stone-200 bg-stone-50/80 text-left text-xs tracking-wide text-stone-500 uppercase">
                <th className="w-10 px-3 py-2.5"><input type="checkbox" aria-label="Select all visible customers" checked={allVisibleSelected} onChange={(event) => setSelected((current) => event.target.checked ? [...new Set([...current, ...visible.map((customer) => customer.id)])] : current.filter((id) => !visible.some((customer) => customer.id === id)))} className="size-4 accent-gold-700" /></th>
                <th className="px-3 py-2.5 font-medium">Customer</th><th className="px-3 py-2.5 font-medium">Owner &amp; tags</th><th className="px-3 py-2.5 font-medium">Last activity</th><th className="px-3 py-2.5 font-medium">Status</th><th className="px-3 py-2.5" />
              </tr></thead>
              <tbody>{visible.map((customer) => (
                <tr key={customer.id} className="border-b border-stone-100 last:border-0 hover:bg-stone-50/60">
                  <td className="px-3 py-3"><input type="checkbox" aria-label={`Select ${customer.name}`} checked={selected.includes(customer.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, customer.id] : current.filter((id) => id !== customer.id))} className="size-4 accent-gold-700" /></td>
                  <td className="px-3 py-3"><button type="button" className="text-left font-medium text-stone-800 hover:text-gold-800 hover:underline" onClick={() => props.onOpenProfile(customer.id, customer.name)}>{customer.name}</button><p className="mt-0.5 text-xs text-stone-500">{customer.email ?? "No email"}{duplicateIds.has(customer.id) && <span className="ml-2 text-amber-700">Possible duplicate</span>}</p></td>
                  <td className="px-3 py-3"><div className="flex max-w-64 flex-wrap gap-1">{customer.ownerName ? <Badge tone="blue">{customer.ownerName}</Badge> : <span className="text-xs text-stone-400">Unassigned</span>}{customer.tags.slice(0, 3).map((tag) => <Badge key={tag} tone="neutral">{tag}</Badge>)}{customer.tags.length > 3 && <Badge tone="neutral">+{customer.tags.length - 3}</Badge>}</div></td>
                  <td className="px-3 py-3 text-xs text-stone-500">{timeAgo(customer.lastActivityAt)}</td>
                  <td className="px-3 py-3">{customer.deactivatedAt ? <Badge tone="neutral">Inactive</Badge> : <Badge tone="green">Active</Badge>}</td>
                  <td className="px-3 py-3 text-right whitespace-nowrap"><button type="button" onClick={() => props.onOpenProfile(customer.id, customer.name)} className="rounded-md px-2 py-1 text-xs font-medium text-stone-500 hover:bg-stone-100 hover:text-stone-800">Open profile</button>{!customer.deactivatedAt && <button type="button" onClick={() => props.onDeactivate(customer)} disabled={props.busy} className="rounded-md px-2 py-1 text-xs text-stone-400 hover:bg-red-50 hover:text-red-700 disabled:opacity-40">Deactivate</button>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}
      <p className="mt-3 text-xs text-stone-400">Deactivation keeps invoices and history available. Duplicate matches are suggestions only, review records before merging.</p>
    </div>
  );
}

function Customer360Dialog(props: {
  customer: Customer | null;
  deals: Deal[];
  members: TeamMember[];
  busy: boolean;
  timeline: TimelineState | null;
  activeTab: "overview" | "activity" | "invoices" | "documents";
  onTabChange: (tab: "overview" | "activity" | "invoices" | "documents") => void;
  onClose: () => void;
  onRetryActivity: () => void;
  onUpdateProfile: (input: { customerIds: string[]; ownerUserId?: string | null; addTags?: string[]; removeTags?: string[]; notes?: string | null }) => Promise<boolean>;
  onCreateTask: (input: { customerId: string; title: string; dueAt?: string; note?: string }) => Promise<boolean>;
}) {
  const [notes, setNotes] = useState(props.customer?.notes ?? "");
  const [owner, setOwner] = useState(props.customer?.ownerUserId ?? "");
  const [tagsText, setTagsText] = useState((props.customer?.tags ?? []).join(", "));
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDate, setTaskDate] = useState("");
  if (!props.customer) return null;
  const customer = props.customer;
  const customerDeals = props.deals.filter((deal) => deal.customerId === customer.id);
  const entries = props.timeline?.entries ?? [];
  const invoiceEntries = entries.filter((entry) => ["invoice", "payment", "quote"].includes(entry.kind));
  const documentEntries = entries.filter((entry) => entry.kind === "document");
  const visibleEntries = props.activeTab === "invoices" ? invoiceEntries : props.activeTab === "documents" ? documentEntries : entries;

  async function saveDetails() {
    const before = new Set(customer.tags.map((tag) => tag.toLowerCase()));
    const afterTags = [...new Set(tagsText.split(",").map((tag) => tag.trim()).filter(Boolean))];
    const after = new Set(afterTags.map((tag) => tag.toLowerCase()));
    await props.onUpdateProfile({
      customerIds: [customer.id],
      ownerUserId: owner || null,
      notes: notes.trim() || null,
      addTags: afterTags.filter((tag) => !before.has(tag.toLowerCase())),
      removeTags: customer.tags.filter((tag) => !after.has(tag.toLowerCase())),
    });
  }

  async function addTask(event: React.FormEvent) {
    event.preventDefault();
    const ok = await props.onCreateTask({ customerId: customer.id, title: taskTitle.trim(), ...(taskDate ? { dueAt: new Date(`${taskDate}T12:00:00`).toISOString() } : {}) });
    if (ok) { setTaskTitle(""); setTaskDate(""); }
  }

  const tabs = [["overview", "Overview"], ["activity", "Activity"], ["invoices", `Invoices & quotes (${invoiceEntries.length})`], ["documents", `Documents (${documentEntries.length})`]] as const;
  return (
    <Dialog open onClose={props.onClose} title={customer.name} description={customer.email ?? "No email address on file"} width="max-w-3xl">
      <div className="mb-4 flex flex-wrap gap-2">
        {customer.email && <a className="inline-flex min-h-9 items-center rounded-md bg-gold-700 px-3 text-xs font-semibold text-white hover:bg-gold-800" href={`mailto:${customer.email}`}>Email customer</a>}
        <Button tone="secondary" size="sm" onClick={() => props.onTabChange("activity")}>View history</Button>
        {!customer.deactivatedAt && <Badge tone="green">Active</Badge>}
        {customer.deactivatedAt && <Badge tone="neutral">Inactive</Badge>}
      </div>
      <div className="scrollbar-hidden mb-4 flex gap-1 overflow-x-auto border-b border-stone-200" role="tablist" aria-label="Customer profile sections">
        {tabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={props.activeTab === id} onClick={() => props.onTabChange(id)} className={cn("min-h-10 shrink-0 border-b-2 px-3 text-xs font-medium", props.activeTab === id ? "border-gold-700 text-stone-900" : "border-transparent text-stone-500 hover:text-stone-800")}>{label}</button>)}
      </div>

      {props.activeTab === "overview" ? (
        <div className="grid gap-4 md:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-4">
            <section className="rounded-lg border border-stone-200 p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">Related deals</h3>
              {customerDeals.length ? <ul className="mt-2 divide-y divide-stone-100">{customerDeals.map((deal) => <li key={deal.id} className="flex items-center justify-between gap-3 py-2 text-sm"><span className="min-w-0 truncate font-medium">{deal.title}</span><span className="shrink-0 text-xs text-stone-500">{stageMeta[deal.stage].label} · {formatMoney(deal.valueMinor)}</span></li>)}</ul> : <p className="mt-2 text-sm text-stone-500">No deals linked yet.</p>}
            </section>
            <section className="rounded-lg border border-stone-200 p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">Notes</h3>
              <textarea className="input mt-2 min-h-24 resize-y" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={4000} placeholder="Keep useful context for the next conversation" aria-label="Customer notes" />
              <div className="mt-2 flex items-center justify-between gap-3"><span className="text-[11px] text-stone-400">{notes.length}/4000 · changes are recorded</span><Button size="sm" loading={props.busy} onClick={() => void saveDetails()}>Save profile</Button></div>
            </section>
          </div>
          <div className="space-y-4">
            <section className="rounded-lg border border-stone-200 p-3">
              <label className="label" htmlFor="customer-owner">Owner</label>
              <select id="customer-owner" className="select mt-1" value={owner} onChange={(event) => setOwner(event.target.value)}><option value="">Unassigned</option>{props.members.map((member) => <option key={member.userId} value={member.userId}>{member.name || member.email}</option>)}</select>
              <label className="label mt-3 block" htmlFor="customer-tags">Tags</label>
              <input id="customer-tags" className="input mt-1" value={tagsText} onChange={(event) => setTagsText(event.target.value)} placeholder="Retail, priority" />
              <p className="mt-1 text-[11px] text-stone-400">Separate tags with commas.</p>
            </section>
            <form className="rounded-lg border border-stone-200 p-3" onSubmit={(event) => void addTask(event)}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">Next follow-up</h3>
              <input className="input mt-2" value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder="Call about the proposal" aria-label="Follow-up task title" required maxLength={160} />
              <label className="label mt-2 block" htmlFor="customer-task-date">Due date</label>
              <input id="customer-task-date" className="input mt-1" type="date" value={taskDate} onChange={(event) => setTaskDate(event.target.value)} />
              <Button type="submit" tone="secondary" size="sm" className="mt-2 w-full" loading={props.busy} disabled={!taskTitle.trim()}>Add follow-up</Button>
            </form>
            <p className="text-xs text-stone-500">Last activity {timeAgo(customer.lastActivityAt)}</p>
          </div>
        </div>
      ) : (
        <div className="max-h-[55vh] overflow-y-auto">
          {props.timeline?.error ? <EmptyState icon={<IconAlertTriangle />} title="History could not load" hint={props.timeline.error} action={<Button tone="secondary" size="sm" onClick={props.onRetryActivity}>Retry</Button>} /> : !props.timeline?.entries ? <p className="py-8 text-center text-sm text-stone-500" role="status">Loading customer history…</p> : visibleEntries.length === 0 ? <EmptyState icon={props.activeTab === "documents" ? <IconFileText /> : <IconHistory />} title={props.activeTab === "documents" ? "No documents linked" : props.activeTab === "invoices" ? "No invoices or quotes yet" : "No activity yet"} hint="Linked records will appear here as work is recorded." /> : <ol className="divide-y divide-stone-100">{visibleEntries.map((entry) => <li key={`${entry.kind}-${entry.refId}`} className="flex gap-3 py-3"><span className="mt-1 size-2 shrink-0 rounded-full bg-gold-500" aria-hidden="true" /><div className="min-w-0 flex-1"><p className="text-sm font-medium text-stone-800">{entry.summary}</p><p className="mt-0.5 text-xs text-stone-500">{entry.kind} · {timeAgo(entry.date)}</p></div></li>)}</ol>}
        </div>
      )}
    </Dialog>
  );
}
