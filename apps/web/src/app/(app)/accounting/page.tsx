"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import { cn, formatDateTime, formatMoney } from "@/lib/format";
import { callApi, postApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";
import { AppFrame } from "../_shell/app-frame";

interface Entry {
  id: string;
  memo: string;
  sourceType: string | null;
  reversalOfId: string | null;
  postedAt: string;
  actorType: string;
  amountMinor: number;
}
interface Overview {
  entries: Entry[];
  aging: { current: number; d30: number; d60: number; d90plus: number; totalOutstanding: number };
  agingInvoices: { number: number; outstandingMinor: number; ageDays: number }[];
  closedPeriods: { year: number; month: number }[];
  bills: { id: string; number: number; status: string; totalMinor: number; paidMinor: number; vendorName: string; outstandingMinor: number }[];
  filings: Filing[];
}
interface Reports {
  pnl: { revenueMinor: number; expenseMinor: number; netIncomeMinor: number; lines: { code: string; name: string; amountMinor: number }[] };
  balanceSheet: { assetsMinor: number; liabilitiesMinor: number; equityMinor: number; retainedResultMinor: number; balanced: boolean };
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
  accounts: { id: string; name: string; currencyCode: string; last4: string | null; balanceMinor: number }[];
  unmatched: { id: string; bankAccountId: string; postedAt: string; amountMinor: number; description: string }[];
  payments: { id: string; invoiceNumber: number | null; customerName: string; amountMinor: number; receivedAt: string }[];
  summary: {
    accounts: { bankAccountId: string; name: string; count: number; moneyInMinor: number; moneyOutMinor: number }[];
    unmatchedCount: number;
  };
}

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "journal", label: "Journal" },
  { id: "receivables", label: "Receivables" },
  { id: "payables", label: "Payables" },
  { id: "bank", label: "Bank" },
  { id: "tax", label: "Tax" },
  { id: "reports", label: "Reports" },
  { id: "periods", label: "Periods & close" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function initialTab(): TabId {
  const hash = typeof window !== "undefined" ? window.location.hash.replace("#", "") : "";
  return (TABS.find((t) => t.id === hash)?.id ?? "overview") as TabId;
}

export default function AccountingPage() {
  const __enabled = useModuleEnabled("accounting");
  const router = useRouter();
  const [tab, setTab] = useState<TabId>(initialTab);
  const [data, setData] = useState<Overview | null>(null);
  const [reports, setReports] = useState<Reports | null>(null);
  const [cash, setCash] = useState<CashBasis | null>(null);
  const [banking, setBanking] = useState<Banking | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [monthInput, setMonthInput] = useState("");
  const [search, setSearch] = useState("");

  const [closeOpen, setCloseOpen] = useState(false);
  const [payTarget, setPayTarget] = useState<Overview["bills"][number] | null>(null);
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
      }).then((r) => (r.ok ? r.json() : null)).then((j: { data?: CashBasis } | null) => j?.data ?? null),
      // Banking is auxiliary to this page's core; its absence must not blank the books.
      callApi<Banking>("/api/banking").then((r) => (r.ok ? r.data : null)),
    ]);
    if (!ov.ok || !rp.ok) {
      setLoadError(ov.error?.title ?? rp.error?.title ?? "Couldn't load your books");
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

  function changeTab(id: string) {
    setTab(id as TabId);
    history.replaceState(null, "", `#${id}`);
  }

  async function action(payload: Record<string, unknown>, label: string) {
    setBusy(true);
    try {
      const res = await postApi("/api/accounting", payload);
      if (res.status === 202) {
        setNotice({ tone: "pending", text: `${label} needs human approval, it's in the Approvals inbox.` });
      } else if (!res.ok) {
        setNotice({ tone: "error", error: res.error! });
      } else {
        setNotice({ tone: "success", text: `${label} done.` });
      }
      void load();
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  async function bankAction(payload: Record<string, unknown>, label: string) {
    setBusy(true);
    try {
      const res = await postApi("/api/banking", payload);
      if (res.status === 202) {
        setNotice({ tone: "pending", text: `${label} needs human approval, it's in the Approvals inbox.` });
      } else if (!res.ok) {
        setNotice({ tone: "error", error: res.error! });
      } else {
        setNotice({ tone: "success", text: `${label} done.` });
      }
      void load();
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  async function closePeriod() {
    const [y, m] = monthInput.split("-").map(Number);
    if (!y || !m) return;
    await action({ action: "closePeriod", year: y, month: m }, `Close ${monthInput}`);
    setCloseOpen(false);
    setMonthInput("");
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
      chatDraft.set("Walk me through my current financial position: cash, receivables, payables, and anything overdue.");
    })();
  }

  return (
    <AppFrame
      appId="accounting"
      description="Entries are immutable — corrections are mirror reversals. Sealed periods refuse new postings."
      tabs={TABS.map((t) => ({ id: t.id, label: t.label }))}
      activeTab={tab}
      onTabChange={changeTab}
      actions={
        <>
          <button
            type="button"
            onClick={askWorkmate}
            className="btn btn-md btn-secondary"
            title="Ask your workmate about your position"
          >
            <IconSparkle className="size-3.5" />
            Ask workmate
          </button>
          <Button tone="secondary" onClick={() => setCloseOpen(true)}>
            <IconLock className="size-3.5" />
            Close period…
          </Button>
        </>
      }
    >
      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}

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

      {tab === "receivables" && <ReceivablesSection a={a} agingInvoices={data.agingInvoices} />}

      {tab === "payables" && (
        <PayablesSection bills={data.bills} openBills={openBills} onPay={setPayTarget} />
      )}

      {tab === "bank" && <BankSection banking={banking} busy={busy} onAction={bankAction} />}

      {tab === "tax" && <TaxSection filings={data.filings} busy={busy} onAction={action} />}

      {tab === "reports" && reports?.pnl && <ReportsSection reports={reports} cash={cash} year={new Date().getUTCFullYear()} />}

      {tab === "periods" && (
        <PeriodsSection
          closedPeriods={data.closedPeriods}
          onOpenClose={() => setCloseOpen(true)}
          onCloseYear={(year) => action({ action: "closeYear", year }, `Year-end close ${year}`)}
          busy={busy}
        />
      )}

      {/* Close period dialog */}
      <Dialog
        open={closeOpen}
        onClose={() => setCloseOpen(false)}
        title="Close a period"
        description="Sealed periods refuse new postings. Reopening is a gated destructive action — make sure the month is reconciled first."
        footer={
          <>
            <Button tone="secondary" onClick={() => setCloseOpen(false)}>
              Cancel
            </Button>
            <Button tone="danger" onClick={closePeriod} loading={busy} disabled={!monthInput}>
              Seal period
            </Button>
          </>
        }
      >
        <label htmlFor="period" className="label">
          Period to seal
        </label>
        <input
          id="period"
          type="month"
          value={monthInput}
          onChange={(e) => setMonthInput(e.target.value)}
          className="input"
        />
      </Dialog>

      {/* Pay bill confirm */}
      <ConfirmDialog
        open={payTarget !== null}
        onClose={() => setPayTarget(null)}
        onConfirm={async () => {
          if (!payTarget) return;
          await action(
            { action: "payBill", billNumber: payTarget.number, amountMinor: payTarget.outstandingMinor },
            `Payment of ${formatMoney(payTarget.outstandingMinor)}`,
          );
          setPayTarget(null);
        }}
        title="Pay vendor bill"
        body={
          <>
            Pay <strong className="text-stone-900">{payTarget?.vendorName}</strong> the full outstanding{" "}
            <strong className="text-stone-900">{payTarget ? formatMoney(payTarget.outstandingMinor) : ""}</strong>? The
            payment posts as a balanced ledger entry.
          </>
        }
        confirmLabel={`Pay ${payTarget ? formatMoney(payTarget.outstandingMinor) : ""}`}
        busy={busy}
      />

      {/* Reverse entry confirm */}
      <ConfirmDialog
        open={reverseTarget !== null}
        onClose={() => setReverseTarget(null)}
        onConfirm={async () => {
          if (!reverseTarget) return;
          await action({ action: "reverse", entryId: reverseTarget.id }, "Reversal");
          setReverseTarget(null);
        }}
        title="Reverse journal entry"
        body={
          <>
            Post a mirror reversal of “{reverseTarget?.memo}” ({formatMoney(reverseTarget?.amountMinor ?? 0)})? The
            original stays untouched — corrections are always additive.
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
              {formatMoney(netIncome)}
            </p>
          </div>
          {reports && (
            <div className="flex items-baseline gap-2 text-sm text-stone-500">
              {reports.balanceSheet.balanced ? (
                <Badge tone="green">books balanced</Badge>
              ) : (
                <Badge tone="red">unbalanced — investigate</Badge>
              )}
              <span>Assets {formatMoney(reports.balanceSheet.assetsMinor)}</span>
            </div>
          )}
        </div>

        <dl className="mt-6 grid gap-x-8 border-y border-stone-200 py-4 sm:grid-cols-2 lg:grid-cols-4">
          <Figure label="Revenue" value={formatMoney(reports?.pnl.revenueMinor ?? 0)} />
          <Figure label="Expenses" value={formatMoney(reports?.pnl.expenseMinor ?? 0)} />
          <Figure
            label={`Net cash · YTD`}
            value={cash ? formatMoney(cash.netCashMinor) : "—"}
            tone={cash && cash.netCashMinor < 0 ? "danger" : "default"}
          />
          <Figure
            label="Receivables outstanding"
            value={formatMoney(a.totalOutstanding)}
            note={a.d90plus > 0 ? `${formatMoney(a.d90plus)} past 90d` : undefined}
            tone={a.d90plus > 0 || a.d60 > 0 ? "warn" : "default"}
          />
        </dl>
      </section>

      {/* Working capital: who owes me / who I owe, with the verbs right there */}
      <section aria-label="Working capital" className="grid gap-6 lg:grid-cols-2">
        <div>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-stone-800">Who owes me</h2>
            <button type="button" onClick={() => onTabChange("receivables")} className="cursor-pointer text-[13px] font-medium text-maroon-800 hover:underline">
              All receivables →
            </button>
          </div>
          {data.agingInvoices.length === 0 ? (
            <QuietLine>No outstanding invoices. Receivables are clear.</QuietLine>
          ) : (
            <ul className="divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white shadow-xs">
              {data.agingInvoices.slice(0, 4).map((inv) => (
                <li key={inv.number} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span className="font-medium text-stone-800">Invoice #{inv.number}</span>
                  <span className="tnum ml-auto text-stone-600">{formatMoney(inv.outstandingMinor)}</span>
                  <Badge tone={inv.ageDays > 60 ? "red" : inv.ageDays > 30 ? "amber" : "neutral"}>{inv.ageDays}d</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-stone-800">Who I owe</h2>
            <button type="button" onClick={() => onTabChange("payables")} className="cursor-pointer text-[13px] font-medium text-maroon-800 hover:underline">
              All bills →
            </button>
          </div>
          {openBills.length === 0 ? (
            <QuietLine>No vendor bills due. Payables are clear.</QuietLine>
          ) : (
            <ul className="divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white shadow-xs">
              {openBills.slice(0, 4).map((b) => (
                <li key={b.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span className="min-w-0 truncate font-medium text-stone-800">{b.vendorName}</span>
                  <span className="tnum ml-auto shrink-0 text-stone-600">{formatMoney(b.outstandingMinor)}</span>
                  <Button tone="ghost" size="sm" onClick={() => onPay(b)}>
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
          <h2 className="text-sm font-semibold text-stone-800">Recent postings</h2>
          <button type="button" onClick={() => onTabChange("journal")} className="cursor-pointer inline-flex items-center gap-0.5 text-[13px] font-medium text-maroon-800 hover:underline">
            Full journal
            <IconArrowRight className="size-3" />
          </button>
        </div>
        {recentEntries.length === 0 ? (
          <EmptyState
            icon={<IconUndo />}
            title="No journal entries yet"
            hint="Post an invoice, bill, sale, or payroll run — or just ask your workmate below."
          />
        ) : (
          <ol className="divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white shadow-xs">
            {recentEntries.map((e) => {
              const isReversal = e.sourceType === "reversal";
              return (
                <li key={e.id} className={cn("flex items-center gap-3 px-4 py-2.5 text-sm", isReversal && "bg-amber-50/50")}>
                  <span className="min-w-0 flex-1 truncate font-medium text-stone-800" title={e.memo}>
                    {isReversal && <IconUndo className="mr-1.5 inline size-3.5 -translate-y-px text-amber-700" />}
                    {e.memo}
                  </span>
                  <Badge tone={e.actorType === "agent" ? "violet" : "neutral"}>{e.actorType}</Badge>
                  <time className="hidden w-24 shrink-0 text-right text-xs text-stone-400 sm:block" title={formatDateTime(e.postedAt)}>
                    {formatDateTime(e.postedAt)}
                  </time>
                  <span className="tnum w-24 shrink-0 text-right font-medium">{formatMoney(e.amountMinor)}</span>
                  {!isReversal && !data.entries.some((x) => x.reversalOfId === e.id) && (
                    <Button tone="ghost" size="sm" onClick={() => onReverse(e)}>
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

function Figure({ label, value, note, tone = "default" }: { label: string; value: string; note?: string; tone?: "default" | "warn" | "danger" }) {
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
        {note && <span className="text-xs font-medium text-amber-700">{note}</span>}
      </dd>
    </div>
  );
}

function QuietLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 rounded-xl border border-dashed border-stone-200 px-4 py-4 text-sm text-stone-400">
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
        <h2 className="text-sm font-semibold text-stone-800">Journal entries</h2>
        <label className="relative">
          <span className="sr-only">Search journal entries</span>
          <IconSearch className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-stone-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by memo, source, actor…"
            className="input h-8 w-64 pl-8 text-xs"
          />
        </label>
      </div>

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
          hint={search ? "Try a different filter." : "Post an invoice, bill, sale, or payroll run — or just ask your workmate."}
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
                const reversed = data.entries.some((x) => x.reversalOfId === e.id);
                const isReversal = e.sourceType === "reversal";
                return (
                  <tr key={e.id} className={isReversal ? "bg-amber-50/50" : undefined}>
                    <td className="max-w-xs truncate font-medium text-stone-800" title={e.memo}>
                      {isReversal && <IconUndo className="mr-1.5 inline size-3.5 -translate-y-px text-amber-700" />}
                      {e.memo}
                    </td>
                    <td className="font-mono text-xs text-stone-500">{e.sourceType ?? "manual"}</td>
                    <td>
                      <Badge tone={e.actorType === "agent" ? "violet" : "neutral"}>{e.actorType}</Badge>
                    </td>
                    <td className="text-xs whitespace-nowrap text-stone-500" title={formatDateTime(e.postedAt)}>
                      {formatDateTime(e.postedAt)}
                    </td>
                    <td className="num font-medium">{formatMoney(e.amountMinor)}</td>
                    <td className="text-right whitespace-nowrap">
                      {!isReversal && !reversed && (
                        <Button tone="ghost" size="sm" onClick={() => onReverse(e)}>
                          Reverse
                        </Button>
                      )}
                      {reversed && <span className="text-xs text-stone-400">reversed</span>}
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

function ReceivablesSection({ a, agingInvoices }: { a: Overview["aging"]; agingInvoices: Overview["agingInvoices"] }) {
  const [emailFor, setEmailFor] = useState<number | null>(null);
  const [emailTo, setEmailTo] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailNote, setEmailNote] = useState<string | null>(null);

  async function sendInvoice(number: number) {
    setEmailBusy(true);
    setEmailNote(null);
    const res = await postApi<{ sent?: boolean; reason?: string }>("/api/email", {
      action: "emailInvoice",
      invoiceNumber: number,
      to: emailTo.trim(),
    });
    setEmailBusy(false);
    if (res.ok) {
      setEmailFor(null);
      setEmailTo("");
      setEmailNote(`Invoice #${number} sent.`);
    } else {
      setEmailNote(res.error?.title ?? "Couldn't send — is SMTP configured in Settings?");
    }
  }

  return (
    <section>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <StatCard label="Current" value={formatMoney(a.current)} />
        <StatCard label="31–60 days" value={formatMoney(a.d30)} tone={a.d30 > 0 ? "warn" : "default"} />
        <StatCard label="61–90 days" value={formatMoney(a.d60)} tone={a.d60 > 0 ? "warn" : "default"} />
        <StatCard label="90+ days" value={formatMoney(a.d90plus)} tone={a.d90plus > 0 ? "danger" : "default"} />
        <StatCard label="Total outstanding" value={formatMoney(a.totalOutstanding)} tone="accent" className="col-span-2 sm:col-span-1" />
      </div>

      {agingInvoices.length > 0 ? (
        <ul className="mt-4 divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white px-4 shadow-xs">
          {agingInvoices.map((inv) => (
            <li key={inv.number} className="py-2.5 text-sm">
              <div className="flex items-center gap-3">
                <span className="font-medium text-stone-800">Invoice #{inv.number}</span>
                <span className="tnum ml-auto text-stone-600">{formatMoney(inv.outstandingMinor)}</span>
                <Badge tone={inv.ageDays > 60 ? "red" : inv.ageDays > 30 ? "amber" : "neutral"}>{inv.ageDays}d old</Badge>
                <button
                  type="button"
                  aria-label={`Email invoice ${inv.number}`}
                  title="Email this invoice to the customer"
                  onClick={() => setEmailFor(emailFor === inv.number ? null : inv.number)}
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
                  <Button size="sm" disabled={emailBusy || !/.+@.+\..+/.test(emailTo)} onClick={() => void sendInvoice(inv.number)}>
                    Send with share link
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <QuietLine>No outstanding invoices — receivables are clear.</QuietLine>
      )}
      {emailNote && <p className="mt-2 text-xs text-stone-500">{emailNote}</p>}
    </section>
  );
}

function PayablesSection({
  bills,
  openBills,
  onPay,
}: {
  bills: Overview["bills"];
  openBills: Overview["bills"];
  onPay: (b: Overview["bills"][number]) => void;
}) {
  const total = openBills.reduce((s, b) => s + b.outstandingMinor, 0);
  if (bills.length === 0)
    return <EmptyState icon={<IconInbox />} title="No vendor bills yet" hint="Record a bill from Purchasing, or ask your workmate to log one." />;
  return (
    <section>
      <p className="mb-3 text-sm text-stone-500">
        Outstanding with vendors: <strong className="tnum font-medium text-stone-900">{formatMoney(total)}</strong> across{" "}
        {openBills.length} bill{openBills.length === 1 ? "" : "s"}.
      </p>
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
                <td className="num font-medium">{formatMoney(b.outstandingMinor)}</td>
                <td className="text-right">
                  {b.outstandingMinor > 0 && (
                    <Button tone="secondary" size="sm" onClick={() => onPay(b)}>
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

function ReportsSection({ reports, cash, year }: { reports: Reports; cash: CashBasis | null; year: number }) {
  return (
    <section className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>Profit &amp; loss · to date</CardTitle>
          <table className="w-full text-sm">
            <tbody>
              {reports.pnl.lines.map((l) => (
                <tr key={l.code}>
                  <td className="py-1.5 text-stone-600">{l.name}</td>
                  <td className="num py-1.5">{formatMoney(l.amountMinor)}</td>
                </tr>
              ))}
              <tr className="border-t border-stone-200">
                <td className="pt-2.5 font-semibold text-stone-900">Net income</td>
                <td
                  className={cn(
                    "num pt-2.5 font-semibold",
                    reports.pnl.netIncomeMinor >= 0 ? "text-emerald-700" : "text-red-700",
                  )}
                >
                  {formatMoney(reports.pnl.netIncomeMinor)}
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
              Assets ≠ liabilities + equity. This should be impossible — treat it as corruption and investigate before
              trusting any figure.
            </p>
          )}
          <table className="w-full text-sm">
            <tbody>
              <tr>
                <td className="py-1.5 text-stone-600">Assets</td>
                <td className="num py-1.5">{formatMoney(reports.balanceSheet.assetsMinor)}</td>
              </tr>
              <tr>
                <td className="py-1.5 text-stone-600">Liabilities</td>
                <td className="num py-1.5">{formatMoney(reports.balanceSheet.liabilitiesMinor)}</td>
              </tr>
              <tr>
                <td className="py-1.5 text-stone-600">Equity</td>
                <td className="num py-1.5">{formatMoney(reports.balanceSheet.equityMinor)}</td>
              </tr>
              <tr>
                <td className="py-1.5 text-stone-600">Current result</td>
                <td className="num py-1.5">{formatMoney(reports.balanceSheet.retainedResultMinor)}</td>
              </tr>
              <tr className="border-t border-stone-200">
                <td className="pt-2.5 font-semibold text-stone-900">Liabilities + equity</td>
                <td className="num pt-2.5 font-semibold text-stone-900">
                  {formatMoney(
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
          <StatCard label={`Cash in ${year}`} value={formatMoney(cash.cashInMinor)} />
          <StatCard label="Cash out" value={formatMoney(cash.cashOutMinor)} />
          <StatCard label="Net cash movement" value={formatMoney(cash.netCashMinor)} tone={cash.netCashMinor >= 0 ? "accent" : "danger"} />
          <StatCard label="Booked but uncollected" value={formatMoney(cash.uncollectedMinor)} tone={cash.uncollectedMinor > 0 ? "warn" : "default"} />
        </div>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------- periods -- */

function PeriodsSection({
  closedPeriods,
  onOpenClose,
  onCloseYear,
  busy,
}: {
  closedPeriods: Overview["closedPeriods"];
  onOpenClose: () => void;
  onCloseYear: (year: number) => Promise<void>;
  busy: boolean;
}) {
  const year = new Date().getUTCFullYear();
  const [yearInput, setYearInput] = useState(String(year));
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <section className="max-w-xl space-y-8">
      <div>
        <h2 className="text-sm font-semibold text-stone-800">Close a period</h2>
        <p className="mt-1 text-sm leading-relaxed text-stone-500">
          Sealing a month refuses new postings to it. Reopening is a gated destructive action, so make sure the month is
          reconciled first.
        </p>
        <Button tone="secondary" className="mt-3" onClick={onOpenClose}>
          <IconLock className="size-3.5" />
          Close period…
        </Button>
        {closedPeriods.length > 0 && (
          <p className="mt-4 flex flex-wrap items-center gap-1.5 text-xs text-stone-500">
            Sealed:
            {closedPeriods.map((p) => (
              <Badge key={`${p.year}-${p.month}`}>
                {p.year}-{String(p.month).padStart(2, "0")}
              </Badge>
            ))}
          </p>
        )}
      </div>

      <div className="border-t border-stone-200 pt-6">
        <h2 className="text-sm font-semibold text-stone-800">Year-end close</h2>
        <p className="mt-1 text-sm leading-relaxed text-stone-500">
          Zeroes income and expense accounts into retained earnings with one balanced entry, then seals December.
          Approval-gated.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input
            className="input w-28"
            placeholder={String(year)}
            value={yearInput}
            onChange={(e) => setYearInput(e.target.value)}
            aria-label="Fiscal year to close"
          />
          <Button tone="danger" disabled={busy || !yearInput} onClick={() => setConfirmOpen(true)}>
            Close year, roll retained earnings
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={async () => {
          await onCloseYear(Number(yearInput));
          setConfirmOpen(false);
        }}
        title={`Close fiscal year ${yearInput}`}
        body={
          <>
            Post the closing entry for {yearInput}, rolling net income into retained earnings and sealing December{" "}
            {yearInput}. This is a destructive-class action and requires approval.
          </>
        }
        confirmLabel={`Close ${yearInput}`}
        busy={busy}
      />
    </section>
  );
}
/* -------------------------------------------------------------------- bank -- */

/** Parses pasted CSV lines of `YYYY-MM-DD,amount,description`; amounts may carry commas. */
function parseFeedCsv(text: string): { rows: { postedAt: string; amountMinor: number; description: string }[]; errors: string[] } {
  const rows: { postedAt: string; amountMinor: number; description: string }[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    const m = t.match(/^(\d{4}-\d{2}-\d{2})\s*,\s*(-?[\d,]+(?:\.\d+)?)\s*,\s*(.+)$/);
    const datePart = m?.[1];
    const amountPart = m?.[2];
    const descPart = m?.[3];
    if (!datePart || !amountPart || !descPart) {
      errors.push(`line ${i + 1}: expected date,amount,description`);
      return;
    }
    const amount = Number(amountPart.replace(/,/g, ""));
    if (!Number.isFinite(amount)) {
      errors.push(`line ${i + 1}: "${amountPart}" is not a number`);
      return;
    }
    rows.push({ postedAt: datePart, amountMinor: Math.round(amount * 100), description: descPart.trim() });
  });
  return { rows, errors };
}

function BankSection({
  banking,
  busy,
  onAction,
}: {
  banking: Banking | null;
  busy: boolean;
  onAction: (payload: Record<string, unknown>, label: string) => Promise<void>;
}) {
  const [feed, setFeed] = useState("");
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [accountId, setAccountId] = useState("");
  const [newName, setNewName] = useState("");
  const [newLast4, setNewLast4] = useState("");
  const [matchPicks, setMatchPicks] = useState<Record<string, string>>({});

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
  const accounts = banking.accounts;

  function addAccount() {
    if (!newName.trim()) return;
    void onAction(
      { action: "addBankAccount", name: newName.trim(), last4: newLast4.trim() || undefined },
      `Add account “${newName.trim()}”`,
    );
    setNewName("");
    setNewLast4("");
  }

  function importFeed() {
    const { rows, errors } = parseFeedCsv(feed);
    setParseErrors(errors);
    if (rows.length === 0) return;
    void onAction(
      { action: "importBankFeed", bankAccountId: accountId || undefined, rows },
      `Import ${rows.length} statement line${rows.length === 1 ? "" : "s"}`,
    );
    setFeed("");
  }

  return (
    <section className="max-w-3xl space-y-8">
      <p className="tnum text-sm text-stone-600">
        <span className={cn("font-semibold", summary.unmatchedCount > 0 ? "text-amber-700" : "text-emerald-700")}>
          {summary.unmatchedCount}
        </span>{" "}
        unmatched statement line{summary.unmatchedCount === 1 ? "" : "s"}
      </p>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-stone-800">Accounts</h2>
        {accounts.length === 0 ? (
          <QuietLine>No bank accounts yet — add one below to start importing statements.</QuietLine>
        ) : (
          <ul className="divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white shadow-xs">
            {accounts.map((a) => {
              const stat = summary.accounts.find((s) => s.bankAccountId === a.id);
              return (
                <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                  <span className="font-medium text-stone-800">{a.name}</span>
                  {a.last4 && <span className="text-stone-400">••••{a.last4}</span>}
                  <Badge>{a.currencyCode}</Badge>
                  {stat && <Badge tone={stat.count > 0 ? "amber" : "green"}>{stat.count} lines</Badge>}
                  <span className="tnum ml-auto font-medium">{formatMoney(a.balanceMinor)}</span>
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
          <Button tone="secondary" disabled={busy || !newName.trim()} onClick={addAccount}>
            Add account
          </Button>
        </div>
      </div>


      <div className="border-t border-stone-200 pt-6">
        <h2 className="text-sm font-semibold text-stone-800">Import feed</h2>
        <p className="mt-1 text-sm leading-relaxed text-stone-500">
          Paste bank export lines, one per row: <code className="text-stone-700">date,amount,description</code> — e.g.
          <code className="ml-1 text-stone-700">2025-06-01,-42.10,Card fees</code>. Positive is money in. Duplicate lines
          are skipped automatically, so re-pasting an export is safe.
        </p>
        {accounts.length > 1 && (
          <select
            className="input mt-3 w-64"
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
        <textarea
          className="input mt-3 h-32 w-full font-mono text-xs"
          placeholder={"2025-06-01,1250.00,ACME wire\n2025-06-02,-42.10,Card fees"}
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
        <Button className="mt-3" disabled={busy || !feed.trim()} onClick={importFeed}>
          Import lines
        </Button>
      </div>

      <div className="border-t border-stone-200 pt-6">
        <h2 className="text-sm font-semibold text-stone-800">Unmatched transactions</h2>
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
              <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-sm">
                <time className="w-20 shrink-0 text-xs text-stone-400">{t.postedAt.slice(0, 10)}</time>
                <span className="min-w-0 flex-1 truncate text-stone-800" title={t.description}>
                  {t.description}
                </span>
                <span className={cn("tnum shrink-0 font-medium", t.amountMinor < 0 && "text-red-700")}>
                  {formatMoney(t.amountMinor)}
                </span>
                <select
                  className="input w-56 py-1 text-xs"
                  value={matchPicks[t.id] ?? ""}
                  onChange={(e) => setMatchPicks((p) => ({ ...p, [t.id]: e.target.value }))}
                  aria-label={`Match ${t.description} against payment`}
                >
                  <option value="">Match to payment…</option>
                  {banking.payments.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.customerName} · #{p.invoiceNumber ?? "?"} · {formatMoney(p.amountMinor)}
                    </option>
                  ))}
                </select>
                <Button
                  tone="secondary"
                  size="sm"
                  disabled={busy || !matchPicks[t.id]}
                  onClick={() =>
                    void onAction(
                      { action: "matchBankTransaction", transactionId: t.id, paymentId: matchPicks[t.id] },
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
                  onClick={() => void onAction({ action: "excludeBankTransaction", transactionId: t.id }, "Exclude")}
                >
                  Exclude
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}


/* --------------------------------------------------------------------- tax -- */

function TaxSection({
  filings,
  busy,
  onAction,
}: {
  filings: Filing[];
  busy: boolean;
  onAction: (payload: Record<string, unknown>, label: string) => Promise<void>;
}) {
  const year = new Date().getUTCFullYear();
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(`${year}-12-31`);
  const [report, setReport] = useState<{ taxableSalesMinor: number; taxCollectedMinor: number } | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function runReport() {
    setRunning(true);
    setReportError(null);
    try {
      const res = await postApi<{ taxableSalesMinor: number; taxCollectedMinor: number }>("/api/accounting", {
        action: "salesTaxReport",
        from,
        to,
      });
      if (!res.ok || !res.data) {
        setReportError(res.error?.hint ?? "Couldn't compute the report");
        setReport(null);
      } else {
        setReport(res.data);
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="max-w-xl space-y-8">
      <div>
        <h2 className="text-sm font-semibold text-stone-800">Sales tax report</h2>
        <p className="mt-1 text-sm leading-relaxed text-stone-500">
          Totals the tax collected on non-void invoices inside the window (vendor bill lines carry no tax today, so this
          is the collected side only).
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input type="date" className="input w-40" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Period from" />
          <span className="text-stone-400">→</span>
          <input type="date" className="input w-40" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Period to" />
          <Button tone="secondary" disabled={busy || running || !from || !to} onClick={() => void runReport()}>
            Run report
          </Button>
        </div>
        {reportError && <p className="mt-2 text-sm text-red-700">{reportError}</p>}
        {report && (
          <dl className="mt-4 grid grid-cols-2 gap-x-8 border-y border-stone-200 py-4">
            <Figure label="Taxable sales" value={formatMoney(report.taxableSalesMinor)} />
            <Figure label="Tax collected" value={formatMoney(report.taxCollectedMinor)} tone="default" />
          </dl>
        )}
      </div>

      <div className="border-t border-stone-200 pt-6">
        <h2 className="text-sm font-semibold text-stone-800">File return</h2>
        <p className="mt-1 text-sm leading-relaxed text-stone-500">
          Filing debits Sales Tax Payable for the remitted tax and credits Cash, then seals{" "}
          <strong className="text-stone-700">{from}</strong> → <strong className="text-stone-700">{to}</strong> against
          double filing. Overlapping returns are refused.
        </p>
        <Button
          className="mt-3"
          tone="danger"
          disabled={busy || !report || report.taxCollectedMinor <= 0}
          onClick={() => setConfirmOpen(true)}
        >
          File return for {from} → {to}
        </Button>
        {!report && <p className="mt-2 text-xs text-stone-500">Run the report first — the filing uses its figures.</p>}
      </div>


      <div className="border-t border-stone-200 pt-6">
        <h2 className="text-sm font-semibold text-stone-800">Recent filings</h2>
        {filings.length === 0 ? (
          <div className="mt-3">
            <QuietLine>No returns filed yet.</QuietLine>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white shadow-xs">
            {filings.map((f) => (
              <li key={f.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="font-medium text-stone-800">
                  {f.periodFrom} → {f.periodTo}
                </span>
                <span className="tnum ml-auto font-medium">{formatMoney(f.taxMinor)}</span>
                <time className="hidden w-24 shrink-0 text-right text-xs text-stone-400 sm:block">
                  {formatDateTime(f.filedAt)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={async () => {
          if (!report) return;
          await onAction(
            {
              action: "fileSalesTaxReturn",
              periodFrom: from,
              periodTo: to,
              taxMinor: report.taxCollectedMinor,
            },
            `File sales tax return ${from} → ${to}`,
          );
          setReport(null);
          setConfirmOpen(false);
        }}
        title="File sales tax return"
        body={
          <>
            File a return for <strong className="text-stone-900">{from}</strong> →{" "}
            <strong className="text-stone-900">{to}</strong> declaring{" "}
            <strong className="text-stone-900">{report ? formatMoney(report.taxCollectedMinor) : ""}</strong> of
            collected tax? This posts a ledger entry and refuses any overlapping future filing.
          </>
        }
        confirmLabel="File return"
        busy={busy}
      />
    </section>
  );
}

