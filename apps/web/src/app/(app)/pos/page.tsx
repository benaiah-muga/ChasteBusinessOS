"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  StatCard,
  type ActionNoticeState,
  SegmentedControl,
} from "@/components/ui";
import { IconCard, IconCash, IconLock, IconPlus, IconSearch, IconTrash, IconUndo } from "@/components/icons";
import { activeCurrencyMinorUnits, cn, formatMoney, minorToInput, statusTone, timeAgo, toMinor } from "@/lib/format";
import { useMoneySync } from "@/lib/money";
import { useRouter } from "next/navigation";
import { callApi, postApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";
import { AppFrame } from "../_shell/app-frame";
import { z } from "zod";

type Tab = "overview" | "sell" | "sessions";

interface PosSession {
  id: string;
  register: string;
  status: string;
  openingFloatMinor: number;
  expectedCashMinor: number | null;
  countedCashMinor: number | null;
  varianceMinor: number | null;
  openedAt: string;
  closedAt: string | null;
}
interface SaleLine {
  description: string;
  quantity: number;
  unitPriceMinor: number;
  sku?: string;
}
interface CatalogItem {
  sku: string;
  name: string;
  kind: string;
  unitLabel: string;
  salePriceMinor: number;
  barcode: string | null;
  availableThousandths: number;
}
interface PosSale {
  id: string;
  number: number;
  status: string;
  totalMinor: number;
  creditedMinor: number;
  memo: string | null;
  customerId: string | null;
  customerName: string | null;
  method: string;
  lines: Array<{ description: string; quantity: number; unitPriceMinor: number }>;
  createdAt: string;
}
interface PosCustomer {
  id: string;
  name: string;
  email: string | null;
  purchaseCount: number;
  lifetimeSpendMinor: number;
}
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
  awaitingApproval: z.boolean(),
});
type PosDraft = z.infer<typeof posDraftSchema>;
interface ShiftSummary {
  register: string;
  status: string;
  salesCount: number;
  takingsMinor: number;
  expectedCashMinor: number;
  countedCashMinor: number | null;
  varianceMinor: number | null;
}
interface PosActionData {
  invoiceId?: string;
  invoiceNumber?: number;
  totalMinor?: number;
  tenderedMinor?: number;
  changeGivenMinor?: number;
  expectedCashMinor?: number;
  varianceMinor?: number;
  creditedMinor?: number;
  restockedLines?: number;
}

