import { z } from "zod";

const TimestampSchema = z.string().datetime({ offset: true });
const SafeIntegerSchema = z.number().int().safe();
const MaxGoInteger = 2_147_483_647;
const GoIntegerSchema = SafeIntegerSchema.min(0).max(MaxGoInteger);
const PositiveGoIntegerSchema = GoIntegerSchema.positive();
const NonnegativeSafeIntegerSchema = GoIntegerSchema;

const ReceivingOrderLineSchema = z.object({
  lineNumber: z.number().int().safe().positive(),
  description: z.string(),
  quantity: NonnegativeSafeIntegerSchema,
  unitPriceMinor: NonnegativeSafeIntegerSchema,
}).strict();

const ReceivingOrderSchema = z.object({
  id: z.string().uuid(),
  number: z.number().int().safe().positive(),
  vendorName: z.string(),
  status: z.string().min(1),
  memo: z.string().nullable(),
  orderedMinor: NonnegativeSafeIntegerSchema,
  lines: z.array(ReceivingOrderLineSchema),
}).strict();

const ReceivingOrdersResponseSchema = z.object({
  baseCurrency: z.string().regex(/^[A-Z]{3}$/),
  orders: z.array(ReceivingOrderSchema),
});

const ReceiptLineSchema = z.object({
  position: z.number().int().safe().positive(),
  description: z.string(),
  acceptedThousandths: NonnegativeSafeIntegerSchema,
  rejectedThousandths: NonnegativeSafeIntegerSchema,
  returnedThousandths: NonnegativeSafeIntegerSchema,
  rejectionNote: z.string().nullable(),
}).strict();

const ReceiptSchema = z.object({
  number: z.number().int().safe().positive(),
  receivedAt: TimestampSchema,
  note: z.string().nullable(),
  lines: z.array(ReceiptLineSchema),
}).strict();

const OrderLineRollupSchema = z.object({
  position: z.number().int().safe().positive(),
  description: z.string(),
  orderedThousandths: NonnegativeSafeIntegerSchema,
  acceptedThousandths: NonnegativeSafeIntegerSchema,
  rejectedThousandths: NonnegativeSafeIntegerSchema,
  returnedThousandths: NonnegativeSafeIntegerSchema,
  remainingThousandths: NonnegativeSafeIntegerSchema,
}).strict();

const ReceiptDetailSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    receipts: z.array(ReceiptSchema),
    orderLines: z.array(OrderLineRollupSchema),
  }).strict(),
}).strict();

const ReceiveGoodsSchema = z.object({
  action: z.literal("receiveGoods"),
  poNumber: PositiveGoIntegerSchema,
  lines: z.array(z.object({
    lineNumber: PositiveGoIntegerSchema,
    quantity: GoIntegerSchema,
    rejected: GoIntegerSchema.optional(),
    rejectionNote: z.string().trim().min(1).max(500).optional(),
  }).strict()).min(1),
  overreceiptTolerancePct: GoIntegerSchema.max(10).optional(),
  authorityReason: z.string().trim().min(10).max(500).optional(),
  note: z.string().trim().min(1).max(500).optional(),
}).strict().superRefine((action, context) => {
  const totals = new Map<number, { quantity: number; rejected: number }>();
  action.lines.forEach((line, index) => {
    const total = totals.get(line.lineNumber) ?? { quantity: 0, rejected: 0 };
    total.quantity += line.quantity;
    total.rejected += line.rejected ?? 0;
    totals.set(line.lineNumber, total);
    if ((line.rejected ?? 0) > 0 && !line.rejectionNote?.trim()) {
      context.addIssue({ code: "custom", path: ["lines", index, "rejectionNote"], message: "Rejected goods need a reason." });
    }
  });
  for (const [lineNumber, total] of totals) {
    if (total.quantity > MaxGoInteger || total.rejected > MaxGoInteger) {
      context.addIssue({ code: "custom", path: ["lines"], message: `Totals for line ${lineNumber} exceed the supported quantity range.` });
    }
  }
  const tolerance = action.overreceiptTolerancePct ?? 0;
  if ((tolerance > 0) !== Boolean(action.authorityReason)) {
    context.addIssue({ code: "custom", path: ["authorityReason"], message: "Overreceipt tolerance and a 10 to 500 character authority reason must be provided together." });
  }
});

const ReceiveGoodsOutputSchema = z.object({
  received: z.literal(true),
  fullyReceived: z.boolean(),
  receiptNumber: PositiveGoIntegerSchema,
}).strict();

const SuccessEnvelopeSchema = z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) }).strict();
/**
 * Not strict: the governed executor may park an action without a reason and
 * the legacy route echoes its own error field, so whatever the kernel sent has
 * to survive parsing.
 */
const PendingEnvelopeSchema = z.object({
  ok: z.literal(false).optional(),
  pendingApproval: z.literal(true),
  reason: z.string().optional(),
  error: z.string().optional(),
});

const SwitchboardSchema = z.object({
  catalog: z.array(z.object({ id: z.string().min(1) })),
  enabledModules: z.array(z.string().min(1)),
});

