"use client";

import { useCallback, useEffect, useState } from "react";
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
import { formatMoney } from "@/lib/format";
import { IconBox, IconSearch } from "@/components/icons";
import { callApi, postApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";
import { AppFrame } from "../_shell/app-frame";

type Tab = "overview" | "catalog" | "new";

interface Item {
  sku: string;
  name: string;
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
  const enabled = useModuleEnabled("inventory");
  const [data, setData] = useState<Payload | null>(null);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [search, setSearch] = useState("");
  const [form, setForm] = useState({ sku: "", name: "", unitLabel: "", salePrice: "", openingQty: "", barcode: "", imageUrl: "", tags: "" });

  const load = useCallback(async () => {
    const res = await callApi<Payload>("/api/inventory");
    setData(res.data ?? {});
    if (res.error) setNotice({ tone: "error", error: res.error });
  }, []);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

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
    const sku = form.sku.trim();
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
        unitLabel: form.unitLabel.trim() || undefined,
        salePriceMinor: Math.round(Number(form.salePrice || "0") * 100),
        barcode: form.barcode.trim() || undefined,
        imageUrl: form.imageUrl.trim() || undefined,
        tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
      },
      `Create ${name}`,
    );
    if (!ok) return;

    const openingQty = Math.round(Number(form.openingQty || "0") * 1000);
    if (openingQty > 0) await post({ action: "adjustStock", sku, quantityDelta: openingQty, note: "Opening stock" }, "Record opening stock");
    setForm({ sku: "", name: "", unitLabel: "", salePrice: "", openingQty: "", barcode: "", imageUrl: "", tags: "" });
  }

  async function archive(sku: string): Promise<void> {
    if (!window.confirm(`Archive ${sku}? Past quotes and invoices keep their history.`)) return;
    await post({ action: "archiveItem", sku, archive: true }, `Archive ${sku}`);
  }

  if (!enabled) return <ModuleDisabled label="Products" />;
  if (!data) return <LoadingPage />;

  const items = data.items ?? [];
  const alerts = data.reorderAlerts ?? [];
  const totalValueMinor = data.totalValueMinor ?? items.reduce((s, i) => s + i.valueMinor, 0);
  const reorderCount = items.filter((i) => i.reorderNeeded).length;
  const q = search.trim().toLowerCase();
  const visibleItems = q ? items.filter((i) => i.sku.toLowerCase().includes(q) || i.name.toLowerCase().includes(q)) : items;

  return (
    <AppFrame
      appId="products"
      description="The item catalog behind every quote, invoice, and stock movement."
      tabs={[
        { id: "overview", label: "Overview" },
        { id: "catalog", label: "Catalog" },
        { id: "new", label: "Create product" },
      ]}
      activeTab={tab}
      onTabChange={(id) => setTab(id as Tab)}
      persistKey="products"
    >
      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}

      {tab === "overview" && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Items in catalog" value={items.length} />
            <StatCard label="Total stock value" value={formatMoney(totalValueMinor)} />
            <StatCard
              label="Reorder alerts"
              value={reorderCount}
              sub={`${alerts.length} below reorder point`}
              tone={reorderCount > 0 ? "warn" : "default"}
            />
          </div>
          <Card>
            <CardTitle>Items needing reorder</CardTitle>
            {alerts.length === 0 ? (
              <EmptyState icon={<IconBox />} title="Nothing below reorder point" hint="Every item is at or above its reorder threshold." />
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
              Stock movements live in the Inventory app — receive, adjust, and count stock there; this catalog stays the pricing
              and product surface.
            </p>
          </Card>
        </>
      )}


      {tab === "catalog" && (
        <Card>
          <CardTitle
            right={
              <div className="flex items-center gap-1.5 rounded border bg-transparent px-2 py-1 text-sm">
                <IconSearch className="size-3.5 opacity-50" />
                <input
                  className="w-40 bg-transparent outline-none"
                  placeholder="Search SKU or name"
                  aria-label="Search catalog"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            }
          >
            Catalog
          </CardTitle>
          {items.length === 0 ? (
            <EmptyState icon={<IconBox />} title="No products yet" hint="Create your first product in the Create product tab." />
          ) : visibleItems.length === 0 ? (
            <EmptyState icon={<IconSearch />} title={`Nothing matches “${search.trim()}”`} hint="Try a different SKU or name fragment." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left opacity-50">
                  <th>SKU</th>
                  <th
                    title="Everything currently in the building — the sum of the stock ledger"
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
                  <th className="text-right" title="On hand × moving average cost — what the stock is worth at cost">
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
                        {i.tags && i.tags.length > 0 && (
                          <span className="text-xs opacity-50" title={i.tags.join(", ")}>
                            {i.tags.slice(0, 2).join(", ")}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="text-right tabular-nums">{(i.salePriceMinor ?? 0) > 0 ? formatMoney(i.salePriceMinor!) : "—"}</td>
                    <td className="text-right tabular-nums">{qty(i.onHandThousandths)}</td>
                    <td className="text-right tabular-nums">{formatMoney(i.avgUnitCostMinor)}</td>
                    <td className="text-right tabular-nums">{formatMoney(i.valueMinor)}</td>
                    <td className="text-right font-mono text-xs opacity-70">{i.barcode ?? "—"}</td>
                    <td className="text-right">
                      {i.reorderNeeded ? <Badge tone="amber">reorder</Badge> : <Badge tone="neutral">ok</Badge>}
                    </td>
                    <td className="text-right">
                      <button
                        type="button"
                        aria-label={`Archive ${i.sku}`}
                        title="Archive — hides from pickers, keeps history"
                        onClick={() => void archive(i.sku)}
                        className="cursor-pointer rounded px-1.5 py-1 text-stone-400 transition-colors hover:bg-red-50 hover:text-red-700"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}


      {tab === "new" && (
        <Card>
          <CardTitle>Create product</CardTitle>
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="w-36 rounded border bg-transparent px-2 py-1.5"
                placeholder="SKU"
                aria-label="SKU"
                value={form.sku}
                onChange={(e) => setForm({ ...form, sku: e.target.value })}
              />
              <input
                className="min-w-40 flex-1 rounded border bg-transparent px-2 py-1.5"
                placeholder="Name"
                aria-label="Product name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <input
                className="w-28 rounded border bg-transparent px-2 py-1.5"
                placeholder="Unit (optional)"
                aria-label="Unit label, for example kg or hour"
                value={form.unitLabel}
                onChange={(e) => setForm({ ...form, unitLabel: e.target.value })}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="w-24 rounded border bg-transparent px-2 py-1.5 text-right"
                placeholder="Sale price"
                aria-label="Default sale price"
                value={form.salePrice}
                onChange={(e) => setForm({ ...form, salePrice: e.target.value })}
              />
              <input
                className="w-36 rounded border bg-transparent px-2 py-1.5 text-right"
                placeholder="Opening qty"
                aria-label="Opening stock quantity in units"
                value={form.openingQty}
                onChange={(e) => setForm({ ...form, openingQty: e.target.value })}
              />
              <input
                className="w-40 rounded border bg-transparent px-2 py-1.5"
                placeholder="Barcode (optional)"
                aria-label="Barcode, for example an EAN or UPC code"
                value={form.barcode}
                onChange={(e) => setForm({ ...form, barcode: e.target.value })}
              />
              <input
                className="w-44 rounded border bg-transparent px-2 py-1.5"
                placeholder="Image URL (optional)"
                aria-label="Product image URL"
                value={form.imageUrl}
                onChange={(e) => setForm({ ...form, imageUrl: e.target.value })}
              />
              <input
                className="w-40 rounded border bg-transparent px-2 py-1.5"
                placeholder="Tags (comma separated)"
                aria-label="Tags, separated by commas"
                value={form.tags}
                onChange={(e) => setForm({ ...form, tags: e.target.value })}
              />
              <Button disabled={busy || !form.sku.trim() || !form.name.trim()} onClick={() => void createProduct()}>
                Create product
              </Button>
            </div>
            <p className="text-xs opacity-50">
              An optional opening quantity is recorded as a stock adjustment right after the item exists. Later movements
              (receipts, adjustments, counts) belong to the Inventory app.
            </p>
          </div>
        </Card>
      )}

    </AppFrame>
  );
}
