import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  goodsReceiptLines,
  goodsReceipts,
  items,
  journalEntries,
  journalLines,
  poLines,
  purchaseOrders,
  paymentRunLines,
  paymentRuns,
  purchaseRequests,
  rfqs,
  stockMovements,
  vendorBillLines,
  vendorBills,
  vendorPayments,
  vendors,
  taxCodes,
  taxProfiles,
} from "@chaste/db";
import { nextDocNumber } from "@chaste/db";
import { withOrgContext } from "@chaste/db";
import {
  canAcceptPayment,
  computeAging,
  documentBalance,
  calculateTaxLine,
  matchThreeWay,
  validatePaymentRun,
  type PaymentRunSelection,
} from "@chaste/erp-core";
import type { Database } from "@chaste/db";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";
import { baseCurrencyOf, postEntry } from "@chaste/module-accounting/posting";
import { applyStockDelta, lockStockItems } from "@chaste/module-inventory";

export interface ModuleDeps {
  db: Database["db"];
}


const createVendor = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.createVendor",
    title: "Create vendor",
    intent: "Register a supplier so bills can be recorded against them",
    module: "purchasing",
    risk: "write",
    permission: "purchasing.write",
    input: z.object({
      name: z.string().min(1),
      email: z.string().email().optional(),
      /** Net-days the vendor expects payment in; drives bill due dates (M10). */
      paymentTermDays: z.number().int().positive().max(365).optional(),
    }),
    output: z.object({ vendorId: z.string() }),
    execute: async (ctx, input) => {
      const [row] = await deps.db
        .insert(vendors)
        .values({
          orgId: ctx.actor.orgId,
          name: input.name,
          email: input.email ?? null,
          paymentTermDays: input.paymentTermDays ?? null,
        })
        .returning({ id: vendors.id });
      return { vendorId: row!.id };
    },
  });

const billLineSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().int().positive().describe("thousandths of a unit"),
  unitPriceMinor: z.number().int().nonnegative(),
  expenseAccountCode: z
    .string()
    .regex(/^\d{4}$/)
    .default("6000")
    .describe("chart-of-accounts code the cost lands on, e.g. 5000 for COGS"),
  taxMinor: z.number().int().nonnegative().optional(),
  taxCodeId: z.string().uuid().optional(),
}).refine((line) => line.taxCodeId === undefined || line.taxMinor === undefined, {
  message: "use a configured tax code or a manual tax amount, not both",
});

/**
 * Posting rule for bills: DR each line's expense account, CR Accounts Payable.
 * The AP credit is what makes the vendor a creditor until paid.
 */
const createBill = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.createBill",
    title: "Record vendor bill",
    intent:
      "Record an invoice received from a supplier; posts the expense and the amount owed to Accounts Payable",
    module: "purchasing",
    risk: "write",
    permission: "purchasing.write",
    inverse: {
      capabilityId: "accounting.reverseEntry",
      buildInput: (_input, output) => ({ entryId: output.entryId ?? "" }),
    },
    input: z.object({
      vendorId: z.string(),
      vendorRef: z.string().optional(),
      memo: z.string().optional(),
      /** When present, every line is matched against this order before posting. */
      poNumber: z.number().int().positive().optional(),
      lines: z
        .array(
          billLineSchema.extend({
            poLineNumber: z.number().int().positive().optional(),
          }),
        )
        .min(1),
    }),
    output: z.object({ billNumber: z.number(), totalMinor: z.number(), entryId: z.string() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const profileRows = await tx.select({ jurisdictionCode: taxProfiles.jurisdictionCode }).from(taxProfiles).where(eq(taxProfiles.orgId, ctx.actor.orgId)).limit(1);
        const resolvedLines = [];
        for (const line of input.lines) {
          if (line.taxCodeId) {
            const profile = profileRows[0];
            if (!profile) throw new Error("set the organization tax jurisdiction before using tax codes");
            const [code] = await tx.select().from(taxCodes).where(and(
              eq(taxCodes.id, line.taxCodeId),
              eq(taxCodes.orgId, ctx.actor.orgId),
              eq(taxCodes.active, true),
            )).limit(1);
            if (!code) throw new Error("tax code not found or inactive");
            if (code.jurisdictionCode !== profile.jurisdictionCode) throw new Error("tax code jurisdiction does not match the organization tax profile");
            if (code.direction !== "input") throw new Error(`tax code ${code.code} is configured for output tax`);
            const amounts = calculateTaxLine(line.quantity, line.unitPriceMinor, code.rateBasisPoints, code.priceIncludesTax);
            resolvedLines.push({
              ...line,
              taxMinor: amounts.taxMinor,
              netMinor: amounts.netMinor,
              grossMinor: amounts.grossMinor,
              taxCodeId: code.id,
              rateBasisPoints: code.rateBasisPoints,
              priceIncludesTax: code.priceIncludesTax,
              recoverable: code.recoverable,
              assetAccountCode: code.assetAccountCode,
              matchingUnitPriceMinor: code.priceIncludesTax ? calculateTaxLine(1_000, line.unitPriceMinor, code.rateBasisPoints, true).netMinor : line.unitPriceMinor,
            });
          } else {
            const amounts = calculateTaxLine(line.quantity, line.unitPriceMinor, 0);
            const taxMinor = line.taxMinor ?? 0;
            const grossMinor = amounts.netMinor + taxMinor;
            if (!Number.isSafeInteger(grossMinor)) throw new Error("bill line exceeds the supported amount range");
            resolvedLines.push({
              ...line,
              taxMinor,
              netMinor: amounts.netMinor,
              grossMinor,
              taxCodeId: null,
              rateBasisPoints: null,
              priceIncludesTax: false,
              recoverable: true,
              assetAccountCode: "1205",
              matchingUnitPriceMinor: line.unitPriceMinor,
            });
          }
        }

        // Three-way match when the bill references an order: order ↔ receipts ↔ bill.
        if (input.poNumber !== undefined) {
          const [po] = await tx
            .select()
            .from(purchaseOrders)
            .where(and(eq(purchaseOrders.orgId, ctx.actor.orgId), eq(purchaseOrders.number, input.poNumber)))
            .limit(1);
          if (!po) throw new Error(`purchase order ${input.poNumber} not found`);
          // N16: a bill arrives from the vendor who took the order; a bill
          // from anyone else is not this order's bill, whatever its numbers.
          if (po.vendorId !== input.vendorId) {
            throw new Error(`vendor mismatch: order ${input.poNumber} belongs to a different vendor`);
          }
          const poLineRows = await tx.select().from(poLines).where(eq(poLines.poId, po.id));
          // N16: addressing is by stable position, never by storage order.
          const poLineAt = (position: number) => poLineRows.find((r) => r.position === position);
          // N16: repeated references to one order line inside this bill
          // consume each other's allowance - the aggregate is what the
          // three-way match validates, not each row against full stock.
          const consumed = new Map<string, number>();
          for (const bl of input.lines) {
            if (!bl.poLineNumber) {
              throw new Error(`line "${bl.description}" must reference a purchase-order line number`);
            }
            const pol = poLineAt(bl.poLineNumber);
            if (!pol) throw new Error(`no line ${bl.poLineNumber} on order ${input.poNumber}`);
            const alreadyInThisBill = consumed.get(pol.id) ?? 0;
            const accepted = await acceptedForLine(tx, pol.id);
            const returned = await returnedForLine(tx, pol.id);
            const [prev] = await tx
              .select({ total: sql<number>`coalesce(sum(${vendorBillLines.quantity}), 0)` })
              .from(vendorBillLines)
              .where(eq(vendorBillLines.poLineId, pol.id));
            // quantities still available on this line after earlier bills
            // and after this bill's own earlier lines; only accepted goods,
            // net of returns, are billable
            const priorBilled = Number(prev?.total ?? 0) + alreadyInThisBill;
            const violations = matchThreeWay({
              orderedQty: pol.quantity - priorBilled,
              receivedQty: accepted - returned - priorBilled,
              billedQty: bl.quantity,
              poUnitPriceMinor: pol.unitPriceMinor,
              billUnitPriceMinor: resolvedLines[input.lines.indexOf(bl)]!.matchingUnitPriceMinor,
            });
            if (violations.length > 0) {
              throw new Error(
                `three-way match failed on line ${bl.poLineNumber} (${bl.description}): ` +
                  violations.map((v) => `${v.kind} (${v.detail})`).join("; "),
              );
            }
            consumed.set(pol.id, alreadyInThisBill + bl.quantity);
          }
        }

        const [vendor] = await tx
          .select({ id: vendors.id, paymentTermDays: vendors.paymentTermDays })
          .from(vendors)
          .where(and(eq(vendors.id, input.vendorId), eq(vendors.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!vendor) throw new Error("vendor not found");
        const baseCurrency = await baseCurrencyOf(tx, ctx.actor.orgId);

        const totals = {
          subtotalMinor: resolvedLines.reduce((sum, line) => sum + line.netMinor, 0),
          taxMinor: resolvedLines.reduce((sum, line) => sum + line.taxMinor, 0),
          totalMinor: resolvedLines.reduce((sum, line) => sum + line.grossMinor, 0),
        };
        if (![totals.subtotalMinor, totals.taxMinor, totals.totalMinor].every(Number.isSafeInteger)) throw new Error("bill total exceeds the supported amount range");

        const billNumber = await nextDocNumber(tx, ctx.actor.orgId, "vendor_bill");

        let poLineRowsForLink = new Map<string, string>();
        if (input.poNumber !== undefined) {
          const [poRow] = await tx
            .select({ id: purchaseOrders.id })
            .from(purchaseOrders)
            .where(and(eq(purchaseOrders.orgId, ctx.actor.orgId), eq(purchaseOrders.number, input.poNumber)))
            .limit(1);
          const rows = await tx.select().from(poLines).where(eq(poLines.poId, poRow!.id));
          poLineRowsForLink = new Map(rows.map((r) => [`${input.poNumber}:${r.position}`, r.id]));
        }

        const glLines = [
          ...resolvedLines.map((l) => ({
            accountCode: l.expenseAccountCode,
            debitMinor: l.recoverable ? l.netMinor : l.grossMinor,
            creditMinor: 0,
          })),
          ...Array.from(resolvedLines.reduce((grouped, line) => {
            if (line.recoverable && line.taxMinor > 0) grouped.set(line.assetAccountCode, (grouped.get(line.assetAccountCode) ?? 0) + line.taxMinor);
            return grouped;
          }, new Map<string, number>()), ([accountCode, taxMinor]) => ({ accountCode, debitMinor: taxMinor, creditMinor: 0 })),
          { accountCode: "2000", debitMinor: 0, creditMinor: totals.totalMinor },
        ].filter((l) => l.debitMinor !== 0 || l.creditMinor !== 0);
        const entryId = await postEntry(tx, ctx.actor.orgId, ctx.actor, {
          memo: `Vendor bill ${billNumber}${input.vendorRef ? ` (${input.vendorRef})` : ""}`,
          sourceType: "vendor_bill",
          postedAt: ctx.now,
          lines: glLines,
        });

        const [bill] = await tx
          .insert(vendorBills)
          .values({
            orgId: ctx.actor.orgId,
            vendorId: input.vendorId,
            number: billNumber,
            vendorRef: input.vendorRef ?? null,
            dueAt:
              vendor.paymentTermDays && vendor.paymentTermDays > 0
                ? new Date(ctx.now.getTime() + vendor.paymentTermDays * 86_400_000)
                : ctx.now,
            status: "open",
            currency: baseCurrency,
            totalMinor: totals.totalMinor,
            memo: input.memo ?? null,
            entryId,
            billDate: ctx.now,
          })
          .returning({ id: vendorBills.id });

        await tx.insert(vendorBillLines).values(
          resolvedLines.map((l) => ({
            billId: bill!.id,
            description: l.description,
            quantity: l.quantity,
            unitPriceMinor: l.unitPriceMinor,
            taxMinor: l.taxMinor,
            taxCodeId: l.taxCodeId,
            taxRateBasisPoints: l.rateBasisPoints,
            priceIncludesTax: l.priceIncludesTax,
            expenseAccountCode: l.expenseAccountCode,
            poLineId:
              input.poNumber !== undefined && l.poLineNumber
                ? (poLineRowsForLink.get(`${input.poNumber}:${l.poLineNumber}`) ?? null)
                : null,
          })),
        );

        return { billNumber, totalMinor: totals.totalMinor, entryId };
      });
    },
  });

