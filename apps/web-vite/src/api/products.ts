import { z } from "zod";

const ProductSchema = z.object({
  sku: z.string().min(1),
  name: z.string(),
  kind: z.enum(["goods", "service"]),
  unitLabel: z.string(),
  salePriceMinor: z.number().int().safe().default(0),
  imageUrl: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  barcode: z.string().nullable().optional(),
  onHandThousandths: z.number().int().safe(),
  valueMinor: z.number().int().safe(),
  avgUnitCostMinor: z.number().int().safe(),
  reorderPointThousandths: z.number().int().safe(),
  reorderNeeded: z.boolean(),
}).passthrough();

const CatalogSchema = z.object({
  items: z.array(ProductSchema),
  reorderAlerts: z.array(z.object({ sku: z.string(), name: z.string(), shortfallThousandths: z.number().int().safe() }).passthrough()).default([]),
  totalValueMinor: z.number().int().safe(),
});
const GoCatalogSchema = z.object({
  items: z.array(ProductSchema),
  totalValueMinor: z.number().int().safe(),
}).strict();
const GoCatalogResponseSchema = z.object({ ok: z.literal(true), data: GoCatalogSchema }).strict();
const ModuleSwitchboardSchema = z.object({
  catalog: z.array(z.object({ id: z.string() })),
  enabledModules: z.array(z.string()),
});
const ProductDefaultsSchema = z.object({
  module: z.literal("inventory"),
  settings: z.object({
    defaultUnitLabel: z.string().max(20).optional(),
    defaultReorderPointUnits: z.number().finite().nonnegative().optional(),
  }).passthrough(),
}).strict();

const CreateSchema = z.object({
  action: z.literal("createItem"), sku: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(120),
  kind: z.enum(["goods", "service"]), unitLabel: z.string().trim().min(1).max(20), salePriceMinor: z.number().int().nonnegative().safe(),
  reorderPointThousandths: z.number().int().nonnegative().safe(), barcode: z.string().trim().min(3).max(64).optional(),
  imageUrl: z.string().url().optional(), tags: z.array(z.string().trim().min(1).max(30)).max(20),
}).strict();
const UpdateSchema = z.object({
  action: z.literal("updateItem"), sku: z.string().trim().min(1), name: z.string().trim().min(1).max(120),
  unitLabel: z.string().trim().min(1).max(20).optional(), salePriceMinor: z.number().int().nonnegative().safe(),
  barcode: z.string().trim().min(3).max(64).nullable(), imageUrl: z.string().url().nullable(), tags: z.array(z.string().trim().min(1).max(30)).max(20),
}).strict();
const ArchiveSchema = z.object({ action: z.literal("archiveItem"), sku: z.string().trim().min(1), archive: z.literal(true) }).strict();
const AdjustSchema = z.object({ action: z.literal("adjustStock"), sku: z.string().trim().min(1), quantityDelta: z.number().int().positive().safe(), note: z.string().trim().min(3) }).strict();
const ActionSchema = z.discriminatedUnion("action", [CreateSchema, UpdateSchema, ArchiveSchema, AdjustSchema]);
const PendingSchema = z.object({ ok: z.literal(false), pendingApproval: z.literal(true), reason: z.string(), approvalId: z.string().optional() }).strict();
const SuccessSchema = z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) }).strict();
const ErrorSchema = z.object({ error: z.string() }).passthrough();
const ImportRowSchema = z.object({ row: z.number().int().positive(), field: z.string().optional(), message: z.string() }).strict();
const ImportResultSchema = z.object({
  inserted: z.number().int().nonnegative(), skippedDuplicates: z.number().int().nonnegative(),
  skippedDuplicateRows: z.array(z.number().int()).optional(), errors: z.array(ImportRowSchema),
  createdIds: z.array(z.string().uuid()).optional(),
}).passthrough();
const UndoResultSchema = z.object({ undone: z.number().int().nonnegative(), remaining: z.number().int().nonnegative() }).strict();
const GoImportOutputSchema = z.object({
  createdIds: z.array(z.string().uuid()),
  imported: z.number().int().nonnegative(),
  skippedDuplicateRows: z.array(z.number().int()),
}).strict();
const GoUndoImportOutputSchema = z.object({ archived: z.number().int().nonnegative() }).strict();
const GoPendingSchema = z.object({ ok: z.literal(false), pendingApproval: z.literal(true), reason: z.string(), approvalId: z.string().optional() }).strict();

