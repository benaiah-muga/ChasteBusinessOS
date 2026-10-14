import { useEffect, useRef, useState } from "react";
import { currencyMinorUnits } from "@chaste/erp-core";
import { InventoryHistoryApiError, fetchInventoryHistory, type InventoryMovement } from "../api/inventory-history";
import "./inventory-stock-history.css";

type HistoryItem = { sku: string; name: string; unitLabel: string };

export function InventoryStockHistoryPanel({
  items,
  currency = "USD",
  organizationId,
}: {
  items: HistoryItem[];
  currency?: string;
  organizationId?: string;
}) {
  const [sku, setSku] = useState(items[0]?.sku ?? "");
  const [movements, setMovements] = useState<InventoryMovement[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "pending" | "error"; message: string } | null>(null);
  const requestId = useRef(0);
  const activeOrganization = useRef(organizationId);
  activeOrganization.current = organizationId;
  const selectedItem = items.find((item) => item.sku === sku);

  useEffect(() => {
    requestId.current += 1;
    setMovements(null);
    setHasMore(false);
    setNotice(null);
    setBusy(false);
  }, [organizationId]);

  async function loadHistory(before?: { createdAt: string; id: string }) {
    if (!selectedItem) return;
    const currentRequest = ++requestId.current;
    const requestedOrganization = organizationId;
    setBusy(true);
    setNotice(null);
    if (!before) {
      setMovements(null);
      setHasMore(false);
    }
    try {
      const result = await fetchInventoryHistory(selectedItem.sku, undefined, organizationId, before);
      if (requestId.current !== currentRequest || activeOrganization.current !== requestedOrganization) return;
      if (result.kind === "pending") {
        setNotice({ kind: "pending", message: result.reason });
        return;
      }
      setMovements((current) => before ? [...(current ?? []), ...result.movements] : result.movements);
      setHasMore(result.hasMore);
    } catch (error) {
      if (requestId.current !== currentRequest || activeOrganization.current !== requestedOrganization) return;
      setNotice({
        kind: "error",
        message: error instanceof InventoryHistoryApiError ? error.message : "Could not load stock history. Try again.",
      });
    } finally {
      if (requestId.current === currentRequest && activeOrganization.current === requestedOrganization) setBusy(false);
    }
  }

  const formatter = new Intl.NumberFormat(undefined, { style: "currency", currency });
  const minorUnitScale = 10 ** (currencyMinorUnits(currency) ?? 2);
  return (
    <section className="inventory-history" aria-labelledby="inventory-history-title">
      <div className="inventory-history-heading">
        <div>
          <p className="inventory-history-eyebrow">Stock ledger</p>
          <h2 id="inventory-history-title">Movement history</h2>
          <p>Review the latest recorded quantity changes, reasons, and unit costs.</p>
        </div>
        <form className="inventory-history-controls" onSubmit={(event) => { event.preventDefault(); void loadHistory(); }}>
          <label htmlFor="inventory-history-item">Item</label>
          <select
            id="inventory-history-item"
            value={sku}
            onChange={(event) => { setSku(event.target.value); setMovements(null); setHasMore(false); setNotice(null); }}
            disabled={busy || items.length === 0}
          >
            {items.length === 0 && <option value="">No items available</option>}
            {items.map((item) => <option key={item.sku} value={item.sku}>{item.sku} · {item.name}</option>)}
          </select>
          <button type="submit" disabled={busy || !selectedItem}>
            {busy ? "Loading…" : "Load history"}
          </button>
        </form>
      </div>

      {notice && <p className={`inventory-history-notice is-${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.message}</p>}
      {movements && movements.length === 0 && <p className="inventory-history-empty" role="status">No stock movements have been recorded for this item.</p>}
      {movements && movements.length > 0 && (
        <>
          <div className="inventory-history-table-wrap">
            <table>
              <caption className="sr-only">Stock movements for {selectedItem?.name ?? sku}</caption>
              <thead><tr><th scope="col">Date</th><th scope="col">Change</th><th scope="col">Reason</th><th scope="col">Unit cost</th><th scope="col">Details</th></tr></thead>
              <tbody>
                {movements.map((movement) => (
                  <tr key={movement.id}>
                    <td><time dateTime={movement.createdAt}>{formatDate(movement.createdAt)}</time></td>
                    <td className={movement.quantityDelta < 0 ? "is-negative" : "is-positive"}>
                      {movement.quantityDelta > 0 ? "+" : ""}{formatQuantity(movement.quantityDelta)} {selectedItem?.unitLabel ?? "units"}
                    </td>
                    <td><strong>{formatReason(movement.reason)}</strong>{movement.note && <span className="inventory-history-note">{movement.note}</span>}</td>
                    <td>{movement.unitCostMinor === null ? "Not recorded" : formatter.format(movement.unitCostMinor / minorUnitScale)}</td>
                    <td className="inventory-history-detail">
                      {[movement.refType, movement.lotCode ? `Lot ${movement.lotCode}` : null, movement.locationCode ? `Location ${movement.locationCode}` : null, `By ${movement.actorType}`].filter(Boolean).join(" · ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hasMore && <button type="button" className="inventory-history-load-more" disabled={busy} onClick={() => {
            const last = movements[movements.length - 1];
            if (last) void loadHistory({ createdAt: last.createdAt, id: last.id });
          }}>
            {busy ? "Loading…" : "Load older movements"}
          </button>}
        </>
      )}
    </section>
  );
}

function formatQuantity(thousandths: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(thousandths / 1000);
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatReason(reason: string): string {
  return reason.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
}
