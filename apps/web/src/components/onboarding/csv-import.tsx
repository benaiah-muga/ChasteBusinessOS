"use client";

import { useMemo, useRef, useState } from "react";
import { FIELD_SYNONYMS, REQUIRED_FIELDS, guessMapping, parseCsv } from "@/lib/csv";
import { postApi } from "@/lib/api";
import { cn } from "@/lib/format";
import {
  IconAlertTriangle,
  IconCheck,
  IconFileText,
  IconUpload,
  IconX,
} from "@/components/icons";
import {
  RecoverBlock,
  Spinner,
  ghostButtonClass,
  inputClass,
  primaryButtonClass,
} from "./parts";

/**
 * Spreadsheet import: pick a file, confirm which column is which, see exactly
 * what will land, then import.
 *
 * The mapping step is not ceremony. Guessing silently is how a business ends up
 * with 400 customers whose names are their email addresses, so anything the
 * guesser is unsure about is shown as a question rather than a decision made
 * for them.
 */

type Entity = "customers" | "products";

const ENTITIES: { id: Entity; label: string; hint: string }[] = [
  { id: "customers", label: "Customers", hint: "Who you invoice" },
  { id: "products", label: "Products", hint: "What you sell" },
];

const FIELD_LABELS: Record<string, string> = {
  name: "Name",
  email: "Email",
  creditLimit: "Credit limit",
  paymentTermDays: "Payment terms (days)",
  sku: "SKU",
  unitLabel: "Unit",
  salePrice: "Sale price",
  barcode: "Barcode",
};

const FIELD_NOTES: Record<string, string> = {
  creditLimit: "Plain amount, e.g. 5000 — not 500000 cents.",
  salePrice: "Plain amount, e.g. 24.99.",
  paymentTermDays: "Whole days, e.g. 30.",
  unitLabel: "e.g. unit, box, kg.",
};

const MAX_ROWS = 5_000;
const MAX_BYTES = 5 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface RowError {
  row: number;
  field?: string;
  message: string;
}

interface ImportResult {
  inserted: number;
  skippedDuplicates: number;
  errors: RowError[];
}

export interface ImportOutcome {
  entity: Entity;
  inserted: number;
}

