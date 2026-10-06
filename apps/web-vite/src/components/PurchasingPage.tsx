import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { currencyMinorUnits } from "@chaste/erp-core";
import {
  closePurchasingOrder,
  createPurchasingBill,
  createPurchasingOrder,
  createPurchasingRequest,
  createPurchasingRfq,
  createPurchasingVendor,
  creditPurchasingBill,
  decidePurchasingRequest,
  fetchPurchasingEnabled,
  fetchPurchasingInputTaxCodes,
  fetchPurchasingPriceHistory,
  fetchPurchasingProducts,
  fetchPurchasingSupplierStatement,
  fetchPurchasingWorkspace,
  payPurchasingBill,
  PurchasingApiError,
  receivePurchasingGoods,
  recordPurchasingQuote,
  returnPurchasingGoods,
  selectPurchasingWinningQuote,
  type PurchasingAction,
  type PurchasingActionOutcome,
  type PurchasingBill,
  type PurchasingOrder,
  type PurchasingPriceHistoryRow,
  type PurchasingProduct,
  type PurchasingRequest,
  type PurchasingSupplierStatement,
  type PurchasingTaxCode,
  type PurchasingVendor,
  type PurchasingWorkspace,
} from "../api/purchasing";
import { legacyUrl } from "../legacy";
import "./PurchasingPage.css";

type Tab = "overview" | "requests" | "orders" | "bills" | "vendors" | "intel";

type LoadState =
  | { status: "loading" }
  | { status: "disabled" }
  | { status: "failed"; error: PurchasingApiError }
  | {
    status: "ready";
    workspace: PurchasingWorkspace;
    products: PurchasingProduct[];
    taxCodes: PurchasingTaxCode[];
  };

type Notice = { tone: "success" | "pending" | "error"; text: string };

/** The read actions are driven by their own handlers, so writes exclude them. */
type PurchasingWrite = Exclude<PurchasingAction, { action: "priceHistory" } | { action: "supplierStatement" }>;

type PoLineDraft = { description: string; quantity: string; unitPrice: string; sku: string };
type BillLineDraft = { description: string; quantity: string; unitPrice: string; poLineNumber: string; taxCodeId: string };

const tabs: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "requests", label: "Requests & RFQs" },
  { id: "orders", label: "Orders" },
  { id: "bills", label: "Bills & payments" },
  { id: "vendors", label: "Vendors" },
  { id: "intel", label: "Prices & statements" },
];

const emptyPoLine: PoLineDraft = { description: "", quantity: "1", unitPrice: "0.00", sku: "" };
const emptyBillLine: BillLineDraft = { description: "", quantity: "1", unitPrice: "0.00", poLineNumber: "", taxCodeId: "" };

/* -------------------------------------------------------------- formatting --- */