const GO_SESSION_CAPABILITY_BODY_LIMIT = 64 * 1024;

export type Product = z.infer<typeof ProductSchema>;
export type ProductAction = z.infer<typeof ActionSchema>;
export type ProductActionResult = { kind: "completed" } | { kind: "pending"; reason: string };
export type ProductImportRow = { rowNumber: number; name: string; sku?: string; type: "goods" | "service"; unit?: string; salePrice: string; barcode?: string; tags: string[] };
export type ProductImportResult = z.infer<typeof ImportResultSchema>;

export class ProductsApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ProductsApiError";
  }
}

type ProductCapabilityID = "inventory.createItem" | "inventory.updateItem" | "inventory.archiveItem" | "inventory.adjustStock";

export function productActionRequest(action: ProductAction, intentId: string, useGo: boolean): { url: string; body: Record<string, unknown> } {
  if (!useGo) return { url: "/api/inventory", body: { ...action, intentId } };
  const { action: operation, ...input } = action;
  const capabilityByAction: Record<ProductAction["action"], ProductCapabilityID> = {
    createItem: "inventory.createItem",
    updateItem: "inventory.updateItem",
    archiveItem: "inventory.archiveItem",
    adjustStock: "inventory.adjustStock",
  };
  return { url: "/api/capabilities/execute", body: { capabilityId: capabilityByAction[operation], input, intentId } };
}

type PreparedProductImport = {
  rowNumber: number;
  name: string;
  sku: string;
  kind: "goods" | "service";
  unitLabel: string;
  salePriceMinor: number;
  reorderPointThousandths: number;
  barcode: string | null;
  tags: string[];
};

function prepareProductImportRows(rows: ProductImportRow[], intentId: string): { rows: PreparedProductImport[]; errors: z.infer<typeof ImportRowSchema>[]; goCompatible: boolean } {
  const errors: z.infer<typeof ImportRowSchema>[] = [];
  const prepared: PreparedProductImport[] = [];
  let goCompatible = true;
  rows.forEach((row, index) => {
    const rowNumber = row.rowNumber ?? index + 2;
    const kind = row.type;
    const sku = row.sku?.trim() || (kind === "service" ? `SVC-IMPORT-${intentId.slice(0, 8).toUpperCase()}-${index + 1}` : "");
    if (!sku) {
      errors.push({ row: rowNumber, field: "sku", message: "Products need a SKU." });
      return;
    }
    const cleanedPrice = row.salePrice.replace(/[\s,]/g, "");
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleanedPrice);
    const salePriceMinor = match ? Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0")) : -1;
    if (!Number.isSafeInteger(salePriceMinor) || salePriceMinor < 0) {
      errors.push({ row: rowNumber, field: "salePrice", message: "Enter a non-negative amount with at most two decimals." });
      return;
    }
    const tags = row.tags.map((tag) => tag.trim());
    if (tags.length > 20) goCompatible = false;
    prepared.push({
      rowNumber,
      name: row.name.trim(),
      sku,
      kind,
      unitLabel: row.unit?.trim() || (kind === "service" ? "hour" : "unit"),
      salePriceMinor,
      reorderPointThousandths: 0,
      barcode: row.barcode?.trim() || null,
      tags,
    });
  });
  return { rows: prepared, errors, goCompatible };
}

