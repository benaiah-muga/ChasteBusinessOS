import { z } from "zod";

const minor = z.number().int().safe();
// The journal row spreads a SQL sum over a bigint column, and Postgres hands
// bigint aggregates back as a JSON string. Accept the string spelling and
// normalise it so the page reads one numeric type.
const minorAggregate = z.union([minor, z.string().regex(/^-?\d+$/)]).transform((value) =>
  typeof value === "number" ? value : Number(value),
);
const currency = z.string().regex(/^[A-Z]{3}$/);
const timestamp = z.string().datetime({ offset: true });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// The catalog entries carry label, description, href, and protected alongside
// id, so neither level may be strict or a real switchboard response is rejected.
const SwitchboardSchema = z.object({
  catalog: z.array(z.object({ id: z.string().min(1) }).passthrough()),
  enabledModules: z.array(z.string().min(1)),
}).passthrough();

const EntrySchema = z.object({
  id: z.string().min(1),
  memo: z.string(),
  sourceType: z.string().nullable(),
  reversalOfId: z.string().nullable(),
  postedAt: timestamp,
  actorType: z.string().min(1),
  currency,
  amountMinor: minor,
  // The legacy route spreads its debit aggregate into every entry, so both
  // keys arrive on the wire even though only one is rendered. That aggregate
  // arrives as a string, so it needs the wire-tolerant parser.
  debitMinor: minorAggregate,
}).strict();

const AgingSchema = z.object({
  current: minor,
  d30: minor,
  d60: minor,
  d90plus: minor,
  totalOutstanding: minor,
}).strict();

const AgingInvoiceSchema = z.object({
  number: z.number().int().positive().safe(),
  currency,
  outstandingMinor: minor,
  ageDays: z.number().int().safe(),
}).strict();

const BillSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive().safe(),
  status: z.string().min(1),
  currency,
  totalMinor: minor,
  creditedMinor: minor,
  paidMinor: minor,
  vendorName: z.string(),
  outstandingMinor: minor,
}).strict();

const FilingSchema = z.object({
  id: z.string().min(1),
  periodFrom: day,
  periodTo: day,
  taxMinor: minor,
  filedAt: timestamp,
}).strict();

const CustomerSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  paymentTermDays: z.number().int().safe().nullable(),
}).strict();

const InvoiceSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive().safe(),
  customerId: z.string().min(1),
  customerName: z.string(),
  status: z.string().min(1),
  currency,
  totalMinor: minor,
  paidMinor: minor,
  creditedMinor: minor,
  outstandingMinor: minor,
  issuedAt: timestamp.nullable(),
}).strict();

const PaymentSchema = z.object({
  id: z.string().min(1),
  invoiceNumber: z.number().int().safe(),
  amountMinor: minor,
  method: z.string().min(1),
  receivedAt: timestamp,
  currency,
}).strict();

const PeriodSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
}).strict();

const AccountingOverviewSchema = z.object({
  entries: z.array(EntrySchema),
  aging: AgingSchema,
  agingInvoices: z.array(AgingInvoiceSchema),
  baseCurrency: currency,
  foreignReceivablesCount: z.number().int().safe().nonnegative(),
  foreignPayablesCount: z.number().int().safe().nonnegative(),
  closedPeriods: z.array(PeriodSchema),
  bills: z.array(BillSchema),
  filings: z.array(FilingSchema),
  customers: z.array(CustomerSchema),
  invoices: z.array(InvoiceSchema),
  payments: z.array(PaymentSchema),
}).strict();

const PnlSchema = z.object({
  revenueMinor: minor,
  expenseMinor: minor,
  netIncomeMinor: minor,
  lines: z.array(z.object({ code: z.string(), name: z.string(), amountMinor: minor }).strict()),
}).strict();

const BalanceSheetSchema = z.object({
  assetsMinor: minor,
  liabilitiesMinor: minor,
  equityMinor: minor,
  retainedResultMinor: minor,
  balanced: z.boolean(),
}).strict();

const CashFlowBucketSchema = z.object({
  inflowMinor: minor,
  outflowMinor: minor,
  netMinor: minor,
  entries: z.number().int().safe().nonnegative(),
}).strict();

const CashFlowSchema = z.object({
  openingMinor: minor,
  closingMinor: minor,
  netMinor: minor,
  cashBalanceMinor: minor,
  ties: z.boolean(),
  unsupportedCurrencies: z.array(currency).optional(),
  operating: CashFlowBucketSchema,
  investing: CashFlowBucketSchema,
  financing: CashFlowBucketSchema,
}).strict();

const FxExposureSchema = z.object({
  exposures: z.array(z.object({
    currency,
    outstandingForeignMinor: minor,
    latestRateNum: z.number().safe().nullable(),
    latestRateDen: z.number().safe().nullable(),
    outstandingBaseMinor: minor.nullable(),
  }).strict()),
}).strict();

