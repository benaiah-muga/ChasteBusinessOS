import { useCallback, useEffect, useMemo, useState } from "react";
import { currencyMinorUnits } from "@chaste/erp-core";
import { fetchInventoryEnabled, fetchInventoryReport, InventoryApiError, type InventoryCycleCount, type InventoryItem, type InventoryLocation, type InventoryLot } from "../api/inventory";
import { legacyUrl } from "../legacy";
import "./inventory-page.css";

type PageState =
  | { status: "loading" }
  | { status: "disabled" }
  | { status: "failed"; error: InventoryApiError }
  | { status: "ready"; items: InventoryItem[]; totalValueMinor: number; locations: InventoryLocation[]; lots: InventoryLot[]; cycleCounts: InventoryCycleCount[] };

type ItemFilter = "all" | "reorder";
const CURRENCY_PREFERENCES = ["org", "USD", "KES", "EUR", "GBP", "TZS", "UGX"];

function displayCurrency(baseCurrency: string | null): string {
  let preference: string | null = null;
  try {
    const cookie = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("chaste_display_currency="));
    if (cookie) {
      const value = decodeURIComponent(cookie.slice("chaste_display_currency=".length));
      if (CURRENCY_PREFERENCES.includes(value)) preference = value;
    }
  } catch { /* A blocked cookie leaves the saved device setting available. */ }
  if (!preference) {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem("chaste-prefs") ?? "null");
      if (stored && typeof stored === "object" && "currency" in stored && typeof stored.currency === "string" && CURRENCY_PREFERENCES.includes(stored.currency)) preference = stored.currency;
    } catch { /* Invalid local preferences fall back to the active organization. */ }
  }
  return !preference || preference === "org" ? baseCurrency ?? "USD" : preference;
}

function formatMoney(minor: number, currency: string): string {
  const minorUnits = currencyMinorUnits(currency) ?? 2;
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    minimumFractionDigits: minorUnits,
    maximumFractionDigits: minorUnits,
  }).format(minor / (10 ** minorUnits));
}

function formatQuantity(thousandths: number, unit: string): string {
  const quantity = thousandths / 1000;
  const value = quantity.toLocaleString("en", { maximumFractionDigits: 3 });
  const label = new Intl.PluralRules("en").select(quantity) === "one" || unit.endsWith("s") ? unit : `${unit}s`;
  return `${value} ${label}`;
}

function formatLotExpiry(expiresAt: string | null): string {
  if (!expiresAt) return "No expiry date";
  const timestamp = Date.parse(expiresAt);
  return Number.isNaN(timestamp) ? "Expiry date unavailable" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(timestamp);
}

function formatCountDate(createdAt: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(createdAt));
}

