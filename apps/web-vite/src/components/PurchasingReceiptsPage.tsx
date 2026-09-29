import { useCallback, useEffect, useMemo, useState } from "react";
import { currencyMinorUnits } from "@chaste/erp-core";
import {
  fetchPurchaseOrderReceipts,
  fetchPurchasingOrders,
  fetchPurchasingReceiptsEnabled,
  PurchasingReceiptsApiError,
  type PurchasingReceipt,
  type PurchasingReceiptOrder,
  type PurchasingReceiptOrderLine,
} from "../api/purchasing-receipts";
import { legacyUrl } from "../legacy";
import "./purchasing-receipts-page.css";

type OrdersState =
  | { status: "loading" }
  | { status: "disabled" }
  | { status: "failed"; error: PurchasingReceiptsApiError }
  | { status: "empty" }
  | { status: "ready"; orders: PurchasingReceiptOrder[]; currency: string };

type ReceiptsState =
  | { status: "idle" | "loading" }
  | { status: "failed"; error: PurchasingReceiptsApiError }
  | { status: "empty" }
  | { status: "ready"; receipts: PurchasingReceipt[]; orderLines: PurchasingReceiptOrderLine[] };

function money(minor: number, currency: string): string {
  const minorUnits = currencyMinorUnits(currency) ?? 2;
  const amount = minor / (10 ** minorUnits);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: minorUnits,
      maximumFractionDigits: minorUnits,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString(undefined, {
      minimumFractionDigits: minorUnits,
      maximumFractionDigits: minorUnits,
    })}`;
  }
}

function quantity(thousandths: number): string {
  return (thousandths / 1000).toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function apiError(error: unknown, fallback: string): PurchasingReceiptsApiError {
  return error instanceof PurchasingReceiptsApiError
    ? error
    : new PurchasingReceiptsApiError(0, fallback);
}

export function PurchasingReceiptsPage({ baseCurrency = null }: { baseCurrency?: string | null } = {}) {
  const [ordersState, setOrdersState] = useState<OrdersState>({ status: "loading" });
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [receiptsState, setReceiptsState] = useState<ReceiptsState>({ status: "idle" });
  const [receiptRetry, setReceiptRetry] = useState(0);

  const loadOrders = useCallback(async (signal?: AbortSignal) => {
    setOrdersState({ status: "loading" });
    try {
      const enabled = await fetchPurchasingReceiptsEnabled(signal);
      if (signal?.aborted) return;
      if (!enabled) {
        setOrdersState({ status: "disabled" });
        setSelectedNumber(null);
        return;
      }
      const result = await fetchPurchasingOrders(signal);
      if (signal?.aborted) return;
      if (result.orders.length === 0) {
        setSelectedNumber(null);
        setOrdersState({ status: "empty" });
        return;
      }
      setOrdersState({ status: "ready", orders: result.orders, currency: baseCurrency || result.baseCurrency });
      setSelectedNumber((current) => result.orders.some((order) => order.number === current)
        ? current
        : result.orders[0]?.number ?? null);
    } catch (error) {
      if (signal?.aborted) return;
      setOrdersState({
        status: "failed",
        error: apiError(error, "Could not load purchase orders. Try again."),
      });
    }
  }, [baseCurrency]);

  useEffect(() => {
    const controller = new AbortController();
    void loadOrders(controller.signal);
    return () => controller.abort();
  }, [loadOrders]);

  useEffect(() => {
    if (ordersState.status !== "ready" || selectedNumber === null) {
      setReceiptsState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setReceiptsState({ status: "loading" });
    void fetchPurchaseOrderReceipts(selectedNumber, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setReceiptsState(result.receipts.length === 0 && result.orderLines.every((line) =>
        line.acceptedThousandths === 0 && line.rejectedThousandths === 0 && line.returnedThousandths === 0,
      )
        ? { status: "empty" }
        : { status: "ready", receipts: result.receipts, orderLines: result.orderLines });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setReceiptsState({
        status: "failed",
        error: apiError(error, "Could not load receipt history. Try again."),
      });
    });
    return () => controller.abort();
  }, [ordersState, receiptRetry, selectedNumber]);

  const selectedOrder = useMemo(() => ordersState.status === "ready"
    ? ordersState.orders.find((order) => order.number === selectedNumber) ?? null
    : null, [ordersState, selectedNumber]);

  return (
    <main className="purchasing-receipts-page">
      <header className="purchasing-receipts-header">
        <div>
          <p className="purchasing-receipts-eyebrow">Purchasing · read only</p>
          <h1>Purchase receipt history</h1>
          <p>Review accepted, rejected, and returned quantities recorded against each purchase order. Receive deliveries in the full workspace.</p>
        </div>
        <a className="purchasing-receipts-full-workspace" href={legacyUrl("/purchasing/receiving")}>Open full receiving workspace</a>
      </header>

      {ordersState.status === "loading" && <p className="purchasing-receipts-message" role="status">Loading purchase orders…</p>}

      {ordersState.status === "disabled" && (
        <section className="purchasing-receipts-message" role="status">
          <h2>Purchasing is turned off</h2>
          <p>Ask a workspace administrator to enable the Purchasing module before viewing receipts.</p>
        </section>
      )}

      {ordersState.status === "failed" && (
        <section className="purchasing-receipts-message purchasing-receipts-error" role="alert" aria-labelledby="purchasing-receipts-orders-error-title">
          <div>
            <h2 id="purchasing-receipts-orders-error-title">
              {ordersState.error.status === 401 ? "Sign in again" : ordersState.error.status === 403 ? "Access denied" : "Could not load purchase orders"}
            </h2>
            <p>{ordersState.error.message}</p>
          </div>
          <div className="purchasing-receipts-error-actions">
            {ordersState.error.status === 401 && <a href="/login">Sign in again</a>}
            <button type="button" onClick={() => void loadOrders()}>Try again</button>
          </div>
        </section>
      )}

      {ordersState.status === "empty" && (
        <section className="purchasing-receipts-message" role="status">
          <h2>No purchase orders yet</h2>
          <p>Purchase orders will appear here after they are created in Purchasing.</p>
        </section>
      )}

      {ordersState.status === "ready" && (
        <>
          <section className="purchasing-receipts-order-picker" aria-label="Purchase order selection">
            <label htmlFor="purchasing-receipts-order">Purchase order</label>
            <select
              id="purchasing-receipts-order"
              value={selectedNumber ?? ""}
              onChange={(event) => setSelectedNumber(Number(event.currentTarget.value))}
            >
              {ordersState.orders.map((order) => (
                <option key={order.id} value={order.number}>
                  PO #{order.number} · {order.vendorName || "Unknown supplier"}
                </option>
              ))}
            </select>
            {selectedOrder && <p>{selectedOrder.status} · {money(selectedOrder.orderedMinor, ordersState.currency)}</p>}
          </section>

          {receiptsState.status === "loading" && <p className="purchasing-receipts-message" role="status">Loading receipt history…</p>}

          {receiptsState.status === "failed" && (
            <section className="purchasing-receipts-message purchasing-receipts-error" role="alert" aria-labelledby="purchasing-receipts-detail-error-title">
              <div>
                <h2 id="purchasing-receipts-detail-error-title">
                  {receiptsState.error.status === 401 ? "Sign in again" : receiptsState.error.status === 403 ? "Access denied" : "Could not load receipt history"}
                </h2>
                <p>{receiptsState.error.message}</p>
              </div>
              <div className="purchasing-receipts-error-actions">
                {receiptsState.error.status === 401 && <a href="/login">Sign in again</a>}
                <button type="button" onClick={() => setReceiptRetry((retry) => retry + 1)}>Try again</button>
              </div>
            </section>
          )}

          {receiptsState.status === "empty" && (
            <section className="purchasing-receipts-message" role="status">
              <h2>No receipts recorded for this purchase order</h2>
              <p>Receipt entries will appear here after deliveries are recorded.</p>
              <a href={legacyUrl("/purchasing/receiving")}>Receive a delivery</a>
            </section>
          )}

          {receiptsState.status === "ready" && (
            <section className="purchasing-receipts-content" aria-label={`Receipt history for purchase order ${selectedNumber}`}>
              <section className="purchasing-receipts-summary" aria-labelledby="purchasing-receipts-summary-title">
                <h2 id="purchasing-receipts-summary-title">Order quantities</h2>
                <div className="purchasing-receipts-table-wrap">
                  <table className="purchasing-receipts-table">
                    <caption>Quantities received, rejected, returned, and remaining for each order line</caption>
                    <thead><tr><th scope="col">Line</th><th scope="col">Ordered</th><th scope="col">Accepted</th><th scope="col">Rejected</th><th scope="col">Returned</th><th scope="col">Outstanding</th></tr></thead>
                    <tbody>
                      {receiptsState.orderLines.map((line) => (
                        <tr key={line.position}>
                          <th scope="row">{line.description}</th>
                          <td>{quantity(line.orderedThousandths)}</td>
                          <td>{quantity(line.acceptedThousandths)}</td>
                          <td>{quantity(line.rejectedThousandths)}</td>
                          <td>{quantity(line.returnedThousandths)}</td>
                          <td>{quantity(line.remainingThousandths)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="purchasing-receipts-list" aria-label="Goods receipts">
                {receiptsState.receipts.length === 0 && (
                  <p className="purchasing-receipts-message" role="status">
                    No receipt records are available. The order quantities above may include stock movements recorded before receipt documents were introduced.
                  </p>
                )}
                {receiptsState.receipts.map((receipt) => (
                  <article className="purchasing-receipt-card" key={receipt.number}>
                    <header className="purchasing-receipt-heading">
                      <div>
                        <h2>Receipt #{receipt.number}</h2>
                        <p><time dateTime={receipt.receivedAt}>{dateLabel(receipt.receivedAt)}</time></p>
                      </div>
                      {receipt.note && <p className="purchasing-receipt-note">{receipt.note}</p>}
                    </header>
                    <div className="purchasing-receipts-table-wrap">
                      <table className="purchasing-receipts-table">
                        <caption>Accepted, rejected, and returned quantities for receipt {receipt.number}</caption>
                        <thead><tr><th scope="col">Line</th><th scope="col">Accepted</th><th scope="col">Rejected</th><th scope="col">Returned</th><th scope="col">Rejection reason</th></tr></thead>
                        <tbody>
                          {receipt.lines.map((line, index) => (
                            <tr key={`${line.position}-${index}`}>
                              <th scope="row">{line.description}</th>
                              <td>{quantity(line.acceptedThousandths)}</td>
                              <td>{quantity(line.rejectedThousandths)}</td>
                              <td>{quantity(line.returnedThousandths)}</td>
                              <td>{line.rejectionNote || "-"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </article>
                ))}
              </section>
            </section>
          )}
        </>
      )}
    </main>
  );
}
