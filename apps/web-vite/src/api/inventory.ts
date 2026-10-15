import { z } from "zod";

const SwitchboardSchema = z.object({
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

const InventoryItemSchema = z.object({
  id: z.string().uuid(),
  sku: z.string(),
  name: z.string(),
  kind: z.enum(["goods", "service"]),
  unitLabel: z.string(),
  salePriceMinor: z.number().int().safe(),
  imageUrl: z.string().nullable(),
  tags: z.array(z.string()),
  barcode: z.string().nullable(),
  onHandThousandths: z.number().int().safe(),
  valueMinor: z.number().int().safe(),
  avgUnitCostMinor: z.number().int().safe(),
  reservedThousandths: z.number().int().safe(),
  availableThousandths: z.number().int().safe(),
  totalValueMinor: z.number().int().safe(),
  reorderPointThousandths: z.number().int().safe(),
  reorderNeeded: z.boolean(),
}).strict();

const CycleCountLineSchema = z.object({
  sku: z.string().min(1),
  expectedThousandths: z.number().int().safe(),
  countedThousandths: z.number().int().nonnegative().safe().nullable(),
  varianceThousandths: z.number().int().safe().nullable(),
}).strict();

const CycleCountSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["open", "posted", "cancelled"]),
  note: z.string().nullable(),
  locationCode: z.string().min(1).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  lines: z.array(CycleCountLineSchema),
}).strict();

const InventoryTransferLineSchema = z.object({
  lineId: z.string().uuid(),
  sku: z.string(),
  quantityThousandths: z.number().int().safe(),
  confirmedThousandths: z.number().int().safe(),
}).strict();

const InventoryTransferSchema = z.object({
  id: z.string().uuid(),
  number: z.number().int().positive().safe(),
  status: z.enum(["pending", "partial", "confirmed", "cancelled", "reversed"]),
  note: z.string().nullable(),
  from: z.string(),
  to: z.string(),
  lines: z.array(InventoryTransferLineSchema),
}).strict();

const InventoryReservationSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  itemId: z.string().uuid(),
  sku: z.string(),
  quantityThousandths: z.number().int().safe().nonnegative(),
  reason: z.string(),
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  status: z.enum(["open", "released"]),
  createdByActorType: z.string().nullable(),
  createdByActorId: z.string().nullable(),
  releasedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

const InventoryReportSchema = z.object({
  items: z.array(InventoryItemSchema),
  totalValueMinor: z.number().int().safe(),
  reorderAlerts: z.array(z.object({
    sku: z.string(),
    name: z.string(),
    onHandThousandths: z.number().int().safe(),
    reorderPointThousandths: z.number().int().safe(),
    shortfallThousandths: z.number().int().safe(),
    avgUnitCostMinor: z.number().int().safe(),
  }).strict()),
  locations: z.array(z.object({
    id: z.string().uuid(),
    orgId: z.string().uuid(),
    code: z.string().min(1),
    name: z.string().min(1),
    createdAt: z.string().datetime({ offset: true }),
  }).strict()),
  lots: z.array(z.object({
    id: z.string().uuid(),
    sku: z.string(),
    lotCode: z.string(),
    balanceThousandths: z.number().int().safe(),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
  }).strict()),
  cycleCounts: z.array(CycleCountSchema),
  transfers: z.array(InventoryTransferSchema),
  reservations: z.array(InventoryReservationSchema),
}).strict();

const GoStockReportSchema = z.object({
  items: z.array(z.object({
    sku: z.string(),
    name: z.string(),
    kind: z.enum(["goods", "service"]),
    unitLabel: z.string(),
    salePriceMinor: z.number().int().safe(),
    imageUrl: z.string().nullable(),
    tags: z.array(z.string()),
    barcode: z.string().nullable(),
    onHandThousandths: z.number().int().safe(),
    valueMinor: z.number().int().safe(),
    avgUnitCostMinor: z.number().int().safe(),
    reservedThousandths: z.number().int().safe(),
    availableThousandths: z.number().int().safe(),
    reorderPointThousandths: z.number().int().safe(),
    reorderNeeded: z.boolean(),
  }).strict()),
  totalValueMinor: z.number().int().safe(),
}).strict();
const CapabilityResponseSchema = z.object({ ok: z.literal(true), data: GoStockReportSchema }).strict();

