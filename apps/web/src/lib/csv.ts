/**
 * Minimal RFC 4180 CSV reader and a header guesser for the import wizard.
 *
 * Client-side on purpose: parsing never touches the database, and showing the
 * user exactly which columns we understood — before anything is written — is
 * the difference between a confident import and a silent mess.
 */

export interface CsvTable {
  headers: string[];
  rows: Record<string, string>[];
}

/** Splits on commas and newlines, honouring double-quoted fields and "" escapes. */
export function parseCsv(text: string): CsvTable {
  // Strip a UTF-8 BOM, which Excel writes and which would otherwise become
  // part of the first header name and break every column match.
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

    if (ch === '"') {
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

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };

  const [headerRow] = nonEmpty;
  if (!headerRow) return { headers: [], rows: [] };
  const headers = headerRow.map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (const r of nonEmpty.slice(1)) {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = (r[i] ?? "").trim();
    });
    out.push(obj);
  }
  return { headers, rows: out };
}

/** Canonical fields per entity, with the synonyms spreadsheets actually use. */
export const FIELD_SYNONYMS: Record<"customers" | "products", Record<string, string[]>> = {
  customers: {
    name: ["name", "customer", "customer name", "company", "contact", "display name"],
    email: ["email", "e-mail", "email address", "mail"],
    creditLimit: ["credit limit", "credit", "credit limit minor", "ar limit"],
    paymentTermDays: ["payment terms", "terms", "net days", "payment term days", "terms (days)"],
  },
  products: {
    sku: ["sku", "code", "item code", "product code", "item", "id"],
    name: ["name", "product", "product name", "item name", "description", "title"],
    unitLabel: ["unit", "unit label", "uom", "unit of measure"],
    salePrice: ["price", "sale price", "unit price", "selling price", "amount", "rate"],
    barcode: ["barcode", "bar code", "ean", "upc"],
  },
};

export const REQUIRED_FIELDS: Record<"customers" | "products", string[]> = {
  customers: ["name"],
  products: ["sku", "name"],
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Best-effort header → canonical field mapping. Returns null for a field
 * nothing looked like, so the UI can ask rather than guess wrong in silence.
 */
export function guessMapping(
  entity: "customers" | "products",
  headers: string[],
): Record<string, string | null> {
  const mapping: Record<string, string | null> = {};
  const taken = new Set<string>();

  for (const [field, synonyms] of Object.entries(FIELD_SYNONYMS[entity])) {
    const wanted = synonyms.map(norm);
    // Exact match first, then substring, so "Email" beats "Email (work)".
    let hit = headers.find((h) => !taken.has(h) && wanted.includes(norm(h)));
    if (!hit) {
      hit = headers.find((h) => !taken.has(h) && wanted.some((w) => norm(h).includes(w)));
    }
    mapping[field] = hit ?? null;
    if (hit) taken.add(hit);
  }
  return mapping;
}
