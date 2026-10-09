import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { calculateTaxLine, currencyMinorUnits } from "@chaste/erp-core";
import {
  AccountingApiError,
  emailInvoice,
  fetchAccountingBanking,
  fetchAccountingBudgetScenarios,
  fetchAccountingCashBasis,
  fetchAccountingEnabled,
  fetchAccountingOverview,
  fetchAccountingReports,
  fetchAccountingTaxCodes,
  fetchCashForecast,
  fetchCustomerStatement,
  fetchPaymentReminders,
  goAccountingRecordPaymentUseGo,
  goAccountingCreateInvoiceUseGo,
  goAccountingCreditNoteUseGo,
  goAccountingReverseEntryUseGo,
  readPendingAccountingRecordPayment,
  readPendingAccountingCreateInvoice,
  readPendingAccountingCreditNote,
  readPendingAccountingReverseEntry,
  submitAccountingAction,
  type AccountingAging,
  type AccountingBill,
  type AccountingBanking,
  type AccountingBudgetScenario,
  type AccountingCashBasis,
  type AccountingCustomer,
  type AccountingEntry,
  type AccountingForecast,
  type AccountingInvoice,
  type AccountingPayment,
  type AccountingPaymentRetryScope,
  type AccountingRecordPaymentAction,
  type AccountingCreateInvoiceAction,
  type AccountingCreditNoteAction,
  type AccountingReverseEntryAction,
  type AccountingReminder,
  type AccountingReports,
  type AccountingStatement,
  type AccountingTaxCode,
} from "../api/accounting";
import { legacyUrl } from "../legacy";
import "./AccountingPage.css";

/* ------------------------------------------------------------------ money -- */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export function hasCurrencyCode(code: string | null | undefined): code is string {
  return typeof code === "string" && currencyMinorUnits(code) !== null;
}

/** Integer minor units in, a localized money string out. Never floats. */
export function formatMoney(currency: string, amountMinor: number): string {
  const minorUnits = currencyMinorUnits(currency) ?? 2;
  const major = amountMinor / 10 ** minorUnits;
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: minorUnits,
      maximumFractionDigits: minorUnits,
    }).format(major);
  } catch {
    return `${currency.toUpperCase()} ${major.toLocaleString("en", {
      minimumFractionDigits: minorUnits,
      maximumFractionDigits: minorUnits,
    })}`;
  }
}

/**
 * A missing currency is a wire defect, not a zero. Saying "0.00" would hide it,
 * so fall back to the raw minor-unit count and say the currency is unavailable.
 */
export function formatMoneyOrMinor(
  currency: string | null | undefined,
  amountMinor: number,
): string {
  return hasCurrencyCode(currency)
    ? formatMoney(currency, amountMinor)
    : `${amountMinor.toLocaleString()} minor units · currency unavailable`;
}

/** Decimal input string to exact integer minor units, or NaN when unparseable. */
export function toMinorUnits(currency: string, amount: string): number {
  const minorUnits = currencyMinorUnits(currency);
  const raw = amount.trim();
  if (minorUnits === null) return raw ? Number.NaN : 0;
  if (!raw) return 0;
  const match = raw.match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/);
  if (!match) return Number.NaN;
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2] ?? "0";
  const fraction = match[3] ?? match[4] ?? "";
  const factor = 10n ** BigInt(minorUnits);
  const retained = fraction.slice(0, minorUnits).padEnd(minorUnits, "0");
  let minor = BigInt(whole) * factor + BigInt(retained || "0");
  if (fraction.length > minorUnits && fraction[minorUnits]! >= "5") minor += 1n;
  minor *= sign;
  if (minor > MAX_SAFE || minor < -MAX_SAFE) return Number.NaN;
  return Number(minor);
}

/** Minor units back to an ungrouped input value in the same currency. */
export function minorToInput(currency: string, minor: number): string {
  const minorUnits = currencyMinorUnits(currency);
  if (minorUnits === null || !Number.isSafeInteger(minor)) return "";
  return (minor / 10 ** minorUnits).toFixed(minorUnits);
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

/* ------------------------------------------------------------------- tabs -- */

export const TABS = [
  { id: "overview", label: "Overview" },
  { id: "journal", label: "Journal" },
  { id: "receivables", label: "Receivables" },
  { id: "cash", label: "Cash & collections" },
  { id: "budgets", label: "Budgets" },
  { id: "payables", label: "Payables" },
  { id: "bank", label: "Bank" },
  { id: "tax", label: "Tax" },
  { id: "reports", label: "Reports" },
  { id: "periods", label: "Periods & close" },
] as const;

export type TabId = (typeof TABS)[number]["id"];

const TAB_IDS: readonly string[] = TABS.map((tab) => tab.id);

export type {
  AccountingEntry,
  AccountingInvoice,
} from "../api/accounting";

/** Reads `?tab=` from a query string, falling back when it names no known tab. */
export function readTabParam(search: string, fallback: TabId = "overview"): TabId {
  const requested = new URLSearchParams(search).get("tab");
  return requested && TAB_IDS.includes(requested) ? (requested as TabId) : fallback;
}

/**
 * Tab changes rewrite the URL in place so a reload, a bookmark, and a pasted
 * link all land on the same tab without pushing a history entry per click.
 */
export function syncTabUrl(tab: TabId): void {
  const url = new URL(window.location.href);
  url.searchParams.set("tab", tab);
  url.hash = tab;
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

/* --------------------------------------------------------------- filtering -- */

export function filterEntries(entries: AccountingEntry[], search: string): AccountingEntry[] {
  const query = search.trim().toLowerCase();
  if (!query) return entries;
  return entries.filter(
    (entry) =>
      entry.memo.toLowerCase().includes(query) ||
      (entry.sourceType ?? "manual").toLowerCase().includes(query) ||
      entry.actorType.toLowerCase().includes(query),
  );
}

export function isReversal(entry: AccountingEntry): boolean {
  return entry.sourceType === "reversal";
}

/** An entry is only reversible while nothing has already mirrored it. */
export function isReversible(entry: AccountingEntry, entries: AccountingEntry[]): boolean {
  return !isReversal(entry) && !entries.some((candidate) => candidate.reversalOfId === entry.id);
}

export type AgingRange = "all" | "current" | "d30" | "d60" | "d90plus" | "outstanding";

/** Aging buckets are keyed off the oldest-days figure the ledger already reports. */
export function filterByAgingRange(
  invoices: AccountingInvoice[],
  ageDaysByInvoice: ReadonlyMap<number, number>,
  range: AgingRange,
): AccountingInvoice[] {
  return invoices.filter((invoice) => {
    if (range === "all") return true;
    if (invoice.outstandingMinor <= 0 || invoice.status === "void") return false;
    if (range === "outstanding") return true;
    const ageDays = ageDaysByInvoice.get(invoice.number) ?? 0;
    if (range === "current") return ageDays <= 30;
    if (range === "d30") return ageDays > 30 && ageDays <= 60;
    if (range === "d60") return ageDays > 60 && ageDays <= 90;
    return ageDays > 90;
  });
}

/* -------------------------------------------------------------- forecasting -- */

export interface InvoiceLineDraft {
  description: string;
  quantity: string;
  unitPrice: string;
  tax: string;
  taxCodeId?: string;
}

/**
 * Live invoice totals in integer minor units. A tax code decides both tax and
 * net (the price may include tax), so a code and a manual tax amount never mix.
 * Any unparseable line collapses the whole preview to null rather than showing a
 * total that does not match what will post.
 */
export function invoicePreviewTotals(
  lines: InvoiceLineDraft[],
  currency: string,
  taxCodes: AccountingTaxCode[] = [],
): { subtotalMinor: number; taxMinor: number; totalMinor: number } | null {
  let subtotal = 0n;
  let tax = 0n;
  let hasLine = false;
  for (const line of lines) {
    if (!line.description.trim()) continue;
    hasLine = true;
    const quantity = Math.round(Number(line.quantity || "0") * 1000);
    const unitPriceMinor = toMinorUnits(currency, line.unitPrice);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) return null;
    if (!Number.isSafeInteger(unitPriceMinor) || unitPriceMinor < 0) return null;
    const taxCode = line.taxCodeId
      ? taxCodes.find((code) => code.id === line.taxCodeId)
      : undefined;
    let lineTax = toMinorUnits(currency, line.tax);
    let lineSubtotal = (BigInt(quantity) * BigInt(unitPriceMinor) + 500n) / 1000n;
    if (taxCode) {
      try {
        const calculated = calculateTaxLine(
          quantity,
          unitPriceMinor,
          taxCode.rateBasisPoints,
          taxCode.priceIncludesTax,
        );
        lineTax = calculated.taxMinor;
        lineSubtotal = BigInt(calculated.netMinor);
      } catch {
        return null;
      }
    }
    if (!Number.isSafeInteger(lineTax) || lineTax < 0) return null;
    if (lineSubtotal < 0n) return null;
    subtotal += lineSubtotal;
    tax += BigInt(lineTax);
  }
  const total = subtotal + tax;
  if (!hasLine || total <= 0n) return null;
  if ([subtotal, tax, total].some((amount) => amount > MAX_SAFE)) return null;
  return {
    subtotalMinor: Number(subtotal),
    taxMinor: Number(tax),
    totalMinor: Number(total),
  };
}

/** Pasted bank export lines of `YYYY-MM-DD,amount,description`. */
export function parseFeedCsv(
  text: string,
  currencyCode: string,
): {
  rows: { postedAt: string; amountMinor: number; description: string }[];
  errors: string[];
} {
  const rows: { postedAt: string; amountMinor: number; description: string }[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})\s*,\s*(-?[\d,]+(?:\.\d+)?)\s*,\s*(.+)$/);
    if (!match) {
      errors.push(`line ${index + 1}: expected date,amount,description`);
      return;
    }
    const datePart = match[1];
    const amountPart = match[2];
    const descriptionPart = match[3];
    if (!datePart || !amountPart || !descriptionPart) {
      errors.push(`line ${index + 1}: expected date,amount,description`);
      return;
    }
    const amountMinor = toMinorUnits(currencyCode, amountPart.replace(/,/g, ""));
    if (!Number.isSafeInteger(amountMinor)) {
      errors.push(`line ${index + 1}: "${amountPart}" is not a number`);
      return;
    }
    rows.push({ postedAt: datePart, amountMinor, description: descriptionPart.trim() });
  });
  return { rows, errors };
}

/* ------------------------------------------------------------------- view -- */

type NoticeTone = "success" | "pending" | "error";
interface Notice {
  tone: NoticeTone;
  text: string;
}

type PageState =
  | { status: "loading" }
  | { status: "disabled" }
  | { status: "failed"; error: AccountingApiError }
  | {
      status: "ready";
      data: Awaited<ReturnType<typeof fetchAccountingOverview>>;
      reports: AccountingReports;
      cash: AccountingCashBasis | null;
      banking: AccountingBanking | null;
    };

const EMPTY_LINE: InvoiceLineDraft = {
  description: "",
  quantity: "1",
  unitPrice: "0",
  tax: "0",
  taxCodeId: "",
};

