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
const ActiveGoIntentSchema = z.object({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/i),
  intentId: z.string().uuid(),
}).strict();

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
const activeRetryIntents = new Map<string, z.infer<typeof ActiveGoIntentSchema>>();

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
  if (!goEnabled) await assertNoUnresolvedGoIntent(input, retryScope);
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
  if (!scope?.actorId.trim() || !scope.organizationId.trim()) {
    throw new InventoryLocationActionError(0, "Wait for your account and organization to finish loading before changing inventory.");
  }
  const keys = await retryIntentKeys(input, scope);
  if (!keys.storageKey || !keys.scopeStorageKey || !keys.fingerprint) {
    throw new InventoryLocationActionError(0, "Inventory retry protection is unavailable. Enable secure browser storage before changing inventory.");
  }
  const memoryActive = keys.scopeMemoryKey ? activeRetryIntents.get(keys.scopeMemoryKey) ?? null : null;
  const memoryAction = retryIntents.get(keys.memoryKey) ?? null;
  let storedActive: z.infer<typeof ActiveGoIntentSchema> | null = null;
  let storedAction: string | null = null;
  if (keys.scopeStorageKey || keys.storageKey) {
    try {
      if (keys.scopeStorageKey) storedActive = parseActiveGoIntent(localStorage.getItem(keys.scopeStorageKey));
      if (keys.storageKey) storedAction = parseStoredIntentId(localStorage.getItem(keys.storageKey));
    } catch {
      throw new InventoryLocationActionError(0, "A saved inventory retry marker is malformed or unavailable. Verify the inventory action before retrying.");
    }
  }
  if (memoryActive && storedActive && (memoryActive.intentId !== storedActive.intentId || memoryActive.fingerprint !== storedActive.fingerprint)) {
    throw new InventoryLocationActionError(0, "The saved inventory retry marker does not match this session. Verify inventory before retrying.");
  }
  const active = storedActive ?? memoryActive;
  if (memoryAction && storedAction && memoryAction !== storedAction) {
    throw new InventoryLocationActionError(0, "The saved inventory retry marker does not match this session. Verify inventory before retrying.");
  }
  if (memoryAction && active && memoryAction !== active.intentId) {
    throw new InventoryLocationActionError(0, "The saved inventory retry marker does not match this session. Verify inventory before retrying.");
  }
  if (active && active.fingerprint !== keys.fingerprint) {
    throw new InventoryLocationActionError(0, "A Go inventory action is unresolved. Retry that exact action or verify inventory before starting another one.");
  }
  if (storedAction && active && storedAction !== active.intentId) {
    throw new InventoryLocationActionError(0, "The saved inventory retry markers do not match. Verify inventory before retrying.");
  }
  const previous = active?.intentId ?? storedAction ?? memoryAction;
  const intentId = previous ?? crypto.randomUUID();
  const marker = { fingerprint: keys.fingerprint, intentId };
  try {
    localStorage.setItem(keys.scopeStorageKey, JSON.stringify(marker));
    const persistedActive = parseActiveGoIntent(localStorage.getItem(keys.scopeStorageKey));
    if (!persistedActive || persistedActive.fingerprint !== marker.fingerprint || persistedActive.intentId !== marker.intentId) {
      throw new Error("scope marker did not persist");
    }
    localStorage.setItem(keys.storageKey, intentId);
    if (parseStoredIntentId(localStorage.getItem(keys.storageKey)) !== intentId) {
      throw new Error("action marker did not persist");
    }
  } catch {
    throw new InventoryLocationActionError(0, "Inventory retry markers could not be saved. Enable browser storage before changing inventory.");
  }
  retryIntents.set(keys.memoryKey, intentId);
  if (keys.scopeMemoryKey) activeRetryIntents.set(keys.scopeMemoryKey, marker);
  return intentId;
}

async function clearStableIntent(
  input: InventoryLocationAction,
  intentId: string,
  scope?: InventoryLocationRetryScope,
): Promise<void> {
  const keys = await retryIntentKeys(input, scope);
  if (retryIntents.get(keys.memoryKey) === intentId) retryIntents.delete(keys.memoryKey);
  if (keys.scopeMemoryKey) {
    const active = activeRetryIntents.get(keys.scopeMemoryKey);
    if (active?.fingerprint === keys.fingerprint && active.intentId === intentId) activeRetryIntents.delete(keys.scopeMemoryKey);
  }
  if (keys.storageKey || keys.scopeStorageKey) {
    try {
      if (keys.storageKey && localStorage.getItem(keys.storageKey) === intentId) localStorage.removeItem(keys.storageKey);
      if (keys.scopeStorageKey) {
        const active = parseActiveGoIntent(localStorage.getItem(keys.scopeStorageKey));
        if (active?.fingerprint === keys.fingerprint && active.intentId === intentId) localStorage.removeItem(keys.scopeStorageKey);
      }
    } catch {
      // A completed attempt no longer needs its saved identity in this page.
    }
  }
}

