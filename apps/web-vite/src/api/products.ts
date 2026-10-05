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
  let response: Response;
  try {
    response = await fetch("/api/import", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ entity: "products", rows }), signal });
  } catch {
    throw new ProductsApiError(0, "The product import could not reach the server. Your preview is still available.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 202) {
    const error = ErrorSchema.safeParse(body);
    throw new ProductsApiError(202, error.success ? error.data.error : "The import is waiting for approval.");
  }
  if (!response.ok) {
    const error = ErrorSchema.safeParse(body);
    throw new ProductsApiError(response.status, error.success ? error.data.error : "The product import could not be completed.");
  }
  const parsed = ImportResultSchema.safeParse(body);
  if (!parsed.success) throw new ProductsApiError(response.status, "The product import returned data in an unexpected format.");
  return parsed.data;
}

export async function undoProductImport(importIds: string[], signal?: AbortSignal): Promise<{ kind: "completed"; undone: number; remaining: number } | { kind: "pending"; reason: string }> {
  let response: Response;
  try {
    response = await fetch("/api/import", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ entity: "products", action: "undo", importIds }), signal });
  } catch {
    throw new ProductsApiError(0, "Undo could not reach the server. The imported products are unchanged.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 202) {
    const error = ErrorSchema.safeParse(body);
    return { kind: "pending", reason: error.success ? error.data.error : "Undo is waiting for approval." };
  }
  if (!response.ok) {
    const error = ErrorSchema.safeParse(body);
    throw new ProductsApiError(response.status, error.success ? error.data.error : "The import could not be undone.");
  }
  const parsed = UndoResultSchema.safeParse(body);
  if (!parsed.success) throw new ProductsApiError(response.status, "The import undo returned data in an unexpected format.");
  return { kind: "completed", ...parsed.data };
}
