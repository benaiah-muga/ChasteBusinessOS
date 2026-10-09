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

const GoCreateVendorSchema = CreateVendorSchema.extend({
  email: z.string().regex(/^[A-Za-z0-9_'+.-]*[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/).refine((value) => !value.startsWith(".") && !value.includes(".."), "Enter a valid email address.").optional(),
});

const PurchaseOrderLineInputSchema = z.object({
  description: z.string().min(1),
  quantity: SafeIntegerSchema.positive(),
  unitPriceMinor: NonnegativeSafeIntegerSchema,
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
  poNumber: z.number().int().safe().positive().max(2_147_483_647),
  receiptNumber: z.number().int().safe().positive().max(2_147_483_647).optional(),
  lines: z.array(z.object({
    lineNumber: z.number().int().safe().positive().max(2_147_483_647),
    quantity: z.number().int().safe().positive().max(2_147_483_647),
    reason: z.string().min(3).max(500),
  }).strict()).min(1),
}).strict().superRefine((action, context) => {
  const totals = new Map<number, number>();
  action.lines.forEach((line) => {
    const total = (totals.get(line.lineNumber) ?? 0) + line.quantity;
    if (total > 2_147_483_647) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "The total return quantity for each purchase order line must fit the database range." });
    }
    totals.set(line.lineNumber, total);
  });
});

