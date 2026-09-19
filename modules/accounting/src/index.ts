import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  bankAccounts,
  bankAllocations,
  bankTransactions,
  customers,
  expenseClaims,
  expensePolicies,
  fxRates,
  fxSettlements,
  invoiceLines,
  invoiceShares,
  invoices,
  quoteLines,
  quotes,
  recurringInvoices,
  recurringInvoiceRuns,
  salesTaxFilings,
  journalEntries,
  journalLines,
  organizations,
  payments,
  periods,
  vendorBills,
} from "@chaste/db";
import { nextDocNumber } from "@chaste/db";
import { withOrgContext } from "@chaste/db";
import { baseCurrencyOf, lockPeriodsForOrg, postEntry } from "./posting";
import {
  buildCashFlowStatement,
  buildInvoiceEntryLines,
  buildPaymentEntryLines,
  buildThirteenWeekForecast,
  cashBalanceFromEntries,
  computeAging,
  computeBalanceSheet,
  computeCashBasis,
  computeIncomeStatement,
  computeInvoiceTotals,
  computeYearEndClose,
  canAcceptPayment,
  currencyMinorUnits,
  documentBalance,
  evaluateExpensePolicy,
  fxRateFromDecimal,
  lineUnexplained,
  paymentRemaining,
  planLineAllocations,
  reconciliationTotals,
  suggestExpenseCategory,
  toBaseMinor,
  nextRunAfter,
  type AccountBalance,
  type AllocationKind,
  type BankStatementLine,
  type FxRate,
} from "@chaste/erp-core";
import type { Database } from "@chaste/db";
import { defineCapability, type ActionContext, type CapabilityRegistry } from "@chaste/kernel";

export interface ModuleDeps {
  db: Database["db"];
}

/**
 * FX helpers (ADR 0021 phases 2-3). Rates are posted facts: the latest row
 * effective at a moment wins. Clearing and realized gain/loss accounts are
 * created lazily so orgs onboarded before multi-currency keep working.
 */
const FX_CLEARING_CODE = "1305";
const REALIZED_FX_CODE = "7900";

async function latestRate(
  tx: Parameters<Parameters<Database["db"]["transaction"]>[0]>[0] | Database["db"],
  orgId: string,
  base: string,
  quote: string,
  at: Date,
): Promise<FxRate | null> {
  const [row] = await tx
    .select({ num: fxRates.rateNum, den: fxRates.rateDen })
    .from(fxRates)
    .where(
      and(eq(fxRates.orgId, orgId), eq(fxRates.base, base), eq(fxRates.quote, quote)),
    )
    .orderBy(desc(fxRates.effectiveAt))
    .limit(1);
  if (!row || row.den === undefined) return null;
  void at;
  return { num: Number(row.num), den: Number(row.den) };
}

async function ensureAccount(
  tx: Parameters<Parameters<Database["db"]["transaction"]>[0]>[0],
  orgId: string,
  code: string,
  name: string,
  type: string,
): Promise<string> {
  const [existing] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.orgId, orgId), eq(accounts.code, code)))
    .limit(1);
  if (existing) return existing.id;
  const [row] = await tx
    .insert(accounts)
    .values({ orgId, code, name, type })
    .returning({ id: accounts.id });
  return row!.id;
}

const lineSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().int().positive().describe("thousandths of a unit; 1000 = one unit"),
  unitPriceMinor: z.number().int().nonnegative(),
  taxMinor: z.number().int().nonnegative().default(0),
});

/**
 * Shared sales-document posting path: inserts the invoice + lines and posts
 * the AR/revenue entry. Used verbatim by accounting.createInvoice, quote
 * acceptance, AND sales-order delivery (ADR 0036), so every revenue path
 * produces an ordinary invoice through one shared write path.
 */
export async function insertInvoiceWithPosting(
  tx: Parameters<Parameters<Database["db"]["transaction"]>[0]>[0],
  ctx: ActionContext,
  input: {
    customerId: string;
    memo?: string;
    lines: Array<{ description: string; quantity: number; unitPriceMinor: number; taxMinor?: number }>;
    currency?: string;
    fxRate?: string;
    /** Overrides the customer's payment-term default. */
    dueAt?: Date;
  },
): Promise<{ invoiceId: string; invoiceNumber: number; totalMinor: number; entryId: string; currency: string }> {
  const cust = await tx
    .select({ id: customers.id, paymentTermDays: customers.paymentTermDays })
    .from(customers)
    .where(and(eq(customers.id, input.customerId), eq(customers.orgId, ctx.actor.orgId)))
    .limit(1);
  if (cust.length === 0) throw new Error("customer not found");

  const totals = computeInvoiceTotals(
    input.lines.map((l) => ({ ...l, taxMinor: l.taxMinor ?? 0 })),
  );
  const base = await baseCurrencyOf(tx, ctx.actor.orgId);
  let currency = base;
  let rateSnapshot: FxRate | null = null;
  if (input.currency) {
    if (currencyMinorUnits(input.currency) === null) {
      throw new Error(`unknown currency code: ${input.currency}`);
    }
    if (input.currency !== base) {
      rateSnapshot = input.fxRate
        ? fxRateFromDecimal(input.fxRate)
        : await latestRate(tx, ctx.actor.orgId, base, input.currency, ctx.now);
      if (!rateSnapshot) {
        throw new Error(`no FX rate for ${base}/${input.currency}; post one with accounting.recordFxRate`);
      }
      currency = input.currency;
    } else if (input.fxRate) {
      throw new Error("fxRate applies only when currency differs from the base");
    }
  }

  const number = await nextDocNumber(tx, ctx.actor.orgId, "invoice");

  const [inv] = await tx
    .insert(invoices)
    .values({
      orgId: ctx.actor.orgId,
      customerId: input.customerId,
      number,
      status: "sent",
      currency,
      fxRateNum: rateSnapshot?.num ?? null,
      fxRateDen: rateSnapshot?.den ?? null,
      subtotalMinor: totals.subtotalMinor,
      taxMinor: totals.taxMinor,
      totalMinor: totals.totalMinor,
      memo: input.memo ?? null,
      issuedAt: ctx.now,
      dueAt:
        input.dueAt ??
        (cust[0]!.paymentTermDays && cust[0]!.paymentTermDays > 0
          ? new Date(ctx.now.getTime() + cust[0]!.paymentTermDays * 86_400_000)
          : ctx.now),
    })
    .returning({ id: invoices.id });

  await tx.insert(invoiceLines).values(
    input.lines.map((l) => ({
      invoiceId: inv!.id,
      description: l.description,
      quantity: l.quantity,
      unitPriceMinor: l.unitPriceMinor,
      taxMinor: l.taxMinor ?? 0,
    })),
  );

  const lines = buildInvoiceEntryLines(
    { ar: "1100", revenue: "4000", taxPayable: "2100" },
    { totals },
  );
  const entryId = await postEntry(tx, ctx.actor.orgId, ctx.actor, {
    memo: `Invoice ${number}${currency !== base ? ` (${currency})` : ""}`,
    sourceType: "invoice",
    sourceId: inv!.id,
    currency,
    postedAt: ctx.now,
    lines,
  });

  return { invoiceId: inv!.id, invoiceNumber: number, totalMinor: totals.totalMinor, entryId, currency };
}

const createInvoice = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.createInvoice",
    title: "Create invoice",
    intent:
      "Issue an invoice to a customer for goods or services with line items; posts the receivable and revenue to the ledger",
    module: "accounting",
    risk: "write",
    permission: "accounting.write",
    // No mechanical inverse: undoing an invoice is a business decision -
    // how much to concede goes through accounting.creditNote, whose amount
    // cannot be derived from the invoice's output. Reversing the posting
    // alone would leave the invoice collecting money the GL says reversed,
    // so the generic path refuses it (N12, ADR 0051).
    input: z.object({
      customerId: z.string(),
      memo: z.string().optional(),
      lines: z.array(lineSchema).min(1),
      // Omitted or equal to the org base → single-currency path as before.
      currency: z.string().optional(),
      /** Explicit rate override (decimal string); else latest posted rate. */
      fxRate: z.string().optional(),
      /** Override the customer's payment-term default due date (M10). */
      dueAt: z.string().datetime().optional(),
    }),
    output: z.object({
      invoiceId: z.string(),
      invoiceNumber: z.number(),
      totalMinor: z.number(),
      entryId: z.string(),
      currency: z.string().optional(),
    }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const created = await insertInvoiceWithPosting(tx, ctx, {
          ...input,
          dueAt: input.dueAt ? new Date(input.dueAt) : undefined,
        });
        return {
          invoiceId: created.invoiceId,
          invoiceNumber: created.invoiceNumber,
          totalMinor: created.totalMinor,
          entryId: created.entryId,
          currency: created.currency,
        };
      });
    },
  });

const recordPayment = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.recordPayment",
    title: "Record customer payment",
    intent:
      "Record money received against an outstanding invoice and post cash to the ledger. Amounts above the policy threshold require approval",
    module: "accounting",
    risk: "money",
    permission: "accounting.post",
    moneyThresholdMinor: 50_000,
    moneyAmount: (input) => input.amountMinor,
    inverse: {
      // reverseEntry refuses payment entries by design (it would leave the
      // invoice balance unrepaired), so the declared undo is the domain
      // compensation - same pattern as payBill → reverseVendorPayment.
      capabilityId: "accounting.reversePayment",
      buildInput: (_input, output) => ({ paymentId: output.paymentId, reason: "undo customer payment" }),
    },
    input: z.object({
      invoiceNumber: z.number().int().positive(),
      amountMinor: z.number().int().positive().describe("amount received in minor units"),
      method: z.enum(["cash", "bank_transfer", "card"]).default("bank_transfer"),
      /** Settlement rate override for foreign invoices (decimal string). */
      settleFxRate: z.string().optional(),
    }),
    output: z.object({
      paymentId: z.string(),
      entryId: z.string(),
      fullyPaid: z.boolean(),
      // Cross-currency settlement extras (single-currency path omits them).
      gainLossMinor: z.number().optional(),
      baseEntryId: z.string().optional(),
      foreignEntryId: z.string().optional(),
    }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [inv] = await tx
          .select()
          .from(invoices)
          .where(and(eq(invoices.orgId, ctx.actor.orgId), eq(invoices.number, input.invoiceNumber)))
          .limit(1)
          // N11: serialize money application per document - the outstanding
          // verdict must see every committed payment, not a stale snapshot.
          .for("update");
        if (!inv) throw new Error("invoice not found");
        // N11: one balance contract gates every payment - lifecycle
        // eligibility first, then the credit-adjusted outstanding.
        const verdict = canAcceptPayment(inv, inv.status, input.amountMinor);
        if (!verdict.ok) throw new Error(verdict.reason);

        const base = await baseCurrencyOf(tx, ctx.actor.orgId);
        const foreign = inv.currency !== base;
        let entryId: string;

        if (!foreign) {
          entryId = await postEntry(tx, ctx.actor.orgId, ctx.actor, {
            memo: `Payment for invoice ${inv.number} (${input.method})`,
            sourceType: "payment",
            postedAt: ctx.now,
            lines: buildPaymentEntryLines({ cash: "1000", ar: "1100" }, input.amountMinor),
          });

          const [pay] = await tx
            .insert(payments)
            .values({
              orgId: ctx.actor.orgId,
              invoiceId: inv.id,
              amountMinor: input.amountMinor,
              method: input.method,
              entryId,
              receivedAt: ctx.now,
            })
            .returning({ id: payments.id });

          const paidMinor = inv.paidMinor + input.amountMinor;
          await tx
            .update(invoices)
            .set({ paidMinor, status: documentBalance({ ...inv, paidMinor }).fullySettled ? "paid" : inv.status })
            .where(eq(invoices.id, inv.id));

          return {
            paymentId: pay!.id,
            entryId,
            fullyPaid: documentBalance({ ...inv, paidMinor }).fullySettled,
          };
        }

        // Cross-currency settlement (ADR 0021): two entries joined by an
        // fx_settlements row. Base entry books cash at the settlement rate
        // and realizes gain/loss against the invoiced rate; the foreign
        // entry clears AR through the FX clearing account.
        const invRate: FxRate | null =
          inv.fxRateNum != null && inv.fxRateDen != null
            ? { num: inv.fxRateNum, den: inv.fxRateDen }
            : null;
        const settleRate = input.settleFxRate
          ? fxRateFromDecimal(input.settleFxRate)
          : await latestRate(tx, ctx.actor.orgId, base, inv.currency, ctx.now);
        if (!settleRate) throw new Error(`no settlement rate for ${base}/${inv.currency}`);
        if (invRate && invRate.den === settleRate.den && invRate.num === settleRate.num) {
          // Same rate: no realized gain/loss possible.
        }
        const cashBase = toBaseMinor(input.amountMinor, settleRate);
        const bookedBase = invRate ? toBaseMinor(input.amountMinor, invRate) : cashBase;
        const gl = cashBase - bookedBase;

        const clearingId = await ensureAccount(
          tx,
          ctx.actor.orgId,
          FX_CLEARING_CODE,
          "FX Clearing",
          "asset",
        );
        const glId = await ensureAccount(
          tx,
          ctx.actor.orgId,
          REALIZED_FX_CODE,
          "Realized FX Gain/Loss",
          gl >= 0 ? "income" : "expense",
        );

        // Base-currency entry: DR Cash / CR Clearing(booked) / CR|DR Realized.
        const baseLines = [
          { accountCode: "1000", debitMinor: cashBase, creditMinor: 0 },
          { accountCode: FX_CLEARING_CODE, debitMinor: 0, creditMinor: bookedBase },
        ];
        if (gl > 0) baseLines.push({ accountCode: REALIZED_FX_CODE, debitMinor: 0, creditMinor: gl });
        else if (gl < 0) baseLines.push({ accountCode: REALIZED_FX_CODE, debitMinor: -gl, creditMinor: 0 });

        const baseEntryId = await postEntry(tx, ctx.actor.orgId, ctx.actor, {
          memo: `Settlement of invoice ${inv.number} (${inv.currency} ${input.amountMinor}) @ ${settleRate.num}/${settleRate.den}`,
          sourceType: "payment",
          currency: base,
          postedAt: ctx.now,
          lines: baseLines,
        });

        const foreignEntryId = await postEntry(tx, ctx.actor.orgId, ctx.actor, {
          memo: `FX clearing of invoice ${inv.number}`,
          sourceType: "payment",
          sourceId: inv.id,
          currency: inv.currency,
          postedAt: ctx.now,
          lines: [
            { accountId: clearingId, debitMinor: input.amountMinor, creditMinor: 0 },
            { accountCode: "1100", debitMinor: 0, creditMinor: input.amountMinor },
          ],
        });
        void glId;

        const [pay] = await tx
          .insert(payments)
          .values({
            orgId: ctx.actor.orgId,
            invoiceId: inv.id,
            amountMinor: input.amountMinor,
            method: input.method,
            entryId: baseEntryId,
            receivedAt: ctx.now,
          })
          .returning({ id: payments.id });

        await tx.insert(fxSettlements).values({
          orgId: ctx.actor.orgId,
          paymentId: pay!.id,
          invoiceId: inv.id,
          currency: inv.currency,
          settledForeignMinor: input.amountMinor,
          baseSettledMinor: cashBase,
          gainLossMinor: gl,
          settleRateNum: settleRate.num,
          settleRateDen: settleRate.den,
          baseEntryId,
          foreignEntryId,
        });

        const paidMinor = inv.paidMinor + input.amountMinor;
        await tx
          .update(invoices)
          .set({ paidMinor, status: paidMinor >= inv.totalMinor ? "paid" : inv.status })
          .where(eq(invoices.id, inv.id));

        return {
          paymentId: pay!.id,
          entryId: baseEntryId,
          fullyPaid: paidMinor >= inv.totalMinor,
          gainLossMinor: gl,
          baseEntryId,
          foreignEntryId,
        };
      });
    },
  });

