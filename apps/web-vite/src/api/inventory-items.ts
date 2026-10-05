import { z } from "zod";

const CreateItemSchema = z.object({
  action: z.literal("createItem"),
  sku: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["goods", "service"]),
  unitLabel: z.string().trim().min(1).max(20),
  salePriceMinor: z.number().int().nonnegative().safe(),
  reorderPointThousandths: z.number().int().nonnegative().safe(),
  barcode: z.string().trim().min(3).max(64).optional(),
  imageUrl: z.string().url().optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(20),
}).strict();

const AdjustStockSchema = z.object({
  action: z.literal("adjustStock"),
  sku: z.string().trim().min(1),
  quantityDelta: z.number().int().safe().refine((value) => value !== 0),
  note: z.string().trim().min(3),
  lotCode: z.string().trim().min(1).max(40).optional(),
  locationCode: z.string().trim().min(1).max(20).optional(),
}).strict();

const PendingSchema = z.object({
  ok: z.literal(false),
  pendingApproval: z.literal(true),
  reason: z.string(),
}).strict();
const ActionResponseSchema = z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) }).strict();
const CreateItemOutputSchema = z.object({ itemId: z.string().uuid() }).strict();
const AdjustStockOutputSchema = z.object({ onHandThousandths: z.number().int().safe() }).strict();

export type CreateInventoryItem = z.infer<typeof CreateItemSchema>;
export type AdjustInventoryStock = z.infer<typeof AdjustStockSchema>;
export type InventoryItemAction = CreateInventoryItem | AdjustInventoryStock;
export type InventoryItemActionResult = { kind: "completed" } | { kind: "pending"; reason: string };

export function inventoryItemActionRequest(
  action: InventoryItemAction,
  intentId: string,
  useGo: boolean,
): { url: string; body: Record<string, unknown> } {
  if (!useGo) return { url: "/api/inventory", body: { ...action, intentId } };
  const { action: operation, ...input } = action;
  return {
    url: "/api/capabilities/execute",
    body: {
      capabilityId: operation === "createItem" ? "inventory.createItem" : "inventory.adjustStock",
      input,
      intentId,
    },
  };
}

export async function submitInventoryItemAction(
  action: InventoryItemAction,
  signal?: AbortSignal,
): Promise<InventoryItemActionResult> {
  const parsedAction = action.action === "createItem"
    ? CreateItemSchema.safeParse(action)
    : AdjustStockSchema.safeParse(action);
  if (!parsedAction.success) throw new InventoryItemActionError(0, "Check the item details and try again.");

  const intentId = crypto.randomUUID();
  const useGo = typeof __GO_INVENTORY_ITEM_SLICE__ !== "undefined" && __GO_INVENTORY_ITEM_SLICE__;
  const request = inventoryItemActionRequest(parsedAction.data, intentId, useGo);

  let response: Response;
  try {
    response = await fetch(request.url, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(request.body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new InventoryItemActionError(0, "The inventory action timed out. Check the current stock before trying again.");
    }
    throw new InventoryItemActionError(0, "Could not reach the inventory service. Check your connection and try again.");
  }

  const body: unknown = await response.json().catch(() => null);
  if (response.status === 202) {
    const pending = PendingSchema.safeParse(body);
    if (!pending.success) throw new InventoryItemActionError(202, "The inventory service returned an unexpected approval response.");
    return { kind: "pending", reason: pending.data.reason };
  }
  if (!response.ok) {
    const error = z.object({ ok: z.literal(false), error: z.string() }).strict().safeParse(body);
    const plainError = z.object({ error: z.string() }).strict().safeParse(body);
    throw new InventoryItemActionError(response.status, error.success ? error.data.error : plainError.success ? plainError.data.error : "The inventory action could not be completed.");
  }

  const envelope = ActionResponseSchema.safeParse(body);
  if (!envelope.success) throw new InventoryItemActionError(response.status, "The inventory service returned an unexpected action response.");
  const output = action.action === "createItem"
    ? CreateItemOutputSchema.safeParse(envelope.data.data)
    : AdjustStockOutputSchema.safeParse(envelope.data.data);
  if (!output.success) throw new InventoryItemActionError(response.status, "The inventory service returned an unexpected action result.");
  return { kind: "completed" };
}

export class InventoryItemActionError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "InventoryItemActionError";
  }
}