const AccountingReportsSchema = z.object({
  baseCurrency: currency,
  unsupportedCurrencies: z.array(currency).optional(),
  pnl: PnlSchema,
  balanceSheet: BalanceSheetSchema,
  cashFlow: CashFlowSchema.nullable().optional(),
  fxExposure: FxExposureSchema.nullable().optional(),
}).strict();

const BankAccountSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  currencyCode: currency,
  last4: z.string().nullable(),
  balanceMinor: minor,
}).strict();

const BankTransactionSchema = z.object({
  id: z.string().min(1),
  bankAccountId: z.string().min(1),
  currencyCode: currency,
  postedAt: timestamp,
  amountMinor: minor,
  description: z.string(),
}).strict();

const BankPaymentSchema = z.object({
  id: z.string().min(1),
  invoiceNumber: z.number().int().safe().nullable(),
  currencyCode: currency.optional(),
  customerName: z.string(),
  amountMinor: minor,
  receivedAt: timestamp,
}).strict();

const BankSummarySchema = z.object({
  accounts: z.array(z.object({
    bankAccountId: z.string().min(1),
    name: z.string(),
    currencyCode: currency,
    last4: z.string().nullable(),
    balanceMinor: minor,
    count: z.number().int().safe().nonnegative(),
    moneyInMinor: minor,
    moneyOutMinor: minor,
  }).strict()),
  unmatchedCount: z.number().int().safe().nonnegative(),
}).strict();

const BankingSchema = z.object({
  accounts: z.array(BankAccountSchema),
  unmatched: z.array(BankTransactionSchema),
  matched: z.array(BankTransactionSchema).optional(),
  excluded: z.array(BankTransactionSchema).optional(),
  payments: z.array(BankPaymentSchema),
  summary: BankSummarySchema,
}).strict();

const TaxCodeSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string(),
  direction: z.enum(["input", "output"]),
  rateBasisPoints: z.number().int().safe().nonnegative(),
  priceIncludesTax: z.boolean(),
  active: z.boolean(),
}).strict();

const TaxCodesSchema = z.object({ codes: z.array(TaxCodeSchema) }).strict();

const BudgetScenarioSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  fiscalYear: z.number().int().min(2000).max(2100),
  version: z.number().int().safe(),
  isCurrent: z.boolean(),
}).strict();

const ScenariosSchema = z.object({
  ok: z.literal(true),
  scenarios: z.object({ scenarios: z.array(BudgetScenarioSchema) }).strict(),
}).strict();

const CashBasisSchema = z.object({
  cashInMinor: minor,
  cashOutMinor: minor,
  netCashMinor: minor,
  accrualRevenueMinor: minor,
  uncollectedMinor: minor,
}).strict();

const ForecastSchema = z.object({
  startMinor: minor,
  finalMinor: minor,
  lowestCloseMinor: minor,
  lowestWeekIndex: z.number().int().safe(),
  scenarioName: z.string().nullable(),
  minimumCashBufferMinor: minor,
  unsupportedCurrencies: z.array(currency).optional(),
  weeks: z.array(z.object({
    weekStart: timestamp,
    inflowMinor: minor,
    outflowMinor: minor,
    closeMinor: minor,
  }).strict()),
}).strict();

const ReminderSchema = z.object({
  customerId: z.string().min(1),
  customerName: z.string(),
  currency,
  overdueCount: z.number().int().safe().nonnegative(),
  oldestDaysOverdue: z.number().int().safe(),
  totalOverdueMinor: minor,
  message: z.string(),
}).strict();

const RemindersSchema = z.object({ reminders: z.array(ReminderSchema) }).strict();

const StatementSchema = z.object({
  currencies: z.array(z.object({
    currency,
    openingBalanceMinor: minor,
    closingBalanceMinor: minor,
    rows: z.array(z.object({
      date: z.string().min(1),
      kind: z.string().min(1),
      ref: z.string(),
      amountMinor: minor,
      balanceMinor: minor,
    }).strict()),
  }).strict()),
}).strict();

