import { z } from "zod";

const SuccessEnvelope = <T extends z.ZodType>(data: T) => z.object({
  ok: z.literal(true),
  data,
}).strict();

const PendingEnvelope = z.object({
  ok: z.literal(false),
  pendingApproval: z.literal(true),
  reason: z.string().min(1),
  approvalId: z.string().uuid().optional(),
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

type InventoryLocationAction =
  | { action: "createLocation"; code: string; name: string }
  | { action: "reserveStock"; sku: string; quantityThousandths: number; reason: string }
  | { action: "releaseReservation"; reservationId: string };

export interface InventoryLocationRetryScope {
  actorId: string;
  organizationId: string;
}

const capabilityByAction = {
  createLocation: "inventory.createLocation",
  reserveStock: "inventory.reserveStock",
  releaseReservation: "inventory.releaseReservation",
} as const;

const retryIntentPrefix = "chaste.inventory-location-reservation.intent.v1:";
const retryIntents = new Map<string, string>();

export async function createInventoryLocation(
  input: { code: string; name: string },
  retryScope?: InventoryLocationRetryScope,
): Promise<InventoryLocationActionResult> {
  const result = await postAction({ action: "createLocation", code: input.code, name: input.name }, LocationCreated, retryScope);
  return result;
}

export async function reserveInventoryStock(input: {
  sku: string;
  quantityThousandths: number;
  reason: string;
}, retryScope?: InventoryLocationRetryScope): Promise<InventoryLocationActionResult> {
  return postAction({
    action: "reserveStock",
    sku: input.sku,
    quantityThousandths: input.quantityThousandths,
    reason: input.reason,
  }, ReservationCreated, retryScope);
}

export async function releaseInventoryReservation(
  input: { reservationId: string },
  retryScope?: InventoryLocationRetryScope,
): Promise<InventoryLocationActionResult> {
  return postAction({ action: "releaseReservation", reservationId: input.reservationId }, ReservationReleased, retryScope);
}

async function postAction<T extends z.ZodType>(
  input: InventoryLocationAction,
  successSchema: T,
  retryScope?: InventoryLocationRetryScope,
): Promise<InventoryLocationActionResult> {
  const goEnabled = typeof __GO_INVENTORY_LOCATION_RESERVATION_WRITES__ !== "undefined"
    && __GO_INVENTORY_LOCATION_RESERVATION_WRITES__;
  const intentId = goEnabled ? await stableIntentId(input, retryScope) : crypto.randomUUID();
  const { action, ...capabilityInput } = input;
  const url = goEnabled ? "/api/capabilities/execute" : "/api/inventory";
  const requestBody = goEnabled
    ? { capabilityId: capabilityByAction[action], input: capabilityInput, intentId }
    : { ...input, intentId };
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(requestBody),
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
    if (goEnabled) await clearStableIntent(input, intentId, retryScope);
    return { kind: "completed" };
  }

  const error = ErrorEnvelope.safeParse(body);
  if (error.success && [400, 401, 403, 422].includes(response.status)) {
    if (goEnabled) await clearStableIntent(input, intentId, retryScope);
    const message = response.status === 401
      ? "Your session has ended. Sign in again to continue."
      : response.status === 403
        ? "You do not have permission to change inventory."
        : error.data.error;
    throw new InventoryLocationActionError(response.status, message);
  }
  throw unexpectedResponse(response.status);
}

async function stableIntentId(input: InventoryLocationAction, scope?: InventoryLocationRetryScope): Promise<string> {
  const { memoryKey, storageKey } = await retryIntentKeys(input, scope);
  if (storageKey) {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored && isIntentId(stored)) {
        retryIntents.set(memoryKey, stored);
        return stored;
      }
    } catch {
      // Keep using the in-memory retry identity when browser storage is unavailable.
    }
  }
  const intentId = retryIntents.get(memoryKey) ?? crypto.randomUUID();
  retryIntents.set(memoryKey, intentId);
  if (storageKey) {
    try {
      localStorage.setItem(storageKey, intentId);
    } catch {
      // The in-memory copy protects retries in this page when storage is unavailable.
    }
  }
  return intentId;
}

async function clearStableIntent(
  input: InventoryLocationAction,
  intentId: string,
  scope?: InventoryLocationRetryScope,
): Promise<void> {
  const { memoryKey, storageKey } = await retryIntentKeys(input, scope);
  if (retryIntents.get(memoryKey) === intentId) retryIntents.delete(memoryKey);
  if (storageKey) {
    try {
      if (localStorage.getItem(storageKey) === intentId) localStorage.removeItem(storageKey);
    } catch {
      // A completed attempt no longer needs its saved identity in this page.
    }
  }
}

async function retryIntentKeys(
  input: InventoryLocationAction,
  scope?: InventoryLocationRetryScope,
): Promise<{ memoryKey: string; storageKey: string | null }> {
  const scoped = Boolean(scope?.actorId.trim() && scope.organizationId.trim());
  const serialized = JSON.stringify({
    input,
    ...(scoped ? { actorId: scope!.actorId, organizationId: scope!.organizationId } : {}),
  });
  const memoryKey = `${retryIntentPrefix}${serialized}`;
  if (!scoped) return { memoryKey, storageKey: null };
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
    const hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
    return { memoryKey, storageKey: `${retryIntentPrefix}${hash}` };
  } catch {
    // Without WebCrypto, retry identity remains in memory and no scoped value is persisted.
  }
  return { memoryKey, storageKey: null };
}

function isIntentId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function unexpectedResponse(status: number): InventoryLocationActionError {
  return new InventoryLocationActionError(status, "The inventory service returned an unexpected result. Check inventory before retrying.");
}