/**
 * N12 (ADR 0051): the domain compensation for recordPayment. A payment is
 * an allocation on an invoice - and for cross-currency settlements a *pair*
 * of entries joined by an fx_settlements row - so the generic journal
 * mirror is not a complete undo. Reversing a payment means mirroring every
 * entry in its original currency, releasing the amount from the invoice's
 * paid balance through the one balance contract (N11), and refusing a
 * second reversal of the same payment.
 */
const reversePayment = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.reversePayment",
    title: "Reverse payment",
    intent:
      "Undo a recorded customer payment: mirror its journal entries in their original currencies, release the amount from the invoice balance, and refuse if the payment was already reversed. The invoice can then receive a corrected payment",
    module: "accounting",
    risk: "money",
    permission: "accounting.post",
    // The refunded amount lives in the payment, not the input: null means
    // the policy engine always gates reversals for human approval.
    moneyAmount: () => null,
    input: z.object({
      paymentId: z.string().uuid(),
      reason: z.string().min(3).max(500),
    }),
    output: z.object({
      reversalEntryIds: z.array(z.string()),
      refundedMinor: z.number(),
      invoiceNumber: z.number(),
      outstandingMinor: z.number(),
    }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [payment] = await tx
          .select()
          .from(payments)
          .where(and(eq(payments.id, input.paymentId), eq(payments.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!payment) throw new Error("payment not found");
        const [inv] = await tx
          .select()
          .from(invoices)
          .where(and(eq(invoices.id, payment.invoiceId), eq(invoices.orgId, ctx.actor.orgId)))
          .limit(1)
          // N11: the reversal mutates paidMinor under the same document lock
          // the payment path holds, so a concurrent payment serializes.
          .for("update");
        if (!inv) throw new Error("payment's invoice not found");
        if (inv.status === "void") throw new Error("invoice is void; a void compensates its payments");
        if (!payment.entryId) throw new Error("payment has no journal entry to reverse");

        const [saleEntry] = await tx
          .select({ sourceType: journalEntries.sourceType })
          .from(journalEntries)
          .where(eq(journalEntries.id, payment.entryId))
          .limit(1);
        if (saleEntry?.sourceType === "pos_sale") {
          throw new Error("register sales are undone with pos.returnSale, not a payment reversal");
        }

        const [settlement] = await tx
          .select()
          .from(fxSettlements)
          .where(and(eq(fxSettlements.paymentId, payment.id), eq(fxSettlements.orgId, ctx.actor.orgId)))
          .limit(1);

        // Unique at the business-operation level: retries and replays find
        // the same reversal row and refuse instead of refunding twice.
        const entryIds = [payment.entryId, ...(settlement ? [settlement.foreignEntryId] : [])];
        const [already] = await tx
          .select({ id: journalEntries.id })
          .from(journalEntries)
          .where(and(eq(journalEntries.orgId, ctx.actor.orgId), inArray(journalEntries.reversalOfId, entryIds)))
          .limit(1);
        if (already) throw new Error("payment has already been reversed");

        const memo = `Payment reversal for invoice ${inv.number}: ${input.reason}`;
        const mirrorOf = async (entryId: string): Promise<string> => {
          const [entry] = await tx
            .select()
            .from(journalEntries)
            .where(eq(journalEntries.id, entryId))
            .limit(1);
          if (!entry) throw new Error(`journal entry ${entryId} not found`);
          const lines = await tx
            .select({
              accountId: journalLines.accountId,
              debitMinor: journalLines.debitMinor,
              creditMinor: journalLines.creditMinor,
            })
            .from(journalLines)
            .where(eq(journalLines.entryId, entryId));
          // The mirror keeps the original's currency: a foreign-currency
          // payment reverses in that currency, never the base (ADR 0021).
          return postEntry(tx, ctx.actor.orgId, ctx.actor, {
            memo,
            sourceType: "payment-reversal",
            sourceId: inv!.id,
            reversalOfId: entryId,
            currency: entry.currency,
            postedAt: ctx.now,
            lines: lines.map((l) => ({
              accountId: l.accountId,
              debitMinor: l.creditMinor,
              creditMinor: l.debitMinor,
            })),
          });
        };

        const reversalEntryIds = [await mirrorOf(payment.entryId)];
        if (settlement) {
          // Paired FX entries reverse as one coherent settlement: without
          // the foreign clearing mirror, AR keeps the charge while the cash
          // has already gone back out.
          reversalEntryIds.push(await mirrorOf(settlement.foreignEntryId));
        }

        const paidMinor = inv.paidMinor - payment.amountMinor;
        const balance = documentBalance({ ...inv, paidMinor });
        await tx
          .update(invoices)
          .set({
            paidMinor,
            status: balance.fullySettled ? "paid" : inv.status === "paid" ? "sent" : inv.status,
          })
          .where(eq(invoices.id, inv.id));

        return {
          reversalEntryIds,
          refundedMinor: payment.amountMinor,
          invoiceNumber: inv.number,
          outstandingMinor: balance.outstandingMinor,
        };
      });
    },
  });

const reverseEntry = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.reverseEntry",
    title: "Reverse journal entry",
    intent:
      "Correct a mistake by posting an exact mirror reversal of a posted entry. The original is never modified",
    module: "accounting",
    risk: "money",
    permission: "accounting.post",
    // The reversed amount lives in the original entry, not the input: the
    // policy engine treats null as "always gate", so reversals wait for
    // human approval regardless of size.
    moneyAmount: () => null,
    input: z.object({ entryId: z.string() }),
    output: z.object({ reversalEntryId: z.string() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [orig] = await tx
          .select()
          .from(journalEntries)
          .where(and(eq(journalEntries.id, input.entryId), eq(journalEntries.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!orig) throw new Error("entry not found");
        if (orig.sourceType === "reversal" || orig.sourceType === "payment-reversal") {
          throw new Error("cannot reverse a reversal");
        }

        // N12 (ADR 0051): a journal mirror alone is not a business undo for
        // source types that own subledger state - those have domain
        // compensations, and the generic path must route there instead of
        // silently leaving the document, drawer or run unrepaired.
        const domainRoutes: Record<string, string> = {
          payment: "accounting.reversePayment on the payment",
          vendor_payment: "purchasing.reverseVendorPayment on the vendor payment",
          pos_sale: "pos.returnSale on the sale invoice",
          payroll_run: "hr.reversePayrollPosting on the payroll run",
          invoice: "accounting.creditNote against the invoice",
          "inventory-valuation": "inventory.reverseValuationSummary on the summary",
          // A roll must be replaced inside its own reopened December, not
          // mirrored into the current period - that would restore closed-year
          // income on the wrong books. closeYear does the replace-and-roll.
          year_end_close: "accounting.closeYear (reopen December first): it replaces the closing entry",
        };
        if (orig.sourceType && domainRoutes[orig.sourceType]) {
          throw new Error(
            `a ${orig.sourceType} entry is undone by its domain workflow: use ${domainRoutes[orig.sourceType]}`,
          );
        }
        // The year-end roll is identified by kind, not source type: mirroring
        // it into the current period would restore closed-year income on the
        // wrong books. Re-closing replaces it inside the reopened December.
        if (orig.entryKind === "year_end_close") {
          throw new Error(
            "a year-end closing entry is replaced by accounting.closeYear (reopen December first), not mirrored",
          );
        }

        const origLines = await tx
          .select({ accountId: journalLines.accountId, debitMinor: journalLines.debitMinor, creditMinor: journalLines.creditMinor })
          .from(journalLines)
          .where(eq(journalLines.entryId, orig.id));

        // One currency per entry (ADR 0021): the mirror keeps the original's
        // currency - reversing a foreign-currency entry in the base currency
        // double-counted it in FX exposure.
        // N13 correction provenance: the mirror lands in the approved open
        // period (postedAt = now) but carries the original business date, so
        // a backdated fix never pretends it happened there.
        const reversalEntryId = await postEntry(tx, ctx.actor.orgId, ctx.actor, {
          memo: `Reversal of: ${orig.memo}`,
          sourceType: "reversal",
          reversalOfId: orig.id,
          entryKind: "correction",
          businessAt: orig.postedAt,
          currency: orig.currency,
          postedAt: ctx.now,
          lines: origLines.map((l) => ({
            accountId: l.accountId,
            debitMinor: l.creditMinor,
            creditMinor: l.debitMinor,
          })),
        });
        return { reversalEntryId };
      });
    },
  });

const trialBalance = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.trialBalance",
    title: "Get trial balance",
    intent: "Total debits and credits per account; proves the books balance and shows balances by account",
    module: "accounting",
    risk: "read",
    permission: "accounting.read",
    input: z.object({}),
    output: z.object({
      lines: z.array(z.object({ code: z.string(), name: z.string(), debitMinor: z.number(), creditMinor: z.number() })),
      balanced: z.boolean(),
    }),
    execute: async (ctx) => {
      const rows = await deps.db
        .select({
          code: accounts.code,
          name: accounts.name,
          debitMinor: sql<number>`coalesce(sum(${journalLines.debitMinor}), 0)`,
          creditMinor: sql<number>`coalesce(sum(${journalLines.creditMinor}), 0)`,
        })
        .from(accounts)
        .leftJoin(journalLines, eq(journalLines.accountId, accounts.id))
        .leftJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
        .where(and(eq(accounts.orgId, ctx.actor.orgId), sql`${journalEntries.orgId} = ${ctx.actor.orgId}`))
        .groupBy(accounts.code, accounts.name)
        .orderBy(accounts.code);
      let debits = 0;
      let credits = 0;
      const lines = rows.map((r) => {
        debits += Number(r.debitMinor);
        credits += Number(r.creditMinor);
        return { code: r.code, name: r.name, debitMinor: Number(r.debitMinor), creditMinor: Number(r.creditMinor) };
      });
      return { lines, balanced: debits === credits };
    },
  });

// ── helpers ─────────────────────────────────────────────────────────────


async function accountBalances(
  deps: ModuleDeps,
  orgId: string,
  opts: { excludeClosing?: boolean; excludeClosingInYear?: number } = {},
): Promise<AccountBalance[]> {
  // Base-currency reporting (ADR 0021 §4): foreign-currency entries are
  // reported through FX exposure/settlement capabilities, never summed into
  // base totals silently.
  const base = await deps.db
    .select({ code: organizations.baseCurrency })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const baseCode = base[0]?.code ?? "USD";
  // Year-end rolls are bookkeeping machinery, not operations (N13):
  // excludeClosing drops the whole close family (rolls and their in-year
  // reversals) from operating results; excludeClosingInYear keeps other
  // years' rolls included so closing year Y zeroes only year Y.
  const closingFilter = opts.excludeClosing
    ? sql`${journalEntries.entryKind} <> 'year_end_close'`
    : opts.excludeClosingInYear !== undefined
      ? sql`NOT (${journalEntries.entryKind} = 'year_end_close' AND extract(year from ${journalEntries.postedAt}) = ${opts.excludeClosingInYear})`
      : sql`true`;
  const rows = await deps.db
    .select({
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      debitMinor: sql<number>`coalesce(sum(${journalLines.debitMinor}), 0)`,
      creditMinor: sql<number>`coalesce(sum(${journalLines.creditMinor}), 0)`,
    })
    .from(accounts)
    .leftJoin(journalLines, eq(journalLines.accountId, accounts.id))
    .leftJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(
      and(
        eq(accounts.orgId, orgId),
        sql`${journalEntries.orgId} = ${orgId}`,
        sql`(${journalEntries.currency} IS NULL OR ${journalEntries.currency} = ${baseCode})`,
        closingFilter,
      ),
    )
    .groupBy(accounts.code, accounts.name, accounts.type)
    .orderBy(accounts.code);
  return rows.map((r) => ({ ...r, type: r.type as AccountBalance["type"], debitMinor: Number(r.debitMinor), creditMinor: Number(r.creditMinor) }));
}


const incomeStatement = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.incomeStatement",
    title: "Profit & loss report",
    intent:
      "Show revenue minus expenses and net income from the ledger, so you know if the business is profitable",
    module: "accounting",
    risk: "read",
    permission: "accounting.read",
    input: z.object({}),
    output: z.object({
      revenueMinor: z.number(),
      expenseMinor: z.number(),
      netIncomeMinor: z.number(),
      lines: z.array(z.object({ code: z.string(), name: z.string(), amountMinor: z.number() })),
    }),
    execute: async (ctx) => {
      // The year-end roll must not erase history: closing a period zeroes
      // the income accounts on the books, but the P&L report still shows
      // the operating results those books recorded.
      const balances = await accountBalances(deps, ctx.actor.orgId, { excludeClosing: true });
      return computeIncomeStatement(balances);
    },
  });

