"use client";

import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardTitle,
  ConfirmDialog,
  EmptyState,
  SegmentedControl,
} from "@/components/ui";
import { IconFileText, IconPlus, IconTrash } from "@/components/icons";
import { formatMoney, minorToInput, timeAgo, toMinor } from "@/lib/format";
import { QuickCreateButton } from "../quick-create";

export interface OrderRow {
  id: string;
  number: number;
  customerId: string;
  status: string;
  backordered: boolean;
  totalMinor: number;
  createdAt: string;
}
interface CustomerLite {
  id: string;
  name: string;
  deactivatedAt: string | null;
}
interface ProductLite {
  sku: string;
  name: string;
  salePriceMinor?: number;
}

type OrderFilter = "all" | "draft" | "confirmed" | "delivered" | "cancelled";

const orderTones: Record<string, "amber" | "blue" | "green" | "red"> = {
  draft: "amber",
  confirmed: "blue",
  delivered: "green",
  cancelled: "red",
};

const emptyLine = { description: "", quantity: "1", unitPrice: "0", tax: "0", sku: "" };

function lineTotals(line: typeof emptyLine): { subtotalMinor: number; taxMinor: number } {
  const quantity = Number(line.quantity || "0");
  const price = Number(line.unitPrice || "0");
  const tax = Number(line.tax || "0");
  if (!Number.isFinite(quantity) || !Number.isFinite(price) || !Number.isFinite(tax) || quantity < 0 || price < 0 || tax < 0) {
    return { subtotalMinor: 0, taxMinor: 0 };
  }
  return {
    subtotalMinor: Math.round((Math.round(quantity * 1000) * toMinor(line.unitPrice)) / 1000),
    taxMinor: toMinor(line.tax),
  };
}

function orderTotals(lines: (typeof emptyLine)[]) {
  return lines.reduce(
    (total, line) => {
      const amounts = lineTotals(line);
      return { subtotalMinor: total.subtotalMinor + amounts.subtotalMinor, taxMinor: total.taxMinor + amounts.taxMinor };
    },
    { subtotalMinor: 0, taxMinor: 0 },
  );
}

interface OrdersTabProps {
  orders: OrderRow[];
  customers: CustomerLite[];
  products: ProductLite[];
  busy: boolean;
  post: (url: string, body: Record<string, unknown>, label: string) => Promise<boolean>;
  onCreateOrder?: () => void;
}

