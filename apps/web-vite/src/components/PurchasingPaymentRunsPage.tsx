import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { currencyMinorUnits } from "@chaste/erp-core";
import {
  fetchPurchasingPaymentRunBills,
  fetchPurchasingPaymentRuns,
  goPurchasingPaymentRunsUseGo,
  PurchasingPaymentRunsApiError,
  readPendingPaymentRunAction,
  submitPurchasingPaymentRunAction,
  type PaymentRunRetryScope,
  type PurchasingPaymentRun,
  type PurchasingPaymentRunAction,
  type PurchasingPaymentRunBill,
} from "../api/purchasing-payment-runs";
import "./purchasing-payment-runs.css";

type PageState =
  | { status: "loading" }
  | { status: "failed"; error: PurchasingPaymentRunsApiError }
  | { status: "ready"; runs: PurchasingPaymentRun[]; bills: PurchasingPaymentRunBill[] };
type Notice = { tone: "success" | "pending" | "error"; text: string };
type ConfirmAction = { action: "instruct" | "reverse"; run: PurchasingPaymentRun } | null;

function money(minor: number, currency: string): string {
  const minorUnits = currencyMinorUnits(currency) ?? 2;
  const amount = minor / (10 ** minorUnits);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: minorUnits,
      maximumFractionDigits: minorUnits,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: minorUnits, maximumFractionDigits: minorUnits })}`;
  }
}

function minorToInput(currency: string, minor: number): string {
  const units = currencyMinorUnits(currency);
  if (units === null) return "";
  return (minor / (10 ** units)).toFixed(units);
}

function toMinor(currency: string, input: string): number {
  const units = currencyMinorUnits(currency);
  const value = input.trim();
  if (units === null || !/^\d+(?:\.\d*)?$/.test(value)) return Number.NaN;
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > units) return Number.NaN;
  const amount = Number(whole) * (10 ** units) + Number(fraction.padEnd(units, "0") || "0");
  return Number.isSafeInteger(amount) ? amount : Number.NaN;
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function csvCell(value: string | number): string {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function downloadCsv(filename: string, rows: (string | number)[][]): void {
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function PurchasingPaymentRunsPage({ actorId = null, organizationId = null }: { actorId?: string | null; organizationId?: string | null }) {
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkingRecovery, setCheckingRecovery] = useState(true);
  const [recoveryAction, setRecoveryAction] = useState<PurchasingPaymentRunAction | null>(null);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [memo, setMemo] = useState("");
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [reverseReason, setReverseReason] = useState("");
  const scope: PaymentRunRetryScope = { actorId, organizationId };

  const load = useCallback(async (signal?: AbortSignal, showLoading = true) => {
    if (showLoading) setState({ status: "loading" });
    try {
      const [runs, bills] = await Promise.all([
        fetchPurchasingPaymentRuns(signal),
        fetchPurchasingPaymentRunBills(signal),
      ]);
      if (!signal?.aborted) setState({ status: "ready", runs, bills });
    } catch (error) {
      if (signal?.aborted) return;
      setState({
        status: "failed",
        error: error instanceof PurchasingPaymentRunsApiError
          ? error
          : new PurchasingPaymentRunsApiError(0, "Could not load payment run data from Go."),
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    let active = true;
    setCheckingRecovery(true);
    void readPendingPaymentRunAction(scope).then((action) => {
      if (!active) return;
      setRecoveryAction(action);
      if (action) setNotice({ tone: "pending", text: "A payment run action is unresolved. Retry the exact action before making another change." });
    }).catch((error) => {
      if (active) setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not check for an unresolved payment run action." });
    }).finally(() => {
      if (active) setCheckingRecovery(false);
    });
    return () => { active = false; };
  }, [actorId, organizationId]);

  const runs = state.status === "ready" ? state.runs : [];
  const bills = state.status === "ready" ? state.bills : [];
  const visibleBills = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return bills.filter((bill) => !query || String(bill.number).includes(query) || bill.vendorName.toLocaleLowerCase().includes(query) || (bill.vendorRef ?? "").toLocaleLowerCase().includes(query));
  }, [bills, search]);
  const selectedBills = useMemo(() => selectedIds.map((id) => bills.find((bill) => bill.id === id)).filter((bill): bill is PurchasingPaymentRunBill => Boolean(bill)), [bills, selectedIds]);
  const selectedCurrencies = [...new Set(selectedBills.map((bill) => bill.currency))];
  const selectedLines = selectedBills.map((bill) => ({ bill, amountMinor: toMinor(bill.currency, amounts[bill.id] ?? minorToInput(bill.currency, bill.dueMinor)) }));
  const selectedTotalMinor = selectedLines.reduce((sum, line) => sum + (Number.isSafeInteger(line.amountMinor) && line.amountMinor > 0 ? line.amountMinor : 0), 0);
  const currentCurrency = selectedCurrencies.length === 1 ? selectedCurrencies[0]! : "";
  const hasInvalidLine = selectedLines.some((line) => !Number.isSafeInteger(line.amountMinor) || line.amountMinor <= 0 || line.amountMinor > line.bill.dueMinor);
  const locked = busy || checkingRecovery || Boolean(recoveryAction);

  function toggleBill(bill: PurchasingPaymentRunBill): void {
    setSelectedIds((current) => current.includes(bill.id) ? current.filter((id) => id !== bill.id) : [...current, bill.id]);
    setAmounts((current) => ({ ...current, [bill.id]: current[bill.id] ?? minorToInput(bill.currency, bill.dueMinor) }));
  }

  function selectVisibleBills(): void {
    const currency = visibleBills[0]?.currency;
    if (!currency) return;
    const sameCurrency = visibleBills.filter((bill) => bill.currency === currency);
    setSelectedIds((current) => [...new Set([...current, ...sameCurrency.map((bill) => bill.id)])]);
    setAmounts((current) => ({
      ...current,
      ...Object.fromEntries(sameCurrency.map((bill) => [bill.id, current[bill.id] ?? minorToInput(bill.currency, bill.dueMinor)])),
    }));
  }

  async function perform(action: PurchasingPaymentRunAction, label: string, exactRetry = false): Promise<void> {
    if (busy || checkingRecovery || (recoveryAction && !exactRetry)) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await submitPurchasingPaymentRunAction(action, scope);
      if (result.kind === "pending") {
        setRecoveryAction(action);
        setNotice({ tone: "pending", text: `${label} is waiting for approval or result recovery. Retry the exact action when it is ready.` });
      } else {
        setRecoveryAction(null);
        setNotice({ tone: "success", text: `${label} completed.` });
        if (action.action === "create") {
          setSelectedIds([]);
          setMemo("");
        }
        setConfirmAction(null);
        setReverseReason("");
        await load(undefined, false);
      }
    } catch (error) {
      try { setRecoveryAction(await readPendingPaymentRunAction(scope)); }
      catch { setRecoveryAction(action); }
      setNotice({ tone: "error", text: error instanceof Error ? error.message : `${label} failed.` });
    } finally {
      setBusy(false);
    }
  }

  function startCreate(): void {
    if (selectedCurrencies.length !== 1 || hasInvalidLine) {
      setNotice({ tone: "error", text: "Use positive payment amounts within each bill balance and select bills in one currency per run." });
      return;
    }
    void perform({
      action: "create",
      lines: selectedLines.map(({ bill, amountMinor }) => ({ billId: bill.id, amountMinor })),
      memo: memo.trim() || undefined,
    }, "Payment draft");
  }

  function exportSchedule(run: PurchasingPaymentRun): void {
    downloadCsv(`${run.reference.toLowerCase()}-bank-schedule.csv`, [
      ["Payment run", "Supplier", "Bill number", "Amount", "Currency", "Payment reference"],
      ...run.lines.map((line) => [run.reference, line.vendorName, line.billNumber, minorToInput(run.currency, line.amountMinor), run.currency, run.reference]),
    ]);
  }

  function exportRemittance(run: PurchasingPaymentRun): void {
    downloadCsv(`${run.reference.toLowerCase()}-remittance-advice.csv`, [
      ["Supplier", "Supplier invoice reference", "Bill number", "Payment amount", "Currency", "Remittance reference"],
      ...run.lines.map((line) => [line.vendorName, line.vendorRef ?? "", line.billNumber, minorToInput(run.currency, line.amountMinor), run.currency, run.reference]),
    ]);
  }

  function renderRecoveryControls(): ReactNode {
    return <>
      {notice && <p className={`payment-run-notice is-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}
      {recoveryAction && <div className="payment-run-retry"><p>An exact action is saved for this account and organization.</p><button type="button" disabled={busy || !goPurchasingPaymentRunsUseGo()} onClick={() => void perform(recoveryAction, "Payment run action", true)}>Retry exact payment run action</button>{!goPurchasingPaymentRunsUseGo() && <small>Re-enable the Go payment run selector to retry it.</small>}</div>}
    </>;
  }

  if (state.status === "loading") return <main className="purchasing-runs-page"><p role="status" className="purchasing-runs-message">Loading supplier payment runs…</p>{renderRecoveryControls()}</main>;
  if (state.status === "failed") {
    return <main className="purchasing-runs-page"><section className="purchasing-runs-message purchasing-runs-error" role="alert">
      <div><p className="purchasing-runs-eyebrow">Go payment runs</p><h1>{state.error.status === 401 ? "Sign in again" : state.error.status === 403 ? "Access denied" : "Could not load payment runs"}</h1><p>{state.error.message}</p></div>
      <div className="purchasing-runs-error-actions">{state.error.status === 401 && <a href="/login">Sign in again</a>}<button type="button" onClick={() => void load()}>Try again</button></div>
    </section>{renderRecoveryControls()}</main>;
  }

  return <main className="purchasing-runs-page">
    <header className="purchasing-runs-header">
      <div><p className="purchasing-runs-eyebrow">Purchasing · Go governed</p><h1>Supplier payment runs</h1><p>Build a draft from open bills, request approval to instruct payment, and confirm settlement through Bank reconciliation.</p></div>
      <a className="purchasing-runs-full-workspace" href="/purchasing">Open Purchasing workspace</a>
    </header>

    {renderRecoveryControls()}

    <section className="purchasing-runs-message" aria-labelledby="payment-run-builder-title">
      <div className="payment-run-section-heading"><div><h2 id="payment-run-builder-title">Build a supplier payment run</h2><p>Choose open bills in one currency, review each amount, then save a draft for approval and bank instructions.</p></div><button type="button" disabled={locked || visibleBills.length === 0} onClick={selectVisibleBills}>Select visible bills</button></div>
      {bills.length === 0 ? <p>No payable bills are available. New open bills will appear here.</p> : <>
        <label className="payment-run-search">Search supplier, bill, or vendor reference<input value={search} onChange={(event) => setSearch(event.currentTarget.value)} disabled={locked} /></label>
        <div className="purchasing-run-lines-wrap"><table className="purchasing-run-lines payment-run-bill-table"><thead><tr><th scope="col">Select</th><th scope="col">Bill</th><th scope="col">Supplier</th><th scope="col">Vendor reference</th><th scope="col">Outstanding</th><th scope="col">Pay amount</th></tr></thead><tbody>
          {visibleBills.map((bill) => {
            const checked = selectedIds.includes(bill.id);
            return <tr key={bill.id}><td><input aria-label={`Select bill ${bill.number} from ${bill.vendorName}`} type="checkbox" checked={checked} disabled={locked} onChange={() => toggleBill(bill)} /></td><td>#{bill.number}</td><td>{bill.vendorName}</td><td>{bill.vendorRef ?? "-"}</td><td>{money(bill.dueMinor, bill.currency)}</td><td>{checked ? <label className="payment-run-amount">Payment amount<input aria-label={`Payment amount for bill ${bill.number}`} inputMode="decimal" value={amounts[bill.id] ?? minorToInput(bill.currency, bill.dueMinor)} disabled={locked} onChange={(event) => setAmounts((current) => ({ ...current, [bill.id]: event.currentTarget.value }))} /></label> : "Select bill"}</td></tr>;
          })}
        </tbody></table></div>
        {visibleBills.length === 0 && <p>No open bills match that search.</p>}
      </>}
      {selectedIds.length > 0 && <div className="payment-run-draft-form">
        <div><strong>{selectedBills.length} bill{selectedBills.length === 1 ? "" : "s"} selected</strong><p>{selectedCurrencies.length === 1 ? `Run total: ${money(selectedTotalMinor, currentCurrency)}` : "Payment runs must use one currency. Split this selection by currency."}</p></div>
        <label>Run memo (optional)<input maxLength={500} value={memo} disabled={locked} onChange={(event) => setMemo(event.currentTarget.value)} /></label>
        <button type="button" disabled={locked || selectedBills.length === 0 || selectedCurrencies.length !== 1 || hasInvalidLine} onClick={startCreate}>Save payment draft</button>
        {hasInvalidLine && <p role="alert">Each payment must be positive and cannot exceed its bill's current outstanding balance.</p>}
      </div>}
    </section>

    <section aria-labelledby="payment-run-history-title">
      <div className="payment-run-section-heading"><div><h2 id="payment-run-history-title">Payment runs and remittance advice</h2><p>Approval posts one ledger entry. Bank confirmation is recorded when you match the consolidated debit.</p></div><button type="button" disabled={busy} onClick={() => void load()}>Refresh</button></div>
      {runs.length === 0 ? <p className="purchasing-runs-message">No payment runs yet. Select open bills above to prepare one.</p> : <div className="purchasing-runs-list">
        <p className="purchasing-runs-count">Showing {runs.length} recent {runs.length === 1 ? "run" : "runs"}</p>
        {runs.map((run) => <article className="purchasing-run-card" key={run.id}>
          <header className="purchasing-run-heading"><div><p className="purchasing-run-reference">{run.reference}</p><p className="purchasing-run-created">Created {dateLabel(run.createdAt)}</p></div><div className="purchasing-run-summary"><span className={`purchasing-run-status is-${run.status}`}>{run.status === "confirmed" ? "Bank confirmed" : run.status}</span><strong>{money(run.totalMinor, run.currency)}</strong></div></header>
          <dl className="purchasing-run-timestamps">{run.instructedAt && <div><dt>Instructed</dt><dd>{dateLabel(run.instructedAt)}</dd></div>}{run.confirmedAt && <div><dt>Confirmed</dt><dd>{dateLabel(run.confirmedAt)}</dd></div>}{run.entryId && <div><dt>Journal entry</dt><dd>{run.entryId}</dd></div>}</dl>
          <div className="purchasing-run-lines-wrap"><table className="purchasing-run-lines"><caption>Remittance details for {run.reference}</caption><thead><tr><th scope="col">Bill</th><th scope="col">Supplier</th><th scope="col">Supplier reference</th><th scope="col">Amount</th></tr></thead><tbody>{run.lines.map((line) => <tr key={line.billId}><td>#{line.billNumber}</td><td>{line.vendorName}</td><td>{line.vendorRef ?? "Not provided"}</td><td>{money(line.amountMinor, run.currency)}</td></tr>)}</tbody></table></div>
          <div className="payment-run-card-actions"><button type="button" disabled={locked} onClick={() => exportSchedule(run)}>Download transfer schedule</button><button type="button" disabled={locked} onClick={() => exportRemittance(run)}>Download remittance advice</button>
            {run.status === "draft" && <><button type="button" disabled={locked} onClick={() => setConfirmAction({ action: "instruct", run })}>Request approval and instruct</button><button type="button" disabled={locked} onClick={() => void perform({ action: "cancel", paymentRunId: run.id }, "Draft cancellation")}>Cancel draft</button></>}
            {run.status === "cancelled" && <button type="button" disabled={locked} onClick={() => void perform({ action: "restore", paymentRunId: run.id }, "Draft restoration")}>Restore draft</button>}
            {run.status === "instructed" && <button type="button" disabled={locked} onClick={() => setConfirmAction({ action: "reverse", run })}>Reverse unconfirmed run</button>}
          </div>
          {run.status === "instructed" && <p className="payment-run-reconcile-note">To confirm, match the consolidated debit in Bank reconciliation to the journal memo containing {run.reference}. Do not reverse after the bank has sent the funds.</p>}
        </article>)}
      </div>}
    </section>

    {confirmAction && <div className="payment-run-dialog-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="payment-run-dialog-title" className="payment-run-dialog">
      <h2 id="payment-run-dialog-title">{confirmAction.action === "instruct" ? `Approve ${confirmAction.run.reference}` : `Reverse ${confirmAction.run.reference}`}</h2>
      {confirmAction.action === "instruct" ? <p>This requests governed approval to post {money(confirmAction.run.totalMinor, confirmAction.run.currency)} across {confirmAction.run.lines.length} supplier bills. Bank execution happens separately.</p> : <><p>Only reverse when the bank has not sent the funds. The reversal restores each bill balance and writes a mirror ledger entry.</p><label>Reason<input minLength={3} maxLength={500} value={reverseReason} disabled={busy} onChange={(event) => setReverseReason(event.currentTarget.value)} /></label></>}
      <div className="payment-run-card-actions"><button type="button" disabled={busy} onClick={() => setConfirmAction(null)}>Keep run</button><button type="button" disabled={busy || (confirmAction.action === "reverse" && reverseReason.trim().length < 3)} onClick={() => void perform(confirmAction.action === "instruct" ? { action: "instruct", paymentRunId: confirmAction.run.id } : { action: "reverse", paymentRunId: confirmAction.run.id, reason: reverseReason.trim() }, confirmAction.action === "instruct" ? "Payment instruction" : "Run reversal")}>{confirmAction.action === "instruct" ? "Request payment approval" : "Reverse run"}</button></div>
    </section></div>}
  </main>;
}
