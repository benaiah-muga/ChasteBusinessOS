import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { currencyMinorUnits } from "@chaste/erp-core";
import { getPendingInventoryItemCreation, InventoryItemActionError, submitInventoryItemAction, type CreateInventoryItem } from "../api/inventory-items";
import { clearRouteLessSalesOrderAttempt, confirmSalesOrder, fetchSalesCustomers, fetchSalesEnabled, fetchSalesOrders, findRouteLessSalesOrderAction, restorePendingSalesOrderAction, SalesApiError, submitSalesOrderWrite, type RouteLessSalesOrderMarker, type SalesCustomer, type SalesOrder, type SalesOrderWrite } from "../api/sales";
import { SalesQuoteWorkspace } from "./SalesQuoteWorkspace";
import "./sales-page.css";

type PageState =
  | { status: "loading" }
  | { status: "disabled"; scopeIdentity: string | null }
  | { status: "failed"; scopeIdentity: string | null; error: SalesApiError }
  | { status: "ready"; scopeIdentity: string | null; orders: SalesOrder[]; customers: SalesCustomer[] };

type CurrencyStyle = { symbol: string; minorUnits: number };
type OrderFilter = "all" | "draft" | "confirmed" | "delivered" | "cancelled";
type OrderDraftLine = { sku: string; description: string; quantity: string; unitPrice: string; tax: string };
type OrderActionTarget = { action: "deliver" | "deliverPartial" | "cancel"; order: SalesOrder };
type QuickCreateItemDraft = { sku: string; name: string; kind: "goods" | "service"; unitLabel: string; salePrice: string };
const emptyOrderDraftLine = (): OrderDraftLine => ({ sku: "", description: "", quantity: "1", unitPrice: "0", tax: "0" });
const emptyQuickCreateItemDraft = (): QuickCreateItemDraft => ({ sku: "", name: "", kind: "goods", unitLabel: "unit", salePrice: "0" });
const ORDER_FILTERS: { value: OrderFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "confirmed", label: "Confirmed" },
  { value: "delivered", label: "Delivered" },
  { value: "cancelled", label: "Cancelled" },
];
const CURRENCY_PREFERENCES = ["org", "USD", "KES", "EUR", "GBP", "TZS", "UGX"];
const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$", KES: "KSh", EUR: "€", GBP: "£", TZS: "TSh", UGX: "USh" };

function goInventoryItemWritesEnabled(): boolean {
  return typeof __GO_INVENTORY_ITEM_SLICE__ !== "undefined" && __GO_INVENTORY_ITEM_SLICE__;
}

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

function formatQuantity(thousandths: number): string {
  return (thousandths / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 });
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

function partialDeliverySelection(order: SalesOrder, values: Record<string, string>): { lines: Array<{ lineId: string; quantityThousandths: number }>; valid: boolean } {
  const lines: Array<{ lineId: string; quantityThousandths: number }> = [];
  let invalid = false;
  for (const line of order.lines) {
    const value = values[line.lineId] ?? "";
    if (!value.trim()) continue;
    const quantityThousandths = quantityFromInput(value);
    if (quantityThousandths === null || quantityThousandths > line.deliverableThousandths) {
      invalid = true;
      continue;
    }
    lines.push({ lineId: line.lineId, quantityThousandths });
  }
  return { lines, valid: !invalid && lines.length > 0 };
}

type ConfirmAttempt = { orderId: string; intentId: string; allowBackorder: boolean; pending: boolean };

function confirmAttemptKey(scopeIdentity: string, orderId: string): string {
  return `chaste:sales-confirm-attempt:${encodeURIComponent(scopeIdentity)}:${orderId}`;
}

function parseConfirmAttempt(value: string | null, orderId: string): ConfirmAttempt | null {
  if (value === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch {
    throw new SalesApiError(0, "A saved order confirmation retry marker is damaged. Verify order history before trying again.");
  }
  if (!parsed || typeof parsed !== "object") throw new SalesApiError(0, "A saved order confirmation retry marker is damaged. Verify order history before trying again.");
  const marker = parsed as Partial<ConfirmAttempt>;
  if (marker.orderId !== orderId || typeof marker.intentId !== "string" || !/^[0-9a-f-]{36}$/i.test(marker.intentId)
    || typeof marker.allowBackorder !== "boolean" || typeof marker.pending !== "boolean") {
    throw new SalesApiError(0, "A saved order confirmation retry marker is damaged. Verify order history before trying again.");
  }
  return marker as ConfirmAttempt;
}

function readConfirmAttempt(scopeIdentity: string, orderId: string): ConfirmAttempt | null {
  try { return parseConfirmAttempt(localStorage.getItem(confirmAttemptKey(scopeIdentity, orderId)), orderId); }
  catch (error) {
    if (error instanceof SalesApiError) throw error;
    throw new SalesApiError(0, "Enable browser storage before confirming an order so an uncertain action can be retried safely.");
  }
}

function savedConfirmAttempt(scopeIdentity: string | null, orderId: string): ConfirmAttempt | null {
  if (!scopeIdentity) return null;
  try { return readConfirmAttempt(scopeIdentity, orderId); } catch { return null; }
}

function hasSavedPendingApproval(scopeIdentity: string | null, orderId: string): boolean {
  return savedConfirmAttempt(scopeIdentity, orderId)?.pending ?? false;
}

async function withConfirmAttemptLock<T>(scopeIdentity: string, orderId: string, operation: (key: string) => Promise<T>): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) throw new SalesApiError(0, "Safe order confirmation retries are unavailable in this browser. Use a browser with Web Locks support before confirming orders.");
  const key = confirmAttemptKey(scopeIdentity, orderId);
  try {
    return await locks.request(`chaste:sales-confirm-lock:${key}`, { mode: "exclusive" }, () => operation(key));
  } catch (error) {
    if (error instanceof SalesApiError) throw error;
    throw new SalesApiError(0, "Could not safely coordinate this order confirmation across browser tabs. Close other Sales tabs and try again.");
  }
}