/** Posting rule: DR Accounts Payable, CR Cash. Money class → threshold-gated. */
const payBill = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.payBill",
    title: "Pay vendor bill",
    intent:
      "Pay money to a supplier against an outstanding bill and post it to the ledger. Amounts above the policy threshold require approval",
    module: "purchasing",
    risk: "money",
    permission: "purchasing.post",
    moneyThresholdMinor: 50_000,
    moneyAmount: (input) => input.amountMinor,
    inverse: {
      capabilityId: "purchasing.reverseVendorPayment",
      buildInput: (_input, output) => ({
        vendorPaymentId: output.paymentId,
        reason: "undo vendor payment",
      }),
    },
    input: z.object({
      billNumber: z.number().int().positive(),
      amountMinor: z.number().int().positive(),
      method: z.enum(["cash", "bank_transfer", "card"]).default("bank_transfer"),
    }),
    output: z.object({ paymentId: z.string(), entryId: z.string(), fullyPaid: z.boolean() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [bill] = await tx
          .select()
          .from(vendorBills)
          .where(and(eq(vendorBills.orgId, ctx.actor.orgId), eq(vendorBills.number, input.billNumber)))
          .limit(1)
          // N11: serialize money application per document - the outstanding
          // verdict must see every committed payment, not a stale snapshot.
          .for("update");
        if (!bill) throw new Error("bill not found");
        // N11: credit-adjusted outstanding gates vendor payments too.
        const verdict = canAcceptPayment(bill, bill.status, input.amountMinor);
        if (!verdict.ok) throw new Error(verdict.reason);

        const glLines = [
          { accountCode: "2000", debitMinor: input.amountMinor, creditMinor: 0 },
          { accountCode: "1000", debitMinor: 0, creditMinor: input.amountMinor },
        ];
        const entryId = await postEntry(tx, ctx.actor.orgId, ctx.actor, {
          memo: `Vendor payment for bill ${bill.number} (${input.method})`,
          sourceType: "vendor_payment",
          currency: bill.currency,
          postedAt: ctx.now,
          lines: glLines,
        });

        const [pay] = await tx
          .insert(vendorPayments)
          .values({
            orgId: ctx.actor.orgId,
            billId: bill.id,
            amountMinor: input.amountMinor,
            method: input.method,
            entryId,
            paidAt: ctx.now,
          })
          .returning({ id: vendorPayments.id });

        const paidMinor = bill.paidMinor + input.amountMinor;
        // N11/N12: settle and flag status through the one balance contract -
        // a bill fully covered by credits is settled without payments.
        const balance = documentBalance({ ...bill, paidMinor });
        await tx
          .update(vendorBills)
          .set({ paidMinor, status: balance.fullySettled ? "paid" : bill.status })
          .where(eq(vendorBills.id, bill.id));

        return { paymentId: pay!.id, entryId, fullyPaid: balance.fullySettled };
      });
    },
  });

const reverseVendorPayment = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.reverseVendorPayment",
    title: "Reverse vendor payment",
    intent:
      "Undo a recorded vendor payment: mirror its journal entry in the original currency, release the amount from the bill balance, and refuse if the payment was already reversed. The bill can then receive a corrected payment",
    module: "purchasing",
    risk: "money",
    permission: "purchasing.post",
    // The refunded amount lives in the payment, not the input: null means
    // the policy engine always gates reversals for human approval.
    // No inverse: reversing a reversal is refused in execute.
    moneyAmount: () => null,
    input: z.object({
      vendorPaymentId: z.string().uuid(),
      reason: z.string().min(3).max(500),
    }),
    output: z.object({
      reversalEntryId: z.string(),
      refundedMinor: z.number(),
      billNumber: z.number(),
      outstandingMinor: z.number(),
    }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [payment] = await tx
          .select()
          .from(vendorPayments)
          .where(and(eq(vendorPayments.id, input.vendorPaymentId), eq(vendorPayments.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!payment) throw new Error("vendor payment not found");
        if (payment.paymentRunId) throw new Error("this payment belongs to a supplier payment run; reverse the complete run instead");
        if (payment.status === "reversed") throw new Error("vendor payment has already been reversed");
        if (!payment.entryId) throw new Error("vendor payment has no journal entry to reverse");

        // Unique at the business-operation level: retries and replays find
        // the same reversal row and refuse instead of refunding twice. The
        // check runs after the bill lock below is acquired, so two
        // concurrent reversals of one payment serialize on the bill row and
        // the loser sees the winner's committed reversal (same discipline
        // as accounting.reversePayment's invoice lock).
        const [bill] = await tx
          .select()
          .from(vendorBills)
          .where(and(eq(vendorBills.id, payment.billId), eq(vendorBills.orgId, ctx.actor.orgId)))
          .limit(1)
          // N11: releasing paidMinor mutates the bill under the same
          // document lock the payment path holds.
          .for("update");
        if (!bill) throw new Error("vendor payment's bill not found");

        const [already] = await tx
          .select({ id: journalEntries.id })
          .from(journalEntries)
          .where(and(eq(journalEntries.orgId, ctx.actor.orgId), eq(journalEntries.reversalOfId, payment.entryId)))
          .limit(1);
        if (already) throw new Error("vendor payment has already been reversed");

        const [entry] = await tx
          .select()
          .from(journalEntries)
          .where(eq(journalEntries.id, payment.entryId))
          .limit(1);
        if (!entry) throw new Error("vendor payment's journal entry not found");
        const lines = await tx
          .select({
            accountId: journalLines.accountId,
            debitMinor: journalLines.debitMinor,
            creditMinor: journalLines.creditMinor,
          })
          .from(journalLines)
          .where(eq(journalLines.entryId, entry.id));

        // The mirror keeps the original's currency (ADR 0021) - a vendor
        // payment settles in the currency it was posted in.
        const reversalEntryId = await postEntry(tx, ctx.actor.orgId, ctx.actor, {
          memo: `Vendor payment reversal for bill ${bill.number}: ${input.reason}`,
          sourceType: "vendor-payment-reversal",
          sourceId: bill.id,
          reversalOfId: entry.id,
          currency: entry.currency,
          postedAt: ctx.now,
          lines: lines.map((l) => ({
            accountId: l.accountId,
            debitMinor: l.creditMinor,
            creditMinor: l.debitMinor,
          })),
        });

        const paidMinor = bill.paidMinor - payment.amountMinor;
        // Bill-state repair (N12): releasing the payment demotes a paid bill
        // back to open through the one balance contract.
        const released = documentBalance({ ...bill, paidMinor });
        await tx
          .update(vendorBills)
          .set({ paidMinor, status: released.fullySettled ? "paid" : "open" })
          .where(eq(vendorBills.id, bill.id));

        return {
          reversalEntryId,
          refundedMinor: payment.amountMinor,
          billNumber: bill.number,
          outstandingMinor: documentBalance({ ...bill, paidMinor }).outstandingMinor,
        };
      });
    },
  });

const createPaymentRun = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.createPaymentRun",
    title: "Create supplier payment run",
    intent: "Select outstanding supplier bills into one same-currency payment run for review, approval, and a consolidated bank instruction",
    module: "purchasing",
    risk: "write",
    permission: "purchasing.write",
    inverse: { capabilityId: "purchasing.cancelPaymentRunDraft", buildInput: (_input, output) => ({ paymentRunId: output.paymentRunId }) },
    input: z.object({ memo: z.string().max(500).optional(), lines: z.array(z.object({ billId: z.string().uuid(), amountMinor: z.number().int().positive() })).min(1).max(100) }),
    output: z.object({ paymentRunId: z.string(), reference: z.string(), currency: z.string(), totalMinor: z.number(), billCount: z.number() }),
    execute: async (ctx, input) => withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
      const ids = input.lines.map((line) => line.billId);
      const rows = await tx.select().from(vendorBills).where(and(eq(vendorBills.orgId, ctx.actor.orgId), inArray(vendorBills.id, ids))).orderBy(asc(vendorBills.id)).for("update");
      const byId = new Map(rows.map((row) => [row.id, row]));
      const selection: PaymentRunSelection[] = input.lines.map((line) => {
        const bill = byId.get(line.billId);
        if (!bill || bill.status === "void" || bill.voidedAt) throw new Error(`bill ${line.billId} is unavailable for payment`);
        return { billId: bill.id, currency: bill.currency, outstandingMinor: documentBalance(bill).outstandingMinor, payMinor: line.amountMinor };
      });
      const validated = validatePaymentRun(selection);
      const number = await nextDocNumber(tx, ctx.actor.orgId, "payment_run");
      const reference = `PR-${String(number).padStart(6, "0")}`;
      const [run] = await tx.insert(paymentRuns).values({
        orgId: ctx.actor.orgId,
        reference,
        currency: validated.currency,
        totalMinor: validated.totalMinor,
        memo: input.memo ?? null,
        createdByActorType: ctx.actor.type,
        createdByActorId: ctx.actor.id,
      }).returning({ id: paymentRuns.id });
      await tx.insert(paymentRunLines).values(validated.lines.map((line) => ({
        orgId: ctx.actor.orgId,
        paymentRunId: run!.id,
        vendorBillId: line.billId,
        amountMinor: line.payMinor,
      })));
      return { paymentRunId: run!.id, reference, currency: validated.currency, totalMinor: validated.totalMinor, billCount: validated.billCount };
    }),
  });

