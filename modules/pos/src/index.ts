import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  customers,
  invoices,
  invoiceLines,
  items,
  payments,
  posReturnLines,
  posReturns,
  posSessions,
  stockMovements,
  stockReservations,
  journalEntries,
  journalLines,
} from "@chaste/db";
import { nextDocNumber } from "@chaste/db";
import { withOrgContext } from "@chaste/db";
import type { Database } from "@chaste/db";
import { computeInvoiceTotals, calculateCashTender } from "@chaste/erp-core";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";
import { baseCurrencyOf, postEntry } from "@chaste/module-accounting/posting";
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
    moneyAmount: (input) => computeInvoiceTotals(input.lines).totalMinor,
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
    input: z
      .object({
        sessionId: z.string(),
        lines: z.array(saleLineSchema).min(1),
        method: z.enum(["cash", "card"]).default("cash"),
        customerId: z.string().uuid().optional(),
        cashReceivedMinor: z.number().int().nonnegative().optional(),
        tenders: z.array(z.object({
          method: z.enum(["cash", "card", "mobile_money"]),
          amountMinor: z.number().int().positive(),
        })).min(1).max(3).optional(),
      })
      .superRefine((input, issue) => {
        const total = input.lines.reduce((sum, line) => sum + Math.round((line.quantity * line.unitPriceMinor) / 1000) + line.taxMinor, 0);
        if (input.tenders) {
          const allocated = input.tenders.reduce((sum, tender) => sum + tender.amountMinor, 0);
          const cashAllocated = input.tenders.filter((tender) => tender.method === "cash").reduce((sum, tender) => sum + tender.amountMinor, 0);
          if (allocated !== total) issue.addIssue({ code: "custom", message: "tender allocations must exactly cover the sale total", path: ["tenders"] });
          if (cashAllocated === 0 && input.cashReceivedMinor !== undefined) issue.addIssue({ code: "custom", message: "cash received only applies when cash is one of the tenders", path: ["cashReceivedMinor"] });
          if (cashAllocated > 0 && (input.cashReceivedMinor ?? cashAllocated) < cashAllocated) issue.addIssue({ code: "custom", message: "cash received cannot be less than its allocated amount", path: ["cashReceivedMinor"] });
        } else if (input.method !== "cash" && input.cashReceivedMinor !== undefined) {
          issue.addIssue({ code: "custom", message: "cash received only applies to cash sales", path: ["cashReceivedMinor"] });
        } else if (input.method === "cash" && (input.cashReceivedMinor ?? total) < total) {
          issue.addIssue({ code: "custom", message: "cash received must cover the sale total", path: ["cashReceivedMinor"] });
        }
      }),
    output: z.object({
      invoiceId: z.string(),
      invoiceNumber: z.number(),
      totalMinor: z.number(),
      tenderedMinor: z.number(),
      changeGivenMinor: z.number(),
      tenders: z.array(z.object({ method: z.string(), amountMinor: z.number() })),
    }),
    execute: async (ctx, input) => {
      let totals: ReturnType<typeof computeInvoiceTotals>;
      try {
        totals = computeInvoiceTotals(input.lines);
      } catch (error) {
        if (error instanceof Error && error.message === "invoice must have a non-zero total") {
          throw new Error("sale must have a non-zero total");
        }
        throw error;
      }
      const { subtotalMinor: subtotal, taxMinor: tax, totalMinor: total } = totals;
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
        const itemBySku = new Map<string, string>();
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
            itemBySku.set(l.sku, item.id);
            // Services sell without stock: they bypass the availability
            // budget and simply ride the invoice like any other line.
            if (item.kind === "service") continue;
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

        const appliedTenders = input.tenders ?? [{ method: input.method, amountMinor: total }];
        if (appliedTenders.some((payment) => !Number.isSafeInteger(payment.amountMinor) || payment.amountMinor <= 0)
          || appliedTenders.reduce((sum, payment) => sum + payment.amountMinor, 0) !== total) {
          throw new Error("tender allocations must exactly cover the sale total");
        }
        const paymentSummary = [...new Set(appliedTenders.map((payment) => payment.method))].join(" + ");
        const cashAllocatedMinor = appliedTenders.filter((tender) => tender.method === "cash").reduce((sum, tender) => sum + tender.amountMinor, 0);
        const cashReceivedMinor = cashAllocatedMinor > 0 ? (input.cashReceivedMinor ?? cashAllocatedMinor) : 0;
        if (cashAllocatedMinor > 0 && cashReceivedMinor < cashAllocatedMinor) throw new Error("cash received cannot be less than its allocated amount");
        const tender = {
          tenderedMinor: cashAllocatedMinor > 0 && appliedTenders.length === 1
            ? calculateCashTender(total, cashReceivedMinor).tenderedMinor
            : total,
          changeGivenMinor: Math.max(0, cashReceivedMinor - cashAllocatedMinor),
        };
        let customerId = input.customerId;
        if (customerId) {
          const [customer] = await tx
            .select({ id: customers.id })
            .from(customers)
            .where(and(eq(customers.id, customerId), eq(customers.orgId, ctx.actor.orgId), isNull(customers.deactivatedAt)))
            .limit(1);
          if (!customer) throw new Error("customer not found or inactive in this organization");
        } else {
          customerId = await walkInCustomerId(tx, ctx.actor.orgId);
        }
        const invoiceNumber = await nextDocNumber(tx, ctx.actor.orgId, "invoice");
        const currency = await baseCurrencyOf(tx, ctx.actor.orgId);

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
            currency,
            subtotalMinor: subtotal,
            taxMinor: tax,
            totalMinor: total,
            paidMinor: total,
            posSessionId: session.id,
            issuedAt: ctx.now,
            memo: `POS (${paymentSummary})`,
          })
          .returning({ id: invoices.id });

        await tx.insert(invoiceLines).values(input.lines.map((line) => ({
          invoiceId: inv!.id,
          itemId: line.sku ? itemBySku.get(line.sku) ?? null : null,
          description: line.description,
          quantity: line.quantity,
          unitPriceMinor: line.unitPriceMinor,
          taxMinor: line.taxMinor,
        })));

        const entryId = await postEntry(tx, ctx.actor.orgId, ctx.actor, {
          memo: `POS sale #${invoiceNumber} (${paymentSummary})`,
          sourceType: "pos_sale",
          sourceId: inv!.id,
          currency,
          postedAt: ctx.now,
          lines: glLines,
        });

        await tx.insert(payments).values(appliedTenders.map((payment) => ({
          orgId: ctx.actor.orgId,
          invoiceId: inv!.id,
          amountMinor: payment.amountMinor,
          method: payment.method,
          entryId,
        })));

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

        // Only the cash allocation enters the physical drawer. Card and mobile money
        // remain visible as separate payment rows for reconciliation.
        if (cashAllocatedMinor > 0) {
          await tx
            .update(posSessions)
            .set({
              expectedCashMinor: sql`${posSessions.expectedCashMinor} + ${cashAllocatedMinor}`,
            })
            .where(eq(posSessions.id, session.id));
        }

        return {
          invoiceId: inv!.id,
          invoiceNumber,
          totalMinor: total,
          tenderedMinor: tender.tenderedMinor,
          changeGivenMinor: tender.changeGivenMinor,
          tenders: appliedTenders,
        };
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
    input: z.object({
      sessionId: z.string(),
      countedCashMinor: z.number().int().nonnegative(),
      varianceReason: z.string().trim().min(3).max(500).optional(),
    }),
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
        if (variance !== 0 && !input.varianceReason) throw new Error("a reason is required to record a drawer variance");

        await tx
          .update(posSessions)
          .set({
            status: "closed",
            countedCashMinor: input.countedCashMinor,
            expectedCashMinor: expected,
            varianceMinor: variance,
            varianceReason: variance === 0 ? null : input.varianceReason,
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
      refundMethod: z.enum(["cash", "card", "mobile_money"]).default("cash"),
      lines: z.array(z.object({ invoiceLineId: z.string().uuid(), quantity: z.number().int().positive() })).min(1).optional(),
    }),
    output: z.object({ refundEntryId: z.string(), refundMinor: z.number(), creditedMinor: z.number(), restockedLines: z.number(), refundMethod: z.string() }),
    execute: async (ctx, input) => {
      const refundMethod = input.refundMethod ?? "cash";
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [inv] = await tx
          .select()
          .from(invoices)
          .where(and(eq(invoices.id, input.invoiceId), eq(invoices.orgId, ctx.actor.orgId)))
          .for("update")
          .limit(1);
        if (!inv) throw new Error("sale not found");
        if (inv.status === "void") throw new Error("sale is void");
        const refundable = inv.totalMinor - inv.creditedMinor;
        if (refundable <= 0) throw new Error(`sale has nothing left to return (total ${inv.totalMinor} - credited ${inv.creditedMinor})`);
        const [origEntry] = await tx
          .select({ id: journalEntries.id })
          .from(journalEntries)
          .where(and(eq(journalEntries.orgId, ctx.actor.orgId), eq(journalEntries.sourceType, "pos_sale"), eq(journalEntries.sourceId, inv.id)))
          .limit(1);
        if (!origEntry) throw new Error("sale entry not found; cannot mirror a return");
        const origLines = await tx
          .select({ accountId: journalLines.accountId, code: accounts.code, debitMinor: journalLines.debitMinor, creditMinor: journalLines.creditMinor })
          .from(journalLines)
          .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
          .where(eq(journalLines.entryId, origEntry.id));
        const invoiceLineRows = await tx
          .select({ id: invoiceLines.id, itemId: invoiceLines.itemId, quantity: invoiceLines.quantity, unitPriceMinor: invoiceLines.unitPriceMinor, taxMinor: invoiceLines.taxMinor })
          .from(invoiceLines)
          .where(eq(invoiceLines.invoiceId, inv.id));
        const invoiceLineIds = invoiceLineRows.map((line) => line.id);
        const priorReturnLines = invoiceLineIds.length
          ? await tx
              .select({ invoiceLineId: posReturnLines.invoiceLineId, quantity: posReturnLines.quantity })
              .from(posReturnLines)
              .where(and(eq(posReturnLines.orgId, ctx.actor.orgId), inArray(posReturnLines.invoiceLineId, invoiceLineIds)))
          : [];
        const priorReturns = await tx
          .select({ refundMinor: posReturns.refundMinor })
          .from(posReturns)
          .where(and(eq(posReturns.orgId, ctx.actor.orgId), eq(posReturns.invoiceId, inv.id)));
        const structuredCreditMinor = priorReturns.reduce((sum, row) => sum + row.refundMinor, 0);
        if (structuredCreditMinor > inv.creditedMinor) throw new Error("return history exceeds the invoice credit total; ask accounting to review the sale");
        if (structuredCreditMinor < inv.creditedMinor) throw new Error("this sale has an older credit that is not linked to returned items; ask accounting to review it before returning more items");

        const returnedByLine = new Map<string, number>();
        for (const row of priorReturnLines) returnedByLine.set(row.invoiceLineId, (returnedByLine.get(row.invoiceLineId) ?? 0) + row.quantity);
        const saleLegs = await tx
          .select({ itemId: stockMovements.itemId, quantityDelta: stockMovements.quantityDelta, unitCostMinor: stockMovements.unitCostMinor })
          .from(stockMovements)
          .where(and(eq(stockMovements.orgId, ctx.actor.orgId), eq(stockMovements.refType, "invoice"), eq(stockMovements.refId, inv.id)));
        const stockSoldByItem = new Map<string, number>();
        for (const leg of saleLegs) {
          if (leg.quantityDelta < 0) stockSoldByItem.set(leg.itemId, (stockSoldByItem.get(leg.itemId) ?? 0) - leg.quantityDelta);
        }
        const linkedStockItems = new Set(invoiceLineRows.map((line) => line.itemId).filter((id): id is string => id !== null));
        const hasUnlinkedLegacyStock = [...stockSoldByItem.keys()].some((itemId) => !linkedStockItems.has(itemId));
        if (input.lines && hasUnlinkedLegacyStock) throw new Error("this older sale does not link stock to individual lines; use its full return option");

        const requested = input.lines ?? invoiceLineRows
          .map((line) => ({ invoiceLineId: line.id, quantity: line.quantity - (returnedByLine.get(line.id) ?? 0) }))
          .filter((line) => line.quantity > 0);
        if (requested.length === 0) throw new Error("sale has no unreturned items");
        const seenLines = new Set<string>();
        const selectedLines: Array<{ id: string; itemId: string | null; quantity: number; unitPriceMinor: number; taxMinor: number; returnedQuantity: number; subtotalMinor: number; returnTaxMinor: number }> = [];
        for (const selection of requested) {
          if (seenLines.has(selection.invoiceLineId)) throw new Error("choose each sale line only once");
          seenLines.add(selection.invoiceLineId);
          const line = invoiceLineRows.find((row) => row.id === selection.invoiceLineId);
          if (!line) throw new Error("a selected item does not belong to this sale");
          const returnedQuantity = returnedByLine.get(line.id) ?? 0;
          const remainingQuantity = line.quantity - returnedQuantity;
          if (selection.quantity > remainingQuantity) throw new Error(`return quantity exceeds the ${remainingQuantity / 1000} remaining units for this item`);
          const cumulativeQuantity = returnedQuantity + selection.quantity;
          const subtotalMinor = Math.round((cumulativeQuantity * line.unitPriceMinor) / 1000) - Math.round((returnedQuantity * line.unitPriceMinor) / 1000);
          const returnTaxMinor = Math.round((line.taxMinor * cumulativeQuantity) / line.quantity) - Math.round((line.taxMinor * returnedQuantity) / line.quantity);
          selectedLines.push({ id: line.id, itemId: line.itemId, quantity: selection.quantity, unitPriceMinor: line.unitPriceMinor, taxMinor: line.taxMinor, returnedQuantity, subtotalMinor, returnTaxMinor });
        }
        const refund = selectedLines.reduce((sum, line) => sum + line.subtotalMinor + line.returnTaxMinor, 0);
        if (refund <= 0) throw new Error("selected items have no refundable balance");
        if (refund > refundable) throw new Error("selected items exceed the remaining sale balance");

        const cashAccount = origLines.find((line) => line.code === "1000" && line.debitMinor > 0);
        const revenueAccount = origLines.find((line) => line.code === "4000" && line.creditMinor > 0);
        const taxAccount = origLines.find((line) => line.code === "2100" && line.creditMinor > 0);
        const subtotalMinor = selectedLines.reduce((sum, line) => sum + line.subtotalMinor, 0);
        const taxMinor = selectedLines.reduce((sum, line) => sum + line.returnTaxMinor, 0);
        if (!cashAccount || !revenueAccount || (taxMinor > 0 && !taxAccount)) throw new Error("the original POS accounts are unavailable; ask accounting to review this return");
        const legacyFullStockReturn = !input.lines && hasUnlinkedLegacyStock;
        if (legacyFullStockReturn && (inv.creditedMinor !== 0 || refund !== inv.totalMinor)) {
          throw new Error("this older sale can only be returned in full because its stock is not linked to individual sale lines");
        }
        const refundEntryId = await postEntry(tx, ctx.actor.orgId, ctx.actor, {
          memo: `POS return on sale ${inv.number} to ${refundMethod}: ${input.reason}`,
          sourceType: "pos_return",
          sourceId: inv.id,
          currency: inv.currency,
          postedAt: ctx.now,
          lines: [
            { accountId: cashAccount.accountId, debitMinor: 0, creditMinor: refund },
            { accountId: revenueAccount.accountId, debitMinor: subtotalMinor, creditMinor: 0 },
            ...(taxMinor > 0 ? [{ accountId: taxAccount!.accountId, debitMinor: taxMinor, creditMinor: 0 }] : []),
          ],
        });
        const [returnHeader] = await tx.insert(posReturns).values({
          orgId: ctx.actor.orgId,
          invoiceId: inv.id,
          entryId: refundEntryId,
          refundMethod,
          refundMinor: refund,
          reason: input.reason,
        }).returning({ id: posReturns.id });
        await tx.insert(posReturnLines).values(selectedLines.map((line) => ({
          orgId: ctx.actor.orgId,
          returnId: returnHeader!.id,
          invoiceLineId: line.id,
          quantity: line.quantity,
          subtotalMinor: line.subtotalMinor,
          taxMinor: line.returnTaxMinor,
        })));
        await tx.update(invoices).set({ creditedMinor: inv.creditedMinor + refund }).where(eq(invoices.id, inv.id));

        // N12 (ADR 0051): a cash refund physically leaves the drawer, so the
        // session's expected cash drops with it - otherwise closeSession
        // would flag an "overage" that is really money already handed back.
        // A closed session's count is frozen history; its variance was
        // recorded when it closed and is not rewritten by later returns.
        if (refundMethod === "cash" && inv.posSessionId) {
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
        let restockedLines = 0;
        await lockStockItems(
          tx,
          legacyFullStockReturn
            ? [...stockSoldByItem.keys()]
            : [...new Set(selectedLines.map((line) => line.itemId).filter((id): id is string => id !== null && stockSoldByItem.has(id)))],
        );
        if (legacyFullStockReturn) {
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
        } else for (const line of selectedLines) {
          if (!line.itemId || !stockSoldByItem.has(line.itemId)) continue;
          const alreadyReturnedForItem = invoiceLineRows
            .filter((saleLine) => saleLine.itemId === line.itemId)
            .reduce((sum, saleLine) => sum + (returnedByLine.get(saleLine.id) ?? 0), 0);
          const returningForItem = selectedLines
            .filter((selected) => selected.itemId === line.itemId)
            .reduce((sum, selected) => sum + selected.quantity, 0);
          if (alreadyReturnedForItem + returningForItem > (stockSoldByItem.get(line.itemId) ?? 0)) {
            throw new Error("returned quantity exceeds the stock originally taken for this item");
          }
          const originalLeg = saleLegs.find((leg) => leg.itemId === line.itemId && leg.quantityDelta < 0);
          await applyStockDelta(tx, {
            orgId: ctx.actor.orgId,
            itemId: line.itemId,
            quantityDelta: line.quantity,
            reason: "sale",
            refType: "pos_return",
            refId: inv.id,
            unitCostMinor: originalLeg?.unitCostMinor ?? undefined,
            note: `POS return on sale ${inv.number}: ${input.reason}`,
            actorType: ctx.actor.type,
            actorId: ctx.actor.id,
          });
          restockedLines += 1;
        }
        return { refundEntryId, refundMinor: refund, creditedMinor: inv.creditedMinor + refund, restockedLines, refundMethod };
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
      tenderTotals: z.array(z.object({ method: z.string(), amountMinor: z.number() })),
      refundTotals: z.array(z.object({ method: z.string(), amountMinor: z.number() })),
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
        const tenderTotals = await tx
          .select({ method: payments.method, amountMinor: sql<number>`coalesce(sum(${payments.amountMinor}), 0)` })
          .from(payments)
          .innerJoin(invoices, eq(payments.invoiceId, invoices.id))
          .where(and(eq(payments.orgId, ctx.actor.orgId), eq(invoices.posSessionId, session.id)))
          .groupBy(payments.method);
        const refundTotals = await tx
          .select({ method: posReturns.refundMethod, amountMinor: sql<number>`coalesce(sum(${posReturns.refundMinor}), 0)` })
          .from(posReturns)
          .innerJoin(invoices, eq(posReturns.invoiceId, invoices.id))
          .where(and(eq(posReturns.orgId, ctx.actor.orgId), eq(invoices.posSessionId, session.id)))
          .groupBy(posReturns.refundMethod);
        return {
          register: session.register,
          status: session.status,
          salesCount: Number(agg?.count ?? 0),
          takingsMinor: Number(agg?.takings ?? 0),
          tenderTotals: tenderTotals.map((tender) => ({ method: tender.method, amountMinor: Number(tender.amountMinor) })),
          refundTotals: refundTotals.map((refund) => ({ method: refund.method, amountMinor: Number(refund.amountMinor) })),
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
