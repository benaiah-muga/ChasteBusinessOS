import { useCallback, useEffect, useMemo, useState } from "react";
import { currencyMinorUnits } from "@chaste/erp-core";
import {
  fetchReceivingDetail,
  fetchReceivingEnabled,
  fetchReceivingOrders,
  ReceivingApiError,
  submitReceiveGoods,
  type ReceivingDetail,
  type ReceivingOrder,
  type ReceivingOrderLineRollup,
  type ReceiveGoodsAction,
} from "../api/purchasing-receiving";
import { legacyUrl } from "../legacy";
import "./PurchasingReceivingPage.css";

type LoadState =
  | { status: "loading" }
  | { status: "disabled" }
  | { status: "failed"; error: ReceivingApiError }
  | { status: "ready"; orders: ReceivingOrder[]; baseCurrency: string };

type Notice = { tone: "success" | "pending" | "error"; text: string };

type DraftLine = { accepted: string; rejected: string; rejectionNote: string };

export type ReceiveLineInput = {
  lineNumber: number;
  quantity: number;
  rejected: number;
  rejectionNote: string;
};

/**
 * Quantities travel as thousandths, so 1000 is one whole unit. The input box
 * takes the same thousandths the server stores, which is why a prefilled
 * remaining quantity can be sent back untouched.
 */
export function formatThousandths(thousandths: number): string {
  return (thousandths / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 });
}

