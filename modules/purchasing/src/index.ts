import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  journalEntries,
  journalLines,
  periods,
  vendorBillLines,
  vendorBills,
  vendorPayments,
  vendors,
} from "@chaste/db";
import { assertBalanced, computeAging, computeInvoiceTotals } from "@chaste/erp-core";
import type { Database } from "@chaste/db";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";

export interface ModuleDeps {
  db: Database["db"];
}

type Tx = Parameters<Parameters<ModuleDeps["db"]["transaction"]>[0]>[0];

async function assertPeriodOpen(db: Tx | ModuleDeps["db"], orgId: string, date: Date): Promise<void> {
  const closed = await db.select({ year: periods.year, month: periods.month }).from(periods).where(eq(periods.orgId, orgId));
  if (!isPeriodOpenLocal(closed, date)) {
    throw new Error(`period ${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")} is closed`);
  }
}

function isPeriodOpenLocal(closed: { year: number; month: number }[], date: Date): boolean {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  return !closed.some((p) => p.year === y && p.month === m);
}

async function coaMap(tx: Tx | ModuleDeps["db"], orgId: string): Promise<Map<string, string>> {
  const rows = await tx.select({ code: accounts.code, id: accounts.id }).from(accounts).where(eq(accounts.orgId, orgId));
  return new Map(rows.map((r) => [r.code, r.id]));
}

function accountIdOf(map: Map<string, string>, code: string): string {
  const id = map.get(code);
  if (!id) throw new Error(`account ${code} missing from chart of accounts`);
  return id;
}

