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
const GoUndoImportOutputSchema = z.object({ itemIds: z.array(z.string().uuid()), archived: z.number().int().nonnegative() }).strict();
const GoRestoreImportOutputSchema = z.object({ itemIds: z.array(z.string().uuid()), restored: z.number().int().nonnegative() }).strict();
const GoPendingSchema = z.object({ ok: z.literal(false), pendingApproval: z.literal(true), reason: z.string(), approvalId: z.string().optional() }).strict();

const GO_SESSION_CAPABILITY_BODY_LIMIT = 64 * 1024;

function isDefinitiveNoEffectGoRejection(status: number): boolean {
  return [400, 401, 403, 413, 415, 422, 429].includes(status);
}

function returnedIDsMatchRequest(returnedIDs: string[], requestIDs: string[], count: number): boolean {
  const requested = new Set(requestIDs);
  return returnedIDs.length === count && new Set(returnedIDs).size === returnedIDs.length && returnedIDs.every((id) => requested.has(id));
}

export type Product = z.infer<typeof ProductSchema>;
export type ProductAction = z.infer<typeof ActionSchema>;
export type ProductActionResult = { kind: "completed" } | { kind: "pending"; reason: string };
export type ProductImportRow = { rowNumber: number; name: string; sku?: string; type: "goods" | "service"; unit?: string; salePrice: string; barcode?: string; tags: string[] };
export type ProductImportResult = z.infer<typeof ImportResultSchema>;
export type ProductImportRetryScope = { actorId: string | null; organizationId: string | null };
export type ProductImportRecovery = {
  result: ProductImportResult;
  activeIds: string[];
  archivedIds: string[];
};

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

function prepareProductImportRows(rows: ProductImportRow[], intentId: string): { rows: PreparedProductImport[]; errors: z.infer<typeof ImportRowSchema>[]; goCompatible: boolean; unsupportedReason: string | null } {
  const errors: z.infer<typeof ImportRowSchema>[] = [];
  const prepared: PreparedProductImport[] = [];
  let goCompatible = true;
  let unsupportedReason: string | null = null;
  if (rows.length > 5000) return { rows: prepared, errors, goCompatible: false, unsupportedReason: "Go inventory imports support at most 5,000 rows. Split this CSV into smaller files." };
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
    if (tags.length > 20 || tags.some((tag) => tag.length < 1 || tag.length > 30)) {
      goCompatible = false;
      unsupportedReason ??= "Go inventory imports support up to 20 tags per row, with each tag 1 to 30 characters.";
    }
    if (row.name.trim().length < 1 || row.name.trim().length > 120 || sku.length > 40) {
      goCompatible = false;
      unsupportedReason ??= "Go inventory imports require names up to 120 characters and SKUs up to 40 characters.";
    }
    const unitLabel = row.unit?.trim() || (kind === "service" ? "hour" : "unit");
    if (unitLabel.length < 1 || unitLabel.length > 20) {
      goCompatible = false;
      unsupportedReason ??= "Go inventory imports require unit labels from 1 to 20 characters.";
    }
    const barcode = row.barcode?.trim() || null;
    if (barcode && (barcode.length < 3 || barcode.length > 64)) {
      goCompatible = false;
      unsupportedReason ??= "Go inventory imports require barcodes from 3 to 64 characters.";
    }
    prepared.push({
      rowNumber,
      name: row.name.trim(),
      sku,
      kind,
      unitLabel,
      salePriceMinor,
      reorderPointThousandths: 0,
      barcode,
      tags,
    });
  });
  return { rows: prepared, errors, goCompatible, unsupportedReason };
}