const ErrorResponseSchema = z.object({ error: z.string().optional(), message: z.string().optional() });
const EnvelopeSchema = z.object({ ok: z.literal(true), data: z.unknown() }).strict();
const PendingSchema = z.object({
  ok: z.literal(false).optional(),
  pendingApproval: z.literal(true),
  reason: z.string().optional(),
  error: z.string().optional(),
}).strict();
const RecordPaymentActionSchema = z.object({
  action: z.literal("recordPayment"),
  invoiceNumber: z.number().int().positive().safe(),
  amountMinor: z.number().int().positive().safe(),
  method: z.enum(["cash", "bank_transfer", "card"]),
  settleFxRate: z.string().optional(),
}).strict();
const StoredRecordPaymentSchema = z.object({
  action: RecordPaymentActionSchema,
  intentId: z.string().uuid(),
  fingerprint: z.string().length(64),
}).strict();
const RecordPaymentOutputSchema = z.object({
  paymentId: z.string().uuid(),
  entryId: z.string().uuid(),
  fullyPaid: z.boolean(),
  gainLossMinor: minor.optional(),
  baseEntryId: z.string().uuid().optional(),
  foreignEntryId: z.string().uuid().optional(),
}).strict();
const RECORD_PAYMENT_ATTEMPT_PREFIX = "chaste:accounting:record-payment:go:attempt:v1:";
const CreateInvoiceActionSchema = z.object({
  action: z.literal("createInvoice"),
  customerId: z.string().uuid(),
  memo: z.string().optional(),
  lines: z.array(z.object({
    description: z.string().min(1),
    quantity: z.number().int().positive().safe(),
    unitPriceMinor: z.number().int().nonnegative().safe(),
    taxMinor: z.number().int().nonnegative().safe().optional(),
    taxCodeId: z.string().uuid().optional(),
  }).strict().refine((line) => !(line.taxMinor !== undefined && line.taxCodeId !== undefined), "Choose a tax amount or a tax code.")).min(1),
  currency: z.string().optional(),
  fxRate: z.string().optional(),
  dueAt: z.string().datetime().optional(),
}).strict();
const StoredCreateInvoiceSchema = z.object({
  action: CreateInvoiceActionSchema,
  intentId: z.string().uuid(),
  fingerprint: z.string().length(64),
}).strict();
const CreateInvoiceOutputSchema = z.object({
  invoiceId: z.string().uuid(),
  invoiceNumber: z.number().int().positive().safe(),
  totalMinor: minor,
  entryId: z.string().uuid(),
  currency: z.string().min(3).max(3),
}).strict();
const CREATE_INVOICE_ATTEMPT_PREFIX = "chaste:accounting:create-invoice:go:attempt:v1:";
const CreditNoteActionSchema = z.object({
  action: z.literal("creditNote"),
  invoiceId: z.string().uuid(),
  amountMinor: z.number().int().positive().safe(),
  reason: z.string().min(3).max(500),
}).strict();
const StoredCreditNoteSchema = z.object({
  action: CreditNoteActionSchema,
  intentId: z.string().uuid(),
  fingerprint: z.string().length(64),
}).strict();
const CreditNoteOutputSchema = z.object({
  entryId: z.string().uuid(),
  creditedMinor: minor,
  invoiceBalanceMinor: minor,
}).strict();
const CREDIT_NOTE_ATTEMPT_PREFIX = "chaste:accounting:credit-note:go:attempt:v1:";

export type AccountingEntry = z.infer<typeof EntrySchema>;
export type AccountingAging = z.infer<typeof AgingSchema>;
export type AccountingAgingInvoice = z.infer<typeof AgingInvoiceSchema>;
export type AccountingBill = z.infer<typeof BillSchema>;
export type AccountingCustomer = z.infer<typeof CustomerSchema>;
export type AccountingInvoice = z.infer<typeof InvoiceSchema>;
export type AccountingPayment = z.infer<typeof PaymentSchema>;
export type AccountingOverview = z.infer<typeof AccountingOverviewSchema>;
export type AccountingReports = z.infer<typeof AccountingReportsSchema>;
export type AccountingCashBasis = z.infer<typeof CashBasisSchema>;
export type AccountingBanking = z.infer<typeof BankingSchema>;
export type AccountingTaxCode = z.infer<typeof TaxCodeSchema>;
export type AccountingBudgetScenario = z.infer<typeof BudgetScenarioSchema>;
export type AccountingForecast = z.infer<typeof ForecastSchema>;
export type AccountingReminder = z.infer<typeof ReminderSchema>;
export type AccountingStatement = z.infer<typeof StatementSchema>;

export class AccountingApiError extends Error {
  constructor(readonly status: number, message: string, readonly requestMayHaveReachedServer = false) {
    super(message);
    this.name = "AccountingApiError";
  }
}

/** Governed writes answer 202 while they wait in the Approvals inbox. */
export type AccountingActionOutcome =
  | { kind: "completed" }
  | { kind: "pending"; reason: string };

export type AccountingRecordPaymentAction = z.infer<typeof RecordPaymentActionSchema>;
export type AccountingPaymentRetryScope = { actorId: string | null; organizationId: string | null };
export type AccountingCreateInvoiceAction = z.infer<typeof CreateInvoiceActionSchema>;
export type AccountingCreditNoteAction = z.infer<typeof CreditNoteActionSchema>;

export function goAccountingRecordPaymentUseGo(): boolean {
  return typeof __GO_ACCOUNTING_RECORD_PAYMENT__ !== "undefined" && __GO_ACCOUNTING_RECORD_PAYMENT__;
}

export function goAccountingCreateInvoiceUseGo(): boolean {
  return typeof __GO_ACCOUNTING_CREATE_INVOICE__ !== "undefined" && __GO_ACCOUNTING_CREATE_INVOICE__;
}

export function goAccountingCreditNoteUseGo(): boolean {
  return typeof __GO_ACCOUNTING_CREDIT_NOTE__ !== "undefined" && __GO_ACCOUNTING_CREDIT_NOTE__;
}

