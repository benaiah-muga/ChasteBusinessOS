import { z } from "zod";

const TimestampSchema = z.string().datetime({ offset: true });
const SafeIntegerSchema = z.number().int().safe();
const NonnegativeSafeIntegerSchema = SafeIntegerSchema.nonnegative();
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);

const VendorSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().nullable(),
  paymentTermDays: SafeIntegerSchema.nullable(),
  deactivatedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  // The legacy route returns whole vendor rows, so a later column must not
  // blank the page out; every field this page reads is still validated.
}).passthrough();

const PurchaseOrderLineSchema = z.object({
  lineNumber: z.number().int().safe().positive(),
  description: z.string(),
  quantity: NonnegativeSafeIntegerSchema,
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

const BillSchema = z.object({
  id: z.string().uuid(),
  number: z.number().int().safe().positive(),
  vendorName: z.string(),
  vendorRef: z.string().nullable(),
  memo: z.string().nullable(),
  totalMinor: SafeIntegerSchema,
  currency: CurrencySchema,
  paidMinor: SafeIntegerSchema,
  creditedMinor: SafeIntegerSchema,
  status: z.string().min(1),
  dueMinor: SafeIntegerSchema,
  createdAt: TimestampSchema,
}).strict();

const AgingBucketsSchema = z.object({
  current: SafeIntegerSchema,
  d30: SafeIntegerSchema,
  d60: SafeIntegerSchema,
  d90plus: SafeIntegerSchema,
  totalOutstanding: SafeIntegerSchema,
}).strict();

const PriceHistoryRowSchema = z.object({
  vendorName: z.string(),
  itemSku: z.string().nullable(),
  itemDescription: z.string(),
  unitPriceMinor: SafeIntegerSchema,
  orderedAt: TimestampSchema.nullable(),
}).strict();

const SupplierPerformanceRowSchema = z.object({
  vendorId: z.string().min(1),
  vendorName: z.string(),
  orders: NonnegativeSafeIntegerSchema,
  avgLeadTimeDays: z.number().finite().nullable(),
  onTimeRate: SafeIntegerSchema.nullable(),
  fillRate: SafeIntegerSchema.nullable(),
  backorderedOrders: NonnegativeSafeIntegerSchema,
}).strict();

const SupplierStatementRowSchema = z.object({
  date: TimestampSchema,
  kind: z.string(),
  ref: z.string(),
  amountMinor: SafeIntegerSchema,
  balanceMinor: SafeIntegerSchema,
}).strict();

const SupplierStatementSchema = z.object({
  closingBalanceMinor: SafeIntegerSchema,
  rows: z.array(SupplierStatementRowSchema),
}).strict();

const RfqSchema = z.object({
  id: z.string().min(1),
  vendorName: z.string(),
  status: z.string().min(1),
  quoteAmountMinor: SafeIntegerSchema.nullable(),
  quoteLeadTimeDays: SafeIntegerSchema.nullable(),
  quoteNotes: z.string().nullable(),
}).strict();

const PurchaseRequestSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  justification: z.string(),
  estimatedAmountMinor: SafeIntegerSchema.nullable(),
  status: z.string().min(1),
  decisionReason: z.string().nullable(),
  createdAt: TimestampSchema,
  rfqs: z.array(RfqSchema),
}).strict();

const PurchasingWorkspaceSchema = z.object({
  baseCurrency: CurrencySchema,
  vendors: z.array(VendorSchema),
  orders: z.array(PurchaseOrderSchema),
  bills: z.array(BillSchema),
  apAging: z.object({ buckets: AgingBucketsSchema.optional() }).passthrough().optional(),
  priceHistory: z.object({ rows: z.array(PriceHistoryRowSchema) }).strict().optional(),
  supplierPerformance: z.object({ vendors: z.array(SupplierPerformanceRowSchema) }).strict().optional(),
  requests: z.array(PurchaseRequestSchema).default([]),
}).strict();

const ProductSchema = z.object({
  sku: z.string().min(1),
  name: z.string(),
  avgUnitCostMinor: SafeIntegerSchema.nullable().optional(),
  // Inventory items travel with kind, unit label, stock levels and pricing the
  // purchase form never reads; only the three fields above are bound.
}).passthrough();

const TaxCodeSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  direction: z.string(),
  rateBasisPoints: SafeIntegerSchema,
  priceIncludesTax: z.boolean(),
  active: z.boolean(),
}).strict();

