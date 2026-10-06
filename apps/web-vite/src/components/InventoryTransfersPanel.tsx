import { useEffect, useMemo, useRef, useState } from "react";
import type { InventoryItem, InventoryLocation, InventoryTransfer } from "../api/inventory";
import {
  confirmInventoryTransfer,
  createInventoryTransfer,
  InventoryTransferApiError,
  supportsPartialConfirmation,
  type InventoryTransferRetryScope,
  type InventoryTransferWithLineIds,
  type PartialTransferLine,
} from "../api/inventory-transfers";

interface InventoryTransfersPanelProps {
  items: InventoryItem[];
  locations: InventoryLocation[];
  transfers: InventoryTransfer[];
  onChanged: () => void | Promise<void>;
  retryScope: InventoryTransferRetryScope;
}

function parseQuantity(value: string): number | null {
  if (!/^\d+(?:\.\d{1,3})?$/.test(value.trim())) return null;
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const thousandths = Math.round(quantity * 1000);
  return thousandths > 0 ? thousandths : null;
}

function units(thousandths: number): string {
  return (thousandths / 1000).toLocaleString("en", { maximumFractionDigits: 3 });
}

function confirmationProgressSignature(transfer: InventoryTransfer): string {
  const lines = transfer.lines
    .map((line) => [line.lineId ?? null, line.sku, line.quantityThousandths, line.confirmedThousandths] as const)
    .sort(([leftId, ...left], [rightId, ...right]) => {
      const idOrder = String(leftId).localeCompare(String(rightId));
      return idOrder || JSON.stringify(left).localeCompare(JSON.stringify(right));
    });
  return JSON.stringify({ status: transfer.status, lines });
}