const balanceSheet = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.balanceSheet",
    title: "Balance sheet",
    intent:
      "Show what the business owns, owes, and is worth right now; verifies assets equal liabilities plus equity plus results",
    module: "accounting",
    risk: "read",
    permission: "accounting.read",
    input: z.object({}),
    output: z.object({
      assetsMinor: z.number(),
      liabilitiesMinor: z.number(),
      equityMinor: z.number(),
      retainedResultMinor: z.number(),
      balanced: z.boolean(),
    }),
    execute: async (ctx) => {
      const balances = await accountBalances(deps, ctx.actor.orgId);
      const { sections: _sections, ...bs } = computeBalanceSheet(balances);
      return bs;
    },
  });

const closePeriodInput = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
});

const listInvoices = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.listInvoices",
    title: "List invoices",
    intent:
      "Find invoices by customer name or status so the agent can look up the invoice number needed to record a payment against it",
    module: "accounting",
    risk: "read",
    permission: "accounting.read",
    input: z.object({
      customerId: z.string().optional(),
      status: z.enum(["draft", "sent", "paid", "void"]).optional(),
      limit: z.number().int().positive().max(100).default(50),
    }),
    output: z.object({
      invoices: z.array(
        z.object({
          id: z.string(),
          number: z.number(),
          customerId: z.string(),
          customerName: z.string(),
          status: z.string(),
          totalMinor: z.number(),
          paidMinor: z.number(),
          creditedMinor: z.number(),
          outstandingMinor: z.number(),
          issuedAt: z.string().nullable(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      const q = deps.db
        .select({
          id: invoices.id,
          number: invoices.number,
          customerId: invoices.customerId,
          customerName: customers.name,
          status: invoices.status,
          totalMinor: invoices.totalMinor,
          paidMinor: invoices.paidMinor,
          creditedMinor: invoices.creditedMinor,
          issuedAt: invoices.issuedAt,
        })
        .from(invoices)
        .innerJoin(customers, eq(customers.id, invoices.customerId))
        .where(
          and(
            eq(invoices.orgId, ctx.actor.orgId),
            input.customerId ? eq(invoices.customerId, input.customerId) : sql`true`,
            input.status ? eq(invoices.status, input.status) : sql`true`,
          ),
        )
        .orderBy(desc(invoices.number))
        .limit(input.limit);
      const rows = await q;
      return {
        invoices: rows.map((r) => ({
          ...r,
          issuedAt: r.issuedAt?.toISOString() ?? null,
          // N11: the list shows the same credit-adjusted outstanding the
          // payment gate enforces, never a phantom receivable.
          outstandingMinor: documentBalance(r).outstandingMinor,
        })),
      };
    },
  });

const arAging = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.arAging",
    title: "AR aging report",
    intent:
      "Show outstanding customer invoices bucketed by days past due (current, 30, 60, 90+) so collections can be prioritized",
    module: "accounting",
    risk: "read",
    permission: "accounting.read",
    input: z.object({}),
    output: z.object({
      buckets: z.object({
        current: z.number(),
        d30: z.number(),
        d60: z.number(),
        d90plus: z.number(),
        totalOutstanding: z.number(),
      }),
      invoices: z.array(
        z.object({ number: z.number(), outstandingMinor: z.number(), ageDays: z.number() }),
      ),
    }),
    execute: async (ctx) => {
      const rows = await deps.db
        .select({
          number: invoices.number,
          totalMinor: invoices.totalMinor,
          paidMinor: invoices.paidMinor,
          creditedMinor: invoices.creditedMinor,
          issuedAt: invoices.issuedAt,
          dueAt: invoices.dueAt,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.orgId, ctx.actor.orgId),
            sql`${invoices.status} in ('sent', 'paid')`,
            sql`${invoices.voidedAt} is null`,
          ),
        );
      const DAY = 86_400_000;
      const receivables = rows
        .filter((r) => r.issuedAt !== null)
        .map((r) => {
          // N11: one balance contract - credits reduce what collections chases.
          const outstanding = documentBalance(r).outstandingMinor;
          return {
            invoiceNumber: r.number,
            outstandingMinor: outstanding,
            issuedAt: r.issuedAt as Date,
            dueAt: r.dueAt,
          };
        })
        .filter((r) => r.outstandingMinor > 0);
      const buckets = computeAging(receivables, ctx.now);
      return {
        buckets,
        invoices: receivables.map((r) => ({
          number: r.invoiceNumber,
          outstandingMinor: r.outstandingMinor,
          ageDays: Math.floor((ctx.now.getTime() - r.issuedAt.getTime()) / DAY),
        })),
      };
    },
  });

const closePeriod = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.closePeriod",
    title: "Close accounting period",
    intent:
      "Seal a calendar month so no further postings can land in it. Identity/destructive class: always requires human approval",
    module: "accounting",
    risk: "destructive",
    permission: "accounting.admin",
    inverse: {
      capabilityId: "accounting.reopenPeriod",
      buildInput: (input) => ({ year: (input as { year: number }).year, month: (input as { month: number }).month }),
    },
    input: z.object({ year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12) }),
    output: z.object({ closed: z.boolean() }),
    execute: async (ctx, input) => {
      // The close/reopen lock is the same one postEntry holds, so a posting
      // and a close always commit in one serial order (N13): either the
      // posting landed first or it refuses the sealed month.
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        await lockPeriodsForOrg(tx, ctx.actor.orgId);
        await tx
          .insert(periods)
          .values({ orgId: ctx.actor.orgId, year: input.year, month: input.month, closedByActorId: ctx.actor.id })
          .onConflictDoNothing();
        return { closed: true };
      });
    },
  });

const reopenPeriod = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.reopenPeriod",
    title: "Reopen accounting period",
    intent: "Unseal a previously closed month to allow corrective postings. Requires human approval",
    module: "accounting",
    risk: "destructive",
    permission: "accounting.admin",
    input: closePeriodInput,
    output: z.object({ reopened: z.boolean() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        await lockPeriodsForOrg(tx, ctx.actor.orgId);
        await tx.delete(periods).where(
          and(eq(periods.orgId, ctx.actor.orgId), eq(periods.year, input.year), eq(periods.month, input.month)),
        );
        return { reopened: true };
      });
    },
  });

const cashBasisReport = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.cashBasisReport",
    title: "Cash-basis report",
    intent:
      "Show money actually received and paid in a period from the ledger, with the accrual comparison, so you know real cash position versus booked income",
    module: "accounting",
    risk: "read",
    permission: "accounting.read",
    input: z.object({
      year: z.number().int().min(2000).max(2100),
      month: z.number().int().min(1).max(12).optional(),
      cashAccountCodes: z.array(z.string()).default(["1000"]),
    }),
    output: z.object({
      cashInMinor: z.number(),
      cashOutMinor: z.number(),
      netCashMinor: z.number(),
      accrualRevenueMinor: z.number(),
      accrualExpenseMinor: z.number(),
      uncollectedMinor: z.number(),
    }),
    execute: async (ctx, input) => {
      const entries = await deps.db
        .select({ id: journalEntries.id, postedAt: journalEntries.postedAt })
        .from(journalEntries)
        .where(eq(journalEntries.orgId, ctx.actor.orgId));
      const lineRows = await deps.db
        .select({
          entryId: journalLines.entryId,
          code: accounts.code,
          type: accounts.type,
          debitMinor: journalLines.debitMinor,
          creditMinor: journalLines.creditMinor,
        })
        .from(journalLines)
        .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
        .where(eq(journalEntries.orgId, ctx.actor.orgId));

      type Line = { accountCode: string; accountType: AccountBalance["type"]; debitMinor: number; creditMinor: number };
      const perEntry = new Map<string, { occurredAt: Date; lines: Line[] }>();
      for (const e of entries) perEntry.set(e.id, { occurredAt: e.postedAt, lines: [] });
      for (const l of lineRows) {
        const bucket = perEntry.get(l.entryId);
        if (!bucket) continue;
        bucket.lines.push({
          accountCode: l.code,
          accountType: l.type as AccountBalance["type"],
          debitMinor: Number(l.debitMinor),
          creditMinor: Number(l.creditMinor),
        });
      }

      const year = input.year;
      const from = new Date(Date.UTC(year, input.month ? input.month - 1 : 0, 1));
      const to = input.month
        ? new Date(Date.UTC(year, input.month, 1))
        : new Date(Date.UTC(year + 1, 0, 1));

      return computeCashBasis(
        [...perEntry.values()],
        new Set(input.cashAccountCodes),
        { from, to },
      );
    },
  });

const closeYear = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.closeYear",
    title: "Close fiscal year",
    intent:
      "Formally roll a fiscal year's profit or loss into retained earnings with one balanced closing entry and seal the December period. Destructive class: always requires human approval",
    module: "accounting",
    risk: "destructive",
    permission: "accounting.admin",
    inverse: {
      capabilityId: "accounting.reverseEntry",
      buildInput: (_input, output) => ({ entryId: output.closingEntryId }),
    },
    input: z.object({ year: z.number().int().min(2000).max(2100) }),
    output: z.object({
      closingEntryId: z.string(),
      replacedEntryId: z.string().nullable(),
      netIncomeMinor: z.number(),
      retainedEarningsMinor: z.number(),
    }),
    execute: async (ctx, input) => {
      // Rolls of the year being closed are excluded (full-year operating
      // result, one live roll), other years' rolls stay included so a
      // re-close never re-rolls income a prior close already zeroed.
      const balances = await accountBalances(deps, ctx.actor.orgId, { excludeClosingInYear: input.year });
      const close = computeYearEndClose(balances, "3100");

      if (close.closingLines.length === 0 && close.netIncomeMinor === 0) {
        throw new Error(`fiscal year ${input.year} has no income or expense activity to close`);
      }

      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        // The roll is an exceptional entry with an explicit kind: at most
        // one live roll per sealed year - live means not itself referenced
        // by a replacement reversal, or a second re-close would undo a
        // stale roll twice. Re-closing after a reopen replaces the live
        // roll - reversed in the reopened December, never in the current
        // period - before the fresh roll lands, so retained earnings is
        // rolled once, not twice.
        const [liveRoll] = await tx
          .select({ id: journalEntries.id, postedAt: journalEntries.postedAt })
          .from(journalEntries)
          .where(
            and(
              eq(journalEntries.orgId, ctx.actor.orgId),
              eq(journalEntries.entryKind, "year_end_close"),
              isNull(journalEntries.reversalOfId),
              sql`extract(year from ${journalEntries.postedAt}) = ${input.year}`,
              sql`NOT EXISTS (
                SELECT 1 FROM journal_entries prior
                WHERE prior.reversal_of_id = ${journalEntries.id}
                  AND prior.entry_kind = 'year_end_close'
              )`,
            ),
          )
          .limit(1);
        let replacedEntryId: string | null = null;
        if (liveRoll) {
          const priorLines = await tx
            .select({ accountId: journalLines.accountId, debitMinor: journalLines.debitMinor, creditMinor: journalLines.creditMinor })
            .from(journalLines)
            .where(eq(journalLines.entryId, liveRoll.id));
          await postEntry(tx, ctx.actor.orgId, ctx.actor, {
            memo: `Reversal of year-end close ${input.year} (replaced by re-close)`,
            sourceType: "reversal",
            reversalOfId: liveRoll.id,
            entryKind: "year_end_close",
            postedAt: liveRoll.postedAt,
            lines: priorLines.map((l) => ({
              accountId: l.accountId,
              debitMinor: l.creditMinor,
              creditMinor: l.debitMinor,
            })),
          });
          replacedEntryId = liveRoll.id;
        }

        const allLines = [...close.closingLines, close.retainedEarningsLine];
        const closingEntryId = await postEntry(tx, ctx.actor.orgId, ctx.actor, {
          memo: `Year-end close ${input.year}: net income ${(close.netIncomeMinor / 100).toFixed(2)} rolled to retained earnings`,
          sourceType: "manual",
          entryKind: "year_end_close",
          postedAt: new Date(Date.UTC(input.year, 11, 31, 23, 59, 59)),
          lines: allLines.map((l) => ({
            accountCode: l.accountCode,
            debitMinor: l.debitMinor,
            creditMinor: l.creditMinor,
          })),
        });
        // Seal December so late postings cannot land inside a closed year.
        await tx
          .insert(periods)
          .values({ orgId: ctx.actor.orgId, year: input.year, month: 12, closedByActorId: ctx.actor.id })
          .onConflictDoNothing();
        return {
          closingEntryId,
          replacedEntryId,
          netIncomeMinor: close.netIncomeMinor,
          retainedEarningsMinor: Math.abs(close.netIncomeMinor),
        };
      });
    },
  });

const recordFxRate = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.recordFxRate",
    title: "Record FX rate",
    intent:
      "Post an exchange rate between the organization's base currency and a foreign currency as a dated fact used for invoicing, settlement and exposure reporting",
    module: "accounting",
    risk: "write",
    permission: "accounting.post",
    input: z.object({
      quoteCurrency: z.string().min(3).max(3),
      /** 1 quote unit in base units as an exact decimal, e.g. "1.0875". */
      rate: z.string(),
      /** ISO datetime string; defaults to now. Dates are strings on the wire so schemas stay JSON-serializable. */
      effectiveAt: z.string().datetime().optional(),
    }),
    output: z.object({ rateId: z.string(), num: z.number(), den: z.number() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        if (currencyMinorUnits(input.quoteCurrency) === null) {
          throw new Error(`unknown currency code: ${input.quoteCurrency}`);
        }
        const rate = fxRateFromDecimal(input.rate);
        if (!rate) throw new Error("invalid rate; use a positive decimal like 1.0875");
        const base = await baseCurrencyOf(tx, ctx.actor.orgId);
        const [row] = await tx
          .insert(fxRates)
          .values({
            orgId: ctx.actor.orgId,
            base,
            quote: input.quoteCurrency.toUpperCase(),
            rateNum: rate.num,
            rateDen: rate.den,
            effectiveAt: input.effectiveAt ? new Date(input.effectiveAt) : ctx.now,
            source: "manual",
            recordedByActorType: ctx.actor.type,
            recordedByActorId: ctx.actor.id,
          })
          .returning({ id: fxRates.id });
        return { rateId: row!.id, num: rate.num, den: rate.den };
      });
    },
  });

