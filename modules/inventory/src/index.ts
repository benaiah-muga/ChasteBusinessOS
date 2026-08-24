import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  cycleCountLines,
  cycleCounts,
  items,
  lots,
  stockLocations,
  stockMovements,
  stockReservations,
} from "@chaste/db";
import { availableToPromise, needsReorder, replayValuation } from "@chaste/erp-core";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";
import {
  getOrCreateLot,
  itemBySku,
  movementHistory,
  recordStockMovement,
  stockOnHand,
  withOrgContext,
  type DbLike,
  type ModuleDeps,
} from "./shared";

// Public surface other modules import — this is the sanctioned integration
// seam: the manufacturing module writes to THIS ledger through these helpers
// rather than keeping its own stock records.
export {
  recordStockMovement,
  stockOnHand,
  movementHistory,
  itemBySku,
  getOrCreateLot,
  withOrgContext,
} from "./shared";
export type { ModuleDeps, MovementInput, Tx, DbLike } from "./shared";

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
    // No mechanical inverse by design: the caller knows the delta it posted
    // and reverses with the same capability (quantityDelta negated), which is
    // what produceFromBom's declared inverse builds.
    input: z.object({
      sku: z.string(),
      quantityDelta: z.number().int().refine((n) => n !== 0, "zero adjustments are pointless"),
      note: z.string().min(3).describe("why this correction happened"),
      lotCode: z.string().min(1).max(40).optional().describe("tag an inward correction with a lot code"),
      locationCode: z.string().min(1).max(20).optional().describe("record where this stock sits"),
    }),
    output: z.object({ onHandThousandths: z.number() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const item = await itemBySku(tx, ctx.actor.orgId, input.sku);
        if (!item) throw new Error(`no item with SKU ${input.sku}`);
        if (input.quantityDelta < 0) {
          const current = await stockOnHand(tx, ctx.actor.orgId, item.id);
          if (-input.quantityDelta > current) {
            throw new Error(`cannot go negative: only ${current} thousandths on hand`);
          }
        }
        if (input.lotCode && input.quantityDelta < 0) {
          throw new Error("lotCode applies only to inward corrections");
        }
        const lotId = input.lotCode ? await getOrCreateLot(tx, ctx.actor.orgId, item.id, input.lotCode) : null;
        let locationId: string | null = null;
        if (input.locationCode) {
          const [loc] = await tx
            .select({ id: stockLocations.id })
            .from(stockLocations)
            .where(and(eq(stockLocations.orgId, ctx.actor.orgId), eq(stockLocations.code, input.locationCode)))
            .limit(1);
          if (!loc) throw new Error(`no location with code ${input.locationCode}`);
          locationId = loc.id;
        }
        await recordStockMovement(tx, {
          orgId: ctx.actor.orgId,
          itemId: item.id,
          quantityDelta: input.quantityDelta,
          reason: "adjustment",
          note: input.note,
          actorType: ctx.actor.type,
          actorId: ctx.actor.id,
          lotId: lotId ?? undefined,
          locationId: locationId ?? undefined,
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
      "Show every tracked item with on-hand quantity, moving-average value, open reservations, and available-to-promise so purchasing and sales see the same truth",
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
          valueMinor: z.number(),
          avgUnitCostMinor: z.number(),
          reservedThousandths: z.number(),
          availableThousandths: z.number(),
          reorderPointThousandths: z.number(),
          reorderNeeded: z.boolean(),
        }),
      ),
      totalValueMinor: z.number(),
    }),
    execute: async (ctx, input) => {
      const rows = await deps.db
        .select()
        .from(items)
        .where(eq(items.orgId, ctx.actor.orgId))
        .orderBy(asc(items.sku));
      const out = [];
      let totalValueMinor = 0;
      for (const item of rows) {
        const level = await stockOnHand(deps.db, ctx.actor.orgId, item.id);
        const history = await movementHistory(deps.db, ctx.actor.orgId, item.id);
        const valuation = replayValuation(
          history.map((h) => ({ quantityDelta: h.quantityDelta, unitCostMinor: h.unitCostMinor ?? undefined })),
        );
        const reserved = await openReserved(deps.db, ctx.actor.orgId, item.id);
        const available = Math.max(0, level - reserved);
        totalValueMinor += valuation.totalValueMinor;
        const reorderNeeded = needsReorder(level, item.reorderPointThousandths);
        if (input.belowReorderOnly && !reorderNeeded) continue;
        out.push({
          sku: item.sku,
          name: item.name,
          unitLabel: item.unitLabel,
          onHandThousandths: level,
          valueMinor: valuation.totalValueMinor,
          avgUnitCostMinor:
            level > 0 ? Math.round((valuation.totalValueMinor * 1000) / level) : 0,
          reservedThousandths: reserved,
          availableThousandths: available,
          reorderPointThousandths: item.reorderPointThousandths,
          reorderNeeded,
        });
      }
      return { items: out, totalValueMinor };
    },
  });