export function InventoryTransfersPanel({ items, locations, transfers, onChanged, retryScope }: InventoryTransfersPanelProps) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sku, setSku] = useState("");
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [partialAmounts, setPartialAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "pending" | "error"; message: string } | null>(null);
  const partialConfirmationGuards = useRef(new Map<string, string>());
  const [guardedTransferIds, setGuardedTransferIds] = useState<ReadonlySet<string>>(() => new Set());
  const activeItems = useMemo(() => items.filter((item) => item.kind !== "service"), [items]);

  useEffect(() => {
    const progressedTransferIds: string[] = [];
    for (const [transferId, previousProgress] of partialConfirmationGuards.current) {
      const transfer = transfers.find((candidate) => candidate.id === transferId);
      if (transfer && confirmationProgressSignature(transfer) !== previousProgress) {
        partialConfirmationGuards.current.delete(transferId);
        progressedTransferIds.push(transferId);
      }
    }
    if (progressedTransferIds.length > 0) {
      setGuardedTransferIds((current) => {
        const next = new Set(current);
        for (const transferId of progressedTransferIds) next.delete(transferId);
        return next;
      });
    }
  }, [transfers]);

  async function runAction(
    action: () => Promise<{ kind: "completed" } | { kind: "pending"; reason: string }>,
    success: string,
    onCompleted?: () => void,
  ) {
    setBusy(true);
    setNotice(null);
    try {
      const result = await action();
      if (result.kind === "pending") {
        setNotice({ kind: "pending", message: `This transfer requires approval. ${result.reason}` });
        return false;
      }
      onCompleted?.();
      setNotice({ kind: "success", message: success });
      try {
        await onChanged();
      } catch {
        setNotice({ kind: "error", message: `${success} The transfer completed, but inventory could not refresh. Reload the page to see the latest status.` });
      }
      return true;
    } catch (error) {
      setNotice({
        kind: "error",
        message: error instanceof InventoryTransferApiError ? error.message : "The transfer could not be completed. Try again.",
      });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function draftTransfer() {
    const amount = parseQuantity(quantity);
    if (!from || !to || from === to || !sku || amount === null) return;
    const created = await runAction(() => createInventoryTransfer({
      fromLocationCode: from,
      toLocationCode: to,
      sku,
      quantityThousandths: amount,
      note: note.trim() || undefined,
    }, retryScope), "Transfer draft created.");
    if (created) {
      setSku("");
      setQuantity("");
      setNote("");
    }
  }

  async function confirmRemaining(transfer: InventoryTransfer) {
    await runAction(() => confirmInventoryTransfer(transfer.id, retryScope), `Transfer #${transfer.number} confirmed.`);
  }

  async function confirmPartial(transfer: InventoryTransferWithLineIds) {
    const lines: PartialTransferLine[] = [];
    for (const line of transfer.lines) {
      if (line.confirmedThousandths >= line.quantityThousandths) continue;
      if (!line.lineId) {
        setNotice({ kind: "error", message: "This transfer is missing line IDs required for partial confirmation. Confirm the remaining quantity instead." });
        return;
      }
      const value = partialAmounts[`${transfer.id}:${line.lineId}`];
      if (value === undefined || value.trim() === "") {
        setNotice({ kind: "error", message: "Enter a quantity for every remaining line. Unspecified lines are confirmed in full." });
        return;
      }
      const amount = parseQuantity(value);
      const remaining = line.quantityThousandths - line.confirmedThousandths;
      if (amount === null || amount > remaining) {
        setNotice({ kind: "error", message: `Enter a quantity above zero and no greater than the remaining amount for ${line.sku}.` });
        return;
      }
      lines.push({ lineId: line.lineId, quantityThousandths: amount });
    }
    if (lines.length === 0) {
      setNotice({ kind: "error", message: "Enter a partial quantity for at least one transfer line." });
      return;
    }
    const completed = await runAction(
      () => confirmInventoryTransfer(transfer.id, retryScope, lines),
      `Partial confirmation saved for transfer #${transfer.number}.`,
      () => {
        partialConfirmationGuards.current.set(transfer.id, confirmationProgressSignature(transfer));
        setGuardedTransferIds((current) => current.has(transfer.id) ? current : new Set(current).add(transfer.id));
      },
    );
    if (completed) {
      setPartialAmounts((current) => Object.fromEntries(
        Object.entries(current).filter(([key]) => !key.startsWith(`${transfer.id}:`)),
      ));
    }
  }

  return (
    <section aria-labelledby="inventory-transfers-title" className="inventory-transfer-panel">
      <h2 id="inventory-transfers-title">Stock transfers</h2>
      <p>Drafts move no stock. Confirm a transfer to move stock between locations.</p>
      {notice && <p role={notice.kind === "error" ? "alert" : "status"} aria-live="polite">{notice.message}</p>}
      <div>
        <label>
          From location
          <select aria-label="From location" value={from} onChange={(event) => { setFrom(event.target.value); if (event.target.value === to) setTo(""); }}>
            <option value="">Choose a location</option>
            {locations.map((location) => <option key={location.id} value={location.code}>{location.name} · {location.code}</option>)}
          </select>
        </label>
        <label>
          To location
          <select aria-label="To location" value={to} onChange={(event) => setTo(event.target.value)}>
            <option value="">Choose a location</option>
            {locations.filter((location) => location.code !== from).map((location) => <option key={location.id} value={location.code}>{location.name} · {location.code}</option>)}
          </select>
        </label>
        <label>
          Item
          <select aria-label="Item to transfer" value={sku} onChange={(event) => setSku(event.target.value)}>
            <option value="">Choose an item</option>
            {activeItems.map((item) => <option key={item.sku} value={item.sku}>{item.name} · {item.sku} · {units(item.availableThousandths)} {item.unitLabel} available</option>)}
          </select>
        </label>
        <label>
          Quantity in units
          <input aria-label="Quantity in units" type="number" min="0.001" step="0.001" inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
        </label>
        <label>
          Transfer note
          <input aria-label="Transfer note" value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
        <button type="button" disabled={busy || !from || !to || from === to || !sku || parseQuantity(quantity) === null} onClick={() => void draftTransfer()}>
          Draft transfer
        </button>
      </div>
      <h3>Transfer history</h3>
      {transfers.length === 0 ? <p>No transfers yet.</p> : (
        <ul>
          {transfers.map((transfer) => {
            const transferWithIds = transfer as InventoryTransferWithLineIds;
            const confirmationGuarded = guardedTransferIds.has(transfer.id);
            return (
              <li key={transfer.id}>
                <div>
                  <strong>#{transfer.number}</strong> {transfer.from} → {transfer.to} <span>({transfer.status})</span>
                  <p>{transfer.lines.map((line) => `${line.sku} ${units(line.confirmedThousandths)}/${units(line.quantityThousandths)}`).join(", ")}{transfer.note ? ` · ${transfer.note}` : ""}</p>
                </div>
                {(transfer.status === "pending" || transfer.status === "partial") && (
                  <div>
                    {confirmationGuarded && <p>Confirmation succeeded. Waiting for refreshed transfer progress before enabling confirmation again.</p>}
                    {supportsPartialConfirmation(transferWithIds) && (
                      <fieldset disabled={busy || confirmationGuarded}>
                        <legend>Confirm part of this transfer</legend>
                        <p>Enter a quantity for every remaining line. Leave no line blank because blank lines confirm in full.</p>
                        {transferWithIds.lines.filter((line) => line.confirmedThousandths < line.quantityThousandths).map((line) => {
                          const remaining = line.quantityThousandths - line.confirmedThousandths;
                          return <label key={line.lineId}>
                            {line.sku}, up to {units(remaining)}
                            <input
                              aria-label={`Partial quantity for ${line.sku}`}
                              type="number"
                              required
                              min="0.001"
                              max={units(remaining)}
                              step="0.001"
                              inputMode="decimal"
                              value={partialAmounts[`${transfer.id}:${line.lineId}`] ?? ""}
                              onChange={(event) => setPartialAmounts((current) => ({ ...current, [`${transfer.id}:${line.lineId}`]: event.target.value }))}
                            />
                          </label>;
                        })}
                        <button type="button" disabled={busy || confirmationGuarded} title={confirmationGuarded ? "Wait for refreshed transfer progress before confirming again" : undefined} onClick={() => void confirmPartial(transferWithIds)}>Confirm entered quantities</button>
                      </fieldset>
                    )}
                    <button type="button" disabled={busy || confirmationGuarded} title={confirmationGuarded ? "Wait for refreshed transfer progress before confirming again" : "Confirm the remaining quantity and move stock"} onClick={() => void confirmRemaining(transfer)}>
                      Confirm remaining
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
