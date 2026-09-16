"use client";

import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardTitle,
  ConfirmDialog,
  EmptyState,
  SegmentedControl,
  Switch,
} from "@/components/ui";
import { IconFileText, IconPlus, IconTrash } from "@/components/icons";
import { formatMoney, timeAgo, toMinor } from "@/lib/format";

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

const emptyLine = { description: "", quantity: "1", unitPrice: "0.00", tax: "0.00", sku: "" };

interface OrdersTabProps {
  orders: OrderRow[];
  customers: CustomerLite[];
  products: ProductLite[];
  busy: boolean;
  post: (url: string, body: Record<string, unknown>, label: string) => Promise<boolean>;
}

export function OrdersListTab({ orders, customers, busy, post }: OrdersTabProps) {
  const [filter, setFilter] = useState<OrderFilter>("all");
  const [allowBackorder, setAllowBackorder] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<OrderRow | null>(null);

  const customerName = new Map(customers.map((c) => [c.id, c.name]));
  const visible = filter === "all" ? orders : orders.filter((o) => o.status === filter);
  const open = orders.filter((o) => o.status === "draft" || o.status === "confirmed");

  async function confirm(order: OrderRow): Promise<void> {
    await post(
      "/api/sales",
      { action: "confirm", orderId: order.id, allowBackorder: allowBackorder || undefined },
      `Confirm order #${order.number}`,
    );
  }

  async function deliver(order: OrderRow): Promise<void> {
    await post("/api/sales", { action: "deliver", orderId: order.id }, `Deliver order #${order.number}`);
  }

  async function cancelOrder(): Promise<void> {
    if (!cancelTarget) return;
    await post("/api/sales", { action: "cancel", orderId: cancelTarget.id }, `Cancel order #${cancelTarget.number}`);
    setCancelTarget(null);
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
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
        <Switch
          checked={allowBackorder}
          onChange={setAllowBackorder}
          label="Confirm with backorders"
          hint="Reserve what exists and flag the shortfall instead of refusing when stock runs short"
        />
      </div>

      {open.length === 0 && orders.length === 0 ? (
        <EmptyState
          icon={<IconFileText />}
          title="No sales orders yet"
          hint="Draft one in the New order tab; confirming reserves stock, delivering ships and invoices it."
        />
      ) : visible.length === 0 ? (
        <EmptyState icon={<IconFileText />} title={`No ${filter} orders`} hint="Try another status filter." />
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
              Order #{o.number} — {customerName.get(o.customerId) ?? "Unknown customer"}
            </CardTitle>
            <p className="text-xs opacity-60">
              {formatMoney(o.totalMinor)} · created {timeAgo(o.createdAt)}
            </p>
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
                  <Button size="sm" disabled={busy} aria-label={`Confirm order #${o.number}`} onClick={() => void confirm(o)}>
                    Confirm &amp; reserve
                  </Button>
                ) : (
                  <Button size="sm" disabled={busy} aria-label={`Deliver order #${o.number}`} onClick={() => void deliver(o)}>
                    Deliver &amp; invoice
                  </Button>
                )}
              </div>
            )}
          </Card>
        ))
      )}

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

