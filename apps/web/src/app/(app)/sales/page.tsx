"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ActionNotice,
  Badge,
  Button,
  Card,
  CardTitle,
  EmptyState,
  LoadingPage,
  SegmentedControl,
  StatCard,
  type ActionNoticeState,
} from "@/components/ui";
import { formatMoney, formatMoneyWhole, statusTone, timeAgo, toMinor } from "@/lib/format";
import { IconFileText, IconListTree, IconPlus, IconTrash } from "@/components/icons";
import { callApi, postApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";
import { AppFrame } from "../_shell/app-frame";

type Tab = "overview" | "quotes" | "new";

interface Quote {
  id: string;
  number: number;
  status: string;
  totalMinor: number;
  customerId: string;
  createdAt: string;
  invoiceId: string | null;
}
interface Customer {
  id: string;
  name: string;
  email: string | null;
  deactivatedAt: string | null;
}
interface Deal {
  id: string;
  title: string;
  stage: string;
  valueMinor: number;
  customerName: string | null;
  updatedAt: string;
}
interface Product {
  sku: string;
  name: string;
  salePriceMinor?: number;
  avgUnitCostMinor?: number;
}

const QUOTE_STATUSES = ["draft", "sent", "accepted", "declined", "expired"] as const;
type StatusFilter = "all" | (typeof QUOTE_STATUSES)[number];

/**
 * Quote decisions carry stronger semantics than the shared mapping assumes
 * (an accepted quote became revenue); everything else falls through.
 */
const quoteTones: Record<string, "blue" | "green" | "red"> = {
  sent: "blue",
  accepted: "green",
  declined: "red",
};
const toneFor = (status: string): "green" | "red" | "amber" | "blue" | "neutral" =>
  quoteTones[status] ?? statusTone(status);

// Weighted-forecast probabilities, identical to the CRM pipeline weights.
const stageWeights: Record<string, number> = {
  lead: 0.1,
  qualified: 0.3,
  proposal: 0.5,
  negotiation: 0.7,
  won: 1,
  lost: 0,
};
const OPEN_STAGES = ["lead", "qualified", "proposal", "negotiation"] as const;

const emptyLine = { description: "", quantity: "1", unitPrice: "0.00", tax: "0.00", sku: "" };

export default function SalesPage() {
  const enabled = useModuleEnabled("sales");
  const [data, setData] = useState<{ quotes: Quote[]; customers: Customer[]; deals: Deal[] } | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [filter, setFilter] = useState<StatusFilter>("all");

  const [quoteForm, setQuoteForm] = useState({
    customerId: "",
    memo: "",
    lines: [{ ...emptyLine }],
  });
  const [quickCustomer, setQuickCustomer] = useState({ open: false, name: "", email: "" });

  const load = useCallback(async () => {
    const [q, c, d, inv] = await Promise.all([
      callApi<{ quotes?: Quote[] }>("/api/quotes"),
      callApi<{ customers?: Customer[] }>("/api/customers"),
      callApi<{ deals?: Deal[] }>("/api/deals"),
      callApi<{ items?: Product[] }>("/api/inventory"),
    ]);
    setData({
      quotes: q.data?.quotes ?? [],
      customers: c.data?.customers ?? [],
      deals: d.data?.deals ?? [],
    });
    setProducts(inv.data?.items ?? []);
    if (q.error) setNotice({ tone: "error", error: q.error });
  }, []);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  // Quotes are governed money actions; 202 means the kernel parked it for approval.
  const post = useCallback(
    async (url: string, body: Record<string, unknown>, label: string): Promise<boolean> => {
      setBusy(true);
      try {
        const res = await postApi(url, body);
        if (res.status === 202) {
          setNotice({ tone: "pending", text: `${label} requires approval.` });
        } else if (!res.ok) {
          setNotice({ tone: "error", error: res.error ?? { title: `${label} failed`, hint: "Try again." } });
        } else {
          setNotice({ tone: "success", text: `${label} done.` });
          await load();
          return true;
        }
      } finally {
        setBusy(false);
      }
      return false;
    },
    [load],
  );

  async function decide(quoteId: string, action: "accept" | "decline", number: number): Promise<void> {
    await post("/api/quotes", { action, quoteId }, `${action === "accept" ? "Accept" : "Decline"} quote #${number}`);
  }

  async function createQuickCustomer(): Promise<void> {
    const name = quickCustomer.name.trim();
    if (!name) return;
    setBusy(true);
    try {
      const res = await postApi<{ customerId?: string }>("/api/customers", {
        action: "create",
        name,
        email: quickCustomer.email.trim() || undefined,
      });
      if (!res.ok && res.error) {
        setNotice({ tone: "error", error: res.error });
      } else {
        await load();
        const created = res.data?.customerId;
        if (created) setQuoteForm((f) => ({ ...f, customerId: created }));
        setQuickCustomer({ open: false, name: "", email: "" });
        setNotice({ tone: "success", text: `Customer ${name} added.` });
      }
    } finally {
      setBusy(false);
    }
  }

  async function createQuote(): Promise<void> {
    const lines = quoteForm.lines
      .map((l) => ({
        description: l.description.trim(),
        quantity: Math.round(Number(l.quantity || "0") * 1000),
        unitPriceMinor: toMinor(l.unitPrice),
        taxMinor: toMinor(l.tax),
      }))
      .filter((l) => l.description.length > 0 && l.quantity > 0);
    if (!quoteForm.customerId || lines.length === 0) {
      setNotice({
        tone: "error",
        error: {
          title: "Some details are missing",
          hint: "Pick a customer and keep at least one line with a description and a positive quantity.",
        },
      });
      return;
    }
    const who = customerName.get(quoteForm.customerId) ?? "customer";
    const ok = await post(
      "/api/quotes",
      { action: "create", customerId: quoteForm.customerId, memo: quoteForm.memo.trim() || undefined, lines },
      `Quote for ${who}`,
    );
    if (ok) setQuoteForm({ customerId: "", memo: "", lines: [{ ...emptyLine }] });
  }

  if (!enabled) return <ModuleDisabled label="Sales" />;
  if (!data) return <LoadingPage />;

  const { quotes, customers, deals } = data;
  const activeCustomers = customers.filter((c) => !c.deactivatedAt);
  const customerName = new Map(customers.map((c) => [c.id, c.name]));

  const openQuotes = quotes.filter((q) => q.status === "draft" || q.status === "sent");
  const openValueMinor = openQuotes.reduce((s, q) => s + q.totalMinor, 0);
  const accepted = quotes.filter((q) => q.status === "accepted");
  const decided = quotes.filter((q) => q.status === "accepted" || q.status === "declined" || q.status === "expired");
  const conversion = decided.length > 0 ? Math.round((accepted.length / decided.length) * 100) : null;

  const openDeals = deals.filter((d) => d.stage !== "won" && d.stage !== "lost");
  const pipelineValueMinor = openDeals.reduce((s, d) => s + d.valueMinor, 0);
  const weightedForecastMinor = openDeals.reduce(
    (s, d) => s + Math.round(d.valueMinor * (stageWeights[d.stage] ?? 0)),
    0,
  );

  const visibleQuotes = filter === "all" ? quotes : quotes.filter((q) => q.status === filter);

  return (
    <AppFrame
      appId="sales"
      description="Draft quotes, let customers accept them, and they become invoices without retyping anything."
      tabs={[
        { id: "overview", label: "Overview" },
        { id: "quotes", label: "Quotes" },
        { id: "new", label: "New quote" },
      ]}
      activeTab={tab}
      onTabChange={(id) => setTab(id as Tab)}
    >
      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}

      {tab === "overview" && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Open quotes" value={openQuotes.length} sub={`${formatMoneyWhole(openValueMinor)} awaiting decision`} />
            <StatCard
              label="Accepted"
              value={accepted.length}
              sub={conversion === null ? "No decided quotes yet" : `${conversion}% of decided quotes`}
              tone={accepted.length > 0 ? "success" : "default"}
            />
            <StatCard
              label="Pipeline value"
              value={formatMoneyWhole(pipelineValueMinor)}
              sub={`${openDeals.length} open deal${openDeals.length === 1 ? "" : "s"} from CRM`}
            />
            <StatCard label="Weighted forecast" value={formatMoneyWhole(weightedForecastMinor)} sub="Stage-probability weighted" />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardTitle>Recent quote activity</CardTitle>
              {quotes.length === 0 ? (
                <EmptyState icon={<IconFileText />} title="No quotes yet" hint="Draft your first quote in the New quote tab." />
              ) : (
                <ul className="divide-y text-sm">
                  {quotes.slice(0, 5).map((q) => (
                    <li key={q.id} className="flex items-center justify-between gap-2 py-1.5">
                      <span className="min-w-0 truncate">
                        <span className="font-medium">#{q.number}</span> · {customerName.get(q.customerId) ?? "Unknown customer"}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="tabular-nums opacity-70">{formatMoney(q.totalMinor)}</span>
                        <Badge tone={toneFor(q.status)}>{q.status}</Badge>
                        <span className="hidden w-16 text-right text-xs opacity-50 sm:inline">{timeAgo(q.createdAt)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card>
              <CardTitle>Pipeline by stage</CardTitle>
              {openDeals.length === 0 ? (
                <EmptyState icon={<IconListTree />} title="No open deals" hint="Deals you track in CRM appear here so quotes have context." />
              ) : (
                <ul className="divide-y text-sm">
                  {OPEN_STAGES.map((stage) => {
                    const stageDeals = openDeals.filter((d) => d.stage === stage);
                    if (stageDeals.length === 0) return null;
                    const stageValueMinor = stageDeals.reduce((s, d) => s + d.valueMinor, 0);
                    return (
                      <li key={stage} className="flex items-center justify-between py-1.5">
                        <span className="capitalize">{stage}</span>
                        <span className="opacity-70">
                          {stageDeals.length} · {formatMoneyWhole(stageValueMinor)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}


      {tab === "quotes" && (
        <>
          <SegmentedControl
            ariaLabel="Filter quotes by status"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              ...QUOTE_STATUSES.map((s) => ({ value: s, label: s[0]!.toUpperCase() + s.slice(1) })),
            ]}
          />
          {visibleQuotes.length === 0 ? (
            <EmptyState
              icon={<IconFileText />}
              title={filter === "all" ? "No quotes yet" : `No ${filter} quotes`}
              hint={
                filter === "all"
                  ? "Draft one in the New quote tab; accepting it creates the invoice automatically."
                  : "Try another status filter."
              }
            />
          ) : (
            visibleQuotes.map((q) => (
              <Card key={q.id}>
                <CardTitle right={<Badge tone={toneFor(q.status)}>{q.status}</Badge>}>
                  Quote #{q.number} — {customerName.get(q.customerId) ?? "Unknown customer"}
                </CardTitle>
                <p className="text-xs opacity-60">
                  {formatMoney(q.totalMinor)} · created {timeAgo(q.createdAt)}
                  {q.invoiceId ? " · converted to an invoice" : ""}
                </p>
                {q.status === "sent" && (
                  <div className="mt-2 flex justify-end gap-2">
                    <Button
                      size="sm"
                      tone="secondary"
                      disabled={busy}
                      aria-label={`Decline quote #${q.number}`}
                      onClick={() => void decide(q.id, "decline", q.number)}
                    >
                      Decline
                    </Button>
                    <Button size="sm" disabled={busy} aria-label={`Accept quote #${q.number}`} onClick={() => void decide(q.id, "accept", q.number)}>
                      Accept &amp; invoice
                    </Button>
                  </div>
                )}
              </Card>
            ))
          )}
        </>
      )}


      {tab === "new" && (
        <Card>
          <CardTitle>Draft quote</CardTitle>
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="rounded border bg-transparent px-2 py-1.5"
                aria-label="Customer"
                value={quoteForm.customerId}
                onChange={(e) => setQuoteForm({ ...quoteForm, customerId: e.target.value })}
              >
                <option value="">Customer…</option>
                {activeCustomers.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              {activeCustomers.length === 0 && !quickCustomer.open && (
                <span className="text-xs text-stone-500">
                  No customers yet —
                  <button type="button" className="ml-1 font-medium text-maroon-700 underline underline-offset-2" onClick={() => setQuickCustomer({ open: true, name: "", email: "" })}>
                    create one here
                  </button>
                </span>
              )}
              {activeCustomers.length > 0 && (
                <Button tone="ghost" size="sm" onClick={() => setQuickCustomer({ open: !quickCustomer.open, name: "", email: "" })}>
                  + New customer
                </Button>
              )}
              <input
                className="min-w-40 flex-1 rounded border bg-transparent px-2 py-1.5"
                placeholder="Memo (optional)"
                value={quoteForm.memo}
                onChange={(e) => setQuoteForm({ ...quoteForm, memo: e.target.value })}
              />
            </div>
            {quickCustomer.open && (
              <div className="flex flex-wrap items-center gap-2 rounded border border-stone-200 bg-stone-50 p-2">
                <input
                  className="flex-1 rounded border bg-transparent px-2 py-1.5"
                  placeholder="Customer name"
                  aria-label="Customer name"
                  value={quickCustomer.name}
                  onChange={(e) => setQuickCustomer({ ...quickCustomer, name: e.target.value })}
                />
                <input
                  className="w-48 rounded border bg-transparent px-2 py-1.5"
                  placeholder="Email (optional)"
                  aria-label="Customer email"
                  value={quickCustomer.email}
                  onChange={(e) => setQuickCustomer({ ...quickCustomer, email: e.target.value })}
                />
                <Button size="sm" disabled={busy || !quickCustomer.name.trim()} onClick={() => void createQuickCustomer()}>
                  Save customer
                </Button>
              </div>
            )}

            <div className="space-y-1.5 pt-1">
              {quoteForm.lines.map((line, i) => {
                const setLine = (patch: Partial<typeof line>) =>
                  setQuoteForm({ ...quoteForm, lines: quoteForm.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
                return (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <select
                      className="w-44 rounded border bg-transparent px-2 py-1.5"
                      title="Pick a product to fill description and price"
                      aria-label={`Line ${i + 1} product`}
                      value={products.some((p) => p.sku === line.sku) ? line.sku : ""}
                      onChange={(e) => {
                        const p = products.find((x) => x.sku === e.target.value);
                        if (!p) return;
                        setLine({
                          sku: p.sku,
                          description: line.description || p.name,
                          unitPrice:
                            p.salePriceMinor != null && p.salePriceMinor > 0
                              ? (p.salePriceMinor / 100).toFixed(2)
                              : line.unitPrice,
                        });
                      }}
                    >
                      <option value="">{products.length ? "Product…" : "No products yet"}</option>
                      {products.map((p) => (
                        <option key={p.sku} value={p.sku}>{p.name} · {p.sku}</option>
                      ))}
                    </select>
                    <input
                      className="min-w-40 flex-1 rounded border bg-transparent px-2 py-1.5"
                      placeholder="Description"
                      aria-label={`Line ${i + 1} description`}
                      value={line.description}
                      onChange={(e) => setLine({ description: e.target.value })}
                    />
                    <input
                      className="w-20 rounded border bg-transparent px-2 py-1.5 text-right"
                      placeholder="Qty"
                      aria-label={`Line ${i + 1} quantity`}
                      value={line.quantity}
                      onChange={(e) => setLine({ quantity: e.target.value })}
                    />
                    <input
                      className="w-24 rounded border bg-transparent px-2 py-1.5 text-right"
                      placeholder="Unit price"
                      aria-label={`Line ${i + 1} unit price`}
                      value={line.unitPrice}
                      onChange={(e) => setLine({ unitPrice: e.target.value })}
                    />
                    <input
                      className="w-20 rounded border bg-transparent px-2 py-1.5 text-right"
                      placeholder="Tax"
                      aria-label={`Line ${i + 1} tax amount`}
                      value={line.tax}
                      onChange={(e) => setLine({ tax: e.target.value })}
                    />
                    <Button
                      tone="ghost"
                      size="sm"
                      aria-label={`Remove line ${i + 1}`}
                      onClick={() => setQuoteForm({ ...quoteForm, lines: quoteForm.lines.filter((_, j) => j !== i) })}
                    >
                      <IconTrash className="size-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button tone="ghost" size="sm" onClick={() => setQuoteForm({ ...quoteForm, lines: [...quoteForm.lines, { ...emptyLine }] })}>
                <IconPlus className="size-4" /> Add line
              </Button>
              <Button disabled={busy || !quoteForm.customerId} onClick={() => void createQuote()}>
                Create quote
              </Button>
            </div>
            <p className="text-xs opacity-50">
              Quantities are entered in whole units; prices and tax in dollars. Accepting a sent quote later converts it into a
              real invoice verbatim.
            </p>
          </div>
        </Card>
      )}

    </AppFrame>
  );
}
