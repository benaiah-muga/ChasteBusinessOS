import { z } from "zod";

const SafeIntegerSchema = z.number().int().safe();
const EntrySchema = z.object({
  id: z.string().uuid(),
  memo: z.string(),
  sourceType: z.string().nullable(),
  reversalOfId: z.string().uuid().nullable(),
  postedAt: z.string().datetime({ offset: true }),
  actorType: z.string().min(1),
  currency: z.string().regex(/^[A-Z]{3}$/),
  amountMinor: SafeIntegerSchema,
  debitMinor: SafeIntegerSchema,
}).strict();
const OverviewSchema = z.object({ entries: z.array(EntrySchema) }).passthrough();

const PostActionSchema = z.object({ action: z.literal("post"), memo: z.string().trim().min(3).max(300) }).strict();
const ReverseActionSchema = z.object({ action: z.literal("reverse"), entryId: z.string().uuid() }).strict();
const ActionSchema = z.discriminatedUnion("action", [PostActionSchema, ReverseActionSchema]);
const PostOutputSchema = z.object({
  posted: z.boolean(),
  entryId: z.string().uuid().nullable(),
  varianceMinor: SafeIntegerSchema,
  ledgerValueMinor: SafeIntegerSchema.nonnegative(),
  glBalanceMinor: SafeIntegerSchema,
}).strict().refine((result) => {
  if (result.ledgerValueMinor - result.glBalanceMinor !== result.varianceMinor) return false;
  return result.posted ? result.entryId !== null && result.varianceMinor !== 0 : result.entryId === null && result.varianceMinor === 0;
}, "The valuation result is inconsistent.");
const ReverseOutputSchema = z.object({ reversed: z.literal(true), reversalEntryId: z.string().uuid() }).strict();
const SuccessSchema = z.object({ ok: z.literal(true), data: z.unknown() }).strict();
const PendingSchema = z.object({ ok: z.literal(false), pendingApproval: z.literal(true), reason: z.string(), approvalId: z.string().optional() }).strict();
const AttemptSchema = z.object({ action: ActionSchema, fingerprint: z.string().min(1), intentId: z.string().uuid() }).strict();

export type InventoryValuationEntry = z.infer<typeof EntrySchema>;
export type InventoryValuationAction = z.infer<typeof ActionSchema>;
export type InventoryValuationOutcome =
  | { kind: "completed"; data: z.infer<typeof PostOutputSchema> | z.infer<typeof ReverseOutputSchema> }
  | { kind: "pending"; reason: string };
export type InventoryValuationRetryScope = { actorId: string | null; organizationId: string | null };

const ATTEMPT_PREFIX = "chaste.inventory.valuation.attempt.v1:";

export class InventoryValuationApiError extends Error {
  constructor(readonly status: number, message: string, readonly requestMayHaveReachedServer = false) {
    super(message);
    this.name = "InventoryValuationApiError";
  }
}

function normalizeScope(scope: InventoryValuationRetryScope): { actorId: string; organizationId: string } {
  const actorId = scope.actorId?.trim();
  const organizationId = scope.organizationId?.trim();
  if (!actorId || !organizationId) {
    throw new InventoryValuationApiError(0, "Wait for your account and organization to finish loading before reconciling inventory value.");
  }
  return { actorId, organizationId };
}

async function scopeKey(scope: InventoryValuationRetryScope): Promise<string> {
  const normalized = normalizeScope(scope);
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(normalized));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
    return `${ATTEMPT_PREFIX}${hex}`;
  } catch {
    throw new InventoryValuationApiError(0, "Inventory valuation retry protection is unavailable. Check browser security settings before continuing.");
  }
}

function parseAttempt(raw: string | null): z.infer<typeof AttemptSchema> | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new InventoryValuationApiError(0, "A saved inventory valuation action could not be recovered safely. Check the journal before continuing.", true);
  }
  const parsed = AttemptSchema.safeParse(value);
  if (!parsed.success || parsed.data.fingerprint !== JSON.stringify(parsed.data.action)) {
    throw new InventoryValuationApiError(0, "A saved inventory valuation action could not be recovered safely. Check the journal before continuing.", true);
  }
  return parsed.data;
}

async function readAttempt(scope: InventoryValuationRetryScope): Promise<z.infer<typeof AttemptSchema> | null> {
  const key = await scopeKey(scope);
  try {
    return parseAttempt(window.localStorage.getItem(key));
  } catch (error) {
    if (error instanceof InventoryValuationApiError) throw error;
    throw new InventoryValuationApiError(0, "Enable browser storage to recover an unresolved inventory valuation action safely.", true);
  }
}

export async function readPendingInventoryValuationAction(scope: InventoryValuationRetryScope): Promise<InventoryValuationAction | null> {
  return (await readAttempt(scope))?.action ?? null;
}

