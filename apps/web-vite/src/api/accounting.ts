import { z } from "zod";
import { normalizeRetryActorId } from "./retry-scope";
import { payPurchasingBill } from "./purchasing";

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

const GoEntrySchema = EntrySchema.extend({ debitMinor: minor }).strict();

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

const GoAccountingOverviewSchema = AccountingOverviewSchema.extend({ entries: z.array(GoEntrySchema) }).strict();

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
    latestRateNum: z.number().safe().int().positive().nullable(),
    latestRateDen: z.number().safe().int().positive().nullable(),
    outstandingBaseMinor: minor.nullable(),
  }).strict().refine((exposure) => {
    const hasRate = exposure.latestRateNum !== null && exposure.latestRateDen !== null && exposure.outstandingBaseMinor !== null;
    const hasNoRate = exposure.latestRateNum === null && exposure.latestRateDen === null && exposure.outstandingBaseMinor === null;
    return hasRate || hasNoRate;
  }),
  ),
}).strict();

const ReportCurrencyMetadataSchema = z.object({
  baseCurrency: currency,
  unsupportedCurrencies: z.array(currency),
}).strict().refine((metadata) => {
  const sorted = [...metadata.unsupportedCurrencies].sort();
  return metadata.unsupportedCurrencies.every((code) => code !== metadata.baseCurrency) &&
    new Set(metadata.unsupportedCurrencies).size === metadata.unsupportedCurrencies.length &&
    metadata.unsupportedCurrencies.every((code, index) => code === sorted[index]);
});

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
  matched: z.array(BankTransactionSchema),
  excluded: z.array(BankTransactionSchema),
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

const GoBudgetScenarioSchema = BudgetScenarioSchema.extend({
  id: z.string().uuid(),
  key: z.string().min(1),
  currency,
  assumptions: z.object({
    collectionDelayDays: z.number().int().safe(),
    spendUpliftBasisPoints: z.number().int().safe(),
    expectedMonthlyInflowMinor: minor,
    expectedMonthlyOutflowMinor: minor,
    minimumCashBufferMinor: minor,
  }).strict(),
  createdAt: timestamp,
}).strict();

const GoBudgetScenariosSchema = z.object({
  scenarios: z.array(GoBudgetScenarioSchema),
}).strict();

const BudgetActualVsPlanLineSchema = z.object({
  accountCode: z.string().regex(/^\d{4}$/),
  accountName: z.string(),
  accountType: z.enum(["income", "expense"]),
  planMinor: minor,
  actualMinor: minor,
  committedMinor: minor,
  projectedMinor: minor,
  varianceMinor: minor,
  utilizationBps: z.number().int().safe().nullable(),
}).strict();

const BudgetActualVsPlanSchema = z.object({
  scenarioId: z.string().uuid(),
  name: z.string(),
  fiscalYear: z.number().int().min(2000).max(2100),
  currency,
  unconvertedEntryCount: z.number().int().safe().nonnegative(),
  months: z.array(z.object({
    month: z.number().int().min(1).max(12),
    lines: z.array(BudgetActualVsPlanLineSchema),
  }).strict()).length(12),
}).strict();

const CashBasisSchema = z.object({
  cashInMinor: minor,
  cashOutMinor: minor,
  netCashMinor: minor,
  accrualRevenueMinor: minor,
  uncollectedMinor: minor,
}).strict();

const GoCashBasisSchema = z.object({
  cashInMinor: minor,
  cashOutMinor: minor,
  netCashMinor: minor,
  accrualRevenueMinor: minor,
  accrualExpenseMinor: minor,
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
      date: timestamp,
      kind: z.string().min(1),
      ref: z.string(),
      amountMinor: minor,
      balanceMinor: minor,
    }).strict()),
  }).strict()),
}).strict();

const ErrorResponseSchema = z.object({ error: z.string().optional(), message: z.string().optional() });
const EnvelopeSchema = z.object({ ok: z.literal(true), data: z.unknown() }).strict();
const CapabilityErrorSchema = z.object({ ok: z.literal(false), error: z.string() }).strict();
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
const ReverseEntryActionSchema = z.object({
  action: z.literal("reverse"),
  entryId: z.string().uuid(),
}).strict();
const StoredReverseEntrySchema = z.object({
  action: ReverseEntryActionSchema,
  intentId: z.string().uuid(),
  fingerprint: z.string().length(64),
}).strict();
const ReverseEntryOutputSchema = z.object({ reversalEntryId: z.string().uuid() }).strict();
const REVERSE_ENTRY_ATTEMPT_PREFIX = "chaste:accounting:reverse-entry:go:attempt:v1:";
const ReversePaymentActionSchema = z.object({
  action: z.literal("reversePayment"),
  paymentId: z.string().uuid(),
  reason: z.string().min(3).max(500),
}).strict();
const StoredReversePaymentSchema = z.object({
  action: ReversePaymentActionSchema,
  intentId: z.string().uuid(),
  fingerprint: z.string().length(64),
}).strict();
const ReversePaymentOutputSchema = z.object({
  reversalEntryIds: z.array(z.string().uuid()),
  refundedMinor: minor,
  invoiceNumber: z.number().int().safe(),
  outstandingMinor: minor,
}).strict();
const REVERSE_PAYMENT_ATTEMPT_PREFIX = "chaste:accounting:reverse-payment:go:attempt:v1:";
const CloseYearActionSchema = z.object({
  action: z.literal("closeYear"),
  year: z.number().int().safe().min(2000).max(2100),
}).strict();
const ReopenPeriodActionSchema = z.object({
  action: z.literal("reopenPeriod"),
  year: z.number().int().safe().min(2000).max(2100),
  month: z.number().int().safe().min(1).max(12),
}).strict();
const RecordFxRateActionSchema = z.object({
  action: z.literal("recordFxRate"),
  quoteCurrency: z.string().regex(/^[A-Za-z]{3}$/).transform((value) => value.toUpperCase()),
  rate: z.string().regex(/^(?:\d+)(?:\.\d+)?$/).refine((value) => Number.isFinite(Number(value)) && Number(value) > 0),
  effectiveAt: timestamp.optional(),
}).strict();
const RevalueForeignReceivablesActionSchema = z.object({
  action: z.literal("revalueForeignReceivables"),
  year: z.number().int().safe().min(2000).max(2100),
  month: z.number().int().safe().min(1).max(12),
}).strict();
const PeriodFxWriteActionSchema = z.discriminatedUnion("action", [ReopenPeriodActionSchema, RecordFxRateActionSchema, RevalueForeignReceivablesActionSchema]);
const StoredPeriodFxWriteSchema = z.object({
  action: PeriodFxWriteActionSchema,
  intentId: z.string().uuid(),
  fingerprint: z.string().length(64),
}).strict();
const ReopenPeriodOutputSchema = z.object({ reopened: z.literal(true) }).strict();
const RecordFxRateOutputSchema = z.object({
  rateId: z.string().uuid(),
  num: z.number().int().safe().positive(),
  den: z.number().int().safe().positive(),
}).strict();
const RevalueForeignReceivablesOutputSchema = z.object({
  revaluationId: z.string().uuid(),
  entryId: z.string().uuid().nullable(),
  totalAdjustmentMinor: z.number().int().safe(),
  currencies: z.array(z.object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    foreignMinor: minor,
    historicalBaseMinor: minor,
    closeBaseMinor: minor,
    adjustmentMinor: z.number().int().safe(),
    rateNum: z.number().int().safe().positive(),
    rateDen: z.number().int().safe().positive(),
  }).strict()),
  alreadyReviewed: z.boolean(),
}).strict();
const PERIOD_FX_WRITE_ATTEMPT_PREFIX = "chaste:accounting:period-fx-write:go:attempt:v1:";
const StoredCloseYearSchema = z.object({
  action: CloseYearActionSchema,
  intentId: z.string().uuid(),
  fingerprint: z.string().length(64),
}).strict();
const CloseYearOutputSchema = z.object({
  closingEntryId: z.string().uuid(),
  replacedEntryId: z.string().uuid().nullable(),
  netIncomeMinor: minor,
  retainedEarningsMinor: minor,
}).strict();
const CLOSE_YEAR_ATTEMPT_PREFIX = "chaste:accounting:close-year:go:attempt:v1:";
const MatchBankTransactionActionSchema = z.object({
  action: z.literal("matchBankTransaction"),
  transactionId: z.string().uuid(),
  paymentId: z.string().uuid().optional(),
  entryId: z.string().uuid().optional(),
  amountMinor: z.number().int().positive().safe().optional(),
  feeMinor: z.number().int().positive().safe().optional(),
  fxGainLossMinor: z.number().int().safe().optional(),
  note: z.string().max(500).optional(),
}).strict().refine((action) => (action.paymentId !== undefined) !== (action.entryId !== undefined), "Pass exactly one of paymentId or entryId.")
  .refine((action) => action.feeMinor === undefined || action.paymentId !== undefined, "feeMinor requires paymentId.")
  .refine((action) => action.fxGainLossMinor === undefined || action.paymentId !== undefined, "fxGainLossMinor requires paymentId.")
  .refine((action) => action.amountMinor === undefined || (action.feeMinor === undefined && action.fxGainLossMinor === undefined), "amountMinor cannot be combined with fee or FX adjustments.");
