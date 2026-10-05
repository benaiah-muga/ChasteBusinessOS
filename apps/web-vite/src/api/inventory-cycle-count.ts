import { z } from "zod";

const ActionResponseSchema = z.object({
  ok: z.literal(true),
  data: z.unknown(),
}).strict();

const CycleCountOutputSchemas = {
  createCycleCount: z.object({ countId: z.string().min(1), lineCount: z.number().int().nonnegative() }).passthrough(),
  recordCycleCounts: z.object({ recorded: z.number().int().nonnegative() }).passthrough(),
  postCycleCount: z.object({
    posted: z.boolean(),
    postedVariances: z.number().int().nonnegative(),
    netVarianceThousandths: z.number().int(),
  }).passthrough(),
  cancelCycleCount: z.object({ cancelled: z.boolean() }).passthrough(),
} satisfies Record<InventoryCycleCountAction["action"], z.ZodType>;

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
  useGoOverride?: boolean,
): Promise<InventoryCycleCountActionResult> {
  const intentId = await stableCycleCountIntent(input);
  const useGo = useGoOverride ?? (typeof __GO_INVENTORY_CYCLE_COUNT_WRITES__ !== "undefined" && __GO_INVENTORY_CYCLE_COUNT_WRITES__);
  try {
    const body = await submitCycleCountRequest(input, intentId, useGo, signal);
    if (body.response.status === 202) {
      if (!PendingResponseSchema.safeParse(body.data).success) {
        throw new InventoryCycleCountApiError(202, "The inventory service returned an unexpected approval response.");
      }
      return { kind: "pending" };
    }
    if (!body.response.ok) {
      throw new InventoryCycleCountApiError(body.response.status, errorMessage(body.data));
    }
    const parsed = ActionResponseSchema.safeParse(body.data);
    if (body.response.status !== 200 || !parsed.success || !CycleCountOutputSchemas[input.action].safeParse(parsed.data.data).success) {
      throw new InventoryCycleCountApiError(body.response.status, "The inventory service returned an unexpected action response.");
    }
    await clearStableCycleCountIntent(input);
    return { kind: "completed" };
  } catch (error) {
    if (error instanceof InventoryCycleCountApiError && error.status >= 400 && error.status < 500) {
      await clearStableCycleCountIntent(input);
    }
    throw error;
  }
}

export function inventoryCycleCountActionRequest(
  input: InventoryCycleCountAction,
  intentId: string,
  useGo: boolean,
): { url: string; body: Record<string, unknown> } {
  if (!useGo) return { url: "/api/inventory", body: { ...input, intentId } };
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

async function submitCycleCountRequest(
  input: InventoryCycleCountAction,
  intentId: string,
  useGo: boolean,
  signal?: AbortSignal,
): Promise<{ response: Response; data: unknown }> {
  const request = inventoryCycleCountActionRequest(input, intentId, useGo);
  const body = await postInventory(request.url, request.body, signal);
  if (useGo && body.response.status === 404) {
    return postInventory("/api/inventory", { ...input, intentId }, signal);
  }
  return body;
}

const stableIntents = new Map<string, string>();

async function stableCycleCountIntent(input: InventoryCycleCountAction): Promise<string> {
  const storageKey = await cycleCountAttemptStorageKey(input);
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored) return stored;
  } catch {
    // Continue with the in-memory attempt when browser storage is unavailable.
  }
  const cached = stableIntents.get(storageKey);
  if (cached) {
    try {
      localStorage.setItem(storageKey, cached);
    } catch {
      // Keep the in-memory attempt when browser storage remains unavailable.
    }
    return cached;
  }
  const intentId = crypto.randomUUID();
  stableIntents.set(storageKey, intentId);
  try {
    localStorage.setItem(storageKey, intentId);
  } catch {
    // The in-memory copy still keeps retries in this page on the same intent.
  }
  return intentId;
}

async function cycleCountAttemptStorageKey(input: InventoryCycleCountAction): Promise<string> {
  const canonicalInput = JSON.stringify(canonicalize(input));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalInput));
  const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `chaste.inventory.cycle-count.intent.v1:${fingerprint}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonicalize(object[key])]));
  }
  return value;
}

async function clearStableCycleCountIntent(input: InventoryCycleCountAction): Promise<void> {
  const storageKey = await cycleCountAttemptStorageKey(input);
  stableIntents.delete(storageKey);
  try {
    localStorage.removeItem(storageKey);
  } catch {
    // Storage may be unavailable; a completed attempt can still be followed in memory.
  }
}

export async function lookupInventoryBarcode(
  barcode: string,
  signal?: AbortSignal,
): Promise<{ sku: string; name: string } | null> {
  const body = await postInventory("/api/inventory", { action: "lookupByBarcode", barcode }, signal);
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

async function postInventory(path: string, input: object, signal?: AbortSignal): Promise<{ response: Response; data: unknown }> {
  let response: Response;
  try {
    response = await fetch(path, {
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