const ClosePurchaseOrderSchema = z.object({
  action: z.literal("closePurchaseOrder"),
  poNumber: z.number().int().safe().positive().max(2_147_483_647),
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

const GoCreateBillSchema = CreateBillSchema.extend({
  poNumber: z.number().int().safe().positive().optional(),
  lines: z.array(z.object({
    description: z.string().min(1),
    quantity: SafeIntegerSchema.positive(),
    unitPriceMinor: NonnegativeSafeIntegerSchema,
    taxCodeId: z.string().uuid().optional(),
    poLineNumber: z.number().int().safe().positive().optional(),
  }).strict()).min(1),
});

const PayBillSchema = z.object({
  action: z.literal("payBill"),
  billNumber: z.number().int().safe().positive(),
  amountMinor: SafeIntegerSchema,
  method: z.enum(["cash", "bank_transfer", "card"]).optional(),
}).strict();

const GoPayBillSchema = PayBillSchema.extend({
  billNumber: z.number().int().safe().positive(),
  amountMinor: z.number().int().safe().positive().max(2_147_483_647),
});

const BillCreditNoteSchema = z.object({
  action: z.literal("billCreditNote"),
  billId: z.string().min(1),
  amountMinor: SafeIntegerSchema,
  reason: z.string().min(1),
}).strict();

const GoBillCreditNoteSchema = BillCreditNoteSchema.extend({
  billId: z.string().uuid(),
  amountMinor: SafeIntegerSchema.positive(),
  reason: z.string().min(3).max(500),
});

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

const GoCreatePurchaseRequestSchema = CreatePurchaseRequestSchema.extend({
  title: z.string().min(3).max(200),
  justification: z.string().min(10).max(4000),
  estimatedAmountMinor: NonnegativeSafeIntegerSchema.optional(),
});
const GoDecidePurchaseRequestSchema = DecidePurchaseRequestSchema.extend({ reason: z.string().max(1000).optional() });
const GoCreateRfqSchema = CreateRfqSchema.extend({ vendorIds: z.array(z.string().min(1)).min(1).max(10) });
const GoRecordQuoteSchema = RecordQuoteSchema.extend({
  amountMinor: SafeIntegerSchema.positive(),
  leadTimeDays: NonnegativeSafeIntegerSchema.optional(),
  notes: z.string().max(2000).optional(),
});

const GoCreatePurchaseRequestOutputSchema = z.object({ requestId: z.string().uuid() }).strict();
const GoDecidePurchaseRequestOutputSchema = z.object({ status: z.enum(["approved", "rejected"]) }).strict();
const GoCreateRfqOutputSchema = z.object({ rfqIds: z.array(z.string().uuid()).min(1).max(10) }).strict();
const GoRecordQuoteOutputSchema = z.object({ status: z.literal("quoted") }).strict();
const GoSelectWinningQuoteOutputSchema = z.object({
  poNumber: z.number().int().safe().positive().max(2_147_483_647),
  vendorId: z.string().uuid(),
  quoteAmountMinor: NonnegativeSafeIntegerSchema,
}).strict();

const PriceHistorySchema = z.object({
  action: z.literal("priceHistory"),
  sku: z.string().min(1).optional(),
}).strict();

const SupplierStatementActionSchema = z.object({
  action: z.literal("supplierStatement"),
  vendorId: z.string().uuid(),
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

const ReturnGoodsOutputSchema = z.object({
  returned: z.literal(true),
  lines: z.number().int().safe().nonnegative(),
}).strict();

const CreateVendorOutputSchema = z.object({
  vendorId: z.string().uuid(),
}).strict();

const CreateBillOutputSchema = z.object({
  billNumber: z.number().int().safe().positive().max(2_147_483_647),
  totalMinor: z.number().int().safe().nonnegative().max(2_147_483_647),
  entryId: z.string().uuid(),
}).strict();

const PayBillOutputSchema = z.object({
  paymentId: z.string().uuid(),
  entryId: z.string().uuid(),
  fullyPaid: z.boolean(),
}).strict();

const GoBillCreditNoteOutputSchema = z.object({
  entryId: z.string().uuid(),
  creditedMinor: z.number().int().safe().positive(),
  billBalanceMinor: z.number().int().safe().nonnegative(),
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
export type PurchasingPayBillAction = z.infer<typeof PayBillSchema>;

export type PurchasingActionOutcome<T = Record<string, unknown>> =
  | { kind: "completed"; data: T }
  | { kind: "pending"; reason: string };

export class PurchasingApiError extends Error {
  constructor(readonly status: number, message: string, readonly requestMayHaveReachedServer = false) {
    super(message);
    this.name = "PurchasingApiError";
  }
}

export function goPurchasingFinanceWritesUseGo(): boolean {
  return typeof __GO_PURCHASING_FINANCE_WRITES__ !== "undefined" && __GO_PURCHASING_FINANCE_WRITES__;
}

export function goPurchasingSupplierStatementReadsUseGo(): boolean {
  return typeof __GO_PURCHASING_SUPPLIER_STATEMENT_READS__ !== "undefined" && __GO_PURCHASING_SUPPLIER_STATEMENT_READS__;
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
      : "Could not reach the Purchasing service. Check your connection and try again.", true);
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok && !(allowNotFound && response.status === 404)) {
    throw new PurchasingApiError(response.status, readError(response.status, body, activity), true);
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
    if (!pending.success) throw new PurchasingApiError(202, "The Purchasing service returned an unexpected approval response.", true);
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
  retryScope?: { actorId: string | null; organizationId: string | null },
): Promise<PurchasingActionOutcome> {
  const parsedAction = CreateVendorSchema.safeParse(action);
  if (!parsedAction.success) throw new PurchasingApiError(0, "Check the purchasing details and try again.");
  const useGo = (typeof __GO_PURCHASING_VENDOR_SLICE__ !== "undefined" && __GO_PURCHASING_VENDOR_SLICE__) || (typeof __GO_PURCHASING_FINANCE_WRITES__ !== "undefined" && __GO_PURCHASING_FINANCE_WRITES__);
  if (!useGo) return submit(parsedAction.data, OpaqueOutputSchema, "adding the vendor", signal);
  const goAction = GoCreateVendorSchema.safeParse(parsedAction.data);
  if (!goAction.success) throw new PurchasingApiError(0, "Enter a valid vendor name and email address before adding the vendor.");
  return submitPurchaseFinanceCapability(goAction.data, "purchasing.createVendor", CreateVendorOutputSchema, "adding the vendor", signal, retryScope);
}

export async function createPurchasingOrder(
  action: z.infer<typeof CreatePurchaseOrderSchema>,
  signal?: AbortSignal,
  retryScope?: { actorId: string | null; organizationId: string | null },
): Promise<PurchasingActionOutcome> {
  const parsedAction = CreatePurchaseOrderSchema.safeParse(action);
  if (!parsedAction.success) throw new PurchasingApiError(0, "Check the purchasing details and try again.");
  const useGo = typeof __GO_PURCHASING_CREATE_ORDER__ !== "undefined" && __GO_PURCHASING_CREATE_ORDER__;
  if (!useGo) return submit(parsedAction.data, OpaqueOutputSchema, "raising the purchase order", signal);
  if (!retryScope?.actorId?.trim() || !retryScope.organizationId?.trim()) {
    throw new PurchasingApiError(0, "Wait for your account and organization to finish loading before creating a purchase order.");
  }

  const scope = { actorId: retryScope.actorId.trim(), organizationId: retryScope.organizationId.trim() };
  const attempt = await createPurchaseOrderAttempt(parsedAction.data, scope);
  try {
    let { response, body } = await request("/api/capabilities/execute", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        capabilityId: "purchasing.createPurchaseOrder",
        input: {
          vendorId: parsedAction.data.vendorId,
          ...(parsedAction.data.memo === undefined ? {} : { memo: parsedAction.data.memo }),
          lines: parsedAction.data.lines,
        },
        intentId: attempt.intentId,
      }),
    }, "raising the purchase order", signal, true);

    if (response.status === 404) {
      ({ response, body } = await request("/api/purchasing", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ ...parsedAction.data, intentId: attempt.intentId }),
      }, "raising the purchase order", signal));
    }

    const outcome = parsePurchasingActionOutcome(response, body, OpaqueOutputSchema, "raising the purchase order");
    if (outcome.kind === "completed") clearPurchaseOrderAttempt(attempt);
    return outcome;
  } catch (error) {
    if (error instanceof PurchasingApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
      clearPurchaseOrderAttempt(attempt);
    }
    throw error;
  }
}