async function retryIntentKeys(
  input: InventoryLocationAction,
  scope?: InventoryLocationRetryScope,
): Promise<{ memoryKey: string; storageKey: string | null; scopeMemoryKey: string | null; scopeStorageKey: string | null; fingerprint: string }> {
  const actorId = scope?.actorId.trim() ?? "";
  const organizationId = scope?.organizationId.trim() ?? "";
  const scoped = Boolean(actorId && organizationId);
  const canonicalScope = scoped ? { actorId, organizationId } : null;
  const serialized = JSON.stringify({
    input,
    ...(canonicalScope ?? {}),
  });
  const memoryKey = `${retryIntentPrefix}${serialized}`;
  const scopeMemoryKey = canonicalScope ? `${retryIntentPrefix}scope:${JSON.stringify(canonicalScope)}` : null;
  if (!scoped) return { memoryKey, storageKey: null, scopeMemoryKey: null, scopeStorageKey: null, fingerprint: "" };
  try {
    const [actionHash, scopeHash] = await Promise.all([
      digest(serialized),
      digest(JSON.stringify(canonicalScope)),
    ]);
    return {
      memoryKey,
      storageKey: `${retryIntentPrefix}${actionHash}`,
      scopeMemoryKey,
      scopeStorageKey: `${retryIntentPrefix}scope:${scopeHash}`,
      fingerprint: actionHash,
    };
  } catch {
    // Without WebCrypto, retry identity remains in memory and no scoped value is persisted.
  }
  return { memoryKey, storageKey: null, scopeMemoryKey, scopeStorageKey: null, fingerprint: "" };
}

async function digest(value: string): Promise<string> {
  const valueDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(valueDigest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function assertNoUnresolvedGoIntent(input: InventoryLocationAction, scope?: InventoryLocationRetryScope): Promise<void> {
  const keys = await retryIntentKeys(input, scope);
  const memoryActive = keys.scopeMemoryKey ? activeRetryIntents.get(keys.scopeMemoryKey) : undefined;
  if (!keys.scopeStorageKey && !keys.storageKey) {
    if (memoryActive || retryIntents.size > 0 || activeRetryIntents.size > 0) {
      throw new InventoryLocationActionError(0, "A Go inventory action is unresolved. Restore Go inventory writes and retry it before using the legacy route.");
    }
    try {
      for (let index = 0; index < localStorage.length; index += 1) {
        if (localStorage.key(index)?.startsWith(retryIntentPrefix)) {
          throw new InventoryLocationActionError(0, "A Go inventory action is unresolved. Restore Go inventory writes and retry it before using the legacy route.");
        }
      }
    } catch (error) {
      if (error instanceof InventoryLocationActionError) throw error;
      throw new InventoryLocationActionError(0, "A saved inventory retry marker is malformed or unavailable. Verify the inventory action before retrying.");
    }
    return;
  }
  try {
    const storedActive = keys.scopeStorageKey ? parseActiveGoIntent(localStorage.getItem(keys.scopeStorageKey)) : null;
    const storedAction = keys.storageKey ? parseStoredIntentId(localStorage.getItem(keys.storageKey)) : null;
    if (memoryActive || storedActive || storedAction) {
      throw new InventoryLocationActionError(0, "A Go inventory action is unresolved. Restore Go inventory writes and retry it before using the legacy route.");
    }
  } catch (error) {
    if (error instanceof InventoryLocationActionError) throw error;
    throw new InventoryLocationActionError(0, "A saved inventory retry marker is malformed or unavailable. Verify the inventory action before retrying.");
  }
}

function parseStoredIntentId(value: string | null): string | null {
  if (value === null) return null;
  if (!isIntentId(value)) throw new InventoryLocationActionError(0, "A saved inventory retry marker is malformed. Verify the inventory action before retrying.");
  return value;
}

function parseActiveGoIntent(value: string | null): z.infer<typeof ActiveGoIntentSchema> | null {
  if (value === null) return null;
  let decoded: unknown;
  try { decoded = JSON.parse(value); }
  catch { throw new InventoryLocationActionError(0, "A saved inventory retry marker is malformed. Verify the inventory action before retrying."); }
  const parsed = ActiveGoIntentSchema.safeParse(decoded);
  if (!parsed.success) throw new InventoryLocationActionError(0, "A saved inventory retry marker is malformed. Verify the inventory action before retrying.");
  return parsed.data;
}

function isIntentId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function unexpectedResponse(status: number): InventoryLocationActionError {
  return new InventoryLocationActionError(status, "The inventory service returned an unexpected result. Check inventory before retrying.");
}
