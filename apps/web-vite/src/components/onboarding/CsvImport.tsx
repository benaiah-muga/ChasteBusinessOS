import { useEffect, useMemo, useRef, useState } from "react";
import { fetchProducts } from "../../api/products";
import {
  failureOf,
  importOnboardingRows,
  undoOnboardingImport,
  type OnboardingFailure,
  type OnboardingImportEntity,
  type OnboardingImportResult,
  type OnboardingImportRow,
} from "../../api/onboarding";
import {
  IconAlertTriangle,
  IconCheck,
  IconFileText,
  IconUpload,
  IconX,
  RecoverBlock,
  Spinner,
  disabledButton,
  ghostButton,
  gold,
  hairline,
  ink,
  muted,
  primaryButton,
  styles,
  textInput,
  withStyle,
} from "./parts";

/**
 * Spreadsheet import: pick a file, confirm which column is which, see exactly
 * what will land, then import.
 *
 * The mapping step is not ceremony. Guessing silently is how a business ends up
 * with 400 customers whose names are their email addresses, so anything the
 * guesser is unsure about is shown as a question rather than a decision made
 * for them.
 *
 * Parsing and mapping stay in this file on purpose: nothing else in the app
 * consumes them, and keeping them beside the panel that owns the preview means
 * the rules a row must pass to be importable live with the copy that explains
 * them.
 */

export interface CsvTable {
  headers: string[];
  rows: Record<string, string>[];
}

/**
 * Minimal RFC 4180 reader. Client-side on purpose: parsing never touches the
 * database, and showing the user exactly which columns we understood, before
 * anything is written, is the difference between a confident import and a
 * silent mess.
 */
export function parseCsv(text: string): CsvTable {
  const src = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    // A quote only opens a quoted field when it sits at the start of one. RFC
    // 4180 treats a quote anywhere else as literal data, and honouring that is
    // what keeps `6" pipe` from quietly becoming `6 pipe` on the way in.
    if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
  const headerRow = nonEmpty[0];
  if (!headerRow) return { headers: [], rows: [] };

  const headers = headerRow.map((header) => header.trim());
  const out: Record<string, string>[] = [];
  for (const cells of nonEmpty.slice(1)) {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = (cells[index] ?? "").trim();
    });
    out.push(record);
  }
  return { headers, rows: out };
}

/** Canonical fields per entity, with the synonyms spreadsheets actually use. */
export const FIELD_SYNONYMS: Record<OnboardingImportEntity, Record<string, string[]>> = {
  customers: {
    name: ["name", "customer", "customer name", "company", "contact", "display name"],
    email: ["email", "e-mail", "email address", "mail"],
    creditLimit: ["credit limit", "credit", "credit limit minor", "ar limit"],
    paymentTermDays: ["payment terms", "terms", "net days", "payment term days", "terms (days)"],
  },
  products: {
    sku: ["sku", "code", "item code", "product code", "item", "id"],
    name: ["name", "product", "product name", "item name", "description", "title"],
    type: ["type", "kind", "item type", "product type", "service or product"],
    unitLabel: ["unit", "unit label", "uom", "unit of measure", "service unit", "billing unit", "billing basis"],
    salePrice: ["price", "sale price", "unit price", "selling price", "amount", "rate"],
    barcode: ["barcode", "bar code", "ean", "upc"],
  },
};

export const REQUIRED_FIELDS: Record<OnboardingImportEntity, string[]> = {
  customers: ["name"],
  products: ["name"],
};

const FIELD_LABELS: Record<string, string> = {
  name: "Name",
  email: "Email",
  creditLimit: "Credit limit",
  paymentTermDays: "Payment terms (days)",
  sku: "SKU",
  unitLabel: "Unit",
  salePrice: "Sale price",
  barcode: "Barcode",
  type: "Product or service",
};

const FIELD_NOTES: Record<string, string> = {
  creditLimit: "Plain amount, e.g. 5000, not 500000 cents.",
  salePrice: "Plain amount, e.g. 24.99.",
  paymentTermDays: "Whole days, e.g. 30.",
  unitLabel: "e.g. unit, box, kg.",
  type: "Use product or service. Service rows may omit SKU and receive an automatic service code.",
};

const MAX_ROWS = 5_000;
const MAX_BYTES = 5 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ENTITIES: { id: OnboardingImportEntity; label: string; hint: string }[] = [
  { id: "customers", label: "Customers", hint: "Who you invoice" },
  { id: "products", label: "Products", hint: "What you sell" },
];