const UnmatchBankTransactionActionSchema = z.object({
  action: z.literal("unmatchBankTransaction"),
  transactionId: z.string().uuid(),
}).strict();
const AddBankAccountActionSchema = z.object({
  action: z.literal("addBankAccount"),
  name: z.string().min(1),
  currencyCode: z.string().length(3).optional(),
  last4: z.string().regex(/^\d{4}$/).optional(),
  balanceMinor: minor.optional(),
}).strict();
const ImportBankFeedActionSchema = z.object({
  action: z.literal("importBankFeed"),
  bankAccountId: z.string().uuid().optional(),
  rows: z.array(z.object({
    postedAt: day,
    amountMinor: minor,
    description: z.string().min(1),
  }).strict()).min(1).max(500),
}).strict();
const TransactionId = z.string().uuid();
const ExcludeBankTransactionActionSchema = z.object({
  action: z.literal("excludeBankTransaction"),
  transactionId: TransactionId,
}).strict();
const UnexcludeBankTransactionActionSchema = z.object({
  action: z.literal("unexcludeBankTransaction"),
  transactionId: TransactionId,
}).strict();
const DeleteBankTransactionActionSchema = z.object({
  action: z.literal("deleteBankTransaction"),
  transactionId: TransactionId,
}).strict();
const BankReconciliationWriteActionSchema = z.discriminatedUnion("action", [
  AddBankAccountActionSchema,
  ImportBankFeedActionSchema,
  MatchBankTransactionActionSchema,
  UnmatchBankTransactionActionSchema,
  ExcludeBankTransactionActionSchema,
  UnexcludeBankTransactionActionSchema,
  DeleteBankTransactionActionSchema,
]);
const StoredBankReconciliationWriteSchema = z.object({
  action: BankReconciliationWriteActionSchema,
  intentId: z.string().uuid(),
  fingerprint: z.string().length(64),
}).strict();
const MatchBankTransactionOutputSchema = z.object({
  status: z.literal("matched"),
  allocatedMinor: minor,
  lineUnexplainedMinor: minor,
}).strict();
const UnmatchBankTransactionOutputSchema = z.object({
  status: z.literal("unmatched"),
  releasedMinor: minor,
}).strict();
const AddBankAccountOutputSchema = z.object({ bankAccountId: z.string().uuid() }).strict();
const ImportBankFeedOutputSchema = z.object({ inserted: z.number().int().nonnegative().safe(), skipped: z.number().int().nonnegative().safe() }).strict();
const ExcludeBankTransactionOutputSchema = z.object({ status: z.literal("excluded") }).strict();
const UnexcludeBankTransactionOutputSchema = z.object({ status: z.literal("unmatched") }).strict();
const DeleteBankTransactionOutputSchema = z.object({ deleted: z.boolean() }).strict();
const BANK_RECONCILIATION_WRITE_ATTEMPT_PREFIX = "chaste:accounting:bank-reconciliation:go:attempt:v1:";

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
export type AccountingBudgetActualVsPlan = z.infer<typeof BudgetActualVsPlanSchema>;
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
  | { kind: "completed"; fxRevaluation?: AccountingFxRevaluationResult }
  | { kind: "pending"; reason: string };

export type AccountingRecordPaymentAction = z.infer<typeof RecordPaymentActionSchema>;
export type AccountingPaymentRetryScope = { actorId: string | null; organizationId: string | null };
export type AccountingCreateInvoiceAction = z.infer<typeof CreateInvoiceActionSchema>;
export type AccountingCreditNoteAction = z.infer<typeof CreditNoteActionSchema>;
export type AccountingReverseEntryAction = z.infer<typeof ReverseEntryActionSchema>;
export type AccountingReversePaymentAction = z.infer<typeof ReversePaymentActionSchema>;
export type AccountingBankReconciliationWriteAction = z.infer<typeof BankReconciliationWriteActionSchema>;
export type AccountingPeriodFxWriteAction = z.infer<typeof PeriodFxWriteActionSchema>;
export type AccountingFxRevaluationResult = z.infer<typeof RevalueForeignReceivablesOutputSchema>;

export async function readPendingAccountingBankReconciliationWrite(scope: AccountingPaymentRetryScope): Promise<AccountingBankReconciliationWriteAction | null> {
  const { scopeHash } = await accountingPaymentScope(scope);
  const storageKey = `${BANK_RECONCILIATION_WRITE_ATTEMPT_PREFIX}${scopeHash}`;
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new AccountingApiError(0, "Enable browser storage to recover an unresolved bank reconciliation action.", true); }
  if (raw === null) return null;
  return parseStoredBankReconciliationWrite(raw).action;
}

export async function readPendingAccountingCloseYear(scope: AccountingPaymentRetryScope): Promise<number | null> {
  const { scopeHash } = await accountingPaymentScope(scope);
  const storageKey = `${CLOSE_YEAR_ATTEMPT_PREFIX}${scopeHash}`;
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new AccountingApiError(0, "Enable browser storage to recover an unresolved year-end close.", true); }
  if (raw === null) return null;
  return parseStoredCloseYear(raw).action.year;
}

export async function readPendingAccountingPeriodFxWrite(scope: AccountingPaymentRetryScope): Promise<AccountingPeriodFxWriteAction | null> {
  const { scopeHash } = await accountingPaymentScope(scope);
  const storageKey = `${PERIOD_FX_WRITE_ATTEMPT_PREFIX}${scopeHash}`;
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new AccountingApiError(0, "Enable browser storage to recover an unresolved Accounting period or FX write.", true); }
  if (raw === null) return null;
  return parseStoredPeriodFxWrite(raw).action;
}

export async function readPendingAccountingReverseEntry(scope: AccountingPaymentRetryScope): Promise<AccountingReverseEntryAction | null> {
  const { scopeHash } = await accountingPaymentScope(scope);
  const storageKey = `${REVERSE_ENTRY_ATTEMPT_PREFIX}${scopeHash}`;
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new AccountingApiError(0, "Enable browser storage to recover an unresolved journal reversal.", true); }
  if (raw === null) return null;
  return parseStoredReverseEntry(raw).action;
}