const SwitchboardSchema = z.object({
  catalog: z.array(z.object({ id: z.string().min(1) })),
  enabledModules: z.array(z.string().min(1)),
});

const ErrorSchema = z.object({ error: z.string().optional(), message: z.string().optional() });

const CreateVendorSchema = z.object({
  action: z.literal("createVendor"),
  name: z.string().min(1),
  email: z.string().min(1).optional(),
}).strict();

const PurchaseOrderLineInputSchema = z.object({
  description: z.string().min(1),
  quantity: SafeIntegerSchema,
  unitPriceMinor: SafeIntegerSchema,
  sku: z.string().min(1).optional(),
}).strict();

const CreatePurchaseOrderSchema = z.object({
  action: z.literal("createPurchaseOrder"),
  vendorId: z.string().min(1),
  memo: z.string().optional(),
  lines: z.array(PurchaseOrderLineInputSchema).min(1),
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

const ReturnGoodsSchema = z.object({
  action: z.literal("returnGoods"),
  poNumber: z.number().int().safe().positive(),
  receiptNumber: z.number().int().safe().positive().optional(),
  lines: z.array(z.object({
    lineNumber: z.number().int().safe().positive(),
    quantity: SafeIntegerSchema,
    reason: z.string(),
  }).strict()).min(1),
}).strict();

const ClosePurchaseOrderSchema = z.object({
  action: z.literal("closePurchaseOrder"),
  poNumber: z.number().int().safe().positive(),
}).strict();

const CreateBillSchema = z.object({
  action: z.literal("createBill"),
  vendorId: z.string().min(1),
  vendorRef: z.string().optional(),
  memo: z.string().optional(),
  poNumber: z.number().int().safe().positive().optional(),
  lines: z.array(z.object({
    description: z.string().min(1),
    quantity: SafeIntegerSchema,
    unitPriceMinor: SafeIntegerSchema,
    taxCodeId: z.string().min(1).optional(),
    poLineNumber: z.number().int().safe().positive().optional(),
  }).strict()).min(1),
}).strict();

const PayBillSchema = z.object({
  action: z.literal("payBill"),
  billNumber: z.number().int().safe().positive(),
  amountMinor: SafeIntegerSchema,
  method: z.enum(["cash", "bank_transfer", "card"]).optional(),
}).strict();

const BillCreditNoteSchema = z.object({
  action: z.literal("billCreditNote"),
  billId: z.string().min(1),
  amountMinor: SafeIntegerSchema,
  reason: z.string().min(1),
}).strict();

const CreatePurchaseRequestSchema = z.object({
  action: z.literal("createPurchaseRequest"),
  title: z.string().min(1),
  justification: z.string().min(1),
  estimatedAmountMinor: SafeIntegerSchema.optional(),
}).strict();

const DecidePurchaseRequestSchema = z.object({
  action: z.literal("decidePurchaseRequest"),
  requestId: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
  reason: z.string().optional(),
}).strict();

const CreateRfqSchema = z.object({
  action: z.literal("createRfq"),
  requestId: z.string().min(1),
  vendorIds: z.array(z.string().min(1)).min(1),
}).strict();

const RecordQuoteSchema = z.object({
  action: z.literal("recordQuote"),
  rfqId: z.string().min(1),
  amountMinor: SafeIntegerSchema,
  leadTimeDays: SafeIntegerSchema.optional(),
  notes: z.string().optional(),
}).strict();

const SelectWinningQuoteSchema = z.object({
  action: z.literal("selectWinningQuote"),
  rfqId: z.string().min(1),
}).strict();

const PriceHistorySchema = z.object({
  action: z.literal("priceHistory"),
  sku: z.string().min(1).optional(),
}).strict();

const SupplierStatementActionSchema = z.object({
  action: z.literal("supplierStatement"),
  vendorId: z.string().min(1),
}).strict();

const PurchasingActionSchema = z.discriminatedUnion("action", [
  CreateVendorSchema,
  CreatePurchaseOrderSchema,
  ReceiveGoodsSchema,
  ReturnGoodsSchema,
  ClosePurchaseOrderSchema,
  CreateBillSchema,
  PayBillSchema,
  BillCreditNoteSchema,
  CreatePurchaseRequestSchema,
  DecidePurchaseRequestSchema,
  CreateRfqSchema,
  RecordQuoteSchema,
  SelectWinningQuoteSchema,
  PriceHistorySchema,
  SupplierStatementActionSchema,
]);

const SuccessEnvelopeSchema = z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) }).strict();
/**
 * Not strict: the governed executor may park an action without a reason, and
 * the legacy route echoes its own error field, so this envelope must keep
 * whatever the kernel actually sent.
 */