export async function readPendingAccountingCreditNote(scope: AccountingPaymentRetryScope): Promise<AccountingCreditNoteAction | null> {
  const { scopeHash } = await accountingPaymentScope(scope);
  const storageKey = `${CREDIT_NOTE_ATTEMPT_PREFIX}${scopeHash}`;
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new AccountingApiError(0, "Enable browser storage to recover an unresolved credit note.", true); }
  if (raw === null) return null;
  return parseStoredCreditNote(raw).action;
}

export async function readPendingAccountingCreateInvoice(scope: AccountingPaymentRetryScope): Promise<AccountingCreateInvoiceAction | null> {
  const { scopeHash } = await accountingPaymentScope(scope);
  const storageKey = `${CREATE_INVOICE_ATTEMPT_PREFIX}${scopeHash}`;
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new AccountingApiError(0, "Enable browser storage to recover an unresolved invoice creation.", true); }
  if (raw === null) return null;
  return parseStoredCreateInvoice(raw).action;
}

export async function readPendingAccountingRecordPayment(scope: AccountingPaymentRetryScope): Promise<AccountingRecordPaymentAction | null> {
  const { scopeHash } = await accountingPaymentScope(scope);
  const storageKey = `${RECORD_PAYMENT_ATTEMPT_PREFIX}${scopeHash}`;
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new AccountingApiError(0, "Enable browser storage to recover an unresolved invoice payment.", true); }
  if (raw === null) return null;
  return parseStoredRecordPayment(raw).action;
}

