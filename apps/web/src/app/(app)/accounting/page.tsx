"use client";

import { useCallback, useEffect, useState } from "react";

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

const usd = (minor: number) =>
  (minor < 0 ? "-" : "") +
  "$" +
  (Math.abs(minor) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function AccountingPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [reports, setReports] = useState<Reports | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [monthInput, setMonthInput] = useState("");

  const load = useCallback(() => {
    fetch("/api/accounting")
      .then((r) => r.json())
      .then(setData);
    fetch("/api/reports")
      .then((r) => r.json())
      .then(setReports);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function action(payload: Record<string, unknown>, label: string) {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/accounting", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (res.status === 202) {
        setNotice(`${label} needs human approval — it's in the Approvals inbox.`);
      } else if (!res.ok) {
        setNotice(`${label} failed: ${json.error}`);
      } else {
        setNotice(`${label} done.`);
      }
      load();
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <p className="text-sm text-neutral-400">Loading…</p>;

  const a = data.aging;

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Accounting</h1>
      <p className="mb-6 text-sm text-neutral-500">
        Entries are immutable — corrections are mirror reversals. Periods seal months; closing is a
        gated destructive action.
      </p>

      {notice && <p className="mb-4 rounded-lg bg-emerald-50 px-4 py-2 text-sm text-emerald-800">{notice}</p>}

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Accounts receivable aging
        </h2>
        <div className="grid grid-cols-5 gap-3">
          {(
            [
              ["Current", a.current],
              ["31–60d", a.d30],
              ["61–90d", a.d60],
              ["90d+", a.d90plus],
              ["Total", a.totalOutstanding],
            ] as const
          ).map(([label, value], i) => (
            <div key={label} className={`rounded-xl border p-4 shadow-sm ${i === 4 ? "border-emerald-300 bg-emerald-50/50" : "border-neutral-200 bg-white"}`}>
              <p className="text-xs text-neutral-500">{label}</p>
              <p className="mt-1 text-lg font-semibold">{usd(value)}</p>
            </div>
          ))}
        </div>
        {data.agingInvoices.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm text-neutral-600">
            {data.agingInvoices.map((inv) => (
              <li key={inv.number}>
                Invoice #{inv.number} — {usd(inv.outstandingMinor)} outstanding ·{" "}
                <span className={inv.ageDays > 60 ? "text-red-700" : ""}>{inv.ageDays}d old</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {reports?.pnl && (
        <section className="mb-8 grid gap-6 md:grid-cols-2">
          <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
              Profit &amp; loss (to date)
            </h2>
            <table className="w-full text-sm">
              <tbody>
                {reports.pnl.lines.map((l) => (
                  <tr key={l.code}>
                    <td className="py-1 text-neutral-600">{l.name}</td>
                    <td className="py-1 text-right tabular-nums">{usd(l.amountMinor)}</td>
                  </tr>
                ))}
                <tr className="border-t border-neutral-200 font-semibold">
                  <td className="pt-2">Net income</td>
                  <td className={`pt-2 text-right tabular-nums ${reports.pnl.netIncomeMinor >= 0 ? "text-emerald-700" : "text-red-700"}`}>
                    {usd(reports.pnl.netIncomeMinor)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">
              Balance sheet
              {reports.balanceSheet.balanced ? (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-mono text-[10px] normal-case text-emerald-800">balanced</span>
              ) : (
                <span className="rounded-full bg-red-100 px-2 py-0.5 font-mono text-[10px] normal-case text-red-800">UNBALANCED</span>
              )}
            </h2>
            <table className="w-full text-sm">
              <tbody>
                <tr><td className="py-1 text-neutral-600">Assets</td><td className="py-1 text-right tabular-nums">{usd(reports.balanceSheet.assetsMinor)}</td></tr>
                <tr><td className="py-1 text-neutral-600">Liabilities</td><td className="py-1 text-right tabular-nums">{usd(reports.balanceSheet.liabilitiesMinor)}</td></tr>
                <tr><td className="py-1 text-neutral-600">Equity</td><td className="py-1 text-right tabular-nums">{usd(reports.balanceSheet.equityMinor)}</td></tr>
                <tr><td className="py-1 text-neutral-600">Current result</td><td className="py-1 text-right tabular-nums">{usd(reports.balanceSheet.retainedResultMinor)}</td></tr>
                <tr className="border-t border-neutral-200 font-semibold">
                  <td className="pt-2">L + E + result</td>
                  <td className="pt-2 text-right tabular-nums">
                    {usd(reports.balanceSheet.liabilitiesMinor + reports.balanceSheet.equityMinor + reports.balanceSheet.retainedResultMinor)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {data && data.bills.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">Vendor bills</h2>
          <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-neutral-200 bg-neutral-50 font-mono text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-2.5">#</th>
                  <th className="px-4 py-2.5">Vendor</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5 text-right">Outstanding</th>
                  <th className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {data.bills.filter((b) => b.outstandingMinor > 0).map((b) => (
                  <tr key={b.id} className="border-b border-neutral-100 last:border-0">
                    <td className="px-4 py-2 font-mono text-xs">{b.number}</td>
                    <td className="px-4 py-2">{b.vendorName}</td>
                    <td className="px-4 py-2 font-mono text-xs text-neutral-500">{b.status}</td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums">{usd(b.outstandingMinor)}</td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => action({ action: "payBill", billNumber: b.number, amountMinor: b.outstandingMinor }, `Payment of ${usd(b.outstandingMinor)}`)}
                        disabled={busy}
                        className="text-xs text-emerald-700 underline underline-offset-2 hover:text-emerald-900 disabled:opacity-40"
                      >
                        pay in full
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="mb-8">
        <div className="mb-3 flex items-end justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Journal entries</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const [y, m] = monthInput.split("-").map(Number);
              if (y && m) action({ action: "closePeriod", year: y, month: m }, "Close period");
            }}
            className="flex items-center gap-2"
          >
            <input
              type="month"
              value={monthInput}
              onChange={(e) => setMonthInput(e.target.value)}
              className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm focus:border-emerald-600 focus:outline-none"
            />
            <button
              type="submit"
              disabled={busy || !monthInput}
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100 disabled:opacity-40"
            >
              Close period…
            </button>
          </form>
        </div>
        {data.closedPeriods.length > 0 && (
          <p className="mb-3 text-xs text-neutral-500">
            Closed periods:{" "}
            {data.closedPeriods.map((p) => `${p.year}-${String(p.month).padStart(2, "0")}`).join(", ")}
          </p>
        )}
        <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-neutral-200 bg-neutral-50 font-mono text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-2.5">Memo</th>
                <th className="px-4 py-2.5">Source</th>
                <th className="px-4 py-2.5">By</th>
                <th className="px-4 py-2.5">When</th>
                <th className="px-4 py-2.5 text-right">Amount</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e) => {
                const reversed = data.entries.some((x) => x.reversalOfId === e.id);
                const isReversal = e.sourceType === "reversal";
                return (
                  <tr key={e.id} className={`border-b border-neutral-100 last:border-0 ${isReversal ? "bg-orange-50/40" : ""}`}>
                    <td className="px-4 py-2">{e.memo}</td>
                    <td className="px-4 py-2 font-mono text-xs text-neutral-500">{e.sourceType ?? "manual"}</td>
                    <td className="px-4 py-2">
                      <span className={`rounded-full px-2 py-0.5 font-mono text-xs ${e.actorType === "agent" ? "bg-indigo-100 text-indigo-800" : "bg-neutral-100"}`}>
                        {e.actorType}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs text-neutral-500">{new Date(e.postedAt).toLocaleString()}</td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums">{usd(e.amountMinor)}</td>
                    <td className="px-4 py-2 text-right">
                      {!isReversal && !reversed && (
                        <button
                          onClick={() => action({ action: "reverse", entryId: e.id }, "Reversal")}
                          disabled={busy}
                          className="text-xs text-neutral-400 underline underline-offset-2 hover:text-red-700 disabled:opacity-40"
                        >
                          reverse
                        </button>
                      )}
                      {reversed && <span className="font-mono text-xs text-neutral-400">reversed</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
