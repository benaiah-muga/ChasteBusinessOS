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
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "AccountingApiError";
  }
}

/** Governed writes answer 202 while they wait in the Approvals inbox. */
export type AccountingActionOutcome =
  | { kind: "completed" }
  | { kind: "pending"; reason: string };

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
): Promise<AccountingActionOutcome> {
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