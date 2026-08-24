"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
  PageHeader,
  StatCard,
} from "@/components/ui";
import { IconAlertTriangle, IconInbox, IconLock, IconSearch, IconUndo } from "@/components/icons";
import { cn, formatDateTime, formatMoney } from "@/lib/format";
import { useRouter } from "next/navigation";
import { callApi, postApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";

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
}
interface Reports {
  pnl: { revenueMinor: number; expenseMinor: number; netIncomeMinor: number; lines: { code: string; name: string; amountMinor: number }[] };
  balanceSheet: { assetsMinor: number; liabilitiesMinor: number; equityMinor: number; retainedResultMinor: number; balanced: boolean };
}

export default function AccountingPage() {
  const __enabled = useModuleEnabled("accounting");
  const router = useRouter();
  const [data, setData] = useState<Overview | null>(null);
  const [reports, setReports] = useState<Reports | null>(null);
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
    const [ov, rp] = await Promise.all([callApi<Overview>("/api/accounting"), callApi<Reports>("/api/reports")]);
    if (!ov.ok || !rp.ok) {
      setLoadError(ov.error?.title ?? rp.error?.title ?? "Couldn't load your books");
      return;
    }
    setData(ov.data);
    setReports(rp.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
      <div>
        <PageHeader title="Accounting" />
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

  if (!data) return <LoadingPage />;

  const a = data.aging;
  const openBills = data.bills.filter((b) => b.outstandingMinor > 0);

  if (!__enabled) return <ModuleDisabled label="Accounting" />;

  return (
    <div>
      <PageHeader
        title="Accounting"
        description="Entries are immutable, corrections are mirror reversals. Closing a period seals it against further postings."
        actions={
          <Button tone="secondary" onClick={() => setCloseOpen(true)}>
            <IconLock className="size-3.5" />
            Close period…
          </Button>
        }
      />

      {notice && (
        <ActionNotice state={notice} onDismiss={() => setNotice(null)} />
      )}

      {/* AR aging */}
      <section className="mb-8">
        <h2 className="section-title mb-3">Accounts receivable</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          <StatCard label="Current" value={formatMoney(a.current)} />
          <StatCard label="31–60 days" value={formatMoney(a.d30)} tone={a.d30 > 0 ? "warn" : "default"} />
          <StatCard label="61–90 days" value={formatMoney(a.d60)} tone={a.d60 > 0 ? "warn" : "default"} />
          <StatCard label="90+ days" value={formatMoney(a.d90plus)} tone={a.d90plus > 0 ? "danger" : "default"} />
          <StatCard label="Total outstanding" value={formatMoney(a.totalOutstanding)} tone="accent" className="col-span-2 sm:col-span-1" />
        </div>

        {a.totalOutstanding === 0 && openBills.length === 0 ? (
          <p className="mt-3 flex items-center gap-2 text-sm text-stone-400">
            <IconInbox className="size-4" />
            No outstanding invoices or bills, receivables and payables are clear.
          </p>
        ) : (
          data.agingInvoices.length > 0 && (
            <ul className="mt-3 divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white px-4 shadow-xs">
              {data.agingInvoices.map((inv) => (
                <li key={inv.number} className="flex items-center gap-3 py-2.5 text-sm">
                  <span className="font-medium text-stone-800">Invoice #{inv.number}</span>
                  <span className="tnum ml-auto text-stone-600">{formatMoney(inv.outstandingMinor)}</span>
                  <Badge tone={inv.ageDays > 60 ? "red" : inv.ageDays > 30 ? "amber" : "neutral"}>{inv.ageDays}d old</Badge>
                </li>
              ))}
            </ul>
          )
        )}
      </section>

      {/* Cash basis + year-end */}
      <CashBasisSection busy={busy} action={action} />

      {/* Reports */}
      {reports?.pnl && (
        <section className="mb-8 grid gap-4 lg:grid-cols-2">
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
                Assets ≠ liabilities + equity. This should be impossible, treat it as corruption and
                investigate before trusting any figure.
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
        </section>
      )}

      {/* Vendor bills */}
      {openBills.length > 0 && (
        <section className="mb-8">
          <h2 className="section-title mb-3">Vendor bills · outstanding</h2>
          <div className="table-shell">
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Vendor</th>
                  <th>Status</th>
                  <th className="text-right">Outstanding</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {openBills.map((b) => (
                  <tr key={b.id}>
                    <td className="font-mono text-xs text-stone-500">{b.number}</td>
                    <td className="font-medium text-stone-800">{b.vendorName}</td>
                    <td>
                      <Badge>{b.status}</Badge>
                    </td>
                    <td className="num font-medium">{formatMoney(b.outstandingMinor)}</td>
                    <td className="text-right">
                      <Button tone="secondary" size="sm" onClick={() => setPayTarget(b)}>
                        Pay in full
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Journal */}
      <section>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <h2 className="section-title">Journal entries</h2>
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
            hint={
              search
                ? "Try a different filter."
                : "Post an invoice, bill, sale, or payroll run, or just ask your co-worker in the Console."
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
                          <Button tone="ghost" size="sm" onClick={() => setReverseTarget(e)}>
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

      {/* Close period dialog */}
      <Dialog
        open={closeOpen}
        onClose={() => setCloseOpen(false)}
        title="Close a period"
        description="Sealed periods refuse new postings. Reopening is a gated destructive action, make sure the month is reconciled first."
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
            original stays untouched, corrections are always additive.
          </>
        }
        confirmLabel="Post reversal"
        busy={busy}
      />
    </div>
  );
}

/** Cash-basis view + formal year-end close (retained-earnings roll). */
function CashBasisSection({
  busy,
  action,
}: {
  busy: boolean;
  action: (payload: Record<string, unknown>, label: string) => Promise<void>;
}) {
  const year = new Date().getUTCFullYear();
  const [summary, setSummary] = useState<{
    cashInMinor: number;
    cashOutMinor: number;
    netCashMinor: number;
    accrualRevenueMinor: number;
    uncollectedMinor: number;
  } | null>(null);
  const [yearInput, setYearInput] = useState(String(year));
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    // Read via the accounting action endpoint (read-class capability).
    void (async () => {
      const res = await fetch("/api/accounting", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "cashBasis", year }),
      });
      if (res.ok) {
        const j = (await res.json()) as { data?: typeof summary };
        setSummary(j.data ?? null);
      }
    })();
  }, [year]);

  return (
    <section className="mb-8">
      <h2 className="section-title mb-3">Cash basis &amp; year-end</h2>
      <Card>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label={`Cash in ${year}`} value={formatMoney(summary?.cashInMinor ?? 0)} />
          <StatCard label="Cash out" value={formatMoney(summary?.cashOutMinor ?? 0)} />
          <StatCard
            label="Net cash movement"
            value={formatMoney(summary?.netCashMinor ?? 0)}
            tone={(summary?.netCashMinor ?? 0) >= 0 ? "accent" : "danger"}
          />
          <StatCard
            label="Booked but uncollected"
            value={formatMoney(summary?.uncollectedMinor ?? 0)}
            tone={(summary?.uncollectedMinor ?? 0) > 0 ? "warn" : "default"}
          />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
          <input
            className="w-24 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5"
            placeholder={String(year)}
            value={yearInput}
            onChange={(e) => setYearInput(e.target.value)}
            aria-label="Fiscal year to close"
          />
          <Button tone="danger" disabled={busy || !yearInput} onClick={() => setConfirmOpen(true)}>
            Close year, roll retained earnings
          </Button>
          <span className="text-xs text-stone-400">
            Zeroes income and expense accounts into retained earnings with one balanced entry, then seals December.
            Approval-gated.
          </span>
        </div>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={async () => {
          await action({ action: "closeYear", year: Number(yearInput) }, `Year-end close ${yearInput}`);
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