function persistConfirmAttempt(key: string, attempt: ConfirmAttempt): void {
  try {
    localStorage.setItem(key, JSON.stringify(attempt));
    const persisted = parseConfirmAttempt(localStorage.getItem(key), attempt.orderId);
    if (!persisted || persisted.intentId !== attempt.intentId || persisted.allowBackorder !== attempt.allowBackorder || persisted.pending !== attempt.pending) throw new Error("saved attempt did not persist");
  } catch (error) {
    if (error instanceof SalesApiError) throw error;
    throw new SalesApiError(0, "Enable browser storage before confirming an order so an uncertain action can be retried safely.");
  }
}

function clearConfirmAttempt(key: string): void {
  try { localStorage.removeItem(key); }
  catch { throw new SalesApiError(0, "Browser storage could not resolve the saved order confirmation. Retry the same confirmation or verify order history."); }
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
  const [quickCreateTargetIndex, setQuickCreateTargetIndex] = useState<number | null>(null);
  const [quickCreateItemDraft, setQuickCreateItemDraft] = useState<QuickCreateItemDraft>(emptyQuickCreateItemDraft);
  const [quickCreateBusy, setQuickCreateBusy] = useState(false);
  const [quickCreateError, setQuickCreateError] = useState<string | null>(null);
  const [quickCreatePending, setQuickCreatePending] = useState(false);
  const [writeBusy, setWriteBusy] = useState(false);
  const [createAttemptPending, setCreateAttemptPending] = useState(false);
  const [createAttemptRestoredScope, setCreateAttemptRestoredScope] = useState<string | null>(null);
  const [scopedWriteRecoveryLocked, setScopedWriteRecoveryLocked] = useState(false);
  const [routeLessAttempt, setRouteLessAttempt] = useState<{ scopeIdentity: string; marker: RouteLessSalesOrderMarker } | null>(null);
  const [routeLessReviewConfirmed, setRouteLessReviewConfirmed] = useState(false);
  const [routeLessRecoveryBusy, setRouteLessRecoveryBusy] = useState(false);
  const [orderActionTarget, setOrderActionTarget] = useState<OrderActionTarget | null>(null);
  const [partialDeliveryQuantities, setPartialDeliveryQuantities] = useState<Record<string, string>>({});
  const [recoveredWriteAction, setRecoveredWriteAction] = useState<SalesOrderWrite | null>(null);
  const previousCreateScope = useRef<string | null>(null);
  const currentCreateScope = useRef<string | null>(null);
  const confirmationScope = useRef<string | null>(null);
  const confirmationGeneration = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const currency = useMemo(() => currencyFor(baseCurrency), [baseCurrency]);
  const createScopeIdentity = actorId?.trim() && organizationId?.trim()
    ? JSON.stringify([actorId.trim(), organizationId.trim()])
    : null;
  const visibleState: PageState = state.status !== "loading" && state.scopeIdentity !== createScopeIdentity
    ? { status: "loading" }
    : state;
  currentCreateScope.current = createScopeIdentity;
  if (confirmationScope.current !== createScopeIdentity) {
    confirmationScope.current = createScopeIdentity;
    confirmationGeneration.current += 1;
  }
  const createScopeReady = createScopeIdentity !== null && createAttemptRestoredScope === createScopeIdentity;
  const routeLessAttemptCurrent = routeLessAttempt?.scopeIdentity === createScopeIdentity;
  const createWriteLocked = !createScopeReady || createAttemptPending || routeLessAttemptCurrent || scopedWriteRecoveryLocked || quickCreateBusy || quickCreatePending;
  const partialSelection = orderActionTarget?.action === "deliverPartial"
    ? partialDeliverySelection(orderActionTarget.order, partialDeliveryQuantities)
    : null;

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ status: "loading" });
    const requestedOrganizationId = organizationId?.trim() ?? "";
    const requestedScopeIdentity = createScopeIdentity;
    try {
      if (!requestedOrganizationId) throw new SalesApiError(0, "Wait for the active organization to finish loading before loading sales data.");
      const enabled = await fetchSalesEnabled(requestedOrganizationId, signal);
      if (signal?.aborted) return;
      if (!enabled) {
        setState({ status: "disabled", scopeIdentity: requestedScopeIdentity });
        return;
      }
      const [orders, customers] = await Promise.all([
        fetchSalesOrders(requestedOrganizationId, signal),
        fetchSalesCustomers(requestedOrganizationId, signal),
      ]);
      if (!signal?.aborted) setState({ status: "ready", scopeIdentity: requestedScopeIdentity, orders, customers });
    } catch (error) {
      if (signal?.aborted) return;
      setState({
        status: "failed",
        scopeIdentity: requestedScopeIdentity,
        error: error instanceof SalesApiError
          ? error
          : new SalesApiError(0, "Could not reach the sales service. Check your connection and try again."),
      });
    }
  }, [createScopeIdentity, organizationId]);

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
    setScopedWriteRecoveryLocked(false);
    setRouteLessAttempt(null);
    setRouteLessReviewConfirmed(false);
    setRouteLessRecoveryBusy(false);
    if (scopeChanged) {
      setWriteBusy(false);
      setConfirmingOrderId(null);
      setApprovalWaitingOrderIds(new Set());
      setAllowBackorder({});
      setCreateForm({ customerId: "", note: "", lines: [emptyOrderDraftLine()] });
      setShowCreateForm(false);
      setCreateError(null);
      setQuickCreateTargetIndex(null);
      setQuickCreateItemDraft(emptyQuickCreateItemDraft());
      setQuickCreateBusy(false);
      setQuickCreateError(null);
      setQuickCreatePending(false);
      setOrderActionTarget(null);
      setRecoveredWriteAction(null);
      setActionNotice(null);
    }
    if (!actorId || !organizationId || !createScopeIdentity) return () => { current = false; };
    void (async () => {
      let pendingItem: CreateInventoryItem | null = null;
      if (goInventoryItemWritesEnabled()) {
        try {
          pendingItem = await getPendingInventoryItemCreation({ actorId, organizationId, retryContext: "sales-catalog" });
        } catch (error) {
          if (!current) return;
          setQuickCreateError(error instanceof InventoryItemActionError ? error.message : "A saved catalog item action could not be recovered safely.");
        }
      }
      if (!current) return;
      if (pendingItem) {
        setQuickCreateItemDraft({
          sku: pendingItem.sku,
          name: pendingItem.name,
          kind: pendingItem.kind,
          unitLabel: pendingItem.unitLabel,
          salePrice: String(pendingItem.salePriceMinor / (10 ** currency.minorUnits)),
        });
        setQuickCreatePending(true);
        setQuickCreateError("An item creation is unresolved. Retry the saved item details to check its result.");
        setShowCreateForm(true);
        setQuickCreateTargetIndex(0);
      }
      const routeLessAction = await findRouteLessSalesOrderAction({ actorId, organizationId });
      if (!current) return;
      if (routeLessAction) {
        setRouteLessAttempt({ scopeIdentity: createScopeIdentity, marker: routeLessAction });
        setCreateAttemptRestoredScope(createScopeIdentity);
        setCreateAttemptPending(true);
        setSearch("");
        setFilter("all");
        setActionNotice({ tone: "error", message: "A saved sales order retry marker has no usable backend route. Review sales order history before choosing whether to clear it." });
        return;
      }
      const action = await restorePendingSalesOrderAction({ actorId, organizationId });
      if (!current) return;
      setCreateAttemptRestoredScope(createScopeIdentity);
      if (!action) return;
      if (action.action !== "create") {
        setRecoveredWriteAction(action);
        setCreateAttemptPending(true);
        setActionNotice({ tone: "pending", message: `An earlier sales order ${action.action === "deliver" ? "delivery" : "cancellation"} is unresolved. Retry the saved action to check its result.` });
        return;
      }
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
    })().catch((error: unknown) => {
      if (!current) return;
      setScopedWriteRecoveryLocked(true);
      setCreateAttemptPending(true);
      setShowCreateForm(true);
      setActionNotice({ tone: "error", message: error instanceof SalesApiError ? error.message : "The saved sales order draft could not be restored." });
    });
    return () => { current = false; };
  }, [actorId, createScopeIdentity, currency.minorUnits, organizationId]);

  async function handleQuickCreateItem(): Promise<void> {
    if (!goInventoryItemWritesEnabled()) {
      setQuickCreateError("Catalog quick-create is unavailable in this deployment because Go inventory item writes are disabled.");
      return;
    }
    if (quickCreateTargetIndex === null || !createScopeReady || !createScopeIdentity || quickCreateBusy) return;
    const submittedScope = createScopeIdentity;
    const salePriceMinor = minorFromInput(quickCreateItemDraft.salePrice, currency.minorUnits);
    if (!quickCreateItemDraft.sku.trim() || quickCreateItemDraft.sku.trim().length > 40
      || !quickCreateItemDraft.name.trim() || quickCreateItemDraft.name.trim().length > 120
      || !quickCreateItemDraft.unitLabel.trim() || quickCreateItemDraft.unitLabel.trim().length > 20
      || salePriceMinor === null) {
      setQuickCreateError("Enter a SKU, item name, unit, and non-negative price using the workspace currency.");
      return;
    }
    const action: CreateInventoryItem = {
      action: "createItem",
      sku: quickCreateItemDraft.sku,
      name: quickCreateItemDraft.name,
      kind: quickCreateItemDraft.kind,
      unitLabel: quickCreateItemDraft.unitLabel,
      salePriceMinor,
      reorderPointThousandths: 0,
      tags: [],
    };
    setQuickCreateBusy(true);
    setQuickCreateError(null);
    try {
      const result = await submitInventoryItemAction(action, undefined, { actorId, organizationId, retryContext: "sales-catalog" });
      if (currentCreateScope.current !== submittedScope) return;
      if (result.kind === "pending") {
        setQuickCreatePending(true);
        setQuickCreateError(result.reason);
        return;
      }
      const targetIndex = quickCreateTargetIndex;
      setCreateForm((current) => ({
        ...current,
        lines: current.lines.map((line, index) => index === targetIndex
          ? { ...line, sku: quickCreateItemDraft.sku.trim(), description: quickCreateItemDraft.name.trim(), unitPrice: quickCreateItemDraft.salePrice }
          : line),
      }));
      setQuickCreateTargetIndex(null);
      setQuickCreateItemDraft(emptyQuickCreateItemDraft());
      setQuickCreatePending(false);
      setQuickCreateError(null);
      setActionNotice({ tone: "success", message: "Catalog item created through Go and added to the order line." });
    } catch (error) {
      if (currentCreateScope.current !== submittedScope) return;
      const uncertain = !(error instanceof InventoryItemActionError)
        || error.status === 0 || error.status === 404 || error.status === 408 || error.status === 429 || error.status >= 500;
      setQuickCreatePending(uncertain);
      setQuickCreateError(error instanceof InventoryItemActionError ? error.message : "The catalog item result is unresolved. Retry these exact details or check the catalog first.");
    } finally {
      if (currentCreateScope.current === submittedScope) setQuickCreateBusy(false);
    }
  }

  async function clearReviewedRouteLessAttempt(): Promise<void> {
    if (!routeLessAttemptCurrent || !routeLessReviewConfirmed || routeLessRecoveryBusy || !actorId || !organizationId || !createScopeIdentity) return;
    const submittedScope = createScopeIdentity;
    setRouteLessRecoveryBusy(true);
    try {
      const cleared = await clearRouteLessSalesOrderAttempt({ actorId, organizationId }, routeLessAttempt.marker);
      if (currentCreateScope.current !== submittedScope) return;
      if (!cleared) {
        setActionNotice({ tone: "error", message: "The ambiguous sales marker changed before it could be cleared. Review sales order history again." });
        return;
      }
      setRouteLessAttempt(null);
      setRouteLessReviewConfirmed(false);
      setCreateAttemptPending(false);
      setScopedWriteRecoveryLocked(false);
      setActionNotice({ tone: "success", message: "The reviewed ambiguous retry marker was cleared. No Sales action was sent." });
    } catch (error) {
      if (currentCreateScope.current !== submittedScope) return;
      setActionNotice({ tone: "error", message: error instanceof SalesApiError ? error.message : "The reviewed sales retry marker could not be cleared." });
    } finally {
      if (currentCreateScope.current === submittedScope) setRouteLessRecoveryBusy(false);
    }
  }

  async function retryRecoveredWriteAction(): Promise<void> {
    if (!recoveredWriteAction || recoveredWriteAction.action === "create" || routeLessAttemptCurrent || scopedWriteRecoveryLocked || writeBusy || !createScopeReady || !createScopeIdentity) return;
    const action = recoveredWriteAction;
    const submittedScope = createScopeIdentity;
    setWriteBusy(true);
    setActionNotice(null);
    try {
      const result = await submitSalesOrderWrite(action, { actorId, organizationId });
      if (currentCreateScope.current !== submittedScope) return;
      if (result.kind === "pending") {
        setActionNotice({ tone: "pending", message: result.reason });
        return;
      }
      setRecoveredWriteAction(null);
      setCreateAttemptPending(false);
      const orderNumber = visibleState.status === "ready"
        ? visibleState.orders.find((order) => order.id === action.orderId)?.number
        : undefined;
      const orderLabel = orderNumber ? `#${orderNumber}` : action.orderId;
      setActionNotice({
        tone: "success",
        message: result.action === "cancel"
          ? `Order ${orderLabel} cancelled.`
          : result.data.orderStatus === "delivered"
            ? `Order ${orderLabel} fully delivered and invoiced.`
            : `Reserved quantities delivered and invoiced for order ${orderLabel}. The order remains confirmed.`,
      });
      await refreshOrderList(submittedScope);
    } catch (error) {
      if (currentCreateScope.current !== submittedScope) return;
      if (error instanceof SalesApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429 && error.status !== 404) {
        setRecoveredWriteAction(null);
        setCreateAttemptPending(false);
      }
      setActionNotice({ tone: "error", message: error instanceof SalesApiError ? error.message : "The saved sales order action could not be retried." });
    } finally {
      if (currentCreateScope.current === submittedScope) setWriteBusy(false);
    }
  }

  useEffect(() => {
    function onShortcut(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select"))) return;
      if (visibleState.status !== "ready" || visibleState.orders.length === 0) return;
      event.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [visibleState]);

  const customerNames = useMemo(() => visibleState.status === "ready"
    ? new Map(visibleState.customers.map((customer) => [customer.id, customer.name]))
    : new Map<string, string>(), [visibleState]);

  const filtered = useMemo(() => {
    if (visibleState.status !== "ready") return [];
    const query = search.trim().toLocaleLowerCase();
    return visibleState.orders.filter((order) => {
      if (filter !== "all" && order.status !== filter) return false;
      if (!query) return true;
      return [`#${order.number}`, customerNames.get(order.customerId) ?? "Unknown customer", order.status]
        .some((value) => value.toLocaleLowerCase().includes(query));
    });
  }, [customerNames, filter, search, visibleState]);

  async function handleConfirm(order: SalesOrder) {
    if (!createScopeReady || routeLessAttemptCurrent || scopedWriteRecoveryLocked) return;
    if (!createScopeIdentity) return;
    const submittedScope = createScopeIdentity;
    const submittedGeneration = confirmationGeneration.current;
    const isCurrentScope = () => currentCreateScope.current === submittedScope
      && confirmationGeneration.current === submittedGeneration;
    const savedAttempt = savedConfirmAttempt(submittedScope, order.id);
    const checkingApproval = approvalWaitingOrderIds.has(order.id) || savedAttempt?.pending === true;
    if (!checkingApproval && !window.confirm(`Confirm order #${order.number}?`)) return;
    const backorderChoice = savedAttempt?.allowBackorder ?? allowBackorder[order.id] ?? false;
    setConfirmingOrderId(order.id);
    setActionNotice(null);
    try {
      const { result, attempt } = await withConfirmAttemptLock(submittedScope, order.id, async (key) => {
        const existing = readConfirmAttempt(submittedScope, order.id);
        const activeAttempt = existing ?? {
          orderId: order.id,
          intentId: crypto.randomUUID(),
          allowBackorder: backorderChoice,
          pending: false,
        };
        if (!existing) persistConfirmAttempt(key, activeAttempt);
        try {
          const outcome = await confirmSalesOrder(order.id, activeAttempt.intentId, organizationId, activeAttempt.allowBackorder);
          if (outcome.kind === "pending") persistConfirmAttempt(key, { ...activeAttempt, pending: true });
          else clearConfirmAttempt(key);
          return { result: outcome, attempt: activeAttempt };
        } catch (error) {
          if (error instanceof SalesApiError && error.status === 422) clearConfirmAttempt(key);
          throw error;
        }
      });
      if (!isCurrentScope()) return;
      if (result.kind === "pending") {
        setAllowBackorder((current) => ({ ...current, [order.id]: attempt.allowBackorder }));
        setApprovalWaitingOrderIds((current) => new Set(current).add(order.id));
        setActionNotice({ tone: "pending", message: result.reason });
        return;
      }
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
      const orders = await fetchSalesOrders(organizationId);
      if (expectedScope !== undefined && currentCreateScope.current !== expectedScope) return;
      setState((current) => current.status === "ready" ? { ...current, orders } : current);
    } catch {
      if (expectedScope !== undefined && currentCreateScope.current !== expectedScope) return;
      setActionNotice((current) => current ?? { tone: "error", message: "The action completed, but the order list could not refresh." });
    }
  }

  async function handleCreateOrder(): Promise<void> {
    if (!createScopeReady || routeLessAttemptCurrent || scopedWriteRecoveryLocked) return;
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
    if (!orderActionTarget || routeLessAttemptCurrent || scopedWriteRecoveryLocked || !createScopeReady || !createScopeIdentity) return;
    const target = orderActionTarget;
    const selection = target.action === "deliverPartial" ? partialDeliverySelection(target.order, partialDeliveryQuantities) : null;
    if (target.action === "deliverPartial" && !selection?.valid) {
      setActionNotice({ tone: "error", message: "Enter a positive quantity no greater than the reserved balance for at least one line." });
      return;
    }
    const submittedScope = createScopeIdentity;
    setWriteBusy(true);
    setActionNotice(null);
    try {
      const result = await submitSalesOrderWrite(target.action === "cancel"
        ? { action: "cancel", orderId: target.order.id }
        : { action: "deliver", orderId: target.order.id, ...(selection ? { lines: selection.lines } : {}) }, { actorId, organizationId });
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
      {recoveredWriteAction && recoveredWriteAction.action !== "create" && (
        <section className="sales-write-card" aria-labelledby="sales-retry-title">
          <div className="sales-write-heading">
            <div>
              <p className="sales-eyebrow">Saved Go action</p>
              <h2 id="sales-retry-title">Retry the unresolved {recoveredWriteAction.action === "deliver" ? "delivery" : "cancellation"}</h2>
            </div>
            <button
              type="button"
              className="sales-write-primary"
              disabled={routeLessAttemptCurrent || scopedWriteRecoveryLocked || writeBusy || !createScopeReady}
              onClick={() => void retryRecoveredWriteAction()}
            >
              {writeBusy ? "Checking…" : recoveredWriteAction.action === "deliver" ? "Retry saved delivery" : "Retry saved cancellation"}
            </button>
          </div>
          <p>
            This sends the saved {recoveredWriteAction.action === "deliver" ? "delivery quantities" : "cancellation"} to Go again with the original intent ID. Other Sales writes stay locked until the action is resolved.
          </p>
        </section>
      )}
      <header className="sales-page-header">
        <div>
          <p className="sales-eyebrow">Revenue · preview</p>
          <h1 id="sales-title">Sales orders</h1>
          <p>Review and create orders, quotes, and customer relationships. Quote actions and CRM views run through authenticated Go capabilities.</p>
        </div>
        <div className="sales-header-actions">
          {visibleState.status === "ready" && <span className="sales-order-count">{visibleState.orders.length} {visibleState.orders.length === 1 ? "order" : "orders"}</span>}
          <button className="sales-new-order" type="button" disabled={createAttemptPending || quickCreateBusy || quickCreatePending} onClick={() => { setShowCreateForm((open) => !open); setCreateError(null); }} aria-expanded={showCreateForm}>
            {showCreateForm ? "Close order form" : "Create sales order"}
          </button>
        </div>
      </header>

      <SalesQuoteWorkspace actorId={actorId} organizationId={organizationId} baseCurrency={baseCurrency} />

      {actionNotice && <p className={`sales-action-notice sales-action-notice-${actionNotice.tone}`} role={actionNotice.tone === "error" ? "alert" : "status"}>{actionNotice.message}</p>}

      {routeLessAttemptCurrent && visibleState.status === "ready" && (
        <section className="sales-write-card" aria-labelledby="sales-route-less-title" role="alert">
          <div className="sales-write-heading">
            <div><p className="sales-eyebrow">Manual review required</p><h2 id="sales-route-less-title">Resolve an older retry marker</h2></div>
            <p>The saved {routeLessAttempt.marker.action} action has no usable backend route. Review the Sales order history below to decide whether it completed. Clearing this marker will not send a request or retry the action.</p>
          </div>
          <label>
            <input type="checkbox" checked={routeLessReviewConfirmed} onChange={(event) => setRouteLessReviewConfirmed(event.currentTarget.checked)} disabled={routeLessRecoveryBusy || visibleState.status !== "ready"} />
            I reviewed the Sales order history and understand this only clears the ambiguous retry marker.
          </label>
          <div className="sales-write-actions">
            <button type="button" className="sales-write-primary" disabled={!routeLessReviewConfirmed || routeLessRecoveryBusy || visibleState.status !== "ready"} onClick={() => void clearReviewedRouteLessAttempt()}>
              {routeLessRecoveryBusy ? "Clearing marker…" : "Clear reviewed retry marker"}
            </button>
          </div>
        </section>
      )}

      {showCreateForm && visibleState.status === "ready" && (
        <section className="sales-write-card" aria-labelledby="sales-create-title">
          <div className="sales-write-heading">
            <div><p className="sales-eyebrow">New draft</p><h2 id="sales-create-title">Create sales order</h2></div>
            <p>Prices and tax use {baseCurrency ?? "the workspace currency"}. A non-empty SKU links the line to inventory.</p>
          </div>
          <div className="sales-write-grid">
            <label>Customer
              <select value={createForm.customerId} onChange={(event) => { const value = event.currentTarget.value; setCreateForm((current) => ({ ...current, customerId: value })); setCreateError(null); }} disabled={writeBusy || createWriteLocked}>
                <option value="">Choose a customer</option>
                {visibleState.customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
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
                <button type="button" className="sales-write-secondary" disabled={!goInventoryItemWritesEnabled() || writeBusy || !createScopeReady || createWriteLocked} onClick={() => { setQuickCreateTargetIndex(index); setQuickCreateError(null); }} title={!goInventoryItemWritesEnabled() ? "Go inventory item writes are disabled in this deployment." : undefined}>Create catalog item</button>
                <label>Description<input value={line.description} onChange={(event) => { const value = event.currentTarget.value; setCreateForm((current) => ({ ...current, lines: current.lines.map((item, itemIndex) => itemIndex === index ? { ...item, description: value } : item) })); setCreateError(null); }} disabled={writeBusy || createWriteLocked} /></label>
                <label>Quantity<input inputMode="decimal" value={line.quantity} onChange={(event) => { const value = event.currentTarget.value; setCreateForm((current) => ({ ...current, lines: current.lines.map((item, itemIndex) => itemIndex === index ? { ...item, quantity: value } : item) })); }} disabled={writeBusy || createWriteLocked} /></label>
                <label>Unit price<input inputMode="decimal" value={line.unitPrice} onChange={(event) => { const value = event.currentTarget.value; setCreateForm((current) => ({ ...current, lines: current.lines.map((item, itemIndex) => itemIndex === index ? { ...item, unitPrice: value } : item) })); }} disabled={writeBusy || createWriteLocked} /></label>
                <label>Tax<input inputMode="decimal" value={line.tax} onChange={(event) => { const value = event.currentTarget.value; setCreateForm((current) => ({ ...current, lines: current.lines.map((item, itemIndex) => itemIndex === index ? { ...item, tax: value } : item) })); }} disabled={writeBusy || createWriteLocked} /></label>
                <button type="button" className="sales-write-remove" disabled={writeBusy || createWriteLocked || createForm.lines.length === 1} aria-label={`Remove line ${index + 1}`} onClick={() => setCreateForm((current) => ({ ...current, lines: current.lines.filter((_, itemIndex) => itemIndex !== index) }))}>Remove</button>
              </div>
            ))}
            <div className="sales-write-actions">
              <button type="button" className="sales-write-secondary" disabled={writeBusy || createWriteLocked} onClick={() => setCreateForm((current) => ({ ...current, lines: [...current.lines, emptyOrderDraftLine()] }))}>Add line</button>
              <button type="button" className="sales-write-primary" disabled={writeBusy || !createScopeReady || routeLessAttemptCurrent || scopedWriteRecoveryLocked} onClick={() => void handleCreateOrder()}>{writeBusy ? "Saving…" : "Create draft"}</button>
            </div>
            {createError && <p className="sales-write-error" role="alert">{createError}</p>}
          </div>
        </section>
      )}

      {quickCreateTargetIndex !== null && visibleState.status === "ready" && (
        <div className="sales-dialog-backdrop" role="presentation">
          <section className="sales-action-dialog" role="dialog" aria-modal="true" aria-labelledby="sales-quick-item-title">
            <div className="sales-write-heading">
              <div><p className="sales-eyebrow">Catalog</p><h2 id="sales-quick-item-title">Create catalog item</h2></div>
              <p>This creates the item through the Go inventory capability, then links it to this draft line.</p>
            </div>
            <div className="sales-write-grid">
              <label>SKU<input value={quickCreateItemDraft.sku} maxLength={40} onChange={(event) => { const value = event.currentTarget.value; setQuickCreateItemDraft((current) => ({ ...current, sku: value })); }} disabled={quickCreateBusy || quickCreatePending} /></label>
              <label>Item name<input value={quickCreateItemDraft.name} maxLength={120} onChange={(event) => { const value = event.currentTarget.value; setQuickCreateItemDraft((current) => ({ ...current, name: value })); }} disabled={quickCreateBusy || quickCreatePending} /></label>
              <label>Type<select value={quickCreateItemDraft.kind} onChange={(event) => { const value = event.currentTarget.value; if (value === "goods" || value === "service") setQuickCreateItemDraft((current) => ({ ...current, kind: value, unitLabel: value === "service" ? "hour" : "unit" })); }} disabled={quickCreateBusy || quickCreatePending}><option value="goods">Goods</option><option value="service">Service</option></select></label>
              <label>Unit<input value={quickCreateItemDraft.unitLabel} maxLength={20} onChange={(event) => { const value = event.currentTarget.value; setQuickCreateItemDraft((current) => ({ ...current, unitLabel: value })); }} disabled={quickCreateBusy || quickCreatePending} /></label>
              <label>Sale price ({baseCurrency ?? "workspace currency"})<input inputMode="decimal" value={quickCreateItemDraft.salePrice} onChange={(event) => { const value = event.currentTarget.value; setQuickCreateItemDraft((current) => ({ ...current, salePrice: value })); }} disabled={quickCreateBusy || quickCreatePending} /></label>
            </div>
            <div className="sales-write-actions">
              <button type="button" className="sales-write-secondary" disabled={quickCreateBusy || quickCreatePending} onClick={() => { setQuickCreateTargetIndex(null); setQuickCreateError(null); }}>Close</button>
              <button type="button" className="sales-write-primary" disabled={quickCreateBusy || !createScopeReady} onClick={() => void handleQuickCreateItem()}>{quickCreateBusy ? "Saving…" : quickCreatePending ? "Retry saved item" : "Create item and add line"}</button>
            </div>
            {quickCreateError && <p className="sales-write-error" role="alert">{quickCreateError}</p>}
          </section>
        </div>
      )}

      {visibleState.status === "ready" && visibleState.orders.length > 0 && (
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

      {visibleState.status === "loading" && <p className="sales-loading" role="status">Loading sales orders…</p>}
      {visibleState.status === "disabled" && (
        <section className="sales-empty" role="status">
          <span aria-hidden="true">↗</span>
          <h2>Sales is turned off</h2>
          <p>Ask a workspace administrator to enable the Sales module before viewing orders.</p>
        </section>
      )}
      {visibleState.status === "failed" && (
        <section className="sales-error" role="alert" aria-labelledby="sales-error-title">
          <div>
            <p className="sales-eyebrow">Sales unavailable</p>
            <h2 id="sales-error-title">{visibleState.error.status === 403 || visibleState.error.message.startsWith("forbidden:") ? "Access denied" : "Could not load sales orders"}</h2>
            <p>{visibleState.error.message}</p>
          </div>
          <div className="sales-error-actions">
            {visibleState.error.status === 401 && <a href="/login">Sign in again</a>}
            <button type="button" onClick={() => void load()}>Try again</button>
          </div>
        </section>
      )}
      {visibleState.status === "ready" && visibleState.orders.length === 0 && (
        <section className="sales-empty" role="status">
          <span aria-hidden="true">↗</span>
          <h2>No sales orders yet</h2>
          <p>Create a draft order, then confirm it to check credit and reserve stock.</p>
        </section>
      )}
      {visibleState.status === "ready" && visibleState.orders.length > 0 && filtered.length === 0 && (
        <section className="sales-empty" role="status">
          <span aria-hidden="true">⌕</span>
          <h2>No orders match</h2>
          <p>Try another order number, customer, or status.</p>
        </section>
      )}
      {visibleState.status === "ready" && filtered.length > 0 && (
        <section className="sales-table-card" aria-label="Sales orders">
          <div className="sales-table-scroll">
            <table className="sales-table">
              <thead><tr><th scope="col">Order</th><th scope="col">Customer</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col">Total</th><th scope="col">Actions</th></tr></thead>
              <tbody>{filtered.map((order) => (
                <tr key={order.id}>
                  <th scope="row">
                    <span>#{order.number}</span>
                    {order.lines.length > 0 && <details className="sales-order-lines">
                      <summary>{order.lines.length} line {order.lines.length === 1 ? "item" : "items"}</summary>
                      <ul>
                        {order.lines.map((line) => <li key={line.lineId}>
                          <strong>{line.description}</strong>
                          <span>Ordered {formatQuantity(line.quantityThousandths)}, delivered {formatQuantity(line.deliveredThousandths)}, reserved to deliver {formatQuantity(line.deliverableThousandths)}</span>
                        </li>)}
                      </ul>
                    </details>}
                  </th>
                  <td><span className="sales-customer-id">{customerNames.get(order.customerId) ?? "Unknown customer"}</span>{order.backordered && <span className="sales-backorder">Backordered</span>}</td>
                  <td><span className="sales-status">{formatStatus(order.status)}</span></td>
                  <td><time dateTime={order.createdAt}>{new Date(order.createdAt).toLocaleDateString()}</time></td>
                  <td className="sales-total">{formatMoney(order.totalMinor, currency)}</td>
                  <td>{order.status === "draft" && <>
                    <label>
                      <input
                        type="checkbox"
                        checked={savedConfirmAttempt(createScopeIdentity, order.id)?.allowBackorder ?? allowBackorder[order.id] ?? false}
                        onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          setAllowBackorder((current) => ({ ...current, [order.id]: checked }));
                        }}
                        disabled={routeLessAttemptCurrent || scopedWriteRecoveryLocked || confirmingOrderId === order.id || approvalWaitingOrderIds.has(order.id) || savedConfirmAttempt(createScopeIdentity, order.id) !== null}
                      />
                      Allow backorder
                    </label>
                    <button type="button" disabled={!createScopeReady || routeLessAttemptCurrent || scopedWriteRecoveryLocked || recoveredWriteAction !== null || confirmingOrderId !== null} onClick={() => void handleConfirm(order)}>{confirmingOrderId === order.id ? "Checking…" : approvalWaitingOrderIds.has(order.id) || hasSavedPendingApproval(createScopeIdentity, order.id) ? `Check approval #${order.number}` : `Confirm #${order.number}`}</button>
                    <button type="button" className="sales-row-action" disabled={routeLessAttemptCurrent || scopedWriteRecoveryLocked || recoveredWriteAction !== null || writeBusy || !createScopeReady || confirmingOrderId !== null} onClick={() => setOrderActionTarget({ action: "cancel", order })}>Cancel</button>
                  </>}{order.status === "confirmed" && <>
                    <button type="button" disabled={routeLessAttemptCurrent || scopedWriteRecoveryLocked || recoveredWriteAction !== null || writeBusy || !createScopeReady} onClick={() => setOrderActionTarget({ action: "deliver", order })}>Deliver #{order.number}</button>
                    {order.lines.some((line) => line.deliverableThousandths > 0) && <button type="button" className="sales-row-action" disabled={routeLessAttemptCurrent || scopedWriteRecoveryLocked || recoveredWriteAction !== null || writeBusy || !createScopeReady} onClick={() => { setPartialDeliveryQuantities({}); setOrderActionTarget({ action: "deliverPartial", order }); }}>Partial delivery</button>}
                    <button type="button" className="sales-row-action" disabled={routeLessAttemptCurrent || scopedWriteRecoveryLocked || recoveredWriteAction !== null || writeBusy || !createScopeReady} onClick={() => setOrderActionTarget({ action: "cancel", order })}>Cancel</button>
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
            <h2 id="sales-action-title">{orderActionTarget.action === "cancel" ? "Cancel sales order?" : orderActionTarget.action === "deliverPartial" ? "Deliver selected quantities?" : "Deliver and invoice order?"}</h2>
            <p>{orderActionTarget.action === "cancel"
              ? "This withdraws the order and releases its remaining stock reservations. Delivered or partially delivered orders must be reversed through the invoice."
              : orderActionTarget.action === "deliverPartial"
                ? "Enter quantities to deliver now. Each amount is limited to the reserved balance, and the order stays open until all lines are delivered."
                : "This delivers all remaining reserved quantities, including service lines, and creates an invoice for those delivered lines."}</p>
            {orderActionTarget.action === "deliverPartial" && <div className="sales-partial-delivery-lines">
              {orderActionTarget.order.lines.filter((line) => line.deliverableThousandths > 0).map((line) => (
                <label key={line.lineId}>
                  <span>{line.description} <small>Available: {(line.deliverableThousandths / 1000).toFixed(3)}</small></span>
                  <input
                    aria-label={`Quantity to deliver for ${line.description}`}
                    type="number"
                    min="0"
                    max={(line.deliverableThousandths / 1000).toString()}
                    step="0.001"
                    inputMode="decimal"
                    value={partialDeliveryQuantities[line.lineId] ?? ""}
                    onChange={(event) => { const value = event.currentTarget.value; setPartialDeliveryQuantities((current) => ({ ...current, [line.lineId]: value })); }}
                    disabled={routeLessAttemptCurrent || scopedWriteRecoveryLocked || writeBusy || !createScopeReady}
                  />
                </label>
              ))}
            </div>}
            <div className="sales-write-actions">
              <button type="button" className="sales-write-secondary" disabled={routeLessAttemptCurrent || scopedWriteRecoveryLocked || writeBusy || !createScopeReady} onClick={() => setOrderActionTarget(null)}>Keep order</button>
              <button type="button" className="sales-write-primary" disabled={routeLessAttemptCurrent || scopedWriteRecoveryLocked || writeBusy || !createScopeReady || (orderActionTarget.action === "deliverPartial" && !partialSelection?.valid)} onClick={() => void handleOrderAction()}>{writeBusy ? "Working…" : orderActionTarget.action === "cancel" ? "Cancel order" : orderActionTarget.action === "deliverPartial" ? "Deliver selected quantities and invoice" : "Deliver all and invoice"}</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