export function productImportRequest(rows: ProductImportRow[], intentId: string, useGo: boolean): { url: string; body: Record<string, unknown>; errors: z.infer<typeof ImportRowSchema>[]; preparedCount: number; unsupportedReason: string | null } {
  const prepared = prepareProductImportRows(rows, intentId);
  const capabilityBody = { capabilityId: "inventory.importItems", input: { rows: prepared.rows }, intentId };
  const bodyBytes = new TextEncoder().encode(JSON.stringify(capabilityBody)).byteLength;
  if (useGo && bodyBytes > GO_SESSION_CAPABILITY_BODY_LIMIT) {
    prepared.unsupportedReason ??= "This import exceeds the 64 KiB Go capability request limit. Split the CSV into smaller files.";
  }
  if (useGo) {
    return { url: "/api/capabilities/execute", body: capabilityBody, errors: prepared.errors, preparedCount: prepared.rows.length, unsupportedReason: prepared.unsupportedReason };
  }
  return { url: "/api/import", body: { entity: "products", rows }, errors: [], preparedCount: prepared.rows.length, unsupportedReason: null };
}

export function productUndoImportRequest(importIds: string[], intentId: string, useGo: boolean): { url: string; body: Record<string, unknown> } {
  const capabilityBody = { capabilityId: "inventory.undoItemImport", input: { itemIds: importIds }, intentId };
  if (!useGo) return { url: "/api/import", body: { entity: "products", action: "undo", importIds } };
  return { url: "/api/capabilities/execute", body: capabilityBody };
}

export function productRestoreImportRequest(importIds: string[], intentId: string): { url: string; body: Record<string, unknown> } {
  return { url: "/api/capabilities/execute", body: { capabilityId: "inventory.restoreItemImport", input: { itemIds: importIds }, intentId } };
}

function intentFingerprint(value: unknown): string {
  let hash = 14695981039346656037n;
  for (const byte of new TextEncoder().encode(JSON.stringify(value))) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 1099511628211n);
  }
  return hash.toString(16);
}

function stableLegacyProductIntentId(operation: "import" | "undo", payload: unknown): { id: string; fingerprint: string } {
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

function clearLegacyProductIntent(operation: "import" | "undo", fingerprint: string): void {
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

const productGoRetryPrefix = "chaste:products:go:v1:";
const ProductImportAttemptSchema = z.object({ fingerprint: z.string().regex(/^[0-9a-f]{64}$/i), intentId: z.string().uuid(), input: z.unknown() }).strict();
const ProductImportRecoverySchema = z.object({
  result: ImportResultSchema,
  activeIds: z.array(z.string().uuid()),
  archivedIds: z.array(z.string().uuid()),
}).strict();

async function productScopeKeys(scope?: ProductImportRetryScope): Promise<{ scopeKey: string; operationKey: (operation: "import" | "undo" | "restore") => string; recoveryKey: string }> {
  const actorId = scope?.actorId?.trim() ?? "";
  const organizationId = scope?.organizationId?.trim() ?? "";
  if (!z.string().uuid().safeParse(actorId).success || !z.string().uuid().safeParse(organizationId).success) {
    throw new ProductsApiError(0, "Product imports are paused until your account and organization finish loading.");
  }
  let scopeHash: string;
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ actorId, organizationId })));
    scopeHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    throw new ProductsApiError(0, "Product import retry protection is unavailable. Enable secure browser storage before importing.");
  }
  return {
    scopeKey: `${productGoRetryPrefix}scope:${scopeHash}`,
    operationKey: (operation) => `${productGoRetryPrefix}scope:${scopeHash}:pending:${operation}`,
    recoveryKey: `${productGoRetryPrefix}scope:${scopeHash}:last-import`,
  };
}

