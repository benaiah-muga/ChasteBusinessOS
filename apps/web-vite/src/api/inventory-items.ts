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
const AdjustmentAttemptSchema = z.object({
  action: AdjustStockSchema,
  fingerprint: z.string().min(1),
  intentId: z.string().uuid(),
}).strict();
const adjustmentAttemptPrefix = "chaste.inventory.adjust-stock.pending.v1:";

export type CreateInventoryItem = z.infer<typeof CreateItemSchema>;
export type AdjustInventoryStock = z.infer<typeof AdjustStockSchema>;
export type InventoryItemAction = CreateInventoryItem | AdjustInventoryStock;
export type InventoryItemActionResult = { kind: "completed" } | { kind: "pending"; reason: string };
export type InventoryAdjustmentRetryScope = { actorId: string | null; organizationId: string | null };

type InventoryAdjustmentAttempt = z.infer<typeof AdjustmentAttemptSchema> & { storageKey: string };

async function adjustmentAttemptStorageKey(scope: InventoryAdjustmentRetryScope): Promise<string> {
  const actorId = scope.actorId?.trim() ?? "";
  const organizationId = scope.organizationId?.trim() ?? "";
  if (!actorId || !organizationId) {
    throw new InventoryItemActionError(0, "Wait for your account and organization to finish loading before adjusting stock.");
  }
  try {
    const identity = JSON.stringify({ actorId, organizationId });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
    const hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
    return `${adjustmentAttemptPrefix}${hash}`;
  } catch {
    throw new InventoryItemActionError(0, "Stock adjustment retry protection is unavailable. Check browser security settings and try again.");
  }
}

function parseAdjustmentAttempt(raw: string | null): z.infer<typeof AdjustmentAttemptSchema> | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InventoryItemActionError(0, "A saved stock adjustment could not be recovered safely. Check stock history before starting another adjustment.");
  }
  const result = AdjustmentAttemptSchema.safeParse(parsed);
  if (!result.success) throw new InventoryItemActionError(0, "A saved stock adjustment could not be recovered safely. Check stock history before starting another adjustment.");
  if (result.data.fingerprint !== adjustmentFingerprint(result.data.action)) {
    throw new InventoryItemActionError(0, "A saved stock adjustment could not be recovered safely. Check stock history before starting another adjustment.");
  }
  return result.data;
}

function adjustmentFingerprint(action: AdjustInventoryStock): string {
  return JSON.stringify(action);
}

async function getOrCreateAdjustmentAttempt(
  action: AdjustInventoryStock,
  scope: InventoryAdjustmentRetryScope,
): Promise<InventoryAdjustmentAttempt> {
  const storageKey = await adjustmentAttemptStorageKey(scope);
  const fingerprint = adjustmentFingerprint(action);
  let stored: ReturnType<typeof parseAdjustmentAttempt>;
  try {
    stored = parseAdjustmentAttempt(window.localStorage.getItem(storageKey));
  } catch {
    throw new InventoryItemActionError(0, "Enable browser storage before adjusting stock so an uncertain action can be retried safely.");
  }
  if (stored && stored.fingerprint !== fingerprint) {
    throw new InventoryItemActionError(0, "A previous stock adjustment is unresolved. Retry that exact adjustment or check stock history before changing it.");
  }
  if (stored) return { ...stored, storageKey };

  const attempt = { action, fingerprint, intentId: crypto.randomUUID(), storageKey };
  try {
    window.localStorage.setItem(storageKey, JSON.stringify({ action, fingerprint, intentId: attempt.intentId }));
    const persisted = parseAdjustmentAttempt(window.localStorage.getItem(storageKey));
    if (!persisted || persisted.fingerprint !== fingerprint || persisted.intentId !== attempt.intentId) throw new Error("saved adjustment did not persist");
    return { ...persisted, storageKey };
  } catch {
    throw new InventoryItemActionError(0, "Enable browser storage before adjusting stock so an uncertain action can be retried safely.");
  }
}

async function clearAdjustmentAttempt(attempt: InventoryAdjustmentAttempt): Promise<void> {
  try {
    const stored = parseAdjustmentAttempt(window.localStorage.getItem(attempt.storageKey));
    if (stored?.intentId === attempt.intentId) window.localStorage.removeItem(attempt.storageKey);
  } catch {
    // A completed request remains safe to inspect if browser storage is unavailable.
  }
}

export async function getPendingInventoryAdjustment(
  scope: InventoryAdjustmentRetryScope,
): Promise<AdjustInventoryStock | null> {
  const storageKey = await adjustmentAttemptStorageKey(scope);
  try {
    return parseAdjustmentAttempt(window.localStorage.getItem(storageKey))?.action ?? null;
  } catch {
    throw new InventoryItemActionError(0, "Enable browser storage to recover the pending stock adjustment safely.");
  }
}

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
  retryScope?: InventoryAdjustmentRetryScope,
): Promise<InventoryItemActionResult> {
  const parsedAction = action.action === "createItem"
    ? CreateItemSchema.safeParse(action)
    : AdjustStockSchema.safeParse(action);
  if (!parsedAction.success) throw new InventoryItemActionError(0, "Check the item details and try again.");

  const useGo = typeof __GO_INVENTORY_ITEM_SLICE__ !== "undefined" && __GO_INVENTORY_ITEM_SLICE__;
  const attempt = useGo && parsedAction.data.action === "adjustStock"
    ? await getOrCreateAdjustmentAttempt(parsedAction.data, retryScope ?? { actorId: null, organizationId: null })
    : null;
  const intentId = attempt?.intentId ?? crypto.randomUUID();
  const request = inventoryItemActionRequest(parsedAction.data, intentId, useGo);

  let response: Response;
  try {
    const send = (url: string, body: Record<string, unknown>) => fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
    response = await send(request.url, request.body);
    if (attempt && response.status === 404) {
      response = await send("/api/inventory", { ...parsedAction.data, intentId: attempt.intentId });
    }
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
    if (attempt && response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
      await clearAdjustmentAttempt(attempt);
    }
    throw new InventoryItemActionError(response.status, error.success ? error.data.error : plainError.success ? plainError.data.error : "The inventory action could not be completed.");
  }

  const envelope = ActionResponseSchema.safeParse(body);
  if (!envelope.success) throw new InventoryItemActionError(response.status, "The inventory service returned an unexpected action response.");
  const output = action.action === "createItem"
    ? CreateItemOutputSchema.safeParse(envelope.data.data)
    : AdjustStockOutputSchema.safeParse(envelope.data.data);
  if (!output.success) throw new InventoryItemActionError(response.status, "The inventory service returned an unexpected action result.");
  if (attempt) await clearAdjustmentAttempt(attempt);
  return { kind: "completed" };
}

export class InventoryItemActionError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "InventoryItemActionError";
  }
}
