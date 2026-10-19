import { useEffect, useRef, useState } from "react";
import { currencyMinorUnits } from "@chaste/erp-core";
import { fetchApprovals, submitApprovalDecision } from "../api/approvals";
import { fetchPurchaseOrder, fetchPurchasingWorkspace, type GoPurchaseOrder } from "../api/purchasing";
import type { ChatProposal } from "../chat-store";
import "./ProposalCard.css";

interface PurchaseProposalLine {
  description: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
}

interface PurchaseProposal {
  vendorName: string;
  currency: string;
  memo: string | null;
  promisedAt: string | null;
  lines: PurchaseProposalLine[];
  totalMinor: number;
  rationale: string;
  status: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; proposal: PurchaseProposal }
  | { status: "missing"; message: string }
  | { status: "error"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function formatMoney(minor: number, currency: string): string {
  const units = currencyMinorUnits(currency) ?? 2;
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      minimumFractionDigits: units,
      maximumFractionDigits: units,
    }).format(minor / 10 ** units);
  } catch {
    return `${(minor / 10 ** units).toFixed(units)} ${currency}`;
  }
}

function formatQuantity(quantity: number): string {
  const units = quantity / 1000;
  return Number.isInteger(units) ? String(units) : units.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function readPurchaseProposal(payload: unknown, currency: string, vendorName: string, rationale: string, status: string): PurchaseProposal | null {
  if (!isRecord(payload)) return null;
  const rawLines = Array.isArray(payload.lines) ? payload.lines : [];
  const lines: PurchaseProposalLine[] = [];
  for (const rawLine of rawLines) {
    if (!isRecord(rawLine)) continue;
    const description = text(rawLine.description);
    const quantity = integer(rawLine.quantity);
    const unitPriceMinor = integer(rawLine.unitPriceMinor);
    if (!description || quantity === null || quantity <= 0 || unitPriceMinor === null || unitPriceMinor < 0) continue;
    lines.push({
      description,
      quantity,
      unitPriceMinor,
      lineTotalMinor: Math.round((quantity * unitPriceMinor) / 1000),
    });
  }
  if (lines.length === 0) return null;
  return {
    vendorName,
    currency,
    memo: text(payload.memo),
    promisedAt: text(payload.promisedAt),
    lines,
    totalMinor: lines.reduce((total, line) => total + line.lineTotalMinor, 0),
    rationale,
    status,
  };
}

function loadErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "The proposal details could not be loaded. Refresh the conversation and try again.";
}

/**
 * The exact approval payload, not the model's prose, is the proposal. The card
 * fetches the stored approval so a renamed or edited line cannot be approved
 * under a different summary.
 */