interface RowError {
  row: number;
  field?: string;
  message: string;
}

interface PreparedRows {
  payload: OnboardingImportRow[];
  problems: RowError[];
}

const normalizeHeader = (value: string) =>
  value
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Shortest synonym allowed to match on a substring. Below this length the
 * false positives outweigh the hits: "id" lives inside "paid", "ean" inside
 * "cleaner", and a column nobody meant to import ends up as the SKU.
 */
const SUBSTRING_SYNONYM_MIN = 4;

/**
 * Best-effort header to canonical field mapping. Returns null for a field
 * nothing looked like, so the UI can ask rather than guess wrong in silence.
 */
export function guessMapping(
  entity: OnboardingImportEntity,
  headers: string[],
): Record<string, string | null> {
  const mapping: Record<string, string | null> = {};
  const taken = new Set<string>();
  const cols = headers.map((raw) => ({ raw, norm: normalizeHeader(raw) }));
  const fields = Object.keys(FIELD_SYNONYMS[entity]);
  const wantedFor = new Map(fields.map((field) => [field, (FIELD_SYNONYMS[entity][field] ?? []).map(normalizeHeader)] as const));

  for (const field of fields) mapping[field] = null;

  // Pass 1: exact matches, resolved for every field before any fuzzy match
  // runs. Doing it per-field is how "Unit Price" used to land on `unitLabel`.
  for (const field of fields) {
    const wanted = wantedFor.get(field) ?? [];
    const hit = cols.find((col) => !taken.has(col.raw) && wanted.includes(col.norm));
    if (hit) {
      mapping[field] = hit.raw;
      taken.add(hit.raw);
    }
  }

  // Pass 2: substring matches for whatever is still unmatched, most specific
  // synonym first so a longer phrase beats the short word nested inside it.
  const candidates: { field: string; raw: string; score: number; fieldRank: number; colRank: number }[] = [];
  fields.forEach((field, fieldRank) => {
    if (mapping[field]) return;
    const wanted = wantedFor.get(field) ?? [];
    cols.forEach((col, colRank) => {
      if (taken.has(col.raw)) return;
      let best = 0;
      for (const synonym of wanted) {
        if (synonym.length >= SUBSTRING_SYNONYM_MIN && col.norm.includes(synonym)) best = Math.max(best, synonym.length);
      }
      if (best > 0) candidates.push({ field, raw: col.raw, score: best, fieldRank, colRank });
    });
  });
  candidates.sort((a, b) => b.score - a.score || a.fieldRank - b.fieldRank || a.colRank - b.colRank);
  for (const candidate of candidates) {
    if (mapping[candidate.field] || taken.has(candidate.raw)) continue;
    mapping[candidate.field] = candidate.raw;
    taken.add(candidate.raw);
  }

  return mapping;
}

export interface ImportOutcome {
  entity: OnboardingImportEntity;
  inserted: number;
}

interface ImportPanelState extends OnboardingImportResult {
  undone?: boolean;
  undoMessage?: string;
}