const ErrorSchema = z.object({ error: z.string().optional(), message: z.string().optional() });

export type ReceivingOrder = z.infer<typeof ReceivingOrderSchema>;
export type ReceivingReceipt = z.infer<typeof ReceiptSchema>;
export type ReceivingOrderLineRollup = z.infer<typeof OrderLineRollupSchema>;
export type ReceivingDetail = { receipts: ReceivingReceipt[]; orderLines: ReceivingOrderLineRollup[] };
export type ReceiveGoodsAction = z.infer<typeof ReceiveGoodsSchema>;
export type ReceiveGoodsResult = z.infer<typeof ReceiveGoodsOutputSchema>;
export type ReceivingActionOutcome =
  | { kind: "completed"; data: ReceiveGoodsResult }
  | { kind: "pending"; reason: string };

export class ReceivingApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ReceivingApiError";
  }
}

function requestSignal(signal?: AbortSignal, timeoutMs = 15_000): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}

function readError(status: number, body: unknown, activity: string): string {
  const parsed = ErrorSchema.safeParse(body);
  if (parsed.success) {
    const message = parsed.data.message ?? parsed.data.error;
    if (message?.trim()) return message;
  }
  if (status === 401) return "Your session has expired. Sign in again to record a delivery.";
  if (status === 403) return "Your account does not have permission to record deliveries.";
  if (status === 428) return "Finish setting up your workspace before recording deliveries.";
  return `Could not ${activity}. Check the service and try again.`;
}

async function request(path: string, init: RequestInit, activity: string, signal?: AbortSignal, allowNotFound = false): Promise<{ response: Response; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      signal: requestSignal(signal, init.method === "POST" ? 20_000 : 15_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new ReceivingApiError(0, timedOut
      ? "The Purchasing service took too long to respond. Check the delivery note before trying again."
      : "Could not reach the Purchasing service. Check your connection and try again.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok && !(allowNotFound && response.status === 404)) throw new ReceivingApiError(response.status, readError(response.status, body, activity));
  return { response, body };
}

export async function fetchReceivingEnabled(signal?: AbortSignal): Promise<boolean> {
  const { body } = await request("/api/modules", { headers: { accept: "application/json" } }, "check whether Purchasing is on", signal);
  const parsed = SwitchboardSchema.safeParse(body);
  if (!parsed.success) throw new ReceivingApiError(200, "The module switchboard returned data in an unexpected format.");
  const catalogIds = new Set(parsed.data.catalog.map((module) => module.id));
  if (!catalogIds.has("purchasing") || parsed.data.enabledModules.some((id) => !catalogIds.has(id))) {
    throw new ReceivingApiError(200, "The module switchboard returned an invalid Purchasing configuration.");
  }
  return parsed.data.enabledModules.includes("purchasing");
}

export async function fetchReceivingOrders(signal?: AbortSignal): Promise<{ baseCurrency: string; orders: ReceivingOrder[] }> {
  const { body } = await request("/api/purchasing", {
    method: "GET",
    headers: { accept: "application/json" },
  }, "load purchase orders", signal);
  const parsed = ReceivingOrdersResponseSchema.safeParse(body);
  if (!parsed.success) throw new ReceivingApiError(200, "The Purchasing service returned purchase orders in an unexpected format.");
  return parsed.data;
}

export async function fetchReceivingDetail(poNumber: number, signal?: AbortSignal): Promise<ReceivingDetail> {
  const { body } = await request("/api/purchasing", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ action: "receiptDetail", poNumber }),
  }, "load receipt history", signal);
  const parsed = ReceiptDetailSchema.safeParse(body);
  if (!parsed.success) throw new ReceivingApiError(200, "The Purchasing service returned receipt history in an unexpected format.");
  return parsed.data.data;
}

export async function submitReceiveGoods(
  action: ReceiveGoodsAction,
  signal?: AbortSignal,
  retryScope?: { actorId: string | null; organizationId: string | null },
): Promise<ReceivingActionOutcome> {
  const parsedAction = ReceiveGoodsSchema.safeParse(action);
  if (!parsedAction.success) throw new ReceivingApiError(0, "Check what arrived on each line and try again.");

  const useGo = typeof __GO_PURCHASING_RECEIVE_GOODS__ !== "undefined" && __GO_PURCHASING_RECEIVE_GOODS__;
  if (!useGo) {
    const { response, body } = await request("/api/purchasing", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ ...parsedAction.data, intentId: crypto.randomUUID() }),
    }, "record the receipt", signal);
    return parseReceiveGoodsOutcome(response, body);
  }
  if (!retryScope?.actorId?.trim() || !retryScope.organizationId?.trim()) {
    throw new ReceivingApiError(0, "Wait for your account and organization to finish loading before recording a delivery.");
  }

  const scope = { actorId: retryScope.actorId.trim(), organizationId: retryScope.organizationId.trim() };
  const attempt = await createReceiveGoodsAttempt(parsedAction.data, scope);
  try {
    let { response, body } = await request("/api/capabilities/execute", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        capabilityId: "purchasing.receiveGoods",
        input: {
          poNumber: parsedAction.data.poNumber,
          lines: parsedAction.data.lines,
          ...(parsedAction.data.overreceiptTolerancePct === undefined ? {} : { overreceiptTolerancePct: parsedAction.data.overreceiptTolerancePct }),
          ...(parsedAction.data.authorityReason === undefined ? {} : { authorityReason: parsedAction.data.authorityReason }),
          ...(parsedAction.data.note === undefined ? {} : { note: parsedAction.data.note }),
        },
        intentId: attempt.intentId,
      }),
    }, "record the receipt", signal, true);

    if (response.status === 404) {
      ({ response, body } = await request("/api/purchasing", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ ...parsedAction.data, intentId: attempt.intentId }),
      }, "record the receipt", signal));
    }

    const outcome = parseReceiveGoodsOutcome(response, body);
    if (outcome.kind === "completed") clearReceiveGoodsAttempt(attempt);
    return outcome;
  } catch (error) {
    if (error instanceof ReceivingApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
      clearReceiveGoodsAttempt(attempt);
    }
    throw error;
  }
}