const PendingEnvelopeSchema = z.object({
  ok: z.literal(false).optional(),
  pendingApproval: z.literal(true),
  reason: z.string().optional(),
  error: z.string().optional(),
});

const ReceiveGoodsOutputSchema = z.object({
  received: z.literal(true),
  fullyReceived: z.boolean(),
  receiptNumber: z.number().int().safe().positive(),
}).strict();

const ClosePurchaseOrderOutputSchema = z.object({
  closed: z.literal(true),
  backordered: z.boolean(),
  shortThousandths: z.number().int().safe().nonnegative(),
}).strict();

const BillCreditNoteOutputSchema = z.object({
  entryId: z.string().min(1),
  creditedMinor: z.number().int().safe(),
  billBalanceMinor: z.number().int().safe(),
}).strict();

const PriceHistoryOutputSchema = z.object({ rows: z.array(PriceHistoryRowSchema) }).strict();
/** Writes whose result the page does not read still have to come back as an object. */
const OpaqueOutputSchema = z.object({}).passthrough();

export type PurchasingVendor = z.infer<typeof VendorSchema>;
export type PurchasingOrder = z.infer<typeof PurchaseOrderSchema>;
export type PurchasingBill = z.infer<typeof BillSchema>;
export type PurchasingAgingBuckets = z.infer<typeof AgingBucketsSchema>;
export type PurchasingRequest = z.infer<typeof PurchaseRequestSchema>;
export type PurchasingRfq = z.infer<typeof RfqSchema>;
export type PurchasingPriceHistoryRow = z.infer<typeof PriceHistoryRowSchema>;
export type PurchasingSupplierPerformance = z.infer<typeof SupplierPerformanceRowSchema>;
export type PurchasingSupplierStatement = z.infer<typeof SupplierStatementSchema>;
export type PurchasingProduct = z.infer<typeof ProductSchema>;
export type PurchasingTaxCode = z.infer<typeof TaxCodeSchema>;
export type PurchasingWorkspace = z.infer<typeof PurchasingWorkspaceSchema>;
export type PurchasingAction = z.infer<typeof PurchasingActionSchema>;
export type PurchasingReceiveGoodsResult = z.infer<typeof ReceiveGoodsOutputSchema>;

export type PurchasingActionOutcome<T = Record<string, unknown>> =
  | { kind: "completed"; data: T }
  | { kind: "pending"; reason: string };

export class PurchasingApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "PurchasingApiError";
  }
}

function requestSignal(signal?: AbortSignal, timeoutMs = 15_000): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}

function readError(status: number, body: unknown, context: string): string {
  const parsed = ErrorSchema.safeParse(body);
  if (parsed.success) {
    const message = parsed.data.message ?? parsed.data.error;
    if (message?.trim()) return message;
  }
  if (status === 401) return "Your session has expired. Sign in again to open Purchasing.";
  if (status === 403) return "Your account does not have permission to use Purchasing.";
  if (status === 428) return "Finish setting up your workspace before using Purchasing.";
  return `Could not ${context}. Check the service and try again.`;
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
    throw new PurchasingApiError(0, timedOut
      ? "The Purchasing service took too long to respond. Check the record before trying again."
      : "Could not reach the Purchasing service. Check your connection and try again.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok && !(allowNotFound && response.status === 404)) {
    throw new PurchasingApiError(response.status, readError(response.status, body, activity));
  }
  return { response, body };
}

async function getValidated<T>(path: string, schema: z.ZodType<T>, subject: string, signal?: AbortSignal): Promise<T> {
  const { body } = await request(path, { headers: { accept: "application/json" } }, `load ${subject}`, signal);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new PurchasingApiError(200, `The Purchasing service returned ${subject} in an unexpected format.`);
  return parsed.data;
}

export async function fetchPurchasingEnabled(signal?: AbortSignal): Promise<boolean> {
  const switchboard = await getValidated("/api/modules", SwitchboardSchema, "the Purchasing module status", signal);
  const catalogIds = new Set(switchboard.catalog.map((module) => module.id));
  if (!catalogIds.has("purchasing") || switchboard.enabledModules.some((id) => !catalogIds.has(id))) {
    throw new PurchasingApiError(200, "The module switchboard returned an invalid Purchasing configuration.");
  }
  return switchboard.enabledModules.includes("purchasing");
}

