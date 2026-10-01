import { useState } from "react";
import { InventoryHistoryApiError, fetchInventoryHistory, type InventoryMovement } from "../api/inventory-history";
import "./inventory-stock-history.css";

type HistoryItem = { sku: string; name: string; unitLabel: string };

export function InventoryStockHistoryPanel({
  items,
  currency = "USD",
}: {
  items: HistoryItem[];
  currency?: string;
}) {
  const [sku, setSku] = useState(items[0]?.sku ?? "");
  const [movements, setMovements] = useState<InventoryMovement[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "pending" | "error"; message: string } | null>(null);
  const selectedItem = items.find((item) => item.sku === sku);

  async function loadHistory() {
    if (!selectedItem) return;
    setBusy(true);
    setNotice(null);
    setMovements(null);
    try {
      const result = await fetchInventoryHistory(selectedItem.sku);
      if (result.kind === "pending") {
        setNotice({ kind: "pending", message: result.reason });
        return;
      }
      setMovements(result.movements);
    } catch (error) {
      setNotice({
        kind: "error",
        message: error instanceof InventoryHistoryApiError ? error.message : "Could not load stock history. Try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  const formatter = new Intl.NumberFormat(undefined, { style: "currency", currency });
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
            onChange={(event) => { setSku(event.target.value); setMovements(null); setNotice(null); }}
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
                  <td>{movement.unitCostMinor === null ? "Not recorded" : formatter.format(movement.unitCostMinor / 100)}</td>
                  <td className="inventory-history-detail">
                    {[movement.refType, movement.lotCode ? `Lot ${movement.lotCode}` : null, movement.locationCode ? `Location ${movement.locationCode}` : null, `By ${movement.actorType}`].filter(Boolean).join(" · ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