const unrealizedFxExposure = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.unrealizedFxExposure",
    title: "Report FX exposure",
    intent:
      "Show outstanding receivables per foreign currency converted at the latest posted rates so the organization can see its unrealized exchange-rate exposure before it settles",
    module: "accounting",
    risk: "read",
    permission: "accounting.read",
    input: z.object({}),
    output: z.object({
      exposures: z.array(
        z.object({
          currency: z.string(),
          outstandingForeignMinor: z.number(),
          latestRateNum: z.number().nullable(),
          latestRateDen: z.number().nullable(),
          outstandingBaseMinor: z.number().nullable(),
        }),
      ),
    }),
    execute: async (ctx, _input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const base = await baseCurrencyOf(tx, ctx.actor.orgId);
        const rows = await tx
          .select({
            currency: invoices.currency,
            outstanding: sql<number>`coalesce(sum(greatest(${invoices.totalMinor} - ${invoices.creditedMinor} - ${invoices.paidMinor}, 0)), 0)`,
          })
          .from(invoices)
          .where(
            and(
              eq(invoices.orgId, ctx.actor.orgId),
              sql`${invoices.currency} <> ${base}`,
              sql`${invoices.status} <> 'void'`,
            ),
          )
          .groupBy(invoices.currency);
        const exposures = [];
        for (const r of rows) {
          const outstanding = Number(r.outstanding);
          const rate = await latestRate(tx, ctx.actor.orgId, base, r.currency, new Date());
          exposures.push({
            currency: r.currency,
            outstandingForeignMinor: outstanding,
            latestRateNum: rate?.num ?? null,
            latestRateDen: rate?.den ?? null,
            outstandingBaseMinor: rate ? toBaseMinor(outstanding, rate) : null,
          });
        }
        return { exposures };
      });
    },
  });


// ── Quotes (convert through the same posting path as createInvoice) ────

const quoteCreate = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.createQuote",
    title: "Create quote",
    intent:
      "Draft a price quote for a customer with line items so they can accept it later and it becomes an invoice without retyping anything",
    module: "accounting",
    risk: "write",
    permission: "accounting.write",
    input: z.object({
      customerId: z.string(),
      memo: z.string().optional(),
      /** Past this instant the quote can no longer be accepted (M9). */
      expiresAt: z.string().datetime().optional(),
      lines: z.array(lineSchema).min(1),
    }),
    output: z.object({ quoteId: z.string(), quoteNumber: z.number(), totalMinor: z.number() }),
    inverse: {
      capabilityId: "accounting.declineQuote",
      buildInput: (_input, output) => ({ quoteId: output.quoteId }),
    },
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const cust = await tx
          .select({ id: customers.id })
          .from(customers)
          .where(and(eq(customers.id, input.customerId), eq(customers.orgId, ctx.actor.orgId)))
          .limit(1);
        if (cust.length === 0) throw new Error("customer not found");
        const totals = computeInvoiceTotals(input.lines.map((l) => ({ ...l, taxMinor: l.taxMinor ?? 0 })));
        const number = await nextDocNumber(tx, ctx.actor.orgId, "quote");
        const [q] = await tx
          .insert(quotes)
          .values({
            orgId: ctx.actor.orgId,
            customerId: input.customerId,
            number,
            status: "sent",
            subtotalMinor: totals.subtotalMinor,
            taxMinor: totals.taxMinor,
            totalMinor: totals.totalMinor,
            memo: input.memo ?? null,
            // Normalize: the registry validates inputs, but direct execute
            // (tests, internal calls) may hand us an ISO string.
            expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
            createdByActorType: ctx.actor.type,
            createdByActorId: ctx.actor.id,
          })
          .returning({ id: quotes.id });
        await tx.insert(quoteLines).values(
          input.lines.map((l) => ({
            quoteId: q!.id,
            description: l.description,
            quantity: l.quantity,
            unitPriceMinor: l.unitPriceMinor,
            taxMinor: l.taxMinor ?? 0,
          })),
        );
        return { quoteId: q!.id, quoteNumber: number, totalMinor: totals.totalMinor };
      });
    },
  });

const quoteAccept = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.acceptQuote",
    title: "Accept quote into invoice",
    intent:
      "Convert an accepted customer quote into a real invoice on the books; the quote is marked accepted and linked to the invoice it produced",
    module: "accounting",
    risk: "write",
    permission: "accounting.write",
    input: z.object({ quoteId: z.string().uuid() }),
    output: z.object({ invoiceId: z.string(), invoiceNumber: z.number(), totalMinor: z.number() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [q] = await tx
          .select()
          .from(quotes)
          .where(and(eq(quotes.id, input.quoteId), eq(quotes.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!q) throw new Error("quote not found");
        if (q.status !== "sent") throw new Error(`quote is ${q.status}; only sent quotes convert`);
        if (q.expiresAt && q.expiresAt.getTime() <= ctx.now.getTime()) {
          throw new Error(
            `quote expired on ${q.expiresAt.toISOString().slice(0, 10)}; decline it and issue a fresh quote`,
          );
        }

        const lines = await tx
          .select({
            description: quoteLines.description,
            quantity: quoteLines.quantity,
            unitPriceMinor: quoteLines.unitPriceMinor,
            taxMinor: quoteLines.taxMinor,
          })
          .from(quoteLines)
          .where(eq(quoteLines.quoteId, q.id))
          .orderBy(quoteLines.id);

        // Conditional claim: first writer converts, racers see it accepted.
        const claimed = await tx
          .update(quotes)
          .set({ status: "accepted", decidedAt: ctx.now })
          .where(and(eq(quotes.id, q.id), eq(quotes.status, "sent")))
          .returning({ id: quotes.id });
        if (claimed.length === 0) throw new Error("quote was just decided by someone else");

        const created = await insertInvoiceWithPosting(tx, ctx, {
          customerId: q.customerId,
          memo: q.memo ?? undefined,
          lines,
        });
        await tx.update(quotes).set({ convertedInvoiceId: created.invoiceId }).where(eq(quotes.id, q.id));
        return {
          invoiceId: created.invoiceId,
          invoiceNumber: created.invoiceNumber,
          totalMinor: created.totalMinor,
        };
      });
    },
  });

const quoteDecline = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.declineQuote",
    title: "Decline or void quote",
    intent:
      "Mark a customer quote as declined or withdraw it so it can no longer be converted into an invoice",
    module: "accounting",
    risk: "write",
    permission: "accounting.write",
    input: z.object({ quoteId: z.string().uuid() }),
    output: z.object({ status: z.literal("declined") }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const updated = await tx
          .update(quotes)
          .set({ status: "declined", decidedAt: ctx.now })
          .where(
            and(
              eq(quotes.id, input.quoteId),
              eq(quotes.orgId, ctx.actor.orgId),
              sql`${quotes.status} IN ('draft','sent')`,
            ),
          )
          .returning({ id: quotes.id });
        if (updated.length === 0) throw new Error("quote not found or already decided");
        return { status: "declined" as const };
      });
    },
  });

/**
 * Marks every sent quote whose validity has lapsed as expired (M9).
 * No inverse: expiry is honest archiving - acceptance is refused past the
 * deadline regardless, so un-expiring would only invite overwriting history
 * with a lie. Declining stays available for anything that needs a decision
 * recorded.
 */
const quoteExpire = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.expireQuote",
    title: "Expire lapsed quotes",
    intent:
      "Sweep all sent quotes past their validity date into expired so the pipeline stops showing dead quotes as open",
    module: "accounting",
    risk: "write",
    permission: "accounting.write",
    input: z.object({}),
    output: z.object({ expiredCount: z.number().int() }),
    execute: async (ctx) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const expired = await tx
          .update(quotes)
          .set({ status: "expired", decidedAt: ctx.now })
          .where(
            and(
              eq(quotes.orgId, ctx.actor.orgId),
              eq(quotes.status, "sent"),
              lt(quotes.expiresAt, ctx.now),
            ),
          )
          .returning({ id: quotes.id });
        return { expiredCount: expired.length };
      });
    },
  });

const quoteList = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.listQuotes",
    title: "List quotes",
    intent:
      "Show the organization's price quotes with their totals and status so sales can follow up on open ones",
    module: "accounting",
    risk: "read",
    permission: "accounting.read",
    input: z.object({ status: z.enum(["draft", "sent", "accepted", "declined", "expired"]).optional() }),
    output: z.object({
      quotes: z.array(
        z.object({
          id: z.string(),
          number: z.number(),
          status: z.string(),
          totalMinor: z.number(),
          customerId: z.string(),
          createdAt: z.date(),
          invoiceId: z.string().nullable(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      const rows = await deps.db
        .select({
          id: quotes.id,
          number: quotes.number,
          status: quotes.status,
          totalMinor: quotes.totalMinor,
          customerId: quotes.customerId,
          createdAt: quotes.createdAt,
          invoiceId: quotes.convertedInvoiceId,
        })
        .from(quotes)
        .where(
          and(
            eq(quotes.orgId, ctx.actor.orgId),
            input.status ? eq(quotes.status, input.status) : undefined,
          ),
        )
        .orderBy(desc(quotes.createdAt))
        .limit(100);
      return { quotes: rows };
    },
  });

// ── Recurring invoicing templates (worker expands them via governed path) ──

const accountingCreateTemplate = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.createRecurringTemplate",
    title: "Create recurring invoice",
    intent:
      "Set up a subscription-style invoice that repeats weekly, monthly or quarterly for a customer, generating real invoices automatically on schedule",
    module: "accounting",
    risk: "write",
    permission: "accounting.write",
    input: z.object({
      customerId: z.string().uuid(),
      frequency: z.enum(["weekly", "monthly", "quarterly"]),
      memo: z.string().max(300).optional(),
      lines: z.array(lineSchema).min(1),
      /** First generation moment as ISO datetime; defaults to now (due immediately). */
      firstRunAt: z.string().datetime().optional(),
    }),
    output: z.object({ templateId: z.string(), nextRunAt: z.date() }),
    inverse: {
      capabilityId: "accounting.pauseRecurringTemplate",
      buildInput: (_input, output) => ({
        templateId: output.templateId,
      }),
    },
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const cust = await tx
          .select({ id: customers.id })
          .from(customers)
          .where(and(eq(customers.id, input.customerId), eq(customers.orgId, ctx.actor.orgId)))
          .limit(1);
        if (cust.length === 0) throw new Error("customer not found");
        const [row] = await tx
          .insert(recurringInvoices)
          .values({
            orgId: ctx.actor.orgId,
            customerId: input.customerId,
            frequency: input.frequency,
            lines: input.lines,
            memo: input.memo ?? null,
            nextRunAt: input.firstRunAt ? new Date(input.firstRunAt) : ctx.now,
            createdByActorType: ctx.actor.type,
            createdByActorId: ctx.actor.id,
          })
          .returning({ id: recurringInvoices.id });
        return { templateId: row!.id, nextRunAt: input.firstRunAt ? new Date(input.firstRunAt) : ctx.now };
      });
    },
  });

const accountingPauseTemplate = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.pauseRecurringTemplate",
    title: "Pause recurring invoice",
    intent:
      "Stop a repeating invoice from generating further bills while keeping its line items for later resumption",
    module: "accounting",
    risk: "write",
    permission: "accounting.write",
    input: z.object({ templateId: z.string().uuid() }),
    output: z.object({ active: z.literal(false) }),
    inverse: {
      capabilityId: "accounting.resumeRecurringTemplate",
      buildInput: (input) => ({ templateId: input.templateId }),
    },
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const rows = await tx
          .update(recurringInvoices)
          .set({ active: false })
          .where(
            and(eq(recurringInvoices.id, input.templateId), eq(recurringInvoices.orgId, ctx.actor.orgId)),
          )
          .returning({ id: recurringInvoices.id });
        if (rows.length === 0) throw new Error("template not found");
        return { active: false as const };
      });
    },
  });

const accountingResumeTemplate = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.resumeRecurringTemplate",
    title: "Resume recurring invoice",
    intent:
      "Turn a paused repeating invoice back on so billing continues from today onward",
    module: "accounting",
    risk: "write",
    permission: "accounting.write",
    input: z.object({ templateId: z.string().uuid() }),
    output: z.object({ active: z.literal(true) }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const rows = await tx
          .update(recurringInvoices)
          .set({ active: true, nextRunAt: ctx.now })
          .where(
            and(eq(recurringInvoices.id, input.templateId), eq(recurringInvoices.orgId, ctx.actor.orgId)),
          )
          .returning({ id: recurringInvoices.id });
        if (rows.length === 0) throw new Error("template not found");
        return { active: true as const };
      });
    },
  });

const accountingListTemplates = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.listRecurringTemplates",
    title: "List recurring invoices",
    intent:
      "Show every repeating invoice template with its schedule and whether it is currently active",
    module: "accounting",
    risk: "read",
    permission: "accounting.read",
    input: z.object({}),
    output: z.object({
      templates: z.array(
        z.object({
          id: z.string(),
          customerId: z.string(),
          frequency: z.string(),
          active: z.boolean(),
          nextRunAt: z.date(),
        }),
      ),
    }),
    execute: async (ctx) => {
      const rows = await deps.db
        .select({
          id: recurringInvoices.id,
          customerId: recurringInvoices.customerId,
          frequency: recurringInvoices.frequency,
          active: recurringInvoices.active,
          nextRunAt: recurringInvoices.nextRunAt,
        })
        .from(recurringInvoices)
        .where(eq(recurringInvoices.orgId, ctx.actor.orgId))
        .orderBy(desc(recurringInvoices.createdAt))
        .limit(100);
      return { templates: rows };
    },
  });

// ── Employee expense claims ─────────────────────────────────────────────