function signalWithTimeout(signal?: AbortSignal, timeoutMs = 15_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function getJson(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<{ response: Response; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
      signal: signalWithTimeout(signal, init.method === "POST" ? 20_000 : 15_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new AccountingApiError(0, timedOut
      ? "The Accounting service took too long to respond. Check the record before trying again."
      : "Could not reach the Accounting service. Check your connection and try again.");
  }
  return { response, body: await response.json().catch(() => null) };
}

function errorMessage(status: number, body: unknown, context: string): string {
  const parsed = ErrorResponseSchema.safeParse(body);
  const serverMessage = parsed.success ? parsed.data.message ?? parsed.data.error : undefined;
  const usable = serverMessage && serverMessage.length <= 240 && !/[{}<>]/.test(serverMessage) ? serverMessage : undefined;
  // Session and outage copy comes first: "unauthorized" is wire truth, not
  // something to put in front of a person.
  if (status === 401) return "Your session has ended. Sign in again to continue.";
  if (status === 428) return "Finish setting up your workspace before posting accounting records.";
  if (status >= 500) return "The Accounting service is unavailable. Try again.";
  if (status === 403) return usable ?? "You do not have permission to complete this accounting action.";
  return usable ?? `Could not ${context}. Try again.`;
}

async function get<T>(path: string, schema: z.ZodType<T>, context: string, signal?: AbortSignal): Promise<T> {
  const { response, body } = await getJson(path, { method: "GET" }, signal);
  if (!response.ok) throw new AccountingApiError(response.status, errorMessage(response.status, body, context));
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new AccountingApiError(response.status, "The Accounting service returned data in an unexpected format.");
  return parsed.data;
}

export async function fetchAccountingEnabled(signal?: AbortSignal): Promise<boolean> {
  const { response, body } = await getJson("/api/modules", { method: "GET" }, signal);
  if (!response.ok) throw new AccountingApiError(response.status, errorMessage(response.status, body, "check the Accounting module status"));
  const parsed = SwitchboardSchema.safeParse(body);
  if (!parsed.success) throw new AccountingApiError(response.status, "The module switchboard returned data in an unexpected format.");
  const catalogIds = new Set(parsed.data.catalog.map((module) => module.id));
  if (!catalogIds.has("accounting") || parsed.data.enabledModules.some((id) => !catalogIds.has(id))) {
    throw new AccountingApiError(response.status, "The module switchboard returned an invalid Accounting configuration.");
  }
  return parsed.data.enabledModules.includes("accounting");
}

export async function fetchAccountingOverview(signal?: AbortSignal): Promise<AccountingOverview> {
  return get("/api/accounting", AccountingOverviewSchema, "load your books", signal);
}

export async function fetchAccountingReports(signal?: AbortSignal): Promise<AccountingReports> {
  return get("/api/reports", AccountingReportsSchema, "load the financial reports", signal);
}

/** Cash basis and bank feeds are auxiliary: a failure must never blank the books. */
export async function fetchAccountingCashBasis(year: number, signal?: AbortSignal): Promise<AccountingCashBasis | null> {
  if (!Number.isSafeInteger(year) || year < 2000 || year > 2100) {
    throw new AccountingApiError(400, "Choose a valid reporting year.");
  }
  const { response, body } = await getJson("/api/accounting", {
    method: "POST",
    body: JSON.stringify({ action: "cashBasis", year }),
  }, signal);
  if (!response.ok) return null;
  const envelope = EnvelopeSchema.safeParse(body);
  if (!envelope.success) return null;
  const parsed = CashBasisSchema.safeParse(envelope.data.data);
  return parsed.success ? parsed.data : null;
}

export async function fetchAccountingBanking(signal?: AbortSignal): Promise<AccountingBanking | null> {
  const { response, body } = await getJson("/api/banking", { method: "GET" }, signal);
  if (!response.ok) return null;
  const parsed = BankingSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

export async function fetchAccountingTaxCodes(signal?: AbortSignal): Promise<AccountingTaxCode[]> {
  // TaxCodesSchema wraps the list, so unwrap before filtering: invoices can only
  // ever charge an active output code.
  const { codes } = await get("/api/accounting/tax", TaxCodesSchema, "load the tax codes", signal);
  return codes.filter((code) => code.active && code.direction === "output");
}

export async function fetchAccountingBudgetScenarios(signal?: AbortSignal): Promise<AccountingBudgetScenario[]> {
  const { response, body } = await getJson("/api/accounting/budgets", { method: "GET" }, signal);
  if (!response.ok) return [];
  const parsed = ScenariosSchema.safeParse(body);
  return parsed.success ? parsed.data.scenarios.scenarios : [];
}

async function readCapability<T>(
  payload: Record<string, unknown>,
  schema: z.ZodType<T>,
  context: string,
  signal?: AbortSignal,
): Promise<T> {
  const { response, body } = await getJson("/api/accounting", { method: "POST", body: JSON.stringify(payload) }, signal);
  if (!response.ok) throw new AccountingApiError(response.status, errorMessage(response.status, body, context));
  const envelope = EnvelopeSchema.safeParse(body);
  if (!envelope.success) throw new AccountingApiError(response.status, "The Accounting service returned an unexpected response.");
  const parsed = schema.safeParse(envelope.data.data);
  if (!parsed.success) throw new AccountingApiError(response.status, "The Accounting service returned an unexpected result.");
  return parsed.data;
}

export async function fetchCashForecast(budgetScenarioId: string, signal?: AbortSignal): Promise<AccountingForecast> {
  return readCapability(
    { action: "cashForecast", ...(budgetScenarioId ? { budgetScenarioId } : {}) },
    ForecastSchema,
    "compute the cash forecast",
    signal,
  );
}

export async function fetchPaymentReminders(signal?: AbortSignal): Promise<AccountingReminder[]> {
  const result = await readCapability({ action: "buildReminders" }, RemindersSchema, "draft payment reminders", signal);
  return result.reminders;
}

export async function fetchCustomerStatement(customerId: string, signal?: AbortSignal): Promise<AccountingStatement> {
  if (!customerId) throw new AccountingApiError(400, "Choose a customer before loading a statement.");
  return readCapability({ action: "customerStatement", customerId }, StatementSchema, "load this customer statement", signal);
}

/**
 * Governed write against the legacy capability seam. The legacy page only
 * mints an intentId for bill payments, so callers pass one explicitly rather
 * than every action gaining an identity it never had.
 */
export async function submitAccountingAction(
  path: "/api/accounting" | "/api/banking",
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  retryScope?: AccountingPaymentRetryScope,
): Promise<AccountingActionOutcome> {
  if (path === "/api/accounting" && payload.action === "creditNote") {
    const action = CreditNoteActionSchema.safeParse(payload);
    if (!action.success) throw new AccountingApiError(400, "Enter a valid credit note before submitting.");
    const scoped = await accountingPaymentScope(retryScope ?? { actorId: null, organizationId: null });
    if (goAccountingCreditNoteUseGo()) return submitGoAccountingCreditNote(action.data, scoped, signal);
    if (await readPendingAccountingCreditNote(retryScope ?? { actorId: null, organizationId: null })) {
      throw new AccountingApiError(0, "A Go credit note is unresolved. Restore the Go credit note route and retry that exact credit before using the legacy route.", true);
    }
  }
  if (path === "/api/accounting" && payload.action === "createInvoice") {
    const action = CreateInvoiceActionSchema.safeParse(payload);
    if (!action.success) throw new AccountingApiError(400, "Enter a valid invoice before submitting.");
    const scoped = await accountingPaymentScope(retryScope ?? { actorId: null, organizationId: null });
    if (goAccountingCreateInvoiceUseGo()) return submitGoAccountingCreateInvoice(action.data, scoped, signal);
    if (await readPendingAccountingCreateInvoice(retryScope ?? { actorId: null, organizationId: null })) {
      throw new AccountingApiError(0, "A Go invoice creation is unresolved. Restore the Go invoice route and retry that exact invoice before using the legacy route.", true);
    }
  }
  if (path === "/api/accounting" && payload.action === "recordPayment") {
    const action = RecordPaymentActionSchema.safeParse(payload);
    if (!action.success) throw new AccountingApiError(400, "Enter a valid invoice payment before submitting.");
    const scoped = await accountingPaymentScope(retryScope ?? { actorId: null, organizationId: null });
    if (goAccountingRecordPaymentUseGo()) return submitGoAccountingRecordPayment(action.data, scoped, signal);
    if (await readPendingAccountingRecordPayment(retryScope ?? { actorId: null, organizationId: null })) {
      throw new AccountingApiError(0, "A Go invoice payment is unresolved. Restore the Go payment route and retry that exact payment before using the legacy route.", true);
    }
  }
  const { response, body } = await getJson(path, { method: "POST", body: JSON.stringify(payload) }, signal);
  if (response.status === 202) {
    const parsed = PendingSchema.safeParse(body);
    if (!parsed.success) throw new AccountingApiError(202, "This action is waiting for approval but the Accounting service returned an invalid approval response.");
    return { kind: "pending", reason: parsed.data.reason ?? parsed.data.error ?? "This action is waiting for approval." };
  }
  if (!response.ok) throw new AccountingApiError(response.status, errorMessage(response.status, body, "complete this accounting action"));
  const envelope = EnvelopeSchema.safeParse(body);
  if (!envelope.success) throw new AccountingApiError(response.status, "The Accounting service returned an unexpected action response.");
  return { kind: "completed" };
}

async function submitGoAccountingCreditNote(
  action: AccountingCreditNoteAction,
  scope: { actorId: string; organizationId: string; scopeHash: string },
  signal?: AbortSignal,
): Promise<AccountingActionOutcome> {
  const attempt = await accountingCreditNoteAttempt(action, scope.scopeHash);
  let response: Response;
  let body: unknown;
  try {
    ({ response, body } = await getJson("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({ capabilityId: "accounting.creditNote", input: creditNoteCapabilityInput(action), intentId: attempt.intentId }),
    }, signal));
  } catch (error) {
    if (error instanceof AccountingApiError) throw new AccountingApiError(error.status, error.message, true);
    throw new AccountingApiError(0, "The Go Accounting service could not confirm this credit note. Retry the same credit to recover its result.", true);
  }
  if (response.status === 202) {
    const parsed = PendingSchema.safeParse(body);
    if (!parsed.success) throw new AccountingApiError(202, "The Go Accounting service returned an invalid credit note approval response.", true);
    return { kind: "pending", reason: parsed.data.reason ?? parsed.data.error ?? "This credit note is waiting for approval." };
  }
  if (!response.ok) {
    const uncertain = response.status === 404 || response.status >= 500 || response.status === 408 || response.status === 429;
    if (!uncertain) await clearAccountingCreditNoteAttempt(attempt.storageKey);
    throw new AccountingApiError(response.status, errorMessage(response.status, body, "create this credit note"), uncertain);
  }
  const envelope = EnvelopeSchema.safeParse(body);
  const output = envelope.success ? CreditNoteOutputSchema.safeParse(envelope.data.data) : null;
  if (response.status !== 200 || !output?.success) {
    throw new AccountingApiError(response.status, "The Go Accounting service returned an unexpected credit note response.", true);
  }
  await clearAccountingCreditNoteAttempt(attempt.storageKey);
  return { kind: "completed" };
}

function creditNoteCapabilityInput(action: AccountingCreditNoteAction): Record<string, unknown> {
  const { action: _action, ...input } = action;
  return input;
}

async function submitGoAccountingCreateInvoice(
  action: AccountingCreateInvoiceAction,
  scope: { actorId: string; organizationId: string; scopeHash: string },
  signal?: AbortSignal,
): Promise<AccountingActionOutcome> {
  const attempt = await accountingCreateInvoiceAttempt(action, scope.scopeHash);
  let response: Response;
  let body: unknown;
  try {
    ({ response, body } = await getJson("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({ capabilityId: "accounting.createInvoice", input: createInvoiceCapabilityInput(action), intentId: attempt.intentId }),
    }, signal));
  } catch (error) {
    if (error instanceof AccountingApiError) throw new AccountingApiError(error.status, error.message, true);
    throw new AccountingApiError(0, "The Go Accounting service could not confirm this invoice. Retry the same invoice to recover its result.", true);
  }
  if (response.status === 202) {
    const parsed = PendingSchema.safeParse(body);
    if (!parsed.success) throw new AccountingApiError(202, "The Go Accounting service returned an invalid invoice approval response.", true);
    return { kind: "pending", reason: parsed.data.reason ?? parsed.data.error ?? "This invoice is waiting for approval." };
  }
  if (!response.ok) {
    const uncertain = response.status === 404 || response.status >= 500 || response.status === 408 || response.status === 429;
    if (!uncertain) await clearAccountingCreateInvoiceAttempt(attempt.storageKey);
    throw new AccountingApiError(response.status, errorMessage(response.status, body, "create this invoice"), uncertain);
  }
  const envelope = EnvelopeSchema.safeParse(body);
  const output = envelope.success ? CreateInvoiceOutputSchema.safeParse(envelope.data.data) : null;
  if (response.status !== 200 || !output?.success) {
    throw new AccountingApiError(response.status, "The Go Accounting service returned an unexpected invoice response.", true);
  }
  await clearAccountingCreateInvoiceAttempt(attempt.storageKey);
  return { kind: "completed" };
}

function createInvoiceCapabilityInput(action: AccountingCreateInvoiceAction): Record<string, unknown> {
  const { action: _action, ...input } = action;
  return input;
}

async function submitGoAccountingRecordPayment(
  action: AccountingRecordPaymentAction,
  scope: { actorId: string; organizationId: string; scopeHash: string },
  signal?: AbortSignal,
): Promise<AccountingActionOutcome> {
  const attempt = await accountingRecordPaymentAttempt(action, scope.scopeHash);
  let response: Response;
  let body: unknown;
  try {
    ({ response, body } = await getJson("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({ capabilityId: "accounting.recordPayment", input: recordPaymentCapabilityInput(action), intentId: attempt.intentId }),
    }, signal));
  } catch (error) {
    if (error instanceof AccountingApiError) throw new AccountingApiError(error.status, error.message, true);
    throw new AccountingApiError(0, "The Go Accounting service could not confirm this payment. Retry the same payment to recover its result.", true);
  }
  if (response.status === 202) {
    const parsed = PendingSchema.safeParse(body);
    if (!parsed.success) throw new AccountingApiError(202, "The Go Accounting service returned an invalid payment approval response.", true);
    return { kind: "pending", reason: parsed.data.reason ?? parsed.data.error ?? "This payment is waiting for approval." };
  }
  if (!response.ok) {
    const uncertain = response.status === 404 || response.status >= 500 || response.status === 408 || response.status === 429;
    if (!uncertain) await clearAccountingRecordPaymentAttempt(attempt.storageKey);
    throw new AccountingApiError(response.status, errorMessage(response.status, body, "record this invoice payment"), uncertain);
  }
  const envelope = EnvelopeSchema.safeParse(body);
  const output = envelope.success ? RecordPaymentOutputSchema.safeParse(envelope.data.data) : null;
  if (response.status !== 200 || !output?.success) {
    throw new AccountingApiError(response.status, "The Go Accounting service returned an unexpected payment response.", true);
  }
  await clearAccountingRecordPaymentAttempt(attempt.storageKey);
  return { kind: "completed" };
}

