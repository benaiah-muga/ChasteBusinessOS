import { z } from "zod";

const ActionResponseSchema = z.object({
  ok: z.literal(true),
  data: z.unknown(),
}).strict();

const PendingResponseSchema = z.object({
  ok: z.literal(false),
  pendingApproval: z.literal(true),
}).passthrough();

const BarcodeResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    item: z.object({ sku: z.string().min(1), name: z.string() }).passthrough().nullable(),
  }).passthrough(),
}).passthrough();

export type InventoryCycleCountAction =
  | { action: "createCycleCount"; note: string; skus?: string[]; locationId?: string }
  | { action: "recordCycleCounts"; countId: string; counts: Array<{ sku: string; countedThousandths: number }> }
  | { action: "postCycleCount" | "cancelCycleCount"; countId: string };

export type InventoryCycleCountActionResult = { kind: "completed" } | { kind: "pending" };

export class InventoryCycleCountApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "InventoryCycleCountApiError";
  }
}

export async function submitInventoryCycleCountAction(
  input: InventoryCycleCountAction,
  signal?: AbortSignal,
): Promise<InventoryCycleCountActionResult> {
  const body = await postInventory({ ...input, intentId: crypto.randomUUID() }, signal);
  if (body.response.status === 202) {
    if (!PendingResponseSchema.safeParse(body.data).success) {
      throw new InventoryCycleCountApiError(202, "The inventory service returned an unexpected approval response.");
    }
    return { kind: "pending" };
  }
  if (!body.response.ok) {
    throw new InventoryCycleCountApiError(body.response.status, errorMessage(body.data));
  }
  if (body.response.status !== 200 || !ActionResponseSchema.safeParse(body.data).success) {
    throw new InventoryCycleCountApiError(body.response.status, "The inventory service returned an unexpected action response.");
  }
  return { kind: "completed" };
}

export async function lookupInventoryBarcode(
  barcode: string,
  signal?: AbortSignal,
): Promise<{ sku: string; name: string } | null> {
  const body = await postInventory({ action: "lookupByBarcode", barcode }, signal);
  if (!body.response.ok || body.response.status !== 200) {
    throw new InventoryCycleCountApiError(body.response.status, errorMessage(body.data));
  }
  const parsed = BarcodeResponseSchema.safeParse(body.data);
  if (!parsed.success) {
    throw new InventoryCycleCountApiError(body.response.status, "The inventory service returned an unexpected barcode response.");
  }
  const item = parsed.data.data.item;
  return item ? { sku: item.sku, name: item.name } : null;
}

async function postInventory(input: object, signal?: AbortSignal): Promise<{ response: Response; data: unknown }> {
  let response: Response;
  try {
    response = await fetch("/api/inventory", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(input),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new InventoryCycleCountApiError(0, timedOut
      ? "The count action timed out. Check count history before retrying to avoid recording it twice."
      : "Could not reach the inventory service. Check your connection and try again.");
  }
  const data: unknown = await response.json().catch(() => null);
  return { response, data };
}

function errorMessage(value: unknown): string {
  const parsed = z.object({ error: z.string() }).safeParse(value);
  if (parsed.success) return parsed.data.error;
  return "The inventory service could not complete that action.";
}
