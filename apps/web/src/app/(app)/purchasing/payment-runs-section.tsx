"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardTitle, ConfirmDialog, Dialog } from "@/components/ui";
import { IconFileText, IconSearch } from "@/components/icons";
import { callApi, postApi } from "@/lib/api";
import { minorToInputIn, toMinorIn } from "@/lib/format";
import { formatMoneyIn } from "@/lib/prefs";

export type PaymentRunBill = { id: string; number: number; vendorName: string; vendorRef: string | null; currency: string; dueMinor: number };
type PaymentRun = {
  id: string;
  reference: string;
  currency: string;
  totalMinor: number;
  status: "draft" | "instructed" | "confirmed" | "reversed" | "cancelled";
  createdAt: string;
  instructedAt: string | null;
  confirmedAt: string | null;
  entryId: string | null;
  lines: { billId: string; billNumber: number; vendorName: string; vendorRef: string | null; amountMinor: number }[];
};
type RunEnvelope = { ok?: boolean; data?: { runs?: PaymentRun[] }; error?: string; reason?: string };
type RunAction = { action: "instruct" | "cancel" | "reverse"; run: PaymentRun } | null;

function statusTone(status: PaymentRun["status"]): "neutral" | "green" | "amber" | "red" | "blue" {
  if (status === "confirmed") return "green";
  if (status === "instructed") return "amber";
  if (status === "draft") return "blue";
  if (status === "reversed") return "red";
  return "neutral";
}

function csvCell(value: string | number): string {
  const raw = String(value);
  return `"${raw.replaceAll('"', '""')}"`;
}