const expenseSubmit = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.submitExpenseClaim",
    title: "Submit expense claim",
    intent:
      "File a reimbursable business expense with amount and explanation so a manager can approve it for payment",
    module: "accounting",
    risk: "write",
    permission: "expenses.submit",
    input: z.object({
      amountMinor: z.number().int().positive(),
      memo: z.string().min(3).max(500),
      accountCode: z.string().optional(),
      /** Overrides the rules-first suggestion from the memo (M11). */
      category: z.string().max(40).optional(),
      /** Receipt attached through the documents seam (M11). */
      documentId: z.string().uuid().optional(),
    }),
    output: z.object({
      claimId: z.string(),
      status: z.literal("submitted"),
      category: z.string(),
      overPolicyLimit: z.boolean(),
      policyLimitMinor: z.number().nullable(),
    }),
    inverse: {
      capabilityId: "accounting.decideExpenseClaim",
      buildInput: (_input, output) => ({
        claimId: output.claimId,
        decision: "rejected" as unknown as string,
        reason: "withdrawn by submitter inverse",
      }),
    },
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const base = await baseCurrencyOf(tx, ctx.actor.orgId);
        const category = input.category ?? suggestExpenseCategory(input.memo);
        const policies = await tx.select({ category: expensePolicies.category, limitMinor: expensePolicies.limitMinor }).from(expensePolicies).where(eq(expensePolicies.orgId, ctx.actor.orgId));
        const policy = evaluateExpensePolicy(category, input.amountMinor, policies);
        const [row] = await tx
          .insert(expenseClaims)
          .values({
            orgId: ctx.actor.orgId,
            claimantUserId: ctx.actor.id!,
            amountMinor: input.amountMinor,
            currency: base,
            memo: input.memo,
            accountCode: input.accountCode ?? null,
            category,
            documentId: input.documentId ?? null,
          })
          .returning({ id: expenseClaims.id });
        return {
          claimId: row!.id,
          status: "submitted" as const,
          category,
          overPolicyLimit: policy.overLimit,
          policyLimitMinor: policy.limitMinor,
        };
      });
    },
  });

const expenseDecide = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.decideExpenseClaim",
    title: "Decide expense claim",
    intent:
      "Approve or reject a submitted employee expense claim, recording who decided and why before any money moves",
    module: "accounting",
    risk: "write",
    permission: "expenses.decide",
    input: z.object({
      claimId: z.string().uuid(),
      decision: z.enum(["approved", "rejected"]),
      reason: z.string().max(500).optional(),
    }),
    output: z.object({ claimId: z.string(), status: z.string() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const rows = await tx
          .update(expenseClaims)
          .set({
            status: input.decision,
            decidedByActorType: ctx.actor.type,
            decidedByActorId: ctx.actor.id,
            decisionReason: input.reason ?? null,
          })
          .where(
            and(
              eq(expenseClaims.id, input.claimId),
              eq(expenseClaims.orgId, ctx.actor.orgId),
              eq(expenseClaims.status, "submitted"),
            ),
          )
          .returning({ id: expenseClaims.id });
        if (rows.length === 0) throw new Error("claim not found or already decided");
        return { claimId: input.claimId, status: input.decision };
      });
    },
  });

const expensePay = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.payExpenseClaim",
    title: "Pay approved expense claim",
    intent:
      "Reimburse an approved expense claim by postting cash out against the right expense account; amounts above the policy threshold need approval",
    module: "accounting",
    risk: "money",
    permission: "accounting.post",
    moneyThresholdMinor: 50_000,
    moneyAmount: (input) => input.amountMinor,
    input: z.object({
      claimId: z.string().uuid(),
      amountMinor: z.number().int().positive().describe("must equal the approved claim amount"),
    }),
    output: z.object({ claimId: z.string(), entryId: z.string(), paidMinor: z.number() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [claim] = await tx
          .select()
          .from(expenseClaims)
          .where(
            and(eq(expenseClaims.id, input.claimId), eq(expenseClaims.orgId, ctx.actor.orgId)),
          )
          .limit(1);
        if (!claim) throw new Error("claim not found");
        if (claim.status !== "approved") throw new Error(`claim is ${claim.status}, not approved`);
        if (claim.amountMinor !== input.amountMinor) {
          throw new Error(`amount mismatch: approved ${claim.amountMinor}`);
        }
        const entryId = await postEntry(tx, ctx.actor.orgId, ctx.actor, {
          memo: `Expense reimbursement: ${claim.memo.slice(0, 80)}`,
          sourceType: "expense_claim",
          sourceId: claim.id,
          currency: claim.currency,
          postedAt: ctx.now,
          lines: [
            { accountCode: claim.accountCode ?? "6900", debitMinor: claim.amountMinor, creditMinor: 0 },
            { accountCode: "1000", debitMinor: 0, creditMinor: claim.amountMinor },
          ],
        });
        await tx
          .update(expenseClaims)
          .set({ status: "paid", paymentEntryId: entryId })
          .where(eq(expenseClaims.id, claim.id));
        return { claimId: claim.id, entryId, paidMinor: claim.amountMinor };
      });
    },
  });

const expenseList = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.listExpenseClaims",
    title: "List expense claims",
    intent:
      "Review submitted and decided expense claims so managers can act on pending reimbursements quickly",
    module: "accounting",
    risk: "read",
    permission: "expenses.decide",
    input: z.object({ status: z.enum(["submitted", "approved", "rejected", "paid"]).optional() }),
    output: z.object({
      claims: z.array(
        z.object({
          id: z.string(),
          claimantUserId: z.string(),
          amountMinor: z.number(),
          status: z.string(),
          memo: z.string(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      const rows = await deps.db
        .select({
          id: expenseClaims.id,
          claimantUserId: expenseClaims.claimantUserId,
          amountMinor: expenseClaims.amountMinor,
          status: expenseClaims.status,
          memo: expenseClaims.memo,
        })
        .from(expenseClaims)
        .where(
          and(
            eq(expenseClaims.orgId, ctx.actor.orgId),
            input.status ? eq(expenseClaims.status, input.status) : undefined,
          ),
        )
        .orderBy(desc(expenseClaims.createdAt))
        .limit(100);
      return { claims: rows };
    },
  });

// ── Customer portal share links ─────────────────────────────────────────

const shareInvoice = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.shareInvoice",
    title: "Share invoice link",
    intent:
      "Create a private read-only link a customer can open to see their own invoice status without signing in; links can be revoked anytime",
    module: "accounting",
    risk: "write",
    permission: "accounting.write",
    input: z.object({
      invoiceNumber: z.number().int().positive(),
      revoke: z.boolean().default(false),
      token: z.string().optional(),
    }),
    output: z.union([
      z.object({ token: z.string(), urlPath: z.string() }),
      z.object({ revoked: z.boolean() }),
    ]),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        if (input.revoke) {
          if (!input.token) throw new Error("revoke requires the token to revoke");
          await tx
            .update(invoiceShares)
            .set({ revokedAt: ctx.now })
            .where(
              and(eq(invoiceShares.token, input.token), eq(invoiceShares.orgId, ctx.actor.orgId)),
            );
          return { revoked: true };
        }
        const [inv] = await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(and(eq(invoices.orgId, ctx.actor.orgId), eq(invoices.number, input.invoiceNumber)))
          .limit(1);
        if (!inv) throw new Error("invoice not found");
        const token = randomBytes(24).toString("base64url");
        await tx.insert(invoiceShares).values({
          orgId: ctx.actor.orgId,
          invoiceId: inv.id,
          token,
          createdByActorType: ctx.actor.type,
          createdByActorId: ctx.actor.id,
        });
        return { token, urlPath: `/portal/${token}` };
      });
    },
  });


/**
 * Worker entry point for the durable job queue: expands every active
 * recurring template whose next run is due, posting each through the same
 * shared invoice path as manual creation. Idempotent per schedule tick
 * because nextRunAt advances past `now` in the same transaction.
 */
const generateDueInvoices = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.generateDueInvoices",
    title: "Generate due recurring invoices",
    intent:
      "Expand every active recurring invoice template that is due into a posted invoice and advance its schedule, so subscriptions bill without double-billing",
    module: "accounting",
    risk: "write",
    permission: "accounting.write",
    // No mechanical inverse: generated invoices reverse via
    // accounting.reverseEntry on their own entry ids; the schedule itself
    // is state, not an undoable action.
    input: z.object({}),
    output: z.object({ generated: z.number() }),
    execute: async (ctx) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const result = (await tx.execute(sql`
          SELECT
            id,
            org_id AS "orgId",
            customer_id AS "customerId",
            memo,
            frequency,
            lines,
            next_run_at AS "nextRunAt"
          FROM recurring_invoices
          WHERE org_id = ${ctx.actor.orgId}
            AND active = true
            AND next_run_at <= ${ctx.now.toISOString()}::timestamptz
          ORDER BY next_run_at, id
          FOR UPDATE SKIP LOCKED
        `)) as unknown as Record<string, unknown>[] | { rows: Record<string, unknown>[] };
        const due = Array.isArray(result) ? result : (result.rows ?? []);
        let generated = 0;
        for (const t of due) {
          const templateId = String(t.id);
          const scheduledFor = t.nextRunAt instanceof Date ? new Date(t.nextRunAt) : new Date(String(t.nextRunAt));
          const [occurrence] = await tx
            .insert(recurringInvoiceRuns)
            .values({
              orgId: ctx.actor.orgId,
              recurringInvoiceId: templateId,
              scheduledFor,
            })
            .onConflictDoNothing({
              target: [
                recurringInvoiceRuns.orgId,
                recurringInvoiceRuns.recurringInvoiceId,
                recurringInvoiceRuns.scheduledFor,
              ],
            })
            .returning({ id: recurringInvoiceRuns.id });
          if (!occurrence) continue;

          const created = await insertInvoiceWithPosting(tx, ctx, {
            customerId: String(t.customerId),
            memo: t.memo ? String(t.memo) : `Recurring (${String(t.frequency)})`,
            lines: t.lines as Array<{ description: string; quantity: number; unitPriceMinor: number; taxMinor?: number }>,
          });
          const nextRunAt = nextRunAfter(String(t.frequency) as "weekly" | "monthly" | "quarterly", scheduledFor);
          await tx
            .update(recurringInvoices)
            .set({ nextRunAt, lastRunAt: ctx.now })
            .where(and(eq(recurringInvoices.id, templateId), eq(recurringInvoices.orgId, ctx.actor.orgId)));
          await tx
            .update(recurringInvoiceRuns)
            .set({ invoiceId: created.invoiceId, status: "completed", completedAt: ctx.now })
            .where(eq(recurringInvoiceRuns.id, occurrence.id));
          generated += 1;
        }
        return { generated };
      });
    },
  });

// ── Bank feeds & reconciliation ─────────────────────────────────────────

const bankFeedRow = z.object({
  postedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountMinor: z.number().int(),
  description: z.string().min(1),
});

const addBankAccount = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.addBankAccount",
    title: "Add bank account",
    intent:
      "Register an external bank account so imported statement lines land somewhere and can be reconciled against the books",
    module: "accounting",
    risk: "write",
    permission: "accounting.write",
    // No mechanical inverse: deleting an account would cascade away its
    // statement history, which are reconciliation facts. An unused account
    // is simply left dormant rather than erased.
    input: z.object({
      name: z.string().min(1),
      currencyCode: z.string().length(3).uppercase().default("USD"),
      last4: z.string().regex(/^\d{4}$/).optional(),
      balanceMinor: z.number().int().default(0),
    }),
    output: z.object({ bankAccountId: z.string() }),
    execute: async (ctx, input) => {
      const [row] = await deps.db
        .insert(bankAccounts)
        .values({
          orgId: ctx.actor.orgId,
          name: input.name,
          currencyCode: input.currencyCode,
          last4: input.last4 ?? null,
          balanceMinor: input.balanceMinor,
        })
        .returning({ id: bankAccounts.id });
      return { bankAccountId: row!.id };
    },
  });

const importBankFeed = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.importBankFeed",
    title: "Import bank feed",
    intent:
      "Load statement lines from a bank export so real cash movements appear for matching against payments and ledger entries",
    module: "accounting",
    risk: "write",
    permission: "accounting.write",
    // No mechanical inverse: an import records external facts, and each row
    // has its own undo paths - unmatch/unexclude reset state and
    // accounting.deleteBankTransaction removes an erroneously imported line.
    input: z.object({
      /** Omitted = the org's only account; ambiguous with several. */
      bankAccountId: z.string().uuid().optional(),
      rows: z.array(bankFeedRow).min(1).max(500),
    }),
    output: z.object({ inserted: z.number(), skipped: z.number() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        let accountId = input.bankAccountId;
        if (!accountId) {
          const existing = await tx
            .select({ id: bankAccounts.id })
            .from(bankAccounts)
            .where(eq(bankAccounts.orgId, ctx.actor.orgId));
          if (existing.length !== 1) {
            throw new Error(
              existing.length === 0
                ? "no bank account yet; add one first"
                : "several bank accounts exist; pass bankAccountId",
            );
          }
          accountId = existing[0]!.id;
        }
        const [acct] = await tx
          .select({ id: bankAccounts.id })
          .from(bankAccounts)
          .where(and(eq(bankAccounts.id, accountId), eq(bankAccounts.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!acct) throw new Error("bank account not found");

        // Idempotency: exact duplicate lines (same day, amount, text) within
        // the account are skipped, so re-pasting the same export is safe.
        const seen = new Set(
          (
            await tx
              .select({
                postedAt: bankTransactions.postedAt,
                amountMinor: bankTransactions.amountMinor,
                description: bankTransactions.description,
              })
              .from(bankTransactions)
              .where(and(eq(bankTransactions.orgId, ctx.actor.orgId), eq(bankTransactions.bankAccountId, accountId)))
          ).map((r) => `${r.postedAt.toISOString()}|${r.amountMinor}|${r.description}`),
        );

        const fresh = [];
        let skipped = 0;
        for (const r of input.rows) {
          const postedAt = new Date(`${r.postedAt}T00:00:00Z`);
          if (Number.isNaN(postedAt.getTime())) throw new Error(`invalid date: ${r.postedAt}`);
          const key = `${postedAt.toISOString()}|${r.amountMinor}|${r.description}`;
          if (seen.has(key)) {
            skipped += 1;
            continue;
          }
          seen.add(key);
          fresh.push({
            orgId: ctx.actor.orgId,
            bankAccountId: accountId,
            postedAt,
            amountMinor: r.amountMinor,
            description: r.description,
          });
        }
        if (fresh.length > 0) await tx.insert(bankTransactions).values(fresh);
        return { inserted: fresh.length, skipped };
      });
    },
  });