export function OrdersListTab({ orders, customers, busy, post, onCreateOrder }: OrdersTabProps) {
  const [filter, setFilter] = useState<OrderFilter>("all");
  const [query, setQuery] = useState("");
  const [allowBackorder, setAllowBackorder] = useState<Record<string, boolean>>({});
  const [cancelTarget, setCancelTarget] = useState<OrderRow | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<OrderRow | null>(null);
  const [deliverTarget, setDeliverTarget] = useState<OrderRow | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const customerName = new Map(customers.map((c) => [c.id, c.name]));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = orders.filter((order) => {
    const matchesStatus = filter === "all" || order.status === filter;
    const matchesQuery = !normalizedQuery || `#${order.number} ${customerName.get(order.customerId) ?? "Unknown customer"} ${order.status}`.toLocaleLowerCase().includes(normalizedQuery);
    return matchesStatus && matchesQuery;
  });
  const open = orders.filter((o) => o.status === "draft" || o.status === "confirmed");

  useEffect(() => {
    function onShortcut(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select"))) return;
      event.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);

  async function confirm(order: OrderRow): Promise<void> {
    const ok = await post(
      "/api/sales",
      { action: "confirm", orderId: order.id, allowBackorder: allowBackorder[order.id] || undefined },
      `Confirm order #${order.number}`,
    );
    if (ok) setConfirmTarget(null);
  }

  async function deliver(order: OrderRow): Promise<void> {
    const ok = await post("/api/sales", { action: "deliver", orderId: order.id }, `Deliver order #${order.number}`);
    if (ok) setDeliverTarget(null);
  }

  async function cancelOrder(): Promise<void> {
    if (!cancelTarget) return;
    await post("/api/sales", { action: "cancel", orderId: cancelTarget.id }, `Cancel order #${cancelTarget.number}`);
    setCancelTarget(null);
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="max-w-full overflow-x-auto pb-1">
          <SegmentedControl
            ariaLabel="Filter orders by status"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              { value: "draft", label: "Draft" },
              { value: "confirmed", label: "Confirmed" },
              { value: "delivered", label: "Delivered" },
              { value: "cancelled", label: "Cancelled" },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-52 flex-1 sm:max-w-xs">
            <span className="sr-only">Search orders by number, customer, or status</span>
            <input ref={searchRef} type="search" className="min-h-9 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm text-[#f6efe5] placeholder:text-[#a69d91] focus:border-gold-500 focus:outline-none focus:ring-2 focus:ring-gold-500/30" placeholder="Search orders…" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <span className="hidden text-xs text-[#bdb4a8] sm:inline">Press / to search</span>
        </div>
      </div>

      {open.length === 0 && orders.length === 0 ? (
        <div>
          <EmptyState
            icon={<IconFileText />}
            title="No sales orders yet"
            hint="Create an order for a customer, then confirm it to check credit and reserve stock."
          />
          <div className="mt-3 text-center"><Button size="sm" onClick={onCreateOrder}>Create sales order</Button></div>
        </div>
      ) : visible.length === 0 ? (
        <div>
          <EmptyState icon={<IconFileText />} title={query ? "No matching orders" : `No ${filter} orders`} hint={query ? "Try another customer name, order number, or clear the search." : "Try another status filter."} />
          {query && <div className="mt-3 text-center"><Button size="sm" tone="secondary" onClick={() => setQuery("")}>Clear search</Button></div>}
        </div>
      ) : (
        visible.map((o) => (
          <Card key={o.id}>
            <CardTitle
              right={
                <span className="flex items-center gap-2">
                  {o.backordered && <Badge tone="amber">backordered</Badge>}
                  <Badge tone={orderTones[o.status] ?? "neutral"}>{o.status}</Badge>
                </span>
              }
            >
              Order #{o.number} - {customerName.get(o.customerId) ?? "Unknown customer"}
            </CardTitle>
            <p className="text-xs text-[#bdb4a8]">
              {formatMoney(o.totalMinor)} · created {timeAgo(o.createdAt)}
            </p>
            {o.status === "draft" && (
              <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2">
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 shrink-0 accent-[#d1a850] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-500"
                    checked={allowBackorder[o.id] ?? false}
                    onChange={(event) => setAllowBackorder((current) => ({ ...current, [o.id]: event.target.checked }))}
                  />
                  <span>
                    <span className="block text-sm font-medium text-[#eee6db]">Allow a backorder for this order</span>
                    <span className="mt-0.5 block text-xs text-[#bdb4a8]">Reserve available stock and flag any shortfall. Leave off to require full stock before confirming.</span>
                  </span>
                </label>
              </div>
            )}
            {(o.status === "draft" || o.status === "confirmed") && (
              <div className="mt-2 flex justify-end gap-2">
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={busy}
                  aria-label={`Cancel order #${o.number}`}
                  onClick={() => setCancelTarget(o)}
                >
                  Cancel
                </Button>
                {o.status === "draft" ? (
                  <Button size="sm" disabled={busy} aria-label={`Confirm order #${o.number}`} onClick={() => setConfirmTarget(o)}>
                    Confirm &amp; reserve
                  </Button>
                ) : (
                  <Button size="sm" disabled={busy} aria-label={`Deliver order #${o.number}`} onClick={() => setDeliverTarget(o)}>
                    Deliver &amp; invoice
                  </Button>
                )}
              </div>
            )}
          </Card>
        ))
      )}

      <ConfirmDialog
        open={confirmTarget !== null}
        onClose={() => setConfirmTarget(null)}
        onConfirm={() => confirmTarget && void confirm(confirmTarget)}
        title={`Confirm order #${confirmTarget?.number ?? ""}?`}
        body={confirmTarget ? `${allowBackorder[confirmTarget.id] ? "Available stock will be reserved and any shortfall marked as a backorder." : "The order will confirm only if enough stock is available for every item."} Customer credit headroom will also be checked.` : ""}
        confirmLabel="Confirm & reserve"
        busy={busy}
      />
      <ConfirmDialog
        open={deliverTarget !== null}
        onClose={() => setDeliverTarget(null)}
        onConfirm={() => deliverTarget && void deliver(deliverTarget)}
        title={`Deliver order #${deliverTarget?.number ?? ""}?`}
        body={deliverTarget ? `This records fulfillment and creates an invoice for ${formatMoney(deliverTarget.totalMinor)}. Check that the order is ready to ship before continuing.` : ""}
        confirmLabel="Deliver & create invoice"
        busy={busy}
      />
      <ConfirmDialog
        open={cancelTarget !== null}
        onClose={() => setCancelTarget(null)}
        onConfirm={() => void cancelOrder()}
        title={`Cancel order #${cancelTarget?.number ?? ""}`}
        body="Withdraws the order and releases every stock reservation it still holds. A delivered or partially delivered order cannot be cancelled this way."
        confirmLabel="Cancel order"
        busy={busy}
      />
    </>
  );
}

export function NewOrderTab({
  customers,
  products,
  busy,
  post,
  onDataChanged,
}: OrdersTabProps & { onDataChanged?: () => void }) {
  const [form, setForm] = useState({ customerId: "", note: "", lines: [{ ...emptyLine }] });
  const [formError, setFormError] = useState("");
  // A just-quick-created product: applied to its line once the refreshed
  // product list arrives and the sku resolves to a product.
  const [pendingLine, setPendingLine] = useState<{ index: number; sku: string } | null>(null);

  useEffect(() => {
    if (!pendingLine) return;
    const p = products.find((x) => x.sku === pendingLine.sku);
    if (!p) return;
    setForm((f) => ({
      ...f,
      lines: f.lines.map((l, j) =>
        j === pendingLine.index
          ? {
              ...l,
              sku: p.sku,
              description: l.description || p.name,
              unitPrice:
                p.salePriceMinor != null && p.salePriceMinor > 0 ? minorToInput(p.salePriceMinor) : l.unitPrice,
            }
          : l,
      ),
    }));
    setPendingLine(null);
  }, [pendingLine, products]);

  const activeCustomers = customers.filter((c) => !c.deactivatedAt);
  const customerName = new Map(customers.map((c) => [c.id, c.name]));
  const amounts = orderTotals(form.lines);

  async function createOrder(): Promise<void> {
    const describedLines = form.lines.filter((line) => line.description.trim().length > 0);
    if (!form.customerId || describedLines.length === 0) {
      setFormError("Choose a customer and add at least one described line item.");
      return;
    }
    const hasInvalidLine = describedLines.some((line) => {
      const quantity = Number(line.quantity || "0");
      const price = Number(line.unitPrice || "0");
      const tax = Number(line.tax || "0");
      return !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price < 0 || !Number.isFinite(tax) || tax < 0;
    });
    if (hasInvalidLine) {
      setFormError("Each line needs a positive quantity and non-negative price and tax.");
      return;
    }
    const lines = describedLines.map((line) => ({
      description: line.description.trim(),
      quantity: Math.round(Number(line.quantity || "0") * 1000),
      unitPriceMinor: toMinor(line.unitPrice),
      taxMinor: toMinor(line.tax),
      sku: line.sku || undefined,
    }));
    const who = customerName.get(form.customerId) ?? "customer";
    const ok = await post(
      "/api/sales",
      { action: "create", customerId: form.customerId, note: form.note.trim() || undefined, lines },
      `Order for ${who}`,
    );
    if (ok) {
      setForm({ customerId: "", note: "", lines: [{ ...emptyLine }] });
      setFormError("");
    }
  }

  return (
    <Card>
      <CardTitle>Create sales order</CardTitle>
      <div className="space-y-2 text-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="order-customer" className="mb-1 block text-xs font-medium text-[#c4bbb0]">Customer <span className="text-rose-300">*</span></label>
            <div className="flex items-center gap-2">
              <select id="order-customer" className="select min-h-10 min-w-44 flex-1" value={form.customerId} onChange={(e) => {
                setForm({ ...form, customerId: e.target.value });
                setFormError("");
              }}>
                <option value="">Choose a customer…</option>
                {activeCustomers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <QuickCreateButton entity="customer" onCreated={(r) => {
                onDataChanged?.();
                setForm((f) => ({ ...f, customerId: r.id }));
                setFormError("");
              }} />
            </div>
          </div>
          <label>
            <span className="mb-1 block text-xs font-medium text-[#c4bbb0]">Order note <span className="font-normal text-[#a69d91]">(optional)</span></span>
            <input className="min-h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm text-[#f6efe5] placeholder:text-[#a69d91]" placeholder="Add delivery or customer context" value={form.note} onChange={(e) => {
              setForm({ ...form, note: e.target.value });
              setFormError("");
            }} />
          </label>
        </div>

        <div className="space-y-2 pt-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-medium text-[#f6efe5]">Line items</h2>
              <p className="text-xs text-[#bdb4a8]">Choose a catalog item or describe a service. Prices and tax use the workspace currency.</p>
            </div>
            {products.length === 0 && <a href="/products" className="text-xs font-medium text-[#dec28f] underline-offset-4 hover:underline">Browse products</a>}
          </div>
          {form.lines.map((line, i) => {
            const lineAmount = lineTotals(line);
            const setLine = (patch: Partial<typeof line>) => {
              setForm({ ...form, lines: form.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
              setFormError("");
            };
            return (
              <div key={i} className="grid grid-cols-2 gap-2 rounded-lg border border-white/10 bg-white/[0.02] p-2 sm:grid-cols-12">
                <div className="col-span-2 sm:col-span-3">
                  <label htmlFor={`order-${i}-product`} className="mb-1 block text-[11px] font-medium text-[#bdb4a8]">Catalog item</label>
                  <div className="flex items-center gap-1.5">
                    <select id={`order-${i}-product`} className="select min-w-0 flex-1" title="Choose a product to fill description and price; leave blank for a service line" value={products.some((p) => p.sku === line.sku) ? line.sku : ""} onChange={(e) => {
                      const p = products.find((x) => x.sku === e.target.value);
                      if (!p) return;
                      setLine({ sku: p.sku, description: line.description || p.name, unitPrice: p.salePriceMinor != null && p.salePriceMinor > 0 ? minorToInput(p.salePriceMinor) : line.unitPrice });
                    }}>
                      <option value="">{products.length ? "Choose item…" : "Service / custom"}</option>
                      {products.map((p) => <option key={p.sku} value={p.sku}>{p.name} · {p.sku}</option>)}
                    </select>
                    <QuickCreateButton entity="product" className="size-8 shrink-0" onCreated={(r) => {
                      onDataChanged?.();
                      setPendingLine({ index: i, sku: r.id });
                      setLine({ sku: r.id });
                    }} />
                  </div>
                </div>
                <label className="col-span-2 sm:col-span-4">
                  <span className="mb-1 block text-[11px] font-medium text-[#bdb4a8]">Description</span>
                  <input className="min-h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm text-[#f6efe5]" value={line.description} onChange={(e) => setLine({ description: e.target.value })} />
                </label>
                <label className="sm:col-span-1">
                  <span className="mb-1 block text-[11px] font-medium text-[#bdb4a8]">Qty</span>
                  <input inputMode="decimal" min="0" className="min-h-10 w-full rounded-lg border border-white/10 bg-black/20 px-2 text-right text-sm text-[#f6efe5]" aria-label={`Line ${i + 1} quantity`} value={line.quantity} onChange={(e) => setLine({ quantity: e.target.value })} />
                </label>
                <label className="sm:col-span-2">
                  <span className="mb-1 block text-[11px] font-medium text-[#bdb4a8]">Unit price</span>
                  <input inputMode="decimal" min="0" className="min-h-10 w-full rounded-lg border border-white/10 bg-black/20 px-2 text-right text-sm text-[#f6efe5]" aria-label={`Line ${i + 1} unit price`} value={line.unitPrice} onChange={(e) => setLine({ unitPrice: e.target.value })} />
                </label>
                <label className="sm:col-span-1">
                  <span className="mb-1 block text-[11px] font-medium text-[#bdb4a8]">Tax</span>
                  <input inputMode="decimal" min="0" className="min-h-10 w-full rounded-lg border border-white/10 bg-black/20 px-2 text-right text-sm text-[#f6efe5]" aria-label={`Line ${i + 1} tax amount`} value={line.tax} onChange={(e) => setLine({ tax: e.target.value })} />
                </label>
                <div className="col-span-2 flex items-center justify-between border-t border-white/10 pt-1 sm:col-span-12">
                  <span className="text-xs text-[#bdb4a8]">Line {i + 1} total</span>
                  <div className="flex items-center gap-2">
                    <strong className="tabular-nums text-[#f6efe5]">{formatMoney(lineAmount.subtotalMinor + lineAmount.taxMinor)}</strong>
                    <Button tone="ghost" size="sm" aria-label={`Remove line ${i + 1}`} onClick={() => {
                      setForm({ ...form, lines: form.lines.filter((_, j) => j !== i) });
                      setFormError("");
                    }}><IconTrash className="size-4" /></Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {formError && <p role="alert" className="rounded-lg border border-rose-400/30 bg-rose-950/20 px-3 py-2 text-sm text-rose-100">{formError}</p>}
        <div className="flex flex-wrap items-start justify-between gap-3 border-t border-white/10 pt-3">
          <Button tone="ghost" size="sm" onClick={() => {
            setForm({ ...form, lines: [...form.lines, { ...emptyLine }] });
            setFormError("");
          }}><IconPlus className="size-4" /> Add line</Button>
          <div className="ml-auto min-w-48 space-y-1 text-right">
            <div className="flex justify-between gap-6 text-xs text-[#bdb4a8]"><span>Subtotal</span><span>{formatMoney(amounts.subtotalMinor)}</span></div>
            <div className="flex justify-between gap-6 text-xs text-[#bdb4a8]"><span>Tax</span><span>{formatMoney(amounts.taxMinor)}</span></div>
            <div className="flex justify-between gap-6 border-t border-white/10 pt-1 font-semibold text-[#f6efe5]"><span>Total</span><span>{formatMoney(amounts.subtotalMinor + amounts.taxMinor)}</span></div>
            <Button className="mt-2 w-full" disabled={busy} onClick={() => void createOrder()}>Create order</Button>
          </div>
        </div>
        <p className="text-xs text-[#bdb4a8]">The new order stays in Draft. Confirmation checks the customer&apos;s credit and available stock, with an explicit backorder choice.</p>
      </div>
    </Card>
  );
}
