import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { hasPermission } from "@chaste/kernel";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
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

interface RowError { row: number; field?: string; message: string }

function minorAmount(value: string | number | undefined): { value: number | null; error?: string } {
  if (value === undefined || String(value).trim() === "") return { value: null };
  const raw = String(value).trim().replace(/[,\s]/g, "");
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) return { value: null, error: `"${String(value)}" is not a valid non-negative amount with at most two decimals.` };
  const amount = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(amount) ? { value: amount } : { value: null, error: "Amount is too large." };
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

  let payload: { entity?: unknown; rows?: unknown; action?: unknown; importIds?: unknown };
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
  if (entity === "customers" && payload.action === "undo") {
    const ids = z.array(z.string().uuid()).min(1).max(5000).safeParse(payload.importIds);
    if (!ids.success) return NextResponse.json({ error: "Select a valid recent import to undo.", code: "invalid" }, { status: 400 });
    const ctx = actorFromResolved(resolved, {});
    if (!ctx) return NextResponse.json({ error: "Set up your workspace before undoing this import.", code: "not_found" }, { status: 409 });
    const db = getDb().db;
    const result = await buildExecutor(db, buildRegistry(db)).execute("crm.undoCustomerImport", ctx, { customerIds: ids.data });
    if (result.pendingApproval) return NextResponse.json({ error: result.error ?? "Undo is awaiting approval.", pendingApproval: true }, { status: 202 });
    if (!result.ok) return NextResponse.json({ error: result.error ?? "The import could not be undone." }, { status: 422 });
    const data = result.data as { deactivated?: number } | undefined;
    return NextResponse.json({ undone: data?.deactivated ?? 0, remaining: Math.max(0, ids.data.length - (data?.deactivated ?? 0)) });
  }
  if (entity === "products" && payload.action === "undo") {
    const ids = z.array(z.string().uuid()).min(1).max(MAX_ROWS).safeParse(payload.importIds);
    if (!ids.success) return NextResponse.json({ error: "Select a valid recent import to undo.", code: "invalid" }, { status: 400 });
    const ctx = actorFromResolved(resolved, {});
    if (!ctx) return NextResponse.json({ error: "Set up your workspace before undoing this import.", code: "not_found" }, { status: 409 });
    const db = getDb().db;
    const result = await buildExecutor(db, buildRegistry(db)).execute("inventory.undoItemImport", ctx, { itemIds: ids.data });
    if (result.pendingApproval) return NextResponse.json({ error: result.error ?? "Undo is awaiting approval.", pendingApproval: true }, { status: 202 });
    if (!result.ok) return NextResponse.json({ error: result.error ?? "The import could not be undone." }, { status: 422 });
    const data = result.data as { archived?: number } | undefined;
    return NextResponse.json({ undone: data?.archived ?? 0, remaining: Math.max(0, ids.data.length - (data?.archived ?? 0)) });
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

  if (entity === "customers") {
    const ctx = actorFromResolved(resolved, {});
    if (!ctx) return NextResponse.json({ error: "Set up your workspace before importing customers.", code: "not_found" }, { status: 409 });
    const rows = z.array(z.object({
      rowNumber: z.number().int().positive().optional(),
      name: z.string().trim().min(1).max(120),
      email: z.string().email().nullable().optional(),
      phone: z.string().trim().max(40).nullable().optional(),
      creditLimitMinor: z.number().int().nonnegative().nullable().optional(),
      creditLimit: z.union([z.string(), z.number()]).optional(),
      paymentTermDays: z.union([z.string(), z.number()]).optional(),
      allowDuplicate: z.boolean().optional(),
    })).min(1).max(MAX_ROWS).safeParse(payload.rows);
    if (!rows.success) return NextResponse.json({ error: "Some rows are invalid. Review the preview and try again.", detail: rows.error.issues, code: "invalid" }, { status: 400 });
    const errors: RowError[] = [];
    const prepared = rows.data.flatMap((row, index) => {
      const rowNumber = row.rowNumber ?? index + 2;
      const credit = row.creditLimitMinor === undefined ? minorAmount(row.creditLimit) : { value: row.creditLimitMinor };
      if (credit.error) { errors.push({ row: rowNumber, field: "creditLimit", message: credit.error }); return []; }
      const rawTerms = row.paymentTermDays?.toString().trim();
      const termsNumber = rawTerms ? Number(rawTerms) : null;
      if (termsNumber !== null && (!Number.isFinite(termsNumber) || termsNumber < 0)) {
        errors.push({ row: rowNumber, field: "paymentTermDays", message: "Payment terms must be a non-negative number of days." });
        return [];
      }
      return [{
        rowNumber,
        name: row.name,
        ...(row.email !== undefined ? { email: row.email } : {}),
        ...(row.phone !== undefined ? { phone: row.phone } : {}),
        creditLimitMinor: credit.value,
        paymentTermDays: termsNumber === null ? null : Math.trunc(termsNumber),
        allowDuplicate: row.allowDuplicate ?? false,
      }];
    });
    if (prepared.length === 0) return NextResponse.json({ inserted: 0, skippedDuplicates: 0, errors, createdIds: [] });
    const db = getDb().db;
    const result = await buildExecutor(db, buildRegistry(db)).execute("crm.importCustomers", ctx, { rows: prepared });
    if (result.pendingApproval) return NextResponse.json({ error: result.error ?? "Import is awaiting approval.", pendingApproval: true }, { status: 202 });
    if (!result.ok) return NextResponse.json({ error: result.error ?? "The import could not be completed." }, { status: 422 });
    const data = result.data as { createdIds: string[]; imported: number; skippedDuplicateRows: number[] } | undefined;
    return NextResponse.json({ inserted: data?.imported ?? 0, skippedDuplicates: data?.skippedDuplicateRows.length ?? 0, skippedDuplicateRows: data?.skippedDuplicateRows ?? [], errors, createdIds: data?.createdIds ?? [] });
  }

  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "Set up your workspace before importing products.", code: "not_found" }, { status: 409 });
  const rows = z.array(z.object({
    rowNumber: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(120),
    sku: z.string().trim().max(40).optional(),
    kind: z.enum(["goods", "service"]).optional(),
    unitLabel: z.string().trim().max(20).optional(),
    salePriceMinor: z.number().int().nonnegative().optional(),
    salePrice: z.union([z.string(), z.number()]).optional(),
    price: z.union([z.string(), z.number()]).optional(),
    type: z.string().trim().max(20).optional(),
    reorderPointThousandths: z.number().int().nonnegative().optional(),
    barcode: z.string().trim().max(64).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(30)).optional(),
    unit: z.string().trim().max(20).optional(),
  })).min(1).max(MAX_ROWS).safeParse(payload.rows);
  if (!rows.success) return NextResponse.json({ error: "Some rows are invalid. Review the preview and try again.", detail: rows.error.issues, code: "invalid" }, { status: 400 });
  const errors: RowError[] = [];
  const prepared = rows.data.flatMap((row, index) => {
    const requestedKind = row.kind ?? row.type?.toLowerCase();
    if (requestedKind && !["goods", "product", "service", "services"].includes(requestedKind)) {
      errors.push({ row: row.rowNumber ?? index + 2, field: "type", message: `Use product or service, not "${requestedKind}".` });
      return [];
    }
    const kind = requestedKind === "service" || requestedKind === "services" ? "service" : "goods";
    const sku = row.sku?.trim() || (kind === "service" ? `SVC-IMPORT-${crypto.randomUUID().slice(0, 8).toUpperCase()}` : "");
    const rowNumber = row.rowNumber ?? index + 2;
    if (!sku) { errors.push({ row: rowNumber, field: "sku", message: "Products need a SKU." }); return []; }
    const rawPrice = row.salePriceMinor !== undefined ? row.salePriceMinor : row.salePrice ?? row.price ?? 0;
    let salePriceMinor: number;
    if (typeof rawPrice === "number") salePriceMinor = Number.isSafeInteger(rawPrice) && rawPrice >= 0 ? rawPrice : -1;
    else {
      const cleaned = rawPrice.replace(/[,\s]/g, "");
      const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
      salePriceMinor = match ? Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0")) : -1;
    }
    if (salePriceMinor < 0 || !Number.isSafeInteger(salePriceMinor)) {
      errors.push({ row: rowNumber, field: "salePrice", message: "Enter a non-negative amount with at most two decimals." });
      return [];
    }
    return [{
      rowNumber,
      name: row.name,
      sku,
      kind,
      unitLabel: kind === "service" ? row.unitLabel ?? row.unit ?? "hour" : row.unitLabel ?? row.unit ?? "unit",
      salePriceMinor,
      reorderPointThousandths: row.reorderPointThousandths ?? 0,
      barcode: row.barcode ?? null,
      tags: row.tags ?? [],
    }];
  });
  if (prepared.length === 0) return NextResponse.json({ inserted: 0, skippedDuplicates: 0, errors, createdIds: [] });
  const db = getDb().db;
  const result = await buildExecutor(db, buildRegistry(db)).execute("inventory.importItems", ctx, { rows: prepared });
  if (result.pendingApproval) return NextResponse.json({ error: result.error ?? "Import is awaiting approval.", pendingApproval: true }, { status: 202 });
  if (!result.ok) return NextResponse.json({ error: result.error ?? "The import could not be completed." }, { status: 422 });
  const data = result.data as { createdIds: string[]; imported: number; skippedDuplicateRows: number[] } | undefined;
  if (data?.imported) await setOnboardingStep(db, resolved.orgId, "import_products", "done");
  return NextResponse.json({ inserted: data?.imported ?? 0, skippedDuplicates: data?.skippedDuplicateRows.length ?? 0, skippedDuplicateRows: data?.skippedDuplicateRows ?? [], errors, createdIds: data?.createdIds ?? [] });
}