function recordPaymentCapabilityInput(action: AccountingRecordPaymentAction): Record<string, unknown> {
  const { action: _action, ...input } = action;
  return input;
}

async function accountingPaymentScope(scope: AccountingPaymentRetryScope): Promise<{ actorId: string; organizationId: string; scopeHash: string }> {
  const actorId = scope.actorId?.trim() ?? "";
  const organizationId = scope.organizationId?.trim() ?? "";
  if (!z.string().uuid().safeParse(actorId).success || !z.string().uuid().safeParse(organizationId).success) {
    throw new AccountingApiError(0, "Accounting writes are waiting for your account and organization details. Wait for your organization to finish loading, then try again.");
  }
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ actorId, organizationId })));
    return { actorId, organizationId, scopeHash: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("") };
  } catch {
    throw new AccountingApiError(0, "Could not prepare a durable payment retry. Check browser security settings and try again.");
  }
}

async function accountingRecordPaymentAttempt(action: AccountingRecordPaymentAction, scopeHash: string): Promise<{ storageKey: string; intentId: string }> {
  const storageKey = `${RECORD_PAYMENT_ATTEMPT_PREFIX}${scopeHash}`;
  const fingerprint = await accountingPaymentFingerprint(action);
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new AccountingApiError(0, "Enable browser storage before recording a payment so it can be retried safely."); }
  if (raw !== null) {
    const stored = parseStoredRecordPayment(raw);
    if (stored.fingerprint !== fingerprint) throw new AccountingApiError(0, "A previous invoice payment is unresolved. Retry its exact details before recording another payment.", true);
    return { storageKey, intentId: stored.intentId };
  }
  const stored = { action, intentId: crypto.randomUUID(), fingerprint };
  const serialized = JSON.stringify(stored);
  try {
    window.localStorage.setItem(storageKey, serialized);
    if (window.localStorage.getItem(storageKey) !== serialized) throw new Error("payment retry marker did not persist");
  } catch {
    throw new AccountingApiError(0, "Enable browser storage before recording a payment so it can be retried safely.");
  }
  return { storageKey, intentId: stored.intentId };
}

