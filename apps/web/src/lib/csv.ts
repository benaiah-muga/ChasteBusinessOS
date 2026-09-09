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

    // A quote only opens a quoted field when it sits at the start of one.
    // RFC 4180 treats a quote anywhere else as literal data, and honouring that
    // is what keeps `6" pipe` from quietly becoming `6 pipe` on the way in.
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
 * Shortest synonym allowed to match on a substring. Below this length the
 * false positives outweigh the hits: "id" lives inside "paid", "ean" inside
 * "cleaner", and a column nobody meant to import ends up as the SKU.
 */
const SUBSTRING_SYNONYM_MIN = 4;

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
  const cols = headers.map((raw) => ({ raw, norm: norm(raw) }));
  const fields = Object.keys(FIELD_SYNONYMS[entity]);
  const wantedFor = new Map(
    fields.map((f) => [f, (FIELD_SYNONYMS[entity][f] ?? []).map(norm)] as const),
  );

  for (const field of fields) mapping[field] = null;

  /* Pass 1 — exact matches, resolved for *every* field before any fuzzy match
     runs. Doing it per-field instead is how "Unit Price" used to land on
     `unitLabel`: that field is declared first, found no exact match, and fell
     through to a substring match on "unit" before `salePrice` — for which
     "unit price" is a listed synonym — was ever consulted. */
  for (const field of fields) {
    const wanted = wantedFor.get(field) ?? [];
    const hit = cols.find((c) => !taken.has(c.raw) && wanted.includes(c.norm));
    if (hit) {
      mapping[field] = hit.raw;
      taken.add(hit.raw);
    }
  }

  /* Pass 2 — substring matches for whatever is still unmatched, most specific
     synonym first so a longer phrase beats the short word nested inside it. */
  const candidates: { field: string; raw: string; score: number; fieldRank: number; colRank: number }[] = [];
  fields.forEach((field, fieldRank) => {
    if (mapping[field]) return;
    const wanted = wantedFor.get(field) ?? [];
    cols.forEach((c, colRank) => {
      if (taken.has(c.raw)) return;
      let best = 0;
      for (const w of wanted) {
        if (w.length >= SUBSTRING_SYNONYM_MIN && c.norm.includes(w)) best = Math.max(best, w.length);
      }
      if (best > 0) candidates.push({ field, raw: c.raw, score: best, fieldRank, colRank });
    });
  });
  candidates.sort((a, b) => b.score - a.score || a.fieldRank - b.fieldRank || a.colRank - b.colRank);
  for (const c of candidates) {
    if (mapping[c.field] || taken.has(c.raw)) continue;
    mapping[c.field] = c.raw;
    taken.add(c.raw);
  }

  return mapping;
}