export async function readPendingAccountingReversePayment(scope: AccountingPaymentRetryScope): Promise<AccountingReversePaymentAction | null> {
  const { scopeHash } = await accountingPaymentScope(scope);
  const storageKey = `${REVERSE_PAYMENT_ATTEMPT_PREFIX}${scopeHash}`;
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new AccountingApiError(0, "Enable browser storage to recover an unresolved payment reversal.", true); }
  if (raw === null) return null;
  return parseStoredReversePayment(raw).action;
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

function requireAccountingOrganization(organizationId: string | null | undefined, context: string): string {
  const orgId = organizationId?.trim() ?? "";
  if (!z.string().uuid().safeParse(orgId).success) {
    throw new AccountingApiError(0, `Wait for your organization to finish loading before you ${context}.`);
  }
  return orgId;
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

export async function fetchAccountingOverview(organizationId: string | null | undefined, signal?: AbortSignal): Promise<AccountingOverview> {
  const orgId = requireAccountingOrganization(organizationId, "load your books");
  return readGoAccountingCapability(
    "accounting.overview",
    {},
    GoAccountingOverviewSchema,
    "load your books",
    signal,
    orgId,
  );
}

export async function fetchAccountingReports(organizationId: string | null | undefined, signal?: AbortSignal): Promise<AccountingReports> {
  const orgId = requireAccountingOrganization(organizationId, "load Accounting reports");
  const [pnl, balanceSheet, cashFlow, fxExposure, metadata] = await Promise.all([
    readGoAccountingReport("accounting.incomeStatement", PnlSchema, "income statement", orgId, signal),
    readGoAccountingReport("accounting.balanceSheet", BalanceSheetSchema, "balance sheet", orgId, signal),
    readGoAccountingReport("accounting.cashFlow", CashFlowSchema, "cash flow statement", orgId, signal, true),
    readGoAccountingReport("accounting.unrealizedFxExposure", FxExposureSchema, "foreign exchange exposure", orgId, signal),
    readGoAccountingReport("accounting.reportCurrencyMetadata", ReportCurrencyMetadataSchema, "report currency metadata", orgId, signal),
  ]);
  if (!pnl || !balanceSheet || !metadata) throw new AccountingApiError(503, "A required Accounting report was unavailable.");
  const aggregate = AccountingReportsSchema.safeParse({
    baseCurrency: metadata.baseCurrency,
    unsupportedCurrencies: metadata.unsupportedCurrencies,
    pnl,
    balanceSheet,
    cashFlow,
    fxExposure,
  });
  if (!aggregate.success) throw new AccountingApiError(200, "The Accounting service returned data in an unexpected format.");
  return aggregate.data;
}

async function readGoAccountingReport<T>(
  capabilityId: "accounting.incomeStatement" | "accounting.balanceSheet" | "accounting.cashFlow" | "accounting.unrealizedFxExposure" | "accounting.reportCurrencyMetadata",
  schema: z.ZodType<T>,
  subject: string,
  organizationId: string,
  signal?: AbortSignal,
  optional = false,
): Promise<T | null> {
  const { response, body } = await getJson("/api/capabilities/execute", {
    method: "POST",
    cache: "no-store",
    headers: { "X-Organization-ID": organizationId },
    body: JSON.stringify({ capabilityId, input: {}, intentId: crypto.randomUUID() }),
  }, signal);
  if (response.status === 422) {
    const error = CapabilityErrorSchema.safeParse(body);
    if (!error.success) throw new AccountingApiError(503, "The Accounting reports service returned an unexpected response.");
    if (optional && error.data.error.startsWith("forbidden:")) {
      throw new AccountingApiError(response.status, error.data.error.slice(0, 240));
    }
    if (optional) return null;
    throw new AccountingApiError(response.status, error.data.error.slice(0, 240));
  }
  if (response.status !== 200) {
    throw new AccountingApiError(response.status, errorMessage(response.status, body, `load ${subject}`));
  }
  const envelope = EnvelopeSchema.safeParse(body);
  if (!envelope.success) throw new AccountingApiError(response.status, "The Accounting reports service returned an unexpected response.");
  const parsed = schema.safeParse(envelope.data.data);
  if (!parsed.success) throw new AccountingApiError(response.status, "The Accounting reports service returned an unexpected result.");
  return parsed.data;
}

/** Cash basis and bank feeds are auxiliary: a failure must never blank the books. */
export async function fetchAccountingCashBasis(year: number, organizationId: string | null | undefined, signal?: AbortSignal): Promise<AccountingCashBasis | null> {
  if (!Number.isSafeInteger(year) || year < 2000 || year > 2100) {
    throw new AccountingApiError(400, "Choose a valid reporting year.");
  }
  const orgId = requireAccountingOrganization(organizationId, "load the cash-basis summary");
  try {
    const result = await readGoAccountingCapability(
      "accounting.cashBasisReport",
      { year },
      GoCashBasisSchema,
      "load the cash-basis summary",
      signal,
      orgId,
    );
    const projected = CashBasisSchema.safeParse({
      cashInMinor: result.cashInMinor,
      cashOutMinor: result.cashOutMinor,
      netCashMinor: result.netCashMinor,
      accrualRevenueMinor: result.accrualRevenueMinor,
      uncollectedMinor: result.uncollectedMinor,
    });
    return projected.success ? projected.data : null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

export async function fetchAccountingBanking(organizationId: string | null | undefined, signal?: AbortSignal): Promise<AccountingBanking> {
  const orgId = requireAccountingOrganization(organizationId, "load bank feeds");
  return readGoAccountingCapability(
    "accounting.listBankingWorkspace",
    {},
    BankingSchema,
    "load bank feeds",
    signal,
    orgId,
  );
}

export async function fetchAccountingTaxCodes(signal?: AbortSignal): Promise<AccountingTaxCode[]> {
  const { codes } = await readGoAccountingCapability(
    "accounting.listTaxCodes",
    {},
    TaxCodesSchema,
    "load the tax codes",
    signal,
  );
  return codes.filter((code) => code.active && code.direction === "output");
}

export async function fetchAccountingBudgetScenarios(signal?: AbortSignal): Promise<AccountingBudgetScenario[]> {
  const result = await readGoAccountingCapability(
    "accounting.listBudgetScenarios",
    {},
    GoBudgetScenariosSchema,
    "load budget scenarios",
    signal,
  );
  return result.scenarios.map(({ id, name, fiscalYear, version, isCurrent }) => ({ id, name, fiscalYear, version, isCurrent }));
}

export async function fetchBudgetActualVsPlan(scenarioId: string, signal?: AbortSignal): Promise<AccountingBudgetActualVsPlan> {
  if (!z.string().uuid().safeParse(scenarioId).success) {
    throw new AccountingApiError(400, "Choose a valid budget scenario.");
  }
  return readGoAccountingCapability(
    "accounting.budgetActualVsPlan",
    { scenarioId },
    BudgetActualVsPlanSchema,
    "compare budget actuals and commitments",
    signal,
  );
}

async function readGoAccountingCapability<T>(
  capabilityId: "accounting.cashForecast" | "accounting.listBudgetScenarios" | "accounting.budgetActualVsPlan" | "accounting.listTaxCodes" | "accounting.buildReminders" | "accounting.cashBasisReport" | "accounting.overview" | "accounting.bankSummary" | "accounting.listBankingWorkspace",
  input: Record<string, unknown>,
  schema: z.ZodType<T>,
  context: string,
  signal?: AbortSignal,
  organizationId?: string,
): Promise<T> {
  const { response, body } = await getJson("/api/capabilities/execute", {
    method: "POST",
    cache: "no-store",
    ...(organizationId ? { headers: { "X-Organization-ID": organizationId } } : {}),
    body: JSON.stringify({ capabilityId, input, intentId: crypto.randomUUID() }),
  }, signal);
  if (response.status === 422) {
    const error = CapabilityErrorSchema.safeParse(body);
    if (!error.success) throw new AccountingApiError(503, "The Go Accounting service returned an unexpected response.");
    throw new AccountingApiError(response.status, error.data.error.slice(0, 240));
  }
  if (response.status !== 200) {
    throw new AccountingApiError(response.status, errorMessage(response.status, body, context));
  }
  const envelope = EnvelopeSchema.safeParse(body);
  if (!envelope.success) throw new AccountingApiError(response.status, "The Go Accounting service returned an unexpected response.");
  const parsed = schema.safeParse(envelope.data.data);
  if (!parsed.success) throw new AccountingApiError(response.status, "The Go Accounting service returned an unexpected result.");
  return parsed.data;
}

export async function fetchCashForecast(budgetScenarioId: string, signal?: AbortSignal): Promise<AccountingForecast> {
  if (budgetScenarioId && !z.string().uuid().safeParse(budgetScenarioId).success) {
    throw new AccountingApiError(400, "Choose a valid budget scenario.");
  }
  return readGoAccountingCapability(
    "accounting.cashForecast",
    budgetScenarioId ? { budgetScenarioId } : {},
    ForecastSchema,
    "compute the cash forecast",
    signal,
  );
}

export async function fetchPaymentReminders(signal?: AbortSignal): Promise<AccountingReminder[]> {
  const result = await readGoAccountingCapability("accounting.buildReminders", {}, RemindersSchema, "draft payment reminders", signal);
  return result.reminders;
}

export async function fetchCustomerStatement(customerId: string, signal?: AbortSignal): Promise<AccountingStatement> {
  if (!customerId) throw new AccountingApiError(400, "Choose a customer before loading a statement.");
  if (!z.string().uuid().safeParse(customerId).success) {
    throw new AccountingApiError(400, "Choose a valid customer before loading a statement.");
  }
  return readGoCustomerStatement(customerId, signal);
}

async function readGoCustomerStatement(customerId: string, signal?: AbortSignal): Promise<AccountingStatement> {
  const { response, body } = await getJson("/api/capabilities/execute", {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify({
      capabilityId: "accounting.customerStatement",
      input: { customerId },
      intentId: crypto.randomUUID(),
    }),
  }, signal);
  if (response.status === 202) {
    const pending = PendingSchema.safeParse(body);
    if (!pending.success) throw new AccountingApiError(503, "The customer statement service returned an unexpected pending response.");
    throw new AccountingApiError(202, pending.data.reason ?? pending.data.error ?? "The customer statement request is pending approval.");
  }
  if (response.status === 422) {
    const error = CapabilityErrorSchema.safeParse(body);
    if (!error.success) throw new AccountingApiError(503, "The customer statement service returned an unexpected response.");
    throw new AccountingApiError(response.status, error.data.error.slice(0, 240));
  }
  if (response.status !== 200) {
    throw new AccountingApiError(response.status, errorMessage(response.status, body, "load this customer statement"));
  }
  const envelope = EnvelopeSchema.safeParse(body);
  if (!envelope.success) throw new AccountingApiError(response.status, "The customer statement service returned an unexpected response.");
  const parsed = StatementSchema.safeParse(envelope.data.data);
  if (!parsed.success) throw new AccountingApiError(response.status, "The customer statement service returned data in an unexpected format.");
  return parsed.data;
}

/**
 * Governed write. Bill payments use the purchasing capability and carry a
 * scope-derived retry identity, while other actions use their own routes.
 */
export async function submitAccountingAction(
  path: "/api/accounting" | "/api/banking",
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  retryScope?: AccountingPaymentRetryScope,
): Promise<AccountingActionOutcome> {
  if (path === "/api/accounting" && payload.action === "payBill") {
    const { intentId: _uiAttemptId, ...payment } = payload;
    const outcome = await payPurchasingBill(payment, signal, retryScope);
    return outcome.kind === "pending" ? outcome : { kind: "completed" };
  }
  if (path === "/api/accounting" && payload.action === "closeYear") {
    const action = CloseYearActionSchema.safeParse(payload);
    if (!action.success) throw new AccountingApiError(400, "Choose a valid fiscal year before closing the books.");
    const scoped = await accountingPaymentScope(retryScope ?? { actorId: null, organizationId: null });
    return submitGoAccountingCloseYear(action.data, scoped, signal);
  }
  if (path === "/api/accounting" && (payload.action === "reopenPeriod" || payload.action === "recordFxRate" || payload.action === "revalueForeignReceivables")) {
    const action = PeriodFxWriteActionSchema.safeParse(payload);
    if (!action.success) throw new AccountingApiError(400, "Enter a valid Accounting period or FX action before submitting.");
    const scoped = await accountingPaymentScope(retryScope ?? { actorId: null, organizationId: null });
    return submitGoAccountingPeriodFxWrite(action.data, scoped, signal);
  }
  if (path === "/api/banking") {
    const action = BankReconciliationWriteActionSchema.safeParse(payload);
    if (!action.success) throw new AccountingApiError(400, "Enter a valid bank action before submitting.");
    const scoped = await accountingPaymentScope(retryScope ?? { actorId: null, organizationId: null });
    return submitGoBankReconciliationWrite(action.data, scoped, signal);
  }
  if (path === "/api/accounting" && payload.action === "reverse") {
    const action = ReverseEntryActionSchema.safeParse(payload);
    if (!action.success) throw new AccountingApiError(400, "Choose a valid journal entry before submitting its reversal.");
    const scoped = await accountingPaymentScope(retryScope ?? { actorId: null, organizationId: null });
    return submitGoAccountingReverseEntry(action.data, scoped, signal);
  }
  if (path === "/api/accounting" && payload.action === "creditNote") {
    const action = CreditNoteActionSchema.safeParse(payload);
    if (!action.success) throw new AccountingApiError(400, "Enter a valid credit note before submitting.");
    const scoped = await accountingPaymentScope(retryScope ?? { actorId: null, organizationId: null });
    return submitGoAccountingCreditNote(action.data, scoped, signal);
  }
  if (path === "/api/accounting" && payload.action === "createInvoice") {
    const action = CreateInvoiceActionSchema.safeParse(payload);
    if (!action.success) throw new AccountingApiError(400, "Enter a valid invoice before submitting.");
    const scoped = await accountingPaymentScope(retryScope ?? { actorId: null, organizationId: null });
    return submitGoAccountingCreateInvoice(action.data, scoped, signal);
  }
  if (path === "/api/accounting" && payload.action === "recordPayment") {
    const action = RecordPaymentActionSchema.safeParse(payload);
    if (!action.success) throw new AccountingApiError(400, "Enter a valid invoice payment before submitting.");
    const scoped = await accountingPaymentScope(retryScope ?? { actorId: null, organizationId: null });
    return submitGoAccountingRecordPayment(action.data, scoped, signal);
  }
  if (path === "/api/accounting" && payload.action === "reversePayment") {
    const action = ReversePaymentActionSchema.safeParse(payload);
    if (!action.success) throw new AccountingApiError(400, "Enter a valid payment reversal before submitting.");
    const scoped = await accountingPaymentScope(retryScope ?? { actorId: null, organizationId: null });
    return submitGoAccountingReversePayment(action.data, scoped, signal);
  }
  throw new AccountingApiError(400, "This Accounting action is not supported by the Go Accounting service.");
}

async function submitGoAccountingPeriodFxWrite(
  action: AccountingPeriodFxWriteAction,
  scope: { actorId: string; organizationId: string; scopeHash: string },
  signal?: AbortSignal,
): Promise<AccountingActionOutcome> {
  const attempt = await accountingPeriodFxWriteAttempt(action, scope.scopeHash);
  const capabilityId = action.action === "reopenPeriod"
    ? "accounting.reopenPeriod"
    : action.action === "recordFxRate"
      ? "accounting.recordFxRate"
      : "accounting.revalueForeignReceivables";
  const { action: _action, ...input } = action;
  let response: Response;
  let body: unknown;
  try {
    ({ response, body } = await getJson("/api/capabilities/execute", {
      method: "POST",
      cache: "no-store",
      headers: { "X-Organization-ID": scope.organizationId },
      body: JSON.stringify({ capabilityId, input, intentId: attempt.intentId }),
    }, signal));
  } catch (error) {
    if (error instanceof AccountingApiError) throw new AccountingApiError(error.status, error.message, true);
    throw new AccountingApiError(0, "The Go Accounting service could not confirm this period or FX action. Retry its exact details to recover the result.", true);
  }
  if (response.status === 202) {
    const pending = PendingSchema.safeParse(body);
    if (!pending.success) throw new AccountingApiError(202, "The Go Accounting service returned an invalid period or FX approval response.", true);
    return { kind: "pending", reason: pending.data.reason ?? pending.data.error ?? "This Accounting action is waiting for approval." };
  }
  if (!response.ok) {
    const uncertain = response.status === 404 || response.status >= 500 || response.status === 408 || response.status === 429;
    if (!uncertain) await clearAccountingPeriodFxWriteAttempt(attempt);
    throw new AccountingApiError(response.status, errorMessage(response.status, body, "complete this Accounting action"), uncertain);
  }
  const envelope = EnvelopeSchema.safeParse(body);
  const output = envelope.success
    ? action.action === "reopenPeriod"
      ? ReopenPeriodOutputSchema.safeParse(envelope.data.data)
      : action.action === "recordFxRate"
        ? RecordFxRateOutputSchema.safeParse(envelope.data.data)
        : RevalueForeignReceivablesOutputSchema.safeParse(envelope.data.data)
    : null;
  if (response.status !== 200 || !output?.success) {
    throw new AccountingApiError(response.status, "The Go Accounting service returned an unexpected period or FX action response.", true);
  }
  await clearAccountingPeriodFxWriteAttempt(attempt);
  if (action.action === "revalueForeignReceivables") {
    return { kind: "completed", fxRevaluation: output.data as AccountingFxRevaluationResult };
  }
  return { kind: "completed" };
}

async function submitGoAccountingCloseYear(
  action: z.infer<typeof CloseYearActionSchema>,
  scope: { actorId: string; organizationId: string; scopeHash: string },
  signal?: AbortSignal,
): Promise<AccountingActionOutcome> {
  const attempt = await accountingCloseYearAttempt(action, scope.scopeHash);
  let response: Response;
  let body: unknown;
  try {
    ({ response, body } = await getJson("/api/capabilities/execute", {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify({ capabilityId: "accounting.closeYear", input: { year: action.year }, intentId: attempt.intentId }),
    }, signal));
  } catch (error) {
    if (error instanceof AccountingApiError) throw new AccountingApiError(error.status, error.message, true);
    throw new AccountingApiError(0, "The Go Accounting service could not confirm this year-end close. Retry the same year to recover its result.", true);
  }
  if (response.status === 202) {
    const pending = PendingSchema.safeParse(body);
    if (!pending.success) throw new AccountingApiError(202, "The Go Accounting service returned an invalid year-end approval response.", true);
    return { kind: "pending", reason: pending.data.reason ?? pending.data.error ?? "This year-end close is waiting for approval." };
  }
  if (!response.ok) {
    const uncertain = response.status === 404 || response.status >= 500 || response.status === 408 || response.status === 429;
    if (!uncertain) await clearAccountingCloseYearAttempt(attempt.storageKey);
    throw new AccountingApiError(response.status, errorMessage(response.status, body, "close this fiscal year"), uncertain);
  }
  const envelope = EnvelopeSchema.safeParse(body);
  const output = envelope.success ? CloseYearOutputSchema.safeParse(envelope.data.data) : null;
  if (response.status !== 200 || !output?.success) {
    throw new AccountingApiError(response.status, "The Go Accounting service returned an unexpected year-end close response.", true);
  }
  await clearAccountingCloseYearAttempt(attempt.storageKey);
  return { kind: "completed" };
}

async function submitGoBankReconciliationWrite(
  action: AccountingBankReconciliationWriteAction,
  scope: { actorId: string; organizationId: string; scopeHash: string },
  signal?: AbortSignal,
): Promise<AccountingActionOutcome> {
  const attempt = await accountingBankReconciliationWriteAttempt(action, scope.scopeHash);
  const capabilityByAction: Record<AccountingBankReconciliationWriteAction["action"], string> = {
    addBankAccount: "accounting.addBankAccount",
    importBankFeed: "accounting.importBankFeed",
    matchBankTransaction: "accounting.matchBankTransaction",
    unmatchBankTransaction: "accounting.unmatchBankTransaction",
    excludeBankTransaction: "accounting.excludeBankTransaction",
    unexcludeBankTransaction: "accounting.unexcludeBankTransaction",
    deleteBankTransaction: "accounting.deleteBankTransaction",
  };
  const capabilityId = capabilityByAction[action.action];
  const { action: _action, ...input } = action;
  let response: Response;
  let body: unknown;
  try {
    ({ response, body } = await getJson("/api/capabilities/execute", {
      method: "POST",
      headers: { "X-Organization-ID": scope.organizationId },
      body: JSON.stringify({ capabilityId, input, intentId: attempt.intentId }),
    }, signal));
  } catch (error) {
    if (error instanceof AccountingApiError) throw new AccountingApiError(error.status, error.message, true);
    throw new AccountingApiError(0, "The Go Banking service could not confirm this bank action. Retry the same action to recover its result.", true);
  }
  if (response.status === 202) {
    const parsed = PendingSchema.safeParse(body);
    if (!parsed.success) throw new AccountingApiError(202, "The Go Banking service returned an invalid bank action approval response.", true);
    return { kind: "pending", reason: parsed.data.reason ?? parsed.data.error ?? "This bank action is waiting for approval." };
  }
  if (!response.ok) {
    const uncertain = response.status === 404 || response.status >= 500 || response.status === 408 || response.status === 429;
    if (!uncertain) await clearAccountingBankReconciliationWriteAttempt(attempt);
    throw new AccountingApiError(response.status, errorMessage(response.status, body, "complete this bank action"), uncertain);
  }
  const envelope = EnvelopeSchema.safeParse(body);
  const output = envelope.success ? (() => {
    switch (action.action) {
      case "addBankAccount": return AddBankAccountOutputSchema.safeParse(envelope.data.data);
      case "importBankFeed": return ImportBankFeedOutputSchema.safeParse(envelope.data.data);
      case "matchBankTransaction": return MatchBankTransactionOutputSchema.safeParse(envelope.data.data);
      case "unmatchBankTransaction": return UnmatchBankTransactionOutputSchema.safeParse(envelope.data.data);
      case "excludeBankTransaction": return ExcludeBankTransactionOutputSchema.safeParse(envelope.data.data);
      case "unexcludeBankTransaction": return UnexcludeBankTransactionOutputSchema.safeParse(envelope.data.data);
      case "deleteBankTransaction": return DeleteBankTransactionOutputSchema.safeParse(envelope.data.data);
    }
  })() : null;
  if (response.status !== 200 || !output?.success) {
    throw new AccountingApiError(response.status, "The Go Banking service returned an unexpected bank action response.", true);
  }
  await clearAccountingBankReconciliationWriteAttempt(attempt);
  return { kind: "completed" };
}

async function submitGoAccountingReverseEntry(
  action: AccountingReverseEntryAction,
  scope: { actorId: string; organizationId: string; scopeHash: string },
  signal?: AbortSignal,
): Promise<AccountingActionOutcome> {
  const attempt = await accountingReverseEntryAttempt(action, scope.scopeHash);
  let response: Response;
  let body: unknown;
  try {
    ({ response, body } = await getJson("/api/capabilities/execute", {
      method: "POST",
      cache: "no-store",
      headers: { "X-Organization-ID": scope.organizationId },
      body: JSON.stringify({ capabilityId: "accounting.reverseEntry", input: reverseEntryCapabilityInput(action), intentId: attempt.intentId }),
    }, signal));
  } catch (error) {
    if (error instanceof AccountingApiError) throw new AccountingApiError(error.status, error.message, true);
    throw new AccountingApiError(0, "The Go Accounting service could not confirm this reversal. Retry the same entry to recover its result.", true);
  }
  if (response.status === 202) {
    const parsed = PendingSchema.safeParse(body);
    if (!parsed.success) throw new AccountingApiError(202, "The Go Accounting service returned an invalid reversal approval response.", true);
    return { kind: "pending", reason: parsed.data.reason ?? parsed.data.error ?? "This reversal is waiting for approval." };
  }
  if (!response.ok) {
    const uncertain = response.status === 404 || response.status >= 500 || response.status === 408 || response.status === 429;
    if (!uncertain) await clearAccountingReverseEntryAttempt(attempt);
    throw new AccountingApiError(response.status, errorMessage(response.status, body, "reverse this journal entry"), uncertain);
  }
  const envelope = EnvelopeSchema.safeParse(body);
  const output = envelope.success ? ReverseEntryOutputSchema.safeParse(envelope.data.data) : null;
  if (response.status !== 200 || !output?.success) {
    throw new AccountingApiError(response.status, "The Go Accounting service returned an unexpected reversal response.", true);
  }
  await clearAccountingReverseEntryAttempt(attempt);
  return { kind: "completed" };
}

async function submitGoAccountingReversePayment(
  action: AccountingReversePaymentAction,
  scope: { actorId: string; organizationId: string; scopeHash: string },
  signal?: AbortSignal,
): Promise<AccountingActionOutcome> {
  const attempt = await accountingReversePaymentAttempt(action, scope.scopeHash);
  let response: Response;
  let body: unknown;
  try {
    ({ response, body } = await getJson("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({ capabilityId: "accounting.reversePayment", input: reversePaymentCapabilityInput(action), intentId: attempt.intentId }),
    }, signal));
  } catch (error) {
    if (error instanceof AccountingApiError) throw new AccountingApiError(error.status, error.message, true);
    throw new AccountingApiError(0, "The Go Accounting service could not confirm this payment reversal. Retry the same reversal to recover its result.", true);
  }
  if (response.status === 202) {
    const parsed = PendingSchema.safeParse(body);
    if (!parsed.success) throw new AccountingApiError(202, "The Go Accounting service returned an invalid payment reversal approval response.", true);
    return { kind: "pending", reason: parsed.data.reason ?? parsed.data.error ?? "This payment reversal is waiting for approval." };
  }
  if (!response.ok) {
    const uncertain = response.status === 404 || response.status >= 500 || response.status === 408 || response.status === 429;
    if (!uncertain) await clearAccountingReversePaymentAttempt(attempt.storageKey, attempt.intentId, attempt.fingerprint);
    throw new AccountingApiError(response.status, errorMessage(response.status, body, "reverse this payment"), uncertain);
  }
  const envelope = EnvelopeSchema.safeParse(body);
  const output = envelope.success ? ReversePaymentOutputSchema.safeParse(envelope.data.data) : null;
  if (response.status !== 200 || !output?.success) {
    throw new AccountingApiError(response.status, "The Go Accounting service returned an unexpected payment reversal response.", true);
  }
  await clearAccountingReversePaymentAttempt(attempt.storageKey, attempt.intentId, attempt.fingerprint);
  return { kind: "completed" };
}

function reversePaymentCapabilityInput(action: AccountingReversePaymentAction): Record<string, unknown> {
  const { action: _action, ...input } = action;
  return input;
}

function reverseEntryCapabilityInput(action: AccountingReverseEntryAction): Record<string, unknown> {
  const { action: _action, ...input } = action;
  return input;
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
      headers: { "X-Organization-ID": scope.organizationId },
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
    if (!uncertain) await clearAccountingCreditNoteAttempt(attempt);
    throw new AccountingApiError(response.status, errorMessage(response.status, body, "create this credit note"), uncertain);
  }
  const envelope = EnvelopeSchema.safeParse(body);
  const output = envelope.success ? CreditNoteOutputSchema.safeParse(envelope.data.data) : null;
  if (response.status !== 200 || !output?.success) {
    throw new AccountingApiError(response.status, "The Go Accounting service returned an unexpected credit note response.", true);
  }
  await clearAccountingCreditNoteAttempt(attempt);
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
      headers: { "X-Organization-ID": scope.organizationId },
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
      headers: { "X-Organization-ID": scope.organizationId },
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
  const actorId = normalizeRetryActorId(scope.actorId) ?? "";
  const organizationId = scope.organizationId?.trim() ?? "";
  if (!actorId || !z.string().uuid().safeParse(organizationId).success) {
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
  return withAccountingReservationLock(
    storageKey,
    "This browser cannot safely reserve an invoice payment. Open Accounting in a browser with Web Locks enabled before recording it.",
    "The browser could not reserve this invoice payment safely. Retry after closing other Accounting tabs.",
    async () => {
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
    },
  );
}

async function accountingCreateInvoiceAttempt(action: AccountingCreateInvoiceAction, scopeHash: string): Promise<{ storageKey: string; intentId: string }> {
  const storageKey = `${CREATE_INVOICE_ATTEMPT_PREFIX}${scopeHash}`;
  const fingerprint = await accountingPaymentFingerprint(action);
  return withAccountingReservationLock(
    storageKey,
    "This browser cannot safely reserve an invoice creation. Open Accounting in a browser with Web Locks enabled before creating it.",
    "The browser could not reserve this invoice creation safely. Retry after closing other Accounting tabs.",
    async () => {
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
    },
  );
}

async function withAccountingReservationLock<T>(
  storageKey: string,
  unavailableMessage: string,
  lockFailureMessage: string,
  reserve: () => Promise<T>,
): Promise<T> {
  const lockManager = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!lockManager) throw new AccountingApiError(0, unavailableMessage);
  try {
    return await lockManager.request(storageKey, { mode: "exclusive" }, reserve);
  } catch (error) {
    if (error instanceof AccountingApiError) throw error;
    throw new AccountingApiError(0, lockFailureMessage, true);
  }
}

async function accountingCreditNoteAttempt(action: AccountingCreditNoteAction, scopeHash: string): Promise<{ storageKey: string; intentId: string; fingerprint: string }> {
  const storageKey = `${CREDIT_NOTE_ATTEMPT_PREFIX}${scopeHash}`;
  const fingerprint = await accountingPaymentFingerprint(action);
  return withAccountingReservationLock(
    storageKey,
    "This browser cannot safely reserve a credit note. Open Accounting in a browser with Web Locks enabled before applying it.",
    "The browser could not reserve this credit note safely. Retry after closing other Accounting tabs.",
    async () => {
      let raw: string | null;
      try { raw = window.localStorage.getItem(storageKey); }
      catch { throw new AccountingApiError(0, "Enable browser storage before applying a credit so it can be retried safely."); }
      if (raw !== null) {
        const stored = parseStoredCreditNote(raw);
        if (stored.fingerprint !== fingerprint) throw new AccountingApiError(0, "A previous credit note is unresolved. Retry its exact details before creating another credit.", true);
        return { storageKey, intentId: stored.intentId, fingerprint: stored.fingerprint };
      }
      const stored = { action, intentId: crypto.randomUUID(), fingerprint };
      const serialized = JSON.stringify(stored);
      try {
        window.localStorage.setItem(storageKey, serialized);
        if (window.localStorage.getItem(storageKey) !== serialized) throw new Error("credit note retry marker did not persist");
      } catch {
        throw new AccountingApiError(0, "Enable browser storage before applying a credit so it can be retried safely.");
      }
      return { storageKey, intentId: stored.intentId, fingerprint: stored.fingerprint };
    },
  );
}

async function accountingReverseEntryAttempt(action: AccountingReverseEntryAction, scopeHash: string): Promise<{ storageKey: string; intentId: string; fingerprint: string }> {
  const storageKey = `${REVERSE_ENTRY_ATTEMPT_PREFIX}${scopeHash}`;
  const fingerprint = await accountingPaymentFingerprint(action);
  return withAccountingReservationLock(
    storageKey,
    "This browser cannot safely reserve a journal reversal. Open Accounting in a browser with Web Locks enabled before reversing it.",
    "The browser could not reserve this journal reversal safely. Retry after closing other Accounting tabs.",
    async () => {
      let raw: string | null;
      try { raw = window.localStorage.getItem(storageKey); }
      catch { throw new AccountingApiError(0, "Enable browser storage before reversing an entry so it can be retried safely."); }
      if (raw !== null) {
        const stored = parseStoredReverseEntry(raw);
        if (stored.fingerprint !== fingerprint) throw new AccountingApiError(0, "A previous journal reversal is unresolved. Retry its exact entry before reversing another entry.", true);
        return { storageKey, intentId: stored.intentId, fingerprint: stored.fingerprint };
      }
      const stored = { action, intentId: crypto.randomUUID(), fingerprint };
      const serialized = JSON.stringify(stored);
      try {
        window.localStorage.setItem(storageKey, serialized);
        if (window.localStorage.getItem(storageKey) !== serialized) throw new Error("journal reversal retry marker did not persist");
      } catch {
        throw new AccountingApiError(0, "Enable browser storage before reversing an entry so it can be retried safely.");
      }
      return { storageKey, intentId: stored.intentId, fingerprint: stored.fingerprint };
    },
  );
}

async function accountingReversePaymentAttempt(action: AccountingReversePaymentAction, scopeHash: string): Promise<{ storageKey: string; intentId: string; fingerprint: string }> {
  const storageKey = `${REVERSE_PAYMENT_ATTEMPT_PREFIX}${scopeHash}`;
  const fingerprint = await accountingPaymentFingerprint(action);
  return withAccountingReservationLock(
    storageKey,
    "This browser cannot safely reserve a payment reversal. Open Accounting in a browser with Web Locks enabled before reversing it.",
    "The browser could not reserve this payment reversal safely. Retry after closing other Accounting tabs.",
    async () => {
      let raw: string | null;
      try { raw = window.localStorage.getItem(storageKey); }
      catch { throw new AccountingApiError(0, "Enable browser storage before reversing a payment so it can be retried safely."); }
      if (raw !== null) {
        const stored = parseStoredReversePayment(raw);
        if (stored.fingerprint !== fingerprint) throw new AccountingApiError(0, "A previous payment reversal is unresolved. Retry its exact details before reversing another payment.", true);
        return { storageKey, intentId: stored.intentId, fingerprint: stored.fingerprint };
      }
      const stored = { action, intentId: crypto.randomUUID(), fingerprint };
      const serialized = JSON.stringify(stored);
      try {
        window.localStorage.setItem(storageKey, serialized);
        if (window.localStorage.getItem(storageKey) !== serialized) throw new Error("payment reversal retry marker did not persist");
      } catch {
        throw new AccountingApiError(0, "Enable browser storage before reversing a payment so it can be retried safely.");
      }
      return { storageKey, intentId: stored.intentId, fingerprint: stored.fingerprint };
    },
  );
}

async function accountingBankReconciliationWriteAttempt(action: AccountingBankReconciliationWriteAction, scopeHash: string): Promise<{ storageKey: string; intentId: string; fingerprint: string }> {
  const storageKey = `${BANK_RECONCILIATION_WRITE_ATTEMPT_PREFIX}${scopeHash}`;
  const fingerprint = await accountingPaymentFingerprint(action);
  return withAccountingReservationLock(
    storageKey,
    "This browser cannot safely reserve a bank action. Open Accounting in a browser with Web Locks enabled before changing bank data.",
    "The browser could not reserve this bank action safely. Retry after closing other Accounting tabs.",
    async () => {
      let raw: string | null;
      try { raw = window.localStorage.getItem(storageKey); }
      catch { throw new AccountingApiError(0, "Enable browser storage before changing a bank reconciliation so it can be retried safely."); }
      if (raw !== null) {
        const stored = parseStoredBankReconciliationWrite(raw);
        if (stored.fingerprint !== fingerprint) throw new AccountingApiError(0, "A previous bank reconciliation action is unresolved. Retry its exact details before changing another match.", true);
        return { storageKey, intentId: stored.intentId, fingerprint: stored.fingerprint };
      }
      const stored = { action, intentId: crypto.randomUUID(), fingerprint };
      const serialized = JSON.stringify(stored);
      try {
        window.localStorage.setItem(storageKey, serialized);
        if (window.localStorage.getItem(storageKey) !== serialized) throw new Error("bank action retry marker did not persist");
      } catch {
        throw new AccountingApiError(0, "Enable browser storage before changing bank data so the action can be retried safely.");
      }
      return { storageKey, intentId: stored.intentId, fingerprint: stored.fingerprint };
    },
  );
}

async function accountingCloseYearAttempt(action: z.infer<typeof CloseYearActionSchema>, scopeHash: string): Promise<{ storageKey: string; intentId: string }> {
  const storageKey = `${CLOSE_YEAR_ATTEMPT_PREFIX}${scopeHash}`;
  const fingerprint = await accountingPaymentFingerprint(action);
  return withAccountingReservationLock(
    storageKey,
    "This browser cannot safely reserve a year-end close. Open Accounting in a browser with Web Locks enabled before closing the books.",
    "The browser could not reserve this year-end close safely. Retry after closing other Accounting tabs.",
    async () => {
      let raw: string | null;
      try { raw = window.localStorage.getItem(storageKey); }
      catch { throw new AccountingApiError(0, "Enable browser storage before closing the books so this year can be retried safely."); }
      if (raw !== null) {
        const stored = parseStoredCloseYear(raw);
        if (stored.fingerprint !== fingerprint) throw new AccountingApiError(0, "A previous year-end close is unresolved. Retry that exact year before closing another year.", true);
        return { storageKey, intentId: stored.intentId };
      }
      const stored = { action, intentId: crypto.randomUUID(), fingerprint };
      const serialized = JSON.stringify(stored);
      try {
        window.localStorage.setItem(storageKey, serialized);
        if (window.localStorage.getItem(storageKey) !== serialized) throw new Error("year-end close retry marker did not persist");
      } catch {
        throw new AccountingApiError(0, "Enable browser storage before closing the books so this year can be retried safely.");
      }
      return { storageKey, intentId: stored.intentId };
    },
  );
}

async function accountingPeriodFxWriteAttempt(
  action: AccountingPeriodFxWriteAction,
  scopeHash: string,
): Promise<{ storageKey: string; intentId: string; fingerprint: string }> {
  const storageKey = `${PERIOD_FX_WRITE_ATTEMPT_PREFIX}${scopeHash}`;
  const fingerprint = await accountingPaymentFingerprint(action);
  return withAccountingReservationLock(
    storageKey,
    "This browser cannot safely reserve an Accounting period or FX action. Open Accounting in a browser with Web Locks enabled before continuing.",
    "The browser could not reserve this Accounting action safely. Retry after closing other Accounting tabs.",
    async () => {
      let raw: string | null;
      try { raw = window.localStorage.getItem(storageKey); }
      catch { throw new AccountingApiError(0, "Enable browser storage before changing period or FX data so the action can be retried safely."); }
      if (raw !== null) {
        const stored = parseStoredPeriodFxWrite(raw);
        if (stored.fingerprint !== fingerprint) {
          throw new AccountingApiError(0, "A previous period or FX action is unresolved. Retry its exact details before changing Accounting data.", true);
        }
        return { storageKey, intentId: stored.intentId, fingerprint: stored.fingerprint };
      }
      const stored = { action, intentId: crypto.randomUUID(), fingerprint };
      const serialized = JSON.stringify(stored);
      try {
        window.localStorage.setItem(storageKey, serialized);
        if (window.localStorage.getItem(storageKey) !== serialized) throw new Error("Accounting retry marker did not persist");
      } catch {
        throw new AccountingApiError(0, "Enable browser storage before changing period or FX data so the action can be retried safely.");
      }
      return { storageKey, intentId: stored.intentId, fingerprint };
    },
  );
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

function parseStoredReverseEntry(raw: string): z.infer<typeof StoredReverseEntrySchema> {
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch { throw new AccountingApiError(0, "An unresolved journal reversal marker is malformed. Contact an administrator before retrying.", true); }
  const parsed = StoredReverseEntrySchema.safeParse(decoded);
  if (!parsed.success) throw new AccountingApiError(0, "An unresolved journal reversal marker is malformed. Contact an administrator before retrying.", true);
  return parsed.data;
}

function parseStoredReversePayment(raw: string): z.infer<typeof StoredReversePaymentSchema> {
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch { throw new AccountingApiError(0, "An unresolved payment reversal marker is malformed. Contact an administrator before retrying.", true); }
  const parsed = StoredReversePaymentSchema.safeParse(decoded);
  if (!parsed.success) throw new AccountingApiError(0, "An unresolved payment reversal marker is malformed. Contact an administrator before retrying.", true);
  return parsed.data;
}

function parseStoredBankReconciliationWrite(raw: string): z.infer<typeof StoredBankReconciliationWriteSchema> {
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch { throw new AccountingApiError(0, "An unresolved bank reconciliation marker is malformed. Contact an administrator before retrying.", true); }
  const parsed = StoredBankReconciliationWriteSchema.safeParse(decoded);
  if (!parsed.success) throw new AccountingApiError(0, "An unresolved bank reconciliation marker is malformed. Contact an administrator before retrying.", true);
  return parsed.data;
}

function parseStoredCloseYear(raw: string): z.infer<typeof StoredCloseYearSchema> {
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch { throw new AccountingApiError(0, "An unresolved year-end close marker is malformed. Contact an administrator before retrying.", true); }
  const parsed = StoredCloseYearSchema.safeParse(decoded);
  if (!parsed.success) throw new AccountingApiError(0, "An unresolved year-end close marker is malformed. Contact an administrator before retrying.", true);
  return parsed.data;
}

function parseStoredPeriodFxWrite(raw: string): z.infer<typeof StoredPeriodFxWriteSchema> {
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch { throw new AccountingApiError(0, "An unresolved period or FX action marker is malformed. Contact an administrator before retrying.", true); }
  const parsed = StoredPeriodFxWriteSchema.safeParse(decoded);
  if (!parsed.success) throw new AccountingApiError(0, "An unresolved period or FX action marker is malformed. Contact an administrator before retrying.", true);
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

async function clearAccountingCreditNoteAttempt(attempt: { storageKey: string; intentId: string; fingerprint: string }): Promise<void> {
  await withAccountingReservationLock(
    attempt.storageKey,
    "This browser cannot safely clear a credit note marker. Open Accounting in a browser with Web Locks enabled before continuing.",
    "The browser could not safely clear the credit note marker. Reload before creating another credit.",
    async () => {
      try {
        const raw = window.localStorage.getItem(attempt.storageKey);
        if (raw === null) return;
        const current = parseStoredCreditNote(raw);
        if (current.intentId === attempt.intentId && current.fingerprint === attempt.fingerprint) {
          window.localStorage.removeItem(attempt.storageKey);
        }
      } catch {
        throw new AccountingApiError(0, "The credit note result was received, but its retry marker could not be verified and cleared. Reload before creating another credit.", true);
      }
    },
  );
}

async function clearAccountingReverseEntryAttempt(attempt: { storageKey: string; intentId: string; fingerprint: string }): Promise<void> {
  await withAccountingReservationLock(
    attempt.storageKey,
    "This browser cannot safely clear a journal reversal marker. Open Accounting in a browser with Web Locks enabled before continuing.",
    "The browser could not safely clear the journal reversal marker. Reload before reversing another entry.",
    async () => {
      try {
        const raw = window.localStorage.getItem(attempt.storageKey);
        if (raw === null) return;
        const current = parseStoredReverseEntry(raw);
        if (current.intentId === attempt.intentId && current.fingerprint === attempt.fingerprint) {
          window.localStorage.removeItem(attempt.storageKey);
        }
      } catch {
        throw new AccountingApiError(0, "The reversal result was received, but its retry marker could not be verified and cleared. Reload before reversing another entry.", true);
      }
    },
  );
}

async function clearAccountingReversePaymentAttempt(storageKey: string, intentId: string, fingerprint: string): Promise<void> {
  await withAccountingReservationLock(
    storageKey,
    "This browser cannot safely clear a payment reversal marker. Open Accounting in a browser with Web Locks enabled before continuing.",
    "The browser could not safely clear the payment reversal marker. Reload before reversing another payment.",
    async () => {
      try {
        const raw = window.localStorage.getItem(storageKey);
        if (raw === null) return;
        const current = parseStoredReversePayment(raw);
        if (current.intentId === intentId && current.fingerprint === fingerprint) window.localStorage.removeItem(storageKey);
      } catch {
        throw new AccountingApiError(0, "The payment reversal completed, but its retry marker could not be cleared. Reload before reversing another payment.", true);
      }
    },
  );
}

async function clearAccountingBankReconciliationWriteAttempt(attempt: { storageKey: string; intentId: string; fingerprint: string }): Promise<void> {
  try {
    await withAccountingReservationLock(
      attempt.storageKey,
      "This browser cannot safely verify a bank action retry marker. Open Accounting in a browser with Web Locks enabled before changing bank data.",
      "The browser could not safely verify this bank action retry marker. Retry after closing other Accounting tabs.",
      async () => {
        const raw = window.localStorage.getItem(attempt.storageKey);
        if (raw === null) return;
        const current = parseStoredBankReconciliationWrite(raw);
        if (current.intentId === attempt.intentId && current.fingerprint === attempt.fingerprint) {
          window.localStorage.removeItem(attempt.storageKey);
        }
      },
    );
  } catch {
    throw new AccountingApiError(0, "The bank action completed, but its retry marker could not be verified and cleared. Reload before changing bank data.", true);
  }
}

async function clearAccountingCloseYearAttempt(storageKey: string): Promise<void> {
  try { window.localStorage.removeItem(storageKey); }
  catch { throw new AccountingApiError(0, "The year-end close completed, but its retry marker could not be cleared. Reload before closing another year.", true); }
}

async function clearAccountingPeriodFxWriteAttempt(attempt: { storageKey: string; intentId: string; fingerprint: string }): Promise<void> {
  try {
    await withAccountingReservationLock(
      attempt.storageKey,
      "This browser cannot safely verify an Accounting action retry marker. Open Accounting in a browser with Web Locks enabled before continuing.",
      "The browser could not safely verify this Accounting retry marker. Reload before changing period or FX data.",
      async () => {
        const raw = window.localStorage.getItem(attempt.storageKey);
        if (raw === null) return;
        const current = parseStoredPeriodFxWrite(raw);
        if (current.intentId === attempt.intentId && current.fingerprint === attempt.fingerprint) {
          window.localStorage.removeItem(attempt.storageKey);
        }
      },
    );
  } catch {
    throw new AccountingApiError(0, "The Accounting action completed, but its retry marker could not be verified and cleared. Reload before changing period or FX data.", true);
  }
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
