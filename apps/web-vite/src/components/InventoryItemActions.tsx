import { useState, type FormEvent } from "react";
import { currencyMinorUnits } from "@chaste/erp-core";
import { type InventoryItem } from "../api/inventory";
import { InventoryItemActionError, submitInventoryItemAction as submitItemAction, type InventoryItemActionResult } from "../api/inventory-items";
import "./inventory-item-actions.css";

type FormValues = {
  sku: string;
  name: string;
  kind: "goods" | "service";
  unitLabel: string;
  salePrice: string;
  reorder: string;
  openingQty: string;
  barcode: string;
  imageUrl: string;
  tags: string;
};

type AdjustmentValues = { sku: string; direction: "increase" | "decrease"; quantity: string; note: string; lotCode: string; locationCode: string };
type Notice = { tone: "success" | "pending" | "error"; message: string };

function scaledInteger(value: string, decimals: number): number | null {
  const text = value.trim();
  if (!text) return 0;
  if (text.length > 24) return null;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match || (match[2]?.length ?? 0) > decimals) return null;
  const scale = 10n ** BigInt(decimals);
  const fractional = BigInt((match[2] ?? "").padEnd(decimals, "0") || "0");
  const result = BigInt(match[1]!) * scale + fractional;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(result);
}

function blankForm(): FormValues {
  return { sku: "", name: "", kind: "goods", unitLabel: "unit", salePrice: "", reorder: "", openingQty: "", barcode: "", imageUrl: "", tags: "" };
}