async function stableGoProductIntentId(
  operation: "import" | "undo" | "restore",
  input: unknown,
  scope?: ProductImportRetryScope,
): Promise<{ id: string; fingerprint: string; keys: Awaited<ReturnType<typeof productScopeKeys>> }> {
  const keys = await productScopeKeys(scope);
  const serializedInput = JSON.stringify({ input, scope: keys.scopeKey });
  let fingerprint: string;
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serializedInput));
    fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    throw new ProductsApiError(0, "Product import retry protection is unavailable. Enable secure browser storage before importing.");
  }
  const storageKey = keys.operationKey(operation);
  let previous: string | null;
  try {
    previous = sessionStorage.getItem(storageKey);
  } catch {
    throw new ProductsApiError(0, "Product import retry protection is unavailable. Enable session storage before importing.");
  }
  if (previous) {
    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(previous);
    } catch {
      throw new ProductsApiError(0, "A saved product import retry marker is malformed. Verify the catalog before retrying.");
    }
    const parsed = ProductImportAttemptSchema.safeParse(parsedValue);
    if (!parsed.success) throw new ProductsApiError(0, "A saved product import retry marker is malformed. Verify the catalog before retrying.");
    if (parsed.data.fingerprint !== fingerprint) throw new ProductsApiError(0, "A product import action is unresolved for this account and organization. Retry that exact action first.");
    return { id: parsed.data.intentId, fingerprint, keys };
  }
  for (const otherOperation of ["import", "undo", "restore"] as const) {
    if (otherOperation === operation) continue;
    try {
      if (sessionStorage.getItem(keys.operationKey(otherOperation))) {
        throw new ProductsApiError(0, "A product import action is unresolved for this account and organization. Retry that exact action first.");
      }
    } catch (error) {
      if (error instanceof ProductsApiError) throw error;
      throw new ProductsApiError(0, "Product import retry protection is unavailable. Verify the catalog before retrying.");
    }
  }
  const id = crypto.randomUUID();
  try {
    sessionStorage.setItem(storageKey, JSON.stringify({ fingerprint, intentId: id, input }));
  } catch {
    throw new ProductsApiError(0, "Product import retry protection is unavailable. Enable session storage before importing.");
  }
  return { id, fingerprint, keys };
}

function clearGoProductIntent(keys: Awaited<ReturnType<typeof productScopeKeys>>, operation: "import" | "undo" | "restore", intentId: string): void {
  const storageKey = keys.operationKey(operation);
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return;
    const parsed = ProductImportAttemptSchema.safeParse(JSON.parse(raw));
    if (parsed.success && parsed.data.intentId === intentId) sessionStorage.removeItem(storageKey);
  } catch {
    throw new ProductsApiError(0, "The product import retry marker could not be cleared. Verify the catalog before retrying.");
  }
}

function readProductImportRecovery(keys: Awaited<ReturnType<typeof productScopeKeys>>): ProductImportRecovery | null {
  try {
    const raw = sessionStorage.getItem(keys.recoveryKey);
    if (!raw) return null;
    const parsed = ProductImportRecoverySchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new ProductsApiError(0, "Saved product import recovery data is malformed. Verify the catalog before changing it.");
    return parsed.data;
  } catch (error) {
    if (error instanceof ProductsApiError) throw error;
    throw new ProductsApiError(0, "Saved product import recovery data is unavailable. Verify the catalog before changing it.");
  }
}

function writeProductImportRecovery(keys: Awaited<ReturnType<typeof productScopeKeys>>, recovery: ProductImportRecovery | null): void {
  try {
    if (!recovery) sessionStorage.removeItem(keys.recoveryKey);
    else sessionStorage.setItem(keys.recoveryKey, JSON.stringify(recovery));
  } catch {
    throw new ProductsApiError(0, "Product import recovery could not be saved. Keep this page open and verify the catalog before retrying.");
  }
}

