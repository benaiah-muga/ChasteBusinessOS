"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ActionNotice,
  Badge,
  Button,
  Card,
  CardTitle,
  ConfirmDialog,
  EmptyState,
  SegmentedControl,
  StatCard,
  type ActionNoticeState,
} from "@/components/ui";
import { formatDate, formatMoney, formatMoneyWhole, minorToInput, statusTone, timeAgo, toMinor } from "@/lib/format";
import { useMoneySync } from "@/lib/money";
import { IconFileText, IconListTree, IconPlus, IconTrash } from "@/components/icons";
import { callApi, postApi, type AppError } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";
import { AppFrame } from "../_shell/app-frame";
import { useTabParam } from "@/lib/tab-param";
import { NewOrderTab, OrdersListTab, type OrderRow } from "./orders-tab";

type Tab = "overview" | "quotes" | "new" | "orders" | "new-order" | "customers";

interface Quote {
  id: string;
  number: number;
  status: string;
  totalMinor: number;
  customerId: string;
  createdAt: string;
  expiresAt: string | null;
  invoiceId: string | null;
}

interface SaleLineDraft {
  description: string;
  quantity: string;
  unitPrice: string;
  tax: string;
  sku: string;
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

const emptyLine = { description: "", quantity: "1", unitPrice: "0", tax: "0", sku: "" };

function draftAmounts(lines: SaleLineDraft[]) {
  return lines.reduce(
    (totals, line) => {
      const quantity = Number(line.quantity || "0");
      const price = Number(line.unitPrice || "0");
      const tax = Number(line.tax || "0");
      if (!Number.isFinite(quantity) || !Number.isFinite(price) || !Number.isFinite(tax) || quantity < 0 || price < 0 || tax < 0) {
        return totals;
      }
      const quantityMilli = Math.round(quantity * 1000);
      const lineSubtotal = Math.round((quantityMilli * toMinor(line.unitPrice)) / 1000);
      const lineTax = toMinor(line.tax);
      return {
        subtotalMinor: totals.subtotalMinor + lineSubtotal,
        taxMinor: totals.taxMinor + lineTax,
      };
    },
    { subtotalMinor: 0, taxMinor: 0 },
  );
}

export default function SalesPage() {
  useMoneySync();
  const enabled = useModuleEnabled("sales");
  const [data, setData] = useState<{
    quotes: Quote[];
    customers: Customer[];
    deals: Deal[];
    orders: OrderRow[];
  } | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [productLoadError, setProductLoadError] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useTabParam(["overview", "quotes", "new", "orders", "new-order"] as const, "overview");
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [quoteSearch, setQuoteSearch] = useState("");
  const [customerSearch, setCustomerSearch] = useState("");
  const quoteSearchRef = useRef<HTMLInputElement>(null);
  const customerSearchRef = useRef<HTMLInputElement>(null);

  const [quoteForm, setQuoteForm] = useState({
    customerId: "",
    memo: "",
    expiresAt: "",
    lines: [{ ...emptyLine }],
  });
  const [quickCustomer, setQuickCustomer] = useState({ open: false, name: "", email: "" });
  const [acceptTarget, setAcceptTarget] = useState<Quote | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [q, c, d, inv, so] = await Promise.all([
      callApi<{ quotes?: Quote[] }>("/api/quotes"),
      callApi<{ customers?: Customer[] }>("/api/customers"),
      callApi<{ deals?: Deal[] }>("/api/deals"),
      callApi<{ items?: Product[] }>("/api/inventory"),
      callApi<{ orders?: OrderRow[] }>("/api/sales"),
    ]);
    const failedCoreRequest = [q, c, d, so].find((result) => !result.ok);
    if (failedCoreRequest) {
      setLoadError(failedCoreRequest.error ?? { title: "Sales data did not load", hint: "Try again in a moment." });
      setLoading(false);
      return;
    }
    setData({
      quotes: q.data?.quotes ?? [],
      customers: c.data?.customers ?? [],
      deals: d.data?.deals ?? [],
      orders: so.data?.orders ?? [],
    });
    setLoadError(null);
    setProducts(inv.data?.items ?? []);
    setProductLoadError(inv.ok ? null : inv.error ?? { title: "Product catalog did not load", hint: "Retry to load products for quote and order lines." });
    setLoading(false);
  }, []);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  useEffect(() => {
    function onShortcut(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select"))) return;
      const search = tab === "quotes" ? quoteSearchRef.current : tab === "customers" ? customerSearchRef.current : null;
      if (!search) return;
      event.preventDefault();
      search.focus();
    }
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [tab]);

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

  async function decide(quoteId: string, action: "accept" | "decline", number: number): Promise<boolean> {
    return post("/api/quotes", { action, quoteId }, `${action === "accept" ? "Accept" : "Decline"} quote #${number}`);
  }

  async function acceptQuote(): Promise<void> {
    if (!acceptTarget) return;
    const accepted = await decide(acceptTarget.id, "accept", acceptTarget.number);
    if (accepted) setAcceptTarget(null);
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
    if (quoteForm.expiresAt && Date.parse(`${quoteForm.expiresAt}T23:59:59.999Z`) <= Date.now()) {
      setNotice({ tone: "error", error: { title: "Choose a future validity date", hint: "A quote that has already expired cannot be accepted." } });
      return;
    }
    const linesWithDescriptions = quoteForm.lines.filter((line) => line.description.trim().length > 0);
    const invalidLine = linesWithDescriptions.some((line) => {
      const quantity = Number(line.quantity || "0");
      const unitPrice = Number(line.unitPrice || "0");
      const tax = Number(line.tax || "0");
      return !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0 || !Number.isFinite(tax) || tax < 0;
    });
    const lines = linesWithDescriptions.map((line) => ({
      description: line.description.trim(),
      quantity: Math.round(Number(line.quantity || "0") * 1000),
      unitPriceMinor: toMinor(line.unitPrice),
      taxMinor: toMinor(line.tax),
    }));
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
    if (invalidLine) {
      setNotice({
        tone: "error",
        error: { title: "Check the quote lines", hint: "Each described line needs a positive quantity and non-negative amount values." },
      });
      return;
    }
    const who = customerName.get(quoteForm.customerId) ?? "customer";
    const ok = await post(
      "/api/quotes",
      {
        action: "create",
        customerId: quoteForm.customerId,
        memo: quoteForm.memo.trim() || undefined,
        expiresAt: quoteForm.expiresAt || undefined,
        lines,
      },
      `Quote for ${who}`,
    );
    if (ok) setQuoteForm({ customerId: "", memo: "", expiresAt: "", lines: [{ ...emptyLine }] });
  }

  if (!enabled) return <ModuleDisabled label="Sales" />;
  if (!data) {
    return (
      <AppFrame appId="sales" description="Quotes, orders, customers, and the next step to move a sale forward.">
        <h1 className="sr-only">Sales</h1>
        {loadError ? (
          <Card>
            <CardTitle>{loadError.title}</CardTitle>
            <p className="text-sm text-[#c4bbb0]">{loadError.hint}</p>
            <div className="mt-3"><Button disabled={loading} onClick={() => void load()}>{loading ? "Trying again…" : "Retry"}</Button></div>
          </Card>
        ) : (
          <div role="status" className="rounded-xl border border-white/10 bg-white/[0.03] p-5 text-sm text-[#c4bbb0]">
            <span className="mr-2 inline-block size-2 animate-pulse rounded-full bg-gold-500" aria-hidden="true" />
            Loading your sales workspace…
          </div>
        )}
      </AppFrame>
    );
  }

  const { quotes, customers, deals, orders } = data;
  const activeCustomers = customers.filter((c) => !c.deactivatedAt);
  const customerName = new Map(customers.map((c) => [c.id, c.name]));
  const openOrders = orders.filter((o) => o.status === "draft" || o.status === "confirmed");

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
  const normalizedQuoteSearch = quoteSearch.trim().toLocaleLowerCase();
  const searchedQuotes = visibleQuotes.filter((q) => {
    const customer = customerName.get(q.customerId) ?? "Unknown customer";
    return !normalizedQuoteSearch || `#${q.number} ${customer} ${q.status}`.toLocaleLowerCase().includes(normalizedQuoteSearch);
  });
  const filteredCustomers = activeCustomers.filter((customer) => {
    const term = customerSearch.trim().toLocaleLowerCase();
    return !term || `${customer.name} ${customer.email ?? ""}`.toLocaleLowerCase().includes(term);
  });
  const quotesNeedingDecision = quotes.filter((quote) => quote.status === "sent");
  const draftOrders = orders.filter((order) => order.status === "draft");
  const totals = draftAmounts(quoteForm.lines);
  const quoteTotalMinor = totals.subtotalMinor + totals.taxMinor;

  const sectionTitle: Record<Tab, string> = {
    overview: "Sales overview",
    quotes: "Quotes",
    new: "New quote",
    orders: "Sales orders",
    "new-order": "New sales order",
    customers: "Customers",
  };
  const sectionDescription: Record<Tab, string> = {
    overview: "A clear view of what needs attention and the fastest way to move a sale forward.",
    quotes: "Track quote decisions, find a record, and follow up with a customer.",
    new: "Prepare a priced offer for a customer and set a clear validity date.",
    orders: "Confirm, fulfill, and track customer orders.",
    "new-order": "Build a customer order and review its total before saving.",
    customers: "Find a customer and start the next conversation or quote.",
  };

  return (
    <AppFrame
      appId="sales"
      description="Quotes, orders, customers, and the next step to move a sale forward."
      tabs={[
        { id: "overview", label: "Overview" },
        { id: "quotes", label: "Quotes", count: openQuotes.length || undefined },
        { id: "orders", label: "Orders", count: openOrders.length || undefined },
        { id: "customers", label: "Customers" },
      ]}
      activeTab={tab === "new" ? "quotes" : tab === "new-order" ? "orders" : tab}
      onTabChange={(id) => setTab(id as Tab)}
      persistKey="sales"
    >
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-[#f6efe5]">{sectionTitle[tab]}</h1>
          <p className="mt-1 text-sm text-[#bdb4a8]">{sectionDescription[tab]}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(tab === "overview" || tab === "quotes" || tab === "customers") && (
            <Button size="sm" onClick={() => setTab("new")}>{tab === "customers" ? "New quote" : "Create quote"}</Button>
          )}
          {(tab === "overview" || tab === "orders") && (
            <Button size="sm" tone="secondary" onClick={() => setTab("new-order")}>Create order</Button>
          )}
        </div>
      </div>
      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}
      {loadError && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-sm" role="status">
          <span className="text-[#e5d3b7]">Some sales data did not refresh. {loadError.hint}</span>
          <Button size="sm" tone="secondary" disabled={loading} onClick={() => void load()}>{loading ? "Retrying…" : "Retry"}</Button>
        </div>
      )}
      {productLoadError && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-sm" role="status">
          <span className="text-[#e5d3b7]">{productLoadError.hint}</span>
          <Button size="sm" tone="secondary" disabled={loading} onClick={() => void load()}>{loading ? "Retrying…" : "Retry catalog"}</Button>
        </div>
      )}
      {tab === "new" && <p className="mb-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-[#c4bbb0]">Quotes start in Sent when created. Share the details with your customer, then record their decision from the Quotes list.</p>}

      {tab === "overview" && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Awaiting customer decision" value={quotesNeedingDecision.length} sub={`${formatMoneyWhole(openValueMinor)} open value`} />
            <StatCard
              label="Quotes accepted"
              value={accepted.length}
              sub={conversion === null ? "No decided quotes yet" : `${conversion}% of decided quotes`}
              tone={accepted.length > 0 ? "success" : "default"}
            />
            <StatCard
              label="Open pipeline"
              value={formatMoneyWhole(pipelineValueMinor)}
              sub={`${openDeals.length} deal${openDeals.length === 1 ? "" : "s"} · ${formatMoneyWhole(weightedForecastMinor)} weighted`}
            />
            <StatCard
              label="Open orders"
              value={openOrders.length}
              sub={`${formatMoneyWhole(openOrders.reduce((s, o) => s + o.totalMinor, 0))} committed`}
              tone={openOrders.length > 0 ? "success" : "default"}
            />
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
            <Card>
              <CardTitle right={<Button size="sm" tone="ghost" onClick={() => setTab("quotes")}>View all</Button>}>Recent quote activity</CardTitle>
              {quotes.length === 0 ? (
                <div className="py-2">
                  <EmptyState icon={<IconFileText />} title="Your quote activity starts here" hint="Create a quote with clear pricing and a validity date, then track the customer decision here." />
                  <div className="mt-3 text-center"><Button size="sm" onClick={() => setTab("new")}>Create your first quote</Button></div>
                </div>
              ) : (
                <ul className="divide-y text-sm">
                  {quotes.slice(0, 5).map((q) => (
                    <li key={q.id}>
                      <button type="button" onClick={() => setTab("quotes")} className="flex w-full items-center justify-between gap-2 rounded-md py-2 text-left transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-500">
                        <span className="min-w-0 truncate">
                          <span className="font-medium">Quote #{q.number}</span> · {customerName.get(q.customerId) ?? "Unknown customer"}
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          <span className="tabular-nums text-[#c4bbb0]">{formatMoney(q.totalMinor)}</span>
                          <Badge tone={toneFor(q.status)}>{q.status}</Badge>
                          <span className="hidden w-16 text-right text-xs text-[#bdb4a8] sm:inline">{timeAgo(q.createdAt)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card>
              <CardTitle right={<Link href="/crm?tab=deals" className="rounded-md px-2 py-1 text-xs font-medium text-[#dec28f] hover:bg-white/[0.06]">Open CRM</Link>}>Pipeline by stage</CardTitle>
              {openDeals.length === 0 ? (
                <div className="py-2">
                  <EmptyState icon={<IconListTree />} title="No active deals yet" hint="Track opportunities in CRM to understand which customers and offers are moving forward." />
                  <div className="mt-3 text-center"><Link href="/crm?tab=deals" className="text-sm font-medium text-[#dec28f] underline-offset-4 hover:underline">Add a deal in CRM</Link></div>
                </div>
              ) : (
                <ul className="divide-y text-sm">
                  {OPEN_STAGES.map((stage) => {
                    const stageDeals = openDeals.filter((d) => d.stage === stage);
                    if (stageDeals.length === 0) return null;
                    const stageValueMinor = stageDeals.reduce((s, d) => s + d.valueMinor, 0);
                    return (
                      <li key={stage} className="flex items-center justify-between py-1.5">
                        <span className="capitalize">{stage}</span>
                        <span className="text-[#c4bbb0]">
                          {stageDeals.length} · {formatMoneyWhole(stageValueMinor)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>
          <Card className="mt-4">
            <CardTitle>Next actions</CardTitle>
            <div className="grid gap-2 sm:grid-cols-2">
              {quotesNeedingDecision.length > 0 && (
                <button type="button" onClick={() => setTab("quotes")} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.06]">
                  <span><span className="block text-sm font-medium">Follow up on open quotes</span><span className="mt-0.5 block text-xs text-[#bdb4a8]">{quotesNeedingDecision.length} awaiting a customer decision</span></span>
                  <span className="text-xs font-semibold text-[#dec28f]">Review →</span>
                </button>
              )}
              {draftOrders.length > 0 && (
                <button type="button" onClick={() => setTab("orders")} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.06]">
                  <span><span className="block text-sm font-medium">Review draft orders</span><span className="mt-0.5 block text-xs text-[#bdb4a8]">{draftOrders.length} need confirmation</span></span>
                  <span className="text-xs font-semibold text-[#dec28f]">Review →</span>
                </button>
              )}
              {quotesNeedingDecision.length === 0 && draftOrders.length === 0 && (
                <p className="text-sm text-[#bdb4a8]">No quote or order needs attention here. Check Accounting for invoice follow-up.</p>
              )}
              <Link href="/accounting#receivables" className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2.5 transition-colors hover:bg-white/[0.06]">
                <span><span className="block text-sm font-medium">View invoices &amp; receivables</span><span className="mt-0.5 block text-xs text-[#bdb4a8]">Posted invoices and payment follow-up stay in Accounting</span></span>
                <span className="text-xs font-semibold text-[#dec28f]">Open →</span>
              </Link>
            </div>
          </Card>
        </>
      )}


      {tab === "quotes" && (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="max-w-full overflow-x-auto pb-1">
              <SegmentedControl
                ariaLabel="Filter quotes by status"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: `All ${quotes.length}` },
                  ...QUOTE_STATUSES.map((s) => ({ value: s, label: `${s[0]!.toUpperCase() + s.slice(1)} ${quotes.filter((q) => q.status === s).length}` })),
                ]}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="relative">
                <span className="sr-only">Search quotes by number, customer, or status</span>
                <input ref={quoteSearchRef} type="search" className="min-h-9 w-56 max-w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm text-[#f6efe5] placeholder:text-[#a69d91] focus:border-gold-500 focus:outline-none focus:ring-2 focus:ring-gold-500/30" placeholder="Search quotes…" value={quoteSearch} onChange={(event) => setQuoteSearch(event.target.value)} />
              </label>
              <span className="hidden text-xs text-[#bdb4a8] sm:inline">Press / to search</span>
              <Button
                tone="secondary"
                size="sm"
                disabled={busy || quotes.every((q) => q.status !== "sent" || !q.expiresAt)}
                onClick={() => void post("/api/quotes", { action: "expire" }, "Expire lapsed quotes")}
                title="Close quotes whose validity date has passed"
              >
                Expire lapsed
              </Button>
            </div>
          </div>
          {searchedQuotes.length === 0 ? (
            <div>
              <EmptyState
                icon={<IconFileText />}
                title={quotes.length === 0 && !quoteSearch ? "No quotes yet" : quoteSearch ? "No matching quotes" : `No ${filter} quotes`}
                hint={
                  quotes.length === 0 && !quoteSearch
                    ? "Create a quote to record the offer and track the customer decision."
                    : quoteSearch
                      ? "Try another customer name, quote number, or clear the search."
                      : "Try another status filter."
                }
              />
              {quoteSearch ? (
                <div className="mt-3 text-center"><Button size="sm" tone="secondary" onClick={() => setQuoteSearch("")}>Clear search</Button></div>
              ) : quotes.length === 0 ? (
                <div className="mt-3 text-center"><Button size="sm" onClick={() => setTab("new")}>Create quote</Button></div>
              ) : null}
            </div>
          ) : (
            searchedQuotes.map((q) => (
              <Card key={q.id}>
                <CardTitle right={<Badge tone={toneFor(q.status)}>{q.status}</Badge>}>
                  Quote #{q.number} · {customerName.get(q.customerId) ?? "Unknown customer"}
                </CardTitle>
                <p className="text-sm text-[#c4bbb0]">
                  {formatMoney(q.totalMinor)} <span className="px-1 text-[#92897e]">·</span> created {timeAgo(q.createdAt)}
                  {q.expiresAt ? <> <span className="px-1 text-[#92897e]">·</span> valid through {formatDate(q.expiresAt)}</> : ""}
                  {q.invoiceId ? <> <span className="px-1 text-[#92897e]">·</span> converted to an invoice</> : ""}
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
                    <Button size="sm" disabled={busy} aria-label={`Accept quote #${q.number}`} onClick={() => setAcceptTarget(q)}>
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
          <CardTitle>Create quote</CardTitle>
          <div className="space-y-2 text-sm">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="quote-customer" className="mb-1 block text-xs font-medium text-[#c4bbb0]">Customer <span className="text-rose-300">*</span></label>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    id="quote-customer"
                    className="select min-w-44 flex-1"
                    value={quoteForm.customerId}
                    onChange={(e) => setQuoteForm({ ...quoteForm, customerId: e.target.value })}
                  >
                    <option value="">Choose a customer…</option>
                    {activeCustomers.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                  <Button tone="ghost" size="sm" onClick={() => setQuickCustomer({ open: !quickCustomer.open, name: "", email: "" })}>
                    + Customer
                  </Button>
                </div>
                {activeCustomers.length === 0 && <p className="mt-1 text-xs text-[#bdb4a8]">Add a customer here to continue.</p>}
              </div>
              <label>
                <span className="mb-1 block text-xs font-medium text-[#c4bbb0]">Memo <span className="font-normal text-[#a69d91]">(optional)</span></span>
                <input
                  className="min-h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm text-[#f6efe5] placeholder:text-[#a69d91] focus:border-gold-500 focus:outline-none focus:ring-2 focus:ring-gold-500/30"
                  placeholder="Add context for the customer"
                  value={quoteForm.memo}
                  onChange={(e) => setQuoteForm({ ...quoteForm, memo: e.target.value })}
                />
              </label>
              <label>
                <span className="mb-1 block text-xs font-medium text-[#c4bbb0]">Valid through <span className="font-normal text-[#a69d91]">(optional)</span></span>
                <input
                  type="date"
                  className="min-h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm text-[#f6efe5] focus:border-gold-500 focus:outline-none focus:ring-2 focus:ring-gold-500/30"
                  value={quoteForm.expiresAt}
                  onChange={(e) => setQuoteForm({ ...quoteForm, expiresAt: e.target.value })}
                />
                <span className="mt-1 block text-xs text-[#a69d91]">Expired quotes can no longer be accepted.</span>
              </label>
            </div>
            {quickCustomer.open && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] p-2">
                <input
                  className="min-h-10 min-w-40 flex-1 rounded-lg border border-white/10 bg-black/20 px-3 text-sm text-[#f6efe5] placeholder:text-[#a69d91]"
                  placeholder="Customer name"
                  aria-label="Customer name"
                  value={quickCustomer.name}
                  onChange={(e) => setQuickCustomer({ ...quickCustomer, name: e.target.value })}
                />
                <input
                  className="min-h-10 w-48 rounded-lg border border-white/10 bg-black/20 px-3 text-sm text-[#f6efe5] placeholder:text-[#a69d91]"
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

            <div className="space-y-2 pt-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="font-medium text-[#f6efe5]">Line items</h2>
                  <p className="text-xs text-[#bdb4a8]">Prices and tax use your workspace currency, totals update as you type.</p>
                </div>
                {products.length === 0 && <Link href="/products" className="text-xs font-medium text-[#dec28f] underline-offset-4 hover:underline">Browse products</Link>}
              </div>
              {quoteForm.lines.map((line, i) => {
                const lineAmounts = draftAmounts([line]);
                const setLine = (patch: Partial<typeof line>) =>
                  setQuoteForm({ ...quoteForm, lines: quoteForm.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
                return (
                  <div key={i} className="grid grid-cols-2 gap-2 rounded-lg border border-white/10 bg-white/[0.02] p-2 sm:grid-cols-12">
                    <label className="col-span-2 sm:col-span-3">
                      <span className="mb-1 block text-[11px] font-medium text-[#bdb4a8]">Catalog item</span>
                      <select className="select w-full" title="Choose a product to fill its description and price" aria-label={`Line ${i + 1} catalog item`} value={products.some((p) => p.sku === line.sku) ? line.sku : ""} onChange={(e) => {
                        const p = products.find((x) => x.sku === e.target.value);
                        if (!p) return;
                        setLine({ sku: p.sku, description: line.description || p.name, unitPrice: p.salePriceMinor != null && p.salePriceMinor > 0 ? minorToInput(p.salePriceMinor) : line.unitPrice });
                      }}>
                        <option value="">{products.length ? "Choose item…" : "Service / custom"}</option>
                        {products.map((p) => <option key={p.sku} value={p.sku}>{p.name} · {p.sku}</option>)}
                      </select>
                    </label>
                    <label className="col-span-2 sm:col-span-4">
                      <span className="mb-1 block text-[11px] font-medium text-[#bdb4a8]">Description</span>
                      <input className="min-h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm text-[#f6efe5] placeholder:text-[#a69d91]" aria-label={`Line ${i + 1} description`} value={line.description} onChange={(e) => setLine({ description: e.target.value })} />
                    </label>
                    <label className="sm:col-span-1">
                      <span className="mb-1 block text-[11px] font-medium text-[#bdb4a8]">Qty</span>
                      <input inputMode="decimal" min="0" className="min-h-10 w-full rounded-lg border border-white/10 bg-black/20 px-2 text-right text-sm text-[#f6efe5]" aria-label={`Line ${i + 1} quantity`} value={line.quantity} onChange={(e) => setLine({ quantity: e.target.value })} />
                    </label>
                    <label className="sm:col-span-2">
                      <span className="mb-1 block text-[11px] font-medium text-[#bdb4a8]">Unit price</span>
                      <input inputMode="decimal" min="0" className="min-h-10 w-full rounded-lg border border-white/10 bg-black/20 px-2 text-right text-sm text-[#f6efe5]" aria-label={`Line ${i + 1} unit price`} value={line.unitPrice} onChange={(e) => setLine({ unitPrice: e.target.value })} />
                    </label>
                    <label className="sm:col-span-1">
                      <span className="mb-1 block text-[11px] font-medium text-[#bdb4a8]">Tax</span>
                      <input inputMode="decimal" min="0" className="min-h-10 w-full rounded-lg border border-white/10 bg-black/20 px-2 text-right text-sm text-[#f6efe5]" aria-label={`Line ${i + 1} tax amount`} value={line.tax} onChange={(e) => setLine({ tax: e.target.value })} />
                    </label>
                    <div className="col-span-2 flex items-center justify-between border-t border-white/10 pt-1 sm:col-span-12">
                      <span className="text-xs text-[#bdb4a8]">Line {i + 1} total</span>
                      <div className="flex items-center gap-2">
                        <strong className="tabular-nums text-[#f6efe5]">{formatMoney(lineAmounts.subtotalMinor + lineAmounts.taxMinor)}</strong>
                        <Button tone="ghost" size="sm" aria-label={`Remove line ${i + 1}`} onClick={() => setQuoteForm({ ...quoteForm, lines: quoteForm.lines.filter((_, j) => j !== i) })}><IconTrash className="size-4" /></Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-3">
              <Button tone="ghost" size="sm" onClick={() => setQuoteForm({ ...quoteForm, lines: [...quoteForm.lines, { ...emptyLine }] })}><IconPlus className="size-4" /> Add line</Button>
              <div className="ml-auto min-w-48 space-y-1 text-right">
                <div className="flex justify-between gap-6 text-xs text-[#bdb4a8]"><span>Subtotal</span><span>{formatMoney(totals.subtotalMinor)}</span></div>
                <div className="flex justify-between gap-6 text-xs text-[#bdb4a8]"><span>Tax</span><span>{formatMoney(totals.taxMinor)}</span></div>
                <div className="flex justify-between gap-6 border-t border-white/10 pt-1 font-semibold text-[#f6efe5]"><span>Total</span><span>{formatMoney(quoteTotalMinor)}</span></div>
                <Button className="mt-2 w-full" disabled={busy || !quoteForm.customerId} onClick={() => void createQuote()}>
                Create quote
                </Button>
              </div>
            </div>
            <p className="text-xs text-[#bdb4a8]">Review the customer, validity date, and total before creating. Accepting a quote records the customer decision and creates its invoice.</p>
          </div>
        </Card>
      )}
      {tab === "customers" && (
        <Card>
          <CardTitle right={<Link href="/crm?tab=customers" className="rounded-md px-2 py-1 text-xs font-medium text-[#dec28f] hover:bg-white/[0.06]">Manage in CRM</Link>}>Customer directory</CardTitle>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <label className="relative min-w-52 flex-1 sm:max-w-sm">
              <span className="sr-only">Search customers by name or email</span>
              <input ref={customerSearchRef} type="search" className="min-h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm text-[#f6efe5] placeholder:text-[#a69d91] focus:border-gold-500 focus:outline-none focus:ring-2 focus:ring-gold-500/30" placeholder="Search customers…" value={customerSearch} onChange={(event) => setCustomerSearch(event.target.value)} />
            </label>
            <span className="hidden text-xs text-[#bdb4a8] sm:inline">Press / to search</span>
            <Link href="/crm?tab=customers" className="rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-[#d4c9bb] transition-colors hover:bg-white/[0.06]">Add customer</Link>
          </div>
          {filteredCustomers.length === 0 ? (
            <EmptyState icon={<IconListTree />} title={activeCustomers.length === 0 ? "No active customers yet" : "No matching customers"} hint={activeCustomers.length === 0 ? "Add a customer in CRM, then come back here to prepare a quote or order." : "Try another name or email address."} />
          ) : (
            <ul className="divide-y divide-white/10">
              {filteredCustomers.map((customer) => (
                <li key={customer.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-40 flex-1">
                    <p className="font-medium text-[#f6efe5]">{customer.name}</p>
                    <p className="mt-0.5 text-sm text-[#bdb4a8]">{customer.email || "No email on file"}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" tone="secondary" onClick={() => {
                      setQuoteForm((form) => ({ ...form, customerId: customer.id }));
                      setTab("new");
                    }}>Create quote</Button>
                    <Link href="/crm?tab=customers" className="rounded-lg px-2 py-1.5 text-xs font-medium text-[#dec28f] hover:bg-white/[0.06]">Open profile</Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {tab === "orders" && (
        <OrdersListTab orders={orders} customers={customers} products={products} busy={busy} post={post} onCreateOrder={() => setTab("new-order")} />
      )}

      {tab === "new-order" && (
        <NewOrderTab orders={orders} customers={customers} products={products} busy={busy} post={post} onDataChanged={load} />
      )}

      <ConfirmDialog
        open={acceptTarget !== null}
        onClose={() => setAcceptTarget(null)}
        onConfirm={() => void acceptQuote()}
        title={`Accept quote #${acceptTarget?.number ?? ""}?`}
        body={acceptTarget ? `This records the customer's acceptance and posts an invoice for ${formatMoney(acceptTarget.totalMinor)}. Posted invoices are part of the accounting records.` : ""}
        confirmLabel="Accept & create invoice"
        busy={busy}
      />

    </AppFrame>
  );
}