export function formatMoney(minor: number, currency: string): string {
  const units = currencyMinorUnits(currency) ?? 2;
  const amount = minor / (10 ** units);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: units,
      maximumFractionDigits: units,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString(undefined, {
      minimumFractionDigits: units,
      maximumFractionDigits: units,
    })}`;
  }
}

/**
 * The server rolls every receipt for a line into one aggregate, so remaining is
 * read from that rollup rather than re-summed from the receipt list here. A
 * line that has never been received reports zero.
 */
export function prefillReceivingDraft(
  order: ReceivingOrder,
  orderLines: ReceivingOrderLineRollup[],
): Record<number, DraftLine> {
  const remainingByLine = new Map(orderLines.map((line) => [line.position, line.remainingThousandths]));
  return Object.fromEntries(
    order.lines.map((line) => [
      line.lineNumber,
      { accepted: String(remainingByLine.get(line.lineNumber) ?? 0), rejected: "0", rejectionNote: "" },
    ]),
  );
}

/**
 * Repeated references to one order line are folded into a single line: the
 * executor charges them against one ordered quantity, so sending them apart
 * would under-report what the delivery contains.
 */
export function aggregateReceiveLines(lines: ReceiveLineInput[]): ReceiveLineInput[] {
  const byLine = new Map<number, ReceiveLineInput>();
  for (const line of lines) {
    const existing = byLine.get(line.lineNumber);
    if (!existing) {
      byLine.set(line.lineNumber, { ...line });
      continue;
    }
    existing.quantity += line.quantity;
    existing.rejected += line.rejected;
    if (!existing.rejectionNote) existing.rejectionNote = line.rejectionNote;
  }
  return [...byLine.values()].sort((a, b) => a.lineNumber - b.lineNumber);
}

function toReceiveLines(order: ReceivingOrder, draft: Record<number, DraftLine>): ReceiveLineInput[] {
  return aggregateReceiveLines(
    order.lines.map((line) => {
      const entry = draft[line.lineNumber] ?? { accepted: "0", rejected: "0", rejectionNote: "" };
      return {
        lineNumber: line.lineNumber,
        quantity: Number(entry.accepted) || 0,
        rejected: Number(entry.rejected) || 0,
        rejectionNote: entry.rejectionNote.trim(),
      };
    }).filter((line) => line.quantity > 0 || line.rejected > 0),
  );
}

function digitsOnly(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

function apiError(error: unknown, fallback: string): ReceivingApiError {
  return error instanceof ReceivingApiError ? error : new ReceivingApiError(0, fallback);
}

function statusPillClass(status: string): string {
  if (status === "received") return "purchasing-receiving-status-pill is-received";
  if (status === "closed") return "purchasing-receiving-status-pill is-closed";
  if (status === "void") return "purchasing-receiving-status-pill is-void";
  return "purchasing-receiving-status-pill";
}

function orderTitle(error: ReceivingApiError, fallback: string): string {
  if (error.status === 401) return "Sign in again";
  if (error.status === 403) return "Access denied";
  if (error.status === 428) return "Finish setting up your workspace";
  return fallback;
}

export function PurchasingReceivingPage({ baseCurrency = null, actorId = null, organizationId = null }: { baseCurrency?: string | null; actorId?: string | null; organizationId?: string | null } = {}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [poNumber, setPoNumber] = useState("");
  const [openNumber, setOpenNumber] = useState<number | null>(null);
  const [detail, setDetail] = useState<ReceivingDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<number, DraftLine>>({});
  const [tolerance, setTolerance] = useState("");
  const [authority, setAuthority] = useState("");
  const [busy, setBusy] = useState(false);
  const [finding, setFinding] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [lastReceipt, setLastReceipt] = useState<{ number: number; fullyReceived: boolean } | null>(null);

  const load = useCallback(async ({ signal, quiet = false }: { signal?: AbortSignal; quiet?: boolean } = {}) => {
    // A quiet reload refreshes order statuses after a receipt without flashing
    // the whole page back to the loading state.
    if (!quiet) setState({ status: "loading" });
    try {
      if (!(await fetchReceivingEnabled(signal))) {
        if (!signal?.aborted) setState({ status: "disabled" });
        return;
      }
      const result = await fetchReceivingOrders(signal);
      if (signal?.aborted) return;
      setState({ status: "ready", orders: result.orders, baseCurrency: baseCurrency || result.baseCurrency });
    } catch (error) {
      if (signal?.aborted) return;
      setState({ status: "failed", error: apiError(error, "Could not load purchase orders. Try again.") });
    }
  }, [baseCurrency]);

  useEffect(() => {
    const controller = new AbortController();
    void load({ signal: controller.signal });
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("poNumber");
    if (requested) setPoNumber(digitsOnly(requested));
  }, []);

  const currency = state.status === "ready" ? state.baseCurrency : (baseCurrency ?? "USD");
  // Derived, not stored: a receipt can change the order's status, so the pill
  // has to come from the refreshed list rather than the copy held at open time.
  const order = useMemo(() => (state.status === "ready" && openNumber !== null
    ? state.orders.find((entry) => entry.number === openNumber) ?? null
    : null), [state, openNumber]);

  const openOrder = useCallback(async (rawNumber: string) => {
    const number = rawNumber.trim();
    if (!number) return;
    setFinding(true);
    setNotice(null);
    setLastReceipt(null);
    setDetailError(null);
    const found = (state.status === "ready" ? state.orders : []).find((entry) => String(entry.number) === number);
    if (!found) {
      setFinding(false);
      setNotice({
        tone: "error",
        text: `No order number ${number}. Check the number on the delivery note; it must be one of this team's purchase orders.`,
      });
      return;
    }
    setOpenNumber(found.number);
    try {
      const loaded = await fetchReceivingDetail(found.number);
      setDetail(loaded);
      setDraft(prefillReceivingDraft(found, loaded.orderLines));
      setDetailError(null);
    } catch (error) {
      // Receipt history is supporting detail: an order with none yet still receives.
      setDetail(null);
      setDraft(prefillReceivingDraft(found, []));
      setDetailError(apiError(error, "Could not load receipt history. The order can still be received.").message);
    } finally {
      setFinding(false);
    }
  }, [state]);

  const rollupFor = useCallback((position: number): ReceivingOrderLineRollup | undefined =>
    detail?.orderLines.find((line) => line.position === position), [detail]);

  const submit = useCallback(async () => {
    if (!order || busy) return;
    const lines = toReceiveLines(order, draft);
    if (lines.length === 0) {
      setNotice({ tone: "error", text: "Nothing to receive. Enter what arrived on at least one line." });
      return;
    }
    const invalidQuantity = lines.find((line) => !Number.isSafeInteger(line.quantity) || !Number.isSafeInteger(line.rejected)
      || line.quantity < 0 || line.rejected < 0 || line.quantity > 2_147_483_647 || line.rejected > 2_147_483_647);
    if (invalidQuantity || lines.some((line) => {
      const sameLine = lines.filter((entry) => entry.lineNumber === line.lineNumber);
      return sameLine.reduce((sum, entry) => sum + entry.quantity, 0) > 2_147_483_647
        || sameLine.reduce((sum, entry) => sum + entry.rejected, 0) > 2_147_483_647;
    })) {
      setNotice({ tone: "error", text: "Enter whole quantities within the supported range for every receipt line." });
      return;
    }
    const missingReason = lines.find((line) => line.rejected > 0 && !line.rejectionNote);
    if (missingReason) {
      setNotice({
        tone: "error",
        text: `Line ${missingReason.lineNumber} needs a rejection reason. Refused goods must say why; that note is what the supplier sees.`,
      });
      return;
    }
    if (lines.some((line) => line.rejected > 0 && (line.rejectionNote.length > 500))) {
      setNotice({ tone: "error", text: "Rejection reasons must be 500 characters or fewer." });
      return;
    }
    const tolerancePct = Number(tolerance) || 0;
    if (!Number.isSafeInteger(tolerancePct) || tolerancePct < 0 || tolerancePct > 10) {
      setNotice({ tone: "error", text: "Overreceipt tolerance must be a whole percentage from 0 to 10." });
      return;
    }
    if (tolerancePct > 0 && (authority.trim().length < 10 || authority.trim().length > 500)) {
      setNotice({
        tone: "error",
        text: "Accepting more than ordered needs a named authority reason between 10 and 500 characters.",
      });
      return;
    }
    const action: ReceiveGoodsAction = {
      action: "receiveGoods",
      poNumber: order.number,
      lines: lines.map((line) => ({
        lineNumber: line.lineNumber,
        quantity: line.quantity,
        rejected: line.rejected,
        rejectionNote: line.rejectionNote || undefined,
      })),
      ...(tolerancePct > 0 ? { overreceiptTolerancePct: tolerancePct, authorityReason: authority.trim() } : {}),
    };

    setBusy(true);
    setNotice(null);
    try {
      const outcome = await submitReceiveGoods(action, undefined, { actorId, organizationId });
      if (outcome.kind === "pending") {
        setNotice({ tone: "pending", text: `${outcome.reason} Nothing has been received yet; the receipt lands once it is approved.` });
        return;
      }
      setDraft((current) => Object.fromEntries(Object.entries(current).map(([lineNumber, line]) => [
        lineNumber,
        { ...line, accepted: "0", rejected: "0" },
      ])));
      setTolerance("");
      setAuthority("");
      setLastReceipt({ number: outcome.data.receiptNumber, fullyReceived: outcome.data.fullyReceived });
      setNotice({
        tone: "success",
        text: `Receipt ${outcome.data.receiptNumber} recorded. ${outcome.data.fullyReceived
          ? "Everything ordered is now on the books."
          : "Partially received; what is still expected stays visible on the order."}`,
      });
      try {
        const refreshedDetail = await fetchReceivingDetail(order.number);
        setDetail(refreshedDetail);
      } catch {
        setDetailError("The receipt was recorded, but the history could not be reloaded.");
      }
      void load({ quiet: true });
    } catch (error) {
      setNotice({ tone: "error", text: apiError(error, "Receiving was refused. Check quantities against the order; overreceipt needs explicit authority.").message });
    } finally {
      setBusy(false);
    }
  }, [order, draft, tolerance, authority, busy, load, actorId, organizationId]);

  const receiptHistory = useMemo(() => detail?.receipts ?? [], [detail]);

  if (state.status === "loading") {
    return <main className="purchasing-receiving-page"><p className="purchasing-receiving-loading" role="status">Loading purchase orders…</p></main>;
  }

  if (state.status === "disabled") {
    return (
      <main className="purchasing-receiving-page">
        <section className="purchasing-receiving-disabled" role="status">
          <h2>Purchasing is turned off</h2>
          <p>Ask a workspace administrator to enable the Purchasing module before recording deliveries.</p>
        </section>
      </main>
    );
  }

  if (state.status === "failed") {
    return (
      <main className="purchasing-receiving-page">
        <header className="purchasing-receiving-header">
          <div>
            <p className="purchasing-receiving-eyebrow">Purchasing · receiving</p>
            <h1>Receiving desk</h1>
            <p>Record what arrived against a purchase order, line by line, with three-way matching kept truthful.</p>
          </div>
          <a className="purchasing-receiving-legacy-link" href={legacyUrl("/purchasing")}>Open Purchasing</a>
        </header>
        <section className="purchasing-receiving-error" role="alert" aria-labelledby="purchasing-receiving-load-error">
          <div>
            <h2 id="purchasing-receiving-load-error">{orderTitle(state.error, "Could not load purchase orders")}</h2>
            <p>{state.error.message}</p>
          </div>
          <div className="purchasing-receiving-error-actions">
            {state.error.status === 401 && <a href="/login">Sign in again</a>}
            <button type="button" className="purchasing-receiving-button is-primary" onClick={() => void load()}>Try again</button>
          </div>
        </section>
      </main>
    );
  }

  const openOrders = state.orders.filter((entry) => entry.status === "ordered" || entry.status === "partial");

  return (
    <main className="purchasing-receiving-page">
      <header className="purchasing-receiving-header">
        <div>
          <p className="purchasing-receiving-eyebrow">Purchasing · receiving</p>
          <h1>Receiving desk</h1>
          <p>Find the order on the delivery note, enter what arrived on each line, and finish with what was added, refused, and still expected.</p>
        </div>
        <a className="purchasing-receiving-legacy-link" href={legacyUrl("/purchasing")}>Open Purchasing</a>
      </header>

      {notice && (
        <div
          className={`purchasing-receiving-notice is-${notice.tone}`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          <span>{notice.text}</span>
          <button type="button" className="purchasing-receiving-notice-dismiss" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <section className="purchasing-receiving-card" aria-labelledby="purchasing-receiving-finder-title">
        <div className="purchasing-receiving-card-head">
          <h2 className="purchasing-receiving-card-title" id="purchasing-receiving-finder-title">Find the order on the delivery note</h2>
        </div>
        <div className="purchasing-receiving-finder">
          <label className="purchasing-receiving-field" htmlFor="purchasing-receiving-order-number">
            PO number
            <input
              id="purchasing-receiving-order-number"
              className="purchasing-receiving-input purchasing-receiving-input-narrow"
              inputMode="numeric"
              placeholder="PO number"
              value={poNumber}
              onChange={(event) => setPoNumber(digitsOnly(event.currentTarget.value))}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void openOrder(poNumber);
                }
              }}
            />
          </label>
          {state.orders.length > 0 && (
            <label className="purchasing-receiving-field purchasing-receiving-field-grow" htmlFor="purchasing-receiving-order-picker">
              Open orders
              <select
                id="purchasing-receiving-order-picker"
                className="purchasing-receiving-input"
                value=""
                onChange={(event) => {
                  if (!event.currentTarget.value) return;
                  setPoNumber(event.currentTarget.value);
                  void openOrder(event.currentTarget.value);
                }}
              >
                <option value="">Choose an order…</option>
                {(openOrders.length > 0 ? openOrders : state.orders).map((entry) => (
                  <option key={entry.id} value={entry.number}>
                    PO #{entry.number} · {entry.vendorName || "Unknown supplier"} · {entry.status}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="button" className="purchasing-receiving-button is-primary" disabled={finding || !poNumber.trim()} onClick={() => void openOrder(poNumber)}>
            {finding ? "Opening…" : "Open order"}
          </button>
        </div>
        {state.orders.length === 0 && (
          <p className="purchasing-receiving-card-hint">
            No purchase orders yet. Raise one in Purchasing before a delivery can be received against it.
          </p>
        )}
      </section>

      {order && (
        <section className="purchasing-receiving-card" aria-labelledby="purchasing-receiving-order-title">
          <div className="purchasing-receiving-card-head">
            <h2 className="purchasing-receiving-card-title" id="purchasing-receiving-order-title">
              PO {order.number} · {order.vendorName || "Unknown supplier"}
            </h2>
            <span className={statusPillClass(order.status)}>{order.status}</span>
          </div>
          <p className="purchasing-receiving-card-hint">
            Ordered {formatMoney(order.orderedMinor, currency)}
            {order.memo ? ` · ${order.memo}` : ""}
          </p>

          {detailError && (
            <div className="purchasing-receiving-notice is-error" role="alert">
              <span>{detailError}</span>
              <button type="button" className="purchasing-receiving-notice-dismiss" onClick={() => void openOrder(String(order.number))}>Retry</button>
            </div>
          )}

          <div className="purchasing-receiving-lines">
            {order.lines.map((line) => {
              const rollup = rollupFor(line.lineNumber);
              const entry = draft[line.lineNumber] ?? { accepted: "0", rejected: "0", rejectionNote: "" };
              const rejected = Number(entry.rejected) || 0;
              return (
                <div className="purchasing-receiving-line" key={line.lineNumber}>
                  <div className="purchasing-receiving-line-head">
                    <p className="purchasing-receiving-line-name">Line {line.lineNumber}: {line.description}</p>
                    <p className="purchasing-receiving-line-stats">
                      ordered {formatThousandths(line.quantity)} · accepted so far {formatThousandths(rollup?.acceptedThousandths ?? 0)} · rejected {formatThousandths(rollup?.rejectedThousandths ?? 0)} · outstanding {formatThousandths(rollup?.remainingThousandths ?? 0)}
                    </p>
                  </div>
                  <div className="purchasing-receiving-line-fields">
                    <label className="purchasing-receiving-field" htmlFor={`purchasing-receiving-accepted-${line.lineNumber}`}>
                      accepted on line {line.lineNumber}
                      <input
                        id={`purchasing-receiving-accepted-${line.lineNumber}`}
                        className="purchasing-receiving-input purchasing-receiving-input-narrow"
                        inputMode="numeric"
                        value={entry.accepted}
                        onChange={(event) => {
                          const value = digitsOnly(event.currentTarget.value);
                          setDraft((current) => ({
                            ...current,
                            [line.lineNumber]: { ...entry, accepted: value },
                          }));
                        }}
                      />
                    </label>
                    <label className="purchasing-receiving-field" htmlFor={`purchasing-receiving-rejected-${line.lineNumber}`}>
                      rejected on line {line.lineNumber}
                      <input
                        id={`purchasing-receiving-rejected-${line.lineNumber}`}
                        className="purchasing-receiving-input purchasing-receiving-input-narrow"
                        inputMode="numeric"
                        value={entry.rejected}
                        onChange={(event) => {
                          const value = digitsOnly(event.currentTarget.value);
                          setDraft((current) => ({
                            ...current,
                            [line.lineNumber]: { ...entry, rejected: value },
                          }));
                        }}
                      />
                    </label>
                    {rejected > 0 && (
                      <label className="purchasing-receiving-field purchasing-receiving-reject-note" htmlFor={`purchasing-receiving-reason-${line.lineNumber}`}>
                        rejection reason for line {line.lineNumber} (shown to the supplier)
                        <input
                          id={`purchasing-receiving-reason-${line.lineNumber}`}
                          className="purchasing-receiving-input purchasing-receiving-input-wide"
                          placeholder="Why are these refused?"
                          value={entry.rejectionNote}
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            setDraft((current) => ({
                              ...current,
                              [line.lineNumber]: { ...entry, rejectionNote: value },
                            }));
                          }}
                        />
                      </label>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="purchasing-receiving-authority">
            <p className="purchasing-receiving-authority-title">Overreceipt tolerance % (optional)</p>
            <p className="purchasing-receiving-hint">Accepting more than ordered is refused unless you name the tolerance and who authorized it.</p>
            <div className="purchasing-receiving-authority-fields">
              <label className="purchasing-receiving-field" htmlFor="purchasing-receiving-tolerance">
                tolerance %
                <input
                  id="purchasing-receiving-tolerance"
                  className="purchasing-receiving-input purchasing-receiving-input-narrow"
                  inputMode="numeric"
                  value={tolerance}
                  onChange={(event) => setTolerance(digitsOnly(event.currentTarget.value))}
                />
              </label>
              {Number(tolerance) > 0 && (
                <label className="purchasing-receiving-field purchasing-receiving-field-grow" htmlFor="purchasing-receiving-authority">
                  authorized by
                  <input
                    id="purchasing-receiving-authority"
                    className="purchasing-receiving-input purchasing-receiving-input-wide"
                    placeholder="Who authorized accepting more than ordered?"
                    value={authority}
                    onChange={(event) => setAuthority(event.currentTarget.value)}
                  />
                </label>
              )}
            </div>
          </div>

          <div className="purchasing-receiving-actions">
            <button type="button" className="purchasing-receiving-button is-primary" disabled={busy} onClick={() => void submit()}>
              {busy ? "Recording…" : "Record receipt"}
            </button>
            <p className="purchasing-receiving-hint">Quantities are thousandths: 1000 is one whole unit.</p>
          </div>
        </section>
      )}

      {lastReceipt && (
        <section className="purchasing-receiving-card" aria-labelledby="purchasing-receiving-last-receipt">
          <div className="purchasing-receiving-card-head">
            <h2 className="purchasing-receiving-card-title" id="purchasing-receiving-last-receipt">Receipt {lastReceipt.number}</h2>
          </div>
          <p className="purchasing-receiving-card-hint">
            {lastReceipt.fullyReceived
              ? "Every line is now fully delivered. The order can be matched against the supplier's bill."
              : "Recorded. The outstanding quantity stays on the order until it arrives or the order is closed."}
          </p>
        </section>
      )}

      {order && receiptHistory.length > 0 && (
        <section className="purchasing-receiving-card" aria-labelledby="purchasing-receiving-history">
          <div className="purchasing-receiving-card-head">
            <h2 className="purchasing-receiving-card-title" id="purchasing-receiving-history">Receipt history</h2>
          </div>
          <div className="purchasing-receiving-receipt-list">
            {receiptHistory.map((receipt) => (
              <article className="purchasing-receiving-receipt-card" key={receipt.number}>
                <header className="purchasing-receiving-receipt-head">
                  <span className="purchasing-receiving-card-title">Receipt {receipt.number}</span>
                  <time className="purchasing-receiving-receipt-time" dateTime={receipt.receivedAt}>
                    {new Date(receipt.receivedAt).toLocaleString()}
                  </time>
                </header>
                {receipt.note && <p className="purchasing-receiving-receipt-note">{receipt.note}</p>}
                <div className="purchasing-receiving-table-wrap">
                  <table className="purchasing-receiving-table">
                    <caption className="purchasing-receiving-visually-hidden">
                      Accepted, rejected, and returned quantities for receipt {receipt.number}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Line</th>
                        <th scope="col">Accepted</th>
                        <th scope="col">Rejected</th>
                        <th scope="col">Returned</th>
                        <th scope="col">Rejection reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {receipt.lines.map((line, index) => (
                        <tr key={`${line.position}-${index}`}>
                          <th scope="row">{line.description}</th>
                          <td>{formatThousandths(line.acceptedThousandths)}</td>
                          <td>{formatThousandths(line.rejectedThousandths)}</td>
                          <td className={line.returnedThousandths > 0 ? "is-credit" : undefined}>{formatThousandths(line.returnedThousandths)}</td>
                          <td>{line.rejectionNote || "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {order && detail && receiptHistory.length === 0 && (
        <section className="purchasing-receiving-empty" role="status">
          <h2>No receipts yet</h2>
          <p>This order has not been received against; the lines above are what is still expected.</p>
        </section>
      )}
    </main>
  );
}