async function accountingCreateInvoiceAttempt(action: AccountingCreateInvoiceAction, scopeHash: string): Promise<{ storageKey: string; intentId: string }> {
  const storageKey = `${CREATE_INVOICE_ATTEMPT_PREFIX}${scopeHash}`;
  const fingerprint = await accountingPaymentFingerprint(action);
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new AccountingApiError(0, "Enable browser storage before creating an invoice so it can be retried safely."); }
  if (raw !== null) {
    const stored = parseStoredCreateInvoice(raw);
    if (stored.fingerprint !== fingerprint) throw new AccountingApiError(0, "A previous invoice creation is unresolved. Retry its exact details before creating another invoice.", true);
    return { storageKey, intentId: stored.intentId };
  }
  const stored = { action, intentId: crypto.randomUUID(), fingerprint };
  const serialized = JSON.stringify(stored);
  try {
    window.localStorage.setItem(storageKey, serialized);
    if (window.localStorage.getItem(storageKey) !== serialized) throw new Error("invoice retry marker did not persist");
  } catch {
    throw new AccountingApiError(0, "Enable browser storage before creating an invoice so it can be retried safely.");
  }
  return { storageKey, intentId: stored.intentId };
}

async function accountingCreditNoteAttempt(action: AccountingCreditNoteAction, scopeHash: string): Promise<{ storageKey: string; intentId: string }> {
  const storageKey = `${CREDIT_NOTE_ATTEMPT_PREFIX}${scopeHash}`;
  const fingerprint = await accountingPaymentFingerprint(action);
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new AccountingApiError(0, "Enable browser storage before applying a credit so it can be retried safely."); }
  if (raw !== null) {
    const stored = parseStoredCreditNote(raw);
    if (stored.fingerprint !== fingerprint) throw new AccountingApiError(0, "A previous credit note is unresolved. Retry its exact details before creating another credit.", true);
    return { storageKey, intentId: stored.intentId };
  }
  const stored = { action, intentId: crypto.randomUUID(), fingerprint };
  const serialized = JSON.stringify(stored);
  try {
    window.localStorage.setItem(storageKey, serialized);
    if (window.localStorage.getItem(storageKey) !== serialized) throw new Error("credit note retry marker did not persist");
  } catch {
    throw new AccountingApiError(0, "Enable browser storage before applying a credit so it can be retried safely.");
  }
  return { storageKey, intentId: stored.intentId };
}