export function productImportRequest(rows: ProductImportRow[], intentId: string, useGo: boolean): { url: string; body: Record<string, unknown>; errors: z.infer<typeof ImportRowSchema>[]; preparedCount: number } {
  const prepared = prepareProductImportRows(rows, intentId);
  const capabilityBody = { capabilityId: "inventory.importItems", input: { rows: prepared.rows }, intentId };
  const withinGoBodyLimit = new TextEncoder().encode(JSON.stringify(capabilityBody)).byteLength <= GO_SESSION_CAPABILITY_BODY_LIMIT;
  if (useGo && prepared.goCompatible && withinGoBodyLimit) {
    return { url: "/api/capabilities/execute", body: capabilityBody, errors: prepared.errors, preparedCount: prepared.rows.length };
  }
  return { url: "/api/import", body: { entity: "products", rows }, errors: [], preparedCount: prepared.rows.length };
}

export function productUndoImportRequest(importIds: string[], intentId: string, useGo: boolean): { url: string; body: Record<string, unknown> } {
  const capabilityBody = { capabilityId: "inventory.undoItemImport", input: { itemIds: importIds }, intentId };
  const withinGoBodyLimit = new TextEncoder().encode(JSON.stringify(capabilityBody)).byteLength <= GO_SESSION_CAPABILITY_BODY_LIMIT;
  if (!useGo || importIds.length > 5000 || !withinGoBodyLimit) {
    return { url: "/api/import", body: { entity: "products", action: "undo", importIds } };
  }
  return { url: "/api/capabilities/execute", body: capabilityBody };
}

function intentFingerprint(value: unknown): string {
  let hash = 14695981039346656037n;
  for (const byte of new TextEncoder().encode(JSON.stringify(value))) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 1099511628211n);
  }
  return hash.toString(16);
}

function stableProductIntentId(operation: "import" | "undo", payload: unknown): { id: string; fingerprint: string } {
  const fingerprint = intentFingerprint(payload);
  const key = `chaste:products:${operation}:pending-intent`;
  try {
    const previous = sessionStorage.getItem(key);
    if (previous) {
      const parsed: unknown = JSON.parse(previous);
      if (typeof parsed === "object" && parsed !== null && "fingerprint" in parsed && parsed.fingerprint === fingerprint &&
        "intentId" in parsed && typeof parsed.intentId === "string") {
        return { id: parsed.intentId, fingerprint };
      }
    }
    const id = crypto.randomUUID();
    sessionStorage.setItem(key, JSON.stringify({ fingerprint, intentId: id }));
    return { id, fingerprint };
  } catch {
    return { id: crypto.randomUUID(), fingerprint };
  }
}

function clearProductIntent(operation: "import" | "undo", fingerprint: string): void {
  try {
    const key = `chaste:products:${operation}:pending-intent`;
    const previous = sessionStorage.getItem(key);
    if (!previous) return;
    const parsed: unknown = JSON.parse(previous);
    if (typeof parsed === "object" && parsed !== null && "fingerprint" in parsed && parsed.fingerprint === fingerprint) {
      sessionStorage.removeItem(key);
    }
  } catch {
    return;
  }
}

function useGoInventoryItemSlice(): boolean {
  return typeof __GO_INVENTORY_ITEM_SLICE__ !== "undefined" && __GO_INVENTORY_ITEM_SLICE__;
}

async function fetchGoProductCatalog(signal?: AbortSignal): Promise<z.infer<typeof CatalogSchema>> {
  let response: Response;
  try {
    response = await fetch("/api/capabilities/execute", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ capabilityId: "inventory.stockReport", input: { belowReorderOnly: false }, intentId: crypto.randomUUID() }),
      signal,
    });
  } catch {
    throw new ProductsApiError(0, "Could not reach the product catalog. Check your connection and try again.");
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = ErrorSchema.safeParse(body);
    throw new ProductsApiError(response.status, error.success ? error.data.error : "Could not load the product catalog.");
  }
  const catalog = GoCatalogResponseSchema.safeParse(body);
  if (response.status !== 200 || !catalog.success) {
    throw new ProductsApiError(response.status, "The product catalog returned data in an unexpected format.");
  }
  return {
    ...catalog.data.data,
    reorderAlerts: catalog.data.data.items.filter((item) => item.reorderNeeded).map((item) => ({
      sku: item.sku,
      name: item.name,
      onHandThousandths: item.onHandThousandths,
      reorderPointThousandths: item.reorderPointThousandths,
      shortfallThousandths: Math.max(0, item.reorderPointThousandths - item.onHandThousandths),
      avgUnitCostMinor: item.avgUnitCostMinor,
    })),
  };
}

