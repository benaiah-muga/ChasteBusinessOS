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
import {
  IconAlertTriangle,
  IconArrowRight,
  IconTrendingUp,
  IconUndo,
  IconUser,
  IconX,
} from "@/components/icons";
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

const stageMeta: Record<Stage, { dot: string; label: string }> = {
  lead: { dot: "bg-stone-400", label: "Lead" },
  qualified: { dot: "bg-sky-500", label: "Qualified" },
  proposal: { dot: "bg-blue-500", label: "Proposal" },
  negotiation: { dot: "bg-violet-500", label: "Negotiation" },
  won: { dot: "bg-emerald-600", label: "Won" },
  lost: { dot: "bg-red-500", label: "Lost" },
};

const weights: Record<Stage, number> = { lead: 0.1, qualified: 0.3, proposal: 0.5, negotiation: 0.7, won: 1, lost: 0 };

// __MAIN__
export default function CrmPage() {
  const __enabled = useModuleEnabled("crm");
  const [tab, setTab] = useState<"deals" | "customers">("deals");
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
      <div>
        <PageHeader title="CRM" />
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
  if (!deals || !customers) return <LoadingPage />;
  if (!__enabled) return <ModuleDisabled label="CRM" />;

  const activeCustomers = customers.filter((c) => !c.deactivatedAt);

  return (
    <div>
      <PageHeader
        title="CRM"
        description="Your customer directory and deal lifecycle across six stages. Weighted forecast applies each stage's probability to its open value."
      />

      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}

      <div className="mb-5 flex w-fit gap-1 rounded-lg border border-stone-200 bg-white p-1">
        {(
          [
            ["deals", `Pipeline (${deals.length})`],
            ["customers", `Customers (${activeCustomers.length})`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              "cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-150",
              tab === key ? "bg-emerald-600 text-white" : "text-stone-600 hover:bg-stone-100",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "deals" && (
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
        />
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
}) {
  const { deals, busy } = props;
  const openDeals = deals.filter((d) => d.stage !== "won" && d.stage !== "lost");
  const openValue = openDeals.reduce((s, d) => s + d.valueMinor, 0);
  const forecast = openDeals.reduce((s, d) => s + Math.round(d.valueMinor * weights[d.stage]), 0);
  const wonValue = deals.filter((d) => d.stage === "won").reduce((s, d) => s + d.valueMinor, 0);

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

function CustomersTab(props: {
  customers: Customer[];
  busy: boolean;
  newName: string;
  newEmail: string;
  onNameChange: (v: string) => void;
  onEmailChange: (v: string) => void;
  onCreate: (e: React.FormEvent) => void;
  onDeactivate: (customerId: string) => void;
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
          hint="Add your first customer above, or ask your co-worker in chat; invoices need a customer record."
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
                  <td className="px-4 py-2.5 text-right">
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
        Deactivating hides a customer from pickers and the agent's lookups; their invoices and history stay intact.
      </p>
    </div>
  );
}
