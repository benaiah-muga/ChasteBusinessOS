import { z } from "zod";
import { currencyMinorUnits } from "@chaste/erp-core";
import { normalizeRetryActorId } from "./retry-scope";

const ProductSchema = z.object({
  id: z.string().uuid(),
  sku: z.string().min(1),
  name: z.string(),
  kind: z.enum(["goods", "service"]),
  unitLabel: z.string(),
  salePriceMinor: z.number().int().safe(),
  imageUrl: z.string().nullable(),
  tags: z.array(z.string()),
  barcode: z.string().nullable(),
  onHandThousandths: z.number().int().safe(),
  valueMinor: z.number().int().safe(),
  totalValueMinor: z.number().int().safe(),
  avgUnitCostMinor: z.number().int().safe(),
  reservedThousandths: z.number().int().safe(),
  availableThousandths: z.number().int().safe(),
  reorderPointThousandths: z.number().int().safe(),
  reorderNeeded: z.boolean(),
}).strict();

const CatalogSchema = z.object({
  items: z.array(ProductSchema),
  reorderAlerts: z.array(z.object({
    sku: z.string(),
    name: z.string(),
    onHandThousandths: z.number().int().safe(),
    reorderPointThousandths: z.number().int().safe(),
    shortfallThousandths: z.number().int().safe(),
    avgUnitCostMinor: z.number().int().safe(),
  }).strict()),
  totalValueMinor: z.number().int().safe(),
});
const ModuleSwitchboardSchema = z.object({
  catalog: z.array(z.object({
    id: z.string(),
    label: z.string(),
    description: z.string(),
    href: z.string().nullable(),
    protected: z.boolean().optional(),
  }).strict()),
  enabledModules: z.array(z.string()),
  usingDefaults: z.boolean(),
}).strict();
const ProductDefaultsSchema = z.object({
  module: z.literal("inventory"),
  settings: z.object({
    defaultUnitLabel: z.string().min(1).max(20).optional(),
    defaultReorderPointUnits: z.number().int().nonnegative().max(1_000_000).optional(),
  }).strict(),
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
const ProductActionEnvelopeSchema = z.object({ ok: z.literal(true), data: z.unknown() }).strict();
const ProductUpdatePriorSchema = z.object({
  sku: z.string().min(1),
  name: z.string(),
  salePriceMinor: z.number().int().nonnegative().safe(),
  imageUrl: z.string().nullable(),
  tags: z.array(z.string()),
  barcode: z.string().nullable(),
  unitLabel: z.string().optional(),
}).strict();
const ProductActionOutputSchemas = {
  createItem: z.object({ itemId: z.string().uuid() }).strict(),
  updateItem: z.object({ sku: z.string().min(1), prior: ProductUpdatePriorSchema }).strict(),
  archiveItem: z.object({ sku: z.string().min(1), archived: z.boolean() }).strict(),
  adjustStock: z.object({ onHandThousandths: z.number().int().nonnegative().safe() }).strict(),
} satisfies Record<ProductAction["action"], z.ZodTypeAny>;

function productActionOutputMatches(action: ProductAction, value: unknown): boolean {
  switch (action.action) {
    case "createItem":
      return ProductActionOutputSchemas.createItem.safeParse(value).success;
    case "updateItem": {
      const output = ProductActionOutputSchemas.updateItem.safeParse(value);
      return output.success
        && output.data.sku === action.sku
        && output.data.prior.sku === action.sku
        && (action.unitLabel === undefined || output.data.prior.unitLabel !== undefined);
    }
    case "archiveItem": {
      const output = ProductActionOutputSchemas.archiveItem.safeParse(value);
      return output.success && output.data.sku === action.sku && output.data.archived === action.archive;
    }
    case "adjustStock":
      return ProductActionOutputSchemas.adjustStock.safeParse(value).success;
  }
}
const ErrorSchema = z.object({ error: z.string() }).passthrough();
const ImportRowSchema = z.object({ row: z.number().int().positive(), field: z.string().optional(), message: z.string() }).strict();
const ImportResultSchema = z.object({
  inserted: z.number().int().nonnegative(), skippedDuplicates: z.number().int().nonnegative(),
  skippedDuplicateRows: z.array(z.number().int()).optional(), errors: z.array(ImportRowSchema),
  createdIds: z.array(z.string().uuid()).optional(),
}).passthrough();
const GoImportOutputSchema = z.object({
  createdIds: z.array(z.string().uuid()),
  imported: z.number().int().nonnegative(),
  skippedDuplicateRows: z.array(z.number().int()),
}).strict();
const GoUndoImportOutputSchema = z.object({ itemIds: z.array(z.string().uuid()), archived: z.number().int().nonnegative() }).strict();
const GoRestoreImportOutputSchema = z.object({ itemIds: z.array(z.string().uuid()), restored: z.number().int().nonnegative() }).strict();
const GoPendingSchema = z.object({ ok: z.literal(false), pendingApproval: z.literal(true), reason: z.string(), approvalId: z.string().optional() }).strict();

const GO_SESSION_CAPABILITY_BODY_LIMIT = 64 * 1024;

function organizationHeaders(organizationId?: string | null): Record<string, string> {
  const organization = organizationId?.trim();
  return organization ? { "X-Organization-ID": organization } : {};
}

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
export type ProductImportRow = { rowNumber: number; name: string; sku?: string; type: "goods" | "service"; unit?: string; salePrice: string; salePriceMinor?: number; barcode?: string; tags: string[] };
export type ProductImportResult = z.infer<typeof ImportResultSchema>;
export type ProductRetryScope = { actorId: string | null; organizationId: string | null };
export type ProductImportRetryScope = ProductRetryScope;
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

export function productActionRequest(action: ProductAction, intentId: string): { url: string; body: Record<string, unknown> } {
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

function prepareProductImportRows(rows: ProductImportRow[], intentId: string, currency: string): { rows: PreparedProductImport[]; errors: z.infer<typeof ImportRowSchema>[]; goCompatible: boolean; unsupportedReason: string | null } {
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
    const minorUnits = currencyMinorUnits(currency) ?? 2;
    const decimalPattern = minorUnits > 0 ? `(?:\\.(\\d{1,${minorUnits}}))?` : "";
    const match = new RegExp(`^(\\d+)${decimalPattern}$`).exec(cleanedPrice);
    const scale = 10 ** minorUnits;
    const parsedSalePriceMinor = match ? Number(match[1]) * scale + Number((match[2] ?? "").padEnd(minorUnits, "0")) : -1;
    const salePriceMinor = row.salePriceMinor ?? parsedSalePriceMinor;
    if (!Number.isSafeInteger(salePriceMinor) || salePriceMinor < 0) {
      errors.push({ row: rowNumber, field: "salePrice", message: `Enter a non-negative amount with at most ${currencyMinorUnits(currency) ?? 2} decimals.` });
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

export function productImportRequest(rows: ProductImportRow[], intentId: string, _useGo = true, currency = "USD"): { url: string; body: Record<string, unknown>; errors: z.infer<typeof ImportRowSchema>[]; preparedCount: number; submittedRowNumbers: number[]; unsupportedReason: string | null } {
  const prepared = prepareProductImportRows(rows, intentId, currency);
  const capabilityBody = { capabilityId: "inventory.importItems", input: { rows: prepared.rows }, intentId };
  const bodyBytes = new TextEncoder().encode(JSON.stringify(capabilityBody)).byteLength;
  if (bodyBytes > GO_SESSION_CAPABILITY_BODY_LIMIT) {
    prepared.unsupportedReason ??= "This import exceeds the 64 KiB Go capability request limit. Split the CSV into smaller files.";
  }
  return { url: "/api/capabilities/execute", body: capabilityBody, errors: prepared.errors, preparedCount: prepared.rows.length, submittedRowNumbers: prepared.rows.map((row) => row.rowNumber), unsupportedReason: prepared.unsupportedReason };
}

export function productUndoImportRequest(importIds: string[], intentId: string, _useGo = true): { url: string; body: Record<string, unknown> } {
  const capabilityBody = { capabilityId: "inventory.undoItemImport", input: { itemIds: importIds }, intentId };
  return { url: "/api/capabilities/execute", body: capabilityBody };
}

export function productRestoreImportRequest(importIds: string[], intentId: string): { url: string; body: Record<string, unknown> } {
  return { url: "/api/capabilities/execute", body: { capabilityId: "inventory.restoreItemImport", input: { itemIds: importIds }, intentId } };
}

const productGoRetryPrefix = "chaste:products:go:v1:";
const ProductImportAttemptSchema = z.object({ fingerprint: z.string().regex(/^[0-9a-f]{64}$/i), intentId: z.string().uuid(), input: z.unknown() }).strict();
const ProductActionAttemptSchema = ProductImportAttemptSchema.extend({ input: ActionSchema });
const ProductImportRecoverySchema = z.object({
  result: ImportResultSchema,
  activeIds: z.array(z.string().uuid()),
  archivedIds: z.array(z.string().uuid()),
}).strict();
const ProductImportRecoveriesSchema = z.array(ProductImportRecoverySchema).max(5000);

async function productScopeKeys(scope?: ProductRetryScope): Promise<{ scopeKey: string; operationKey: (operation: "import" | "undo" | "restore" | "action") => string; recoveryKey: string }> {
  const actorId = normalizeRetryActorId(scope?.actorId) ?? "";
  const organizationId = scope?.organizationId?.trim() ?? "";
  if (!actorId || !z.string().uuid().safeParse(organizationId).success) {
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
  try {
    if (sessionStorage.getItem(keys.operationKey("action"))) {
      throw new ProductsApiError(0, "A product action is unresolved for this account and organization. Retry its exact saved details first.");
    }
  } catch (error) {
    if (error instanceof ProductsApiError) throw error;
    throw new ProductsApiError(0, "Product import retry protection is unavailable. Verify the catalog before importing.");
  }
  const id = crypto.randomUUID();
  try {
    sessionStorage.setItem(storageKey, JSON.stringify({ fingerprint, intentId: id, input }));
  } catch {
    throw new ProductsApiError(0, "Product import retry protection is unavailable. Enable session storage before importing.");
  }
  return { id, fingerprint, keys };
}

async function stableProductActionIntent(
  action: ProductAction,
  scope: ProductRetryScope,
): Promise<{ intentId: string; keys: Awaited<ReturnType<typeof productScopeKeys>> }> {
  const keys = await productScopeKeys(scope);
  const serializedInput = JSON.stringify({ input: action, scope: keys.scopeKey });
  let fingerprint: string;
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serializedInput));
    fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    throw new ProductsApiError(0, "Product action retry protection is unavailable. Enable secure browser storage before continuing.");
  }
  const storageKey = keys.operationKey("action");
  let previous: string | null;
  try {
    previous = sessionStorage.getItem(storageKey);
  } catch {
    throw new ProductsApiError(0, "Product action retry protection is unavailable. Enable session storage before continuing.");
  }
  if (previous) {
    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(previous);
    } catch {
      throw new ProductsApiError(0, "A saved product action retry marker is malformed. Verify the catalog before retrying.");
    }
    const parsed = ProductActionAttemptSchema.safeParse(parsedValue);
    if (!parsed.success) throw new ProductsApiError(0, "A saved product action retry marker is malformed. Verify the catalog before retrying.");
    if (parsed.data.fingerprint !== fingerprint) {
      throw new ProductsApiError(0, "A product action is unresolved for this account and organization. Retry its exact saved details first.");
    }
    return { intentId: parsed.data.intentId, keys };
  }
  for (const operation of ["import", "undo", "restore"] as const) {
    try {
      if (sessionStorage.getItem(keys.operationKey(operation))) {
        throw new ProductsApiError(0, "A product import action is unresolved for this account and organization. Retry that exact action first.");
      }
    } catch (error) {
      if (error instanceof ProductsApiError) throw error;
      throw new ProductsApiError(0, "Product action retry protection is unavailable. Verify the catalog before continuing.");
    }
  }
  const intentId = crypto.randomUUID();
  const record = { fingerprint, intentId, input: action };
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(record));
    const saved = ProductActionAttemptSchema.safeParse(JSON.parse(sessionStorage.getItem(storageKey) ?? "null"));
    if (!saved.success || saved.data.intentId !== intentId || saved.data.fingerprint !== fingerprint) throw new Error("retry marker verification failed");
  } catch {
    throw new ProductsApiError(0, "Product action retry protection could not be verified. Enable session storage before continuing.");
  }
  return { intentId, keys };
}