type PurchaseOrderRetryScope = { actorId: string; organizationId: string };
type PurchaseOrderAttempt = { storageKey: string; fingerprint: string; intentId: string };
const purchaseOrderActiveAttemptPrefix = "chaste.purchasing.create-po.active.v1:";

async function createPurchaseOrderAttempt(
  action: z.infer<typeof CreatePurchaseOrderSchema>,
  scope: PurchaseOrderRetryScope,
): Promise<PurchaseOrderAttempt> {
  let scopeDigest: string;
  let fingerprint: string;
  try {
    scopeDigest = await digestHex(JSON.stringify({ actorId: scope.actorId, organizationId: scope.organizationId }));
    fingerprint = await digestHex(JSON.stringify({ actorId: scope.actorId, organizationId: scope.organizationId, action: canonicalize(action) }));
  } catch {
    throw new PurchasingApiError(0, "Purchase order retry protection is unavailable. Check browser security settings and try again.");
  }

  const storageKey = `${purchaseOrderActiveAttemptPrefix}${scopeDigest}`;
  let stored: { fingerprint: string; intentId: string } | null;
  try {
    stored = parsePurchaseOrderAttempt(window.localStorage.getItem(storageKey));
  } catch {
    throw new PurchasingApiError(0, "Enable browser storage before creating a purchase order so an uncertain submission can be retried safely.");
  }
  if (stored && stored.fingerprint !== fingerprint) {
    throw new PurchasingApiError(0, "A previous purchase order result is unresolved. Retry the exact draft or check purchase orders before starting another one.");
  }
  if (stored) return { storageKey, fingerprint, intentId: stored.intentId };

  const attempt = { storageKey, fingerprint, intentId: crypto.randomUUID() };
  try {
    window.localStorage.setItem(storageKey, JSON.stringify({ fingerprint, intentId: attempt.intentId }));
    const persisted = parsePurchaseOrderAttempt(window.localStorage.getItem(storageKey));
    if (!persisted || persisted.fingerprint !== fingerprint) throw new Error("saved attempt did not persist");
    return { ...attempt, intentId: persisted.intentId };
  } catch {
    throw new PurchasingApiError(0, "Enable browser storage before creating a purchase order so an uncertain submission can be retried safely.");
  }
}

function parsePurchaseOrderAttempt(raw: string | null): { fingerprint: string; intentId: string; action?: unknown } | null {
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  const attempt = z.object({ fingerprint: z.string().regex(/^[0-9a-f]{64}$/), intentId: z.string().uuid(), action: z.unknown().optional() }).safeParse(parsed);
  if (!attempt.success) throw new Error("saved purchase order attempt is invalid");
  return attempt.data;
}

function clearPurchaseOrderAttempt(attempt: PurchaseOrderAttempt): void {
  try {
    const stored = parsePurchaseOrderAttempt(window.localStorage.getItem(attempt.storageKey));
    if (stored?.fingerprint === attempt.fingerprint && stored.intentId === attempt.intentId) {
      window.localStorage.removeItem(attempt.storageKey);
    }
  } catch {
    // A saved marker cannot change the server result, so resolution continues.
  }
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

type PurchaseLifecycleAction = z.infer<typeof ReturnGoodsSchema> | z.infer<typeof ClosePurchaseOrderSchema>;
type PurchaseLifecycleAttempt = { storageKey: string; fingerprint: string; intentId: string };
type PurchaseLifecycleRetryScope = { actorId: string; organizationId: string };
const purchaseLifecycleAttemptPrefix = "chaste.purchasing.lifecycle.active.v1:";

async function createPurchaseLifecycleAttempt(action: PurchaseLifecycleAction, scope: PurchaseLifecycleRetryScope): Promise<PurchaseLifecycleAttempt> {
  let scopeDigest: string;
  let fingerprint: string;
  try {
    scopeDigest = await digestHex(JSON.stringify(scope));
    fingerprint = await digestHex(JSON.stringify({ ...scope, action: canonicalize(action) }));
  } catch {
    throw new PurchasingApiError(0, "Purchase order retry protection is unavailable. Check browser security settings and try again.");
  }
  const storageKey = `${purchaseLifecycleAttemptPrefix}${scopeDigest}`;
  let stored: { fingerprint: string; intentId: string } | null;
  try {
    stored = parsePurchaseOrderAttempt(window.localStorage.getItem(storageKey));
  } catch {
    throw new PurchasingApiError(0, "Enable browser storage before changing a purchase order so an uncertain action can be retried safely.");
  }
  if (stored && stored.fingerprint !== fingerprint) {
    throw new PurchasingApiError(0, "A previous purchase order result is unresolved. Retry that exact action or check purchase order history before making another change.");
  }
  if (stored) return { storageKey, fingerprint, intentId: stored.intentId };
  const attempt = { storageKey, fingerprint, intentId: crypto.randomUUID() };
  try {
    window.localStorage.setItem(storageKey, JSON.stringify({ fingerprint, intentId: attempt.intentId }));
    const persisted = parsePurchaseOrderAttempt(window.localStorage.getItem(storageKey));
    if (!persisted || persisted.fingerprint !== fingerprint) throw new Error("saved attempt did not persist");
    return { ...attempt, intentId: persisted.intentId };
  } catch {
    throw new PurchasingApiError(0, "Enable browser storage before changing a purchase order so an uncertain action can be retried safely.");
  }
}

function clearPurchaseLifecycleAttempt(attempt: PurchaseLifecycleAttempt): void {
  try {
    const stored = parsePurchaseOrderAttempt(window.localStorage.getItem(attempt.storageKey));
    if (stored?.fingerprint === attempt.fingerprint && stored.intentId === attempt.intentId) {
      window.localStorage.removeItem(attempt.storageKey);
    }
  } catch {
    // A saved marker cannot change the server result, so resolution continues.
  }
}

async function submitPurchaseLifecycle<T>(
  action: PurchaseLifecycleAction,
  capabilityId: "purchasing.returnGoods" | "purchasing.closePurchaseOrder",
  output: z.ZodType<T>,
  activity: string,
  signal: AbortSignal | undefined,
  retryScope: { actorId: string | null; organizationId: string | null } | undefined,
): Promise<PurchasingActionOutcome<T>> {
  if (!retryScope?.actorId?.trim() || !retryScope.organizationId?.trim()) {
    throw new PurchasingApiError(0, "Wait for your account and organization to finish loading before changing a purchase order.");
  }
  const scope = { actorId: retryScope.actorId.trim(), organizationId: retryScope.organizationId.trim() };
  const attempt = await createPurchaseLifecycleAttempt(action, scope);
  try {
    let { response, body } = await request("/api/capabilities/execute", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        capabilityId,
        input: Object.fromEntries(Object.entries(action).filter(([key]) => key !== "action")),
        intentId: attempt.intentId,
      }),
    }, activity, signal, true);
    if (response.status === 404) {
      ({ response, body } = await request("/api/purchasing", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ ...action, intentId: attempt.intentId }),
      }, activity, signal));
    }
    const outcome = parsePurchasingActionOutcome(response, body, output, activity);
    if (outcome.kind === "completed") clearPurchaseLifecycleAttempt(attempt);
    return outcome;
  } catch (error) {
    if (error instanceof PurchasingApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
      clearPurchaseLifecycleAttempt(attempt);
    }
    throw error;
  }
}

