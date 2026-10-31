import { z } from "zod";

const ActionResponseSchema = z.object({
  ok: z.literal(true),
  data: z.unknown(),
}).strict();

const CycleCountOutputSchemas = {
  createCycleCount: z.object({ countId: z.string().uuid(), lineCount: z.number().int().positive().safe() }).strict(),
  recordCycleCounts: z.object({ recorded: z.number().int().positive().max(500).safe() }).strict(),
  postCycleCount: z.object({
    posted: z.literal(true),
    postedVariances: z.number().int().nonnegative().safe(),
    netVarianceThousandths: z.number().int().safe(),
  }).strict(),
  cancelCycleCount: z.object({ cancelled: z.literal(true) }).strict(),
} satisfies Record<InventoryCycleCountAction["action"], z.ZodType>;

const PendingResponseSchema = z.object({
  ok: z.literal(false),
  pendingApproval: z.literal(true),
  reason: z.string().min(1),
  approvalId: z.string().uuid().optional(),
}).strict();
const RejectedResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string().min(1),
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
export interface InventoryCycleCountRetryScope {
  actorId: string;
  organizationId: string;
}

export class InventoryCycleCountApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "InventoryCycleCountApiError";
  }
}

export async function submitInventoryCycleCountAction(
  input: InventoryCycleCountAction,
  signal?: AbortSignal,
  useGoOverride?: boolean,
  retryScope?: InventoryCycleCountRetryScope,
): Promise<InventoryCycleCountActionResult> {
  if (useGoOverride === false) {
    throw new InventoryCycleCountApiError(503, "Go cycle-count writes are not enabled for this request.");
  }
  const intentId = await stableGoCycleCountIntent(input, retryScope);
  const request = inventoryCycleCountActionRequest(input, intentId);
  const body = await postInventory(request.url, request.body, signal, retryScope?.organizationId);
  if (body.response.status === 202) {
    if (!PendingResponseSchema.safeParse(body.data).success) {
      throw new InventoryCycleCountApiError(202, "The inventory service returned an unexpected approval response.");
    }
    return { kind: "pending" };
  }
  if (!body.response.ok) {
    const rejected = RejectedResponseSchema.safeParse(body.data);
    const definiteGoRejection = rejected.success && [400, 401, 403, 422].includes(body.response.status);
    if (definiteGoRejection) await clearStableGoCycleCountIntent(input, intentId, retryScope);
    throw new InventoryCycleCountApiError(body.response.status, errorMessage(body.data));
  }
  const parsed = ActionResponseSchema.safeParse(body.data);
  if (body.response.status !== 200 || !parsed.success || !CycleCountOutputSchemas[input.action].safeParse(parsed.data.data).success) {
    throw new InventoryCycleCountApiError(body.response.status, "The inventory service returned an unexpected action response.");
  }
  await clearStableGoCycleCountIntent(input, intentId, retryScope);
  return { kind: "completed" };
}

export function inventoryCycleCountActionRequest(
  input: InventoryCycleCountAction,
  intentId: string,
): { url: string; body: Record<string, unknown> } {
  const { action, ...capabilityInput } = input;
  const capabilityByAction: Record<InventoryCycleCountAction["action"], string> = {
    createCycleCount: "inventory.createCycleCount",
    recordCycleCounts: "inventory.recordCycleCounts",
    postCycleCount: "inventory.postCycleCount",
    cancelCycleCount: "inventory.cancelCycleCount",
  };
  return {
    url: "/api/capabilities/execute",
    body: { capabilityId: capabilityByAction[action], input: capabilityInput, intentId },
  };
}

const goRetryIntents = new Map<string, string>();
const activeGoRetryIntents = new Map<string, { fingerprint: string; intentId: string }>();
const goRetryPrefix = "chaste.inventory.cycle-count.intent.v2:";
const GoRetryMarkerSchema = z.object({ fingerprint: z.string().regex(/^[0-9a-f]{64}$/i), intentId: z.string().uuid() }).strict();

