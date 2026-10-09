import { useEffect, useMemo, useRef, useState } from "react";
import type { InventoryItem, InventoryLocation } from "../api/inventory";
import {
  createInventoryLocation,
  InventoryLocationActionError,
  type InventoryLocationRetryScope,
  releaseInventoryReservation,
  reserveInventoryStock,
} from "../api/inventory-locations-reservations";
import "./inventory-locations-reservations.css";

export interface InventoryReservation {
  id: string;
  sku: string;
  quantityThousandths: number;
  reason: string;
  status: string;
  createdAt: string;
}

interface InventoryLocationsReservationsPanelProps {
  items: InventoryItem[];
  locations: InventoryLocation[];
  reservations: InventoryReservation[];
  onChanged: () => Promise<void>;
  retryScope?: InventoryLocationRetryScope;
}

type Notice = { tone: "success" | "pending" | "error"; message: string };

export function InventoryLocationsReservationsPanel({
  items,
  locations,
  reservations,
  onChanged,
  retryScope,
}: InventoryLocationsReservationsPanelProps) {
  const scopeKey = JSON.stringify({
    actorId: retryScope?.actorId.trim() ?? "",
    organizationId: retryScope?.organizationId.trim() ?? "",
  });
  const currentScopeKey = useRef(scopeKey);
  const scopeGeneration = useRef(0);
  if (currentScopeKey.current !== scopeKey) {
    currentScopeKey.current = scopeKey;
    scopeGeneration.current += 1;
  }
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const stockItems = useMemo(() => items.filter((item) => item.kind !== "service"), [items]);
  const openReservations = useMemo(() => reservations.filter((reservation) => reservation.status === "open"), [reservations]);

  useEffect(() => {
    setBusy(false);
    setNotice(null);
  }, [scopeKey]);

  async function runAction(
    action: () => Promise<{ kind: "completed" } | { kind: "pending"; reason: string }>,
    successMessage: string,
  ): Promise<boolean> {
    const requestGeneration = scopeGeneration.current;
    setBusy(true);
    setNotice(null);
    try {
      const result = await action();
      if (requestGeneration !== scopeGeneration.current) return false;
      if (result.kind === "pending") {
        setNotice({ tone: "pending", message: `This action is waiting for approval. ${result.reason}` });
        return false;
      }
      setNotice({ tone: "success", message: successMessage });
      try {
        await onChanged();
      } catch {
        if (requestGeneration !== scopeGeneration.current) return false;
        setNotice({ tone: "error", message: `${successMessage} The action completed, but the inventory view could not refresh. Reload to see the latest status.` });
      }
      if (requestGeneration !== scopeGeneration.current) return false;
      return true;
    } catch (error) {
      if (requestGeneration !== scopeGeneration.current) return false;
      setNotice({
        tone: "error",
        message: error instanceof InventoryLocationActionError
          ? error.message
          : "The action could not be completed. Check inventory before retrying.",
      });
      return false;
    } finally {
      if (requestGeneration === scopeGeneration.current) setBusy(false);
    }
  }

  async function submitLocation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedCode = code.trim().toUpperCase();
    const normalizedName = name.trim();
    if (!normalizedCode || !normalizedName || normalizedCode.length > 20 || normalizedName.length > 80) return;
    const created = await runAction(() => createInventoryLocation({ code: normalizedCode, name: normalizedName }, retryScope), "Stock location created.");
    if (created) {
      setCode("");
      setName("");
    }
  }

  async function submitReservation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amount = parseThousandths(quantity);
    const normalizedReason = reason.trim();
    if (!sku || amount === null || !normalizedReason || normalizedReason.length < 3 || normalizedReason.length > 200) return;
    const reserved = await runAction(() => reserveInventoryStock({ sku, quantityThousandths: amount, reason: normalizedReason }, retryScope), "Stock reserved.");
    if (reserved) {
      setSku("");
      setQuantity("");
      setReason("");
    }
  }

  async function releaseReservation(reservation: InventoryReservation) {
    await runAction(
      () => releaseInventoryReservation({ reservationId: reservation.id }, retryScope),
      `Reservation for ${reservation.sku} released.`,
    );
  }

  return (
    <section className="inventory-locations-reservations" aria-label="Inventory locations and reservations">
      <header className="inventory-lr-header">
        <div>
          <p className="inventory-lr-eyebrow">Stock controls</p>
          <h2>Locations and reservations</h2>
        </div>
      </header>

      {notice && <p className={`inventory-lr-notice is-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}</p>}

      <div className="inventory-lr-grid">
        <form className="inventory-lr-card" onSubmit={(event) => void submitLocation(event)}>
          <h3>Create a stock location</h3>
          <label>
            Location code
            <input value={code} onChange={(event) => setCode(event.target.value)} maxLength={20} autoComplete="off" placeholder="WH-A" required />
          </label>
          <label>
            Location name
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoComplete="off" placeholder="Main warehouse" required />
          </label>
          <button type="submit" disabled={busy || !code.trim() || !name.trim()}>Create location</button>
        </form>

        <form className="inventory-lr-card" onSubmit={(event) => void submitReservation(event)}>
          <h3>Reserve stock</h3>
          <label>
            Stock item
            <select value={sku} onChange={(event) => setSku(event.target.value)} required>
              <option value="">Select an item</option>
              {stockItems.map((item) => <option key={item.sku} value={item.sku}>{item.name} ({item.sku})</option>)}
            </select>
          </label>
          <label>
            Quantity
            <input value={quantity} onChange={(event) => setQuantity(event.target.value)} inputMode="decimal" placeholder="1.000" required />
          </label>
          <label>
            Reason or order reference
            <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={200} placeholder="SO-1042" required />
          </label>
          <button type="submit" disabled={busy || !sku || parseThousandths(quantity) === null || reason.trim().length < 3}>Reserve stock</button>
        </form>

        <section className="inventory-lr-card inventory-lr-reservations" aria-labelledby="inventory-lr-reservations-heading">
          <h3 id="inventory-lr-reservations-heading">Open reservations</h3>
          {openReservations.length === 0 ? (
            <p className="inventory-lr-empty">No open reservations.</p>
          ) : (
            <ul>
              {openReservations.map((reservation) => (
                <li key={reservation.id}>
                  <div>
                    <strong>{reservation.sku}</strong>
                    <span>{formatQuantity(reservation.quantityThousandths)} · {reservation.reason}</span>
                  </div>
                  <button type="button" disabled={busy} onClick={() => void releaseReservation(reservation)}>Release</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {locations.length > 0 && (
        <div className="inventory-lr-location-list" aria-label="Current stock locations">
          <h3>Current locations</h3>
          <ul>{locations.map((location) => <li key={location.id}><strong>{location.code}</strong><span>{location.name}</span></li>)}</ul>
        </div>
      )}
    </section>
  );
}

function parseThousandths(value: string): number | null {
  const normalized = value.trim();
  if (!/^(?:\d+(?:\.\d{0,3})?|\.\d{1,3})$/.test(normalized)) return null;
  const quantity = Number(normalized);
  const thousandths = Math.round(quantity * 1000);
  return Number.isFinite(quantity) && quantity > 0 && Number.isSafeInteger(thousandths) ? thousandths : null;
}

function formatQuantity(thousandths: number): string {
  return (thousandths / 1000).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}
