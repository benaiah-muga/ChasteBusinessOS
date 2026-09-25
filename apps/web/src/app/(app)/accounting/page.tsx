"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  CardTitle,
  ConfirmDialog,
  Dialog,
  EmptyState,
  LoadingPage,
  ActionNotice,
  type ActionNoticeState,
  StatCard,
} from "@/components/ui";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconInbox,
  IconLock,
  IconSearch,
  IconSparkle,
  IconUndo,
} from "@/components/icons";
import {
  cn,
  currencyStyleFor,
  formatDate,
  formatDateTime,
  minorToInputIn,
  toMinorIn,
} from "@/lib/format";
import { formatMoneyIn } from "@/lib/prefs";
import { useMoneySync } from "@/lib/money";
import { callApi, postApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";
import { AppFrame } from "../_shell/app-frame";
import { useTabParam } from "@/lib/tab-param";
import { BudgetSection } from "./budget-section";
import { CloseWorkbench } from "./close-workbench";
import { TaxWorkbench } from "./tax-workbench";
import { calculateTaxLine } from "@chaste/erp-core";

interface Entry {
  id: string;
  memo: string;
  sourceType: string | null;
  reversalOfId: string | null;
  postedAt: string;
  actorType: string;
  amountMinor: number;
  currency: string;
}
interface InvoiceRow {
  id: string;
  number: number;
  customerId: string;
  customerName: string;
  currency: string;
  status: string;
  totalMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  issuedAt: string | null;
}
interface PaymentRow {
  id: string;
  invoiceNumber: number;
  amountMinor: number;
  method: string;
  receivedAt: string;
  currency: string;
}
interface Overview {
  entries: Entry[];
  aging: {
    current: number;
    d30: number;
    d60: number;
    d90plus: number;
    totalOutstanding: number;
  };
  agingInvoices: {
    number: number;
    currency: string;
    outstandingMinor: number;
    ageDays: number;
  }[];
  baseCurrency: string;
  foreignReceivablesCount: number;
  foreignPayablesCount: number;
  closedPeriods: { year: number; month: number }[];
  bills: {
    id: string;
    number: number;
    status: string;
    currency: string;
    totalMinor: number;
    paidMinor: number;
    vendorName: string;
    outstandingMinor: number;
  }[];
  filings: Filing[];
  customers?: { id: string; name: string; paymentTermDays: number | null }[];
  invoices?: InvoiceRow[];
  payments?: PaymentRow[];
}
interface Reports {
  baseCurrency: string;
  unsupportedCurrencies?: string[];
  pnl: {
    revenueMinor: number;
    expenseMinor: number;
    netIncomeMinor: number;
    lines: { code: string; name: string; amountMinor: number }[];
  };
  balanceSheet: {
    assetsMinor: number;
    liabilitiesMinor: number;
    equityMinor: number;
    retainedResultMinor: number;
    balanced: boolean;
  };
  cashFlow?: CashFlow | null;
  fxExposure?: {
    exposures: {
      currency: string;
      outstandingForeignMinor: number;
      latestRateNum: number | null;
      latestRateDen: number | null;
      outstandingBaseMinor: number | null;
    }[];
  } | null;
}
interface CashFlow {
  openingMinor: number;
  closingMinor: number;
  netMinor: number;
  cashBalanceMinor: number;
  ties: boolean;
  unsupportedCurrencies?: string[];
  operating: {
    inflowMinor: number;
    outflowMinor: number;
    netMinor: number;
    entries: number;
  };
  investing: {
    inflowMinor: number;
    outflowMinor: number;
    netMinor: number;
    entries: number;
  };
  financing: {
    inflowMinor: number;
    outflowMinor: number;
    netMinor: number;
    entries: number;
  };
}
interface CashBasis {
  cashInMinor: number;
  cashOutMinor: number;
  netCashMinor: number;
  accrualRevenueMinor: number;
  uncollectedMinor: number;
}
interface Filing {
  id: string;
  periodFrom: string;
  periodTo: string;
  taxMinor: number;
  filedAt: string;
}
interface Banking {
  accounts: {
    id: string;
    name: string;
    currencyCode: string;
    last4: string | null;
    balanceMinor: number;
  }[];
  unmatched: {
    id: string;
    bankAccountId: string;
    currencyCode: string;
    postedAt: string;
    amountMinor: number;
    description: string;
  }[];
  matched?: {
    id: string;
    bankAccountId: string;
    currencyCode: string;
    postedAt: string;
    amountMinor: number;
    description: string;
  }[];
  excluded?: {
    id: string;
    bankAccountId: string;
    currencyCode: string;
    postedAt: string;
    amountMinor: number;
    description: string;
  }[];
  payments: {
    id: string;
    invoiceNumber: number | null;
    currencyCode: string;
    customerName: string;
    amountMinor: number;
    receivedAt: string;
  }[];
  summary: {
    accounts: {
      bankAccountId: string;
      name: string;
      count: number;
      moneyInMinor: number;
      moneyOutMinor: number;
    }[];
    unmatchedCount: number;
  };
}
interface ForecastWeek {
  weekStart: string;
  inflowMinor: number;
  outflowMinor: number;
  closeMinor: number;
}
interface Forecast {
  startMinor: number;
  finalMinor: number;
  lowestCloseMinor: number;
  lowestWeekIndex: number;
  scenarioName: string | null;
  minimumCashBufferMinor: number;
  unsupportedCurrencies?: string[];
  weeks: ForecastWeek[];
}
interface TaxCodeOption {
  id: string;
  code: string;
  name: string;
  direction: "input" | "output";
  rateBasisPoints: number;
  priceIncludesTax: boolean;
  active: boolean;
}
interface ReminderDraft {
  customerId: string;
  customerName: string;
  currency: string;
  overdueCount: number;
  oldestDaysOverdue: number;
  totalOverdueMinor: number;
  message: string;
}
interface StatementLine {
  date: string;
  kind: string;
  ref: string;
  amountMinor: number;
  balanceMinor: number;
}
interface StatementView {
  currencies?: {
    currency: string;
    openingBalanceMinor: number;
    closingBalanceMinor: number;
    rows: StatementLine[];
  }[];
}

function capabilityData<T>(value: unknown): T | null {
  if (typeof value !== "object" || value === null) return null;
  const envelope = value as { ok?: unknown; data?: unknown };
  return envelope.ok === true && envelope.data !== undefined
    ? (envelope.data as T)
    : null;
}

function hasCurrencyCode(code: string | null | undefined): code is string {
  return typeof code === "string" && currencyStyleFor(code) !== null;
}

function formatMoneyOrMinor(
  currency: string | null | undefined,
  amountMinor: number,
): string {
  return hasCurrencyCode(currency)
    ? formatMoneyIn(currency, amountMinor)
    : `${amountMinor.toLocaleString()} minor units · currency unavailable`;
}

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "journal", label: "Journal" },
  { id: "receivables", label: "Receivables" },
  { id: "cash", label: "Cash & collections" },
  { id: "budgets", label: "Budgets & scenarios" },
  { id: "payables", label: "Payables" },
  { id: "bank", label: "Bank" },
  { id: "tax", label: "Tax" },
  { id: "reports", label: "Reports" },
  { id: "periods", label: "Periods & close" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function AccountingPage() {
  useMoneySync();
  const __enabled = useModuleEnabled("accounting");
  const router = useRouter();
  const [tab, setTab] = useTabParam(TABS.map((item) => item.id), "overview");
  const [data, setData] = useState<Overview | null>(null);
  const [reports, setReports] = useState<Reports | null>(null);
  const [cash, setCash] = useState<CashBasis | null>(null);
  const [banking, setBanking] = useState<Banking | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");

  const [payTarget, setPayTarget] = useState<Overview["bills"][number] | null>(
    null,
  );
  const [reverseTarget, setReverseTarget] = useState<Entry | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    const year = new Date().getUTCFullYear();
    const [ov, rp, cb, bk] = await Promise.all([
      callApi<Overview>("/api/accounting"),
      callApi<Reports>("/api/reports"),
      fetch("/api/accounting", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "cashBasis", year }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: unknown) => capabilityData<CashBasis>(j)),
      // Banking is auxiliary to this page's core; its absence must not blank the books.
      callApi<Banking>("/api/banking").then((r) => (r.ok ? r.data : null)),
    ]);
    if (!ov.ok || !rp.ok) {
      setLoadError(
        ov.error?.title ?? rp.error?.title ?? "Couldn't load your books",
      );
      return;
    }
    setData(ov.data);
    setReports(rp.data);
    setCash(cb);
    setBanking(bk);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    function onShortcut(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey)
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      )
        return;
      event.preventDefault();
      setTab("journal");
      const url = new URL(window.location.href);
      url.searchParams.set("tab", "journal");
      url.hash = "journal";
      history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLInputElement>("[data-journal-search]")
          ?.focus(),
      );
    }
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);

  function changeTab(id: string) {
    setTab(id as TabId);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", id);
    url.hash = id;
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  async function action(
    payload: Record<string, unknown>,
    label: string,
  ): Promise<boolean> {
    setBusy(true);
    try {
      const res = await postApi("/api/accounting", payload);
      if (res.status === 202) {
        setNotice({
          tone: "pending",
          text: `${label} needs human approval, it's in the Approvals inbox.`,
        });
      } else if (!res.ok) {
        setNotice({
          tone: "error",
          error: res.error ?? {
            title: `${label} didn't complete`,
            hint: "Check the details and try again.",
          },
        });
      } else {
        setNotice({ tone: "success", text: `${label} done.` });
      }
      if (res.ok || res.status === 202) void load();
      return res.ok || res.status === 202;
    } catch {
      setNotice({
        tone: "error",
        error: {
          title: `${label} didn't complete`,
          hint: "Check your connection and try again.",
        },
      });
      return false;
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  async function bankAction(
    payload: Record<string, unknown>,
    label: string,
  ): Promise<boolean> {
    setBusy(true);
    try {
      const res = await postApi("/api/banking", payload);
      if (res.status === 202) {
        setNotice({
          tone: "pending",
          text: `${label} needs human approval, it's in the Approvals inbox.`,
        });
      } else if (!res.ok) {
        setNotice({
          tone: "error",
          error: res.error ?? {
            title: `${label} didn't complete`,
            hint: "Check the details and try again.",
          },
        });
      } else {
        setNotice({ tone: "success", text: `${label} done.` });
      }
      if (res.ok || res.status === 202) void load();
      return res.ok || res.status === 202;
    } catch {
      setNotice({
        tone: "error",
        error: {
          title: `${label} didn't complete`,
          hint: "Check your connection and try again.",
        },
      });
      return false;
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  const filteredEntries = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    if (!q) return data.entries;
    return data.entries.filter(
      (e) =>
        e.memo.toLowerCase().includes(q) ||
        (e.sourceType ?? "manual").toLowerCase().includes(q) ||
        e.actorType.toLowerCase().includes(q),
    );
  }, [data, search]);

  if (loadError && !data) {
    return (
      <AppFrame appId="accounting">
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
      </AppFrame>
    );
  }

  if (!__enabled) return <ModuleDisabled label="Accounting" />;
  if (!data) return <LoadingPage />;

  const a = data.aging;
  const openBills = data.bills.filter((b) => b.outstandingMinor > 0);
  const recentEntries = data.entries.slice(0, 6);

  function askWorkmate() {
    void (async () => {
      const { chatDock, chatDraft } = await import("../chat-widget-state");
      chatDock.set("open");
      chatDraft.set(
        "Walk me through my current financial position: cash, receivables, payables, and anything overdue.",
      );
    })();
  }

  return (
    <AppFrame
      appId="accounting"
      description="Entries are immutable - corrections are mirror reversals. Sealed periods refuse new postings."
      tabs={[
        { id: "overview", label: "Overview", mobileQuick: true },
        { id: "journal", label: "Journal" },
        {
          id: "receivables",
          label: "Receivables",
          count: data?.agingInvoices.length || undefined,
          mobileQuick: true,
        },
        { id: "cash", label: "Cash & collections" },
        { id: "budgets", label: "Budgets" },
        {
          id: "payables",
          label: "Payables",
          count:
            data?.bills.filter((b) => b.outstandingMinor > 0).length ||
            undefined,
          mobileQuick: true,
        },
        {
          id: "bank",
          label: "Bank",
          count: banking?.summary.unmatchedCount || undefined,
        },
        { id: "tax", label: "Tax" },
        { id: "reports", label: "Reports" },
        { id: "periods", label: "Periods & close" },
      ]}
      activeTab={tab}
      onTabChange={changeTab}
      persistKey="accounting"
      actions={
        <>
          <button
            type="button"
            onClick={askWorkmate}
            className="btn btn-md btn-secondary min-h-11 min-w-11 gap-1.5 px-2.5 text-xs sm:gap-2 sm:px-3 sm:text-sm"
            title="Ask your workmate about your position"
            aria-label="Ask workmate"
          >
            <IconSparkle className="size-3.5" />
            <span className="hidden min-[360px]:inline sm:hidden">Ask</span>
            <span className="hidden sm:inline">Ask workmate</span>
          </button>
        </>
      }
    >
      <h1 className="sr-only">Accounting</h1>
      {notice && (
        <ActionNotice state={notice} onDismiss={() => setNotice(null)} />
      )}

      {tab === "overview" && (
        <OverviewTab
          data={data}
          reports={reports}
          cash={cash}
          recentEntries={recentEntries}
          onReverse={setReverseTarget}
          onPay={setPayTarget}
          onTabChange={changeTab}
        />
      )}

      {tab === "journal" && (
        <JournalSection
          data={data}
          filteredEntries={filteredEntries}
          search={search}
          setSearch={setSearch}
          onReverse={setReverseTarget}
        />
      )}

      {tab === "receivables" && (
        <ReceivablesSection
          a={a}
          baseCurrency={data.baseCurrency}
          agingInvoices={data.agingInvoices}
          invoices={data.invoices ?? []}
          payments={data.payments ?? []}
          customers={data.customers ?? []}
          busy={busy}
          onAction={action}
        />
      )}

      {tab === "cash" && (
        <CashSection
          baseCurrency={data.baseCurrency}
          customers={data.customers ?? []}
        />
      )}

      {tab === "budgets" && <BudgetSection baseCurrency={data.baseCurrency} />}

      {tab === "payables" && (
        <PayablesSection
          baseCurrency={data.baseCurrency}
          bills={data.bills}
          openBills={openBills}
          onPay={setPayTarget}
        />
      )}

      {tab === "bank" && (
        <BankSection
          baseCurrency={data.baseCurrency}
          banking={banking}
          busy={busy}
          onAction={bankAction}
        />
      )}

      {tab === "tax" && <TaxWorkbench baseCurrency={data.baseCurrency} />}

      {tab === "reports" && reports?.pnl && (
        <ReportsSection
          reports={reports}
          cash={cash}
          year={new Date().getUTCFullYear()}
          busy={busy}
          onAction={action}
        />
      )}

      {tab === "periods" && (
        <div className="space-y-5">
          <CloseWorkbench
            closedPeriods={data.closedPeriods}
            onRefresh={() => void load()}
          />
          <PeriodsSection
            closedPeriods={data.closedPeriods}
            onCloseYear={(year) =>
              action({ action: "closeYear", year }, `Year-end close ${year}`)
            }
            onReopen={(year, month) =>
              action(
                { action: "reopenPeriod", year, month },
                `Reopen ${year}-${String(month).padStart(2, "0")}`,
              )
            }
            busy={busy}
          />
        </div>
      )}

      {/* Pay bill confirm */}
      <ConfirmDialog
        open={payTarget !== null}
        onClose={() => setPayTarget(null)}
        onConfirm={async () => {
          if (!payTarget || !hasCurrencyCode(payTarget.currency)) return;
          await action(
            {
              action: "payBill",
              billNumber: payTarget.number,
              amountMinor: payTarget.outstandingMinor,
              // One identity per confirmed intent (B02): a double-submit or
              // network retry reconciles to this same receipt.
              intentId: crypto.randomUUID(),
            },
            `Payment of ${formatMoneyOrMinor(payTarget.currency, payTarget.outstandingMinor)}`,
          );
          setPayTarget(null);
        }}
        title="Pay vendor bill"
        body={
          <>
            Pay{" "}
            <strong className="text-stone-900">{payTarget?.vendorName}</strong>{" "}
            the full outstanding{" "}
            <strong className="text-stone-900">
              {payTarget
                ? formatMoneyOrMinor(
                    payTarget.currency,
                    payTarget.outstandingMinor,
                  )
                : ""}
            </strong>
            ? The payment posts as a balanced ledger entry.
          </>
        }
        confirmLabel={`Pay ${payTarget ? formatMoneyOrMinor(payTarget.currency, payTarget.outstandingMinor) : ""}`}
        busy={busy}
      />

      {/* Reverse entry confirm */}
      <ConfirmDialog
        open={reverseTarget !== null}
        onClose={() => setReverseTarget(null)}
        onConfirm={async () => {
          if (!reverseTarget) return;
          await action(
            { action: "reverse", entryId: reverseTarget.id },
            "Reversal",
          );
          setReverseTarget(null);
        }}
        title="Reverse journal entry"
        body={
          <>
            Post a mirror reversal of “{reverseTarget?.memo}” (
            {reverseTarget
              ? formatMoneyIn(reverseTarget.currency, reverseTarget.amountMinor)
              : ""}
            )? The original stays untouched - corrections are always additive.
          </>
        }
        confirmLabel="Post reversal"
        busy={busy}
      />
    </AppFrame>
  );
}

/* ---------------------------------------------------------------- overview -- */

function OverviewTab({
  data,
  reports,
  cash,
  recentEntries,
  onReverse,
  onPay,
  onTabChange,
}: {
  data: Overview;
  reports: Reports | null;
  cash: CashBasis | null;
  recentEntries: Entry[];
  onReverse: (e: Entry) => void;
  onPay: (b: Overview["bills"][number]) => void;
  onTabChange: (id: string) => void;
}) {
  const a = data.aging;
  const openBills = data.bills.filter((b) => b.outstandingMinor > 0);
  const netIncome = reports?.pnl.netIncomeMinor ?? 0;

  return (
    <div className="space-y-10">
      {/* Position: open composition, hairline-separated figures */}
      <section aria-label="Financial position">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3">
          <div>
            <p className="figure-label">Net income · to date</p>
            <p
              className={cn(
                "tnum mt-1 text-[40px] leading-none font-semibold tracking-tight",
                netIncome >= 0 ? "text-stone-900" : "text-red-700",
              )}
            >
              {formatMoneyIn(data.baseCurrency, netIncome)}
            </p>
          </div>
          {reports && (
            <div className="flex items-baseline gap-2 text-sm text-stone-500">
              {reports.balanceSheet.balanced ? (
                <Badge tone="green">books balanced</Badge>
              ) : (
                <Badge tone="red">unbalanced - investigate</Badge>
              )}
              <span>
                Assets{" "}
                {formatMoneyIn(
                  data.baseCurrency,
                  reports.balanceSheet.assetsMinor,
                )}
              </span>
            </div>
          )}
        </div>

        <dl className="mt-6 grid gap-x-8 border-y border-stone-200 py-4 sm:grid-cols-2 lg:grid-cols-4">
          <Figure
            label={`Revenue · ${data.baseCurrency}`}
            value={formatMoneyIn(
              data.baseCurrency,
              reports?.pnl.revenueMinor ?? 0,
            )}
          />
          <Figure
            label={`Expenses · ${data.baseCurrency}`}
            value={formatMoneyIn(
              data.baseCurrency,
              reports?.pnl.expenseMinor ?? 0,
            )}
          />
          <Figure
            label={`Net cash · YTD`}
            value={
              cash ? formatMoneyIn(data.baseCurrency, cash.netCashMinor) : "-"
            }
            tone={cash && cash.netCashMinor < 0 ? "danger" : "default"}
          />
          <Figure
            label="Receivables outstanding"
            value={formatMoneyIn(data.baseCurrency, a.totalOutstanding)}
            note={
              a.d90plus > 0
                ? `${formatMoneyIn(data.baseCurrency, a.d90plus)} past 90d`
                : undefined
            }
            tone={a.d90plus > 0 || a.d60 > 0 ? "warn" : "default"}
          />
        </dl>
        {(data.foreignReceivablesCount > 0 ||
          data.foreignPayablesCount > 0) && (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
            Base-currency totals use {data.baseCurrency}.{" "}
            {data.foreignReceivablesCount} foreign receivable
            {data.foreignReceivablesCount === 1 ? "" : "s"} and{" "}
            {data.foreignPayablesCount} foreign payable
            {data.foreignPayablesCount === 1 ? "" : "s"} are listed in their
            document currencies and excluded from those totals.
          </p>
        )}
      </section>

      {/* Working capital: who owes me / who I owe, with the verbs right there */}
      <section
        aria-label="Working capital"
        className="grid gap-6 lg:grid-cols-2"
      >
        <div>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-stone-800">
              Who owes me
            </h2>
            <button
              type="button"
              onClick={() => onTabChange("receivables")}
              className="cursor-pointer text-[13px] font-medium text-gold-800 hover:underline"
            >
              All receivables →
            </button>
          </div>
          {data.agingInvoices.length === 0 ? (
            <QuietLine>
              No outstanding invoices. Receivables are clear.
            </QuietLine>
          ) : (
            <ul className="divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white shadow-xs">
              {data.agingInvoices.slice(0, 4).map((inv) => (
                <li
                  key={inv.number}
                  className="flex items-center gap-3 px-4 py-2.5 text-sm"
                >
                  <span className="font-medium text-stone-800">
                    Invoice #{inv.number}
                  </span>
                  <span className="tnum ml-auto text-stone-600">
                    {formatMoneyOrMinor(inv.currency, inv.outstandingMinor)}
                  </span>
                  <Badge
                    tone={
                      inv.ageDays > 60
                        ? "red"
                        : inv.ageDays > 30
                          ? "amber"
                          : "neutral"
                    }
                  >
                    {inv.ageDays > 0 ? `${inv.ageDays}d overdue` : "current"}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-stone-800">Who I owe</h2>
            <button
              type="button"
              onClick={() => onTabChange("payables")}
              className="cursor-pointer text-[13px] font-medium text-gold-800 hover:underline"
            >
              All bills →
            </button>
          </div>
          {openBills.length === 0 ? (
            <QuietLine>No vendor bills due. Payables are clear.</QuietLine>
          ) : (
            <ul className="divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white shadow-xs">
              {openBills.slice(0, 4).map((b) => (
                <li
                  key={b.id}
                  className="flex items-center gap-3 px-4 py-2.5 text-sm"
                >
                  <span className="min-w-0 truncate font-medium text-stone-800">
                    {b.vendorName}
                  </span>
                  <span className="tnum ml-auto shrink-0 text-stone-600">
                    {formatMoneyOrMinor(b.currency, b.outstandingMinor)}
                  </span>
                  <Button
                    tone="ghost"
                    size="sm"
                    disabled={!hasCurrencyCode(b.currency)}
                    title={
                      !hasCurrencyCode(b.currency)
                        ? "Bill currency is unavailable."
                        : undefined
                    }
                    onClick={() => onPay(b)}
                  >
                    Pay
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Recent postings */}
      <section aria-label="Recent postings">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-stone-800">
            Recent postings
          </h2>
          <button
            type="button"
            onClick={() => onTabChange("journal")}
            className="cursor-pointer inline-flex items-center gap-0.5 text-[13px] font-medium text-gold-800 hover:underline"
          >
            Full journal
            <IconArrowRight className="size-3" />
          </button>
        </div>
        {recentEntries.length === 0 ? (
          <EmptyState
            icon={<IconUndo />}
            title="No journal entries yet"
            hint="Post an invoice, bill, sale, or payroll run - or just ask your workmate below."
          />
        ) : (
          <ol className="divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white shadow-xs">
            {recentEntries.map((e) => {
              const isReversal = e.sourceType === "reversal";
              return (
                <li
                  key={e.id}
                  className={cn(
                    "flex items-center gap-3 px-4 py-2.5 text-sm",
                    isReversal && "bg-amber-50/50",
                  )}
                >
                  <span
                    className="min-w-0 flex-1 truncate font-medium text-stone-800"
                    title={e.memo}
                  >
                    {isReversal && (
                      <IconUndo className="mr-1.5 inline size-3.5 -translate-y-px text-amber-700" />
                    )}
                    {e.memo}
                  </span>
                  <Badge tone={e.actorType === "agent" ? "violet" : "neutral"}>
                    {e.actorType}
                  </Badge>
                  <time
                    className="hidden w-24 shrink-0 text-right text-xs text-stone-600 sm:block"
                    title={formatDateTime(e.postedAt)}
                  >
                    {formatDateTime(e.postedAt)}
                  </time>
                  <span className="tnum w-24 shrink-0 text-right font-medium">
                    {formatMoneyOrMinor(e.currency, e.amountMinor)}
                  </span>
                  {!isReversal &&
                    !data.entries.some((x) => x.reversalOfId === e.id) && (
                      <Button
                        tone="ghost"
                        size="sm"
                        onClick={() => onReverse(e)}
                      >
                        Reverse
                      </Button>
                    )}
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}

function Figure({
  label,
  value,
  note,
  tone = "default",
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "default" | "warn" | "danger";
}) {
  return (
    <div>
      <dt className="figure-label">{label}</dt>
      <dd className="mt-1 flex items-baseline gap-2">
        <span
          className={cn(
            "tnum text-lg font-semibold",
            tone === "default" && "text-stone-900",
            tone === "warn" && "text-amber-700",
            tone === "danger" && "text-red-700",
          )}
        >
          {value}
        </span>
        {note && (
          <span className="text-xs font-medium text-amber-700">{note}</span>
        )}
      </dd>
    </div>
  );
}

function QuietLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 rounded-xl border border-dashed border-stone-200 px-4 py-4 text-sm text-stone-600">
      <IconInbox className="size-4" />
      {children}
    </p>
  );
}

/* ----------------------------------------------------------------- journal -- */

function JournalSection({
  data,
  filteredEntries,
  search,
  setSearch,
  onReverse,
}: {
  data: Overview;
  filteredEntries: Entry[];
  search: string;
  setSearch: (v: string) => void;
  onReverse: (e: Entry) => void;
}) {
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-sm font-semibold text-stone-800">
          Journal entries
        </h2>
        <label className="relative">
          <span className="sr-only">Search journal entries</span>
          <IconSearch className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-stone-400" />
          <input
            data-journal-search
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search memo, source, actor…"
            className="input h-8 w-64 pl-8 text-xs"
          />
        </label>
      </div>
      <p className="-mt-1 mb-3 text-xs text-stone-500">
        Showing {filteredEntries.length} of the latest {data.entries.length}{" "}
        entries. Press / to search.
      </p>

      {data.closedPeriods.length > 0 && (
        <p className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-stone-500">
          <IconLock className="size-3.5" /> Sealed:
          {data.closedPeriods.map((p) => (
            <Badge key={`${p.year}-${p.month}`}>
              {p.year}-{String(p.month).padStart(2, "0")}
            </Badge>
          ))}
        </p>
      )}

      {filteredEntries.length === 0 ? (
        <EmptyState
          icon={<IconUndo />}
          title={search ? "No entries match" : "No journal entries yet"}
          hint={
            search
              ? "Try a different filter."
              : "Post an invoice, bill, sale, or payroll run - or just ask your workmate."
          }
        />
      ) : (
        <div className="table-shell">
          <table className="data-table">
            <thead>
              <tr>
                <th>Memo</th>
                <th>Source</th>
                <th>By</th>
                <th>When</th>
                <th className="text-right">Amount</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {filteredEntries.map((e) => {
                const reversed = data.entries.some(
                  (x) => x.reversalOfId === e.id,
                );
                const isReversal = e.sourceType === "reversal";
                return (
                  <tr
                    key={e.id}
                    className={isReversal ? "bg-amber-50/50" : undefined}
                  >
                    <td
                      className="max-w-xs truncate font-medium text-stone-800"
                      title={e.memo}
                    >
                      {isReversal && (
                        <IconUndo className="mr-1.5 inline size-3.5 -translate-y-px text-amber-700" />
                      )}
                      {e.memo}
                    </td>
                    <td className="font-mono text-xs text-stone-500">
                      {e.sourceType ?? "manual"}
                    </td>
                    <td>
                      <Badge
                        tone={e.actorType === "agent" ? "violet" : "neutral"}
                      >
                        {e.actorType}
                      </Badge>
                    </td>
                    <td
                      className="text-xs whitespace-nowrap text-stone-500"
                      title={formatDateTime(e.postedAt)}
                    >
                      {formatDateTime(e.postedAt)}
                    </td>
                    <td className="num font-medium">
                      {formatMoneyOrMinor(e.currency, e.amountMinor)}
                    </td>
                    <td className="text-right whitespace-nowrap">
                      {!isReversal && !reversed && (
                        <Button
                          tone="ghost"
                          size="sm"
                          onClick={() => onReverse(e)}
                        >
                          Reverse
                        </Button>
                      )}
                      {reversed && (
                        <span className="text-xs text-stone-400">reversed</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------- receivables/payables */

function invoicePreviewTotals(
  lines: {
    description: string;
    quantity: string;
    unitPrice: string;
    tax: string;
    taxCodeId?: string;
  }[],
  currency: string,
  taxCodes: TaxCodeOption[] = [],
): { subtotalMinor: number; taxMinor: number; totalMinor: number } | null {
  let subtotal = 0n;
  let tax = 0n;
  let hasLine = false;
  for (const line of lines) {
    if (!line.description.trim()) continue;
    hasLine = true;
    const quantity = Math.round(Number(line.quantity || "0") * 1000);
    const unitPriceMinor = toMinorIn(currency, line.unitPrice);
    if (
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      !Number.isSafeInteger(unitPriceMinor) ||
      unitPriceMinor < 0
    )
      return null;
    const taxCode = line.taxCodeId
      ? taxCodes.find((code) => code.id === line.taxCodeId)
      : undefined;
    const calculated = taxCode
      ? calculateTaxLine(
          quantity,
          unitPriceMinor,
          taxCode.rateBasisPoints,
          taxCode.priceIncludesTax,
        )
      : null;
    const taxMinor = calculated?.taxMinor ?? toMinorIn(currency, line.tax);
    const lineSubtotal =
      calculated?.netMinor ??
      Number((BigInt(quantity) * BigInt(unitPriceMinor) + 500n) / 1000n);
    if (
      !Number.isSafeInteger(taxMinor) ||
      taxMinor < 0 ||
      !Number.isSafeInteger(lineSubtotal)
    )
      return null;
    subtotal += BigInt(lineSubtotal);
    tax += BigInt(taxMinor);
  }
  const total = subtotal + tax;
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (
    !hasLine ||
    total <= 0n ||
    [subtotal, tax, total].some((amount) => amount > limit)
  )
    return null;
  return {
    subtotalMinor: Number(subtotal),
    taxMinor: Number(tax),
    totalMinor: Number(total),
  };
}

function ReceivablesSection({
  a,
  baseCurrency,
  agingInvoices,
  invoices,
  payments,
  customers,
  busy,
  onAction,
}: {
  a: Overview["aging"];
  baseCurrency: string;
  agingInvoices: Overview["agingInvoices"];
  invoices: InvoiceRow[];
  payments: PaymentRow[];
  customers: { id: string; name: string; paymentTermDays: number | null }[];
  busy: boolean;
  onAction: (
    payload: Record<string, unknown>,
    label: string,
  ) => Promise<boolean>;
}) {
  const [emailFor, setEmailFor] = useState<number | null>(null);
  const [emailTo, setEmailTo] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailNote, setEmailNote] = useState<string | null>(null);

  // New invoice
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [taxCodes, setTaxCodes] = useState<TaxCodeOption[]>([]);
  const [invoiceForm, setInvoiceForm] = useState({
    customerId: "",
    memo: "",
    lines: [
      {
        description: "",
        quantity: "1",
        unitPrice: "0",
        tax: "0",
        taxCodeId: "",
      },
    ],
    currency: "",
    dueAt: "",
  });

  // Pay / credit / reverse
  const [payFor, setPayFor] = useState<InvoiceRow | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState<"bank_transfer" | "cash" | "card">(
    "bank_transfer",
  );
  const [creditFor, setCreditFor] = useState<InvoiceRow | null>(null);
  const [creditForm, setCreditForm] = useState({ amount: "", reason: "" });
  const [reverseFor, setReverseFor] = useState<PaymentRow | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const invoiceCurrency =
    invoiceForm.currency.trim().toUpperCase() || baseCurrency;
  const invoiceDigits = currencyStyleFor(invoiceCurrency)?.minorUnits ?? 2;
  const amountPlaceholder =
    invoiceDigits === 0 ? "0" : `0.${"0".repeat(invoiceDigits)}`;
  const preview = useMemo(
    () => invoicePreviewTotals(invoiceForm.lines, invoiceCurrency, taxCodes),
    [invoiceForm.lines, invoiceCurrency, taxCodes],
  );
  const enteredPayMinor = payFor
    ? toMinorIn(payFor.currency, payAmount)
    : Number.NaN;
  const enteredCreditMinor = creditFor
    ? toMinorIn(creditFor.currency, creditForm.amount)
    : Number.NaN;

  useEffect(() => {
    let cancelled = false;
    void callApi<{ codes?: TaxCodeOption[] }>("/api/accounting/tax").then(
      (res) => {
        if (!cancelled && res.ok)
          setTaxCodes(
            (res.data?.codes ?? []).filter(
              (code) => code.active && code.direction === "output",
            ),
          );
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  async function sendInvoice(number: number) {
    setEmailBusy(true);
    setEmailNote(null);
    const res = await postApi<{ sent?: boolean; reason?: string }>(
      "/api/email",
      {
        action: "emailInvoice",
        invoiceNumber: number,
        to: emailTo.trim(),
      },
    );
    setEmailBusy(false);
    if (res.ok) {
      setEmailFor(null);
      setEmailTo("");
      setEmailNote(`Invoice #${number} sent.`);
    } else {
      setEmailNote(
        res.error?.title ?? "Couldn't send - is SMTP configured in Settings?",
      );
    }
  }

  function createInvoice() {
    const lines = invoiceForm.lines
      .map((l) => {
        const line = {
          description: l.description.trim(),
          quantity: Math.round(Number(l.quantity || "0") * 1000),
          unitPriceMinor: toMinorIn(invoiceCurrency, l.unitPrice),
        };
        return l.taxCodeId
          ? { ...line, taxCodeId: l.taxCodeId }
          : { ...line, taxMinor: toMinorIn(invoiceCurrency, l.tax) };
      })
      .filter((l) => l.description.length > 0 && l.quantity > 0);
    if (
      !invoiceForm.customerId ||
      lines.length === 0 ||
      !preview ||
      lines.some(
        (l) =>
          !Number.isSafeInteger(l.unitPriceMinor) ||
          ("taxMinor" in l && !Number.isSafeInteger(l.taxMinor)),
      )
    )
      return;
    void onAction(
      {
        action: "createInvoice",
        customerId: invoiceForm.customerId,
        memo: invoiceForm.memo.trim() || undefined,
        lines,
        currency:
          invoiceCurrency === baseCurrency ? undefined : invoiceCurrency,
        dueAt: invoiceForm.dueAt
          ? new Date(`${invoiceForm.dueAt}T12:00:00Z`).toISOString()
          : undefined,
      },
      "Invoice posted",
    ).then((accepted) => {
      if (!accepted) return;
      setInvoiceOpen(false);
      setInvoiceForm({
        customerId: "",
        memo: "",
        lines: [
          {
            description: "",
            quantity: "1",
            unitPrice: "0",
            tax: "0",
            taxCodeId: "",
          },
        ],
        currency: "",
        dueAt: "",
      });
    });
  }

  const outstanding = invoices.filter(
    (i) => i.outstandingMinor > 0 && i.status !== "void",
  );

  return (
    <section>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <StatCard
          label="Current"
          value={formatMoneyIn(baseCurrency, a.current)}
        />
        <StatCard
          label="31–60 days"
          value={formatMoneyIn(baseCurrency, a.d30)}
          tone={a.d30 > 0 ? "warn" : "default"}
        />
        <StatCard
          label="61–90 days"
          value={formatMoneyIn(baseCurrency, a.d60)}
          tone={a.d60 > 0 ? "warn" : "default"}
        />
        <StatCard
          label="90+ days"
          value={formatMoneyIn(baseCurrency, a.d90plus)}
          tone={a.d90plus > 0 ? "danger" : "default"}
        />
        <StatCard
          label={`Total outstanding · ${baseCurrency}`}
          value={formatMoneyIn(baseCurrency, a.totalOutstanding)}
          tone="accent"
          className="col-span-2 sm:col-span-1"
        />
      </div>
      {agingInvoices.some((invoice) => invoice.currency !== baseCurrency) && (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
          Aging totals include {baseCurrency} invoices only. Foreign invoices
          remain listed in their document currency and are excluded until
          converted.
        </p>
      )}

      <div className="mt-4 flex justify-end">
        <Button onClick={() => setInvoiceOpen(true)}>New invoice…</Button>
      </div>

      {/* Full invoice ledger */}
      {invoices.length === 0 ? (
        <QuietLine>
          No invoices yet - issue your first one above, or accept a quote in
          Sales.
        </QuietLine>
      ) : (
        <div className="table-shell mt-4">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Customer</th>
                <th>Status</th>
                <th className="text-right">Total</th>
                <th className="text-right">Outstanding</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => {
                const age = agingInvoices.find((x) => x.number === inv.number);
                const invoiceCurrency = hasCurrencyCode(inv.currency)
                  ? inv.currency
                  : null;
                return (
                  <tr key={inv.id}>
                    <td className="tnum">{inv.number}</td>
                    <td className="font-medium text-stone-800">
                      {inv.customerName}
                    </td>
                    <td>
                      <Badge
                        tone={
                          inv.status === "paid"
                            ? "green"
                            : inv.status === "void"
                              ? "red"
                              : "amber"
                        }
                      >
                        {inv.status}
                      </Badge>
                      {age && inv.status === "sent" && age.ageDays > 0 && (
                        <span className="ml-1.5 text-xs text-stone-400">
                          {age.ageDays}d overdue
                        </span>
                      )}
                    </td>
                    <td className="num">
                      {formatMoneyOrMinor(invoiceCurrency, inv.totalMinor)}
                    </td>
                    <td className="num font-medium">
                      {formatMoneyOrMinor(
                        invoiceCurrency,
                        inv.outstandingMinor,
                      )}
                    </td>
                    <td className="text-right whitespace-nowrap">
                      {inv.outstandingMinor > 0 &&
                        inv.status !== "void" &&
                        (invoiceCurrency ? (
                          <span className="inline-flex gap-1.5">
                            <Button
                              tone="secondary"
                              size="sm"
                              disabled={busy}
                              onClick={() => {
                                setPayFor(inv);
                                setPayAmount(
                                  minorToInputIn(
                                    invoiceCurrency,
                                    inv.outstandingMinor,
                                  ),
                                );
                              }}
                            >
                              Pay
                            </Button>
                            <Button
                              tone="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() => {
                                setCreditFor(inv);
                                setCreditForm({
                                  amount: minorToInputIn(
                                    invoiceCurrency,
                                    inv.outstandingMinor,
                                  ),
                                  reason: "",
                                });
                              }}
                            >
                              Credit
                            </Button>
                          </span>
                        ) : (
                          <span
                            className="text-xs text-amber-800"
                            title="Refresh after the accounting service returns the invoice currency."
                          >
                            Money actions unavailable: currency missing
                          </span>
                        ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Overdue aging list */}
      {agingInvoices.length > 0 && (
        <ul className="mt-4 divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white px-4 shadow-xs">
          {agingInvoices.map((inv) => (
            <li key={inv.number} className="py-2.5 text-sm">
              <div className="flex items-center gap-3">
                <span className="font-medium text-stone-800">
                  Invoice #{inv.number}
                </span>
                <span className="tnum ml-auto text-stone-600">
                  {formatMoneyOrMinor(inv.currency, inv.outstandingMinor)}
                </span>
                <Badge
                  tone={
                    inv.ageDays > 60
                      ? "red"
                      : inv.ageDays > 30
                        ? "amber"
                        : "neutral"
                  }
                >
                  {inv.ageDays}d overdue
                </Badge>
                <button
                  type="button"
                  aria-label={`Email invoice ${inv.number}`}
                  title="Email this invoice to the customer"
                  onClick={() =>
                    setEmailFor(emailFor === inv.number ? null : inv.number)
                  }
                  className="cursor-pointer rounded p-1 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
                >
                  ✉
                </button>
              </div>
              {emailFor === inv.number && (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 p-2">
                  <input
                    aria-label={`Recipient for invoice ${inv.number}`}
                    type="email"
                    placeholder="customer@example.com"
                    value={emailTo}
                    onChange={(e) => setEmailTo(e.target.value)}
                    className="min-w-48 flex-1 rounded border border-stone-200 bg-white px-2 py-1.5 text-xs outline-none focus:border-stone-400"
                  />
                  <Button
                    size="sm"
                    disabled={emailBusy || !/.+@.+\..+/.test(emailTo)}
                    onClick={() => void sendInvoice(inv.number)}
                  >
                    Send with share link
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Payments received */}
      <Card className="mt-6">
        <CardTitle
          right={
            <span className="text-xs text-stone-500">
              {outstanding.length} invoice{outstanding.length === 1 ? "" : "s"}{" "}
              open
            </span>
          }
        >
          Payments received
        </CardTitle>
        {payments.length === 0 ? (
          <QuietLine>
            No payments recorded yet - hit Pay on an invoice above.
          </QuietLine>
        ) : (
          <div className="table-shell">
            <table className="data-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Invoice</th>
                  <th>Method</th>
                  <th className="text-right">Amount</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td
                      className="text-xs whitespace-nowrap text-stone-500"
                      title={formatDateTime(p.receivedAt)}
                    >
                      {formatDate(p.receivedAt)}
                    </td>
                    <td className="tnum">#{p.invoiceNumber}</td>
                    <td className="font-mono text-xs text-stone-500">
                      {p.method}
                    </td>
                    <td className="num font-medium">
                      {formatMoneyOrMinor(p.currency, p.amountMinor)}
                    </td>
                    <td className="text-right">
                      <Button
                        tone="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setReverseFor(p);
                          setReverseReason("");
                        }}
                      >
                        Reverse
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-stone-500">
          Reversals mirror the payment&apos;s entries and release the invoice
          balance - always approval-gated.
        </p>
      </Card>
      {emailNote && <p className="mt-2 text-xs text-stone-500">{emailNote}</p>}

      {/* New invoice dialog */}
      <Dialog
        open={invoiceOpen}
        onClose={() => setInvoiceOpen(false)}
        title="New invoice"
        description="Posts the receivable and revenue to the ledger immediately - posted documents are immutable, corrections go through credit notes."
        width="max-w-2xl"
        footer={
          <>
            <Button
              tone="secondary"
              onClick={() => setInvoiceOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={!invoiceForm.customerId || !preview}
              onClick={createInvoice}
            >
              Post invoice
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap gap-2">
            <select
              className="select"
              aria-label="Customer"
              value={invoiceForm.customerId}
              onChange={(e) =>
                setInvoiceForm({ ...invoiceForm, customerId: e.target.value })
              }
            >
              <option value="">Customer…</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input
              className="min-w-40 flex-1 rounded border bg-transparent px-2 py-1.5"
              placeholder="Memo (optional)"
              aria-label="Memo"
              value={invoiceForm.memo}
              onChange={(e) =>
                setInvoiceForm({ ...invoiceForm, memo: e.target.value })
              }
            />
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-stone-500">
            <label className="flex items-center gap-1">
              Currency
              <input
                className="w-16 rounded border bg-transparent px-1.5 py-1 uppercase"
                placeholder={baseCurrency}
                aria-label="Invoice currency code"
                value={invoiceForm.currency}
                onChange={(e) =>
                  setInvoiceForm({
                    ...invoiceForm,
                    currency: e.target.value.toUpperCase(),
                  })
                }
              />
              <span className="text-stone-400">
                Amounts in {invoiceCurrency}
              </span>
            </label>
            <label className="flex items-center gap-1">
              Due
              <input
                type="date"
                className="rounded border bg-transparent px-1.5 py-1"
                aria-label="Due date"
                value={invoiceForm.dueAt}
                onChange={(e) =>
                  setInvoiceForm({ ...invoiceForm, dueAt: e.target.value })
                }
              />
            </label>
          </div>
          <p className="text-xs text-stone-500">
            A blank due date uses the selected customer&apos;s payment terms.
          </p>
          {invoiceForm.currency.trim() &&
            !currencyStyleFor(invoiceCurrency) && (
              <p role="alert" className="text-xs text-red-700">
                {invoiceCurrency} is not a supported currency code.
              </p>
            )}
          {invoiceForm.lines.map((l, i) => {
            const setLine = (patch: Partial<typeof l>) =>
              setInvoiceForm({
                ...invoiceForm,
                lines: invoiceForm.lines.map((x, j) =>
                  j === i ? { ...x, ...patch } : x,
                ),
              });
            return (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <input
                  className="min-w-40 flex-1 rounded border bg-transparent px-2 py-1.5"
                  placeholder={`Line ${i + 1} description`}
                  aria-label={`Line ${i + 1} description`}
                  value={l.description}
                  onChange={(e) => setLine({ description: e.target.value })}
                />
                <input
                  className="w-20 rounded border bg-transparent px-2 py-1.5 text-right"
                  placeholder="Qty"
                  aria-label={`Line ${i + 1} quantity`}
                  value={l.quantity}
                  onChange={(e) => setLine({ quantity: e.target.value })}
                />
                <input
                  className="w-24 rounded border bg-transparent px-2 py-1.5 text-right"
                  placeholder={amountPlaceholder}
                  aria-label={`Line ${i + 1} unit price`}
                  value={l.unitPrice}
                  onChange={(e) => setLine({ unitPrice: e.target.value })}
                />
                {taxCodes.length > 0 && (
                  <select
                    className="select max-w-36"
                    aria-label={`Line ${i + 1} tax code`}
                    value={l.taxCodeId}
                    onChange={(e) => setLine({ taxCodeId: e.target.value })}
                  >
                    <option value="">Manual tax</option>
                    {taxCodes.map((code) => (
                      <option key={code.id} value={code.id}>
                        {code.code} · {(code.rateBasisPoints / 100).toFixed(2)}%
                      </option>
                    ))}
                  </select>
                )}
                {!l.taxCodeId && (
                  <input
                    className="w-20 rounded border bg-transparent px-2 py-1.5 text-right"
                    placeholder={amountPlaceholder}
                    aria-label={`Line ${i + 1} tax`}
                    value={l.tax}
                    onChange={(e) => setLine({ tax: e.target.value })}
                  />
                )}
                {l.taxCodeId && (
                  <span className="w-20 text-right text-xs text-stone-500">
                    Code applied
                  </span>
                )}
                <Button
                  tone="ghost"
                  size="sm"
                  aria-label={`Remove line ${i + 1}`}
                  onClick={() =>
                    setInvoiceForm({
                      ...invoiceForm,
                      lines: invoiceForm.lines.filter((_, j) => j !== i),
                    })
                  }
                >
                  ✕
                </Button>
              </div>
            );
          })}
          <Button
            tone="ghost"
            size="sm"
            onClick={() =>
              setInvoiceForm({
                ...invoiceForm,
                lines: [
                  ...invoiceForm.lines,
                  {
                    description: "",
                    quantity: "1",
                    unitPrice: "0",
                    tax: "0",
                    taxCodeId: "",
                  },
                ],
              })
            }
          >
            + Line
          </Button>
          <dl className="grid grid-cols-2 gap-2 rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-stone-500">Subtotal</dt>
              <dd className="tnum mt-1 font-medium">
                {preview
                  ? formatMoneyIn(invoiceCurrency, preview.subtotalMinor)
                  : "-"}
              </dd>
            </div>
            <div>
              <dt className="text-stone-500">Tax</dt>
              <dd className="tnum mt-1 font-medium">
                {preview
                  ? formatMoneyIn(invoiceCurrency, preview.taxMinor)
                  : "-"}
              </dd>
            </div>
            <div>
              <dt className="text-stone-500">Total</dt>
              <dd className="tnum mt-1 text-sm font-semibold text-stone-900">
                {preview
                  ? formatMoneyIn(invoiceCurrency, preview.totalMinor)
                  : "Complete a valid line to see the total"}
              </dd>
            </div>
          </dl>
        </div>
      </Dialog>

      {/* Record payment dialog */}
      <Dialog
        open={payFor !== null}
        onClose={() => setPayFor(null)}
        title={`Record payment - invoice #${payFor?.number ?? ""}`}
        description="Posts cash to the ledger and settles the invoice balance. Payments above the policy threshold wait for approval."
        footer={
          <>
            <Button
              tone="secondary"
              onClick={() => setPayFor(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={
                !Number.isSafeInteger(enteredPayMinor) ||
                enteredPayMinor <= 0 ||
                (payFor !== null && enteredPayMinor > payFor.outstandingMinor)
              }
              onClick={() => {
                if (!payFor) return;
                void onAction(
                  {
                    action: "recordPayment",
                    invoiceNumber: payFor.number,
                    amountMinor: enteredPayMinor,
                    method: payMethod,
                  },
                  `Payment on invoice #${payFor.number}`,
                ).then((accepted) => {
                  if (accepted) setPayFor(null);
                });
              }}
            >
              Record payment
            </Button>
          </>
        }
      >
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <div>
            <label htmlFor="pay-amount" className="label">
              Amount received
            </label>
            <input
              id="pay-amount"
              inputMode="decimal"
              className="input tnum w-32"
              value={payAmount}
              onChange={(e) => setPayAmount(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="pay-method" className="label">
              Method
            </label>
            <select
              id="pay-method"
              className="select"
              value={payMethod}
              onChange={(e) => setPayMethod(e.target.value as typeof payMethod)}
            >
              <option value="bank_transfer">Bank transfer</option>
              <option value="cash">Cash</option>
              <option value="card">Card</option>
            </select>
          </div>
          {payFor && (
            <span className="pb-2 text-xs text-stone-500">
              Outstanding{" "}
              {formatMoneyOrMinor(payFor.currency, payFor.outstandingMinor)}
            </span>
          )}
          {payFor &&
            Number.isSafeInteger(enteredPayMinor) &&
            enteredPayMinor > payFor.outstandingMinor && (
              <p role="alert" className="basis-full text-xs text-red-700">
                Payment exceeds this invoice&apos;s outstanding balance.
              </p>
            )}
        </div>
      </Dialog>

      {/* Credit note dialog */}
      <Dialog
        open={creditFor !== null}
        onClose={() => setCreditFor(null)}
        title={`Credit invoice #${creditFor?.number ?? ""} - ${creditFor?.customerName ?? ""}`}
        description="Concedes part of the invoice through an approved reversing entry; the invoice itself is never edited."
        footer={
          <>
            <Button
              tone="secondary"
              onClick={() => setCreditFor(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              tone="danger"
              loading={busy}
              disabled={
                !Number.isSafeInteger(enteredCreditMinor) ||
                enteredCreditMinor <= 0 ||
                !creditFor ||
                enteredCreditMinor > creditFor.outstandingMinor ||
                creditForm.reason.trim().length < 3
              }
              onClick={() => {
                if (!creditFor) return;
                void onAction(
                  {
                    action: "creditNote",
                    invoiceId: creditFor.id,
                    amountMinor: enteredCreditMinor,
                    reason: creditForm.reason.trim(),
                  },
                  `Credit on invoice #${creditFor.number}`,
                ).then((accepted) => {
                  if (accepted) setCreditFor(null);
                });
              }}
            >
              Apply credit
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-sm">
          <div>
            <label htmlFor="credit-amount" className="label">
              Amount to credit
            </label>
            <input
              id="credit-amount"
              inputMode="decimal"
              className="input tnum w-32"
              value={creditForm.amount}
              onChange={(e) =>
                setCreditForm({ ...creditForm, amount: e.target.value })
              }
            />
          </div>
          <div>
            <label htmlFor="credit-reason" className="label">
              Reason
            </label>
            <input
              id="credit-reason"
              className="input"
              placeholder="e.g. goodwill for late delivery"
              value={creditForm.reason}
              onChange={(e) =>
                setCreditForm({ ...creditForm, reason: e.target.value })
              }
            />
          </div>
        </div>
      </Dialog>

      {/* Reverse payment dialog */}
      <Dialog
        open={reverseFor !== null}
        onClose={() => setReverseFor(null)}
        title={`Reverse payment on invoice #${reverseFor?.invoiceNumber ?? ""}`}
        description="Mirrors the payment's journal entries, releases the invoice balance, and lets you record a corrected payment."
        footer={
          <>
            <Button
              tone="secondary"
              onClick={() => setReverseFor(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              tone="danger"
              loading={busy}
              disabled={reverseReason.trim().length < 3}
              onClick={() => {
                if (!reverseFor) return;
                void onAction(
                  {
                    action: "reversePayment",
                    paymentId: reverseFor.id,
                    reason: reverseReason.trim(),
                  },
                  `Reverse payment on invoice #${reverseFor.invoiceNumber}`,
                ).then((accepted) => {
                  if (accepted) setReverseFor(null);
                });
              }}
            >
              Reverse (needs approval)
            </Button>
          </>
        }
      >
        <div>
          <label htmlFor="reverse-reason" className="label">
            Reason
          </label>
          <input
            id="reverse-reason"
            className="input"
            placeholder="e.g. customer paid twice"
            value={reverseReason}
            onChange={(e) => setReverseReason(e.target.value)}
          />
        </div>
      </Dialog>
    </section>
  );
}

function PayablesSection({
  baseCurrency,
  bills,
  openBills,
  onPay,
}: {
  baseCurrency: string;
  bills: Overview["bills"];
  openBills: Overview["bills"];
  onPay: (b: Overview["bills"][number]) => void;
}) {
  const total = openBills
    .filter((bill) => bill.currency === baseCurrency)
    .reduce((s, b) => s + b.outstandingMinor, 0);
  const foreignCount = openBills.filter(
    (bill) => bill.currency !== baseCurrency,
  ).length;
  if (bills.length === 0)
    return (
      <EmptyState
        icon={<IconInbox />}
        title="No vendor bills yet"
        hint="Record a bill from Purchasing, or ask your workmate to log one."
        action={
          <Link className="btn btn-md btn-secondary" href="/purchasing">
            Open Purchasing
          </Link>
        }
      />
    );
  return (
    <section>
      <p className="mb-3 text-sm text-stone-500">
        Outstanding in {baseCurrency}:{" "}
        <strong className="tnum font-medium text-stone-900">
          {formatMoneyIn(baseCurrency, total)}
        </strong>{" "}
        across {openBills.length} bill{openBills.length === 1 ? "" : "s"}.
      </p>
      {foreignCount > 0 && (
        <p className="mb-3 text-xs text-amber-800">
          {foreignCount} foreign-currency bill
          {foreignCount === 1 ? " is" : "s are"} shown separately and excluded
          from this base-currency total.
        </p>
      )}
      <div className="table-shell">
        <table className="data-table">
          <thead>
            <tr>
              <th>Bill #</th>
              <th>Vendor</th>
              <th>Status</th>
              <th className="text-right">Outstanding</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {bills.map((b) => (
              <tr key={b.id}>
                <td className="tnum">{b.number}</td>
                <td className="font-medium text-stone-800">{b.vendorName}</td>
                <td>
                  <Badge>{b.status}</Badge>
                </td>
                <td className="num font-medium">
                  {formatMoneyOrMinor(b.currency, b.outstandingMinor)}
                </td>
                <td className="text-right">
                  {b.outstandingMinor > 0 && (
                    <Button
                      tone="secondary"
                      size="sm"
                      disabled={!hasCurrencyCode(b.currency)}
                      title={
                        !hasCurrencyCode(b.currency)
                          ? "Bill currency is unavailable."
                          : undefined
                      }
                      onClick={() => onPay(b)}
                    >
                      Pay in full
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- reports -- */

function ReportsSection({
  reports,
  cash,
  year,
  busy,
  onAction,
}: {
  reports: Reports;
  cash: CashBasis | null;
  year: number;
  busy: boolean;
  onAction: (
    payload: Record<string, unknown>,
    label: string,
  ) => Promise<boolean>;
}) {
  const [fxForm, setFxForm] = useState({
    quoteCurrency: "",
    rate: "",
    effectiveAt: "",
  });
  const cf = reports.cashFlow ?? null;
  const exposures = reports.fxExposure?.exposures ?? [];

  function recordRate() {
    if (!fxForm.quoteCurrency.trim() || !Number(fxForm.rate)) return;
    void onAction(
      {
        action: "recordFxRate",
        quoteCurrency: fxForm.quoteCurrency.trim().toUpperCase(),
        rate: fxForm.rate.trim(),
        effectiveAt: fxForm.effectiveAt
          ? new Date(`${fxForm.effectiveAt}T12:00:00Z`).toISOString()
          : undefined,
      },
      `Record ${fxForm.quoteCurrency.toUpperCase()} rate`,
    ).then((accepted) => {
      if (accepted) setFxForm({ quoteCurrency: "", rate: "", effectiveAt: "" });
    });
  }

  return (
    <section className="space-y-6">
      {reports.unsupportedCurrencies === undefined ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
          Currency coverage could not be verified for this report. Review
          foreign-currency activity before relying on these totals.
        </p>
      ) : (
        reports.unsupportedCurrencies.length > 0 && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
            These statements are in {reports.baseCurrency}. Ledger activity in{" "}
            {reports.unsupportedCurrencies.join(", ")} is excluded until
            multi-currency consolidation is completed.
          </p>
        )
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>Profit &amp; loss · to date</CardTitle>
          <table className="w-full text-sm">
            <tbody>
              {reports.pnl.lines.map((l) => (
                <tr key={l.code}>
                  <td className="py-1.5 text-stone-600">{l.name}</td>
                  <td className="num py-1.5">
                    {formatMoneyIn(reports.baseCurrency, l.amountMinor)}
                  </td>
                </tr>
              ))}
              <tr className="border-t border-stone-200">
                <td className="pt-2.5 font-semibold text-stone-900">
                  Net income
                </td>
                <td
                  className={cn(
                    "num pt-2.5 font-semibold",
                    reports.pnl.netIncomeMinor >= 0
                      ? "text-emerald-700"
                      : "text-red-700",
                  )}
                >
                  {formatMoneyIn(
                    reports.baseCurrency,
                    reports.pnl.netIncomeMinor,
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </Card>

        <Card>
          <CardTitle
            right={
              reports.balanceSheet.balanced ? (
                <Badge tone="green">balanced</Badge>
              ) : (
                <Badge tone="red">unbalanced</Badge>
              )
            }
          >
            Balance sheet
          </CardTitle>
          {!reports.balanceSheet.balanced && (
            <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-900">
              Assets ≠ liabilities + equity. This should be impossible - treat
              it as corruption and investigate before trusting any figure.
            </p>
          )}
          <table className="w-full text-sm">
            <tbody>
              <tr>
                <td className="py-1.5 text-stone-600">Assets</td>
                <td className="num py-1.5">
                  {formatMoneyIn(
                    reports.baseCurrency,
                    reports.balanceSheet.assetsMinor,
                  )}
                </td>
              </tr>
              <tr>
                <td className="py-1.5 text-stone-600">Liabilities</td>
                <td className="num py-1.5">
                  {formatMoneyIn(
                    reports.baseCurrency,
                    reports.balanceSheet.liabilitiesMinor,
                  )}
                </td>
              </tr>
              <tr>
                <td className="py-1.5 text-stone-600">Equity</td>
                <td className="num py-1.5">
                  {formatMoneyIn(
                    reports.baseCurrency,
                    reports.balanceSheet.equityMinor,
                  )}
                </td>
              </tr>
              <tr>
                <td className="py-1.5 text-stone-600">Current result</td>
                <td className="num py-1.5">
                  {formatMoneyIn(
                    reports.baseCurrency,
                    reports.balanceSheet.retainedResultMinor,
                  )}
                </td>
              </tr>
              <tr className="border-t border-stone-200">
                <td className="pt-2.5 font-semibold text-stone-900">
                  Liabilities + equity
                </td>
                <td className="num pt-2.5 font-semibold text-stone-900">
                  {formatMoneyIn(
                    reports.baseCurrency,
                    reports.balanceSheet.liabilitiesMinor +
                      reports.balanceSheet.equityMinor +
                      reports.balanceSheet.retainedResultMinor,
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </Card>
      </div>

      {cash && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            label={`Cash in ${year}`}
            value={formatMoneyIn(reports.baseCurrency, cash.cashInMinor)}
          />
          <StatCard
            label="Cash out"
            value={formatMoneyIn(reports.baseCurrency, cash.cashOutMinor)}
          />
          <StatCard
            label="Net cash movement"
            value={formatMoneyIn(reports.baseCurrency, cash.netCashMinor)}
            tone={cash.netCashMinor >= 0 ? "accent" : "danger"}
          />
          <StatCard
            label="Booked but uncollected"
            value={formatMoneyIn(reports.baseCurrency, cash.uncollectedMinor)}
            tone={cash.uncollectedMinor > 0 ? "warn" : "default"}
          />
        </div>
      )}

      {cf && (
        <Card>
          <CardTitle
            right={
              cf.ties ? (
                <Badge tone="green">ties to cash</Badge>
              ) : (
                <Badge tone="red">doesn&apos;t tie - investigate</Badge>
              )
            }
          >
            Cash flow statement · all time, {reports.baseCurrency}
          </CardTitle>
          <table className="w-full text-sm">
            <tbody>
              {(
                [
                  ["Operating", cf.operating],
                  ["Investing", cf.investing],
                  ["Financing", cf.financing],
                ] as const
              ).map(([label, b]) => (
                <tr key={label}>
                  <td className="py-1.5 text-stone-600">{label}</td>
                  <td className="num py-1.5 text-emerald-700">
                    {b.inflowMinor
                      ? `+${formatMoneyIn(reports.baseCurrency, b.inflowMinor)}`
                      : "-"}
                  </td>
                  <td className="num py-1.5 text-stone-600">
                    {b.outflowMinor
                      ? `−${formatMoneyIn(reports.baseCurrency, b.outflowMinor)}`
                      : "-"}
                  </td>
                  <td className="num py-1.5 font-medium">
                    {formatMoneyIn(reports.baseCurrency, b.netMinor)}
                  </td>
                </tr>
              ))}
              <tr className="border-t border-stone-200">
                <td className="pt-2.5 font-semibold text-stone-900">
                  Net change in cash
                </td>
                <td colSpan={2} />
                <td
                  className={cn(
                    "num pt-2.5 font-semibold",
                    cf.netMinor >= 0 ? "text-stone-900" : "text-red-700",
                  )}
                >
                  {formatMoneyIn(reports.baseCurrency, cf.netMinor)}
                </td>
              </tr>
              <tr>
                <td className="py-1.5 text-stone-600">Cash balance now</td>
                <td colSpan={2} />
                <td className="num py-1.5 font-semibold text-stone-900">
                  {formatMoneyIn(reports.baseCurrency, cf.cashBalanceMinor)}
                </td>
              </tr>
            </tbody>
          </table>
        </Card>
      )}

      <Card>
        <CardTitle>FX exposure &amp; rates</CardTitle>
        {exposures.length === 0 ? (
          <QuietLine>
            No foreign-currency receivables outstanding - no unrealized
            exposure.
          </QuietLine>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left opacity-50">
                <th>Currency</th>
                <th className="text-right">Outstanding (foreign)</th>
                <th className="text-right">Latest rate</th>
                <th className="text-right">Value in base</th>
              </tr>
            </thead>
            <tbody>
              {exposures.map((e) => (
                <tr key={e.currency} className="border-t">
                  <td className="py-1.5 font-medium">{e.currency}</td>
                  <td className="num text-right">
                    {formatMoneyOrMinor(e.currency, e.outstandingForeignMinor)}
                  </td>
                  <td className="num text-right">
                    {e.latestRateNum !== null && e.latestRateDen !== null
                      ? (e.latestRateNum / e.latestRateDen).toFixed(4)
                      : "no rate yet"}
                  </td>
                  <td className="num text-right font-medium">
                    {e.outstandingBaseMinor === null
                      ? "-"
                      : formatMoneyIn(
                          reports.baseCurrency,
                          e.outstandingBaseMinor,
                        )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-stone-100 pt-4 text-sm">
          <div>
            <label htmlFor="fx-currency" className="label">
              Currency
            </label>
            <input
              id="fx-currency"
              className="input w-20 uppercase"
              placeholder="EUR"
              maxLength={3}
              value={fxForm.quoteCurrency}
              onChange={(e) =>
                setFxForm({ ...fxForm, quoteCurrency: e.target.value })
              }
            />
          </div>
          <div>
            <label htmlFor="fx-rate" className="label">
              Rate (1 unit in base)
            </label>
            <input
              id="fx-rate"
              inputMode="decimal"
              className="input tnum w-28"
              placeholder="1.0875"
              value={fxForm.rate}
              onChange={(e) => setFxForm({ ...fxForm, rate: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="fx-date" className="label">
              Effective <span className="opacity-50">(optional)</span>
            </label>
            <input
              id="fx-date"
              type="date"
              className="input w-36"
              value={fxForm.effectiveAt}
              onChange={(e) =>
                setFxForm({ ...fxForm, effectiveAt: e.target.value })
              }
            />
          </div>
          <Button
            tone="secondary"
            disabled={
              busy || !fxForm.quoteCurrency.trim() || !Number(fxForm.rate)
            }
            onClick={recordRate}
          >
            Record rate
          </Button>
        </div>
      </Card>
    </section>
  );
}

/* ----------------------------------------------------------------- periods -- */

function PeriodsSection({
  closedPeriods,
  onCloseYear,
  onReopen,
  busy,
}: {
  closedPeriods: Overview["closedPeriods"];
  onCloseYear: (year: number) => Promise<boolean>;
  onReopen: (year: number, month: number) => Promise<boolean>;
  busy: boolean;
}) {
  const year = new Date().getUTCFullYear();
  const [yearInput, setYearInput] = useState(String(year));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reopenTarget, setReopenTarget] = useState<{
    year: number;
    month: number;
  } | null>(null);
  return (
    <section className="max-w-xl space-y-8">
      <div>
        <h2 className="text-sm font-semibold text-stone-800">
          Closed period history
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-stone-500">
          Reopen a sealed month only when a corrective posting is needed.
          Reopening requires approval.
        </p>
        {closedPeriods.length > 0 && (
          <div className="mt-4 text-xs text-stone-500">
            Sealed:
            <ul className="mt-1.5 space-y-1">
              {closedPeriods.map((p) => (
                <li
                  key={`${p.year}-${p.month}`}
                  className="flex items-center gap-2"
                >
                  <Badge>
                    {p.year}-{String(p.month).padStart(2, "0")}
                  </Badge>
                  <Button
                    tone="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setReopenTarget(p)}
                  >
                    Reopen
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {closedPeriods.length === 0 && (
          <p className="mt-3 text-sm text-stone-500">
            No periods have been sealed yet. Start from the close checklist
            above.
          </p>
        )}
      </div>

      <div className="border-t border-stone-200 pt-6">
        <h2 className="text-sm font-semibold text-stone-800">Year-end close</h2>
        <p className="mt-1 text-sm leading-relaxed text-stone-500">
          Zeroes income and expense accounts into retained earnings with one
          balanced entry, then seals December. Approval-gated.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input
            className="input w-28"
            placeholder={String(year)}
            value={yearInput}
            onChange={(e) => setYearInput(e.target.value)}
            aria-label="Fiscal year to close"
          />
          <Button
            tone="danger"
            disabled={busy || !yearInput}
            onClick={() => setConfirmOpen(true)}
          >
            Close year, roll retained earnings
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={async () => {
          const accepted = await onCloseYear(Number(yearInput));
          if (accepted) setConfirmOpen(false);
        }}
        title={`Close fiscal year ${yearInput}`}
        body={
          <>
            Post the closing entry for {yearInput}, rolling net income into
            retained earnings and sealing December {yearInput}. This is a
            destructive-class action and requires approval.
          </>
        }
        confirmLabel={`Close ${yearInput}`}
        busy={busy}
      />

      <ConfirmDialog
        open={reopenTarget !== null}
        onClose={() => setReopenTarget(null)}
        onConfirm={async () => {
          if (!reopenTarget) return;
          const accepted = await onReopen(
            reopenTarget.year,
            reopenTarget.month,
          );
          if (accepted) setReopenTarget(null);
        }}
        title={`Reopen ${reopenTarget ? `${reopenTarget.year}-${String(reopenTarget.month).padStart(2, "0")}` : ""}?`}
        body="Unseals the month so corrective postings land in the right period. This is a destructive-class action and requires approval."
        confirmLabel="Reopen period"
        busy={busy}
      />
    </section>
  );
}
/* -------------------------------------------------------------------- bank -- */

/** Parses pasted CSV lines of `YYYY-MM-DD,amount,description`; amounts may carry commas. */
function parseFeedCsv(
  text: string,
  currencyCode: string,
): {
  rows: { postedAt: string; amountMinor: number; description: string }[];
  errors: string[];
} {
  const rows: { postedAt: string; amountMinor: number; description: string }[] =
    [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    const m = t.match(
      /^(\d{4}-\d{2}-\d{2})\s*,\s*(-?[\d,]+(?:\.\d+)?)\s*,\s*(.+)$/,
    );
    const datePart = m?.[1];
    const amountPart = m?.[2];
    const descPart = m?.[3];
    if (!datePart || !amountPart || !descPart) {
      errors.push(`line ${i + 1}: expected date,amount,description`);
      return;
    }
    const amountMinor = toMinorIn(currencyCode, amountPart.replace(/,/g, ""));
    if (!Number.isSafeInteger(amountMinor)) {
      errors.push(`line ${i + 1}: "${amountPart}" is not a number`);
      return;
    }
    rows.push({
      postedAt: datePart,
      amountMinor,
      description: descPart.trim(),
    });
  });
  return { rows, errors };
}

function BankSection({
  baseCurrency,
  banking,
  busy,
  onAction,
}: {
  baseCurrency: string;
  banking: Banking | null;
  busy: boolean;
  onAction: (
    payload: Record<string, unknown>,
    label: string,
  ) => Promise<boolean>;
}) {
  const [feed, setFeed] = useState("");
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [accountId, setAccountId] = useState("");
  const [newName, setNewName] = useState("");
  const [newLast4, setNewLast4] = useState("");
  const [newCurrencyCode, setNewCurrencyCode] = useState(baseCurrency);
  const [matchPicks, setMatchPicks] = useState<Record<string, string>>({});
  const accounts = banking?.accounts ?? [];
  useEffect(() => {
    if (!accountId && accounts.length === 1) setAccountId(accounts[0]!.id);
    else if (accountId && !accounts.some((account) => account.id === accountId))
      setAccountId("");
  }, [accounts, accountId]);

  if (!banking) {
    return (
      <EmptyState
        icon={<IconInbox />}
        title="Bank feeds couldn't load"
        hint="Check your connection and retry from the Overview tab."
      />
    );
  }

  const summary = banking.summary;
  const selectedAccount =
    accounts.find((account) => account.id === accountId) ??
    (accounts.length === 1 ? accounts[0] : undefined);

  function addAccount() {
    if (!newName.trim()) return;
    void onAction(
      {
        action: "addBankAccount",
        name: newName.trim(),
        currencyCode: newCurrencyCode.trim().toUpperCase() || baseCurrency,
        last4: newLast4.trim() || undefined,
      },
      `Add account “${newName.trim()}”`,
    ).then((accepted) => {
      if (!accepted) return;
      setNewName("");
      setNewLast4("");
    });
  }

  function importFeed() {
    if (!selectedAccount) return;
    const { rows, errors } = parseFeedCsv(feed, selectedAccount.currencyCode);
    setParseErrors(errors);
    if (rows.length === 0) return;
    void onAction(
      { action: "importBankFeed", bankAccountId: selectedAccount.id, rows },
      `Import ${rows.length} statement line${rows.length === 1 ? "" : "s"}`,
    ).then((accepted) => {
      if (accepted) setFeed("");
    });
  }

  return (
    <section className="max-w-3xl space-y-8">
      <p className="tnum text-sm text-stone-600">
        <span
          className={cn(
            "font-semibold",
            summary.unmatchedCount > 0 ? "text-amber-700" : "text-emerald-700",
          )}
        >
          {summary.unmatchedCount}
        </span>{" "}
        unmatched statement line{summary.unmatchedCount === 1 ? "" : "s"}
      </p>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-stone-800">Accounts</h2>
        {accounts.length === 0 ? (
          <QuietLine>
            No bank accounts yet - add one below to start importing statements.
          </QuietLine>
        ) : (
          <ul className="divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white shadow-xs">
            {accounts.map((a) => {
              const stat = summary.accounts.find(
                (s) => s.bankAccountId === a.id,
              );
              return (
                <li
                  key={a.id}
                  className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm"
                >
                  <span className="font-medium text-stone-800">{a.name}</span>
                  {a.last4 && (
                    <span className="text-stone-400">••••{a.last4}</span>
                  )}
                  <Badge>{a.currencyCode}</Badge>
                  {stat && (
                    <Badge tone={stat.count > 0 ? "amber" : "green"}>
                      {stat.count} lines
                    </Badge>
                  )}
                  <span className="tnum ml-auto font-medium">
                    {formatMoneyOrMinor(a.currencyCode, a.balanceMinor)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            className="input w-48"
            placeholder="Account name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            aria-label="New bank account name"
          />
          <input
            className="input w-24"
            placeholder="Last 4"
            maxLength={4}
            value={newLast4}
            onChange={(e) => setNewLast4(e.target.value)}
            aria-label="Last four digits"
          />
          <input
            className="input w-20 uppercase"
            maxLength={3}
            placeholder={baseCurrency}
            value={newCurrencyCode}
            onChange={(e) => setNewCurrencyCode(e.target.value.toUpperCase())}
            aria-label="Bank account currency"
          />
          <Button
            tone="secondary"
            disabled={
              busy ||
              !newName.trim() ||
              !currencyStyleFor(newCurrencyCode.trim() || baseCurrency)
            }
            onClick={addAccount}
          >
            Add account
          </Button>
        </div>
      </div>

      <div className="border-t border-stone-200 pt-6">
        <h2 className="text-sm font-semibold text-stone-800">Import feed</h2>
        <p className="mt-1 text-sm leading-relaxed text-stone-500">
          Paste bank export lines, one per row:{" "}
          <code className="text-stone-700">date,amount,description</code> - e.g.
          <code className="ml-1 text-stone-700">
            2025-06-01,-42.10,Card fees
          </code>
          . Positive is money in. Duplicate lines are skipped automatically, so
          re-pasting an export is safe.
        </p>
        {accounts.length > 1 && (
          <select
            className="select mt-3 w-64"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            aria-label="Account to import into"
          >
            <option value="">Select account…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
        {selectedAccount && (
          <p className="mt-2 text-xs text-stone-500">
            Amounts will be read as {selectedAccount.currencyCode}.
          </p>
        )}
        <textarea
          className="input mt-3 h-32 w-full font-mono text-xs"
          placeholder={
            "2025-06-01,1250.00,ACME wire\n2025-06-02,-42.10,Card fees"
          }
          value={feed}
          onChange={(e) => setFeed(e.target.value)}
          aria-label="Statement lines"
        />
        {parseErrors.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-xs text-red-700">
            {parseErrors.slice(0, 5).map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        <Button
          className="mt-3"
          disabled={busy || !feed.trim() || !selectedAccount}
          onClick={importFeed}
        >
          Import lines
        </Button>
      </div>

      <div className="border-t border-stone-200 pt-6">
        <h2 className="text-sm font-semibold text-stone-800">
          Unmatched transactions
        </h2>
        {banking.unmatched.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              icon={<IconInbox />}
              title="Nothing waiting"
              hint="Every imported statement line is matched or excluded."
            />
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white shadow-xs">
            {banking.unmatched.map((t) => (
              <li
                key={t.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-sm"
              >
                <time className="w-20 shrink-0 text-xs text-stone-400">
                  {t.postedAt.slice(0, 10)}
                </time>
                <span
                  className="min-w-0 flex-1 truncate text-stone-800"
                  title={t.description}
                >
                  {t.description}
                </span>
                <span
                  className={cn(
                    "tnum shrink-0 font-medium",
                    t.amountMinor < 0 && "text-red-700",
                  )}
                >
                  {formatMoneyOrMinor(t.currencyCode, t.amountMinor)}
                </span>
                <select
                  className="select w-56 py-1 text-xs"
                  value={matchPicks[t.id] ?? ""}
                  onChange={(e) =>
                    setMatchPicks((p) => ({ ...p, [t.id]: e.target.value }))
                  }
                  aria-label={`Match ${t.description} against payment`}
                >
                  <option value="">Match to payment…</option>
                  {banking.payments
                    .filter((p) => p.currencyCode === t.currencyCode)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.customerName} · #{p.invoiceNumber ?? "?"} ·{" "}
                        {formatMoneyOrMinor(p.currencyCode, p.amountMinor)}
                      </option>
                    ))}
                </select>
                <Button
                  tone="secondary"
                  size="sm"
                  disabled={busy || !matchPicks[t.id]}
                  onClick={() =>
                    void onAction(
                      {
                        action: "matchBankTransaction",
                        transactionId: t.id,
                        paymentId: matchPicks[t.id],
                      },
                      "Match",
                    )
                  }
                >
                  Match
                </Button>
                <Button
                  tone="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void onAction(
                      { action: "excludeBankTransaction", transactionId: t.id },
                      "Exclude",
                    )
                  }
                >
                  Exclude
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {(banking.matched?.length ?? 0) > 0 && (
        <div className="border-t border-stone-200 pt-6">
          <h2 className="text-sm font-semibold text-stone-800">
            Matched transactions
          </h2>
          <ul className="mt-3 divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white shadow-xs">
            {banking.matched!.map((t) => (
              <li
                key={t.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-sm"
              >
                <time className="w-20 shrink-0 text-xs text-stone-400">
                  {t.postedAt.slice(0, 10)}
                </time>
                <span
                  className="min-w-0 flex-1 truncate text-stone-800"
                  title={t.description}
                >
                  {t.description}
                </span>
                <span
                  className={cn(
                    "tnum shrink-0 font-medium",
                    t.amountMinor < 0 && "text-red-700",
                  )}
                >
                  {formatMoneyOrMinor(t.currencyCode, t.amountMinor)}
                </span>
                <Button
                  tone="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void onAction(
                      { action: "unmatchBankTransaction", transactionId: t.id },
                      "Unmatch",
                    )
                  }
                >
                  Unmatch
                </Button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-stone-500">
            A mistaken match releases the line back to unmatched - nothing is
            ever deleted.
          </p>
        </div>
      )}

      {(banking.excluded?.length ?? 0) > 0 && (
        <div className="border-t border-stone-200 pt-6">
          <h2 className="text-sm font-semibold text-stone-800">
            Excluded transactions
          </h2>
          <ul className="mt-3 divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white shadow-xs">
            {banking.excluded!.map((t) => (
              <li
                key={t.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-sm"
              >
                <time className="w-20 shrink-0 text-xs text-stone-400">
                  {t.postedAt.slice(0, 10)}
                </time>
                <span
                  className="min-w-0 flex-1 truncate text-stone-500"
                  title={t.description}
                >
                  {t.description}
                </span>
                <span
                  className={cn(
                    "tnum shrink-0 font-medium",
                    t.amountMinor < 0 && "text-red-700",
                  )}
                >
                  {formatMoneyOrMinor(t.currencyCode, t.amountMinor)}
                </span>
                <Button
                  tone="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void onAction(
                      {
                        action: "unexcludeBankTransaction",
                        transactionId: t.id,
                      },
                      "Restore",
                    )
                  }
                >
                  Restore
                </Button>
                <Button
                  tone="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void onAction(
                      { action: "deleteBankTransaction", transactionId: t.id },
                      "Delete",
                    )
                  }
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-stone-500">
            Restore puts a line back into matching; delete removes it entirely
            (e.g. a duplicate import).
          </p>
        </div>
      )}
    </section>
  );
}

/* --------------------------------------------------------------------- tax -- */

function CashSection({
  baseCurrency,
  customers,
}: {
  baseCurrency: string;
  customers: { id: string; name: string }[];
}) {
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [forecastError, setForecastError] = useState<string | null>(null);
  const [forecastAttempt, setForecastAttempt] = useState(0);
  const [reminders, setReminders] = useState<ReminderDraft[] | null>(null);
  const [reminderError, setReminderError] = useState<string | null>(null);
  const [remindersBusy, setRemindersBusy] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [statement, setStatement] = useState<StatementView | null>(null);
  const [statementBusy, setStatementBusy] = useState(false);
  const [statementError, setStatementError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [scenarios, setScenarios] = useState<
    {
      id: string;
      name: string;
      fiscalYear: number;
      version: number;
      isCurrent: boolean;
    }[]
  >([]);
  const [budgetScenarioId, setBudgetScenarioId] = useState("");

  useEffect(() => {
    let cancelled = false;
    void callApi<{
      scenarios?: {
        scenarios: {
          id: string;
          name: string;
          fiscalYear: number;
          version: number;
          isCurrent: boolean;
        }[];
      };
    }>("/api/accounting/budgets").then((res) => {
      if (cancelled || !res.ok) return;
      const rows = res.data?.scenarios?.scenarios ?? [];
      setScenarios(rows);
      setBudgetScenarioId(
        (current) => current || rows.find((row) => row.isCurrent)?.id || "",
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setForecast(null);
    setForecastError(null);
    void postApi<unknown>("/api/accounting", {
      action: "cashForecast",
      budgetScenarioId: budgetScenarioId || undefined,
    })
      .then((res) => {
        if (cancelled) return;
        const result = res.ok ? capabilityData<Forecast>(res.data) : null;
        if (result && Array.isArray(result.weeks)) setForecast(result);
        else
          setForecastError(
            res.error?.title ??
              "Couldn't compute the forecast. Retry in a moment.",
          );
      })
      .catch(() => {
        if (!cancelled)
          setForecastError("Couldn't compute the forecast. Retry in a moment.");
      });
    return () => {
      cancelled = true;
    };
  }, [forecastAttempt, budgetScenarioId]);

  async function draftReminders() {
    setRemindersBusy(true);
    setReminderError(null);
    const res = await postApi<unknown>("/api/accounting", {
      action: "buildReminders",
    });
    setRemindersBusy(false);
    const result = res.ok
      ? capabilityData<{ reminders: ReminderDraft[] }>(res.data)
      : null;
    if (result && Array.isArray(result.reminders))
      setReminders(result.reminders);
    else
      setReminderError(
        res.error?.title ?? "Couldn't draft reminders. Try again.",
      );
  }

  async function loadStatement() {
    if (!customerId) return;
    setStatementBusy(true);
    setStatementError(null);
    const res = await postApi<unknown>("/api/accounting", {
      action: "customerStatement",
      customerId,
    });
    setStatementBusy(false);
    const result = res.ok ? capabilityData<StatementView>(res.data) : null;
    setStatement(result);
    if (!result)
      setStatementError(
        res.error?.title ?? "Couldn't load this customer statement. Try again.",
      );
  }

  function copyMessage(r: ReminderDraft) {
    setCopyError(null);
    void navigator.clipboard
      .writeText(r.message)
      .then(() => {
        setCopiedId(`${r.customerId}:${r.currency}`);
        window.setTimeout(() => setCopiedId(null), 1800);
      })
      .catch(() =>
        setCopyError(
          "Clipboard access was blocked. Select and copy the draft text instead.",
        ),
      );
  }

  return (
    <section className="space-y-8">
      <Card>
        <CardTitle
          right={
            forecast?.scenarioName ? (
              <Badge tone="blue">{forecast.scenarioName}</Badge>
            ) : undefined
          }
        >
          13-week cash forecast
        </CardTitle>
        {scenarios.length > 0 && (
          <label className="mb-4 block max-w-sm text-xs font-medium text-stone-600">
            Forecast assumptions
            <select
              className="input mt-1 block w-full"
              value={budgetScenarioId}
              onChange={(event) => setBudgetScenarioId(event.target.value)}
            >
              <option value="">Operational forecast, no saved scenario</option>
              {scenarios.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>
                  {scenario.name} · {scenario.fiscalYear} · v{scenario.version}
                  {scenario.isCurrent ? " (current)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        {forecastError ? (
          <div className="flex flex-wrap items-center gap-3">
            <p role="alert" className="text-sm text-red-700">
              {forecastError}
            </p>
            <Button
              size="sm"
              tone="secondary"
              onClick={() => setForecastAttempt((attempt) => attempt + 1)}
            >
              Retry
            </Button>
          </div>
        ) : !forecast ? (
          <QuietLine>Projecting thirteen weeks of cash…</QuietLine>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <StatCard
                label={`Cash today · ${baseCurrency}`}
                value={formatMoneyIn(baseCurrency, forecast.startMinor)}
              />
              <StatCard
                label="Projected in 13 weeks"
                value={formatMoneyIn(baseCurrency, forecast.finalMinor)}
              />
              <StatCard
                label="Projected low point"
                value={formatMoneyIn(baseCurrency, forecast.lowestCloseMinor)}
                sub={
                  forecast.lowestWeekIndex < 0
                    ? "today"
                    : `week ${forecast.lowestWeekIndex + 1} of 13`
                }
                tone={forecast.lowestCloseMinor < 0 ? "danger" : "default"}
              />
            </div>
            {forecast.scenarioName &&
              forecast.lowestCloseMinor < forecast.minimumCashBufferMinor && (
                <p
                  role="status"
                  className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
                >
                  Forecast cash falls below the scenario's minimum buffer of{" "}
                  {formatMoneyIn(baseCurrency, forecast.minimumCashBufferMinor)}
                  .
                </p>
              )}
            {forecast.unsupportedCurrencies === undefined ? (
              <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
                Currency coverage could not be verified. The forecast is shown
                in {baseCurrency}; confirm foreign-currency balances separately.
              </p>
            ) : (
              forecast.unsupportedCurrencies.length > 0 && (
                <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
                  The forecast is in {baseCurrency}. Foreign-currency balances (
                  {forecast.unsupportedCurrencies.join(", ")}) are excluded
                  until converted.
                </p>
              )
            )}
            <div
              className="mt-4 overflow-x-auto"
              role="region"
              aria-label="Weekly cash forecast"
              tabIndex={0}
            >
              <table className="w-full min-w-[34rem] text-sm">
                <thead>
                  <tr className="text-left text-stone-600">
                    <th>Week of</th>
                    <th className="text-right">Inflow</th>
                    <th className="text-right">Outflow</th>
                    <th className="text-right">Closing</th>
                  </tr>
                </thead>
                <tbody>
                  {forecast.weeks.map((w, i) => (
                    <tr
                      key={w.weekStart}
                      className={cn(
                        "border-t",
                        i === forecast.lowestWeekIndex && "bg-amber-50/70",
                      )}
                    >
                      <td className="whitespace-nowrap py-1.5 text-stone-600">
                        {formatDate(w.weekStart)}
                        {i === forecast.lowestWeekIndex && (
                          <span className="ml-2 text-xs font-medium text-amber-700">
                            lowest
                          </span>
                        )}
                      </td>
                      <td className="text-right tabular-nums text-emerald-700">
                        {w.inflowMinor
                          ? formatMoneyIn(baseCurrency, w.inflowMinor)
                          : "-"}
                      </td>
                      <td className="text-right tabular-nums text-stone-600">
                        {w.outflowMinor
                          ? formatMoneyIn(baseCurrency, w.outflowMinor)
                          : "-"}
                      </td>
                      <td className="text-right font-medium tabular-nums">
                        {formatMoneyIn(baseCurrency, w.closeMinor)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-stone-600">
              Projected from current cash plus the due dates on open invoices
              and unpaid bills; anything unscheduled (new sales, one-off spends)
              is not included.
            </p>
          </>
        )}
      </Card>

      <Card>
        <CardTitle
          right={
            <Button
              tone="ghost"
              size="sm"
              disabled={remindersBusy}
              onClick={() => void draftReminders()}
            >
              {reminders ? "Redraft" : "Draft reminders"}
            </Button>
          }
        >
          Payment reminder drafts
        </CardTitle>
        {reminders === null ? (
          <QuietLine>
            Draft polite chases for every overdue customer - nothing is sent
            automatically.
          </QuietLine>
        ) : reminders.length === 0 ? (
          <QuietLine>
            No overdue balances - nobody needs chasing right now.
          </QuietLine>
        ) : (
          <ul className="divide-y divide-stone-100">
            {reminders.map((r) => (
              <li
                key={`${r.customerId}:${r.currency}`}
                className="py-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-stone-800">
                    {r.customerName}
                  </span>
                  <Badge tone={r.oldestDaysOverdue > 60 ? "red" : "amber"}>
                    {r.oldestDaysOverdue}d overdue
                  </Badge>
                  <span className="text-xs text-stone-500">
                    {r.overdueCount} invoice{r.overdueCount === 1 ? "" : "s"}
                  </span>
                  <Badge>{r.currency}</Badge>
                  <span className="tnum ml-auto font-medium">
                    {formatMoneyOrMinor(r.currency, r.totalOverdueMinor)}
                  </span>
                  <Button tone="ghost" size="sm" onClick={() => copyMessage(r)}>
                    {copiedId === `${r.customerId}:${r.currency}`
                      ? "Copied"
                      : "Copy draft"}
                  </Button>
                </div>
                <p className="mt-1.5 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs leading-relaxed text-stone-700">
                  {r.message}
                </p>
              </li>
            ))}
          </ul>
        )}
        {reminderError && (
          <p role="alert" className="mt-2 text-xs text-red-700">
            {reminderError}
          </p>
        )}
        {copyError && (
          <p role="alert" className="mt-2 text-xs text-red-700">
            {copyError}
          </p>
        )}
      </Card>

      <Card>
        <CardTitle>Customer statement</CardTitle>
        {customers.length === 0 ? (
          <QuietLine>No customers yet - record an invoice first.</QuietLine>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <select
                className="select"
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                aria-label="Customer"
              >
                <option value="">Customer…</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={!customerId || statementBusy}
                onClick={() => void loadStatement()}
              >
                {statementBusy ? "Loading…" : "Load statement"}
              </Button>
            </div>
            {statementError && (
              <p role="alert" className="mt-3 text-xs text-red-700">
                {statementError}
              </p>
            )}
            {statement &&
              (statement.currencies === undefined ? (
                <p
                  role="alert"
                  className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900"
                >
                  This statement response does not include currency grouping, so
                  its balances are hidden until the accounting service can
                  verify each amount&apos;s currency.
                </p>
              ) : statement.currencies.length === 0 ? (
                <QuietLine>No activity on this account yet.</QuietLine>
              ) : (
                <>
                  {statement.currencies.map((statementCurrency) => (
                    <div key={statementCurrency.currency} className="mt-5">
                      <h3 className="mb-2 text-sm font-semibold text-stone-800">
                        Statement in {statementCurrency.currency}
                      </h3>
                      <div
                        className="overflow-x-auto"
                        role="region"
                        aria-label={`Statement activity in ${statementCurrency.currency}`}
                        tabIndex={0}
                      >
                        <table className="w-full min-w-[38rem] text-sm">
                          <thead>
                            <tr className="text-left text-stone-600">
                              <th>Date</th>
                              <th>Kind</th>
                              <th>Ref</th>
                              <th className="text-right">Amount</th>
                              <th className="text-right">Balance</th>
                            </tr>
                          </thead>
                          <tbody>
                            {statementCurrency.rows.map((row, i) => (
                              <tr key={`${row.ref}-${i}`} className="border-t">
                                <td className="whitespace-nowrap py-1.5 text-stone-600">
                                  {formatDate(row.date)}
                                </td>
                                <td>
                                  <Badge
                                    tone={
                                      row.kind === "payment" ||
                                      row.kind === "credit_note"
                                        ? "green"
                                        : "neutral"
                                    }
                                  >
                                    {row.kind}
                                  </Badge>
                                </td>
                                <td className="text-stone-600">{row.ref}</td>
                                <td
                                  className={cn(
                                    "text-right tabular-nums",
                                    row.amountMinor < 0
                                      ? "text-emerald-700"
                                      : "text-stone-800",
                                  )}
                                >
                                  {formatMoneyOrMinor(
                                    statementCurrency.currency,
                                    row.amountMinor,
                                  )}
                                </td>
                                <td className="text-right font-medium tabular-nums">
                                  {formatMoneyOrMinor(
                                    statementCurrency.currency,
                                    row.balanceMinor,
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="mt-2 text-right text-sm">
                        Closing balance{" "}
                        <span className="tnum font-semibold text-stone-900">
                          {formatMoneyOrMinor(
                            statementCurrency.currency,
                            statementCurrency.closingBalanceMinor,
                          )}
                        </span>
                      </p>
                    </div>
                  ))}
                </>
              ))}
          </>
        )}
      </Card>
    </section>
  );
}
