import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  customers,
  invoices,
  items,
  payments,
  posSessions,
  stockMovements,
  stockReservations,
  journalEntries,
  journalLines,
} from "@chaste/db";
import { nextDocNumber } from "@chaste/db";
import { withOrgContext } from "@chaste/db";
import type { Database } from "@chaste/db";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";
import { postEntry } from "@chaste/module-accounting/posting";
import { applyStockDelta, lockStockItems } from "@chaste/module-inventory";

export interface ModuleDeps {
  db: Database["db"];
}


type Tx = Parameters<Parameters<ModuleDeps["db"]["transaction"]>[0]>[0];

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
      // "One open register per org" is a check-then-insert invariant; the
      // advisory lock serializes concurrent opens so two sessions cannot
      // both pass the check and double the drawer.
      return deps.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.actor.orgId}, 44))`);
        const [open] = await tx
          .select({ id: posSessions.id })
          .from(posSessions)
          .where(and(eq(posSessions.orgId, ctx.actor.orgId), eq(posSessions.status, "open")))
          .limit(1);
        if (open) throw new Error("a register session is already open, close it first");
        const [row] = await tx
          .insert(posSessions)
          .values({
            orgId: ctx.actor.orgId,
            register: input.register,
            openingFloatMinor: input.openingFloatMinor,
            openedByUserId: ctx.actor.type === "human" ? ctx.actor.id : null,
          })
          .returning({ id: posSessions.id });
        return { sessionId: row!.id };
      });
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
    // Same total computation as execute(): quantity is thousandths of a unit.
    moneyAmount: (input) =>
      input.lines.reduce(
        (sum, l) => sum + Math.round((l.quantity * l.unitPriceMinor) / 1000) + l.taxMinor,
        0,
      ),
    // N12 (ADR 0051): the undo of a register sale is a register return -
    // it restores stock, the drawer and the money together. buildInput is
    // typed against completeSale's output, so a key the sale never returns
    // is a compile error.
    inverse: {
      capabilityId: "pos.returnSale",
      buildInput: (_input, output) => ({
        invoiceId: output.invoiceId,
        reason: `undo of POS sale #${output.invoiceNumber}`,
      }),
    },
    input: z.object({
      sessionId: z.string(),
      lines: z.array(saleLineSchema).min(1),
      method: z.enum(["cash", "card"]).default("cash"),
    }),
    output: z.object({
      invoiceId: z.string(),
      invoiceNumber: z.number(),
      totalMinor: z.number(),
      changeGivenMinor: z.number(),
    }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [session] = await tx
          .select()
          .from(posSessions)
          .where(and(eq(posSessions.id, input.sessionId), eq(posSessions.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!session) throw new Error("session not found");
        if (session.status !== "open") throw new Error("session is closed");

        // Graceful degradation (ADR 0035): with the inventory module disabled,
        // a sale is a pure money event - no item resolution, no oversell
        // checks, no ledger legs. No gate configured behaves as enabled.
        const gate = ctx.services.moduleGate as
          | { isEnabled(orgId: string, moduleId: string): boolean | Promise<boolean> }
          | undefined;
        const inventoryEnabled = gate
          ? await gate.isEnabled(ctx.actor.orgId, "inventory")
          : true;

        // Resolve stocked lines first so oversell fails before any posting.
        const stockLines: { itemId: string; sku: string; quantity: number }[] = [];
        if (inventoryEnabled) {
          // Resolve SKUs, then aggregate demand by item identity (N15):
          // repeated lines spend one running availability budget, not one
          // each. Item rows are locked in a stable order so a concurrent
          // sales-order confirm (or register) cannot claim the same stock.
          // Available means on hand minus open reservations - stock promised
          // to an order is not sellable at the register.
          const resolved: { itemId: string; sku: string; quantity: number }[] = [];
          for (const l of input.lines) {
            if (!l.sku) continue;
            const [item] = await tx
              .select()
              .from(items)
              .where(and(eq(items.orgId, ctx.actor.orgId), eq(items.sku, l.sku)))
              .limit(1);
            if (!item) throw new Error(`no stocked item with SKU ${l.sku}`);
            resolved.push({ itemId: item.id, sku: l.sku, quantity: l.quantity });
          }
          const itemIds = [...new Set(resolved.map((r) => r.itemId))].sort();
          if (itemIds.length > 0) {
            await tx
              .select({ id: items.id })
              .from(items)
              .where(and(eq(items.orgId, ctx.actor.orgId), inArray(items.id, itemIds)))
              .orderBy(items.id)
              .for("update");
          }
          const budget = new Map<string, number>();
          for (const id of itemIds) {
            const [mov] = await tx
              .select({ total: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)` })
              .from(stockMovements)
              .where(and(eq(stockMovements.orgId, ctx.actor.orgId), eq(stockMovements.itemId, id)));
            const [res] = await tx
              .select({ total: sql<number>`coalesce(sum(${stockReservations.quantityThousandths}), 0)` })
              .from(stockReservations)
              .where(
                and(
                  eq(stockReservations.orgId, ctx.actor.orgId),
                  eq(stockReservations.itemId, id),
                  eq(stockReservations.status, "open"),
                ),
              );
            budget.set(id, Number(mov?.total ?? 0) - Number(res?.total ?? 0));
          }
          for (const r of resolved) {
            const available = budget.get(r.itemId) ?? 0;
            if (available < r.quantity) {
              throw new Error(
                `insufficient stock for ${r.sku}: ${available} thousandths available (on hand minus open reservations)`,
              );
            }
            budget.set(r.itemId, available - r.quantity);
            stockLines.push(r);
          }
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
        const invoiceNumber = await nextDocNumber(tx, ctx.actor.orgId, "invoice");

        const glLines = [
          { accountCode: "1000", debitMinor: total, creditMinor: 0 },
          { accountCode: "4000", debitMinor: 0, creditMinor: subtotal },
          ...(tax > 0 ? [{ accountCode: "2100", debitMinor: 0, creditMinor: tax }] : []),
        ];

        // The invoice row exists before posting so the entry carries its
        // source link at insert time - posted journal rows are immutable
        // (N09), so there is no post-hoc patch of the GL header.
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

        const entryId = await postEntry(tx, ctx.actor.orgId, ctx.actor, {
          memo: `POS sale #${invoiceNumber} (${input.method})`,
          sourceType: "pos_sale",
          sourceId: inv!.id,
          postedAt: ctx.now,
          lines: glLines,
        });

        await tx.insert(payments).values({
          orgId: ctx.actor.orgId,
          invoiceId: inv!.id,
          amountMinor: total,
          method: input.method === "card" ? "card" : "cash",
          entryId,
        });

        // Stock leaves the ledger in the same transaction as the money -
        // only when the inventory module is enabled (ADR 0035). N22: through
        // the shared command service, so the ledger guards hold here too.
        for (const sl of inventoryEnabled ? stockLines : []) {
          await applyStockDelta(tx, {
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

        return { invoiceId: inv!.id, invoiceNumber, totalMinor: total, changeGivenMinor: 0 };
      });
    },
  });

/**
 * Closing counts the drawer. A variance is recorded honestly, it can never be
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
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
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


// ── M13: returns + shift summaries ─────────────────────────────────────

const returnSale = (deps: ModuleDeps) =>
  defineCapability({
    id: "pos.returnSale",
    title: "Return POS sale",
    intent:
      "Take goods back at the register: refund the customer through a balanced reversing entry, credit the sale invoice, and put the stock back on the shelf - the original sale is never edited",
    // Always gates: the refunded amount lives in the sale, not the input.
    module: "pos",
    risk: "money",
    permission: "pos.sell",
    moneyAmount: () => null,
    input: z.object({
      invoiceId: z.string().uuid(),
      reason: z.string().min(3).max(500),
    }),
    output: z.object({ refundEntryId: z.string(), creditedMinor: z.number(), restockedLines: z.number() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [inv] = await tx
          .select()
          .from(invoices)
          .where(and(eq(invoices.id, input.invoiceId), eq(invoices.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!inv) throw new Error("sale not found");
        if (inv.status === "void") throw new Error("sale is void");
        // POS sales are paid at the register, so the refundable amount is
        // total minus what has already been returned - paid is refundable.
        const refundable = inv.totalMinor - inv.creditedMinor;
        if (refundable <= 0) throw new Error(`sale has nothing left to return (total ${inv.totalMinor} − credited ${inv.creditedMinor})`);
        const refund = refundable;
        const [origEntry] = await tx
          .select({ id: journalEntries.id })
          .from(journalEntries)
          .where(and(eq(journalEntries.orgId, ctx.actor.orgId), eq(journalEntries.sourceType, "pos_sale"), eq(journalEntries.sourceId, inv.id)))
          .limit(1);
        if (!origEntry) throw new Error("sale entry not found; cannot mirror a return");
        // Mirror the original sale entry exactly (reverseEntry mechanics):
        // every line swaps sides. Full returns only - partial credits go
        // through accounting.creditNote.
        const origLines = await tx
          .select({ accountId: journalLines.accountId, debitMinor: journalLines.debitMinor, creditMinor: journalLines.creditMinor })
          .from(journalLines)
          .where(eq(journalLines.entryId, origEntry.id));
        const mirrorLines = origLines.map((l) => ({
          accountId: l.accountId,
          debitMinor: l.creditMinor,
          creditMinor: l.debitMinor,
        }));
        const refundEntryId = await postEntry(tx, ctx.actor.orgId, ctx.actor, {
          memo: `POS return on sale ${inv.number}: ${input.reason}`,
          sourceType: "pos_return",
          sourceId: inv.id,
          reversalOfId: origEntry?.id ?? null,
          postedAt: ctx.now,
          lines: mirrorLines,
        });
        await tx.update(invoices).set({ creditedMinor: inv.creditedMinor + refund }).where(eq(invoices.id, inv.id));

        // N12 (ADR 0051): a cash refund physically leaves the drawer, so the
        // session's expected cash drops with it - otherwise closeSession
        // would flag an "overage" that is really money already handed back.
        // A closed session's count is frozen history; its variance was
        // recorded when it closed and is not rewritten by later returns.
        const [salePayment] = await tx
          .select({ method: payments.method })
          .from(payments)
          .innerJoin(journalEntries, eq(journalEntries.id, payments.entryId))
          .where(and(eq(payments.orgId, ctx.actor.orgId), eq(payments.invoiceId, inv.id)))
          .limit(1);
        if (salePayment?.method === "cash" && inv.posSessionId) {
          const [session] = await tx
            .select({ id: posSessions.id, status: posSessions.status })
            .from(posSessions)
            .where(and(eq(posSessions.id, inv.posSessionId), eq(posSessions.orgId, ctx.actor.orgId)))
            .limit(1);
          if (session && session.status === "open") {
            await tx
              .update(posSessions)
              .set({ expectedCashMinor: sql`${posSessions.expectedCashMinor} - ${refund}` })
              .where(eq(posSessions.id, session.id));
          }
        }

        // Stock back: the sale took items out with negative legs referencing
        // the invoice; the return mirrors each one positively.
        const saleLegs = await tx
          .select({ itemId: stockMovements.itemId, quantityDelta: stockMovements.quantityDelta, unitCostMinor: stockMovements.unitCostMinor })
          .from(stockMovements)
          .where(and(eq(stockMovements.orgId, ctx.actor.orgId), eq(stockMovements.refType, "invoice"), eq(stockMovements.refId, inv.id)));
        let restockedLines = 0;
        await lockStockItems(
          tx,
          saleLegs.filter((l) => l.quantityDelta < 0).map((l) => l.itemId),
        );
        for (const leg of saleLegs) {
          if (leg.quantityDelta >= 0) continue;
          await applyStockDelta(tx, {
            orgId: ctx.actor.orgId,
            itemId: leg.itemId,
            quantityDelta: -leg.quantityDelta,
            reason: "sale",
            refType: "pos_return",
            refId: inv.id,
            unitCostMinor: leg.unitCostMinor ?? undefined,
            note: `POS return on sale ${inv.number}: ${input.reason}`,
            actorType: ctx.actor.type,
            actorId: ctx.actor.id,
          });
          restockedLines += 1;
        }
        return { refundEntryId, creditedMinor: inv.creditedMinor + refund, restockedLines };
      });
    },
  });

const shiftSummary = (deps: ModuleDeps) =>
  defineCapability({
    id: "pos.shiftSummary",
    title: "Shift summary",
    intent:
      "Summarize a register session - sales count, takings, expected versus counted cash, and variance - so closing a shift is a check, not a guess",
    module: "pos",
    risk: "read",
    permission: "pos.read",
    input: z.object({ sessionId: z.string().uuid() }),
    output: z.object({
      register: z.string(),
      status: z.string(),
      salesCount: z.number(),
      takingsMinor: z.number(),
      expectedCashMinor: z.number(),
      countedCashMinor: z.number().nullable(),
      varianceMinor: z.number().nullable(),
    }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [session] = await tx
          .select()
          .from(posSessions)
          .where(and(eq(posSessions.id, input.sessionId), eq(posSessions.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!session) throw new Error("session not found");
        const [agg] = await tx
          .select({ count: sql<number>`count(*)`, takings: sql<number>`coalesce(sum(${invoices.totalMinor}), 0)` })
          .from(invoices)
          .where(and(eq(invoices.orgId, ctx.actor.orgId), eq(invoices.posSessionId, session.id)));
        return {
          register: session.register,
          status: session.status,
          salesCount: Number(agg?.count ?? 0),
          takingsMinor: Number(agg?.takings ?? 0),
          expectedCashMinor: session.expectedCashMinor,
          countedCashMinor: session.countedCashMinor,
          varianceMinor: session.varianceMinor,
        };
      });
    },
  });

export function registerPosCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(openSession(deps));
  registry.register(completeSale(deps));
  registry.register(closeSession(deps));
  registry.register(returnSale(deps));
  registry.register(shiftSummary(deps));
}
