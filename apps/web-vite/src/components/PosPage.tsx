import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { currencyMinorUnits } from "@chaste/erp-core";
import { PosApiError, fetchPosShiftSummary, type PosShiftSummary } from "../api/pos";
import {
  adjustPosItemStock,
  clearPosSaleRetryIntent,
  closePosSession,
  createPosQuickProduct,
  fetchPosCatalog,
  fetchPosCustomers,
  fetchPosModules,
  fetchPosRegisterState,
  openPosSession,
  requestPosReturn,
  restorePosReturnAttempt,
  submitPosSale,
  type PosCatalogItem,
  type PosCustomer,
  type PosSaleAction,
  type PosReturnAction,
  type PosRegisterSession,
  type PosSale,
  type PosSaleLine,
} from "../api/pos-session";
import { legacyUrl } from "../legacy";
import "./PosPage.css";

type Tab = "overview" | "sell" | "sessions";
const TABS: readonly Tab[] = ["overview", "sell", "sessions"];
type PosStorageBucket = "cart" | "parked-carts" | "queued-sales";

function posStorageKey(bucket: PosStorageBucket, actorId: string | null, organizationId: string | null): string {
  return `chaste.pos.${bucket}.v2:${encodeURIComponent(organizationId ?? "unresolved-org")}:${encodeURIComponent(actorId ?? "anonymous")}`;
}

type CurrencyStyle = { symbol: string; minorUnits: number };
const CURRENCY_PREFERENCES = ["org", "USD", "KES", "EUR", "GBP", "TZS", "UGX"];
const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$", KES: "KSh", EUR: "€", GBP: "£", TZS: "TSh", UGX: "USh" };

type Notice = { tone: "success" | "pending" | "error"; title: string; hint?: string };
type DraftLine = { description: string; quantity: number; unitPriceMinor: number; sku?: string };
type SplitTender = { method: "cash" | "card" | "mobile_money"; amount: string };
type RefundMethod = "cash" | "card" | "mobile_money";

const posDraftSchema = z.object({
  sessionId: z.string().uuid(),
  lines: z.array(z.object({
    description: z.string().min(1).max(200),
    quantity: z.number().int().positive(),
    unitPriceMinor: z.number().int().nonnegative(),
    sku: z.string().min(1).max(80).optional(),
  })).min(1).max(100),
  customerId: z.union([z.string().uuid(), z.literal("")]),
  method: z.enum(["cash", "card"]),
  cashReceived: z.string().max(32),
  splitMode: z.boolean().default(false),
  splitTenders: z.array(z.object({ method: z.enum(["cash", "card", "mobile_money"]), amount: z.string().max(32) })).max(3).default([]),
  awaitingApproval: z.boolean(),
  attemptUncertain: z.boolean().default(false),
  attemptIntentId: z.string().uuid().nullable().default(null),
});
type PosDraft = z.infer<typeof posDraftSchema>;

const parkedCartSchema = posDraftSchema.omit({ awaitingApproval: true, attemptUncertain: true, attemptIntentId: true }).extend({
  id: z.string().uuid(),
  parkedAt: z.string(),
  customerName: z.string(),
});
type ParkedCart = z.infer<typeof parkedCartSchema>;

const queuedSaleSchema = z.object({
  id: z.string().uuid(),
  intentId: z.string().uuid(),
  sessionId: z.string().uuid(),
  lines: posDraftSchema.shape.lines,
  customerId: z.union([z.string().uuid(), z.literal("")]),
  method: z.enum(["cash", "card"]),
  tenders: z.array(z.object({ method: z.enum(["cash", "card", "mobile_money"]), amountMinor: z.number().int().positive() })).min(1).max(3),
  cashReceivedMinor: z.number().int().nonnegative().nullable(),
  totalMinor: z.number().int().positive(),
  queuedAt: z.string(),
  status: z.enum(["queued", "failed", "uncertain"]),
  errorMessage: z.string().max(500).nullable(),
});
type QueuedSale = z.infer<typeof queuedSaleSchema>;

const STATUS_TONES: Record<string, string> = {
  open: "pos-pill-green",
  posted: "pos-pill-green",
  paid: "pos-pill-green",
  settled: "pos-pill-green",
  reconciled: "pos-pill-green",
  balanced: "pos-pill-green",
  void: "pos-pill-red",
  voided: "pos-pill-red",
  failed: "pos-pill-red",
  pending: "pos-pill-amber",
  partial: "pos-pill-amber",
  credited: "pos-pill-amber",
  unreconciled: "pos-pill-amber",
  credit_review: "pos-pill-gold",
  closed: "pos-pill-neutral",
};

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
    try { symbol = new Intl.NumberFormat("en-US", { style: "currency", currency: code }).formatToParts(0).find((part) => part.type === "currency")?.value; }
    catch { symbol = `${code} `; }
  }
  return { symbol: symbol ?? `${code} `, minorUnits: currencyMinorUnits(code) ?? 2 };
}

function formatMoney(minor: number, currency: CurrencyStyle): string {
  const formatted = (Math.abs(minor) / (10 ** currency.minorUnits)).toLocaleString("en-US", {
    minimumFractionDigits: currency.minorUnits,
    maximumFractionDigits: currency.minorUnits,
  });
  return `${minor < 0 ? "−" : ""}${currency.symbol}${formatted}`;
}

function toMinor(amount: string, minorUnits: number): number {
  return Math.round(Number(amount || "0") * 10 ** minorUnits);
}

function minorToInput(minor: number, minorUnits: number): string {
  return String(minor / 10 ** minorUnits);
}

