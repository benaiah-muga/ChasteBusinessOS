"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ActionNotice,
  Badge,
  Button,
  Card,
  CardTitle,
  EmptyState,
  type ActionNoticeState,
} from "@/components/ui";
import { callApi, postApi } from "@/lib/api";
import { IconListTree } from "@/components/icons";
import { pilotBegin, record } from "@/lib/pilot-metrics";
import { ModuleDisabled, useModuleEnabled } from "../../_shell/module-context";
import { AppFrame } from "../../_shell/app-frame";

/**
 * P05 - the receiving desk for the person holding the delivery: find the
 * order, enter per line what arrived (accepted / rejected with a reason),
 * and finish with what was added, refused and still expected. Every number
 * goes through the governed receiving capability; partial work survives
 * reloads because lines are re-enterable and receipts are append-only.
 */

interface OrderLine {
  lineNumber: number;
  description: string;
  quantity: number;
  unitPriceMinor: number;
}
interface Order {
  id: string;
  number: number;
  vendorName: string;
  status: string;
  lines: OrderLine[];
}

interface ReceiptLine {
  position: number;
  description: string;
  acceptedThousandths: number;
  rejectedThousandths: number;
  returnedThousandths: number;
  rejectionNote: string | null;
}
interface Receipt {
  number: number;
  receivedAt: string;
  note: string | null;
  lines: ReceiptLine[];
}
interface OrderLineRollup {
  position: number;
  description: string;
  orderedThousandths: number;
  acceptedThousandths: number;
  rejectedThousandths: number;
  returnedThousandths: number;
  remainingThousandths: number;
}
interface ReceiptDetail {
  receipts: Receipt[];
  orderLines: OrderLineRollup[];
}

interface DraftLine {
  accepted: string;
  rejected: string;
  rejectionNote: string;
}

const fmt = (thousandths: number) => (thousandths / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 });

