import { z } from "zod";

const TimestampSchema = z.string().datetime({ offset: true });
const SafeIntegerSchema = z.number().int().safe();
const NonnegativeSafeIntegerSchema = SafeIntegerSchema.nonnegative();

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
  poNumber: z.number().int().safe().positive(),
  lines: z.array(z.object({
    lineNumber: z.number().int().safe().positive(),
    quantity: SafeIntegerSchema,
    rejected: SafeIntegerSchema.optional(),
    rejectionNote: z.string().optional(),
  }).strict()).min(1),
  overreceiptTolerancePct: SafeIntegerSchema.optional(),
  authorityReason: z.string().optional(),
  note: z.string().optional(),
}).strict();

const ReceiveGoodsOutputSchema = z.object({
  received: z.literal(true),
  fullyReceived: z.boolean(),
  receiptNumber: z.number().int().safe().positive(),
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

async function request(path: string, init: RequestInit, activity: string, signal?: AbortSignal): Promise<{ response: Response; body: unknown }> {
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
  if (!response.ok) throw new ReceivingApiError(response.status, readError(response.status, body, activity));
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
): Promise<ReceivingActionOutcome> {
  const parsedAction = ReceiveGoodsSchema.safeParse(action);
  if (!parsedAction.success) throw new ReceivingApiError(0, "Check what arrived on each line and try again.");

  const { response, body } = await request("/api/purchasing", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ ...parsedAction.data, intentId: crypto.randomUUID() }),
  }, "record the receipt", signal);

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