function clearProductActionIntent(keys: Awaited<ReturnType<typeof productScopeKeys>>, intentId: string): void {
  const storageKey = keys.operationKey("action");
  try {
    const parsed = ProductActionAttemptSchema.safeParse(JSON.parse(sessionStorage.getItem(storageKey) ?? "null"));
    if (parsed.success && parsed.data.intentId === intentId) sessionStorage.removeItem(storageKey);
  } catch {
    return;
  }
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

function readProductImportRecoveries(keys: Awaited<ReturnType<typeof productScopeKeys>>): ProductImportRecovery[] {
  try {
    const raw = sessionStorage.getItem(keys.recoveryKey);
    if (!raw) return [];
    const decoded: unknown = JSON.parse(raw);
    const parsed = Array.isArray(decoded)
      ? ProductImportRecoveriesSchema.safeParse(decoded)
      : ProductImportRecoverySchema.safeParse(decoded);
    if (!parsed.success) throw new ProductsApiError(0, "Saved product import recovery data is malformed. Verify the catalog before changing it.");
    return Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  } catch (error) {
    if (error instanceof ProductsApiError) throw error;
    throw new ProductsApiError(0, "Saved product import recovery data is unavailable. Verify the catalog before changing it.");
  }
}

function writeProductImportRecoveries(keys: Awaited<ReturnType<typeof productScopeKeys>>, recoveries: ProductImportRecovery[]): void {
  try {
    if (recoveries.length === 0) sessionStorage.removeItem(keys.recoveryKey);
    else sessionStorage.setItem(keys.recoveryKey, JSON.stringify(recoveries));
  } catch {
    throw new ProductsApiError(0, "Product import recovery could not be saved. Keep this page open and verify the catalog before retrying.");
  }
}

export async function recoverProductImport(scope: ProductImportRetryScope): Promise<{ pendingRows: ProductImportRow[] | null; pendingUndoIds: string[] | null; pendingRestoreIds: string[] | null; recovery: ProductImportRecovery | null; recoveries: ProductImportRecovery[] }> {
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
  const recoveries = readProductImportRecoveries(keys);
  return { pendingRows, pendingUndoIds, pendingRestoreIds, recovery: recoveries.at(-1) ?? null, recoveries };
}

const ProductImportRowSchema = z.object({ rowNumber: z.number().int().positive(), name: z.string(), sku: z.string().optional(), type: z.enum(["goods", "service"]), unit: z.string().optional(), salePrice: z.string(), salePriceMinor: z.number().int().nonnegative().optional(), barcode: z.string().optional(), tags: z.array(z.string()) }).strict();

export async function fetchProductsEnabled(signal?: AbortSignal, organizationId?: string): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch("/api/modules", { credentials: "same-origin", cache: "no-store", signal, headers: organizationHeaders(organizationId) });
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

export async function fetchProductDefaults(signal?: AbortSignal, organizationId?: string): Promise<{ defaultUnitLabel?: string; defaultReorderPointUnits?: number }> {
  let response: Response;
  try {
    response = await fetch("/api/module-settings?module=inventory", { credentials: "same-origin", cache: "no-store", signal, headers: organizationHeaders(organizationId) });
  } catch {
    throw new ProductsApiError(0, "Could not load inventory defaults.");
  }
  const body: unknown = await response.json().catch(() => null);
  const parsed = ProductDefaultsSchema.safeParse(body);
  if (!response.ok || !parsed.success) throw new ProductsApiError(response.status, "Inventory defaults returned data in an unexpected format.");
  return parsed.data.settings;
}

export async function fetchProducts(signal?: AbortSignal, organizationId?: string): Promise<{ items: Product[]; reorderAlerts: z.infer<typeof CatalogSchema>["reorderAlerts"]; totalValueMinor: number }> {
  let response: Response;
  try {
    response = await fetch("/api/inventory", { credentials: "same-origin", cache: "no-store", signal, headers: organizationHeaders(organizationId) });
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

export async function submitProductAction(action: ProductAction, retryScope: ProductRetryScope, signal?: AbortSignal): Promise<ProductActionResult> {
  const parsed = ActionSchema.safeParse(action);
  if (!parsed.success) throw new ProductsApiError(0, "Check the product details and try again.");
  const attempt = await stableProductActionIntent(parsed.data, retryScope);
  const request = productActionRequest(parsed.data, attempt.intentId);
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json", ...organizationHeaders(retryScope.organizationId) },
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
    if (isDefinitiveNoEffectGoRejection(response.status)) clearProductActionIntent(attempt.keys, attempt.intentId);
    throw new ProductsApiError(response.status, error.success ? error.data.error : "The product action could not be completed.");
  }
  const envelope = ProductActionEnvelopeSchema.safeParse(body);
  const outputMatchesRequest = envelope.success && productActionOutputMatches(parsed.data, envelope.data.data);
  if (response.status !== 200 || !outputMatchesRequest) {
    throw new ProductsApiError(response.status, "The inventory service returned an unexpected action response.");
  }
  clearProductActionIntent(attempt.keys, attempt.intentId);
  return { kind: "completed" };
}

export async function importProducts(rows: ProductImportRow[], signal?: AbortSignal, retryScope?: ProductImportRetryScope, currencyOrUnusedSelector: string | boolean = "USD"): Promise<ProductImportResult> {
  const currency = typeof currencyOrUnusedSelector === "string" ? currencyOrUnusedSelector : "USD";
  const preview = productImportRequest(rows, "00000000-0000-4000-8000-000000000000", true, currency);
  if (preview.unsupportedReason) throw new ProductsApiError(413, preview.unsupportedReason);
  if (preview.preparedCount === 0) {
    if (preview.errors.length) return { inserted: 0, skippedDuplicates: 0, errors: preview.errors, createdIds: [] };
    throw new ProductsApiError(422, "Add at least one valid product row before importing.");
  }
  const attempt = await stableGoProductIntentId("import", rows, retryScope);
  const request = productImportRequest(rows, attempt.id, true, currency);
  let response: Response;
  try {
    response = await fetch(request.url, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { accept: "application/json", "content-type": "application/json", ...organizationHeaders(retryScope?.organizationId) }, body: JSON.stringify(request.body), signal });
  } catch {
    throw new ProductsApiError(0, "The product import could not reach the server. Your preview is still available.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 202) {
    const pending = GoPendingSchema.safeParse(body);
    if (pending.success) throw new ProductsApiError(202, pending.data.reason);
    const error = ErrorSchema.safeParse(body);
    throw new ProductsApiError(202, error.success ? error.data.error : "The import is waiting for approval.");
  }
  if (!response.ok) {
    const error = ErrorSchema.safeParse(body);
    if (isDefinitiveNoEffectGoRejection(response.status) && attempt.keys) clearGoProductIntent(attempt.keys, "import", attempt.id);
    throw new ProductsApiError(response.status, error.success ? error.data.error : "The product import could not be completed.");
  }
  {
    const envelope = z.object({ ok: z.literal(true), data: GoImportOutputSchema }).strict().safeParse(body);
    if (!envelope.success) throw new ProductsApiError(response.status, "The product import returned data in an unexpected format.");
    const data = envelope.data.data;
    const submittedRows = new Set(request.submittedRowNumbers);
    const skippedRowsAreValid = new Set(data.skippedDuplicateRows).size === data.skippedDuplicateRows.length
      && data.skippedDuplicateRows.every((rowNumber) => submittedRows.has(rowNumber));
    if (data.imported !== data.createdIds.length || new Set(data.createdIds).size !== data.createdIds.length
      || !skippedRowsAreValid || data.imported + data.skippedDuplicateRows.length !== request.preparedCount) {
      throw new ProductsApiError(response.status, "The product import returned inconsistent item or duplicate-row results. Verify the catalog before retrying.");
    }
    const result = {
      inserted: data.imported,
      skippedDuplicates: data.skippedDuplicateRows.length,
      skippedDuplicateRows: data.skippedDuplicateRows,
      errors: request.errors,
      createdIds: data.createdIds,
    };
    if (!attempt.keys) throw new ProductsApiError(0, "Product import recovery scope was lost. Verify the catalog before retrying.");
    const recoveries = readProductImportRecoveries(attempt.keys);
    writeProductImportRecoveries(attempt.keys, [...recoveries, { result, activeIds: data.createdIds, archivedIds: [] }]);
    clearGoProductIntent(attempt.keys, "import", attempt.id);
    return result;
  }
}

export async function undoProductImport(importIds: string[], signal?: AbortSignal, retryScope?: ProductImportRetryScope, _unusedGoSelector?: boolean): Promise<{ kind: "completed"; undone: number; remaining: number; itemIds: string[] } | { kind: "pending"; reason: string }> {
  if (importIds.length === 0 || importIds.length > 5000 || importIds.some((id) => !z.string().uuid().safeParse(id).success) || new Set(importIds).size !== importIds.length) {
    throw new ProductsApiError(422, "Undo requires between 1 and 5,000 valid imported item IDs.");
  }
  if (new TextEncoder().encode(JSON.stringify({ capabilityId: "inventory.undoItemImport", input: { itemIds: importIds }, intentId: crypto.randomUUID() })).byteLength > GO_SESSION_CAPABILITY_BODY_LIMIT) {
    throw new ProductsApiError(413, "This undo exceeds the 64 KiB Go capability request limit.");
  }
  const attempt = await stableGoProductIntentId("undo", importIds, retryScope);
  const request = productUndoImportRequest(importIds, attempt.id);
  let response: Response;
  try {
    response = await fetch(request.url, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { accept: "application/json", "content-type": "application/json", ...organizationHeaders(retryScope?.organizationId) }, body: JSON.stringify(request.body), signal });
  } catch {
    throw new ProductsApiError(0, "Undo could not reach the server. The imported products are unchanged.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 202) {
    const pending = GoPendingSchema.safeParse(body);
    if (pending.success) return { kind: "pending", reason: pending.data.reason };
    const error = ErrorSchema.safeParse(body);
    return { kind: "pending", reason: error.success ? error.data.error : "Undo is waiting for approval." };
  }
  if (!response.ok) {
    const error = ErrorSchema.safeParse(body);
    if (isDefinitiveNoEffectGoRejection(response.status) && attempt.keys) clearGoProductIntent(attempt.keys, "undo", attempt.id);
    throw new ProductsApiError(response.status, error.success ? error.data.error : "The import could not be undone.");
  }
  {
    const envelope = z.object({ ok: z.literal(true), data: GoUndoImportOutputSchema }).strict().safeParse(body);
    if (!envelope.success) throw new ProductsApiError(response.status, "The import undo returned data in an unexpected format.");
    const { archived: undone, itemIds } = envelope.data.data;
    if (!returnedIDsMatchRequest(itemIds, importIds, undone)) throw new ProductsApiError(response.status, "The import undo returned invalid or inconsistent item IDs. Verify the catalog before retrying.");
    if (!attempt.keys) throw new ProductsApiError(0, "Product import recovery scope was lost. Verify the catalog before retrying.");
    const recoveries = readProductImportRecoveries(attempt.keys).map((recovery) => {
      const batchIds = new Set(recovery.activeIds);
      if (itemIds.some((id) => batchIds.has(id))) {
        const archived = new Set([...recovery.archivedIds, ...itemIds.filter((id) => batchIds.has(id))]);
        const newlyArchived = itemIds.filter((id) => batchIds.has(id) && !recovery.archivedIds.includes(id)).length;
        return {
          ...recovery,
          result: { ...recovery.result, inserted: Math.max(0, recovery.result.inserted - newlyArchived) },
          activeIds: recovery.activeIds.filter((id) => !archived.has(id)),
          archivedIds: [...archived],
        };
      }
      return recovery;
    });
    writeProductImportRecoveries(attempt.keys, recoveries);
    clearGoProductIntent(attempt.keys, "undo", attempt.id);
    return { kind: "completed", undone, remaining: Math.max(0, importIds.length - undone), itemIds };
  }
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
    response = await fetch(request.url, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { accept: "application/json", "content-type": "application/json", ...organizationHeaders(retryScope?.organizationId) }, body: JSON.stringify(request.body), signal });
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
  const restoredIDs = new Set(itemIds);
  const recoveries = readProductImportRecoveries(attempt.keys).map((recovery) => {
    const batchIds = new Set(recovery.archivedIds);
    if (!itemIds.some((id) => batchIds.has(id))) return recovery;
    const newlyRestored = itemIds.filter((id) => batchIds.has(id) && !recovery.activeIds.includes(id)).length;
    const active = new Set([...recovery.activeIds, ...itemIds.filter((id) => batchIds.has(id))]);
    return {
      ...recovery,
      result: { ...recovery.result, inserted: recovery.result.inserted + newlyRestored },
      activeIds: [...active],
      archivedIds: recovery.archivedIds.filter((id) => !restoredIDs.has(id)),
    };
  });
  writeProductImportRecoveries(attempt.keys, recoveries);
  clearGoProductIntent(attempt.keys, "restore", attempt.id);
  return { kind: "completed", restored, itemIds };
}
