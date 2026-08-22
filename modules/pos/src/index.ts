import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  customers,
  invoices,
  items,
  journalEntries,
  journalLines,
  payments,
  periods,
  posSessions,
  stockMovements,
} from "@chaste/db";
import { assertBalanced } from "@chaste/erp-core";
import type { Database } from "@chaste/db";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";

export interface ModuleDeps {
  db: Database["db"];
}

type Tx = Parameters<Parameters<ModuleDeps["db"]["transaction"]>[0]>[0];

async function assertPeriodOpen(db: Tx | ModuleDeps["db"], orgId: string, date: Date): Promise<void> {
  const closed = await db.select({ year: periods.year, month: periods.month }).from(periods).where(eq(periods.orgId, orgId));
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  if (closed.some((p) => p.year === y && p.month === m)) {
    throw new Error(`period ${y}-${String(m).padStart(2, "0")} is closed`);
  }
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

const WALK_IN = "Walk-in Customer";

async function walkInCustomerId(tx: Tx, orgId: string): Promise<string> {
  const [existing] = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.orgId, orgId), eq(customers.name, WALK_IN)))
    .limit(1);
  if (existing) return existing.id;
  const [created] = await tx.insert(customers).values({ orgId, name: WALK_IN }).returning({ id: customers.id });
  return created!.id;
}

const openSession = (deps: ModuleDeps) =>
  defineCapability({
    id: "pos.openSession",
    title: "Open register session",
    intent: "Open a point-of-sale cash drawer session with an opening float before taking sales",
    module: "pos",
    risk: "write",
    permission: "pos.write",
    input: z.object({
      register: z.string().default("main"),
      openingFloatMinor: z.number().int().nonnegative().default(0),
    }),
    output: z.object({ sessionId: z.string() }),
    execute: async (ctx, input) => {
      const [open] = await deps.db
        .select({ id: posSessions.id })
        .from(posSessions)
        .where(and(eq(posSessions.orgId, ctx.actor.orgId), eq(posSessions.status, "open")))
        .limit(1);
      if (open) throw new Error("a register session is already open — close it first");
      const [row] = await deps.db
        .insert(posSessions)
        .values({
          orgId: ctx.actor.orgId,
          register: input.register,
          openingFloatMinor: input.openingFloatMinor,
          openedByUserId: ctx.actor.type === "human" ? ctx.actor.id : null,
        })
        .returning({ id: posSessions.id });
      return { sessionId: row!.id };
    },
  });

const saleLineSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().int().positive().describe("thousandths of a unit; 1000 = one unit"),
  unitPriceMinor: z.number().int().nonnegative(),
  taxMinor: z.number().int().nonnegative().default(0),
  sku: z.string().optional().describe("stocked item to decrement; omit for services"),
});

/**
 * Instant retail sale: invoice + payment in one atomic posting.
 * DR Cash (total), CR Revenue (subtotal), CR Tax Payable.
 * Cash sales increment the drawer's expected cash for reconciliation.
 */
