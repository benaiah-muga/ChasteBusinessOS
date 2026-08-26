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
import { formatMoney, timeAgo } from "@/lib/format";
import { IconListTree } from "@/components/icons";
import { callApi, postApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";
import { AppFrame } from "../_shell/app-frame";

type Tab = "overview" | "requests" | "orders" | "bills" | "vendors";

interface PoLine {
  lineNumber: number;
  description: string;
  quantity: number;
  unitPriceMinor: number;
}
interface PurchaseOrder {
  id: string;
  number: number;
  vendorName: string;
  status: string;
  memo: string | null;
  orderedMinor: number;
  lines: PoLine[];
}
interface Bill {
  number: number;
  vendorName: string;
  vendorRef: string | null;
  memo: string | null;
  totalMinor: number;
  paidMinor: number;
  dueMinor: number;
  createdAt: string;
}
interface Vendor {
  id: string;
  name: string;
  email?: string | null;
}
interface Aging {
  buckets?: {
    current: number;
    d30: number;
    d60: number;
    d90plus: number;
    totalOutstanding: number;
  };
}
interface Product {
  sku: string;
  name: string;
  avgUnitCostMinor?: number;
}
interface Payload {
  vendors?: Vendor[];
  orders?: PurchaseOrder[];
  bills?: Bill[];
  apAging?: Aging;
  requests?: PurchaseRequest[];
}
interface RfqBid {
  id: string;
  vendorName: string;
  status: string; // sent | quoted | won | lost
  quoteAmountMinor: number | null;
  quoteLeadTimeDays: number | null;
  quoteNotes?: string | null;
}
interface PurchaseRequest {
  id: string;
  title: string;
  justification: string;
  estimatedAmountMinor: number | null;
  status: string; // pending_review | approved | rejected | converted
  decisionReason?: string | null;
  createdAt: string;
  rfqs: RfqBid[];
}
const qty = (t: number) => (t / 1000).toFixed(3);

export default function PurchasingPage() {
  const enabled = useModuleEnabled("purchasing");
  const [data, setData] = useState<Payload | null>(null);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");

  const [vendorForm, setVendorForm] = useState({ name: "", email: "" });
  const [poForm, setPoForm] = useState({
    vendorId: "",
    memo: "",
    lines: [{ description: "", quantity: "1", unitPrice: "0.00", sku: "" }],
  });
  const [receipts, setReceipts] = useState<Record<string, string>>({});
  const [billForm, setBillForm] = useState({
    vendorId: "",
    vendorRef: "",
    poNumber: "",
    lines: [{ description: "", quantity: "1", unitPrice: "0.00", poLineNumber: "" }],
  });
  const [payAmount, setPayAmount] = useState<Record<string, string>>({});
  const [products, setProducts] = useState<Product[]>([]);
  const [quickVendor, setQuickVendor] = useState<{ open: boolean; name: string; email: string }>({
    open: false,
    name: "",
    email: "",
  });
  const [requestForm, setRequestForm] = useState({ title: "", justification: "", estimate: "" });
  const [rfqPick, setRfqPick] = useState<Record<string, string[]>>({});
  const [quoteDraft, setQuoteDraft] = useState<Record<string, { amount: string; leadTime: string }>>({});

  const load = useCallback(async () => {
    const [res, inv] = await Promise.all([callApi<Payload>("/api/purchasing"), callApi<{ items?: Product[] }>("/api/inventory")]);
    setData(res.data ?? {});
    setProducts(inv.data?.items ?? []);
    if (res.error) setNotice({ tone: "error", error: res.error });
  }, []);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  const post = useCallback(
    async (body: Record<string, unknown>, label: string): Promise<boolean> => {
      setBusy(true);
      try {
        const res = await postApi("/api/purchasing", body);
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

  if (!enabled) return <ModuleDisabled label="Purchasing (Procurement)" />;
  if (!data) return <LoadingPage />;

  const vendors = data.vendors ?? [];
  const orders = data.orders ?? [];
  const bills = data.bills ?? [];
  const requests = data.requests ?? [];

  return (
    <AppFrame
      appId="purchasing"
      description="Vendors, purchase orders, receipts, bills, and payments — with three-way matching"
      persistKey="purchasing"
      tabs={[
        { id: "overview", label: "Overview" },
        { id: "requests", label: "Requests & RFQs", count: requests.filter((r) => r.status === "pending_review").length || undefined },
        { id: "orders", label: "Orders", count: orders.filter((o) => o.status === "approved").length || undefined },
        { id: "bills", label: "Bills & payments" },
        { id: "vendors", label: "Vendors", count: vendors.length || undefined },
      ]}
      activeTab={tab}
      onTabChange={(id) => setTab(id as Tab)}
    >
      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}

      {tab === "overview" && (
        <PurchasingOverview data={data} goTo={(t) => setTab(t)} />
      )}

      {tab === "requests" && (
        <>
          <Card>
            <CardTitle>Raise a purchase request</CardTitle>
            <div className="space-y-2 text-sm">
              <div className="flex flex-wrap gap-2">
                <input
                  className="min-w-48 flex-1 rounded border bg-transparent px-2 py-1.5"
                  placeholder="What needs buying? e.g. Packaging supplies for Q4"
                  value={requestForm.title}
                  onChange={(e) => setRequestForm({ ...requestForm, title: e.target.value })}
                />
                <input
                  className="w-32 rounded border bg-transparent px-2 py-1.5"
                  placeholder="Estimate (opt.)"
                  value={requestForm.estimate}
                  onChange={(e) => setRequestForm({ ...requestForm, estimate: e.target.value })}
                />
              </div>
              <textarea
                className="textarea min-h-16 w-full py-2 text-sm"
                rows={2}
                placeholder="Justify it for the reviewer: why now, from whom, what changes if it is declined…"
                value={requestForm.justification}
                onChange={(e) => setRequestForm({ ...requestForm, justification: e.target.value })}
              />
              <div className="flex items-center gap-3">
                <Button
                  disabled={
                    busy ||
                    requestForm.title.trim().length < 3 ||
                    requestForm.justification.trim().length < 10
                  }
                  onClick={() =>
                    void post(
                      {
                        action: "createPurchaseRequest",
                        title: requestForm.title.trim(),
                        justification: requestForm.justification.trim(),
                        estimatedAmountMinor: Math.round(Number(requestForm.estimate || "0") * 100) || undefined,
                      },
                      "Purchase request raised",
                    ).then((ok) => ok && setRequestForm({ title: "", justification: "", estimate: "" }))
                  }
                >
                  Submit request
                </Button>
                <span className="text-xs opacity-50">
                  Requests wait for a reviewer. Approved ones go out as RFQs; the winning bid becomes a purchase order.
                </span>
              </div>
            </div>
          </Card>

          {(data.requests ?? []).length === 0 ? (
            <EmptyState
              icon={<IconListTree />}
              title="No purchase requests yet"
              hint="Raise one above — or ask the workmate — to start the request → approval → quotes → order flow."
            />
          ) : (
            (data.requests ?? []).map((r) => {
              const picked = rfqPick[r.id] ?? [];
              return (
                <Card key={r.id}>
                  <CardTitle
                    right={
                      <Badge
                        tone={
                          r.status === "approved" || r.status === "converted"
                            ? "green"
                            : r.status === "rejected"
                              ? "red"
                              : r.status === "converted"
                                ? "violet"
                                : "amber"
                        }
                      >
                        {r.status.replace("_", " ")}
                      </Badge>
                    }
                  >
                    {r.title}
                  </CardTitle>
                  <p className="mb-1 text-xs opacity-60">{r.justification}</p>
                  {r.estimatedAmountMinor != null && (
                    <p className="mb-1 text-xs opacity-60">Estimated {formatMoney(r.estimatedAmountMinor)}</p>
                  )}
                  {r.decisionReason && <p className="mb-1 text-xs italic opacity-50">“{r.decisionReason}”</p>}

                  {r.status === "pending_review" && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Button size="sm" disabled={busy} onClick={() => void post({ action: "decidePurchaseRequest", requestId: r.id, decision: "approve" }, "Request approved")}>
                        Approve
                      </Button>
                      <Button size="sm" tone="dangerSecondary" disabled={busy} onClick={() => void post({ action: "decidePurchaseRequest", requestId: r.id, decision: "reject", reason: window.prompt("Reason for rejection (optional)") || undefined }, "Request rejected")}>
                        Reject
                      </Button>
                    </div>
                  )}

                  {r.status === "approved" && (
                    <div className="mt-3 space-y-2 border-t pt-3 text-sm">
                      <p className="text-xs font-medium uppercase tracking-wide opacity-50">Send RFQs to vendors</p>
                      {vendors.length === 0 ? (
                        <p className="text-xs opacity-60">No vendors yet — add them in the Vendors tab first.</p>
                      ) : (
                        <>
                          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                            {vendors.map((v) => (
                              <label key={v.id} className="flex cursor-pointer items-center gap-1.5 text-sm">
                                <input
                                  type="checkbox"
                                  checked={picked.includes(v.id)}
                                  onChange={(e) =>
                                    setRfqPick({
                                      ...rfqPick,
                                      [r.id]: e.target.checked ? [...picked, v.id] : picked.filter((x) => x !== v.id),
                                    })
                                  }
                                  className="accent-maroon-700"
                                />
                                {v.name}
                              </label>
                            ))}
                          </div>
                          <Button
                            size="sm"
                            disabled={busy || picked.length === 0}
                            onClick={() => void post({ action: "createRfq", requestId: r.id, vendorIds: picked }, `RFQs sent to ${picked.length} vendor(s)`)}
                          >
                            Send RFQs ({picked.length})
                          </Button>
                        </>
                      )}
                    </div>
                  )}

                  {(r.status === "approved" || r.status === "converted") && r.rfqs.length > 0 && (
                    <table className="mt-3 w-full text-sm">
                      <thead>
                        <tr className="text-left opacity-50">
                          <th>Vendor</th>
                          <th>Bid status</th>
                          <th className="text-right">Quote</th>
                          <th className="text-right">Lead time</th>
                          <th className="text-right">Record quote / award</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.rfqs.map((f) => {
                          const draft = quoteDraft[f.id] ?? { amount: "", leadTime: "" };
                          return (
                            <tr key={f.id} className="border-t">
                              <td className="py-1.5">{f.vendorName}</td>
                              <td>
                                <Badge tone={f.status === "won" ? "green" : f.status === "quoted" ? "blue" : f.status === "lost" ? "neutral" : "amber"}>
                                  {f.status}
                                </Badge>
                              </td>
                              <td className="text-right tabular-nums">{f.quoteAmountMinor != null ? formatMoney(f.quoteAmountMinor) : "—"}</td>
                              <td className="text-right tabular-nums">{f.quoteLeadTimeDays != null ? `${f.quoteLeadTimeDays}d` : "—"}</td>
                              <td>
                                {f.status === "sent" && (
                                  <span className="flex items-center justify-end gap-1">
                                    <input
                                      className="w-20 rounded border bg-transparent px-1 py-0.5 text-right"
                                      placeholder="Quote"
                                      value={draft.amount}
                                      onChange={(e) => setQuoteDraft({ ...quoteDraft, [f.id]: { ...draft, amount: e.target.value } })}
                                    />
                                    <input
                                      className="w-12 rounded border bg-transparent px-1 py-0.5 text-right"
                                      placeholder="Days"
                                      value={draft.leadTime}
                                      onChange={(e) => setQuoteDraft({ ...quoteDraft, [f.id]: { ...draft, leadTime: e.target.value } })}
                                    />
                                    <Button
                                      size="sm"
                                      disabled={busy || !Number(draft.amount)}
                                      onClick={() => {
                                        void post(
                                          {
                                            action: "recordQuote",
                                            rfqId: f.id,
                                            amountMinor: Math.round(Number(draft.amount || "0") * 100),
                                            leadTimeDays: Number(draft.leadTime || "0") || undefined,
                                          },
                                          `Quote recorded for ${f.vendorName}`,
                                        ).then((ok) => ok && setQuoteDraft((q) => ({ ...q, [f.id]: { amount: "", leadTime: "" } })));
                                      }}
                                    >
                                      Save
                                    </Button>
                                  </span>
                                )}
                                {f.status === "quoted" && r.status === "approved" && (
                                  <Button
                                    size="sm"
                                    tone="primary"
                                    disabled={busy}
                                    onClick={() =>
                                      void post(
                                        { action: "selectWinningQuote", rfqId: f.id },
                                        `${f.vendorName} awarded — purchase order raised`,
                                      )
                                    }
                                  >
                                    Award & raise PO
                                  </Button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </Card>
              );
            })
          )}
        </>
      )}

      {tab === "orders" && (
        <Card>
          <CardTitle>Draft purchase order</CardTitle>
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="rounded border bg-transparent px-2 py-1.5"
                value={poForm.vendorId}
                onChange={(e) => setPoForm({ ...poForm, vendorId: e.target.value })}
              >
                <option value="">Vendor…</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
              {vendors.length === 0 && !quickVendor.open && (
                <span className="text-xs text-stone-500">
                  No vendors yet —
                  <button type="button" className="ml-1 font-medium text-maroon-700 underline underline-offset-2" onClick={() => setQuickVendor({ open: true, name: "", email: "" })}>
                    create one here
                  </button>
                </span>
              )}
              {vendors.length > 0 && (
                <Button tone="ghost" size="sm" onClick={() => setQuickVendor({ open: !quickVendor.open, name: "", email: "" })}>
                  + New vendor
                </Button>
              )}
              <input
                className="min-w-40 flex-1 rounded border bg-transparent px-2 py-1.5"
                placeholder="Memo (optional)"
                value={poForm.memo}
                onChange={(e) => setPoForm({ ...poForm, memo: e.target.value })}
              />
            </div>
            {quickVendor.open && (
              <div className="flex flex-wrap items-center gap-2 rounded border border-stone-200 bg-stone-50 p-2">
                <input
                  className="flex-1 rounded border bg-transparent px-2 py-1.5"
                  placeholder="Vendor name"
                  value={quickVendor.name}
                  onChange={(e) => setQuickVendor({ ...quickVendor, name: e.target.value })}
                />
                <input
                  className="w-48 rounded border bg-transparent px-2 py-1.5"
                  placeholder="Email (optional)"
                  value={quickVendor.email}
                  onChange={(e) => setQuickVendor({ ...quickVendor, email: e.target.value })}
                />
                <Button
                  size="sm"
                  disabled={busy || !quickVendor.name.trim()}
                  onClick={() => {
                    void post({ action: "createVendor", name: quickVendor.name.trim(), email: quickVendor.email || undefined }, "Vendor created").then((ok) => {
                      if (ok) setQuickVendor({ open: false, name: "", email: "" });
                    });
                  }}
                >
                  Save & use
                </Button>
              </div>
            )}
            {poForm.lines.map((l, i) => (
              <div key={i} className="flex flex-wrap gap-2">
                <select
                  className="w-44 rounded border bg-transparent px-2 py-1.5"
                  title="Pick a stocked product to fill this line"
                  value={products.some((p) => p.sku === l.sku) ? l.sku : ""}
                  onChange={(e) => {
                    const p = products.find((x) => x.sku === e.target.value);
                    if (!p) return;
                    const next = [...poForm.lines];
                    next[i] = {
                      ...l,
                      description: l.description || p.name,
                      sku: p.sku,
                      unitPrice: p.avgUnitCostMinor != null ? (p.avgUnitCostMinor / 100).toFixed(2) : l.unitPrice,
                    };
                    setPoForm({ ...poForm, lines: next });
                  }}
                >
                  <option value="">{products.length ? "Product…" : "No products yet"}</option>
                  {products.map((p) => (
                    <option key={p.sku} value={p.sku}>{p.name} · {p.sku}</option>
                  ))}
                </select>
                <input
                  className="flex-1 rounded border bg-transparent px-2 py-1.5"
                  placeholder={`Line ${i + 1} description`}
                  value={l.description}
                  onChange={(e) => {
                    const next = [...poForm.lines];
                    next[i] = { ...l, description: e.target.value };
                    setPoForm({ ...poForm, lines: next });
                  }}
                />
                <input
                  className="w-20 rounded border bg-transparent px-2 py-1.5"
                  placeholder="Qty"
                  value={l.quantity}
                  onChange={(e) => {
                    const next = [...poForm.lines];
                    next[i] = { ...l, quantity: e.target.value };
                    setPoForm({ ...poForm, lines: next });
                  }}
                />
                <input
                  className="w-24 rounded border bg-transparent px-2 py-1.5"
                  placeholder="Unit price"
                  value={l.unitPrice}
                  onChange={(e) => {
                    const next = [...poForm.lines];
                    next[i] = { ...l, unitPrice: e.target.value };
                    setPoForm({ ...poForm, lines: next });
                  }}
                />
                <input
                  className="w-24 rounded border bg-transparent px-2 py-1.5 font-mono"
                  placeholder="SKU (opt.)"
                  title="Links the line to a stocked item so receipts update stock"
                  value={l.sku}
                  onChange={(e) => {
                    const next = [...poForm.lines];
                    next[i] = { ...l, sku: e.target.value.toUpperCase() };
                    setPoForm({ ...poForm, lines: next });
                  }}
                />
                <button
                  type="button"
                  aria-label={`Remove line ${i + 1}`}
                  title="Remove line"
                  disabled={poForm.lines.length === 1}
                  className="rounded px-2 py-1.5 text-stone-400 transition-colors hover:bg-red-50 hover:text-red-700 disabled:pointer-events-none disabled:opacity-30"
                  onClick={() => setPoForm({ ...poForm, lines: poForm.lines.filter((_, j) => j !== i) })}
                >
                  ✕
                </button>
              </div>
            ))}
            <div className="flex gap-2">
              <Button
                tone="ghost"
                size="sm"
                onClick={() =>
                  setPoForm({
                    ...poForm,
                    lines: [...poForm.lines, { description: "", quantity: "1", unitPrice: "0.00", sku: "" }],
                  })
                }
              >
                + Line
              </Button>
              <Button
                disabled={busy || !poForm.vendorId || poForm.lines.some((l) => !l.description)}
                onClick={() => {
                  const lines = poForm.lines.map((l) => ({
                    description: l.description,
                    quantity: Math.round(Number(l.quantity || "0") * 1000),
                    unitPriceMinor: Math.round(Number(l.unitPrice || "0") * 100),
                    sku: l.sku || undefined,
                  }));
                  void post({ action: "createPurchaseOrder", vendorId: poForm.vendorId, memo: poForm.memo, lines }, "Draft order").then((ok) => {
                    if (ok)
                      setPoForm({ vendorId: "", memo: "", lines: [{ description: "", quantity: "1", unitPrice: "0.00", sku: "" }] });
                  });
                }}
              >
                Create order
              </Button>
            </div>
          </div>
        </Card>
      )}


      {tab === "orders" && (
        <>
          {orders.length === 0 ? (
            <EmptyState icon={<IconListTree />} title="No purchase orders yet" hint="Draft one above; receipts against it feed three-way matching on bills." />
          ) : (
            orders.map((o) => (
              <Card key={o.id}>
                <CardTitle
                  right={
                    <Badge tone={o.status === "received" ? "green" : o.status === "closed" ? "neutral" : o.status === "void" ? "red" : "blue"}>
                      {o.status}
                    </Badge>
                  }
                >
                  PO #{o.number} — {o.vendorName}
                </CardTitle>
                <p className="mb-2 text-xs opacity-60">
                  Ordered {formatMoney(o.orderedMinor)}
                  {o.memo ? ` · ${o.memo}` : ""}
                </p>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left opacity-50">
                      <th>#</th>
                      <th>Description</th>
                      <th className="text-right">Qty</th>
                      <th className="text-right">Unit price</th>
                      <th className="text-right">Receive qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {o.lines.map((l) => (
                      <tr key={l.lineNumber} className="border-t">
                        <td className="py-1">{l.lineNumber}</td>
                        <td>{l.description}</td>
                        <td className="text-right tabular-nums">{qty(l.quantity)}</td>
                        <td className="text-right tabular-nums">{formatMoney(l.unitPriceMinor)}</td>
                        <td className="text-right">
                          {(o.status === "ordered" || o.status === "partial") && (
                            <input
                              className="w-16 rounded border bg-transparent px-1 py-0.5 text-right"
                              placeholder={qty(l.quantity)}
                              value={receipts[`${o.id}:${l.lineNumber}`] ?? ""}
                              onChange={(e) => setReceipts({ ...receipts, [`${o.id}:${l.lineNumber}`]: e.target.value })}
                            />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(o.status === "ordered" || o.status === "partial") && (
                  <div className="mt-2 flex justify-end">
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        const lines = o.lines
                          .map((l) => ({
                            lineNumber: l.lineNumber,
                            quantity: Math.round(Number(receipts[`${o.id}:${l.lineNumber}`] || "0") * 1000),
                          }))
                          .filter((l) => l.quantity > 0);
                        if (!lines.length) return;
                        void post({ action: "receiveGoods", poNumber: o.number, lines }, "Receive goods");
                      }}
                    >
                      Record receipt
                    </Button>
                  </div>
                )}
              </Card>
            ))
          )}
        </>
      )}


      {tab === "bills" && (
        <>
          <Card>
            <CardTitle>Record vendor bill</CardTitle>
            <div className="space-y-2 text-sm">
              <div className="flex flex-wrap gap-2">
                <select
                  className="rounded border bg-transparent px-2 py-1.5"
                  value={billForm.vendorId}
                  onChange={(e) => setBillForm({ ...billForm, vendorId: e.target.value })}
                >
                  <option value="">Vendor…</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </select>
                <input
                  className="w-32 rounded border bg-transparent px-2 py-1.5"
                  placeholder="Their ref #"
                  value={billForm.vendorRef}
                  onChange={(e) => setBillForm({ ...billForm, vendorRef: e.target.value })}
                />
                <input
                  className="w-28 rounded border bg-transparent px-2 py-1.5"
                  placeholder="PO # (match)"
                  title="When set, every line must reference a PO line number and passes three-way matching"
                  value={billForm.poNumber}
                  onChange={(e) => setBillForm({ ...billForm, poNumber: e.target.value })}
                />
              </div>
              {billForm.lines.map((l, i) => (
                <div key={i} className="flex flex-wrap gap-2">
                  <input
                    className="flex-1 rounded border bg-transparent px-2 py-1.5"
                    placeholder={`Line ${i + 1} description`}
                    value={l.description}
                    onChange={(e) => {
                      const next = [...billForm.lines];
                      next[i] = { ...l, description: e.target.value };
                      setBillForm({ ...billForm, lines: next });
                    }}
                  />
                  <input
                    className="w-20 rounded border bg-transparent px-2 py-1.5"
                    placeholder="Qty"
                    value={l.quantity}
                    onChange={(e) => {
                      const next = [...billForm.lines];
                      next[i] = { ...l, quantity: e.target.value };
                      setBillForm({ ...billForm, lines: next });
                    }}
                  />
                  <input
                    className="w-24 rounded border bg-transparent px-2 py-1.5"
                    placeholder="Unit price"
                    value={l.unitPrice}
                    onChange={(e) => {
                      const next = [...billForm.lines];
                      next[i] = { ...l, unitPrice: e.target.value };
                      setBillForm({ ...billForm, lines: next });
                    }}
                  />
                  {billForm.poNumber && (
                    <input
                      className="w-20 rounded border bg-transparent px-2 py-1.5"
                      placeholder="PO line #"
                      value={l.poLineNumber}
                      onChange={(e) => {
                        const next = [...billForm.lines];
                        next[i] = { ...l, poLineNumber: e.target.value };
                        setBillForm({ ...billForm, lines: next });
                      }}
                    />
                  )}
                </div>
              ))}
              <Button
                disabled={busy || !billForm.vendorId || billForm.lines.some((l) => !l.description)}
                onClick={() => {
                  const hasPo = Boolean(billForm.poNumber);
                  const lines = billForm.lines.map((l) => ({
                    description: l.description,
                    quantity: Math.round(Number(l.quantity || "0") * 1000),
                    unitPriceMinor: Math.round(Number(l.unitPrice || "0") * 100),
                    poLineNumber: hasPo ? Number(l.poLineNumber || "0") || undefined : undefined,
                  }));
                  void post(
                    {
                      action: "createBill",
                      vendorId: billForm.vendorId,
                      vendorRef: billForm.vendorRef || undefined,
                      poNumber: hasPo ? Number(billForm.poNumber) : undefined,
                      lines,
                    },
                    "Record bill",
                  ).then((ok) => {
                    if (ok)
                      setBillForm({ vendorId: "", vendorRef: "", poNumber: "", lines: [{ description: "", quantity: "1", unitPrice: "0.00", poLineNumber: "" }] });
                  });
                }}
              >
                Record bill
              </Button>
              <p className="text-xs opacity-50">
                Bills matched to a purchase order pass three-way matching (ordered vs received vs billed) before posting.
              </p>
            </div>
          </Card>

          <Card>
            <CardTitle>Accounts payable aging</CardTitle>
            <div className="flex flex-wrap gap-4 text-sm">
              {data.apAging?.buckets ? (
                <>
                  <div>
                    <div className="opacity-50">Current</div>
                    <div className="font-medium tabular-nums">{formatMoney(data.apAging.buckets.current)}</div>
                  </div>
                  <div>
                    <div className="opacity-50">31–60 days</div>
                    <div className="font-medium tabular-nums">{formatMoney(data.apAging.buckets.d30)}</div>
                  </div>
                  <div>
                    <div className="opacity-50">61–90 days</div>
                    <div className="font-medium tabular-nums">{formatMoney(data.apAging.buckets.d60)}</div>
                  </div>
                  <div>
                    <div className="opacity-50">90+ days</div>
                    <div className="font-medium tabular-nums">{formatMoney(data.apAging.buckets.d90plus)}</div>
                  </div>
                  <div>
                    <div className="opacity-50">Total outstanding</div>
                    <div className="font-semibold tabular-nums">{formatMoney(data.apAging.buckets.totalOutstanding)}</div>
                  </div>
                </>
              ) : (
                <div className="opacity-50">No outstanding bills.</div>
              )}
            </div>
          </Card>

          {bills.length === 0 ? (
            <EmptyState
              icon={<IconListTree />}
              title="No bills recorded"
              hint="Record supplier invoices through the agent, optionally matched to a purchase order; they appear here with balances."
            />
          ) : (
            <Card>
              <CardTitle>Bills</CardTitle>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left opacity-50">
                    <th>Bill</th>
                    <th>Vendor</th>
                    <th className="text-right">Total</th>
                    <th className="text-right">Paid</th>
                    <th className="text-right">Due</th>
                    <th className="text-right">Pay amount</th>
                  </tr>
                </thead>
                <tbody>
                  {bills.map((b) => (
                    <tr key={b.number} className="border-t">
                      <td className="whitespace-nowrap py-1.5 opacity-70">#{b.number}</td>
                      <td>{b.vendorName}</td>
                      <td className="text-right tabular-nums">{formatMoney(b.totalMinor)}</td>
                      <td className="text-right tabular-nums">{formatMoney(b.paidMinor)}</td>
                      <td className="text-right font-medium tabular-nums">{formatMoney(b.dueMinor)}</td>
                      <td className="text-right">
                        {b.dueMinor > 0 ? (
                          <span className="inline-flex items-center gap-1">
                            <input
                              className="w-20 rounded border bg-transparent px-1 py-0.5 text-right"
                              placeholder={(b.dueMinor / 100).toFixed(2)}
                              value={payAmount[String(b.number)] ?? ""}
                              onChange={(e) => setPayAmount({ ...payAmount, [String(b.number)]: e.target.value })}
                            />
                            <Button
                              size="sm"
                              disabled={busy || !Number(payAmount[String(b.number)])}
                              onClick={() =>
                                void post(
                                  {
                                    action: "payBill",
                                    billNumber: b.number,
                                    amountMinor: Math.round(Number(payAmount[String(b.number)] || "0") * 100),
                                  },
                                  `Payment on #${b.number}`,
                                ).then((ok) => ok && setPayAmount((p) => ({ ...p, [String(b.number)]: "" })))
                              }
                            >
                              Pay
                            </Button>
                          </span>
                        ) : (
                          <Badge tone="green">paid</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs opacity-50">
                Payments above the policy threshold are gated and wait in the Approvals inbox.
              </p>
            </Card>
          )}
        </>
      )}


      {tab === "vendors" && (
        <>
          <Card>
            <CardTitle>Add vendor</CardTitle>
            <div className="flex flex-wrap gap-2 text-sm">
              <input
                className="flex-1 rounded border bg-transparent px-2 py-1.5"
                placeholder="Name"
                value={vendorForm.name}
                onChange={(e) => setVendorForm({ ...vendorForm, name: e.target.value })}
              />
              <input
                className="flex-1 rounded border bg-transparent px-2 py-1.5"
                placeholder="Email (optional)"
                value={vendorForm.email}
                onChange={(e) => setVendorForm({ ...vendorForm, email: e.target.value })}
              />
              <Button
                disabled={busy || !vendorForm.name}
                onClick={() =>
                  void post(
                    { action: "createVendor", name: vendorForm.name, email: vendorForm.email || undefined },
                    `Add ${vendorForm.name}`,
                  ).then((ok) => ok && setVendorForm({ name: "", email: "" }))
                }
              >
                Add vendor
              </Button>
            </div>
          </Card>
          <Card>
            <CardTitle>Vendors</CardTitle>
            {vendors.length === 0 ? (
              <EmptyState icon={<IconListTree />} title="No vendors yet" hint="Add the suppliers you buy from; orders and bills reference them." />
            ) : (
              <ul className="divide-y text-sm">
                {vendors.map((v) => (
                  <li key={v.id} className="flex items-center justify-between py-1.5">
                    <span>{v.name}</span>
                    {v.email ? <span className="opacity-50">{v.email}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </AppFrame>
  );
}

/* -------------------------------------------------------------- overview --- */

function PurchasingOverview({ data, goTo }: { data: Payload; goTo: (tab: Tab) => void }) {
  const orders = data.orders ?? [];
  const bills = data.bills ?? [];
  const requests = data.requests ?? [];
  const vendors = data.vendors ?? [];

  const openOrders = orders.filter((o) => o.status === "approved");
  const openValue = openOrders.reduce((s, o) => s + o.orderedMinor, 0);
  const pendingRequests = requests.filter((r) => r.status === "pending_review");
  const outstanding = data.apAging?.buckets?.totalOutstanding ?? 0;
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const spendThisMonth = bills
    .filter((b) => new Date(b.createdAt).getTime() >= monthStart.getTime())
    .reduce((s, b) => s + b.totalMinor, 0);
  const dueBills = bills.filter((b) => b.dueMinor > 0);

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Open POs" value={openOrders.length} sub={openValue > 0 ? formatMoney(openValue) : undefined} />
        <StatCard
          label="Requests pending"
          value={pendingRequests.length}
          tone={pendingRequests.length > 0 ? "warn" : "default"}
        />
        <StatCard label="Spend this month" value={formatMoney(spendThisMonth)} />
        <StatCard label="Payables outstanding" value={formatMoney(outstanding)} />
        <StatCard label="Vendors" value={vendors.length} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle
            right={
              pendingRequests.length > 0 ? (
                <Button tone="ghost" onClick={() => goTo("requests")}>
                  Review requests →
                </Button>
              ) : undefined
            }
          >
            Decisions waiting on you
          </CardTitle>
          {pendingRequests.length === 0 ? (
            <EmptyState icon={<IconListTree />} title="No requests pending" hint="Purchase requests land here for review." />
          ) : (
            <ul className="divide-y text-sm">
              {pendingRequests.slice(0, 5).map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{r.title}</span>
                    <span className="text-xs opacity-50">
                      raised {timeAgo(r.createdAt)}
                      {r.estimatedAmountMinor ? ` · est. ${formatMoney(r.estimatedAmountMinor)}` : ""}
                    </span>
                  </span>
                  <Badge tone="amber">pending</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardTitle
            right={
              dueBills.length > 0 ? (
                <Button tone="ghost" onClick={() => goTo("bills")}>
                  Bills & payments →
                </Button>
              ) : undefined
            }
          >
            Bills to pay
          </CardTitle>
          {dueBills.length === 0 ? (
            <p className="text-sm opacity-60">Nothing due — vendors are current.</p>
          ) : (
            <ul className="divide-y text-sm">
              {dueBills.slice(0, 5).map((b) => (
                <li key={b.number} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate">
                      Bill #{b.number} · {b.vendorName}
                    </span>
                    <span className="text-xs opacity-50">raised {timeAgo(b.createdAt)}</span>
                  </span>
                  <span className="tnum shrink-0 font-medium">{formatMoney(b.dueMinor)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