const deleteBankTransaction = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.deleteBankTransaction",
    title: "Remove bank transaction",
    intent:
      "Delete an unmatched statement line imported by mistake; this is the undo path that makes feed imports reversible",
    module: "accounting",
    risk: "write",
    permission: "accounting.write",
    // Deletion of a raw fact is deliberately terminal - the line came from
    // the bank's export, so the real restore path is importing it again.
    input: z.object({ transactionId: z.string().uuid() }),
    output: z.object({ deleted: z.boolean() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const removed = await tx
          .delete(bankTransactions)
          .where(
            and(
              eq(bankTransactions.id, input.transactionId),
              eq(bankTransactions.orgId, ctx.actor.orgId),
              eq(bankTransactions.status, "unmatched"),
            ),
          )
          .returning({ id: bankTransactions.id });
        if (removed.length === 0) throw new Error("transaction not found or already matched/excluded");
        return { deleted: true };
      });
    },
  });

/** The org's cash account; bank matching reconciles statement lines against it. */
const CASH_ACCOUNT_CODE = "1000";

const matchBankTransaction = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.matchBankTransaction",
    title: "Match bank transaction",
    intent:
      "Explain a bank statement line with explicit allocations - a payment (whole or partial), a journal entry, a reviewed fee, or an FX difference - so the line's money is fully accounted for",
    module: "accounting",
    risk: "write",
    permission: "accounting.write",
    inverse: {
      capabilityId: "accounting.unmatchBankTransaction",
      buildInput: (input) => ({ transactionId: (input as { transactionId: string }).transactionId }),
    },
    input: z
      .object({
        transactionId: z.string().uuid(),
        paymentId: z.string().uuid().optional(),
        entryId: z.string().uuid().optional(),
        /** Portion of the line the payment explains; defaults to the full line (minus reviewed differences). Splits allocate the rest on other lines. */
        amountMinor: z.number().int().positive().optional(),
        /** Reviewed bank fee the statement line includes on top of the payment. */
        feeMinor: z.number().int().positive().optional(),
        /** Reviewed FX difference between the payment and the statement line. */
        fxGainLossMinor: z.number().int().optional(),
        note: z.string().max(500).optional(),
      })
      .refine((v) => (v.paymentId !== undefined) !== (v.entryId !== undefined), {
        message: "pass exactly one of paymentId or entryId",
      })
      .refine((v) => v.feeMinor === undefined || v.paymentId !== undefined, {
        message: "feeMinor requires paymentId",
      })
      .refine((v) => v.fxGainLossMinor === undefined || v.paymentId !== undefined, {
        message: "fxGainLossMinor requires paymentId",
      })
      .refine((v) => v.amountMinor === undefined || (v.feeMinor === undefined && v.fxGainLossMinor === undefined), {
        message: "amountMinor (partial split) cannot be combined with feeMinor or fxGainLossMinor",
      }),
    output: z.object({
      status: z.literal("matched"),
      allocatedMinor: z.number(),
      lineUnexplainedMinor: z.number(),
    }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [bt] = await tx
          .select({
            id: bankTransactions.id,
            amountMinor: bankTransactions.amountMinor,
            status: bankTransactions.status,
            accountCurrency: bankAccounts.currencyCode,
          })
          .from(bankTransactions)
          .innerJoin(bankAccounts, eq(bankAccounts.id, bankTransactions.bankAccountId))
          .where(and(eq(bankTransactions.id, input.transactionId), eq(bankTransactions.orgId, ctx.actor.orgId)))
          .limit(1)
          // N14: the line is the race anchor for its own remaining amount.
          .for("update");
        if (!bt) throw new Error("bank transaction not found");
        if (bt.status === "excluded") throw new Error("transaction is excluded; unexclude it before matching");

        const existingRows = await tx
          .select({ amountMinor: bankAllocations.amountMinor })
          .from(bankAllocations)
          .where(and(eq(bankAllocations.orgId, ctx.actor.orgId), eq(bankAllocations.transactionId, bt.id)));
        const existingAllocated = existingRows.reduce((s, r) => s + r.amountMinor, 0);

        let proposed: { kind: AllocationKind; amountMinor: number; paymentId?: string; entryId?: string; note?: string }[];

        if (input.paymentId) {
          // N14: a customer payment is money in; the statement line must be
          // the same money in the same currency. The payment row is the race
          // anchor for its own remaining amount, so splits cannot overdraw it.
          const [p] = await tx
            .select({ id: payments.id, amountMinor: payments.amountMinor, currency: invoices.currency })
            .from(payments)
            .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
            .where(and(eq(payments.id, input.paymentId), eq(payments.orgId, ctx.actor.orgId)))
            .for("update");
          if (!p) throw new Error("payment not found");
          if (bt.amountMinor <= 0) {
            throw new Error(
              `direction mismatch: a customer payment is money in, but this statement line is money out (${bt.amountMinor})`,
            );
          }
          if (p.currency !== bt.accountCurrency) {
            throw new Error(`currency mismatch: statement account is ${bt.accountCurrency}, payment is ${p.currency}`);
          }

          const claimedRows = await tx
            .select({ allocated: sql<number>`coalesce(sum(${bankAllocations.amountMinor}), 0)` })
            .from(bankAllocations)
            .where(and(eq(bankAllocations.orgId, ctx.actor.orgId), eq(bankAllocations.paymentId, p.id)));
          const paymentAllocated = Number(claimedRows[0]?.allocated ?? 0);

          if (input.amountMinor !== undefined) {
            // Explicit split: claim exactly the caller's slice of the line.
            proposed = [{ kind: "payment", amountMinor: input.amountMinor, paymentId: p.id, note: input.note }];
          } else {
            // Whole-line claim: the line must decompose exactly into the
            // payment plus any reviewed fee / FX difference.
            const fee = input.feeMinor ?? 0;
            const fx = input.fxGainLossMinor ?? 0;
            if (p.amountMinor + fee + fx !== bt.amountMinor - existingAllocated) {
              throw new Error(
                `amount mismatch: line has ${bt.amountMinor - existingAllocated} unexplained, payment is ${p.amountMinor}${fee ? `, fee ${fee}` : ""}${fx ? `, fx ${fx}` : ""}; pass feeMinor, fxGainLossMinor or a partial amountMinor to review the difference explicitly`,
              );
            }
            proposed = [{ kind: "payment", amountMinor: p.amountMinor, paymentId: p.id, note: input.note }];
            if (fee > 0) proposed.push({ kind: "fee", amountMinor: fee, note: input.note ?? "reviewed bank fee" });
            if (fx !== 0) proposed.push({ kind: "fx_difference", amountMinor: fx, note: input.note ?? "reviewed FX difference" });
          }

          const planned = planLineAllocations(
            { id: bt.id, amountMinor: bt.amountMinor, status: bt.status as BankStatementLine["status"] },
            existingAllocated,
            proposed.map((a) => ({ kind: a.kind, amountMinor: a.amountMinor })),
          );
          // Only the payment-kind slice consumes the payment's budget - the
          // fee and FX allocations explain the bank's side of the gap.
          const paymentSlices = planned
            .filter((a) => a.kind === "payment")
            .reduce((s, a) => s + a.amountMinor, 0);
          paymentRemaining(p.amountMinor, paymentAllocated, paymentSlices);

          await tx.insert(bankAllocations).values(
            proposed.map((a) => ({
              orgId: ctx.actor.orgId,
              transactionId: bt.id,
              kind: a.kind,
              paymentId: a.paymentId ?? null,
              entryId: null,
              amountMinor: a.amountMinor,
              note: a.note ?? null,
            })),
          );
        } else {
          // Entry path: the entry must move this account's cash by exactly
          // the line's still-unexplained signed amount (transfers included).
          const [e] = await tx
            .select({ id: journalEntries.id, currency: journalEntries.currency })
            .from(journalEntries)
            .where(and(eq(journalEntries.id, input.entryId!), eq(journalEntries.orgId, ctx.actor.orgId)))
            .for("update");
          if (!e) throw new Error("journal entry not found");
          if (e.currency !== bt.accountCurrency) {
            throw new Error(`currency mismatch: statement account is ${bt.accountCurrency}, entry is ${e.currency}`);
          }
          const cashLines = await tx
            .select({ debitMinor: journalLines.debitMinor, creditMinor: journalLines.creditMinor })
            .from(journalLines)
            .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
            .where(and(eq(journalLines.entryId, e.id), eq(accounts.code, CASH_ACCOUNT_CODE)));
          const cashNet = cashLines.reduce((sum, l) => sum + l.debitMinor - l.creditMinor, 0);
          const unexplained = lineUnexplained(
            { id: bt.id, amountMinor: bt.amountMinor, status: bt.status as BankStatementLine["status"] },
            existingAllocated,
          );
          if (cashNet !== unexplained) {
            throw new Error(
              `cash effect mismatch: entry nets ${cashNet} on account ${CASH_ACCOUNT_CODE}, statement line has ${unexplained} unexplained`,
            );
          }
          // The entry's cash effect is its remaining-amount budget: prior
          // allocations (splits of one receipt across lines) consume it.
          const entryClaimed = await tx
            .select({ allocated: sql<number>`coalesce(sum(${bankAllocations.amountMinor}), 0)` })
            .from(bankAllocations)
            .where(and(eq(bankAllocations.orgId, ctx.actor.orgId), eq(bankAllocations.entryId, e.id)));
          const entryAllocated = Number(entryClaimed[0]?.allocated ?? 0);
          if (entryAllocated + unexplained > cashNet) {
            throw new Error(
              `entry over-allocated: entry nets ${cashNet} on account ${CASH_ACCOUNT_CODE}, allocations already explain ${entryAllocated}`,
            );
          }
          proposed = [{ kind: "entry", amountMinor: unexplained, entryId: e.id, note: input.note }];
          await tx.insert(bankAllocations).values({
            orgId: ctx.actor.orgId,
            transactionId: bt.id,
            kind: "entry",
            paymentId: null,
            entryId: e.id,
            amountMinor: unexplained,
            note: input.note ?? null,
          });
        }

        const allocatedMinor =
          existingAllocated + proposed.reduce((s, a) => s + a.amountMinor, 0);
        const updated = await tx
          .update(bankTransactions)
          .set({ status: "matched" })
          .where(and(eq(bankTransactions.id, bt.id), sql`${bankTransactions.status} <> 'excluded'`))
          .returning({ id: bankTransactions.id });
        if (updated.length === 0) throw new Error("transaction was just excluded by someone else");
        return {
          status: "matched" as const,
          allocatedMinor,
          lineUnexplainedMinor: lineUnexplained(
            { id: bt.id, amountMinor: bt.amountMinor, status: "matched" },
            allocatedMinor,
          ),
        };
      });
    },
  });

const unmatchBankTransaction = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.unmatchBankTransaction",
    title: "Unmatch bank transaction",
    intent:
      "Undo a mistaken reconciliation by releasing a matched statement line's allocations back into the unmatched queue",
    module: "accounting",
    risk: "write",
    permission: "accounting.write",
    input: z.object({ transactionId: z.string().uuid() }),
    output: z.object({ status: z.literal("unmatched"), releasedMinor: z.number() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [bt] = await tx
          .select({ id: bankTransactions.id, status: bankTransactions.status })
          .from(bankTransactions)
          .where(and(eq(bankTransactions.id, input.transactionId), eq(bankTransactions.orgId, ctx.actor.orgId)))
          .limit(1)
          .for("update");
        if (!bt || bt.status !== "matched") throw new Error("transaction not found or not matched");
        const removed = await tx
          .delete(bankAllocations)
          .where(and(eq(bankAllocations.orgId, ctx.actor.orgId), eq(bankAllocations.transactionId, bt.id)))
          .returning({ amountMinor: bankAllocations.amountMinor });
        const releasedMinor = removed.reduce((s, r) => s + r.amountMinor, 0);
        await tx.update(bankTransactions).set({ status: "unmatched" }).where(eq(bankTransactions.id, bt.id));
        return { status: "unmatched" as const, releasedMinor };
      });
    },
  });

