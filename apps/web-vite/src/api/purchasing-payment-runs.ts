import { z } from "zod";

const SafeMinorSchema = z.number().int().safe().nonnegative();
const TimestampSchema = z.string().datetime({ offset: true });

const PaymentRunLineSchema = z.object({
  billId: z.string().uuid(),
  billNumber: z.number().int().safe().positive(),
  vendorName: z.string().min(1),
  vendorRef: z.string().nullable(),
  amountMinor: SafeMinorSchema,
}).strict();

const PaymentRunSchema = z.object({
  id: z.string().uuid(),
  reference: z.string().min(1),
  currency: z.string().regex(/^[A-Z]{3}$/),
  totalMinor: SafeMinorSchema,
  status: z.enum(["draft", "instructed", "confirmed", "reversed", "cancelled"]),
  createdAt: TimestampSchema,
  instructedAt: TimestampSchema.nullable(),
  confirmedAt: TimestampSchema.nullable(),
  entryId: z.string().uuid().nullable(),
  lines: z.array(PaymentRunLineSchema),
}).strict();

const PaymentRunsResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ runs: z.array(PaymentRunSchema) }).strict(),
}).strict();
const PaymentRunBillSchema = z.object({
  id: z.string().uuid(),
  number: z.number().int().safe().positive(),
  vendorName: z.string().min(1),
  vendorRef: z.string().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  dueMinor: SafeMinorSchema,
}).strict();
const PaymentRunBillsResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ bills: z.array(PaymentRunBillSchema) }).strict(),
}).strict();
const SwitchboardSchema = z.object({
  catalog: z.array(z.object({ id: z.string().min(1) })),
  enabledModules: z.array(z.string().min(1)),
});

export type PurchasingPaymentRun = z.infer<typeof PaymentRunSchema>;
export type PurchasingPaymentRunBill = z.infer<typeof PaymentRunBillSchema>;
export type PurchasingPaymentRunAction =
  | { action: "create"; memo?: string; lines: Array<{ billId: string; amountMinor: number }> }
  | { action: "cancel" | "restore" | "instruct"; paymentRunId: string }
  | { action: "reverse"; paymentRunId: string; reason: string };
export type PaymentRunRetryScope = { actorId: string | null; organizationId: string | null };
export type PurchasingPaymentRunActionResult = { kind: "success" | "pending"; data: Record<string, unknown> };

const GO_PAYMENT_RUN_ATTEMPT_PREFIX = "chaste:purchasing:payment-runs:go:attempt:v1:";
const CreateActionSchema = z.object({ action: z.literal("create"), memo: z.string().max(500).optional(), lines: z.array(z.object({ billId: z.string().uuid(), amountMinor: z.number().int().safe().positive() }).strict()).min(1).max(100) }).strict();
const RunIDActionSchema = z.object({ action: z.enum(["cancel", "restore", "instruct"]), paymentRunId: z.string().uuid() }).strict();
const ReverseActionSchema = z.object({ action: z.literal("reverse"), paymentRunId: z.string().uuid(), reason: z.string().min(3).max(500) }).strict();
const PaymentRunActionSchema = z.discriminatedUnion("action", [CreateActionSchema, RunIDActionSchema, ReverseActionSchema]);
const PaymentRunAttemptSchema = z.object({ intentId: z.string().uuid(), fingerprint: z.string().length(64), action: PaymentRunActionSchema }).strict();
const PaymentRunActionOutputs = {
  create: z.object({ paymentRunId: z.string().uuid(), reference: z.string().min(1), currency: z.string().regex(/^[A-Z]{3}$/), totalMinor: SafeMinorSchema, billCount: z.number().int().safe().positive() }).strict(),
  cancel: z.object({ paymentRunId: z.string().uuid() }).strict(),
  restore: z.object({ paymentRunId: z.string().uuid() }).strict(),
  instruct: z.object({ paymentRunId: z.string().uuid(), reference: z.string().min(1), currency: z.string().regex(/^[A-Z]{3}$/), totalMinor: SafeMinorSchema, entryId: z.string().uuid(), billCount: z.number().int().safe().positive(), status: z.literal("instructed") }).strict(),
  reverse: z.object({ paymentRunId: z.string().uuid(), reversalEntryId: z.string().uuid(), status: z.literal("reversed") }).strict(),
} as const;

export class PurchasingPaymentRunsApiError extends Error {
  constructor(readonly status: number, message: string, readonly requestMayHaveReachedServer = false) {
    super(message);
    this.name = "PurchasingPaymentRunsApiError";
  }
}

export function goPurchasingPaymentRunsUseGo(): boolean {
  return typeof __GO_PURCHASING_PAYMENT_RUNS__ !== "undefined" && __GO_PURCHASING_PAYMENT_RUNS__;
}

