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

const InventoryReportSchema = z.object({
  items: z.array(InventoryItemSchema),
  totalValueMinor: z.number().int().safe(),
});

export type InventoryItem = z.infer<typeof InventoryItemSchema>;

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

export async function fetchInventoryReport(signal?: AbortSignal): Promise<{ items: InventoryItem[]; totalValueMinor: number }> {
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
  return parsed.data;
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
