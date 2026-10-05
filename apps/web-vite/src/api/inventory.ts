import { z } from "zod";

const SwitchboardSchema = z.object({
  catalog: z.array(z.object({ id: z.string() })),
  enabledModules: z.array(z.string()),
});

const InventoryItemSchema = z.object({
  sku: z.string(),
  name: z.string(),
  kind: z.string(),
  unitLabel: z.string(),
  onHandThousandths: z.number().int().safe(),
  reservedThousandths: z.number().int().safe(),
  availableThousandths: z.number().int().safe(),
  totalValueMinor: z.number().int().safe(),
  reorderPointThousandths: z.number().int().safe(),
  reorderNeeded: z.boolean(),
});

const CycleCountLineSchema = z.object({
  sku: z.string().min(1),
  expectedThousandths: z.number().int().safe(),
  countedThousandths: z.number().int().nonnegative().safe().nullable(),
  varianceThousandths: z.number().int().safe().nullable(),
});

const CycleCountSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["open", "posted", "cancelled"]),
  note: z.string().nullable(),
  locationCode: z.string().min(1).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  lines: z.array(CycleCountLineSchema),
});

const InventoryTransferLineSchema = z.object({
  lineId: z.string(),
  sku: z.string(),
  quantityThousandths: z.number().int().safe(),
  confirmedThousandths: z.number().int().safe(),
});

const InventoryTransferSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  status: z.string(),
  note: z.string().nullable(),
  from: z.string(),
  to: z.string(),
  lines: z.array(InventoryTransferLineSchema),
});

const InventoryReservationSchema = z.object({
  id: z.string().min(1),
  sku: z.string(),
  quantityThousandths: z.number().int().safe(),
  reason: z.string(),
  status: z.string(),
  createdAt: z.string().datetime({ offset: true }),
});

const InventoryReportSchema = z.object({
  items: z.array(InventoryItemSchema),
  totalValueMinor: z.number().int().safe(),
  locations: z.array(z.object({
    id: z.string().min(1),
    code: z.string().min(1),
    name: z.string().min(1),
  })),
  lots: z.array(z.object({
    id: z.string(),
    sku: z.string(),
    lotCode: z.string(),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    balanceThousandths: z.number().int().safe().optional(),
  })),
  cycleCounts: z.array(CycleCountSchema),
  transfers: z.array(InventoryTransferSchema),
  reservations: z.array(InventoryReservationSchema).default([]),
});

const GoStockReportSchema = z.object({
  items: z.array(z.object({
    sku: z.string(),
    name: z.string(),
    kind: z.string(),
    unitLabel: z.string(),
    onHandThousandths: z.number().int().safe(),
    reservedThousandths: z.number().int().safe(),
    availableThousandths: z.number().int().safe(),
    valueMinor: z.number().int().safe(),
    reorderPointThousandths: z.number().int().safe(),
    reorderNeeded: z.boolean(),
  })),
  totalValueMinor: z.number().int().safe(),
}).strict();
const CapabilityResponseSchema = z.object({ ok: z.literal(true), data: GoStockReportSchema }).strict();

export type InventoryItem = z.infer<typeof InventoryItemSchema>;
export type InventoryLocation = z.infer<typeof InventoryReportSchema>["locations"][number];
export type InventoryLot = z.infer<typeof InventoryReportSchema>["lots"][number];
export type InventoryCycleCount = z.infer<typeof CycleCountSchema>;
export type InventoryTransfer = z.infer<typeof InventoryTransferSchema>;
export type InventoryReservation = z.infer<typeof InventoryReservationSchema>;

export class InventoryApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "InventoryApiError";
  }
}

export async function fetchInventoryEnabled(signal?: AbortSignal): Promise<boolean> {
  const response = await fetchJson("/api/modules", signal);
  if (!response.ok) throw new InventoryApiError(response.status, "Could not check whether the inventory module is enabled.");
  const parsed = SwitchboardSchema.safeParse(response.body);
  if (!parsed.success) throw new InventoryApiError(response.status, "The module switchboard returned data in an unexpected format.");
  const catalogIds = new Set(parsed.data.catalog.map((module) => module.id));
  if (!catalogIds.has("inventory") || parsed.data.enabledModules.some((id) => !catalogIds.has(id))) {
    throw new InventoryApiError(response.status, "The module switchboard returned an invalid inventory configuration.");
  }
  return parsed.data.enabledModules.includes("inventory");
}

export async function fetchInventoryReport(signal?: AbortSignal): Promise<{ items: InventoryItem[]; totalValueMinor: number; locations: InventoryLocation[]; lots: InventoryLot[]; cycleCounts: InventoryCycleCount[]; transfers: InventoryTransfer[]; reservations: InventoryReservation[] }> {
  const response = await fetchJson("/api/inventory", signal);
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
  if (typeof __GO_INVENTORY_ITEM_SLICE__ === "undefined" || !__GO_INVENTORY_ITEM_SLICE__) return parsed.data;
  const stock = await fetchGoStockReport(signal);
  return {
    ...parsed.data,
    totalValueMinor: stock.totalValueMinor,
    items: stock.items.map((item) => ({
      ...item,
      totalValueMinor: item.valueMinor,
    })),
  };
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

async function fetchJson(path: string, signal?: AbortSignal): Promise<{ ok: boolean; status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
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
