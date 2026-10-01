import { z } from "zod";

const SuccessEnvelope = <T extends z.ZodType>(data: T) => z.object({
  ok: z.literal(true),
  data,
}).strict();

const PendingEnvelope = z.object({
  ok: z.literal(false),
  pendingApproval: z.literal(true),
  reason: z.string().min(1),
}).strict();

const ErrorEnvelope = z.object({ ok: z.literal(false), error: z.string().min(1) }).strict();
const LocationCreated = SuccessEnvelope(z.object({ locationId: z.string().min(1) }).strict());
const ReservationCreated = SuccessEnvelope(z.object({
  reservationId: z.string().min(1),
  availableAfterThousandths: z.number().int().safe(),
}).strict());
const ReservationReleased = SuccessEnvelope(z.object({ released: z.literal(true) }).strict());

export type InventoryLocationActionResult =
  | { kind: "completed" }
  | { kind: "pending"; reason: string };

export class InventoryLocationActionError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "InventoryLocationActionError";
  }
}

export async function createInventoryLocation(input: { code: string; name: string }): Promise<InventoryLocationActionResult> {
  const result = await postAction({ action: "createLocation", code: input.code, name: input.name }, LocationCreated);
  return result;
}

export async function reserveInventoryStock(input: {
  sku: string;
  quantityThousandths: number;
  reason: string;
}): Promise<InventoryLocationActionResult> {
  return postAction({
    action: "reserveStock",
    sku: input.sku,
    quantityThousandths: input.quantityThousandths,
    reason: input.reason,
  }, ReservationCreated);
}

export async function releaseInventoryReservation(input: { reservationId: string }): Promise<InventoryLocationActionResult> {
  return postAction({ action: "releaseReservation", reservationId: input.reservationId }, ReservationReleased);
}

async function postAction<T extends z.ZodType>(
  input: Record<string, unknown>,
  successSchema: T,
): Promise<InventoryLocationActionResult> {
  let response: Response;
  try {
    response = await fetch("/api/inventory", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ ...input, intentId: crypto.randomUUID() }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new InventoryLocationActionError(0, timedOut
      ? "The request timed out. Its outcome is unknown, so check inventory before retrying."
      : "The connection ended before the result arrived. Its outcome is unknown, so check inventory before retrying.");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new InventoryLocationActionError(0, "The server response could not be read. Its outcome is unknown, so check inventory before retrying.");
  }

  if (response.status === 202) {
    const pending = PendingEnvelope.safeParse(body);
    if (!pending.success) throw unexpectedResponse(response.status);
    return { kind: "pending", reason: pending.data.reason };
  }
  if (response.ok) {
    const parsed = successSchema.safeParse(body);
    if (!parsed.success || response.status !== 200) throw unexpectedResponse(response.status);
    return { kind: "completed" };
  }

  const error = ErrorEnvelope.safeParse(body);
  if (error.success && [400, 401, 403, 422].includes(response.status)) {
    const message = response.status === 401
      ? "Your session has ended. Sign in again to continue."
      : response.status === 403
        ? "You do not have permission to change inventory."
        : error.data.error;
    throw new InventoryLocationActionError(response.status, message);
  }
  throw unexpectedResponse(response.status);
}

function unexpectedResponse(status: number): InventoryLocationActionError {
  return new InventoryLocationActionError(status, "The inventory service returned an unexpected result. Check inventory before retrying.");
}