export async function recoverProductImport(scope: ProductImportRetryScope): Promise<{ pendingRows: ProductImportRow[] | null; pendingUndoIds: string[] | null; pendingRestoreIds: string[] | null; recovery: ProductImportRecovery | null }> {
  const keys = await productScopeKeys(scope);
  let pendingRows: ProductImportRow[] | null = null;
  let pendingUndoIds: string[] | null = null;
  let pendingRestoreIds: string[] | null = null;
  try {
    for (const operation of ["import", "undo", "restore"] as const) {
      const raw = sessionStorage.getItem(keys.operationKey(operation));
      if (!raw) continue;
      const parsed = ProductImportAttemptSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new ProductsApiError(0, "A saved product import retry marker is malformed. Verify the catalog before retrying.");
      if (operation === "import") {
        if (!Array.isArray(parsed.data.input) || !parsed.data.input.every((row) => ProductImportRowSchema.safeParse(row).success)) {
          throw new ProductsApiError(0, "A saved product import retry marker is malformed. Verify the catalog before retrying.");
        }
        pendingRows = parsed.data.input as ProductImportRow[];
      } else {
        const ids = z.array(z.string().uuid()).min(1).max(5000).safeParse(parsed.data.input);
        if (!ids.success) throw new ProductsApiError(0, "A saved product import retry marker is malformed. Verify the catalog before retrying.");
        if (operation === "undo") pendingUndoIds = ids.data;
        else pendingRestoreIds = ids.data;
      }
    }
  } catch (error) {
    if (error instanceof ProductsApiError) throw error;
    throw new ProductsApiError(0, "A saved product import retry marker is unavailable. Verify the catalog before retrying.");
  }
  return { pendingRows, pendingUndoIds, pendingRestoreIds, recovery: readProductImportRecovery(keys) };
}

const ProductImportRowSchema = z.object({ rowNumber: z.number().int().positive(), name: z.string(), sku: z.string().optional(), type: z.enum(["goods", "service"]), unit: z.string().optional(), salePrice: z.string(), barcode: z.string().optional(), tags: z.array(z.string()) }).strict();

async function assertNoUnresolvedGoProductIntent(scope?: ProductImportRetryScope): Promise<void> {
  const keys = await productScopeKeys(scope);
  try {
    for (const operation of ["import", "undo", "restore"] as const) {
      const raw = sessionStorage.getItem(keys.operationKey(operation));
      if (!raw) continue;
      if (!ProductImportAttemptSchema.safeParse(JSON.parse(raw)).success) {
        throw new ProductsApiError(0, "A saved product import retry marker is malformed. Verify the catalog before retrying.");
      }
      throw new ProductsApiError(0, "A product import action is unresolved for this account and organization. Retry that exact action first.");
    }
  } catch (error) {
    if (error instanceof ProductsApiError) throw error;
    throw new ProductsApiError(0, "Product import retry protection is unavailable. Verify the catalog before using the legacy route.");
  }
}

function useGoInventoryItemSlice(): boolean {
  return typeof __GO_INVENTORY_ITEM_SLICE__ !== "undefined" && __GO_INVENTORY_ITEM_SLICE__;
}

