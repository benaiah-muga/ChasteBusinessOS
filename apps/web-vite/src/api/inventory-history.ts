import { z } from "zod";

const MovementSchema = z.object({
  id: z.string().min(1),
  quantityDelta: z.number().int().safe(),
  reason: z.string().min(1),
  note: z.string().nullable(),
  refType: z.string().nullable(),
  unitCostMinor: z.number().int().safe().nullable(),
  lotCode: z.string().nullable(),
  locationCode: z.string().nullable(),
  actorType: z.string().min(1),
  createdAt: z.string().refine((value) => Number.isFinite(Date.parse(value)), "Expected a valid timestamp"),
}).strict();

const HistoryResponseSchema = z.object({ movements: z.array(MovementSchema) }).strict();
const PendingResponseSchema = z.object({
  ok: z.literal(false),
  pendingApproval: z.literal(true),
  reason: z.string().optional(),
}).strict();
const ErrorResponseSchema = z.union([
  z.object({ error: z.string().min(1) }).strict(),
  z.object({ ok: z.literal(false), error: z.string().min(1) }).strict(),
]);

export type InventoryMovement = z.infer<typeof MovementSchema>;
export type InventoryHistoryResult =
  | { kind: "loaded"; movements: InventoryMovement[] }
  | { kind: "pending"; reason: string };

export class InventoryHistoryApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "InventoryHistoryApiError";
  }
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function fetchInventoryHistory(
  sku: string,
  signal?: AbortSignal,
): Promise<InventoryHistoryResult> {
  let response: Response;
  try {
    response = await fetch(`/api/inventory?sku=${encodeURIComponent(sku)}`, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new InventoryHistoryApiError(0, "Could not reach inventory history. Check your connection and try again.");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new InventoryHistoryApiError(response.status, "The inventory service returned an unreadable response.");
  }

  if (response.status === 202) {
    const pending = PendingResponseSchema.safeParse(body);
    if (!pending.success) {
      throw new InventoryHistoryApiError(202, "The inventory service returned an unexpected approval response.");
    }
    return { kind: "pending", reason: pending.data.reason ?? "This history request is waiting for approval." };
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new InventoryHistoryApiError(401, "Your session has ended. Sign in again to view stock history.");
    }
    const error = ErrorResponseSchema.safeParse(body);
    throw new InventoryHistoryApiError(response.status, error.success ? error.data.error : "Could not load stock history.");
  }

  if (response.status !== 200) {
    throw new InventoryHistoryApiError(response.status, "The inventory service returned an unexpected history response.");
  }
  const parsed = HistoryResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new InventoryHistoryApiError(response.status, "The inventory service returned stock history in an unexpected format.");
  }
  return { kind: "loaded", movements: parsed.data.movements };
}