export function formatMoney(minor: number, currency: string): string {
  const units = currencyMinorUnits(currency) ?? 2;
  const amount = minor / (10 ** units);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: units,
      maximumFractionDigits: units,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString(undefined, {
      minimumFractionDigits: units,
      maximumFractionDigits: units,
    })}`;
  }
}

export function formatThousandths(thousandths: number): string {
  return (thousandths / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 });
}

/**
 * Money is integer minor units end to end, so the decimal a person typed has to
 * be scaled by the currency's own exponent rather than a hardcoded 100, and
 * rounded from the digits themselves so 1.005 does not drift to 1.00.
 */
export function parseMinor(currency: string, value: string): number | null {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) return null;
  const units = currencyMinorUnits(currency) ?? 2;
  const [, whole, fraction = ""] = match;
  const kept = fraction.slice(0, units).padEnd(units, "0");
  const dropped = fraction.length > units ? Number(fraction.charAt(units)) : 0;
  const minor = Number(`${whole}${kept}` || "0") + (dropped >= 5 ? 1 : 0);
  return Number.isSafeInteger(minor) ? minor : null;
}

export function parseThousandths(value: string): number {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return 0;
  return Math.round(Number(trimmed) * 1000);
}

export function majorToInput(minor: number, currency: string): string {
  const units = currencyMinorUnits(currency) ?? 2;
  return (minor / (10 ** units)).toFixed(units);
}

function timeAgo(value: string): string {
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "recently";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(value).toLocaleDateString();
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleDateString();
}

function digitsOnly(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

function statusClass(status: string): string {
  if (status === "approved" || status === "received" || status === "paid" || status === "settled" || status === "converted") {
    return "purchasing-status-pill is-green";
  }
  if (status === "rejected" || status === "void") return "purchasing-status-pill is-red";
  if (status === "ordered" || status === "quoted" || status === "won") return "purchasing-status-pill is-blue";
  if (status === "pending_review" || status === "sent" || status === "lost") return "purchasing-status-pill is-amber";
  return "purchasing-status-pill";
}

/* ------------------------------------------------------------- pure builders --- */

export type ReceiveLineDraft = { lineNumber: number; quantity: number };

/**
 * Only lines with something to book are sent, and repeated references to one
 * order line are folded together: the executor charges duplicates against a
 * single ordered quantity.
 */
export function aggregateReceiveLines(drafts: ReceiveLineDraft[]): ReceiveLineDraft[] {
  const byLine = new Map<number, number>();
  for (const draft of drafts) {
    byLine.set(draft.lineNumber, (byLine.get(draft.lineNumber) ?? 0) + draft.quantity);
  }
  return [...byLine.entries()]
    .map(([lineNumber, quantity]) => ({ lineNumber, quantity }))
    .filter((line) => line.quantity > 0)
    .sort((a, b) => a.lineNumber - b.lineNumber);
}

export type BillLineInput = {
  description: string;
  quantity: number;
  unitPriceMinor: number;
  poLineNumber: number | undefined;
  taxCodeId: string | undefined;
};

/**
 * Three-way matching only engages when a PO number is set; without one the
 * bill stands alone and no PO line reference is claimed.
 */
export function buildBillLines(
  drafts: BillLineDraft[],
  currency: string,
  matched: boolean,
): { lines: BillLineInput[]; invalid: number } {
  let invalid = 0;
  const lines = drafts.map((draft) => {
    const description = draft.description.trim();
    const poLine = draft.poLineNumber.trim() === "" ? undefined : Number(draft.poLineNumber);
    const poLineNumber = matched ? (poLine && Number.isSafeInteger(poLine) && poLine > 0 ? poLine : undefined) : undefined;
    if (matched && !poLineNumber) invalid += 1;
    return {
      description,
      quantity: parseThousandths(draft.quantity),
      unitPriceMinor: parseMinor(currency, draft.unitPrice || "0") ?? 0,
      poLineNumber,
      taxCodeId: draft.taxCodeId || undefined,
    };
  });
  return { lines, invalid };
}

export type ReturnLineInput = { lineNumber: number; quantity: number; reason: string };

/** A return without a stated reason is not a return, so it is never sent. */
export function buildReturnLines(drafts: Record<number, { qty: string; reason: string }>, order: PurchasingOrder): ReturnLineInput[] {
  return order.lines
    .map((line) => ({
      lineNumber: line.lineNumber,
      quantity: parseThousandths(drafts[line.lineNumber]?.qty ?? "0"),
      reason: (drafts[line.lineNumber]?.reason ?? "").trim(),
    }))
    .filter((line) => line.quantity > 0 && line.reason.length >= 3)
    .sort((a, b) => a.lineNumber - b.lineNumber);
}

function vendorOpenOrders(orders: PurchasingOrder[], name: string): PurchasingOrder[] {
  return orders.filter((order) => order.vendorName === name && (order.status === "ordered" || order.status === "partial"));
}

/* -------------------------------------------------------------------- submit --- */

async function submitAction(action: PurchasingWrite, retryScope?: { actorId: string | null; organizationId: string | null }): Promise<PurchasingActionOutcome> {
  switch (action.action) {
    case "createVendor": return createPurchasingVendor(action, undefined, retryScope);
    case "createPurchaseOrder": return createPurchasingOrder(action, undefined, retryScope);
    case "receiveGoods": return receivePurchasingGoods(action);
    case "returnGoods": return returnPurchasingGoods(action, undefined, retryScope);
    case "closePurchaseOrder": return closePurchasingOrder(action, undefined, retryScope);
    case "createBill": return createPurchasingBill(action, undefined, retryScope);
    case "payBill": return payPurchasingBill(action, undefined, retryScope);
    case "billCreditNote": return creditPurchasingBill(action, undefined, retryScope);
    case "createPurchaseRequest": return createPurchasingRequest(action);
    case "decidePurchaseRequest": return decidePurchasingRequest(action);
    case "createRfq": return createPurchasingRfq(action);
    case "recordQuote": return recordPurchasingQuote(action);
    case "selectWinningQuote": return selectPurchasingWinningQuote(action);
    default: {
      const unreachable: never = action;
      throw new PurchasingApiError(0, `Unsupported purchasing action: ${JSON.stringify(unreachable)}`);
    }
  }
}

/* ------------------------------------------------------------------- dialogs --- */

function Dialog({ title, hint, wide = false, onClose, foot, children }: {
  title: string;
  hint?: string;
  wide?: boolean;
  onClose: () => void;
  foot: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="purchasing-modal-backdrop" onClick={onClose}>
      <div
        className={wide ? "purchasing-modal purchasing-modal-wide" : "purchasing-modal"}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="purchasing-modal-title">{title}</h2>
        {hint && <p className="purchasing-modal-hint">{hint}</p>}
        {children}
        <div className="purchasing-modal-foot">{foot}</div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- page --- */

export function PurchasingPage({ baseCurrency = null, actorId = null, organizationId = null }: { baseCurrency?: string | null; actorId?: string | null; organizationId?: string | null } = {}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [tab, setTab] = useState<Tab>(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    return tabs.find((entry) => entry.id === requested)?.id ?? "overview";
  });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const [vendorForm, setVendorForm] = useState({ name: "", email: "" });
  const [quickVendor, setQuickVendor] = useState<{ open: boolean; name: string; email: string }>({ open: false, name: "", email: "" });
  const [poForm, setPoForm] = useState({ vendorId: "", memo: "", lines: [emptyPoLine] });
  const [billForm, setBillForm] = useState({ vendorId: "", vendorRef: "", poNumber: "", lines: [emptyBillLine] });
  const [requestForm, setRequestForm] = useState({ title: "", justification: "", estimate: "" });
  const [receipts, setReceipts] = useState<Record<string, string>>({});
  const [payAmount, setPayAmount] = useState<Record<string, string>>({});
  const [rfqPick, setRfqPick] = useState<Record<string, string[]>>({});
  const [quoteDraft, setQuoteDraft] = useState<Record<string, { amount: string; leadTime: string }>>({});
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [billError, setBillError] = useState<string | null>(null);
  const [creditTarget, setCreditTarget] = useState<PurchasingBill | null>(null);
  const [creditForm, setCreditForm] = useState({ amount: "", reason: "" });
  const [creditDrafts, setCreditDrafts] = useState<Record<string, { amount: string; reason: string }>>({});
  const [creditAttemptLocked, setCreditAttemptLocked] = useState<Record<string, boolean>>({});
  const [closeTarget, setCloseTarget] = useState<PurchasingOrder | null>(null);
  const [returnTarget, setReturnTarget] = useState<PurchasingOrder | null>(null);
  const [returnLines, setReturnLines] = useState<Record<number, { qty: string; reason: string }>>({});
  const [selectedVendorId, setSelectedVendorId] = useState<string | null>(null);

  const load = useCallback(async ({ signal, quiet = false }: { signal?: AbortSignal; quiet?: boolean } = {}) => {
    if (!quiet) setState({ status: "loading" });
    try {
      if (!(await fetchPurchasingEnabled(signal))) {
        if (!signal?.aborted) setState({ status: "disabled" });
        return;
      }
      const [workspace, products, taxCodes] = await Promise.all([
        fetchPurchasingWorkspace(signal),
        fetchPurchasingProducts(signal).catch(() => [] as PurchasingProduct[]),
        fetchPurchasingInputTaxCodes(signal).catch(() => [] as PurchasingTaxCode[]),
      ]);
      if (signal?.aborted) return;
      setState({ status: "ready", workspace, products, taxCodes });
    } catch (error) {
      if (signal?.aborted) return;
      setState({
        status: "failed",
        error: error instanceof PurchasingApiError
          ? error
          : new PurchasingApiError(0, "Could not load the Purchasing workspace. Try again."),
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load({ signal: controller.signal });
    return () => controller.abort();
  }, [load]);

  function changeTab(next: Tab): void {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  async function runAction(
    label: string,
    action: PurchasingWrite,
    after?: () => void,
    lifecycle?: { onPending?: () => void; onError?: (error: unknown) => void },
  ): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setNotice(null);
    try {
      const outcome = await submitAction(action, { actorId, organizationId });
      if (outcome.kind === "pending") {
        lifecycle?.onPending?.();
        setNotice({ tone: "pending", text: `${label} is waiting for approval${outcome.reason ? `: ${outcome.reason}` : ""}.` });
        return false;
      }
      setNotice({ tone: "success", text: `${label} done.` });
      after?.();
      await load({ quiet: true });
      return true;
    } catch (error) {
      lifecycle?.onError?.(error);
      setNotice({
        tone: "error",
        text: error instanceof PurchasingApiError ? error.message : `${label} failed. Try again.`,
      });
      return false;
    } finally {
      setBusy(false);
    }
  }

  function clearCreditDraft(billId: string): void {
    setCreditDrafts((current) => {
      const next = { ...current };
      delete next[billId];
      return next;
    });
    setCreditAttemptLocked((current) => ({ ...current, [billId]: false }));
  }

  function creditDraftKey(billId: string): string {
    return JSON.stringify([actorId, organizationId, billId]);
  }

  const activeCreditDraftKey = creditTarget ? creditDraftKey(creditTarget.id) : null;

  if (state.status === "loading") {
    return <main className="purchasing-page"><p className="purchasing-loading" role="status">Loading the purchasing workspace…</p></main>;
  }

  if (state.status === "disabled") {
    return (
      <main className="purchasing-page">
        <section className="purchasing-disabled" role="status">
          <h2>Purchasing is turned off</h2>
          <p>Ask a workspace administrator to enable the Purchasing module before using it.</p>
        </section>
      </main>
    );
  }

  if (state.status === "failed") {
    const heading = state.error.status === 401 ? "Sign in again"
      : state.error.status === 403 ? "Access denied"
      : state.error.status === 428 ? "Finish setting up your workspace"
      : "Could not load Purchasing";
    return (
      <main className="purchasing-page">
        <header className="purchasing-header">
          <div>
            <p className="purchasing-eyebrow">Purchasing · procurement</p>
            <h1>Purchasing</h1>
            <p>Vendors, purchase orders, receipts, bills, and payments, with three-way matching throughout.</p>
          </div>
          <a className="purchasing-legacy-link" href={legacyUrl("/purchasing")}>Open full workspace</a>
        </header>
        <section className="purchasing-error" role="alert" aria-labelledby="purchasing-load-error">
          <div>
            <h2 id="purchasing-load-error">{heading}</h2>
            <p>{state.error.message}</p>
          </div>
          <div className="purchasing-error-actions">
            {state.error.status === 401 && <a href="/login">Sign in again</a>}
            <button type="button" className="purchasing-button is-primary" onClick={() => void load()}>Try again</button>
          </div>
        </section>
      </main>
    );
  }

  const { workspace, products, taxCodes } = state;
  const currency = baseCurrency || workspace.baseCurrency;
  const vendors = workspace.vendors;
  const orders = workspace.orders;
  const bills = workspace.bills;
  const requests = workspace.requests;
  const pendingRequests = requests.filter((request) => request.status === "pending_review");
  const openOrders = orders.filter((order) => order.status === "ordered" || order.status === "partial");
  const outstanding = workspace.apAging?.buckets?.totalOutstanding ?? 0;

  function countFor(id: Tab): number | null {
    if (id === "requests") return pendingRequests.length || null;
    if (id === "orders") return openOrders.length || null;
    if (id === "vendors") return vendors.length || null;
    return null;
  }

  return (
    <main className="purchasing-page">
      <header className="purchasing-header">
        <div>
          <p className="purchasing-eyebrow">Purchasing · procurement</p>
          <h1>Purchasing</h1>
          <p>Vendors, purchase orders, receipts, bills, and payments, with three-way matching throughout. Every write goes through the governed capability kernel, so anything above your authority waits in the Approvals inbox.</p>
        </div>
        <a className="purchasing-legacy-link" href={legacyUrl("/purchasing")}>Open full workspace</a>
      </header>

      <nav className="purchasing-subnav" aria-label="Purchasing reports">
        <a className="purchasing-subnav-link" href={legacyUrl("/purchasing/payment-runs")}>Payment runs</a>
        <a className="purchasing-subnav-link" href={legacyUrl("/purchasing/ap-aging")}>Payables aging</a>
        <a className="purchasing-subnav-link" href={legacyUrl("/purchasing/receipts")}>Receipt history</a>
        <a className="purchasing-subnav-link" href={legacyUrl("/purchasing/receiving")}>Receiving desk</a>
      </nav>

      <nav className="purchasing-tabs" role="tablist" aria-label="Purchasing sections">
        {tabs.map((entry, index) => (
          <button
            key={entry.id}
            id={`purchasing-tab-${entry.id}`}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            aria-controls="purchasing-tab-panel"
            tabIndex={tab === entry.id ? 0 : -1}
            className="purchasing-tab"
            onClick={() => changeTab(entry.id)}
            onKeyDown={(event) => {
              const next = event.key === "ArrowRight"
                ? tabs[(index + 1) % tabs.length]
                : event.key === "ArrowLeft"
                  ? tabs[(index + tabs.length - 1) % tabs.length]
                  : event.key === "Home"
                    ? tabs[0]
                    : event.key === "End"
                      ? tabs[tabs.length - 1]
                      : null;
              if (!next) return;
              event.preventDefault();
              changeTab(next.id);
              document.getElementById(`purchasing-tab-${next.id}`)?.focus();
            }}
          >
            {entry.label}
            {countFor(entry.id) !== null && <span className="purchasing-tab-count">{countFor(entry.id)}</span>}
          </button>
        ))}
      </nav>

      <div id="purchasing-tab-panel" role="tabpanel" aria-labelledby={`purchasing-tab-${tab}`}>
        {notice && (
          <div className={`purchasing-notice is-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
            <span>{notice.text}</span>
            <button type="button" className="purchasing-notice-dismiss" onClick={() => setNotice(null)}>Dismiss</button>
          </div>
        )}

        {tab === "overview" && (
          <Overview
            orders={orders}
            bills={bills}
            requests={pendingRequests}
            vendorCount={vendors.length}
            outstanding={outstanding}
            currency={currency}
            onOpenTab={changeTab}
          />
        )}

        {tab === "requests" && (
          <RequestsTab
            requests={requests}
            vendors={vendors}
            busy={busy}
            form={requestForm}
            setForm={setRequestForm}
            rfqPick={rfqPick}
            setRfqPick={setRfqPick}
            quoteDraft={quoteDraft}
            setQuoteDraft={setQuoteDraft}
            rejectFor={rejectFor}
            rejectReason={rejectReason}
            setRejectFor={setRejectFor}
            setRejectReason={setRejectReason}
            onRun={runAction}
          />
        )}

        {tab === "orders" && (
          <OrdersTab
            orders={orders}
            vendors={vendors}
            products={products}
            currency={currency}
            busy={busy}
            poForm={poForm}
            setPoForm={setPoForm}
            quickVendor={quickVendor}
            setQuickVendor={setQuickVendor}
            receipts={receipts}
            setReceipts={setReceipts}
            onRun={runAction}
            onOpenReturn={(order) => {
              setReturnTarget(order);
              setReturnLines({});
            }}
            onOpenClose={setCloseTarget}
          />
        )}

        {tab === "bills" && (
          <BillsTab
            bills={bills}
            vendors={vendors}
            taxCodes={taxCodes}
            currency={currency}
            outstanding={outstanding}
            busy={busy}
            form={billForm}
            setForm={setBillForm}
            billError={billError}
            setBillError={setBillError}
            payAmount={payAmount}
            setPayAmount={setPayAmount}
            onRun={runAction}
            onOpenCredit={(bill) => {
              setCreditTarget(bill);
              setCreditForm(creditDrafts[creditDraftKey(bill.id)] ?? { amount: majorToInput(bill.dueMinor, bill.currency), reason: "" });
            }}
          />
        )}

        {tab === "vendors" && (
          <VendorsTab
            vendors={vendors}
            orders={orders}
            bills={bills}
            currency={currency}
            busy={busy}
            form={vendorForm}
            setForm={setVendorForm}
            selectedVendorId={selectedVendorId}
            setSelectedVendorId={setSelectedVendorId}
            onRun={runAction}
          />
        )}

        {tab === "intel" && (
          <IntelTab
            vendors={vendors}
            initialRows={workspace.priceHistory?.rows ?? []}
            performance={workspace.supplierPerformance?.vendors ?? []}
            currency={currency}
          />
        )}
      </div>

      {creditTarget && (
        <Dialog
          title={`Credit bill #${creditTarget.number}`}
          hint={`A supplier credit for ${creditTarget.vendorName} reduces what you owe through a reversing entry; the bill itself is never edited.`}
          onClose={() => setCreditTarget(null)}
          foot={
            <>
              <button type="button" className="purchasing-button is-quiet" disabled={busy} onClick={() => setCreditTarget(null)}>Cancel</button>
              <button
                type="button"
                className="purchasing-button is-primary"
                disabled={busy || (parseMinor(creditTarget.currency, creditForm.amount) ?? 0) <= 0 || creditForm.reason.trim().length < 3}
                onClick={() => {
                  const amountMinor = parseMinor(creditTarget.currency, creditForm.amount) ?? 0;
                  void runAction(`Credit bill #${creditTarget.number}`, {
                    action: "billCreditNote",
                    billId: creditTarget.id,
                    amountMinor,
                    reason: creditForm.reason.trim(),
                  }, () => {
                    if (activeCreditDraftKey) clearCreditDraft(activeCreditDraftKey);
                    setCreditTarget(null);
                  }, {
                    onPending: () => {
                      if (activeCreditDraftKey) setCreditAttemptLocked((current) => ({ ...current, [activeCreditDraftKey]: true }));
                    },
                    onError: (error) => {
                      const terminal = error instanceof PurchasingApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
                      if (terminal && activeCreditDraftKey) clearCreditDraft(activeCreditDraftKey);
                      else if (activeCreditDraftKey && error instanceof PurchasingApiError && error.requestMayHaveReachedServer) {
                        setCreditAttemptLocked((current) => ({ ...current, [activeCreditDraftKey]: true }));
                      }
                    },
                  });
                }}
              >
                Apply credit
              </button>
            </>
          }
        >
          <div className="purchasing-form">
            <label className="purchasing-field" htmlFor="purchasing-credit-amount">
              Amount ({creditTarget.currency})
              <input
                id="purchasing-credit-amount"
                className="purchasing-input purchasing-input-wide"
                inputMode="decimal"
                value={creditForm.amount}
                disabled={busy || (activeCreditDraftKey !== null && (creditAttemptLocked[activeCreditDraftKey] ?? false))}
                onChange={(event) => {
                  if (busy || (activeCreditDraftKey !== null && creditAttemptLocked[activeCreditDraftKey])) return;
                  const next = { ...creditForm, amount: event.currentTarget.value };
                  setCreditForm(next);
                  if (activeCreditDraftKey) setCreditDrafts((current) => ({ ...current, [activeCreditDraftKey]: next }));
                }}
              />
            </label>
            <label className="purchasing-field" htmlFor="purchasing-credit-reason">
              Reason
              <input
                id="purchasing-credit-reason"
                className="purchasing-input"
                placeholder="e.g. damaged goods on delivery"
                maxLength={500}
                value={creditForm.reason}
                disabled={busy || (activeCreditDraftKey !== null && (creditAttemptLocked[activeCreditDraftKey] ?? false))}
                onChange={(event) => {
                  if (busy || (activeCreditDraftKey !== null && creditAttemptLocked[activeCreditDraftKey])) return;
                  const next = { ...creditForm, reason: event.currentTarget.value };
                  setCreditForm(next);
                  if (activeCreditDraftKey) setCreditDrafts((current) => ({ ...current, [activeCreditDraftKey]: next }));
                }}
              />
            </label>
          </div>
        </Dialog>
      )}

      {closeTarget && (
        <Dialog
          title={`Close PO #${closeTarget.number}?`}
          hint="Closes the order for anything not yet received. If quantities are short the order is marked backordered so the shortfall stays on the vendor's record."
          onClose={() => setCloseTarget(null)}
          foot={
            <>
              <button type="button" className="purchasing-button is-quiet" disabled={busy} onClick={() => setCloseTarget(null)}>Cancel</button>
              <button
                type="button"
                className="purchasing-button is-primary"
                disabled={busy}
                onClick={() => {
                  void runAction(`Close PO #${closeTarget.number}`, { action: "closePurchaseOrder", poNumber: closeTarget.number }, () => setCloseTarget(null));
                }}
              >
                Close order
              </button>
            </>
          }
        >
          <p className="purchasing-modal-hint">
            {closeTarget.vendorName} · {formatMoney(closeTarget.orderedMinor, currency)} ordered.
          </p>
        </Dialog>
      )}

      {returnTarget && (
        <Dialog
          wide
          title={`Return goods against PO #${returnTarget.number}`}
          hint="Writes the outbound stock legs against this order so receipts, fill rates, and stock stay truthful."
          onClose={() => setReturnTarget(null)}
          foot={
            <>
              <button type="button" className="purchasing-button is-quiet" disabled={busy} onClick={() => setReturnTarget(null)}>Cancel</button>
              <button
                type="button"
                className="purchasing-button is-danger"
                disabled={busy}
                onClick={() => {
                  const lines = buildReturnLines(returnLines, returnTarget);
                  if (lines.length === 0) return;
                  void runAction(`Return goods on PO #${returnTarget.number}`, {
                    action: "returnGoods",
                    poNumber: returnTarget.number,
                    lines,
                  }, () => setReturnTarget(null));
                }}
              >
                Return goods
              </button>
            </>
          }
        >
          <div className="purchasing-table-wrap">
            <table className="purchasing-table">
              <caption>Quantities to return and the reason for each order line</caption>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Description</th>
                  <th scope="col" className="is-numeric">Return qty</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {returnTarget.lines.map((line) => (
                  <tr key={line.lineNumber}>
                    <td className="is-numeric">{line.lineNumber}</td>
                    <th scope="row">{line.description}</th>
                    <td className="is-numeric">
                      <input
                        className="purchasing-input purchasing-input-narrow"
                        inputMode="numeric"
                        placeholder={formatThousandths(line.quantity)}
                        aria-label={`Return quantity for line ${line.lineNumber}`}
                        value={returnLines[line.lineNumber]?.qty ?? ""}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          setReturnLines((current) => ({
                            ...current,
                            [line.lineNumber]: { qty: value, reason: current[line.lineNumber]?.reason ?? "" },
                          }));
                        }}
                      />
                    </td>
                    <td>
                      <input
                        className="purchasing-input purchasing-input-wide"
                        placeholder="why it goes back"
                        aria-label={`Reason for line ${line.lineNumber}`}
                        maxLength={500}
                        value={returnLines[line.lineNumber]?.reason ?? ""}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          setReturnLines((current) => ({
                            ...current,
                            [line.lineNumber]: { qty: current[line.lineNumber]?.qty ?? "", reason: value },
                          }));
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="purchasing-card-foot">
            Quantities are in whole units, and a line needs a reason of at least three characters. A return larger than what was received is refused.
          </p>
        </Dialog>
      )}
    </main>
  );
}