export function CsvImportPanel({
  onImported,
  onSkipped,
}: {
  onImported: (outcome: ImportOutcome) => void;
  onSkipped: () => void;
}) {
  const [entity, setEntity] = useState<Entity>("customers");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [failure, setFailure] = useState<{ title: string; hint: string; detail?: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const fields = useMemo(() => Object.keys(FIELD_SYNONYMS[entity]), [entity]);
  const required = REQUIRED_FIELDS[entity];

  /** Rows rebuilt through the current mapping, with client-side checks first. */
  const prepared = useMemo(() => {
    const payload: Record<string, string>[] = [];
    const problems: RowError[] = [];
    rows.forEach((row, i) => {
      const line = i + 2;
      const out: Record<string, string> = {};
      for (const f of fields) {
        const col = mapping[f];
        if (!col) continue;
        const v = (row[col] ?? "").trim();
        if (v !== "") out[f] = v;
      }
      const missingField = required.find((f) => !out[f]);
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
      if (out.salePrice && Number.isNaN(Number(out.salePrice.replace(/[,\s]/g, "")))) {
        problems.push({ row: line, field: "salePrice", message: `"${out.salePrice}" is not a number.` });
        return;
      }
      payload.push(out);
    });
    return { payload, problems };
  }, [rows, mapping, fields, required]);

  function reset() {
    setHeaders([]);
    setRows([]);
    setMapping({});
    setFileName(null);
    setParseError(null);
    setResult(null);
    setFailure(null);
  }

  function switchEntity(next: Entity) {
    setEntity(next);
    reset();
  }

  async function readFile(file: File) {
    reset();
    if (file.size > MAX_BYTES) {
      setParseError(
        `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 5 MB — split it into a few files and import each one.`,
      );
      return;
    }
    const text = await file.text();
    const table = parseCsv(text);
    if (table.headers.length === 0 || table.rows.length === 0) {
      setParseError(
        "That file looks empty. Export it again making sure the first row holds your column headings.",
      );
      return;
    }
    if (table.rows.length > MAX_ROWS) {
      setParseError(
        `That file has ${table.rows.length.toLocaleString()} rows; one import handles ${MAX_ROWS.toLocaleString()}. Split it and import the pieces.`,
      );
      return;
    }
    setFileName(file.name);
    setHeaders(table.headers);
    setRows(table.rows);
    setMapping(guessMapping(entity, table.headers));
  }

  async function runImport() {
    setBusy(true);
    setFailure(null);
    setResult(null);
    const res = await postApi<ImportResult>("/api/import", { entity, rows: prepared.payload });
    if (!res.ok || !res.data) {
      setFailure(res.error ?? { title: "That didn't work", hint: "Try again in a moment." });
      setBusy(false);
      return;
    }
    setResult(res.data);
    setBusy(false);
    if (res.data.inserted > 0) onImported({ entity, inserted: res.data.inserted });
  }

  /* ── 1. The file ─────────────────────────────────────────────────────── */

  if (headers.length === 0) {
    return (
      <div>
        <div className="mb-4 inline-flex rounded-lg bg-sand-100 p-0.5" role="tablist" aria-label="What are you importing?">
          {ENTITIES.map((e) => (
            <button
              key={e.id}
              type="button"
              role="tab"
              aria-selected={entity === e.id}
              onClick={() => switchEntity(e.id)}
              className={cn(
                "inline-flex cursor-pointer items-center gap-2 rounded-md px-3.5 py-1.5 text-[13px] font-medium transition-all duration-150",
                entity === e.id
                  ? "bg-cream text-ink shadow-xs"
                  : "text-ink-muted hover:text-ink",
              )}
            >
              {e.label}
              <span className="hidden text-[11px] text-ink-muted/70 sm:inline">{e.hint}</span>
            </button>
          ))}
        </div>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void readFile(file);
          }}
          className={cn(
            "rounded-xl border-2 border-dashed p-8 text-center transition-colors",
            dragging ? "border-gold-500 bg-gold-500/8" : "border-sand-300 bg-sand-50",
          )}
        >
          <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-gold-500/12 text-gold-600">
            <IconUpload className="size-5" />
          </span>
          <p className="mt-3.5 text-[15px] font-semibold text-ink">
            Drop your {entity === "customers" ? "customer" : "product"} file here
          </p>
          <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-muted">
            A CSV exported from Excel, Google Sheets, QuickBooks or anywhere else. The first row
            should be your column headings.
          </p>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className={cn(primaryButtonClass, "mt-4 w-auto px-5")}
          >
            Choose a file
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv,text/plain"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void readFile(file);
              e.target.value = "";
            }}
          />
          <p className="mt-3 text-[11px] text-ink-muted/80">
            Nothing is uploaded until you press import. Files stay in your browser until then.
          </p>
        </div>

        {parseError && (
          <div className="mt-4">
            <RecoverBlock title="We couldn't read that file">
              {parseError}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className={cn(primaryButtonClass, "h-9 w-auto px-3.5 text-[13px]")}
                >
                  Try another file
                </button>
                <button type="button" onClick={onSkipped} className={cn(ghostButtonClass, "h-9")}>
                  Skip importing for now
                </button>
              </div>
            </RecoverBlock>
          </div>
        )}

        <div className="mt-5 flex items-start gap-2.5 rounded-lg bg-sand-50 px-3.5 py-3 text-[13px] text-ink-muted ring-1 ring-sand-200">
          <IconFileText className="mt-0.5 size-4 shrink-0 text-gold-600" />
          <span>
            {entity === "customers" ? (
              <>
                We need a <strong className="font-semibold text-ink">name</strong> column. Email,
                credit limit and payment terms are optional — you can fill those in later, one
                customer at a time.
              </>
            ) : (
              <>
                We need a <strong className="font-semibold text-ink">SKU</strong> and a{" "}
                <strong className="font-semibold text-ink">name</strong>. Price, unit and barcode
                are optional.
              </>
            )}
          </span>
        </div>

        <div className="mt-5">
          <button type="button" onClick={onSkipped} className={ghostButtonClass}>
            Skip this and add {entity === "customers" ? "customers" : "products"} later
          </button>
        </div>
      </div>
    );
  }

  /* ── 2. Map and confirm ──────────────────────────────────────────────── */

  const unmappedRequired = required.filter((f) => !mapping[f]);
  const onlyUnmapped = unmappedRequired.length === 1 ? unmappedRequired[0] : undefined;
  const labelFor = (f: string) => FIELD_LABELS[f] ?? f;
  const preview = prepared.payload.slice(0, 5);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-sand-50 px-3.5 py-2.5 ring-1 ring-sand-200">
        <div className="flex min-w-0 items-center gap-2.5">
          <IconFileText className="size-4 shrink-0 text-gold-600" />
          <span className="truncate text-[13px] font-medium text-ink">{fileName}</span>
          <span className="shrink-0 text-[12px] text-ink-muted">
            {rows.length.toLocaleString()} rows · {headers.length} columns
          </span>
        </div>
        <button type="button" onClick={reset} className={cn(ghostButtonClass, "shrink-0")}>
          <IconX className="size-3.5" />
          Use a different file
        </button>
      </div>

      <h3 className="mt-6 text-[15px] font-semibold text-ink">Match your columns</h3>
      <p className="mt-1 text-[13px] text-ink-muted">
        We took a first guess from your headings. Change anything that looks wrong.
      </p>

      <div className="mt-4 space-y-2.5">
        {fields.map((f) => {
          const isRequired = required.includes(f);
          const missing = isRequired && !mapping[f];
          return (
            <div key={f} className="flex flex-wrap items-center gap-3">
              <label
                htmlFor={`map-${f}`}
                className="flex w-44 shrink-0 items-center gap-1.5 text-[13px] font-medium text-ink"
              >
                {FIELD_LABELS[f] ?? f}
                {isRequired ? (
                  <span className="text-[10px] font-bold tracking-wide text-gold-600 uppercase">
                    required
                  </span>
                ) : (
                  <span className="text-[10px] text-ink-muted/70">optional</span>
                )}
              </label>
              <select
                id={`map-${f}`}
                value={mapping[f] ?? ""}
                onChange={(e) => setMapping({ ...mapping, [f]: e.target.value || null })}
                className={cn(inputClass, "h-9 w-full max-w-xs", missing && "border-red-300")}
              >
                <option value="">— not in my file —</option>
                {headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
              {FIELD_NOTES[f] && mapping[f] && (
                <span className="text-[12px] text-ink-muted">{FIELD_NOTES[f]}</span>
              )}
            </div>
          );
        })}
      </div>

      {unmappedRequired.length > 0 && (
        <div className="mt-4">
          <RecoverBlock
            tone="warn"
            title={
              onlyUnmapped
                ? `We still need a ${labelFor(onlyUnmapped)} column`
                : "Some required columns aren't matched yet"
            }
          >
            {onlyUnmapped ? (
              <>
                No column was matched to <strong className="font-semibold">{labelFor(onlyUnmapped)}</strong>.
                Either pick the right column above, or add that column to your file and re-export it.
                Nothing has been imported.
              </>
            ) : (
              <>
                These are still unmatched:{" "}
                <strong className="font-semibold">{unmappedRequired.map(labelFor).join(", ")}</strong>.
                Nothing has been imported.
              </>
            )}
          </RecoverBlock>
        </div>
      )}

      {preview.length > 0 && (
        <div className="mt-6">
          <div className="flex items-baseline justify-between">
            <h3 className="text-[15px] font-semibold text-ink">A look at what will land</h3>
            <span className="text-[12px] text-ink-muted">First {preview.length} rows</span>
          </div>
          <div className="mt-2.5 overflow-x-auto rounded-lg ring-1 ring-sand-200">
            <table className="w-full min-w-[32rem] text-left text-[13px]">
              <thead className="bg-sand-100 text-[11px] tracking-wide text-ink-muted uppercase">
                <tr>
                  {required.concat(fields.filter((f) => !required.includes(f))).map((f) => (
                    <th key={f} className="px-3 py-2 font-semibold">
                      {FIELD_LABELS[f] ?? f}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.map((r, i) => (
                  <tr key={i} className="border-t border-sand-200 bg-cream">
                    {required
                      .concat(fields.filter((f) => !required.includes(f)))
                      .map((f) => (
                        <td key={f} className="px-3 py-2 text-ink">
                          {r[f] ?? <span className="text-ink-muted/50">—</span>}
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
        <p className="mt-3 flex items-start gap-2 text-[13px] text-ink-muted">
          <IconAlertTriangle className="mt-0.5 size-4 shrink-0 text-gold-600" />
          <span>
            {prepared.problems.length} of {rows.length} rows will be left out because something is
            missing or malformed. The rest still import — you can fix those rows and import them
            again afterwards.
          </span>
        </p>
      )}

      {failure && (
        <div className="mt-4">
          <RecoverBlock title={failure.title}>
            {failure.hint}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void runImport()}
                className={cn(primaryButtonClass, "h-9 w-auto px-3.5 text-[13px]")}
              >
                Try again
              </button>
              <button type="button" onClick={onSkipped} className={cn(ghostButtonClass, "h-9")}>
                Skip for now
              </button>
            </div>
          </RecoverBlock>
        </div>
      )}

      {result && (
        <div className="mt-4 rounded-lg border border-sand-200 bg-cream p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-ink">
            <IconCheck className="size-4 text-gold-600" />
            {result.inserted > 0
              ? `${result.inserted.toLocaleString()} ${entity === "customers" ? "customers" : "products"} imported`
              : "Nothing new was imported"}
          </p>
          <ul className="mt-2 space-y-1 text-[13px] text-ink-muted">
            {result.skippedDuplicates > 0 && (
              <li>
                {result.skippedDuplicates.toLocaleString()} already existed{" "}
                {result.skippedDuplicates === 1 ? "(left as it was)" : "(left as they were)"}.
              </li>
            )}
            {result.errors.length > 0 && (
              <li>{result.errors.length.toLocaleString()} rows were set aside — see below.</li>
            )}
          </ul>

          {result.errors.length > 0 && (
            <div className="mt-3 max-h-40 overflow-y-auto rounded-md bg-sand-50 p-3">
              <ul className="space-y-1 text-[12px] text-ink-muted">
                {result.errors.slice(0, 12).map((e) => (
                  <li key={`${e.row}-${e.message}`}>
                    <span className="font-medium text-ink">Row {e.row}</span> — {e.message}
                  </li>
                ))}
              </ul>
              {result.errors.length > 12 && (
                <p className="mt-2 text-[12px] text-ink-muted">
                  …and {result.errors.length - 12} more. Fix them in your file and import it again —
                  anything already imported won&apos;t be duplicated.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void runImport()}
          disabled={busy || prepared.payload.length === 0}
          className={cn(primaryButtonClass, "w-auto px-5")}
        >
          {busy && <Spinner />}
          {busy
            ? "Importing…"
            : `Import ${prepared.payload.length.toLocaleString()} ${entity === "customers" ? "customers" : "products"}`}
        </button>
        <button type="button" onClick={onSkipped} disabled={busy} className={ghostButtonClass}>
          Skip for now
        </button>
      </div>
    </div>
  );
}