const bankReconciliation = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.bankReconciliation",
    title: "Bank reconciliation",
    intent:
      "Show a bank account's statement lines with their allocations and the unexplained difference - reconciled means that difference is exactly zero",
    module: "accounting",
    risk: "read",
    permission: "accounting.read",
    input: z.object({
      bankAccountId: z.string().uuid(),
      from: isoDate.optional(),
      to: isoDate.optional(),
    }),
    output: z.object({
      totals: z.object({
        linesMinor: z.number(),
        allocatedMinor: z.number(),
        unexplainedMinor: z.number(),
        reconciled: z.boolean(),
      }),
      lines: z.array(
        z.object({
          id: z.string(),
          postedAt: z.string(),
          amountMinor: z.number(),
          allocatedMinor: z.number(),
          unexplainedMinor: z.number(),
          status: z.string(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      const conditions = [eq(bankTransactions.orgId, ctx.actor.orgId), eq(bankTransactions.bankAccountId, input.bankAccountId)];
      if (input.from && input.to) {
        const { start, end } = dateWindow(input.from, input.to);
        conditions.push(gte(bankTransactions.postedAt, start), lt(bankTransactions.postedAt, end));
      }
      const lines = await deps.db
        .select({
          id: bankTransactions.id,
          amountMinor: bankTransactions.amountMinor,
          status: bankTransactions.status,
          postedAt: bankTransactions.postedAt,
        })
        .from(bankTransactions)
        .where(and(...conditions))
        .orderBy(bankTransactions.postedAt)
        .limit(500);
      const allocRows = await deps.db
        .select({
          transactionId: bankAllocations.transactionId,
          allocated: sql<number>`coalesce(sum(${bankAllocations.amountMinor}), 0)`,
        })
        .from(bankAllocations)
        .where(
          and(
            eq(bankAllocations.orgId, ctx.actor.orgId),
            inArray(
              bankAllocations.transactionId,
              lines.map((l) => l.id).length > 0 ? lines.map((l) => l.id) : [crypto.randomUUID()],
            ),
          ),
        )
        .groupBy(bankAllocations.transactionId);
      const allocatedByLine = new Map(allocRows.map((r) => [r.transactionId, Number(r.allocated)]));
      const { totals, lines: detailed } = reconciliationTotals(
        lines.map((l) => ({ id: l.id, amountMinor: l.amountMinor, status: l.status as BankStatementLine["status"] })),
        allocatedByLine,
      );
      return {
        totals,
        lines: detailed.map((l, i) => ({
          id: l.id,
          postedAt: lines[i]!.postedAt.toISOString(),
          amountMinor: l.amountMinor,
          allocatedMinor: l.allocatedMinor,
          unexplainedMinor: l.unexplainedMinor,
          status: l.status,
        })),
      };
    },
  });

const excludeBankTransaction = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.excludeBankTransaction",
    title: "Exclude bank transaction",
    intent:
      "Mark a statement line as not-a-business-transaction (e.g. a personal transfer) so it stops counting as unmatched",
    module: "accounting",
    risk: "write",
    permission: "accounting.write",
    inverse: {
      capabilityId: "accounting.unexcludeBankTransaction",
      buildInput: (input) => ({ transactionId: (input as { transactionId: string }).transactionId }),
    },
    input: z.object({ transactionId: z.string().uuid() }),
    output: z.object({ status: z.literal("excluded") }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const updated = await tx
          .update(bankTransactions)
          .set({ status: "excluded" })
          .where(
            and(
              eq(bankTransactions.id, input.transactionId),
              eq(bankTransactions.orgId, ctx.actor.orgId),
              eq(bankTransactions.status, "unmatched"),
            ),
          )
          .returning({ id: bankTransactions.id });
        if (updated.length === 0) throw new Error("transaction not found or not unmatched");
        return { status: "excluded" as const };
      });
    },
  });

const unexcludeBankTransaction = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.unexcludeBankTransaction",
    title: "Un-exclude bank transaction",
    intent:
      "Bring an excluded statement line back into the unmatched queue because the exclusion was a mistake",
    module: "accounting",
    risk: "write",
    permission: "accounting.write",
    input: z.object({ transactionId: z.string().uuid() }),
    output: z.object({ status: z.literal("unmatched") }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const updated = await tx
          .update(bankTransactions)
          .set({ status: "unmatched" })
          .where(
            and(
              eq(bankTransactions.id, input.transactionId),
              eq(bankTransactions.orgId, ctx.actor.orgId),
              eq(bankTransactions.status, "excluded"),
            ),
          )
          .returning({ id: bankTransactions.id });
        if (updated.length === 0) throw new Error("transaction not found or not excluded");
        return { status: "unmatched" as const };
      });
    },
  });

const bankSummary = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.bankSummary",
    title: "Bank reconciliation summary",
    intent:
      "Show per-account statement totals and the unmatched count, which is the number that says whether reconciliation is done",
    module: "accounting",
    risk: "read",
    permission: "accounting.read",
    input: z.object({}),
    output: z.object({
      accounts: z.array(
        z.object({
          bankAccountId: z.string(),
          name: z.string(),
          currencyCode: z.string(),
          last4: z.string().nullable(),
          balanceMinor: z.number(),
          count: z.number(),
          moneyInMinor: z.number(),
          moneyOutMinor: z.number(),
        }),
      ),
      unmatchedCount: z.number(),
    }),
    execute: async (ctx) => {
      const accts = await deps.db
        .select()
        .from(bankAccounts)
        .where(eq(bankAccounts.orgId, ctx.actor.orgId))
        .orderBy(bankAccounts.createdAt);
      const stats = await deps.db
        .select({
          bankAccountId: bankTransactions.bankAccountId,
          count: sql<number>`count(*)`,
          moneyIn: sql<number>`coalesce(sum(case when ${bankTransactions.amountMinor} > 0 then ${bankTransactions.amountMinor} else 0 end), 0)`,
          moneyOut: sql<number>`coalesce(sum(case when ${bankTransactions.amountMinor} < 0 then -${bankTransactions.amountMinor} else 0 end), 0)`,
        })
        .from(bankTransactions)
        .where(eq(bankTransactions.orgId, ctx.actor.orgId))
        .groupBy(bankTransactions.bankAccountId);
      const byAccount = new Map(stats.map((s) => [s.bankAccountId, s]));
      const [unmatched] = await deps.db
        .select({ n: sql<number>`count(*)` })
        .from(bankTransactions)
        .where(and(eq(bankTransactions.orgId, ctx.actor.orgId), eq(bankTransactions.status, "unmatched")));
      return {
        accounts: accts.map((a) => ({
          bankAccountId: a.id,
          name: a.name,
          currencyCode: a.currencyCode,
          last4: a.last4,
          balanceMinor: Number(a.balanceMinor),
          count: Number(byAccount.get(a.id)?.count ?? 0),
          moneyInMinor: Number(byAccount.get(a.id)?.moneyIn ?? 0),
          moneyOutMinor: Number(byAccount.get(a.id)?.moneyOut ?? 0),
        })),
        unmatchedCount: Number(unmatched?.n ?? 0),
      };
    },
  });

// ── Sales tax filing ────────────────────────────────────────────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function dateWindow(fromIso: string, toIso: string): { start: Date; end: Date } {
  const start = new Date(`${fromIso}T00:00:00Z`);
  const endExclusive = new Date(`${toIso}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(endExclusive.getTime())) {
    throw new Error("dates must be YYYY-MM-DD");
  }
  if (endExclusive < start) throw new Error("`to` is before `from`");
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1); // include the `to` day
  return { start, end: endExclusive };
}

const salesTaxReport = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.salesTaxReport",
    title: "Sales tax report",
    intent:
      "Sum the sales tax collected on non-void invoices inside a period so you know what a return will declare before filing it",
    module: "accounting",
    risk: "read",
    permission: "accounting.read",
    input: z.object({ from: isoDate, to: isoDate }),
    output: z.object({
      taxableSalesMinor: z.number(),
      taxCollectedMinor: z.number(),
      /** Collected-side only: vendor bill lines carry no tax column today. */
      basis: z.literal("invoice-tax-minor"),
    }),
    execute: async (ctx, input) => {
      const { start, end } = dateWindow(input.from, input.to);
      const [row] = await deps.db
        .select({
          taxable: sql<number>`coalesce(sum(${invoices.subtotalMinor}), 0)`,
          tax: sql<number>`coalesce(sum(${invoices.taxMinor}), 0)`,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.orgId, ctx.actor.orgId),
            gte(invoices.issuedAt, start),
            lt(invoices.issuedAt, end),
            sql`${invoices.status} <> 'void'`,
          ),
        );
      return {
        taxableSalesMinor: Number(row?.taxable ?? 0),
        taxCollectedMinor: Number(row?.tax ?? 0),
        basis: "invoice-tax-minor" as const,
      };
    },
  });

const fileSalesTaxReturn = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.fileSalesTaxReturn",
    title: "File sales tax return",
    intent:
      "Record a filed sales-tax return by debiting Sales Tax Payable for the remitted tax, netting out what invoices accrued, and sealing the window against double filing",
    module: "accounting",
    risk: "money",
    permission: "accounting.post",
    // Null like reverseEntry: the remitted amount lives in the report the
    // filer confirms, so policy always gates this for human approval.
    moneyAmount: () => null,
    inverse: {
      capabilityId: "accounting.reverseEntry",
      buildInput: (_input, output) => ({ entryId: output.entryId ?? "" }),
    },
    input: z.object({
      periodFrom: isoDate,
      periodTo: isoDate,
      taxMinor: z.number().int().positive(),
    }),
    output: z.object({ filingId: z.string(), entryId: z.string(), taxMinor: z.number() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const { start, end } = dateWindow(input.periodFrom, input.periodTo);
        const overlapping = await tx
          .select({ id: salesTaxFilings.id })
          .from(salesTaxFilings)
          .where(
            and(
              eq(salesTaxFilings.orgId, ctx.actor.orgId),
              // Half-open interval overlap test; the filings table is the
              // single source of truth for what was already remitted.
              lt(salesTaxFilings.periodFrom, end),
              gt(salesTaxFilings.periodTo, start),
            ),
          )
          .limit(1);
        if (overlapping.length > 0) {
          throw new Error(`period ${input.periodFrom}…${input.periodTo} overlaps an already-filed return`);
        }

        // Invoice collection credited 2100 (Sales Tax Payable); the filing
        // debits that same account so the liability nets to zero. Remitting
        // means cash leaves, so the balancing side is 1000 Cash - the same
        // convention payBill uses when money goes out.
        const entryId = await postEntry(tx, ctx.actor.orgId, ctx.actor, {
          memo: `Sales tax filing ${input.periodFrom} → ${input.periodTo}`,
          sourceType: "sales_tax_filing",
          postedAt: ctx.now,
          lines: [
            { accountCode: "2100", debitMinor: input.taxMinor, creditMinor: 0 },
            { accountCode: "1000", debitMinor: 0, creditMinor: input.taxMinor },
          ],
        });

        const [filing] = await tx
          .insert(salesTaxFilings)
          .values({
            orgId: ctx.actor.orgId,
            periodFrom: start,
            periodTo: end,
            taxMinor: input.taxMinor,
            entryId,
            filedByActorType: ctx.actor.type,
            filedByActorId: ctx.actor.id,
          })
          .returning({ id: salesTaxFilings.id });

        return { filingId: filing!.id, entryId, taxMinor: input.taxMinor };
      });
    },
  });

// ── M10: money depth - credit notes, statements, reminders, cash flow ──

/**
 * AR credit note (M10, ADR 0037): reversal-style, like reverseEntry. The
 * document is never edited - a proportional mirror entry reduces revenue,
 * tax, and the receivable, and the credited amount lands on an immutable
 * column. Always gates: the reversed amount lives in the invoice, not the
 * input, so the policy engine treats it as "always require a human".
 */
const creditNote = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.creditNote",
    title: "Credit an invoice",
    intent:
      "Correct or concede an issued invoice by crediting part of it through an approved reversing entry; the invoice itself is never edited",
    module: "accounting",
    risk: "money",
    permission: "accounting.post",
    moneyAmount: () => null,
    input: z.object({
      invoiceId: z.string().uuid(),
      amountMinor: z.number().int().positive(),
      reason: z.string().min(3).max(500),
    }),
    output: z.object({ entryId: z.string(), creditedMinor: z.number(), invoiceBalanceMinor: z.number() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [inv] = await tx
          .select()
          .from(invoices)
          .where(and(eq(invoices.id, input.invoiceId), eq(invoices.orgId, ctx.actor.orgId)))
          .limit(1)
          // N11: creditedMinor mutates here under the same document lock the
          // payment path holds - a payment and a credit can't race the balance.
          .for("update");
        if (!inv) throw new Error("invoice not found");
        if (inv.status === "void") throw new Error("invoice is void; nothing to credit");
        const balance = inv.totalMinor - inv.paidMinor - inv.creditedMinor;
        if (input.amountMinor > balance) {
          throw new Error(
            `credit ${input.amountMinor} exceeds the open balance ${balance} (total ${inv.totalMinor} − paid ${inv.paidMinor} − credited ${inv.creditedMinor})`,
          );
        }

        const revenueShare = Math.round((input.amountMinor * (inv.totalMinor - inv.taxMinor)) / inv.totalMinor);
        const taxShare = input.amountMinor - revenueShare;
        // Zero-tax invoices have no tax leg; an empty 0/0 line is rejected.
        const mirrorLines = [
          revenueShare > 0 ? { accountCode: "4000", debitMinor: revenueShare, creditMinor: 0 } : null,
          taxShare > 0 ? { accountCode: "2100", debitMinor: taxShare, creditMinor: 0 } : null,
          { accountCode: "1100", debitMinor: 0, creditMinor: input.amountMinor },
        ].filter((l) => l !== null);
        const [origEntry] = await tx
          .select({ id: journalEntries.id })
          .from(journalEntries)
          .where(
            and(
              eq(journalEntries.orgId, ctx.actor.orgId),
              eq(journalEntries.sourceType, "invoice"),
              eq(journalEntries.sourceId, inv.id),
            ),
          )
          .limit(1);
        const entryId = await postEntry(tx, ctx.actor.orgId, ctx.actor, {
          memo: `Credit note on invoice ${inv.number}: ${input.reason}`,
          sourceType: "invoice_credit_note",
          sourceId: inv.id,
          reversalOfId: origEntry?.id ?? null,
          postedAt: ctx.now,
          lines: mirrorLines,
        });
        const credited = inv.creditedMinor + input.amountMinor;
        await tx.update(invoices).set({ creditedMinor: credited }).where(eq(invoices.id, inv.id));
        return {
          entryId,
          creditedMinor: credited,
          invoiceBalanceMinor: inv.totalMinor - inv.paidMinor - credited,
        };
      });
    },
  });

/** One rendered line of a statement, with the running balance after it. */
const statementRow = z.object({
  date: z.string(),
  kind: z.string(),
  ref: z.string(),
  amountMinor: z.number(),
  balanceMinor: z.number(),
});

const customerStatement = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.customerStatement",
    title: "Customer statement",
    intent:
      "Render a customer's account as a dated, running-balance statement of invoices, payments, and credit notes - the document you can send when they dispute what they owe",
    module: "accounting",
    risk: "read",
    permission: "accounting.read",
    input: z.object({ customerId: z.string().uuid() }),
    output: z.object({
      openingBalanceMinor: z.number(),
      closingBalanceMinor: z.number(),
      rows: z.array(statementRow),
    }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const invRows = await tx
          .select({
            id: invoices.id,
            number: invoices.number,
            totalMinor: invoices.totalMinor,
            creditedMinor: invoices.creditedMinor,
            issuedAt: invoices.issuedAt,
            createdAt: invoices.createdAt,
            voidedAt: invoices.voidedAt,
          })
          .from(invoices)
          .where(and(eq(invoices.orgId, ctx.actor.orgId), eq(invoices.customerId, input.customerId)));
        const live = invRows.filter((i) => !i.voidedAt);
        const invoiceIds = new Set(live.map((i) => i.id));
        const payRows = invoiceIds.size
          ? await tx
              .select({ invoiceId: payments.invoiceId, amountMinor: payments.amountMinor, receivedAt: payments.receivedAt })
              .from(payments)
              .where(eq(payments.orgId, ctx.actor.orgId))
          : [];
        const creditRows = invoiceIds.size
          ? await tx
              .select({
                entryId: journalEntries.id,
                sourceId: journalEntries.sourceId,
                postedAt: journalEntries.postedAt,
                creditMinor: journalLines.creditMinor,
                debitMinor: journalLines.debitMinor,
                code: accounts.code,
              })
              .from(journalEntries)
              .innerJoin(journalLines, eq(journalLines.entryId, journalEntries.id))
              .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
              .where(
                and(
                  eq(journalEntries.orgId, ctx.actor.orgId),
                  eq(journalEntries.sourceType, "invoice_credit_note"),
                  eq(accounts.code, "1100"),
                ),
              )
          : [];

        type Row = { date: Date; kind: string; ref: string; amountMinor: number };
        const rows: Row[] = [];
        for (const i of live) {
          // Gross: credits appear as their own statement lines below.
          rows.push({ date: i.issuedAt ?? i.createdAt, kind: "invoice", ref: `Invoice #${i.number}`, amountMinor: i.totalMinor });
          const credited = creditRows.filter((c) => c.sourceId === i.id);
          for (const c of credited) {
            const amount = c.creditMinor - c.debitMinor;
            rows.push({ date: c.postedAt, kind: "credit_note", ref: `Credit on invoice #${i.number}`, amountMinor: -amount });
          }
        }
        for (const p of payRows) {
          if (!invoiceIds.has(p.invoiceId)) continue;
          rows.push({ date: p.receivedAt, kind: "payment", ref: "Payment received", amountMinor: -p.amountMinor });
        }
        // One clock basis (N13) means same-instant rows are normal - the
        // statement orders them by business sequence, not wall-clock luck:
        // the invoice exists before money or credit can touch it.
        const KIND_ORDER: Record<string, number> = { invoice: 0, payment: 1, credit_note: 2 };
        rows.sort(
          (a, b) =>
            a.date.getTime() - b.date.getTime() ||
            (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) ||
            a.kind.localeCompare(b.kind),
        );
        let running = 0;
        const rendered = rows.map((r) => {
          running += r.amountMinor;
          return { date: r.date.toISOString(), kind: r.kind, ref: r.ref, amountMinor: r.amountMinor, balanceMinor: running };
        });
        return {
          openingBalanceMinor: 0,
          closingBalanceMinor: running,
          rows: rendered,
        };
      });
    },
  });