// ── Reservations (available-to-promise) ─────────────────────────────────

export async function openReserved(db: DbLike, orgId: string, itemId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${stockReservations.quantityThousandths}), 0)` })
    .from(stockReservations)
    .where(and(eq(stockReservations.orgId, orgId), eq(stockReservations.itemId, itemId), eq(stockReservations.status, "open")));
  return Number(row?.total ?? 0);
}

const reserveStock = (deps: ModuleDeps) =>
  defineCapability({
    id: "inventory.reserveStock",
    title: "Reserve stock",
    intent:
      "Place an open claim against available stock for a sales order, work order, or other commitment; reservations never move the ledger but reduce what is promiseable",
    module: "inventory",
    risk: "write",
    permission: "inventory.write",
    inverse: {
      capabilityId: "inventory.releaseReservation",
      buildInput: (_input, output) => ({ reservationId: (output as { reservationId: string }).reservationId }),
    },
    input: z.object({
      sku: z.string(),
      quantityThousandths: z.number().int().positive(),
      reason: z.string().min(3).max(200).describe("what is claiming this stock, e.g. 'SO-1042'"),
    }),
    output: z.object({ reservationId: z.string(), availableAfterThousandths: z.number() }),
    execute: async (ctx, input) =>
      withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const item = await itemBySku(tx, ctx.actor.orgId, input.sku);
        if (!item) throw new Error(`no item with SKU ${input.sku}`);
        const onHand = await stockOnHand(tx, ctx.actor.orgId, item.id);
        const reserved = await openReserved(tx, ctx.actor.orgId, item.id);
        const available = availableToPromise(onHand, reserved);
        if (input.quantityThousandths > available) {
          throw new Error(`only ${available} thousandths available to promise (${onHand} on hand, ${reserved} reserved)`);
        }
        const [row] = await tx
          .insert(stockReservations)
          .values({
            orgId: ctx.actor.orgId,
            itemId: item.id,
            quantityThousandths: input.quantityThousandths,
            reason: input.reason,
            createdByActorType: ctx.actor.type,
            createdByActorId: ctx.actor.id,
          })
          .returning({ id: stockReservations.id });
        return { reservationId: row!.id, availableAfterThousandths: available - input.quantityThousandths };
      }),
  });

const releaseReservation = (deps: ModuleDeps) =>
  defineCapability({
    id: "inventory.releaseReservation",
    title: "Release reservation",
    intent:
      "Release an open stock reservation back to available-to-promise when the claiming order is cancelled or re-planned",
    module: "inventory",
    risk: "write",
    permission: "inventory.write",
    // No mechanical inverse: releasing is itself the compensation; the
    // original reserveStock capability is what would restore the claim.
    input: z.object({ reservationId: z.string().uuid() }),
    output: z.object({ released: z.boolean() }),
    execute: async (ctx, input) =>
      withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [res] = await tx
          .select()
          .from(stockReservations)
          .where(and(eq(stockReservations.orgId, ctx.actor.orgId), eq(stockReservations.id, input.reservationId)))
          .limit(1);
        if (!res) throw new Error(`no reservation ${input.reservationId}`);
        if (res.status !== "open") throw new Error(`reservation is ${res.status}, only open ones can be released`);
        await tx
          .update(stockReservations)
          .set({ status: "released", releasedAt: new Date() })
          .where(eq(stockReservations.id, res.id));
        return { released: true };
      }),
  });

// ── Locations ───────────────────────────────────────────────────────────

const createLocation = (deps: ModuleDeps) =>
  defineCapability({
    id: "inventory.createLocation",
    title: "Create stock location",
    intent:
      "Register a warehouse, bin, or shop-floor staging area so movements can record where stock physically sits",
    module: "inventory",
    risk: "write",
    permission: "inventory.write",
    // No mechanical inverse: locations organize records rather than hold
    // value; deleting one would orphan historical movement references.
    input: z.object({ code: z.string().min(1).max(20), name: z.string().min(1).max(80) }),
    output: z.object({ locationId: z.string() }),
    execute: async (ctx, input) => {
      const [dupe] = await deps.db
        .select({ id: stockLocations.id })
        .from(stockLocations)
        .where(and(eq(stockLocations.orgId, ctx.actor.orgId), eq(stockLocations.code, input.code)))
        .limit(1);
      if (dupe) throw new Error(`location code "${input.code}" already exists`);
      const [row] = await deps.db
        .insert(stockLocations)
        .values({ orgId: ctx.actor.orgId, code: input.code, name: input.name })
        .returning({ id: stockLocations.id });
      return { locationId: row!.id };
    },
  });


// ── Cycle counting ──────────────────────────────────────────────────────

const startCycleCount = (deps: ModuleDeps) =>
  defineCapability({
    id: "inventory.createCycleCount",
    title: "Start cycle count",
    intent:
      "Open a stock take that snapshots the expected on-hand quantity of every active item so counters can record what they physically find",
    module: "inventory",
    risk: "write",
    permission: "inventory.write",
    inverse: { capabilityId: "inventory.cancelCycleCount", buildInput: (_input, output) => ({ countId: (output as { countId: string }).countId }) },
    input: z.object({
      note: z.string().max(200).optional(),
      skus: z.array(z.string().min(1).max(40)).max(500).optional().describe("count only these SKUs; default is every active item"),
    }),
    output: z.object({ countId: z.string(), lineCount: z.number() }),
    execute: async (ctx, input) =>
      withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const allActive = await tx
          .select({ id: items.id, sku: items.sku })
          .from(items)
          .where(and(eq(items.orgId, ctx.actor.orgId), sql`${items.archivedAt} is null`));
        const wanted = input.skus ? new Set(input.skus) : null;
        const activeItems = wanted ? allActive.filter((i) => wanted.has(i.sku)) : allActive;
        if (activeItems.length === 0)
          throw new Error(wanted ? "none of the requested SKUs are active items" : "no items to count");
        const [count] = await tx
          .insert(cycleCounts)
          .values({
            orgId: ctx.actor.orgId,
            note: input.note ?? null,
            createdByActorType: ctx.actor.type,
            createdByActorId: ctx.actor.id,
          })
          .returning({ id: cycleCounts.id });
        const lines = [];
        for (const it of activeItems) {
          lines.push({
            orgId: ctx.actor.orgId,
            countId: count!.id,
            itemId: it.id,
            expectedThousandths: await stockOnHand(tx, ctx.actor.orgId, it.id),
          });
        }
        await tx.insert(cycleCountLines).values(lines);
        return { countId: count!.id, lineCount: lines.length };
      }),
  });

async function loadCount(tx: Parameters<Parameters<ModuleDeps["db"]["transaction"]>[0]>[0], orgId: string, countId: string) {
  const [count] = await tx
    .select()
    .from(cycleCounts)
    .where(and(eq(cycleCounts.orgId, orgId), eq(cycleCounts.id, countId)))
    .limit(1);
  if (!count) throw new Error(`no cycle count ${countId}`);
  return count;
}

const recordCycleCounts = (deps: ModuleDeps) =>
  defineCapability({
    id: "inventory.recordCycleCounts",
    title: "Record counted quantities",
    intent:
      "Enter physical count results into an open cycle count; posting happens separately once every line has been counted and reviewed",
    module: "inventory",
    risk: "write",
    permission: "inventory.write",
    // No mechanical inverse: entries are editable until the count posts, so
    // correction is simply recording the right number again.
    input: z.object({
      countId: z.string().uuid(),
      counts: z
        .array(z.object({ sku: z.string(), countedThousandths: z.number().int().min(0) }))
        .min(1)
        .max(500),
    }),
    output: z.object({ recorded: z.number() }),
    execute: async (ctx, input) =>
      withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const count = await loadCount(tx, ctx.actor.orgId, input.countId);
        if (count.status !== "open") throw new Error(`cycle count is ${count.status}; only open counts accept entries`);
        let recorded = 0;
        for (const e of input.counts) {
          const item = await itemBySku(tx, ctx.actor.orgId, e.sku);
          if (!item) throw new Error(`no item with SKU ${e.sku}`);
          const updated = await tx
            .update(cycleCountLines)
            .set({ countedThousandths: e.countedThousandths })
            .where(and(eq(cycleCountLines.countId, count.id), eq(cycleCountLines.itemId, item.id)))
            .returning({ id: cycleCountLines.id });
          if (updated.length === 0) throw new Error(`SKU ${e.sku} is not part of this count`);
          recorded += updated.length;
        }
        return { recorded };
      }),
  });


const postCycleCount = (deps: ModuleDeps) =>
  defineCapability({
    id: "inventory.postCycleCount",
    title: "Post cycle count variances",
    intent:
      "Close an open cycle count and write one adjustment movement per variance line so the ledger matches physical reality, with an audit note per line",
    module: "inventory",
    risk: "write",
    permission: "inventory.write",
    // No mechanical inverse: a posted count records observed reality; a later
    // miscount is corrected by another count, not by undoing the observation.
    input: z.object({ countId: z.string().uuid() }),
    output: z.object({ posted: z.boolean(), postedVariances: z.number(), netVarianceThousandths: z.number() }),
    execute: async (ctx, input) =>
      withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const count = await loadCount(tx, ctx.actor.orgId, input.countId);
        if (count.status !== "open") throw new Error(`cycle count is ${count.status}; only open counts can post`);
        const lines = await tx.select().from(cycleCountLines).where(eq(cycleCountLines.countId, count.id));
        if (!lines.some((l) => l.countedThousandths !== null)) {
          throw new Error("no counted quantity recorded on any line; enter counts before posting");
        }
        // Snapshot drift guard: a count sheet is only valid against the stock
        // it was snapshotted from. If anything moved since, the variance would
        // silently absorb an unrelated movement — force a fresh count instead.
        for (const line of lines) {
          const current = await stockOnHand(tx, ctx.actor.orgId, line.itemId);
          if (current !== line.expectedThousandths) {
            throw new Error(
              `stock for one of the counted items moved since the snapshot (expected ${line.expectedThousandths}, now ${current}); start a fresh count`,
            );
          }
        }
        let adjustments = 0;
        let netVariance = 0;
        for (const line of lines) {
          if (line.countedThousandths === null) continue;
          const delta = line.countedThousandths - line.expectedThousandths;
          if (delta === 0) continue;
          await recordStockMovement(tx, {
            orgId: ctx.actor.orgId,
            itemId: line.itemId,
            quantityDelta: delta,
            reason: "adjustment",
            note: `cycle count ${count.id.slice(0, 8)} variance`,
            refType: "cycle_count",
            refId: count.id,
            actorType: ctx.actor.type,
            actorId: ctx.actor.id,
          });
          adjustments += 1;
          netVariance += delta;
        }
        await tx.update(cycleCounts).set({ status: "posted", postedAt: new Date() }).where(eq(cycleCounts.id, count.id));
        return { posted: true, postedVariances: adjustments, netVarianceThousandths: netVariance };
      }),
  });

const cancelCycleCount = (deps: ModuleDeps) =>
  defineCapability({
    id: "inventory.cancelCycleCount",
    title: "Cancel cycle count",
    intent: "Discard an open cycle count without posting any variances to the ledger",
    module: "inventory",
    risk: "write",
    permission: "inventory.write",
    // No mechanical inverse: cancellation discards unposted observations.
    input: z.object({ countId: z.string().uuid() }),
    output: z.object({ cancelled: z.boolean() }),
    execute: async (ctx, input) =>
      withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const count = await loadCount(tx, ctx.actor.orgId, input.countId);
        if (count.status !== "open") throw new Error(`cycle count is ${count.status}; only open counts can be cancelled`);
        await tx.update(cycleCounts).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(cycleCounts.id, count.id));
        return { cancelled: true };
      }),
  });


// ── Reads ───────────────────────────────────────────────────────────────

const stockHistory = (deps: ModuleDeps) =>
  defineCapability({
    id: "inventory.itemHistory",
    title: "Stock movement history",
    intent:
      "Show the append-only movement history of one item — every quantity change with its reason, reference, cost, lot, and actor",
    module: "inventory",
    risk: "read",
    permission: "inventory.read",
    input: z.object({ sku: z.string(), limit: z.number().int().min(1).max(200).default(50) }),
    output: z.object({
      movements: z.array(
        z.object({
          id: z.string(),
          quantityDelta: z.number(),
          reason: z.string(),
          note: z.string().nullable(),
          refType: z.string().nullable(),
          unitCostMinor: z.number().nullable(),
          lotCode: z.string().nullable(),
          locationCode: z.string().nullable(),
          actorType: z.string(),
          createdAt: z.date(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      const item = await itemBySku(deps.db, ctx.actor.orgId, input.sku);
      if (!item) throw new Error(`no item with SKU ${input.sku}`);
      const rows = await deps.db
        .select({
          id: stockMovements.id,
          quantityDelta: stockMovements.quantityDelta,
          reason: stockMovements.reason,
          note: stockMovements.note,
          refType: stockMovements.refType,
          unitCostMinor: stockMovements.unitCostMinor,
          lotCode: lots.lotCode,
          locationCode: stockLocations.code,
          actorType: stockMovements.actorType,
          createdAt: stockMovements.createdAt,
        })
        .from(stockMovements)
        .leftJoin(lots, eq(stockMovements.lotId, lots.id))
        .leftJoin(stockLocations, eq(stockMovements.locationId, stockLocations.id))
        .where(and(eq(stockMovements.orgId, ctx.actor.orgId), eq(stockMovements.itemId, item.id)))
        .orderBy(desc(stockMovements.createdAt))
        .limit(input.limit);
      return { movements: rows };
    },
  });


const listLocations = (deps: ModuleDeps) =>
  defineCapability({
    id: "inventory.listLocations",
    title: "List stock locations",
    intent: "Show every registered stock location with its code and human name",
    module: "inventory",
    risk: "read",
    permission: "inventory.read",
    input: z.object({}),
    output: z.object({ locations: z.array(z.object({ code: z.string(), name: z.string() })) }),
    execute: async (ctx) => {
      const rows = await deps.db
        .select({ code: stockLocations.code, name: stockLocations.name })
        .from(stockLocations)
        .where(eq(stockLocations.orgId, ctx.actor.orgId))
        .orderBy(asc(stockLocations.code));
      return { locations: rows };
    },
  });

const listReservations = (deps: ModuleDeps) =>
  defineCapability({
    id: "inventory.listReservations",
    title: "List stock reservations",
    intent: "Show open (or all recent) stock reservations so overbooking is visible before it becomes a stockout",
    module: "inventory",
    risk: "read",
    permission: "inventory.read",
    input: z.object({ openOnly: z.boolean().default(true) }),
    output: z.object({
      reservations: z.array(
        z.object({
          id: z.string(),
          sku: z.string(),
          quantityThousandths: z.number(),
          reason: z.string(),
          status: z.string(),
          createdAt: z.date(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      const conditions = [eq(stockReservations.orgId, ctx.actor.orgId)];
      if (input.openOnly) conditions.push(eq(stockReservations.status, "open"));
      const rows = await deps.db
        .select({ res: stockReservations, sku: items.sku })
        .from(stockReservations)
        .innerJoin(items, eq(stockReservations.itemId, items.id))
        .where(and(...conditions))
        .orderBy(desc(stockReservations.createdAt))
        .limit(100);
      return {
        reservations: rows.map(({ res, sku }) => ({
          id: res.id,
          sku,
          quantityThousandths: res.quantityThousandths,
          reason: res.reason,
          status: res.status,
          createdAt: res.createdAt,
        })),
      };
    },
  });

const listLots = (deps: ModuleDeps) =>
  defineCapability({
    id: "inventory.listLots",
    title: "List lots",
    intent:
      "Show production/inspection lots with their derived on-hand balance from the ledger, so expiring or stuck batches are visible",
    module: "inventory",
    risk: "read",
    permission: "inventory.read",
    input: z.object({}),
    output: z.object({
      lots: z.array(
        z.object({ id: z.string(), sku: z.string(), lotCode: z.string(), balanceThousandths: z.number() }),
      ),
    }),
    execute: async (ctx) => {
      const itemRows = await deps.db.select({ id: items.id, sku: items.sku }).from(items).where(eq(items.orgId, ctx.actor.orgId));
      const skuOf = new Map(itemRows.map((r) => [r.id, r.sku]));
      const rows = await deps.db
        .select({
          id: lots.id,
          itemId: lots.itemId,
          lotCode: lots.lotCode,
          balance: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)`,
        })
        .from(lots)
        .leftJoin(stockMovements, eq(stockMovements.lotId, lots.id))
        .where(eq(lots.orgId, ctx.actor.orgId))
        .groupBy(lots.id)
        .orderBy(desc(lots.createdAt))
        .limit(200);
      return {
        lots: rows.map((l) => ({
          id: l.id,
          sku: skuOf.get(l.itemId) ?? String(l.itemId),
          lotCode: l.lotCode,
          balanceThousandths: Number(l.balance),
        })),
      };
    },
  });


export function registerInventoryCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(createItem(deps));
  registry.register(adjustStock(deps));
  registry.register(stockReport(deps));
  registry.register(stockHistory(deps));
  registry.register(reserveStock(deps));
  registry.register(releaseReservation(deps));
  registry.register(createLocation(deps));
  registry.register(startCycleCount(deps));
  registry.register(recordCycleCounts(deps));
  registry.register(postCycleCount(deps));
  registry.register(cancelCycleCount(deps));
  registry.register(listLocations(deps));
  registry.register(listReservations(deps));
  registry.register(listLots(deps));
}