const cancelPaymentRunDraft = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.cancelPaymentRunDraft",
    title: "Cancel payment run draft",
    intent: "Cancel a supplier payment run that has not been approved or sent as a bank instruction",
    module: "purchasing",
    risk: "write",
    permission: "purchasing.write",
    inverse: { capabilityId: "purchasing.restorePaymentRunDraft", buildInput: (input) => input },
    input: z.object({ paymentRunId: z.string().uuid() }),
    output: z.object({ paymentRunId: z.string() }),
    execute: async (ctx, input) => withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
      const changed = await tx.update(paymentRuns).set({ status: "cancelled" }).where(and(eq(paymentRuns.id, input.paymentRunId), eq(paymentRuns.orgId, ctx.actor.orgId), eq(paymentRuns.status, "draft"))).returning({ id: paymentRuns.id });
      if (!changed.length) throw new Error("draft payment run not found");
      return { paymentRunId: input.paymentRunId };
    }),
  });

const restorePaymentRunDraft = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.restorePaymentRunDraft",
    title: "Restore payment run draft",
    intent: "Restore a cancelled supplier payment run draft that has never been instructed to a bank",
    module: "purchasing",
    risk: "write",
    permission: "purchasing.write",
    inverse: { capabilityId: "purchasing.cancelPaymentRunDraft", buildInput: (input) => input },
    input: z.object({ paymentRunId: z.string().uuid() }),
    output: z.object({ paymentRunId: z.string() }),
    execute: async (ctx, input) => withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
      const changed = await tx.update(paymentRuns).set({ status: "draft" }).where(and(eq(paymentRuns.id, input.paymentRunId), eq(paymentRuns.orgId, ctx.actor.orgId), eq(paymentRuns.status, "cancelled"))).returning({ id: paymentRuns.id });
      if (!changed.length) throw new Error("cancelled draft payment run not found");
      return { paymentRunId: input.paymentRunId };
    }),
  });

const instructPaymentRun = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.instructPaymentRun",
    title: "Approve payment instructions",
    intent: "Approve a reviewed supplier payment run, post its bill settlements once, and prepare one consolidated bank instruction for later statement confirmation",
    module: "purchasing",
    risk: "money",
    permission: "purchasing.post",
    moneyAmount: () => null,
    inverse: { capabilityId: "purchasing.reversePaymentRun", buildInput: (_input, output) => ({ paymentRunId: output.paymentRunId, reason: "undo supplier payment instruction" }) },
    input: z.object({ paymentRunId: z.string().uuid() }),
    output: z.object({ paymentRunId: z.string(), reference: z.string(), currency: z.string(), totalMinor: z.number(), entryId: z.string(), billCount: z.number(), status: z.literal("instructed") }),
    execute: async (ctx, input) => withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
      const [run] = await tx.select().from(paymentRuns).where(and(eq(paymentRuns.id, input.paymentRunId), eq(paymentRuns.orgId, ctx.actor.orgId))).limit(1).for("update");
      if (!run || run.status !== "draft") throw new Error("only a draft payment run can be approved");
      const lines = await tx.select({ lineId: paymentRunLines.id, billId: paymentRunLines.vendorBillId, amountMinor: paymentRunLines.amountMinor })
        .from(paymentRunLines).where(and(eq(paymentRunLines.paymentRunId, run.id), eq(paymentRunLines.orgId, ctx.actor.orgId))).orderBy(asc(paymentRunLines.vendorBillId));
      const billIds = lines.map((line) => line.billId);
      const bills = await tx.select().from(vendorBills).where(and(eq(vendorBills.orgId, ctx.actor.orgId), inArray(vendorBills.id, billIds))).orderBy(asc(vendorBills.id)).for("update");
      const byId = new Map(bills.map((bill) => [bill.id, bill]));
      const current: PaymentRunSelection[] = lines.map((line) => {
        const bill = byId.get(line.billId);
        if (!bill || bill.status === "void" || bill.voidedAt) throw new Error("a selected bill is no longer payable");
        return { billId: bill.id, currency: bill.currency, outstandingMinor: documentBalance(bill).outstandingMinor, payMinor: Number(line.amountMinor) };
      });
      const validated = validatePaymentRun(current);
      if (validated.currency !== run.currency || validated.totalMinor !== Number(run.totalMinor)) throw new Error("payment run total changed; cancel this draft and review the current bills");
      const entryId = await postEntry(tx, ctx.actor.orgId, ctx.actor, {
        memo: `Supplier payment run ${run.reference}`,
        sourceType: "supplier_payment_run",
        sourceId: run.id,
        currency: run.currency,
        postedAt: ctx.now,
        lines: [
          { accountCode: "2000", debitMinor: validated.totalMinor, creditMinor: 0 },
          { accountCode: "1000", debitMinor: 0, creditMinor: validated.totalMinor },
        ],
      });
      for (const line of lines) {
        const bill = byId.get(line.billId)!;
        const amountMinor = Number(line.amountMinor);
        const [payment] = await tx.insert(vendorPayments).values({
          orgId: ctx.actor.orgId,
          billId: bill.id,
          amountMinor,
          method: "bank_transfer",
          entryId,
          paymentRunId: run.id,
          status: "instructed",
          paidAt: ctx.now,
        }).returning({ id: vendorPayments.id });
        await tx.update(paymentRunLines).set({ vendorPaymentId: payment!.id }).where(eq(paymentRunLines.id, line.lineId));
        const paidMinor = bill.paidMinor + amountMinor;
        const balance = documentBalance({ ...bill, paidMinor });
        await tx.update(vendorBills).set({ paidMinor, status: balance.fullySettled ? "paid" : bill.status }).where(eq(vendorBills.id, bill.id));
      }
      await tx.update(paymentRuns).set({ status: "instructed", journalEntryId: entryId, instructedAt: ctx.now }).where(eq(paymentRuns.id, run.id));
      return { paymentRunId: run.id, reference: run.reference, currency: run.currency, totalMinor: validated.totalMinor, entryId, billCount: lines.length, status: "instructed" as const };
    }),
  });

const reversePaymentRun = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.reversePaymentRun",
    title: "Reverse supplier payment run",
    intent: "Reverse an instructed but not bank-confirmed supplier payment run, restore every bill balance, and retain the original instruction and reversal evidence",
    module: "purchasing",
    risk: "money",
    permission: "purchasing.post",
    moneyAmount: () => null,
    // Terminal compensation: reinstating a run would repeat a bank instruction; a corrected payment must be a new approved run.
    input: z.object({ paymentRunId: z.string().uuid(), reason: z.string().min(3).max(500) }),
    output: z.object({ paymentRunId: z.string(), reversalEntryId: z.string(), status: z.literal("reversed") }),
    execute: async (ctx, input) => withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
      const [run] = await tx.select().from(paymentRuns).where(and(eq(paymentRuns.id, input.paymentRunId), eq(paymentRuns.orgId, ctx.actor.orgId))).limit(1).for("update");
      if (!run || run.status !== "instructed" || !run.journalEntryId) throw new Error("only an instructed, unconfirmed run can be reversed; confirmed payments require a refund or bank correction");
      const [original] = await tx.select().from(journalEntries).where(and(eq(journalEntries.id, run.journalEntryId), eq(journalEntries.orgId, ctx.actor.orgId))).limit(1);
      if (!original) throw new Error("payment run journal entry not found");
      const journal = await tx.select({ accountId: journalLines.accountId, debitMinor: journalLines.debitMinor, creditMinor: journalLines.creditMinor }).from(journalLines).where(eq(journalLines.entryId, original.id));
      const reversalEntryId = await postEntry(tx, ctx.actor.orgId, ctx.actor, {
        memo: `Reverse payment run ${run.reference}: ${input.reason}`,
        sourceType: "supplier_payment_run_reversal",
        sourceId: run.id,
        reversalOfId: original.id,
        currency: original.currency,
        postedAt: ctx.now,
        lines: journal.map((line) => ({ accountId: line.accountId, debitMinor: line.creditMinor, creditMinor: line.debitMinor })),
      });
      const paymentLines = await tx.select().from(paymentRunLines).where(and(eq(paymentRunLines.paymentRunId, run.id), eq(paymentRunLines.orgId, ctx.actor.orgId)));
      for (const line of paymentLines) {
        const [bill] = await tx.select().from(vendorBills).where(and(eq(vendorBills.id, line.vendorBillId), eq(vendorBills.orgId, ctx.actor.orgId))).limit(1).for("update");
        if (!bill || bill.paidMinor < Number(line.amountMinor)) throw new Error("bill payment balance changed; the run cannot be reversed safely");
        const paidMinor = bill.paidMinor - Number(line.amountMinor);
        const balance = documentBalance({ ...bill, paidMinor });
        await tx.update(vendorBills).set({ paidMinor, status: balance.fullySettled ? "paid" : "open" }).where(eq(vendorBills.id, bill.id));
        if (line.vendorPaymentId) await tx.update(vendorPayments).set({ status: "reversed", reversedAt: ctx.now, reversalEntryId }).where(eq(vendorPayments.id, line.vendorPaymentId));
      }
      await tx.update(paymentRuns).set({ status: "reversed", reversalEntryId }).where(eq(paymentRuns.id, run.id));
      return { paymentRunId: run.id, reversalEntryId, status: "reversed" as const };
    }),
  });