type PurchaseFinanceAction = z.infer<typeof GoCreateVendorSchema> | z.infer<typeof GoCreateBillSchema> | z.infer<typeof GoPayBillSchema> | z.infer<typeof GoBillCreditNoteSchema>;
type PurchaseSourcingAction = z.infer<typeof GoCreatePurchaseRequestSchema> | z.infer<typeof GoDecidePurchaseRequestSchema> | z.infer<typeof GoCreateRfqSchema> | z.infer<typeof GoRecordQuoteSchema> | z.infer<typeof SelectWinningQuoteSchema>;
type PurchaseFinanceAttempt = { storageKey: string; fingerprint: string; intentId: string };
type PurchaseFinanceRetryScope = { actorId: string; organizationId: string };
const purchaseFinanceAttemptPrefix = "chaste.purchasing.finance.active.v1:";

async function createPurchaseFinanceAttempt(action: PurchaseFinanceAction, scope: PurchaseFinanceRetryScope): Promise<PurchaseFinanceAttempt> {
  let scopeDigest: string;
  let fingerprint: string;
  try {
    scopeDigest = await digestHex(JSON.stringify(scope));
    fingerprint = await digestHex(JSON.stringify({ ...scope, action: canonicalize(action) }));
  } catch {
    throw new PurchasingApiError(0, "Purchasing retry protection is unavailable. Check browser security settings and try again.");
  }
  const storageKey = `${purchaseFinanceAttemptPrefix}${action.action}:${scopeDigest}`;
  let stored: { fingerprint: string; intentId: string } | null;
  try {
    stored = parsePurchaseOrderAttempt(window.localStorage.getItem(storageKey));
  } catch {
    throw new PurchasingApiError(0, "Enable browser storage before making this purchasing change so an uncertain result can be retried safely.");
  }
  if (stored && stored.fingerprint !== fingerprint) {
    throw new PurchasingApiError(0, "A previous result for this purchasing action is unresolved. Retry the exact action or check the related record before changing it.");
  }
  if (stored) return { storageKey, fingerprint, intentId: stored.intentId };
  const attempt = { storageKey, fingerprint, intentId: crypto.randomUUID() };
  try {
    window.localStorage.setItem(storageKey, JSON.stringify({
      fingerprint,
      intentId: attempt.intentId,
      ...(action.action === "payBill" ? { action } : {}),
    }));
    const persisted = parsePurchaseOrderAttempt(window.localStorage.getItem(storageKey));
    if (!persisted || persisted.fingerprint !== fingerprint) throw new Error("saved attempt did not persist");
    return { ...attempt, intentId: persisted.intentId };
  } catch {
    throw new PurchasingApiError(0, "Enable browser storage before making this purchasing change so an uncertain result can be retried safely.");
  }
}