export default function PosPage() {
  useMoneySync();
  const __enabled = useModuleEnabled("pos");
  const inventoryEnabled = useModuleEnabled("inventory");
  const router = useRouter();
  const [sessions, setSessions] = useState<PosSession[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogQuery, setCatalogQuery] = useState("");
  const catalogInputRef = useRef<HTMLInputElement>(null);
  const [float, setFloat] = useState("100");
  const [line, setLine] = useState({ description: "", price: "" });
  const [customLineOpen, setCustomLineOpen] = useState(false);
  const [lines, setLines] = useState<SaleLine[]>([]);
  const [salePendingApproval, setSalePendingApproval] = useState(false);
  const [method, setMethod] = useState<"cash" | "card">("cash");
  const [counted, setCounted] = useState("");
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [sales, setSales] = useState<PosSale[]>([]);
  const [summary, setSummary] = useState<ShiftSummary | null>(null);
  const [returnTarget, setReturnTarget] = useState<PosSale | null>(null);
  const [returnReason, setReturnReason] = useState("");
  const [customers, setCustomers] = useState<PosCustomer[]>([]);
  const [customerError, setCustomerError] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState("");
  const [customerQuery, setCustomerQuery] = useState("");
  const [cashReceived, setCashReceived] = useState("");
  const [online, setOnline] = useState(true);
  const [receiptText, setReceiptText] = useState<string | null>(null);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const [draftToRestore, setDraftToRestore] = useState<PosDraft | null>(null);

  const openSession = sessions?.find((s) => s.status === "open") ?? null;
  const openSessionId = openSession?.id ?? null;
  const selectedCustomer = customers.find((customer) => customer.id === customerId) ?? null;

  const load = useCallback(async () => {
    const res = await callApi<{ sessions?: PosSession[]; sales?: PosSale[] }>("/api/pos");
    if (!res.ok) {
      setLoadError(res.error?.title ?? "Couldn't load register data");
      return false;
    }
    setLoadError(null);
    setSessions(res.data?.sessions ?? []);
    setSales(res.data?.sales ?? []);
    return true;
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem("chaste.pos.cart.v1");
      if (stored) {
        const parsed = posDraftSchema.safeParse(JSON.parse(stored));
        if (parsed.success) setDraftToRestore(parsed.data);
        else localStorage.removeItem("chaste.pos.cart.v1");
      }
    } catch {
      localStorage.removeItem("chaste.pos.cart.v1");
    }
    setDraftLoaded(true);
    const updateOnline = () => setOnline(navigator.onLine);
    updateOnline();
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, []);

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
      setSalePendingApproval(draftToRestore.awaitingApproval);
    } else {
      localStorage.removeItem("chaste.pos.cart.v1");
    }
    setDraftToRestore(null);
    setDraftReady(true);
  }, [sessions, openSessionId, draftToRestore, draftLoaded]);

  useEffect(() => {
    if (!draftReady) return;
    if (openSessionId && lines.length > 0) {
      localStorage.setItem("chaste.pos.cart.v1", JSON.stringify({
        sessionId: openSessionId,
        lines,
        customerId,
        method,
        cashReceived,
        awaitingApproval: salePendingApproval,
      }));
    } else {
      localStorage.removeItem("chaste.pos.cart.v1");
    }
  }, [draftReady, openSessionId, lines, customerId, method, cashReceived, salePendingApproval]);

  useEffect(() => {
    let active = true;
    void callApi<{ customers?: PosCustomer[] }>("/api/customers").then((res) => {
      if (!active) return;
      if (!res.ok) {
        setCustomerError(res.error?.title ?? "Customer lookup is unavailable.");
        return;
      }
      setCustomers(res.data?.customers ?? []);
      setCustomerError(null);
    });
    return () => { active = false; };
  }, []);

  const loadCatalog = useCallback(async () => {
    if (!inventoryEnabled) {
      setCatalog([]);
      setCatalogError(null);
      setCatalogLoading(false);
      return;
    }
    setCatalogLoading(true);
    const res = await callApi<{ items?: CatalogItem[] }>("/api/inventory");
    if (!res.ok) {
      setCatalogError(res.error?.title ?? "Product lookup isn't available for this account.");
      setCatalog([]);
      setCatalogLoading(false);
      return;
    }
    setCatalogError(null);
    setCatalog(res.data?.items ?? []);
    setCatalogLoading(false);
  }, [inventoryEnabled]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    if (tab !== "sell" || !openSessionId) return;
    const focusCatalog = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      event.preventDefault();
      catalogInputRef.current?.focus();
    };
    window.addEventListener("keydown", focusCatalog);
    return () => window.removeEventListener("keydown", focusCatalog);
  }, [tab, openSessionId]);

  const loadSummary = useCallback(async (sessionId: string) => {
    const res = await postApi<{ data?: ShiftSummary }>("/api/pos", { action: "shiftSummary", sessionId });
    setSummary(res.data?.data ?? null);
  }, []);

  // Re-derived whenever sessions reload so a fresh sale is counted immediately.
  useEffect(() => {
    if (!openSessionId) {
      setSummary(null);
      return;
    }
    void loadSummary(openSessionId);
  }, [openSessionId, sessions, loadSummary]);

  async function post(payload: Record<string, unknown>, label: string): Promise<{ ok: boolean; data?: PosActionData }> {
    if (!navigator.onLine) {
      setNotice({ tone: "error", error: { title: "You're offline", hint: "Your cart is saved on this device. Reconnect before posting this register action." } });
      return { ok: false };
    }
    setBusy(true);
    try {
      const res = await postApi<{ data?: PosActionData }>("/api/pos", payload);
      if (res.status === 202) {
        if (payload.action === "sale") {
          setSalePendingApproval(true);
          setNotice({ tone: "pending", text: `${label} is awaiting approval. Check Approvals before resubmitting it.` });
        } else {
          setNotice({ tone: "pending", text: `${label} requires approval.` });
        }
        return { ok: false };
      } else if (!res.ok) {
        setNotice({ tone: "error", error: res.error! });
        return { ok: false };
      } else if (payload.action === "close" && res.data?.data) {
        const d = res.data.data;
        const variance = d.varianceMinor ?? 0;
        const drawerExpected = d.expectedCashMinor ?? expectedCash;
        setNotice(
          variance === 0
            ? { tone: "success", text: `Drawer balanced exactly at ${formatMoney(drawerExpected)}.` }
            : {
                tone: "error",
                error: {
                  title: `Drawer variance of ${formatMoney(variance)} recorded`,
                  hint: `Expected ${formatMoney(drawerExpected)}. The difference is flagged for review and can't be edited away.`,
                  detail: `POS close-session\nexpected cash: ${drawerExpected}\nvariance: ${variance}`,
                },
              },
        );
      } else if (payload.action === "sale" && res.data?.data) {
        const d = res.data.data;
        setSalePendingApproval(false);
        setReceiptText([
          `Chaste BusinessOS · Sale #${d.invoiceNumber ?? ""}`,
          `Date: ${new Date().toLocaleString()}`,
          `Customer: ${selectedCustomer?.name ?? "Walk-in customer"}`,
          ...lines.map((saleLine) => `${saleLine.quantity / 1000} × ${saleLine.description} · ${formatMoney(Math.round(saleLine.quantity * saleLine.unitPriceMinor / 1000))}`),
          `Total: ${formatMoney(d.totalMinor ?? 0)}`,
          `Tender: ${String(payload.method)}${payload.method === "cash" ? ` · received ${formatMoney(d.tenderedMinor ?? d.totalMinor ?? 0)} · change ${formatMoney(d.changeGivenMinor ?? 0)}` : ""}`,
          "Thank you for your purchase.",
        ].join("\n"));
        setNotice({
          tone: "success",
          text: `Sale${d.invoiceNumber ? ` #${d.invoiceNumber}` : ""} recorded for ${formatMoney(d.totalMinor ?? 0)} (${String(payload.method)}).${(d.changeGivenMinor ?? 0) > 0 ? ` Change due ${formatMoney(d.changeGivenMinor ?? 0)}.` : ""}`,
        });
      } else {
        setNotice({ tone: "success", text: `${label} done.` });
      }
      await load();
      return { ok: true, data: res.data?.data };
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  async function shareReceipt(text: string) {
    try {
      if (navigator.share) {
        await navigator.share({ title: "Purchase receipt", text });
      } else {
        await navigator.clipboard.writeText(text);
        setNotice({ tone: "success", text: "Receipt copied. Paste it into a message to share." });
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      setNotice({ tone: "error", error: { title: "Could not share receipt", hint: "Check the browser share permissions, or try again from a secure connection." } });
    }
  }

  async function returnSale(): Promise<void> {
    if (!returnTarget) return;
    const trimmed = returnReason.trim();
    if (trimmed.length < 3 || trimmed.length > 500) {
      setNotice({
        tone: "error",
        error: { title: "Add a short reason", hint: "A return needs a reason between 3 and 500 characters for the audit trail." },
      });
      return;
    }
    const saleNumber = returnTarget.number;
    setBusy(true);
    try {
      const res = await postApi<{ data?: { creditedMinor: number; restockedLines: number } }>("/api/pos", {
        action: "returnSale",
        invoiceId: returnTarget.id,
        reason: trimmed,
      });
      if (res.status === 202) {
        setNotice({
          tone: "pending",
          text: `Return of sale #${saleNumber} is awaiting approval. It will post after someone approves it.`,
        });
        setReturnTarget(null);
        setReturnReason("");
      } else if (!res.ok || !res.data?.data) {
        setNotice({ tone: "error", error: res.error ?? { title: "That didn't work", hint: "Try again in a moment." } });
        return;
      } else {
        const d = res.data.data;
        setNotice({
          tone: "success",
          text: `Return posted - ${formatMoney(d.creditedMinor)} credited, ${d.restockedLines} line${d.restockedLines === 1 ? "" : "s"} restocked.`,
        });
        setReturnTarget(null);
        setReturnReason("");
      }
      await load();
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  function addLine(e: React.FormEvent) {
    e.preventDefault();
    if (!line.description.trim() || line.price === "" || !Number.isFinite(Number(line.price)) || Number(line.price) < 0) return;
    setLines((l) => [...l, { description: line.description.trim(), quantity: 1000, unitPriceMinor: toMinor(line.price) }]);
    setLine({ description: "", price: "" });
    setCustomLineOpen(false);
  }

  if (!sessions && loadError) {
    return (
      <EmptyState
        icon={<IconCash />}
        title={loadError}
        hint={draftToRestore ? <span>Your cart with {draftToRestore.lines.length} line{draftToRestore.lines.length === 1 ? "" : "s"} is saved on this device, awaiting connection and register validation before you can continue.</span> : "Your register history is still on file. Check the connection, then retry."}
        action={<Button tone="secondary" onClick={() => void load()}>Retry</Button>}
      />
    );
  }
  if (!sessions) return <LoadingPage />;

  const total = lines.reduce((s, l) => s + Math.round((l.quantity * l.unitPriceMinor) / 1000), 0);
  const parsedTender = method === "cash" && cashReceived.trim() ? toMinor(cashReceived) : total;
  const tenderedMinor = Number.isSafeInteger(parsedTender) && parsedTender >= 0 ? parsedTender : 0;
  const changeDueMinor = Math.max(0, tenderedMinor - total);
  const currencyDigits = activeCurrencyMinorUnits();
  const currencyScale = 10 ** currencyDigits;
  const cashPresets = currencyDigits === 0
    ? [{ label: "+1,000", amountMinor: 1000 }, { label: "+5,000", amountMinor: 5000 }]
    : [{ label: "+5", amountMinor: 5 * currencyScale }, { label: "+10", amountMinor: 10 * currencyScale }];
  const expectedCash = openSession ? openSession.openingFloatMinor + (openSession.expectedCashMinor ?? 0) : 0;
  const liveVariance = counted ? toMinor(counted) - expectedCash : null;
  const catalogResults = catalogQuery.trim()
    ? catalog.filter((item) => `${item.name} ${item.sku} ${item.barcode ?? ""}`.toLowerCase().includes(catalogQuery.trim().toLowerCase())).slice(0, 8)
    : [];
  const customerResults = customerQuery.trim()
    ? customers.filter((customer) => `${customer.name} ${customer.email ?? ""}`.toLowerCase().includes(customerQuery.trim().toLowerCase())).slice(0, 6)
    : [];

  function receiptForSale(sale: PosSale): string {
    return [
      `Chaste BusinessOS · Sale #${sale.number}`,
      `Date: ${new Date(sale.createdAt).toLocaleString()}`,
      `Customer: ${sale.customerName ?? "Walk-in customer"}`,
      ...sale.lines.map((saleLine) => `${saleLine.quantity / 1000} × ${saleLine.description} · ${formatMoney(Math.round(saleLine.quantity * saleLine.unitPriceMinor / 1000))}`),
      `Total: ${formatMoney(sale.totalMinor)}`,
      `Payment: ${sale.method}`,
      "Thank you for your purchase.",
    ].join("\n");
  }

  function clearCart() {
    setLines([]);
    setCustomerId("");
    setCustomerQuery("");
    setCashReceived("");
    setSalePendingApproval(false);
  }

  function addCatalogItem(item: CatalogItem) {
    const existingQuantity = lines.find((lineItem) => lineItem.sku === item.sku)?.quantity ?? 0;
    const available = item.kind === "service" ? Number.MAX_SAFE_INTEGER : Math.max(0, item.availableThousandths - existingQuantity);
    const quantity = Math.min(1000, available);
    if (quantity <= 0) {
      setNotice({ tone: "error", error: { title: "No stock available", hint: `${item.name} has no available stock to sell.` } });
      return;
    }
    setLines((current) => {
      const existingIndex = current.findIndex((lineItem) => lineItem.sku === item.sku);
      if (existingIndex < 0) {
        return [...current, { description: item.name, sku: item.sku, quantity, unitPriceMinor: item.salePriceMinor }];
      }
      return current.map((lineItem, index) => index === existingIndex
        ? { ...lineItem, quantity: Math.min(lineItem.quantity + quantity, item.kind === "service" ? Number.MAX_SAFE_INTEGER : item.availableThousandths) }
        : lineItem);
    });
    setCatalogQuery("");
    requestAnimationFrame(() => catalogInputRef.current?.focus());
  }

  function updateQuantity(index: number, value: string) {
    const units = Number(value);
    if (!Number.isFinite(units) || units <= 0) return;
    const quantity = Math.round(units * 1000);
    const item = lines[index]?.sku ? catalog.find((candidate) => candidate.sku === lines[index]?.sku) : undefined;
    if (item && item.kind !== "service" && quantity > item.availableThousandths) {
      setNotice({ tone: "error", error: { title: "That is more than the available stock", hint: `${item.name} has ${item.availableThousandths / 1000} ${item.unitLabel} available.` } });
      return;
    }
    setLines((current) => current.map((lineItem, lineIndex) => lineIndex === index ? { ...lineItem, quantity } : lineItem));
  }

  if (!__enabled) return <ModuleDisabled label="Point of sale" />;

  const openSessions = sessions.filter((s) => s.status === "open");
  const varianceSessions = sessions.filter((s) => s.varianceMinor !== null && s.varianceMinor !== 0);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const closedToday = sessions.filter(
    (s) => s.closedAt && new Date(s.closedAt).getTime() >= todayStart.getTime(),
  );

  return (
    <AppFrame
      appId="pos"
      description="Sales post instantly to the ledger as one balanced entry. Closing counts the drawer, variances are recorded, never smoothed over."
      persistKey="pos"
      tabs={[
        { id: "overview", label: "Overview" },
        { id: "sell", label: openSession ? "Sell · register open" : "Sell" },
        { id: "sessions", label: "Sessions", count: sessions.length || undefined },
      ]}
      activeTab={tab}
      onTabChange={(id) => setTab(id as Tab)}
    >
      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}
      {!online && (
        <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-950">
          <span><strong>Offline mode.</strong> Cart edits are saved on this device. Sales and register actions wait until you reconnect.</span>
          <span className="text-xs">Never submitted automatically</span>
        </div>
      )}
      {receiptText && (
        <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-950">
          <span>Receipt ready{selectedCustomer ? ` for ${selectedCustomer.name}` : " to share"}.</span>
          <div className="flex gap-2">
            <Button tone="secondary" size="sm" onClick={() => void shareReceipt(receiptText)}>Share receipt</Button>
            <Button tone="ghost" size="sm" onClick={() => setReceiptText(null)}>Dismiss</Button>
          </div>
        </div>
      )}
      {loadError && (
        <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span>{loadError}. Showing the last loaded register data.</span>
          <Button tone="secondary" size="sm" onClick={() => void load()}>Refresh</Button>
        </div>
      )}

      {tab === "overview" && (
        <div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label="Register"
              value={openSession ? openSession.register : "closed"}
              sub={openSession ? `open since ${timeAgo(openSession.openedAt)}` : "no session running"}
              tone={openSession ? "success" : "default"}
            />
            <StatCard label="Expected in drawer" value={openSession ? formatMoney(expectedCash) : "-"} />
            <StatCard
              label="Closed today"
              value={closedToday.length}
              sub={varianceSessions.length > 0 ? `${varianceSessions.length} variance flag` : undefined}
            />
            <StatCard
              label="Variance flags"
              value={varianceSessions.length}
              tone={varianceSessions.length > 0 ? "warn" : "default"}
            />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <Card>
              <CardTitle>The floor right now</CardTitle>
              {openSession ? (
                <ul className="space-y-2 text-sm">
                  <li className="flex items-center gap-2">
                    <span aria-hidden="true" className="size-1.5 rounded-full bg-emerald-500" />
                    “{openSession.register}” is open - float {formatMoney(openSession.openingFloatMinor)}
                  </li>
                  <li className="flex items-center gap-2">
                    <span aria-hidden="true" className="size-1.5 rounded-full bg-stone-300" />
                    {openSessions.length > 1 ? `${openSessions.length} registers open` : "One register running"}
                  </li>
                </ul>
              ) : (
                <p className="text-sm opacity-60">No register is open. Open one from the Sell tab to start ringing sales.</p>
              )}
              <div className="mt-4 flex gap-2">
                <Button onClick={() => setTab("sell")}>{openSession ? "Ring a sale" : "Open register"}</Button>
                <Button tone="ghost" onClick={() => setTab("sessions")}>
                  Session history
                </Button>
              </div>
            </Card>

            <Card>
              <CardTitle>Watch list</CardTitle>
              {varianceSessions.length === 0 ? (
                <p className="text-sm opacity-60">No drawer variances on record. Counts have matched expected cash.</p>
              ) : (
                <ul className="divide-y text-sm">
                  {varianceSessions.slice(0, 4).map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-2 py-2">
                      <span>
                        {s.register} · closed {timeAgo(s.closedAt!)}
                      </span>
                      <span className="tnum font-medium text-red-700">{formatMoney(s.varianceMinor!)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}

      {tab === "sell" && (
        <div>
          {!openSession && (
            <Card className="max-w-md">
              <CardTitle>Open the register</CardTitle>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label htmlFor="float" className="label">
                    Opening float
                  </label>
                  <input
                    id="float"
                    value={float}
                    onChange={(e) => setFloat(e.target.value)}
                    inputMode="decimal"
                    placeholder="100.00"
                    className="input"
                  />
                </div>
                <Button
                  className="mt-[22px]"
                  loading={busy}
                  onClick={() => post({ action: "open", openingFloatMinor: toMinor(float) }, "Open session")}
                >
                  Open register
                </Button>
              </div>
            </Card>
          )}
        </div>
      )}

      {tab === "sell" && openSession && (
        <div className="grid items-start gap-4 lg:grid-cols-[1fr_380px]">
          {/* Sale builder */}
          <Card>
            <CardTitle right={<Badge tone="green">register open</Badge>}>Ring a sale</CardTitle>
            {draftReady && lines.length > 0 && !salePendingApproval && (
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-xs text-emerald-900">
                <span>Cart saved on this device. You can leave and come back without losing it.</span>
                <button type="button" className="font-medium underline" onClick={clearCart} disabled={busy}>Clear cart</button>
              </div>
            )}
            {selectedCustomer ? (
              <div className="mb-4 rounded-lg border border-gold-200 bg-gold-50/50 p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-stone-900">{selectedCustomer.name}</p>
                    {selectedCustomer.email && <p className="mt-0.5 truncate text-xs text-stone-500">{selectedCustomer.email}</p>}
                  </div>
                  <button type="button" className="text-xs font-medium text-stone-500 underline" onClick={() => { setCustomerId(""); setCustomerQuery(""); }} disabled={busy || salePendingApproval}>Change customer</button>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-gold-200/70 pt-2 text-xs text-stone-600">
                  <span><strong className="tnum text-stone-900">{selectedCustomer.purchaseCount}</strong> past purchase{selectedCustomer.purchaseCount === 1 ? "" : "s"}</span>
                  <span><strong className="tnum text-stone-900">{formatMoney(selectedCustomer.lifetimeSpendMinor)}</strong> lifetime net spend</span>
                </div>
                <p className="mt-2 text-[11px] text-stone-500">Rewards points are unavailable because no loyalty program is configured for this workspace.</p>
              </div>
            ) : (
              <div className="mb-4">
                <label htmlFor="pos-customer-search" className="label">Customer lookup <span className="font-normal text-stone-400">(optional)</span></label>
                <input id="pos-customer-search" className="input" value={customerQuery} onChange={(event) => setCustomerQuery(event.target.value)} placeholder="Search name or email, or leave as walk-in" autoComplete="off" disabled={busy || salePendingApproval} />
                {customerError ? <p className="mt-1 text-xs text-amber-800">{customerError}</p> : customerQuery.trim() ? (
                  <ul className="mt-1 max-h-56 overflow-auto rounded-lg border border-stone-200 bg-white shadow-sm" aria-label="Matching customers">
                    {customerResults.map((customer) => <li key={customer.id}><button type="button" className="flex min-h-12 w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-stone-50" onClick={() => { setCustomerId(customer.id); setCustomerQuery(""); }}><span className="min-w-0"><span className="block truncate text-sm font-medium">{customer.name}</span><span className="block truncate text-xs text-stone-500">{customer.email ?? "No email"}</span></span><span className="shrink-0 text-right text-[11px] text-stone-500">{customer.purchaseCount} visits</span></button></li>)}
                    {customerResults.length === 0 && <li className="px-3 py-3 text-xs text-stone-500">No match. Continue as walk-in, or add the customer in CRM.</li>}
                  </ul>
                ) : <p className="mt-1 text-[11px] text-stone-400">Find a customer to attach this sale to their purchase history.</p>}
              </div>
            )}
            {!online && <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">Products already in the cart stay available. Register lookups need a connection.</p>}
            {inventoryEnabled ? (
              <div>
                <label htmlFor="pos-catalog-search" className="label">Find a product</label>
                <div className="relative">
                  <IconSearch aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
                  <input
                    ref={catalogInputRef}
                    id="pos-catalog-search"
                    value={catalogQuery}
                    disabled={busy || salePendingApproval}
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
                    className="input pl-9 pr-16"
                  />
                  {catalogQuery && (
                    <button
                      type="button"
                      onClick={() => {
                        setCatalogQuery("");
                        catalogInputRef.current?.focus();
                      }}
                      disabled={busy || salePendingApproval}
                      className="absolute top-1/2 right-3 -translate-y-1/2 text-xs font-medium text-stone-500 hover:text-stone-900"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <div aria-live="polite" className="mt-2">
                  {catalogError ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                      <span>{catalogError} You can still add an untracked item.</span>
                      <Button tone="secondary" size="sm" onClick={() => void loadCatalog()}>Retry</Button>
                    </div>
                  ) : catalogQuery.trim() ? (
                    catalogLoading ? (
                      <p className="rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-500">Loading product matches…</p>
                    ) : catalogResults.length > 0 ? (
                      <ul className="divide-y divide-stone-100 overflow-hidden rounded-lg border border-stone-200">
                        {catalogResults.map((item) => {
                          const outOfStock = item.kind !== "service" && item.availableThousandths <= 0;
                          return (
                            <li key={item.sku}>
                              <button
                                type="button"
                                disabled={busy || salePendingApproval || outOfStock}
                                onClick={() => addCatalogItem(item)}
                                className="flex min-h-14 w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-gold-600 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                <span className="min-w-0">
                                  <span className="block truncate text-sm font-medium text-stone-900">{item.name}</span>
                                  <span className="mt-0.5 block truncate text-xs text-stone-500">
                                    {item.sku} · {outOfStock ? "Out of stock" : item.kind === "service" ? item.unitLabel : `${item.availableThousandths / 1000} ${item.unitLabel} available`}
                                  </span>
                                </span>
                                <span className="shrink-0 text-right">
                                  <span className="block tnum text-sm font-semibold text-stone-900">{formatMoney(item.salePriceMinor)}</span>
                                  <span className="text-[11px] text-stone-500">per {item.unitLabel}</span>
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-500">No matching products. Check the name, SKU, or barcode, or add a custom line.</p>
                    )
                  ) : catalogLoading ? (
                    <p className="rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-500">Loading product catalog…</p>
                  ) : catalog.length === 0 ? (
                    <p className="rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-500">No products in the catalog yet. Add a custom line or create products in Inventory.</p>
                  ) : (
                    <p className="px-1 text-xs text-stone-500">Scan a barcode or type a few characters. Press Enter to add the first match, or / to focus search.</p>
                  )}
                </div>
              </div>
            ) : (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                Product lookup is unavailable in this workspace. You can still add an untracked item or service below.
              </p>
            )}

            {inventoryEnabled && (
              <button
                type="button"
                aria-expanded={customLineOpen}
                onClick={() => setCustomLineOpen((open) => !open)}
                disabled={busy || salePendingApproval}
                className="mt-3 inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-gold-600"
              >
                <IconPlus className="size-3.5" /> {customLineOpen ? "Hide custom item" : "Add custom item or service"}
              </button>
            )}
            {(customLineOpen || !inventoryEnabled) && (
              <form onSubmit={addLine} className="mt-2 rounded-lg border border-stone-200 bg-stone-50/70 p-3">
                <p className="mb-2 text-xs text-stone-500">Custom lines are not connected to stock counts.</p>
                <div className="grid gap-2 sm:grid-cols-[1fr_140px_auto]">
                  <label className="text-xs font-medium text-stone-600">
                    Description
                    <input
                      value={line.description}
                      onChange={(event) => setLine((current) => ({ ...current, description: event.target.value }))}
                      placeholder="One-off item or service"
                      aria-label="Custom item description"
                      required
                      disabled={busy || salePendingApproval}
                      className="input mt-1"
                    />
                  </label>
                  <label className="text-xs font-medium text-stone-600">
                    Unit price
                    <input
                      value={line.price}
                      onChange={(event) => setLine((current) => ({ ...current, price: event.target.value }))}
                      placeholder="0.00"
                      aria-label="Custom item unit price"
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      required
                      disabled={busy || salePendingApproval}
                      className="input mt-1"
                    />
                  </label>
                  <Button type="submit" tone="secondary" className="self-end" loading={busy} disabled={salePendingApproval}>
                    <IconPlus className="size-3.5" /> Add line
                  </Button>
                </div>
              </form>
            )}

            {salePendingApproval && (
              <div role="status" className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                <span>This cart is already awaiting approval. Starting another sale clears it from this screen, not from Approvals.</span>
                <Button
                  tone="secondary"
                  size="sm"
                  onClick={() => {
                    clearCart();
                    setCatalogQuery("");
                    requestAnimationFrame(() => catalogInputRef.current?.focus());
                  }}
                >
                  Start another sale
                </Button>
              </div>
            )}

            {lines.length > 0 && (
              <ul className="mt-4 divide-y divide-stone-100 border-y border-stone-100">
              {lines.map((l, i) => {
                const catalogItem = l.sku ? catalog.find((item) => item.sku === l.sku) : undefined;
                return (
                  <li key={l.sku ?? `${l.description}-${i}`} className="flex items-center gap-2 py-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-stone-800">{l.description}</span>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-stone-500">
                        <label className="flex items-center gap-1.5">
                          <span className="sr-only">Quantity for {l.description}</span>
                          <input
                            type="number"
                            min="0.001"
                            step="0.001"
                            max={catalogItem && catalogItem.kind !== "service" ? catalogItem.availableThousandths / 1000 : undefined}
                            value={l.quantity / 1000}
                            onChange={(event) => updateQuantity(i, event.target.value)}
                            aria-label={`Quantity for ${l.description}`}
                            disabled={busy || salePendingApproval}
                            className="input h-8 w-20 px-2 text-center tnum"
                          />
                          <span>{catalogItem?.unitLabel ?? "unit"}</span>
                        </label>
                        <span>× {formatMoney(l.unitPriceMinor)} each</span>
                      </div>
                    </div>
                    <span className="tnum shrink-0 font-semibold">{formatMoney(Math.round((l.quantity * l.unitPriceMinor) / 1000))}</span>
                    <button
                      type="button"
                      onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                      aria-label={`Remove ${l.description}`}
                      className="icon-btn size-8 shrink-0 text-stone-500 hover:text-red-600"
                      disabled={busy || salePendingApproval}
                    >
                      <IconTrash className="size-3.5" />
                    </button>
                  </li>
                );
              })}
              </ul>
            )}

            <div className="mt-4 flex items-baseline justify-between">
              <span className="text-sm text-stone-500">Cart · {lines.length} line{lines.length === 1 ? "" : "s"}</span>
              <span className="tnum text-2xl font-semibold tracking-tight">{formatMoney(total)}</span>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <SegmentedControl
                ariaLabel="Payment method"
                value={method}
                onChange={setMethod}
                disabled={busy || salePendingApproval}
                options={[
                  { value: "cash", label: "Cash", icon: <IconCash className="size-3.5" /> },
                  { value: "card", label: "Card", icon: <IconCard className="size-3.5" /> },
                ]}
              />
            </div>
            {method === "cash" && (
              <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50/70 p-3">
                <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                  <label className="label" htmlFor="pos-cash-received">Cash received
                    <input id="pos-cash-received" className="input mt-1 text-base tnum" type="number" min="0" step={currencyDigits === 0 ? "1" : "0.01"} inputMode="decimal" value={cashReceived} onChange={(event) => setCashReceived(event.target.value)} placeholder={minorToInput(total)} disabled={busy || salePendingApproval} />
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" className="rounded-md border border-stone-200 bg-white px-2.5 py-2 text-xs font-medium hover:bg-stone-100" onClick={() => setCashReceived(minorToInput(total))} disabled={busy || salePendingApproval}>Exact</button>
                    {cashPresets.map((preset) => <button key={preset.label} type="button" className="rounded-md border border-stone-200 bg-white px-2.5 py-2 text-xs font-medium hover:bg-stone-100" onClick={() => setCashReceived(minorToInput(total + preset.amountMinor))} disabled={busy || salePendingApproval}>{preset.label}</button>)}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-stone-200 pt-2 text-sm">
                  <span className="text-stone-500">Due now <strong className="tnum ml-1 text-stone-900">{formatMoney(total)}</strong></span>
                  <span className={cn("font-semibold", tenderedMinor < total ? "text-red-700" : "text-emerald-800")}>{tenderedMinor < total ? `Short by ${formatMoney(total - tenderedMinor)}` : `Change due ${formatMoney(changeDueMinor)}`}</span>
                </div>
              </div>
            )}
            <Button
              className="mt-4 min-h-11 w-full"
              loading={busy}
              disabled={lines.length === 0 || salePendingApproval || !online || (method === "cash" && tenderedMinor < total)}
              onClick={async () => {
                const result = await post({ action: "sale", sessionId: openSession.id, method, lines, ...(customerId ? { customerId } : {}), ...(method === "cash" ? { cashReceivedMinor: tenderedMinor } : {}) }, `Sale ${formatMoney(total)} (${method})`);
                if (result.ok) {
                  setLines([]);
                  setCashReceived("");
                }
              }}
            >
              Complete sale · {formatMoney(total)}
            </Button>
          </Card>

          {/* Drawer */}
          <Card>
            <CardTitle>Close &amp; count drawer</CardTitle>
            <dl className="mb-4 space-y-2 rounded-lg bg-stone-50 p-3.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-stone-500">Opening float</dt>
                <dd className="tnum">{formatMoney(openSession.openingFloatMinor)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-stone-500">Cash sales</dt>
                <dd className="tnum">{formatMoney(openSession.expectedCashMinor ?? 0)}</dd>
              </div>
              <div className="flex justify-between border-t border-stone-200 pt-2 font-semibold">
                <dt>Expected cash</dt>
                <dd className="tnum">{formatMoney(expectedCash)}</dd>
              </div>
            </dl>
            <label htmlFor="counted" className="label">
              Counted cash
            </label>
            <input
              id="counted"
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
              inputMode="decimal"
              placeholder="Count the drawer…"
              className="input"
            />
            {liveVariance !== null && (
              <p
                className={cn(
                  "tnum mt-2 rounded-lg px-3 py-2 text-sm",
                  liveVariance === 0
                    ? "bg-emerald-50 text-emerald-800"
                    : "bg-red-50 font-medium text-red-800",
                )}
              >
                {liveVariance === 0 ? "Balanced, matches expected cash." : `Variance preview: ${formatMoney(liveVariance)}`}
              </p>
            )}
            <Button
              tone="dangerSecondary"
              className="mt-4 w-full"
              disabled={!counted || lines.length > 0 || busy}
              onClick={() => setCloseConfirm(true)}
            >
              <IconLock className="size-3.5" />
              Close session &amp; reconcile
            </Button>
            {lines.length > 0 && <p className="mt-2 text-xs text-amber-800">Complete the current cart before closing this register.</p>}
          </Card>
        </div>
      )}

      {tab === "sell" && summary && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-stone-500">Current shift</span>
            <Badge tone={summary.status === "open" ? "green" : "neutral"}>{summary.register} · {summary.status}</Badge>
          </div>
          <p><strong className="tnum">{summary.salesCount}</strong> sale{summary.salesCount === 1 ? "" : "s"} · <strong className="tnum">{formatMoney(summary.takingsMinor)}</strong> total takings</p>
        </div>
      )}

      {tab === "sell" && (
        <Card className="mt-4">
          <CardTitle right={<Badge tone="neutral">{sales.length}</Badge>}>Recent sales</CardTitle>
          {sales.length === 0 ? (
            <p className="text-sm opacity-60">No register sales yet. Completed sales show up here with a Return action.</p>
          ) : (
            <>
            <ul className="space-y-2 sm:hidden" aria-label="Recent sales">
              {sales.map((sale) => {
                const remaining = sale.totalMinor - sale.creditedMinor;
                const returnable = sale.status !== "void" && remaining > 0;
                return (
                  <li key={sale.id} className="rounded-xl border border-stone-200 bg-white p-3 shadow-xs">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-stone-900">Sale #{sale.number}</p>
                        <p className="mt-0.5 truncate text-xs text-stone-500">{sale.customerName ?? "Walk-in customer"} · {sale.method}</p>
                      </div>
                      <Badge tone={statusTone(sale.status)}>{sale.status}</Badge>
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-stone-100 pt-2 text-sm">
                      <div>
                        <dt className="text-xs text-stone-500">Total</dt>
                        <dd className="tnum font-medium">{formatMoney(sale.totalMinor)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-stone-500">Remaining</dt>
                        <dd className="tnum font-medium">{formatMoney(Math.max(0, remaining))}</dd>
                      </div>
                    </dl>
                    <div className="mt-3 flex items-center justify-between gap-3 border-t border-stone-100 pt-2">
                      <span className="text-xs text-stone-500" title={new Date(sale.createdAt).toLocaleString()}>{timeAgo(sale.createdAt)}</span>
                      <div className="flex gap-2">
                        <Button tone="ghost" size="sm" onClick={() => void shareReceipt(receiptForSale(sale))}>Share receipt</Button>
                        {returnable ? <Button tone="secondary" size="sm" disabled={busy || !online} onClick={() => { setReturnTarget(sale); setReturnReason(""); }}><IconUndo className="size-3.5" /> Return</Button> : <span className="self-center text-xs text-stone-400">No return balance</span>}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="table-shell hidden sm:block">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Sale</th>
                    <th>Status</th>
                    <th>Taken</th>
                    <th className="text-right">Total</th>
                    <th className="text-right">Credited</th>
                    <th className="text-right" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {sales.map((sale) => {
                    const returnable = sale.status !== "void" && sale.totalMinor - sale.creditedMinor > 0;
                    return (
                      <tr key={sale.id}>
                        <td className="font-medium">
                          #{sale.number}
                          <span className="block text-xs font-normal text-stone-500">{sale.customerName ?? "Walk-in customer"} · {sale.method}</span>
                        </td>
                        <td>
                          <Badge tone={statusTone(sale.status)}>{sale.status}</Badge>
                        </td>
                        <td className="text-xs whitespace-nowrap text-stone-500" title={new Date(sale.createdAt).toLocaleString()}>
                          {timeAgo(sale.createdAt)}
                        </td>
                        <td className="num">{formatMoney(sale.totalMinor)}</td>
                        <td className="num">{sale.creditedMinor > 0 ? formatMoney(sale.creditedMinor) : "-"}</td>
                        <td className="text-right">
                          <div className="inline-flex gap-1">
                            <Button tone="ghost" size="sm" onClick={() => void shareReceipt(receiptForSale(sale))}>Share</Button>
                            <Button tone="secondary" size="sm" disabled={!returnable || busy || !online} onClick={() => { setReturnTarget(sale); setReturnReason(""); }}><IconUndo className="size-3.5" />Return</Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            </>
          )}
        </Card>
      )}

      {tab === "sessions" &&
        (sessions.length > 0 ? (
          <section>
            <h2 className="section-title mb-3">Register history</h2>
            <ul className="space-y-2 sm:hidden" aria-label="Register history">
              {sessions.map((s) => (
                <li key={s.id} className={cn("rounded-xl border bg-white p-3 shadow-xs", s.varianceMinor !== null && s.varianceMinor !== 0 ? "border-red-200" : "border-stone-200")}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-stone-900">{s.register}</p>
                      <p className="mt-0.5 text-xs text-stone-500">Opened {timeAgo(s.openedAt)}{s.closedAt ? ` · closed ${timeAgo(s.closedAt)}` : " · still open"}</p>
                    </div>
                    <Badge tone={statusTone(s.status)}>{s.status}</Badge>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-stone-100 pt-2 text-sm">
                    <div><dt className="text-xs text-stone-500">Expected in drawer</dt><dd className="tnum font-medium">{formatMoney(s.openingFloatMinor + (s.expectedCashMinor ?? 0))}</dd></div>
                    <div><dt className="text-xs text-stone-500">Counted</dt><dd className="tnum font-medium">{s.countedCashMinor !== null ? formatMoney(s.countedCashMinor) : "-"}</dd></div>
                    <div className="col-span-2"><dt className="text-xs text-stone-500">Variance</dt><dd className={cn("tnum font-medium", s.varianceMinor ? "text-red-700" : "")}>{s.varianceMinor !== null ? formatMoney(s.varianceMinor) : "Not reconciled"}</dd></div>
                  </dl>
                </li>
              ))}
            </ul>
            <div className="table-shell hidden sm:block">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Register</th>
                    <th>Status</th>
                    <th>Opened</th>
                    <th className="text-right">Expected in drawer</th>
                    <th className="text-right">Counted</th>
                    <th className="text-right">Variance</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id} className={s.varianceMinor !== null && s.varianceMinor !== 0 ? "bg-red-50/50" : undefined}>
                      <td className="font-medium">{s.register}</td>
                      <td>
                        <Badge tone={statusTone(s.status)}>{s.status}</Badge>
                      </td>
                      <td className="text-xs whitespace-nowrap text-stone-500" title={new Date(s.openedAt).toLocaleString()}>
                        {timeAgo(s.openedAt)}
                      </td>
                      <td className="num">{formatMoney(s.openingFloatMinor + (s.expectedCashMinor ?? 0))}</td>
                      <td className="num">{s.countedCashMinor !== null ? formatMoney(s.countedCashMinor) : "-"}</td>
                      <td className={cn("num", s.varianceMinor ? "font-semibold text-red-700" : "")}>
                        {s.varianceMinor !== null ? formatMoney(s.varianceMinor) : "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : (
          <EmptyState icon={<IconCash />} title="No register sessions yet" hint="Open a register from the Sell tab to start ringing sales." />
        ))}

      <ConfirmDialog
        open={closeConfirm}
        onClose={() => setCloseConfirm(false)}
        onConfirm={async () => {
          setCloseConfirm(false);
          const result = await post(
            { action: "close", sessionId: openSession?.id, countedCashMinor: toMinor(counted) },
            "Close session",
          );
          if (result.ok) {
            setCounted("");
            setLines([]);
          }
        }}
        title="Close this register session?"
        body={
          <>
            Expected cash is <strong className="text-stone-900">{formatMoney(expectedCash)}</strong>; you counted{" "}
            <strong className="text-stone-900">{formatMoney(toMinor(counted))}</strong>.{" "}
            {liveVariance !== null && liveVariance !== 0
              ? `The ${formatMoney(liveVariance)} variance will be recorded and flagged, it can't be edited away later.`
              : "The drawer balances; closing posts the reconciliation."}
          </>
        }
        confirmLabel="Close & reconcile"
        busy={busy}
      />
      <Dialog
        open={Boolean(returnTarget)}
        onClose={() => {
          if (busy) return;
          setReturnTarget(null);
          setReturnReason("");
        }}
        title={`Return sale${returnTarget ? ` #${returnTarget.number}` : ""}`}
        description="A return request is recorded in the audit trail. Credit is applied after approval."
        footer={
          <>
            <Button
              tone="secondary"
              disabled={busy}
              onClick={() => {
                setReturnTarget(null);
                setReturnReason("");
              }}
            >
              Cancel
            </Button>
            <Button
              tone="dangerSecondary"
              loading={busy}
              disabled={returnReason.trim().length < 3 || returnReason.trim().length > 500}
              onClick={() => void returnSale()}
            >
              <IconUndo className="size-3.5" /> Request return
            </Button>
          </>
        }
      >
        {returnTarget && (
          <div>
            <div className="mb-4 rounded-lg bg-stone-50 p-3 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-stone-500">Sale total</span>
                <strong className="tnum">{formatMoney(returnTarget.totalMinor)}</strong>
              </div>
              <div className="mt-1 flex justify-between gap-3">
                <span className="text-stone-500">Already credited</span>
                <strong className="tnum">{formatMoney(returnTarget.creditedMinor)}</strong>
              </div>
              <div className="mt-2 flex justify-between gap-3 border-t border-stone-200 pt-2 font-semibold">
                <span>Remaining return balance</span>
                <span className="tnum">{formatMoney(Math.max(0, returnTarget.totalMinor - returnTarget.creditedMinor))}</span>
              </div>
            </div>
            <label htmlFor="return-reason" className="label">Reason for return</label>
            <textarea
              id="return-reason"
              value={returnReason}
              onChange={(event) => setReturnReason(event.target.value)}
              maxLength={500}
              rows={3}
              placeholder="For example, item was damaged on arrival"
              className="textarea resize-y"
              disabled={busy}
            />
            <p className="mt-1 text-right text-xs text-stone-400" aria-live="polite">{returnReason.length}/500</p>
          </div>
        )}
      </Dialog>
    </AppFrame>
  );
}