type ReceiveGoodsRetryScope = { actorId: string; organizationId: string };
type ReceiveGoodsAttempt = { storageKey: string; fingerprint: string; intentId: string };
const receiveGoodsActiveAttemptPrefix = "chaste.purchasing.receive-goods.active.v1:";

async function createReceiveGoodsAttempt(action: ReceiveGoodsAction, scope: ReceiveGoodsRetryScope): Promise<ReceiveGoodsAttempt> {
  let scopeDigest: string;
  let fingerprint: string;
  try {
    scopeDigest = await receiveGoodsDigest(JSON.stringify({ actorId: scope.actorId, organizationId: scope.organizationId }));
    fingerprint = await receiveGoodsDigest(JSON.stringify({ actorId: scope.actorId, organizationId: scope.organizationId, action }));
  } catch {
    throw new ReceivingApiError(0, "Receipt retry protection is unavailable. Check browser security settings and try again.");
  }

  const storageKey = `${receiveGoodsActiveAttemptPrefix}${scopeDigest}`;
  let stored: { fingerprint: string; intentId: string } | null;
  try {
    stored = parseReceiveGoodsAttempt(window.localStorage.getItem(storageKey));
  } catch {
    throw new ReceivingApiError(0, "Enable browser storage before recording a delivery so an uncertain receipt can be retried safely.");
  }
  if (stored && stored.fingerprint !== fingerprint) {
    throw new ReceivingApiError(0, "A previous receipt result is unresolved. Retry the exact receipt or check receipt history before changing it.");
  }
  if (stored) return { storageKey, fingerprint, intentId: stored.intentId };

  const attempt = { storageKey, fingerprint, intentId: crypto.randomUUID() };
  try {
    window.localStorage.setItem(storageKey, JSON.stringify({ fingerprint, intentId: attempt.intentId }));
    const persisted = parseReceiveGoodsAttempt(window.localStorage.getItem(storageKey));
    if (!persisted || persisted.fingerprint !== fingerprint) throw new Error("saved attempt did not persist");
    return { ...attempt, intentId: persisted.intentId };
  } catch {
    throw new ReceivingApiError(0, "Enable browser storage before recording a delivery so an uncertain receipt can be retried safely.");
  }
}

function parseReceiveGoodsAttempt(value: string | null): { fingerprint: string; intentId: string } | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("stored receipt attempt is invalid");
  const record = parsed as Record<string, unknown>;
  if (typeof record.fingerprint !== "string" || typeof record.intentId !== "string" || !record.intentId.trim()) {
    throw new Error("stored receipt attempt is incomplete");
  }
  return { fingerprint: record.fingerprint, intentId: record.intentId };
}

function clearReceiveGoodsAttempt(attempt: ReceiveGoodsAttempt): void {
  try {
    const current = parseReceiveGoodsAttempt(window.localStorage.getItem(attempt.storageKey));
    if (current?.intentId === attempt.intentId) window.localStorage.removeItem(attempt.storageKey);
  } catch {
    // Keep a corrupt entry fail-closed on the next attempt.
  }
}

async function receiveGoodsDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseReceiveGoodsOutcome(response: Response, body: unknown): ReceivingActionOutcome {
  if (response.status === 202) {
    const pending = PendingEnvelopeSchema.safeParse(body);
    if (!pending.success) throw new ReceivingApiError(202, "The Purchasing service returned an unexpected approval response.");
    return { kind: "pending", reason: pending.data.reason ?? pending.data.error ?? "This receiving action is gated; it completes once someone approves it." };
  }

  const envelope = SuccessEnvelopeSchema.safeParse(body);
  const output = ReceiveGoodsOutputSchema.safeParse(envelope.success ? envelope.data.data : body);
  if (!output.success) throw new ReceivingApiError(response.status, "The Purchasing service returned an unexpected receipt result.");
  return { kind: "completed", data: output.data };
}