const listPaymentRuns = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.listPaymentRuns",
    title: "List supplier payment runs",
    intent: "List draft, instructed, confirmed, and reversed supplier payment runs with their bill-level remittance details and reconciliation state",
    module: "purchasing",
    risk: "read",
    permission: "purchasing.read",
    input: z.object({}),
    output: z.object({ runs: z.array(z.object({ id: z.string(), reference: z.string(), currency: z.string(), totalMinor: z.number(), status: z.string(), createdAt: z.string(), instructedAt: z.string().nullable(), confirmedAt: z.string().nullable(), entryId: z.string().nullable(), lines: z.array(z.object({ billId: z.string(), billNumber: z.number(), vendorName: z.string(), vendorRef: z.string().nullable(), amountMinor: z.number() })) })) }),
    execute: async (ctx) => {
      const runs = await deps.db.select().from(paymentRuns).where(eq(paymentRuns.orgId, ctx.actor.orgId)).orderBy(desc(paymentRuns.createdAt)).limit(50);
      const ids = runs.map((run) => run.id);
      const lines = ids.length ? await deps.db.select({ runId: paymentRunLines.paymentRunId, billId: vendorBills.id, billNumber: vendorBills.number, vendorName: vendors.name, vendorRef: vendorBills.vendorRef, amountMinor: paymentRunLines.amountMinor })
        .from(paymentRunLines).innerJoin(vendorBills, eq(vendorBills.id, paymentRunLines.vendorBillId)).innerJoin(vendors, eq(vendors.id, vendorBills.vendorId))
        .where(and(eq(paymentRunLines.orgId, ctx.actor.orgId), inArray(paymentRunLines.paymentRunId, ids))).orderBy(asc(vendorBills.number)) : [];
      return { runs: runs.map((run) => ({
        id: run.id,
        reference: run.reference,
        currency: run.currency,
        totalMinor: Number(run.totalMinor),
        status: run.status,
        createdAt: run.createdAt.toISOString(),
        instructedAt: run.instructedAt?.toISOString() ?? null,
        confirmedAt: run.confirmedAt?.toISOString() ?? null,
        entryId: run.journalEntryId,
        lines: lines.filter((line) => line.runId === run.id).map((line) => ({ billId: line.billId, billNumber: line.billNumber, vendorName: line.vendorName, vendorRef: line.vendorRef, amountMinor: Number(line.amountMinor) })),
      })) };
    },
  });

const apAging = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.apAging",
    title: "AP aging report",
    intent: "Show outstanding vendor bills bucketed by age so you know what you owe and when",
    module: "purchasing",
    risk: "read",
    permission: "purchasing.read",
    input: z.object({}),
    output: z.object({
      buckets: z.object({
        current: z.number(),
        d30: z.number(),
        d60: z.number(),
        d90plus: z.number(),
        totalOutstanding: z.number(),
      }),
    }),
    execute: async (ctx) => {
      const rows = await deps.db
        .select({ totalMinor: vendorBills.totalMinor, paidMinor: vendorBills.paidMinor, billDate: vendorBills.billDate })
        .from(vendorBills)
        .where(and(eq(vendorBills.orgId, ctx.actor.orgId), gt(vendorBills.totalMinor, vendorBills.paidMinor)));
      const buckets = computeAging(
        rows
          .filter((r) => r.billDate !== null && r.totalMinor - r.paidMinor > 0)
          .map((r) => ({
            invoiceNumber: 0,
            outstandingMinor: r.totalMinor - r.paidMinor,
            issuedAt: r.billDate as Date,
          })),
        ctx.now,
      );
      return { buckets };
    },
  });

const createPO = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.createPurchaseOrder",
    title: "Create purchase order",
    intent:
      "Order goods from a vendor with line items and expected prices; receiving and billing are matched against this order later",
    module: "purchasing",
    risk: "write",
    permission: "purchasing.write",
    input: z.object({
      vendorId: z.string(),
      memo: z.string().optional(),
      /** When the vendor promised delivery; feeds on-time-rate (M10). */
      promisedAt: z.string().datetime().optional(),
      lines: z
        .array(
          z.object({
            description: z.string().min(1),
            quantity: z.number().int().positive().describe("thousandths of a unit"),
            unitPriceMinor: z.number().int().nonnegative(),
            expenseAccountCode: z.string().regex(/^\d{4}$/).default("6000"),
            sku: z.string().optional().describe("links the line to a stocked item for receipts"),
          }),
        )
        .min(1),
    }),
    output: z.object({ poNumber: z.number() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [vendor] = await tx
          .select({ id: vendors.id, paymentTermDays: vendors.paymentTermDays })
          .from(vendors)
          .where(and(eq(vendors.id, input.vendorId), eq(vendors.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!vendor) throw new Error("vendor not found");

        const poNumber = await nextDocNumber(tx, ctx.actor.orgId, "purchase_order");

        const itemSkus = input.lines.filter((l) => l.sku).map((l) => l.sku!);
        const itemMap = new Map<string, string>();
        if (itemSkus.length > 0) {
          const rows = await tx.select({ id: items.id, sku: items.sku }).from(items).where(eq(items.orgId, ctx.actor.orgId));
          for (const r of rows) itemMap.set(r.sku, r.id);
        }

        const [po] = await tx
          .insert(purchaseOrders)
          .values({
            orgId: ctx.actor.orgId,
            vendorId: input.vendorId,
            number: poNumber,
            status: "ordered",
            memo: input.memo ?? null,
            orderedAt: ctx.now,
            promisedAt: input.promisedAt ? new Date(input.promisedAt) : null,
          })
          .returning({ id: purchaseOrders.id });
        await tx.insert(poLines).values(
          input.lines.map((l, i) => ({
            poId: po!.id,
            description: l.description,
            quantity: l.quantity,
            unitPriceMinor: l.unitPriceMinor,
            expenseAccountCode: l.expenseAccountCode,
            itemId: l.sku ? (itemMap.get(l.sku) ?? null) : null,
            // N16: stable display position, fixed at creation and never
            // renumbered - "line 1" means this line forever.
            position: i + 1,
          })),
        );
        return { poNumber };
      });
    },
  });

const receivePO = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.receiveGoods",
    title: "Receive goods against purchase order",
    intent:
      "Record that ordered goods physically arrived; adds received quantities to stock for linked items and updates the order status. Receipts feed three-way matching on bills",
    module: "purchasing",
    risk: "write",
    permission: "purchasing.write",
    input: z.object({
      poNumber: z.number().int().positive(),
      lines: z
        .array(
          z.object({
            lineNumber: z.number().int().positive().describe("stable 1-based position on the order"),
            quantity: z.number().int().min(0).describe("accepted thousandths - the only quantity that stocks and bills"),
            rejected: z.number().int().nonnegative().default(0).describe("arrived but refused; recorded, never stocked"),
            rejectionNote: z.string().max(500).optional(),
          }),
        )
        .min(1),
      /**
       * N16: overreceipt tolerance is an explicit authority, not an accident -
       * accepting more than ordered (within pct of the ordered quantity)
       * requires the paired reason naming who authorized it.
       */
      overreceiptTolerancePct: z.number().int().min(0).max(10).optional(),
      authorityReason: z.string().min(10).max(500).optional(),
      note: z.string().max(500).optional(),
    }),
    output: z.object({
      received: z.literal(true),
      fullyReceived: z.boolean(),
      receiptNumber: z.number(),
    }),
    execute: async (ctx, input) => {
      if ((input.overreceiptTolerancePct ?? 0) > 0 !== (input.authorityReason !== undefined)) {
        throw new Error(
        "overreceiptTolerancePct and authorityReason go together: either omit overreceiptTolerancePct entirely, or send both the tolerance percent and an authorityReason naming who authorized the overdelivery",
      );
      }
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [po] = await tx
          .select()
          .from(purchaseOrders)
          .where(and(eq(purchaseOrders.orgId, ctx.actor.orgId), eq(purchaseOrders.number, input.poNumber)))
          .limit(1);
        if (!po) throw new Error("purchase order not found");
        if (po.status === "void" || po.status === "closed") throw new Error(`order is ${po.status}`);

        const lines = await tx.select().from(poLines).where(eq(poLines.poId, po.id));
        // N16: addressing is by stable position, never by storage order.
        const lineAt = (position: number) => lines.find((l) => l.position === position);

        // N16: aggregate this receipt's demand per line first - repeated
        // references to the same line spend one budget, not one each.
        const wanted = new Map<number, { accepted: number; rejected: number; rejectionNote?: string }>();
        for (const rl of input.lines) {
          if (!lineAt(rl.lineNumber)) throw new Error(`no line ${rl.lineNumber} on order ${input.poNumber}`);
          const rejected = rl.rejected ?? 0;
          if (rejected > 0 && !rl.rejectionNote) {
            throw new Error(`line ${rl.lineNumber}: rejected goods need a rejectionNote saying why`);
          }
          const prior = wanted.get(rl.lineNumber);
          wanted.set(rl.lineNumber, {
            accepted: (prior?.accepted ?? 0) + rl.quantity,
            rejected: (prior?.rejected ?? 0) + rejected,
            rejectionNote: [prior?.rejectionNote, rl.rejectionNote].filter(Boolean).join("; ") || undefined,
          });
        }

        const receiptWrites: { line: (typeof lines)[number]; accepted: number; rejected: number; rejectionNote?: string }[] = [];
        for (const [lineNumber, { accepted, rejected, rejectionNote }] of wanted) {
          const line = lineAt(lineNumber)!;
          if (accepted === 0 && rejected === 0) {
            throw new Error(`line ${lineNumber}: a receipt line must accept or reject something`);
          }
          if (line.itemId) {
            const priorAccepted = await acceptedForLine(tx, line.id);
            const priorRejected = await rejectedForLine(tx, line.id);
            const tolerance = Math.floor((line.quantity * (input.overreceiptTolerancePct ?? 0)) / 100);
            if (priorAccepted + accepted > line.quantity + tolerance) {
              throw new Error(
                `line ${lineNumber}: receiving ${accepted} would exceed the ordered quantity ` +
                  `(ordered ${line.quantity}, already accepted ${priorAccepted}` +
                  (tolerance > 0 ? `, tolerance ${tolerance}` : "") +
                  `); overreceipt needs explicit authority (overreceiptTolerancePct + authorityReason) or an amended order`,
              );
            }
            if (priorAccepted + priorRejected + accepted + rejected > line.quantity + tolerance) {
              throw new Error(
                `line ${lineNumber}: delivered ${accepted + rejected} exceeds what was ordered ` +
                  `(ordered ${line.quantity}, already delivered ${priorAccepted + priorRejected})`,
              );
            }
          } else {
            // Service acceptance: record the delivered milestone without
            // faking stock, so service-only and mixed orders can complete.
            const acceptedPrior = line.serviceAcceptedThousandths ?? 0;
            if (acceptedPrior + accepted > line.quantity) {
              throw new Error(
                `line ${lineNumber}: accepting ${accepted} would exceed the ordered quantity ` +
                  `(ordered ${line.quantity}, already accepted ${acceptedPrior})`,
              );
            }
            await tx.update(poLines).set({ serviceAcceptedThousandths: acceptedPrior + accepted }).where(eq(poLines.id, line.id));
          }
          receiptWrites.push({ line, accepted, rejected, rejectionNote });
        }

        const receiptNumber = await nextDocNumber(tx, ctx.actor.orgId, "goods_receipt");
        const [receipt] = await tx
          .insert(goodsReceipts)
          .values({
            orgId: ctx.actor.orgId,
            poId: po.id,
            number: receiptNumber,
            receivedAt: ctx.now,
            receivedByActorType: ctx.actor.type,
            receivedByActorId: ctx.actor.id,
            note: input.note ?? (input.authorityReason ? `Overreceipt authorized: ${input.authorityReason}` : null),
          })
          .returning({ id: goodsReceipts.id });
        const receiptLineIds = new Map<number, string>();
        for (const [i, { line, accepted, rejected, rejectionNote }] of receiptWrites.entries()) {
          const [rl] = await tx
            .insert(goodsReceiptLines)
            .values({
              orgId: ctx.actor.orgId,
              receiptId: receipt!.id,
              poLineId: line.id,
              position: i + 1,
              acceptedThousandths: accepted,
              rejectedThousandths: rejected,
              rejectionNote: rejectionNote ?? null,
            })
            .returning({ id: goodsReceiptLines.id });
          receiptLineIds.set(receiptWrites[i]!.line.position, rl!.id);
        }

        // N22: write the stock movements through the shared inventory command
        // service - items locked in stable id order first, so a receipt and a
        // concurrent sale/production of the same item serialize. Only accepted
        // goods stock; rejected goods are recorded on the receipt and stop
        // there.
        const itemLineWrites = receiptWrites.filter((w) => w.line.itemId && w.accepted > 0);
        await lockStockItems(tx, itemLineWrites.map((w) => w.line.itemId!));
        for (const { line, accepted } of itemLineWrites) {
          await applyStockDelta(tx, {
            orgId: ctx.actor.orgId,
            itemId: line.itemId!,
            quantityDelta: accepted,
            reason: "purchase",
            refType: "goods_receipt_line",
            refId: receiptLineIds.get(line.position)!,
            note: `Receipt ${receiptNumber} against PO ${input.poNumber}`,
            unitCostMinor: line.unitPriceMinor,
            actorType: ctx.actor.type,
            actorId: ctx.actor.id,
          });
        }

        const fully = await orderFullyReceived(tx, po.id);
        await tx
          .update(purchaseOrders)
          .set({ status: fully ? "received" : "partial" })
          .where(eq(purchaseOrders.id, po.id));
        return { received: true as const, fullyReceived: fully, receiptNumber };
      });
    },
  });