export default function ReceivingDeskPage() {
  const enabled = useModuleEnabled("purchasing");
  const [poNumber, setPoNumber] = useState("");
  const [order, setOrder] = useState<Order | null>(null);
  const [detail, setDetail] = useState<ReceiptDetail | null>(null);
  const [draft, setDraft] = useState<Record<number, DraftLine>>({});
  const [tolerance, setTolerance] = useState("");
  const [authority, setAuthority] = useState("");
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const [lastReceipt, setLastReceipt] = useState<{ number: number; fullyReceived: boolean } | null>(null);

  useEffect(() => {
    pilotBegin("receiving");
    const requested = new URLSearchParams(window.location.search).get("poNumber");
    if (requested) setPoNumber(requested);
  }, []);

  const loadDetail = useCallback(
    async (number: string) => {
      const res = await postApi<{ receipts: Receipt[]; orderLines: OrderLineRollup[] }>("/api/purchasing", {
        action: "receiptDetail",
        poNumber: Number(number),
      });
      return res.ok ? (res.data as ReceiptDetail) : null;
    },
    [],
  );

  const findOrder = useCallback(async () => {
    const number = poNumber.trim();
    if (!number) return;
    setLoading(true);
    setNotice(null);
    setLastReceipt(null);
    const res = await callApi<{ orders: Order[] }>("/api/purchasing");
    if (!res.ok || !res.data) {
      setNotice({ tone: "error", error: res.error ?? { title: "Could not load orders", hint: "Check the connection and try again." } });
      setLoading(false);
      return;
    }
    const found = res.data.orders.find((o) => String(o.number) === number);
    if (!found) {
      setNotice({ tone: "error", error: { title: `No order number ${number}`, hint: "Check the number on the delivery note; it must be one of this team's purchase orders." } });
      setLoading(false);
      return;
    }
    setOrder(found);
    const detail = await loadDetail(number);
    setDetail(detail);
    // Prefill: accept what is still expected, nothing rejected.
    const remainingByPosition = new Map((detail?.orderLines ?? []).map((l) => [l.position, l.remainingThousandths]));
    setDraft(
      Object.fromEntries(
        found.lines.map((l) => [l.lineNumber, { accepted: String(remainingByPosition.get(l.lineNumber) ?? 0), rejected: "0", rejectionNote: "" }]),
      ),
    );
    setLoading(false);
  }, [poNumber, loadDetail]);

  const submit = useCallback(async () => {
    if (!order) return;
    const lines = order.lines
      .map((l) => {
        const d = draft[l.lineNumber] ?? { accepted: "0", rejected: "0", rejectionNote: "" };
        return {
          lineNumber: l.lineNumber,
          quantity: Number(d.accepted) || 0,
          rejected: Number(d.rejected) || 0,
          rejectionNote: d.rejectionNote || undefined,
        };
      })
      .filter((l) => l.quantity > 0 || l.rejected > 0);
    if (lines.length === 0) {
      setNotice({ tone: "error", error: { title: "Nothing to receive", hint: "Enter what arrived on at least one line." } });
      return;
    }
    for (const l of lines) {
      if (l.rejected > 0 && !l.rejectionNote) {
        setNotice({ tone: "error", error: { title: `Line ${l.lineNumber} needs a rejection reason`, hint: "Refused goods must say why; that note is what the supplier sees." } });
        return;
      }
    }
    const body: Record<string, unknown> = { action: "receiveGoods", poNumber: order.number, lines };
    if (Number(tolerance) > 0) {
      body.overreceiptTolerancePct = Number(tolerance);
      body.authorityReason = authority;
    }
    const res = await postApi<{ received: boolean; receiptNumber: number; fullyReceived: boolean }>("/api/purchasing", body);
    if (res.status === 202) {
      setNotice({ tone: "pending", text: "This receiving action is gated; it completes once someone approves it." });
      return;
    }
    if (!res.ok || !res.data?.received) {
      setNotice({ tone: "error", error: res.error ?? { title: "Receiving was refused", hint: "Check quantities against the order; overreceipt needs explicit authority." } });
      return;
    }
    record("first_action", `PO ${order.number}`, "receiving");
    if (res.data.fullyReceived) record("journey_complete", `PO ${order.number} fully received`, "receiving");
    setLastReceipt({ number: res.data.receiptNumber, fullyReceived: res.data.fullyReceived });
    setNotice({
      tone: "success",
      text: `Receipt ${res.data.receiptNumber} recorded. ` + (res.data.fullyReceived
        ? "Everything ordered is now on the books."
        : "Partially received; what is still expected stays visible on the order."),
    });
    setDetail(await loadDetail(String(order.number)));
  }, [order, draft, tolerance, authority, loadDetail]);

  const orderedLineRollup = (position: number): OrderLineRollup | undefined => detail?.orderLines.find((l) => l.position === position);

  if (!enabled) return <ModuleDisabled label="Purchasing (Procurement)" />;

  return (
    <AppFrame appId="purchasing" description="Receiving desk - record what arrived, line by line" persistKey="purchasing-receiving">
      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}
      <Card>
        <CardTitle>Find the order on the delivery note</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="w-40 rounded border bg-transparent px-2 py-1.5 text-sm"
            placeholder="PO number"
            inputMode="numeric"
            value={poNumber}
            onChange={(e) => setPoNumber(e.target.value.replace(/[^0-9]/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && findOrder()}
          />
          <Button onClick={findOrder} disabled={loading}>
            {loading ? "Loading…" : "Open order"}
          </Button>
        </div>
      </Card>

      {order && (
        <Card>
          <CardTitle>
            PO {order.number} · {order.vendorName} <Badge>{order.status}</Badge>
          </CardTitle>
          <div className="space-y-4 text-sm">
            {order.lines.map((l) => {
              const rollup = orderedLineRollup(l.lineNumber);
              const d = draft[l.lineNumber] ?? { accepted: "0", rejected: "0", rejectionNote: "" };
              const rejected = Number(d.rejected) || 0;
              return (
                <div key={l.lineNumber} className="rounded border p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="font-medium">
                      Line {l.lineNumber}: {l.description}
                    </div>
                    <div className="text-xs opacity-70">
                      ordered {fmt(l.quantity)} · accepted so far {fmt(rollup?.acceptedThousandths ?? 0)} · rejected {fmt(rollup?.rejectedThousandths ?? 0)} · outstanding {fmt(rollup?.remainingThousandths ?? 0)}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label className="text-xs opacity-70">
                      accepted
                      <input
                        className="ml-1 w-24 rounded border bg-transparent px-2 py-1"
                        inputMode="numeric"
                        value={d.accepted}
                        onChange={(e) => setDraft({ ...draft, [l.lineNumber]: { ...d, accepted: e.target.value.replace(/[^0-9]/g, "") } })}
                      />
                    </label>
                    <label className="text-xs opacity-70">
                      rejected
                      <input
                        className="ml-1 w-24 rounded border bg-transparent px-2 py-1"
                        inputMode="numeric"
                        value={d.rejected}
                        onChange={(e) => setDraft({ ...draft, [l.lineNumber]: { ...d, rejected: e.target.value.replace(/[^0-9]/g, "") } })}
                      />
                    </label>
                    {rejected > 0 && (
                      <input
                        className="min-w-48 flex-1 rounded border bg-transparent px-2 py-1"
                        placeholder="Why are these refused? (shown to the supplier)"
                        value={d.rejectionNote}
                        onChange={(e) => setDraft({ ...draft, [l.lineNumber]: { ...d, rejectionNote: e.target.value } })}
                      />
                    )}
                  </div>
                </div>
              );
            })}

            <div className="flex flex-wrap items-center gap-2 rounded border border-dashed p-3 text-xs opacity-80">
              <span>Overreceipt tolerance % (optional)</span>
              <input
                className="w-16 rounded border bg-transparent px-2 py-1"
                inputMode="numeric"
                value={tolerance}
                onChange={(e) => setTolerance(e.target.value.replace(/[^0-9]/g, ""))}
              />
              {Number(tolerance) > 0 && (
                <input
                  className="min-w-56 flex-1 rounded border bg-transparent px-2 py-1"
                  placeholder="Who authorized accepting more than ordered?"
                  value={authority}
                  onChange={(e) => setAuthority(e.target.value)}
                />
              )}
            </div>

            <Button onClick={submit}>Record receipt</Button>
          </div>
        </Card>
      )}

      {lastReceipt && (
        <Card>
          <CardTitle>Receipt {lastReceipt.number}</CardTitle>
          <p className="text-sm">
            {lastReceipt.fullyReceived
              ? "Every line is now fully delivered. The order can be matched against the supplier's bill."
              : "Recorded. The outstanding quantity stays on the order until it arrives or the order is closed."}
          </p>
        </Card>
      )}

      {order && detail && detail.receipts.length > 0 && (
        <Card>
          <CardTitle>Receipt history</CardTitle>
          <div className="space-y-3 text-sm">
            {detail.receipts.map((r) => (
              <div key={r.number} className="rounded border p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">Receipt {r.number}</span>
                  <span className="text-xs opacity-70">{new Date(r.receivedAt).toLocaleString()}</span>
                </div>
                {r.note && <div className="text-xs opacity-70">{r.note}</div>}
                <ul className="mt-1 list-disc pl-5">
                  {r.lines.map((l) => (
                    <li key={l.position}>
                      line {l.position}: accepted {fmt(l.acceptedThousandths)}
                      {l.rejectedThousandths > 0 ? `, rejected ${fmt(l.rejectedThousandths)}${l.rejectionNote ? ` (${l.rejectionNote})` : ""}` : ""}
                      {l.returnedThousandths > 0 ? `, returned ${fmt(l.returnedThousandths)}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Card>
      )}

      {order && detail && detail.receipts.length === 0 && (
        <EmptyState icon={<IconListTree />} title="No receipts yet" hint="This order has not been received against; the lines above are what is still expected." />
      )}
    </AppFrame>
  );
}