function clearPurchaseFinanceAttempt(attempt: PurchaseFinanceAttempt): void {
  try {
    const stored = parsePurchaseOrderAttempt(window.localStorage.getItem(attempt.storageKey));
    if (stored?.fingerprint === attempt.fingerprint && stored.intentId === attempt.intentId) {
      window.localStorage.removeItem(attempt.storageKey);
    }
  } catch {
    // A saved marker cannot change the server result, so resolution continues.
  }
}

async function submitPurchaseFinanceCapability(
  action: PurchaseFinanceAction,
  capabilityId: "purchasing.createVendor" | "purchasing.createBill" | "purchasing.payBill" | "purchasing.billCreditNote",
  output: z.ZodType<Record<string, unknown>>,
  activity: string,
  signal: AbortSignal | undefined,
  retryScope: { actorId: string | null; organizationId: string | null } | undefined,
): Promise<PurchasingActionOutcome> {
  if (!retryScope?.actorId?.trim() || !retryScope.organizationId?.trim()) {
    throw new PurchasingApiError(0, "Wait for your account and organization to finish loading before submitting this purchasing change.");
  }
  const scope = { actorId: retryScope.actorId.trim(), organizationId: retryScope.organizationId.trim() };
  const attempt = await createPurchaseFinanceAttempt(action, scope);
  try {
    let { response, body } = await request("/api/capabilities/execute", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        capabilityId,
        input: Object.fromEntries(Object.entries(action).filter(([key]) => key !== "action")),
        intentId: attempt.intentId,
      }),
    }, activity, signal, true);
    if (response.status === 404 && action.action === "payBill") {
      throw new PurchasingApiError(
        404,
        "Go could not confirm this bill payment capability. Retry the exact payment through Go to recover its result.",
        true,
      );
    }
    if (response.status === 404) {
      ({ response, body } = await request("/api/purchasing", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ ...action, intentId: attempt.intentId }),
      }, activity, signal));
      const outcome = parsePurchasingActionOutcome(response, body, OpaqueOutputSchema, activity);
      if (outcome.kind === "completed") clearPurchaseFinanceAttempt(attempt);
      return outcome;
    }
    const outcome = parsePurchasingActionOutcome(response, body, output, activity);
    if (outcome.kind === "completed") clearPurchaseFinanceAttempt(attempt);
    return outcome;
  } catch (error) {
    if (!(error instanceof PurchasingApiError)) {
      throw new PurchasingApiError(0, "The request was interrupted. Check the record before trying again.", true);
    }
    if (error instanceof PurchasingApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429 && !(action.action === "payBill" && error.status === 404)) {
      clearPurchaseFinanceAttempt(attempt);
    }
    throw error;
  }
}

async function submitPurchaseSourcingCapability<T>(
  action: PurchaseSourcingAction,
  capabilityId: "purchasing.createPurchaseRequest" | "purchasing.decidePurchaseRequest" | "purchasing.createRfq" | "purchasing.recordQuote" | "purchasing.selectWinningQuote",
  output: z.ZodType<T>,
  activity: string,
  signal: AbortSignal | undefined,
  retryScope: { actorId: string | null; organizationId: string | null } | undefined,
): Promise<PurchasingActionOutcome<T>> {
  if (!retryScope?.actorId?.trim() || !retryScope.organizationId?.trim()) {
    throw new PurchasingApiError(0, "Wait for your account and organization to finish loading before changing a purchase request.");
  }
  const scope = { actorId: retryScope.actorId.trim(), organizationId: retryScope.organizationId.trim() };
  const attempt = await createPurchaseSourcingAttempt(action, scope);
  try {
    let { response, body } = await request("/api/capabilities/execute", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        capabilityId,
        input: Object.fromEntries(Object.entries(action).filter(([key]) => key !== "action")),
        intentId: attempt.intentId,
      }),
    }, activity, signal, true);
    if (response.status === 404) {
      ({ response, body } = await request("/api/purchasing", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ ...action, intentId: attempt.intentId }),
      }, activity, signal));
      const outcome = parsePurchasingActionOutcome(response, body, OpaqueOutputSchema, activity);
      if (outcome.kind === "completed") clearPurchaseSourcingAttempt(attempt);
      return outcome as PurchasingActionOutcome<T>;
    }
    const outcome = parsePurchasingActionOutcome(response, body, output, activity);
    if (outcome.kind === "completed") clearPurchaseSourcingAttempt(attempt);
    return outcome;
  } catch (error) {
    if (!(error instanceof PurchasingApiError)) {
      throw new PurchasingApiError(0, "The request was interrupted. Check the purchase request before trying again.", true);
    }
    if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) clearPurchaseSourcingAttempt(attempt);
    throw error;
  }
}

type PurchaseSourcingAttempt = { storageKey: string; fingerprint: string; intentId: string };
const purchaseSourcingAttemptPrefix = "chaste.purchasing.sourcing.active.v1:";