/**
 * Delivered-basis helpers (N16): acceptance and rejection live on the
 * receipt lines; the stock ledger keeps netting returns out of acceptance
 * for legacy rows posted before receipts existed.
 */
async function acceptedForLine(tx: Parameters<Parameters<Database["db"]["transaction"]>[0]>[0], lineId: string): Promise<number> {
  const [rec] = await tx
    .select({ total: sql<number>`coalesce(sum(${goodsReceiptLines.acceptedThousandths}), 0)` })
    .from(goodsReceiptLines)
    .where(eq(goodsReceiptLines.poLineId, lineId));
  const [legacy] = await tx
    .select({ total: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)` })
    .from(stockMovements)
    .where(and(eq(stockMovements.refType, "po_line"), eq(stockMovements.refId, lineId)));
  return Number(rec?.total ?? 0) + Math.max(0, Number(legacy?.total ?? 0));
}

async function rejectedForLine(tx: Parameters<Parameters<Database["db"]["transaction"]>[0]>[0], lineId: string): Promise<number> {
  const [rec] = await tx
    .select({ total: sql<number>`coalesce(sum(${goodsReceiptLines.rejectedThousandths}), 0)` })
    .from(goodsReceiptLines)
    .where(eq(goodsReceiptLines.poLineId, lineId));
  return Number(rec?.total ?? 0);
}

/**
 * True when every line has its full ordered quantity delivered - through
 * accepted receipts (stock movements for item lines, accepted milestones
 * for service lines) plus recorded rejections, net of returns: goods sent
 * back are owed again, so a return demotes a "received" order to partial
 * (N16).
 */
async function orderFullyReceived(
  tx: Parameters<Parameters<Database["db"]["transaction"]>[0]>[0],
  poId: string,
): Promise<boolean> {
  const lines = await tx.select().from(poLines).where(eq(poLines.poId, poId));
  for (const line of lines) {
    if (line.itemId) {
      const delivered =
        (await acceptedForLine(tx, line.id)) - (await returnedForLine(tx, line.id)) + (await rejectedForLine(tx, line.id));
      if (delivered < line.quantity) return false;
    } else if ((line.serviceAcceptedThousandths ?? 0) < line.quantity) {
      return false;
    }
  }
  return true;
}

// ── Purchasing workflow: request → review → RFQ → quotes → award ───────

const createPurchaseRequest = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.createPurchaseRequest",
    title: "Create purchase request",
    intent:
      "Raise an internal purchase request for review and approval before anything is ordered; the first step of the procure-to-pay workflow",
    module: "purchasing",
    risk: "write",
    permission: "purchasing.write",
    input: z.object({
      title: z.string().min(3).max(200),
      justification: z.string().min(10).max(4000),
      estimatedAmountMinor: z.number().int().nonnegative().optional(),
    }),
    output: z.object({ requestId: z.string() }),
    execute: async (ctx, input) => {
      const [row] = await deps.db
        .insert(purchaseRequests)
        .values({
          orgId: ctx.actor.orgId,
          title: input.title,
          justification: input.justification,
          estimatedAmountMinor: input.estimatedAmountMinor ?? null,
          // Attribution: an agent's actor id is the principal it works for,
          // so requests always carry the human they belong to.
          requestedByUserId: ctx.actor.id,
        })
        .returning({ id: purchaseRequests.id });
      return { requestId: row!.id };
    },
  });

const decidePurchaseRequest = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.decidePurchaseRequest",
    title: "Approve or reject purchase request",
    intent:
      "Record a reviewer's approve or reject decision on a pending purchase request; only approved requests may go out as RFQs",
    module: "purchasing",
    risk: "write",
    permission: "purchasing.write",
    input: z.object({
      requestId: z.string(),
      decision: z.enum(["approve", "reject"]),
      reason: z.string().max(1000).optional(),
    }),
    output: z.object({ status: z.string() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [req] = await tx
          .select({ id: purchaseRequests.id, status: purchaseRequests.status })
          .from(purchaseRequests)
          .where(and(eq(purchaseRequests.id, input.requestId), eq(purchaseRequests.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!req) throw new Error("purchase request not found");
        if (req.status !== "pending_review") throw new Error(`request is already ${req.status}`);
        const status = input.decision === "approve" ? "approved" : "rejected";
        await tx
          .update(purchaseRequests)
          .set({
            status,
            decidedByUserId: ctx.actor.type === "human" ? ctx.actor.id : null,
            decisionReason: input.reason ?? null,
            decidedAt: ctx.now,
          })
          .where(eq(purchaseRequests.id, req.id));
        return { status };
      });
    },
  });

const createRfq = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.createRfq",
    title: "Send RFQ to vendors",
    intent:
      "Request competitive quotes from one or more vendors for an approved purchase request, creating one tracked RFQ per vendor",
    module: "purchasing",
    risk: "write",
    permission: "purchasing.write",
    input: z.object({
      requestId: z.string(),
      vendorIds: z.array(z.string()).min(1).max(10),
    }),
    output: z.object({ rfqIds: z.array(z.string()) }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [req] = await tx
          .select({ id: purchaseRequests.id, status: purchaseRequests.status })
          .from(purchaseRequests)
          .where(and(eq(purchaseRequests.id, input.requestId), eq(purchaseRequests.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!req) throw new Error("purchase request not found");
        if (req.status !== "approved") throw new Error("only approved requests can go out as RFQs");

        const vendorRows = await tx
          .select({ id: vendors.id })
          .from(vendors)
          .where(eq(vendors.orgId, ctx.actor.orgId));
        const known = new Set(vendorRows.map((v) => v.id));
        const unknown = input.vendorIds.filter((v) => !known.has(v));
        if (unknown.length > 0) throw new Error("unknown vendor id(s)");

        const rows = await tx
          .insert(rfqs)
          .values(input.vendorIds.map((vendorId) => ({ orgId: ctx.actor.orgId, requestId: req.id, vendorId })))
          .returning({ id: rfqs.id });
        return { rfqIds: rows.map((r) => r.id) };
      });
    },
  });

const recordQuote = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.recordQuote",
    title: "Record a vendor quote",
    intent:
      "Log a vendor's quote (amount, lead time, notes) against an open RFQ so bids can be compared and a winner selected",
    module: "purchasing",
    risk: "write",
    permission: "purchasing.write",
    input: z.object({
      rfqId: z.string(),
      amountMinor: z.number().int().positive(),
      leadTimeDays: z.number().int().nonnegative().optional(),
      notes: z.string().max(2000).optional(),
    }),
    output: z.object({ status: z.string() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [rfq] = await tx
          .select({ id: rfqs.id, status: rfqs.status })
          .from(rfqs)
          .where(and(eq(rfqs.id, input.rfqId), eq(rfqs.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!rfq) throw new Error("RFQ not found");
        if (rfq.status === "won" || rfq.status === "lost") throw new Error("this RFQ is already decided");
        await tx
          .update(rfqs)
          .set({
            status: "quoted",
            quoteAmountMinor: input.amountMinor,
            quoteLeadTimeDays: input.leadTimeDays ?? null,
            quoteNotes: input.notes ?? null,
            quotedAt: ctx.now,
          })
          .where(eq(rfqs.id, rfq.id));
        return { status: "quoted" };
      });
    },
  });

const selectWinningQuote = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.selectWinningQuote",
    title: "Select winning quote and raise PO",
    intent:
      "Award an approved request to a vendor's quoted price: marks that RFQ won, its siblings lost, and raises the purchase order so receiving and billing can proceed",
    module: "purchasing",
    risk: "write",
    permission: "purchasing.write",
    input: z.object({ rfqId: z.string() }),
    output: z.object({ poNumber: z.number(), vendorId: z.string(), quoteAmountMinor: z.number() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [winner] = await tx
          .select()
          .from(rfqs)
          .where(and(eq(rfqs.id, input.rfqId), eq(rfqs.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!winner) throw new Error("RFQ not found");
        if (winner.status !== "quoted") throw new Error("record this vendor's quote before awarding");
        const [req] = await tx
          .select({ status: purchaseRequests.status, title: purchaseRequests.title })
          .from(purchaseRequests)
          .where(and(eq(purchaseRequests.id, winner.requestId), eq(purchaseRequests.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!req) throw new Error("purchase request not found");
        if (req.status !== "approved") throw new Error("request is no longer approvable into an order");

        // Sibling bids lose; the winner converts into a purchase order.
        await tx.update(rfqs).set({ status: "lost" }).where(
          and(eq(rfqs.requestId, winner.requestId), eq(rfqs.orgId, ctx.actor.orgId)),
        );
        await tx.update(rfqs).set({ status: "won" }).where(eq(rfqs.id, winner.id));

        const poNumber = await nextDocNumber(tx, ctx.actor.orgId, "purchase_order");
        const [po] = await tx
          .insert(purchaseOrders)
          .values({
            orgId: ctx.actor.orgId,
            vendorId: winner.vendorId,
            number: poNumber,
            status: "ordered",
            memo: `From RFQ award · ${req.title}`,
            orderedAt: ctx.now,
          })
          .returning({ id: purchaseOrders.id });
        await tx.insert(poLines).values({
          poId: po!.id,
          description: req.title,
          quantity: 1000,
          unitPriceMinor: winner.quoteAmountMinor ?? 0,
          position: 1,
        });

        await tx
          .update(purchaseRequests)
          .set({ status: "converted", decidedAt: ctx.now })
          .where(eq(purchaseRequests.id, winner.requestId));
        return { poNumber, vendorId: winner.vendorId, quoteAmountMinor: winner.quoteAmountMinor ?? 0 };
      });
    },
  });

const listPurchaseWorkflow = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.listPurchaseWorkflow",
    title: "List purchase requests and RFQs",
    intent:
      "List recent internal purchase requests with their approval state and every RFQ bid on them, so you can review, chase quotes, or award a winner",
    module: "purchasing",
    risk: "read",
    permission: "purchasing.read",
    input: z.object({}),
    output: z.object({
      requests: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          justification: z.string(),
          estimatedAmountMinor: z.number().nullable(),
          status: z.string(),
          createdAt: z.string(),
          rfqs: z.array(
            z.object({
              id: z.string(),
              vendorId: z.string(),
              status: z.string(),
              quoteAmountMinor: z.number().nullable(),
              quoteLeadTimeDays: z.number().nullable(),
            }),
          ),
        }),
      ),
    }),
    execute: async (ctx) => {
      const reqRows = await deps.db
        .select()
        .from(purchaseRequests)
        .where(eq(purchaseRequests.orgId, ctx.actor.orgId))
        .orderBy(desc(purchaseRequests.createdAt))
        .limit(50);
      const rfqRows = reqRows.length
        ? await deps.db.select().from(rfqs).where(eq(rfqs.orgId, ctx.actor.orgId))
        : [];
      return {
        requests: reqRows.map((r) => ({
          id: r.id,
          title: r.title,
          justification: r.justification,
          estimatedAmountMinor: r.estimatedAmountMinor,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
          rfqs: rfqRows
            .filter((f) => f.requestId === r.id)
            .map((f) => ({
              id: f.id,
              vendorId: f.vendorId,
              status: f.status,
              quoteAmountMinor: f.quoteAmountMinor,
              quoteLeadTimeDays: f.quoteLeadTimeDays,
            })),
        })),
      };
    },
  });

// ── M10: supplier memory, credit notes, returns, backorders ────────────

/**
 * AP credit note (M10, ADR 0037): the supplier conceded money - mirror of
 * the AR credit note. Always gates; the bill document is never edited.
 */
const billCreditNote = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.billCreditNote",
    title: "Credit a vendor bill",
    intent:
      "Record a supplier credit against an open bill - an approved reversing entry that reduces what is owed without editing the bill",
    module: "purchasing",
    risk: "money",
    permission: "purchasing.write",
    moneyAmount: () => null,
    input: z.object({
      billId: z.string().uuid(),
      amountMinor: z.number().int().positive(),
      reason: z.string().min(3).max(500),
    }),
    output: z.object({ entryId: z.string(), creditedMinor: z.number(), billBalanceMinor: z.number() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [bill] = await tx
          .select()
          .from(vendorBills)
          .where(and(eq(vendorBills.id, input.billId), eq(vendorBills.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!bill) throw new Error("bill not found");
        if (bill.status === "void") throw new Error("bill is void; nothing to credit");
        const balance = bill.totalMinor - bill.paidMinor - bill.creditedMinor;
        if (input.amountMinor > balance) {
          throw new Error(
            `credit ${input.amountMinor} exceeds the open balance ${balance} (total ${bill.totalMinor} − paid ${bill.paidMinor} − credited ${bill.creditedMinor})`,
          );
        }
        const taxRows = await tx
          .select({ taxMinor: vendorBillLines.taxMinor })
          .from(vendorBillLines)
          .innerJoin(taxCodes, eq(taxCodes.id, vendorBillLines.taxCodeId))
          .where(and(
            eq(vendorBillLines.billId, bill.id),
            eq(taxCodes.direction, "input"),
            eq(taxCodes.recoverable, true),
          ));
        const recoverableTax = taxRows.reduce((sum, row) => sum + BigInt(row.taxMinor), 0n);
        const taxCreditMinor = bill.totalMinor === 0
          ? 0
          : Number((BigInt(input.amountMinor) * recoverableTax * 2n + BigInt(bill.totalMinor)) / (2n * BigInt(bill.totalMinor)));
        const expenseCreditMinor = input.amountMinor - taxCreditMinor;
        const entryId = await postEntry(tx, ctx.actor.orgId, ctx.actor, {
          memo: `Supplier credit on bill ${bill.number}: ${input.reason}`,
          sourceType: "vendor_credit_note",
          sourceId: bill.id,
          reversalOfId: bill.entryId,
          postedAt: ctx.now,
          lines: [
            { accountCode: "2000", debitMinor: input.amountMinor, creditMinor: 0 },
            { accountCode: "6000", debitMinor: 0, creditMinor: expenseCreditMinor },
            ...(taxCreditMinor > 0 ? [{ accountCode: "1205", debitMinor: 0, creditMinor: taxCreditMinor }] : []),
          ],
        });
        const credited = bill.creditedMinor + input.amountMinor;
        await tx.update(vendorBills).set({ creditedMinor: credited }).where(eq(vendorBills.id, bill.id));
        return { entryId, creditedMinor: credited, billBalanceMinor: bill.totalMinor - bill.paidMinor - credited };
      });
    },
  });

/** Received quantity for a PO line, derived from the stock ledger. */
/**
 * Returns recorded against a line: modern returns update the receipt line's
 * returned quantity; legacy returns are the negative refType='po_line'
 * movements posted before receipts existed.
 */
async function returnedForLine(tx: Parameters<Parameters<Database["db"]["transaction"]>[0]>[0], lineId: string): Promise<number> {
  const [rec] = await tx
    .select({ total: sql<number>`coalesce(sum(${goodsReceiptLines.returnedThousandths}), 0)` })
    .from(goodsReceiptLines)
    .where(eq(goodsReceiptLines.poLineId, lineId));
  const [legacy] = await tx
    .select({ total: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)` })
    .from(stockMovements)
    .where(and(eq(stockMovements.refType, "po_line"), eq(stockMovements.refId, lineId)));
  return Number(rec?.total ?? 0) + Math.max(0, -Number(legacy?.total ?? 0));
}

