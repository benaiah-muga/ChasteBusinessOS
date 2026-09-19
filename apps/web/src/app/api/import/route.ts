import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { customers, getDb, items } from "@chaste/db";
import { hasPermission } from "@chaste/kernel";
import { getResolvedUser } from "@/server/session";
import { checkRateLimit } from "@/server/rate-limit";
import { setOnboardingStep } from "@/server/onboarding";

/**
 * CSV import for the two entities a migrating business almost always has a
 * spreadsheet of: customers and products.
 *
 * Rows are validated individually and inserted in batches. One malformed row
 * never aborts the import - it comes back in `errors` with its row number and
 * what was wrong, so the user can fix the file (or just carry on with the
 * rows that were fine) instead of guessing at a 500.
 */

const MAX_ROWS = 5_000;

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** Decimal currency → integer minor units, parsed from the raw string so a
 * float never represents money (X15). "19.99" → 1999 exactly; "1,234.56" →
 * 123456. More than two decimal places, malformed input and unsafe magnitudes
 * are row errors, never silent coercion. */
function toMinor(v: unknown): { value: number | null; error?: string } {
  if (v === null || v === undefined) return { value: null };
  const raw = String(v).trim();
  if (raw === "") return { value: null };
  const s = raw.replace(/[,\s]/g, "");
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return { value: null, error: `"${raw}" is not a valid amount.` };
  const [, neg, whole, fracRaw = ""] = m;
  if (fracRaw.length > 2) return { value: null, error: `"${raw}" has more than two decimal places.` };
  const value = Number(whole) * 100 + Number(fracRaw.padEnd(2, "0"));
  if (!Number.isSafeInteger(value)) return { value: null, error: `"${raw}" is too large.` };
  return { value: neg ? -value : value };
}