const createVendor = (deps: ModuleDeps) =>
  defineCapability({
    id: "purchasing.createVendor",
    title: "Create vendor",
    intent: "Register a supplier so bills can be recorded against them",
    module: "purchasing",
    risk: "write",
    permission: "purchasing.write",
    input: z.object({ name: z.string().min(1), email: z.string().email().optional() }),
    output: z.object({ vendorId: z.string() }),
    execute: async (ctx, input) => {
      const [row] = await deps.db
        .insert(vendors)
        .values({ orgId: ctx.actor.orgId, name: input.name, email: input.email ?? null })
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
      buildInput: (_input, output) => ({ entryId: (output as { entryId?: string }).entryId ?? "" }),
    },
    input: z.object({
      vendorId: z.string(),
      vendorRef: z.string().optional(),
      memo: z.string().optional(),
      lines: z.array(billLineSchema).min(1),
    }),
    output: z.object({ billNumber: z.number(), totalMinor: z.number(), entryId: z.string() }),
    execute: async (ctx, input) => {
      return deps.db.transaction(async (tx) => {
        await assertPeriodOpen(tx, ctx.actor.orgId, ctx.now);
        const [vendor] = await tx
          .select({ id: vendors.id })
          .from(vendors)
          .where(and(eq(vendors.id, input.vendorId), eq(vendors.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!vendor) throw new Error("vendor not found");

        const totals = computeInvoiceTotals(
          input.lines.map((l) => ({ quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, taxMinor: 0 })),
        );

        const [numRow] = await tx
          .select({ maxNum: sql<number>`coalesce(max(${vendorBills.number}), 0)` })
          .from(vendorBills)
          .where(eq(vendorBills.orgId, ctx.actor.orgId));
        const billNumber = Number(numRow?.maxNum ?? 0) + 1;

        const map = await coaMap(tx, ctx.actor.orgId);
        const glLines = [
          ...input.lines.map((l) => ({
            accountCode: l.expenseAccountCode,
            debitMinor: Math.round((l.quantity * l.unitPriceMinor) / 1000),
            creditMinor: 0,
          })),
          { accountCode: "2000", debitMinor: 0, creditMinor: totals.totalMinor },
        ].filter((l) => l.debitMinor !== 0 || l.creditMinor !== 0);
        assertBalanced({ memo: `Vendor bill ${billNumber}`, lines: glLines });

        const [entry] = await tx
          .insert(journalEntries)
          .values({
            orgId: ctx.actor.orgId,
            memo: `Vendor bill ${billNumber}${input.vendorRef ? ` (${input.vendorRef})` : ""}`,
            sourceType: "vendor_bill",
            postedByActorType: ctx.actor.type,
            postedByActorId: ctx.actor.id,
          })
          .returning({ id: journalEntries.id });
        await tx.insert(journalLines).values(
          glLines.map((l) => ({
            entryId: entry!.id,
            accountId: accountIdOf(map, l.accountCode),
            debitMinor: l.debitMinor,
            creditMinor: l.creditMinor,
          })),
        );

        const [bill] = await tx
          .insert(vendorBills)
          .values({
            orgId: ctx.actor.orgId,
            vendorId: input.vendorId,
            number: billNumber,
            vendorRef: input.vendorRef ?? null,
            status: "open",
            totalMinor: totals.totalMinor,
            memo: input.memo ?? null,
            entryId: entry!.id,
            billDate: ctx.now,
          })
          .returning({ id: vendorBills.id });

        await tx.insert(vendorBillLines).values(
          input.lines.map((l) => ({
            billId: bill!.id,
            description: l.description,
            quantity: l.quantity,
            unitPriceMinor: l.unitPriceMinor,
            expenseAccountCode: l.expenseAccountCode,
          })),
        );

        return { billNumber, totalMinor: totals.totalMinor, entryId: entry!.id };
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
    inverse: {
      capabilityId: "accounting.reverseEntry",
      buildInput: (_input, output) => ({ entryId: (output as { entryId: string }).entryId }),
    },
    input: z.object({
      billNumber: z.number().int().positive(),
      amountMinor: z.number().int().positive(),
      method: z.enum(["cash", "bank_transfer", "card"]).default("bank_transfer"),
    }),
    output: z.object({ paymentId: z.string(), entryId: z.string(), fullyPaid: z.boolean() }),
    execute: async (ctx, input) => {
      return deps.db.transaction(async (tx) => {
        await assertPeriodOpen(tx, ctx.actor.orgId, ctx.now);
        const [bill] = await tx
          .select()
          .from(vendorBills)
          .where(and(eq(vendorBills.orgId, ctx.actor.orgId), eq(vendorBills.number, input.billNumber)))
          .limit(1);
        if (!bill) throw new Error("bill not found");
        if (bill.status === "void") throw new Error("bill is void");
        if (bill.paidMinor + input.amountMinor > bill.totalMinor) {
          throw new Error(`overpayment: outstanding is ${bill.totalMinor - bill.paidMinor}`);
        }

        const map = await coaMap(tx, ctx.actor.orgId);
        const glLines = [
          { accountCode: "2000", debitMinor: input.amountMinor, creditMinor: 0 },
          { accountCode: "1000", debitMinor: 0, creditMinor: input.amountMinor },
        ];
        assertBalanced({ memo: `Vendor payment ${bill.number}`, lines: glLines });
        const [entry] = await tx
          .insert(journalEntries)
          .values({
            orgId: ctx.actor.orgId,
            memo: `Vendor payment for bill ${bill.number} (${input.method})`,
            sourceType: "vendor_payment",
            postedByActorType: ctx.actor.type,
            postedByActorId: ctx.actor.id,
          })
          .returning({ id: journalEntries.id });
        await tx.insert(journalLines).values(
          glLines.map((l) => ({
            entryId: entry!.id,
            accountId: accountIdOf(map, l.accountCode),
            debitMinor: l.debitMinor,
            creditMinor: l.creditMinor,
          })),
        );

        const [pay] = await tx
          .insert(vendorPayments)
          .values({
            orgId: ctx.actor.orgId,
            billId: bill.id,
            amountMinor: input.amountMinor,
            method: input.method,
            entryId: entry!.id,
          })
          .returning({ id: vendorPayments.id });

        const paidMinor = bill.paidMinor + input.amountMinor;
        await tx
          .update(vendorBills)
          .set({ paidMinor, status: paidMinor >= bill.totalMinor ? "paid" : bill.status })
          .where(eq(vendorBills.id, bill.id));

        return { paymentId: pay!.id, entryId: entry!.id, fullyPaid: paidMinor >= bill.totalMinor };
      });
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

export function registerPurchasingCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(createVendor(deps));
  registry.register(createBill(deps));
  registry.register(payBill(deps));
  registry.register(apAging(deps));
}