async function createPurchaseSourcingAttempt(action: PurchaseSourcingAction, scope: PurchaseFinanceRetryScope): Promise<PurchaseSourcingAttempt> {
  let scopeDigest: string;
  let fingerprint: string;
  try {
    scopeDigest = await digestHex(JSON.stringify(scope));
    fingerprint = await digestHex(JSON.stringify({ ...scope, action: canonicalize(action) }));
  } catch {
    throw new PurchasingApiError(0, "Purchase request retry protection is unavailable. Check browser security settings and try again.");
  }
  const actionTarget = action.action === "createPurchaseRequest" ? "new"
    : action.action === "decidePurchaseRequest" || action.action === "createRfq" ? action.requestId
      : action.rfqId;
  const storageKey = `${purchaseSourcingAttemptPrefix}${action.action}:${encodeURIComponent(actionTarget)}:${scopeDigest}`;
  let stored: { fingerprint: string; intentId: string } | null;
  try {
    stored = parsePurchaseOrderAttempt(window.localStorage.getItem(storageKey));
  } catch {
    throw new PurchasingApiError(0, "Enable browser storage before changing a purchase request so an uncertain result can be retried safely.");
  }
  if (stored && stored.fingerprint !== fingerprint) {
    throw new PurchasingApiError(0, "A previous result for this sourcing action is unresolved. Retry the exact action or check the request before changing it.");
  }
  if (stored) return { storageKey, fingerprint, intentId: stored.intentId };
  const attempt = { storageKey, fingerprint, intentId: crypto.randomUUID() };
  try {
    window.localStorage.setItem(storageKey, JSON.stringify({ fingerprint, intentId: attempt.intentId }));
    const persisted = parsePurchaseOrderAttempt(window.localStorage.getItem(storageKey));
    if (!persisted || persisted.fingerprint !== fingerprint) throw new Error("saved attempt did not persist");
    return { ...attempt, intentId: persisted.intentId };
  } catch {
    throw new PurchasingApiError(0, "Enable browser storage before changing a purchase request so an uncertain result can be retried safely.");
  }
}

function clearPurchaseSourcingAttempt(attempt: PurchaseSourcingAttempt): void {
  try {
    const stored = parsePurchaseOrderAttempt(window.localStorage.getItem(attempt.storageKey));
    if (stored?.fingerprint === attempt.fingerprint && stored.intentId === attempt.intentId) window.localStorage.removeItem(attempt.storageKey);
  } catch {
    // A saved marker cannot change the server result, so resolution continues.
  }
}

function parsePurchasingActionOutcome<T>(response: Response, body: unknown, output: z.ZodType<T>, activity: string): PurchasingActionOutcome<T> {
  if (response.status === 202) {
    const pending = PendingEnvelopeSchema.safeParse(body);
    if (!pending.success) throw new PurchasingApiError(202, "The Purchasing service returned an unexpected approval response.");
    return { kind: "pending", reason: pending.data.reason ?? pending.data.error ?? "This action is waiting for approval." };
  }
  const envelope = SuccessEnvelopeSchema.safeParse(body);
  if (!response.ok || !envelope.success) throw new PurchasingApiError(response.status, `The Purchasing service returned an unexpected result: could not ${activity}.`, true);
  const parsedOutput = output.safeParse(envelope.data.data);
  if (!parsedOutput.success) throw new PurchasingApiError(response.status, `The Purchasing service returned an unexpected result: could not ${activity}.`, true);
  return { kind: "completed", data: parsedOutput.data };
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
  retryScope?: { actorId: string | null; organizationId: string | null },
): Promise<PurchasingActionOutcome> {
  const parsedAction = ReturnGoodsSchema.safeParse(action);
  if (!parsedAction.success) throw new PurchasingApiError(0, "Check the return quantities and reasons, then try again.");
  const useGo = typeof __GO_PURCHASING_RETURN_CLOSE__ !== "undefined" && __GO_PURCHASING_RETURN_CLOSE__;
  if (!useGo) return submit(parsedAction.data, OpaqueOutputSchema, "returning the goods", signal);
  return submitPurchaseLifecycle(parsedAction.data, "purchasing.returnGoods", ReturnGoodsOutputSchema, "returning the goods", signal, retryScope);
}

export async function closePurchasingOrder(
  action: z.infer<typeof ClosePurchaseOrderSchema>,
  signal?: AbortSignal,
  retryScope?: { actorId: string | null; organizationId: string | null },
): Promise<PurchasingActionOutcome<z.infer<typeof ClosePurchaseOrderOutputSchema>>> {
  const parsedAction = ClosePurchaseOrderSchema.safeParse(action);
  if (!parsedAction.success) throw new PurchasingApiError(0, "Check the purchase order number and try again.");
  const useGo = typeof __GO_PURCHASING_RETURN_CLOSE__ !== "undefined" && __GO_PURCHASING_RETURN_CLOSE__;
  if (!useGo) return submit(parsedAction.data, ClosePurchaseOrderOutputSchema, "closing the purchase order", signal);
  return submitPurchaseLifecycle(parsedAction.data, "purchasing.closePurchaseOrder", ClosePurchaseOrderOutputSchema, "closing the purchase order", signal, retryScope);
}