/* ----------------------------------------------------------------- overview --- */

function Overview({ orders, bills, requests, vendorCount, outstanding, currency, onOpenTab }: {
  orders: PurchasingOrder[];
  bills: PurchasingBill[];
  requests: PurchasingRequest[];
  vendorCount: number;
  outstanding: number;
  currency: string;
  onOpenTab: (tab: Tab) => void;
}) {
  const openOrders = orders.filter((order) => order.status === "ordered" || order.status === "partial");
  const openValue = openOrders.reduce((sum, order) => sum + order.orderedMinor, 0);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const spendThisMonth = bills
    .filter((bill) => new Date(bill.createdAt).getTime() >= monthStart.getTime())
    .reduce((sum, bill) => sum + bill.totalMinor, 0);
  const dueBills = bills.filter((bill) => bill.dueMinor > 0);

  return (
    <section className="purchasing-form" aria-label="Purchasing overview">
      <div className="purchasing-metrics">
        <button type="button" className="purchasing-metric" onClick={() => onOpenTab("orders")}>
          <span>Open POs</span>
          <strong>{openOrders.length}</strong>
          {openValue > 0 && <small>{formatMoney(openValue, currency)} ordered</small>}
        </button>
        <button type="button" className={requests.length > 0 ? "purchasing-metric is-warn" : "purchasing-metric"} onClick={() => onOpenTab("requests")}>
          <span>Requests pending</span>
          <strong>{requests.length}</strong>
        </button>
        <button type="button" className="purchasing-metric" onClick={() => onOpenTab("bills")}>
          <span>Spend this month</span>
          <strong>{formatMoney(spendThisMonth, currency)}</strong>
        </button>
        <button type="button" className="purchasing-metric" onClick={() => onOpenTab("bills")}>
          <span>Payables outstanding</span>
          <strong>{formatMoney(outstanding, currency)}</strong>
        </button>
        <button type="button" className="purchasing-metric" onClick={() => onOpenTab("vendors")}>
          <span>Vendors</span>
          <strong>{vendorCount}</strong>
        </button>
      </div>

      <div className="purchasing-split">
        <section className="purchasing-card" aria-labelledby="purchasing-decisions-title">
          <div className="purchasing-card-head">
            <h2 className="purchasing-card-title" id="purchasing-decisions-title">Decisions waiting on you</h2>
            {requests.length > 0 && (
              <button type="button" className="purchasing-button is-tiny" onClick={() => onOpenTab("requests")}>Review requests</button>
            )}
          </div>
          {requests.length === 0 ? (
            <p className="purchasing-card-hint">No requests pending. Purchase requests land here for review.</p>
          ) : (
            <ul className="purchasing-list">
              {requests.slice(0, 5).map((request) => (
                <li className="purchasing-list-row" key={request.id}>
                  <span className="purchasing-list-title">{request.title}</span>
                  <span className="purchasing-list-meta">
                    raised {timeAgo(request.createdAt)}
                    {request.estimatedAmountMinor ? ` · est. ${formatMoney(request.estimatedAmountMinor, currency)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="purchasing-card" aria-labelledby="purchasing-due-title">
          <div className="purchasing-card-head">
            <h2 className="purchasing-card-title" id="purchasing-due-title">Bills to pay</h2>
            {dueBills.length > 0 && (
              <button type="button" className="purchasing-button is-tiny" onClick={() => onOpenTab("bills")}>Bills &amp; payments</button>
            )}
          </div>
          {dueBills.length === 0 ? (
            <p className="purchasing-card-hint">Nothing due. Vendors are current.</p>
          ) : (
            <ul className="purchasing-list">
              {dueBills.slice(0, 5).map((bill) => (
                <li className="purchasing-list-row" key={bill.id}>
                  <span className="purchasing-list-title">Bill #{bill.number} · {bill.vendorName}</span>
                  <span className="purchasing-list-meta">raised {timeAgo(bill.createdAt)}</span>
                  <span className="purchasing-list-amount">{formatMoney(bill.dueMinor, bill.currency)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- requests --- */

function RequestsTab({ requests, vendors, busy, form, setForm, rfqPick, setRfqPick, quoteDraft, setQuoteDraft, rejectFor, rejectReason, setRejectFor, setRejectReason, onRun }: {
  requests: PurchasingRequest[];
  vendors: PurchasingVendor[];
  busy: boolean;
  form: { title: string; justification: string; estimate: string };
  setForm: (form: { title: string; justification: string; estimate: string }) => void;
  rfqPick: Record<string, string[]>;
  setRfqPick: (pick: Record<string, string[]>) => void;
  quoteDraft: Record<string, { amount: string; leadTime: string }>;
  setQuoteDraft: React.Dispatch<React.SetStateAction<Record<string, { amount: string; leadTime: string }>>>;
  rejectFor: string | null;
  rejectReason: string;
  setRejectFor: (id: string | null) => void;
  setRejectReason: (reason: string) => void;
  onRun: (label: string, action: PurchasingWrite, after?: () => void) => Promise<boolean>;
}) {
  return (
    <section className="purchasing-form" aria-label="Purchase requests and quotes">
      <section className="purchasing-card" aria-labelledby="purchasing-request-form-title">
        <div className="purchasing-card-head">
          <h2 className="purchasing-card-title" id="purchasing-request-form-title">Raise a purchase request</h2>
        </div>
        <form
          className="purchasing-form"
          onSubmit={(event) => {
            event.preventDefault();
            const estimateMinor = parseMinor("USD", form.estimate || "0") ?? 0;
            void onRun("Purchase request raised", {
              action: "createPurchaseRequest",
              title: form.title.trim(),
              justification: form.justification.trim(),
              ...(estimateMinor > 0 ? { estimatedAmountMinor: estimateMinor } : {}),
            }, () => setForm({ title: "", justification: "", estimate: "" }));
          }}
        >
          <div className="purchasing-form-row">
            <label className="purchasing-field purchasing-field-grow" htmlFor="purchasing-request-title">
              What needs buying
              <input
                id="purchasing-request-title"
                className="purchasing-input"
                placeholder="e.g. Packaging supplies for Q4"
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.currentTarget.value })}
              />
            </label>
            <label className="purchasing-field" htmlFor="purchasing-request-estimate">
              Estimate (optional)
              <input
                id="purchasing-request-estimate"
                className="purchasing-input purchasing-input-narrow"
                inputMode="decimal"
                placeholder="0.00"
                value={form.estimate}
                onChange={(event) => setForm({ ...form, estimate: event.currentTarget.value })}
              />
            </label>
          </div>
          <label className="purchasing-field" htmlFor="purchasing-request-justification">
            Justification
            <textarea
              id="purchasing-request-justification"
              className="purchasing-textarea"
              rows={2}
              placeholder="Justify it for the reviewer: why now, from whom, what changes if it is declined…"
              value={form.justification}
              onChange={(event) => setForm({ ...form, justification: event.currentTarget.value })}
            />
          </label>
          <div className="purchasing-actions">
            <button
              type="submit"
              className="purchasing-button is-primary"
              disabled={busy || form.title.trim().length < 3 || form.justification.trim().length < 10}
            >
              Submit request
            </button>
            <p className="purchasing-inline-note">
              Requests wait for a reviewer. Approved ones go out as RFQs; the winning bid becomes a purchase order.
            </p>
          </div>
        </form>
      </section>

      {requests.length === 0 ? (
        <section className="purchasing-empty" role="status">
          <h2>No purchase requests yet</h2>
          <p>Raise one above, or ask the workmate, to start the request, approval, quotes, and order flow.</p>
        </section>
      ) : requests.map((request) => {
        const picked = rfqPick[request.id] ?? [];
        const draft = quoteDraft;
        return (
          <section className="purchasing-card" key={request.id} aria-labelledby={`purchasing-request-${request.id}`}>
            <div className="purchasing-card-head">
              <h2 className="purchasing-card-title" id={`purchasing-request-${request.id}`}>{request.title}</h2>
              <span className={statusClass(request.status)}>{request.status.replace(/_/g, " ")}</span>
            </div>
            <p className="purchasing-card-hint">{request.justification}</p>
            {request.estimatedAmountMinor != null && (
              <p className="purchasing-inline-note">Estimated {formatMoney(request.estimatedAmountMinor, "USD")}</p>
            )}
            {request.decisionReason && <p className="purchasing-inline-note">Decision: {request.decisionReason}</p>}

            {request.status === "pending_review" && (
              <div className="purchasing-actions">
                <button
                  type="button"
                  className="purchasing-button is-primary"
                  disabled={busy}
                  onClick={() => void onRun("Request approved", { action: "decidePurchaseRequest", requestId: request.id, decision: "approve" })}
                >
                  Approve
                </button>
                {rejectFor === request.id ? (
                  <>
                    <label className="purchasing-field purchasing-field-grow" htmlFor={`purchasing-reject-${request.id}`}>
                      Reason for rejection (optional)
                      <input
                        id={`purchasing-reject-${request.id}`}
                        className="purchasing-input"
                        value={rejectReason}
                        onChange={(event) => setRejectReason(event.currentTarget.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className="purchasing-button is-danger"
                      disabled={busy}
                      onClick={() => {
                        void onRun("Request rejected", {
                          action: "decidePurchaseRequest",
                          requestId: request.id,
                          decision: "reject",
                          ...(rejectReason.trim() ? { reason: rejectReason.trim() } : {}),
                        }, () => {
                          setRejectFor(null);
                          setRejectReason("");
                        });
                      }}
                    >
                      Confirm rejection
                    </button>
                    <button
                      type="button"
                      className="purchasing-button is-quiet"
                      disabled={busy}
                      onClick={() => {
                        setRejectFor(null);
                        setRejectReason("");
                      }}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="purchasing-button is-danger"
                    disabled={busy}
                    onClick={() => {
                      setRejectFor(request.id);
                      setRejectReason("");
                    }}
                  >
                    Reject
                  </button>
                )}
              </div>
            )}

            {request.status === "approved" && (
              <div className="purchasing-form">
                <p className="purchasing-inline-note">Send RFQs to vendors</p>
                {vendors.length === 0 ? (
                  <p className="purchasing-card-hint">No vendors yet. Add them in the Vendors tab first.</p>
                ) : (
                  <>
                    <div className="purchasing-check-list">
                      {vendors.map((vendor) => (
                        <label className="purchasing-check" key={vendor.id}>
                          <input
                            type="checkbox"
                            checked={picked.includes(vendor.id)}
                            onChange={(event) => setRfqPick({
                              ...rfqPick,
                              [request.id]: event.currentTarget.checked
                                ? [...picked, vendor.id]
                                : picked.filter((id) => id !== vendor.id),
                            })}
                          />
                          {vendor.name}
                        </label>
                      ))}
                    </div>
                    <div className="purchasing-actions">
                      <button
                        type="button"
                        className="purchasing-button is-primary"
                        disabled={busy || picked.length === 0}
                        onClick={() => void onRun(`RFQs sent to ${picked.length} vendor${picked.length === 1 ? "" : "s"}`, {
                          action: "createRfq",
                          requestId: request.id,
                          vendorIds: picked,
                        })}
                      >
                        Send RFQs ({picked.length})
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {(request.status === "approved" || request.status === "converted") && request.rfqs.length > 0 && (
              <div className="purchasing-table-wrap">
                <table className="purchasing-table">
                  <caption>Vendor quotes for {request.title}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Vendor</th>
                      <th scope="col">Bid status</th>
                      <th scope="col" className="is-numeric">Quote</th>
                      <th scope="col" className="is-numeric">Lead time</th>
                      <th scope="col" className="is-numeric">Record quote or award</th>
                    </tr>
                  </thead>
                  <tbody>
                    {request.rfqs.map((rfq) => {
                      const entry = draft[rfq.id] ?? { amount: "", leadTime: "" };
                      const quoteMinor = parseMinor("USD", entry.amount || "");
                      return (
                        <tr key={rfq.id}>
                          <th scope="row">{rfq.vendorName}</th>
                          <td><span className={statusClass(rfq.status)}>{rfq.status}</span></td>
                          <td className="is-amount">{rfq.quoteAmountMinor != null ? formatMoney(rfq.quoteAmountMinor, "USD") : "-"}</td>
                          <td className="is-numeric">{rfq.quoteLeadTimeDays != null ? `${rfq.quoteLeadTimeDays}d` : "-"}</td>
                          <td>
                            <div className="purchasing-cell-actions">
                              {rfq.status === "sent" && (
                                <>
                                  <input
                                    className="purchasing-input purchasing-input-narrow"
                                    inputMode="decimal"
                                    placeholder="Quote"
                                    aria-label={`Quote amount from ${rfq.vendorName}`}
                                    value={entry.amount}
                                    onChange={(event) => setQuoteDraft({ ...draft, [rfq.id]: { ...entry, amount: event.currentTarget.value } })}
                                  />
                                  <input
                                    className="purchasing-input purchasing-input-narrow"
                                    inputMode="numeric"
                                    placeholder="Days"
                                    aria-label={`Lead time days from ${rfq.vendorName}`}
                                    value={entry.leadTime}
                                    onChange={(event) => setQuoteDraft({ ...draft, [rfq.id]: { ...entry, leadTime: event.currentTarget.value } })}
                                  />
                                  <button
                                    type="button"
                                    className="purchasing-button is-tiny"
                                    disabled={busy || quoteMinor === null || quoteMinor <= 0}
                                    onClick={() => void onRun(`Quote recorded for ${rfq.vendorName}`, {
                                      action: "recordQuote",
                                      rfqId: rfq.id,
                                      amountMinor: quoteMinor ?? 0,
                                      ...(Number(entry.leadTime) > 0 ? { leadTimeDays: Number(entry.leadTime) } : {}),
                                    }, () => setQuoteDraft({ ...draft, [rfq.id]: { amount: "", leadTime: "" } }))}
                                  >
                                    Save
                                  </button>
                                </>
                              )}
                              {rfq.status === "quoted" && request.status === "approved" && (
                                <button
                                  type="button"
                                  className="purchasing-button is-tiny is-primary"
                                  disabled={busy}
                                  onClick={() => void onRun(`${rfq.vendorName} awarded and purchase order raised`, {
                                    action: "selectWinningQuote",
                                    rfqId: rfq.id,
                                  })}
                                >
                                  Award and raise PO
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {request.rfqs.some((rfq) => rfq.quoteNotes) && (
                  <p className="purchasing-card-foot">
                    {request.rfqs.filter((rfq) => rfq.quoteNotes).map((rfq) => `${rfq.vendorName}: ${rfq.quoteNotes}`).join(" · ")}
                  </p>
                )}
              </div>
            )}
          </section>
        );
      })}
    </section>
  );
}

/* ------------------------------------------------------------------ orders --- */

function OrdersTab({ orders, vendors, products, currency, busy, poForm, setPoForm, quickVendor, setQuickVendor, receipts, setReceipts, onRun, onOpenReturn, onOpenClose }: {
  orders: PurchasingOrder[];
  vendors: PurchasingVendor[];
  products: PurchasingProduct[];
  currency: string;
  busy: boolean;
  poForm: { vendorId: string; memo: string; lines: PoLineDraft[] };
  setPoForm: (form: { vendorId: string; memo: string; lines: PoLineDraft[] }) => void;
  quickVendor: { open: boolean; name: string; email: string };
  setQuickVendor: (state: { open: boolean; name: string; email: string }) => void;
  receipts: Record<string, string>;
  setReceipts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onRun: (label: string, action: PurchasingWrite, after?: () => void) => Promise<boolean>;
  onOpenReturn: (order: PurchasingOrder) => void;
  onOpenClose: (order: PurchasingOrder) => void;
}) {
  const units = currencyMinorUnits(currency) ?? 2;
  const [poError, setPoError] = useState<string | null>(null);

  function updatePoLine(index: number, patch: Partial<PoLineDraft>): void {
    setPoForm({ ...poForm, lines: poForm.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)) });
  }

  return (
    <section className="purchasing-form" aria-label="Purchase orders">
      <section className="purchasing-card" aria-labelledby="purchasing-po-form-title">
        <div className="purchasing-card-head">
          <h2 className="purchasing-card-title" id="purchasing-po-form-title">Draft purchase order</h2>
        </div>
        <form
          className="purchasing-form"
          onSubmit={(event) => {
            event.preventDefault();
            const lines = poForm.lines.map((line) => ({
              description: line.description.trim(),
              quantity: parseThousandths(line.quantity),
              unitPriceMinor: parseMinor(currency, line.unitPrice),
              ...(line.sku.trim() ? { sku: line.sku.trim() } : {}),
            }));
            if (lines.some((line) => !line.description)) {
              setPoError("Add a description for every purchase order line.");
              return;
            }
            if (lines.some((line) => !Number.isSafeInteger(line.quantity) || line.quantity <= 0)) {
              setPoError("Enter a quantity greater than zero for every purchase order line.");
              return;
            }
            if (lines.some((line) => line.unitPriceMinor === null || !Number.isSafeInteger(line.unitPriceMinor) || line.unitPriceMinor < 0)) {
              setPoError("Enter a valid non-negative unit price for every purchase order line.");
              return;
            }
            setPoError(null);
            void onRun("Draft order", {
              action: "createPurchaseOrder",
              vendorId: poForm.vendorId,
              ...(poForm.memo.trim() ? { memo: poForm.memo.trim() } : {}),
              lines: lines.map((line) => ({ ...line, unitPriceMinor: line.unitPriceMinor! })),
            }, () => {
              setPoError(null);
              setPoForm({ vendorId: "", memo: "", lines: [emptyPoLine] });
            });
          }}
        >
          <div className="purchasing-form-row">
            <label className="purchasing-field" htmlFor="purchasing-po-vendor">
              Vendor
              <select
                id="purchasing-po-vendor"
                className="purchasing-select"
                value={poForm.vendorId}
                onChange={(event) => setPoForm({ ...poForm, vendorId: event.currentTarget.value })}
              >
                <option value="">Vendor…</option>
                {vendors.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}
              </select>
            </label>
            <label className="purchasing-field purchasing-field-memo" htmlFor="purchasing-po-memo">
              Memo (optional)
              <input
                id="purchasing-po-memo"
                className="purchasing-input"
                placeholder="Memo"
                value={poForm.memo}
                onChange={(event) => setPoForm({ ...poForm, memo: event.currentTarget.value })}
              />
            </label>
          </div>

          {quickVendor.open && (
            <div className="purchasing-line-row">
              <label className="purchasing-field purchasing-field-grow" htmlFor="purchasing-quick-vendor-name">
                Vendor name
                <input
                  id="purchasing-quick-vendor-name"
                  className="purchasing-input"
                  value={quickVendor.name}
                  onChange={(event) => setQuickVendor({ ...quickVendor, name: event.currentTarget.value })}
                />
              </label>
              <label className="purchasing-field purchasing-field-grow" htmlFor="purchasing-quick-vendor-email">
                Email (optional)
                <input
                  id="purchasing-quick-vendor-email"
                  className="purchasing-input"
                  inputMode="email"
                  value={quickVendor.email}
                  onChange={(event) => setQuickVendor({ ...quickVendor, email: event.currentTarget.value })}
                />
              </label>
              <button
                type="button"
                className="purchasing-button is-primary"
                disabled={busy || !quickVendor.name.trim()}
                onClick={() => void onRun("Vendor created", {
                  action: "createVendor",
                  name: quickVendor.name.trim(),
                  ...(quickVendor.email.trim() ? { email: quickVendor.email.trim() } : {}),
                }, () => setQuickVendor({ open: false, name: "", email: "" }))}
              >
                Save and use
              </button>
            </div>
          )}

          {vendors.length === 0 && !quickVendor.open && (
            <p className="purchasing-inline-note">
              No vendors yet.
              <button
                type="button"
                className="purchasing-link"
                onClick={() => setQuickVendor({ open: true, name: "", email: "" })}
              >
                Create one here.
              </button>
            </p>
          )}

          <div className="purchasing-line-rows">
            {poForm.lines.map((line, index) => (
              <div className="purchasing-line-row" key={index}>
                <label className="purchasing-field purchasing-field-grow" htmlFor={`purchasing-po-product-${index}`}>
                  Stocked product
                  <select
                    id={`purchasing-po-product-${index}`}
                    className="purchasing-select"
                    value={products.some((product) => product.sku === line.sku) ? line.sku : ""}
                    onChange={(event) => {
                      const product = products.find((entry) => entry.sku === event.currentTarget.value);
                      if (!product) return;
                      updatePoLine(index, {
                        description: line.description || product.name,
                        sku: product.sku,
                        unitPrice: product.avgUnitCostMinor != null
                          ? (product.avgUnitCostMinor / (10 ** units)).toFixed(units)
                          : line.unitPrice,
                      });
                    }}
                  >
                    <option value="">{products.length > 0 ? "Product…" : "No products yet"}</option>
                    {products.map((product) => (
                      <option key={product.sku} value={product.sku}>{product.name} · {product.sku}</option>
                    ))}
                  </select>
                </label>
                <label className="purchasing-field purchasing-field-grow" htmlFor={`purchasing-po-description-${index}`}>
                  Description
                  <input
                    id={`purchasing-po-description-${index}`}
                    className="purchasing-input"
                    placeholder={`Line ${index + 1} description`}
                    value={line.description}
                    onChange={(event) => updatePoLine(index, { description: event.currentTarget.value })}
                  />
                </label>
                <label className="purchasing-field" htmlFor={`purchasing-po-quantity-${index}`}>
                  Qty
                  <input
                    id={`purchasing-po-quantity-${index}`}
                    className="purchasing-input purchasing-input-narrow"
                    inputMode="decimal"
                    placeholder="Qty"
                    value={line.quantity}
                    onChange={(event) => updatePoLine(index, { quantity: event.currentTarget.value })}
                  />
                </label>
                <label className="purchasing-field" htmlFor={`purchasing-po-price-${index}`}>
                  Unit price
                  <input
                    id={`purchasing-po-price-${index}`}
                    className="purchasing-input purchasing-input-narrow"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={line.unitPrice}
                    onChange={(event) => updatePoLine(index, { unitPrice: event.currentTarget.value })}
                  />
                </label>
                <label className="purchasing-field" htmlFor={`purchasing-po-sku-${index}`}>
                  SKU (optional)
                  <input
                    id={`purchasing-po-sku-${index}`}
                    className="purchasing-input purchasing-input-wide purchasing-input-mono"
                    placeholder="SKU"
                    title="Links the line to a stocked item so receipts update stock"
                    value={line.sku}
                    onChange={(event) => updatePoLine(index, { sku: event.currentTarget.value.toUpperCase() })}
                  />
                </label>
                <button
                  type="button"
                  className="purchasing-button is-tiny is-danger"
                  aria-label={`Remove line ${index + 1}`}
                  disabled={poForm.lines.length === 1}
                  onClick={() => setPoForm({ ...poForm, lines: poForm.lines.filter((_, i) => i !== index) })}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>

          {poError && <p className="purchasing-inline-error" role="alert">{poError}</p>}
          <div className="purchasing-actions">
            <button
              type="button"
              className="purchasing-button is-quiet"
              onClick={() => setPoForm({ ...poForm, lines: [...poForm.lines, { ...emptyPoLine }] })}
            >
              Add line
            </button>
            <button
              type="submit"
              className="purchasing-button is-primary"
              disabled={busy || !poForm.vendorId || poForm.lines.some((line) => !line.description.trim())}
            >
              Create order
            </button>
            <p className="purchasing-inline-note">Quantities are in whole units. Linking a stocked SKU is what makes a receipt update stock.</p>
          </div>
        </form>
      </section>

      {orders.length === 0 ? (
        <section className="purchasing-empty" role="status">
          <h2>No purchase orders yet</h2>
          <p>Draft one above. Receipts against it feed three-way matching on bills.</p>
        </section>
      ) : orders.map((order) => {
        const receivable = order.status === "ordered" || order.status === "partial";
        return (
          <section className="purchasing-card" key={order.id} aria-labelledby={`purchasing-order-${order.id}`}>
            <div className="purchasing-card-head">
              <h2 className="purchasing-card-title" id={`purchasing-order-${order.id}`}>PO #{order.number} - {order.vendorName}</h2>
              <span className={statusClass(order.status)}>{order.status}</span>
            </div>
            <p className="purchasing-card-hint">
              Ordered {formatMoney(order.orderedMinor, currency)}
              {order.memo ? ` · ${order.memo}` : ""}
            </p>
            <div className="purchasing-table-wrap">
              <table className="purchasing-table">
                <caption>Lines ordered on purchase order {order.number}</caption>
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Description</th>
                    <th scope="col" className="is-numeric">Qty</th>
                    <th scope="col" className="is-numeric">Unit price</th>
                    <th scope="col" className="is-numeric">Receive qty</th>
                  </tr>
                </thead>
                <tbody>
                  {order.lines.map((line) => (
                    <tr key={line.lineNumber}>
                      <td className="is-numeric">{line.lineNumber}</td>
                      <th scope="row">{line.description}</th>
                      <td className="is-numeric">{formatThousandths(line.quantity)}</td>
                      <td className="is-amount">{formatMoney(line.unitPriceMinor, currency)}</td>
                      <td className="is-numeric">
                        {receivable && (
                          <input
                            className="purchasing-input purchasing-input-narrow"
                            inputMode="decimal"
                            placeholder={formatThousandths(line.quantity)}
                            aria-label={`Receive quantity for line ${line.lineNumber} of purchase order ${order.number}`}
                            value={receipts[`${order.id}:${line.lineNumber}`] ?? ""}
                            onChange={(event) => {
                              const value = event.currentTarget.value;
                              setReceipts((current) => ({ ...current, [`${order.id}:${line.lineNumber}`]: value }));
                            }}
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {order.status !== "void" && order.status !== "closed" && (
              <div className="purchasing-actions">
                {(order.status === "received" || order.status === "partial") && (
                  <button type="button" className="purchasing-button is-quiet" disabled={busy} onClick={() => onOpenReturn(order)}>
                    Return goods
                  </button>
                )}
                {receivable && (
                  <>
                    <button type="button" className="purchasing-button is-quiet" disabled={busy} onClick={() => onOpenClose(order)}>
                      Close
                    </button>
                    <button
                      type="button"
                      className="purchasing-button is-primary"
                      disabled={busy}
                      onClick={() => {
                        const lines = aggregateReceiveLines(order.lines.map((line) => ({
                          lineNumber: line.lineNumber,
                          quantity: parseThousandths(receipts[`${order.id}:${line.lineNumber}`] ?? "0"),
                        })));
                        if (lines.length === 0) return;
                        void onRun("Receive goods", { action: "receiveGoods", poNumber: order.number, lines });
                      }}
                    >
                      Record receipt
                    </button>
                    <a className="purchasing-link" href={legacyUrl(`/purchasing/receiving?poNumber=${order.number}`)}>
                      Open the receiving desk
                    </a>
                  </>
                )}
              </div>
            )}
          </section>
        );
      })}
    </section>
  );
}

/* ------------------------------------------------------------------- bills --- */

function BillsTab({ bills, vendors, taxCodes, currency, outstanding, busy, form, setForm, billError, setBillError, payAmount, setPayAmount, onRun, onOpenCredit }: {
  bills: PurchasingBill[];
  vendors: PurchasingVendor[];
  taxCodes: PurchasingTaxCode[];
  currency: string;
  outstanding: number;
  busy: boolean;
  form: { vendorId: string; vendorRef: string; poNumber: string; lines: BillLineDraft[] };
  setForm: (form: { vendorId: string; vendorRef: string; poNumber: string; lines: BillLineDraft[] }) => void;
  billError: string | null;
  setBillError: (message: string | null) => void;
  payAmount: Record<string, string>;
  setPayAmount: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onRun: (label: string, action: PurchasingWrite, after?: () => void) => Promise<boolean>;
  onOpenCredit: (bill: PurchasingBill) => void;
}) {
  const matched = form.poNumber.trim() !== "";
  const built = buildBillLines(form.lines, currency, matched);

  function updateBillLine(index: number, patch: Partial<BillLineDraft>): void {
    setForm({ ...form, lines: form.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)) });
  }

  return (
    <section className="purchasing-form" aria-label="Bills and payments">
      <section className="purchasing-card" aria-labelledby="purchasing-bill-form-title">
        <div className="purchasing-card-head">
          <h2 className="purchasing-card-title" id="purchasing-bill-form-title">Record vendor bill</h2>
        </div>
        <form
          className="purchasing-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (built.lines.some((line) => !Number.isSafeInteger(line.quantity) || line.quantity <= 0)) {
              setBillError("Enter a quantity greater than zero on every bill line.");
              return;
            }
            const parsedPrices = form.lines.map((line) => parseMinor(currency, line.unitPrice.trim() || "0"));
            if (parsedPrices.some((price) => price === null || !Number.isSafeInteger(price) || price < 0)) {
              setBillError("Enter a valid non-negative unit price on every bill line.");
              return;
            }
            if (built.invalid > 0) {
              setBillError(`Three-way matching needs a PO line number on every line. ${built.invalid} line${built.invalid === 1 ? " is" : "s are"} missing one.`);
              return;
            }
            setBillError(null);
            void onRun("Record bill", {
              action: "createBill",
              vendorId: form.vendorId,
              ...(form.vendorRef.trim() ? { vendorRef: form.vendorRef.trim() } : {}),
              ...(matched ? { poNumber: Number(form.poNumber) } : {}),
              lines: built.lines,
            }, () => setForm({ vendorId: "", vendorRef: "", poNumber: "", lines: [emptyBillLine] }));
          }}
        >
          <div className="purchasing-form-row">
            <label className="purchasing-field" htmlFor="purchasing-bill-vendor">
              Vendor
              <select
                id="purchasing-bill-vendor"
                className="purchasing-select"
                value={form.vendorId}
                onChange={(event) => setForm({ ...form, vendorId: event.currentTarget.value })}
              >
                <option value="">Vendor…</option>
                {vendors.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}
              </select>
            </label>
            <label className="purchasing-field" htmlFor="purchasing-bill-ref">
              Their ref
              <input
                id="purchasing-bill-ref"
                className="purchasing-input purchasing-input-wide"
                placeholder="Their ref #"
                value={form.vendorRef}
                onChange={(event) => setForm({ ...form, vendorRef: event.currentTarget.value })}
              />
            </label>
            <label className="purchasing-field" htmlFor="purchasing-bill-po">
              PO number
              <input
                id="purchasing-bill-po"
                className="purchasing-input purchasing-input-narrow"
                inputMode="numeric"
                placeholder="PO # (match)"
                title="When set, every line must reference a PO line number and passes three-way matching"
                value={form.poNumber}
                onChange={(event) => setForm({ ...form, poNumber: digitsOnly(event.currentTarget.value) })}
              />
            </label>
          </div>

          <div className="purchasing-line-rows">
            {form.lines.map((line, index) => (
              <div className="purchasing-line-row" key={index}>
                <label className="purchasing-field purchasing-field-grow" htmlFor={`purchasing-bill-description-${index}`}>
                  Description
                  <input
                    id={`purchasing-bill-description-${index}`}
                    className="purchasing-input"
                    placeholder={`Line ${index + 1} description`}
                    value={line.description}
                    onChange={(event) => updateBillLine(index, { description: event.currentTarget.value })}
                  />
                </label>
                <label className="purchasing-field" htmlFor={`purchasing-bill-quantity-${index}`}>
                  Qty
                  <input
                    id={`purchasing-bill-quantity-${index}`}
                    className="purchasing-input purchasing-input-narrow"
                    inputMode="decimal"
                    placeholder="Qty"
                    value={line.quantity}
                    onChange={(event) => updateBillLine(index, { quantity: event.currentTarget.value })}
                  />
                </label>
                <label className="purchasing-field" htmlFor={`purchasing-bill-price-${index}`}>
                  Unit price
                  <input
                    id={`purchasing-bill-price-${index}`}
                    className="purchasing-input purchasing-input-narrow"
                    inputMode="decimal"
                    placeholder={`0.${"0".repeat(currencyMinorUnits(currency) ?? 2)}`}
                    value={line.unitPrice}
                    onChange={(event) => updateBillLine(index, { unitPrice: event.currentTarget.value })}
                  />
                </label>
                {matched && (
                  <label className="purchasing-field" htmlFor={`purchasing-bill-po-line-${index}`}>
                    PO line #
                    <input
                      id={`purchasing-bill-po-line-${index}`}
                      className="purchasing-input purchasing-input-narrow"
                      inputMode="numeric"
                      placeholder="PO line #"
                      value={line.poLineNumber}
                      onChange={(event) => updateBillLine(index, { poLineNumber: digitsOnly(event.currentTarget.value) })}
                    />
                  </label>
                )}
                {taxCodes.length > 0 && (
                  <label className="purchasing-field" htmlFor={`purchasing-bill-tax-${index}`}>
                    Input tax
                    <select
                      id={`purchasing-bill-tax-${index}`}
                      className="purchasing-select"
                      value={line.taxCodeId}
                      onChange={(event) => updateBillLine(index, { taxCodeId: event.currentTarget.value })}
                    >
                      <option value="">No input tax</option>
                      {taxCodes.map((code) => (
                        <option key={code.id} value={code.id}>
                          {code.code} · {(code.rateBasisPoints / 100).toFixed(2)}%
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <button
                  type="button"
                  className="purchasing-button is-tiny is-danger"
                  aria-label={`Remove bill line ${index + 1}`}
                  disabled={form.lines.length === 1}
                  onClick={() => setForm({ ...form, lines: form.lines.filter((_, i) => i !== index) })}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>

          {billError && <p className="purchasing-inline-error" role="alert">{billError}</p>}

          <div className="purchasing-actions">
            <button
              type="submit"
              className="purchasing-button is-primary"
              disabled={busy || !form.vendorId || form.lines.some((line) => !line.description.trim())}
            >
              Record bill
            </button>
            <button
              type="button"
              className="purchasing-button is-quiet"
              onClick={() => setForm({ ...form, lines: [...form.lines, { ...emptyBillLine }] })}
            >
              Add line
            </button>
            <p className="purchasing-inline-note">
              Bills matched to a purchase order pass three-way matching, ordered against received against billed, before posting.
            </p>
          </div>
        </form>
      </section>

      <section className="purchasing-card" aria-labelledby="purchasing-aging-summary-title">
        <div className="purchasing-card-head">
          <h2 className="purchasing-card-title" id="purchasing-aging-summary-title">Accounts payable aging</h2>
        </div>
        <div className="purchasing-aging-summary">
          <div className="purchasing-aging-total">
            <span>Total outstanding</span>
            <strong>{formatMoney(outstanding, currency)}</strong>
          </div>
          <a className="purchasing-link" href={legacyUrl("/purchasing/ap-aging")}>Open the full aging report</a>
        </div>
      </section>

      <section className="purchasing-card" aria-labelledby="purchasing-payment-runs-title">
        <div className="purchasing-card-head">
          <h2 className="purchasing-card-title" id="purchasing-payment-runs-title">Payment runs</h2>
        </div>
        <p className="purchasing-card-hint">
          Grouped payments and their approvals live in the payment runs report.
        </p>
        <a className="purchasing-link" href={legacyUrl("/purchasing/payment-runs")}>Open payment runs</a>
      </section>

      {bills.length === 0 ? (
        <section className="purchasing-empty" role="status">
          <h2>No bills recorded</h2>
          <p>Record supplier invoices above, optionally matched to a purchase order. They appear here with balances.</p>
        </section>
      ) : (
        <section className="purchasing-card" aria-labelledby="purchasing-bills-title">
          <div className="purchasing-card-head">
            <h2 className="purchasing-card-title" id="purchasing-bills-title">Bills</h2>
          </div>
          <div className="purchasing-table-wrap">
            <table className="purchasing-table">
              <caption>Vendor bills with balances and payment actions</caption>
              <thead>
                <tr>
                  <th scope="col">Bill</th>
                  <th scope="col">Vendor</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="is-numeric">Total</th>
                  <th scope="col" className="is-numeric">Paid</th>
                  <th scope="col" className="is-numeric">Due</th>
                  <th scope="col" className="is-numeric">Pay amount</th>
                </tr>
              </thead>
              <tbody>
                {bills.map((bill) => {
                  const entered = payAmount[String(bill.number)] ?? "";
                  const paymentMinor = entered.trim() === "" ? null : parseMinor(bill.currency, entered);
                  return (
                    <tr key={bill.id}>
                      <td className="is-numeric is-muted">#{bill.number}</td>
                      <th scope="row">{bill.vendorName}</th>
                      <td><span className={statusClass(bill.status)}>{bill.status}</span></td>
                      <td className="is-amount">{formatMoney(bill.totalMinor, bill.currency)}</td>
                      <td className="is-numeric">{formatMoney(bill.paidMinor, bill.currency)}</td>
                      <td className="is-amount">{formatMoney(bill.dueMinor, bill.currency)}</td>
                      <td className="is-numeric">
                        <div className="purchasing-cell-actions">
                          {bill.dueMinor > 0 ? (
                            <>
                              <input
                                className="purchasing-input purchasing-input-narrow"
                                inputMode="decimal"
                                placeholder={majorToInput(bill.dueMinor, bill.currency)}
                                aria-label={`Pay amount for bill ${bill.number}`}
                                value={entered}
                                onChange={(event) => {
                          const value = event.currentTarget.value;
                          setPayAmount((current) => ({ ...current, [String(bill.number)]: value }));
                        }}
                              />
                              <button
                                type="button"
                                className="purchasing-button is-tiny is-primary"
                                disabled={busy || paymentMinor === null || paymentMinor <= 0 || paymentMinor > bill.dueMinor || paymentMinor > 2_147_483_647}
                                onClick={() => void onRun(`Payment on #${bill.number}`, {
                                  action: "payBill",
                                  billNumber: bill.number,
                                  amountMinor: paymentMinor ?? 0,
                                }, () => setPayAmount((current) => ({ ...current, [String(bill.number)]: "" })))}
                              >
                                Pay
                              </button>
                              <button type="button" className="purchasing-button is-tiny is-quiet" disabled={busy} onClick={() => onOpenCredit(bill)}>
                                Credit
                              </button>
                            </>
                          ) : (
                            <span className={statusClass(bill.creditedMinor > 0 ? "settled" : "paid")}>
                              {bill.creditedMinor > 0 ? "settled" : "paid"}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="purchasing-card-foot">
            Payments above the policy threshold are gated and wait in the Approvals inbox.
          </p>
        </section>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- vendors --- */

function VendorsTab({ vendors, orders, bills, currency, busy, form, setForm, selectedVendorId, setSelectedVendorId, onRun }: {
  vendors: PurchasingVendor[];
  orders: PurchasingOrder[];
  bills: PurchasingBill[];
  currency: string;
  busy: boolean;
  form: { name: string; email: string };
  setForm: (form: { name: string; email: string }) => void;
  selectedVendorId: string | null;
  setSelectedVendorId: (id: string | null) => void;
  onRun: (label: string, action: PurchasingWrite, after?: () => void) => Promise<boolean>;
}) {
  return (
    <section className="purchasing-form" aria-label="Vendors">
      <section className="purchasing-card" aria-labelledby="purchasing-vendor-form-title">
        <div className="purchasing-card-head">
          <h2 className="purchasing-card-title" id="purchasing-vendor-form-title">Add vendor</h2>
        </div>
        <form
          className="purchasing-form-row"
          onSubmit={(event) => {
            event.preventDefault();
            void onRun(`Add ${form.name.trim()}`, {
              action: "createVendor",
              name: form.name.trim(),
              ...(form.email.trim() ? { email: form.email.trim() } : {}),
            }, () => setForm({ name: "", email: "" }));
          }}
        >
          <label className="purchasing-field purchasing-field-grow" htmlFor="purchasing-vendor-name">
            Name
            <input
              id="purchasing-vendor-name"
              className="purchasing-input"
              placeholder="Vendor name"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.currentTarget.value })}
            />
          </label>
          <label className="purchasing-field purchasing-field-grow" htmlFor="purchasing-vendor-email">
            Email (optional)
            <input
              id="purchasing-vendor-email"
              className="purchasing-input"
              inputMode="email"
              placeholder="Email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.currentTarget.value })}
            />
          </label>
          <button type="submit" className="purchasing-button is-primary" disabled={busy || !form.name.trim()}>
            Add vendor
          </button>
        </form>
      </section>

      <section className="purchasing-card" aria-labelledby="purchasing-vendors-title">
        <div className="purchasing-card-head">
          <h2 className="purchasing-card-title" id="purchasing-vendors-title">Vendors</h2>
        </div>
        {vendors.length === 0 ? (
          <p className="purchasing-card-hint">No vendors yet. Add the suppliers you buy from; orders and bills reference them.</p>
        ) : (
          <ul className="purchasing-list">
            {vendors.map((vendor) => {
              const vendorOrders = orders.filter((order) => order.vendorName === vendor.name);
              const open = vendorOpenOrders(orders, vendor.name);
              const vendorBills = bills.filter((bill) => bill.vendorName === vendor.name);
              const owed = vendorBills.reduce((sum, bill) => sum + bill.dueMinor, 0);
              const selected = selectedVendorId === vendor.id;
              return (
                <li className="purchasing-list-row" key={vendor.id}>
                  <button
                    type="button"
                    className="purchasing-list-row-button"
                    aria-expanded={selected}
                    onClick={() => setSelectedVendorId(selected ? null : vendor.id)}
                  >
                    <span>
                      <span className="purchasing-list-title">{vendor.name}</span>
                      <span className="purchasing-list-meta">
                        {open.length > 0 ? `${open.length} open order${open.length === 1 ? "" : "s"}` : "no open orders"}
                        {owed > 0 ? ` · ${formatMoney(owed, currency)} owed` : ""}
                      </span>
                    </span>
                    {vendor.email && <span className="purchasing-list-meta">{vendor.email}</span>}
                  </button>
                  {selected && (
                    <div className="purchasing-detail">
                      {vendorOrders.length === 0 && vendorBills.length === 0 ? (
                        <p className="purchasing-detail-empty">No orders or bills with this vendor yet.</p>
                      ) : (
                        <>
                          {vendorOrders.map((order) => (
                            <p className="purchasing-detail-line" key={order.id}>
                              <span>PO {order.number} · {order.status}</span>
                              <span>{formatMoney(order.orderedMinor, currency)}</span>
                            </p>
                          ))}
                          {vendorBills.map((bill) => (
                            <p className="purchasing-detail-line" key={bill.id}>
                              <span>Bill {bill.number} · {bill.status}</span>
                              <span>
                                {formatMoney(bill.totalMinor, bill.currency)}
                                {bill.dueMinor > 0 ? ` (${formatMoney(bill.dueMinor, bill.currency)} outstanding)` : ""}
                              </span>
                            </p>
                          ))}
                          <p>
                            <a className="purchasing-link" href={legacyUrl(`/purchasing/receiving${open[0] ? `?poNumber=${open[0].number}` : ""}`)}>
                              Receive against {open[0] ? `PO ${open[0].number}` : "an order"}
                            </a>
                          </p>
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
}

/* ------------------------------------------------------------------ intel --- */

function IntelTab({ vendors, initialRows, performance, currency }: {
  vendors: PurchasingVendor[];
  initialRows: PurchasingPriceHistoryRow[];
  performance: { vendorId: string; vendorName: string; orders: number; avgLeadTimeDays: number | null; onTimeRate: number | null; fillRate: number | null; backorderedOrders: number }[];
  currency: string;
}) {
  const [rows, setRows] = useState(initialRows);
  const [sku, setSku] = useState("");
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [vendorId, setVendorId] = useState("");
  const [statement, setStatement] = useState<PurchasingSupplierStatement | null>(null);
  const [statementBusy, setStatementBusy] = useState(false);
  const [statementError, setStatementError] = useState<string | null>(null);

  async function loadHistory(event: FormEvent): Promise<void> {
    event.preventDefault();
    setHistoryBusy(true);
    setHistoryError(null);
    try {
      setRows(await fetchPurchasingPriceHistory(sku.trim() || undefined));
    } catch (error) {
      setHistoryError(error instanceof PurchasingApiError ? error.message : "Could not load price history.");
    } finally {
      setHistoryBusy(false);
    }
  }

  async function loadStatement(): Promise<void> {
    if (!vendorId) return;
    setStatementBusy(true);
    setStatementError(null);
    try {
      setStatement(await fetchPurchasingSupplierStatement(vendorId));
    } catch (error) {
      setStatementError(error instanceof PurchasingApiError ? error.message : "Could not load the statement.");
    } finally {
      setStatementBusy(false);
    }
  }

  return (
    <section className="purchasing-form" aria-label="Prices and statements">
      <section className="purchasing-card" aria-labelledby="purchasing-price-history-title">
        <div className="purchasing-card-head">
          <h2 className="purchasing-card-title" id="purchasing-price-history-title">Supplier price history</h2>
          <form className="purchasing-form-row" onSubmit={(event) => void loadHistory(event)}>
            <label className="purchasing-field" htmlFor="purchasing-price-sku">
              Filter by SKU
              <input
                id="purchasing-price-sku"
                className="purchasing-input purchasing-input-wide purchasing-input-mono"
                value={sku}
                onChange={(event) => setSku(event.currentTarget.value)}
              />
            </label>
            <button type="submit" className="purchasing-button is-quiet" disabled={historyBusy}>
              {historyBusy ? "Loading…" : "Apply"}
            </button>
          </form>
        </div>
        {historyError ? (
          <p className="purchasing-inline-error" role="alert">{historyError}</p>
        ) : rows.length === 0 ? (
          <p className="purchasing-card-hint">No purchase prices recorded. Prices fill in as purchase orders are raised.</p>
        ) : (
          <div className="purchasing-table-wrap">
            <table className="purchasing-table">
              <caption>What each vendor charged per item, most recent first</caption>
              <thead>
                <tr>
                  <th scope="col">Vendor</th>
                  <th scope="col">Item</th>
                  <th scope="col">SKU</th>
                  <th scope="col" className="is-numeric">Unit price</th>
                  <th scope="col" className="is-numeric">Last ordered</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={`${row.vendorName}-${row.itemDescription}-${index}`}>
                    <th scope="row">{row.vendorName}</th>
                    <td className="is-muted">{row.itemDescription}</td>
                    <td className="purchasing-input-mono is-muted">{row.itemSku ?? "-"}</td>
                    <td className="is-amount">{formatMoney(row.unitPriceMinor, currency)}</td>
                    <td className="is-numeric is-muted">{row.orderedAt ? timeAgo(row.orderedAt) : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="purchasing-card" aria-labelledby="purchasing-performance-title">
        <div className="purchasing-card-head">
          <h2 className="purchasing-card-title" id="purchasing-performance-title">Supplier performance</h2>
        </div>
        {performance.length === 0 ? (
          <p className="purchasing-card-hint">No vendor history yet. Lead times, fill rates, and on-time arrivals appear once orders are received.</p>
        ) : (
          <div className="purchasing-table-wrap">
            <table className="purchasing-table">
              <caption>Lead time, on-time arrival, and fill rate by supplier</caption>
              <thead>
                <tr>
                  <th scope="col">Vendor</th>
                  <th scope="col" className="is-numeric">Orders</th>
                  <th scope="col" className="is-numeric">Avg lead time</th>
                  <th scope="col" className="is-numeric">On-time</th>
                  <th scope="col" className="is-numeric">Fill rate</th>
                  <th scope="col" className="is-numeric">Backordered</th>
                </tr>
              </thead>
              <tbody>
                {performance.map((row) => (
                  <tr key={row.vendorId}>
                    <th scope="row">{row.vendorName}</th>
                    <td className="is-numeric">{row.orders}</td>
                    <td className="is-numeric">{row.avgLeadTimeDays === null ? "-" : `${row.avgLeadTimeDays} d`}</td>
                    <td className="is-numeric">{row.onTimeRate === null ? "-" : `${row.onTimeRate}%`}</td>
                    <td className="is-numeric">{row.fillRate === null ? "-" : `${row.fillRate}%`}</td>
                    <td className="is-numeric">{row.backorderedOrders}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="purchasing-card-foot">Lead time is order to first receipt. On-time needs a promised date on the order.</p>
      </section>

      <section className="purchasing-card" aria-labelledby="purchasing-statement-title">
        <div className="purchasing-card-head">
          <h2 className="purchasing-card-title" id="purchasing-statement-title">Supplier statement</h2>
        </div>
        {vendors.length === 0 ? (
          <p className="purchasing-card-hint">No vendors yet. Add a vendor first; statements build from bills, payments, and credits.</p>
        ) : (
          <>
            <div className="purchasing-form-row">
              <label className="purchasing-field" htmlFor="purchasing-statement-vendor">
                Vendor
                <select
                  id="purchasing-statement-vendor"
                  className="purchasing-select"
                  value={vendorId}
                  onChange={(event) => setVendorId(event.currentTarget.value)}
                >
                  <option value="">Vendor…</option>
                  {vendors.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}
                </select>
              </label>
              <button type="button" className="purchasing-button is-primary" disabled={!vendorId || statementBusy} onClick={() => void loadStatement()}>
                {statementBusy ? "Loading…" : "Load statement"}
              </button>
            </div>
            {statementError && <p className="purchasing-inline-error" role="alert">{statementError}</p>}
            {statement && statement.rows.length === 0 && (
              <p className="purchasing-card-hint">No activity with this vendor yet.</p>
            )}
            {statement && statement.rows.length > 0 && (
              <>
                <div className="purchasing-table-wrap">
                  <table className="purchasing-table">
                    <caption>Running balance of bills, payments, and credits for this vendor</caption>
                    <thead>
                      <tr>
                        <th scope="col">Date</th>
                        <th scope="col">Kind</th>
                        <th scope="col">Ref</th>
                        <th scope="col" className="is-numeric">Amount</th>
                        <th scope="col" className="is-numeric">Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statement.rows.map((row, index) => (
                        <tr key={`${row.ref}-${index}`}>
                          <td className="is-muted">{formatDate(row.date)}</td>
                          <td><span className={statusClass(row.kind === "bill" ? "" : "paid")}>{row.kind}</span></td>
                          <td className="is-muted">{row.ref}</td>
                          <td className={row.amountMinor < 0 ? "is-numeric is-credit" : "is-numeric"}>{formatMoney(row.amountMinor, currency)}</td>
                          <td className="is-amount">{formatMoney(row.balanceMinor, currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="purchasing-card-foot">
                  Closing balance {formatMoney(statement.closingBalanceMinor, currency)}. Reconcile this against the statement the vendor sends at month end.
                </p>
              </>
            )}
          </>
        )}
      </section>
    </section>
  );
}