export function CsvImportPanel({
  onImported,
  onSkipped,
  initialEntity,
  onChanged,
}: {
  onImported: (outcome: ImportOutcome) => void;
  onSkipped: () => void;
  initialEntity?: OnboardingImportEntity;
  onChanged?: () => void;
}) {
  const [entity, setEntity] = useState<OnboardingImportEntity>(initialEntity ?? "customers");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportPanelState | null>(null);
  const [failure, setFailure] = useState<OnboardingFailure | null>(null);
  const [dragging, setDragging] = useState(false);
  const [existingProducts, setExistingProducts] = useState<{ sku: string; barcode: string | null }[]>([]);
  const [serviceCodePrefix, setServiceCodePrefix] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (entity !== "products") return;
    const controller = new AbortController();
    void fetchProducts(controller.signal)
      .then((catalog) => {
        if (controller.signal.aborted) return;
        setExistingProducts(catalog.items.map((item) => ({ sku: item.sku, barcode: item.barcode ?? null })));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [entity]);

  const fields = useMemo(() => Object.keys(FIELD_SYNONYMS[entity]), [entity]);
  const required = REQUIRED_FIELDS[entity];

  /** Rows rebuilt through the current mapping, with client-side checks first. */
  const prepared = useMemo<PreparedRows>(() => {
    const payload: OnboardingImportRow[] = [];
    const problems: RowError[] = [];
    rows.forEach((row, index) => {
      const line = index + 2;
      const out: OnboardingImportRow = {};
      for (const field of fields) {
        const column = mapping[field];
        if (!column) continue;
        const value = (row[column] ?? "").trim();
        if (value !== "") out[field] = value;
      }
      const typeValue = (out.type ?? "product").trim().toLowerCase();
      const serviceRow = ["service", "services"].includes(typeValue);
      if (entity === "products" && out.type && !["product", "goods", "service", "services"].includes(typeValue)) {
        problems.push({ row: line, field: "type", message: `Use product or service, not "${out.type}".` });
        return;
      }
      if (entity === "products" && serviceRow) {
        if (!out.sku) out.sku = `${serviceCodePrefix || "SVC-IMPORT"}-${String(line).padStart(4, "0")}`;
        if (!out.unitLabel) out.unitLabel = "hour";
      }
      const missingField =
        required.find((field) => !out[field]) ?? (entity === "products" && !serviceRow && !out.sku ? "sku" : undefined);
      if (missingField) {
        problems.push({
          row: line,
          field: missingField,
          message: `Needs a ${FIELD_LABELS[missingField] ?? missingField}.`,
        });
        return;
      }
      if (out.email && !EMAIL_RE.test(out.email)) {
        problems.push({ row: line, field: "email", message: `"${out.email}" is not a valid email.` });
        return;
      }
      if (out.salePrice && !/^\d+(?:\.\d{1,2})?$/.test(out.salePrice.replace(/[,\s]/g, ""))) {
        problems.push({
          row: line,
          field: "salePrice",
          message: `"${out.salePrice}" must be a non-negative amount with at most two decimals.`,
        });
        return;
      }
      if (entity === "products" && out.sku && out.sku.length > 40) {
        problems.push({ row: line, field: "sku", message: "SKU must be 40 characters or fewer." });
        return;
      }
      if (entity === "products" && out.unitLabel && out.unitLabel.length > 20) {
        problems.push({ row: line, field: "unitLabel", message: "Unit label must be 20 characters or fewer." });
        return;
      }
      if (entity === "products" && out.barcode && (out.barcode.length < 3 || out.barcode.length > 64)) {
        problems.push({ row: line, field: "barcode", message: "Barcode must be between 3 and 64 characters." });
        return;
      }
      payload.push(out);
    });
    return { payload, problems };
  }, [rows, mapping, fields, required, entity, serviceCodePrefix]);

  const duplicateProductCount = useMemo(() => {
    if (entity !== "products") return 0;
    const skus = new Set(existingProducts.map((item) => item.sku.trim().toLowerCase()));
    const barcodes = new Set(
      existingProducts
        .map((item) => item.barcode?.trim().toLowerCase())
        .filter((barcode): barcode is string => Boolean(barcode)),
    );
    let duplicates = 0;
    for (const row of prepared.payload) {
      const sku = row.sku?.trim().toLowerCase();
      const barcode = row.barcode?.trim().toLowerCase();
      if ((sku && skus.has(sku)) || (barcode && barcodes.has(barcode))) duplicates += 1;
      if (sku) skus.add(sku);
      if (barcode) barcodes.add(barcode);
    }
    return duplicates;
  }, [entity, existingProducts, prepared.payload]);

  function reset() {
    setHeaders([]);
    setRows([]);
    setMapping({});
    setFileName(null);
    setParseError(null);
    setResult(null);
    setFailure(null);
    setServiceCodePrefix("");
  }

  function switchEntity(next: OnboardingImportEntity) {
    setEntity(next);
    reset();
  }

  async function readFile(file: File) {
    reset();
    if (file.size > MAX_BYTES) {
      setParseError(
        `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 5 MB, so split it into a few files and import each one.`,
      );
      return;
    }
    const table = parseCsv(await file.text());
    if (table.headers.length === 0 || table.rows.length === 0) {
      setParseError("That file looks empty. Export it again making sure the first row holds your column headings.");
      return;
    }
    if (table.rows.length > MAX_ROWS) {
      setParseError(
        `That file has ${table.rows.length.toLocaleString()} rows, and one import handles ${MAX_ROWS.toLocaleString()}. Split it and import the pieces.`,
      );
      return;
    }
    setFileName(file.name);
    setServiceCodePrefix(`SVC-${crypto.randomUUID().slice(0, 6).toUpperCase()}`);
    setHeaders(table.headers);
    setRows(table.rows);
    setMapping(guessMapping(entity, table.headers));
  }

  async function runImport() {
    setBusy(true);
    setFailure(null);
    setResult(null);
    try {
      const imported = await importOnboardingRows(entity, prepared.payload);
      setResult(imported);
      onChanged?.();
      if (imported.inserted > 0) onImported({ entity, inserted: imported.inserted });
    } catch (error) {
      setFailure(failureOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function undoImport() {
    const currentResult = result;
    const ids = currentResult?.createdIds;
    if (!currentResult || !ids?.length) return;
    setBusy(true);
    setFailure(null);
    try {
      const undone = await undoOnboardingImport(entity, ids);
      setResult({
        ...currentResult,
        inserted: Math.max(0, currentResult.inserted - undone.undone),
        createdIds: undone.remaining > 0 ? ids : [],
        undone: undone.remaining === 0,
        undoMessage:
          undone.remaining > 0
            ? `${undone.undone} archived. ${undone.remaining} record${undone.remaining === 1 ? " was" : "s were"} changed after import and remain active.`
            : `Undid the import. ${undone.undone} record${undone.undone === 1 ? " was" : "s were"} safely archived.`,
      });
      onChanged?.();
    } catch (error) {
      setFailure(failureOf(error));
    } finally {
      setBusy(false);
    }
  }

  const failureActions = failure && failure.code !== "pending_approval" ? (
    <>
      <button type="button" onClick={() => void runImport()} style={withStyle(primaryButton, { minHeight: 36, fontSize: 12 })}>
        Try again
      </button>
      <button type="button" onClick={onSkipped} style={ghostButton}>
        Skip for now
      </button>
    </>
  ) : undefined;

  /* ── 1. The file ─────────────────────────────────────────────────────── */

  if (headers.length === 0) {
    return (
      <div style={styles.stack}>
        {!initialEntity && (
          <div role="tablist" aria-label="What are you importing?" style={{ display: "inline-flex", gap: 4, justifySelf: "start", borderRadius: 10, background: "#ece9e0", padding: 4 }}>
            {ENTITIES.map((option) => (
              <button
                key={option.id}
                type="button"
                role="tab"
                aria-selected={entity === option.id}
                onClick={() => switchEntity(option.id)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  border: 0,
                  borderRadius: 7,
                  padding: "7px 12px",
                  background: entity === option.id ? "#fffefa" : "transparent",
                  color: entity === option.id ? ink : muted,
                  cursor: "pointer",
                  font: "inherit",
                  fontSize: 12.5,
                  fontWeight: 600,
                }}
              >
                {option.label}
                <span style={{ color: muted, fontSize: 11 }}>{option.hint}</span>
              </button>
            ))}
          </div>
        )}

        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files?.[0];
            if (file) void readFile(file);
          }}
          style={{
            ...styles.dropzone,
            borderColor: dragging ? "#c8a866" : "#d9d5c8",
            background: dragging ? "rgb(200 168 102 / 10%)" : "#faf9f4",
          }}
        >
          <span style={{ display: "grid", width: 46, height: 46, placeItems: "center", borderRadius: "50%", background: "rgb(200 168 102 / 14%)", color: gold, fontSize: 20 }}>
            <IconUpload />
          </span>
          <strong style={{ fontSize: 14.5 }}>Drop your {entity === "customers" ? "customer" : "product"} file here</strong>
          <span style={{ maxWidth: 420, color: muted, fontSize: 12.5, lineHeight: 1.6 }}>
            A CSV exported from Excel, Google Sheets, QuickBooks or anywhere else. The first row should be
            your column headings.
          </span>
          <button type="button" onClick={() => inputRef.current?.click()} style={withStyle(primaryButton, { justifySelf: "center", marginTop: 6 })}>
            Choose a file
          </button>
          <input
            ref={inputRef}
            type="file"
            aria-label="Choose a CSV file"
            accept=".csv,text/csv,text/plain"
            style={{ display: "none" }}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void readFile(file);
              event.currentTarget.value = "";
            }}
          />
          <span style={{ color: muted, fontSize: 10.5 }}>
            Nothing is uploaded until you press import. Files stay in your browser until then.
          </span>
        </div>

        {parseError && (
          <RecoverBlock
            title="We couldn't read that file"
            actions={
              <>
                <button type="button" onClick={() => inputRef.current?.click()} style={withStyle(primaryButton, { minHeight: 36, fontSize: 12 })}>
                  Try another file
                </button>
                <button type="button" onClick={onSkipped} style={ghostButton}>
                  Skip importing for now
                </button>
              </>
            }
          >
            {parseError}
          </RecoverBlock>
        )}

        <p style={styles.note}>
          <IconFileText style={{ width: 14, height: 14, marginRight: 6, verticalAlign: "-2px", color: gold }} />
          {entity === "customers" ? (
            <>
              We need a <strong>name</strong> column. Email, credit limit and payment terms are optional, so
              you can fill those in later, one customer at a time.
            </>
          ) : (
            <>
              We need a <strong>name</strong>. Products also need a SKU. Services can leave SKU blank and
              receive an automatic service code. Type, price, unit and barcode can be mapped when present.
            </>
          )}
        </p>

        <div>
          <button type="button" onClick={onSkipped} style={ghostButton}>
            Skip this and add {entity === "customers" ? "customers" : "products"} later
          </button>
        </div>
      </div>
    );
  }

  /* ── 2. Map and confirm ──────────────────────────────────────────────── */

  const unmappedRequired = required.filter((field) => !mapping[field]);
  const onlyUnmapped = unmappedRequired.length === 1 ? unmappedRequired[0] : undefined;
  const labelFor = (field: string) => FIELD_LABELS[field] ?? field;
  const preview = prepared.payload.slice(0, 5);
  const previewColumns = [...required, ...fields.filter((field) => !required.includes(field))];

  return (
    <div style={styles.stack}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, border: `1px solid ${hairline}`, borderRadius: 12, padding: "11px 14px", background: "#faf9f4" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
          <IconFileText style={{ width: 15, height: 15, flex: "0 0 auto", color: gold }} />
          <strong style={{ overflow: "hidden", fontSize: 12.5, textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fileName}</strong>
          <span style={{ color: muted, fontSize: 11.5 }}>
            {rows.length.toLocaleString()} rows · {headers.length} columns
          </span>
        </span>
        <button type="button" onClick={reset} style={ghostButton}>
          <IconX style={{ width: 13, height: 13 }} />
          Use a different file
        </button>
      </div>

      <div>
        <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 650 }}>Match your columns</h3>
        <p style={styles.lede}>We took a first guess from your headings. Change anything that looks wrong.</p>
      </div>

      <div style={styles.stackTight}>
        {fields.map((field) => {
          const isRequired = required.includes(field);
          const missing = isRequired && !mapping[field];
          return (
            <div key={field} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
              <label htmlFor={`map-${field}`} style={{ display: "flex", width: 200, alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600 }}>
                {labelFor(field)}
                <span style={{ color: missing ? "#994838" : gold, fontSize: 9.5, fontWeight: 750, letterSpacing: ".08em", textTransform: "uppercase" }}>
                  {isRequired ? "required" : "optional"}
                </span>
              </label>
              <select
                id={`map-${field}`}
                value={mapping[field] ?? ""}
                onChange={(event) => setMapping({ ...mapping, [field]: event.currentTarget.value || null })}
                style={withStyle(textInput, { maxWidth: 320, minHeight: 38, borderColor: missing ? "#d8a79f" : "#d9d2c7" })}
              >
                <option value="">- not in my file -</option>
                {headers.map((header) => (
                  <option key={header} value={header}>
                    {header}
                  </option>
                ))}
              </select>
              {FIELD_NOTES[field] && mapping[field] ? (
                <span style={{ color: muted, fontSize: 11.5 }}>{FIELD_NOTES[field]}</span>
              ) : null}
            </div>
          );
        })}
      </div>

      {unmappedRequired.length > 0 && (
        <RecoverBlock
          tone="warn"
          title={onlyUnmapped ? `We still need a ${labelFor(onlyUnmapped)} column` : "Some required columns aren't matched yet"}
        >
          {onlyUnmapped ? (
            <>
              No column was matched to <strong>{labelFor(onlyUnmapped)}</strong>. Either pick the right column
              above, or add that column to your file and re-export it. Nothing has been imported.
            </>
          ) : (
            <>
              These are still unmatched: <strong>{unmappedRequired.map(labelFor).join(", ")}</strong>. Nothing
              has been imported.
            </>
          )}
        </RecoverBlock>
      )}

      {preview.length > 0 && (
        <div>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
            <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 650 }}>A look at what will land</h3>
            <span style={{ color: muted, fontSize: 11.5 }}>First {preview.length} rows</span>
          </div>
          <div style={{ marginTop: 9, overflowX: "auto", border: `1px solid ${hairline}`, borderRadius: 11 }}>
            <table style={styles.table}>
              <thead style={styles.tableHead}>
                <tr>
                  {previewColumns.map((field) => (
                    <th key={field} style={styles.tableCell}>
                      {labelFor(field)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.map((row, index) => (
                  <tr key={index}>
                    {previewColumns.map((field) => (
                      <td key={field} style={styles.tableCell}>
                        {row[field] ?? <span style={{ color: "#a7a69d" }}>-</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {prepared.problems.length > 0 && (
        <p style={{ ...styles.lede, display: "flex", gap: 9 }}>
          <IconAlertTriangle style={{ width: 15, height: 15, flex: "0 0 auto", marginTop: 2, color: gold }} />
          <span>
            {prepared.problems.length} of {rows.length} rows will be left out because something is missing or
            malformed. The rest still import, so you can fix those rows and import them again afterwards.
          </span>
        </p>
      )}

      {duplicateProductCount > 0 && (
        <p role="status" style={{ ...styles.lede, border: "1px solid #e8d9ae", borderRadius: 10, padding: "9px 12px", background: "#fbf5e4", color: "#6b5a22" }}>
          {duplicateProductCount} row{duplicateProductCount === 1 ? " looks" : "s look"} like an existing SKU or
          barcode. Those rows will be skipped automatically, and you can change the code in your file and import
          again.
        </p>
      )}

      {failure && (
        <RecoverBlock title={failure.title} actions={failureActions}>
          {failure.hint}
        </RecoverBlock>
      )}

      {result && (
        <div style={{ border: `1px solid ${hairline}`, borderRadius: 12, padding: 16, background: "#faf9f4" }}>
          <p style={{ display: "flex", alignItems: "center", gap: 8, margin: 0, fontSize: 13.5, fontWeight: 650 }}>
            <IconCheck style={{ width: 15, height: 15, color: gold }} />
            {result.undone
              ? "This import was undone"
              : result.inserted > 0
                ? `${result.inserted.toLocaleString()} ${entity === "customers" ? "customers" : "products"} imported`
                : "Nothing new was imported"}
          </p>
          <ul style={{ ...styles.list, marginTop: 9 }}>
            {!result.undone && result.skippedDuplicates > 0 && (
              <li style={styles.note}>
                {result.skippedDuplicates.toLocaleString()} already existed{" "}
                {result.skippedDuplicates === 1 ? "(left as it was)" : "(left as they were)"}.
              </li>
            )}
            {!result.undone && result.errors.length > 0 && (
              <li style={styles.note}>
                {result.errors.length.toLocaleString()} rows were set aside, see below.
              </li>
            )}
          </ul>
          {result.undoMessage ? <p style={{ ...styles.note, marginTop: 9 }}>{result.undoMessage}</p> : null}

          {!result.undone && result.createdIds?.length ? (
            <button type="button" disabled={busy} onClick={() => void undoImport()} style={withStyle(ghostButton, { marginTop: 10 })}>
              {busy ? <Spinner /> : null} Undo this import
            </button>
          ) : null}

          {result.errors.length > 0 && (
            <div style={{ marginTop: 11, maxHeight: 168, overflowY: "auto", borderRadius: 9, padding: 12, background: "#f1efe7" }}>
              <ul style={styles.list}>
                {result.errors.slice(0, 12).map((error) => (
                  <li key={`${error.row}-${error.message}`} style={styles.note}>
                    <strong style={{ color: ink }}>Row {error.row}</strong> - {error.message}
                  </li>
                ))}
              </ul>
              {result.errors.length > 12 && (
                <p style={{ ...styles.note, marginTop: 8 }}>
                  …and {result.errors.length - 12} more. Fix them in your file and import it again, anything
                  already imported will not be duplicated.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <div style={styles.row}>
        <button
          type="button"
          onClick={() => void runImport()}
          disabled={busy || prepared.payload.length === 0}
          style={withStyle(primaryButton, busy || prepared.payload.length === 0 ? disabledButton : undefined)}
        >
          {busy ? <Spinner /> : null}
          {busy
            ? "Importing…"
            : `Import ${prepared.payload.length.toLocaleString()} ${entity === "customers" ? "customers" : "products"}`}
        </button>
        <button type="button" onClick={onSkipped} disabled={busy} style={withStyle(ghostButton, busy ? disabledButton : undefined)}>
          Skip for now
        </button>
        <span style={{ color: muted, fontSize: 11.5 }}>
          {prepared.payload.length.toLocaleString()} rows ready
        </span>
      </div>
    </div>
  );
}