async function stableGoCycleCountIntent(
  input: InventoryCycleCountAction,
  scope?: InventoryCycleCountRetryScope,
): Promise<string> {
  const keys = await goRetryKeys(input, scope);
  if (!keys.scopeMemoryKey) {
    throw new InventoryCycleCountApiError(0, "Wait for your account and organization to finish loading before changing inventory.");
  }
  if (!keys.storageKey || !keys.scopeStorageKey || !keys.fingerprint) {
    throw new InventoryCycleCountApiError(0, "Cycle-count retry protection is unavailable. Enable secure browser storage before changing inventory.");
  }

  let storedActive: z.infer<typeof GoRetryMarkerSchema> | null = null;
  let storedAction: string | null = null;
  try {
    storedActive = parseGoRetryMarker(localStorage.getItem(keys.scopeStorageKey));
    storedAction = parseGoRetryIntentId(localStorage.getItem(keys.storageKey));
  } catch {
    throw new InventoryCycleCountApiError(0, "A saved cycle-count retry marker is malformed or unavailable. Verify inventory before retrying.");
  }

  const memoryActive = activeGoRetryIntents.get(keys.scopeMemoryKey) ?? null;
  const memoryAction = goRetryIntents.get(keys.memoryKey) ?? null;
  if (storedActive && memoryActive && (storedActive.intentId !== memoryActive.intentId || storedActive.fingerprint !== memoryActive.fingerprint)) {
    throw new InventoryCycleCountApiError(0, "The saved cycle-count retry marker does not match this session. Verify inventory before retrying.");
  }
  if (storedAction && memoryAction && storedAction !== memoryAction) {
    throw new InventoryCycleCountApiError(0, "The saved cycle-count retry marker does not match this session. Verify inventory before retrying.");
  }
  const active = storedActive ?? memoryActive;
  const priorIntentId = storedAction ?? memoryAction;
  if (active && active.fingerprint !== keys.fingerprint) {
    throw new InventoryCycleCountApiError(0, "A Go cycle-count action is unresolved. Retry that exact action or verify inventory before starting another one.");
  }
  if (active && priorIntentId && active.intentId !== priorIntentId) {
    throw new InventoryCycleCountApiError(0, "The saved cycle-count retry markers do not match. Verify inventory before retrying.");
  }

  const intentId = active?.intentId ?? priorIntentId ?? crypto.randomUUID();
  const marker = { fingerprint: keys.fingerprint, intentId };
  try {
    localStorage.setItem(keys.scopeStorageKey, JSON.stringify(marker));
    const savedMarker = parseGoRetryMarker(localStorage.getItem(keys.scopeStorageKey));
    if (!savedMarker || savedMarker.fingerprint !== marker.fingerprint || savedMarker.intentId !== marker.intentId) {
      throw new Error("scope marker did not persist");
    }
    localStorage.setItem(keys.storageKey, intentId);
    if (parseGoRetryIntentId(localStorage.getItem(keys.storageKey)) !== intentId) {
      throw new Error("action marker did not persist");
    }
  } catch {
    throw new InventoryCycleCountApiError(0, "Cycle-count retry markers could not be saved. Enable browser storage before changing inventory.");
  }
  goRetryIntents.set(keys.memoryKey, intentId);
  activeGoRetryIntents.set(keys.scopeMemoryKey, marker);
  return intentId;
}

async function goRetryKeys(
  input: InventoryCycleCountAction,
  scope?: InventoryCycleCountRetryScope,
): Promise<{ memoryKey: string; storageKey: string | null; scopeMemoryKey: string | null; scopeStorageKey: string | null; fingerprint: string }> {
  const actorId = scope?.actorId.trim() ?? "";
  const organizationId = scope?.organizationId.trim() ?? "";
  if (!actorId || !organizationId) {
    return { memoryKey: "", storageKey: null, scopeMemoryKey: null, scopeStorageKey: null, fingerprint: "" };
  }
  const canonicalScope = { actorId, organizationId };
  const serializedAction = JSON.stringify({ input: canonicalize(input), ...canonicalScope });
  const scopeMemoryKey = `${goRetryPrefix}scope:${JSON.stringify(canonicalScope)}`;
  const memoryKey = `${goRetryPrefix}${serializedAction}`;
  try {
    const [fingerprint, scopeHash] = await Promise.all([
      digestHex(serializedAction),
      digestHex(JSON.stringify(canonicalScope)),
    ]);
    return {
      memoryKey,
      storageKey: `${goRetryPrefix}${fingerprint}`,
      scopeMemoryKey,
      scopeStorageKey: `${goRetryPrefix}scope:${scopeHash}`,
      fingerprint,
    };
  } catch {
    return { memoryKey, storageKey: null, scopeMemoryKey, scopeStorageKey: null, fingerprint: "" };
  }
}

async function clearStableGoCycleCountIntent(
  input: InventoryCycleCountAction,
  intentId: string,
  scope?: InventoryCycleCountRetryScope,
): Promise<void> {
  const keys = await goRetryKeys(input, scope);
  if (goRetryIntents.get(keys.memoryKey) === intentId) goRetryIntents.delete(keys.memoryKey);
  if (keys.scopeMemoryKey) {
    const active = activeGoRetryIntents.get(keys.scopeMemoryKey);
    if (active?.fingerprint === keys.fingerprint && active.intentId === intentId) activeGoRetryIntents.delete(keys.scopeMemoryKey);
  }
  if (!keys.storageKey || !keys.scopeStorageKey) return;
  try {
    if (parseGoRetryIntentId(localStorage.getItem(keys.storageKey)) === intentId) localStorage.removeItem(keys.storageKey);
    const active = parseGoRetryMarker(localStorage.getItem(keys.scopeStorageKey));
    if (active?.fingerprint === keys.fingerprint && active.intentId === intentId) localStorage.removeItem(keys.scopeStorageKey);
  } catch {
    // A completed or rejected attempt no longer needs its marker in this page.
  }
}

function parseGoRetryMarker(value: string | null): z.infer<typeof GoRetryMarkerSchema> | null {
  if (value === null) return null;
  const parsed = GoRetryMarkerSchema.safeParse(JSON.parse(value) as unknown);
  if (!parsed.success) throw new Error("invalid retry marker");
  return parsed.data;
}

function parseGoRetryIntentId(value: string | null): string | null {
  if (value === null) return null;
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw new Error("invalid retry intent");
  return parsed.data;
}

async function digestHex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonicalize(object[key])]));
  }
  return value;
}

export async function lookupInventoryBarcode(
  barcode: string,
  signal?: AbortSignal,
  useGoOverride?: boolean,
  organizationId?: string,
): Promise<{ sku: string; name: string } | null> {
  if (useGoOverride === false) {
    throw new InventoryCycleCountApiError(503, "Go barcode lookup is not enabled for this request.");
  }
  const body = await postInventory("/api/capabilities/execute", {
    capabilityId: "inventory.lookupByBarcode",
    input: { barcode },
  }, signal, organizationId);
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

async function postInventory(path: string, input: object, signal?: AbortSignal, organizationId?: string): Promise<{ response: Response; data: unknown }> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json", ...(organizationId ? { "X-Organization-ID": organizationId } : {}) },
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