export async function fetchPurchasingWorkspace(signal?: AbortSignal): Promise<PurchasingWorkspace> {
  return getValidated("/api/purchasing", PurchasingWorkspaceSchema, "the purchasing workspace", signal);
}

export async function fetchPurchasingProducts(signal?: AbortSignal): Promise<PurchasingProduct[]> {
  const report = await getValidated(
    "/api/inventory",
    z.object({ items: z.array(ProductSchema) }).passthrough(),
    "stocked products",
    signal,
  );
  return report.items;
}

export async function fetchPurchasingInputTaxCodes(signal?: AbortSignal): Promise<PurchasingTaxCode[]> {
  const tax = await getValidated(
    "/api/accounting/tax",
    z.object({ codes: z.array(TaxCodeSchema) }).passthrough(),
    "input tax codes",
    signal,
  );
  return tax.codes.filter((code) => code.active && code.direction === "input");
}

/**
 * One governed seam for every /api/purchasing POST. A 202 stays `pending` with
 * its reason so the page can surface the approval instead of reporting a write
 * that never happened.
 */
async function submit<T>(
  action: PurchasingAction,
  output: z.ZodType<T>,
  activity: string,
  signal?: AbortSignal,
): Promise<PurchasingActionOutcome<T>> {
  const parsedAction = PurchasingActionSchema.safeParse(action);
  if (!parsedAction.success) throw new PurchasingApiError(0, "Check the purchasing details and try again.");

  const { response, body } = await request("/api/purchasing", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ ...parsedAction.data, intentId: crypto.randomUUID() }),
  }, activity, signal);

  if (response.status === 202) {
    const pending = PendingEnvelopeSchema.safeParse(body);
    if (!pending.success) throw new PurchasingApiError(202, "The Purchasing service returned an unexpected approval response.");
    return { kind: "pending", reason: pending.data.reason ?? pending.data.error ?? "This action is waiting for approval." };
  }

  const envelope = SuccessEnvelopeSchema.safeParse(body);
  if (!envelope.success) throw new PurchasingApiError(response.status, `The Purchasing service returned an unexpected result: could not ${activity}.`);
  const parsedOutput = output.safeParse(envelope.data.data);
  if (!parsedOutput.success) throw new PurchasingApiError(response.status, `The Purchasing service returned an unexpected result: could not ${activity}.`);
  return { kind: "completed", data: parsedOutput.data };
}

export async function createPurchasingVendor(
  action: z.infer<typeof CreateVendorSchema>,
  signal?: AbortSignal,
): Promise<PurchasingActionOutcome> {
  const parsedAction = CreateVendorSchema.safeParse(action);
  if (!parsedAction.success) throw new PurchasingApiError(0, "Check the purchasing details and try again.");
  const useGo = typeof __GO_PURCHASING_VENDOR_SLICE__ !== "undefined" && __GO_PURCHASING_VENDOR_SLICE__;
  if (!useGo) return submit(parsedAction.data, OpaqueOutputSchema, "adding the vendor", signal);

  const { response, body } = await request("/api/capabilities/execute", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      capabilityId: "purchasing.createVendor",
      input: {
        name: parsedAction.data.name,
        ...(parsedAction.data.email === undefined ? {} : { email: parsedAction.data.email }),
      },
      intentId: crypto.randomUUID(),
    }),
  }, "adding the vendor", signal, true);

  // The Vite and Go proxy flags are paired and default off. A missing Go route
  // leaves the established purchasing POST as the compatible owner.
  if (response.status === 404) return submit(parsedAction.data, OpaqueOutputSchema, "adding the vendor", signal);
  if (response.status === 202) {
    const pending = PendingEnvelopeSchema.safeParse(body);
    if (!pending.success) throw new PurchasingApiError(202, "The Purchasing service returned an unexpected approval response.");
    return { kind: "pending", reason: pending.data.reason ?? pending.data.error ?? "This action is waiting for approval." };
  }
  const envelope = SuccessEnvelopeSchema.safeParse(body);
  if (!envelope.success) throw new PurchasingApiError(response.status, "The Purchasing service returned an unexpected result: could not add the vendor.");
  const parsedOutput = OpaqueOutputSchema.safeParse(envelope.data.data);
  if (!parsedOutput.success) throw new PurchasingApiError(response.status, "The Purchasing service returned an unexpected result: could not add the vendor.");
  return { kind: "completed", data: parsedOutput.data };
}