export async function createPurchasingBill(
  action: z.infer<typeof CreateBillSchema>,
  signal?: AbortSignal,
  retryScope?: { actorId: string | null; organizationId: string | null },
): Promise<PurchasingActionOutcome> {
  const parsedAction = CreateBillSchema.safeParse(action);
  if (!parsedAction.success) throw new PurchasingApiError(0, "Check the bill details and try again.");
  const useGo = goPurchasingFinanceWritesUseGo();
  if (!useGo) return submit(parsedAction.data, OpaqueOutputSchema, "recording the bill", signal);
  const goAction = GoCreateBillSchema.safeParse(parsedAction.data);
  if (!goAction.success) throw new PurchasingApiError(0, "Check the bill quantities, prices, tax codes, and PO line references before submitting.");
  return submitPurchaseFinanceCapability(goAction.data, "purchasing.createBill", CreateBillOutputSchema, "recording the bill", signal, retryScope);
}

export async function payPurchasingBill(
  action: unknown,
  signal?: AbortSignal,
  retryScope?: { actorId: string | null; organizationId: string | null },
): Promise<PurchasingActionOutcome> {
  const parsedAction = PayBillSchema.safeParse(action);
  if (!parsedAction.success) throw new PurchasingApiError(0, "Check the payment amount and try again.");
  const useGo = goPurchasingFinanceWritesUseGo();
  if (!useGo) return submit(parsedAction.data, OpaqueOutputSchema, "paying the bill", signal);
  const goAction = GoPayBillSchema.safeParse(parsedAction.data);
  if (!goAction.success) throw new PurchasingApiError(0, "Enter a positive payment amount within the supported database range.");
  return submitPurchaseFinanceCapability(goAction.data, "purchasing.payBill", PayBillOutputSchema, "paying the bill", signal, retryScope);
}

export async function readPendingPurchasingBillPayment(
  retryScope: { actorId: string | null; organizationId: string | null },
): Promise<PurchasingPayBillAction | null> {
  if (!retryScope.actorId?.trim() || !retryScope.organizationId?.trim()) return null;
  const scope = { actorId: retryScope.actorId.trim(), organizationId: retryScope.organizationId.trim() };
  let scopeDigest: string;
  try { scopeDigest = await digestHex(JSON.stringify(scope)); }
  catch { throw new PurchasingApiError(0, "Purchasing retry recovery is unavailable in this browser session.", true); }
  const storageKey = `${purchaseFinanceAttemptPrefix}payBill:${scopeDigest}`;
  let stored: ReturnType<typeof parsePurchaseOrderAttempt>;
  try { stored = parsePurchaseOrderAttempt(window.localStorage.getItem(storageKey)); }
  catch { throw new PurchasingApiError(0, "Could not read the unresolved bill payment. Enable browser storage and reload.", true); }
  if (!stored) return null;
  const action = PayBillSchema.safeParse(stored.action);
  if (!action.success) {
    throw new PurchasingApiError(0, "An unresolved bill payment is missing its saved details and cannot be safely retried.", true);
  }
  let fingerprint: string;
  try { fingerprint = await digestHex(JSON.stringify({ ...scope, action: canonicalize(action.data) })); }
  catch { throw new PurchasingApiError(0, "Could not verify the saved bill payment. Check the bill before retrying.", true); }
  if (fingerprint !== stored.fingerprint) {
    throw new PurchasingApiError(0, "The saved bill payment details failed verification. Check the bill before retrying.", true);
  }
  return action.data;
}

export async function creditPurchasingBill(
  action: z.infer<typeof BillCreditNoteSchema>,
  signal?: AbortSignal,
  retryScope?: { actorId: string | null; organizationId: string | null },
): Promise<PurchasingActionOutcome> {
  const parsedAction = BillCreditNoteSchema.safeParse(action);
  if (!parsedAction.success) throw new PurchasingApiError(0, "Check the bill credit amount and reason, then try again.");
  const useGo = goPurchasingFinanceWritesUseGo();
  if (!useGo) return submit(parsedAction.data, BillCreditNoteOutputSchema, "crediting the bill", signal);
  const goAction = GoBillCreditNoteSchema.safeParse(parsedAction.data);
  if (!goAction.success) throw new PurchasingApiError(0, "Enter a valid bill, positive credit amount, and reason between 3 and 500 characters.");
  return submitPurchaseFinanceCapability(goAction.data, "purchasing.billCreditNote", GoBillCreditNoteOutputSchema, "crediting the bill", signal, retryScope);
}

export async function createPurchasingRequest(
  action: z.infer<typeof CreatePurchaseRequestSchema>,
  signal?: AbortSignal,
  retryScope?: { actorId: string | null; organizationId: string | null },
): Promise<PurchasingActionOutcome> {
  const useGo = typeof __GO_PURCHASING_SOURCING_WRITES__ !== "undefined" && __GO_PURCHASING_SOURCING_WRITES__;
  if (!useGo) return submit(action, OpaqueOutputSchema, "raising the purchase request", signal);
  const parsed = GoCreatePurchaseRequestSchema.safeParse(action);
  if (!parsed.success) throw new PurchasingApiError(0, "Enter a request title of 3 to 200 characters and a justification of 10 to 4000 characters.");
  return submitPurchaseSourcingCapability(parsed.data, "purchasing.createPurchaseRequest", GoCreatePurchaseRequestOutputSchema, "raising the purchase request", signal, retryScope);
}

