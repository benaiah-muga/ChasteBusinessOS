import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchProductDefaults, fetchProducts, fetchProductsEnabled, goProductImportEnabled, importProducts, ProductsApiError, recoverProductImport, restoreProductImport, submitProductAction, undoProductImport, type Product, type ProductAction, type ProductImportResult, type ProductImportRetryScope, type ProductImportRow } from "../api/products";
import "./ProductsPage.css";

type Tab = "overview" | "catalog" | "new";
type Notice = { kind: "success" | "pending" | "error"; text: string };
type Draft = { sku: string; name: string; kind: "goods" | "service"; unitLabel: string; price: string; reorder: string; opening: string; barcode: string; imageUrl: string; tags: string };
const importFields = [
  { id: "sku", label: "SKU", aliases: ["sku", "item code", "product code", "service code"] },
  { id: "name", label: "Name", aliases: ["name", "product", "product name", "item", "item name", "service"] },
  { id: "type", label: "Product or service", aliases: ["type", "kind", "item type"] },
  { id: "unit", label: "Unit", aliases: ["unit", "unit label", "uom"] },
  { id: "salePrice", label: "Sale price", aliases: ["sale price", "saleprice", "price", "unit price"] },
  { id: "barcode", label: "Barcode", aliases: ["barcode", "ean", "upc"] },
  { id: "tags", label: "Tags", aliases: ["tags", "category", "categories"] },
] as const;
const emptyDraft: Draft = { sku: "", name: "", kind: "goods", unitLabel: "", price: "", reorder: "", opening: "", barcode: "", imageUrl: "", tags: "" };
const moneyMinor = (minor: number, currency: string) => new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100);
const quantity = (thousandths: number) => (thousandths / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 });
const parseDecimal = (value: string, places: number): number | null => {
  const normalized = value.trim();
  if (normalized) {
    const parts = normalized.split(".");
    if (parts.length > 2 || parts.some((part) => part && !/^\d+$/.test(part)) || (parts[1]?.length ?? 0) > places || (!parts[0] && !parts[1])) return null;
  }
  const parsed = Math.round(Number(normalized || "0") * 10 ** places);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted && char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { row.push(cell.trim()); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = []; cell = "";
    } else cell += char;
  }
  if (quoted) throw new Error("The CSV file contains an unclosed quoted value.");
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function guessCsvMapping(headers: string[]): Record<string, number | null> {
  const normalized = headers.map((header) => header.trim().toLocaleLowerCase().replace(/[_-]+/g, " "));
  const mapping: Record<string, number | null> = {};
  for (const field of importFields) {
    const aliases: readonly string[] = field.aliases;
    const index = normalized.findIndex((header) => aliases.includes(header));
    mapping[field.id] = index >= 0 ? index : null;
  }
  return mapping;
}