const closePurchaseOrder = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.closePurchaseOrder",
    title: "Close purchase order",
    intent:
      "Close an order that will not be fully received; if quantities are short the order is marked backordered so the shortfall stays on the vendor's record",
    module: "purchasing",
    risk: "write",
    permission: "purchasing.write",
    input: z.object({ poNumber: z.number().int().positive() }),
    output: z.object({ closed: z.literal(true), backordered: z.boolean(), shortThousandths: z.number() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [po] = await tx
          .select()
          .from(purchaseOrders)
          .where(and(eq(purchaseOrders.orgId, ctx.actor.orgId), eq(purchaseOrders.number, input.poNumber)))
          .limit(1);
        if (!po) throw new Error("purchase order not found");
        if (po.status === "void") throw new Error("order is void");
        if (po.status === "closed") throw new Error("order is already closed");
        const lines = await tx.select().from(poLines).where(eq(poLines.poId, po.id));
        let short = 0;
        for (const line of lines) {
          // N16: the shortfall still owed is ordered minus what remains
          // accepted net of returns - rejections were delivered (refused,
          // not owed), returns are owed again.
          const delivered = line.itemId
            ? (await acceptedForLine(tx, line.id)) - (await returnedForLine(tx, line.id)) + (await rejectedForLine(tx, line.id))
            : (line.serviceAcceptedThousandths ?? 0);
          short += Math.max(0, line.quantity - delivered);
        }
        await tx
          .update(purchaseOrders)
          .set({ status: "closed", backordered: short > 0 })
          .where(eq(purchaseOrders.id, po.id));
        return { closed: true as const, backordered: short > 0, shortThousandths: short };
      });
    },
  });

