import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { currencyMinorUnits } from "@chaste/erp-core";
import { confirmSalesOrder, fetchSalesEnabled, fetchSalesOrders, SalesApiError, type SalesOrder } from "../api/sales";
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

export function SalesPage({ baseCurrency = null }: { baseCurrency?: string | null }) {
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<OrderFilter>("all");
  const [confirmingOrderId, setConfirmingOrderId] = useState<string | null>(null);
  const [approvalWaitingOrderIds, setApprovalWaitingOrderIds] = useState<Set<string>>(() => new Set());
  const [allowBackorder, setAllowBackorder] = useState<Record<string, boolean>>({});
  const [actionNotice, setActionNotice] = useState<{ tone: "success" | "pending" | "error"; message: string } | null>(null);
  const confirmIntents = useRef(new Map<string, string>());
  const searchRef = useRef<HTMLInputElement>(null);
  const currency = useMemo(() => currencyFor(baseCurrency), [baseCurrency]);

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
  }, [load]);

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
      setConfirmingOrderId(null);
    }
  }

  return (
    <main className="sales-page">
      <header className="sales-page-header">
        <div>
          <p className="sales-eyebrow">Revenue · preview</p>
          <h1 id="sales-title">Sales orders</h1>
          <p>Review orders, delivery progress, and order totals. Create and manage orders in the full sales workspace.</p>
        </div>
        <div className="sales-header-actions">
          {state.status === "ready" && <span className="sales-order-count">{state.orders.length} {state.orders.length === 1 ? "order" : "orders"}</span>}
          <a className="sales-full-workspace" href={legacyUrl("/sales")}>Open full sales workspace</a>
        </div>
      </header>

      {actionNotice && <p className={`sales-action-notice sales-action-notice-${actionNotice.tone}`} role={actionNotice.tone === "error" ? "alert" : "status"}>{actionNotice.message}</p>}

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
          <p>Orders will appear here as your team confirms customer purchases.</p>
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
                  </>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
