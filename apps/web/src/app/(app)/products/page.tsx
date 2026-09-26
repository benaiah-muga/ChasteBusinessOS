"use client";

import { useCallback, useEffect, useState } from "react";
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
import { cn, formatMoney, toMinor } from "@/lib/format";
import { useMoneySync } from "@/lib/money";
import { IconBox, IconSearch } from "@/components/icons";
import { callApi, postApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";
import { AppFrame } from "../_shell/app-frame";
import { CsvImportPanel } from "@/components/onboarding/csv-import";

type Tab = "overview" | "catalog" | "new";

interface Item {
  sku: string;
  name: string;
  kind?: string;
  unitLabel: string;
  salePriceMinor?: number;
  imageUrl?: string | null;
  tags?: string[];
  barcode?: string | null;
  onHandThousandths: number;
  avgUnitCostMinor: number;
  valueMinor: number;
  reorderPointThousandths: number;
  reorderNeeded: boolean;
}
interface ReorderAlert {
  sku: string;
  name: string;
  onHandThousandths: number;
  reorderPointThousandths: number;
  shortfallThousandths: number;
  avgUnitCostMinor: number;
}
interface Payload {
  items?: Item[];
  totalValueMinor?: number;
  reorderAlerts?: ReorderAlert[];
}

const qty = (t: number) => (t / 1000).toFixed(3);

export default function ProductsPage() {
  useMoneySync();
  const enabled = useModuleEnabled("inventory");
  const [data, setData] = useState<Payload | null>(null);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | "goods" | "service">("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [stockFilter, setStockFilter] = useState<"all" | "reorder" | "in-stock">("all");
  const [form, setForm] = useState({ sku: "", name: "", unitLabel: "", salePrice: "", reorder: "", openingQty: "", barcode: "", imageUrl: "", tags: "" });
  const [isService, setIsService] = useState(false);
  const [serviceBasis, setServiceBasis] = useState<"hour" | "session" | "job" | "month">("hour");
  const [editTarget, setEditTarget] = useState<Item | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [editForm, setEditForm] = useState({ name: "", unitLabel: "", salePrice: "", barcode: "", imageUrl: "", tags: "" });

  const load = useCallback(async () => {
    const res = await callApi<Payload>("/api/inventory");
    setData(res.data ?? {});
    if (res.error) setNotice({ tone: "error", error: res.error });
  }, []);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  // Module defaults prefill the create form (Settings > Modules > Inventory).
  useEffect(() => {
    void (async () => {
      const res = await callApi<{ settings?: { defaultUnitLabel?: string; defaultReorderPointUnits?: number } }>(
        "/api/module-settings?module=inventory",
      );
      const s = res.data?.settings;
      if (!s) return;
      setForm((f) => ({
        ...f,
        unitLabel: f.unitLabel || (s.defaultUnitLabel ?? ""),
        reorder: f.reorder || (s.defaultReorderPointUnits != null && s.defaultReorderPointUnits > 0 ? String(s.defaultReorderPointUnits) : ""),
      }));
    })();
  }, []);

  // Inventory actions are governed; 202 means the kernel parked it for approval.
  const post = useCallback(
    async (body: Record<string, unknown>, label: string): Promise<boolean> => {
      setBusy(true);
      try {
        const res = await postApi("/api/inventory", body);
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
    },
    [load],
  );

  async function createProduct(): Promise<void> {
    const sku = form.sku.trim() || (isService ? `SVC-${crypto.randomUUID().slice(0, 8).toUpperCase()}` : "");
    const name = form.name.trim();
    if (!sku || !name) {
      setNotice({ tone: "error", error: { title: "Some details are missing", hint: "Both SKU and name are required." } });
      return;
    }
    const ok = await post(
      {
        action: "createItem",
        sku,
        name,
        kind: isService ? "service" : "goods",
        unitLabel: isService ? serviceBasis : form.unitLabel.trim() || undefined,
        salePriceMinor: toMinor(form.salePrice),
        reorderPointThousandths: isService ? 0 : Math.round(Number(form.reorder || "0") * 1000),
        barcode: form.barcode.trim() || undefined,
        imageUrl: form.imageUrl.trim() || undefined,
        tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
      },
      `Create ${name}`,
    );
    if (!ok) return;

    const openingQty = isService ? 0 : Math.round(Number(form.openingQty || "0") * 1000);
    if (openingQty > 0) await post({ action: "adjustStock", sku, quantityDelta: openingQty, note: "Opening stock" }, "Record opening stock");
    setForm({ sku: "", name: "", unitLabel: "", salePrice: "", reorder: "", openingQty: "", barcode: "", imageUrl: "", tags: "" });
    setIsService(false);
  }

  async function archive(sku: string): Promise<void> {
    if (!window.confirm(`Archive ${sku}? Past quotes and invoices keep their history.`)) return;
    await post({ action: "archiveItem", sku, archive: true }, `Archive ${sku}`);
  }

  function openEdit(item: Item): void {
    setEditForm({
      name: item.name,
      unitLabel: item.unitLabel ?? "",
      salePrice: item.salePriceMinor ? (item.salePriceMinor / 100).toFixed(2) : "",
      barcode: item.barcode ?? "",
      imageUrl: item.imageUrl ?? "",
      tags: (item.tags ?? []).join(", "),
    });
    setEditTarget(item);
  }

  async function saveEdit(): Promise<void> {
    if (!editTarget || !editForm.name.trim()) return;
    const ok = await post(
      {
        action: "updateItem",
        sku: editTarget.sku,
        name: editForm.name.trim(),
        unitLabel: editForm.unitLabel.trim() || undefined,
        salePriceMinor: Math.round(Number(editForm.salePrice || "0") * 100),
        barcode: editForm.barcode.trim() || null,
        imageUrl: editForm.imageUrl.trim() || null,
        tags: editForm.tags.split(",").map((t) => t.trim()).filter(Boolean),
      },
      `Update ${editTarget.sku}`,
    );
    if (ok) setEditTarget(null);
  }

  if (!enabled) return <ModuleDisabled label="Products" />;
  if (!data) return <LoadingPage />;

  const items = data.items ?? [];
  const alerts = data.reorderAlerts ?? [];
  const totalValueMinor = data.totalValueMinor ?? items.reduce((s, i) => s + i.valueMinor, 0);
  const reorderCount = items.filter((i) => i.reorderNeeded).length;
  const q = search.trim().toLowerCase();
  const categories = [...new Set(items.flatMap((item) => item.tags ?? []))].sort((a, b) => a.localeCompare(b));
  const visibleItems = items.filter((item) => {
    const matchesSearch = !q || `${item.sku} ${item.name} ${item.barcode ?? ""} ${(item.tags ?? []).join(" ")}`.toLowerCase().includes(q);
    const matchesKind = kindFilter === "all" || (kindFilter === "service" ? item.kind === "service" : item.kind !== "service");
    const matchesCategory = categoryFilter === "all" || (item.tags ?? []).includes(categoryFilter);
    const matchesStock = stockFilter === "all" || (stockFilter === "reorder" ? item.reorderNeeded : item.kind === "service" || item.onHandThousandths > 0);
    return matchesSearch && matchesKind && matchesCategory && matchesStock;
  });

  return (
    <AppFrame
      appId="products"
      description="Products and services behind quotes, invoices, stock, and point of sale."
      tabs={[
        { id: "overview", label: "Overview" },
        { id: "catalog", label: "Products & Services" },
        { id: "new", label: "Add item" },
      ]}
      activeTab={tab}
      onTabChange={(id) => setTab(id as Tab)}
      persistKey="products"
    >
      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}

      {tab === "overview" && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label="Items in catalog"
              value={items.length}
              onClick={() => { setTab("catalog"); setSearch(""); setKindFilter("all"); setStockFilter("all"); }}
              actionLabel="Open the full products and services catalog"
            />
            <StatCard
              label="Total stock value"
              value={formatMoney(totalValueMinor)}
              onClick={() => { setTab("catalog"); setSearch(""); setKindFilter("goods"); setStockFilter("all"); }}
              actionLabel="Review goods and their inventory value"
            />
            <StatCard
              label="Reorder alerts"
              value={items.length === 0 ? "N/A" : reorderCount}
              sub={items.length === 0 ? "Add items to track stock" : `${alerts.length} below reorder point`}
              tone={reorderCount > 0 ? "warn" : "default"}
              onClick={() => { setTab("catalog"); setKindFilter("goods"); setStockFilter("reorder"); }}
              actionLabel="Open catalog items below their reorder point"
            />
          </div>
          <Card>
            <CardTitle>Items needing reorder</CardTitle>
            {items.length === 0 ? (
              <EmptyState
                icon={<IconBox />}
                title="Start your products and services catalog"
                hint="Add your first item or import a spreadsheet. Stock health will appear here once you track goods."
                action={(
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button size="sm" onClick={() => setTab("new")}>Add first item</Button>
                    <Button size="sm" tone="secondary" onClick={() => setImportOpen(true)}>Import spreadsheet</Button>
                  </div>
                )}
              />
            ) : alerts.length === 0 ? (
              <EmptyState icon={<IconBox />} title="No reorder needed" hint="Tracked goods are at or above their reorder thresholds." />
            ) : (
              <ul className="divide-y text-sm">
                {alerts.map((a) => (
                  <li key={a.sku} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                    <span>
                      <span className="font-mono text-xs opacity-60">{a.sku}</span> · {a.name}
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="tabular-nums opacity-70">
                        on hand {qty(a.onHandThousandths)} · point {qty(a.reorderPointThousandths)}
                      </span>
                      <Badge tone="amber">short {qty(a.shortfallThousandths)}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs opacity-50">
              Stock movements live in the Inventory app - receive, adjust, and count stock there; this catalog stays the pricing
              and product surface.
            </p>
          </Card>
        </>
      )}


      {tab === "catalog" && (
        <Card>
          <div className="mb-4 flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="section-title min-w-0">Products &amp; Services</h2>
            <div className="flex min-w-0 w-full flex-col gap-2 sm:w-auto sm:flex-row">
              <Button className="w-full sm:w-auto" tone="secondary" size="sm" onClick={() => setImportOpen(true)}>Import CSV</Button>
              <div className="flex min-w-0 w-full items-center gap-1.5 rounded border bg-transparent px-2 py-1 text-sm sm:w-auto">
                <IconSearch className="size-3.5 shrink-0 opacity-50" />
                <input
                  className="min-w-0 w-full flex-1 bg-transparent outline-none sm:w-40 sm:flex-none"
                  placeholder="Search SKU or name"
                  aria-label="Search catalog"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>
          </div>
          <div className="mb-3 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            <select className="select h-9" aria-label="Filter by item type" value={kindFilter} onChange={(event) => setKindFilter(event.target.value as typeof kindFilter)}><option value="all">All types</option><option value="goods">Products</option><option value="service">Services</option></select>
            <select className="select h-9" aria-label="Filter by category" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="all">All categories</option>{categories.map((category) => <option key={category} value={category}>{category}</option>)}</select>
            <select className="select h-9" aria-label="Filter by stock status" value={stockFilter} onChange={(event) => setStockFilter(event.target.value as typeof stockFilter)}><option value="all">Any stock level</option><option value="reorder">Needs reorder</option><option value="in-stock">In stock</option></select>
            <span className="col-span-2 self-center text-xs text-stone-500 sm:ml-auto sm:col-span-1">{visibleItems.length} shown</span>
          </div>
          {items.length === 0 ? (
            <EmptyState icon={<IconBox />} title="No products or services yet" hint="Create an item or bring in your existing catalog from a spreadsheet." action={<div className="flex flex-wrap justify-center gap-2"><Button onClick={() => setTab("new")}>Add an item</Button><Button tone="secondary" onClick={() => setImportOpen(true)}>Import CSV</Button></div>} />
          ) : visibleItems.length === 0 ? (
            <EmptyState icon={<IconSearch />} title={`Nothing matches “${search.trim()}”`} hint="Try a different SKU or name fragment." />
          ) : (
            <>
            <ul className="space-y-2 sm:hidden" aria-label="Products and services">
              {visibleItems.map((item) => (
                <li key={item.sku} className="rounded-xl border border-stone-200 bg-white p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0"><p className="truncate text-sm font-semibold text-stone-900">{item.name}</p><p className="mt-0.5 font-mono text-[11px] text-stone-500">{item.sku} · {item.kind === "service" ? `service / ${item.unitLabel}` : item.unitLabel}</p></div>
                    <p className="shrink-0 text-right text-sm font-semibold tabular-nums">{(item.salePriceMinor ?? 0) > 0 ? formatMoney(item.salePriceMinor!) : "-"}<span className="block text-[10px] font-normal text-stone-500">per {item.unitLabel}</span></p>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">{item.kind === "service" ? <Badge tone="blue">Service</Badge> : <Badge tone={item.reorderNeeded ? "amber" : "green"}>{item.reorderNeeded ? "Reorder" : `${qty(item.onHandThousandths)} ${item.unitLabel}`}</Badge>}{(item.tags ?? []).slice(0, 3).map((tag) => <Badge key={tag} tone="neutral">{tag}</Badge>)}</div>
                  <div className="mt-3 flex gap-2 border-t border-stone-100 pt-2"><Button tone="secondary" size="sm" className="flex-1" onClick={() => openEdit(item)}>Edit</Button><Button tone="ghost" size="sm" onClick={() => void archive(item.sku)}>Archive</Button></div>
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="text-left opacity-50">
                  <th>SKU</th>
                  <th
                    title="Everything currently in the building - the sum of the stock ledger"
                  >
                    Name
                  </th>
                  <th className="text-right">Sale price</th>
                  <th className="text-right" title="Physical quantity on shelves; reserved units are still included here">
                    On hand
                  </th>
                  <th
                    className="text-right"
                    title="Moving average of what inward movements cost; advances only when stock comes in"
                  >
                    Avg cost
                  </th>
                  <th className="text-right" title="On hand × moving average cost - what the stock is worth at cost">
                    Value
                  </th>
                  <th className="text-right">Barcode</th>
                  <th className="text-right">Reorder</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visibleItems.map((i) => (
                  <tr key={i.sku} className="border-t">
                    <td className="py-1.5 font-mono text-xs">{i.sku}</td>
                    <td>
                      <span className="flex items-center gap-2">
                        {i.imageUrl ? <img src={i.imageUrl} alt="" className="size-6 rounded object-cover" /> : null}
                        {i.name}
                        {i.kind === "service" && (
                          <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-800">
                            service
                          </span>
                        )}
                        {i.tags && i.tags.length > 0 && (
                          <span className="text-xs opacity-50" title={i.tags.join(", ")}>
                            {i.tags.slice(0, 2).join(", ")}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="text-right tabular-nums">{(i.salePriceMinor ?? 0) > 0 ? formatMoney(i.salePriceMinor!) : "-"}</td>
                    <td className="text-right tabular-nums">{qty(i.onHandThousandths)}</td>
                    <td className="text-right tabular-nums">{formatMoney(i.avgUnitCostMinor)}</td>
                    <td className="text-right tabular-nums">{formatMoney(i.valueMinor)}</td>
                    <td className="text-right font-mono text-xs opacity-70">{i.barcode ?? "-"}</td>
                    <td className="text-right">
                      {i.reorderNeeded ? <Badge tone="amber">reorder</Badge> : <Badge tone="neutral">ok</Badge>}
                    </td>
                    <td className="text-right">
                      <span className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          aria-label={`Edit ${i.sku}`}
                          title="Edit name, price, barcode, image, tags"
                          onClick={() => openEdit(i)}
                          className="cursor-pointer rounded px-1.5 py-1 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          aria-label={`Archive ${i.sku}`}
                          title="Archive - hides from pickers, keeps history"
                          onClick={() => void archive(i.sku)}
                          className="cursor-pointer rounded px-1.5 py-1 text-stone-400 transition-colors hover:bg-red-50 hover:text-red-700"
                        >
                          ✕
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            </>
          )}
        </Card>
      )}


      {tab === "new" && (
        <Card>
          <CardTitle>{isService ? "Add a service" : "Add a product"}</CardTitle>
          <div className="space-y-4 text-sm">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="label sm:col-span-2">Type
                <div className="mt-1 flex gap-2">
                  <button type="button" aria-pressed={!isService} onClick={() => setIsService(false)} className={cn("flex-1 rounded-lg border px-3 py-2 text-sm", !isService ? "border-gold-400 bg-gold-50 text-stone-900" : "border-stone-200 bg-white text-stone-600")}>Product <span className="block text-xs font-normal opacity-70">Tracked stock and barcode</span></button>
                  <button type="button" aria-pressed={isService} onClick={() => { setIsService(true); setForm((current) => ({ ...current, unitLabel: "" })); }} className={cn("flex-1 rounded-lg border px-3 py-2 text-sm", isService ? "border-violet-300 bg-violet-50 text-stone-900" : "border-stone-200 bg-white text-stone-600")}>Service <span className="block text-xs font-normal opacity-70">Billable time or work</span></button>
                </div>
              </label>
              <label className="label">Name<input className="input mt-1" placeholder={isService ? "e.g. Consultation" : "e.g. Coffee beans"} aria-label="Product name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} maxLength={120} /></label>
              <label className="label">{isService ? "Service code" : "SKU"}<input className="input mt-1" placeholder={isService ? "Generated automatically" : "Required"} aria-label={isService ? "Optional service code" : "SKU"} value={form.sku} onChange={(event) => setForm({ ...form, sku: event.target.value })} />{isService && <span className="mt-1 block text-[11px] font-normal text-stone-500">Leave blank to assign a unique service code.</span>}</label>
              {isService ? (
                <label className="label">Billing unit<select className="select mt-1" value={serviceBasis} onChange={(event) => setServiceBasis(event.target.value as typeof serviceBasis)}><option value="hour">Per hour</option><option value="session">Per session</option><option value="job">Per job</option><option value="month">Per month</option></select></label>
              ) : (
                <label className="label">Unit label<input className="input mt-1" placeholder="unit, kg, box" aria-label="Unit label" value={form.unitLabel} onChange={(event) => setForm({ ...form, unitLabel: event.target.value })} /></label>
              )}
              <label className="label">Sale price<input className="input mt-1 tnum" type="number" min="0" step="0.01" inputMode="decimal" placeholder="0.00" aria-label="Default sale price" value={form.salePrice} onChange={(event) => setForm({ ...form, salePrice: event.target.value })} /></label>
              {!isService && <label className="label">Opening stock <span className="font-normal text-stone-400">(optional)</span><input className="input mt-1 tnum" type="number" min="0" step="0.001" inputMode="decimal" placeholder="0" aria-label="Opening stock quantity in units" value={form.openingQty} onChange={(event) => setForm({ ...form, openingQty: event.target.value })} /></label>}
              {!isService && <label className="label">Reorder point<input className="input mt-1 tnum" type="number" min="0" step="0.001" inputMode="decimal" placeholder="Optional" aria-label="Reorder point in units" value={form.reorder} onChange={(event) => setForm({ ...form, reorder: event.target.value })} /></label>}
              {!isService && <label className="label">Barcode <span className="font-normal text-stone-400">(optional)</span><input className="input mt-1" placeholder="Scan or enter a barcode" aria-label="Barcode" value={form.barcode} onChange={(event) => setForm({ ...form, barcode: event.target.value })} /></label>}
              <label className="label">Tags or category<input className="input mt-1" placeholder="Consulting, premium" aria-label="Tags, separated by commas" value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} /></label>
              <label className="label sm:col-span-2">Image URL <span className="font-normal text-stone-400">(optional)</span><input className="input mt-1" placeholder="https://..." aria-label="Product image URL" value={form.imageUrl} onChange={(event) => setForm({ ...form, imageUrl: event.target.value })} /></label>
            </div>
            <div className="flex flex-col-reverse gap-2 border-t border-stone-100 pt-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-stone-500">{isService ? `This service will be priced per ${serviceBasis} and will not use stock or barcodes.` : "Opening stock is recorded in the stock ledger after the product is created."}</p>
              <Button className="min-h-11" disabled={busy || !form.name.trim() || (!isService && !form.sku.trim())} onClick={() => void createProduct()}>{isService ? "Add service" : "Add product"}</Button>
            </div>
          </div>
        </Card>
      )}

      <Dialog open={importOpen} onClose={() => setImportOpen(false)} title="Import products and services" description="Map your spreadsheet, review the preview, and skip matching codes before adding catalog items." width="max-w-4xl">
        {importOpen && <CsvImportPanel initialEntity="products" onChanged={() => void load()} onImported={(outcome) => {
          if (outcome.entity !== "products") return;
          setNotice({ tone: "success", text: `${outcome.inserted} catalog item${outcome.inserted === 1 ? "" : "s"} imported. Opening stock can be recorded in Inventory.` });
        }} onSkipped={() => setImportOpen(false)} />}
      </Dialog>

      {/* Edit item - identity beyond the SKU */}
      <Dialog
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        title={`Edit ${editTarget?.sku ?? ""}`}
        description="Clearing the barcode or image removes it; the prior values are snapshotted so the edit can be undone."
        footer={
          <>
            <Button tone="secondary" onClick={() => setEditTarget(null)} disabled={busy}>
              Cancel
            </Button>
            <Button loading={busy} disabled={!editForm.name.trim()} onClick={() => void saveEdit()}>
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap gap-2">
            <div className="min-w-40 flex-1">
              <label htmlFor="edit-name" className="label">
                Name
              </label>
              <input
                id="edit-name"
                className="input"
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              />
            </div>
            <div className="w-24">
              <label htmlFor="edit-unit" className="label">
                Unit
              </label>
              <input
                id="edit-unit"
                className="input"
                placeholder="kg"
                value={editForm.unitLabel}
                onChange={(e) => setEditForm({ ...editForm, unitLabel: e.target.value })}
              />
            </div>
            <div className="w-28">
              <label htmlFor="edit-price" className="label">
                Sale price
              </label>
              <input
                id="edit-price"
                inputMode="decimal"
                className="input tnum"
                value={editForm.salePrice}
                onChange={(e) => setEditForm({ ...editForm, salePrice: e.target.value })}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="min-w-40 flex-1">
              <label htmlFor="edit-barcode" className="label">
                Barcode
              </label>
              <input
                id="edit-barcode"
                className="input"
                value={editForm.barcode}
                onChange={(e) => setEditForm({ ...editForm, barcode: e.target.value })}
              />
            </div>
            <div className="min-w-44 flex-1">
              <label htmlFor="edit-image" className="label">
                Image URL
              </label>
              <input
                id="edit-image"
                className="input"
                value={editForm.imageUrl}
                onChange={(e) => setEditForm({ ...editForm, imageUrl: e.target.value })}
              />
            </div>
          </div>
          <div>
            <label htmlFor="edit-tags" className="label">
              Tags (comma separated)
            </label>
            <input
              id="edit-tags"
              className="input"
              value={editForm.tags}
              onChange={(e) => setEditForm({ ...editForm, tags: e.target.value })}
            />
          </div>
        </div>
      </Dialog>

    </AppFrame>
  );
}