export function InventoryPage({ baseCurrency = null }: { baseCurrency?: string | null }) {
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ItemFilter>("all");
  const currency = useMemo(() => displayCurrency(baseCurrency), [baseCurrency]);

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ status: "loading" });
    try {
      const enabled = await fetchInventoryEnabled(signal);
      if (signal?.aborted) return;
      if (!enabled) {
        setState({ status: "disabled" });
        return;
      }
      const report = await fetchInventoryReport(signal);
      if (!signal?.aborted) setState({ status: "ready", ...report });
    } catch (error) {
      if (signal?.aborted) return;
      setState({
        status: "failed",
        error: error instanceof InventoryApiError
          ? error
          : new InventoryApiError(0, "Could not reach the inventory service. Check your connection and try again."),
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const filteredItems = useMemo(() => {
    if (state.status !== "ready") return [];
    const query = search.trim().toLocaleLowerCase();
    return state.items.filter((item) => {
      if (filter === "reorder" && !item.reorderNeeded) return false;
      return !query || `${item.sku} ${item.name} ${item.kind}`.toLocaleLowerCase().includes(query);
    });
  }, [filter, search, state]);
  const lots = state.status === "ready" ? state.lots : [];
  const unitLabelBySku = new Map(state.status === "ready" ? state.items.map((item) => [item.sku, item.unitLabel] as const) : []);
  const showLotBalance = lots.some((lot) => lot.balanceThousandths !== undefined);
  const cycleCounts = state.status === "ready" ? state.cycleCounts : [];

  return (
    <main className="inventory-page">
      <header className="inventory-page-header">
        <div>
          <p className="inventory-eyebrow">Operations · preview</p>
          <h1>Inventory</h1>
          <p>Review stock availability, reorder needs, lot details, and stock locations. Adjustments, transfers, and cycle counts stay in the full inventory workspace.</p>
        </div>
        <a className="inventory-full-workspace" href={legacyUrl("/inventory")}>Open full inventory workspace</a>
      </header>

      {state.status === "loading" && <p className="inventory-loading" role="status">Loading stock levels…</p>}
      {state.status === "disabled" && (
        <section className="inventory-empty" role="status">
          <h2>Inventory is turned off</h2>
          <p>Ask a workspace administrator to enable the Inventory module before viewing stock.</p>
        </section>
      )}
      {state.status === "failed" && (
        <section className="inventory-error" role="alert" aria-labelledby="inventory-error-title">
          <div>
            <p className="inventory-eyebrow">Inventory unavailable</p>
            <h2 id="inventory-error-title">{state.error.status === 403 || state.error.message.startsWith("forbidden:") ? "Access denied" : "Could not load stock levels"}</h2>
            <p>{state.error.message}</p>
          </div>
          <div className="inventory-error-actions">
            {state.error.status === 401 && <a href="/login">Sign in again</a>}
            <button type="button" onClick={() => void load()}>Try again</button>
          </div>
        </section>
      )}
      {state.status === "ready" && state.items.length === 0 && (
        <section className="inventory-empty" role="status">
          <h2>No inventory items yet</h2>
          <p>Items will appear here once they are added to your catalog.</p>
        </section>
      )}
      {state.status === "ready" && state.items.length > 0 && (
        <>
          <section className="inventory-metrics" aria-label="Inventory summary">
            <article><span>Stock value</span><strong>{formatMoney(state.totalValueMinor, currency)}</strong></article>
            <article><span>Items tracked</span><strong>{state.items.length.toLocaleString()}</strong></article>
            <article><span>Need reorder</span><strong>{state.items.filter((item) => item.reorderNeeded).length.toLocaleString()}</strong></article>
          </section>
          <div className="inventory-tools">
            <div className="inventory-filters" role="group" aria-label="Filter inventory items">
              <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All items</button>
              <button type="button" aria-pressed={filter === "reorder"} onClick={() => setFilter("reorder")}>Reorder needed</button>
            </div>
            <label className="inventory-search">
              <span>Find an item</span>
              <input type="search" value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="SKU, name, or item type" />
            </label>
          </div>
          {filteredItems.length === 0 ? (
            <section className="inventory-empty" role="status"><h2>No items match</h2><p>Try another search or show all items.</p></section>
          ) : (
            <section className="inventory-table-card" aria-label="Inventory stock levels">
              <div className="inventory-table-scroll">
                <table className="inventory-table">
                  <thead><tr><th scope="col">SKU</th><th scope="col">Item</th><th scope="col">On hand</th><th scope="col">Reserved</th><th scope="col">Available</th><th scope="col">Reorder</th><th scope="col">Stock value</th></tr></thead>
                  <tbody>{filteredItems.map((item) => (
                    <tr key={item.sku}>
                      <th scope="row">{item.sku}</th>
                      <td>{item.name}<span className="inventory-kind">{item.kind}</span></td>
                      <td>{formatQuantity(item.onHandThousandths, item.unitLabel)}</td>
                      <td>{formatQuantity(item.reservedThousandths, item.unitLabel)}</td>
                      <td>{formatQuantity(item.availableThousandths, item.unitLabel)}</td>
                      <td><span className={`inventory-status${item.reorderNeeded ? " inventory-status-low" : ""}`}>{item.reorderNeeded ? "Reorder" : "Stocked"}</span></td>
                      <td className="inventory-value">{formatMoney(item.totalValueMinor, currency)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
      {state.status === "ready" && (
        <section className="inventory-lots" aria-labelledby="inventory-lots-title">
          <div className="inventory-lots-heading">
            <div>
              <p className="inventory-eyebrow">Read only</p>
              <h2 id="inventory-lots-title">Inventory lots</h2>
            </div>
            <p>Lot details are shown as returned by the inventory service.</p>
          </div>
          {lots.length === 0 ? (
            <p className="inventory-empty inventory-lots-empty" role="status">No inventory lots recorded yet.</p>
          ) : (
            <div className="inventory-table-card" aria-label="Inventory lots">
              <div className="inventory-table-scroll">
                <table className="inventory-table">
                  <thead>
                    <tr>
                      <th scope="col">SKU</th>
                      <th scope="col">Lot code</th>
                      <th scope="col">Expiry date</th>
                      {showLotBalance && <th scope="col">Current balance</th>}
                    </tr>
                  </thead>
                  <tbody>{lots.map((lot) => (
                      <tr key={lot.id}>
                        <th scope="row">{lot.sku || "SKU unavailable"}</th>
                        <td>{lot.lotCode}</td>
                        <td>{formatLotExpiry(lot.expiresAt)}</td>
                        {showLotBalance && <td>{lot.balanceThousandths === undefined ? "Not provided" : formatQuantity(lot.balanceThousandths, unitLabelBySku.get(lot.sku) ?? "units")}</td>}
                      </tr>
                    ))}</tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}
      {state.status === "ready" && (
        <section className="inventory-lots" aria-labelledby="inventory-cycle-counts-title">
          <div className="inventory-lots-heading">
            <div>
              <p className="inventory-eyebrow">Read only</p>
              <h2 id="inventory-cycle-counts-title">Cycle count history</h2>
            </div>
            <p>Review recorded counts here. Start, update, and post counts in the full inventory workspace.</p>
          </div>
          {cycleCounts.length === 0 ? (
            <p className="inventory-empty inventory-lots-empty" role="status">No cycle counts recorded yet.</p>
          ) : (
            <div className="inventory-cycle-count-list">
              {cycleCounts.map((count) => {
                const countedLines = count.lines.filter((line) => line.countedThousandths !== null).length;
                const headingId = `inventory-cycle-count-${count.id}`;
                return (
                  <article className="inventory-table-card" key={count.id} aria-labelledby={headingId}>
                    <div className="inventory-cycle-count-heading">
                      <div>
                        <h3 id={headingId}>Count of {formatCountDate(count.createdAt)}</h3>
                        <p>{count.locationCode ?? "All locations"}{count.note ? ` · ${count.note}` : " · No reason recorded"}</p>
                      </div>
                      <span className="inventory-status">{count.status}</span>
                    </div>
                    <p className="inventory-cycle-count-progress" role="status">{countedLines} of {count.lines.length} items counted</p>
                    {count.lines.length === 0 ? (
                      <p className="inventory-empty inventory-lots-empty">This count has no item lines.</p>
                    ) : (
                      <div className="inventory-table-scroll">
                        <table className="inventory-table">
                          <thead><tr><th scope="col">SKU</th><th scope="col">Expected</th><th scope="col">Counted</th><th scope="col">Variance</th></tr></thead>
                          <tbody>{count.lines.map((line) => {
                            const unit = unitLabelBySku.get(line.sku) ?? "units";
                            return (
                              <tr key={`${count.id}:${line.sku}`}>
                                <th scope="row">{line.sku}</th>
                                <td>{formatQuantity(line.expectedThousandths, unit)}</td>
                                <td>{line.countedThousandths === null ? "Not counted" : formatQuantity(line.countedThousandths, unit)}</td>
                                <td>{line.varianceThousandths === null ? "Not available" : `${line.varianceThousandths > 0 ? "+" : ""}${formatQuantity(line.varianceThousandths, unit)}`}</td>
                              </tr>
                            );
                          })}</tbody>
                        </table>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}
      {state.status === "ready" && (
        <section className="inventory-lots" aria-labelledby="inventory-locations-title">
          <div className="inventory-lots-heading">
            <div>
              <p className="inventory-eyebrow">Read only</p>
              <h2 id="inventory-locations-title">Stock locations</h2>
            </div>
            <p>Location records are shown as returned by the inventory service.</p>
          </div>
          {state.locations.length === 0 ? (
            <p className="inventory-empty inventory-lots-empty" role="status">No stock locations recorded yet.</p>
          ) : (
            <div className="inventory-table-card" aria-label="Stock locations">
              <div className="inventory-table-scroll">
                <table className="inventory-table">
                  <thead>
                    <tr><th scope="col">Location code</th><th scope="col">Location name</th></tr>
                  </thead>
                  <tbody>{state.locations.map((location) => (
                    <tr key={location.id}>
                      <th scope="row">{location.code}</th>
                      <td>{location.name}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
