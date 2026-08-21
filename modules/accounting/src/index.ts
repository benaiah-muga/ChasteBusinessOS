import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  customers,
  invoiceLines,
  invoices,
  journalEntries,
  journalLines,
  payments,
  periods,
} from "@chaste/db";
import {
  buildInvoiceEntryLines,
  buildPaymentEntryLines,
  computeAging,
  computeBalanceSheet,
  computeIncomeStatement,
  computeInvoiceTotals,
  assertBalanced,
  isPeriodOpen,
  type AccountBalance,
} from "@chaste/erp-core";
import type { Database } from "@chaste/db";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";

export interface ModuleDeps {
  db: Database["db"];
}

const lineSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().int().positive().describe("thousandths of a unit; 1000 = one unit"),
  unitPriceMinor: z.number().int().nonnegative(),
  taxMinor: z.number().int().nonnegative().default(0),
});

function accountIdOf(map: Map<string, string>, code: string): string {
  const id = map.get(code);
  if (!id) throw new Error(`account ${code} missing from chart of accounts`);
  return id;
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
    inverse: {
      capabilityId: "accounting.reverseEntry",
      buildInput: (_input, output) => ({ entryId: (output as { entryId?: string }).entryId ?? "" }),
    },
    input: z.object({
      customerId: z.string(),
      memo: z.string().optional(),
      lines: z.array(lineSchema).min(1),
    }),
    output: z.object({
      invoiceId: z.string(),
      invoiceNumber: z.number(),
      totalMinor: z.number(),
      entryId: z.string(),
    }),
    execute: async (ctx, input) => {
      return deps.db.transaction(async (tx) => {
        await assertPeriodOpen(tx, ctx.actor.orgId, ctx.now);
        const cust = await tx
          .select({ id: customers.id })
          .from(customers)
          .where(and(eq(customers.id, input.customerId), eq(customers.orgId, ctx.actor.orgId)))
          .limit(1);
        if (cust.length === 0) throw new Error("customer not found");

        const totals = computeInvoiceTotals(input.lines);
        const [numRow] = await tx
          .select({ maxNum: sql<number>`coalesce(max(${invoices.number}), 0)` })
          .from(invoices)
          .where(eq(invoices.orgId, ctx.actor.orgId));
        const number = Number(numRow?.maxNum ?? 0) + 1;

        const [inv] = await tx
          .insert(invoices)
          .values({
            orgId: ctx.actor.orgId,
            customerId: input.customerId,
            number,
            status: "sent",
            currency: "USD",
            subtotalMinor: totals.subtotalMinor,
            taxMinor: totals.taxMinor,
            totalMinor: totals.totalMinor,
            memo: input.memo ?? null,
            issuedAt: ctx.now,
          })
          .returning({ id: invoices.id });

        await tx.insert(invoiceLines).values(
          input.lines.map((l) => ({
            invoiceId: inv!.id,
            description: l.description,
            quantity: l.quantity,
            unitPriceMinor: l.unitPriceMinor,
            taxMinor: l.taxMinor,
          })),
        );

        const map = await coaMap(tx, ctx.actor.orgId);
        const lines = buildInvoiceEntryLines(
          { ar: "1100", revenue: "4000", taxPayable: "2100" },
          { totals },
        );
        assertBalanced({ memo: `Invoice ${number}`, lines });
        const [entry] = await tx
          .insert(journalEntries)
          .values({
            orgId: ctx.actor.orgId,
            memo: `Invoice ${number}`,
            sourceType: "invoice",
            sourceId: inv!.id,
            postedByActorType: ctx.actor.type,
            postedByActorId: ctx.actor.id,
          })
          .returning({ id: journalEntries.id });
        await tx.insert(journalLines).values(
          lines.map((l) => ({
            entryId: entry!.id,
            accountId: accountIdOf(map, l.accountCode),
            debitMinor: l.debitMinor,
            creditMinor: l.creditMinor,
          })),
        );

        return {
          invoiceId: inv!.id,
          invoiceNumber: number,
          totalMinor: totals.totalMinor,
          entryId: entry!.id,
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
    inverse: {
      capabilityId: "accounting.reverseEntry",
      buildInput: (_input, output) => ({ entryId: (output as { entryId: string }).entryId }),
    },
    input: z.object({
      invoiceNumber: z.number().int().positive(),
      amountMinor: z.number().int().positive().describe("amount received in minor units"),
      method: z.enum(["cash", "bank_transfer", "card"]).default("bank_transfer"),
    }),
    output: z.object({ paymentId: z.string(), entryId: z.string(), fullyPaid: z.boolean() }),
    execute: async (ctx, input) => {
      return deps.db.transaction(async (tx) => {
        await assertPeriodOpen(tx, ctx.actor.orgId, ctx.now);
        const [inv] = await tx
          .select()
          .from(invoices)
          .where(and(eq(invoices.orgId, ctx.actor.orgId), eq(invoices.number, input.invoiceNumber)))
          .limit(1);
        if (!inv) throw new Error("invoice not found");
        if (inv.status === "void") throw new Error("invoice is void");
        if (inv.paidMinor + input.amountMinor > inv.totalMinor) {
          throw new Error(`overpayment: outstanding is ${inv.totalMinor - inv.paidMinor}`);
        }

        const map = await coaMap(tx, ctx.actor.orgId);
        const lines = buildPaymentEntryLines({ cash: "1000", ar: "1100" }, input.amountMinor);
        assertBalanced({ memo: `Payment for invoice ${inv.number}`, lines });
        const [entry] = await tx
          .insert(journalEntries)
          .values({
            orgId: ctx.actor.orgId,
            memo: `Payment for invoice ${inv.number} (${input.method})`,
            sourceType: "payment",
            sourceId: null,
            postedByActorType: ctx.actor.type,
            postedByActorId: ctx.actor.id,
          })
          .returning({ id: journalEntries.id });
        await tx.insert(journalLines).values(
          lines.map((l) => ({
            entryId: entry!.id,
            accountId: accountIdOf(map, l.accountCode),
            debitMinor: l.debitMinor,
            creditMinor: l.creditMinor,
          })),
        );

        const [pay] = await tx
          .insert(payments)
          .values({
            orgId: ctx.actor.orgId,
            invoiceId: inv.id,
            amountMinor: input.amountMinor,
            method: input.method,
            entryId: entry!.id,
          })
          .returning({ id: payments.id });

        const paidMinor = inv.paidMinor + input.amountMinor;
        await tx
          .update(invoices)
          .set({ paidMinor, status: paidMinor >= inv.totalMinor ? "paid" : inv.status })
          .where(eq(invoices.id, inv.id));

        return { paymentId: pay!.id, entryId: entry!.id, fullyPaid: paidMinor >= inv.totalMinor };
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
    input: z.object({ entryId: z.string() }),
    output: z.object({ reversalEntryId: z.string() }),
    execute: async (ctx, input) => {
      return deps.db.transaction(async (tx) => {
        await assertPeriodOpen(tx, ctx.actor.orgId, ctx.now);
        const [orig] = await tx
          .select()
          .from(journalEntries)
          .where(and(eq(journalEntries.id, input.entryId), eq(journalEntries.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!orig) throw new Error("entry not found");
        if (orig.sourceType === "reversal") throw new Error("cannot reverse a reversal");

        const origLines = await tx
          .select({ accountId: journalLines.accountId, debitMinor: journalLines.debitMinor, creditMinor: journalLines.creditMinor })
          .from(journalLines)
          .where(eq(journalLines.entryId, orig.id));

        const [rev] = await tx
          .insert(journalEntries)
          .values({
            orgId: ctx.actor.orgId,
            memo: `Reversal of: ${orig.memo}`,
            sourceType: "reversal",
            sourceId: null,
            reversalOfId: orig.id,
            postedByActorType: ctx.actor.type,
            postedByActorId: ctx.actor.id,
          })
          .returning({ id: journalEntries.id });
        await tx.insert(journalLines).values(
          origLines.map((l) => ({
            entryId: rev!.id,
            accountId: l.accountId,
            debitMinor: l.creditMinor,
            creditMinor: l.debitMinor,
          })),
        );
        return { reversalEntryId: rev!.id };
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

type Tx = Parameters<Parameters<ModuleDeps["db"]["transaction"]>[0]>[0];

/** Posting into a closed period is rejected — the books are sealed, not edited. */
async function assertPeriodOpen(db: Tx | ModuleDeps["db"], orgId: string, date: Date): Promise<void> {
  const closed = await db
    .select({ year: periods.year, month: periods.month })
    .from(periods)
    .where(eq(periods.orgId, orgId));
  if (!isPeriodOpen(closed, date)) {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    throw new Error(`period ${y}-${String(m).padStart(2, "0")} is closed; post to the current period or reopen it`);
  }
}

async function coaMap(tx: Tx | ModuleDeps["db"], orgId: string): Promise<Map<string, string>> {
  const rows = await tx.select({ code: accounts.code, id: accounts.id }).from(accounts).where(eq(accounts.orgId, orgId));
  return new Map(rows.map((r) => [r.code, r.id]));
}

async function accountBalances(deps: ModuleDeps, orgId: string): Promise<AccountBalance[]> {
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
    .where(and(eq(accounts.orgId, orgId), sql`${journalEntries.orgId} = ${orgId}`))
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
      const balances = await accountBalances(deps, ctx.actor.orgId);
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

const arAging = (deps: ModuleDeps) =>
  defineCapability({
    id: "accounting.arAging",
    title: "AR aging report",
    intent:
      "Show outstanding customer invoices bucketed by age (current, 30, 60, 90+ days) so collections can be prioritized",
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
          issuedAt: invoices.issuedAt,
        })
        .from(invoices)
        .where(and(eq(invoices.orgId, ctx.actor.orgId), gt(invoices.totalMinor, invoices.paidMinor)));
      const receivables = rows
        .filter((r) => r.issuedAt !== null)
        .map((r) => ({
          invoiceNumber: r.number,
          outstandingMinor: r.totalMinor - r.paidMinor,
          issuedAt: r.issuedAt as Date,
        }));
      const buckets = computeAging(receivables, ctx.now);
      const DAY = 86_400_000;
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
      await deps.db
        .insert(periods)
        .values({ orgId: ctx.actor.orgId, year: input.year, month: input.month, closedByActorId: ctx.actor.id })
        .onConflictDoNothing();
      return { closed: true };
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
      await deps.db.delete(periods).where(
        and(eq(periods.orgId, ctx.actor.orgId), eq(periods.year, input.year), eq(periods.month, input.month)),
      );
      return { reopened: true };
    },
  });

export function registerAccountingCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(createInvoice(deps));
  registry.register(recordPayment(deps));
  registry.register(reverseEntry(deps));
  registry.register(trialBalance(deps));
  registry.register(arAging(deps));
  registry.register(closePeriod(deps));
  registry.register(reopenPeriod(deps));
  registry.register(incomeStatement(deps));
  registry.register(balanceSheet(deps));
}