export function InventoryItemActions({
  items,
  currency = "USD",
  onChanged,
}: {
  items: InventoryItem[];
  currency?: string;
  onChanged: () => void | Promise<void>;
}) {
  const [form, setForm] = useState<FormValues>(blankForm);
  const [adjustment, setAdjustment] = useState<AdjustmentValues>({ sku: "", direction: "increase", quantity: "", note: "", lotCode: "", locationCode: "" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const minorUnits = currencyMinorUnits(currency) ?? 2;

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const salePriceMinor = scaledInteger(form.salePrice, minorUnits);
    const reorderPointThousandths = form.kind === "goods" ? scaledInteger(form.reorder, 3) : 0;
    const openingQuantity = form.kind === "goods" ? scaledInteger(form.openingQty, 3) : 0;
    if (salePriceMinor === null || reorderPointThousandths === null || openingQuantity === null) {
      setNotice({ tone: "error", message: `Use at most ${minorUnits} decimal places for price and 3 for stock quantities.` });
      return;
    }
    setBusy(true);
    setNotice(null);
    let created: InventoryItemActionResult;
    try {
      created = await submitItemAction({
        action: "createItem",
        sku: form.sku.trim(),
        name: form.name.trim(),
        kind: form.kind,
        unitLabel: form.kind === "service" ? form.unitLabel.trim() || "hour" : form.unitLabel.trim() || "unit",
        salePriceMinor,
        reorderPointThousandths,
        ...(form.barcode.trim() ? { barcode: form.barcode.trim() } : {}),
        ...(form.imageUrl.trim() ? { imageUrl: form.imageUrl.trim() } : {}),
        tags: form.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      });
      if (created.kind === "pending") {
        setNotice({ tone: "pending", message: created.reason });
        return;
      }
    } catch (error) {
      if (error instanceof InventoryItemActionError && error.status === 0) await onChanged();
      setNotice({ tone: "error", message: error instanceof InventoryItemActionError ? error.message : "The inventory action could not be completed." });
      return;
    } finally {
      setBusy(false);
    }

    await onChanged();
    setForm(blankForm());
    if (openingQuantity > 0 && form.kind === "goods") {
      setBusy(true);
      try {
        const opening = await submitItemAction({
          action: "adjustStock",
          sku: form.sku.trim(),
          quantityDelta: openingQuantity,
          note: "Opening stock",
        });
        if (opening.kind === "pending") {
          setNotice({ tone: "pending", message: "Item created. Opening stock is waiting for approval." });
        } else {
          await onChanged();
          setNotice({ tone: "success", message: "Item created and opening stock recorded." });
        }
      } catch (error) {
        await onChanged();
        setNotice({ tone: "error", message: `Item created, but opening stock could not be recorded: ${error instanceof InventoryItemActionError ? error.message : "check the current stock before retrying."}` });
      } finally {
        setBusy(false);
      }
      return;
    }
    setNotice({ tone: "success", message: "Item created." });
  }

  async function handleAdjustment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const quantity = scaledInteger(adjustment.quantity, 3);
    if (quantity === null || quantity <= 0) {
      setNotice({ tone: "error", message: "Enter a stock quantity greater than zero with no more than 3 decimal places." });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result = await submitItemAction({
        action: "adjustStock",
        sku: adjustment.sku,
        quantityDelta: adjustment.direction === "increase" ? quantity : -quantity,
        note: adjustment.note.trim(),
        ...(adjustment.lotCode.trim() && adjustment.direction === "increase" ? { lotCode: adjustment.lotCode.trim() } : {}),
        ...(adjustment.locationCode.trim() ? { locationCode: adjustment.locationCode.trim() } : {}),
      });
      if (result.kind === "pending") {
        setNotice({ tone: "pending", message: result.reason });
        return;
      }
      await onChanged();
      setAdjustment((current) => ({ ...current, quantity: "", note: "", lotCode: "" }));
      setNotice({ tone: "success", message: "Stock adjustment recorded." });
    } catch (error) {
      if (error instanceof InventoryItemActionError && error.status === 0) await onChanged();
      setNotice({ tone: "error", message: error instanceof InventoryItemActionError ? error.message : "The stock adjustment could not be completed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="inventory-item-actions" aria-labelledby="inventory-item-actions-title">
      <div className="inventory-item-actions-heading">
        <div><p className="inventory-eyebrow">Governed actions</p><h2 id="inventory-item-actions-title">Manage items and stock</h2></div>
        {notice && <p className={`inventory-item-notice inventory-item-notice-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}</p>}
      </div>
      <div className="inventory-item-action-grid">
        <form className="inventory-item-form" onSubmit={(event) => void handleCreate(event)}>
          <h3>Add an item</h3>
          <div className="inventory-item-fields">
            <label>SKU<input required maxLength={40} value={form.sku} onChange={(event) => setForm({ ...form, sku: event.currentTarget.value })} /></label>
            <label>Name<input required maxLength={120} value={form.name} onChange={(event) => setForm({ ...form, name: event.currentTarget.value })} /></label>
            <label>Item type<select value={form.kind} onChange={(event) => { const kind = event.currentTarget.value as FormValues["kind"]; setForm({ ...form, kind, unitLabel: kind === "service" && form.unitLabel === "unit" ? "hour" : kind === "goods" && form.unitLabel === "hour" ? "unit" : form.unitLabel }); }}><option value="goods">Goods</option><option value="service">Service</option></select></label>
            <label>Unit<input maxLength={20} value={form.unitLabel} onChange={(event) => setForm({ ...form, unitLabel: event.currentTarget.value })} /></label>
            <label>Selling price<input inputMode="decimal" value={form.salePrice} onChange={(event) => setForm({ ...form, salePrice: event.currentTarget.value })} placeholder="0.00" /></label>
            {form.kind === "goods" && <>
              <label>Reorder point<input inputMode="decimal" value={form.reorder} onChange={(event) => setForm({ ...form, reorder: event.currentTarget.value })} placeholder="0" /></label>
              <label>Opening stock<input inputMode="decimal" value={form.openingQty} onChange={(event) => setForm({ ...form, openingQty: event.currentTarget.value })} placeholder="0" /></label>
            </>}
            <label>Barcode<input maxLength={64} value={form.barcode} onChange={(event) => setForm({ ...form, barcode: event.currentTarget.value })} /></label>
            <label>Image URL<input type="url" value={form.imageUrl} onChange={(event) => setForm({ ...form, imageUrl: event.currentTarget.value })} /></label>
            <label className="inventory-item-field-wide">Tags<input value={form.tags} onChange={(event) => setForm({ ...form, tags: event.currentTarget.value })} placeholder="Separate tags with commas" /></label>
          </div>
          <button className="shell-button" type="submit" disabled={busy}>{busy ? "Saving…" : "Create item"}</button>
        </form>

        <form className="inventory-item-form" onSubmit={(event) => void handleAdjustment(event)}>
          <h3>Adjust stock</h3>
          {items.length === 0 ? <p>Add a goods item before adjusting stock.</p> : <>
            <div className="inventory-item-fields">
              <label className="inventory-item-field-wide">Item<select required value={adjustment.sku} onChange={(event) => setAdjustment({ ...adjustment, sku: event.currentTarget.value })}><option value="">Choose an item</option>{items.filter((item) => item.kind !== "service").map((item) => <option key={item.sku} value={item.sku}>{item.sku} · {item.name}</option>)}</select></label>
              <label>Direction<select value={adjustment.direction} onChange={(event) => setAdjustment({ ...adjustment, direction: event.currentTarget.value as AdjustmentValues["direction"] })}><option value="increase">Increase stock</option><option value="decrease">Decrease stock</option></select></label>
              <label>Quantity<input required inputMode="decimal" value={adjustment.quantity} onChange={(event) => setAdjustment({ ...adjustment, quantity: event.currentTarget.value })} placeholder="0" /></label>
              <label>Lot code<input maxLength={40} value={adjustment.lotCode} disabled={adjustment.direction !== "increase"} onChange={(event) => setAdjustment({ ...adjustment, lotCode: event.currentTarget.value })} /></label>
              <label>Location code<input maxLength={20} value={adjustment.locationCode} onChange={(event) => setAdjustment({ ...adjustment, locationCode: event.currentTarget.value })} /></label>
              <label className="inventory-item-field-wide">Reason<input required minLength={3} value={adjustment.note} onChange={(event) => setAdjustment({ ...adjustment, note: event.currentTarget.value })} /></label>
            </div>
            <button className="shell-button" type="submit" disabled={busy || items.every((item) => item.kind === "service")}>{busy ? "Saving…" : "Record adjustment"}</button>
          </>}
        </form>
      </div>
    </section>
  );
}