const returnGoods = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.returnGoods",
    title: "Return goods to vendor",
    intent:
      "Send received goods back to the vendor: writes negative stock legs against the purchase order so receipts, fill rates, and stock stay truthful",
    // No inverse: a return is itself a reversal. The ledger keeps both legs;
    // a mistaken return is corrected by receiving the goods again.
    module: "purchasing",
    risk: "write",
    permission: "purchasing.write",
    input: z.object({
      poNumber: z.number().int().positive(),
      /** N16: when given, the return consumes that receipt's acceptance. */
      receiptNumber: z.number().int().positive().optional(),
      lines: z
        .array(
          z.object({
            lineNumber: z.number().int().positive().describe("stable 1-based position on the order"),
            quantity: z.number().int().positive().describe("Thousandths to send back"),
            reason: z.string().min(3).max(500),
          }),
        )
        .min(1),
    }),
    output: z.object({ returned: z.literal(true), lines: z.number() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [po] = await tx
          .select()
          .from(purchaseOrders)
          .where(and(eq(purchaseOrders.orgId, ctx.actor.orgId), eq(purchaseOrders.number, input.poNumber)))
          .limit(1);
        if (!po) throw new Error("purchase order not found");
        if (po.status === "void") throw new Error("order is void");
        const lines = await tx.select().from(poLines).where(eq(poLines.poId, po.id));
        const lineAt = (position: number) => lines.find((l) => l.position === position);

        // N16: one budget per line, so repeated references cannot double-return.
        const wanted = new Map<number, { quantity: number; reason: string }>();
        for (const rl of input.lines) {
          if (!lineAt(rl.lineNumber)) throw new Error(`no line ${rl.lineNumber} on order ${input.poNumber}`);
          const prior = wanted.get(rl.lineNumber);
          wanted.set(rl.lineNumber, {
            quantity: (prior?.quantity ?? 0) + rl.quantity,
            reason: prior ? `${prior.reason}; ${rl.reason}` : rl.reason,
          });
        }

        // The receipts this return draws from: one named receipt, or the
        // order's receipts in receipt-number order (oldest acceptance first).
        const receiptScope = input.receiptNumber
          ? await tx
              .select()
              .from(goodsReceipts)
              .where(and(eq(goodsReceipts.orgId, ctx.actor.orgId), eq(goodsReceipts.poId, po.id), eq(goodsReceipts.number, input.receiptNumber)))
          : await tx
              .select()
              .from(goodsReceipts)
              .where(and(eq(goodsReceipts.orgId, ctx.actor.orgId), eq(goodsReceipts.poId, po.id)))
              .orderBy(goodsReceipts.number);
        if (input.receiptNumber && receiptScope.length === 0) {
          throw new Error(`receipt ${input.receiptNumber} does not belong to order ${input.poNumber}`);
        }
        const scopeIds = new Set(receiptScope.map((r) => r.id));

        const returnWrites: { lineId: string; itemId: string; quantity: number; note: string; unitCostMinor: number; draws: { receiptLineId: string; qty: number }[] }[] = [];
        for (const [lineNumber, { quantity, reason }] of wanted) {
          const line = lineAt(lineNumber)!;
          if (!line.itemId) throw new Error(`line ${lineNumber} is a service line; nothing to return`);
          const netAvailable = (await acceptedForLine(tx, line.id)) - (await returnedForLine(tx, line.id));
          if (quantity > netAvailable) {
            throw new Error(
              `line ${lineNumber}: cannot return ${quantity}; only ${netAvailable} thousandths were received and not already returned`,
            );
          }
          // Goods already shipped to customers are not in the warehouse to
          // send back; a return of consumed stock needs a customer return,
          // not a vendor one.
          const [oh] = await tx
            .select({ total: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)` })
            .from(stockMovements)
            .where(and(eq(stockMovements.orgId, ctx.actor.orgId), eq(stockMovements.itemId, line.itemId)));
          const onHand = Number(oh?.total ?? 0);
          if (onHand < quantity) {
            throw new Error(
              `line ${lineNumber}: only ${onHand} thousandths of this item are on hand; goods already shipped need a customer return, not a vendor return`,
            );
          }
          // N16: draw the return from concrete receipt lines, oldest first,
          // so each receipt line's returned quantity stays exact.
          const receiptLines = (await tx
            .select()
            .from(goodsReceiptLines)
            .where(and(eq(goodsReceiptLines.orgId, ctx.actor.orgId), eq(goodsReceiptLines.poLineId, line.id)))
            .orderBy(goodsReceiptLines.receiptId, goodsReceiptLines.position)).filter((rl) => scopeIds.has(rl.receiptId));
          let remaining = quantity;
          const draws: { receiptLineId: string; qty: number }[] = [];
          for (const rl of receiptLines) {
            if (remaining === 0) break;
            const available = rl.acceptedThousandths - rl.returnedThousandths;
            if (available <= 0) continue;
            const take = Math.min(available, remaining);
            draws.push({ receiptLineId: rl.id, qty: take });
            remaining -= take;
          }
          if (remaining > 0 && receiptLines.length > 0) {
            throw new Error(
              input.receiptNumber
                ? `line ${lineNumber}: receipt ${input.receiptNumber} does not carry ${quantity} thousandths available to return on this line`
                : `line ${lineNumber}: no receipt carries ${quantity} thousandths available to return on this line`,
            );
          }
          // Legacy line - received before receipts existed, so the return
          // can only draw from the historical net and points at the line.
          const legacy = receiptLines.length === 0;
          const scopeNote = input.receiptNumber ? `receipt ${input.receiptNumber}` : "receipts";
          returnWrites.push({
            lineId: line.id,
            itemId: line.itemId,
            quantity,
            note: legacy
              ? `Return to vendor (PO ${input.poNumber}): ${reason}`
              : `Return to vendor (PO ${input.poNumber}, ${scopeNote}): ${reason}`,
            unitCostMinor: line.unitPriceMinor,
            draws,
          });
        }

        for (const w of returnWrites) {
          for (const d of w.draws) {
            await tx
              .update(goodsReceiptLines)
              .set({ returnedThousandths: sql`${goodsReceiptLines.returnedThousandths} + ${d.qty}` })
              .where(eq(goodsReceiptLines.id, d.receiptLineId));
          }
        }

        // N22: the outbound legs go through the shared inventory command
        // service - items locked in stable id order, non-negative balance
        // re-checked against the serialized state.
        await lockStockItems(tx, returnWrites.map((w) => w.itemId));
        for (const w of returnWrites) {
          await applyStockDelta(tx, {
            orgId: ctx.actor.orgId,
            itemId: w.itemId,
            quantityDelta: -w.quantity,
            reason: "purchase",
            refType: w.draws.length > 0 ? "goods_receipt_line" : "po_line",
            refId: w.draws.length > 0 ? w.draws[0]!.receiptLineId : w.lineId,
            note: w.note,
            unitCostMinor: w.unitCostMinor,
            actorType: ctx.actor.type,
            actorId: ctx.actor.id,
          });
        }

        // A return can undo full receipt: a "received" order with a line
        // back below its ordered quantity is partially received again.
        if (po.status === "received" && !(await orderFullyReceived(tx, po.id))) {
          await tx.update(purchaseOrders).set({ status: "partial" }).where(eq(purchaseOrders.id, po.id));
        }
        return { returned: true as const, lines: input.lines.length };
      });
    },
  });

const listReceipts = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.listReceipts",
    title: "List goods receipts for a purchase order",
    intent:
      "Show each receipt an order produced - per line what was accepted, rejected, returned, and what remains outstanding - so receiving and three-way matching can be checked by hand",
    module: "purchasing",
    risk: "read",
    permission: "purchasing.read",
    input: z.object({ poNumber: z.number().int().positive() }),
    output: z.object({
      receipts: z.array(
        z.object({
          number: z.number(),
          receivedAt: z.string(),
          note: z.string().nullable(),
          lines: z.array(
            z.object({
              position: z.number(),
              description: z.string(),
              acceptedThousandths: z.number(),
              rejectedThousandths: z.number(),
              returnedThousandths: z.number(),
              rejectionNote: z.string().nullable(),
            }),
          ),
        }),
      ),
      orderLines: z.array(
        z.object({
          position: z.number(),
          description: z.string(),
          orderedThousandths: z.number(),
          acceptedThousandths: z.number(),
          rejectedThousandths: z.number(),
          returnedThousandths: z.number(),
          remainingThousandths: z.number(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [po] = await tx
          .select()
          .from(purchaseOrders)
          .where(and(eq(purchaseOrders.orgId, ctx.actor.orgId), eq(purchaseOrders.number, input.poNumber)))
          .limit(1);
        if (!po) throw new Error("purchase order not found");
        const lines = await tx.select().from(poLines).where(eq(poLines.poId, po.id));
        const lineById = new Map(lines.map((l) => [l.id, l]));

        const receipts = await tx
          .select()
          .from(goodsReceipts)
          .where(and(eq(goodsReceipts.orgId, ctx.actor.orgId), eq(goodsReceipts.poId, po.id)))
          .orderBy(goodsReceipts.number);
        const receiptRows = receipts.length
          ? await tx
              .select({
                receiptId: goodsReceiptLines.receiptId,
                position: goodsReceiptLines.position,
                poLineId: goodsReceiptLines.poLineId,
                acceptedThousandths: goodsReceiptLines.acceptedThousandths,
                rejectedThousandths: goodsReceiptLines.rejectedThousandths,
                returnedThousandths: goodsReceiptLines.returnedThousandths,
                rejectionNote: goodsReceiptLines.rejectionNote,
              })
              .from(goodsReceiptLines)
              .where(
                and(
                  eq(goodsReceiptLines.orgId, ctx.actor.orgId),
                  inArray(
                    goodsReceiptLines.receiptId,
                    receipts.map((r) => r.id),
                  ),
                ),
              )
              .orderBy(goodsReceiptLines.receiptId, goodsReceiptLines.position)
          : [];
        // Legacy lines delivered before receipts existed contribute to the
        // order-line roll-up through the stock ledger instead.
        const outReceipts: Array<{
          number: number;
          receivedAt: string;
          note: string | null;
          lines: Array<{
            position: number;
            description: string;
            acceptedThousandths: number;
            rejectedThousandths: number;
            returnedThousandths: number;
            rejectionNote: string | null;
          }>;
        }> = [];
        for (const r of receipts) {
          const rl = receiptRows.filter((row) => row.receiptId === r.id);
          outReceipts.push({
            number: r.number,
            receivedAt: r.receivedAt.toISOString(),
            note: r.note,
            lines: rl.map((row) => ({
              position: row.position,
              description: lineById.get(row.poLineId)?.description ?? "",
              acceptedThousandths: row.acceptedThousandths,
              rejectedThousandths: row.rejectedThousandths,
              returnedThousandths: row.returnedThousandths,
              rejectionNote: row.rejectionNote,
            })),
          });
        }
        const orderLines = [];
        for (const line of [...lines].sort((a, b) => a.position - b.position)) {
          const accepted = await acceptedForLine(tx, line.id);
          const rejected = await rejectedForLine(tx, line.id);
          const returned = await returnedForLine(tx, line.id);
          orderLines.push({
            position: line.position,
            description: line.description,
            orderedThousandths: line.quantity,
            acceptedThousandths: accepted,
            rejectedThousandths: rejected,
            returnedThousandths: returned,
            remainingThousandths: Math.max(0, line.quantity - accepted - rejected),
          });
        }
        return { receipts: outReceipts, orderLines };
      });
    },
  });

const supplierPerformance = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.supplierPerformance",
    title: "Supplier performance",
    intent:
      "Summarize each vendor's delivery record - average lead time from order to receipt, fill rate, backorders, and late arrivals against promised dates",
    module: "purchasing",
    risk: "read",
    permission: "purchasing.read",
    input: z.object({}),
    output: z.object({
      vendors: z.array(
        z.object({
          vendorId: z.string(),
          vendorName: z.string(),
          orders: z.number(),
          avgLeadTimeDays: z.number().nullable(),
          onTimeRate: z.number().nullable(),
          fillRate: z.number().nullable(),
          backorderedOrders: z.number(),
        }),
      ),
    }),
    execute: async (ctx) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const vendorRows = await tx.select({ id: vendors.id, name: vendors.name }).from(vendors).where(eq(vendors.orgId, ctx.actor.orgId));
        const out = [] as Array<{
          vendorId: string;
          vendorName: string;
          orders: number;
          avgLeadTimeDays: number | null;
          onTimeRate: number | null;
          fillRate: number | null;
          backorderedOrders: number;
        }>;
        for (const v of vendorRows) {
          const pos = await tx
            .select()
            .from(purchaseOrders)
            .where(and(eq(purchaseOrders.orgId, ctx.actor.orgId), eq(purchaseOrders.vendorId, v.id)));
          const live = pos.filter((p) => p.status !== "void" && p.orderedAt);
          let leadSum = 0;
          let leadCount = 0;
          let onTime = 0;
          let promised = 0;
          let orderedTotal = 0;
          let receivedTotal = 0;
          let backordered = 0;
          for (const p of live) {
            backordered += p.backordered ? 1 : 0;
            const lines = await tx.select().from(poLines).where(eq(poLines.poId, p.id)).orderBy(poLines.id);
            for (const line of lines) {
              orderedTotal += line.quantity;
              const rec = Math.max(0, (await acceptedForLine(tx, line.id)) - (await returnedForLine(tx, line.id)));
              receivedTotal += Math.min(rec, line.quantity);
            }
            // Lead time runs from order to first receipt - the receipt
            // header when receipts exist, the first legacy movement
            // otherwise (N16).
            let firstAt: Date | null = null;
            const [firstReceipt] = await tx
              .select({ at: sql<Date>`min(${goodsReceipts.receivedAt})` })
              .from(goodsReceipts)
              .where(and(eq(goodsReceipts.orgId, ctx.actor.orgId), eq(goodsReceipts.poId, p.id)));
            if (firstReceipt?.at) firstAt = new Date(firstReceipt.at);
            if (!firstAt) {
              const [first] = await tx
                .select({ at: stockMovements.createdAt })
                .from(stockMovements)
                .where(and(eq(stockMovements.refType, "po_line"), eq(stockMovements.refId, lines[0]?.id ?? "")))
                .orderBy(stockMovements.createdAt)
                .limit(1);
              firstAt = first?.at ?? null;
            }
            const touched = lines.some((line) => line.itemId) ? true : lines.some((l) => (l.serviceAcceptedThousandths ?? 0) > 0);
            if (firstAt && p.orderedAt && touched) {
              leadSum += Math.max(0, (firstAt.getTime() - p.orderedAt.getTime()) / 86_400_000);
              leadCount += 1;
              if (p.promisedAt) {
                promised += 1;
                if (firstAt.getTime() <= p.promisedAt.getTime()) onTime += 1;
              }
            }
          }
          out.push({
            vendorId: v.id,
            vendorName: v.name,
            orders: live.length,
            avgLeadTimeDays: leadCount > 0 ? Math.round((leadSum / leadCount) * 10) / 10 : null,
            onTimeRate: promised > 0 ? Math.round((onTime / promised) * 100) : null,
            fillRate: orderedTotal > 0 ? Math.round((Math.min(receivedTotal, orderedTotal) / orderedTotal) * 100) : null,
            backorderedOrders: backordered,
          });
        }
        return { vendors: out };
      });
    },
  });

const priceHistory = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.priceHistory",
    title: "Supplier price history",
    intent:
      "Show what each vendor has actually charged per item across purchase orders over time, so a 'special price' can be checked against the record",
    module: "purchasing",
    risk: "read",
    permission: "purchasing.read",
    input: z.object({ sku: z.string().optional() }),
    output: z.object({
      rows: z.array(
        z.object({
          vendorName: z.string(),
          itemSku: z.string().nullable(),
          itemDescription: z.string(),
          unitPriceMinor: z.number(),
          orderedAt: z.string().nullable(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const rows = await tx
          .select({
            vendorName: vendors.name,
            itemSku: items.sku,
            description: poLines.description,
            unitPriceMinor: poLines.unitPriceMinor,
            orderedAt: purchaseOrders.orderedAt,
          })
          .from(poLines)
          .innerJoin(purchaseOrders, eq(poLines.poId, purchaseOrders.id))
          .innerJoin(vendors, eq(purchaseOrders.vendorId, vendors.id))
          .leftJoin(items, eq(poLines.itemId, items.id))
          .where(
            input.sku
              ? and(eq(purchaseOrders.orgId, ctx.actor.orgId), eq(items.sku, input.sku))
              : eq(purchaseOrders.orgId, ctx.actor.orgId),
          )
          .orderBy(desc(purchaseOrders.orderedAt))
          .limit(300);
        return {
          rows: rows.map((r) => ({
            vendorName: r.vendorName,
            itemSku: r.itemSku,
            itemDescription: r.description,
            unitPriceMinor: r.unitPriceMinor,
            orderedAt: r.orderedAt?.toISOString() ?? null,
          })),
        };
      });
    },
  });

const supplierStatement = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.supplierStatement",
    title: "Supplier statement",
    intent:
      "Render a vendor's account as a dated, running-balance statement of bills, payments, and supplier credits - what you reconcile their month-end statement against",
    module: "purchasing",
    risk: "read",
    permission: "purchasing.read",
    input: z.object({ vendorId: z.string().uuid() }),
    output: z.object({
      closingBalanceMinor: z.number(),
      rows: z.array(
        z.object({
          date: z.string(),
          kind: z.string(),
          ref: z.string(),
          amountMinor: z.number(),
          balanceMinor: z.number(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const billRows = await tx
          .select({
            id: vendorBills.id,
            number: vendorBills.number,
            totalMinor: vendorBills.totalMinor,
            creditedMinor: vendorBills.creditedMinor,
            billDate: vendorBills.billDate,
            createdAt: vendorBills.createdAt,
            voidedAt: vendorBills.voidedAt,
          })
          .from(vendorBills)
          .where(and(eq(vendorBills.orgId, ctx.actor.orgId), eq(vendorBills.vendorId, input.vendorId)));
        const live = billRows.filter((b) => !b.voidedAt);
        const billIds = new Set(live.map((b) => b.id));
        const payRows = await tx
          .select({ billId: vendorPayments.billId, amountMinor: vendorPayments.amountMinor, paidAt: vendorPayments.paidAt })
          .from(vendorPayments)
          .where(eq(vendorPayments.orgId, ctx.actor.orgId));
        const creditRows = await tx
          .select({
            sourceId: journalEntries.sourceId,
            postedAt: journalEntries.postedAt,
            debitMinor: journalLines.debitMinor,
            creditMinor: journalLines.creditMinor,
            code: accounts.code,
          })
          .from(journalEntries)
          .innerJoin(journalLines, eq(journalLines.entryId, journalEntries.id))
          .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
          .where(
            and(
              eq(journalEntries.orgId, ctx.actor.orgId),
              eq(journalEntries.sourceType, "vendor_credit_note"),
              eq(accounts.code, "2000"),
            ),
          );

        type Row = { date: Date; kind: string; ref: string; amountMinor: number };
        const rows: Row[] = [];
        for (const b of live) {
          // Gross: credits appear as their own statement lines below.
          rows.push({ date: b.billDate ?? b.createdAt, kind: "bill", ref: `Bill #${b.number}`, amountMinor: b.totalMinor });
          for (const c of creditRows) {
            if (c.sourceId !== b.id) continue;
            rows.push({ date: c.postedAt, kind: "credit_note", ref: `Credit on bill #${b.number}`, amountMinor: -(c.debitMinor - c.creditMinor) });
          }
        }
        for (const p of payRows) {
          if (!billIds.has(p.billId)) continue;
          rows.push({ date: p.paidAt, kind: "payment", ref: "Payment sent", amountMinor: -p.amountMinor });
        }
        rows.sort((a, b) => a.date.getTime() - b.date.getTime() || a.kind.localeCompare(b.kind));
        let running = 0;
        const rendered = rows.map((r) => {
          running += r.amountMinor;
          return { date: r.date.toISOString(), kind: r.kind, ref: r.ref, amountMinor: r.amountMinor, balanceMinor: running };
        });
        return { closingBalanceMinor: running, rows: rendered };
      });
    },
  });

export function registerPurchasingCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(createVendor(deps));
  registry.register(createPO(deps));
  registry.register(receivePO(deps));
  registry.register(createBill(deps));
  registry.register(payBill(deps));
  registry.register(reverseVendorPayment(deps));
  registry.register(createPaymentRun(deps));
  registry.register(cancelPaymentRunDraft(deps));
  registry.register(restorePaymentRunDraft(deps));
  registry.register(instructPaymentRun(deps));
  registry.register(reversePaymentRun(deps));
  registry.register(listPaymentRuns(deps));
  registry.register(apAging(deps));
  registry.register(billCreditNote(deps));
  registry.register(closePurchaseOrder(deps));
  registry.register(returnGoods(deps));
  registry.register(listReceipts(deps));
  registry.register(supplierPerformance(deps));
  registry.register(priceHistory(deps));
  registry.register(supplierStatement(deps));
  registry.register(createPurchaseRequest(deps));
  registry.register(decidePurchaseRequest(deps));
  registry.register(createRfq(deps));
  registry.register(recordQuote(deps));
  registry.register(selectWinningQuote(deps));
  registry.register(listPurchaseWorkflow(deps));
}