export function AccountingPage({ actorId = null, organizationId = null }: { actorId?: string | null; organizationId?: string | null }) {
  const [tab, setTab] = useState<TabId>(() => readTabParam(window.location.search));
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [payTarget, setPayTarget] = useState<AccountingBill | null>(null);
  const [reverseTarget, setReverseTarget] = useState<AccountingEntry | null>(null);
  const [pendingRecordPayment, setPendingRecordPayment] = useState<AccountingRecordPaymentAction | null>(null);
  const [pendingCreateInvoice, setPendingCreateInvoice] = useState<AccountingCreateInvoiceAction | null>(null);
  const [pendingCreditNote, setPendingCreditNote] = useState<AccountingCreditNoteAction | null>(null);
  const [pendingReverseEntry, setPendingReverseEntry] = useState<AccountingReverseEntryAction | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const paymentRetryScope: AccountingPaymentRetryScope = { actorId, organizationId };

  const load = useCallback(async (signal?: AbortSignal) => {
    setState((current) => (current.status === "ready" ? current : { status: "loading" }));
    try {
      const enabled = await fetchAccountingEnabled(signal);
      if (signal?.aborted) return;
      if (!enabled) {
        setState({ status: "disabled" });
        return;
      }
      const year = new Date().getUTCFullYear();
      // The books and the reports must both land or the page is unusable.
      // Cash basis and bank feeds are auxiliary: a failure must never blank them.
      const [data, reports, cash, banking] = await Promise.all([
        fetchAccountingOverview(signal),
        fetchAccountingReports(signal),
        fetchAccountingCashBasis(year, signal).catch(() => null),
        fetchAccountingBanking(signal).catch(() => null),
      ]);
      if (signal?.aborted) return;
      setState({ status: "ready", data, reports, cash, banking });
    } catch (error) {
      if (signal?.aborted) return;
      setState({
        status: "failed",
        error: error instanceof AccountingApiError
          ? error
          : new AccountingApiError(0, "Could not reach the Accounting service. Check your connection and try again."),
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (!actorId || !organizationId) return;
    let active = true;
    void readPendingAccountingRecordPayment(paymentRetryScope).then((action) => {
      if (!active) return;
      setPendingRecordPayment(action);
      if (action) {
        setNotice({ tone: "pending", text: goAccountingRecordPaymentUseGo()
          ? "An invoice payment is unresolved. Retry the exact payment to recover its result."
          : "A Go invoice payment is unresolved. Restore the Go payment route and retry that exact payment before using legacy payments." });
      }
    }).catch((error) => {
      if (active && goAccountingRecordPaymentUseGo()) {
        setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not check for an unresolved invoice payment." });
      }
    });
    return () => { active = false; };
  }, [actorId, organizationId]);

  useEffect(() => {
    if (!actorId || !organizationId) return;
    let active = true;
    void readPendingAccountingReverseEntry(paymentRetryScope).then((action) => {
      if (!active) return;
      setPendingReverseEntry(action);
      if (action) setNotice({ tone: "pending", text: goAccountingReverseEntryUseGo()
        ? "A journal reversal is unresolved. Retry the exact entry to recover its result."
        : "A Go journal reversal is unresolved. Restore the Go reversal route and retry that exact entry before using the legacy route." });
    }).catch((error) => {
      if (active && goAccountingReverseEntryUseGo()) {
        setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not check for an unresolved journal reversal." });
      }
    });
    return () => { active = false; };
  }, [actorId, organizationId]);

  useEffect(() => {
    if (!actorId || !organizationId) return;
    let active = true;
    void readPendingAccountingCreditNote(paymentRetryScope).then((action) => {
      if (!active) return;
      setPendingCreditNote(action);
      if (action) setNotice({ tone: "pending", text: goAccountingCreditNoteUseGo()
        ? "A credit note is unresolved. Retry the exact credit to recover its result."
        : "A Go credit note is unresolved. Restore the Go credit note route and retry that exact credit before using the legacy route." });
    }).catch((error) => {
      if (active && goAccountingCreditNoteUseGo()) {
        setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not check for an unresolved credit note." });
      }
    });
    return () => { active = false; };
  }, [actorId, organizationId]);

  useEffect(() => {
    if (!actorId || !organizationId) return;
    let active = true;
    void readPendingAccountingCreateInvoice(paymentRetryScope).then((action) => {
      if (!active) return;
      setPendingCreateInvoice(action);
      if (action) setNotice({ tone: "pending", text: goAccountingCreateInvoiceUseGo()
        ? "An invoice creation is unresolved. Retry the exact invoice to recover its result."
        : "A Go invoice creation is unresolved. Restore the Go invoice route and retry that exact invoice before using legacy invoice creation." });
    }).catch((error) => {
      if (active && goAccountingCreateInvoiceUseGo()) {
        setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not check for an unresolved invoice creation." });
      }
    });
    return () => { active = false; };
  }, [actorId, organizationId]);

  const changeTab = useCallback((next: string) => {
    const resolved = readTabParam(`?tab=${next}`);
    setTab(resolved);
    syncTabUrl(resolved);
  }, []);

  useEffect(() => {
    function onShortcut(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      event.preventDefault();
      changeTab("journal");
      searchRef.current?.focus();
    }
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [changeTab]);

  const runAction = useCallback(
    async (
      path: "/api/accounting" | "/api/banking",
      payload: Record<string, unknown>,
      label: string,
    ): Promise<boolean> => {
      const isRecordPayment = path === "/api/accounting" && payload.action === "recordPayment";
      const goRecordPayment = isRecordPayment && goAccountingRecordPaymentUseGo();
      const isCreateInvoice = path === "/api/accounting" && payload.action === "createInvoice";
      const goCreateInvoice = isCreateInvoice && goAccountingCreateInvoiceUseGo();
      const isCreditNote = path === "/api/accounting" && payload.action === "creditNote";
      const goCreditNote = isCreditNote && goAccountingCreditNoteUseGo();
      const isReverseEntry = path === "/api/accounting" && payload.action === "reverse";
      const goReverseEntry = isReverseEntry && goAccountingReverseEntryUseGo();
      setBusy(true);
      try {
        const outcome = await submitAccountingAction(path, payload, undefined, paymentRetryScope);
        if (goRecordPayment) {
          setPendingRecordPayment(outcome.kind === "pending"
            ? await readPendingAccountingRecordPayment(paymentRetryScope)
            : null);
        }
        if (goCreateInvoice) {
          setPendingCreateInvoice(outcome.kind === "pending"
            ? await readPendingAccountingCreateInvoice(paymentRetryScope)
            : null);
        }
        if (goCreditNote) {
          setPendingCreditNote(outcome.kind === "pending"
            ? await readPendingAccountingCreditNote(paymentRetryScope)
            : null);
        }
        if (goReverseEntry) {
          setPendingReverseEntry(outcome.kind === "pending"
            ? await readPendingAccountingReverseEntry(paymentRetryScope)
            : null);
          if (outcome.kind === "completed") setReverseTarget(null);
        }
        // A 202 is a queued approval, never a completed write: say so plainly.
        setNotice(
          outcome.kind === "pending"
            ? { tone: "pending", text: `${label} needs human approval. It is in the Approvals inbox.` }
            : { tone: "success", text: `${label} done.` },
        );
        void load();
        return !((goRecordPayment || goCreateInvoice || goCreditNote || goReverseEntry) && outcome.kind === "pending");
      } catch (error) {
        if (goRecordPayment) {
          try { setPendingRecordPayment(await readPendingAccountingRecordPayment(paymentRetryScope)); }
          catch { setPendingRecordPayment(payload as unknown as AccountingRecordPaymentAction); }
        }
        if (goCreateInvoice) {
          try { setPendingCreateInvoice(await readPendingAccountingCreateInvoice(paymentRetryScope)); }
          catch { setPendingCreateInvoice(payload as unknown as AccountingCreateInvoiceAction); }
        }
        if (goCreditNote) {
          try { setPendingCreditNote(await readPendingAccountingCreditNote(paymentRetryScope)); }
          catch { setPendingCreditNote(payload as unknown as AccountingCreditNoteAction); }
        }
        if (goReverseEntry) {
          try { setPendingReverseEntry(await readPendingAccountingReverseEntry(paymentRetryScope)); }
          catch { setPendingReverseEntry(payload as unknown as AccountingReverseEntryAction); }
        }
        setNotice({
          tone: "error",
          text: error instanceof AccountingApiError
            ? error.message
            : `${label} did not complete. Check your connection and try again.`,
        });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load, actorId, organizationId],
  );

  const filteredEntries = useMemo(
    () => (state.status === "ready" ? filterEntries(state.data.entries, search) : []),
    [state, search],
  );

  const openBills = useMemo(
    () => (state.status === "ready" ? state.data.bills.filter((bill) => bill.outstandingMinor > 0) : []),
    [state],
  );

  return (
    <main className="accounting-page">
      <header className="accounting-header">
        <div>
          <p className="accounting-eyebrow">Finance · governed ledger</p>
          <h1>Accounting</h1>
          <p>
            Entries are immutable, so corrections post as mirror reversals. Sealed periods refuse
            new postings, and every write below waits in the Approvals inbox when it needs a human.
          </p>
        </div>
        <a
          className="accounting-button accounting-button-secondary"
          href={legacyUrl("/accounting?tab=invoices")}
        >
          Open invoices workspace
        </a>
      </header>

      {state.status === "loading" && (
        <p className="accounting-loading" role="status">Loading your books…</p>
      )}

      {state.status === "disabled" && (
        <section className="accounting-empty" role="status">
          <strong>Accounting is turned off</strong>
          <p>
            Ask a workspace administrator to enable the Accounting module before using this page.
          </p>
        </section>
      )}

      {state.status === "failed" && (
        <section
          className="accounting-error-card"
          role="alert"
          aria-labelledby="accounting-error-title"
        >
          <div>
            <h2 id="accounting-error-title">
              {state.error.status === 401
                ? "Sign in again"
                : state.error.status === 403 || state.error.status === 422
                  ? "Access denied"
                  : "Could not load your books"}
            </h2>
            <p>{state.error.message}</p>
          </div>
          <div className="accounting-error-actions">
            {state.error.status === 401 && <a href="/login">Sign in again</a>}
            <button type="button" onClick={() => void load()}>
              Try again
            </button>
          </div>
        </section>
      )}

      {state.status === "ready" && (
        <>
          {notice && (
            <div
              className={`accounting-notice accounting-notice-${notice.tone}`}
              role={notice.tone === "error" ? "alert" : "status"}
            >
              <span>{notice.text}</span>
              {pendingCreateInvoice && <button
                type="button"
                className="accounting-button accounting-button-small"
                disabled={busy || !goAccountingCreateInvoiceUseGo()}
                onClick={() => void runAction("/api/accounting", { ...pendingCreateInvoice }, "Invoice creation")}
              >{goAccountingCreateInvoiceUseGo() ? "Retry exact invoice" : "Enable Go invoice route to retry"}</button>}
              {pendingCreditNote && <button
                type="button"
                className="accounting-button accounting-button-small"
                disabled={busy || !goAccountingCreditNoteUseGo()}
                onClick={() => void runAction("/api/accounting", { ...pendingCreditNote }, `Credit on invoice`)}
              >{goAccountingCreditNoteUseGo() ? "Retry exact credit" : "Enable Go credit route to retry"}</button>}
              {pendingReverseEntry && <button
                type="button"
                className="accounting-button accounting-button-small"
                disabled={busy || !goAccountingReverseEntryUseGo()}
                onClick={() => void runAction("/api/accounting", { ...pendingReverseEntry }, "Reversal")}
              >{goAccountingReverseEntryUseGo() ? "Retry exact reversal" : "Enable Go reversal route to retry"}</button>}
              {pendingRecordPayment && <button
                type="button"
                className="accounting-button accounting-button-small"
                disabled={busy || !goAccountingRecordPaymentUseGo()}
                onClick={() => void runAction(
                  "/api/accounting",
                  { ...pendingRecordPayment },
                  `Payment on invoice #${pendingRecordPayment.invoiceNumber}`,
                )}
              >{goAccountingRecordPaymentUseGo() ? "Retry exact payment" : "Enable Go payment route to retry"}</button>}
              <button
                type="button"
                className="accounting-notice-dismiss"
                aria-label="Dismiss notice"
                onClick={() => setNotice(null)}
              >
                Dismiss
              </button>
            </div>
          )}

          <nav className="accounting-tabs" aria-label="Accounting sections">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`accounting-button accounting-tab${tab === item.id ? " is-active" : ""}`}
                aria-current={tab === item.id ? "page" : undefined}
                aria-pressed={tab === item.id}
                onClick={() => changeTab(item.id)}
              >
                {item.label}
                {item.id === "receivables" && state.data.agingInvoices.length > 0 && (
                  <span>{state.data.agingInvoices.length}</span>
                )}
                {item.id === "payables" && openBills.length > 0 && <span>{openBills.length}</span>}
                {item.id === "bank" && (state.banking?.summary.unmatchedCount ?? 0) > 0 && (
                  <span>{state.banking?.summary.unmatchedCount}</span>
                )}
              </button>
            ))}
          </nav>

          {tab === "overview" && (
            <OverviewTab
              data={state.data}
              reports={state.reports}
              cash={state.cash}
              onReverse={setReverseTarget}
              onPay={setPayTarget}
              onTabChange={changeTab}
            />
          )}

          {tab === "journal" && (
            <JournalSection
              data={state.data}
              filteredEntries={filteredEntries}
              search={search}
              searchRef={searchRef}
              setSearch={setSearch}
              onReverse={setReverseTarget}
            />
          )}

          {tab === "receivables" && (
            <ReceivablesSection
              aging={state.data.aging}
              baseCurrency={state.data.baseCurrency}
              agingInvoices={state.data.agingInvoices}
              invoices={state.data.invoices}
              payments={state.data.payments}
              customers={state.data.customers}
              busy={busy}
              pendingPayment={pendingRecordPayment}
              pendingCreateInvoice={pendingCreateInvoice}
              pendingCreditNote={pendingCreditNote}
              onAction={runAction}
            />
          )}

          {tab === "payables" && (
            <PayablesSection
              baseCurrency={state.data.baseCurrency}
              bills={state.data.bills}
              onPay={setPayTarget}
            />
          )}

          {tab === "cash" && (
            <CashSection
              baseCurrency={state.data.baseCurrency}
              customers={state.data.customers}
            />
          )}

          {tab === "budgets" && <BudgetsSection baseCurrency={state.data.baseCurrency} />}

          {tab === "tax" && (
            <TaxTab baseCurrency={state.data.baseCurrency} filings={state.data.filings} />
          )}

          {tab === "reports" && (
            <ReportsSection
              reports={state.reports}
              cash={state.cash}
              year={new Date().getUTCFullYear()}
              busy={busy}
              onAction={runAction}
            />
          )}

          {tab === "periods" && (
            <PeriodsSection
              closedPeriods={state.data.closedPeriods}
              busy={busy}
              onCloseYear={(year) =>
                runAction("/api/accounting", { action: "closeYear", year }, `Year-end close ${year}`)
              }
              onReopen={(year, month) =>
                runAction(
                  "/api/accounting",
                  { action: "reopenPeriod", year, month },
                  `Reopen ${year}-${String(month).padStart(2, "0")}`,
                )
              }
            />
          )}

          {tab === "bank" && (
            <BankSection
              baseCurrency={state.data.baseCurrency}
              banking={state.banking}
              busy={busy}
              onAction={runAction}
            />
          )}

          <PayBillDialog
            bill={payTarget}
            busy={busy}
            onClose={() => setPayTarget(null)}
            onConfirm={async () => {
              if (!payTarget || !hasCurrencyCode(payTarget.currency)) return;
              const accepted = await runAction(
                "/api/accounting",
                {
                  action: "payBill",
                  billNumber: payTarget.number,
                  amountMinor: payTarget.outstandingMinor,
                  // One identity per confirmed intent: a double submit or a
                  // network retry reconciles to this same receipt.
                  intentId: crypto.randomUUID(),
                },
                `Payment of ${formatMoneyOrMinor(payTarget.currency, payTarget.outstandingMinor)}`,
              );
              if (accepted) setPayTarget(null);
            }}
          />

          <ReverseEntryDialog
            entry={reverseTarget}
            busy={busy}
            pending={pendingReverseEntry?.entryId === reverseTarget?.id}
            onClose={() => { if (pendingReverseEntry?.entryId !== reverseTarget?.id) setReverseTarget(null); }}
            onConfirm={async () => {
              if (!reverseTarget) return;
              const accepted = await runAction(
                "/api/accounting",
                { action: "reverse", entryId: reverseTarget.id },
                "Reversal",
              );
              if (accepted) setReverseTarget(null);
            }}
          />
        </>
      )}
    </main>
  );
}

/* --------------------------------------------------------------- overview -- */

function OverviewTab({
  data,
  reports,
  cash,
  onReverse,
  onPay,
  onTabChange,
}: {
  data: Awaited<ReturnType<typeof fetchAccountingOverview>>;
  reports: AccountingReports;
  cash: AccountingCashBasis | null;
  onReverse: (entry: AccountingEntry) => void;
  onPay: (bill: AccountingBill) => void;
  onTabChange: (id: string) => void;
}) {
  const aging = data.aging;
  const openBills = data.bills.filter((bill) => bill.outstandingMinor > 0);
  const recentEntries = data.entries.slice(0, 6);
  const netIncome = reports?.pnl.netIncomeMinor ?? 0;

  return (
    <div className="accounting-stack">
      <section aria-label="Financial position">
        <div className="accounting-position-head">
          <div>
            <p className="accounting-figure-label">Net income · to date</p>
            <p className={`accounting-hero-value${netIncome < 0 ? " is-danger" : ""}`}>
              {formatMoney(data.baseCurrency, netIncome)}
            </p>
          </div>
          <div className="accounting-balance-row">
          <span className={`accounting-badge accounting-badge-${reports.balanceSheet.balanced ? "green" : "red"}`}>
            {reports.balanceSheet.balanced ? "books balanced" : "unbalanced, investigate"}
          </span>
          <span>
            Assets {formatMoney(data.baseCurrency, reports.balanceSheet.assetsMinor)}
          </span>
        </div>
        </div>

        <dl className="accounting-figures">
          <Figure
            label={`Revenue · ${data.baseCurrency}`}
            value={formatMoney(data.baseCurrency, reports?.pnl.revenueMinor ?? 0)}
          />
          <Figure
            label={`Expenses · ${data.baseCurrency}`}
            value={formatMoney(data.baseCurrency, reports?.pnl.expenseMinor ?? 0)}
          />
          <Figure
            label="Net cash · year to date"
            value={cash ? formatMoney(data.baseCurrency, cash.netCashMinor) : "-"}
            tone={cash && cash.netCashMinor < 0 ? "danger" : "default"}
          />
          <Figure
            label="Receivables outstanding"
            value={formatMoney(data.baseCurrency, aging.totalOutstanding)}
            note={
              aging.d90plus > 0
                ? `${formatMoney(data.baseCurrency, aging.d90plus)} past 90 days`
                : undefined
            }
            tone={aging.d90plus > 0 || aging.d60 > 0 ? "warn" : "default"}
          />
        </dl>

        {(data.foreignReceivablesCount > 0 || data.foreignPayablesCount > 0) && (
          <p className="accounting-callout">
            Base-currency totals use {data.baseCurrency}. {data.foreignReceivablesCount} foreign
            receivable{data.foreignReceivablesCount === 1 ? "" : "s"} and{" "}
            {data.foreignPayablesCount} foreign payable
            {data.foreignPayablesCount === 1 ? "" : "s"} are listed in their document currencies
            and excluded from those totals.
          </p>
        )}
      </section>

      <section className="accounting-two-col" aria-label="Working capital">
        <div>
          <div className="accounting-section-head">
            <h2>Who owes me</h2>
            <button type="button" className="accounting-link-button" onClick={() => onTabChange("receivables")}>
              All receivables
            </button>
          </div>
          {data.agingInvoices.length === 0 ? (
            <p className="accounting-quiet">No outstanding invoices. Receivables are clear.</p>
          ) : (
            <ul className="accounting-list">
              {data.agingInvoices.slice(0, 4).map((invoice) => (
                <li key={invoice.number} className="accounting-list-item">
                  <strong>Invoice #{invoice.number}</strong>
                  <span className="accounting-money-inline">
                    {formatMoneyOrMinor(invoice.currency, invoice.outstandingMinor)}
                  </span>
                  <AgeBadge ageDays={invoice.ageDays} />
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="accounting-section-head">
            <h2>Who I owe</h2>
            <button type="button" className="accounting-link-button" onClick={() => onTabChange("payables")}>
              All bills
            </button>
          </div>
          {openBills.length === 0 ? (
            <p className="accounting-quiet">No vendor bills due. Payables are clear.</p>
          ) : (
            <ul className="accounting-list">
              {openBills.slice(0, 4).map((bill) => (
                <li key={bill.id} className="accounting-list-item">
                  <strong className="accounting-truncate">{bill.vendorName}</strong>
                  <span className="accounting-money-inline">
                    {formatMoneyOrMinor(bill.currency, bill.outstandingMinor)}
                  </span>
                  <button
                    type="button"
                    className="accounting-button accounting-button-ghost accounting-button-small"
                    disabled={!hasCurrencyCode(bill.currency)}
                    title={!hasCurrencyCode(bill.currency) ? "Bill currency is unavailable." : undefined}
                    onClick={() => onPay(bill)}
                  >
                    Pay
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section aria-label="Recent postings">
        <div className="accounting-section-head">
          <h2>Recent postings</h2>
          <button type="button" className="accounting-link-button" onClick={() => onTabChange("journal")}>
            Full journal
          </button>
        </div>
        {recentEntries.length === 0 ? (
          <p className="accounting-empty">
            <strong>No journal entries yet</strong>
            <span>Post an invoice, bill, sale, or payroll run to see it here.</span>
          </p>
        ) : (
          <ol className="accounting-posting-list">
            {recentEntries.map((entry) => {
              const reversal = isReversal(entry);
              return (
                <li
                  key={entry.id}
                  className={`accounting-posting-item${reversal ? " is-reversal" : ""}`}
                >
                  <strong className="accounting-truncate" title={entry.memo}>
                    {reversal ? "Reversal: " : ""}
                    {entry.memo}
                  </strong>
                  <span className={`accounting-badge accounting-badge-${entry.actorType === "agent" ? "violet" : ""}`}>
                    {entry.actorType}
                  </span>
                  <time
                    className="accounting-when"
                    title={formatDateTime(entry.postedAt)}
                    dateTime={entry.postedAt}
                  >
                    {formatDateTime(entry.postedAt)}
                  </time>
                  <span className="accounting-money-inline">
                    {formatMoneyOrMinor(entry.currency, entry.amountMinor)}
                  </span>
                  {isReversible(entry, data.entries) && (
                    <button
                      type="button"
                      className="accounting-button accounting-button-ghost accounting-button-small"
                      onClick={() => onReverse(entry)}
                    >
                      Reverse
                    </button>
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

function AgeBadge({ ageDays }: { ageDays: number }) {
  if (ageDays <= 0) return <span className="accounting-badge">current</span>;
  const tone = ageDays > 60 ? "red" : ageDays > 30 ? "amber" : "";
  return <span className={`accounting-badge accounting-badge-${tone}`}>{ageDays}d overdue</span>;
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
      <dt className="accounting-figure-label">{label}</dt>
      <dd>
        <p className={`accounting-figure-value${tone === "default" ? "" : ` is-${tone}`}`}>{value}</p>
        {note && <span className="accounting-figure-note">{note}</span>}
      </dd>
    </div>
  );
}

/* ---------------------------------------------------------------- journal -- */

function JournalSection({
  data,
  filteredEntries,
  search,
  searchRef,
  setSearch,
  onReverse,
}: {
  data: Awaited<ReturnType<typeof fetchAccountingOverview>>;
  filteredEntries: AccountingEntry[];
  search: string;
  searchRef: React.RefObject<HTMLInputElement | null>;
  setSearch: (value: string) => void;
  onReverse: (entry: AccountingEntry) => void;
}) {
  return (
    <section>
      <div className="accounting-section-head">
        <h2>Journal entries</h2>
        <label className="accounting-label">
          <span className="accounting-sr-only">Search journal entries</span>
          <input
            ref={searchRef}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search memo, source, actor"
          />
        </label>
      </div>
      <p className="accounting-hint">
        Showing {filteredEntries.length} of the latest {data.entries.length} entries. Press / to
        search.
      </p>

      {data.closedPeriods.length > 0 && (
        <p className="accounting-hint accounting-block-divider">
          Sealed:{" "}
          {data.closedPeriods.map((period) => (
            <span key={`${period.year}-${period.month}`} className="accounting-badge">
              {period.year}-{String(period.month).padStart(2, "0")}
            </span>
          ))}
        </p>
      )}

      {filteredEntries.length === 0 ? (
        <p className="accounting-empty">
          <strong>{search ? "No entries match" : "No journal entries yet"}</strong>
          <span>
            {search
              ? "Try a different filter."
              : "Post an invoice, bill, sale, or payroll run to see it here."}
          </span>
        </p>
      ) : (
        <div className="accounting-table-shell accounting-table-scroll">
          <table className="accounting-table">
            <caption className="accounting-sr-only">Journal entries</caption>
            <thead>
              <tr>
                <th scope="col">Memo</th>
                <th scope="col">Source</th>
                <th scope="col">By</th>
                <th scope="col">When</th>
                <th scope="col" className="is-numeric">Amount</th>
                <th scope="col" className="accounting-table-actions">
                  <span className="accounting-sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredEntries.map((entry) => {
                const reversal = isReversal(entry);
                const reversed = !isReversible(entry, data.entries) && !reversal;
                return (
                  <tr key={entry.id} className={reversal ? "is-reversal" : undefined}>
                    <th scope="row" className="accounting-truncate" title={entry.memo}>
                      {reversal ? "Reversal: " : ""}
                      {entry.memo}
                    </th>
                    <td className="accounting-source">{entry.sourceType ?? "manual"}</td>
                    <td>
                      <span className={`accounting-badge accounting-badge-${entry.actorType === "agent" ? "violet" : ""}`}>
                        {entry.actorType}
                      </span>
                    </td>
                    <td className="accounting-when" title={formatDateTime(entry.postedAt)}>
                      {formatDateTime(entry.postedAt)}
                    </td>
                    <td className="is-numeric">
                      {formatMoneyOrMinor(entry.currency, entry.amountMinor)}
                    </td>
                    <td className="accounting-table-actions">
                      {isReversible(entry, data.entries) ? (
                        <button
                          type="button"
                          className="accounting-button accounting-button-ghost accounting-button-small"
                          onClick={() => onReverse(entry)}
                        >
                          Reverse
                        </button>
                      ) : reversed ? (
                        <span className="accounting-hint">reversed</span>
                      ) : null}
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

/* --------------------------------------------------------------- dialogs -- */

function Dialog({
  open,
  title,
  description,
  onClose,
  footer,
  wide,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  footer?: React.ReactNode;
  wide?: boolean;
  children?: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="accounting-dialog-backdrop">
      <div
        className={`accounting-dialog${wide ? " accounting-dialog-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <div>
            <h2>{title}</h2>
            {description && <p className="accounting-dialog-description">{description}</p>}
          </div>
          <button type="button" aria-label="Close" onClick={onClose}>
            Close
          </button>
        </header>
        {children && <div className="accounting-dialog-body">{children}</div>}
        {footer && <div className="accounting-dialog-footer">{footer}</div>}
      </div>
    </div>
  );
}

function PayBillDialog({
  bill,
  busy,
  onClose,
  onConfirm,
}: {
  bill: AccountingBill | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <Dialog
      open={bill !== null}
      title="Pay vendor bill"
      description="The payment posts as a balanced ledger entry. Above-threshold payments wait for approval."
      onClose={onClose}
      footer={
        <>
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="accounting-button-primary"
            disabled={busy || !bill || !hasCurrencyCode(bill.currency)}
            onClick={() => void onConfirm()}
          >
            {busy
              ? "Working"
              : `Pay ${bill ? formatMoneyOrMinor(bill.currency, bill.outstandingMinor) : ""}`}
          </button>
        </>
      }
    >
      <p>
        Pay <strong>{bill?.vendorName}</strong> the full outstanding{" "}
        <strong>{bill ? formatMoneyOrMinor(bill.currency, bill.outstandingMinor) : ""}</strong>.
      </p>
    </Dialog>
  );
}

function ReverseEntryDialog({
  entry,
  busy,
  pending,
  onClose,
  onConfirm,
}: {
  entry: AccountingEntry | null;
  busy: boolean;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <Dialog
      open={entry !== null}
      title="Reverse journal entry"
      description="The original stays untouched, so corrections are always additive."
      onClose={onClose}
      footer={
        <>
            <button type="button" disabled={busy || pending} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="accounting-button-danger"
            disabled={busy || pending || !entry}
            onClick={() => void onConfirm()}
          >
            Post reversal
          </button>
        </>
      }
    >
      <p>
        Post a mirror reversal of &ldquo;{entry?.memo}&rdquo;{" "}
        {entry ? formatMoneyOrMinor(entry.currency, entry.amountMinor) : ""}?
      </p>
    </Dialog>
  );
}

/* ------------------------------------------------------------ receivables -- */

const EMPTY_INVOICE_FORM = {
  customerId: "",
  memo: "",
  lines: [EMPTY_LINE],
  currency: "",
  dueAt: "",
};

function ReceivablesSection({
  aging,
  baseCurrency,
  agingInvoices,
  invoices,
  payments,
  customers,
  busy,
  pendingPayment,
  pendingCreateInvoice,
  pendingCreditNote,
  onAction,
}: {
  aging: AccountingAging;
  baseCurrency: string;
  agingInvoices: Awaited<ReturnType<typeof fetchAccountingOverview>>["agingInvoices"];
  invoices: AccountingInvoice[];
  payments: AccountingPayment[];
  customers: AccountingCustomer[];
  busy: boolean;
  pendingPayment: AccountingRecordPaymentAction | null;
  pendingCreateInvoice: AccountingCreateInvoiceAction | null;
  pendingCreditNote: AccountingCreditNoteAction | null;
  onAction: (
    path: "/api/accounting" | "/api/banking",
    payload: Record<string, unknown>,
    label: string,
  ) => Promise<boolean>;
}) {
  const [agingRange, setAgingRange] = useState<AgingRange>("all");
  const [showAllInvoices, setShowAllInvoices] = useState(false);
  const [taxCodes, setTaxCodes] = useState<AccountingTaxCode[]>([]);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [invoiceForm, setInvoiceForm] = useState(EMPTY_INVOICE_FORM);
  const [emailFor, setEmailFor] = useState<number | null>(null);
  const [emailTo, setEmailTo] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailNote, setEmailNote] = useState<string | null>(null);
  const [payFor, setPayFor] = useState<AccountingInvoice | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState<"bank_transfer" | "cash" | "card">("bank_transfer");
  const [creditFor, setCreditFor] = useState<AccountingInvoice | null>(null);
  const [creditForm, setCreditForm] = useState({ amount: "", reason: "" });
  const [reverseFor, setReverseFor] = useState<AccountingPayment | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const invoiceListRef = useRef<HTMLDivElement>(null);
  const previousPendingCreditNote = useRef<AccountingCreditNoteAction | null>(null);
  const previousPendingCreateInvoice = useRef<AccountingCreateInvoiceAction | null>(null);
  const previousPendingPayment = useRef<AccountingRecordPaymentAction | null>(null);

  const invoiceCurrency = invoiceForm.currency.trim().toUpperCase() || baseCurrency;
  const invoiceDigits = currencyMinorUnits(invoiceCurrency) ?? 2;
  const amountPlaceholder = invoiceDigits === 0 ? "0" : `0.${"0".repeat(invoiceDigits)}`;
  const currencyUnsupported = invoiceForm.currency.trim() !== "" && !hasCurrencyCode(invoiceCurrency);
  const preview = useMemo(
    () => (currencyUnsupported ? null : invoicePreviewTotals(invoiceForm.lines, invoiceCurrency, taxCodes)),
    [invoiceForm.lines, invoiceCurrency, taxCodes, currencyUnsupported],
  );
  const enteredPayMinor = payFor ? toMinorUnits(payFor.currency, payAmount) : Number.NaN;
  const enteredCreditMinor = creditFor ? toMinorUnits(creditFor.currency, creditForm.amount) : Number.NaN;

  useEffect(() => {
    if (!pendingPayment) return;
    const invoice = invoices.find((candidate) => candidate.number === pendingPayment.invoiceNumber);
    if (!invoice) return;
    setPayFor(invoice);
    setPayAmount(minorToInput(invoice.currency, pendingPayment.amountMinor));
    setPayMethod(pendingPayment.method);
  }, [pendingPayment, invoices]);

  const retryingExactPayment = pendingPayment !== null && pendingPayment.invoiceNumber === payFor?.number;
  const retryingExactCreditNote = pendingCreditNote !== null && pendingCreditNote.invoiceId === creditFor?.id;

  useEffect(() => {
    if (previousPendingCreditNote.current && pendingCreditNote === null && creditFor?.id === previousPendingCreditNote.current.invoiceId) setCreditFor(null);
    previousPendingCreditNote.current = pendingCreditNote;
  }, [creditFor?.id, pendingCreditNote]);

  useEffect(() => {
    if (previousPendingCreateInvoice.current && pendingCreateInvoice === null) {
      setInvoiceOpen(false);
      setInvoiceForm(EMPTY_INVOICE_FORM);
    }
    previousPendingCreateInvoice.current = pendingCreateInvoice;
  }, [pendingCreateInvoice]);

  useEffect(() => {
    if (previousPendingPayment.current && pendingPayment === null && payFor?.number === previousPendingPayment.current.invoiceNumber) {
      setPayFor(null);
      setPayAmount("");
      setPayMethod("bank_transfer");
    }
    previousPendingPayment.current = pendingPayment;
  }, [payFor?.number, pendingPayment]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchAccountingTaxCodes(controller.signal)
      .then((codes) => {
        if (!controller.signal.aborted) setTaxCodes(codes);
      })
      // A missing tax-code list only costs the code picker; manual tax still works.
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  function showAgingRange(range: AgingRange) {
    setAgingRange(range);
    setShowAllInvoices(false);
    requestAnimationFrame(() => invoiceListRef.current?.focus({ preventScroll: true }));
  }

  const outstanding = invoices.filter(
    (invoice) => invoice.outstandingMinor > 0 && invoice.status !== "void",
  );
  const ageDaysByInvoice = new Map(
    agingInvoices.map((invoice) => [invoice.number, invoice.ageDays]),
  );
  const visibleInvoices = filterByAgingRange(invoices, ageDaysByInvoice, agingRange);
  const invoicesToShow = showAllInvoices ? visibleInvoices : visibleInvoices.slice(0, 30);

  async function sendInvoice(invoiceNumber: number) {
    setEmailBusy(true);
    setEmailNote(null);
    try {
      const result = await emailInvoice(invoiceNumber, emailTo);
      setEmailFor(null);
      setEmailTo("");
      setEmailNote(result.urlPath ? `Invoice #${invoiceNumber} sent with a share link.` : `Invoice #${invoiceNumber} sent.`);
    } catch (error) {
      setEmailNote(
        error instanceof AccountingApiError
          ? error.message
          : "Could not send the invoice. Check that email is configured in Settings.",
      );
    } finally {
      setEmailBusy(false);
    }
  }

  function createInvoice() {
    if (!preview || pendingCreateInvoice) return;
    const lines = invoiceForm.lines
      .map((line) => {
        const base = {
          description: line.description.trim(),
          quantity: Math.round(Number(line.quantity || "0") * 1000),
          unitPriceMinor: toMinorUnits(invoiceCurrency, line.unitPrice),
        };
        return line.taxCodeId
          ? { ...base, taxCodeId: line.taxCodeId }
          : { ...base, taxMinor: toMinorUnits(invoiceCurrency, line.tax) };
      })
      .filter((line) => line.description.length > 0 && line.quantity > 0);
    if (
      !invoiceForm.customerId ||
      lines.length === 0 ||
      lines.some(
        (line) =>
          !Number.isSafeInteger(line.unitPriceMinor) ||
          ("taxMinor" in line && !Number.isSafeInteger(line.taxMinor)),
      )
    ) {
      return;
    }
    void onAction(
      "/api/accounting",
      {
        action: "createInvoice",
        customerId: invoiceForm.customerId,
        memo: invoiceForm.memo.trim() || undefined,
        lines,
        currency: invoiceCurrency === baseCurrency ? undefined : invoiceCurrency,
        dueAt: invoiceForm.dueAt ? new Date(`${invoiceForm.dueAt}T12:00:00Z`).toISOString() : undefined,
      },
      "Invoice posted",
    ).then((accepted) => {
      if (!accepted) return;
      setInvoiceOpen(false);
      setInvoiceForm(EMPTY_INVOICE_FORM);
    });
  }

  return (
    <section className="accounting-stack">
      <div className="accounting-stats">
        <AgingStatButton label="Current" value={formatMoney(baseCurrency, aging.current)} pressed={agingRange === "current"} onSelect={() => showAgingRange("current")} />
        <AgingStatButton label="31 to 60 days" value={formatMoney(baseCurrency, aging.d30)} tone={aging.d30 > 0 ? "is-warn" : undefined} pressed={agingRange === "d30"} onSelect={() => showAgingRange("d30")} />
        <AgingStatButton label="61 to 90 days" value={formatMoney(baseCurrency, aging.d60)} tone={aging.d60 > 0 ? "is-warn" : undefined} pressed={agingRange === "d60"} onSelect={() => showAgingRange("d60")} />
        <AgingStatButton label="90 days and over" value={formatMoney(baseCurrency, aging.d90plus)} tone={aging.d90plus > 0 ? "is-danger" : undefined} pressed={agingRange === "d90plus"} onSelect={() => showAgingRange("d90plus")} />
        <AgingStatButton label={`Total outstanding · ${baseCurrency}`} value={formatMoney(baseCurrency, aging.totalOutstanding)} tone="is-accent" pressed={agingRange === "outstanding"} onSelect={() => showAgingRange("outstanding")} />
      </div>

      {agingInvoices.some((invoice) => invoice.currency !== baseCurrency) && (
        <p className="accounting-callout">
          Aging totals include {baseCurrency} invoices only. Foreign invoices remain listed in their
          document currency and are excluded until converted.
        </p>
      )}

      <div className="accounting-button-row">
        <button type="button" className="accounting-button-primary" disabled={pendingCreateInvoice !== null} onClick={() => setInvoiceOpen(true)}>
          New invoice
        </button>
      </div>

      {invoices.length === 0 ? (
        <p className="accounting-quiet">No invoices yet. Issue your first one above.</p>
      ) : (
        <>
          <div className="accounting-section-head">
            <p className="accounting-hint" aria-live="polite">
              {agingRange === "all"
                ? "All invoices"
                : agingRange === "outstanding"
                  ? "Outstanding invoices"
                  : `${visibleInvoices.length} invoices in this aging range`}
            </p>
            {agingRange !== "all" && (
              <button type="button" className="accounting-button accounting-button-ghost accounting-button-small" onClick={() => showAgingRange("all")}>
                Reset filter
              </button>
            )}
          </div>
          {visibleInvoices.length === 0 ? (
            <p className="accounting-quiet">No invoices match this aging range.</p>
          ) : (
            <div ref={invoiceListRef} tabIndex={-1} className="accounting-table-shell accounting-table-scroll">
              <table className="accounting-table">
                <caption className="accounting-sr-only">Invoices</caption>
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Customer</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="is-numeric">Total</th>
                    <th scope="col" className="is-numeric">Outstanding</th>
                    <th scope="col" className="accounting-table-actions">
                      <span className="accounting-sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invoicesToShow.map((invoice) => {
                    const age = agingInvoices.find((row) => row.number === invoice.number);
                    const currency = hasCurrencyCode(invoice.currency) ? invoice.currency : null;
                    const tone = invoice.status === "paid" ? "green" : invoice.status === "void" ? "red" : "amber";
                    return (
                      <tr key={invoice.id}>
                        <th scope="row">{invoice.number}</th>
                        <td>{invoice.customerName}</td>
                        <td>
                          <span className={`accounting-badge accounting-badge-${tone}`}>{invoice.status}</span>
                          {age && invoice.status === "sent" && age.ageDays > 0 && (
                            <span className="accounting-hint"> {age.ageDays}d overdue</span>
                          )}
                        </td>
                        <td className="is-numeric">{formatMoneyOrMinor(currency, invoice.totalMinor)}</td>
                        <td className="is-numeric">{formatMoneyOrMinor(currency, invoice.outstandingMinor)}</td>
                        <td className="accounting-table-actions">
                          {invoice.outstandingMinor > 0 && invoice.status !== "void" && (
                            currency ? (
                              <>
                                <button
                                  type="button"
                                  className="accounting-button accounting-button-small"
                                  disabled={busy || pendingPayment !== null}
                                  onClick={() => {
                                    setPayFor(invoice);
                                    setPayAmount(minorToInput(currency, invoice.outstandingMinor));
                                  }}
                                >
                                  Pay
                                </button>
                                <button
                                  type="button"
                                  className="accounting-button accounting-button-ghost accounting-button-small"
                                  disabled={busy || pendingCreditNote !== null}
                                  onClick={() => {
                                    setCreditFor(invoice);
                                    setCreditForm({
                                      amount: minorToInput(currency, invoice.outstandingMinor),
                                      reason: "",
                                    });
                                  }}
                                >
                                  Credit
                                </button>
                              </>
                            ) : (
                              <span
                                className="accounting-callout accounting-callout-inline"
                                title="Refresh once the accounting service returns the invoice currency."
                              >
                                Money actions unavailable: currency missing
                              </span>
                            )
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {visibleInvoices.length > 30 && (
            <div className="accounting-button-row">
              <button type="button" onClick={() => setShowAllInvoices((showing) => !showing)}>
                {showAllInvoices ? "Show fewer invoices" : "Show all invoices"}
              </button>
            </div>
          )}
        </>
      )}

      {agingInvoices.length > 0 && (
        <ul className="accounting-list">
          {agingInvoices.map((invoice) => (
            <li key={invoice.number} className="accounting-list-item">
              <strong>Invoice #{invoice.number}</strong>
              <span className="accounting-money-inline">
                {formatMoneyOrMinor(invoice.currency, invoice.outstandingMinor)}
              </span>
              <AgeBadge ageDays={invoice.ageDays} />
              <button
                type="button"
                className="accounting-button accounting-button-ghost accounting-button-small"
                aria-label={`Email invoice ${invoice.number}`}
                title="Email this invoice to the customer"
                onClick={() => setEmailFor(emailFor === invoice.number ? null : invoice.number)}
              >
                Email
              </button>
              {emailFor === invoice.number && (
                <>
                  <input
                    type="email"
                    aria-label={`Recipient for invoice ${invoice.number}`}
                    placeholder="customer@example.com"
                    value={emailTo}
                    onChange={(event) => setEmailTo(event.target.value)}
                  />
                  <button
                    type="button"
                    className="accounting-button-primary accounting-button-small"
                    disabled={emailBusy || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTo)}
                    onClick={() => void sendInvoice(invoice.number)}
                  >
                    {emailBusy ? "Sending" : "Send with share link"}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <section className="accounting-card">
        <header>
          <h2>Payments received</h2>
          <p className="accounting-hint">
            {outstanding.length} invoice{outstanding.length === 1 ? "" : "s"} open
          </p>
        </header>
        {payments.length === 0 ? (
          <p className="accounting-quiet">
            No payments recorded yet. Hit Pay on an invoice above.
          </p>
        ) : (
          <div className="accounting-table-shell accounting-table-scroll">
            <table className="accounting-table">
              <caption className="accounting-sr-only">Payments received</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Invoice</th>
                  <th scope="col">Method</th>
                  <th scope="col" className="is-numeric">Amount</th>
                  <th scope="col" className="accounting-table-actions">
                    <span className="accounting-sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.id}>
                    <td className="accounting-when">{formatDate(payment.receivedAt)}</td>
                    <th scope="row">#{payment.invoiceNumber}</th>
                    <td className="accounting-source">{payment.method}</td>
                    <td className="is-numeric">{formatMoneyOrMinor(payment.currency, payment.amountMinor)}</td>
                    <td className="accounting-table-actions">
                      <button
                        type="button"
                        className="accounting-button accounting-button-ghost accounting-button-small"
                        disabled={busy}
                        onClick={() => {
                          setReverseFor(payment);
                          setReverseReason("");
                        }}
                      >
                        Reverse
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="accounting-hint">
          Reversals mirror the payment entries and release the invoice balance, and are always
          approval-gated.
        </p>
      </section>

      {emailNote && <p className="accounting-hint">{emailNote}</p>}

      <Dialog
        open={invoiceOpen}
        wide
        title="New invoice"
        description="Posts the receivable and revenue to the ledger immediately. Posted documents are immutable, so corrections go through credit notes."
        onClose={() => setInvoiceOpen(false)}
        footer={
          <>
            <button type="button" disabled={busy} onClick={() => setInvoiceOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="accounting-button-primary"
              disabled={busy || pendingCreateInvoice !== null || !invoiceForm.customerId || !preview}
              onClick={createInvoice}
            >
              Post invoice
            </button>
          </>
        }
      >
        <div className="accounting-field-row">
          <label className="accounting-label">
            Customer
            <select
              disabled={pendingCreateInvoice !== null}
              value={invoiceForm.customerId}
              onChange={(event) => setInvoiceForm({ ...invoiceForm, customerId: event.target.value })}
            >
              <option value="">Choose a customer</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </select>
          </label>
          <label className="accounting-label">
            Memo
            <input
              placeholder="Memo (optional)"
              disabled={pendingCreateInvoice !== null}
              value={invoiceForm.memo}
              onChange={(event) => setInvoiceForm({ ...invoiceForm, memo: event.target.value })}
            />
          </label>
          <label className="accounting-label">
            Currency
            <input
              className="accounting-currency-input"
              placeholder={baseCurrency}
              maxLength={3}
              disabled={pendingCreateInvoice !== null}
              value={invoiceForm.currency}
              onChange={(event) =>
                setInvoiceForm({ ...invoiceForm, currency: event.target.value.toUpperCase() })
              }
            />
          </label>
          <label className="accounting-label">
            Due date
            <input
              type="date"
              disabled={pendingCreateInvoice !== null}
              value={invoiceForm.dueAt}
              onChange={(event) => setInvoiceForm({ ...invoiceForm, dueAt: event.target.value })}
            />
          </label>
        </div>
        <p className="accounting-hint">
          Amounts read as {invoiceCurrency}. A blank due date uses the customer payment terms.
        </p>
        {currencyUnsupported && (
          <p className="accounting-callout accounting-callout-danger" role="alert">
            {invoiceCurrency} is not a supported currency code.
          </p>
        )}
        {invoiceForm.lines.map((line, index) => {
          const setLine = (patch: Partial<InvoiceLineDraft>) =>
            setInvoiceForm({
              ...invoiceForm,
              lines: invoiceForm.lines.map((candidate, position) =>
                position === index ? { ...candidate, ...patch } : candidate,
              ),
            });
          return (
            <div key={index} className="accounting-line-row">
              <input
                disabled={pendingCreateInvoice !== null}
                placeholder={`Line ${index + 1} description`}
                aria-label={`Line ${index + 1} description`}
                value={line.description}
                onChange={(event) => setLine({ description: event.target.value })}
              />
              <input
                disabled={pendingCreateInvoice !== null}
                className="accounting-line-narrow"
                placeholder="Qty"
                aria-label={`Line ${index + 1} quantity`}
                value={line.quantity}
                onChange={(event) => setLine({ quantity: event.target.value })}
              />
              <input
                disabled={pendingCreateInvoice !== null}
                className="accounting-line-narrow"
                placeholder={amountPlaceholder}
                aria-label={`Line ${index + 1} unit price`}
                value={line.unitPrice}
                onChange={(event) => setLine({ unitPrice: event.target.value })}
              />
              {taxCodes.length > 0 ? (
                <select
                  disabled={pendingCreateInvoice !== null}
                  aria-label={`Line ${index + 1} tax code`}
                  value={line.taxCodeId ?? ""}
                  onChange={(event) => setLine({ taxCodeId: event.target.value })}
                >
                  <option value="">Manual tax</option>
                  {taxCodes.map((code) => (
                    <option key={code.id} value={code.id}>
                      {code.code} · {(code.rateBasisPoints / 100).toFixed(2)}%
                    </option>
                  ))}
                </select>
              ) : null}
              {line.taxCodeId ? (
                <span className="accounting-hint">Code applied</span>
              ) : (
                <input
                  disabled={pendingCreateInvoice !== null}
                  className="accounting-line-narrow"
                  placeholder={amountPlaceholder}
                  aria-label={`Line ${index + 1} tax`}
                  value={line.tax}
                  onChange={(event) => setLine({ tax: event.target.value })}
                />
              )}
              <button
                type="button"
                className="accounting-button accounting-button-ghost accounting-button-small"
                disabled={pendingCreateInvoice !== null}
                aria-label={`Remove line ${index + 1}`}
                onClick={() =>
                  setInvoiceForm({
                    ...invoiceForm,
                    lines: invoiceForm.lines.filter((_, position) => position !== index),
                  })
                }
              >
                Remove
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="accounting-button accounting-button-ghost accounting-button-small"
          disabled={pendingCreateInvoice !== null}
          onClick={() => setInvoiceForm({ ...invoiceForm, lines: [...invoiceForm.lines, EMPTY_LINE] })}
        >
          Add line
        </button>
        <dl className="accounting-preview">
          <div>
            <dt>Subtotal</dt>
            <dd>{preview ? formatMoney(invoiceCurrency, preview.subtotalMinor) : "-"}</dd>
          </div>
          <div>
            <dt>Tax</dt>
            <dd>{preview ? formatMoney(invoiceCurrency, preview.taxMinor) : "-"}</dd>
          </div>
          <div>
            <dt>Total</dt>
            <dd className="is-total">
              {preview
                ? formatMoney(invoiceCurrency, preview.totalMinor)
                : "Complete a valid line to see the total"}
            </dd>
          </div>
        </dl>
      </Dialog>

      <Dialog
        open={payFor !== null}
        title={`Record payment on invoice #${payFor?.number ?? ""}`}
        description="Posts cash to the ledger and settles the invoice balance. Payments above the policy threshold wait for approval."
        onClose={() => { if (!retryingExactPayment) setPayFor(null); }}
        footer={
          <>
            <button type="button" disabled={busy || retryingExactPayment} onClick={() => setPayFor(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="accounting-button-primary"
              disabled={
                busy ||
                !Number.isSafeInteger(enteredPayMinor) ||
                enteredPayMinor <= 0 ||
                (payFor !== null && enteredPayMinor > payFor.outstandingMinor && !retryingExactPayment)
              }
              onClick={() => {
                if (!payFor) return;
                void onAction(
                  "/api/accounting",
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
              {retryingExactPayment ? "Retry exact payment in dialog" : "Record payment"}
            </button>
          </>
        }
      >
        <div className="accounting-field-row">
          <label className="accounting-label">
            Amount received
            <input
              className="accounting-money-input"
              inputMode="decimal"
              disabled={retryingExactPayment}
              value={payAmount}
              onChange={(event) => setPayAmount(event.target.value)}
            />
          </label>
          <label className="accounting-label">
            Method
            <select
              disabled={retryingExactPayment}
              value={payMethod}
              onChange={(event) => setPayMethod(event.target.value as typeof payMethod)}
            >
              <option value="bank_transfer">Bank transfer</option>
              <option value="cash">Cash</option>
              <option value="card">Card</option>
            </select>
          </label>
          {payFor && (
            <p className="accounting-hint">
              Outstanding {formatMoneyOrMinor(payFor.currency, payFor.outstandingMinor)}
            </p>
          )}
        </div>
        {payFor && !retryingExactPayment && Number.isSafeInteger(enteredPayMinor) && enteredPayMinor > payFor.outstandingMinor && (
          <p className="accounting-callout accounting-callout-danger" role="alert">
            Payment exceeds this invoice outstanding balance.
          </p>
        )}
      </Dialog>

      <Dialog
        open={creditFor !== null}
        title={`Credit invoice #${creditFor?.number ?? ""}`}
        description="Concedes part of the invoice through an approved reversing entry. The invoice itself is never edited."
        onClose={() => { if (!retryingExactCreditNote) setCreditFor(null); }}
        footer={
          <>
            <button type="button" disabled={busy || retryingExactCreditNote} onClick={() => setCreditFor(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="accounting-button-danger"
              disabled={
                busy ||
                retryingExactCreditNote ||
                !Number.isSafeInteger(enteredCreditMinor) ||
                enteredCreditMinor <= 0 ||
                !creditFor ||
                enteredCreditMinor > creditFor.outstandingMinor ||
                creditForm.reason.trim().length < 3
              }
              onClick={() => {
                if (!creditFor) return;
                void onAction(
                  "/api/accounting",
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
            </button>
          </>
        }
      >
        <label className="accounting-label">
          Amount to credit
          <input
            className="accounting-money-input"
            inputMode="decimal"
            disabled={retryingExactCreditNote}
            value={creditForm.amount}
            onChange={(event) => setCreditForm({ ...creditForm, amount: event.target.value })}
          />
        </label>
        <label className="accounting-label">
          Reason
          <input
            placeholder="For example: goodwill for late delivery"
            disabled={retryingExactCreditNote}
            value={creditForm.reason}
            onChange={(event) => setCreditForm({ ...creditForm, reason: event.target.value })}
          />
        </label>
      </Dialog>

      <Dialog
        open={reverseFor !== null}
        title={`Reverse payment on invoice #${reverseFor?.invoiceNumber ?? ""}`}
        description="Mirrors the payment journal entries, releases the invoice balance, and lets you record a corrected payment."
        onClose={() => setReverseFor(null)}
        footer={
          <>
            <button type="button" disabled={busy} onClick={() => setReverseFor(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="accounting-button-danger"
              disabled={busy || reverseReason.trim().length < 3}
              onClick={() => {
                if (!reverseFor) return;
                void onAction(
                  "/api/accounting",
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
              Reverse, needs approval
            </button>
          </>
        }
      >
        <label className="accounting-label">
          Reason
          <input
            placeholder="For example: customer paid twice"
            value={reverseReason}
            onChange={(event) => setReverseReason(event.target.value)}
          />
        </label>
      </Dialog>
    </section>
  );
}

function AgingStatButton({
  label,
  value,
  tone,
  pressed,
  onSelect,
}: {
  label: string;
  value: string;
  tone?: "is-warn" | "is-danger" | "is-accent";
  pressed: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="accounting-stat-button"
      aria-pressed={pressed}
      onClick={onSelect}
    >
      <span className="accounting-metric">
        <span className="accounting-stat-label">{label}</span>
        <strong className={`accounting-stat-value${tone ? ` ${tone}` : ""}`}>{value}</strong>
      </span>
    </button>
  );
}

/* --------------------------------------------------------------- payables -- */

function PayablesSection({
  baseCurrency,
  bills,
  onPay,
}: {
  baseCurrency: string;
  bills: AccountingBill[];
  onPay: (bill: AccountingBill) => void;
}) {
  const openBills = bills.filter((bill) => bill.outstandingMinor > 0);
  // Base-currency totals never quietly absorb a foreign bill: they stay excluded.
  const total = openBills
    .filter((bill) => bill.currency === baseCurrency)
    .reduce((sum, bill) => sum + bill.outstandingMinor, 0);
  const foreignCount = openBills.filter((bill) => bill.currency !== baseCurrency).length;

  if (bills.length === 0) {
    return (
      <p className="accounting-empty">
        <strong>No vendor bills yet</strong>
        <span>Record a bill from Purchasing, or ask your workmate to log one.</span>
      </p>
    );
  }

  return (
    <section className="accounting-stack">
      <p className="accounting-hint">
        Outstanding in {baseCurrency}:{" "}
        <strong className="accounting-money">{formatMoney(baseCurrency, total)}</strong> across{" "}
        {openBills.length} bill{openBills.length === 1 ? "" : "s"}.
      </p>
      {foreignCount > 0 && (
        <p className="accounting-callout">
          {foreignCount} foreign-currency bill{foreignCount === 1 ? " is" : "s are"} shown
          separately and excluded from this base-currency total.
        </p>
      )}
      <div className="accounting-table-shell accounting-table-scroll">
        <table className="accounting-table">
          <caption className="accounting-sr-only">Vendor bills</caption>
          <thead>
            <tr>
              <th scope="col">Bill #</th>
              <th scope="col">Vendor</th>
              <th scope="col">Status</th>
              <th scope="col" className="is-numeric">Outstanding</th>
              <th scope="col" className="accounting-table-actions">
                <span className="accounting-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {bills.map((bill) => (
              <tr key={bill.id}>
                <th scope="row">{bill.number}</th>
                <td>{bill.vendorName}</td>
                <td>
                  <span className="accounting-badge">{bill.status}</span>
                </td>
                <td className="is-numeric">{formatMoneyOrMinor(bill.currency, bill.outstandingMinor)}</td>
                <td className="accounting-table-actions">
                  {bill.outstandingMinor > 0 && (
                    <button
                      type="button"
                      className="accounting-button accounting-button-small"
                      disabled={!hasCurrencyCode(bill.currency)}
                      title={!hasCurrencyCode(bill.currency) ? "Bill currency is unavailable." : undefined}
                      onClick={() => onPay(bill)}
                    >
                      Pay in full
                    </button>
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

/* ---------------------------------------------------------------- reports -- */

function ReportsSection({
  reports,
  cash,
  year,
  busy,
  onAction,
}: {
  reports: AccountingReports;
  cash: AccountingCashBasis | null;
  year: number;
  busy: boolean;
  onAction: (
    path: "/api/accounting" | "/api/banking",
    payload: Record<string, unknown>,
    label: string,
  ) => Promise<boolean>;
}) {
  const [fxForm, setFxForm] = useState({ quoteCurrency: "", rate: "", effectiveAt: "" });
  const cashFlow = reports.cashFlow ?? null;
  const exposures = reports.fxExposure?.exposures ?? [];

  function recordRate() {
    if (!fxForm.quoteCurrency.trim() || !Number(fxForm.rate)) return;
    void onAction(
      "/api/accounting",
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
    <section className="accounting-stack">
      {reports.unsupportedCurrencies === undefined ? (
        <p className="accounting-callout">
          Currency coverage could not be verified for this report. Review foreign-currency activity
          before relying on these totals.
        </p>
      ) : (
        reports.unsupportedCurrencies.length > 0 && (
          <p className="accounting-callout">
            These statements are in {reports.baseCurrency}. Ledger activity in{" "}
            {reports.unsupportedCurrencies.join(", ")} is excluded until multi-currency
            consolidation is completed.
          </p>
        )
      )}

      <div className="accounting-two-col">
        <section className="accounting-card">
          <header>
            <h2>Profit and loss · to date</h2>
          </header>
          <table className="accounting-statement-table">
            <caption className="accounting-sr-only">Profit and loss</caption>
            <tbody>
              {reports.pnl.lines.map((line) => (
                <tr key={line.code}>
                  <td>{line.name}</td>
                  <td className="is-numeric">{formatMoney(reports.baseCurrency, line.amountMinor)}</td>
                </tr>
              ))}
              <tr className="accounting-statement-total">
                <th scope="row">Net income</th>
                <td className={`is-numeric${reports.pnl.netIncomeMinor < 0 ? " is-negative" : " is-positive"}`}>
                  {formatMoney(reports.baseCurrency, reports.pnl.netIncomeMinor)}
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="accounting-card">
          <header>
            <h2>Balance sheet</h2>
            <span className={`accounting-badge accounting-badge-${reports.balanceSheet.balanced ? "green" : "red"}`}>
              {reports.balanceSheet.balanced ? "balanced" : "unbalanced"}
            </span>
          </header>
          {!reports.balanceSheet.balanced && (
            <p className="accounting-callout accounting-callout-danger">
              Assets do not equal liabilities plus equity. Treat this as corruption and investigate
              before trusting any figure.
            </p>
          )}
          <table className="accounting-statement-table">
            <caption className="accounting-sr-only">Balance sheet</caption>
            <tbody>
              <tr>
                <td>Assets</td>
                <td className="is-numeric">{formatMoney(reports.baseCurrency, reports.balanceSheet.assetsMinor)}</td>
              </tr>
              <tr>
                <td>Liabilities</td>
                <td className="is-numeric">{formatMoney(reports.baseCurrency, reports.balanceSheet.liabilitiesMinor)}</td>
              </tr>
              <tr>
                <td>Equity</td>
                <td className="is-numeric">{formatMoney(reports.baseCurrency, reports.balanceSheet.equityMinor)}</td>
              </tr>
              <tr>
                <td>Current result</td>
                <td className="is-numeric">{formatMoney(reports.baseCurrency, reports.balanceSheet.retainedResultMinor)}</td>
              </tr>
              <tr className="accounting-statement-total">
                <th scope="row">Liabilities plus equity</th>
                <td className="is-numeric">
                  {formatMoney(
                    reports.baseCurrency,
                    reports.balanceSheet.liabilitiesMinor +
                      reports.balanceSheet.equityMinor +
                      reports.balanceSheet.retainedResultMinor,
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>

      {cash && (
        <div className="accounting-stats">
          <span className="accounting-metric">
            <span className="accounting-stat-label">Cash in {year}</span>
            <strong className="accounting-stat-value">{formatMoney(reports.baseCurrency, cash.cashInMinor)}</strong>
          </span>
          <span className="accounting-metric">
            <span className="accounting-stat-label">Cash out</span>
            <strong className="accounting-stat-value">{formatMoney(reports.baseCurrency, cash.cashOutMinor)}</strong>
          </span>
          <span className="accounting-metric">
            <span className="accounting-stat-label">Net cash movement</span>
            <strong className={`accounting-stat-value${cash.netCashMinor >= 0 ? " is-accent" : " is-danger"}`}>
              {formatMoney(reports.baseCurrency, cash.netCashMinor)}
            </strong>
          </span>
          <span className="accounting-metric">
            <span className="accounting-stat-label">Booked but uncollected</span>
            <strong className={`accounting-stat-value${cash.uncollectedMinor > 0 ? " is-warn" : ""}`}>
              {formatMoney(reports.baseCurrency, cash.uncollectedMinor)}
            </strong>
          </span>
        </div>
      )}

      {cashFlow && (
        <section className="accounting-card">
          <header>
            <h2>Cash flow statement · all time, {reports.baseCurrency}</h2>
            <span className={`accounting-badge accounting-badge-${cashFlow.ties ? "green" : "red"}`}>
              {cashFlow.ties ? "ties to cash" : "does not tie, investigate"}
            </span>
          </header>
          <table className="accounting-statement-table">
            <caption className="accounting-sr-only">Cash flow by activity</caption>
            <tbody>
              {(
                [
                  ["Operating", cashFlow.operating],
                  ["Investing", cashFlow.investing],
                  ["Financing", cashFlow.financing],
                ] as const
              ).map(([label, bucket]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="is-numeric is-positive">
                    {bucket.inflowMinor ? `+${formatMoney(reports.baseCurrency, bucket.inflowMinor)}` : "-"}
                  </td>
                  <td className="is-numeric">
                    {bucket.outflowMinor ? `-${formatMoney(reports.baseCurrency, bucket.outflowMinor)}` : "-"}
                  </td>
                  <td className="is-numeric">{formatMoney(reports.baseCurrency, bucket.netMinor)}</td>
                </tr>
              ))}
              <tr className="accounting-statement-total">
                <th scope="row">Net change in cash</th>
                <td className="is-numeric" />
                <td className="is-numeric" />
                <td className={`is-numeric${cashFlow.netMinor < 0 ? " is-negative" : ""}`}>
                  {formatMoney(reports.baseCurrency, cashFlow.netMinor)}
                </td>
              </tr>
              <tr>
                <td>Cash balance now</td>
                <td className="is-numeric" />
                <td className="is-numeric" />
                <td className="is-numeric">{formatMoney(reports.baseCurrency, cashFlow.cashBalanceMinor)}</td>
              </tr>
            </tbody>
          </table>
        </section>
      )}

      <section className="accounting-card">
        <header>
          <h2>FX exposure and rates</h2>
        </header>
        {exposures.length === 0 ? (
          <p className="accounting-quiet">
            No foreign-currency receivables outstanding, so there is no unrealized exposure.
          </p>
        ) : (
          <div className="accounting-table-scroll">
            <table className="accounting-statement-table">
              <caption className="accounting-sr-only">Foreign currency exposure</caption>
              <thead>
                <tr>
                  <th scope="col">Currency</th>
                  <th scope="col" className="is-numeric">Outstanding (foreign)</th>
                  <th scope="col" className="is-numeric">Latest rate</th>
                  <th scope="col" className="is-numeric">Value in base</th>
                </tr>
              </thead>
              <tbody>
                {exposures.map((exposure) => (
                  <tr key={exposure.currency}>
                    <th scope="row">{exposure.currency}</th>
                    <td className="is-numeric">{formatMoneyOrMinor(exposure.currency, exposure.outstandingForeignMinor)}</td>
                    <td className="is-numeric">
                      {exposure.latestRateNum !== null && exposure.latestRateDen !== null
                        ? (exposure.latestRateNum / exposure.latestRateDen).toFixed(4)
                        : "no rate yet"}
                    </td>
                    <td className="is-numeric">
                      {exposure.outstandingBaseMinor === null
                        ? "-"
                        : formatMoney(reports.baseCurrency, exposure.outstandingBaseMinor)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="accounting-field-row accounting-block-divider">
          <label className="accounting-label">
            Currency
            <input
              className="accounting-currency-input"
              placeholder="EUR"
              maxLength={3}
              value={fxForm.quoteCurrency}
              onChange={(event) => setFxForm({ ...fxForm, quoteCurrency: event.target.value })}
            />
          </label>
          <label className="accounting-label">
            Rate, 1 unit in base
            <input
              className="accounting-money-input"
              inputMode="decimal"
              placeholder="1.0875"
              value={fxForm.rate}
              onChange={(event) => setFxForm({ ...fxForm, rate: event.target.value })}
            />
          </label>
          <label className="accounting-label">
            Effective (optional)
            <input
              type="date"
              value={fxForm.effectiveAt}
              onChange={(event) => setFxForm({ ...fxForm, effectiveAt: event.target.value })}
            />
          </label>
          <button
            type="button"
            disabled={busy || !fxForm.quoteCurrency.trim() || !Number(fxForm.rate)}
            onClick={recordRate}
          >
            Record rate
          </button>
        </div>
      </section>
    </section>
  );
}

/* ---------------------------------------------------------------- periods -- */

function PeriodsSection({
  closedPeriods,
  busy,
  onCloseYear,
  onReopen,
}: {
  closedPeriods: Awaited<ReturnType<typeof fetchAccountingOverview>>["closedPeriods"];
  busy: boolean;
  onCloseYear: (year: number) => Promise<boolean>;
  onReopen: (year: number, month: number) => Promise<boolean>;
}) {
  const [yearInput, setYearInput] = useState(String(new Date().getUTCFullYear()));
  const [closeTarget, setCloseTarget] = useState<number | null>(null);
  const [reopenTarget, setReopenTarget] = useState<{ year: number; month: number } | null>(null);
  const closeYear = Number(yearInput);

  return (
    <section className="accounting-stack accounting-narrow">
      <div>
        <h2>Closed period history</h2>
        <p className="accounting-hint">
          Reopen a sealed month only when a corrective posting is needed. Reopening requires
          approval.
        </p>
        {closedPeriods.length > 0 ? (
          <div className="accounting-block-divider">
            <p className="accounting-hint">Sealed:</p>
            <ul className="accounting-sealed-list">
              {closedPeriods.map((period) => (
                <li key={`${period.year}-${period.month}`}>
                  <span className="accounting-badge">
                    {period.year}-{String(period.month).padStart(2, "0")}
                  </span>
                  <button
                    type="button"
                    className="accounting-button accounting-button-ghost accounting-button-small"
                    disabled={busy}
                    onClick={() => setReopenTarget(period)}
                  >
                    Reopen
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="accounting-hint accounting-block-divider">
            No periods have been sealed yet.
          </p>
        )}
      </div>

      <div className="accounting-block-divider">
        <h2>Year-end close</h2>
        <p className="accounting-hint">
          Zeroes income and expense accounts into retained earnings with one balanced entry, then
          seals December. Approval-gated.
        </p>
        <div className="accounting-field-row">
          <label className="accounting-label">
            Fiscal year to close
            <input
              className="accounting-money-input"
              inputMode="numeric"
              value={yearInput}
              onChange={(event) => setYearInput(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="accounting-button-danger"
            disabled={busy || !yearInput || !Number.isSafeInteger(closeYear)}
            onClick={() => setCloseTarget(closeYear)}
          >
            Close year, roll retained earnings
          </button>
        </div>
      </div>

      <Dialog
        open={closeTarget !== null}
        title={`Close fiscal year ${closeTarget ?? ""}`}
        description="Post the closing entry, rolling net income into retained earnings and sealing December. This is a destructive-class action and requires approval."
        onClose={() => setCloseTarget(null)}
        footer={
          <>
            <button type="button" disabled={busy} onClick={() => setCloseTarget(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="accounting-button-danger"
              disabled={busy || closeTarget === null}
              onClick={() => {
                if (closeTarget === null) return;
                void onCloseYear(closeTarget).then((accepted) => {
                  if (accepted) setCloseTarget(null);
                });
              }}
            >
              Close {closeTarget}
            </button>
          </>
        }
      >
        <p>
          This posts the closing entry for {closeTarget} and seals December {closeTarget}. The books
          cannot be edited afterwards without reopening the period.
        </p>
      </Dialog>

      <Dialog
        open={reopenTarget !== null}
        title={`Reopen ${reopenTarget ? `${reopenTarget.year}-${String(reopenTarget.month).padStart(2, "0")}` : ""}`}
        description="Unseals the month so corrective postings land in the right period. This is a destructive-class action and requires approval."
        onClose={() => setReopenTarget(null)}
        footer={
          <>
            <button type="button" disabled={busy} onClick={() => setReopenTarget(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="accounting-button-danger"
              disabled={busy || !reopenTarget}
              onClick={() => {
                if (!reopenTarget) return;
                void onReopen(reopenTarget.year, reopenTarget.month).then((accepted) => {
                  if (accepted) setReopenTarget(null);
                });
              }}
            >
              Reopen period
            </button>
          </>
        }
      >
        <p>
          Reopening {reopenTarget?.year}-{reopenTarget ? String(reopenTarget.month).padStart(2, "0") : ""}{" "}
          lets new postings land in a sealed period.
        </p>
      </Dialog>
    </section>
  );
}

/* ------------------------------------------------------------------- bank -- */

function BankSection({
  baseCurrency,
  banking,
  busy,
  onAction,
}: {
  baseCurrency: string;
  banking: AccountingBanking | null;
  busy: boolean;
  onAction: (
    path: "/api/accounting" | "/api/banking",
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
    const only = accounts.length === 1 ? accounts[0] : undefined;
    if (!accountId && only) setAccountId(only.id);
    else if (accountId && !accounts.some((account) => account.id === accountId)) setAccountId("");
  }, [accounts, accountId]);

  if (!banking) {
    return (
      <p className="accounting-empty">
        <strong>Bank feeds could not load</strong>
        <span>Check your connection and retry from the Overview tab.</span>
      </p>
    );
  }

  const summary = banking.summary;
  const selectedAccount =
    accounts.find((account) => account.id === accountId) ??
    (accounts.length === 1 ? accounts[0] : undefined);

  function addAccount() {
    if (!newName.trim()) return;
    void onAction(
      "/api/banking",
      {
        action: "addBankAccount",
        name: newName.trim(),
        currencyCode: newCurrencyCode.trim().toUpperCase() || baseCurrency,
        last4: newLast4.trim() || undefined,
      },
      `Add account ${newName.trim()}`,
    ).then((accepted) => {
      if (!accepted) return;
      setNewName("");
      setNewLast4("");
    });
  }

  function importFeed() {
    if (!selectedAccount) return;
    const parsed = parseFeedCsv(feed, selectedAccount.currencyCode);
    setParseErrors(parsed.errors);
    if (parsed.rows.length === 0) return;
    void onAction(
      "/api/banking",
      { action: "importBankFeed", bankAccountId: selectedAccount.id, rows: parsed.rows },
      `Import ${parsed.rows.length} statement line${parsed.rows.length === 1 ? "" : "s"}`,
    ).then((accepted) => {
      if (accepted) setFeed("");
    });
  }

  return (
    <section className="accounting-stack accounting-narrow">
      <p className="accounting-hint">
        <strong className={summary.unmatchedCount > 0 ? "accounting-figure-value is-warn" : "accounting-figure-value is-positive"}>
          {summary.unmatchedCount}
        </strong>{" "}
        unmatched statement line{summary.unmatchedCount === 1 ? "" : "s"}
      </p>

      <div>
        <h2>Accounts</h2>
        {accounts.length === 0 ? (
          <p className="accounting-quiet">
            No bank accounts yet. Add one below to start importing statements.
          </p>
        ) : (
          <ul className="accounting-account-list">
            {accounts.map((account) => {
              const stat = summary.accounts.find((row) => row.bankAccountId === account.id);
              return (
                <li key={account.id} className="accounting-account-item">
                  <strong>{account.name}</strong>
                  {account.last4 && <span className="accounting-hint">{account.last4}</span>}
                  <span className="accounting-badge">{account.currencyCode}</span>
                  {stat && (
                    <span className={`accounting-badge accounting-badge-${stat.count > 0 ? "amber" : "green"}`}>
                      {stat.count} lines
                    </span>
                  )}
                  <span className="accounting-money-inline">
                    {formatMoneyOrMinor(account.currencyCode, account.balanceMinor)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <div className="accounting-field-row accounting-block-divider">
          <label className="accounting-label">
            Account name
            <input value={newName} onChange={(event) => setNewName(event.target.value)} />
          </label>
          <label className="accounting-label">
            Last four
            <input
              maxLength={4}
              value={newLast4}
              onChange={(event) => setNewLast4(event.target.value)}
            />
          </label>
          <label className="accounting-label">
            Currency
            <input
              className="accounting-currency-input"
              maxLength={3}
              placeholder={baseCurrency}
              value={newCurrencyCode}
              onChange={(event) => setNewCurrencyCode(event.target.value.toUpperCase())}
            />
          </label>
          <button
            type="button"
            disabled={busy || !newName.trim() || !hasCurrencyCode(newCurrencyCode.trim() || baseCurrency)}
            onClick={addAccount}
          >
            Add account
          </button>
        </div>
      </div>

      <div className="accounting-block-divider">
        <h2>Import feed</h2>
        <p className="accounting-hint">
          Paste bank export lines, one per row, as <code className="accounting-source">date,amount,description</code>.
          Positive is money in. Duplicate lines are skipped automatically, so re-pasting an export is
          safe.
        </p>
        {accounts.length > 1 && (
          <label className="accounting-label accounting-block-divider">
            Account to import into
            <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              <option value="">Choose an account</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {selectedAccount && (
          <p className="accounting-hint">Amounts will be read as {selectedAccount.currencyCode}.</p>
        )}
        <label className="accounting-label accounting-block-divider">
          Statement lines
          <textarea
            className="accounting-code-input"
            rows={5}
            placeholder={"2025-06-01,1250.00,ACME wire\n2025-06-02,-42.10,Card fees"}
            value={feed}
            onChange={(event) => setFeed(event.target.value)}
          />
        </label>
        {parseErrors.length > 0 && (
          <ul className="accounting-sealed-list" role="alert">
            {parseErrors.slice(0, 5).map((message) => (
              <li key={message} className="accounting-figure-value is-danger">
                {message}
              </li>
            ))}
          </ul>
        )}
        <div className="accounting-button-row accounting-block-divider">
          <button
            type="button"
            className="accounting-button-primary"
            disabled={busy || !feed.trim() || !selectedAccount}
            onClick={importFeed}
          >
            Import lines
          </button>
        </div>
      </div>

      <div className="accounting-block-divider">
        <h2>Unmatched transactions</h2>
        {banking.unmatched.length === 0 ? (
          <p className="accounting-quiet">
            Every imported statement line is matched or excluded.
          </p>
        ) : (
          <ul className="accounting-transaction-list">
            {banking.unmatched.map((transaction) => (
              <li key={transaction.id} className="accounting-transaction-item">
                <time className="accounting-transaction-date" dateTime={transaction.postedAt}>
                  {transaction.postedAt.slice(0, 10)}
                </time>
                <span className="accounting-transaction-desc" title={transaction.description}>
                  {transaction.description}
                </span>
                <span className={`accounting-transaction-amount${transaction.amountMinor < 0 ? " is-negative" : ""}`}>
                  {formatMoneyOrMinor(transaction.currencyCode, transaction.amountMinor)}
                </span>
                <select
                  aria-label={`Match ${transaction.description} against payment`}
                  value={matchPicks[transaction.id] ?? ""}
                  onChange={(event) =>
                    setMatchPicks((current) => ({ ...current, [transaction.id]: event.target.value }))
                  }
                >
                  <option value="">Match to payment</option>
                  {banking.payments
                    .filter((payment) => payment.currencyCode === transaction.currencyCode)
                    .map((payment) => (
                      <option key={payment.id} value={payment.id}>
                        {payment.customerName} · #{payment.invoiceNumber ?? "?"} ·{" "}
                        {formatMoneyOrMinor(payment.currencyCode ?? transaction.currencyCode, payment.amountMinor)}
                      </option>
                    ))}
                </select>
                <button
                  type="button"
                  className="accounting-button accounting-button-small"
                  disabled={busy || !matchPicks[transaction.id]}
                  onClick={() =>
                    void onAction(
                      "/api/banking",
                      {
                        action: "matchBankTransaction",
                        transactionId: transaction.id,
                        paymentId: matchPicks[transaction.id],
                      },
                      "Match",
                    )
                  }
                >
                  Match
                </button>
                <button
                  type="button"
                  className="accounting-button accounting-button-ghost accounting-button-small"
                  disabled={busy}
                  onClick={() =>
                    void onAction(
                      "/api/banking",
                      { action: "excludeBankTransaction", transactionId: transaction.id },
                      "Exclude",
                    )
                  }
                >
                  Exclude
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {(banking.matched?.length ?? 0) > 0 && (
        <div className="accounting-block-divider">
          <h2>Matched transactions</h2>
          <ul className="accounting-transaction-list accounting-block-divider">
            {banking.matched!.map((transaction) => (
              <li key={transaction.id} className="accounting-transaction-item">
                <time className="accounting-transaction-date" dateTime={transaction.postedAt}>
                  {transaction.postedAt.slice(0, 10)}
                </time>
                <span className="accounting-transaction-desc" title={transaction.description}>
                  {transaction.description}
                </span>
                <span className={`accounting-transaction-amount${transaction.amountMinor < 0 ? " is-negative" : ""}`}>
                  {formatMoneyOrMinor(transaction.currencyCode, transaction.amountMinor)}
                </span>
                <button
                  type="button"
                  className="accounting-button accounting-button-ghost accounting-button-small"
                  disabled={busy}
                  onClick={() =>
                    void onAction(
                      "/api/banking",
                      { action: "unmatchBankTransaction", transactionId: transaction.id },
                      "Unmatch",
                    )
                  }
                >
                  Unmatch
                </button>
              </li>
            ))}
          </ul>
          <p className="accounting-hint">
            A mistaken match releases the line back to unmatched. Nothing is ever deleted.
          </p>
        </div>
      )}

      {(banking.excluded?.length ?? 0) > 0 && (
        <div className="accounting-block-divider">
          <h2>Excluded transactions</h2>
          <ul className="accounting-transaction-list accounting-block-divider">
            {banking.excluded!.map((transaction) => (
              <li key={transaction.id} className="accounting-transaction-item">
                <time className="accounting-transaction-date" dateTime={transaction.postedAt}>
                  {transaction.postedAt.slice(0, 10)}
                </time>
                <span className="accounting-transaction-desc" title={transaction.description}>
                  {transaction.description}
                </span>
                <span className={`accounting-transaction-amount${transaction.amountMinor < 0 ? " is-negative" : ""}`}>
                  {formatMoneyOrMinor(transaction.currencyCode, transaction.amountMinor)}
                </span>
                <button
                  type="button"
                  className="accounting-button accounting-button-ghost accounting-button-small"
                  disabled={busy}
                  onClick={() =>
                    void onAction(
                      "/api/banking",
                      { action: "unexcludeBankTransaction", transactionId: transaction.id },
                      "Restore",
                    )
                  }
                >
                  Restore
                </button>
                <button
                  type="button"
                  className="accounting-button accounting-button-ghost accounting-button-small"
                  disabled={busy}
                  onClick={() =>
                    void onAction(
                      "/api/banking",
                      { action: "deleteBankTransaction", transactionId: transaction.id },
                      "Delete",
                    )
                  }
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
          <p className="accounting-hint">
            Restore puts a line back into matching. Delete removes it entirely, for example a
            duplicate import.
          </p>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------- cash -- */

function CashSection({
  baseCurrency,
  customers,
}: {
  baseCurrency: string;
  customers: AccountingCustomer[];
}) {
  const [forecast, setForecast] = useState<AccountingForecast | null>(null);
  const [forecastError, setForecastError] = useState<string | null>(null);
  const [forecastAttempt, setForecastAttempt] = useState(0);
  const [scenarios, setScenarios] = useState<AccountingBudgetScenario[]>([]);
  const [budgetScenarioId, setBudgetScenarioId] = useState("");
  const [reminders, setReminders] = useState<AccountingReminder[] | null>(null);
  const [reminderError, setReminderError] = useState<string | null>(null);
  const [remindersBusy, setRemindersBusy] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [statement, setStatement] = useState<AccountingStatement | null>(null);
  const [statementBusy, setStatementBusy] = useState(false);
  const [statementError, setStatementError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchAccountingBudgetScenarios(controller.signal)
      .then((rows) => {
        if (controller.signal.aborted) return;
        setScenarios(rows);
        setBudgetScenarioId((current) => current || rows.find((row) => row.isCurrent)?.id || "");
      })
      // No scenario list only means the picker stays empty; the forecast still runs.
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setForecast(null);
    setForecastError(null);
    void fetchCashForecast(budgetScenarioId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setForecast(result);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setForecastError(
          error instanceof AccountingApiError
            ? error.message
            : "Could not compute the forecast. Try again in a moment.",
        );
      });
    return () => controller.abort();
  }, [forecastAttempt, budgetScenarioId]);

  async function draftReminders() {
    setRemindersBusy(true);
    setReminderError(null);
    try {
      setReminders(await fetchPaymentReminders());
    } catch (error) {
      setReminderError(
        error instanceof AccountingApiError ? error.message : "Could not draft reminders. Try again.",
      );
    } finally {
      setRemindersBusy(false);
    }
  }

  async function loadStatement() {
    if (!customerId) return;
    setStatementBusy(true);
    setStatementError(null);
    try {
      setStatement(await fetchCustomerStatement(customerId));
    } catch (error) {
      setStatement(null);
      setStatementError(
        error instanceof AccountingApiError
          ? error.message
          : "Could not load this customer statement. Try again.",
      );
    } finally {
      setStatementBusy(false);
    }
  }

  function copyMessage(reminder: AccountingReminder) {
    setCopyError(null);
    void navigator.clipboard
      .writeText(reminder.message)
      .then(() => {
        const key = `${reminder.customerId}:${reminder.currency}`;
        setCopiedId(key);
        window.setTimeout(() => setCopiedId(null), 1800);
      })
      .catch(() =>
        setCopyError("Clipboard access was blocked. Select and copy the draft text instead."),
      );
  }

  return (
    <section className="accounting-stack">
      <section className="accounting-card">
        <header>
          <h2>13-week cash forecast</h2>
          {forecast?.scenarioName && (
            <span className="accounting-badge accounting-badge-blue">{forecast.scenarioName}</span>
          )}
        </header>
        {scenarios.length > 0 && (
          <label className="accounting-label accounting-block-divider">
            Forecast assumptions
            <select
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
          <div className="accounting-button-row">
            <p className="accounting-callout accounting-callout-danger" role="alert">
              {forecastError}
            </p>
            <button type="button" onClick={() => setForecastAttempt((attempt) => attempt + 1)}>
              Retry
            </button>
          </div>
        ) : !forecast ? (
          <p className="accounting-quiet">Projecting thirteen weeks of cash.</p>
        ) : (
          <>
            <div className="accounting-stats accounting-block-divider">
              <span className="accounting-metric">
                <span className="accounting-stat-label">Cash today · {baseCurrency}</span>
                <strong className="accounting-stat-value">{formatMoney(baseCurrency, forecast.startMinor)}</strong>
              </span>
              <span className="accounting-metric">
                <span className="accounting-stat-label">Projected in 13 weeks</span>
                <strong className={`accounting-stat-value${forecast.finalMinor < 0 ? " is-danger" : " is-accent"}`}>
                  {formatMoney(baseCurrency, forecast.finalMinor)}
                </strong>
              </span>
              <span className="accounting-metric">
                <span className="accounting-stat-label">Projected low point</span>
                <strong className={`accounting-stat-value${forecast.lowestCloseMinor < 0 ? " is-danger" : ""}`}>
                  {formatMoney(baseCurrency, forecast.lowestCloseMinor)}
                </strong>
                <span className="accounting-stat-sub">
                  {forecast.lowestWeekIndex < 0
                    ? "today"
                    : `week ${forecast.lowestWeekIndex + 1} of 13`}
                </span>
              </span>
            </div>
            {forecast.scenarioName &&
              forecast.lowestCloseMinor < forecast.minimumCashBufferMinor && (
                <p className="accounting-callout" role="status">
                  Forecast cash falls below the scenario minimum buffer of{" "}
                  {formatMoney(baseCurrency, forecast.minimumCashBufferMinor)}.
                </p>
              )}
            {forecast.unsupportedCurrencies === undefined ? (
              <p className="accounting-callout">
                Currency coverage could not be verified. The forecast is shown in {baseCurrency};
                confirm foreign-currency balances separately.
              </p>
            ) : (
              forecast.unsupportedCurrencies.length > 0 && (
                <p className="accounting-callout">
                  The forecast is in {baseCurrency}. Foreign-currency balances (
                  {forecast.unsupportedCurrencies.join(", ")}) are excluded until converted.
                </p>
              )
            )}
            <div className="accounting-statement-scroll" role="region" aria-label="Weekly cash forecast" tabIndex={0}>
              <table className="accounting-statement-table">
                <caption className="accounting-sr-only">Weekly cash forecast</caption>
                <thead>
                  <tr>
                    <th scope="col">Week of</th>
                    <th scope="col" className="is-numeric">Inflow</th>
                    <th scope="col" className="is-numeric">Outflow</th>
                    <th scope="col" className="is-numeric">Closing</th>
                  </tr>
                </thead>
                <tbody>
                  {forecast.weeks.map((week, index) => (
                    <tr key={week.weekStart} className={index === forecast.lowestWeekIndex ? "accounting-row-lowest" : undefined}>
                      <th scope="row">
                        {formatDate(week.weekStart)}
                        {index === forecast.lowestWeekIndex && (
                          <span className="accounting-badge accounting-badge-amber">lowest</span>
                        )}
                      </th>
                      <td className="is-numeric is-positive">
                        {week.inflowMinor ? formatMoney(baseCurrency, week.inflowMinor) : "-"}
                      </td>
                      <td className="is-numeric">
                        {week.outflowMinor ? formatMoney(baseCurrency, week.outflowMinor) : "-"}
                      </td>
                      <td className="is-numeric">{formatMoney(baseCurrency, week.closeMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="accounting-hint">
              Projected from current cash plus the due dates on open invoices and unpaid bills.
              Anything unscheduled, such as new sales or one-off spends, is not included.
            </p>
          </>
        )}
      </section>

      <section className="accounting-card">
        <header>
          <h2>Payment reminder drafts</h2>
          <button
            type="button"
            className="accounting-button accounting-button-ghost accounting-button-small"
            disabled={remindersBusy}
            onClick={() => void draftReminders()}
          >
            {reminders ? "Redraft" : "Draft reminders"}
          </button>
        </header>
        {reminders === null ? (
          <p className="accounting-quiet">
            Draft polite chases for every overdue customer. Nothing is sent automatically.
          </p>
        ) : reminders.length === 0 ? (
          <p className="accounting-quiet">
            No overdue balances, so nobody needs chasing right now.
          </p>
        ) : (
          <ul className="accounting-reminder-list">
            {reminders.map((reminder) => {
              const key = `${reminder.customerId}:${reminder.currency}`;
              return (
                <li key={key} className="accounting-reminder-item">
                  <div className="accounting-reminder-meta">
                    <strong>{reminder.customerName}</strong>
                    <span
                      className={`accounting-badge accounting-badge-${reminder.oldestDaysOverdue > 60 ? "red" : "amber"}`}
                    >
                      {reminder.oldestDaysOverdue}d overdue
                    </span>
                    <span>
                      {reminder.overdueCount} invoice{reminder.overdueCount === 1 ? "" : "s"}
                    </span>
                    <span className="accounting-badge">{reminder.currency}</span>
                    <span className="accounting-money-inline">
                      {formatMoneyOrMinor(reminder.currency, reminder.totalOverdueMinor)}
                    </span>
                    <button
                      type="button"
                      className="accounting-button accounting-button-ghost accounting-button-small"
                      onClick={() => copyMessage(reminder)}
                    >
                      {copiedId === key ? "Copied" : "Copy draft"}
                    </button>
                  </div>
                  <p className="accounting-reminder-message">{reminder.message}</p>
                </li>
              );
            })}
          </ul>
        )}
        {reminderError && (
          <p className="accounting-callout accounting-callout-danger" role="alert">
            {reminderError}
          </p>
        )}
        {copyError && (
          <p className="accounting-callout accounting-callout-danger" role="alert">
            {copyError}
          </p>
        )}
      </section>

      <section className="accounting-card">
        <header>
          <h2>Customer statement</h2>
        </header>
        {customers.length === 0 ? (
          <p className="accounting-quiet">No customers yet. Record an invoice first.</p>
        ) : (
          <>
            <div className="accounting-field-row">
              <label className="accounting-label">
                Customer
                <select value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
                  <option value="">Choose a customer</option>
                  {customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={!customerId || statementBusy}
                onClick={() => void loadStatement()}
              >
                {statementBusy ? "Loading" : "Load statement"}
              </button>
            </div>
            {statementError && (
              <p className="accounting-callout accounting-callout-danger" role="alert">
                {statementError}
              </p>
            )}
            {statement && statement.currencies.length === 0 && (
              <p className="accounting-quiet accounting-block-divider">No activity on this account yet.</p>
            )}
            {statement?.currencies.map((statementCurrency) => (
              <div key={statementCurrency.currency} className="accounting-statement-group">
                <h3>Statement in {statementCurrency.currency}</h3>
                <div
                  className="accounting-statement-scroll"
                  role="region"
                  aria-label={`Statement activity in ${statementCurrency.currency}`}
                  tabIndex={0}
                >
                  <table className="accounting-statement-table">
                    <caption className="accounting-sr-only">
                      Statement activity in {statementCurrency.currency}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Date</th>
                        <th scope="col">Kind</th>
                        <th scope="col">Reference</th>
                        <th scope="col" className="is-numeric">Amount</th>
                        <th scope="col" className="is-numeric">Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statementCurrency.rows.map((row, index) => (
                        <tr key={`${row.ref}-${index}`}>
                          <th scope="row">{formatDate(row.date)}</th>
                          <td>
                            <span
                              className={`accounting-badge accounting-badge-${
                                row.kind === "payment" || row.kind === "credit_note" ? "green" : ""
                              }`}
                            >
                              {row.kind}
                            </span>
                          </td>
                          <td>{row.ref}</td>
                          <td className={`is-numeric${row.amountMinor < 0 ? " is-positive" : ""}`}>
                            {formatMoneyOrMinor(statementCurrency.currency, row.amountMinor)}
                          </td>
                          <td className="is-numeric">
                            {formatMoneyOrMinor(statementCurrency.currency, row.balanceMinor)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="accounting-statement-closing">
                  Closing balance{" "}
                  <strong>{formatMoneyOrMinor(statementCurrency.currency, statementCurrency.closingBalanceMinor)}</strong>
                </p>
              </div>
            ))}
          </>
        )}
      </section>
    </section>
  );
}

/* ---------------------------------------------------------------- budgets -- */

function BudgetsSection({ baseCurrency }: { baseCurrency: string }) {
  const [scenarios, setScenarios] = useState<AccountingBudgetScenario[]>([]);
  const [scenarioId, setScenarioId] = useState("");
  const [forecast, setForecast] = useState<AccountingForecast | null>(null);
  const [forecastError, setForecastError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void fetchAccountingBudgetScenarios(controller.signal)
      .then((rows) => {
        if (controller.signal.aborted) return;
        setScenarios(rows);
        setScenarioId((current) => current || rows.find((row) => row.isCurrent)?.id || "");
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setForecast(null);
    setForecastError(null);
    void fetchCashForecast(scenarioId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setForecast(result);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setForecastError(
          error instanceof AccountingApiError
            ? error.message
            : "Could not project this scenario. Try again in a moment.",
        );
      });
    return () => controller.abort();
  }, [scenarioId, attempt]);

  return (
    <section className="accounting-stack accounting-narrow">
      <p className="accounting-hint">
        Each scenario is a saved set of assumptions. Project one against open invoices and unpaid
        bills to see whether it holds cash.
      </p>
      {scenarios.length === 0 ? (
        <p className="accounting-quiet">
          No saved scenarios yet. The operational forecast runs on live due dates.
        </p>
      ) : (
        <div className="accounting-stats">
          {scenarios.map((scenario) => (
            <button
              key={scenario.id}
              type="button"
              className="accounting-stat-button"
              aria-pressed={scenario.id === scenarioId}
              onClick={() => setScenarioId(scenario.id)}
            >
              <span className="accounting-metric">
                <span className="accounting-stat-label">
                  {scenario.name} · {scenario.fiscalYear} · v{scenario.version}
                </span>
                <strong className="accounting-stat-value">
                  {scenario.isCurrent ? "Current" : "Superseded"}
                </strong>
              </span>
            </button>
          ))}
        </div>
      )}

      {forecastError ? (
        <div className="accounting-button-row">
          <p className="accounting-callout accounting-callout-danger" role="alert">
            {forecastError}
          </p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry
          </button>
        </div>
      ) : !forecast ? (
        <p className="accounting-quiet">Projecting this scenario.</p>
      ) : (
        <>
          <div className="accounting-stats">
            <span className="accounting-metric">
              <span className="accounting-stat-label">Opening cash · {baseCurrency}</span>
              <strong className="accounting-stat-value">{formatMoney(baseCurrency, forecast.startMinor)}</strong>
            </span>
            <span className="accounting-metric">
              <span className="accounting-stat-label">Closing cash in 13 weeks</span>
              <strong className={`accounting-stat-value${forecast.finalMinor < 0 ? " is-danger" : " is-accent"}`}>
                {formatMoney(baseCurrency, forecast.finalMinor)}
              </strong>
            </span>
            <span className="accounting-metric">
              <span className="accounting-stat-label">Lowest week</span>
              <strong className={`accounting-stat-value${forecast.lowestCloseMinor < 0 ? " is-danger" : ""}`}>
                {formatMoney(baseCurrency, forecast.lowestCloseMinor)}
              </strong>
              <span className="accounting-stat-sub">
                {forecast.lowestWeekIndex < 0 ? "today" : `week ${forecast.lowestWeekIndex + 1} of 13`}
              </span>
            </span>
            <span className="accounting-metric">
              <span className="accounting-stat-label">Minimum buffer</span>
              <strong className="accounting-stat-value">
                {formatMoney(baseCurrency, forecast.minimumCashBufferMinor)}
              </strong>
            </span>
          </div>
          {forecast.lowestCloseMinor < forecast.minimumCashBufferMinor && (
            <p className="accounting-callout" role="status">
              This scenario dips below its own minimum cash buffer in week{" "}
              {forecast.lowestWeekIndex + 1}.
            </p>
          )}
          <p className="accounting-hint">
            Projections assume no new sales and no unplanned spend, so treat a thin week as a prompt
            to collect or defer rather than as a forecast.
          </p>
        </>
      )}
    </section>
  );
}

/** The tax code list is only needed on the tax tab, so it loads on demand. */
function TaxTab(props: {
  baseCurrency: string;
  filings: Awaited<ReturnType<typeof fetchAccountingOverview>>["filings"];
}) {
  const [taxCodes, setTaxCodes] = useState<AccountingTaxCode[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    void fetchAccountingTaxCodes(controller.signal)
      .then((codes) => {
        if (!controller.signal.aborted) setTaxCodes(codes);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  return <TaxSection {...props} taxCodes={taxCodes} />;
}

function TaxSection({
  baseCurrency,
  taxCodes,
  filings,
}: {
  baseCurrency: string;
  taxCodes: AccountingTaxCode[];
  filings: Awaited<ReturnType<typeof fetchAccountingOverview>>["filings"];
}) {
  const taxTotal = filings.reduce((sum, filing) => sum + filing.taxMinor, 0);

  return (
    <section className="accounting-stack accounting-narrow">
      <div className="accounting-stats">
        <span className="accounting-metric">
          <span className="accounting-stat-label">Returns filed</span>
          <strong className="accounting-stat-value">{filings.length}</strong>
        </span>
        <span className="accounting-metric">
          <span className="accounting-stat-label">Tax recorded · {baseCurrency}</span>
          <strong className="accounting-stat-value">{formatMoney(baseCurrency, taxTotal)}</strong>
        </span>
        <span className="accounting-metric">
          <span className="accounting-stat-label">Active output codes</span>
          <strong className="accounting-stat-value">{taxCodes.length}</strong>
        </span>
      </div>

      <section className="accounting-card">
        <header>
          <h2>Return filings</h2>
        </header>
        {filings.length === 0 ? (
          <p className="accounting-quiet">No returns filed yet.</p>
        ) : (
          <div className="accounting-table-shell accounting-table-scroll">
            <table className="accounting-table">
              <caption className="accounting-sr-only">Tax return filings</caption>
              <thead>
                <tr>
                  <th scope="col">Period</th>
                  <th scope="col">Filed</th>
                  <th scope="col" className="is-numeric">Tax · {baseCurrency}</th>
                </tr>
              </thead>
              <tbody>
                {filings.map((filing) => (
                  <tr key={filing.id}>
                    <th scope="row">
                      {filing.periodFrom} to {filing.periodTo}
                    </th>
                    <td className="accounting-when">{formatDate(filing.filedAt)}</td>
                    <td className="is-numeric">{formatMoney(baseCurrency, filing.taxMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="accounting-card">
        <header>
          <h2>Output tax codes</h2>
        </header>
        {taxCodes.length === 0 ? (
          <p className="accounting-quiet">
            No active output tax codes. Invoices will use manual tax amounts.
          </p>
        ) : (
          <div className="accounting-table-shell accounting-table-scroll">
            <table className="accounting-table">
              <caption className="accounting-sr-only">Active output tax codes</caption>
              <thead>
                <tr>
                  <th scope="col">Code</th>
                  <th scope="col">Name</th>
                  <th scope="col" className="is-numeric">Rate</th>
                  <th scope="col">Basis</th>
                </tr>
              </thead>
              <tbody>
                {taxCodes.map((code) => (
                  <tr key={code.id}>
                    <th scope="row">{code.code}</th>
                    <td>{code.name}</td>
                    <td className="is-numeric">{(code.rateBasisPoints / 100).toFixed(2)}%</td>
                    <td>{code.priceIncludesTax ? "Price includes tax" : "Tax added on top"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="accounting-hint">
          Preparing returns, recording submissions, and settling the tax ledger happen in the full
          tax workbench.
        </p>
      </section>
    </section>
  );
}