export async function fetchPurchasingEnabled(signal?: AbortSignal): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch("/api/modules", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new PurchasingPaymentRunsApiError(0, "Could not check whether Purchasing is enabled.");
  }
  if (!response.ok) {
    throw new PurchasingPaymentRunsApiError(response.status, "Could not check whether Purchasing is enabled.");
  }
  const parsed = SwitchboardSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new PurchasingPaymentRunsApiError(response.status, "The module switchboard returned data in an unexpected format.");
  }
  const catalogIds = new Set(parsed.data.catalog.map((module) => module.id));
  if (!catalogIds.has("purchasing") || parsed.data.enabledModules.some((id) => !catalogIds.has(id))) {
    throw new PurchasingPaymentRunsApiError(response.status, "The module switchboard returned an invalid Purchasing configuration.");
  }
  return parsed.data.enabledModules.includes("purchasing");
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
}

async function errorMessage(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) return record.message;
    if (typeof record.error === "string" && record.error.trim()) return record.error;
    if (record.error && typeof record.error === "object" && "message" in record.error && typeof record.error.message === "string") {
      return record.error.message;
    }
  }
  if (response.status === 401) return "Your session has expired. Sign in again to view payment runs.";
  if (response.status === 403) return "Your account does not have permission to view supplier payment runs.";
  return "Could not load supplier payment runs. Check the service and try again.";
}

export async function fetchPurchasingPaymentRuns(signal?: AbortSignal): Promise<PurchasingPaymentRun[]> {
  const data = await executeRead("purchasing.listPaymentRuns", {}, PaymentRunsResponseSchema, "payment runs", signal);
  return data.runs;
}

export async function fetchPurchasingPaymentRunBills(signal?: AbortSignal): Promise<PurchasingPaymentRunBill[]> {
  const data = await executeRead("purchasing.listPaymentRunBills", {}, PaymentRunBillsResponseSchema, "eligible bills", signal);
  return data.bills;
}

async function executeRead<TData>(
  capabilityId: string,
  input: Record<string, unknown>,
  responseSchema: z.ZodType<{ ok: true; data: TData }>,
  label: string,
  signal?: AbortSignal,
): Promise<TData> {
  if (!goPurchasingPaymentRunsUseGo()) throw new PurchasingPaymentRunsApiError(503, "Go supplier payment runs are disabled. Enable CHASTE_GO_PURCHASING_PAYMENT_RUNS and the session capability route.");
  let response: Response;
  try {
    response = await fetch("/api/capabilities/execute", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ capabilityId, input, intentId: crypto.randomUUID() }),
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new PurchasingPaymentRunsApiError(0, timedOut ? `Loading ${label} took too long. Try again.` : `Could not reach Go while loading ${label}.`);
  }

  if (!response.ok) throw new PurchasingPaymentRunsApiError(response.status, await errorMessage(response));
  const parsed = responseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new PurchasingPaymentRunsApiError(response.status, `The Go purchasing service returned ${label} in an unexpected format.`);
  }
  return parsed.data.data;
}

export async function readPendingPaymentRunAction(scope: PaymentRunRetryScope): Promise<PurchasingPaymentRunAction | null> {
  const scoped = await paymentRunScope(scope);
  let raw: string | null;
  try { raw = window.localStorage.getItem(`${GO_PAYMENT_RUN_ATTEMPT_PREFIX}${scoped.scopeHash}`); }
  catch { throw new PurchasingPaymentRunsApiError(0, "Enable browser storage to check for an unresolved payment run action."); }
  if (raw === null) return null;
  return parsePaymentRunAttempt(raw).action;
}

export async function submitPurchasingPaymentRunAction(
  action: PurchasingPaymentRunAction,
  scope: PaymentRunRetryScope,
  signal?: AbortSignal,
): Promise<PurchasingPaymentRunActionResult> {
  if (!goPurchasingPaymentRunsUseGo()) throw new PurchasingPaymentRunsApiError(503, "Go supplier payment runs are disabled. Re-enable the Go selector before retrying this action.", true);
  const scoped = await paymentRunScope(scope);
  const attempt = await paymentRunAttempt(action, scoped.scopeHash);
  const capabilityId = paymentRunCapability(action);
  const { action: _action, ...input } = action;
  try {
    let response: Response;
    try {
      response = await fetch("/api/capabilities/execute", {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ capabilityId, input, intentId: attempt.intentId }),
        signal: requestSignal(signal),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      throw new PurchasingPaymentRunsApiError(0, timedOut ? "The payment run action timed out. Its result is uncertain; retry the exact action." : "The payment run action could not be confirmed. Retry the exact action.", true);
    }
    const body: unknown = await response.json().catch(() => null);
    if (response.status === 202) {
      const pending = z.object({ pendingApproval: z.literal(true), reason: z.string().optional(), error: z.string().optional() }).safeParse(body);
      if (!pending.success) throw new PurchasingPaymentRunsApiError(response.status, "Go returned an unexpected payment run approval response.", true);
      return { kind: "pending", data: { reason: pending.data.reason ?? pending.data.error ?? "This payment run action is waiting for approval." } };
    }
    if (!response.ok) {
      const mayHaveReachedServer = response.status === 404 || response.status >= 500 || response.status === 408 || response.status === 429;
      const failure = new PurchasingPaymentRunsApiError(response.status, await errorMessageFromBody(response.status, body), mayHaveReachedServer);
      if (!mayHaveReachedServer) await clearPaymentRunAttempt(attempt.storageKey);
      throw failure;
    }
    const parsed = z.object({ ok: z.literal(true), data: PaymentRunActionOutputs[action.action] }).strict().safeParse(body);
    if (response.status !== 200 || !parsed.success) throw new PurchasingPaymentRunsApiError(response.status, "Go returned an unexpected payment run action response.", true);
    await clearPaymentRunAttempt(attempt.storageKey);
    return { kind: "success", data: parsed.data.data };
  } catch (error) {
    if (error instanceof PurchasingPaymentRunsApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429 && !error.requestMayHaveReachedServer) {
      await clearPaymentRunAttempt(attempt.storageKey);
    }
    throw error;
  }
}