const completeSale = (deps: ModuleDeps) =>
  defineCapability({
    id: "pos.completeSale",
    title: "Complete POS sale",
    intent:
      "Ring up a paid sale on the register: creates the invoice and records the payment instantly. Cash sales count toward the drawer",
    module: "pos",
    risk: "money",
    permission: "pos.sell",
    moneyThresholdMinor: 100_000,
    inverse: {
      capabilityId: "accounting.reverseEntry",
      buildInput: (_input, output) => ({ entryId: (output as { entryId: string }).entryId }),
    },
    input: z.object({
      sessionId: z.string(),
      lines: z.array(saleLineSchema).min(1),
      method: z.enum(["cash", "card"]).default("cash"),
    }),
    output: z.object({
      invoiceNumber: z.number(),
      totalMinor: z.number(),
      changeGivenMinor: z.number(),
    }),
    execute: async (ctx, input) => {
      return deps.db.transaction(async (tx) => {
        await assertPeriodOpen(tx, ctx.actor.orgId, ctx.now);
        const [session] = await tx
          .select()
          .from(posSessions)
          .where(and(eq(posSessions.id, input.sessionId), eq(posSessions.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!session) throw new Error("session not found");
        if (session.status !== "open") throw new Error("session is closed");

        // Resolve stocked lines first so oversell fails before any posting.
        const stockLines: { itemId: string; sku: string; quantity: number }[] = [];
        for (const l of input.lines) {
          if (!l.sku) continue;
          const [item] = await tx
            .select()
            .from(items)
            .where(and(eq(items.orgId, ctx.actor.orgId), eq(items.sku, l.sku)))
            .limit(1);
          if (!item) throw new Error(`no stocked item with SKU ${l.sku}`);
          const [mov] = await tx
            .select({ total: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)` })
            .from(stockMovements)
            .where(and(eq(stockMovements.orgId, ctx.actor.orgId), eq(stockMovements.itemId, item.id)));
          if (Number(mov?.total ?? 0) < l.quantity) {
            throw new Error(`insufficient stock for ${l.sku}: ${Number(mov?.total ?? 0)} thousandths on hand`);
          }
          stockLines.push({ itemId: item.id, sku: l.sku, quantity: l.quantity });
        }

        let subtotal = 0;
        let tax = 0;
        for (const l of input.lines) {
          subtotal += Math.round((l.quantity * l.unitPriceMinor) / 1000);
          tax += l.taxMinor;
        }
        const total = subtotal + tax;
        if (total <= 0) throw new Error("sale must have a non-zero total");

        const customerId = await walkInCustomerId(tx, ctx.actor.orgId);
        const [numRow] = await tx
          .select({ maxNum: sql<number>`coalesce(max(${invoices.number}), 0)` })
          .from(invoices)
          .where(eq(invoices.orgId, ctx.actor.orgId));
        const invoiceNumber = Number(numRow?.maxNum ?? 0) + 1;

        const map = await coaMap(tx, ctx.actor.orgId);
        const glLines = [
          { accountCode: "1000", debitMinor: total, creditMinor: 0 },
          { accountCode: "4000", debitMinor: 0, creditMinor: subtotal },
          ...(tax > 0 ? [{ accountCode: "2100", debitMinor: 0, creditMinor: tax }] : []),
        ];
        assertBalanced({ memo: `POS sale #${invoiceNumber}`, lines: glLines });

        const [entry] = await tx
          .insert(journalEntries)
          .values({
            orgId: ctx.actor.orgId,
            memo: `POS sale #${invoiceNumber} (${input.method})`,
            sourceType: "pos_sale",
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

        const [inv] = await tx
          .insert(invoices)
          .values({
            orgId: ctx.actor.orgId,
            customerId,
            number: invoiceNumber,
            status: "paid",
            subtotalMinor: subtotal,
            taxMinor: tax,
            totalMinor: total,
            paidMinor: total,
            posSessionId: session.id,
            issuedAt: ctx.now,
            memo: `POS (${input.method})`,
          })
          .returning({ id: invoices.id });

        await tx.insert(payments).values({
          orgId: ctx.actor.orgId,
          invoiceId: inv!.id,
          amountMinor: total,
          method: input.method === "card" ? "card" : "cash",
          entryId: entry!.id,
        });

        // Stock leaves the ledger in the same transaction as the money.
        for (const sl of stockLines) {
          await tx.insert(stockMovements).values({
            orgId: ctx.actor.orgId,
            itemId: sl.itemId,
            quantityDelta: -sl.quantity,
            reason: "sale",
            refType: "invoice",
            refId: inv!.id,
            note: `POS sale #${invoiceNumber}`,
            actorType: ctx.actor.type,
            actorId: ctx.actor.id,
          });
        }

        // Card sales never touch the drawer; cash sales do.
        if (input.method === "cash") {
          await tx
            .update(posSessions)
            .set({
              expectedCashMinor: sql`${posSessions.expectedCashMinor} + ${total}`,
            })
            .where(eq(posSessions.id, session.id));
        }

        return { invoiceNumber, totalMinor: total, changeGivenMinor: 0 };
      });
    },
  });

/**
 * Closing counts the drawer. A variance is recorded honestly — it can never be
 * silently adjusted away; investigate or reverse.
 */
const closeSession = (deps: ModuleDeps) =>
  defineCapability({
    id: "pos.closeSession",
    title: "Close register session",
    intent:
      "Count the cash drawer and close the session; reports any variance between counted and expected cash",
    module: "pos",
    risk: "write",
    permission: "pos.write",
    input: z.object({ sessionId: z.string(), countedCashMinor: z.number().int().nonnegative() }),
    output: z.object({
      expectedCashMinor: z.number(),
      varianceMinor: z.number(),
      flagged: z.boolean(),
    }),
    execute: async (ctx, input) => {
      return deps.db.transaction(async (tx) => {
        const [session] = await tx
          .select()
          .from(posSessions)
          .where(and(eq(posSessions.id, input.sessionId), eq(posSessions.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!session) throw new Error("session not found");
        if (session.status !== "open") throw new Error("session already closed");

        const expected = session.openingFloatMinor + (session.expectedCashMinor ?? 0);
        const variance = input.countedCashMinor - expected;

        await tx
          .update(posSessions)
          .set({
            status: "closed",
            countedCashMinor: input.countedCashMinor,
            expectedCashMinor: expected,
            varianceMinor: variance,
            closedByUserId: ctx.actor.type === "human" ? ctx.actor.id : null,
            closedAt: ctx.now,
          })
          .where(eq(posSessions.id, session.id));

        return { expectedCashMinor: expected, varianceMinor: variance, flagged: variance !== 0 };
      });
    },
  });

export function registerPosCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(openSession(deps));
  registry.register(completeSale(deps));
  registry.register(closeSession(deps));
}