function downloadCsv(filename: string, rows: (string | number)[][]) {
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function PaymentRunsSection({ bills, onRefresh }: { bills: PaymentRunBill[]; onRefresh: () => void }) {
  const [runs, setRuns] = useState<PaymentRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "pending"; text: string } | null>(null);
  const [confirmAction, setConfirmAction] = useState<RunAction>(null);
  const [reverseReason, setReverseReason] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const res = await callApi<RunEnvelope>("/api/purchasing/payment-runs");
    if (!res.ok || !res.data?.data) {
      setRuns([]);
      setLoadError(res.error?.title ?? res.data?.error ?? "Could not load supplier payment runs.");
    } else {
      setRuns(res.data.data.runs ?? []);
    }
    setLoading(false);
  }, [refresh]);

  useEffect(() => { void load(); }, [load]);

  const visibleBills = useMemo(() => {
    const query = search.trim().toLowerCase();
    return bills.filter((bill) => !query || String(bill.number).includes(query) || bill.vendorName.toLowerCase().includes(query) || (bill.vendorRef ?? "").toLowerCase().includes(query));
  }, [bills, search]);
  const selectedBills = useMemo(() => selectedIds.map((id) => bills.find((bill) => bill.id === id)).filter((bill): bill is PaymentRunBill => Boolean(bill)), [bills, selectedIds]);
  const selectedCurrencies = [...new Set(selectedBills.map((bill) => bill.currency))];
  const selectedTotalMinor = selectedBills.reduce((sum, bill) => {
    const amount = toMinorIn(bill.currency, amounts[bill.id] ?? minorToInputIn(bill.currency, bill.dueMinor));
    return sum + (Number.isSafeInteger(amount) && amount > 0 ? amount : 0);
  }, 0);
  const currentCurrency = selectedCurrencies.length === 1 ? selectedCurrencies[0]! : "";

  function toggleBill(bill: PaymentRunBill) {
    setSelectedIds((current) => current.includes(bill.id) ? current.filter((id) => id !== bill.id) : [...current, bill.id]);
    setAmounts((current) => ({ ...current, [bill.id]: current[bill.id] ?? minorToInputIn(bill.currency, bill.dueMinor) }));
  }

  function selectVisibleBills() {
    const currency = visibleBills[0]?.currency;
    if (!currency) return;
    const sameCurrency = visibleBills.filter((bill) => bill.currency === currency);
    setSelectedIds((current) => [...new Set([...current, ...sameCurrency.map((bill) => bill.id)])]);
    setAmounts((current) => Object.fromEntries([...sameCurrency.map((bill) => [bill.id, current[bill.id] ?? minorToInputIn(bill.currency, bill.dueMinor)]), ...Object.entries(current).filter(([id]) => !sameCurrency.some((bill) => bill.id === id))]));
  }

  async function perform(action: "create" | "instruct" | "cancel" | "reverse", run?: PaymentRun) {
    if (action === "create") {
      const lines = selectedBills.map((bill) => ({ billId: bill.id, amountMinor: toMinorIn(bill.currency, amounts[bill.id] ?? minorToInputIn(bill.currency, bill.dueMinor)) }));
      if (selectedCurrencies.length !== 1 || lines.some((line) => !Number.isSafeInteger(line.amountMinor) || line.amountMinor <= 0)) {
        setNotice({ tone: "error", text: "Use positive payment amounts and select bills in one currency per run." });
        return;
      }
      const res = await submit({ action, lines, memo: memo.trim() || undefined }, "Payment run draft");
      if (res) {
        setSelectedIds([]);
        setMemo("");
        onRefresh();
      }
      return;
    }
    if (!run) return;
    const reason = action === "reverse" ? reverseReason.trim() : undefined;
    const res = await submit({ action, paymentRunId: run.id, ...(reason ? { reason } : {}) }, action === "instruct" ? "Payment instruction" : action === "cancel" ? "Draft cancellation" : "Run reversal");
    if (res) {
      setConfirmAction(null);
      setReverseReason("");
      onRefresh();
    }
  }

  async function submit(body: Record<string, unknown>, label: string): Promise<boolean> {
    setBusy(true);
    setNotice(null);
    try {
      const res = await postApi<RunEnvelope>("/api/purchasing/payment-runs", { ...body, intentId: crypto.randomUUID() });
      if (res.status === 202) {
        setNotice({ tone: "pending", text: res.data?.reason ?? `${label} is waiting for approval.` });
        setRefresh((value) => value + 1);
      } else if (!res.ok) {
        setNotice({ tone: "error", text: res.error?.title ?? res.data?.error ?? `${label} could not be completed.` });
      } else {
        setNotice({ tone: "success", text: `${label} recorded.` });
        setRefresh((value) => value + 1);
        return true;
      }
    } catch {
      setNotice({ tone: "error", text: `Could not complete ${label.toLowerCase()}. Check your connection and try again.` });
    } finally {
      setBusy(false);
    }
    return false;
  }

  function exportSchedule(run: PaymentRun) {
    downloadCsv(`${run.reference.toLowerCase()}-bank-schedule.csv`, [
      ["Payment run", "Supplier", "Bill number", "Amount", "Currency", "Payment reference"],
      ...run.lines.map((line) => [run.reference, line.vendorName, line.billNumber, minorToInputIn(run.currency, line.amountMinor), run.currency, run.reference]),
    ]);
  }

  function exportRemittance(run: PaymentRun) {
    downloadCsv(`${run.reference.toLowerCase()}-remittance-advice.csv`, [
      ["Supplier", "Supplier invoice reference", "Bill number", "Payment amount", "Currency", "Remittance reference"],
      ...run.lines.map((line) => [line.vendorName, line.vendorRef ?? "", line.billNumber, minorToInputIn(run.currency, line.amountMinor), run.currency, run.reference]),
    ]);
  }

  return (
    <section className="space-y-4">
      {notice && <div role={notice.tone === "error" ? "alert" : "status"} className={`rounded-xl border px-4 py-3 text-sm ${notice.tone === "error" ? "border-rose-200 bg-rose-50 text-rose-800" : notice.tone === "pending" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>{notice.text}</div>}

      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div><CardTitle>Build a supplier payment run</CardTitle><p className="-mt-2 max-w-3xl text-sm text-stone-600">Choose open bills in one currency, review each amount, then save a draft for approval and bank instructions.</p></div>
          <Button size="sm" tone="secondary" disabled={visibleBills.length === 0} onClick={selectVisibleBills}>Select visible bills</Button>
        </div>
        {bills.length === 0 ? <p className="rounded-lg bg-stone-50 px-4 py-3 text-sm text-stone-600">No payable bills are available. New open bills will appear here.</p> : <>
          <label className="relative mt-3 block max-w-md"><span className="sr-only">Search payable bills</span><IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" /><input className="input pl-9" placeholder="Search supplier, bill or vendor reference" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          <div className="table-shell mt-3 overflow-x-auto">
            <table className="data-table min-w-[760px]">
              <thead><tr><th><span className="sr-only">Select bill</span></th><th>Bill</th><th>Supplier</th><th>Vendor reference</th><th className="text-right">Outstanding</th><th className="text-right">Pay amount</th></tr></thead>
              <tbody>{visibleBills.map((bill) => {
                const checked = selectedIds.includes(bill.id);
                return <tr key={bill.id}>
                  <td><input aria-label={`Select bill ${bill.number} from ${bill.vendorName}`} className="size-4 accent-emerald-700" type="checkbox" checked={checked} onChange={() => toggleBill(bill)} /></td>
                  <td className="tnum">#{bill.number}</td><td className="font-medium text-stone-800">{bill.vendorName}</td><td className="text-stone-600">{bill.vendorRef || "-"}</td>
                  <td className="num">{formatMoneyIn(bill.currency, bill.dueMinor)}</td>
                  <td className="num">{checked ? <label><span className="sr-only">Payment amount for bill {bill.number}</span><input className="input h-9 w-32 text-right" inputMode="decimal" value={amounts[bill.id] ?? minorToInputIn(bill.currency, bill.dueMinor)} onChange={(event) => setAmounts((current) => ({ ...current, [bill.id]: event.target.value }))} /></label> : <span className="text-stone-600">Select bill</span>}</td>
                </tr>;
              })}</tbody>
            </table>
          </div>
          {visibleBills.length === 0 && <p className="py-4 text-center text-sm text-stone-600">No open bills match that search.</p>}
          {selectedIds.length > 0 && <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm font-semibold text-stone-800">{selectedBills.length} bill{selectedBills.length === 1 ? "" : "s"} selected</p><p className="mt-1 text-sm text-stone-600">{selectedCurrencies.length === 1 ? `Run total: ${formatMoneyIn(currentCurrency, selectedTotalMinor)}` : "Payment runs must use one currency. Split this selection by currency."}</p></div><Button size="sm" tone="ghost" onClick={() => setSelectedIds([])}>Clear selection</Button></div>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end"><label className="min-w-56 flex-1 text-xs font-medium text-stone-600">Run memo <span className="font-normal text-stone-400">(optional)</span><input className="input mt-1 block w-full" maxLength={500} placeholder="Supplier payments for week 39" value={memo} onChange={(event) => setMemo(event.target.value)} /></label><Button disabled={busy || selectedCurrencies.length !== 1 || selectedBills.length === 0 || selectedBills.some((bill) => { const amount = toMinorIn(bill.currency, amounts[bill.id] ?? minorToInputIn(bill.currency, bill.dueMinor)); return !Number.isSafeInteger(amount) || amount <= 0 || amount > bill.dueMinor; })} loading={busy} onClick={() => void perform("create")}>Save payment draft</Button></div>
            {selectedBills.some((bill) => toMinorIn(bill.currency, amounts[bill.id] ?? minorToInputIn(bill.currency, bill.dueMinor)) > bill.dueMinor) && <p role="alert" className="mt-2 text-xs text-rose-700">A payment cannot exceed its bill's outstanding balance.</p>}
          </div>}
        </>}
      </Card>

      <Card>
        <CardTitle right={<Button size="sm" tone="ghost" onClick={() => setRefresh((value) => value + 1)}>Refresh</Button>}>Payment runs and remittance advice</CardTitle>
        <p className="-mt-2 mb-4 text-sm text-stone-600">Approval posts one ledger entry. Bank confirmation is recorded when you match the consolidated debit in Bank. Downloads are schedules for your bank workflow and do not contain supplier bank account details.</p>
        {loadError ? <div className="flex flex-wrap items-center gap-3"><p role="alert" className="text-sm text-red-700">{loadError}</p><Button size="sm" tone="secondary" onClick={() => setRefresh((value) => value + 1)}>Retry</Button></div> : loading ? <p role="status" className="text-sm text-stone-600">Loading payment run history…</p> : runs.length === 0 ? <p className="rounded-lg bg-stone-50 px-4 py-5 text-center text-sm text-stone-600">No payment runs yet. Select open bills above to prepare one.</p> : <div className="space-y-3">
          {runs.map((run) => <article key={run.id} className="rounded-xl border border-stone-200 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="font-mono text-sm font-semibold text-stone-900">{run.reference}</h3><Badge tone={statusTone(run.status)}>{run.status === "confirmed" ? "Bank confirmed" : run.status}</Badge></div><p className="mt-1 text-xs text-stone-600">Created {new Date(run.createdAt).toLocaleString()}{run.confirmedAt ? ` · matched ${new Date(run.confirmedAt).toLocaleString()}` : run.instructedAt ? ` · instructed ${new Date(run.instructedAt).toLocaleString()}` : ""}</p></div>
              <div className="sm:text-right"><p className="tnum text-base font-semibold">{formatMoneyIn(run.currency, run.totalMinor)}</p><p className="text-xs text-stone-600">{run.lines.length} supplier payment{run.lines.length === 1 ? "" : "s"}</p></div>
            </div>
            <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[36rem] text-sm"><thead><tr className="text-left text-xs text-stone-600"><th className="py-1">Supplier</th><th>Bill</th><th>Payment reference</th><th className="text-right">Amount</th></tr></thead><tbody>{run.lines.map((line) => <tr key={line.billId} className="border-t border-stone-100"><td className="py-2 font-medium text-stone-700">{line.vendorName}</td><td>#{line.billNumber}</td><td className="font-mono text-xs text-stone-600">{run.reference}</td><td className="num">{formatMoneyIn(run.currency, line.amountMinor)}</td></tr>)}</tbody></table></div>
            <div className="mt-3 flex flex-wrap gap-2 border-t border-stone-100 pt-3">
              <Button size="sm" tone="secondary" onClick={() => exportSchedule(run)}><IconFileText className="size-3.5" /> Download transfer schedule</Button>
              <Button size="sm" tone="secondary" onClick={() => exportRemittance(run)}>Download remittance advice</Button>
              {run.status === "draft" && <><Button size="sm" disabled={busy} onClick={() => setConfirmAction({ action: "instruct", run })}>Request approval and instruct</Button><Button size="sm" tone="ghost" disabled={busy} onClick={() => setConfirmAction({ action: "cancel", run })}>Cancel draft</Button></>}
              {run.status === "instructed" && <Button size="sm" tone="danger" disabled={busy} onClick={() => setConfirmAction({ action: "reverse", run })}>Reverse unconfirmed run</Button>}
              {run.status === "instructed" && <p className="basis-full text-xs text-amber-800">To confirm, import the bank statement and match its consolidated debit to the journal memo containing {run.reference}. Do not reverse after the bank has sent the funds.</p>}
            </div>
          </article>)}
        </div>}
      </Card>

      <ConfirmDialog open={confirmAction?.action === "instruct"} onClose={() => setConfirmAction(null)} onConfirm={() => { if (confirmAction?.action === "instruct") void perform("instruct", confirmAction.run); }} title={`Approve ${confirmAction?.run.reference ?? "payment run"}`} body={<>This records a single {confirmAction ? formatMoneyIn(confirmAction.run.currency, confirmAction.run.totalMinor) : ""} cash payment, allocates it across {confirmAction?.run.lines.length ?? 0} supplier bills, and prepares a bank schedule. Bank execution happens separately.</>} confirmLabel="Request payment approval" busy={busy} />
      <ConfirmDialog open={confirmAction?.action === "cancel"} onClose={() => setConfirmAction(null)} onConfirm={() => { if (confirmAction?.action === "cancel") void perform("cancel", confirmAction.run); }} title="Cancel payment draft" body="This keeps the run in history as cancelled and returns its bills to the payable list." confirmLabel="Cancel draft" busy={busy} />
      <Dialog open={confirmAction?.action === "reverse"} onClose={() => { if (!busy) { setConfirmAction(null); setReverseReason(""); } }} title={`Reverse ${confirmAction?.run.reference ?? "payment run"}`} description="Only reverse when the bank has not sent the funds. The reversal restores each bill balance and writes a mirror ledger entry." footer={<><Button tone="secondary" disabled={busy} onClick={() => setConfirmAction(null)}>Keep run</Button><Button tone="danger" disabled={busy || reverseReason.trim().length < 3} loading={busy} onClick={() => { if (confirmAction?.action === "reverse") void perform("reverse", confirmAction.run); }}>Reverse run</Button></>}>
        <label className="label">Reason<input className="input mt-1" minLength={3} maxLength={500} value={reverseReason} onChange={(event) => setReverseReason(event.target.value)} placeholder="Bank rejected the payment instruction" /></label>
      </Dialog>
    </section>
  );
}