function formatStatus(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusPill(status: string): string {
  return STATUS_TONES[status.toLowerCase()] ?? "pos-pill-neutral";
}

function formatMethod(method: string): string {
  return method.replaceAll("_", " ");
}

function timeAgo(iso: string): string {
  const then = new Date(iso).valueOf();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function readTab(search: string): Tab {
  const requested = new URLSearchParams(search).get("tab");
  return requested && TABS.includes(requested as Tab) ? (requested as Tab) : "overview";
}

function syncTabUrl(tab: Tab): void {
  const url = new URL(window.location.href);
  url.searchParams.set("tab", tab);
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}

function noticeFor(error: unknown, hint: string): Notice {
  if (error instanceof PosApiError) {
    return { tone: "error", title: error.message, hint: error.status === 401 ? "Sign in again to continue at the register." : hint };
  }
  return { tone: "error", title: "Could not reach the POS service.", hint };
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function lineTotalMinor(line: DraftLine): number {
  return Math.round((line.quantity * line.unitPriceMinor) / 1000);
}

function saleLineTotalMinor(line: PosSaleLine): number {
  return Math.round((line.quantity * line.unitPriceMinor) / 1000) + line.taxMinor;
}

export function PosPage({ baseCurrency = null, actorId = null, organizationId = null, useGoCompleteSale, useGoReturnSale }: { baseCurrency?: string | null; actorId?: string | null; organizationId?: string | null; useGoCompleteSale?: boolean; useGoReturnSale?: boolean }) {
  const currency = useMemo(() => currencyFor(baseCurrency), [baseCurrency]);
  const digits = currency.minorUnits;
  const scale = 10 ** digits;
  const money = useCallback((minor: number) => formatMoney(minor, currency), [currency]);

  const [tab, setTab] = useState<Tab>(() => readTab(window.location.search));
  const [modules, setModules] = useState<{ pos: boolean; inventory: boolean } | null>(null);
  const [moduleError, setModuleError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<PosRegisterSession[] | null>(null);
  const [sales, setSales] = useState<PosSale[]>([]);
  const [registerStateLoaded, setRegisterStateLoaded] = useState(false);
  const [registerStateScope, setRegisterStateScope] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [summary, setSummary] = useState<PosShiftSummary | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(true);

  const [catalog, setCatalog] = useState<PosCatalogItem[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogUpdatedAt, setCatalogUpdatedAt] = useState<string | null>(null);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [favoriteSkus, setFavoriteSkus] = useState<string[]>([]);
  const catalogInputRef = useRef<HTMLInputElement>(null);

  const [float, setFloat] = useState("100");
  const [line, setLine] = useState({ description: "", price: "" });
  const [customLineOpen, setCustomLineOpen] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [activeLineIndex, setActiveLineIndex] = useState<number | null>(null);
  const [salePendingApproval, setSalePendingApproval] = useState(false);
  const [saleAttemptUncertain, setSaleAttemptUncertain] = useState(false);
  const [saleAttemptIntentId, setSaleAttemptIntentId] = useState<string | null>(null);
  const saleLocked = salePendingApproval || saleAttemptUncertain || saleAttemptIntentId !== null;
  const [method, setMethod] = useState<"cash" | "card">("cash");
  const [splitMode, setSplitMode] = useState(false);
  const [splitTenders, setSplitTenders] = useState<SplitTender[]>([
    { method: "cash", amount: "" },
    { method: "card", amount: "" },
  ]);
  const [cashReceived, setCashReceived] = useState("");

  const [counted, setCounted] = useState("");
  const [countByDenomination, setCountByDenomination] = useState(false);
  const [denominationCounts, setDenominationCounts] = useState<Record<string, string>>({});
  const [varianceReason, setVarianceReason] = useState("");
  const [closeConfirm, setCloseConfirm] = useState(false);

  const [customers, setCustomers] = useState<PosCustomer[]>([]);
  const [customerError, setCustomerError] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState("");
  const [customerQuery, setCustomerQuery] = useState("");

  const [draftToRestore, setDraftToRestore] = useState<PosDraft | null>(null);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const [parkedCarts, setParkedCarts] = useState<ParkedCart[]>([]);
  const [parkedCartsLoaded, setParkedCartsLoaded] = useState(false);
  const [queuedSales, setQueuedSales] = useState<QueuedSale[]>([]);
  const [queuedSalesLoaded, setQueuedSalesLoaded] = useState(false);
  const [queuedSaleBusyId, setQueuedSaleBusyId] = useState<string | null>(null);
  const [discardQueuedId, setDiscardQueuedId] = useState<string | null>(null);
  const [quickProductOpen, setQuickProductOpen] = useState(false);
  const [quickProductAdvancedOpen, setQuickProductAdvancedOpen] = useState(false);
  const [quickProduct, setQuickProduct] = useState({ name: "", sku: "", barcode: "", price: "", openingStock: "", unitLabel: "unit" });
  const [returnTarget, setReturnTarget] = useState<PosSale | null>(null);
  const [returnAttemptUncertain, setReturnAttemptUncertain] = useState(false);
  const [returnAttemptPending, setReturnAttemptPending] = useState(false);
  const [returnAttemptAction, setReturnAttemptAction] = useState<PosReturnAction | null>(null);
  const [returnRecoveryBlocked, setReturnRecoveryBlocked] = useState(false);
  const [returnReason, setReturnReason] = useState("");
  const [returnQuantities, setReturnQuantities] = useState<Record<string, string>>({});
  const [refundMethod, setRefundMethod] = useState<RefundMethod>("cash");
  const [receiptPreview, setReceiptPreview] = useState<{ text: string; customerName: string; customerEmail: string | null } | null>(null);
  const [receiptReady, setReceiptReady] = useState<{ text: string; customerName: string; customerEmail: string | null } | null>(null);
  const [receiptShareFeedback, setReceiptShareFeedback] = useState<string | null>(null);
  const wasOnline = useRef(true);
  const returnRecoveryScope = useRef<string | null>(null);
  const returnAttemptLocked = returnAttemptPending || returnAttemptUncertain;

  const openSession = useMemo(() => sessions?.find((session) => session.status === "open") ?? null, [sessions]);
  const openSessionId = openSession?.id ?? null;
  const selectedCustomer = useMemo(() => customers.find((customer) => customer.id === customerId) ?? null, [customers, customerId]);
  const inventoryEnabled = modules?.inventory ?? false;
  const workspaceParkedCarts = useMemo(
    () => parkedCarts.filter((cart) => sessions?.some((session) => session.id === cart.sessionId)),
    [parkedCarts, sessions],
  );

  const changeTab = useCallback((next: Tab) => {
    setTab(next);
    syncTabUrl(next);
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const state = await fetchPosRegisterState(signal);
      if (signal?.aborted) return;
      setSessions(state.sessions);
      setSales(state.sales);
      setRegisterStateLoaded(true);
      setRegisterStateScope(actorId && organizationId ? `${organizationId}:${actorId}` : null);
      setLoadError(null);
    } catch (error) {
      if (signal?.aborted) return;
      setLoadError(noticeFor(error, "Your register history is still on file. Check the connection, then retry.").title);
    }
  }, [actorId, organizationId]);

  const loadCatalog = useCallback(async (signal?: AbortSignal) => {
    if (!modules?.inventory) {
      setCatalog([]);
      setCatalogError(null);
      setCatalogLoading(false);
      return;
    }
    setCatalogLoading(true);
    try {
      const items = await fetchPosCatalog(signal);
      if (signal?.aborted) return;
      setCatalog(items);
      setCatalogUpdatedAt(new Date().toISOString());
      setCatalogError(null);
    } catch (error) {
      if (signal?.aborted) return;
      setCatalog([]);
      setCatalogError(noticeFor(error, "You can still add an untracked item.").title);
    } finally {
      if (!signal?.aborted) setCatalogLoading(false);
    }
  }, [modules?.inventory]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchPosModules(controller.signal)
      .then((resolved) => { if (!controller.signal.aborted) { setModules(resolved); setModuleError(null); } })
      .catch((error: unknown) => { if (!controller.signal.aborted) setModuleError(noticeFor(error, "The module switchboard could not be read. Try again.").title); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    void fetchPosCustomers(controller.signal)
      .then((resolved) => { if (!controller.signal.aborted) { setCustomers(resolved); setCustomerError(null); } })
      .catch((error: unknown) => { if (!controller.signal.aborted) setCustomerError(noticeFor(error, "Continue as a walk-in, or add the customer in CRM.").title); });
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (!registerStateLoaded || !actorId || !organizationId) return;
    const scopeId = `${organizationId}:${actorId}`;
    if (registerStateScope !== scopeId) return;
    if (returnRecoveryScope.current === scopeId) return;
    returnRecoveryScope.current = scopeId;
    void restorePosReturnAttempt(scopeId).then((attempt) => {
      if (returnRecoveryScope.current !== scopeId) return;
      if (!attempt) {
        setReturnRecoveryBlocked(false);
        return;
      }
      const target = sales.find((sale) => sale.id === attempt.action.invoiceId);
      if (!target) {
        setReturnRecoveryBlocked(true);
        setNotice({ tone: "error", title: "An unresolved return needs review", hint: "Its sale is not in the current register list. Refresh the register or verify the return in approvals before requesting another refund." });
        return;
      }
      setReturnRecoveryBlocked(false);
      setReturnTarget(target);
      setReturnAttemptAction(attempt.action);
      setReturnReason(attempt.action.reason);
      setRefundMethod(attempt.action.refundMethod);
      setReturnQuantities(Object.fromEntries((attempt.action.lines ?? []).flatMap((line) => {
        const saleLine = target.lines.find((entry) => entry.id === line.invoiceLineId);
        return saleLine ? [[saleLine.id, String(line.quantity / 1000)]] : [];
      })));
      setReturnAttemptPending(attempt.status === "pending");
      setReturnAttemptUncertain(attempt.status === "uncertain");
      setNotice(attempt.status === "pending"
        ? { tone: "pending", title: `Return of sale #${target.number} is waiting for approval.`, hint: "The exact request and its identity have been restored. Retry it safely to check for completion." }
        : { tone: "error", title: "Return result is unknown", hint: "The exact request and its identity have been restored. Retry it or verify the sale before starting another return." });
    }).catch(() => {
      if (returnRecoveryScope.current === scopeId) {
        setReturnRecoveryBlocked(true);
        setNotice({ tone: "error", title: "Could not restore the return attempt", hint: "Refresh the page or verify the sale before requesting another refund." });
      }
    });
  }, [actorId, organizationId, sales, registerStateLoaded, registerStateScope]);

  useEffect(() => {
    if (modules === null) return;
    const controller = new AbortController();
    void loadCatalog(controller.signal);
    return () => controller.abort();
  }, [modules, loadCatalog]);

  useEffect(() => {
    if (online && !wasOnline.current) void loadCatalog();
    wasOnline.current = online;
  }, [online, loadCatalog]);

  useEffect(() => {
    const storageKey = posStorageKey("cart", actorId, organizationId);
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = posDraftSchema.safeParse(JSON.parse(stored));
        if (parsed.success) setDraftToRestore(parsed.data);
        else localStorage.removeItem(storageKey);
      }
    } catch {
      localStorage.removeItem(storageKey);
    }
    setDraftLoaded(true);
    const updateOnline = () => setOnline(navigator.onLine);
    const reportOnline = () => {
      setOnline(true);
      setNotice({ tone: "pending", title: "Connection restored.", hint: "Review queued sales and send them when you are ready." });
    };
    updateOnline();
    window.addEventListener("online", reportOnline);
    window.addEventListener("offline", updateOnline);
    return () => {
      window.removeEventListener("online", reportOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, [actorId, organizationId]);

  useEffect(() => {
    setRegisterStateLoaded(false);
    try {
      const stored = localStorage.getItem("chaste.pos.favorite-items.v1");
      const parsed: unknown = stored ? JSON.parse(stored) : [];
      if (Array.isArray(parsed) && parsed.every((sku): sku is string => typeof sku === "string")) setFavoriteSkus(parsed.slice(0, 30));
    } catch {
      localStorage.removeItem("chaste.pos.favorite-items.v1");
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("chaste.pos.favorite-items.v1", JSON.stringify(favoriteSkus));
  }, [favoriteSkus]);

  useEffect(() => {
    const storageKey = posStorageKey("parked-carts", actorId, organizationId);
    try {
      const stored = localStorage.getItem(storageKey);
      const parsed = z.array(parkedCartSchema).max(20).safeParse(stored ? JSON.parse(stored) : []);
      if (parsed.success) setParkedCarts(parsed.data);
      else localStorage.removeItem(storageKey);
    } catch {
      localStorage.removeItem(storageKey);
    }
    setParkedCartsLoaded(true);
  }, [actorId, organizationId]);

  useEffect(() => {
    if (!parkedCartsLoaded) return;
    try {
      localStorage.setItem(posStorageKey("parked-carts", actorId, organizationId), JSON.stringify(parkedCarts));
    } catch {
      setNotice({ tone: "error", title: "Parked carts could not be saved", hint: "Free some browser storage or keep this sale open before continuing." });
    }
  }, [actorId, organizationId, parkedCarts, parkedCartsLoaded]);

  useEffect(() => {
    const storageKey = posStorageKey("queued-sales", actorId, organizationId);
    try {
      const stored = localStorage.getItem(storageKey);
      const parsed = z.array(queuedSaleSchema).max(20).safeParse(stored ? JSON.parse(stored) : []);
      if (parsed.success) setQueuedSales(parsed.data);
      else localStorage.removeItem(storageKey);
    } catch {
      localStorage.removeItem(storageKey);
    }
    setQueuedSalesLoaded(true);
  }, [actorId, organizationId]);

  useEffect(() => {
    if (!queuedSalesLoaded) return;
    try {
      localStorage.setItem(posStorageKey("queued-sales", actorId, organizationId), JSON.stringify(queuedSales));
    } catch {
      setNotice({ tone: "error", title: "Queued sales could not be saved", hint: "Free browser storage before taking an offline sale." });
    }
  }, [actorId, organizationId, queuedSales, queuedSalesLoaded]);

  useEffect(() => {
    if (!sessions || !draftLoaded) return;
    if (!draftToRestore) {
      setDraftReady(true);
      return;
    }
    if (openSessionId && draftToRestore.sessionId === openSessionId) {
      setLines(draftToRestore.lines);
      setCustomerId(draftToRestore.customerId);
      setMethod(draftToRestore.method);
      setCashReceived(draftToRestore.cashReceived);
      setSplitMode(draftToRestore.splitMode);
      setSplitTenders(draftToRestore.splitTenders);
      setSalePendingApproval(draftToRestore.awaitingApproval);
      setSaleAttemptIntentId(draftToRestore.attemptIntentId);
      setSaleAttemptUncertain(draftToRestore.attemptUncertain || draftToRestore.attemptIntentId !== null);
    } else {
      localStorage.removeItem(posStorageKey("cart", actorId, organizationId));
    }
    setDraftToRestore(null);
    setDraftReady(true);
  }, [actorId, organizationId, sessions, openSessionId, draftToRestore, draftLoaded]);

  useEffect(() => {
    if (!draftReady) return;
    if (openSessionId && lines.length > 0) {
      localStorage.setItem(posStorageKey("cart", actorId, organizationId), JSON.stringify({
        sessionId: openSessionId,
        lines,
        customerId,
        method,
        cashReceived,
        splitMode,
        splitTenders,
        awaitingApproval: salePendingApproval,
        attemptUncertain: saleAttemptUncertain,
        attemptIntentId: saleAttemptIntentId,
      } satisfies PosDraft));
    } else {
      localStorage.removeItem(posStorageKey("cart", actorId, organizationId));
    }
  }, [actorId, organizationId, draftReady, openSessionId, lines, customerId, method, cashReceived, splitMode, splitTenders, salePendingApproval, saleAttemptUncertain, saleAttemptIntentId]);

  useEffect(() => {
    if (openSessionId === null) {
      setSummary(null);
      return;
    }
    let active = true;
    void fetchPosShiftSummary(openSessionId)
      .then((resolved) => { if (active) setSummary(resolved); })
      .catch(() => { if (active) setSummary(null); });
    return () => { active = false; };
  }, [openSessionId, sessions]);

  const focusCatalogField = useCallback(() => {
    const input = catalogInputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    input.scrollIntoView?.({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, []);

  useEffect(() => {
    if (tab !== "sell" || !openSessionId) return;
    const onShortcut = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === "Enter") {
        event.preventDefault();
        document.getElementById("pos-complete-sale")?.click();
      } else if (event.ctrlKey && event.key === "Backspace" && activeLineIndex !== null) {
        event.preventDefault();
        if (saleLocked) return;
        setLines((current) => current.filter((_, index) => index !== activeLineIndex));
        setActiveLineIndex(null);
      } else if (event.altKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        document.getElementById("pos-park-cart")?.click();
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [tab, openSessionId, activeLineIndex, saleLocked]);

  const openSessions = useMemo(() => (sessions ?? []).filter((session) => session.status === "open"), [sessions]);
  const varianceSessions = useMemo(() => (sessions ?? []).filter((session) => session.varianceMinor !== null && session.varianceMinor !== 0), [sessions]);
  const closedToday = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return (sessions ?? []).filter((session) => session.closedAt && new Date(session.closedAt).valueOf() >= start.valueOf());
  }, [sessions]);

  const total = useMemo(() => lines.reduce((sum, entry) => sum + lineTotalMinor(entry), 0), [lines]);
  const expectedCash = openSession ? openSession.openingFloatMinor + (openSession.expectedCashMinor ?? 0) : 0;
  const tenderedMinor = method === "cash" && cashReceived.trim() ? Math.max(0, toMinor(cashReceived, digits)) : total;
  const splitAmounts = splitTenders.map((tender) => (tender.amount.trim() ? toMinor(tender.amount, digits) : 0));
  const splitAllocatedMinor = splitAmounts.reduce((sum, amount) => sum + (Number.isSafeInteger(amount) && amount > 0 ? amount : 0), 0);
  const splitCashAllocatedMinor = splitTenders.reduce((sum, tender, index) => sum + (tender.method === "cash" ? splitAmounts[index] ?? 0 : 0), 0);
  const splitCashReceivedMinor = cashReceived.trim() ? toMinor(cashReceived, digits) : splitCashAllocatedMinor;
  const splitTenderRowsComplete = splitTenders.length > 1
    && splitTenders.every((tender, index) => tender.amount.trim() !== "" && (splitAmounts[index] ?? 0) > 0);
  const checkoutReady = splitMode
    ? splitTenderRowsComplete && splitAllocatedMinor === total && (splitCashAllocatedMinor === 0 || splitCashReceivedMinor >= splitCashAllocatedMinor)
    : method !== "cash" || tenderedMinor >= total;
  const changeDueMinor = splitMode ? Math.max(0, splitCashReceivedMinor - splitCashAllocatedMinor) : Math.max(0, tenderedMinor - total);
  const splitCheckoutStatus = splitAllocatedMinor < total
    ? `Remaining ${money(total - splitAllocatedMinor)}`
    : splitAllocatedMinor > total
      ? `Over by ${money(splitAllocatedMinor - total)}`
      : !splitTenderRowsComplete
        ? "Enter amounts"
        : splitCashReceivedMinor < splitCashAllocatedMinor
          ? `Cash short ${money(splitCashAllocatedMinor - splitCashReceivedMinor)}`
          : "Complete sale";

  const denominations = useMemo(
    () => (digits === 0
      ? [50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50]
      : [100, 50, 20, 10, 5, 1, 0.5, 0.25]).map((amount) => Math.round(amount * scale)),
    [digits, scale],
  );
  const denominationTotalMinor = useMemo(() => denominations.reduce((sum, amount) => {
    const count = Number(denominationCounts[String(amount)] ?? "");
    return sum + (Number.isSafeInteger(count) && count > 0 ? count * amount : 0);
  }, 0), [denominations, denominationCounts]);
  const hasCashCount = countByDenomination
    ? Object.values(denominationCounts).some((value) => value !== "")
    : counted !== "";
  const countedCashMinor = countByDenomination ? denominationTotalMinor : counted.trim() ? toMinor(counted, digits) : 0;
  const liveVariance = hasCashCount ? countedCashMinor - expectedCash : null;
  const cashPresets = digits === 0
    ? [{ label: "+1,000", amountMinor: 1000 }, { label: "+5,000", amountMinor: 5000 }]
    : [{ label: "+5", amountMinor: 5 * scale }, { label: "+10", amountMinor: 10 * scale }];

  const catalogResults = useMemo(() => {
    const query = catalogQuery.trim().toLowerCase();
    if (!query) return [];
    return catalog
      .filter((item) => `${item.name} ${item.sku} ${item.kind} ${item.barcode ?? ""} ${item.tags.join(" ")}`.toLowerCase().includes(query))
      .slice(0, 8);
  }, [catalog, catalogQuery]);
  const catalogTags = useMemo(() => [...new Set(catalog.flatMap((item) => item.tags))].slice(0, 5), [catalog]);
  const customerResults = useMemo(() => {
    const query = customerQuery.trim().toLowerCase();
    if (!query) return [];
    return customers.filter((customer) => `${customer.name} ${customer.email ?? ""}`.toLowerCase().includes(query)).slice(0, 6);
  }, [customers, customerQuery]);

  async function openRegister() {
    setBusy(true);
    try {
      const outcome = await openPosSession({ action: "open", openingFloatMinor: Math.max(0, toMinor(float, digits)) });
      if (outcome.kind === "pending") {
        setNotice({ tone: "pending", title: "Opening the register is waiting for approval.", hint: outcome.reason });
        return;
      }
      setNotice({ tone: "success", title: "Register session opened." });
      await load();
    } catch (error) {
      setNotice(noticeFor(error, "Check the opening float and try again."));
    } finally {
      setBusy(false);
    }
  }

  async function closeRegister() {
    if (!openSessionId) return;
    setBusy(true);
    try {
      const outcome = await closePosSession({
        action: "close",
        sessionId: openSessionId,
        countedCashMinor: Math.max(0, countedCashMinor),
        ...(liveVariance !== null && liveVariance !== 0 ? { varianceReason: varianceReason.trim() } : {}),
      });
      if (outcome.kind === "pending") {
        setNotice({ tone: "pending", title: "Closing the register is waiting for approval.", hint: outcome.reason });
        return;
      }
      const { expectedCashMinor, varianceMinor, flagged } = outcome.data;
      const drawerExpected = expectedCashMinor || expectedCash;
      setNotice(varianceMinor === 0
        ? { tone: "success", title: `Drawer balanced exactly at ${money(drawerExpected)}.` }
        : {
            tone: "error",
            title: `Drawer variance of ${money(varianceMinor)} recorded`,
            hint: `Expected ${money(drawerExpected)}. ${flagged ? "This shift is flagged for review. " : ""}Your explanation is attached to this shift.`,
          });
      setCounted("");
      setVarianceReason("");
      setDenominationCounts({});
      setLines([]);
      await load();
    } catch (error) {
      setNotice(noticeFor(error, "Recount the drawer and try again."));
    } finally {
      setBusy(false);
    }
  }

  function clearCart() {
    setLines([]);
    setCustomerId("");
    setCustomerQuery("");
    setCashReceived("");
    setSplitMode(false);
    setSplitTenders([{ method: "cash", amount: "" }, { method: "card", amount: "" }]);
    setSalePendingApproval(false);
    setSaleAttemptUncertain(false);
    setSaleAttemptIntentId(null);
  }

  function parkCurrentCart() {
    if (lines.length === 0 || !openSessionId || saleLocked) return;
    if (parkedCarts.length >= 20) {
      setNotice({ tone: "error", title: "Parked cart limit reached", hint: "Resume or remove a parked cart before parking another. Up to 20 carts are kept on this device." });
      return;
    }
    const parked: ParkedCart = {
      id: crypto.randomUUID(),
      parkedAt: new Date().toISOString(),
      sessionId: openSessionId,
      lines,
      customerId,
      customerName: selectedCustomer?.name ?? "Walk-in customer",
      method,
      cashReceived,
      splitMode,
      splitTenders,
    };
    setParkedCarts((current) => [parked, ...current]);
    clearCart();
    setNotice({ tone: "success", title: `Cart for ${parked.customerName} parked on this device.` });
  }

  function resumeParkedCart(parked: ParkedCart) {
    if (lines.length > 0) return;
    setLines(parked.lines);
    setCustomerId(customers.some((customer) => customer.id === parked.customerId) ? parked.customerId : "");
    setMethod(parked.method);
    setCashReceived(parked.cashReceived);
    setSplitMode(parked.splitMode);
    setSplitTenders(parked.splitTenders);
    setSalePendingApproval(false);
    setSaleAttemptUncertain(false);
    setSaleAttemptIntentId(null);
    setParkedCarts((current) => current.filter((cart) => cart.id !== parked.id));
    setNotice({ tone: "success", title: `Cart for ${parked.customerName} resumed. Review stock and total before checkout.` });
    requestAnimationFrame(focusCatalogField);
  }

  function addCatalogItem(item: PosCatalogItem) {
    const existingQuantity = lines.find((entry) => entry.sku === item.sku)?.quantity ?? 0;
    const available = item.kind === "service" ? Number.MAX_SAFE_INTEGER : Math.max(0, item.availableThousandths - existingQuantity);
    const quantity = Math.min(1000, available);
    if (quantity <= 0) {
      setNotice({ tone: "error", title: "No stock available", hint: `${item.name} has no available stock to sell.` });
      return;
    }
    setLines((current) => {
      const existingIndex = current.findIndex((entry) => entry.sku === item.sku);
      if (existingIndex < 0) return [...current, { description: item.name, sku: item.sku, quantity, unitPriceMinor: item.salePriceMinor }];
      return current.map((entry, index) => index === existingIndex
        ? { ...entry, quantity: Math.min(entry.quantity + quantity, item.kind === "service" ? Number.MAX_SAFE_INTEGER : item.availableThousandths) }
        : entry);
    });
    setCatalogQuery("");
    requestAnimationFrame(focusCatalogField);
  }

  function updateQuantity(index: number, value: string) {
    const units = Number(value);
    if (!Number.isFinite(units) || units <= 0) return;
    const quantity = Math.round(units * 1000);
    const sku = lines[index]?.sku;
    const item = sku ? catalog.find((candidate) => candidate.sku === sku) : undefined;
    if (item && item.kind !== "service" && quantity > item.availableThousandths) {
      setNotice({ tone: "error", title: "That is more than the available stock", hint: `${item.name} has ${item.availableThousandths / 1000} ${item.unitLabel} available.` });
      return;
    }
    setLines((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, quantity } : entry));
  }

  function addCustomLine(event: React.FormEvent) {
    event.preventDefault();
    if (!line.description.trim() || line.price === "" || !Number.isFinite(Number(line.price)) || Number(line.price) < 0) return;
    setLines((current) => [...current, { description: line.description.trim(), quantity: 1000, unitPriceMinor: toMinor(line.price, digits) }]);
    setLine({ description: "", price: "" });
    setCustomLineOpen(false);
  }

  function tenderPayload(): Array<{ method: "cash" | "card" | "mobile_money"; amountMinor: number }> {
    if (!splitMode) return [{ method, amountMinor: total }];
    return splitTenders.map((tender, index) => ({ method: tender.method, amountMinor: splitAmounts[index] ?? 0 }));
  }

  function cashReceivedMinor(): number | undefined {
    if (splitMode) return splitCashAllocatedMinor > 0 ? splitCashReceivedMinor : undefined;
    return method === "cash" ? tenderedMinor : undefined;
  }

  function currentSaleAction(): PosSaleAction | null {
    if (!openSessionId || lines.length === 0) return null;
    const received = cashReceivedMinor();
    return {
      action: "sale",
      sessionId: openSessionId,
      method,
      lines: lines.map((entry) => ({
        description: entry.description,
        quantity: entry.quantity,
        unitPriceMinor: entry.unitPriceMinor,
        ...(entry.sku ? { sku: entry.sku } : {}),
      })),
      tenders: tenderPayload(),
      ...(customerId ? { customerId } : {}),
      ...(received !== undefined ? { cashReceivedMinor: received } : {}),
    };
  }

  async function completeCurrentSale() {
    if (!openSessionId || lines.length === 0 || salePendingApproval || !online || !checkoutReady) return;
    setBusy(true);
    try {
      const action = currentSaleAction();
      if (!action) return;
      const attemptIntentId = saleAttemptIntentId ?? crypto.randomUUID();
      setSaleAttemptIntentId(attemptIntentId);
      setSaleAttemptUncertain(true);
      try {
        localStorage.setItem(posStorageKey("cart", actorId, organizationId), JSON.stringify({
          sessionId: action.sessionId,
          lines,
          customerId,
          method,
          cashReceived,
          splitMode,
          splitTenders,
          awaitingApproval: false,
          attemptUncertain: true,
          attemptIntentId,
        } satisfies PosDraft));
      } catch {
        setSaleAttemptIntentId(null);
        setSaleAttemptUncertain(false);
        setNotice({ tone: "error", title: "Sale could not be started safely", hint: "Free browser storage before sending so this exact sale can be retried if the connection drops." });
        return;
      }
      const outcome = await submitPosSale(action, attemptIntentId, undefined, { scopeId: actorId, useGo: useGoCompleteSale });
      if (outcome.kind === "pending") {
        setSalePendingApproval(true);
        setSaleAttemptUncertain(false);
        setNotice({ tone: "pending", title: "This sale is waiting for approval.", hint: `${outcome.reason} Check Approvals before resubmitting it.` });
        return;
      }
      const result = outcome.data;
      const paymentSummary = result.tenders.map((tender) => `${formatMethod(tender.method)} ${money(tender.amountMinor)}`).join(" + ") || formatMethod(method);
      const receiptName = selectedCustomer?.name ?? "Walk-in customer";
      setSalePendingApproval(false);
      setSaleAttemptUncertain(false);
      setSaleAttemptIntentId(null);
      setLines([]);
      setCashReceived("");
      setSplitMode(false);
      setSplitTenders([{ method: "cash", amount: "" }, { method: "card", amount: "" }]);
      setActiveLineIndex(null);
      setReceiptReady({
        customerName: receiptName,
        customerEmail: selectedCustomer?.email ?? null,
        text: [
          `Chaste BusinessOS · Sale #${result.invoiceNumber ?? ""}`,
          `Date: ${new Date().toLocaleString()}`,
          `Customer: ${receiptName}`,
          ...lines.map((entry) => `${entry.quantity / 1000} × ${entry.description} · ${money(lineTotalMinor(entry))}`),
          `Total: ${money(result.totalMinor)}`,
          `Payment: ${paymentSummary}`,
          ...(result.changeGivenMinor > 0 ? [`Cash received: ${money(result.tenderedMinor)}`, `Change: ${money(result.changeGivenMinor)}`] : []),
          "Thank you for your purchase.",
        ].join("\n"),
      });
      setNotice({
        tone: "success",
        title: `Sale${result.invoiceNumber ? ` #${result.invoiceNumber}` : ""} recorded for ${money(result.totalMinor)} (${paymentSummary}).`,
        ...(result.changeGivenMinor > 0 ? { hint: `Change due ${money(result.changeGivenMinor)}.` } : {}),
      });
      await load();
    } catch (error) {
      const status = error instanceof PosApiError ? error.status : 0;
      const definitiveRefusal = status >= 400 && status < 500 && status !== 408;
      setSaleAttemptUncertain(!definitiveRefusal);
      if (definitiveRefusal) setSaleAttemptIntentId(null);
      if (!definitiveRefusal) {
        setNotice({ tone: "error", title: "Sale status is not confirmed", hint: "The cart is locked to this attempt. Retry it with the same request identity, or check Sales and Approvals before abandoning it." });
      } else {
        setNotice(noticeFor(error, "Check the sale lines and payment amounts before submitting."));
      }
    } finally {
      setBusy(false);
    }
  }

  async function startAnotherSale() {
    const pendingAction = currentSaleAction();
    if (pendingAction) {
      try {
        await clearPosSaleRetryIntent(pendingAction, actorId, saleAttemptIntentId ?? undefined);
      } catch {
        setNotice({ tone: "error", title: "Could not reset this sale attempt", hint: "Keep this cart open and try again before starting another sale." });
        return;
      }
    }
    clearCart();
    setCatalogQuery("");
    requestAnimationFrame(focusCatalogField);
  }

  function queueCurrentSaleOffline() {
    if (!openSession || online || lines.length === 0 || saleLocked || !checkoutReady || total <= 0) return;
    if (!queuedSalesLoaded || queuedSales.length >= 20) {
      setNotice({
        tone: "error",
        title: queuedSalesLoaded ? "Offline sale queue is full" : "Offline storage is still loading",
        hint: queuedSalesLoaded ? "Send or discard a queued sale before adding another. Up to 20 sales are kept on this device." : "Wait a moment, then try again.",
      });
      return;
    }
    const queued: QueuedSale = {
      id: crypto.randomUUID(),
      intentId: crypto.randomUUID(),
      sessionId: openSession.id,
      lines,
      customerId,
      method,
      tenders: tenderPayload(),
      cashReceivedMinor: cashReceivedMinor() ?? null,
      totalMinor: total,
      queuedAt: new Date().toISOString(),
      status: "queued",
      errorMessage: null,
    };
    const next = [queued, ...queuedSales];
    try {
      localStorage.setItem(posStorageKey("queued-sales", actorId, organizationId), JSON.stringify(next));
    } catch {
      setNotice({ tone: "error", title: "Offline sale could not be saved", hint: "Free browser storage before taking an offline sale. Nothing was charged." });
      return;
    }
    setQueuedSales(next);
    clearCart();
    setNotice({ tone: "pending", title: `Sale saved to this device for ${money(queued.totalMinor)}.`, hint: "It has not been charged or deducted from stock." });
  }

  async function retryQueuedSale(queued: QueuedSale) {
    if (!online || queuedSaleBusyId) return;
    const session = (sessions ?? []).find((candidate) => candidate.id === queued.sessionId);
    if (!session || session.status !== "open") {
      const message = "The register used for this queued sale is no longer open. Open that register or contact your manager before sending it.";
      setQueuedSales((current) => current.map((sale) => sale.id === queued.id ? { ...sale, status: "failed", errorMessage: message } : sale));
      setNotice({ tone: "error", title: "Register session is closed", hint: message });
      return;
    }
    setQueuedSaleBusyId(queued.id);
    try {
      const action: PosSaleAction = {
        action: "sale",
        sessionId: queued.sessionId,
        method: queued.method,
        lines: queued.lines,
        tenders: queued.tenders,
        ...(queued.customerId ? { customerId: queued.customerId } : {}),
        ...(queued.cashReceivedMinor !== null ? { cashReceivedMinor: queued.cashReceivedMinor } : {}),
      };
      const outcome = await submitPosSale(action, queued.intentId, undefined, { scopeId: actorId, useGo: useGoCompleteSale });
      if (outcome.kind === "pending") {
        await clearPosSaleRetryIntent(action, actorId, queued.intentId);
        setQueuedSales((current) => current.filter((sale) => sale.id !== queued.id));
        setNotice({ tone: "pending", title: `Sale for ${money(queued.totalMinor)} was submitted and is waiting for approval.`, hint: "Check Approvals before taking payment again." });
        await load();
        return;
      }
      const paymentSummary = outcome.data.tenders.map((tender) => `${formatMethod(tender.method)} ${money(tender.amountMinor)}`).join(" + ") || formatMethod(queued.method);
      const receiptCustomer = customers.find((entry) => entry.id === queued.customerId);
      const receiptCustomerName = receiptCustomer?.name ?? "Walk-in customer";
      setQueuedSales((current) => current.filter((sale) => sale.id !== queued.id));
      setReceiptReady({
        customerName: receiptCustomerName,
        customerEmail: receiptCustomer?.email ?? null,
        text: [
          `Chaste BusinessOS · Sale #${outcome.data.invoiceNumber ?? ""}`,
          `Date: ${new Date().toLocaleString()}`,
          `Customer: ${receiptCustomerName}`,
          ...queued.lines.map((entry) => `${entry.quantity / 1000} × ${entry.description} · ${money(lineTotalMinor(entry))}`),
          `Total: ${money(outcome.data.totalMinor)}`,
          `Payment: ${paymentSummary}`,
          ...(outcome.data.changeGivenMinor > 0 ? [`Cash received: ${money(outcome.data.tenderedMinor)}`, `Change: ${money(outcome.data.changeGivenMinor)}`] : []),
          "Thank you for your purchase.",
        ].join("\n"),
      });
      setNotice({ tone: "success", title: `Queued sale${outcome.data.invoiceNumber ? ` #${outcome.data.invoiceNumber}` : ""} posted for ${money(outcome.data.totalMinor)}.`, hint: "Stock and prices were checked again." });
      await load();
    } catch (error) {
      const detail = noticeFor(error, "Review current stock, prices, and register status before retrying.");
      const status = error instanceof PosApiError ? error.status : 0;
      const malformedSuccess = status === 202 || (status >= 200 && status < 300);
      const uncertain = status === 0 || status === 408 || status >= 500 || malformedSuccess;
      setQueuedSales((current) => current.map((sale) => sale.id === queued.id ? { ...sale, status: uncertain ? "uncertain" : "failed", errorMessage: detail.title } : sale));
      setNotice(uncertain
        ? { tone: "error", title: "Queued sale result is not confirmed", hint: "The server may have accepted this sale. Keep the queued attempt and retry with the same identity, or verify Sales and Approvals before discarding it." }
        : detail);
    } finally {
      setQueuedSaleBusyId(null);
    }
  }

  async function discardQueuedSale() {
    if (!discardQueuedId) return;
    const queued = queuedSales.find((sale) => sale.id === discardQueuedId);
    if (queued) {
      const action: PosSaleAction = {
        action: "sale",
        sessionId: queued.sessionId,
        method: queued.method,
        lines: queued.lines,
        tenders: queued.tenders,
        ...(queued.customerId ? { customerId: queued.customerId } : {}),
        ...(queued.cashReceivedMinor !== null ? { cashReceivedMinor: queued.cashReceivedMinor } : {}),
      };
      try {
        await clearPosSaleRetryIntent(action, actorId, queued.intentId);
      } catch {
        setNotice({ tone: "error", title: "Queued attempt could not be retired", hint: "Keep the queued sale and retry discarding it when browser storage is available." });
        return;
      }
    }
    setQueuedSales((current) => current.filter((sale) => sale.id !== discardQueuedId));
    setDiscardQueuedId(null);
    setNotice(queued?.status === "uncertain"
      ? { tone: "success", title: "Queued attempt retired.", hint: "Verify Sales and Approvals before creating a replacement, since its result was unknown." }
      : { tone: "success", title: "Queued sale discarded.", hint: "Nothing was charged or posted." });
  }

  async function createQuickProduct() {
    const name = quickProduct.name.trim();
    if (!name) return;
    const sku = quickProduct.sku.trim() || `POS-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const unitLabel = quickProduct.unitLabel.trim() || "unit";
    const stockInput = quickProduct.openingStock.trim();
    const stockUnits = stockInput ? Number(stockInput) : 0;
    const stockThousandths = Math.round(stockUnits * 1000);
    const stockIsPrecise = stockInput === "" || /^(?:\d+(?:\.\d{0,3})?|\.\d{1,3})$/.test(stockInput);
    if (!stockIsPrecise || !Number.isFinite(stockUnits) || stockUnits < 0 || !Number.isSafeInteger(stockThousandths)) {
      setNotice({ tone: "error", title: "Check the opening stock quantity", hint: "Enter a non-negative quantity with up to three decimal places." });
      return;
    }
    setBusy(true);
    const blank = { name: "", sku: "", barcode: "", price: "", openingStock: "", unitLabel: "unit" };
    try {
      const barcode = quickProduct.barcode.trim();
      const outcome = await createPosQuickProduct({
        action: "createItem",
        sku,
        name,
        kind: "goods",
        unitLabel,
        salePriceMinor: Math.max(0, toMinor(quickProduct.price, digits)),
        ...(barcode ? { barcode } : {}),
      });
      if (outcome.kind === "pending") {
        setQuickProduct(blank);
        setQuickProductOpen(false);
        setNotice({ tone: "pending", title: `Adding ${name} is waiting for approval.`, hint: outcome.reason });
        return;
      }
      setQuickProduct(blank);
      setQuickProductOpen(false);
      if (stockThousandths <= 0) {
        setNotice({ tone: "success", title: `${name} is in the catalog with zero stock.`, hint: "Add an opening balance in Inventory before selling it." });
      } else {
        const stock = await adjustPosItemStock({
          action: "adjustStock",
          sku,
          quantityDelta: stockThousandths,
          note: "Opening stock from POS quick add",
        });
        setNotice(stock.kind === "pending"
          ? { tone: "pending", title: `${name} was added.`, hint: "Its opening stock is waiting for approval before the item can be sold." }
          : { tone: "success", title: `${name} is in the catalog with ${stockUnits} ${unitLabel} in opening stock.`, hint: "Scan its barcode or search to add it to this sale." });
      }
      await loadCatalog();
      requestAnimationFrame(focusCatalogField);
    } catch (error) {
      setNotice(noticeFor(error, "Review the item details and try again."));
    } finally {
      setBusy(false);
    }
  }

  const selectedReturnLines = useMemo(() => {
    if (returnTarget?.returnMode !== "itemized") return [];
    return returnTarget.lines.flatMap((line) => {
      const quantity = Math.round(Number(returnQuantities[line.id] ?? "0") * 1000);
      const remaining = line.quantity - line.returnedQuantity;
      if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > remaining) return [];
      const nextQuantity = line.returnedQuantity + quantity;
      const subtotalMinor = Math.round((nextQuantity * line.unitPriceMinor) / 1000) - Math.round((line.returnedQuantity * line.unitPriceMinor) / 1000);
      const taxMinor = Math.round((line.taxMinor * nextQuantity) / line.quantity) - Math.round((line.taxMinor * line.returnedQuantity) / line.quantity);
      return [{ invoiceLineId: line.id, quantity, refundMinor: subtotalMinor + taxMinor }];
    });
  }, [returnTarget, returnQuantities]);
  const selectedReturnTotalMinor = selectedReturnLines.reduce((sum, line) => sum + line.refundMinor, 0);
  const invalidReturnQuantity = returnTarget?.returnMode === "itemized" === true && returnTarget.lines.some((line) => {
    const value = returnQuantities[line.id];
    if (!value?.trim()) return false;
    const quantity = Number(value);
    return !Number.isFinite(quantity) || quantity < 0 || quantity > (line.quantity - line.returnedQuantity) / 1000;
  });
  const fullReturnMinor = returnTarget ? Math.max(0, returnTarget.totalMinor - returnTarget.creditedMinor) : 0;

  function returnAllRemaining() {
    if (!returnTarget || returnAttemptLocked) return;
    setReturnQuantities(Object.fromEntries(returnTarget.lines
      .filter((line) => line.quantity > line.returnedQuantity)
      .map((line) => [line.id, String((line.quantity - line.returnedQuantity) / 1000)])));
  }

  async function submitReturn() {
    if (!returnTarget) return;
    if (returnAttemptLocked && !returnAttemptAction) {
      setNotice({ tone: "error", title: "Return recovery is incomplete", hint: "Refresh the register before retrying or requesting another refund." });
      return;
    }
    let action = returnAttemptLocked ? returnAttemptAction : null;
    if (!action) {
      const trimmed = returnReason.trim();
      if (trimmed.length < 3 || trimmed.length > 500 || invalidReturnQuantity) {
        setNotice({ tone: "error", title: "Add a short reason", hint: "A return needs a reason between 3 and 500 characters for the audit trail." });
        return;
      }
      const lines = returnTarget.returnMode === "itemized"
        ? selectedReturnLines.map((line) => ({ invoiceLineId: line.invoiceLineId, quantity: line.quantity }))
        : undefined;
      if (returnTarget.returnMode === "itemized" && !lines?.length) {
        setNotice({ tone: "error", title: "Choose items to return", hint: "Enter a quantity for at least one sale item." });
        return;
      }
      action = {
        action: "returnSale",
        invoiceId: returnTarget.id,
        reason: trimmed,
        refundMethod,
        ...(lines ? { lines } : {}),
      };
      setReturnAttemptAction(action);
    }
    setBusy(true);
    try {
      const outcome = await requestPosReturn(action, undefined, { useGo: useGoReturnSale, scopeId: actorId && organizationId ? `${organizationId}:${actorId}` : null });
      if (outcome.kind === "pending") {
        setReturnAttemptPending(true);
        setReturnAttemptUncertain(false);
        setNotice({ tone: "pending", title: `Return of sale #${returnTarget.number} is waiting for approval.`, hint: `${outcome.reason} It posts after someone approves it.` });
      } else {
        setReturnAttemptPending(false);
        setReturnAttemptUncertain(false);
        setReturnAttemptAction(null);
        setNotice({
          tone: "success",
          title: `Return posted, ${money(outcome.data.refundMinor)} refunded to ${formatMethod(outcome.data.refundMethod)}.`,
          hint: `${outcome.data.restockedLines} line${outcome.data.restockedLines === 1 ? "" : "s"} restocked.`,
        });
        setReturnTarget(null);
        setReturnReason("");
        setReturnQuantities({});
        await load();
      }
    } catch (error) {
      if (!(error instanceof PosApiError) || error.status === 0 || error.status === 408 || error.status >= 500 || (error.status >= 200 && error.status < 300)) {
        setReturnAttemptUncertain(true);
        setNotice({ tone: "error", title: "Return result is unknown", hint: "The refund may have been accepted. Retry this exact return or verify the sale before starting another return." });
        return;
      }
      setReturnAttemptPending(false);
      setReturnAttemptUncertain(false);
      setReturnAttemptAction(null);
      setNotice(noticeFor(error, "Check the return quantities and reason before submitting."));
    } finally {
      setBusy(false);
    }
  }

  function receiptForSale(sale: PosSale): string {
    return [
      `Chaste BusinessOS · Sale #${sale.number}`,
      `Date: ${new Date(sale.createdAt).toLocaleString()}`,
      `Customer: ${sale.customerName ?? "Walk-in customer"}`,
      ...sale.lines.map((entry) => `${entry.quantity / 1000} × ${entry.description} · ${money(saleLineTotalMinor(entry))}`),
      `Total: ${money(sale.totalMinor)}`,
      `Payment: ${formatMethod(sale.method)}`,
      "Thank you for your purchase.",
    ].join("\n");
  }

  function previewSaleReceipt(sale: PosSale) {
    const customer = customers.find((entry) => entry.id === sale.customerId);
    setReceiptShareFeedback(null);
    setReceiptPreview({ text: receiptForSale(sale), customerName: sale.customerName ?? "Walk-in customer", customerEmail: customer?.email ?? null });
  }

  async function shareReceipt(text: string) {
    try {
      if (navigator.share) {
        await navigator.share({ title: "Purchase receipt", text });
        setReceiptShareFeedback("Receipt shared.");
      } else {
        await navigator.clipboard.writeText(text);
        setReceiptShareFeedback("Receipt copied. Paste it into a message to share.");
      }
      setNotice({ tone: "success", title: receiptShareFeedback ?? "Receipt shared." });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      setReceiptShareFeedback("Could not share the receipt. Try downloading it instead.");
      setNotice({ tone: "error", title: "Could not share receipt", hint: "Check the browser share permissions, or try again from a secure connection." });
    }
  }

  function downloadReceipt(text: string) {
    const saleNumber = /Sale #?(\d+)/.exec(text.split("\n")[0] ?? "")?.[1] ?? "copy";
    const href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `receipt-${saleNumber}.txt`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
    setReceiptShareFeedback("Receipt downloaded.");
  }

  function printReceipt(text: string) {
    const printWindow = window.open("", "_blank", "width=480,height=640");
    if (!printWindow) {
      setNotice({ tone: "error", title: "Receipt window was blocked", hint: "Allow pop-ups for this app, or download the receipt instead." });
      return;
    }
    printWindow.opener = null;
    const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    printWindow.document.write(`<html><head><title>Receipt</title><style>body{font:14px/1.5 ui-monospace,monospace;padding:24px;white-space:pre-wrap}@media print{body{padding:0}}</style></head><body>${escaped}</body></html>`);
    printWindow.document.close();
    printWindow.focus();
    window.setTimeout(() => printWindow.print(), 200);
    setReceiptShareFeedback("Print dialog opened.");
  }

  function emailReceiptDraft() {
    if (!receiptPreview) return;
    const saleNumber = /Sale #?(\d+)/.exec(receiptPreview.text.split("\n")[0] ?? "")?.[1];
    const recipient = receiptPreview.customerEmail ? encodeURIComponent(receiptPreview.customerEmail) : "";
    const query = new URLSearchParams({
      subject: `Receipt${saleNumber ? ` for sale #${saleNumber}` : ""}`,
      body: receiptPreview.text,
    });
    window.location.href = `mailto:${recipient}?${query.toString()}`;
    setReceiptShareFeedback(receiptPreview.customerEmail
      ? `Email draft opened for ${receiptPreview.customerEmail}. Review it before sending.`
      : "Email draft opened. Add a recipient and review it before sending.");
  }

  function startReturn(sale: PosSale) {
    if (returnRecoveryBlocked) return;
    setReturnTarget(sale);
    setReturnAttemptUncertain(false);
    setReturnAttemptPending(false);
    setReturnAttemptAction(null);
    setReturnReason("");
    setReturnQuantities({});
    const firstMethod = sale.method.split(" ")[0];
    setRefundMethod(firstMethod === "card" ? "card" : firstMethod === "mobile_money" ? "mobile_money" : "cash");
  }

  const pageHeader = (
    <header className="pos-page-header">
      <div>
        <p className="pos-eyebrow">Point of sale</p>
        <h1>Register workspace</h1>
        <p>Sales post instantly to the ledger as one balanced entry. Closing counts the drawer, variances are recorded, never smoothed over.</p>
      </div>
      <div className="pos-header-actions">
        <a className="pos-shift-link" href={legacyUrl("/pos/shift-summary")}>POS shift summary</a>
      </div>
    </header>
  );

  if (modules === null && moduleError) {
    return (
      <main className="pos-page">
        {pageHeader}
        <section className="pos-error" role="alert">
          <p className="pos-eyebrow">Point of sale</p>
          <h2>Could not read the module switchboard</h2>
          <p>{moduleError}</p>
          <div className="pos-error-actions">
            <button type="button" className="pos-button pos-button-primary" onClick={() => window.location.reload()}>Try again</button>
          </div>
        </section>
      </main>
    );
  }

  if (modules !== null && !modules.pos) {
    return (
      <main className="pos-page">
        {pageHeader}
        <section className="pos-disabled">
          <p className="pos-eyebrow">Point of sale</p>
          <h2>Point of sale is not enabled</h2>
          <p>This workspace has the point of sale module switched off. Ask an owner to enable it, then reload this page.</p>
          <div className="pos-error-actions">
            <a className="pos-button" href={legacyUrl("/settings")}>Open settings</a>
          </div>
        </section>
      </main>
    );
  }

  if (sessions === null && moduleError === null && modules === null) {
    return (
      <main className="pos-page">
        {pageHeader}
        <p className="pos-loading" role="status">Loading the register…</p>
      </main>
    );
  }

  return (
    <main className="pos-page">
      {pageHeader}

      {sessions === null ? (
        <section className="pos-error" role="alert">
          <p className="pos-eyebrow">Point of sale</p>
          <h2>Could not load register data</h2>
          <p>{loadError ?? "The register service did not answer."}</p>
          {draftToRestore ? (
            <p>Your cart with {draftToRestore.lines.length} line{draftToRestore.lines.length === 1 ? "" : "s"} is saved on this device, awaiting connection and register validation before you can continue.</p>
          ) : null}
          <div className="pos-error-actions">
            <button type="button" className="pos-button pos-button-primary" onClick={() => void load()}>Try again</button>
          </div>
        </section>
      ) : (
        <>
          <div className="pos-tabs" role="tablist" aria-label="Register views">
            {([
              { id: "overview" as const, label: "Overview" },
              { id: "sell" as const, label: openSession ? "Sell · register open" : "Sell" },
              { id: "sessions" as const, label: "Sessions", count: (sessions ?? []).length || undefined },
            ]).map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                id={`pos-tab-${entry.id}`}
                aria-selected={tab === entry.id}
                aria-controls={`pos-panel-${entry.id}`}
                className={`pos-tab${tab === entry.id ? " is-active" : ""}`}
                onClick={() => changeTab(entry.id)}
              >
                {entry.label}
                {entry.count ? <span>{entry.count}</span> : null}
              </button>
            ))}
          </div>

          {notice && (
            <div className={`pos-notice pos-notice-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
              <div className="pos-notice-body">
                <span className="pos-notice-title">{notice.title}</span>
                {notice.hint ? <span className="pos-notice-hint">{notice.hint}</span> : null}
              </div>
              <button type="button" className="pos-icon-button" aria-label="Dismiss notice" onClick={() => setNotice(null)}>×</button>
            </div>
          )}

          {!online && (
            <div className="pos-banner pos-banner-offline" role="status">
              <span><strong>Offline mode.</strong> Cart and catalog stay available on this device. You can queue an unposted sale, then review and send it after reconnecting.</span>
              <span className="pos-banner-hint">Stock last checked {catalogUpdatedAt ? timeAgo(catalogUpdatedAt) : "before this session"}</span>
            </div>
          )}

          {loadError && (
            <div className="pos-banner pos-banner-stale" role="status">
              <span>{loadError} Showing the last loaded register data.</span>
              <div className="pos-banner-actions">
                <button type="button" className="pos-button pos-button-small" onClick={() => void load()}>Refresh</button>
              </div>
            </div>
          )}

          {receiptReady ? (
            <div className="pos-banner pos-banner-receipt" role="status">
              <span>Receipt ready for {receiptReady.customerName}.</span>
              <div className="pos-banner-actions">
                <button
                  type="button"
                  className="pos-button pos-button-small"
                  onClick={() => setReceiptPreview({ text: receiptReady.text, customerName: receiptReady.customerName, customerEmail: receiptReady.customerEmail })}
                >
                  Preview and share
                </button>
                <button type="button" className="pos-button pos-button-small pos-button-ghost" onClick={() => setReceiptReady(null)}>Dismiss</button>
              </div>
            </div>
          ) : null}

          {queuedSales.length > 0 && (
            <section className="pos-card pos-queue" aria-label="Offline sales queue">
              <div className="pos-card-heading">
                <h2>Offline sales queue</h2>
                <span className="pos-pill pos-pill-amber">{queuedSales.length} on this device</span>
              </div>
              <div className="pos-card-body">
                <p className="pos-hint">These sales are not posted, charged, or deducted from stock yet. Sending rechecks the register, current prices, and available stock. A safe retry uses the same request identity.</p>
                <ul className="pos-queue-list">
                  {queuedSales.map((queued) => {
                    const session = (sessions ?? []).find((candidate) => candidate.id === queued.sessionId);
                    return (
                      <li key={queued.id} className="pos-queue-row">
                        <div className="pos-queue-main">
                          <div className="pos-queue-heading">
                            <strong>{money(queued.totalMinor)}</strong>
                            <span className={`pos-pill ${queued.status === "failed" || queued.status === "uncertain" ? "pos-pill-red" : "pos-pill-amber"}`}>
                              {queued.status === "uncertain" ? "Result unknown" : queued.status === "failed" ? "Needs review" : "Not posted"}
                            </span>
                          </div>
                          <p className={queued.errorMessage ? "is-error" : undefined}>
                            {queued.lines.length} line{queued.lines.length === 1 ? "" : "s"} · {session?.register ?? "Original register"} · saved {timeAgo(queued.queuedAt)}
                          </p>
                          {queued.errorMessage ? <p className="is-error">{queued.errorMessage}</p> : null}
                        </div>
                        <div className="pos-queue-actions">
                          <button
                            type="button"
                            className="pos-button pos-button-small"
                            disabled={!online || queuedSaleBusyId !== null}
                            onClick={() => void retryQueuedSale(queued)}
                          >
                            {queued.status === "failed" ? "Retry sale" : "Send sale"}
                          </button>
                          <button
                            type="button"
                            className="pos-button pos-button-small pos-button-ghost"
                            disabled={queuedSaleBusyId !== null}
                            onClick={() => setDiscardQueuedId(queued.id)}
                          >
                            Discard
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </section>
          )}

          {tab === "overview" && (
            <section id="pos-panel-overview" role="tabpanel" aria-labelledby="pos-tab-overview">
              <div className="pos-stat-grid">
                <button type="button" className="pos-stat" onClick={() => changeTab("sell")}>
                  <span className="pos-stat-label">Register</span>
                  <span className={`pos-stat-value${openSession ? "" : " is-idle"}`}>{openSession ? openSession.register : "closed"}</span>
                  <span className="pos-stat-sub">{openSession ? `open since ${timeAgo(openSession.openedAt)}` : "no session running"}</span>
                </button>
                <button type="button" className="pos-stat" onClick={() => changeTab("sessions")}>
                  <span className="pos-stat-label">Expected in drawer</span>
                  <span className={`pos-stat-value${openSession ? "" : " is-idle"}`}>{openSession ? money(expectedCash) : "not counting"}</span>
                  <span className="pos-stat-sub">{openSession ? "float plus net cash movement" : "open a register to count"}</span>
                </button>
                <button type="button" className="pos-stat" onClick={() => changeTab("sessions")}>
                  <span className="pos-stat-label">Closed today</span>
                  <span className="pos-stat-value">{closedToday.length}</span>
                  <span className={`pos-stat-sub${varianceSessions.length > 0 ? " is-warn" : ""}`}>
                    {varianceSessions.length > 0 ? `${varianceSessions.length} variance flag${varianceSessions.length === 1 ? "" : "s"}` : "no variance flags"}
                  </span>
                </button>
                <button type="button" className="pos-stat" onClick={() => changeTab("sessions")}>
                  <span className="pos-stat-label">Variance flags</span>
                  <span className={`pos-stat-value${varianceSessions.length > 0 ? "" : " is-idle"}`}>{varianceSessions.length}</span>
                  <span className="pos-stat-sub">shifts that missed expected cash</span>
                </button>
              </div>

              <div className="pos-overview-grid">
                <section className="pos-card">
                  <div className="pos-card-heading"><h2>The floor right now</h2></div>
                  <div className="pos-card-body">
                    {openSession ? (
                      <ul className="pos-floor-list">
                        <li className="pos-floor-item">
                          <span className="pos-dot pos-dot-open" aria-hidden="true" />
                          <span>{openSession.register} is open, float {money(openSession.openingFloatMinor)}</span>
                        </li>
                        <li className="pos-floor-item">
                          <span className="pos-dot" aria-hidden="true" />
                          <span>{openSessions.length > 1 ? `${openSessions.length} registers open` : "One register running"}</span>
                        </li>
                      </ul>
                    ) : (
                      <p className="pos-hint">No register is open. Open one from the Sell tab to start ringing sales.</p>
                    )}
                    <div className="pos-header-actions">
                      <button type="button" className="pos-button pos-button-primary" onClick={() => changeTab("sell")}>
                        {openSession ? "Ring a sale" : "Open register"}
                      </button>
                      <button type="button" className="pos-button pos-button-ghost" onClick={() => changeTab("sessions")}>Session history</button>
                    </div>
                  </div>
                </section>

                <section className="pos-card">
                  <div className="pos-card-heading"><h2>Watch list</h2></div>
                  <div className="pos-card-body">
                    {varianceSessions.length === 0 ? (
                      <p className="pos-hint">No drawer variances on record. Counts have matched expected cash.</p>
                    ) : (
                      <ul className="pos-watch-list">
                        {varianceSessions.slice(0, 4).map((session) => (
                          <li key={session.id} className="pos-watch-row">
                            <span>{session.register} · closed {session.closedAt ? timeAgo(session.closedAt) : "unknown"}</span>
                            <span className="pos-variance-amount">{money(session.varianceMinor ?? 0)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </section>
              </div>
            </section>
          )}

          {tab === "sessions" && (
            <section id="pos-panel-sessions" role="tabpanel" aria-labelledby="pos-tab-sessions">
              {(sessions ?? []).length === 0 ? (
                <section className="pos-empty" aria-live="polite">
                  <h2>No register sessions yet</h2>
                  <p>Open a register from the Sell tab to start ringing sales.</p>
                  <div className="pos-error-actions">
                    <button type="button" className="pos-button pos-button-primary" onClick={() => changeTab("sell")}>Open the register</button>
                  </div>
                </section>
              ) : (
                <>
                  <div className="pos-table-card pos-card pos-table-only">
                    <div className="pos-card-heading">
                      <h2>Register history</h2>
                      <span>{(sessions ?? []).length} session{(sessions ?? []).length === 1 ? "" : "s"}</span>
                    </div>
                    <div className="pos-table-scroll">
                      <table className="pos-table">
                        <thead>
                          <tr>
                            <th>Register</th>
                            <th>Status</th>
                            <th>Opened</th>
                            <th className="is-numeric">Expected in drawer</th>
                            <th className="is-numeric">Counted</th>
                            <th className="is-numeric">Variance</th>
                            <th>Close note</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(sessions ?? []).map((session) => {
                            const variance = session.varianceMinor !== null && session.varianceMinor !== 0;
                            return (
                              <tr key={session.id} className={variance ? "is-variance" : undefined}>
                                <th scope="row">{session.register}</th>
                                <td><span className={`pos-pill ${statusPill(session.status)}`}>{formatStatus(session.status)}</span></td>
                                <td className="is-nowrap" title={session.openedAt}>{timeAgo(session.openedAt)}</td>
                                <td className="is-numeric">{money(session.openingFloatMinor + (session.expectedCashMinor ?? 0))}</td>
                                <td className="is-numeric">{session.countedCashMinor !== null ? money(session.countedCashMinor) : "Not counted"}</td>
                                <td className="is-numeric is-amount">{session.varianceMinor !== null ? money(session.varianceMinor) : "Not reconciled"}</td>
                                <td className="is-note" title={session.varianceReason ?? ""}>{session.varianceReason ?? "None recorded"}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <ul className="pos-cards-only pos-session-cards">
                    {(sessions ?? []).map((session) => {
                      const variance = session.varianceMinor !== null && session.varianceMinor !== 0;
                      return (
                        <li key={session.id} className={`pos-session-card${variance ? " is-variance" : ""}`}>
                          <div className="pos-session-card-heading">
                            <div>
                              <strong>{session.register}</strong>
                              <p>Opened {timeAgo(session.openedAt)}{session.closedAt ? ` · closed ${timeAgo(session.closedAt)}` : " · still open"}</p>
                            </div>
                            <span className={`pos-pill ${statusPill(session.status)}`}>{formatStatus(session.status)}</span>
                          </div>
                          <dl className="pos-session-figures">
                            <div>
                              <dt>Expected in drawer</dt>
                              <dd>{money(session.openingFloatMinor + (session.expectedCashMinor ?? 0))}</dd>
                            </div>
                            <div>
                              <dt>Counted</dt>
                              <dd>{session.countedCashMinor !== null ? money(session.countedCashMinor) : "Not counted"}</dd>
                            </div>
                            <div className="is-wide">
                              <dt>Variance</dt>
                              <dd className={variance ? "is-variance" : undefined}>
                                {session.varianceMinor !== null ? money(session.varianceMinor) : "Not reconciled"}
                              </dd>
                            </div>
                            {session.varianceReason ? (
                              <div className="is-wide">
                                <dt>Close note</dt>
                                <dd className="is-note">{session.varianceReason}</dd>
                              </div>
                            ) : null}
                          </dl>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </section>
          )}

          {tab === "sell" && (
            <section id="pos-panel-sell" role="tabpanel" aria-labelledby="pos-tab-sell">
              {openSession ? (
                <div className="pos-sale-grid">
                  <div className="pos-sale-column">
                    <section className="pos-card" aria-label="Ring a sale">
                      <div className="pos-card-heading">
                        <h2>Ring a sale</h2>
                        <span className="pos-pill pos-pill-green">register open</span>
                      </div>
                      <div className="pos-card-body">
                        {draftReady && lines.length > 0 && !saleLocked ? (
                          <div className="pos-banner pos-banner-saved" role="status">
                            <span>Cart saved on this device. You can leave and come back without losing it.</span>
                            <div className="pos-banner-actions">
                              <button type="button" className="pos-button pos-button-small" onClick={clearCart} disabled={busy || saleLocked}>Clear cart</button>
                            </div>
                          </div>
                        ) : null}

                        {!online ? (
                          <p className="pos-inline-warning">Products already in the cart stay available. Register lookups need a connection.</p>
                        ) : null}

                        {inventoryEnabled ? (
                          <div>
                            <label className="pos-field" htmlFor="pos-catalog-search">
                              <span>Scan or find a product <em>· press / to focus, Enter to add</em></span>
                            </label>
                            <div className="pos-catalog">
                              <input
                                ref={catalogInputRef}
                                id="pos-catalog-search"
                                className="pos-input"
                                value={catalogQuery}
                                disabled={busy || saleLocked}
                                onChange={(event) => setCatalogQuery(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" && catalogResults[0]) {
                                    event.preventDefault();
                                    addCatalogItem(catalogResults[0]);
                                  }
                                }}
                                placeholder="Search name, SKU, or barcode"
                                aria-label="Search products by name, SKU, or barcode"
                                autoComplete="off"
                              />
                              {catalogQuery ? (
                                <button type="button" className="pos-catalog-clear" onClick={() => { setCatalogQuery(""); focusCatalogField(); }} disabled={busy || saleLocked}>Clear</button>
                              ) : null}
                            </div>
                            {catalog.length > 0 ? (
                              <div className="pos-chips" aria-label="Quick product filters">
                                <button type="button" className="pos-chip" onClick={() => setCatalogQuery("")}>All</button>
                                <button type="button" className="pos-chip" onClick={() => setCatalogQuery("service")}>Services</button>
                                {favoriteSkus.map((sku) => {
                                  const item = catalog.find((candidate) => candidate.sku === sku);
                                  return item ? (
                                    <button key={sku} type="button" className="pos-chip pos-chip-favorite" onClick={() => addCatalogItem(item)}>★ {item.name}</button>
                                  ) : null;
                                })}
                                {catalogTags.map((tag) => (
                                  <button key={tag} type="button" className="pos-chip" onClick={() => setCatalogQuery(tag)}>{tag}</button>
                                ))}
                              </div>
                            ) : null}
                            <div aria-live="polite">
                              {catalogError ? (
                                <div className="pos-inline-warning">
                                  <span>{catalogError} You can still add an untracked item.</span>
                                  <button type="button" className="pos-button pos-button-small" onClick={() => void loadCatalog()}>Retry</button>
                                </div>
                              ) : catalogQuery.trim() ? (
                                catalogLoading ? (
                                  <p className="pos-hint">Loading product matches…</p>
                                ) : catalogResults.length > 0 ? (
                                  <ul className="pos-results">
                                    {catalogResults.map((item) => {
                                      const outOfStock = item.kind !== "service" && item.availableThousandths <= 0;
                                      return (
                                        <li key={item.sku} className="pos-result">
                                          <button
                                            type="button"
                                            className="pos-result-add"
                                            disabled={busy || saleLocked || outOfStock}
                                            onClick={() => addCatalogItem(item)}
                                          >
                                            <span className="pos-result-main">
                                              <span className="pos-result-title">{item.name}</span>
                                              <span className="pos-result-meta">
                                                {item.sku} · {outOfStock ? "Out of stock" : item.kind === "service" ? item.unitLabel : `${item.availableThousandths / 1000} ${item.unitLabel} available`}
                                              </span>
                                            </span>
                                            <span className="pos-result-price">
                                              {money(item.salePriceMinor)}
                                              <span className="pos-result-unit">per {item.unitLabel}</span>
                                            </span>
                                          </button>
                                          <button
                                            type="button"
                                            className={`pos-result-favorite pos-icon-button${favoriteSkus.includes(item.sku) ? " is-on" : ""}`}
                                            aria-label={`${favoriteSkus.includes(item.sku) ? "Remove from" : "Add to"} favorites: ${item.name}`}
                                            aria-pressed={favoriteSkus.includes(item.sku)}
                                            onClick={() => setFavoriteSkus((current) => current.includes(item.sku) ? current.filter((sku) => sku !== item.sku) : [...current, item.sku].slice(-30))}
                                          >
                                            {favoriteSkus.includes(item.sku) ? "★" : "☆"}
                                          </button>
                                        </li>
                                      );
                                    })}
                                  </ul>
                                ) : (
                                  <ul className="pos-results">
                                    <li className="pos-result-empty">No matching products. Check the name, SKU, or barcode, or add a custom line.</li>
                                  </ul>
                                )
                              ) : catalogLoading ? (
                                <p className="pos-hint">Loading product catalog…</p>
                              ) : catalog.length === 0 ? (
                                <div className="pos-catalog-empty">
                                  <strong>Set up this register</strong>
                                  <p>Add a first item with its selling price and barcode, or bring in your existing spreadsheet.</p>
                                  <div className="pos-catalog-actions">
                                    <button type="button" className="pos-button pos-button-small" onClick={() => { setQuickProductAdvancedOpen(false); setQuickProductOpen(true); }}>Add a product</button>
                                    <a className="pos-button pos-button-small" href={legacyUrl("/products")}>Import spreadsheet</a>
                                    <a className="pos-button pos-button-small pos-button-ghost" href={legacyUrl("/inventory")}>Open Inventory</a>
                                  </div>
                                </div>
                              ) : (
                                <p className="pos-hint pos-hint-muted">Scan a barcode or type a few characters. Press Enter to add the first match, or / to focus search.</p>
                              )}
                            </div>
                          </div>
                        ) : (
                          <p className="pos-inline-warning">Product lookup is unavailable in this workspace. You can still add an untracked item or service below.</p>
                        )}

                        {selectedCustomer ? (
                          <div className="pos-customer">
                            <div className="pos-customer-heading">
                              <div>
                                <strong>{selectedCustomer.name}</strong>
                                <p>{selectedCustomer.email ?? "No email on file"}</p>
                              </div>
                              <button
                                type="button"
                                className="pos-link-button"
                                onClick={() => { setCustomerId(""); setCustomerQuery(""); }}
                                disabled={busy || saleLocked}
                              >
                                Change customer
                              </button>
                            </div>
                            <div className="pos-customer-stats">
                              <span><strong>{selectedCustomer.purchaseCount}</strong> past purchase{selectedCustomer.purchaseCount === 1 ? "" : "s"}</span>
                              <span><strong>{money(selectedCustomer.lifetimeSpendMinor)}</strong> lifetime net spend</span>
                            </div>
                          </div>
                        ) : (
                          <details className="pos-customer-attach">
                            <summary>Attach customer <em>· optional</em></summary>
                            <div>
                              <label className="pos-field" htmlFor="pos-customer-search">
                                <span>Customer lookup</span>
                                <input
                                  id="pos-customer-search"
                                  className="pos-input"
                                  value={customerQuery}
                                  onChange={(event) => setCustomerQuery(event.target.value)}
                                  placeholder="Search name or email"
                                  autoComplete="off"
                                  disabled={busy || saleLocked}
                                />
                              </label>
                              {customerError ? (
                                <p className="pos-hint is-warn" role="status">{customerError}</p>
                              ) : customerQuery.trim() ? (
                                customerResults.length > 0 ? (
                                  <ul className="pos-customer-results" aria-label="Matching customers">
                                    {customerResults.map((customer) => (
                                      <li key={customer.id}>
                                        <button type="button" className="pos-customer-option" onClick={() => { setCustomerId(customer.id); setCustomerQuery(""); }}>
                                          <span>
                                            <strong>{customer.name}</strong>
                                            <span>{customer.email ?? "No email"}</span>
                                          </span>
                                          <span className="pos-customer-option-meta">{customer.purchaseCount} visits</span>
                                        </button>
                                      </li>
                                    ))}
                                  </ul>
                                ) : (
                                  <p className="pos-hint">No match. Continue as walk-in, or add the customer in CRM.</p>
                                )
                              ) : (
                                <small>Search to attach this sale to a customer purchase history.</small>
                              )}
                            </div>
                          </details>
                        )}

                        {inventoryEnabled ? (
                          <button
                            type="button"
                            className="pos-link-button"
                            aria-expanded={customLineOpen}
                            onClick={() => setCustomLineOpen((open) => !open)}
                            disabled={busy || saleLocked}
                          >
                            {customLineOpen ? "Hide custom item" : "Add custom item or service"}
                          </button>
                        ) : null}

                        {customLineOpen || !inventoryEnabled ? (
                          <form className="pos-form-stack" onSubmit={addCustomLine}>
                            <p className="pos-hint">Custom lines are not connected to stock counts.</p>
                            <div className="pos-form-row">
                              <label className="pos-field" htmlFor="pos-custom-description">
                                <span>Description</span>
                                <input
                                  id="pos-custom-description"
                                  className="pos-input"
                                  value={line.description}
                                  onChange={(event) => setLine((current) => ({ ...current, description: event.target.value }))}
                                  placeholder="One-off item or service"
                                  maxLength={200}
                                  required
                                  disabled={busy || saleLocked}
                                />
                              </label>
                              <label className="pos-field" htmlFor="pos-custom-price">
                                <span>Unit price</span>
                                <input
                                  id="pos-custom-price"
                                  className="pos-input pos-input-numeric"
                                  type="number"
                                  min="0"
                                  step={digits === 0 ? "1" : "0.01"}
                                  inputMode="decimal"
                                  value={line.price}
                                  onChange={(event) => setLine((current) => ({ ...current, price: event.target.value }))}
                                  placeholder="0.00"
                                  required
                                  disabled={busy || saleLocked}
                                />
                              </label>
                              <button type="submit" className="pos-button" disabled={busy || saleLocked}>Add line</button>
                            </div>
                          </form>
                        ) : null}

                        {saleLocked ? (
                          <div className="pos-banner pos-banner-pending" role="status">
                            <span>{salePendingApproval
                              ? "This cart is already waiting for approval. Starting another sale clears it from this screen, not from Approvals."
                              : "The connection ended before this sale's status was confirmed. The cart is locked to the same attempt until you retry it or explicitly abandon it."}</span>
                            <div className="pos-banner-actions">
                              <button
                                type="button"
                                className="pos-button pos-button-small"
                                onClick={() => { void startAnotherSale(); }}
                              >
                                {salePendingApproval ? "Start another sale" : "Abandon attempt and start another sale"}
                              </button>
                            </div>
                          </div>
                        ) : null}

                        {lines.length > 0 ? (
                          <ul className="pos-cart-lines" id="pos-cart-lines">
                            {lines.map((entry, index) => {
                              const item = entry.sku ? catalog.find((candidate) => candidate.sku === entry.sku) : undefined;
                              return (
                                <li key={entry.sku ?? `${entry.description}-${index}`} className="pos-cart-line">
                                  <div className="pos-cart-line-main">
                                    <span className="pos-cart-line-title">{entry.description}</span>
                                    <div className="pos-cart-line-meta">
                                      <label className="pos-cart-quantity-label">
                                        <span className="pos-hint-muted">Quantity</span>
                                        <input
                                          type="number"
                                          className="pos-input pos-input-compact"
                                          min="0.001"
                                          step="0.001"
                                          max={item && item.kind !== "service" ? item.availableThousandths / 1000 : undefined}
                                          value={entry.quantity / 1000}
                                          onChange={(event) => updateQuantity(index, event.target.value)}
                                          aria-label={`Quantity for ${entry.description}`}
                                          disabled={busy || saleLocked}
                                          onFocus={() => setActiveLineIndex(index)}
                                        />
                                        <span className="pos-hint-muted">{item?.unitLabel ?? "unit"}</span>
                                      </label>
                                      <span>× {money(entry.unitPriceMinor)} each</span>
                                    </div>
                                  </div>
                                  <span className="pos-cart-line-total">{money(lineTotalMinor(entry))}</span>
                                  <button
                                    type="button"
                                    className="pos-icon-button"
                                    aria-label={`Remove ${entry.description}`}
                                    onClick={() => setLines((current) => current.filter((_, entryIndex) => entryIndex !== index))}
                                    disabled={busy || saleLocked}
                                    onFocus={() => setActiveLineIndex(index)}
                                  >
                                    ×
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        ) : null}

                        <div className="pos-cart-summary">
                          <div>
                            <span className="pos-cart-count">Cart · {lines.length} line{lines.length === 1 ? "" : "s"}</span>
                            <span className="pos-cart-total">{money(total)}</span>
                          </div>
                          {lines.length > 0 ? (
                            <button id="pos-park-cart" type="button" className="pos-button pos-button-small" disabled={busy || saleLocked} onClick={parkCurrentCart}>
                              Park cart <span className="pos-button-note">Alt+P</span>
                            </button>
                          ) : null}
                        </div>

                        {workspaceParkedCarts.length > 0 ? (
                          <section className="pos-parked" aria-label="Parked carts">
                            <div className="pos-parked-heading">
                              <h3>Parked carts</h3>
                              <span className="pos-hint">{workspaceParkedCarts.length} on this device · not shared with coworkers</span>
                            </div>
                            <ul className="pos-parked-list">
                              {workspaceParkedCarts.map((cart) => {
                                const cartTotal = cart.lines.reduce((sum, entry) => sum + lineTotalMinor(entry), 0);
                                return (
                                  <li key={cart.id} className="pos-parked-row">
                                    <div className="pos-parked-main">
                                      <strong>{cart.customerName} · {cart.lines.length} line{cart.lines.length === 1 ? "" : "s"}</strong>
                                      <span>{money(cartTotal)} · {new Date(cart.parkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                                    </div>
                                    <div className="pos-parked-actions">
                                      <button type="button" className="pos-button pos-button-small" disabled={lines.length > 0 || busy || saleLocked} onClick={() => resumeParkedCart(cart)}>Resume</button>
                                      <button type="button" className="pos-button pos-button-small pos-button-ghost" disabled={busy} onClick={() => setParkedCarts((current) => current.filter((entry) => entry.id !== cart.id))}>Remove</button>
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                            {lines.length > 0 ? <p className="pos-hint">Park or finish the current cart before resuming another.</p> : null}
                          </section>
                        ) : null}

                        <div className="pos-tender-bar">
                          {!splitMode ? (
                            <div className="pos-tender-toggle" role="group" aria-label="Payment method">
                              {(["cash", "card"] as const).map((option) => (
                                <button
                                  key={option}
                                  type="button"
                                  className={`pos-tender-option${method === option ? " is-active" : ""}`}
                                  disabled={busy || saleLocked}
                                  aria-pressed={method === option}
                                  onClick={() => setMethod(option)}
                                >
                                  {option === "cash" ? "Cash" : "Card"}
                                </button>
                              ))}
                            </div>
                          ) : <span />}
                          <button
                            type="button"
                            className="pos-button pos-button-small"
                            disabled={busy || saleLocked}
                            onClick={() => {
                              setSplitMode((enabled) => !enabled);
                              setCashReceived("");
                              setSplitTenders([{ method: "cash", amount: "" }, { method: "card", amount: "" }]);
                            }}
                          >
                            {splitMode ? "Single payment" : "Split payment"}
                          </button>
                        </div>

                        {splitMode ? (
                          <div className="pos-split">
                            <div className="pos-split-heading">
                              <span>Payment allocation</span>
                              <span>{money(splitAllocatedMinor)} of {money(total)}</span>
                            </div>
                            {splitTenders.map((tender, index) => (
                              <div key={tender.method} className="pos-split-row">
                                <label className="pos-field" htmlFor={`pos-split-method-${index}`}>
                                  <span>Payment method</span>
                                  <select
                                    id={`pos-split-method-${index}`}
                                    className="pos-select"
                                    value={tender.method}
                                    disabled={busy || saleLocked}
                                    onChange={(event) => setSplitTenders((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, method: event.target.value as SplitTender["method"] } : entry))}
                                  >
                                    <option value="cash">Cash</option>
                                    <option value="card">Card</option>
                                    <option value="mobile_money">Mobile money</option>
                                  </select>
                                </label>
                                <label className="pos-field" htmlFor={`pos-split-amount-${index}`}>
                                  <span>Amount</span>
                                  <input
                                    id={`pos-split-amount-${index}`}
                                    className="pos-input pos-input-numeric"
                                    type="number"
                                    min="0"
                                    step={digits === 0 ? "1" : "0.01"}
                                    inputMode="decimal"
                                    value={tender.amount}
                                    placeholder="0"
                                    disabled={busy || saleLocked}
                                    onChange={(event) => setSplitTenders((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, amount: event.target.value } : entry))}
                                  />
                                </label>
                                <button
                                  type="button"
                                  className="pos-icon-button"
                                  aria-label={`Remove ${formatMethod(tender.method)} payment`}
                                  disabled={splitTenders.length <= 2 || busy || saleLocked}
                                  onClick={() => setSplitTenders((current) => current.filter((_, entryIndex) => entryIndex !== index))}
                                >
                                  ×
                                </button>
                              </div>
                            ))}
                            {splitTenders.length < 3 ? (
                              <button
                                type="button"
                                className="pos-link-button"
                                disabled={busy || saleLocked}
                                onClick={() => {
                                  const used = new Set(splitTenders.map((entry) => entry.method));
                                  const next = (["cash", "card", "mobile_money"] as const).find((candidate) => !used.has(candidate));
                                  if (next) setSplitTenders((current) => [...current, { method: next, amount: "" }]);
                                }}
                              >
                                Add payment method
                              </button>
                            ) : null}
                            <div className={`pos-split-total${splitAllocatedMinor === total ? " is-balanced" : ""}`}>
                              <span>{splitAllocatedMinor < total ? `Remaining ${money(total - splitAllocatedMinor)}` : splitAllocatedMinor > total ? `Over by ${money(splitAllocatedMinor - total)}` : "Fully allocated"}</span>
                              {splitCashAllocatedMinor > 0 ? <span>Cash portion {money(splitCashAllocatedMinor)}</span> : null}
                            </div>
                            {splitCashAllocatedMinor > 0 ? (
                              <div className="pos-split-cash">
                                <label className="pos-field" htmlFor="pos-split-cash-received">
                                  <span>Cash received</span>
                                  <input
                                    id="pos-split-cash-received"
                                    className="pos-input pos-input-money"
                                    type="number"
                                    min="0"
                                    step={digits === 0 ? "1" : "0.01"}
                                    inputMode="decimal"
                                    value={cashReceived}
                                    onChange={(event) => setCashReceived(event.target.value)}
                                    placeholder={minorToInput(splitCashAllocatedMinor, digits)}
                                    disabled={busy || saleLocked}
                                  />
                                </label>
                                <span className={`pos-split-cash-status${splitCashReceivedMinor < splitCashAllocatedMinor ? " is-short" : ""}`}>
                                  {splitCashReceivedMinor < splitCashAllocatedMinor
                                    ? `Cash short by ${money(splitCashAllocatedMinor - splitCashReceivedMinor)}`
                                    : `Change due ${money(changeDueMinor)}`}
                                </span>
                              </div>
                            ) : null}
                          </div>
                        ) : method === "cash" ? (
                          <div className="pos-cash-box">
                            <div className="pos-cash-row">
                              <label className="pos-field" htmlFor="pos-cash-received">
                                <span>Cash received</span>
                                <input
                                  id="pos-cash-received"
                                  className="pos-input pos-input-money"
                                  type="number"
                                  min="0"
                                  step={digits === 0 ? "1" : "0.01"}
                                  inputMode="decimal"
                                  value={cashReceived}
                                  onChange={(event) => setCashReceived(event.target.value)}
                                  placeholder={minorToInput(total, digits)}
                                  disabled={busy || saleLocked}
                                />
                              </label>
                              <div className="pos-cash-presets">
                                <button type="button" className="pos-cash-preset" onClick={() => setCashReceived(minorToInput(total, digits))} disabled={busy || saleLocked}>Exact</button>
                                {cashPresets.map((preset) => (
                                  <button key={preset.label} type="button" className="pos-cash-preset" onClick={() => setCashReceived(minorToInput(total + preset.amountMinor, digits))} disabled={busy || saleLocked}>{preset.label}</button>
                                ))}
                              </div>
                            </div>
                            <div className="pos-cash-status">
                              <span>Due now <strong>{money(total)}</strong></span>
                              <span className={`pos-cash-change${tenderedMinor < total ? " is-short" : ""}`}>
                                {tenderedMinor < total ? `Short by ${money(total - tenderedMinor)}` : `Change due ${money(changeDueMinor)}`}
                              </span>
                            </div>
                          </div>
                        ) : null}

                        <button
                          id="pos-complete-sale"
                          type="button"
                          className="pos-button pos-button-primary pos-button-block pos-button-large"
                          disabled={lines.length === 0 || salePendingApproval || (saleAttemptUncertain && !online) || !checkoutReady || total <= 0 || (!online && queuedSales.length >= 20) || busy}
                          onClick={() => (online ? void completeCurrentSale() : queueCurrentSaleOffline())}
                        >
                          {online ? `${saleAttemptUncertain ? "Retry same sale attempt" : "Complete sale"} · ${money(total)}` : `Queue sale · ${money(total)}`}
                          <span className="pos-button-note">{online ? "Ctrl+Enter" : "Not charged"}</span>
                        </button>
                      </div>
                    </section>
                  </div>

                  <div className="pos-sale-column">
                    <section className="pos-card" aria-label="Close and count drawer">
                      <div className="pos-card-heading">
                        <h2>Close and count drawer</h2>
                        <span className={`pos-pill ${openSession ? "pos-pill-green" : "pos-pill-neutral"}`}>{formatStatus(openSession.status)}</span>
                      </div>
                      <div className="pos-card-body">
                        <dl className="pos-drawer-summary">
                          <div className="pos-drawer-row">
                            <dt>Opening float</dt>
                            <dd>{money(openSession.openingFloatMinor)}</dd>
                          </div>
                          <div className="pos-drawer-row">
                            <dt>Net cash movement</dt>
                            <dd>{money(openSession.expectedCashMinor ?? 0)}</dd>
                          </div>
                          <div className="pos-drawer-row pos-drawer-row-total">
                            <dt>Expected cash</dt>
                            <dd>{money(expectedCash)}</dd>
                          </div>
                        </dl>

                        {summary && summary.tenderTotals.length > 0 ? (
                          <section className="pos-drawer-tenders" aria-label="Gross sales by tender">
                            <h3>Gross sales by tender</h3>
                            <dl className="pos-drawer-tender-list">
                              {summary.tenderTotals.map((tender) => (
                                <div key={tender.method} className="pos-drawer-tender-row">
                                  <dt>{formatMethod(tender.method)}</dt>
                                  <dd>{money(tender.amountMinor)}</dd>
                                </div>
                              ))}
                            </dl>
                            <p className="pos-drawer-note">Captured sales by payment type. Net cash movement and expected drawer cash are shown separately.</p>
                            {summary.refundTotals.length > 0 ? (
                              <div className="pos-drawer-refunds">
                                <h4>Refunds by destination</h4>
                                <dl className="pos-drawer-tender-list">
                                  {summary.refundTotals.map((refund) => (
                                    <div key={refund.method} className="pos-drawer-tender-row">
                                      <dt>{formatMethod(refund.method)}</dt>
                                      <dd>{money(refund.amountMinor)}</dd>
                                    </div>
                                  ))}
                                </dl>
                              </div>
                            ) : null}
                          </section>
                        ) : null}

                        <label className="pos-field" htmlFor="counted">
                          <span>Counted cash</span>
                          <input
                            id="counted"
                            className="pos-input pos-input-money"
                            value={counted}
                            onChange={(event) => { setCounted(event.target.value); setVarianceReason(""); }}
                            inputMode="decimal"
                            placeholder="Count the drawer"
                            disabled={countByDenomination}
                          />
                        </label>
                        <button
                          type="button"
                          className="pos-link-button"
                          onClick={() => {
                            setCountByDenomination((enabled) => !enabled);
                            setCounted("");
                            setDenominationCounts({});
                            setVarianceReason("");
                          }}
                        >
                          {countByDenomination ? "Enter one total instead" : "Count by denomination"}
                        </button>

                        {countByDenomination ? (
                          <div className="pos-denominations">
                            {denominations.map((amount) => (
                              <label key={amount} className="pos-denomination">
                                <span>{money(amount)}</span>
                                <input
                                  className="pos-input"
                                  type="number"
                                  min="0"
                                  max="10000"
                                  step="1"
                                  inputMode="numeric"
                                  aria-label={`${money(amount)} notes or coins`}
                                  value={denominationCounts[String(amount)] ?? ""}
                                  onChange={(event) => { setDenominationCounts((current) => ({ ...current, [String(amount)]: event.target.value })); setVarianceReason(""); }}
                                />
                              </label>
                            ))}
                            <div className="pos-denomination-total">
                              <span>Counted total</span>
                              <span>{money(denominationTotalMinor)}</span>
                            </div>
                          </div>
                        ) : null}

                        {liveVariance !== null ? (
                          <p className={`pos-variance ${liveVariance === 0 ? "pos-variance-balanced" : "pos-variance-flagged"}`}>
                            {liveVariance === 0
                              ? "Balanced, matches expected cash."
                              : <>Variance preview: <span className="pos-variance-amount">{money(liveVariance)}</span></>}
                          </p>
                        ) : null}

                        {liveVariance !== null && liveVariance !== 0 ? (
                          <div className="pos-field">
                            <label htmlFor="pos-variance-reason"><span>Explain the variance</span></label>
                            <textarea
                              id="pos-variance-reason"
                              className="pos-textarea"
                              maxLength={500}
                              value={varianceReason}
                              onChange={(event) => setVarianceReason(event.target.value)}
                              placeholder="For example: one cash refund was entered after the count."
                            />
                            <small>This note is saved with the closed shift for review.</small>
                          </div>
                        ) : null}

                        <button
                          type="button"
                          className="pos-button pos-button-danger pos-button-block"
                          disabled={!hasCashCount || (liveVariance !== null && liveVariance !== 0 && varianceReason.trim().length < 3) || lines.length > 0 || busy}
                          onClick={() => setCloseConfirm(true)}
                        >
                          Close session and reconcile
                        </button>
                        {lines.length > 0 ? <p className="pos-hint">Complete the current cart before closing this register.</p> : null}
                      </div>
                    </section>
                  </div>
                </div>
              ) : (
                <section className="pos-card">
                  <div className="pos-card-heading"><h2>Open the register</h2></div>
                  <div className="pos-card-body">
                    <form className="pos-form-row" onSubmit={(event) => { event.preventDefault(); void openRegister(); }}>
                      <div className="pos-field">
                        <label htmlFor="float"><span>Opening float</span></label>
                        <input
                          id="float"
                          className="pos-input pos-input-money"
                          value={float}
                          onChange={(event) => setFloat(event.target.value)}
                          inputMode="decimal"
                          placeholder={minorToInput(10000, digits)}
                        />
                        <small>The counted cash this register starts from. It is part of expected drawer cash until you close the shift.</small>
                      </div>
                      <span aria-hidden="true" />
                      <button type="submit" className="pos-button pos-button-primary" disabled={busy}>
                        {busy ? "Opening…" : "Open register"}
                      </button>
                    </form>
                  </div>
                </section>
              )}
            </section>
          )}

          {tab === "sell" && summary && openSession ? (
            <div className="pos-shift-strip">
              <span className={`pos-pill ${summary.status === "open" ? "pos-pill-green" : "pos-pill-neutral"}`}>{summary.register} · {formatStatus(summary.status)}</span>
              <span><strong>{summary.salesCount}</strong> sale{summary.salesCount === 1 ? "" : "s"} · <strong>{money(summary.takingsMinor)}</strong> total takings</span>
              <a className="pos-shift-link" href={legacyUrl("/pos/shift-summary")}>Full shift summary</a>
            </div>
          ) : null}

          {tab === "sell" ? (
            <section className="pos-card pos-table-card" aria-label="Recent sales">
              <div className="pos-card-heading">
                <h2>Recent sales</h2>
                <span className="pos-pill pos-pill-neutral">{sales.length}</span>
              </div>
              {sales.length === 0 ? (
                <div className="pos-card-body">
                  <p className="pos-hint">No register sales yet. Completed sales show up here with a Return action.</p>
                </div>
              ) : (
                <>
                  <div className="pos-table-scroll pos-table-only">
                    <table className="pos-table">
                      <thead>
                        <tr>
                          <th>Sale</th>
                          <th>Status</th>
                          <th>Taken</th>
                          <th className="is-numeric">Total</th>
                          <th className="is-numeric">Credited</th>
                          <th aria-label="Actions" />
                        </tr>
                      </thead>
                      <tbody>
                        {sales.map((sale) => {
                          const returnable = sale.status !== "void" && sale.totalMinor - sale.creditedMinor > 0;
                          return (
                            <tr key={sale.id}>
                              <th scope="row">
                                #{sale.number}
                                <span className="is-secondary">{sale.customerName ?? "Walk-in customer"} · {formatMethod(sale.method)}</span>
                              </th>
                              <td><span className={`pos-pill ${statusPill(sale.status)}`}>{formatStatus(sale.status)}</span></td>
                              <td className="is-nowrap" title={sale.createdAt}>{timeAgo(sale.createdAt)}</td>
                              <td className="is-numeric">{money(sale.totalMinor)}</td>
                              <td className="is-numeric">{sale.creditedMinor > 0 ? money(sale.creditedMinor) : "None"}</td>
                              <td>
                                <span className="pos-table-actions">
                                  <button type="button" className="pos-button pos-button-small pos-button-ghost" onClick={() => previewSaleReceipt(sale)}>Receipt</button>
                                  <button type="button" className="pos-button pos-button-small" disabled={!returnable || busy || !online || returnRecoveryBlocked} onClick={() => startReturn(sale)}>Return</button>
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <ul className="pos-cards-only pos-sales-stack">
                    {sales.map((sale) => {
                      const remaining = Math.max(0, sale.totalMinor - sale.creditedMinor);
                      const returnable = sale.status !== "void" && remaining > 0;
                      return (
                        <li key={sale.id} className="pos-sale-card">
                          <div className="pos-sale-card-heading">
                            <div>
                              <strong>Sale #{sale.number}</strong>
                              <p>{sale.customerName ?? "Walk-in customer"} · {formatMethod(sale.method)}</p>
                            </div>
                            <span className={`pos-pill ${statusPill(sale.status)}`}>{formatStatus(sale.status)}</span>
                          </div>
                          <dl className="pos-sale-card-figures">
                            <div>
                              <dt>Total</dt>
                              <dd>{money(sale.totalMinor)}</dd>
                            </div>
                            <div>
                              <dt>Remaining</dt>
                              <dd>{money(remaining)}</dd>
                            </div>
                          </dl>
                          <div className="pos-sale-card-actions">
                            <span title={sale.createdAt}>{timeAgo(sale.createdAt)}</span>
                            <div className="pos-sale-card-buttons">
                              <button type="button" className="pos-button pos-button-small pos-button-ghost" onClick={() => previewSaleReceipt(sale)}>Receipt</button>
                              {returnable ? (
                                <button type="button" className="pos-button pos-button-small" disabled={busy || !online || returnRecoveryBlocked} onClick={() => startReturn(sale)}>Return</button>
                              ) : (
                                <span className="pos-hint">No return balance</span>
                              )}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </section>
          ) : null}

          {tab === "sell" && openSession && lines.length > 0 ? (
            <div className="pos-mobile-bar">
              <button
                type="button"
                className="pos-mobile-bar-review"
                aria-label={`Review cart with ${lines.length} line${lines.length === 1 ? "" : "s"}, total ${money(total)}`}
                onClick={() => document.getElementById("pos-cart-lines")?.scrollIntoView?.({
                  block: "center",
                  behavior: prefersReducedMotion() ? "auto" : "smooth",
                })}
              >
                <span>Review cart · {lines.length} line{lines.length === 1 ? "" : "s"}</span>
                <strong>{money(total)}</strong>
              </button>
              <button
                type="button"
                className="pos-button pos-button-primary"
                disabled={busy || salePendingApproval || (saleAttemptUncertain && !online) || !checkoutReady || total <= 0 || (!online && queuedSales.length >= 20)}
                aria-label={!checkoutReady && splitMode
                  ? splitCheckoutStatus
                  : !checkoutReady && method === "cash"
                    ? `Cash due ${money(Math.max(0, total - tenderedMinor))}`
                    : online
                      ? `${saleAttemptUncertain ? "Retry same sale attempt" : "Complete sale for"} ${money(total)}`
                      : `Queue sale for ${money(total)} without charging`}
                onClick={() => (online ? void completeCurrentSale() : queueCurrentSaleOffline())}
              >
                {!checkoutReady && splitMode
                  ? splitCheckoutStatus
                  : !checkoutReady && method === "cash"
                    ? `Due ${money(Math.max(0, total - tenderedMinor))}`
                    : online ? (saleAttemptUncertain ? "Retry same sale attempt" : "Complete sale") : "Queue sale"}
              </button>
            </div>
          ) : null}

          {closeConfirm && (
            <div className="pos-modal-backdrop" role="presentation" onClick={() => setCloseConfirm(false)}>
              <div className="pos-modal" role="dialog" aria-modal="true" aria-labelledby="pos-close-title" onClick={(event) => event.stopPropagation()}>
                <div className="pos-modal-header">
                  <h2 id="pos-close-title">Close this register session?</h2>
                  <p>Expected cash is {money(expectedCash)}; you counted {money(countedCashMinor)}.</p>
                </div>
                <div className="pos-modal-body">
                  {summary && summary.tenderTotals.length > 0 ? (
                    <section className="pos-drawer-tenders" aria-label="Gross sales by tender">
                      <h3>Gross sales by tender</h3>
                      <dl className="pos-drawer-tender-list">
                        {summary.tenderTotals.map((tender) => (
                          <div key={tender.method} className="pos-drawer-tender-row">
                            <dt>{formatMethod(tender.method)}</dt>
                            <dd>{money(tender.amountMinor)}</dd>
                          </div>
                        ))}
                      </dl>
                      <p className="pos-drawer-note">Captured sales by payment type. Net cash movement and expected drawer cash are shown separately.</p>
                      {summary.refundTotals.length > 0 ? (
                        <div className="pos-drawer-refunds">
                          <h4>Refunds by destination</h4>
                          <dl className="pos-drawer-tender-list">
                            {summary.refundTotals.map((refund) => (
                              <div key={refund.method} className="pos-drawer-tender-row">
                                <dt>{formatMethod(refund.method)}</dt>
                                <dd>{money(refund.amountMinor)}</dd>
                              </div>
                            ))}
                          </dl>
                        </div>
                      ) : null}
                    </section>
                  ) : null}
                  {liveVariance !== null && liveVariance !== 0
                    ? <p className="pos-return-note">The {money(liveVariance)} variance and your note, {varianceReason.trim()}, will be recorded for review.</p>
                    : <p className="pos-return-hint">The drawer balances; closing posts the reconciliation.</p>}
                </div>
                <div className="pos-modal-footer">
                  <button type="button" className="pos-button" onClick={() => setCloseConfirm(false)}>Keep counting</button>
                  <button type="button" className="pos-button pos-button-danger" disabled={busy} onClick={() => { setCloseConfirm(false); void closeRegister(); }}>
                    {busy ? "Closing…" : "Close and reconcile"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {discardQueuedId !== null && (
            <div className="pos-modal-backdrop" role="presentation" onClick={() => setDiscardQueuedId(null)}>
              <div className="pos-modal" role="dialog" aria-modal="true" aria-labelledby="pos-discard-title" onClick={(event) => event.stopPropagation()}>
                <div className="pos-modal-header">
                  <h2 id="pos-discard-title">Discard this queued sale?</h2>
                  <p>{queuedSales.find((sale) => sale.id === discardQueuedId)?.status === "uncertain"
                    ? "The last attempt did not return a confirmed result. Verify Sales and Approvals before discarding because this sale may already have posted."
                    : "This sale has not been sent, charged, or posted. Discarding removes its local copy from this device."}</p>
                </div>
                <div className="pos-modal-footer">
                  <button type="button" className="pos-button" onClick={() => setDiscardQueuedId(null)}>Keep it queued</button>
                  <button type="button" className="pos-button pos-button-danger" onClick={() => { void discardQueuedSale(); }}>
                    {queuedSales.find((sale) => sale.id === discardQueuedId)?.status === "uncertain" ? "Discard after checking" : "Discard sale"}
                  </button>
                </div>
              </div>
            </div>
          )}
        {returnTarget ? (
            <div className="pos-modal-backdrop" role="presentation" onClick={() => { if (busy || returnAttemptLocked) return; setReturnTarget(null); setReturnReason(""); setReturnQuantities({}); }}>
              <div className="pos-modal" role="dialog" aria-modal="true" aria-labelledby="pos-return-title" onClick={(event) => event.stopPropagation()}>
                <div className="pos-modal-header">
                  <h2 id="pos-return-title">Return sale #{returnTarget.number}</h2>
                  <p>Every POS return needs approval before the refund posts or stock is restored. Review the original sale and refund destination before requesting it.</p>
                  {returnAttemptPending && <p className="pos-return-note" role="status">This exact return is awaiting approval. Retry with the same identity to check for completion; do not start another return until this request resolves.</p>}
                  {returnAttemptUncertain && <p className="pos-return-note is-error" role="alert">This exact return has an unknown result. Retry it with the same identity or verify the sale before starting another return.</p>}
                </div>
                <div className="pos-modal-body">
                  <div className="pos-return-summary" role="group" aria-label="Return amount summary">
                    <div className="pos-return-row">
                      <span>Sale total</span>
                      <strong>{money(returnTarget.totalMinor)}</strong>
                    </div>
                    <div className="pos-return-row">
                      <span>Already credited</span>
                      <strong>{money(returnTarget.creditedMinor)}</strong>
                    </div>
                    <div className="pos-return-row pos-return-row-total">
                      <span>{returnAttemptLocked ? "Saved return amount" : returnTarget.returnMode === "itemized" ? "Selected refund" : "Refund amount"}</span>
                      <strong>{returnAttemptLocked ? "Locked request" : money(returnTarget.returnMode === "itemized" ? selectedReturnTotalMinor : fullReturnMinor)}</strong>
                    </div>
                  </div>

                  <section aria-label="Items in original sale">
                    <div className="pos-card-heading">
                      <h3>{returnTarget.returnMode === "itemized" ? "Choose return quantities" : "Items in original sale"}</h3>
                      {returnTarget.returnMode === "itemized" ? <span>Qty available</span> : null}
                    </div>
                    <ul className="pos-return-lines">
                      {returnTarget.lines.map((saleLine) => {
                        const itemTotalMinor = saleLineTotalMinor(saleLine);
                        const remainingQuantity = saleLine.quantity - saleLine.returnedQuantity;
                        const selected = selectedReturnLines.find((entry) => entry.invoiceLineId === saleLine.id);
                        return (
                          <li key={saleLine.id} className="pos-return-line">
                            <div>
                              <strong>{saleLine.description}</strong>
                              <p>
                                {saleLine.quantity / 1000} × {money(saleLine.unitPriceMinor)} each · {money(itemTotalMinor)} · {saleLine.returnedQuantity > 0 ? `${saleLine.returnedQuantity / 1000} returned · ` : ""}{saleLine.stockTracked ? "Stock restored on return" : "No stock adjustment"}
                              </p>
                              {selected ? <p className="pos-return-count">Selected refund: {money(selected.refundMinor)}</p> : null}
                            </div>
                            {returnTarget.returnMode === "itemized" ? (
                              <input
                                className="pos-input pos-input-compact"
                                type="number"
                                min="0"
                                max={remainingQuantity / 1000}
                                step="0.001"
                                inputMode="decimal"
                                disabled={remainingQuantity <= 0 || returnAttemptLocked}
                                value={returnQuantities[saleLine.id] ?? ""}
                                onChange={(event) => setReturnQuantities((current) => ({ ...current, [saleLine.id]: event.target.value }))}
                                aria-label={`Quantity to return for ${saleLine.description}, ${remainingQuantity / 1000} available`}
                              />
                            ) : (
                              <span className="pos-return-line-amount">{money(itemTotalMinor)}</span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    {returnTarget.returnMode === "itemized" ? (
                      <>
                        <p className="pos-return-hint">Only the selected quantities are refunded. Inventory is restored for tracked items, and fractional tax is allocated across returns so totals match the original sale.</p>
                      <button type="button" className="pos-link-button pos-link-button-warn" disabled={returnAttemptLocked} onClick={returnAllRemaining}>Return all remaining items</button>
                      </>
                    ) : null}
                    {returnTarget.returnMode === "legacy-full" ? (
                      <p className="pos-return-note">This older sale does not link stock to individual items. A full remaining return restores its original stock movements together.</p>
                    ) : null}
                    {returnTarget.returnMode === "credit-review" ? (
                      <p className="pos-return-note is-error" role="alert">An earlier credit is not linked to returned item quantities. Ask accounting to review the sale before returning more items.</p>
                    ) : null}
                    <p className="pos-return-hint">Original tender: <strong>{formatMethod(returnTarget.method)}</strong></p>
                  </section>

                  <div className="pos-field">
                    <label htmlFor="pos-refund-method"><span>Refund destination</span></label>
                    <select
                      id="pos-refund-method"
                      className="pos-select"
                      value={refundMethod}
                      disabled={returnAttemptLocked}
                      onChange={(event) => setRefundMethod(event.target.value as RefundMethod)}
                    >
                      <option value="cash">Cash</option>
                      <option value="card">Card reversal</option>
                      <option value="mobile_money">Mobile money</option>
                    </select>
                    <small>Cash refunds reduce this open drawer. Non-cash refunds leave drawer cash unchanged.</small>
                  </div>

                  <label className="pos-field" htmlFor="return-reason">
                    <span>Reason for return</span>
                    <textarea
                      id="return-reason"
                      className="pos-textarea"
                      value={returnReason}
                      onChange={(event) => setReturnReason(event.target.value)}
                      maxLength={500}
                      placeholder="For example, item was damaged on arrival"
                      disabled={busy || returnAttemptLocked}
                    />
                  </label>
                  <p className="pos-return-count" aria-live="polite">{returnReason.length}/500</p>
                </div>
                <div className="pos-modal-footer">
                  <div className="pos-modal-footer-split">
                    <span className="pos-modal-footer-amount">{returnAttemptLocked ? "Saved request" : "Refund amount"} <strong>{returnAttemptLocked ? "Locked" : money(returnTarget.returnMode === "itemized" ? selectedReturnTotalMinor : fullReturnMinor)}</strong></span>
                    <div className="pos-modal-footer-buttons">
                      <button type="button" className="pos-button" disabled={busy || returnAttemptLocked} onClick={() => { setReturnTarget(null); setReturnReason(""); setReturnQuantities({}); setReturnAttemptUncertain(false); setReturnAttemptPending(false); }}>Cancel</button>
                      <button
                        type="button"
                        className="pos-button pos-button-danger"
                        disabled={busy || (!returnAttemptLocked && (returnReason.trim().length < 3 || returnReason.trim().length > 500 || returnTarget.returnMode === "credit-review" || (returnTarget.returnMode === "itemized" && (selectedReturnTotalMinor <= 0 || invalidReturnQuantity))))}
                        onClick={() => void submitReturn()}
                      >
                        {returnAttemptPending ? "Retry pending return safely" : returnAttemptUncertain ? "Retry exact return" : returnTarget.returnMode === "itemized" ? "Request selected return" : "Request full return"}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {receiptPreview ? (
            <div className="pos-modal-backdrop" role="presentation" onClick={() => { setReceiptPreview(null); setReceiptShareFeedback(null); }}>
              <div className="pos-modal" role="dialog" aria-modal="true" aria-labelledby="pos-receipt-title" onClick={(event) => event.stopPropagation()}>
                <div className="pos-modal-header">
                  <h2 id="pos-receipt-title">Receipt preview</h2>
                  <p>Review the sale before printing, saving, emailing, or sharing it to a messaging app. This screen does not send a message.</p>
                </div>
                <div className="pos-modal-body">
                  <div className="pos-receipt-frame">
                    <p className="pos-receipt-customer">For {receiptPreview.customerName}</p>
                    <pre className="pos-receipt-text">{receiptPreview.text}</pre>
                  </div>
                  {receiptShareFeedback ? (
                    <div className="pos-notice pos-notice-success" role="status">
                      <div className="pos-notice-body"><span className="pos-notice-title">{receiptShareFeedback}</span></div>
                    </div>
                  ) : null}
                </div>
                <div className="pos-modal-footer">
                  <div className="pos-modal-footer-buttons">
                    <button type="button" className="pos-button" onClick={() => printReceipt(receiptPreview.text)}>Print</button>
                    <button type="button" className="pos-button" onClick={() => downloadReceipt(receiptPreview.text)}>Download</button>
                    <button type="button" className="pos-button" onClick={emailReceiptDraft}>Email draft</button>
                    <button type="button" className="pos-button pos-button-primary" onClick={() => void shareReceipt(receiptPreview.text)}>Share</button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {quickProductOpen ? (
            <div className="pos-modal-backdrop" role="presentation" onClick={() => { if (!busy) { setQuickProductOpen(false); setQuickProductAdvancedOpen(false); } }}>
              <div className="pos-modal" role="dialog" aria-modal="true" aria-labelledby="pos-quick-product-title" onClick={(event) => event.stopPropagation()}>
                <div className="pos-modal-header">
                  <h2 id="pos-quick-product-title">Quick add product</h2>
                  <p>Add a price and barcode. Enter on-hand stock to sell this item right away.</p>
                </div>
                <div className="pos-modal-body">
                  <form
                    className="pos-quick-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void createQuickProduct();
                    }}
                  >
                    <label className="pos-field" htmlFor="pos-quick-name">
                      <span>Product name</span>
                      <input
                        id="pos-quick-name"
                        className="pos-input"
                        autoFocus
                        value={quickProduct.name}
                        onChange={(event) => setQuickProduct((current) => ({ ...current, name: event.target.value }))}
                        maxLength={120}
                        required
                      />
                    </label>
                    <label className="pos-field" htmlFor="pos-quick-price">
                      <span>Price</span>
                      <input
                        id="pos-quick-price"
                        className="pos-input pos-input-numeric"
                        type="number"
                        min="0"
                        step={digits === 0 ? "1" : "0.01"}
                        inputMode="decimal"
                        value={quickProduct.price}
                        onChange={(event) => setQuickProduct((current) => ({ ...current, price: event.target.value }))}
                        required
                      />
                    </label>
                    <div className="pos-field">
                      <label htmlFor="pos-quick-stock"><span>Opening stock <em>(optional)</em></span></label>
                      <input
                        id="pos-quick-stock"
                        className="pos-input pos-input-numeric"
                        type="number"
                        min="0"
                        step="0.001"
                        inputMode="decimal"
                        placeholder="0"
                        value={quickProduct.openingStock}
                        onChange={(event) => setQuickProduct((current) => ({ ...current, openingStock: event.target.value }))}
                      />
                      <small>Zero stock cannot be sold from this register.</small>
                    </div>
                    <label className="pos-field" htmlFor="pos-quick-barcode">
                      <span>Barcode <em>(optional)</em></span>
                      <input
                        id="pos-quick-barcode"
                        className="pos-input"
                        value={quickProduct.barcode}
                        onChange={(event) => setQuickProduct((current) => ({ ...current, barcode: event.target.value }))}
                        minLength={3}
                        maxLength={64}
                      />
                    </label>
                    <button
                      type="button"
                      className="pos-link-button pos-link-button-warn"
                      aria-expanded={quickProductAdvancedOpen}
                      aria-controls="pos-quick-product-advanced"
                      onClick={() => setQuickProductAdvancedOpen((open) => !open)}
                    >
                      {quickProductAdvancedOpen ? "Hide details" : "More details"}
                    </button>
                    {quickProductAdvancedOpen ? (
                      <div className="pos-quick-advanced" id="pos-quick-product-advanced">
                        <div className="pos-quick-advanced-grid">
                          <label className="pos-field" htmlFor="pos-quick-unit">
                            <span>Unit</span>
                            <input
                              id="pos-quick-unit"
                              className="pos-input"
                              value={quickProduct.unitLabel}
                              onChange={(event) => setQuickProduct((current) => ({ ...current, unitLabel: event.target.value }))}
                              maxLength={20}
                            />
                          </label>
                          <label className="pos-field" htmlFor="pos-quick-sku">
                            <span>SKU <em>(optional)</em></span>
                            <input
                              id="pos-quick-sku"
                              className="pos-input"
                              placeholder="Generated automatically if blank"
                              value={quickProduct.sku}
                              onChange={(event) => setQuickProduct((current) => ({ ...current, sku: event.target.value }))}
                              maxLength={40}
                            />
                          </label>
                        </div>
                      </div>
                    ) : null}
                    <button type="submit" className="pos-button pos-button-primary pos-button-block" disabled={busy || !quickProduct.name.trim() || !quickProduct.price.trim()}>
                      {busy ? "Saving…" : "Save product"}
                    </button>
                  </form>
                </div>
                <div className="pos-modal-footer">
                  <button type="button" className="pos-button" disabled={busy} onClick={() => { setQuickProductOpen(false); setQuickProductAdvancedOpen(false); }}>Cancel</button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}
    </main>
  );
}