/**
 * Deterministic reminder drafting (M10, ADR 0037): who is overdue, by how
 * much, and the exact message to send. Delivery rides the messaging seam;
 * opted-out customers are excluded here, not at send time.
 */
const buildReminders = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.buildReminders",
    title: "Draft payment reminders",
    intent:
      "List overdue customer balances with a drafted, polite reminder message each, skipping anyone who opted out, so a routine or a human can send them as-is",
    module: "accounting",
    risk: "read",
    permission: "accounting.read",
    input: z.object({}),
    output: z.object({
      reminders: z.array(
        z.object({
          customerId: z.string(),
          customerName: z.string(),
          overdueCount: z.number(),
          oldestDaysOverdue: z.number(),
          totalOverdueMinor: z.number(),
          message: z.string(),
        }),
      ),
    }),
    execute: async (ctx) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const rows = await tx
          .select({
            invoiceId: invoices.id,
            number: invoices.number,
            totalMinor: invoices.totalMinor,
            paidMinor: invoices.paidMinor,
            creditedMinor: invoices.creditedMinor,
            dueAt: invoices.dueAt,
            issuedAt: invoices.issuedAt,
            customerId: customers.id,
            customerName: customers.name,
          })
          .from(invoices)
          .innerJoin(customers, eq(customers.id, invoices.customerId))
          .where(
            and(
              eq(invoices.orgId, ctx.actor.orgId),
              eq(invoices.status, "sent"),
              sql`${invoices.voidedAt} IS NULL`,
              eq(customers.reminderOptOut, false),
            ),
          )
          .limit(500);

        const perCustomer = new Map<string, { name: string; count: number; total: number; oldest: number }>();
        for (const r of rows) {
          const balance = r.totalMinor - r.paidMinor - r.creditedMinor;
          if (balance <= 0) continue;
          const due = r.dueAt ?? r.issuedAt;
          if (!due) continue;
          const daysOverdue = Math.floor((ctx.now.getTime() - due.getTime()) / 86_400_000);
          if (daysOverdue <= 0) continue;
          const e = perCustomer.get(r.customerId) ?? { name: r.customerName, count: 0, total: 0, oldest: 0 };
          e.count += 1;
          e.total += balance;
          e.oldest = Math.max(e.oldest, daysOverdue);
          perCustomer.set(r.customerId, e);
        }
        const reminders = [...perCustomer.entries()].map(([customerId, e]) => ({
          customerId,
          customerName: e.name,
          overdueCount: e.count,
          oldestDaysOverdue: e.oldest,
          totalOverdueMinor: e.total,
          message: `Hi ${e.name} - a friendly nudge that ${e.count} invoice${e.count === 1 ? "" : "s"} totalling $${(e.total / 100).toFixed(2)} ${e.count === 1 ? "is" : "are"} now ${e.oldest} day${e.oldest === 1 ? "" : "s"} past due. If you have already sent payment, thank you and please disregard; otherwise we would appreciate it at your earliest convenience.`,
        }));
        reminders.sort((a, b) => b.totalOverdueMinor - a.totalOverdueMinor);
        return { reminders };
      });
    },
  });

/** Assemble balanced ledger lines into the erp-core entry shape. */
async function loadCashFlowEntries(
  tx: Parameters<Parameters<Database["db"]["transaction"]>[0]>[0],
  orgId: string,
) {
  const entryRows = await tx
    .select({ id: journalEntries.id, postedAt: journalEntries.postedAt })
    .from(journalEntries)
    .where(eq(journalEntries.orgId, orgId));
  const lineRows = await tx
    .select({
      entryId: journalLines.entryId,
      code: accounts.code,
      type: accounts.type,
      debitMinor: journalLines.debitMinor,
      creditMinor: journalLines.creditMinor,
    })
    .from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(eq(journalEntries.orgId, orgId));
  type CashLine = { accountCode: string; accountType: "asset" | "liability" | "equity" | "income" | "expense"; debitMinor: number; creditMinor: number };
  const byEntry = new Map<string, { occurredAt: Date; lines: CashLine[] }>();
  for (const e of entryRows) byEntry.set(e.id, { occurredAt: e.postedAt, lines: [] });
  for (const l of lineRows) {
    const b = byEntry.get(l.entryId);
    // accounts.type is a text column; the ledger only ever holds COA types.
    if (b) b.lines.push({ accountCode: l.code, accountType: l.type as CashLine["accountType"], debitMinor: l.debitMinor, creditMinor: l.creditMinor });
  }
  return [...byEntry.values()];
}

const cashFlow = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.cashFlow",
    title: "Cash flow statement",
    intent:
      "Derive the direct-method cash flow statement from the ledger - operating, investing, and financing buckets that provably tie to the cash balance",
    module: "accounting",
    risk: "read",
    permission: "accounting.read",
    input: z.object({ cashAccountCodes: z.array(z.string()).default(["1000"]) }),
    output: z.object({
      openingMinor: z.number(),
      closingMinor: z.number(),
      netMinor: z.number(),
      cashBalanceMinor: z.number(),
      ties: z.boolean(),
      operating: z.object({ inflowMinor: z.number(), outflowMinor: z.number(), netMinor: z.number(), entries: z.number() }),
      investing: z.object({ inflowMinor: z.number(), outflowMinor: z.number(), netMinor: z.number(), entries: z.number() }),
      financing: z.object({ inflowMinor: z.number(), outflowMinor: z.number(), netMinor: z.number(), entries: z.number() }),
    }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const entries = await loadCashFlowEntries(tx, ctx.actor.orgId);
        return buildCashFlowStatement(entries, { cashCodes: input.cashAccountCodes, openingMinor: 0 });
      });
    },
  });

const cashForecast = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.cashForecast",
    title: "13-week cash forecast",
    intent:
      "Project thirteen weekly cash closes from current cash plus open receivable and payable due dates, and flag the projected trough",
    module: "accounting",
    risk: "read",
    permission: "accounting.read",
    input: z.object({ cashAccountCodes: z.array(z.string()).default(["1000"]) }),
    output: z.object({
      startMinor: z.number(),
      finalMinor: z.number(),
      lowestCloseMinor: z.number(),
      lowestWeekIndex: z.number(),
      weeks: z.array(
        z.object({
          weekStart: z.string(),
          inflowMinor: z.number(),
          outflowMinor: z.number(),
          closeMinor: z.number(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const entries = await loadCashFlowEntries(tx, ctx.actor.orgId);
        const startMinor = cashBalanceFromEntries(entries, input.cashAccountCodes);
        const arRows = await tx
          .select({ dueAt: invoices.dueAt, issuedAt: invoices.issuedAt, totalMinor: invoices.totalMinor, paidMinor: invoices.paidMinor, creditedMinor: invoices.creditedMinor })
          .from(invoices)
          .where(and(eq(invoices.orgId, ctx.actor.orgId), eq(invoices.status, "sent"), sql`${invoices.voidedAt} IS NULL`));
        const apRows = await tx
          .select({ dueAt: vendorBills.dueAt, createdAt: vendorBills.createdAt, totalMinor: vendorBills.totalMinor, paidMinor: vendorBills.paidMinor, creditedMinor: vendorBills.creditedMinor })
          .from(vendorBills)
          .where(and(eq(vendorBills.orgId, ctx.actor.orgId), eq(vendorBills.status, "open"), sql`${vendorBills.voidedAt} IS NULL`));
        const flows = [] as Array<{ dueAt: Date; amountMinor: number; kind: "inflow" | "outflow" }>;
        for (const r of arRows) {
          const bal = r.totalMinor - r.paidMinor - r.creditedMinor;
          if (bal > 0) flows.push({ dueAt: r.dueAt ?? r.issuedAt ?? ctx.now, amountMinor: bal, kind: "inflow" });
        }
        for (const r of apRows) {
          const bal = r.totalMinor - r.paidMinor - r.creditedMinor;
          if (bal > 0) flows.push({ dueAt: r.dueAt ?? r.createdAt, amountMinor: bal, kind: "outflow" });
        }
        const forecast = buildThirteenWeekForecast(startMinor, flows, ctx.now);
        return {
          startMinor: forecast.startMinor,
          finalMinor: forecast.finalMinor,
          lowestCloseMinor: forecast.lowestCloseMinor,
          lowestWeekIndex: forecast.lowestWeekIndex,
          weeks: forecast.weeks.map((w) => ({
            weekStart: w.weekStart.toISOString(),
            inflowMinor: w.inflowMinor,
            outflowMinor: w.outflowMinor,
            closeMinor: w.closeMinor,
          })),
        };
      });
    },
  });

// ── M11: expense policy ────────────────────────────────────────────────

const setExpensePolicy = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.setExpensePolicy",
    title: "Set expense policy limit",
    intent:
      "Cap what a category of expense may cost before it is scrutinized harder; claims over the limit stay visible as signals until decided",
    module: "accounting",
    risk: "write",
    permission: "expenses.decide",
    input: z.object({ category: z.string().min(2).max(40), limitMinor: z.number().int().nonnegative() }),
    output: z.object({ set: z.literal(true), category: z.string(), limitMinor: z.number() }),
    execute: async (ctx, input) => {
      await deps.db
        .insert(expensePolicies)
        .values({ orgId: ctx.actor.orgId, category: input.category, limitMinor: input.limitMinor })
        .onConflictDoUpdate({
          target: [expensePolicies.orgId, expensePolicies.category],
          set: { limitMinor: input.limitMinor },
        });
      return { set: true as const, category: input.category, limitMinor: input.limitMinor };
    },
  });

export function registerAccountingCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(addBankAccount(deps));
  registry.register(importBankFeed(deps));
  registry.register(deleteBankTransaction(deps));
  registry.register(matchBankTransaction(deps));
  registry.register(unmatchBankTransaction(deps));
  registry.register(excludeBankTransaction(deps));
  registry.register(unexcludeBankTransaction(deps));
  registry.register(bankReconciliation(deps));
  registry.register(bankSummary(deps));
  registry.register(salesTaxReport(deps));
  registry.register(fileSalesTaxReturn(deps));
  registry.register(generateDueInvoices(deps));
  registry.register(recordFxRate(deps));
  registry.register(unrealizedFxExposure(deps));
  registry.register(quoteCreate(deps));
  registry.register(quoteAccept(deps));
  registry.register(quoteDecline(deps));
  registry.register(quoteExpire(deps));
  registry.register(quoteList(deps));
  registry.register(accountingCreateTemplate(deps));
  registry.register(accountingPauseTemplate(deps));
  registry.register(accountingResumeTemplate(deps));
  registry.register(accountingListTemplates(deps));
  registry.register(expenseSubmit(deps));
  registry.register(setExpensePolicy(deps));
  registry.register(expenseDecide(deps));
  registry.register(expensePay(deps));
  registry.register(expenseList(deps));
  registry.register(shareInvoice(deps));
  registry.register(createInvoice(deps));
  registry.register(listInvoices(deps));
  registry.register(recordPayment(deps));
  registry.register(reversePayment(deps));
  registry.register(reverseEntry(deps));
  registry.register(creditNote(deps));
  registry.register(customerStatement(deps));
  registry.register(buildReminders(deps));
  registry.register(cashFlow(deps));
  registry.register(cashForecast(deps));
  registry.register(trialBalance(deps));
  registry.register(arAging(deps));
  registry.register(closePeriod(deps));
  registry.register(reopenPeriod(deps));
  registry.register(incomeStatement(deps));
  registry.register(balanceSheet(deps));
  registry.register(cashBasisReport(deps));
  registry.register(closeYear(deps));
}

export { createAccountingSignalProducer } from "./signals";
