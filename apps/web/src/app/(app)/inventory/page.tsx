"use client";

import { useCallback, useEffect, useMemo, useState, Fragment, useId } from "react";
import {
  ActionNotice,
  Badge,
  Button,
  Card,
  CardTitle,
  Dialog,
  EmptyState,
  LoadingPage,
  StatCard,
  type ActionNoticeState,
} from "@/components/ui";
import { cn, formatDateTime, formatMoney } from "@/lib/format";
import { useMoneySync } from "@/lib/money";
import { IconChevronDown, IconListTree } from "@/components/icons";
import { callApi, postApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";
import { AppFrame } from "../_shell/app-frame";

type Tab = "overview" | "levels" | "reorder" | "counts" | "locations";

interface StockItem {
  sku: string;
  name: string;
  kind?: string;
  barcode?: string | null;
  unitLabel: string;
  onHandThousandths: number;
  reservedThousandths: number;
  availableThousandths: number;
  reorderPointThousandths: number;
  reorderNeeded: boolean;
  totalValueMinor: number;
  avgUnitCostMinor: number;
}
interface ReorderAlert {
  sku: string;
  name: string;
  onHandThousandths: number;
  reorderPointThousandths: number;
  shortfallThousandths: number;
  avgUnitCostMinor: number;
}
interface Movement {
  id: string;
  quantityDelta: number;
  reason: string;
  note: string | null;
  refType: string | null;
  unitCostMinor: number | null;
  lotCode: string | null;
  locationCode: string | null;
  actorType: string;
  createdAt: string;
}
interface Reservation {
  id: string;
  sku: string;
  quantityThousandths: number;
  reason: string;
  status: string;
  createdAt: string;
}
interface CountLine {
  sku: string;
  expectedThousandths: number;
  countedThousandths: number | null;
  varianceThousandths: number | null;
}
interface CycleCount {
  id: string;
  status: string;
  note: string | null;
  locationCode: string | null;
  createdAt: string;
  lines: CountLine[];
}
interface Location {
  id: string;
  code: string;
  name: string;
}
interface TransferLine {
  sku: string;
  quantityThousandths: number;
  confirmedThousandths: number;
}
interface TransferRow {
  id: string;
  number: number;
  status: string;
  note: string | null;
  from: string;
  to: string;
  lines: TransferLine[];
}
interface Payload {
  items?: StockItem[];
  reorderAlerts?: ReorderAlert[];
  locations?: Location[];
  reservations?: Reservation[];
  cycleCounts?: CycleCount[];
  transfers?: TransferRow[];
}
const qty = (t: number) => (t / 1000).toFixed(3);

export default function InventoryPage() {
  useMoneySync();
  const __enabled = useModuleEnabled("inventory");
  const [data, setData] = useState<Payload | null>(null);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");

  const [expanded, setExpanded] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, Movement[]>>({});
  const [newItem, setNewItem] = useState({ sku: "", name: "", unitLabel: "unit", openingQty: "", openingReason: "Opening balance", reorder: "" });

  const [vendorId, setVendorId] = useState("");
  const [vendors, setVendors] = useState<{ id: string; name: string }[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [poNumber, setPoNumber] = useState<number | null>(null);

  const [countAllItems, setCountAllItems] = useState(true);
  const [selectedCountSkus, setSelectedCountSkus] = useState<string[]>([]);
  const [countSearch, setCountSearch] = useState("");
  const [countBarcode, setCountBarcode] = useState("");
  const [countLocationId, setCountLocationId] = useState("");
  const [countNote, setCountNote] = useState("Scheduled cycle count");
  const [countEntries, setCountEntries] = useState<Record<string, string>>({});
  const [reviewCount, setReviewCount] = useState<CycleCount | null>(null);
  const [locForm, setLocForm] = useState({ code: "", name: "" });
  const [reserveForm, setReserveForm] = useState({ sku: "", qty: "", reason: "" });
  const [transferForm, setTransferForm] = useState({ from: "", to: "", sku: "", qty: "", note: "" });
  const [barcode, setBarcode] = useState("");
  const [scannedSku, setScannedSku] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await callApi<Payload>("/api/inventory");
    setData(res.data ?? {});
    if (res.error) setNotice({ tone: "error", error: res.error });
  }, []);

  useEffect(() => {
    void load();
    void callApi<{ vendors: { id: string; name: string }[] }>("/api/purchasing").then((r) =>
      setVendors(r.data?.vendors ?? []),
    );
  }, [load]);

  async function post(payload: Record<string, unknown>, label: string) {
    setBusy(true);
    try {
      const res = await postApi("/api/inventory", payload);
      if (res.status === 202) {
        setNotice({ tone: "pending", text: `${label} requires approval.` });
      } else if (!res.ok) {
        setNotice({ tone: "error", error: res.error ?? { title: `${label} failed`, hint: "Try again." } });
      } else {
        setNotice({ tone: "success", text: `${label} done.` });
        await load();
        return true;
      }
    } finally {
      setBusy(false);
    }
    return false;
  }

  async function createStockItem(): Promise<void> {
    if (!newItem.sku.trim() || !newItem.name.trim()) return;
    const created = await post({
      action: "createItem",
      sku: newItem.sku.trim(),
      name: newItem.name.trim(),
      unitLabel: newItem.unitLabel.trim() || "unit",
      reorderPointThousandths: Math.round(Number(newItem.reorder || "0") * 1000),
    }, `Create ${newItem.sku.trim()}`);
    if (!created) return;
    const openingQty = Math.round(Number(newItem.openingQty || "0") * 1000);
    if (openingQty > 0) {
      const adjusted = await post({ action: "adjustStock", sku: newItem.sku.trim(), quantityDelta: openingQty, note: newItem.openingReason.trim() || "Opening balance" }, "Record opening balance");
      if (!adjusted) return;
    }
    setNewItem({ sku: "", name: "", unitLabel: "unit", openingQty: "", openingReason: "Opening balance", reorder: "" });
  }

  async function toggleHistory(sku: string) {
    if (expanded === sku) {
      setExpanded(null);
      return;
    }
    setExpanded(sku);
    if (!history[sku]) {
      const res = await callApi<{ movements: Movement[] }>(`/api/inventory?sku=${encodeURIComponent(sku)}`);
      if (res.data?.movements) setHistory((h) => ({ ...h, [sku]: res.data!.movements }));
    }
  }

  /** Scan-at-receiving: resolves a barcode to an item or an honest null. */
  async function lookupBarcode(): Promise<void> {
    if (barcode.trim().length < 3) return;
    const res = await postApi<{ data?: { item: { sku: string; name: string } | null } }>("/api/inventory", {
      action: "lookupByBarcode",
      barcode: barcode.trim(),
    });
    const item = res.ok ? res.data?.data?.item ?? null : null;
    if (item) {
      setScannedSku(item.sku);
      setNotice({ tone: "success", text: `${item.name} (${item.sku}) - highlighted below.` });
    } else {
      setScannedSku(null);
      setNotice({
        tone: "error",
        error: { title: res.ok ? "No item carries that barcode" : "Lookup failed", hint: res.ok ? "Check the code, or add the barcode to the product in the Products app." : res.error?.hint ?? "Try again." },
      });
    }
  }

  async function addCountScan(): Promise<void> {
    const code = countBarcode.trim();
    if (code.length < 3) return;
    const res = await postApi<{ data?: { item: { sku: string; name: string } | null } }>("/api/inventory", {
      action: "lookupByBarcode",
      barcode: code,
    });
    const item = res.ok ? res.data?.data?.item ?? null : null;
    if (!item) {
      setNotice({ tone: "error", error: { title: res.ok ? "No item carries that barcode" : "Lookup failed", hint: res.ok ? "Check the code or add a barcode in Products & Services." : res.error?.hint ?? "Try again." } });
      return;
    }
    setSelectedCountSkus((current) => current.includes(item.sku) ? current : [...current, item.sku]);
    setCountAllItems(false);
    setCountSearch("");
    setCountBarcode("");
    setNotice({ tone: "success", text: `${item.name} added to this count.` });
  }

  async function draftPo() {
    if (!vendorId || picked.size === 0) return;
    setBusy(true);
    try {
      const alerts = (data?.reorderAlerts ?? []).filter((a) => picked.has(a.sku));
      const res = await postApi<{ data?: { poNumber: number } }>("/api/purchasing", {
        action: "createPurchaseOrder",
        vendorId,
        lines: alerts.map((a) => ({
          description: `${a.name} (${a.sku}) replenishment to reorder point`,
          quantity: Math.max(1000, a.reorderPointThousandths - a.onHandThousandths),
          unitPriceMinor: a.avgUnitCostMinor,
          sku: a.sku,
        })),
      });
      if (res.status === 202) setNotice({ tone: "pending", text: "Purchase order needs approval." });
      else if (!res.ok) {
        if (res.error) setNotice({ tone: "error", error: res.error });
      } else {
        setPoNumber(res.data?.data?.poNumber ?? null);
        setPicked(new Set());
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  const items = useMemo(() => data?.items ?? [], [data]);
  const countableItems = useMemo(() => items.filter((item) => item.kind !== "service"), [items]);
  const matchingCountItems = useMemo(() => {
    const query = countSearch.trim().toLowerCase();
    return countableItems.filter((item) => !query || `${item.name} ${item.sku}`.toLowerCase().includes(query)).slice(0, 12);
  }, [countableItems, countSearch]);
  const totalValue = useMemo(() => items.reduce((s, i) => s + i.totalValueMinor, 0), [items]);

  if (!data) return <LoadingPage />;
  if (!__enabled) return <ModuleDisabled label="Inventory" />;

  return (
    <AppFrame
      appId="inventory"
      description="Stock ledger, valuation, counting, and what to buy next"
      persistKey="inventory"
      tabs={[
        { id: "overview", label: "Overview" },
        { id: "levels", label: "Stock levels", count: items.length || undefined },
        { id: "reorder", label: "Reorder", count: (data.reorderAlerts ?? []).length || undefined },
        { id: "counts", label: "Cycle counts" },
        { id: "locations", label: "Locations" },
      ]}
      activeTab={tab}
      onTabChange={(id) => setTab(id as Tab)}
    >
      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}

      {tab === "overview" && <InventoryOverview data={data} totalValue={totalValue} goTo={(t) => setTab(t)} />}

      {tab === "levels" && (
        <>
          <Card>
            <CardTitle
              right={
                <div className="flex items-center gap-2">
                  <Badge tone="blue">total value {formatMoney(totalValue)}</Badge>
                  <Button
                    tone="secondary"
                    size="sm"
                    disabled={busy || totalValue === 0}
                    onClick={() => void post({ action: "postValuationSummary", memo: `Valuation summary ${new Date().toISOString().slice(0, 10)}` }, "Post valuation summary")}
                    title="Posts the inventory value to the ledger as a summary entry - approval-gated"
                  >
                    Post valuation summary
                  </Button>
                </div>
              }
            >
              Stock on hand
            </CardTitle>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <input
                className="w-56 rounded border bg-transparent px-2 py-1.5"
                placeholder="Scan or type a barcode…"
                aria-label="Barcode lookup"
                value={barcode}
                onChange={(e) => setBarcode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void lookupBarcode();
                }}
              />
              <Button tone="secondary" size="sm" disabled={busy || barcode.trim().length < 3} onClick={() => void lookupBarcode()}>
                Look up
              </Button>
              {scannedSku && <Badge tone="green">scanned: {scannedSku}</Badge>}
            </div>
            {items.length === 0 ? (
              <EmptyState icon={<IconListTree />} title="No inventory tracked yet" hint="Add a product, record its opening balance and set a reorder point. You can create a stock location now or later." action={<div className="flex flex-wrap justify-center gap-2"><Button onClick={() => document.getElementById("inventory-create-item-name")?.focus()}>Add first item</Button><Button tone="secondary" onClick={() => setTab("locations")}>Create a location</Button><Button tone="secondary" onClick={() => window.location.assign("/products")}>Open Products &amp; Services</Button></div>} />
            ) : (
              <>
              <ul className="space-y-2 sm:hidden" aria-label="Stock items">
                {items.map((item) => (
                  <li key={item.sku} className={`rounded-xl border p-3 ${scannedSku === item.sku ? "border-emerald-300 bg-emerald-50/70" : "border-stone-200 bg-white"}`}>
                    <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-semibold text-stone-900">{item.name}</p><p className="mt-0.5 font-mono text-[11px] text-stone-500">{item.sku}</p></div>{item.reorderNeeded && <Badge tone="amber">Reorder</Badge>}</div>
                    <div className="mt-3 grid grid-cols-3 gap-2 border-t border-stone-100 pt-2 text-xs"><div><p className="text-stone-500">On hand</p><p className="tnum mt-0.5 font-semibold">{qty(item.onHandThousandths)} {item.unitLabel}</p></div><div><p className="text-stone-500">Available</p><p className="tnum mt-0.5 font-semibold">{qty(item.availableThousandths)}</p></div><div><p className="text-stone-500">Value at cost</p><p className="tnum mt-0.5 font-semibold">{formatMoney(item.totalValueMinor)}</p></div></div>
                    {item.reservedThousandths > 0 && <p className="mt-2 text-[11px] text-stone-500">{qty(item.reservedThousandths)} reserved</p>}
                    <button type="button" className="mt-3 min-h-9 w-full rounded-md border border-stone-200 text-xs font-medium text-stone-600" aria-expanded={expanded === item.sku} onClick={() => void toggleHistory(item.sku)}>{expanded === item.sku ? "Hide stock history" : "View stock history"}</button>
                    {expanded === item.sku && <ol className="mt-2 divide-y divide-stone-100 rounded-lg bg-stone-50 px-2">{(history[item.sku] ?? []).length === 0 ? <li className="py-2 text-xs text-stone-500">Loading stock ledger…</li> : (history[item.sku] ?? []).map((movement) => <li key={movement.id} className="py-2 text-xs"><div className="flex items-start justify-between gap-2"><span className="font-medium text-stone-700">{movement.reason}</span><span className={`tnum font-semibold ${movement.quantityDelta < 0 ? "text-red-700" : "text-green-800"}`}>{movement.quantityDelta > 0 ? "+" : ""}{qty(movement.quantityDelta)}</span></div><p className="mt-0.5 text-stone-500">{formatDateTime(movement.createdAt)}{movement.locationCode ? ` · ${movement.locationCode}` : ""}{movement.note ? ` · ${movement.note}` : ""}</p></li>)}</ol>}
                  </li>
                ))}
              </ul>
              <div className="overflow-x-auto">
              <table className="hidden w-full min-w-[760px] text-sm sm:table">
                <thead>
                  <tr className="text-left opacity-60">
                    <th className="py-1.5">SKU</th>
                    <th>Name</th>
                    <th className="text-right">On hand</th>
                    <th
                      className="text-right"
                      title="Available-to-promise: on hand minus open reservations - what you can still sell"
                    >
                      Available
                    </th>
                    <th className="text-right" title="On hand × moving average cost - what the stock is worth at cost">
                      Value
                    </th>
                    <th
                      className="text-right"
                      title="Moving average of what inward movements cost; advances only when stock comes in"
                    >
                      Avg cost
                    </th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <Fragment key={i.sku}>
                      <tr className={`border-t ${scannedSku === i.sku ? "bg-emerald-50/70" : ""}`}>
                        <td className="py-1.5 font-mono">{i.sku}</td>
                        <td>{i.name}</td>
                        <td className="text-right tabular-nums">
                          {qty(i.onHandThousandths)} {i.unitLabel}
                          {i.reservedThousandths > 0 && (
                            <span className="ml-1 text-xs opacity-50">(−{qty(i.reservedThousandths)} reserved)</span>
                          )}
                        </td>
                        <td className="text-right tabular-nums">{qty(i.availableThousandths)}</td>
                        <td className="text-right tabular-nums">{formatMoney(i.totalValueMinor)}</td>
                        <td className="text-right tabular-nums">{formatMoney(i.avgUnitCostMinor)}</td>
                        <td className="text-right whitespace-nowrap">
                          {i.reorderNeeded ? <Badge tone="amber">reorder</Badge> : null}
                          <button
                            className="ml-2 inline-flex cursor-pointer items-center gap-0.5 text-xs opacity-60 hover:opacity-100"
                            onClick={() => void toggleHistory(i.sku)}
                          >
                            <IconChevronDown className={expanded === i.sku ? "rotate-180 transition-transform" : "transition-transform"} width={12} height={12} />
                            history
                          </button>
                        </td>
                      </tr>
                      {expanded === i.sku && (
                        <tr className="border-t bg-stone-50/60">
                          <td colSpan={7} className="p-3">
                            {(history[i.sku] ?? []).length === 0 ? (
                              <p className="text-xs opacity-60">Loading ledger…</p>
                            ) : (
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-left opacity-50">
                                    <th className="py-1">When</th>
                                    <th>Δ</th>
                                    <th>Reason</th>
                                    <th>Ref</th>
                                    <th>Lot / location</th>
                                    <th>Actor</th>
                                    <th>Note</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {(history[i.sku] ?? []).map((m) => (
                                    <tr key={m.id} className="border-t border-stone-200">
                                      <td className="py-1 whitespace-nowrap opacity-70">{formatDateTime(m.createdAt)}</td>
                                      <td className={`tabular-nums ${m.quantityDelta < 0 ? "text-red-700" : "text-green-800"}`}>
                                        {m.quantityDelta > 0 ? "+" : ""}
                                        {qty(m.quantityDelta)}
                                      </td>
                                      <td>{m.reason}</td>
                                      <td className="font-mono opacity-60">{m.refType ?? "-"}</td>
                                      <td className="opacity-70">{[m.lotCode, m.locationCode].filter(Boolean).join(" · ") || "-"}</td>
                                      <td className="opacity-60">{m.actorType}</td>
                                      <td className="max-w-64 truncate opacity-70" title={m.note ?? ""}>{m.note ?? "-"}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
              </div>
              </>
            )}
            <p className="mt-2 text-xs opacity-50">
              Available = on hand − open reservations. Value uses moving-average cost replayed from the append-only ledger.
            </p>
          </Card>

          <Card>
            <CardTitle>Create item</CardTitle>
            <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <label className="label">SKU<input className="input mt-1" placeholder="e.g. COF-001" value={newItem.sku} onChange={(e) => setNewItem({ ...newItem, sku: e.target.value })} /></label>
              <label className="label">Item name<input id="inventory-create-item-name" className="input mt-1" placeholder="e.g. House blend beans" value={newItem.name} onChange={(e) => setNewItem({ ...newItem, name: e.target.value })} /></label>
              <label className="label">Unit<input className="input mt-1" placeholder="unit, kg, box" value={newItem.unitLabel} onChange={(e) => setNewItem({ ...newItem, unitLabel: e.target.value })} /></label>
              <label className="label">Opening balance<input className="input mt-1 tnum" type="number" min="0" step="0.001" inputMode="decimal" placeholder="0" value={newItem.openingQty} onChange={(e) => setNewItem({ ...newItem, openingQty: e.target.value })} /></label>
              <label className="label">Reorder point<input className="input mt-1 tnum" type="number" min="0" step="0.001" inputMode="decimal" placeholder="Optional" value={newItem.reorder} onChange={(e) => setNewItem({ ...newItem, reorder: e.target.value })} /></label>
              {Number(newItem.openingQty) > 0 && <label className="label">Reason for opening balance<input className="input mt-1" value={newItem.openingReason} onChange={(e) => setNewItem({ ...newItem, openingReason: e.target.value })} maxLength={300} /></label>}
              <Button className="min-h-10 sm:w-fit"
                disabled={busy || !newItem.sku.trim() || !newItem.name.trim() || (Number(newItem.openingQty) > 0 && !newItem.openingReason.trim())}
                onClick={() => void createStockItem()}
              >
                Add item and stock
              </Button>
            </div>
          </Card>

          {(data.reservations ?? []).length > 0 && (
            <Card>
              <CardTitle>Stock reservations</CardTitle>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left opacity-60">
                    <th className="py-1.5">SKU</th>
                    <th className="text-right">Quantity</th>
                    <th>Reason</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(data.reservations ?? []).map((r) => (
                    <tr key={r.id} className="border-t">
                      <td className="py-1.5 font-mono">{r.sku}</td>
                      <td className="text-right tabular-nums">{qty(r.quantityThousandths)}</td>
                      <td className="opacity-80">{r.reason}</td>
                      <td><Badge tone={r.status === "open" ? "amber" : "neutral"}>{r.status}</Badge></td>
                      <td className="text-right">
                        {r.status === "open" && (
                          <Button tone="ghost" disabled={busy} onClick={() => void post({ action: "releaseReservation", reservationId: r.id }, "Release reservation")}>
                            Release
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}

      {tab === "reorder" && (
        <Card>
          <CardTitle>Below reorder point</CardTitle>
          {(data.reorderAlerts ?? []).length === 0 ? (
            <EmptyState icon={<IconListTree />} title="Nothing to reorder" hint="Every tracked item is above its reorder point." />
          ) : (
            <div className="space-y-3 text-sm">
              <table className="w-full">
                <thead>
                  <tr className="text-left opacity-60">
                    <th className="py-1.5 w-8" />
                    <th>SKU</th>
                    <th className="text-right">On hand</th>
                    <th className="text-right">Reorder at</th>
                    <th className="text-right">Shortfall</th>
                    <th className="text-right">Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.reorderAlerts ?? []).map((a) => (
                    <tr key={a.sku} className="border-t">
                      <td className="py-1.5">
                        <input
                          type="checkbox"
                          checked={picked.has(a.sku)}
                          onChange={(e) => {
                            const next = new Set(picked);
                            if (e.target.checked) next.add(a.sku);
                            else next.delete(a.sku);
                            setPicked(next);
                          }}
                        />
                      </td>
                      <td className="font-mono">{a.sku}</td>
                      <td className="text-right tabular-nums">{qty(a.onHandThousandths)}</td>
                      <td className="text-right tabular-nums">{qty(a.reorderPointThousandths)}</td>
                      <td className="text-right tabular-nums text-amber-700">{qty(a.shortfallThousandths)}</td>
                      <td className="text-right tabular-nums">{formatMoney(Math.round((a.shortfallThousandths * a.avgUnitCostMinor) / 1000))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="select"
                  value={vendorId}
                  onChange={(e) => setVendorId(e.target.value)}
                >
                  <option value="">Pick a vendor…</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </select>
                <Button disabled={busy || !vendorId || picked.size === 0} onClick={() => void draftPo()}>
                  Draft purchase order ({picked.size})
                </Button>
                {vendors.length === 0 && <span className="text-xs opacity-60">No vendors yet - create one via Purchasing or your agent first.</span>}
              </div>
              {poNumber !== null && (
                <p className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-900">
                  Purchase order #{poNumber} drafted with the selected lines.
                </p>
              )}
            </div>
          )}
        </Card>
      )}

      {tab === "counts" && (
        <>
          <Card>
            <CardTitle>Set up a stock count</CardTitle>
            {countableItems.length === 0 ? (
              <EmptyState icon={<IconListTree />} title="Add stocked items before counting" hint="Services do not use stock counts. Add a product with an opening balance, then return here to count it." action={<Button size="sm" onClick={() => setTab("levels")}>Open stock levels</Button>} />
            ) : (
              <div className="space-y-3">
                <label className="label block">Count location
                  <select className="select mt-1" value={countLocationId} onChange={(event) => setCountLocationId(event.target.value)}>
                    <option value="">All locations</option>
                    {(data.locations ?? []).map((location) => <option key={location.id} value={location.id}>{location.name} · {location.code}</option>)}
                  </select>
                  <span className="mt-1 block text-xs font-normal text-stone-500">A location count compares stock recorded in that location.</span>
                </label>
                <label className="flex min-h-11 items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-3 text-sm">
                  <input type="checkbox" checked={countAllItems} onChange={(event) => setCountAllItems(event.target.checked)} className="accent-gold-700" />
                  Count every stocked item{countLocationId ? " in this location" : " across all locations"}
                </label>
                {!countAllItems && (
                  <div className="space-y-2 rounded-lg border border-stone-200 p-3">
                    <label className="label block">Scan an item or search by name / SKU
                      <div className="mt-1 flex gap-2">
                        <input className="input min-w-0 flex-1" value={countBarcode} onChange={(event) => setCountBarcode(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void addCountScan(); } }} placeholder="Scan barcode" aria-label="Scan a barcode into the count" />
                        <Button tone="secondary" disabled={countBarcode.trim().length < 3} onClick={() => void addCountScan()}>Add scan</Button>
                      </div>
                    </label>
                    <input className="input" value={countSearch} onChange={(event) => setCountSearch(event.target.value)} placeholder="Find a product" aria-label="Search products for this count" />
                    {countSearch.trim() && (
                      <ul className="max-h-48 divide-y overflow-y-auto rounded-md border border-stone-200" aria-label="Matching products">
                        {matchingCountItems.length === 0 ? <li className="p-3 text-sm text-stone-500">No matching products.</li> : matchingCountItems.map((item) => {
                          const selected = selectedCountSkus.includes(item.sku);
                          return <li key={item.sku}><button type="button" aria-pressed={selected} onClick={() => setSelectedCountSkus((current) => selected ? current.filter((sku) => sku !== item.sku) : [...current, item.sku])} className="flex min-h-12 w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-stone-50"><span className="min-w-0"><span className="block truncate text-sm font-medium">{item.name}</span><span className="font-mono text-xs text-stone-500">{item.sku}</span></span><span className="shrink-0 text-xs font-medium text-gold-800">{selected ? "Added" : "Add"}</span></button></li>;
                        })}
                      </ul>
                    )}
                    <div className="flex flex-wrap items-center gap-1.5" aria-live="polite">
                      <span className="mr-1 text-xs text-stone-500">{selectedCountSkus.length} selected</span>
                      {selectedCountSkus.map((sku) => <button key={sku} type="button" className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-xs" onClick={() => setSelectedCountSkus((current) => current.filter((value) => value !== sku))}>{sku} <span aria-hidden="true">×</span></button>)}
                      {selectedCountSkus.length > 0 && <button type="button" className="text-xs text-stone-500 underline" onClick={() => setSelectedCountSkus([])}>Clear</button>}
                    </div>
                  </div>
                )}
                <label className="label block">Count reason or reference
                  <input className="input mt-1" value={countNote} onChange={(event) => setCountNote(event.target.value)} maxLength={200} placeholder="Scheduled count, aisle check..." />
                </label>
                <div className="flex flex-col gap-2 border-t border-stone-100 pt-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-stone-500">Expected quantities are snapshotted. If stock moves while you count, the sheet asks you to start a fresh count.</p>
                  <Button className="min-h-11 shrink-0" disabled={busy || countNote.trim().length < 3 || (!countAllItems && selectedCountSkus.length === 0)} onClick={() => void post({ action: "createCycleCount", ...(countAllItems ? {} : { skus: selectedCountSkus }), ...(countLocationId ? { locationId: countLocationId } : {}), note: countNote.trim() }, "Open stock count")}>Start count sheet</Button>
                </div>
              </div>
            )}
          </Card>

          {(data.cycleCounts ?? []).length === 0 && countableItems.length > 0 && (
            <EmptyState icon={<IconListTree />} title="No count sheets yet" hint="Start a location or item count above. Open sheets keep progress until you review and post the differences." />
          )}

          {(data.cycleCounts ?? []).map((c) => {
            const countedLines = c.lines.filter((line) => line.countedThousandths !== null).length;
            const allCounted = countedLines === c.lines.length;
            const varianceLines = c.lines.filter((line) => (line.varianceThousandths ?? 0) !== 0);
            return (
              <Card key={c.id}>
                <CardTitle right={<Badge tone={c.status === "open" ? "amber" : c.status === "posted" ? "green" : "neutral"}>{c.status}</Badge>}>
                  Count of {formatDateTime(c.createdAt)}{c.locationCode ? ` · ${c.locationCode}` : " · all locations"}
                </CardTitle>
                <div className="mb-3 rounded-lg bg-stone-50 p-3">
                  <div className="flex items-center justify-between gap-3 text-xs"><span className="font-medium text-stone-700">{countedLines} of {c.lines.length} items counted</span><span className="text-right text-stone-500">{c.note || "No reason recorded"}</span></div>
                  <progress className="mt-2 h-2 w-full accent-gold-700" value={countedLines} max={Math.max(1, c.lines.length)} aria-label={`${countedLines} of ${c.lines.length} items counted`} />
                </div>
                <ul className="space-y-2 sm:hidden" aria-label="Count lines">
                  {c.lines.map((line) => {
                    const key = `${c.id}:${line.sku}`;
                    return (
                      <li key={line.sku} className="rounded-lg border border-stone-200 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0"><p className="truncate text-sm font-semibold">{items.find((item) => item.sku === line.sku)?.name ?? line.sku}</p><p className="font-mono text-[11px] text-stone-500">{line.sku}</p></div>
                          <span className="shrink-0 text-right text-xs"><span className="block text-stone-500">Expected</span><strong className="tnum">{qty(line.expectedThousandths)}</strong></span>
                        </div>
                        {c.status === "open" && (
                          <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
                            <label className="label">Counted quantity<input className="input mt-1 text-right tabular-nums" type="number" min="0" step="0.001" inputMode="decimal" placeholder="Enter count" value={countEntries[key] ?? (line.countedThousandths === null ? "" : qty(line.countedThousandths))} onChange={(event) => setCountEntries((current) => ({ ...current, [key]: event.target.value }))} /></label>
                            <Button tone="secondary" className="min-h-11" disabled={busy || countEntries[key] === undefined} onClick={() => void post({ action: "recordCycleCounts", countId: c.id, counts: [{ sku: line.sku, countedThousandths: Math.round(Number(countEntries[key] || "0") * 1000) }] }, `Record ${line.sku}`).then((ok) => ok && setCountEntries((current) => ({ ...current, [key]: "" })))}>Save</Button>
                          </div>
                        )}
                        {line.varianceThousandths !== null && <p className={`mt-2 text-xs font-medium ${line.varianceThousandths === 0 ? "text-green-800" : "text-amber-800"}`}>{line.varianceThousandths === 0 ? "Matches snapshot" : `Difference ${line.varianceThousandths > 0 ? "+" : ""}${qty(line.varianceThousandths)}`}</p>}
                      </li>
                    );
                  })}
                </ul>
                <div className="hidden overflow-x-auto sm:block">
                  <table className="w-full min-w-[760px] text-sm">
                    <thead><tr className="text-left text-xs text-stone-500"><th className="py-1.5">Item</th><th className="text-right">Expected</th><th className="text-right">Counted</th><th className="text-right">Difference</th><th>Save count</th></tr></thead>
                    <tbody>{c.lines.map((line) => {
                      const key = `${c.id}:${line.sku}`;
                      return <tr key={line.sku} className="border-t"><td className="py-2"><span className="font-medium">{items.find((item) => item.sku === line.sku)?.name ?? line.sku}</span><span className="ml-2 font-mono text-xs text-stone-500">{line.sku}</span></td><td className="text-right tabular-nums">{qty(line.expectedThousandths)}</td><td className="text-right tabular-nums">{line.countedThousandths === null ? "-" : qty(line.countedThousandths)}</td><td className="text-right tabular-nums">{line.varianceThousandths === null ? "-" : `${line.varianceThousandths > 0 ? "+" : ""}${qty(line.varianceThousandths)}`}</td><td>{c.status === "open" && <div className="flex gap-1.5"><input className="input w-28 text-right" type="number" min="0" step="0.001" inputMode="decimal" placeholder="Counted" value={countEntries[key] ?? (line.countedThousandths === null ? "" : qty(line.countedThousandths))} onChange={(event) => setCountEntries((current) => ({ ...current, [key]: event.target.value }))} /><Button tone="ghost" disabled={busy || countEntries[key] === undefined} onClick={() => void post({ action: "recordCycleCounts", countId: c.id, counts: [{ sku: line.sku, countedThousandths: Math.round(Number(countEntries[key] || "0") * 1000) }] }, `Record ${line.sku}`).then((ok) => ok && setCountEntries((current) => ({ ...current, [key]: "" })))}>Save</Button></div>}</td></tr>;
                    })}</tbody>
                  </table>
                </div>
                {c.status === "open" && (
                  <div className="mt-3 flex flex-col gap-2 border-t border-stone-100 pt-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-xs text-stone-500">{allCounted ? `${varianceLines.length} stock adjustment${varianceLines.length === 1 ? "" : "s"} to review.` : `Count every item before posting. ${c.lines.length - countedLines} remain.`}</p>
                    <div className="flex gap-2"><Button tone="secondary" disabled={busy || !allCounted} onClick={() => setReviewCount(c)}>Review &amp; post</Button><Button tone="ghost" disabled={busy} onClick={() => void post({ action: "cancelCycleCount", countId: c.id }, "Cancel count")}>Cancel count</Button></div>
                  </div>
                )}
              </Card>
            );
          })}

          <Dialog open={reviewCount !== null} onClose={() => setReviewCount(null)} title="Review stock adjustments" description="Check every difference before the stock ledger is updated." width="max-w-xl" footer={<><Button tone="secondary" onClick={() => setReviewCount(null)}>Back to count</Button><Button disabled={busy || !reviewCount} onClick={() => reviewCount && void post({ action: "postCycleCount", countId: reviewCount.id }, "Post count adjustments").then((ok) => ok && setReviewCount(null))}>Post to stock ledger</Button></>}>
            {reviewCount && <div className="space-y-3"><p className="rounded-lg bg-stone-50 p-3 text-sm"><strong>Reason:</strong> {reviewCount.note || "No reason recorded"}<br /><strong>Items counted:</strong> {reviewCount.lines.length} · <strong>Location:</strong> {reviewCount.locationCode ?? "All locations"}</p>{reviewCount.lines.filter((line) => (line.varianceThousandths ?? 0) !== 0).length === 0 ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">All counted quantities match the snapshot. No stock adjustments will be posted.</p> : <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border border-stone-200">{reviewCount.lines.filter((line) => (line.varianceThousandths ?? 0) !== 0).map((line) => <li key={line.sku} className="flex items-center justify-between gap-3 px-3 py-2 text-sm"><span className="min-w-0"><span className="block truncate font-medium">{items.find((item) => item.sku === line.sku)?.name ?? line.sku}</span><span className="font-mono text-xs text-stone-500">{line.sku} · {qty(line.expectedThousandths)} expected, {line.countedThousandths === null ? "not counted" : qty(line.countedThousandths)} counted</span></span><strong className={`tnum shrink-0 ${(line.varianceThousandths ?? 0) < 0 ? "text-red-700" : "text-emerald-800"}`}>{(line.varianceThousandths ?? 0) > 0 ? "+" : ""}{qty(line.varianceThousandths ?? 0)}</strong></li>)}</ul>}</div>}
          </Dialog>
        </>
      )}

      {tab === "locations" && (
        <>
          <Card>
            <CardTitle>Create stock location</CardTitle>
            <div className="flex flex-wrap gap-2 text-sm">
              <input className="w-32 rounded border bg-transparent px-2 py-1.5" placeholder="Code" value={locForm.code} onChange={(e) => setLocForm({ ...locForm, code: e.target.value.toUpperCase() })} />
              <input className="flex-1 rounded border bg-transparent px-2 py-1.5" placeholder="Name (warehouse, staging bin…)" value={locForm.name} onChange={(e) => setLocForm({ ...locForm, name: e.target.value })} />
              <Button
                disabled={busy || !locForm.code || !locForm.name}
                onClick={() => void post({ action: "createLocation", code: locForm.code, name: locForm.name }, `Create ${locForm.code}`).then((ok) => ok && setLocForm({ code: "", name: "" }))}
              >
                Create location
              </Button>
            </div>
          </Card>
          <Card>
            <CardTitle>Locations</CardTitle>
            {(data.locations ?? []).length === 0 ? (
              <EmptyState icon={<IconListTree />} title="No locations yet" hint="Register warehouses or shop-floor bins so movements can say where stock lives." />
            ) : (
              <ul className="divide-y text-sm">
                {(data.locations ?? []).map((l) => (
                  <li key={l.id} className="py-1.5">
                    <span className="font-mono">{l.code}</span> - {l.name}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardTitle>Transfer stock</CardTitle>
            <p
              className="text-xs opacity-50"
              title="Transfers relocate stock between locations; quantity is always conserved and value never changes"
            >
              Quantity is always conserved; value never changes.
            </p>
            <div className="grid gap-2 text-sm sm:grid-cols-2 xl:grid-cols-5">
              <InventorySearchSelect
                label="From location"
                ariaLabel="Source location"
                placeholder="Search source location"
                value={transferForm.from}
                options={(data.locations ?? []).map((location) => ({ value: location.code, label: location.name, details: location.code, searchText: `${location.name} ${location.code}` }))}
                onChange={(from) => setTransferForm((current) => ({ ...current, from, to: current.to === from ? "" : current.to }))}
              />
              <InventorySearchSelect
                label="To location"
                ariaLabel="Destination location"
                placeholder="Search destination location"
                value={transferForm.to}
                options={(data.locations ?? []).filter((location) => location.code !== transferForm.from).map((location) => ({ value: location.code, label: location.name, details: location.code, searchText: `${location.name} ${location.code}` }))}
                onChange={(to) => setTransferForm((current) => ({ ...current, to }))}
              />
              <InventorySearchSelect
                label="Item"
                ariaLabel="Item to transfer"
                placeholder="Search item by name or SKU"
                value={transferForm.sku}
                options={countableItems.map((item) => ({ value: item.sku, label: item.name, details: `${item.sku} · ${qty(item.availableThousandths)} ${item.unitLabel} available`, searchText: `${item.name} ${item.sku} ${item.barcode ?? ""}` }))}
                onChange={(sku) => setTransferForm((current) => ({ ...current, sku }))}
              />
              <input className="input text-right" type="number" min="0.001" step="0.001" inputMode="decimal" placeholder="Quantity" aria-label="Quantity in units" value={transferForm.qty} onChange={(e) => setTransferForm({ ...transferForm, qty: e.target.value })} />
              <input className="input" placeholder="Reason or note (optional)" aria-label="Transfer note" value={transferForm.note} onChange={(e) => setTransferForm({ ...transferForm, note: e.target.value })} />
              {transferForm.sku && (() => { const selected = items.find((item) => item.sku === transferForm.sku); return selected ? <p className="text-xs text-stone-500 sm:col-span-2 xl:col-span-4">{selected.name}: {qty(selected.onHandThousandths)} on hand, {qty(selected.reservedThousandths)} reserved, {qty(selected.availableThousandths)} available</p> : null; })()}
              <Button
                disabled={busy || !transferForm.from || !transferForm.to || !transferForm.sku || !Number(transferForm.qty)}
                onClick={() =>
                  void post(
                    {
                      action: "createTransfer",
                      fromLocationCode: transferForm.from,
                      toLocationCode: transferForm.to,
                      sku: transferForm.sku,
                      lines: [{ sku: transferForm.sku, quantityThousandths: Math.round(Number(transferForm.qty || "0") * 1000) }],
                      note: transferForm.note || undefined,
                    },
                    `Transfer ${transferForm.sku} to ${transferForm.to}`,
                  ).then((ok) => ok && setTransferForm({ from: "", to: "", sku: "", qty: "", note: "" }))
                }
              >
                Draft transfer
              </Button>
            </div>
            <p className="mt-1 text-xs opacity-50">
              Drafts move nothing. Confirm moves the stock (partial confirms allowed); once moved, a transfer can only be reversed.
            </p>
          </Card>
          <Card>
            <CardTitle>Transfers</CardTitle>
            {(data.transfers ?? []).length === 0 ? (
              <EmptyState icon={<IconListTree />} title="No transfers yet" hint="Draft a transfer above to relocate stock between locations." />
            ) : (
              <ul className="divide-y text-sm">
                {(data.transfers ?? []).map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                    <span>
                      <span className="font-mono text-xs opacity-60">#{t.number}</span> {t.from} → {t.to}{" "}
                      {t.lines.map((l) => `${l.sku} ${(l.confirmedThousandths / 1000).toFixed(3)}/${(l.quantityThousandths / 1000).toFixed(3)}`).join(", ")}
                      {t.note ? <span className="text-xs opacity-50"> · {t.note}</span> : null}
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge tone={t.status === "confirmed" ? "green" : t.status === "pending" || t.status === "partial" ? "amber" : "neutral"}>
                        {t.status}
                      </Badge>
                      {(t.status === "pending" || t.status === "partial") && (
                        <button
                          type="button"
                          className="cursor-pointer rounded px-1.5 py-1 text-xs opacity-70 hover:opacity-100"
                          title="Confirm remaining quantity - this writes the paired ledger legs"
                          onClick={() => void post({ action: "confirmTransfer", transferId: t.id }, `Confirm transfer #${t.number}`)}
                        >
                          confirm
                        </button>
                      )}
                      {t.status === "pending" && (
                        <button
                          type="button"
                          className="cursor-pointer rounded px-1.5 py-1 text-xs opacity-70 hover:opacity-100"
                          title="Cancel a draft that has moved nothing"
                          onClick={() => void post({ action: "cancelTransfer", transferId: t.id }, `Cancel transfer #${t.number}`)}
                        >
                          cancel
                        </button>
                      )}
                      {(t.status === "confirmed" || t.status === "partial") && (
                        <button
                          type="button"
                          className="cursor-pointer rounded px-1.5 py-1 text-xs opacity-70 hover:opacity-100"
                          title="Move the confirmed quantities back"
                          onClick={() => void post({ action: "reverseTransfer", transferId: t.id }, `Reverse transfer #${t.number}`)}
                        >
                          reverse
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardTitle>Reserve stock</CardTitle>
            <div className="grid gap-2 text-sm sm:grid-cols-3">
              <InventorySearchSelect
                label="Item"
                ariaLabel="Item to reserve"
                placeholder="Search item by name or SKU"
                value={reserveForm.sku}
                options={countableItems.map((item) => ({ value: item.sku, label: item.name, details: `${item.sku} · ${qty(item.availableThousandths)} ${item.unitLabel} available`, searchText: `${item.name} ${item.sku} ${item.barcode ?? ""}` }))}
                onChange={(sku) => setReserveForm((current) => ({ ...current, sku }))}
              />
              <input className="input" type="number" min="0.001" step="0.001" inputMode="decimal" placeholder="Quantity" aria-label="Quantity to reserve" value={reserveForm.qty} onChange={(e) => setReserveForm({ ...reserveForm, qty: e.target.value })} />
              <input className="input" placeholder="Reason (sales order, work order…)" aria-label="Reservation reason" value={reserveForm.reason} onChange={(e) => setReserveForm({ ...reserveForm, reason: e.target.value })} />
              <Button
                disabled={busy || !reserveForm.sku || !Number(reserveForm.qty) || reserveForm.reason.length < 3}
                onClick={() =>
                  void post(
                    {
                      action: "reserveStock",
                      sku: reserveForm.sku,
                      quantityThousandths: Math.round(Number(reserveForm.qty || "0") * 1000),
                      reason: reserveForm.reason,
                    },
                    "Reserve stock",
                  ).then((ok) => ok && setReserveForm({ sku: "", qty: "", reason: "" }))
                }
              >
                Reserve
              </Button>
            </div>
          </Card>
        </>
      )}

    </AppFrame>
  );
}

interface InventorySearchOption {
  value: string;
  label: string;
  details?: string;
  searchText?: string;
}

function InventorySearchSelect({
  label,
  ariaLabel,
  placeholder,
  value,
  options,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  placeholder: string;
  value: string;
  options: InventorySearchOption[];
  onChange: (value: string) => void;
}) {
  const listboxId = useId();
  const inputId = `${listboxId}-input`;
  const selected = options.find((option) => option.value === value);
  const [query, setQuery] = useState(selected?.label ?? "");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const normalizedQuery = query.trim().toLowerCase();
  const matches = options
    .filter((option) => !normalizedQuery || `${option.label} ${option.details ?? ""} ${option.searchText ?? ""}`.toLowerCase().includes(normalizedQuery))
    .slice(0, 20);

  useEffect(() => {
    setQuery(selected?.label ?? "");
  }, [selected?.label, value]);

  function choose(option: InventorySearchOption) {
    onChange(option.value);
    setQuery(option.label);
    setOpen(false);
  }

  return (
    <div className="relative min-w-0">
      <label htmlFor={inputId} className="mb-1 block text-xs font-medium text-stone-600">{label}</label>
      <input
        id={inputId}
        className="input w-full"
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && matches[activeIndex] ? `${listboxId}-option-${activeIndex}` : undefined}
        autoComplete="off"
        placeholder={placeholder}
        value={query}
        onFocus={(event) => { setOpen(true); event.currentTarget.select(); }}
        onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); setOpen(true); }}
        onBlur={() => window.setTimeout(() => { setOpen(false); setQuery(selected?.label ?? ""); }, 120)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && open) {
            event.preventDefault();
            setActiveIndex((index) => Math.min(index + 1, matches.length - 1));
          } else if (event.key === "ArrowUp" && open) {
            event.preventDefault();
            setActiveIndex((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter" && open && matches[activeIndex]) {
            event.preventDefault();
            choose(matches[activeIndex]!);
          } else if (event.key === "Escape") {
            setOpen(false);
            setQuery(selected?.label ?? "");
          }
        }}
      />
      {open && (
        <div id={listboxId} role="listbox" aria-label={`${ariaLabel} options`} className="absolute inset-x-0 top-full z-30 mt-1 max-h-56 overflow-y-auto rounded-lg border border-stone-200 bg-white p-1 shadow-lg">
          {matches.length === 0 ? <p className="px-3 py-2 text-xs text-stone-500">No matching choices.</p> : matches.map((option, index) => (
            <div
              id={`${listboxId}-option-${index}`}
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option)}
              className={cn("cursor-pointer rounded-md px-3 py-2 text-left text-sm", index === activeIndex ? "bg-gold-50 text-stone-900" : "text-stone-700 hover:bg-stone-50")}
            >
              <span className="block truncate font-medium">{option.label}</span>
              {option.details && <span className="mt-0.5 block truncate text-xs text-stone-500">{option.details}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- overview --- */

function InventoryOverview({
  data,
  totalValue,
  goTo,
}: {
  data: Payload;
  totalValue: number;
  goTo: (tab: Tab) => void;
}) {
  const items = data.items ?? [];
  const alerts = data.reorderAlerts ?? [];
  const counts = data.cycleCounts ?? [];
  const openCounts = counts.filter((c) => c.status !== "posted");
  const reservations = (data.reservations ?? []).filter((r) => r.status === "active");
  const draftTransfers = (data.transfers ?? []).filter((transfer) => transfer.status === "draft");
  const reservedValue = items.reduce((s, i) => s + Math.round((i.avgUnitCostMinor * i.reservedThousandths) / 1000), 0);

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Tracked items" value={items.length} onClick={() => goTo("levels")} actionLabel="Open stock levels" />
        <StatCard label="Stock value" value={formatMoney(totalValue)} tone="accent" onClick={() => goTo("levels")} actionLabel="Review valued stock items" />
        <StatCard
          label="Below reorder point"
          value={alerts.length}
          sub={alerts.length > 0 ? "action needed" : items.length > 0 ? "all healthy" : "add items to begin"}
          tone={alerts.length > 0 ? "warn" : items.length > 0 ? "success" : undefined}
          onClick={() => goTo("reorder")}
          actionLabel="Review items below their reorder point"
        />
        <StatCard label="Reserved units" value={qty(items.reduce((s, i) => s + i.reservedThousandths, 0))} sub={reservedValue > 0 ? formatMoney(reservedValue) : undefined} onClick={() => goTo("locations")} actionLabel="Review active stock reservations" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle
            right={
              alerts.length > 0 ? (
                <Button tone="ghost" onClick={() => goTo("reorder")}>
                  Reorder →
                </Button>
              ) : undefined
            }
          >
            Reorder now
          </CardTitle>
          {alerts.length === 0 ? (
            <p className="text-sm opacity-60">{items.length === 0 ? "No inventory tracked yet. Add items and opening balances to start seeing stock health." : "Every active item is at or above its reorder point."}</p>
          ) : (
            <ul className="divide-y text-sm">
              {alerts.slice(0, 5).map((a) => (
                <li key={a.sku} className="flex items-center justify-between gap-2 py-2">
                  <span>
                    <span className="font-mono text-xs opacity-60">{a.sku}</span> · {a.name}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums text-xs opacity-60">
                      {qty(a.onHandThousandths)}/{qty(a.reorderPointThousandths)}
                    </span>
                    <Badge tone="amber">short {qty(a.shortfallThousandths)}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardTitle>Counts & reservations</CardTitle>
          <ul className="divide-y text-sm">
            <li className="flex items-center justify-between gap-2 py-2">
              <span>Open cycle counts</span>
              <span className="flex items-center gap-2">
                <span className="tnum text-xs opacity-60">{openCounts.length}</span>
                <Button tone="ghost" onClick={() => goTo("counts")}>
                  Count →
                </Button>
              </span>
            </li>
            <li className="flex items-center justify-between gap-2 py-2">
              <span>Active reservations</span>
              <span className="tnum text-xs opacity-60">{reservations.length}</span>
            </li>
            <li className="flex items-center justify-between gap-2 py-2">
              <span>Transfer drafts</span>
              <span className="flex items-center gap-2">
                <span className="tnum text-xs opacity-60">{draftTransfers.length}</span>
                <Button tone="ghost" onClick={() => goTo("locations")}>Review →</Button>
              </span>
            </li>
            <li className="flex items-center justify-between gap-2 py-2">
              <span>Locations</span>
              <span className="flex items-center gap-2">
                <span className="tnum text-xs opacity-60">{(data.locations ?? []).length}</span>
                <Button tone="ghost" onClick={() => goTo("locations")}>
                  Manage →
                </Button>
              </span>
            </li>
          </ul>
          {counts.length > 0 && (
            <p className="mt-2 text-xs opacity-50">
              Last count {formatDateTime(counts[0]!.createdAt)} · {counts[0]!.status}
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