async function accountingPaymentFingerprint(action: unknown): Promise<string> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(action)));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    throw new AccountingApiError(0, "Could not prepare a durable payment retry. Check browser security settings and try again.");
  }
}

function parseStoredRecordPayment(raw: string): z.infer<typeof StoredRecordPaymentSchema> {
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch { throw new AccountingApiError(0, "An unresolved invoice payment marker is malformed. Contact an administrator before retrying.", true); }
  const parsed = StoredRecordPaymentSchema.safeParse(decoded);
  if (!parsed.success) throw new AccountingApiError(0, "An unresolved invoice payment marker is malformed. Contact an administrator before retrying.", true);
  return parsed.data;
}

function parseStoredCreateInvoice(raw: string): z.infer<typeof StoredCreateInvoiceSchema> {
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch { throw new AccountingApiError(0, "An unresolved invoice creation marker is malformed. Contact an administrator before retrying.", true); }
  const parsed = StoredCreateInvoiceSchema.safeParse(decoded);
  if (!parsed.success) throw new AccountingApiError(0, "An unresolved invoice creation marker is malformed. Contact an administrator before retrying.", true);
  return parsed.data;
}

function parseStoredCreditNote(raw: string): z.infer<typeof StoredCreditNoteSchema> {
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch { throw new AccountingApiError(0, "An unresolved credit note marker is malformed. Contact an administrator before retrying.", true); }
  const parsed = StoredCreditNoteSchema.safeParse(decoded);
  if (!parsed.success) throw new AccountingApiError(0, "An unresolved credit note marker is malformed. Contact an administrator before retrying.", true);
  return parsed.data;
}

async function clearAccountingRecordPaymentAttempt(storageKey: string): Promise<void> {
  try { window.localStorage.removeItem(storageKey); }
  catch { throw new AccountingApiError(0, "The payment completed, but its retry marker could not be cleared. Reload before recording another payment.", true); }
}

async function clearAccountingCreateInvoiceAttempt(storageKey: string): Promise<void> {
  try { window.localStorage.removeItem(storageKey); }
  catch { throw new AccountingApiError(0, "The invoice completed, but its retry marker could not be cleared. Reload before creating another invoice.", true); }
}

async function clearAccountingCreditNoteAttempt(storageKey: string): Promise<void> {
  try { window.localStorage.removeItem(storageKey); }
  catch { throw new AccountingApiError(0, "The credit note completed, but its retry marker could not be cleared. Reload before creating another credit.", true); }
}

export async function emailInvoice(invoiceNumber: number, to: string, signal?: AbortSignal): Promise<{ urlPath: string | null }> {
  if (!Number.isSafeInteger(invoiceNumber) || invoiceNumber <= 0) {
    throw new AccountingApiError(400, "Choose an invoice to email.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())) {
    throw new AccountingApiError(400, "Enter a valid email address.");
  }
  const { response, body } = await getJson("/api/email", {
    method: "POST",
    body: JSON.stringify({ action: "emailInvoice", invoiceNumber, to: to.trim() }),
  }, signal);
  if (!response.ok) throw new AccountingApiError(response.status, errorMessage(response.status, body, "email this invoice"));
  const parsed = z.object({ sent: z.literal(true), urlPath: z.string().nullable().optional() }).safeParse(body);
  if (!parsed.success) throw new AccountingApiError(response.status, "The email service returned an unexpected response.");
  return { urlPath: parsed.data.urlPath ?? null };
}
