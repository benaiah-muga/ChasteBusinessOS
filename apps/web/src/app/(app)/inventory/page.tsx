"use client";

import { useCallback, useEffect, useMemo, useState, Fragment } from "react";
import {
  ActionNotice,
  Badge,
  Button,
  Card,
  CardTitle,
  EmptyState,
  LoadingPage,
  StatCard,
  type ActionNoticeState,
} from "@/components/ui";
import { formatDateTime, formatMoney } from "@/lib/format";
import { IconChevronDown, IconListTree } from "@/components/icons";
import { callApi, postApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";
import { AppFrame } from "../_shell/app-frame";

type Tab = "overview" | "levels" | "reorder" | "counts" | "locations";

interface StockItem {
  sku: string;
  name: string;
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
  const __enabled = useModuleEnabled("inventory");
  const [data, setData] = useState<Payload | null>(null);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");

  const [expanded, setExpanded] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, Movement[]>>({});
  const [newItem, setNewItem] = useState({ sku: "", name: "", reorder: "" });

  const [vendorId, setVendorId] = useState("");
  const [vendors, setVendors] = useState<{ id: string; name: string }[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [poNumber, setPoNumber] = useState<number | null>(null);

  const [countSkus, setCountSkus] = useState("");
  const [countEntries, setCountEntries] = useState<Record<string, string>>({});
  const [locForm, setLocForm] = useState({ code: "", name: "" });
  const [reserveForm, setReserveForm] = useState({ sku: "", qty: "", reason: "" });
  const [transferForm, setTransferForm] = useState({ from: "", to: "", sku: "", qty: "", note: "" });

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
              right={<Badge tone="blue">total value {formatMoney(totalValue)}</Badge>}
            >
              Stock on hand
            </CardTitle>
            {items.length === 0 ? (
              <EmptyState icon={<IconListTree />} title="No items yet" hint="Create a stocked item below to start tracking quantities." />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left opacity-60">
                    <th className="py-1.5">SKU</th>
                    <th>Name</th>
                    <th className="text-right">On hand</th>
                    <th
                      className="text-right"
                      title="Available-to-promise: on hand minus open reservations — what you can still sell"
                    >
                      Available
                    </th>
                    <th className="text-right" title="On hand × moving average cost — what the stock is worth at cost">
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
                      <tr className="border-t">
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
                                      <td className="font-mono opacity-60">{m.refType ?? "—"}</td>
                                      <td className="opacity-70">{[m.lotCode, m.locationCode].filter(Boolean).join(" · ") || "—"}</td>
                                      <td className="opacity-60">{m.actorType}</td>
                                      <td className="max-w-64 truncate opacity-70" title={m.note ?? ""}>{m.note ?? "—"}</td>
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
            )}
            <p className="mt-2 text-xs opacity-50">
              Available = on hand − open reservations. Value uses moving-average cost replayed from the append-only ledger.
            </p>
          </Card>

          <Card>
            <CardTitle>Create item</CardTitle>
            <div className="flex flex-wrap gap-2 text-sm">
              <input className="w-36 rounded border bg-transparent px-2 py-1.5" placeholder="SKU" value={newItem.sku} onChange={(e) => setNewItem({ ...newItem, sku: e.target.value })} />
              <input className="flex-1 rounded border bg-transparent px-2 py-1.5" placeholder="Name" value={newItem.name} onChange={(e) => setNewItem({ ...newItem, name: e.target.value })} />
              <input className="w-44 rounded border bg-transparent px-2 py-1.5" placeholder="Reorder point (units)" value={newItem.reorder} onChange={(e) => setNewItem({ ...newItem, reorder: e.target.value })} />
              <Button
                disabled={busy || !newItem.sku || !newItem.name}
                onClick={() =>
                  post(
                    {
                      action: "createItem",
                      sku: newItem.sku,
                      name: newItem.name,
                      reorderPointThousandths: Math.round(Number(newItem.reorder || "0") * 1000),
                    },
                    `Create ${newItem.sku}`,
                  ).then((ok) => ok && setNewItem({ sku: "", name: "", reorder: "" }))
                }
              >
                Create item
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
                  className="rounded border bg-transparent px-2 py-1.5"
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
                {vendors.length === 0 && <span className="text-xs opacity-60">No vendors yet — create one via Purchasing or your agent first.</span>}
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
            <CardTitle>New cycle count</CardTitle>
            <div className="flex flex-wrap gap-2 text-sm">
              <input
                className="flex-1 rounded border bg-transparent px-2 py-1.5"
                placeholder="SKUs to count (comma-separated, empty = everything)"
                value={countSkus}
                onChange={(e) => setCountSkus(e.target.value)}
              />
              <Button
                disabled={busy}
                onClick={() =>
                  void post(
                    {
                      action: "createCycleCount",
                      skus: countSkus.split(",").map((s) => s.trim()).filter(Boolean),
                      note: "opened from inventory page",
                    },
                    "Open count sheet",
                  )
                }
              >
                Open count sheet
              </Button>
            </div>
          </Card>

          {(data.cycleCounts ?? []).map((c) => (
            <Card key={c.id}>
              <CardTitle right={<Badge tone={c.status === "open" ? "amber" : c.status === "posted" ? "green" : "neutral"}>{c.status}</Badge>}>
                Count of {formatDateTime(c.createdAt)}
                {c.locationCode ? ` · ${c.locationCode}` : ""}
              </CardTitle>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left opacity-60">
                    <th className="py-1.5">SKU</th>
                    <th className="text-right">Expected</th>
                    <th className="text-right">Counted</th>
                    <th className="text-right">Variance</th>
                    <th>Enter finding</th>
                  </tr>
                </thead>
                <tbody>
                  {c.lines.map((l) => (
                    <tr key={l.sku} className="border-t">
                      <td className="py-1.5 font-mono">{l.sku}</td>
                      <td className="text-right tabular-nums">{qty(l.expectedThousandths)}</td>
                      <td className="text-right tabular-nums">{l.countedThousandths === null ? "—" : qty(l.countedThousandths)}</td>
                      <td className={`text-right tabular-nums ${(l.varianceThousandths ?? 0) < 0 ? "text-red-700" : "text-green-800"}`}>
                        {l.varianceThousandths === null ? "—" : `${l.varianceThousandths > 0 ? "+" : ""}${qty(l.varianceThousandths)}`}
                      </td>
                      <td>
                        {c.status === "open" && (
                          <div className="flex gap-1.5">
                            <input
                              className="w-24 rounded border bg-transparent px-2 py-1"
                              placeholder="counted"
                              value={countEntries[`${c.id}:${l.sku}`] ?? ""}
                              onChange={(e) => setCountEntries({ ...countEntries, [`${c.id}:${l.sku}`]: e.target.value })}
                            />
                            <Button
                              tone="ghost"
                              disabled={busy || countEntries[`${c.id}:${l.sku}`] === undefined}
                              onClick={() =>
                                void post(
                                  {
                                    action: "recordCycleCounts",
                                    countId: c.id,
                                    counts: [
                                      { sku: l.sku, countedThousandths: Math.round(Number(countEntries[`${c.id}:${l.sku}`] || "0") * 1000) },
                                    ],
                                  },
                                  `Record ${l.sku}`,
                                ).then(() => setCountEntries((prev) => ({ ...prev, [`${c.id}:${l.sku}`]: "" })))
                              }
                            >
                              Save
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {c.note && <p className="mt-1 text-xs opacity-60">{c.note}</p>}
              {c.status === "open" && (
                <div className="mt-2 flex gap-2">
                  <Button disabled={busy} onClick={() => void post({ action: "postCycleCount", countId: c.id }, "Post variances")}>
                    Post variances to ledger
                  </Button>
                  <Button tone="ghost" disabled={busy} onClick={() => void post({ action: "cancelCycleCount", countId: c.id }, "Cancel count")}>
                    Cancel count
                  </Button>
                </div>
              )}
            </Card>
          ))}
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
                    <span className="font-mono">{l.code}</span> — {l.name}
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
            <div className="flex flex-wrap gap-2 text-sm">
              <input className="w-24 rounded border bg-transparent px-2 py-1.5" placeholder="From code" aria-label="Source location code" value={transferForm.from} onChange={(e) => setTransferForm({ ...transferForm, from: e.target.value.toUpperCase() })} />
              <span className="self-center opacity-50">→</span>
              <input className="w-24 rounded border bg-transparent px-2 py-1.5" placeholder="To code" aria-label="Destination location code" value={transferForm.to} onChange={(e) => setTransferForm({ ...transferForm, to: e.target.value.toUpperCase() })} />
              <input className="w-32 rounded border bg-transparent px-2 py-1.5" placeholder="SKU" aria-label="Item SKU" value={transferForm.sku} onChange={(e) => setTransferForm({ ...transferForm, sku: e.target.value })} />
              <input className="w-28 rounded border bg-transparent px-2 py-1.5 text-right" placeholder="Units" aria-label="Quantity in units" value={transferForm.qty} onChange={(e) => setTransferForm({ ...transferForm, qty: e.target.value })} />
              <input className="flex-1 rounded border bg-transparent px-2 py-1.5" placeholder="Note (optional)" aria-label="Transfer note" value={transferForm.note} onChange={(e) => setTransferForm({ ...transferForm, note: e.target.value })} />
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
                          title="Confirm remaining quantity — this writes the paired ledger legs"
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
            <div className="flex flex-wrap gap-2 text-sm">
              <input className="w-32 rounded border bg-transparent px-2 py-1.5" placeholder="SKU" value={reserveForm.sku} onChange={(e) => setReserveForm({ ...reserveForm, sku: e.target.value })} />
              <input className="w-28 rounded border bg-transparent px-2 py-1.5" placeholder="Units" value={reserveForm.qty} onChange={(e) => setReserveForm({ ...reserveForm, qty: e.target.value })} />
              <input className="flex-1 rounded border bg-transparent px-2 py-1.5" placeholder="Reason (sales order, WO…)" value={reserveForm.reason} onChange={(e) => setReserveForm({ ...reserveForm, reason: e.target.value })} />
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

      <p className="text-xs opacity-50">
        Money values display in major units; the ledger stores integer minor units. {formatMoney(0)}
      </p>
    </AppFrame>
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
  const reservedValue = items.reduce((s, i) => s + Math.round((i.avgUnitCostMinor * i.reservedThousandths) / 1000), 0);

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Tracked items" value={items.length} />
        <StatCard label="Stock value" value={formatMoney(totalValue)} tone="accent" />
        <StatCard
          label="Below reorder point"
          value={alerts.length}
          sub={alerts.length > 0 ? "action needed" : "all healthy"}
          tone={alerts.length > 0 ? "warn" : "success"}
        />
        <StatCard label="Reserved units" value={qty(items.reduce((s, i) => s + i.reservedThousandths, 0))} sub={reservedValue > 0 ? formatMoney(reservedValue) : undefined} />
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
            <p className="text-sm opacity-60">Every item is at or above its reorder point.</p>
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
