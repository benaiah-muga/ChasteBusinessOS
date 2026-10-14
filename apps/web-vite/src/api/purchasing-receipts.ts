import { z } from "zod";

const SafeIntegerSchema = z.number().int().safe();
const NonnegativeSafeIntegerSchema = SafeIntegerSchema.nonnegative();
const TimestampSchema = z.string().datetime({ offset: true });

const PurchaseOrderLineSchema = z.object({
  lineNumber: z.number().int().safe().positive(),
  description: z.string(),
  quantity: NonnegativeSafeIntegerSchema,
  acceptedThousandths: NonnegativeSafeIntegerSchema,
  rejectedThousandths: NonnegativeSafeIntegerSchema,
  returnedThousandths: NonnegativeSafeIntegerSchema,
  remainingThousandths: NonnegativeSafeIntegerSchema,
  unitPriceMinor: NonnegativeSafeIntegerSchema,
}).strict();

const PurchaseOrderSchema = z.object({
  id: z.string().uuid(),
  number: z.number().int().safe().positive(),
  vendorName: z.string(),
  status: z.string().min(1),
  memo: z.string().nullable(),
  orderedMinor: NonnegativeSafeIntegerSchema,
  lines: z.array(PurchaseOrderLineSchema),
}).strict();

const PurchaseOrdersResponseSchema = z.object({
  baseCurrency: z.string().regex(/^[A-Z]{3}$/),
  orders: z.array(PurchaseOrderSchema),
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

const OrderLineSchema = z.object({
  position: z.number().int().safe().positive(),
  description: z.string(),
  orderedThousandths: NonnegativeSafeIntegerSchema,
  acceptedThousandths: NonnegativeSafeIntegerSchema,
  rejectedThousandths: NonnegativeSafeIntegerSchema,
  returnedThousandths: NonnegativeSafeIntegerSchema,
  remainingThousandths: NonnegativeSafeIntegerSchema,
}).strict();

const ReceiptsOutputSchema = z.object({
  receipts: z.array(ReceiptSchema),
  orderLines: z.array(OrderLineSchema),
}).strict();

const ModuleSwitchboardSchema = z.object({
  catalog: z.array(z.object({ id: z.string().min(1) })),
  enabledModules: z.array(z.string().min(1)),
});

const GoCapabilityEnvelopeSchema = z.object({ ok: z.literal(true), data: z.unknown() }).strict();
const ErrorSchema = z.object({ error: z.string().optional(), message: z.string().optional() });

export type PurchasingReceipt = z.infer<typeof ReceiptSchema>;
export type PurchasingReceiptOrderLine = z.infer<typeof OrderLineSchema>;
export type PurchasingReceiptOrder = z.infer<typeof PurchaseOrderSchema>;

export class PurchasingReceiptsApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "PurchasingReceiptsApiError";
  }
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
}

function readError(status: number, body: unknown, context: string): string {
  const parsed = ErrorSchema.safeParse(body);
  if (parsed.success) {
    const message = parsed.data.message ?? parsed.data.error;
    if (message?.trim()) return message;
  }
  if (status === 401) return "Your session has expired. Sign in again to view purchase receipts.";
  if (status === 403) return "Your account does not have permission to view purchase receipts.";
  return `Could not load ${context}. Check the service and try again.`;
}

function organizationHeaders(organizationId: string | null | undefined): Record<string, string> {
  const normalized = organizationId?.trim();
  if (!normalized || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new PurchasingReceiptsApiError(0, "Wait for the active organization to finish loading before viewing receipts.");
  }
  return { "X-Organization-ID": normalized };
}

async function fetchJson(path: string, init: RequestInit, organizationId: string | null | undefined, signal?: AbortSignal): Promise<{ response: Response; body: unknown }> {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(organizationHeaders(organizationId))) headers.set(key, value);
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, credentials: "same-origin", cache: "no-store", signal: requestSignal(signal) });
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new PurchasingReceiptsApiError(0, timedOut
      ? "The purchasing service took too long to respond. Try again."
      : "Could not reach the purchasing service. Check your connection and try again.");
  }
  return { response, body: await response.json().catch(() => null) };
}

async function executePurchasingRead(
  capabilityId: "purchasing.listWorkspace" | "purchasing.listReceipts",
  input: Record<string, unknown>,
  context: string,
  organizationId: string | null | undefined,
  signal?: AbortSignal,
): Promise<unknown> {
  const { response, body } = await fetchJson("/api/capabilities/execute", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ capabilityId, input, intentId: crypto.randomUUID() }),
  }, organizationId, signal);
  if (!response.ok) {
    throw new PurchasingReceiptsApiError(response.status, readError(response.status, body, context));
  }
  const envelope = GoCapabilityEnvelopeSchema.safeParse(body);
  if (response.status !== 200 || !envelope.success) {
    throw new PurchasingReceiptsApiError(response.status, `The Go Purchasing service returned ${context} in an unexpected format.`);
  }
  return envelope.data.data;
}

export async function fetchPurchasingReceiptsEnabled(organizationId: string | null | undefined, signal?: AbortSignal): Promise<boolean> {
  const { response, body } = await fetchJson("/api/modules", {
    headers: { accept: "application/json" },
  }, organizationId, signal);
  if (!response.ok) {
    throw new PurchasingReceiptsApiError(response.status, readError(response.status, body, "the Purchasing module status"));
  }
  const parsed = ModuleSwitchboardSchema.safeParse(body);
  if (!parsed.success) {
    throw new PurchasingReceiptsApiError(response.status, "The module switchboard returned data in an unexpected format.");
  }
  const catalogIds = new Set(parsed.data.catalog.map(({ id }) => id));
  if (!catalogIds.has("purchasing") || parsed.data.enabledModules.some((id) => !catalogIds.has(id))) {
    throw new PurchasingReceiptsApiError(response.status, "The module switchboard returned an invalid Purchasing configuration.");
  }
  return parsed.data.enabledModules.includes("purchasing");
}

export async function fetchPurchasingOrders(organizationId: string | null | undefined, signal?: AbortSignal): Promise<{ baseCurrency: string; orders: PurchasingReceiptOrder[] }> {
  const body = await executePurchasingRead("purchasing.listWorkspace", {}, "purchase orders", organizationId, signal);
  const parsed = PurchaseOrdersResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new PurchasingReceiptsApiError(200, "The Go Purchasing service returned purchase orders in an unexpected format.");
  }
  return parsed.data;
}

export async function fetchPurchaseOrderReceipts(poNumber: number, organizationId: string | null | undefined, signal?: AbortSignal): Promise<{
  receipts: PurchasingReceipt[];
  orderLines: PurchasingReceiptOrderLine[];
}> {
  if (!Number.isSafeInteger(poNumber) || poNumber <= 0) {
    throw new PurchasingReceiptsApiError(400, "Choose a valid purchase order to view receipt history.");
  }
  const body = await executePurchasingRead("purchasing.listReceipts", { poNumber }, "receipt history", organizationId, signal);
  const parsed = ReceiptsOutputSchema.safeParse(body);
  if (!parsed.success) {
    throw new PurchasingReceiptsApiError(200, "The Go Purchasing service returned receipt history in an unexpected format.");
  }
  return parsed.data;
}
