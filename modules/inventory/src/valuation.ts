import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, items, journalEntries, journalLines } from "@chaste/db";
import { replayValuation, valuationAdjustmentLines } from "@chaste/erp-core";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";
import { assertPeriodOpen, postEntry } from "@chaste/module-accounting/posting";
import { movementHistory, withOrgContext, type DbLike, type ModuleDeps } from "./shared";

/**
 * Inventory → GL closure (ADR 0033). The stock ledger's moving-average value
 * is operational truth; account 1200 is brought to it by one balanced entry,
 * the counterpart landing on COGS (5000). The variance is only knowable
 * inside the transaction, so the capabilities declare moneyAmount → null,
 * which the kernel treats as "always gate" — valuation postings always
 * demand a human approval, whichever policy is configured.
 */

export const INVENTORY_ACCOUNT_CODE = "1200";
export const COGS_ACCOUNT_CODE = "5000";

/** Sum of every item's replayed moving-average value (the stock report total). */
export async function inventoryLedgerValueMinor(db: DbLike, orgId: string): Promise<number> {
  const rows = await db.select({ id: items.id }).from(items).where(eq(items.orgId, orgId));
  let total = 0;
  for (const row of rows) {
    const history = await movementHistory(db, orgId, row.id);
    const valuation = replayValuation(
      history.map((h) => ({
        quantityDelta: h.quantityDelta,
        unitCostMinor: h.unitCostMinor ?? undefined,
        valueNeutral: h.reason === "transfer",
      })),
    );
    total += valuation.totalValueMinor;
  }
  return total;
}

/** Debits minus credits posted to one account code in this org's chart. */
export async function glAccountBalanceMinor(
  db: DbLike,
  orgId: string,
  code: string = INVENTORY_ACCOUNT_CODE,
): Promise<number> {
  const [row] = await db
    .select({ balance: sql<number>`coalesce(sum(${journalLines.debitMinor} - ${journalLines.creditMinor}), 0)` })
    .from(journalLines)
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(and(eq(accounts.orgId, orgId), eq(accounts.code, code)));
  return Number(row?.balance ?? 0);
}

export const postValuationSummary = (deps: ModuleDeps) =>
  defineCapability({
    id: "inventory.postValuationSummary",
    title: "Post inventory valuation summary",
    intent:
      "Reconcile the GL inventory account to the stock ledger's moving-average value with one balanced adjustment entry against COGS; a no-op when already reconciled",
    module: "inventory",
    risk: "money",
    permission: "inventory.write",
    // Variance is only knowable inside the transaction; null fails closed to
    // "always demand approval" rather than guessing an amount.
    moneyAmount: () => null,
    inverse: {
      capabilityId: "inventory.reverseValuationSummary",
      buildInput: (_input, output) => ({ entryId: (output as { entryId: string | null }).entryId }),
    },
    input: z.object({
      memo: z
        .string()
        .min(3)
        .max(300)
        .default("Inventory valuation summary — stock ledger to GL"),
    }),
    output: z.object({
      posted: z.boolean(),
      entryId: z.string().nullable(),
      varianceMinor: z.number(),
      ledgerValueMinor: z.number(),
      glBalanceMinor: z.number(),
    }),
    execute: async (ctx, input) =>
      withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const ledgerValueMinor = await inventoryLedgerValueMinor(tx, ctx.actor.orgId);
        const glBalanceMinor = await glAccountBalanceMinor(tx, ctx.actor.orgId);
        const varianceMinor = ledgerValueMinor - glBalanceMinor;
        // Already reconciled: an empty entry must never exist, so the honest
        // answer is an explicit no-op, not a zero posting.
        if (varianceMinor === 0) {
          return { posted: false, entryId: null, varianceMinor, ledgerValueMinor, glBalanceMinor };
        }
        await assertPeriodOpen(tx, ctx.actor.orgId, ctx.now);
        const entryId = await postEntry(tx, ctx.actor.orgId, { type: ctx.actor.type, id: ctx.actor.id }, {
          memo: input.memo,
          sourceType: "inventory-valuation",
          lines: valuationAdjustmentLines(varianceMinor, {
            inventoryCode: INVENTORY_ACCOUNT_CODE,
            cogsCode: COGS_ACCOUNT_CODE,
          }),
        });
        return { posted: true, entryId, varianceMinor, ledgerValueMinor, glBalanceMinor };
      }),
  });

export const reverseValuationSummary = (deps: ModuleDeps) =>
  defineCapability({
    id: "inventory.reverseValuationSummary",
    title: "Reverse inventory valuation summary",
    intent:
      "Reverse a previously posted inventory valuation summary with the exact mirrored entry, restoring the GL to its pre-posting state; each summary may be reversed at most once",
    module: "inventory",
    risk: "money",
    permission: "inventory.write",
    moneyAmount: () => null,
    // Reversing the reversal is what postValuationSummary does; no further
    // mechanical inverse is declared.
    input: z.object({ entryId: z.string().uuid() }),
    output: z.object({ reversed: z.boolean(), reversalEntryId: z.string() }),
    execute: async (ctx, input) =>
      withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [entry] = await tx
          .select()
          .from(journalEntries)
          .where(and(eq(journalEntries.orgId, ctx.actor.orgId), eq(journalEntries.id, input.entryId)))
          .limit(1);
        if (!entry) throw new Error(`no journal entry ${input.entryId}`);
        if (entry.sourceType !== "inventory-valuation") {
          throw new Error(`entry ${input.entryId} is not an inventory valuation summary`);
        }
        const [already] = await tx
          .select({ id: journalEntries.id })
          .from(journalEntries)
          .where(and(eq(journalEntries.orgId, ctx.actor.orgId), eq(journalEntries.reversalOfId, input.entryId)))
          .limit(1);
        if (already) throw new Error(`entry ${input.entryId} has already been reversed`);
        const lines = await tx
          .select({
            accountId: journalLines.accountId,
            debitMinor: journalLines.debitMinor,
            creditMinor: journalLines.creditMinor,
          })
          .from(journalLines)
          .where(eq(journalLines.entryId, input.entryId));
        const reversalEntryId = await postEntry(tx, ctx.actor.orgId, { type: ctx.actor.type, id: ctx.actor.id }, {
          memo: `Reversal: ${entry.memo}`,
          sourceType: "inventory-valuation-reversal",
          reversalOfId: input.entryId,
          lines: lines.map((l) => ({
            accountId: l.accountId,
            debitMinor: l.creditMinor,
            creditMinor: l.debitMinor,
          })),
        });
        return { reversed: true, reversalEntryId };
      }),
  });

export function registerValuationCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(postValuationSummary(deps));
  registry.register(reverseValuationSummary(deps));
}

