import { useEffect, useRef, useState } from "react";
import { currencyMinorUnits } from "@chaste/erp-core";
import { fetchApprovals, submitApprovalDecision, type Approval } from "../api/approvals";
import { fetchOrganizations } from "../api/organizations";
import { fetchPurchaseOrder, fetchPurchasingWorkspace, type GoPurchaseOrder } from "../api/purchasing";
import type { ChatProposal } from "../chat-store";
import { actionTitle, humanizeFieldKey, isRecord, previewFields } from "./approval-payload";
import "./ApprovalCard.css";

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
  | { status: "ready"; approval: Approval; purchase: PurchaseProposal | null }
  | { status: "missing"; message: string }
  | { status: "error"; message: string };

// Only the purchase-order capability has a line-item payload this card can
// render as an order. Every other approval is shown generically, because
// calling a customer creation a purchase proposal is worse than showing less.
const purchaseOrderCapability = "purchasing.createPurchaseOrder";

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

function formatApprovalValue(key: string, value: unknown, currency: string | null): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isSafeInteger(value) && /(amount|total|value|price|minor)/i.test(key)) {
      // Without the workspace currency a symbol would be a guess, so show the
      // stored minor units and let the label carry the convention.
      return currency ? formatMoney(value, currency) : `${value.toLocaleString("en-US")} minor units`;
    }
    return value.toLocaleString("en-US");
  }
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 117)}…` : value;
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (isRecord(value)) return "Details in Approvals";
  return String(value);
}

function loadErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "The approval details could not be loaded. Refresh the conversation and try again.";
}

/**
 * The exact approval payload, not the model's prose, is what the person
 * reviews. A purchase order keeps its line-item view; every other governed
 * action gets a generic card with the same decision path and a link to the
 * full approval.
 */
export function ApprovalCard({ proposal, organizationId }: { proposal: ChatProposal; organizationId: string | null }) {
  const isPurchaseOrder = proposal.capabilityId === purchaseOrderCapability;
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [decision, setDecision] = useState<"approve" | "reject" | null>(null);
  const [outcome, setOutcome] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [order, setOrder] = useState<GoPurchaseOrder | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
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
        const payload = isRecord(approval.payload) ? approval.payload : {};
        const rationale = approval.rationale ?? proposal.rationale;
        if (!isPurchaseOrder) {
          // The base currency only improves how a money field reads. A failure
          // must not hide the approval itself.
          try {
            const organizations = await fetchOrganizations();
            const active = organizations.orgs.find((organization) => organization.id === organizationId);
            if (active) setCurrency(active.baseCurrency);
          } catch {
            // Keep the fallback currency.
          }
          if (cancelled) return;
          setState({ status: "ready", approval: { ...approval, rationale }, purchase: null });
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
        const vendorId = text(payload.vendorId) ?? "";
        const vendorName = workspace?.vendors.find((vendor) => vendor.id === vendorId)?.name ?? vendorId;
        const parsed = readPurchaseProposal(
          payload,
          workspace?.baseCurrency ?? "USD",
          vendorName || "Supplier",
          rationale,
          String(approval.status ?? "pending"),
        );
        setState({ status: "ready", approval: { ...approval, rationale }, purchase: parsed });
      } catch (error) {
        if (!cancelled) setState({ status: "error", message: loadErrorMessage(error) });
      }
    })();
    return () => {
      cancelled = true;
      orderRequest.current += 1;
    };
  }, [organizationId, proposal.approvalId, proposal.rationale, isPurchaseOrder]);

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
    const purchaseOrder = state.status === "ready" && state.purchase !== null;
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
          ? purchaseOrder
            ? "Rejected. No purchase order was created."
            : "Rejected. Nothing was changed."
          : result.status === "executed"
            ? purchaseOrder
              ? "Approved and executed. The purchase order is now on record."
              : "Approved and executed."
            : purchaseOrder
              ? "Approved. The commitment is waiting for another required decision."
              : "Approved. Another required decision is still waiting.",
      });
      if (value === "approve" && purchaseOrder && poNumber !== null) await loadOrder(poNumber);
    } catch (error) {
      setOutcome({ tone: "error", message: loadErrorMessage(error) });
    } finally {
      setDecision(null);
    }
  }

  const label = isPurchaseOrder ? "Purchase proposal" : "Approval required";
  const ariaLabel = isPurchaseOrder ? "Purchase proposal" : "Approval required";

  if (state.status === "loading") {
    return (
      <section className="chat-proposal" aria-label={ariaLabel} aria-busy="true">
        <p className="chat-proposal-kicker">{label}</p>
        <p className="chat-proposal-loading">{isPurchaseOrder ? "Loading the exact approval payload…" : "Loading the stored approval…"}</p>
      </section>
    );
  }
  if (state.status === "missing" || state.status === "error") {
    return (
      <section className="chat-proposal" aria-label={ariaLabel}>
        <p className="chat-proposal-kicker">{label}</p>
        <p className="chat-proposal-note">{state.message}</p>
      </section>
    );
  }

  const approval = state.approval;
  const purchase = state.purchase;
  const decided = outcome?.tone === "success";
  const pending = purchase ? purchase.status === "pending" : String(approval.status ?? "pending") === "pending";

  return (
    <section className="chat-proposal" aria-label={ariaLabel}>
      <header className="chat-proposal-head">
        <div>
          <p className="chat-proposal-kicker">{label}</p>
          <h3>{purchase ? purchase.vendorName : actionTitle(approval.capabilityId || proposal.capabilityId)}</h3>
        </div>
        {purchase ? (
          <span className="chat-proposal-total">{formatMoney(purchase.totalMinor, purchase.currency)}</span>
        ) : approval.riskClass ? (
          <span className="chat-approval-risk">{approval.riskClass} risk</span>
        ) : null}
      </header>
      <p className="chat-proposal-rationale">{approval.rationale ?? proposal.rationale}</p>
      {purchase ? (
        <>
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
        </>
      ) : (
        <ApprovalFields approval={approval} currency={currency} />
      )}
      {outcome ? (
        <p className={outcome.tone === "success" ? "chat-proposal-outcome" : "chat-proposal-error"} role="status">
          {outcome.message}
        </p>
      ) : pending ? (
        <div className="chat-proposal-actions">
          <button type="button" className="chat-proposal-approve" disabled={decision !== null} onClick={() => void decide("approve")}>
            {decision === "approve" ? "Approving…" : purchase ? "Approve order" : "Approve"}
          </button>
          <button type="button" className="chat-proposal-reject" disabled={decision !== null} onClick={() => void decide("reject")}>
            {decision === "reject" ? "Rejecting…" : "Reject"}
          </button>
          <a className="chat-proposal-link" href={purchase ? "/purchasing" : "/approvals"}>
            {purchase ? "Open purchasing" : "Open approvals"}
          </a>
        </div>
      ) : (
        <p className="chat-proposal-note">This approval is {purchase ? purchase.status : approval.status}. No further decision is available here.</p>
      )}
      {decided && (
        <a className="chat-proposal-link" href={purchase ? "/purchasing" : "/approvals"}>
          {purchase ? "Open purchasing" : "Open approvals"}
        </a>
      )}
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

function ApprovalFields({ approval, currency }: { approval: Approval; currency: string | null }) {
  const fields = previewFields(approval.payload).slice(0, 6);
  if (fields.length === 0) {
    return <p className="chat-proposal-note">The stored payload is empty for this action.</p>;
  }
  return (
    <dl className="chat-approval-fields">
      {fields.map(([key, value]) => (
        <div className="chat-approval-field" key={key}>
          <dt>{humanizeFieldKey(key)}</dt>
          <dd>{formatApprovalValue(key, value, currency)}</dd>
        </div>
      ))}
    </dl>
  );
}