/** Money fields must not be negative (credit limits, sale prices). */
function toNonNegativeMinor(v: unknown): { value: number | null; error?: string } {
  const parsed = toMinor(v);
  if (parsed.error) return parsed;
  if (parsed.value !== null && parsed.value < 0) return { value: null, error: "Amount must not be negative." };
  return parsed;
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved) {
    return NextResponse.json(
      { error: "Your session has expired. Sign in again to continue.", code: "unauthorized" },
      { status: 401 },
    );
  }
  if (!resolved.orgId) {
    return NextResponse.json(
      { error: "Set up your workspace before importing data.", code: "not_found" },
      { status: 409 },
    );
  }

  const limit = checkRateLimit(`import:${resolved.orgId}`, { max: 40, windowMs: 60 * 60_000 });
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `Import limit reached. Try again in ${limit.retryAfterSec}s.`, code: "rate_limited" },
      { status: 429 },
    );
  }

  let payload: { entity?: unknown; rows?: unknown };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Could not read that request.", code: "invalid" }, { status: 400 });
  }

  const entity = payload.entity;
  if (entity !== "customers" && entity !== "products") {
    return NextResponse.json(
      { error: "Unknown import type. Expected customers or products.", code: "invalid" },
      { status: 400 },
    );
  }
  // Writing imported rows is domain authority (X15/N08), not mere session
  // membership: customers are CRM records, products are inventory records.
  const requiredPermission = entity === "customers" ? "crm.write" : "inventory.write";
  if (!hasPermission({ permissions: resolved.permissions }, requiredPermission)) {
    return NextResponse.json(
      { error: `forbidden: missing ${requiredPermission}`, code: "forbidden" },
      { status: 403 },
    );
  }
  if (!Array.isArray(payload.rows)) {
    return NextResponse.json(
      { error: "No rows to import.", code: "invalid" },
      { status: 400 },
    );
  }
  if (payload.rows.length > MAX_ROWS) {
    return NextResponse.json(
      {
        error: `That file has ${payload.rows.length} rows; the limit per import is ${MAX_ROWS}. Split it and import again.`,
        code: "invalid",
      },
      { status: 400 },
    );
  }

  const db = getDb().db;
  const orgId = resolved.orgId;
  const result: ImportResult = { inserted: 0, skippedDuplicates: 0, errors: [] };

  if (entity === "customers") {
    const toInsert: (typeof customers.$inferInsert)[] = [];
    const seen = new Set<string>();

    payload.rows.forEach((raw, i) => {
      const row = (raw ?? {}) as Record<string, unknown>;
      const line = i + 2; // +2: header is line 1
      const name = str(row.name);
      if (!name) {
        result.errors.push({ row: line, field: "name", message: "Name is required." });
        return;
      }
      const email = str(row.email);
      if (email && !EMAIL_RE.test(email)) {
        result.errors.push({ row: line, field: "email", message: `"${email}" is not a valid email.` });
        return;
      }
      const key = email ? `e:${email.toLowerCase()}` : `n:${name.toLowerCase()}`;
      if (seen.has(key)) {
        result.skippedDuplicates += 1;
        return;
      }
      seen.add(key);

      const credit = toNonNegativeMinor(row.creditLimit ?? row.credit_limit);
      if (credit.error) {
        result.errors.push({ row: line, field: "creditLimit", message: credit.error });
        return;
      }
      const terms = num(row.paymentTermDays ?? row.payment_terms ?? row.terms);
      toInsert.push({
        orgId,
        name,
        email,
        creditLimitMinor: credit.value,
        paymentTermDays: terms === null ? null : Math.max(0, Math.trunc(terms)),
      });
    });

    if (toInsert.length > 0) {
      const emails = toInsert.map((r) => r.email).filter((e): e is string => Boolean(e));
      const existing = new Set<string>();
      if (emails.length > 0) {
        const found = await db
          .select({ email: customers.email })
          .from(customers)
          .where(and(eq(customers.orgId, orgId), inArray(customers.email, emails)));
        for (const f of found) if (f.email) existing.add(f.email.toLowerCase());
      }
      const fresh = toInsert.filter((r) => !r.email || !existing.has(r.email.toLowerCase()));
      result.skippedDuplicates += toInsert.length - fresh.length;

      for (let i = 0; i < fresh.length; i += 500) {
        await db.insert(customers).values(fresh.slice(i, i + 500));
      }
      result.inserted = fresh.length;
    }

    if (result.inserted > 0) await setOnboardingStep(db, orgId, "import_customers", "done");
  } else {
    const toInsert: (typeof items.$inferInsert)[] = [];
    const seenSku = new Set<string>();

    payload.rows.forEach((raw, i) => {
      const row = (raw ?? {}) as Record<string, unknown>;
      const line = i + 2;
      const name = str(row.name);
      const sku = str(row.sku ?? row.code);
      if (!name) {
        result.errors.push({ row: line, field: "name", message: "Name is required." });
        return;
      }
      if (!sku) {
        result.errors.push({ row: line, field: "sku", message: "SKU is required." });
        return;
      }
      const key = sku.toLowerCase();
      if (seenSku.has(key)) {
        result.skippedDuplicates += 1;
        return;
      }
      seenSku.add(key);

      const price = toNonNegativeMinor(row.salePrice ?? row.price ?? row.unit_price);
      if (price.error) {
        result.errors.push({ row: line, field: "salePrice", message: price.error });
        return;
      }
      toInsert.push({
        orgId,
        sku,
        name,
        unitLabel: str(row.unit ?? row.unitLabel) ?? "unit",
        salePriceMinor: price.value ?? 0,
        barcode: str(row.barcode),
      });
    });

    if (toInsert.length > 0) {
      const skus = toInsert.map((r) => r.sku);
      const found = await db
        .select({ sku: items.sku })
        .from(items)
        .where(and(eq(items.orgId, orgId), inArray(items.sku, skus)));
      const existing = new Set(found.map((f) => f.sku.toLowerCase()));
      const fresh = toInsert.filter((r) => !existing.has(r.sku.toLowerCase()));
      result.skippedDuplicates += toInsert.length - fresh.length;

      for (let i = 0; i < fresh.length; i += 500) {
        await db.insert(items).values(fresh.slice(i, i + 500));
      }
      result.inserted = fresh.length;
    }

    if (result.inserted > 0) await setOnboardingStep(db, orgId, "import_products", "done");
  }

  return NextResponse.json(result);
}