export async function fetchProductsEnabled(signal?: AbortSignal): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch("/api/modules", { credentials: "same-origin", cache: "no-store", signal });
  } catch {
    throw new ProductsApiError(0, "Could not check whether the inventory module is enabled.");
  }
  const body: unknown = await response.json().catch(() => null);
  const parsed = ModuleSwitchboardSchema.safeParse(body);
  if (!response.ok || !parsed.success) throw new ProductsApiError(response.status, "The module switchboard returned data in an unexpected format.");
  const catalog = new Set(parsed.data.catalog.map((module) => module.id));
  if (!catalog.has("inventory") || parsed.data.enabledModules.some((id) => !catalog.has(id))) {
    throw new ProductsApiError(response.status, "The module switchboard returned an invalid inventory configuration.");
  }
  return parsed.data.enabledModules.includes("inventory");
}

export async function fetchProductDefaults(signal?: AbortSignal): Promise<{ defaultUnitLabel?: string; defaultReorderPointUnits?: number }> {
  let response: Response;
  try {
    response = await fetch("/api/module-settings?module=inventory", { credentials: "same-origin", cache: "no-store", signal });
  } catch {
    throw new ProductsApiError(0, "Could not load inventory defaults.");
  }
  const body: unknown = await response.json().catch(() => null);
  const parsed = ProductDefaultsSchema.safeParse(body);
  if (!response.ok || !parsed.success) throw new ProductsApiError(response.status, "Inventory defaults returned data in an unexpected format.");
  return parsed.data.settings;
}

export async function fetchProducts(signal?: AbortSignal): Promise<{ items: Product[]; reorderAlerts: z.infer<typeof CatalogSchema>["reorderAlerts"]; totalValueMinor: number }> {
  if (useGoInventoryItemSlice()) return fetchGoProductCatalog(signal);
  let response: Response;
  try {
    response = await fetch("/api/inventory", { credentials: "same-origin", cache: "no-store", signal });
  } catch {
    throw new ProductsApiError(0, "Could not reach the product catalog. Check your connection and try again.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = ErrorSchema.safeParse(body);
    throw new ProductsApiError(response.status, error.success ? error.data.error : "Could not load the product catalog.");
  }
  const catalog = CatalogSchema.safeParse(body);
  if (!catalog.success) throw new ProductsApiError(response.status, "The product catalog returned data in an unexpected format.");
  return catalog.data;
}

export async function submitProductAction(action: ProductAction, signal?: AbortSignal): Promise<ProductActionResult> {
  const parsed = ActionSchema.safeParse(action);
  if (!parsed.success) throw new ProductsApiError(0, "Check the product details and try again.");
  const request = productActionRequest(parsed.data, crypto.randomUUID(), useGoInventoryItemSlice());
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(request.body), signal,
    });
  } catch {
    throw new ProductsApiError(0, "Could not reach the inventory service. Check your connection and try again.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 202) {
    const pending = PendingSchema.safeParse(body);
    if (!pending.success) throw new ProductsApiError(202, "The inventory service returned an unexpected approval response.");
    return { kind: "pending", reason: pending.data.reason };
  }
  if (!response.ok) {
    const error = ErrorSchema.safeParse(body);
    throw new ProductsApiError(response.status, error.success ? error.data.error : "The product action could not be completed.");
  }
  if (response.status !== 200 || !SuccessSchema.safeParse(body).success) {
    throw new ProductsApiError(response.status, "The inventory service returned an unexpected action response.");
  }
  return { kind: "completed" };
}

