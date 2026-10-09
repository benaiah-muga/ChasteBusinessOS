import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { currencyMinorUnits } from "@chaste/erp-core";
import { confirmSalesOrder, fetchSalesEnabled, fetchSalesOrders, restorePendingSalesOrderCreate, SalesApiError, submitSalesOrderWrite, type SalesOrder } from "../api/sales";
import { CrmApiError, fetchCrmCustomers, type CrmCustomer } from "../api/crm";
import { legacyUrl } from "../legacy";
import "./sales-page.css";

type PageState =
  | { status: "loading" }
  | { status: "disabled" }
  | { status: "failed"; error: SalesApiError }
  | { status: "ready"; orders: SalesOrder[]; customers: CrmCustomer[] };

type CurrencyStyle = { symbol: string; minorUnits: number };
type OrderFilter = "all" | "draft" | "confirmed" | "delivered" | "cancelled";
type OrderDraftLine = { sku: string; description: string; quantity: string; unitPrice: string; tax: string };
type OrderActionTarget = { action: "deliver" | "cancel"; order: SalesOrder };
const emptyOrderDraftLine = (): OrderDraftLine => ({ sku: "", description: "", quantity: "1", unitPrice: "0", tax: "0" });
const ORDER_FILTERS: { value: OrderFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "confirmed", label: "Confirmed" },
  { value: "delivered", label: "Delivered" },
  { value: "cancelled", label: "Cancelled" },
];
const CURRENCY_PREFERENCES = ["org", "USD", "KES", "EUR", "GBP", "TZS", "UGX"];
const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$", KES: "KSh", EUR: "€", GBP: "£", TZS: "TSh", UGX: "USh" };

function currencyFor(baseCurrency: string | null): CurrencyStyle {
  let preference: string | null = null;
  try {
    const cookie = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("chaste_display_currency="));
    if (cookie) {
      const value = decodeURIComponent(cookie.slice("chaste_display_currency=".length));
      if (CURRENCY_PREFERENCES.includes(value)) preference = value;
    }
  } catch { /* A blocked cookie leaves the device preference available. */ }
  if (!preference) {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem("chaste-prefs") ?? "null");
      if (stored && typeof stored === "object" && "currency" in stored && typeof stored.currency === "string" && CURRENCY_PREFERENCES.includes(stored.currency)) preference = stored.currency;
    } catch { /* Invalid local preferences fall back to the active organization. */ }
  }
  const code = !preference || preference === "org" ? baseCurrency ?? "USD" : preference;
  let symbol = CURRENCY_SYMBOLS[code];
  if (!symbol) {
    try {
      symbol = new Intl.NumberFormat("en-US", { style: "currency", currency: code }).formatToParts(0).find((part) => part.type === "currency")?.value;
    } catch {
      symbol = `${code} `;
    }
  }
  return { symbol: symbol ?? `${code} `, minorUnits: currencyMinorUnits(code) ?? 2 };
}

function formatMoney(minor: number, currency: CurrencyStyle): string {
  const amount = Math.abs(minor) / (10 ** currency.minorUnits);
  const formatted = amount.toLocaleString("en-US", {
    minimumFractionDigits: currency.minorUnits,
    maximumFractionDigits: currency.minorUnits,
  });
  return `${minor < 0 ? "−" : ""}${currency.symbol}${formatted}`;
}

