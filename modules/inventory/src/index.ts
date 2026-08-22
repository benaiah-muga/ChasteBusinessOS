import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { items, stockMovements, type Database } from "@chaste/db";
import { needsReorder } from "@chaste/erp-core";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";

export interface ModuleDeps {
  db: Database["db"];
}

type Tx = Parameters<Parameters<ModuleDeps["db"]["transaction"]>[0]>[0];

export interface MovementInput {
  orgId: string;
  itemId: string;
  quantityDelta: number;
  reason: "purchase" | "sale" | "adjustment" | "production";
  note?: string | undefined;
  refType?: string | undefined;
  refId?: string | undefined;
  unitCostMinor?: number | undefined;
  actorType: "human" | "agent" | "system";
  actorId: string | null;
}

/**
 * Shared writer for the append-only stock ledger. Other modules (POS,
 * purchasing) import this so every quantity change lands in one ledger
 * with a reason and an actor, whatever wrote it.
 */
export async function recordStockMovement(tx: Tx | ModuleDeps["db"], m: MovementInput): Promise<void> {
  await tx.insert(stockMovements).values({
    orgId: m.orgId,
    itemId: m.itemId,
    quantityDelta: m.quantityDelta,
    reason: m.reason,
    note: m.note ?? null,
    refType: m.refType ?? null,
    refId: m.refId ?? null,
    unitCostMinor: m.unitCostMinor ?? null,
    actorType: m.actorType,
    actorId: m.actorId,
  });
}

/** Current on-hand thousandths for one item. */
export async function stockOnHand(db: Tx | ModuleDeps["db"], orgId: string, itemId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)` })
    .from(stockMovements)
    .where(and(eq(stockMovements.orgId, orgId), eq(stockMovements.itemId, itemId)));
  return Number(row?.total ?? 0);
}

const createItem = (deps: ModuleDeps) =>
  defineCapability({
    id: "inventory.createItem",
    title: "Create stock item",
    intent:
      "Register a stocked product with a SKU and optional reorder point so quantities can be tracked",
    module: "inventory",
    risk: "write",
    permission: "inventory.write",
    input: z.object({
      sku: z.string().min(1).max(40),
      name: z.string().min(1).max(120),
      unitLabel: z.string().max(20).default("unit"),
      reorderPointThousandths: z.number().int().nonnegative().default(0),
    }),
    output: z.object({ itemId: z.string() }),
    execute: async (ctx, input) => {
      const [dupe] = await deps.db
        .select({ id: items.id })
        .from(items)
        .where(and(eq(items.orgId, ctx.actor.orgId), eq(items.sku, input.sku)))
        .limit(1);
      if (dupe) throw new Error(`SKU "${input.sku}" already exists`);
      const [row] = await deps.db
        .insert(items)
        .values({
          orgId: ctx.actor.orgId,
          sku: input.sku,
          name: input.name,
          unitLabel: input.unitLabel,
          reorderPointThousandths: input.reorderPointThousandths,
        })
        .returning({ id: items.id });
      return { itemId: row!.id };
    },
  });

const adjustStock = (deps: ModuleDeps) =>
  defineCapability({
    id: "inventory.adjustStock",
    title: "Adjust stock",
    intent:
      "Record a manual stock correction (breakage, count fix, donation) on the stock ledger with a reason; sales and purchases use their own movements instead",
    module: "inventory",
    risk: "write",
    permission: "inventory.write",
    input: z.object({
      sku: z.string(),
      quantityDelta: z.number().int().refine((n) => n !== 0, "zero adjustments are pointless"),
      note: z.string().min(3).describe("why this correction happened"),
    }),
    output: z.object({ onHandThousandths: z.number() }),
    execute: async (ctx, input) => {
      return deps.db.transaction(async (tx) => {
        const [item] = await tx
          .select()
          .from(items)
          .where(and(eq(items.orgId, ctx.actor.orgId), eq(items.sku, input.sku)))
          .limit(1);
        if (!item) throw new Error(`no item with SKU ${input.sku}`);
        if (input.quantityDelta < 0) {
          const current = await stockOnHand(tx, ctx.actor.orgId, item.id);
          if (-input.quantityDelta > current) {
            throw new Error(`cannot go negative: only ${current} thousandths on hand`);
          }
        }
        await recordStockMovement(tx, {
          orgId: ctx.actor.orgId,
          itemId: item.id,
          quantityDelta: input.quantityDelta,
          reason: "adjustment",
          note: input.note,
          actorType: ctx.actor.type,
          actorId: ctx.actor.id,
        });
        const newLevel = await stockOnHand(tx, ctx.actor.orgId, item.id);
        return { onHandThousandths: newLevel };
      });
    },
  });

const stockReport = (deps: ModuleDeps) =>
  defineCapability({
    id: "inventory.stockReport",
    title: "Stock levels report",
    intent:
      "Show every tracked item with on-hand quantity and reorder alerts, so purchasing knows what to buy",
    module: "inventory",
    risk: "read",
    permission: "inventory.read",
    input: z.object({ belowReorderOnly: z.boolean().default(false) }),
    output: z.object({
      items: z.array(
        z.object({
          sku: z.string(),
          name: z.string(),
          unitLabel: z.string(),
          onHandThousandths: z.number(),
          reorderPointThousandths: z.number(),
          reorderNeeded: z.boolean(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      const rows = await deps.db
        .select()
        .from(items)
        .where(eq(items.orgId, ctx.actor.orgId))
        .orderBy(asc(items.sku));
      const out = [];
      for (const item of rows) {
        const level = await stockOnHand(deps.db, ctx.actor.orgId, item.id);
        const reorderNeeded = needsReorder(level, item.reorderPointThousandths);
        if (input.belowReorderOnly && !reorderNeeded) continue;
        out.push({
          sku: item.sku,
          name: item.name,
          unitLabel: item.unitLabel,
          onHandThousandths: level,
          reorderPointThousandths: item.reorderPointThousandths,
          reorderNeeded,
        });
      }
      return { items: out };
    },
  });

export function registerInventoryCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(createItem(deps));
  registry.register(adjustStock(deps));
  registry.register(stockReport(deps));
}