export async function importProducts(rows: ProductImportRow[], signal?: AbortSignal): Promise<ProductImportResult> {
  const useGo = typeof __GO_INVENTORY_IMPORT_SLICE__ !== "undefined" && __GO_INVENTORY_IMPORT_SLICE__;
  const attempt = stableProductIntentId("import", rows);
  const request = productImportRequest(rows, attempt.id, useGo);
  if (request.url === "/api/capabilities/execute" && request.preparedCount === 0) {
    clearProductIntent("import", attempt.fingerprint);
    return { inserted: 0, skippedDuplicates: 0, errors: request.errors, createdIds: [] };
  }
  let response: Response;
  try {
    response = await fetch(request.url, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(request.body), signal });
  } catch {
    throw new ProductsApiError(0, "The product import could not reach the server. Your preview is still available.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 202) {
    const pending = GoPendingSchema.safeParse(body);
    if (request.url === "/api/capabilities/execute" && pending.success) throw new ProductsApiError(202, pending.data.reason);
    const error = ErrorSchema.safeParse(body);
    throw new ProductsApiError(202, error.success ? error.data.error : "The import is waiting for approval.");
  }
  if (!response.ok) {
    const error = ErrorSchema.safeParse(body);
    throw new ProductsApiError(response.status, error.success ? error.data.error : "The product import could not be completed.");
  }
  if (request.url === "/api/capabilities/execute") {
    const envelope = z.object({ ok: z.literal(true), data: GoImportOutputSchema }).strict().safeParse(body);
    if (!envelope.success) throw new ProductsApiError(response.status, "The product import returned data in an unexpected format.");
    const data = envelope.data.data;
    clearProductIntent("import", attempt.fingerprint);
    return {
      inserted: data.imported,
      skippedDuplicates: data.skippedDuplicateRows.length,
      skippedDuplicateRows: data.skippedDuplicateRows,
      errors: request.errors,
      createdIds: data.createdIds,
    };
  }
  const parsed = ImportResultSchema.safeParse(body);
  if (!parsed.success) throw new ProductsApiError(response.status, "The product import returned data in an unexpected format.");
  clearProductIntent("import", attempt.fingerprint);
  return parsed.data;
}

export async function undoProductImport(importIds: string[], signal?: AbortSignal): Promise<{ kind: "completed"; undone: number; remaining: number } | { kind: "pending"; reason: string }> {
  const useGo = typeof __GO_INVENTORY_IMPORT_SLICE__ !== "undefined" && __GO_INVENTORY_IMPORT_SLICE__;
  const attempt = stableProductIntentId("undo", importIds);
  const request = productUndoImportRequest(importIds, attempt.id, useGo);
  let response: Response;
  try {
    response = await fetch(request.url, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(request.body), signal });
  } catch {
    throw new ProductsApiError(0, "Undo could not reach the server. The imported products are unchanged.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 202) {
    const pending = GoPendingSchema.safeParse(body);
    if (request.url === "/api/capabilities/execute" && pending.success) return { kind: "pending", reason: pending.data.reason };
    const error = ErrorSchema.safeParse(body);
    return { kind: "pending", reason: error.success ? error.data.error : "Undo is waiting for approval." };
  }
  if (!response.ok) {
    const error = ErrorSchema.safeParse(body);
    throw new ProductsApiError(response.status, error.success ? error.data.error : "The import could not be undone.");
  }
  if (request.url === "/api/capabilities/execute") {
    const envelope = z.object({ ok: z.literal(true), data: GoUndoImportOutputSchema }).strict().safeParse(body);
    if (!envelope.success) throw new ProductsApiError(response.status, "The import undo returned data in an unexpected format.");
    const undone = envelope.data.data.archived;
    clearProductIntent("undo", attempt.fingerprint);
    return { kind: "completed", undone, remaining: Math.max(0, importIds.length - undone) };
  }
  const parsed = UndoResultSchema.safeParse(body);
  if (!parsed.success) throw new ProductsApiError(response.status, "The import undo returned data in an unexpected format.");
  clearProductIntent("undo", attempt.fingerprint);
  return { kind: "completed", ...parsed.data };
}