async function paymentRunScope(scope: PaymentRunRetryScope): Promise<{ scopeHash: string }> {
  const actorId = scope.actorId?.trim() ?? "";
  const organizationId = scope.organizationId?.trim() ?? "";
  if (!z.string().uuid().safeParse(actorId).success || !z.string().uuid().safeParse(organizationId).success) {
    throw new PurchasingPaymentRunsApiError(0, "Payment run actions need your account and organization details before they can be submitted.");
  }
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ actorId, organizationId })));
    return { scopeHash: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("") };
  } catch {
    throw new PurchasingPaymentRunsApiError(0, "Could not prepare a durable payment run retry. Check browser security settings.");
  }
}

async function paymentRunAttempt(action: PurchasingPaymentRunAction, scopeHash: string): Promise<{ storageKey: string; intentId: string }> {
  const storageKey = `${GO_PAYMENT_RUN_ATTEMPT_PREFIX}${scopeHash}`;
  const parsedAction = PaymentRunActionSchema.safeParse(action);
  if (!parsedAction.success) throw new PurchasingPaymentRunsApiError(400, "The payment run action does not match the Go service contract.");
  const fingerprint = await paymentRunFingerprint(parsedAction.data);
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new PurchasingPaymentRunsApiError(0, "Enable browser storage before changing a payment run so uncertain actions can be retried safely."); }
  if (raw !== null) {
    const stored = parsePaymentRunAttempt(raw);
    if (stored.fingerprint !== fingerprint) throw new PurchasingPaymentRunsApiError(0, "A previous payment run action is unresolved. Retry its exact details before starting another action.", true);
    return { storageKey, intentId: stored.intentId };
  }
  const attempt = { fingerprint, intentId: crypto.randomUUID(), action: parsedAction.data };
  const serialized = JSON.stringify(attempt);
  try {
    window.localStorage.setItem(storageKey, serialized);
    if (window.localStorage.getItem(storageKey) !== serialized) throw new Error("payment run retry did not persist");
  } catch {
    throw new PurchasingPaymentRunsApiError(0, "Enable browser storage before changing a payment run so uncertain actions can be retried safely.");
  }
  return { storageKey, intentId: attempt.intentId };
}

async function paymentRunFingerprint(action: PurchasingPaymentRunAction): Promise<string> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJSON(action)));
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  } catch {
    throw new PurchasingPaymentRunsApiError(0, "Could not prepare a durable payment run retry.");
  }
}

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJSON(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function parsePaymentRunAttempt(raw: string): z.infer<typeof PaymentRunAttemptSchema> {
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch { throw new PurchasingPaymentRunsApiError(0, "An unresolved payment run action marker is malformed. Contact an administrator.", true); }
  const parsed = PaymentRunAttemptSchema.safeParse(decoded);
  if (!parsed.success) throw new PurchasingPaymentRunsApiError(0, "An unresolved payment run action marker is malformed. Contact an administrator.", true);
  return parsed.data;
}

async function clearPaymentRunAttempt(storageKey: string): Promise<void> {
  try { window.localStorage.removeItem(storageKey); }
  catch { throw new PurchasingPaymentRunsApiError(0, "The payment run action completed, but its retry marker could not be cleared. Reload before another action.", true); }
}

function paymentRunCapability(action: PurchasingPaymentRunAction): string {
  switch (action.action) {
    case "create": return "purchasing.createPaymentRun";
    case "cancel": return "purchasing.cancelPaymentRunDraft";
    case "restore": return "purchasing.restorePaymentRunDraft";
    case "instruct": return "purchasing.instructPaymentRun";
    case "reverse": return "purchasing.reversePaymentRun";
  }
}

async function errorMessageFromBody(status: number, body: unknown): Promise<string> {
  const parsed = z.object({ error: z.union([z.string(), z.object({ message: z.string().optional() })]).optional(), message: z.string().optional(), reason: z.string().optional() }).safeParse(body);
  if (parsed.success) {
    if (typeof parsed.data.error === "string" && parsed.data.error.trim()) return parsed.data.error;
    if (parsed.data.error && typeof parsed.data.error === "object" && parsed.data.error.message) return parsed.data.error.message;
    if (parsed.data.message) return parsed.data.message;
    if (parsed.data.reason) return parsed.data.reason;
  }
  return status === 403 ? "Your account does not have permission to use payment runs." : "Go could not complete the payment run action.";
}