// These exported shapes are the UI's inventory view model. The wire schemas
// above remain stricter and validate every Go field before returning data.
export type InventoryItem = {
  sku: string;
  name: string;
  kind: string;
  unitLabel: string;
  onHandThousandths: number;
  reservedThousandths: number;
  availableThousandths: number;
  totalValueMinor: number;
  reorderPointThousandths: number;
  reorderNeeded: boolean;
};
export type InventoryReport = {
  items: InventoryItem[];
  totalValueMinor: number;
  locations: InventoryLocation[];
  lots: InventoryLot[];
  cycleCounts: InventoryCycleCount[];
  transfers: InventoryTransfer[];
  reservations: InventoryReservation[];
  reorderAlerts: Array<{
    sku: string;
    name: string;
    onHandThousandths: number;
    reorderPointThousandths: number;
    shortfallThousandths: number;
    avgUnitCostMinor: number;
  }>;
};
export type InventoryLocation = { id: string; code: string; name: string };
export type InventoryLot = { id: string; sku: string; lotCode: string; balanceThousandths: number; expiresAt: string | null };
export type InventoryCycleCount = z.infer<typeof CycleCountSchema>;
export type InventoryTransfer = {
  id: string;
  number: number;
  status: string;
  note: string | null;
  from: string;
  to: string;
  lines: Array<{ lineId: string; sku: string; quantityThousandths: number; confirmedThousandths: number }>;
};
export type InventoryReservation = {
  id: string;
  sku: string;
  quantityThousandths: number;
  reason: string;
  status: string;
  createdAt: string;
};

export class InventoryApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "InventoryApiError";
  }
}

export async function fetchInventoryEnabled(signal?: AbortSignal, organizationId?: string): Promise<boolean> {
  const response = await fetchJson("/api/modules", signal, organizationId);
  if (!response.ok) throw new InventoryApiError(response.status, "Could not check whether the inventory module is enabled.");
  const parsed = SwitchboardSchema.safeParse(response.body);
  if (!parsed.success) throw new InventoryApiError(response.status, "The module switchboard returned data in an unexpected format.");
  const catalogIds = new Set(parsed.data.catalog.map((module) => module.id));
  if (!catalogIds.has("inventory") || parsed.data.enabledModules.some((id) => !catalogIds.has(id))) {
    throw new InventoryApiError(response.status, "The module switchboard returned an invalid inventory configuration.");
  }
  return parsed.data.enabledModules.includes("inventory");
}

export async function fetchInventoryReport(signal?: AbortSignal, organizationId?: string): Promise<InventoryReport> {
  const response = await fetchJson("/api/inventory", signal, organizationId);
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(response.body);
    if (response.status === 401) throw new InventoryApiError(401, "Your session has ended. Sign in again to continue.");
    if (response.status === 403 || response.status === 422) {
      throw new InventoryApiError(response.status, error.success ? error.data.error : "You do not have permission to view inventory.");
    }
    throw new InventoryApiError(response.status, error.success ? error.data.error : "The inventory service is unavailable.");
  }
  const parsed = InventoryReportSchema.safeParse(response.body);
  if (!parsed.success) throw new InventoryApiError(response.status, "The inventory service returned data in an unexpected format.");
  return parsed.data;
}

export async function fetchGoStockReport(signal?: AbortSignal): Promise<z.infer<typeof GoStockReportSchema>> {
  let response: Response;
  try {
    response = await fetch("/api/capabilities/execute", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ capabilityId: "inventory.stockReport", input: {}, intentId: crypto.randomUUID() }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new InventoryApiError(0, timedOut
      ? "The Go inventory service took too long to respond. Try again."
      : "Could not reach the Go inventory service. Check your connection and try again.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(body);
    throw new InventoryApiError(response.status, error.success ? error.data.error : "Could not load Go stock levels.");
  }
  const parsed = CapabilityResponseSchema.safeParse(body);
  if (!parsed.success) throw new InventoryApiError(response.status, "The Go inventory service returned data in an unexpected format.");
  return parsed.data.data;
}

async function fetchJson(path: string, signal?: AbortSignal, organizationId?: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      headers: { accept: "application/json", ...(organizationId ? { "X-Organization-ID": organizationId } : {}) },
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new InventoryApiError(0, timedOut
      ? "The inventory service took too long to respond. Try again."
      : "Could not reach the inventory service. Check your connection and try again.");
  }
  return { ok: response.ok, status: response.status, body: await response.json().catch(() => null) };
}