export async function decidePurchasingRequest(
  action: z.infer<typeof DecidePurchaseRequestSchema>,
  signal?: AbortSignal,
  retryScope?: { actorId: string | null; organizationId: string | null },
): Promise<PurchasingActionOutcome> {
  const useGo = typeof __GO_PURCHASING_SOURCING_WRITES__ !== "undefined" && __GO_PURCHASING_SOURCING_WRITES__;
  if (!useGo) return submit(action, OpaqueOutputSchema, "recording the decision", signal);
  const parsed = GoDecidePurchaseRequestSchema.safeParse(action);
  if (!parsed.success) throw new PurchasingApiError(0, "Enter a valid purchase request decision and a reason no longer than 1000 characters.");
  return submitPurchaseSourcingCapability(parsed.data, "purchasing.decidePurchaseRequest", GoDecidePurchaseRequestOutputSchema, "recording the decision", signal, retryScope);
}

export async function createPurchasingRfq(
  action: z.infer<typeof CreateRfqSchema>,
  signal?: AbortSignal,
  retryScope?: { actorId: string | null; organizationId: string | null },
): Promise<PurchasingActionOutcome> {
  const useGo = typeof __GO_PURCHASING_SOURCING_WRITES__ !== "undefined" && __GO_PURCHASING_SOURCING_WRITES__;
  if (!useGo) return submit(action, OpaqueOutputSchema, "sending the RFQs", signal);
  const parsed = GoCreateRfqSchema.safeParse(action);
  if (!parsed.success) throw new PurchasingApiError(0, "Select between 1 and 10 valid suppliers for the RFQ.");
  return submitPurchaseSourcingCapability(parsed.data, "purchasing.createRfq", GoCreateRfqOutputSchema, "sending the RFQs", signal, retryScope);
}

export async function recordPurchasingQuote(
  action: z.infer<typeof RecordQuoteSchema>,
  signal?: AbortSignal,
  retryScope?: { actorId: string | null; organizationId: string | null },
): Promise<PurchasingActionOutcome> {
  const useGo = typeof __GO_PURCHASING_SOURCING_WRITES__ !== "undefined" && __GO_PURCHASING_SOURCING_WRITES__;
  if (!useGo) return submit(action, OpaqueOutputSchema, "recording the quote", signal);
  const parsed = GoRecordQuoteSchema.safeParse(action);
  if (!parsed.success) throw new PurchasingApiError(0, "Enter a positive quote amount and valid optional lead time and notes.");
  return submitPurchaseSourcingCapability(parsed.data, "purchasing.recordQuote", GoRecordQuoteOutputSchema, "recording the quote", signal, retryScope);
}

export async function selectPurchasingWinningQuote(
  action: z.infer<typeof SelectWinningQuoteSchema>,
  signal?: AbortSignal,
  retryScope?: { actorId: string | null; organizationId: string | null },
): Promise<PurchasingActionOutcome> {
  const useGo = typeof __GO_PURCHASING_SOURCING_WRITES__ !== "undefined" && __GO_PURCHASING_SOURCING_WRITES__;
  if (!useGo) return submit(action, OpaqueOutputSchema, "awarding the quote", signal);
  return submitPurchaseSourcingCapability(action, "purchasing.selectWinningQuote", GoSelectWinningQuoteOutputSchema, "awarding the quote", signal, retryScope);
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
  const action = SupplierStatementActionSchema.safeParse({ action: "supplierStatement", vendorId });
  if (!action.success) throw new PurchasingApiError(0, "Choose a valid supplier before loading the statement.");

  if (goPurchasingSupplierStatementReadsUseGo()) {
    const { response, body } = await request("/api/capabilities/execute", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        capabilityId: "purchasing.supplierStatement",
        input: { vendorId: action.data.vendorId },
        intentId: crypto.randomUUID(),
      }),
    }, "load the supplier statement", signal);
    if (response.status !== 200) {
      throw new PurchasingApiError(response.status, "The Purchasing service returned an unexpected result: could not load the supplier statement.");
    }
    const envelope = SuccessEnvelopeSchema.safeParse(body);
    if (!envelope.success) throw new PurchasingApiError(response.status, "The Purchasing service returned an unexpected result: could not load the supplier statement.");
    const statement = SupplierStatementSchema.safeParse(envelope.data.data);
    if (!statement.success) throw new PurchasingApiError(response.status, "The Purchasing service returned an unexpected result: could not load the supplier statement.");
    return statement.data;
  }

  const outcome = await submit(action.data, SupplierStatementSchema, "loading the supplier statement", signal);
  if (outcome.kind === "pending") {
    throw new PurchasingApiError(202, "The supplier statement read did not complete.");
  }
  return outcome.data;
}