function formatStatus(status: string): string {
  return status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function minorFromInput(value: string, minorUnits: number): number | null {
  const parsed = Number(value.trim() || "0");
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  const minor = Math.round(parsed * (10 ** minorUnits));
  return Number.isSafeInteger(minor) ? minor : null;
}

function quantityFromInput(value: string): number | null {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const thousandths = Math.round(parsed * 1000);
  return Number.isSafeInteger(thousandths) && thousandths > 0 ? thousandths : null;
}

function savedConfirmIntent(orderId: string): string | null {
  try {
    const value = sessionStorage.getItem(`chaste:sales-confirm-intent:${orderId}`);
    return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
  } catch {
    return null;
  }
}

function savedAllowBackorder(orderId: string): boolean {
  try {
    return sessionStorage.getItem(`chaste:sales-confirm-backorder:${orderId}`) === "1";
  } catch {
    return false;
  }
}

function persistConfirmIntent(orderId: string, intentId: string, pending: boolean, allowBackorder: boolean) {
  try {
    sessionStorage.setItem(`chaste:sales-confirm-intent:${orderId}`, intentId);
    sessionStorage.setItem(`chaste:sales-confirm-pending:${orderId}`, pending ? "1" : "0");
    sessionStorage.setItem(`chaste:sales-confirm-backorder:${orderId}`, allowBackorder ? "1" : "0");
  } catch { /* In-memory intent reuse still protects retries for this page. */ }
}

function clearConfirmIntent(orderId: string) {
  try {
    sessionStorage.removeItem(`chaste:sales-confirm-intent:${orderId}`);
    sessionStorage.removeItem(`chaste:sales-confirm-pending:${orderId}`);
    sessionStorage.removeItem(`chaste:sales-confirm-backorder:${orderId}`);
  } catch { /* The server remains the source of truth for the action result. */ }
}

function hasSavedPendingApproval(orderId: string): boolean {
  try {
    return sessionStorage.getItem(`chaste:sales-confirm-pending:${orderId}`) === "1";
  } catch {
    return false;
  }
}

export function SalesPage({ baseCurrency = null, actorId = null, organizationId = null }: { baseCurrency?: string | null; actorId?: string | null; organizationId?: string | null }) {
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<OrderFilter>("all");
  const [confirmingOrderId, setConfirmingOrderId] = useState<string | null>(null);
  const [approvalWaitingOrderIds, setApprovalWaitingOrderIds] = useState<Set<string>>(() => new Set());
  const [allowBackorder, setAllowBackorder] = useState<Record<string, boolean>>({});
  const [actionNotice, setActionNotice] = useState<{ tone: "success" | "pending" | "error"; message: string } | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createForm, setCreateForm] = useState({ customerId: "", note: "", lines: [emptyOrderDraftLine()] });
  const [createError, setCreateError] = useState<string | null>(null);
  const [writeBusy, setWriteBusy] = useState(false);
  const [createAttemptPending, setCreateAttemptPending] = useState(false);
  const [createAttemptRestoredScope, setCreateAttemptRestoredScope] = useState<string | null>(null);
  const [orderActionTarget, setOrderActionTarget] = useState<OrderActionTarget | null>(null);
  const confirmIntents = useRef(new Map<string, string>());
  const previousCreateScope = useRef<string | null>(null);
  const currentCreateScope = useRef<string | null>(null);
  const confirmationScope = useRef<string | null>(null);
  const confirmationGeneration = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const currency = useMemo(() => currencyFor(baseCurrency), [baseCurrency]);
  const createScopeIdentity = actorId?.trim() && organizationId?.trim()
    ? JSON.stringify([actorId.trim(), organizationId.trim()])
    : null;
  currentCreateScope.current = createScopeIdentity;
  if (confirmationScope.current !== createScopeIdentity) {
    confirmationScope.current = createScopeIdentity;
    confirmationGeneration.current += 1;
  }
  const createScopeReady = createScopeIdentity !== null && createAttemptRestoredScope === createScopeIdentity;
  const createWriteLocked = !createScopeReady || createAttemptPending;

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ status: "loading" });
    try {
      const enabled = await fetchSalesEnabled(signal);
      if (signal?.aborted) return;
      if (!enabled) {
        setState({ status: "disabled" });
        return;
      }
      const [orders, customers] = await Promise.all([fetchSalesOrders(signal), fetchCrmCustomers(signal)]);
      if (!signal?.aborted) setState({ status: "ready", orders, customers });
    } catch (error) {
      if (signal?.aborted) return;
      setState({
        status: "failed",
        error: error instanceof SalesApiError
          ? error
          : error instanceof CrmApiError
            ? new SalesApiError(error.status, error.message)
          : new SalesApiError(0, "Could not reach the sales service. Check your connection and try again."),
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [createScopeIdentity, load]);

  useEffect(() => {
    let current = true;
    const scopeChanged = previousCreateScope.current !== createScopeIdentity;
    previousCreateScope.current = createScopeIdentity;
    setCreateAttemptRestoredScope(null);
    setCreateAttemptPending(false);
    if (scopeChanged) {
      setWriteBusy(false);
      setConfirmingOrderId(null);
      setApprovalWaitingOrderIds(new Set());
      setAllowBackorder({});
      confirmIntents.current.clear();
      setCreateForm({ customerId: "", note: "", lines: [emptyOrderDraftLine()] });
      setShowCreateForm(false);
      setCreateError(null);
      setOrderActionTarget(null);
      setActionNotice(null);
    }
    if (!actorId || !organizationId || !createScopeIdentity) return () => { current = false; };
    void restorePendingSalesOrderCreate({ actorId, organizationId }).then((action) => {
      if (!current) return;
      setCreateAttemptRestoredScope(createScopeIdentity);
      if (!action) return;
      setCreateForm({
        customerId: action.customerId,
        note: action.note ?? "",
        lines: action.lines.map((line) => ({
          sku: line.sku ?? "",
          description: line.description,
          quantity: String(line.quantity / 1000),
          unitPrice: String(line.unitPriceMinor / (10 ** currency.minorUnits)),
          tax: String((line.taxMinor ?? 0) / (10 ** currency.minorUnits)),
        })),
      });
      setShowCreateForm(true);
      setCreateAttemptPending(true);
      setActionNotice({ tone: "pending", message: "An earlier sales order submission is unresolved. Retry the restored draft to check its result." });
    }).catch((error: unknown) => {
      if (!current) return;
      setCreateAttemptPending(true);
      setShowCreateForm(true);
      setActionNotice({ tone: "error", message: error instanceof SalesApiError ? error.message : "The saved sales order draft could not be restored." });
    });
    return () => { current = false; };
  }, [actorId, createScopeIdentity, currency.minorUnits, organizationId]);

  useEffect(() => {
    function onShortcut(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select"))) return;
      if (state.status !== "ready" || state.orders.length === 0) return;
      event.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [state]);

  const customerNames = useMemo(() => state.status === "ready"
    ? new Map(state.customers.map((customer) => [customer.id, customer.name]))
    : new Map<string, string>(), [state]);

  const filtered = useMemo(() => {
    if (state.status !== "ready") return [];
    const query = search.trim().toLocaleLowerCase();
    return state.orders.filter((order) => {
      if (filter !== "all" && order.status !== filter) return false;
      if (!query) return true;
      return [`#${order.number}`, customerNames.get(order.customerId) ?? "Unknown customer", order.status]
        .some((value) => value.toLocaleLowerCase().includes(query));
    });
  }, [customerNames, filter, search, state]);

  async function handleConfirm(order: SalesOrder) {
    const submittedScope = createScopeIdentity;
    const submittedGeneration = confirmationGeneration.current;
    const isCurrentScope = () => currentCreateScope.current === submittedScope
      && confirmationGeneration.current === submittedGeneration;
    const checkingApproval = approvalWaitingOrderIds.has(order.id) || hasSavedPendingApproval(order.id);
    if (!checkingApproval && !window.confirm(`Confirm order #${order.number}?`)) return;
    const intentId = confirmIntents.current.get(order.id) ?? savedConfirmIntent(order.id) ?? crypto.randomUUID();
    confirmIntents.current.set(order.id, intentId);
    const backorderChoice = allowBackorder[order.id] ?? savedAllowBackorder(order.id);
    persistConfirmIntent(order.id, intentId, checkingApproval, backorderChoice);
    setConfirmingOrderId(order.id);
    setActionNotice(null);
    try {
      const result = await confirmSalesOrder(order.id, intentId, backorderChoice);
      if (!isCurrentScope()) return;
      if (result.kind === "pending") {
        persistConfirmIntent(order.id, intentId, true, backorderChoice);
        setApprovalWaitingOrderIds((current) => new Set(current).add(order.id));
        setActionNotice({ tone: "pending", message: result.reason });
        return;
      }
      confirmIntents.current.delete(order.id);
      clearConfirmIntent(order.id);
      setApprovalWaitingOrderIds((current) => {
        const next = new Set(current);
        next.delete(order.id);
        return next;
      });
      setState((current) => current.status !== "ready" ? current : {
        ...current,
        orders: current.orders.map((candidate) => candidate.id === order.id
          ? { ...candidate, status: "confirmed", backordered: result.backordered }
          : candidate),
      });
      setActionNotice({ tone: "success", message: `Order #${order.number} confirmed.` });
    } catch (error) {
      if (!isCurrentScope()) return;
      if (error instanceof SalesApiError && error.status === 422) {
        confirmIntents.current.delete(order.id);
        clearConfirmIntent(order.id);
        setApprovalWaitingOrderIds((current) => {
          const next = new Set(current);
          next.delete(order.id);
          return next;
        });
      }
      setActionNotice({
        tone: "error",
        message: error instanceof SalesApiError ? error.message : "The order confirmation could not be completed.",
      });
    } finally {
      if (isCurrentScope()) setConfirmingOrderId(null);
    }
  }

  async function refreshOrderList(expectedScope?: string): Promise<void> {
    try {
      const orders = await fetchSalesOrders();
      if (expectedScope !== undefined && currentCreateScope.current !== expectedScope) return;
      setState((current) => current.status === "ready" ? { ...current, orders } : current);
    } catch {
      if (expectedScope !== undefined && currentCreateScope.current !== expectedScope) return;
      setActionNotice((current) => current ?? { tone: "error", message: "The action completed, but the order list could not refresh." });
    }
  }

  async function handleCreateOrder(): Promise<void> {
    if (!createScopeReady) return;
    const submittedScope = createScopeIdentity;
    const described = createForm.lines.filter((line) => line.description.trim().length > 0);
    if (!createForm.customerId || described.length === 0) {
      setCreateError("Choose a customer and add at least one described line item.");
      return;
    }
    const lines = [] as Array<{ sku?: string; description: string; quantity: number; unitPriceMinor: number; taxMinor: number }>;
    for (const line of described) {
      const quantity = quantityFromInput(line.quantity);
      const unitPriceMinor = minorFromInput(line.unitPrice, currency.minorUnits);
      const taxMinor = minorFromInput(line.tax, currency.minorUnits);
      if (quantity === null || unitPriceMinor === null || taxMinor === null) {
        setCreateError("Each line needs a positive quantity and non-negative price and tax.");
        return;
      }
      lines.push({
        description: line.description.trim(), quantity, unitPriceMinor, taxMinor,
        ...(line.sku.trim() ? { sku: line.sku.trim() } : {}),
      });
    }
    if (createForm.note.length > 4000) {
      setCreateError("Keep the order note under 4,000 characters.");
      return;
    }
    setWriteBusy(true);
    setCreateAttemptPending(true);
    setCreateError(null);
    setActionNotice(null);
    try {
      const result = await submitSalesOrderWrite({
        action: "create", customerId: createForm.customerId,
        ...(createForm.note.trim() ? { note: createForm.note.trim() } : {}), lines,
      }, { actorId, organizationId });
      if (currentCreateScope.current !== submittedScope) return;
      if (result.kind === "pending") {
        setCreateAttemptPending(true);
        setActionNotice({ tone: "pending", message: result.reason });
        return;
      }
      setCreateAttemptPending(false);
      setCreateForm({ customerId: "", note: "", lines: [emptyOrderDraftLine()] });
      setShowCreateForm(false);
      setActionNotice({ tone: "success", message: "Sales order created as a draft." });
      await refreshOrderList(submittedScope);
    } catch (error) {
      if (currentCreateScope.current !== submittedScope) return;
      if (error instanceof SalesApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
        setCreateAttemptPending(false);
      }
      setActionNotice({ tone: "error", message: error instanceof SalesApiError ? error.message : "The sales order could not be created." });
    } finally {
      if (currentCreateScope.current === submittedScope) setWriteBusy(false);
    }
  }

  async function handleOrderAction(): Promise<void> {
    if (!orderActionTarget || !createScopeReady || !createScopeIdentity) return;
    const target = orderActionTarget;
    const submittedScope = createScopeIdentity;
    setWriteBusy(true);
    setActionNotice(null);
    try {
      const result = await submitSalesOrderWrite({ action: target.action, orderId: target.order.id }, { actorId, organizationId });
      if (currentCreateScope.current !== submittedScope) return;
      if (result.kind === "pending") {
        setActionNotice({ tone: "pending", message: result.reason });
        return;
      }
      const nextStatus = result.action === "cancel" ? "cancelled"
        : result.action === "deliver" ? result.data.orderStatus : target.order.status;
      setOrderActionTarget(null);
      setState((current) => current.status !== "ready" ? current : {
        ...current,
        orders: current.orders.map((order) => order.id === target.order.id
          ? { ...order, status: nextStatus }
          : order),
      });
      setActionNotice({
        tone: "success",
        message: result.action === "cancel"
          ? `Order #${target.order.number} cancelled.`
          : result.action === "deliver" && result.data.orderStatus === "delivered"
            ? `Order #${target.order.number} fully delivered and invoiced.`
            : result.action === "deliver"
              ? `Reserved quantities delivered and invoiced for order #${target.order.number}. The order remains confirmed.`
              : `Order #${target.order.number} updated.`,
      });
      await refreshOrderList(submittedScope);
    } catch (error) {
      if (currentCreateScope.current !== submittedScope) return;
      setActionNotice({ tone: "error", message: error instanceof SalesApiError ? error.message : "The sales order action could not be completed." });
    } finally {
      if (currentCreateScope.current === submittedScope) setWriteBusy(false);
    }
  }

  return (
    <main className="sales-page">
      <header className="sales-page-header">
        <div>
          <p className="sales-eyebrow">Revenue · preview</p>
          <h1 id="sales-title">Sales orders</h1>
          <p>Review orders, create drafts, and deliver or cancel confirmed orders. Use the full workspace for quotes and advanced workflows.</p>
        </div>
        <div className="sales-header-actions">
          {state.status === "ready" && <span className="sales-order-count">{state.orders.length} {state.orders.length === 1 ? "order" : "orders"}</span>}
          <button className="sales-new-order" type="button" disabled={createAttemptPending} onClick={() => { setShowCreateForm((open) => !open); setCreateError(null); }} aria-expanded={showCreateForm}>
            {showCreateForm ? "Close order form" : "Create sales order"}
          </button>
          <a className="sales-full-workspace" href={legacyUrl("/sales")}>Open full sales workspace</a>
        </div>
      </header>

      {actionNotice && <p className={`sales-action-notice sales-action-notice-${actionNotice.tone}`} role={actionNotice.tone === "error" ? "alert" : "status"}>{actionNotice.message}</p>}

      {showCreateForm && state.status === "ready" && (
        <section className="sales-write-card" aria-labelledby="sales-create-title">
          <div className="sales-write-heading">
            <div><p className="sales-eyebrow">New draft</p><h2 id="sales-create-title">Create sales order</h2></div>
            <p>Prices and tax use {baseCurrency ?? "the workspace currency"}. A non-empty SKU links the line to inventory.</p>
          </div>
          <div className="sales-write-grid">
            <label>Customer
              <select value={createForm.customerId} onChange={(event) => { const value = event.currentTarget.value; setCreateForm((current) => ({ ...current, customerId: value })); setCreateError(null); }} disabled={writeBusy || createWriteLocked}>
                <option value="">Choose a customer</option>
                {state.customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
              </select>
            </label>
            <label>Order note
              <input value={createForm.note} maxLength={4000} onChange={(event) => { const value = event.currentTarget.value; setCreateForm((current) => ({ ...current, note: value })); setCreateError(null); }} disabled={writeBusy || createWriteLocked} />
            </label>
          </div>
          <div className="sales-write-lines">
            <h3>Line items</h3>
            {createForm.lines.map((line, index) => (
              <div className="sales-write-line" key={index}>
                <label>SKU (optional)<input value={line.sku} onChange={(event) => { const value = event.currentTarget.value; setCreateForm((current) => ({ ...current, lines: current.lines.map((item, itemIndex) => itemIndex === index ? { ...item, sku: value } : item) })); }} disabled={writeBusy || createWriteLocked} /></label>
                <label>Description<input value={line.description} onChange={(event) => { const value = event.currentTarget.value; setCreateForm((current) => ({ ...current, lines: current.lines.map((item, itemIndex) => itemIndex === index ? { ...item, description: value } : item) })); setCreateError(null); }} disabled={writeBusy || createWriteLocked} /></label>
                <label>Quantity<input inputMode="decimal" value={line.quantity} onChange={(event) => { const value = event.currentTarget.value; setCreateForm((current) => ({ ...current, lines: current.lines.map((item, itemIndex) => itemIndex === index ? { ...item, quantity: value } : item) })); }} disabled={writeBusy || createWriteLocked} /></label>
                <label>Unit price<input inputMode="decimal" value={line.unitPrice} onChange={(event) => { const value = event.currentTarget.value; setCreateForm((current) => ({ ...current, lines: current.lines.map((item, itemIndex) => itemIndex === index ? { ...item, unitPrice: value } : item) })); }} disabled={writeBusy || createWriteLocked} /></label>
                <label>Tax<input inputMode="decimal" value={line.tax} onChange={(event) => { const value = event.currentTarget.value; setCreateForm((current) => ({ ...current, lines: current.lines.map((item, itemIndex) => itemIndex === index ? { ...item, tax: value } : item) })); }} disabled={writeBusy || createWriteLocked} /></label>
                <button type="button" className="sales-write-remove" disabled={writeBusy || createWriteLocked || createForm.lines.length === 1} aria-label={`Remove line ${index + 1}`} onClick={() => setCreateForm((current) => ({ ...current, lines: current.lines.filter((_, itemIndex) => itemIndex !== index) }))}>Remove</button>
              </div>
            ))}
            <div className="sales-write-actions">
              <button type="button" className="sales-write-secondary" disabled={writeBusy || createWriteLocked} onClick={() => setCreateForm((current) => ({ ...current, lines: [...current.lines, emptyOrderDraftLine()] }))}>Add line</button>
              <button type="button" className="sales-write-primary" disabled={writeBusy || !createScopeReady} onClick={() => void handleCreateOrder()}>{writeBusy ? "Saving…" : "Create draft"}</button>
            </div>
            {createError && <p className="sales-write-error" role="alert">{createError}</p>}
          </div>
        </section>
      )}

      {state.status === "ready" && state.orders.length > 0 && (
        <div className="sales-order-tools">
          <div className="sales-order-filters" role="group" aria-label="Filter orders by status">
            {ORDER_FILTERS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={filter === option.value}
                onClick={() => setFilter(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <label className="sales-search">
            <span>Find an order</span>
            <input
              ref={searchRef}
              type="search"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              placeholder="Order number, customer, or status"
            />
          </label>
          <span className="sales-search-hint">Press / to search</span>
        </div>
      )}

      {state.status === "loading" && <p className="sales-loading" role="status">Loading sales orders…</p>}
      {state.status === "disabled" && (
        <section className="sales-empty" role="status">
          <span aria-hidden="true">↗</span>
          <h2>Sales is turned off</h2>
          <p>Ask a workspace administrator to enable the Sales module before viewing orders.</p>
        </section>
      )}
      {state.status === "failed" && (
        <section className="sales-error" role="alert" aria-labelledby="sales-error-title">
          <div>
            <p className="sales-eyebrow">Sales unavailable</p>
            <h2 id="sales-error-title">{state.error.status === 403 || state.error.message.startsWith("forbidden:") ? "Access denied" : "Could not load sales orders"}</h2>
            <p>{state.error.message}</p>
          </div>
          <div className="sales-error-actions">
            {state.error.status === 401 && <a href="/login">Sign in again</a>}
            <button type="button" onClick={() => void load()}>Try again</button>
          </div>
        </section>
      )}
      {state.status === "ready" && state.orders.length === 0 && (
        <section className="sales-empty" role="status">
          <span aria-hidden="true">↗</span>
          <h2>No sales orders yet</h2>
          <p>Create a draft order, then confirm it to check credit and reserve stock.</p>
        </section>
      )}
      {state.status === "ready" && state.orders.length > 0 && filtered.length === 0 && (
        <section className="sales-empty" role="status">
          <span aria-hidden="true">⌕</span>
          <h2>No orders match</h2>
          <p>Try another order number, customer, or status.</p>
        </section>
      )}
      {state.status === "ready" && filtered.length > 0 && (
        <section className="sales-table-card" aria-label="Sales orders">
          <div className="sales-table-scroll">
            <table className="sales-table">
              <thead><tr><th scope="col">Order</th><th scope="col">Customer</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col">Total</th><th scope="col">Actions</th></tr></thead>
              <tbody>{filtered.map((order) => (
                <tr key={order.id}>
                  <th scope="row">#{order.number}</th>
                  <td><span className="sales-customer-id">{customerNames.get(order.customerId) ?? "Unknown customer"}</span>{order.backordered && <span className="sales-backorder">Backordered</span>}</td>
                  <td><span className="sales-status">{formatStatus(order.status)}</span></td>
                  <td><time dateTime={order.createdAt}>{new Date(order.createdAt).toLocaleDateString()}</time></td>
                  <td className="sales-total">{formatMoney(order.totalMinor, currency)}</td>
                  <td>{order.status === "draft" && <>
                    <label>
                      <input
                        type="checkbox"
                        checked={allowBackorder[order.id] ?? savedAllowBackorder(order.id)}
                        onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          setAllowBackorder((current) => ({ ...current, [order.id]: checked }));
                        }}
                        disabled={confirmingOrderId === order.id || approvalWaitingOrderIds.has(order.id) || hasSavedPendingApproval(order.id) || savedConfirmIntent(order.id) !== null || confirmIntents.current.has(order.id)}
                      />
                      Allow backorder
                    </label>
                    <button type="button" disabled={confirmingOrderId !== null} onClick={() => void handleConfirm(order)}>{confirmingOrderId === order.id ? "Checking…" : approvalWaitingOrderIds.has(order.id) || hasSavedPendingApproval(order.id) ? `Check approval #${order.number}` : `Confirm #${order.number}`}</button>
                    <button type="button" className="sales-row-action" disabled={writeBusy || !createScopeReady || confirmingOrderId !== null} onClick={() => setOrderActionTarget({ action: "cancel", order })}>Cancel</button>
                  </>}{order.status === "confirmed" && <>
                    <button type="button" disabled={writeBusy || !createScopeReady} onClick={() => setOrderActionTarget({ action: "deliver", order })}>Deliver #{order.number}</button>
                    <button type="button" className="sales-row-action" disabled={writeBusy || !createScopeReady} onClick={() => setOrderActionTarget({ action: "cancel", order })}>Cancel</button>
                  </>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}
      {orderActionTarget && (
        <div className="sales-modal-backdrop">
          <section className="sales-modal" role="dialog" aria-modal="true" aria-labelledby="sales-action-title">
            <p className="sales-eyebrow">Order #{orderActionTarget.order.number}</p>
            <h2 id="sales-action-title">{orderActionTarget.action === "deliver" ? "Deliver and invoice order?" : "Cancel sales order?"}</h2>
            <p>{orderActionTarget.action === "deliver"
              ? "This delivers all remaining reserved quantities, including service lines, and creates an invoice for those delivered lines."
              : "This withdraws the order and releases its remaining stock reservations. Delivered or partially delivered orders must be reversed through the invoice."}</p>
            <div className="sales-write-actions">
              <button type="button" className="sales-write-secondary" disabled={writeBusy || !createScopeReady} onClick={() => setOrderActionTarget(null)}>Keep order</button>
              <button type="button" className="sales-write-primary" disabled={writeBusy || !createScopeReady} onClick={() => void handleOrderAction()}>{writeBusy ? "Working…" : orderActionTarget.action === "deliver" ? "Deliver all and invoice" : "Cancel order"}</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