export function ProposalCard({ proposal, organizationId }: { proposal: ChatProposal; organizationId: string | null }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [decision, setDecision] = useState<"approve" | "reject" | null>(null);
  const [outcome, setOutcome] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [order, setOrder] = useState<GoPurchaseOrder | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const organizationRef = useRef(organizationId);
  organizationRef.current = organizationId;
  const orderRequest = useRef(0);

  useEffect(() => {
    let cancelled = false;
    if (!organizationId) {
      setState({ status: "error", message: "Choose an organization before reviewing this approval." });
      return () => {
        cancelled = true;
      };
    }
    setState({ status: "loading" });
    setOutcome(null);
    setOrder(null);
    setOrderError(null);
    orderRequest.current += 1;
    void (async () => {
      try {
        const inbox = await fetchApprovals(organizationId);
        if (cancelled) return;
        const approval = [...inbox.approvals, ...inbox.history].find((item) => item.id === proposal.approvalId);
        if (!approval) {
          setState({
            status: "missing",
            message: "This approval is no longer pending. Refresh the conversation to see the current record.",
          });
          return;
        }
        // Vendor names and the base currency are presentation details. A
        // purchasing-read failure must not hide the approval itself.
        let workspace: Awaited<ReturnType<typeof fetchPurchasingWorkspace>> | null = null;
        try {
          workspace = await fetchPurchasingWorkspace(organizationId);
        } catch {
          workspace = null;
        }
        if (cancelled) return;
        const payload = isRecord(approval.payload) ? approval.payload : {};
        const vendorId = text(payload.vendorId) ?? "";
        const vendorName = workspace?.vendors.find((vendor) => vendor.id === vendorId)?.name ?? vendorId;
        const parsed = readPurchaseProposal(
          payload,
          workspace?.baseCurrency ?? "USD",
          vendorName || "Supplier",
          approval.rationale ?? proposal.rationale,
          String(approval.status ?? "pending"),
        );
        if (!parsed) {
          setState({
            status: "error",
            message: "The approval payload is not a purchase order this card can review. Open Approvals to inspect it.",
          });
          return;
        }
        setState({ status: "ready", proposal: parsed });
      } catch (error) {
        if (!cancelled) setState({ status: "error", message: loadErrorMessage(error) });
      }
    })();
    return () => {
      cancelled = true;
      orderRequest.current += 1;
    };
  }, [organizationId, proposal.approvalId, proposal.rationale]);

  async function loadOrder(poNumber: number) {
    if (!organizationId) return;
    const organization = organizationId;
    const request = ++orderRequest.current;
    setRefreshing(true);
    setOrderError(null);
    try {
      const next = await fetchPurchaseOrder(poNumber, organization);
      if (request === orderRequest.current && organizationRef.current === organization) setOrder(next);
    } catch (error) {
      if (request === orderRequest.current && organizationRef.current === organization) {
        setOrderError(loadErrorMessage(error));
      }
    } finally {
      if (request === orderRequest.current) setRefreshing(false);
    }
  }

  async function decide(value: "approve" | "reject") {
    if (!organizationId || decision) return;
    setDecision(value);
    setOutcome(null);
    setOrder(null);
    setOrderError(null);
    try {
      const result = await submitApprovalDecision(proposal.approvalId, value, organizationId);
      const data = isRecord(result.result?.data) ? result.result.data : null;
      const poNumber = typeof data?.poNumber === "number" && Number.isSafeInteger(data.poNumber) && data.poNumber > 0 ? data.poNumber : null;
      setOutcome({
        tone: "success",
        message: value === "reject"
          ? "Rejected. No purchase order was created."
          : result.status === "executed"
            ? "Approved and executed. The purchase order is now on record."
            : "Approved. The commitment is waiting for another required decision.",
      });
      if (value === "approve" && poNumber !== null) await loadOrder(poNumber);
    } catch (error) {
      setOutcome({ tone: "error", message: loadErrorMessage(error) });
    } finally {
      setDecision(null);
    }
  }

  if (state.status === "loading") {
    return (
      <section className="chat-proposal" aria-label="Purchase proposal" aria-busy="true">
        <p className="chat-proposal-kicker">Purchase proposal</p>
        <p className="chat-proposal-loading">Loading the exact approval payload…</p>
      </section>
    );
  }
  if (state.status === "missing" || state.status === "error") {
    return (
      <section className="chat-proposal" aria-label="Purchase proposal">
        <p className="chat-proposal-kicker">Purchase proposal</p>
        <p className="chat-proposal-note">{state.message}</p>
      </section>
    );
  }

  const purchase = state.proposal;
  const decided = outcome?.tone === "success";
  return (
    <section className="chat-proposal" aria-label="Purchase proposal">
      <header className="chat-proposal-head">
        <div>
          <p className="chat-proposal-kicker">Purchase proposal</p>
          <h3>{purchase.vendorName}</h3>
        </div>
        <span className="chat-proposal-total">{formatMoney(purchase.totalMinor, purchase.currency)}</span>
      </header>
      <p className="chat-proposal-rationale">{purchase.rationale}</p>
      {purchase.memo && <p className="chat-proposal-memo">{purchase.memo}</p>}
      <div className="chat-proposal-table-wrap">
        <table className="chat-proposal-table">
          <thead>
            <tr>
              <th scope="col">Line</th>
              <th scope="col">Quantity</th>
              <th scope="col">Unit price</th>
              <th scope="col">Total</th>
            </tr>
          </thead>
          <tbody>
            {purchase.lines.map((line, index) => (
              <tr key={`${line.description}-${index}`}>
                <td>{line.description}</td>
                <td>{formatQuantity(line.quantity)}</td>
                <td>{formatMoney(line.unitPriceMinor, purchase.currency)}</td>
                <td>{formatMoney(line.lineTotalMinor, purchase.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {purchase.promisedAt && (
        <p className="chat-proposal-meta">
          Promised delivery: {new Date(purchase.promisedAt).toLocaleDateString()}
        </p>
      )}
      {outcome ? (
        <p className={outcome.tone === "success" ? "chat-proposal-outcome" : "chat-proposal-error"} role="status">
          {outcome.message}
        </p>
      ) : purchase.status === "pending" ? (
        <div className="chat-proposal-actions">
          <button type="button" className="chat-proposal-approve" disabled={decision !== null} onClick={() => void decide("approve")}>
            {decision === "approve" ? "Approving…" : "Approve order"}
          </button>
          <button type="button" className="chat-proposal-reject" disabled={decision !== null} onClick={() => void decide("reject")}>
            {decision === "reject" ? "Rejecting…" : "Reject"}
          </button>
          <a className="chat-proposal-link" href="/purchasing">Open purchasing</a>
        </div>
      ) : (
        <p className="chat-proposal-note">This proposal is {purchase.status}. No further decision is available here.</p>
      )}
      {decided && <a className="chat-proposal-link" href="/purchasing">Open purchasing</a>}
      {order && (
        <section className="chat-proposal-fulfillment" aria-label="Purchase order status">
          <p className="chat-proposal-kicker">Order status</p>
          <p>
            <strong>Order #{order.poNumber}</strong> is {order.status}.{" "}
            {order.fullyReceived
              ? "Received in full."
              : `${formatQuantity(order.lines.reduce((total, line) => total + line.remainingThousandths, 0))} of ${formatQuantity(order.lines.reduce((total, line) => total + line.quantity, 0))} units still outstanding.`}
          </p>
          {order.receipts.length > 0 && (
            <p className="chat-proposal-meta">
              {order.receipts.length} receipt{order.receipts.length === 1 ? "" : "s"} recorded. Latest{" "}
              {new Date(order.receipts[order.receipts.length - 1]!.receivedAt).toLocaleString()}.
            </p>
          )}
          {order.backordered && <p className="chat-proposal-note">Closed with a recorded shortfall.</p>}
          <button type="button" className="chat-proposal-refresh" disabled={refreshing} onClick={() => void loadOrder(order.poNumber)}>
            {refreshing ? "Refreshing…" : "Refresh status"}
          </button>
        </section>
      )}
      {orderError && <p className="chat-proposal-error">{orderError}</p>}
    </section>
  );
}