async function reserveAttempt(action: InventoryValuationAction, scope: InventoryValuationRetryScope): Promise<{ key: string; attempt: z.infer<typeof AttemptSchema> }> {
  const key = await scopeKey(scope);
  const fingerprint = JSON.stringify(action);
  const lockManager = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!lockManager) {
    throw new InventoryValuationApiError(0, "This browser cannot safely reserve an inventory valuation action. Use a browser with Web Locks enabled.");
  }
  try {
    return await lockManager.request(key, { mode: "exclusive" }, () => {
      let stored: z.infer<typeof AttemptSchema> | null;
      try {
        stored = parseAttempt(window.localStorage.getItem(key));
      } catch (error) {
        if (error instanceof InventoryValuationApiError) throw error;
        throw new InventoryValuationApiError(0, "Enable browser storage before reconciling inventory value.");
      }
      if (stored && stored.fingerprint !== fingerprint) {
        throw new InventoryValuationApiError(0, "A previous inventory valuation result is unresolved. Retry that exact action before starting another.", true);
      }
      if (stored) return { key, attempt: stored };
      const attempt = { action, fingerprint, intentId: crypto.randomUUID() };
      try {
        window.localStorage.setItem(key, JSON.stringify(attempt));
        const persisted = parseAttempt(window.localStorage.getItem(key));
        if (!persisted || persisted.intentId !== attempt.intentId || persisted.fingerprint !== fingerprint) throw new Error("attempt did not persist");
        return { key, attempt: persisted };
      } catch {
        throw new InventoryValuationApiError(0, "Enable browser storage before reconciling inventory value so an uncertain result can be retried safely.");
      }
    });
  } catch (error) {
    if (error instanceof InventoryValuationApiError) throw error;
    throw new InventoryValuationApiError(0, "The browser could not reserve this inventory valuation action safely. Close other Inventory tabs and try again.", true);
  }
}

async function clearAttempt(key: string, intentId: string): Promise<void> {
  try {
    const stored = parseAttempt(window.localStorage.getItem(key));
    if (stored?.intentId === intentId) window.localStorage.removeItem(key);
  } catch {
    // A saved marker cannot change the server result, so resolution continues.
  }
}

export async function fetchInventoryValuationEntries(
  organizationId: string | null | undefined,
  signal?: AbortSignal,
): Promise<InventoryValuationEntry[]> {
  const orgId = organizationId?.trim();
  if (!orgId) throw new InventoryValuationApiError(0, "Wait for the active organization to finish loading before viewing valuation history.");
  const body = await execute("accounting.overview", {}, orgId, signal, "load valuation history");
  const envelope = SuccessSchema.safeParse(body);
  if (!envelope.success) throw new InventoryValuationApiError(200, "The Go Accounting service returned an unexpected valuation history response.");
  const parsed = OverviewSchema.safeParse(envelope.data.data);
  if (!parsed.success) throw new InventoryValuationApiError(200, "The Go Accounting service returned valuation history in an unexpected format.");
  return parsed.data.entries;
}

export async function submitInventoryValuationAction(
  action: InventoryValuationAction,
  scope: InventoryValuationRetryScope,
): Promise<InventoryValuationOutcome> {
  const normalizedAction = ActionSchema.safeParse(action);
  if (!normalizedAction.success) throw new InventoryValuationApiError(0, "Enter a valid inventory valuation action before continuing.");
  const { key, attempt } = await reserveAttempt(normalizedAction.data, scope);
  const capabilityId = attempt.action.action === "post" ? "inventory.postValuationSummary" : "inventory.reverseValuationSummary";
  const input = attempt.action.action === "post" ? { memo: attempt.action.memo } : { entryId: attempt.action.entryId };
  try {
    const body = await execute(capabilityId, input, normalizeScope(scope).organizationId, undefined, "submit inventory valuation", attempt.intentId);
    if (body && typeof body === "object" && "pendingApproval" in body && (body as { pendingApproval?: unknown }).pendingApproval === true) {
      const pending = PendingSchema.safeParse(body);
      if (!pending.success) throw new InventoryValuationApiError(202, "Go returned an unexpected inventory valuation approval response.", true);
      return { kind: "pending", reason: pending.data.reason };
    }
    const success = SuccessSchema.safeParse(body);
    if (!success.success) throw new InventoryValuationApiError(200, "Go returned an unexpected inventory valuation response.", true);
    const output = attempt.action.action === "post" ? PostOutputSchema.safeParse(success.data.data) : ReverseOutputSchema.safeParse(success.data.data);
    if (!output.success) throw new InventoryValuationApiError(200, "Go returned an inventory valuation result in an unexpected format.", true);
    await clearAttempt(key, attempt.intentId);
    return { kind: "completed", data: output.data };
  } catch (error) {
    if (error instanceof InventoryValuationApiError && [400, 401, 403, 422].includes(error.status) && !error.requestMayHaveReachedServer) {
      await clearAttempt(key, attempt.intentId);
    }
    throw error;
  }
}

async function execute(
  capabilityId: string,
  input: Record<string, unknown>,
  organizationId: string,
  signal: AbortSignal | undefined,
  activity: string,
  intentId: string = crypto.randomUUID(),
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch("/api/capabilities/execute", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json", "X-Organization-ID": organizationId },
      cache: "no-store",
      body: JSON.stringify({ capabilityId, input, intentId }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new InventoryValuationApiError(0, timedOut
      ? "The inventory valuation request timed out. Its result is uncertain. Retry the exact action or check the journal."
      : `Could not confirm whether Go completed ${activity}. Retry the exact action or check the journal.`, true);
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 202) return body;
  if (!response.ok) {
    const parsed = z.object({ error: z.string().optional(), message: z.string().optional() }).safeParse(body);
    const message = parsed.success ? parsed.data.message ?? parsed.data.error : undefined;
    const definitiveNoEffect = [400, 401, 403, 422].includes(response.status);
    throw new InventoryValuationApiError(response.status, message?.trim() || `Could not ${activity}. Check the service and try again.`, !definitiveNoEffect);
  }
  return body;
}