export function goProductImportEnabled(): boolean {
  return typeof __GO_INVENTORY_IMPORT_SLICE__ !== "undefined" && __GO_INVENTORY_IMPORT_SLICE__;
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

export async function importProducts(rows: ProductImportRow[], signal?: AbortSignal, retryScope?: ProductImportRetryScope): Promise<ProductImportResult> {
  const useGo = goProductImportEnabled();
  const preview = productImportRequest(rows, "00000000-0000-4000-8000-000000000000", useGo);
  if (useGo && preview.unsupportedReason) throw new ProductsApiError(413, preview.unsupportedReason);
  if (useGo && preview.preparedCount === 0) {
    if (preview.errors.length) return { inserted: 0, skippedDuplicates: 0, errors: preview.errors, createdIds: [] };
    throw new ProductsApiError(422, "Add at least one valid product row before importing.");
  }
  let attempt: { id: string; fingerprint: string; keys?: Awaited<ReturnType<typeof productScopeKeys>> };
  if (useGo) attempt = await stableGoProductIntentId("import", rows, retryScope);
  else {
    await assertNoUnresolvedGoProductIntent(retryScope);
    attempt = stableLegacyProductIntentId("import", rows);
  }
  const request = productImportRequest(rows, attempt.id, useGo);
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
    if (useGo && isDefinitiveNoEffectGoRejection(response.status) && attempt.keys) clearGoProductIntent(attempt.keys, "import", attempt.id);
    throw new ProductsApiError(response.status, error.success ? error.data.error : "The product import could not be completed.");
  }
  if (request.url === "/api/capabilities/execute") {
    const envelope = z.object({ ok: z.literal(true), data: GoImportOutputSchema }).strict().safeParse(body);
    if (!envelope.success) throw new ProductsApiError(response.status, "The product import returned data in an unexpected format.");
    const data = envelope.data.data;
    if (data.imported !== data.createdIds.length || new Set(data.createdIds).size !== data.createdIds.length) {
      throw new ProductsApiError(response.status, "The product import returned inconsistent or duplicate item IDs. Verify the catalog before retrying.");
    }
    const result = {
      inserted: data.imported,
      skippedDuplicates: data.skippedDuplicateRows.length,
      skippedDuplicateRows: data.skippedDuplicateRows,
      errors: request.errors,
      createdIds: data.createdIds,
    };
    if (!attempt.keys) throw new ProductsApiError(0, "Product import recovery scope was lost. Verify the catalog before retrying.");
    writeProductImportRecovery(attempt.keys, { result, activeIds: data.createdIds, archivedIds: [] });
    clearGoProductIntent(attempt.keys, "import", attempt.id);
    return result;
  }
  const parsed = ImportResultSchema.safeParse(body);
  if (!parsed.success) throw new ProductsApiError(response.status, "The product import returned data in an unexpected format.");
  clearLegacyProductIntent("import", attempt.fingerprint);
  return parsed.data;
}

export async function undoProductImport(importIds: string[], signal?: AbortSignal, retryScope?: ProductImportRetryScope): Promise<{ kind: "completed"; undone: number; remaining: number; itemIds: string[] } | { kind: "pending"; reason: string }> {
  const useGo = goProductImportEnabled();
  if (useGo && (importIds.length === 0 || importIds.length > 5000 || importIds.some((id) => !z.string().uuid().safeParse(id).success) || new Set(importIds).size !== importIds.length)) {
    throw new ProductsApiError(422, "Undo requires between 1 and 5,000 valid imported item IDs.");
  }
  if (useGo && new TextEncoder().encode(JSON.stringify({ capabilityId: "inventory.undoItemImport", input: { itemIds: importIds }, intentId: crypto.randomUUID() })).byteLength > GO_SESSION_CAPABILITY_BODY_LIMIT) {
    throw new ProductsApiError(413, "This undo exceeds the 64 KiB Go capability request limit.");
  }
  let attempt: { id: string; fingerprint: string; keys?: Awaited<ReturnType<typeof productScopeKeys>> };
  if (useGo) attempt = await stableGoProductIntentId("undo", importIds, retryScope);
  else {
    await assertNoUnresolvedGoProductIntent(retryScope);
    attempt = stableLegacyProductIntentId("undo", importIds);
  }
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
    if (useGo && isDefinitiveNoEffectGoRejection(response.status) && attempt.keys) clearGoProductIntent(attempt.keys, "undo", attempt.id);
    throw new ProductsApiError(response.status, error.success ? error.data.error : "The import could not be undone.");
  }
  if (request.url === "/api/capabilities/execute") {
    const envelope = z.object({ ok: z.literal(true), data: GoUndoImportOutputSchema }).strict().safeParse(body);
    if (!envelope.success) throw new ProductsApiError(response.status, "The import undo returned data in an unexpected format.");
    const { archived: undone, itemIds } = envelope.data.data;
    if (!returnedIDsMatchRequest(itemIds, importIds, undone)) throw new ProductsApiError(response.status, "The import undo returned invalid or inconsistent item IDs. Verify the catalog before retrying.");
    if (!attempt.keys) throw new ProductsApiError(0, "Product import recovery scope was lost. Verify the catalog before retrying.");
    const recovery = readProductImportRecovery(attempt.keys);
    if (recovery) {
      const archived = new Set([...recovery.archivedIds, ...itemIds]);
      writeProductImportRecovery(attempt.keys, {
        ...recovery,
        result: { ...recovery.result, inserted: Math.max(0, recovery.result.inserted - itemIds.length) },
        activeIds: recovery.activeIds.filter((id) => !archived.has(id)),
        archivedIds: [...archived],
      });
    }
    clearGoProductIntent(attempt.keys, "undo", attempt.id);
    return { kind: "completed", undone, remaining: Math.max(0, importIds.length - undone), itemIds };
  }
  const parsed = UndoResultSchema.safeParse(body);
  if (!parsed.success) throw new ProductsApiError(response.status, "The import undo returned data in an unexpected format.");
  clearLegacyProductIntent("undo", attempt.fingerprint);
  return { kind: "completed", ...parsed.data, itemIds: [] };
}