export function NewOrderTab({ customers, products, busy, post }: OrdersTabProps) {
  const [form, setForm] = useState({ customerId: "", note: "", lines: [{ ...emptyLine }] });

  const activeCustomers = customers.filter((c) => !c.deactivatedAt);
  const customerName = new Map(customers.map((c) => [c.id, c.name]));

  async function createOrder(): Promise<void> {
    const lines = form.lines
      .map((l) => ({
        description: l.description.trim(),
        quantity: Math.round(Number(l.quantity || "0") * 1000),
        unitPriceMinor: toMinor(l.unitPrice),
        taxMinor: toMinor(l.tax),
        sku: l.sku || undefined,
      }))
      .filter((l) => l.description.length > 0 && l.quantity > 0);
    if (!form.customerId || lines.length === 0) return;
    const who = customerName.get(form.customerId) ?? "customer";
    const ok = await post(
      "/api/sales",
      { action: "create", customerId: form.customerId, note: form.note.trim() || undefined, lines },
      `Order for ${who}`,
    );
    if (ok) setForm({ customerId: "", note: "", lines: [{ ...emptyLine }] });
  }

  return (
    <Card>
      <CardTitle>Draft sales order</CardTitle>
      <div className="space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="rounded border bg-transparent px-2 py-1.5"
            aria-label="Customer"
            value={form.customerId}
            onChange={(e) => setForm({ ...form, customerId: e.target.value })}
          >
            <option value="">Customer…</option>
            {activeCustomers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <input
            className="min-w-40 flex-1 rounded border bg-transparent px-2 py-1.5"
            placeholder="Note (optional)"
            aria-label="Order note"
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
        </div>

        <div className="space-y-1.5 pt-1">
          {form.lines.map((line, i) => {
            const setLine = (patch: Partial<typeof line>) =>
              setForm({ ...form, lines: form.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
            return (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <select
                  className="w-44 rounded border bg-transparent px-2 py-1.5"
                  title="Pick a product to fill description and price; leave blank for a service line"
                  aria-label={`Line ${i + 1} product`}
                  value={products.some((p) => p.sku === line.sku) ? line.sku : ""}
                  onChange={(e) => {
                    const p = products.find((x) => x.sku === e.target.value);
                    if (!p) return;
                    setLine({
                      sku: p.sku,
                      description: line.description || p.name,
                      unitPrice:
                        p.salePriceMinor != null && p.salePriceMinor > 0
                          ? (p.salePriceMinor / 100).toFixed(2)
                          : line.unitPrice,
                    });
                  }}
                >
                  <option value="">{products.length ? "Product…" : "No products yet"}</option>
                  {products.map((p) => (
                    <option key={p.sku} value={p.sku}>{p.name} · {p.sku}</option>
                  ))}
                </select>
                <input
                  className="min-w-40 flex-1 rounded border bg-transparent px-2 py-1.5"
                  placeholder="Description"
                  aria-label={`Line ${i + 1} description`}
                  value={line.description}
                  onChange={(e) => setLine({ description: e.target.value })}
                />
                <input
                  className="w-20 rounded border bg-transparent px-2 py-1.5 text-right"
                  placeholder="Qty"
                  aria-label={`Line ${i + 1} quantity`}
                  value={line.quantity}
                  onChange={(e) => setLine({ quantity: e.target.value })}
                />
                <input
                  className="w-24 rounded border bg-transparent px-2 py-1.5 text-right"
                  placeholder="Unit price"
                  aria-label={`Line ${i + 1} unit price`}
                  value={line.unitPrice}
                  onChange={(e) => setLine({ unitPrice: e.target.value })}
                />
                <input
                  className="w-20 rounded border bg-transparent px-2 py-1.5 text-right"
                  placeholder="Tax"
                  aria-label={`Line ${i + 1} tax amount`}
                  value={line.tax}
                  onChange={(e) => setLine({ tax: e.target.value })}
                />
                <Button
                  tone="ghost"
                  size="sm"
                  aria-label={`Remove line ${i + 1}`}
                  onClick={() => setForm({ ...form, lines: form.lines.filter((_, j) => j !== i) })}
                >
                  <IconTrash className="size-4" />
                </Button>
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button tone="ghost" size="sm" onClick={() => setForm({ ...form, lines: [...form.lines, { ...emptyLine }] })}>
            <IconPlus className="size-4" /> Add line
          </Button>
          <Button disabled={busy || !form.customerId} onClick={() => void createOrder()}>
            Create order
          </Button>
        </div>
        <p className="text-xs opacity-50">
          Confirming a draft checks the customer's credit headroom and reserves stock; delivering ships the reservation and
          raises the invoice automatically.
        </p>
      </div>
    </Card>
  );
}
