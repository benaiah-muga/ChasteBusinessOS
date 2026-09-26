"use client";

import { useMemo, useState } from "react";
import { findDuplicate, normalizeCustomerName, normalizeEmail, normalizePhone, type CustomerFingerprint, type DuplicateVerdict } from "@chaste/erp-core";
import { Button, Dialog } from "@/components/ui";
import { postApi } from "@/lib/api";
import { cn } from "@/lib/format";

interface ExistingCustomer extends CustomerFingerprint {
  id: string;
  deactivatedAt: string | null;
}

interface ImportRow {
  rowNumber: number;
  name: string;
  email: string;
  phone: string;
}

interface PreviewRow extends ImportRow {
  error: string | null;
  duplicate: string | null;
  include: boolean;
  allowDuplicate: boolean;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell.length === 0) quoted = true;
    else if (char === ",") { row.push(cell.trim()); cell = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  row.push(cell.trim());
  if (row.some((value) => value.length > 0)) rows.push(row);
  return rows;
}

function matchingHeader(headers: string[], terms: string[]): string {
  return headers.find((header) => terms.includes(header.trim().toLowerCase().replace(/[_-]+/g, " "))) ?? "";
}

function templateDownload() {
  const blob = new Blob(["name,email,phone\nAda Lovelace,ada@example.com,+256 700 000 000\n"], { type: "text/csv;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = "customer-import-template.csv";
  anchor.click();
  URL.revokeObjectURL(href);
}

export function CustomerImportDialog(props: {
  open: boolean;
  customers: ExistingCustomer[];
  onClose: () => void;
  onImported: () => void;
  onNotice: (message: string, error?: boolean) => void;
}) {
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [sourceRows, setSourceRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState({ name: "", email: "", phone: "" });
  const [edits, setEdits] = useState<Record<number, Partial<ImportRow>>>({});
  const [includedRows, setIncludedRows] = useState<Record<number, boolean>>({});
  const [duplicateRows, setDuplicateRows] = useState<Record<number, boolean>>({});
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ imported: number; skipped: number; undoIds: string[]; undone: boolean } | null>(null);

  const preview = useMemo<PreviewRow[]>(() => {
    const existing = props.customers.filter((customer) => !customer.deactivatedAt);
    const emails = new Map<string, string>();
    const phones = new Map<string, string>();
    const names = new Map<string, string>();
    const namePrefixes = new Map<string, CustomerFingerprint[]>();
    const remember = (fingerprint: CustomerFingerprint) => {
      const email = normalizeEmail(fingerprint.email);
      const phone = normalizePhone(fingerprint.phone);
      const name = normalizeCustomerName(fingerprint.name);
      if (email) emails.set(email, fingerprint.name);
      if (phone) phones.set(phone, fingerprint.name);
      if (name) {
        names.set(name, fingerprint.name);
        const prefix = name.slice(0, 2);
        namePrefixes.set(prefix, [...(namePrefixes.get(prefix) ?? []), fingerprint]);
      }
    };
    existing.forEach(remember);
    return sourceRows.map((source, index) => {
      const sourceValue = (column: string) => {
        const columnIndex = headers.indexOf(column);
        return columnIndex < 0 ? "" : source[columnIndex] ?? "";
      };
      const row: ImportRow = {
        rowNumber: index + 2,
        name: (edits[index]?.name ?? sourceValue(mapping.name)).trim(),
        email: (edits[index]?.email ?? sourceValue(mapping.email)).trim(),
        phone: (edits[index]?.phone ?? sourceValue(mapping.phone)).trim(),
      };
      const emailValid = !row.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email);
      const error = !row.name ? "Customer name is required" : row.name.length > 120 ? "Customer name must be 120 characters or fewer" : !emailValid ? "Enter a valid email" : row.phone.length > 40 ? "Phone must be 40 characters or fewer" : null;
      const candidate = { name: row.name, email: row.email || null, phone: row.phone || null };
      const emailMatch = normalizeEmail(candidate.email) ? emails.get(normalizeEmail(candidate.email)!) : undefined;
      const phoneMatch = normalizePhone(candidate.phone) ? phones.get(normalizePhone(candidate.phone)!) : undefined;
      const normalizedName = normalizeCustomerName(candidate.name);
      const exactNameMatch = normalizedName ? names.get(normalizedName) : undefined;
      const fuzzyMatch: DuplicateVerdict = normalizedName.length >= 2
        ? findDuplicate(namePrefixes.get(normalizedName.slice(0, 2)) ?? [], candidate)
        : { duplicate: false, reason: null, existingName: null };
      const duplicate: DuplicateVerdict = !row.name
        ? { duplicate: false, reason: null, existingName: null }
        : emailMatch
            ? { duplicate: true, reason: "email", existingName: emailMatch }
            : phoneMatch
              ? { duplicate: true, reason: "phone", existingName: phoneMatch }
              : exactNameMatch
                ? { duplicate: true, reason: "name", existingName: exactNameMatch }
                : fuzzyMatch;
      if (row.name) remember(candidate);
      const hasDuplicate = duplicate.duplicate;
      return {
        ...row,
        error,
        duplicate: hasDuplicate ? `${duplicate.reason} match: ${duplicate.existingName ?? "another row in this file"}` : null,
        include: includedRows[index] ?? (!error && !hasDuplicate),
        allowDuplicate: duplicateRows[index] ?? false,
      };
    });
  }, [sourceRows, headers, mapping, edits, includedRows, duplicateRows, props.customers]);

  const validCount = preview.filter((row) => !row.error).length;
  const duplicateCount = preview.filter((row) => row.duplicate).length;
  const selectedCount = preview.filter((row) => row.include && !row.error).length;
  const pageSize = 40;
  const visibleRows = preview.slice(page * pageSize, (page + 1) * pageSize).map((row, offset) => ({ row, index: page * pageSize + offset }));

  function reset() {
    setFileName(""); setHeaders([]); setSourceRows([]); setMapping({ name: "", email: "", phone: "" });
    setEdits({}); setIncludedRows({}); setDuplicateRows({}); setError(null); setSummary(null); setPage(0);
  }

  async function readFile(file: File | undefined) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv") && file.type !== "text/csv") { setError("Choose a CSV file to continue."); return; }
    setError(null); setSummary(null); setFileName(file.name);
    const parsed = parseCsv(await file.text());
    if (parsed.length < 2) { setError("Add a header row and at least one customer row."); setHeaders([]); setSourceRows([]); return; }
    if (parsed.length - 1 > 5000) { setError("This file has more than 5,000 rows. Split it into smaller imports."); setHeaders([]); setSourceRows([]); return; }
    const nextHeaders = parsed[0]!.map((header) => header.trim());
    setHeaders(nextHeaders);
    setSourceRows(parsed.slice(1).map((row) => nextHeaders.map((_, index) => row[index] ?? "")));
    setMapping({
      name: matchingHeader(nextHeaders, ["name", "customer name", "full name", "company", "business name"]),
      email: matchingHeader(nextHeaders, ["email", "email address"]),
      phone: matchingHeader(nextHeaders, ["phone", "phone number", "mobile", "telephone"]),
    });
    setEdits({}); setIncludedRows({}); setDuplicateRows({}); setPage(0);
  }

  async function importRows() {
    const rows = preview.filter((row) => row.include && !row.error);
    if (rows.length === 0) return;
    setBusy(true); setError(null);
    try {
      const response = await postApi<{ inserted?: number; skippedDuplicates?: number; createdIds?: string[]; errors?: Array<{ row: number; message: string }> }>("/api/import", {
        entity: "customers",
        rows: rows.map((row) => ({ rowNumber: row.rowNumber, name: row.name, ...(row.email ? { email: row.email } : {}), ...(row.phone ? { phone: row.phone } : {}), allowDuplicate: row.allowDuplicate })),
      });
      if (response.status === 202) { setError("The import is waiting for approval. Check Approvals before trying again."); return; }
      if (!response.ok) { setError(response.error?.title ?? "The import did not finish. Review the rows and try again."); return; }
      const data = response.data;
      setSummary({ imported: data?.inserted ?? 0, skipped: data?.skippedDuplicates ?? 0, undoIds: data?.createdIds ?? [], undone: false });
      props.onImported();
      props.onNotice(`Imported ${data?.inserted ?? 0} customers. ${data?.skippedDuplicates ?? 0} likely duplicates were skipped.`);
    } finally {
      setBusy(false);
    }
  }

  async function undoImport() {
    if (!summary?.undoIds.length) return;
    setBusy(true); setError(null);
    try {
      const response = await postApi<{ undone?: number; remaining?: number }>("/api/import", { entity: "customers", action: "undo", importIds: summary.undoIds });
      if (!response.ok) { setError(response.error?.title ?? "Could not undo this import."); return; }
      const undone = response.data?.undone ?? 0;
      const remaining = response.data?.remaining ?? 0;
      setSummary({ ...summary, undoIds: [], undone: true });
      props.onImported();
      props.onNotice(remaining ? `Deactivated ${undone} imported customers. ${remaining} could not be changed because they were already updated.` : `Undid this import. ${undone} imported customers were deactivated.`);
    } finally {
      setBusy(false);
    }
  }

  return <Dialog open={props.open} onClose={() => { if (busy) return; reset(); props.onClose(); }} title="Import customers" description="Map your columns, review likely matches, and fix invalid rows before adding customers." width="max-w-5xl">
    {summary ? <div className="space-y-4">
      <div className={cn("rounded-xl border p-4", summary.undone ? "border-stone-200 bg-stone-50" : "border-emerald-200 bg-emerald-50")} role="status">
        <h3 className="font-semibold text-stone-900">{summary.undone ? "Import undone" : "Import complete"}</h3>
        <p className="mt-1 text-sm text-stone-600">{summary.undone ? "Imported customers were deactivated, and their linked history remains intact." : `${summary.imported} customers added · ${summary.skipped} likely duplicates skipped.`}</p>
      </div>
      {!summary.undone && summary.undoIds.length > 0 && <Button tone="secondary" disabled={busy} loading={busy} onClick={() => void undoImport()}>Undo this import</Button>}
      <Button className="w-full" onClick={() => { reset(); props.onClose(); }}>Done</Button>
    </div> : <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-stone-200 bg-stone-50/70 p-4">
        <div><p className="text-sm font-semibold text-stone-800">Start with a CSV</p><p className="mt-0.5 text-xs text-stone-500">We keep your column names and values in this preview until you import.</p></div>
        <div className="flex flex-wrap items-center gap-2"><button type="button" className="text-xs font-medium text-stone-600 underline" onClick={templateDownload}>Download template</button><label className="inline-flex min-h-10 cursor-pointer items-center rounded-md bg-emerald-800 px-3 text-sm font-semibold text-white hover:bg-emerald-900">{fileName || "Choose CSV"}<input className="sr-only" type="file" accept=".csv,text/csv" onChange={(event) => void readFile(event.target.files?.[0])} /></label></div>
      </div>
      {headers.length > 0 && <>
        <section className="grid gap-3 rounded-xl border border-stone-200 p-4 sm:grid-cols-3" aria-label="Column mapping">
          {(["name", "email", "phone"] as const).map((field) => <label key={field} className="label capitalize">{field}{field === "name" && <span className="text-red-600"> *</span>}
            <select className="select mt-1" value={mapping[field]} onChange={(event) => setMapping((current) => ({ ...current, [field]: event.target.value }))}><option value="">Do not import</option>{headers.map((header) => <option key={`${field}-${header}`} value={header}>{header || "Unnamed column"}</option>)}</select>
          </label>)}
        </section>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-stone-500"><span>{sourceRows.length} rows · {validCount} valid · {duplicateCount} possible duplicates</span><span>{selectedCount} selected to import</span></div>
        <div className="flex items-center justify-between text-xs text-stone-500"><span>Rows {page * pageSize + 1}-{Math.min((page + 1) * pageSize, preview.length)} of {preview.length}</span><div className="flex gap-2"><button type="button" className="rounded border border-stone-200 px-2 py-1 disabled:opacity-40" disabled={page === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>Previous</button><button type="button" className="rounded border border-stone-200 px-2 py-1 disabled:opacity-40" disabled={(page + 1) * pageSize >= preview.length} onClick={() => setPage((current) => current + 1)}>Next</button></div></div>
        <div className="max-h-[48vh] overflow-auto rounded-xl border border-stone-200">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="sticky top-0 bg-stone-50 text-left text-xs text-stone-500"><tr><th className="p-2">Import</th><th className="p-2">Row</th><th className="p-2">Customer name</th><th className="p-2">Email</th><th className="p-2">Phone</th><th className="p-2">Review</th></tr></thead>
            <tbody>{visibleRows.map(({ row, index }) => <tr key={row.rowNumber} className="border-t border-stone-100 align-top">
              <td className="p-2"><input type="checkbox" aria-label={`Import row ${row.rowNumber}`} checked={row.include} disabled={Boolean(row.error)} onChange={(event) => setIncludedRows((current) => ({ ...current, [index]: event.target.checked }))} /></td>
              <td className="p-2 text-xs text-stone-500">{row.rowNumber}</td>
              {(["name", "email", "phone"] as const).map((field) => <td key={field} className="p-2"><input className={cn("input h-9 min-w-40", field === "name" && !row.name && "border-red-300")} aria-label={`Row ${row.rowNumber} ${field}`} value={row[field]} onChange={(event) => setEdits((current) => ({ ...current, [index]: { ...current[index], [field]: event.target.value } }))} /></td>)}
              <td className="max-w-48 p-2 text-xs">{row.error ? <span className="text-red-700">{row.error}</span> : row.duplicate ? <label className="flex items-start gap-1.5 text-amber-800"><input type="checkbox" checked={row.allowDuplicate} onChange={(event) => setDuplicateRows((current) => ({ ...current, [index]: event.target.checked }))} /><span>{row.duplicate}. Import anyway</span></label> : <span className="text-emerald-700">Ready</span>}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </>}
      {error && <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p>}
      <div className="flex justify-end gap-2"><Button tone="secondary" disabled={busy} onClick={() => { reset(); props.onClose(); }}>Cancel</Button><Button disabled={busy || selectedCount === 0} loading={busy} onClick={() => void importRows()}>Import {selectedCount} customers</Button></div>
    </div>}
  </Dialog>;
}