export async function createPurchasingOrder(
  action: z.infer<typeof CreatePurchaseOrderSchema>,
  signal?: AbortSignal,
): Promise<PurchasingActionOutcome> {
  return submit(action, OpaqueOutputSchema, "raising the purchase order", signal);
}

export async function receivePurchasingGoods(
  action: z.infer<typeof ReceiveGoodsSchema>,
  signal?: AbortSignal,
): Promise<PurchasingActionOutcome<PurchasingReceiveGoodsResult>> {
  return submit(action, ReceiveGoodsOutputSchema, "recording the receipt", signal);
}

export async function returnPurchasingGoods(
  action: z.infer<typeof ReturnGoodsSchema>,
  signal?: AbortSignal,
): Promise<PurchasingActionOutcome> {
  return submit(action, OpaqueOutputSchema, "returning the goods", signal);
}

export async function closePurchasingOrder(
  action: z.infer<typeof ClosePurchaseOrderSchema>,
  signal?: AbortSignal,
): Promise<PurchasingActionOutcome<z.infer<typeof ClosePurchaseOrderOutputSchema>>> {
  return submit(action, ClosePurchaseOrderOutputSchema, "closing the purchase order", signal);
}

export async function createPurchasingBill(
  action: z.infer<typeof CreateBillSchema>,
  signal?: AbortSignal,
): Promise<PurchasingActionOutcome> {
  return submit(action, OpaqueOutputSchema, "recording the bill", signal);
}

export async function payPurchasingBill(
  action: z.infer<typeof PayBillSchema>,
  signal?: AbortSignal,
): Promise<PurchasingActionOutcome> {
  return submit(action, OpaqueOutputSchema, "paying the bill", signal);
}

export async function creditPurchasingBill(
  action: z.infer<typeof BillCreditNoteSchema>,
  signal?: AbortSignal,
): Promise<PurchasingActionOutcome<z.infer<typeof BillCreditNoteOutputSchema>>> {
  return submit(action, BillCreditNoteOutputSchema, "crediting the bill", signal);
}

export async function createPurchasingRequest(
  action: z.infer<typeof CreatePurchaseRequestSchema>,
  signal?: AbortSignal,
): Promise<PurchasingActionOutcome> {
  return submit(action, OpaqueOutputSchema, "raising the purchase request", signal);
}

export async function decidePurchasingRequest(
  action: z.infer<typeof DecidePurchaseRequestSchema>,
  signal?: AbortSignal,
): Promise<PurchasingActionOutcome> {
  return submit(action, OpaqueOutputSchema, "recording the decision", signal);
}

export async function createPurchasingRfq(
  action: z.infer<typeof CreateRfqSchema>,
  signal?: AbortSignal,
): Promise<PurchasingActionOutcome> {
  return submit(action, OpaqueOutputSchema, "sending the RFQs", signal);
}

export async function recordPurchasingQuote(
  action: z.infer<typeof RecordQuoteSchema>,
  signal?: AbortSignal,
): Promise<PurchasingActionOutcome> {
  return submit(action, OpaqueOutputSchema, "recording the quote", signal);
}

export async function selectPurchasingWinningQuote(
  action: z.infer<typeof SelectWinningQuoteSchema>,
  signal?: AbortSignal,
): Promise<PurchasingActionOutcome> {
  return submit(action, OpaqueOutputSchema, "awarding the quote", signal);
}

export async function fetchPurchasingPriceHistory(
  sku: string | undefined,
  signal?: AbortSignal,
): Promise<PurchasingPriceHistoryRow[]> {
  const action: z.infer<typeof PriceHistorySchema> = sku?.trim() ? { action: "priceHistory", sku: sku.trim() } : { action: "priceHistory" };
  const outcome = await submit(action, PriceHistoryOutputSchema, "loading price history", signal);
  return outcome.kind === "completed" ? outcome.data.rows : [];
}

export async function fetchPurchasingSupplierStatement(
  vendorId: string,
  signal?: AbortSignal,
): Promise<PurchasingSupplierStatement> {
  const outcome = await submit({ action: "supplierStatement", vendorId }, SupplierStatementSchema, "loading the supplier statement", signal);
  if (outcome.kind === "pending") return { closingBalanceMinor: 0, rows: [] };
  return outcome.data;
}