export async function restoreProductImport(importIds: string[], signal?: AbortSignal, retryScope?: ProductImportRetryScope): Promise<{ kind: "completed"; restored: number; itemIds: string[] } | { kind: "pending"; reason: string }> {
  if (importIds.length === 0 || importIds.length > 5000 || importIds.some((id) => !z.string().uuid().safeParse(id).success) || new Set(importIds).size !== importIds.length) {
    throw new ProductsApiError(422, "Restore requires between 1 and 5,000 valid imported item IDs.");
  }
  const requestBody = { capabilityId: "inventory.restoreItemImport", input: { itemIds: importIds }, intentId: crypto.randomUUID() };
  if (new TextEncoder().encode(JSON.stringify(requestBody)).byteLength > GO_SESSION_CAPABILITY_BODY_LIMIT) {
    throw new ProductsApiError(413, "This restore exceeds the 64 KiB Go capability request limit.");
  }
  const attempt = await stableGoProductIntentId("restore", importIds, retryScope);
  const request = productRestoreImportRequest(importIds, attempt.id);
  let response: Response;
  try {
    response = await fetch(request.url, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(request.body), signal });
  } catch {
    throw new ProductsApiError(0, "Restore could not reach the server. The imported products are unchanged.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 202) {
    const pending = GoPendingSchema.safeParse(body);
    if (pending.success) return { kind: "pending", reason: pending.data.reason };
    throw new ProductsApiError(202, "Restore is waiting for approval.");
  }
  if (!response.ok) {
    const error = ErrorSchema.safeParse(body);
    if (isDefinitiveNoEffectGoRejection(response.status)) clearGoProductIntent(attempt.keys, "restore", attempt.id);
    throw new ProductsApiError(response.status, error.success ? error.data.error : "The import could not be restored.");
  }
  const envelope = z.object({ ok: z.literal(true), data: GoRestoreImportOutputSchema }).strict().safeParse(body);
  if (!envelope.success) throw new ProductsApiError(response.status, "The import restore returned data in an unexpected format.");
  const { restored, itemIds } = envelope.data.data;
  if (!returnedIDsMatchRequest(itemIds, importIds, restored)) throw new ProductsApiError(response.status, "The import restore returned invalid or inconsistent item IDs. Verify the catalog before retrying.");
  const recovery = readProductImportRecovery(attempt.keys);
  if (recovery) {
    const active = new Set([...recovery.activeIds, ...itemIds]);
    writeProductImportRecovery(attempt.keys, {
      ...recovery,
      result: { ...recovery.result, inserted: recovery.result.inserted + itemIds.length },
      activeIds: [...active],
      archivedIds: recovery.archivedIds.filter((id) => !active.has(id)),
    });
  }
  clearGoProductIntent(attempt.keys, "restore", attempt.id);
  return { kind: "completed", restored, itemIds };
}