export function ProductsPage({ baseCurrency = "USD", actorId = null, organizationId = null }: { baseCurrency?: string | null; actorId?: string | null; organizationId?: string | null }) {
  const currency = baseCurrency || "USD";
  const [items, setItems] = useState<Product[]>([]);
  const [totalValueMinor, setTotalValueMinor] = useState(0);
  const [loading, setLoading] = useState(true);
  const [moduleEnabled, setModuleEnabled] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [category, setCategory] = useState("all");
  const [stock, setStock] = useState("all");
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editTarget, setEditTarget] = useState<Product | null>(null);
  const editDialogRef = useRef<HTMLDialogElement>(null);
  const editReturnFocusRef = useRef<HTMLElement | null>(null);
  const [editDraft, setEditDraft] = useState({ name: "", unitLabel: "", price: "", barcode: "", imageUrl: "", tags: "" });
  const [csvRows, setCsvRows] = useState<string[][]>([]);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvMapping, setCsvMapping] = useState<Record<string, number | null>>({});
  const [csvServicePrefix, setCsvServicePrefix] = useState("");
  const [csvResult, setCsvResult] = useState<ProductImportResult | null>(null);
  const [csvActiveIds, setCsvActiveIds] = useState<string[]>([]);
  const [csvArchivedIds, setCsvArchivedIds] = useState<string[]>([]);
  const [pendingCsvImportRows, setPendingCsvImportRows] = useState<ProductImportRow[] | null>(null);
  const [pendingCsvUndoIds, setPendingCsvUndoIds] = useState<string[] | null>(null);
  const [pendingCsvRestoreIds, setPendingCsvRestoreIds] = useState<string[] | null>(null);
  const [recoveryLoaded, setRecoveryLoaded] = useState(false);
  const [csvError, setCsvError] = useState<string | null>(null);
  const retryScope = useMemo<ProductImportRetryScope>(() => ({ actorId, organizationId }), [actorId, organizationId]);
  const retryScopeIdentity = actorId?.trim() && organizationId?.trim() ? JSON.stringify([actorId.trim(), organizationId.trim()]) : "";

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadError(null);
    try {
      const enabled = await fetchProductsEnabled(signal);
      if (signal?.aborted) return;
      setModuleEnabled(enabled);
      if (!enabled) { setItems([]); setLoading(false); return; }
      const result = await fetchProducts(signal);
      if (signal?.aborted) return;
      setItems(result.items);
      setTotalValueMinor(result.totalValueMinor);
    } catch (error) {
      if (!signal?.aborted) setLoadError(error instanceof Error ? error.message : "Could not load products.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    let current = true;
    setRecoveryLoaded(false);
    setCsvResult(null);
    setCsvActiveIds([]);
    setCsvArchivedIds([]);
    setPendingCsvImportRows(null);
    setPendingCsvUndoIds(null);
    setPendingCsvRestoreIds(null);
    if (!retryScopeIdentity) {
      setRecoveryLoaded(true);
      return () => { current = false; };
    }
    void recoverProductImport(retryScope).then(({ pendingRows, pendingUndoIds, pendingRestoreIds, recovery }) => {
      if (!current) return;
      setPendingCsvImportRows(pendingRows);
      setPendingCsvUndoIds(pendingUndoIds);
      setPendingCsvRestoreIds(pendingRestoreIds);
      setCsvResult(recovery?.result ?? null);
      setCsvActiveIds(recovery?.activeIds ?? []);
      setCsvArchivedIds(recovery?.archivedIds ?? []);
    }).catch((error) => {
      if (current) setCsvError(error instanceof Error ? error.message : "Could not recover the last product import.");
    }).finally(() => { if (current) setRecoveryLoaded(true); });
    return () => { current = false; };
  }, [retryScopeIdentity]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchProductDefaults(controller.signal).then((settings) => {
      if (controller.signal.aborted) return;
      setDraft((current) => ({
        ...current,
        unitLabel: current.unitLabel || settings.defaultUnitLabel || "",
        reorder: current.reorder || (settings.defaultReorderPointUnits ? String(settings.defaultReorderPointUnits) : ""),
      }));
    }).catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const dialog = editDialogRef.current;
    if (editTarget && dialog && !dialog.open) dialog.showModal();
    else if (!editTarget && dialog?.open) dialog.close();
  }, [editTarget]);

  const categories = useMemo(() => [...new Set(items.flatMap((item) => item.tags))].sort((a, b) => a.localeCompare(b)), [items]);
  const alerts = items.filter((item) => item.reorderNeeded);
  const visible = items.filter((item) => {
    const text = `${item.sku} ${item.name} ${item.barcode ?? ""} ${item.tags.join(" ")}`.toLocaleLowerCase();
    const matchesKind = kind === "all" || (kind === "goods" ? item.kind !== "service" : item.kind === kind);
    const matchesStock = stock === "all" || (stock === "reorder" ? item.reorderNeeded : item.kind === "service" || item.onHandThousandths > 0);
    return matchesKind && matchesStock && (category === "all" || item.tags.includes(category)) && (!query.trim() || text.includes(query.trim().toLocaleLowerCase()));
  });
  const preparedCsv = useMemo(() => {
    const rows: ProductImportRow[] = [];
    const errors: Array<{ row: number; message: string }> = [];
    csvRows.forEach((row, index) => {
      const value = (field: string) => {
        const column = csvMapping[field];
        return column === undefined || column === null ? "" : row[column]?.trim() ?? "";
      };
      const name = value("name");
      const typeValue = value("type").toLocaleLowerCase();
      if (typeValue && !["product", "goods", "service", "services"].includes(typeValue)) { errors.push({ row: index + 2, message: `Use product or service, not "${typeValue}".` }); return; }
      const kind = typeValue === "service" || typeValue === "services" ? "service" : "goods";
      const sku = value("sku") || (kind === "service" ? `${csvServicePrefix}-${String(index + 2).padStart(4, "0")}` : "");
      if (!name || !sku) { errors.push({ row: index + 2, message: !name ? "A name is required." : "Products need an SKU." }); return; }
      if (sku.length > 40 || name.length > 120) { errors.push({ row: index + 2, message: "SKU must be 40 characters or fewer and name 120 characters or fewer." }); return; }
      const unit = value("unit");
      if (unit.length > 20) { errors.push({ row: index + 2, message: "Unit labels must be 20 characters or fewer." }); return; }
      const price = value("salePrice").replace(/[ ,]/g, "");
      if (price && !/^\d+(?:\.\d{1,2})?$/.test(price)) { errors.push({ row: index + 2, message: "Sale price must be non-negative with at most two decimals." }); return; }
      const barcode = value("barcode");
      if (barcode && (barcode.length < 3 || barcode.length > 64)) { errors.push({ row: index + 2, message: "Barcode must be between 3 and 64 characters." }); return; }
      const tags = value("tags").split(/[;,]/).map((tag) => tag.trim()).filter(Boolean);
      if (tags.length > 20 || tags.some((tag) => tag.length > 30)) { errors.push({ row: index + 2, message: "Use up to 20 tags, each 30 characters or fewer." }); return; }
      rows.push({ rowNumber: index + 2, name, sku, type: kind, unit: unit || (kind === "service" ? "hour" : "unit"), salePrice: price || "0", ...(barcode ? { barcode } : {}), tags });
    });
    return { rows, errors };
  }, [csvMapping, csvRows, csvServicePrefix]);

  async function run(action: ProductAction, label: string): Promise<boolean> {
    setBusy(true);
    setNotice(null);
    try {
      const result = await submitProductAction(action);
      if (result.kind === "pending") {
        setNotice({ kind: "pending", text: `${label} requires approval. ${result.reason}` });
        return false;
      }
      setNotice({ kind: "success", text: `${label} completed.` });
      await load();
      return true;
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof ProductsApiError ? error.message : `${label} failed. Try again.` });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function createProduct() {
    const sku = draft.sku.trim() || (draft.kind === "service" ? `SVC-${crypto.randomUUID().slice(0, 8).toUpperCase()}` : "");
    const price = parseDecimal(draft.price, 2);
    const reorder = parseDecimal(draft.reorder, 3);
    const opening = parseDecimal(draft.opening, 3);
    if (!sku || !draft.name.trim() || price === null || reorder === null || opening === null) {
      setNotice({ kind: "error", text: "Check the SKU, name, price, and stock quantities." });
      return;
    }
    const created = await run({
      action: "createItem", sku, name: draft.name.trim(), kind: draft.kind,
      unitLabel: draft.kind === "service" ? (draft.unitLabel.trim() || "hour") : (draft.unitLabel.trim() || "unit"),
      salePriceMinor: price, reorderPointThousandths: draft.kind === "service" ? 0 : reorder,
      ...(draft.kind === "goods" && draft.barcode.trim() ? { barcode: draft.barcode.trim() } : {}),
      ...(draft.imageUrl.trim() ? { imageUrl: draft.imageUrl.trim() } : {}),
      tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
    }, `Create ${draft.name.trim()}`);
    if (!created) return;
    setDraft(emptyDraft);
    setTab("catalog");
    if (draft.kind === "goods" && opening > 0) {
      await run({ action: "adjustStock", sku, quantityDelta: opening, note: "Opening stock" }, "Record opening stock");
    }
  }

  function openEdit(item: Product) {
    editReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditTarget(item);
    setEditDraft({ name: item.name, unitLabel: item.unitLabel, price: (item.salePriceMinor / 100).toFixed(2), barcode: item.barcode ?? "", imageUrl: item.imageUrl ?? "", tags: item.tags.join(", ") });
  }

  async function saveEdit() {
    if (!editTarget || !editDraft.name.trim()) return;
    const price = parseDecimal(editDraft.price, 2);
    if (price === null) { setNotice({ kind: "error", text: "Enter a valid non-negative sale price with up to two decimal places." }); return; }
    const saved = await run({ action: "updateItem", sku: editTarget.sku, name: editDraft.name.trim(), unitLabel: editDraft.unitLabel.trim() || undefined, salePriceMinor: price,
      barcode: editDraft.barcode.trim() || null, imageUrl: editDraft.imageUrl.trim() || null, tags: editDraft.tags.split(",").map((tag) => tag.trim()).filter(Boolean) }, `Update ${editTarget.sku}`);
    if (saved) setEditTarget(null);
  }

  async function importCsv() {
    if (goProductImportEnabled() && (!retryScopeIdentity || !recoveryLoaded)) {
      setNotice({ kind: "error", text: "Product imports are paused until your account and organization finish loading." });
      return;
    }
    if (preparedCsv.rows.length === 0) {
      setNotice({ kind: "error", text: preparedCsv.errors[0]?.message ?? "Map at least one row with a name and SKU before importing." });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result = await importProducts(preparedCsv.rows, undefined, retryScope);
      setCsvResult(result);
      setCsvActiveIds(result.createdIds ?? []);
      setCsvArchivedIds([]);
      setPendingCsvImportRows(null);
      await load();
      setNotice({ kind: result.errors.length ? "error" : "success", text: `${result.inserted} item${result.inserted === 1 ? "" : "s"} imported, ${result.skippedDuplicates} duplicate${result.skippedDuplicates === 1 ? "" : "s"} skipped, ${result.errors.length} row error${result.errors.length === 1 ? "" : "s"}.` });
    } catch (error) {
      setNotice({ kind: error instanceof ProductsApiError && error.status === 202 ? "pending" : "error", text: error instanceof Error ? error.message : "The product import could not be completed." });
    } finally {
      setBusy(false);
    }
  }

  async function retryRecoveredCsvImport() {
    if (!pendingCsvImportRows?.length || !recoveryLoaded) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await importProducts(pendingCsvImportRows, undefined, retryScope);
      setCsvResult(result);
      setCsvActiveIds(result.createdIds ?? []);
      setCsvArchivedIds([]);
      setPendingCsvImportRows(null);
      await load();
      setNotice({ kind: result.errors.length ? "error" : "success", text: `${result.inserted} item${result.inserted === 1 ? "" : "s"} imported, ${result.skippedDuplicates} duplicates skipped, ${result.errors.length} row errors.` });
    } catch (error) {
      setNotice({ kind: error instanceof ProductsApiError && error.status === 202 ? "pending" : "error", text: error instanceof Error ? error.message : "The product import could not be completed." });
    } finally {
      setBusy(false);
    }
  }

  async function undoCsvImport() {
    const ids = pendingCsvUndoIds ?? csvActiveIds;
    if (!ids?.length) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await undoProductImport(ids, undefined, retryScope);
      if (result.kind === "pending") {
        setPendingCsvUndoIds(ids);
        setNotice({ kind: "pending", text: result.reason });
        return;
      }
      setPendingCsvUndoIds(null);
      setCsvActiveIds((current) => current.filter((id) => !result.itemIds.includes(id)));
      setCsvArchivedIds((current) => [...new Set([...current, ...result.itemIds])]);
      setCsvResult((current) => current ? { ...current, inserted: Math.max(0, current.inserted - result.undone), undone: result.remaining === 0 } : current);
      setNotice({ kind: "success", text: result.remaining > 0 ? `${result.undone} items archived. ${result.remaining} changed items remain active.` : `Undid the import. ${result.undone} items were archived.` });
      await load();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "The import could not be undone." });
    } finally {
      setBusy(false);
    }
  }

  async function restoreCsvImport() {
    if (!csvArchivedIds.length) return;
    setBusy(true);
    setNotice(null);
    try {
      const ids = pendingCsvRestoreIds ?? csvArchivedIds;
      const result = await restoreProductImport(ids, undefined, retryScope);
      if (result.kind === "pending") {
        setPendingCsvRestoreIds(ids);
        setNotice({ kind: "pending", text: result.reason });
        return;
      }
      setPendingCsvRestoreIds(null);
      setCsvArchivedIds((current) => current.filter((id) => !result.itemIds.includes(id)));
      setCsvActiveIds((current) => [...new Set([...current, ...result.itemIds])]);
      setCsvResult((current) => current ? { ...current, undone: false } : current);
      setNotice({ kind: "success", text: `Restored ${result.restored} imported items.` });
      await load();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "The import could not be restored." });
    } finally {
      setBusy(false);
    }
  }

  async function readCsvFile(file: File) {
    setTab("catalog");
    setCsvRows([]);
    setCsvHeaders([]);
    setCsvMapping({});
    setCsvServicePrefix("");
    setCsvResult(null);
    setCsvError(null);
    if (file.size > 5 * 1024 * 1024) { setCsvError("The CSV file exceeds the 5 MB limit. Split it into smaller files and import each one."); return; }
    try {
      const table = parseCsv(await file.text());
      if (table.length < 2 || !(table[0]?.length)) { setCsvError("The CSV needs a heading row and at least one data row."); return; }
      if (table.length - 1 > 5000) { setCsvError("The CSV has more than 5,000 rows. Split it into smaller files."); return; }
      const headers = table[0] ?? [];
      setCsvHeaders(headers);
      setCsvRows(table.slice(1));
      setCsvMapping(guessCsvMapping(headers));
      setCsvServicePrefix(`SVC-${crypto.randomUUID().slice(0, 6).toUpperCase()}`);
      setTab("catalog");
    } catch (error) {
      setCsvError(error instanceof Error ? error.message : "Could not read the CSV file.");
    }
  }

  if (loading) return <main className="products-page"><p role="status">Loading products and services…</p></main>;
  if (!moduleEnabled && !loadError) return <main className="products-page"><section className="products-panel" role="status"><h1>Products are turned off</h1><p>Ask a workspace administrator to enable the Inventory module before managing products and services.</p></section></main>;
  return (
    <main className="products-page">
      <header className="products-header">
        <div><p className="products-eyebrow">Catalog</p><h1>Products &amp; Services</h1><p>Manage items used by quotes, invoices, stock, and point of sale.</p></div>
        <button type="button" onClick={() => { setTab("new"); setDraft(emptyDraft); }}>Create item</button>
      </header>
      {notice && <p className={`products-notice is-${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}<button type="button" aria-label="Dismiss notification" onClick={() => setNotice(null)}>Dismiss</button></p>}
      {loadError && <div className="products-error" role="alert">{loadError}<button type="button" onClick={() => { setLoading(true); void load(); }}>Try again</button></div>}
      <nav className="products-tabs" aria-label="Products workspace"><button type="button" aria-pressed={tab === "overview"} onClick={() => setTab("overview")}>Overview</button><button type="button" aria-pressed={tab === "catalog"} onClick={() => setTab("catalog")}>Products &amp; Services</button><button type="button" aria-pressed={tab === "new"} onClick={() => setTab("new")}>Add item</button></nav>
      <input id="products-csv" className="products-file" type="file" accept=".csv,text/csv" aria-label="Choose products CSV file" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void readCsvFile(file); event.currentTarget.value = ""; }} />

      {tab === "overview" && <>
        <section className="products-stats" aria-label="Catalog summary"><button type="button" onClick={() => setTab("catalog")}><span>Items in catalog</span><strong>{items.length}</strong></button><button type="button" onClick={() => { setTab("catalog"); setKind("goods"); }}><span>Total stock value</span><strong>{moneyMinor(totalValueMinor, currency)}</strong></button><button type="button" onClick={() => { setTab("catalog"); setStock("reorder"); }}><span>Reorder alerts</span><strong>{items.length ? alerts.length : "N/A"}</strong></button></section>
        <section className="products-panel"><h2>Items needing reorder</h2>{alerts.length ? <ul>{alerts.map((item) => <li key={item.sku}><span><code>{item.sku}</code> · {item.name}</span><span>On hand {quantity(item.onHandThousandths)} · reorder at {quantity(item.reorderPointThousandths)}</span></li>)}</ul> : <p>{items.length ? "Tracked goods are at or above their reorder thresholds." : "Add your first product or service to build the catalog."}</p>}<button type="button" onClick={() => { setCsvError(null); document.getElementById("products-csv")?.click(); }}>Import CSV</button></section>
      </>}

      {tab === "catalog" && <section className="products-panel">
        <div className="products-controls"><label>Search catalog<input type="search" aria-label="Search catalog" placeholder="SKU, name, barcode, or tag" value={query} onChange={(event) => setQuery(event.target.value)} /></label><label>Type<select aria-label="Filter by item type" value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">All types</option><option value="goods">Products</option><option value="service">Services</option></select></label><label>Category<select aria-label="Filter by category" value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">All categories</option>{categories.map((tag) => <option key={tag}>{tag}</option>)}</select></label><label>Stock<select aria-label="Filter by stock status" value={stock} onChange={(event) => setStock(event.target.value)}><option value="all">Any stock level</option><option value="reorder">Needs reorder</option><option value="in-stock">In stock</option></select></label><button type="button" onClick={() => { setCsvError(null); document.getElementById("products-csv")?.click(); }}>Import CSV</button></div>
        {csvError && <p className="products-error" role="alert">{csvError}</p>}
        {goProductImportEnabled() && !retryScopeIdentity && <p className="products-error" role="alert">Product imports are paused until your account and organization finish loading.</p>}
        {pendingCsvImportRows && <div className="products-import" role="status"><p>An import for this account and organization has an unresolved result. Retry the exact saved {pendingCsvImportRows.length}-row request to recover its outcome.</p><button type="button" disabled={busy || !recoveryLoaded} onClick={() => void retryRecoveredCsvImport()}>Retry pending import</button></div>}
        {csvResult && <div className="products-import" aria-label="Product import recovery"><p>{csvResult.inserted} imported · {csvResult.skippedDuplicates} duplicates skipped · {csvResult.errors.length} errors. {csvActiveIds.length} active and {csvArchivedIds.length} archived imported items are tracked for recovery.</p>{pendingCsvUndoIds && <p role="status">An undo result is unresolved. Retry the exact saved {pendingCsvUndoIds.length}-item action.</p>}{pendingCsvRestoreIds && <p role="status">A restore result is unresolved. Retry the exact saved {pendingCsvRestoreIds.length}-item action.</p>}<button type="button" disabled={busy || !(pendingCsvUndoIds?.length || csvActiveIds.length) || (goProductImportEnabled() && !recoveryLoaded)} onClick={() => void undoCsvImport()}>{pendingCsvUndoIds ? "Retry pending undo" : "Undo import"}</button><button type="button" disabled={busy || !(pendingCsvRestoreIds?.length || csvArchivedIds.length) || (goProductImportEnabled() && !recoveryLoaded)} onClick={() => void restoreCsvImport()}>{pendingCsvRestoreIds ? "Retry pending restore" : "Restore import"}</button></div>}
        {csvRows.length > 0 && <div className="products-import"><p>CSV preview: {csvRows.length} data rows. Map columns, review validation, and import the valid rows. Service SKUs can be generated automatically.</p><div className="products-controls">{importFields.map((field) => <label key={field.id}>Map {field.label}<select aria-label={`Map ${field.label} column`} value={csvMapping[field.id] ?? ""} onChange={(event) => setCsvMapping((current) => ({ ...current, [field.id]: event.target.value === "" ? null : Number(event.target.value) }))}><option value="">Not mapped</option>{csvHeaders.map((header, index) => <option key={`${index}-${header}`} value={index}>{header || `Column ${index + 1}`}</option>)}</select></label>)}</div><div className="products-preview"><table><thead><tr>{csvHeaders.map((header, index) => <th key={`${index}-${header}`}>{header || `Column ${index + 1}`}</th>)}</tr></thead><tbody>{csvRows.slice(0, 5).map((row, index) => <tr key={index}>{csvHeaders.map((header, column) => <td key={`${column}-${header}`}>{row[column] ?? ""}</td>)}</tr>)}</tbody></table></div><p>{preparedCsv.rows.length} valid rows, {preparedCsv.errors.length} row errors</p>{preparedCsv.errors.length > 0 && <ul>{preparedCsv.errors.slice(0, 10).map((error) => <li key={`${error.row}-${error.message}`}>Row {error.row}: {error.message}</li>)}</ul>}<button type="button" disabled={busy || preparedCsv.rows.length === 0 || csvResult !== null || (goProductImportEnabled() && (!retryScopeIdentity || !recoveryLoaded))} onClick={() => void importCsv()}>Import rows</button><button type="button" onClick={() => { setCsvRows([]); setCsvHeaders([]); }}>Cancel import</button></div>}
        <p className="products-count" role="status">{visible.length} shown</p>
        {visible.length ? <div className="products-table-wrap"><table><thead><tr><th>SKU</th><th>Name</th><th>Sale price</th><th>On hand</th><th>Avg cost</th><th>Value</th><th>Barcode</th><th>Reorder</th><th>Actions</th></tr></thead><tbody>{visible.map((item) => <tr key={item.sku}><td><code>{item.sku}</code></td><td>{item.imageUrl && <img src={item.imageUrl} alt="" width="28" height="28" />} {item.name}<small>{item.kind === "service" ? `Service / ${item.unitLabel}` : item.tags.join(", ")}</small></td><td>{moneyMinor(item.salePriceMinor, currency)}</td><td>{quantity(item.onHandThousandths)} {item.unitLabel}</td><td>{moneyMinor(item.avgUnitCostMinor, currency)}</td><td>{moneyMinor(item.valueMinor, currency)}</td><td>{item.barcode ?? "-"}</td><td>{item.reorderNeeded ? "Needs reorder" : "OK"}</td><td><button type="button" onClick={() => openEdit(item)}>Edit</button><button type="button" disabled={busy} onClick={() => { if (window.confirm(`Archive ${item.sku}? Past quotes and invoices keep their history.`)) void run({ action: "archiveItem", sku: item.sku, archive: true }, `Archive ${item.sku}`); }}>Archive</button></td></tr>)}</tbody></table></div> : <p className="products-empty">{items.length ? "No items match these filters." : "No products or services yet."}</p>}
      </section>}

      {tab === "new" && <section className="products-panel"><h2>{draft.kind === "service" ? "Add a service" : "Add a product"}</h2><div className="products-form">
        <label>Type<select value={draft.kind} onChange={(event) => setDraft((current) => ({ ...current, kind: event.target.value as Draft["kind"] }))}><option value="goods">Product</option><option value="service">Service</option></select></label>
        <label>Name<input aria-label="Product name" maxLength={120} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label>{draft.kind === "service" ? "Service code (optional)" : "SKU"}<input aria-label="SKU" value={draft.sku} onChange={(event) => setDraft({ ...draft, sku: event.target.value })} /></label>
        <label>{draft.kind === "service" ? "Billing unit" : "Unit label"}<input value={draft.unitLabel} onChange={(event) => setDraft({ ...draft, unitLabel: event.target.value })} placeholder={draft.kind === "service" ? "hour, session, job, month" : "unit, kg, box"} /></label><label>Sale price<input type="number" min="0" step="0.01" value={draft.price} onChange={(event) => setDraft({ ...draft, price: event.target.value })} /></label>
        {draft.kind === "goods" && <><label>Opening stock<input type="number" min="0" step="0.001" value={draft.opening} onChange={(event) => setDraft({ ...draft, opening: event.target.value })} /></label><label>Reorder point<input type="number" min="0" step="0.001" value={draft.reorder} onChange={(event) => setDraft({ ...draft, reorder: event.target.value })} /></label><label>Barcode<input value={draft.barcode} onChange={(event) => setDraft({ ...draft, barcode: event.target.value })} /></label></>}
        <label>Tags or category<input placeholder="Consulting, premium" value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} /></label><label className="products-wide">Image URL<input type="url" value={draft.imageUrl} onChange={(event) => setDraft({ ...draft, imageUrl: event.target.value })} /></label>
      </div><p className="products-help">{draft.kind === "service" ? "Services do not carry stock or barcodes." : "Opening stock is recorded as a separate governed stock movement."}</p><button type="button" disabled={busy || !draft.name.trim() || (draft.kind === "goods" && !draft.sku.trim())} onClick={() => void createProduct()}>{draft.kind === "service" ? "Add service" : "Add product"}</button></section>}

      {editTarget && <dialog ref={editDialogRef} className="products-dialog" aria-labelledby="products-edit-title" onCancel={(event) => { event.preventDefault(); setEditTarget(null); }} onClose={() => { if (editTarget) setEditTarget(null); window.requestAnimationFrame(() => editReturnFocusRef.current?.focus()); }}><h2 id="products-edit-title">Edit {editTarget.sku}</h2><label>Name<input autoFocus value={editDraft.name} onChange={(event) => setEditDraft({ ...editDraft, name: event.target.value })} /></label><label>Unit<input value={editDraft.unitLabel} onChange={(event) => setEditDraft({ ...editDraft, unitLabel: event.target.value })} /></label><label>Sale price<input inputMode="decimal" value={editDraft.price} onChange={(event) => setEditDraft({ ...editDraft, price: event.target.value })} /></label><label>Barcode<input value={editDraft.barcode} onChange={(event) => setEditDraft({ ...editDraft, barcode: event.target.value })} /></label><label>Image URL<input value={editDraft.imageUrl} onChange={(event) => setEditDraft({ ...editDraft, imageUrl: event.target.value })} /></label><label>Tags<input value={editDraft.tags} onChange={(event) => setEditDraft({ ...editDraft, tags: event.target.value })} /></label><footer><button type="button" disabled={busy} onClick={() => setEditTarget(null)}>Cancel</button><button type="button" disabled={busy || !editDraft.name.trim()} onClick={() => void saveEdit()}>Save changes</button></footer></dialog>}
    </main>
  );
}
