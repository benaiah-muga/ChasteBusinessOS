import { useMemo, useState } from "react";
import {
  lookupInventoryBarcode,
  submitInventoryCycleCountAction,
  type InventoryCycleCountAction,
  type InventoryCycleCountRetryScope,
} from "../api/inventory-cycle-count";
import type { InventoryCycleCount, InventoryItem, InventoryLocation } from "../api/inventory";

function parseCountedThousandths(value: string): number | null {
  const match = /^(?:(\d+)(?:\.(\d{0,3}))?|\.(\d{1,3}))$/.exec(value.trim());
  if (!match) return null;
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? match[3] ?? "";
  const thousandths = Number(`${whole}${fraction.padEnd(3, "0")}`);
  return Number.isSafeInteger(thousandths) ? thousandths : null;
}
import "./inventory-cycle-count-panel.css";

type Notice = { tone: "success" | "pending" | "error"; text: string };

export interface InventoryCycleCountPanelProps {
  items: InventoryItem[];
  locations: InventoryLocation[];
  counts: InventoryCycleCount[];
  onChanged: () => void | Promise<void>;
  retryScope?: InventoryCycleCountRetryScope;
}

export function InventoryCycleCountPanel({ items, locations, counts, onChanged, retryScope }: InventoryCycleCountPanelProps) {
  const [countAllItems, setCountAllItems] = useState(true);
  const [selectedSkus, setSelectedSkus] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [barcode, setBarcode] = useState("");
  const [locationId, setLocationId] = useState("");
  const [note, setNote] = useState("Scheduled cycle count");
  const [entries, setEntries] = useState<Record<string, string>>({});
  const [reviewCount, setReviewCount] = useState<InventoryCycleCount | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const countableItems = useMemo(() => items.filter((item) => item.kind !== "service"), [items]);
  const matchingItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return countableItems
      .filter((item) => !query || `${item.name} ${item.sku}`.toLocaleLowerCase().includes(query))
      .slice(0, 12);
  }, [countableItems, search]);
  const itemBySku = useMemo(() => new Map(items.map((item) => [item.sku, item] as const)), [items]);

  async function submit(input: InventoryCycleCountAction, label: string): Promise<boolean> {
    setBusy(true);
    setNotice(null);
    try {
      const result = await submitInventoryCycleCountAction(input, undefined, undefined, retryScope);
      if (result.kind === "pending") {
        setNotice({ tone: "pending", text: `${label} requires approval.` });
        return false;
      }
      setNotice({ tone: "success", text: `${label} done.` });
      await onChanged();
      return true;
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : `${label} failed. Try again.`,
      });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addBarcode(): Promise<void> {
    const code = barcode.trim();
    if (code.length < 3) return;
    setBusy(true);
    setNotice(null);
    try {
      const item = await lookupInventoryBarcode(code);
      if (!item) {
        setNotice({ tone: "error", text: "No item carries that barcode. Check the code or add a barcode in Products & Services." });
        return;
      }
      setSelectedSkus((current) => current.includes(item.sku) ? current : [...current, item.sku]);
      setCountAllItems(false);
      setSearch("");
      setBarcode("");
      setNotice({ tone: "success", text: `${item.name} added to this count.` });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Barcode lookup failed. Try again." });
    } finally {
      setBusy(false);
    }
  }

  async function recordCount(countId: string, sku: string, value: string | undefined): Promise<void> {
    if (value === undefined) return;
    if (value.trim() === "") {
      setNotice({ tone: "error", text: "Enter a counted quantity. Use 0 only when no stock is present." });
      return;
    }
    const countedThousandths = parseCountedThousandths(value);
    if (countedThousandths === null) {
      setNotice({ tone: "error", text: "Enter a non-negative quantity with up to 3 decimal places." });
      return;
    }
    const ok = await submit({
      action: "recordCycleCounts",
      countId,
      counts: [{ sku, countedThousandths }],
    }, `Record ${sku}`);
    if (ok) setEntries((current) => ({ ...current, [`${countId}:${sku}`]: "" }));
  }

  return (
    <section className="inventory-cycle-count" aria-labelledby="cycle-count-title">
      <h2 id="cycle-count-title">Set up a stock count</h2>
      {notice && <p className={`inventory-cycle-count-notice is-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}
      {countableItems.length === 0 ? (
        <p className="inventory-cycle-count-muted">Add stocked items before counting. Services do not use stock counts. Add a product with an opening balance, then return here to count it.</p>
      ) : (
        <div className="inventory-cycle-count-setup">
          <label>Count location
            <select aria-label="Count location" value={locationId} onChange={(event) => setLocationId(event.target.value)}>
              <option value="">All locations</option>
              {locations.map((location) => <option key={location.id} value={location.id}>{location.name} · {location.code}</option>)}
            </select>
            <span>A location count compares stock recorded in that location.</span>
          </label>
          <label className="inventory-cycle-count-checkbox">
            <input type="checkbox" checked={countAllItems} onChange={(event) => setCountAllItems(event.target.checked)} />
            Count every stocked item{locationId ? " in this location" : " across all locations"}
          </label>
          {!countAllItems && <div className="inventory-cycle-count-picker">
            <label>Scan an item or search by name / SKU
              <span className="inventory-cycle-count-scan">
                <input value={barcode} onChange={(event) => setBarcode(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void addBarcode(); } }} placeholder="Scan barcode" aria-label="Scan a barcode into the count" />
                <button type="button" disabled={busy || barcode.trim().length < 3} onClick={() => void addBarcode()}>Add scan</button>
              </span>
            </label>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a product" aria-label="Search products for this count" />
            {search.trim() && <ul aria-label="Matching products">
              {matchingItems.length === 0 ? <li className="inventory-cycle-count-muted">No matching products.</li> : matchingItems.map((item) => {
                const selected = selectedSkus.includes(item.sku);
                return <li key={item.sku}><button type="button" aria-pressed={selected} onClick={() => setSelectedSkus((current) => selected ? current.filter((sku) => sku !== item.sku) : [...current, item.sku])}><span><strong>{item.name}</strong><small>{item.sku}</small></span><span>{selected ? "Added" : "Add"}</span></button></li>;
              })}
            </ul>}
            <div className="inventory-cycle-count-selected" aria-live="polite">
              <span>{selectedSkus.length} selected</span>
              {selectedSkus.map((sku) => <button key={sku} type="button" aria-label={`Remove ${sku}`} onClick={() => setSelectedSkus((current) => current.filter((value) => value !== sku))}>{sku} <span aria-hidden="true">×</span></button>)}
              {selectedSkus.length > 0 && <button type="button" className="inventory-cycle-count-clear" onClick={() => setSelectedSkus([])}>Clear</button>}
            </div>
          </div>}
          <label>Count reason or reference
            <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} placeholder="Scheduled count, aisle check..." />
          </label>
          <div className="inventory-cycle-count-start">
            <p>Expected quantities are snapshotted. If stock moves while you count, the sheet asks you to start a fresh count.</p>
            <button type="button" disabled={busy || note.trim().length < 3 || (!countAllItems && selectedSkus.length === 0)} onClick={() => void submit({
              action: "createCycleCount",
              ...(countAllItems ? {} : { skus: selectedSkus }),
              ...(locationId ? { locationId } : {}),
              note: note.trim(),
            }, "Open stock count")}>Start count sheet</button>
          </div>
        </div>
      )}

      {counts.length === 0 && countableItems.length > 0 && <p className="inventory-cycle-count-muted">No count sheets yet. Start a location or item count above. Open sheets keep progress until you review and post the differences.</p>}
      <div className="inventory-cycle-count-list">
        {counts.map((count) => {
          const countedLines = count.lines.filter((line) => line.countedThousandths !== null).length;
          const allCounted = countedLines === count.lines.length;
          const varianceLines = count.lines.filter((line) => (line.varianceThousandths ?? 0) !== 0);
          return <article className="inventory-cycle-count-sheet" key={count.id}>
            <header><h3>Count of {formatDate(count.createdAt)}{count.locationCode ? ` · ${count.locationCode}` : " · all locations"}</h3><span>{count.status}</span></header>
            <div className="inventory-cycle-count-progress">
              <div><strong>{countedLines} of {count.lines.length} items counted</strong><span>{count.note || "No reason recorded"}</span></div>
              <progress value={countedLines} max={Math.max(1, count.lines.length)} aria-label={`${countedLines} of ${count.lines.length} items counted`} />
            </div>
            <ul className="inventory-cycle-count-lines" aria-label="Count lines">
              {count.lines.map((line) => {
                const key = `${count.id}:${line.sku}`;
                const item = itemBySku.get(line.sku);
                const entry = entries[key] ?? (line.countedThousandths === null ? "" : quantity(line.countedThousandths));
                return <li key={line.sku}>
                  <div className="inventory-cycle-count-line-heading"><strong>{item?.name ?? line.sku}</strong><small>{line.sku}</small><span>Expected: {quantity(line.expectedThousandths, item?.unitLabel)}</span></div>
                  {count.status === "open" && <div className="inventory-cycle-count-entry">
                    <label>Counted quantity
                      <input type="number" min="0" step="0.001" inputMode="decimal" placeholder="Enter count" value={entry} onChange={(event) => setEntries((current) => ({ ...current, [key]: event.target.value }))} />
                    </label>
                    <button type="button" disabled={busy || entries[key] === undefined} onClick={() => void recordCount(count.id, line.sku, entries[key])}>Save</button>
                  </div>}
                  <div className="inventory-cycle-count-variance">
                    <span>Counted: {line.countedThousandths === null ? "-" : quantity(line.countedThousandths, item?.unitLabel)}</span>
                    <span>Difference: {line.varianceThousandths === null ? "-" : `${line.varianceThousandths > 0 ? "+" : ""}${quantity(line.varianceThousandths, item?.unitLabel)}`}</span>
                  </div>
                </li>;
              })}
            </ul>
            {count.status === "open" && <footer>
              <p>{allCounted ? `${varianceLines.length} stock adjustment${varianceLines.length === 1 ? "" : "s"} to review.` : `Count every item before posting. ${count.lines.length - countedLines} remain.`}</p>
              <div>
                <button type="button" disabled={busy || !allCounted} onClick={() => setReviewCount(count)}>Review &amp; post</button>
                <button type="button" className="inventory-cycle-count-secondary" disabled={busy} onClick={() => void submit({ action: "cancelCycleCount", countId: count.id }, "Cancel count")}>Cancel count</button>
              </div>
            </footer>}
          </article>;
        })}
      </div>

      {reviewCount && <div className="inventory-cycle-count-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setReviewCount(null); }}>
        <section className="inventory-cycle-count-dialog" role="dialog" aria-modal="true" aria-labelledby="cycle-count-review-title" aria-describedby="cycle-count-review-description">
          <header><h3 id="cycle-count-review-title">Review stock adjustments</h3><button type="button" aria-label="Close review" onClick={() => setReviewCount(null)}>×</button></header>
          <p id="cycle-count-review-description">Check every difference before the stock ledger is updated.</p>
          <div className="inventory-cycle-count-review-reason"><strong>Reason:</strong> {reviewCount.note || "No reason recorded"}<br /><strong>Items counted:</strong> {reviewCount.lines.length} · <strong>Location:</strong> {reviewCount.locationCode ?? "All locations"}</div>
          {reviewCount.lines.filter((line) => (line.varianceThousandths ?? 0) !== 0).length === 0
            ? <p className="inventory-cycle-count-no-adjustments">All counted quantities match the snapshot. No stock adjustments will be posted.</p>
            : <ul className="inventory-cycle-count-review-lines">{reviewCount.lines.filter((line) => (line.varianceThousandths ?? 0) !== 0).map((line) => {
              const item = itemBySku.get(line.sku);
              return <li key={line.sku}><span><strong>{item?.name ?? line.sku}</strong><small>{line.sku} · {quantity(line.expectedThousandths, item?.unitLabel)} expected, {line.countedThousandths === null ? "not counted" : `${quantity(line.countedThousandths, item?.unitLabel)} counted`}</small></span><b>{(line.varianceThousandths ?? 0) > 0 ? "+" : ""}{quantity(line.varianceThousandths ?? 0, item?.unitLabel)}</b></li>;
            })}</ul>}
          <footer>
            <button type="button" className="inventory-cycle-count-secondary" onClick={() => setReviewCount(null)}>Back to count</button>
            <button type="button" disabled={busy} onClick={() => void submit({ action: "postCycleCount", countId: reviewCount.id }, "Post count adjustments").then((ok) => ok && setReviewCount(null))}>Post to stock ledger</button>
          </footer>
        </section>
      </div>}
    </section>
  );
}

function formatDate(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? "Date unavailable" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

function quantity(thousandths: number, unit = "unit"): string {
  const amount = thousandths / 1000;
  const formatted = amount.toLocaleString(undefined, { maximumFractionDigits: 3 });
  const plural = new Intl.PluralRules().select(amount) !== "one";
  const label = plural && !unit.endsWith("s") ? `${unit}s` : unit;
  return `${formatted} ${label}`;
}
