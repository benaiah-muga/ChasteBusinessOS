import { useEffect, useRef, useState, type FormEvent } from "react";
import { currencyMinorUnits } from "@chaste/erp-core";
import { type InventoryItem } from "../api/inventory";
import { getPendingInventoryAdjustment, InventoryItemActionError, submitInventoryItemAction as submitItemAction, type InventoryAdjustmentRetryScope, type InventoryItemActionResult } from "../api/inventory-items";
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
type RetryState = "loading" | "clear" | "unresolved" | "failed";

function goItemWritesEnabled(): boolean {
  return typeof __GO_INVENTORY_ITEM_SLICE__ !== "undefined" && __GO_INVENTORY_ITEM_SLICE__;
}

function adjustmentValuesFromAction(action: { sku: string; quantityDelta: number; note: string; lotCode?: string; locationCode?: string }): AdjustmentValues {
  const quantity = (Math.abs(action.quantityDelta) / 1000).toFixed(3).replace(/\.?0+$/, "");
  return {
    sku: action.sku,
    direction: action.quantityDelta < 0 ? "decrease" : "increase",
    quantity,
    note: action.note,
    lotCode: action.lotCode ?? "",
    locationCode: action.locationCode ?? "",
  };
}

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
  retryScope,
}: {
  items: InventoryItem[];
  currency?: string;
  onChanged: () => void | Promise<void>;
  retryScope?: InventoryAdjustmentRetryScope;
}) {
  const [form, setForm] = useState<FormValues>(blankForm);
  const [adjustment, setAdjustment] = useState<AdjustmentValues>({ sku: "", direction: "increase", quantity: "", note: "", lotCode: "", locationCode: "" });
  const [retryState, setRetryState] = useState<RetryState>(() => goItemWritesEnabled() ? "loading" : "clear");
  const [retryStateScopeIdentity, setRetryStateScopeIdentity] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const minorUnits = currencyMinorUnits(currency) ?? 2;
  const retryScopeIdentity = `${retryScope?.actorId?.trim() ?? ""}:${retryScope?.organizationId?.trim() ?? ""}`;
  const retryScopeIdentityRef = useRef(retryScopeIdentity);
  retryScopeIdentityRef.current = retryScopeIdentity;
  const retryScopeChecked = retryStateScopeIdentity === retryScopeIdentity;
  const retryBlockedByRoute = retryState === "unresolved" && !goItemWritesEnabled();

  useEffect(() => {
    setBusy(false);
    setRetryState("loading");
    setRetryStateScopeIdentity(null);
    setNotice(null);
    const actorId = retryScope?.actorId?.trim();
    const organizationId = retryScope?.organizationId?.trim();
    if (!actorId || !organizationId) {
      setRetryState("failed");
      setNotice({ tone: "pending", message: "Loading the active workspace before stock adjustments are available." });
      return;
    }
    let active = true;
    setRetryState("loading");
    setAdjustment({ sku: "", direction: "increase", quantity: "", note: "", lotCode: "", locationCode: "" });
    void getPendingInventoryAdjustment({ actorId, organizationId }).then((action) => {
      if (!active) return;
      setRetryStateScopeIdentity(retryScopeIdentity);
      if (action) {
        setAdjustment(adjustmentValuesFromAction(action));
        setRetryState("unresolved");
        setNotice({ tone: "pending", message: "A stock adjustment is unresolved. Retry the saved adjustment to confirm its outcome." });
      } else {
        setRetryState("clear");
        setNotice(null);
      }
    }).catch((error: unknown) => {
      if (!active) return;
      setRetryState("failed");
      setNotice({ tone: "error", message: error instanceof InventoryItemActionError ? error.message : "Stock adjustment retry recovery is unavailable." });
    });
    return () => { active = false; };
  }, [retryScopeIdentity]);

  async function recoverAdjustmentRetryState(terminal: boolean, expectedScopeIdentity: string): Promise<void> {
    if (retryScopeIdentityRef.current !== expectedScopeIdentity) return;
    if (terminal) {
      setRetryState("clear");
      setRetryStateScopeIdentity(expectedScopeIdentity);
      return;
    }
    try {
      const action = await getPendingInventoryAdjustment(retryScope ?? { actorId: null, organizationId: null });
      if (retryScopeIdentityRef.current !== expectedScopeIdentity) return;
      setRetryStateScopeIdentity(expectedScopeIdentity);
      if (action) {
        setAdjustment(adjustmentValuesFromAction(action));
        setRetryState("unresolved");
      } else {
        setRetryState("clear");
      }
    } catch {
      if (retryScopeIdentityRef.current !== expectedScopeIdentity) return;
      setRetryState("failed");
    }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submittedScopeIdentity = retryScopeIdentity;
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
      if (retryScopeIdentityRef.current !== submittedScopeIdentity) return;
      if (created.kind === "pending") {
        setNotice({ tone: "pending", message: created.reason });
        return;
      }
    } catch (error) {
      if (retryScopeIdentityRef.current !== submittedScopeIdentity) return;
      if (error instanceof InventoryItemActionError && error.status === 0) await onChanged();
      if (retryScopeIdentityRef.current !== submittedScopeIdentity) return;
      setNotice({ tone: "error", message: error instanceof InventoryItemActionError ? error.message : "The inventory action could not be completed." });
      return;
    } finally {
      if (retryScopeIdentityRef.current === submittedScopeIdentity) setBusy(false);
    }

    if (retryScopeIdentityRef.current !== submittedScopeIdentity) return;
    await onChanged();
    if (retryScopeIdentityRef.current !== submittedScopeIdentity) return;
    setForm(blankForm());
    if (openingQuantity > 0 && form.kind === "goods") {
      setBusy(true);
      try {
        const opening = await submitItemAction({
          action: "adjustStock",
          sku: form.sku.trim(),
          quantityDelta: openingQuantity,
          note: "Opening stock",
        }, undefined, retryScope);
        if (retryScopeIdentityRef.current !== submittedScopeIdentity) return;
        if (opening.kind === "pending") {
          setAdjustment(adjustmentValuesFromAction({ sku: form.sku.trim(), quantityDelta: openingQuantity, note: "Opening stock" }));
          setRetryState(goItemWritesEnabled() ? "unresolved" : "clear");
          setNotice({ tone: "pending", message: "Item created. Opening stock is waiting for approval." });
        } else {
          await onChanged();
          if (retryScopeIdentityRef.current !== submittedScopeIdentity) return;
          setNotice({ tone: "success", message: "Item created and opening stock recorded." });
        }
      } catch (error) {
        if (retryScopeIdentityRef.current !== submittedScopeIdentity) return;
        await onChanged();
        if (retryScopeIdentityRef.current !== submittedScopeIdentity) return;
        await recoverAdjustmentRetryState(error instanceof InventoryItemActionError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429, submittedScopeIdentity);
        setNotice({ tone: "error", message: `Item created, but opening stock could not be recorded: ${error instanceof InventoryItemActionError ? error.message : "check the current stock before retrying."}` });
      } finally {
        if (retryScopeIdentityRef.current === submittedScopeIdentity) setBusy(false);
      }
      return;
    }
    setNotice({ tone: "success", message: "Item created." });
  }

  async function handleAdjustment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submittedScopeIdentity = retryScopeIdentity;
    if (!retryScopeChecked || (retryState !== "clear" && retryState !== "unresolved")) return;
    const quantity = scaledInteger(adjustment.quantity, 3);
    if (quantity === null || quantity <= 0) {
      setNotice({ tone: "error", message: "Enter a stock quantity greater than zero with no more than 3 decimal places." });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const action = {
        action: "adjustStock",
        sku: adjustment.sku,
        quantityDelta: adjustment.direction === "increase" ? quantity : -quantity,
        note: adjustment.note.trim(),
        ...(adjustment.lotCode.trim() && adjustment.direction === "increase" ? { lotCode: adjustment.lotCode.trim() } : {}),
        ...(adjustment.locationCode.trim() ? { locationCode: adjustment.locationCode.trim() } : {}),
      } as const;
      const result = await submitItemAction(action, undefined, retryScope);
      if (retryScopeIdentityRef.current !== submittedScopeIdentity) return;
      if (result.kind === "pending") {
        setRetryState(goItemWritesEnabled() ? "unresolved" : "clear");
        setNotice({ tone: "pending", message: result.reason });
        return;
      }
      setRetryState("clear");
      await onChanged();
      if (retryScopeIdentityRef.current !== submittedScopeIdentity) return;
      setAdjustment((current) => ({ ...current, quantity: "", note: "", lotCode: "" }));
      setNotice({ tone: "success", message: "Stock adjustment recorded." });
    } catch (error) {
      if (retryScopeIdentityRef.current !== submittedScopeIdentity) return;
      await recoverAdjustmentRetryState(error instanceof InventoryItemActionError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429, submittedScopeIdentity);
      if (retryScopeIdentityRef.current !== submittedScopeIdentity) return;
      if (error instanceof InventoryItemActionError && error.status === 0) await onChanged();
      if (retryScopeIdentityRef.current !== submittedScopeIdentity) return;
      setNotice({ tone: "error", message: error instanceof InventoryItemActionError ? error.message : "The stock adjustment could not be completed." });
    } finally {
      if (retryScopeIdentityRef.current === submittedScopeIdentity) setBusy(false);
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
              <label className="inventory-item-field-wide">Item<select required value={adjustment.sku} disabled={busy || !retryScopeChecked || retryState !== "clear"} onChange={(event) => setAdjustment({ ...adjustment, sku: event.currentTarget.value })}><option value="">Choose an item</option>{adjustment.sku && !items.some((item) => item.sku === adjustment.sku) && <option value={adjustment.sku}>{adjustment.sku} · saved adjustment</option>}{items.filter((item) => item.kind !== "service").map((item) => <option key={item.sku} value={item.sku}>{item.sku} · {item.name}</option>)}</select></label>
              <label>Direction<select value={adjustment.direction} disabled={busy || !retryScopeChecked || retryState !== "clear"} onChange={(event) => setAdjustment({ ...adjustment, direction: event.currentTarget.value as AdjustmentValues["direction"] })}><option value="increase">Increase stock</option><option value="decrease">Decrease stock</option></select></label>
              <label>Quantity<input required inputMode="decimal" value={adjustment.quantity} disabled={busy || !retryScopeChecked || retryState !== "clear"} onChange={(event) => setAdjustment({ ...adjustment, quantity: event.currentTarget.value })} placeholder="0" /></label>
              <label>Lot code<input maxLength={40} value={adjustment.lotCode} disabled={busy || !retryScopeChecked || retryState !== "clear" || adjustment.direction !== "increase"} onChange={(event) => setAdjustment({ ...adjustment, lotCode: event.currentTarget.value })} /></label>
              <label>Location code<input maxLength={20} value={adjustment.locationCode} disabled={busy || !retryScopeChecked || retryState !== "clear"} onChange={(event) => setAdjustment({ ...adjustment, locationCode: event.currentTarget.value })} /></label>
              <label className="inventory-item-field-wide">Reason<input required minLength={3} value={adjustment.note} disabled={busy || !retryScopeChecked || retryState !== "clear"} onChange={(event) => setAdjustment({ ...adjustment, note: event.currentTarget.value })} /></label>
            </div>
            <button className="shell-button" type="submit" disabled={busy || !retryScopeChecked || retryState === "loading" || retryState === "failed" || retryBlockedByRoute || items.every((item) => item.kind === "service")}>{retryBlockedByRoute ? "Restore Go writes to retry" : busy ? "Saving…" : retryState === "unresolved" ? "Retry saved adjustment" : "Record adjustment"}</button>
          </>}
        </form>
      </div>
    </section>
  );
}
