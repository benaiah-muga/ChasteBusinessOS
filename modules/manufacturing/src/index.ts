import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { bomLines, items, lots, stockMovements, workOrders, type Database } from "@chaste/db";
import {
  checkAvailability,
  maxProducibleUnits,
  replayValuation,
  explodeBom,
  plannedGoodQuantity,
  previewProductionCost,
  requirementsWithScrap,
  traceLotUpstream,
  type LotTraceEdge,
} from "@chaste/erp-core";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";
import {
  getOrCreateLot,
  itemBySku,
  movementHistory,
  recordStockMovement,
  stockOnHand,
  withOrgContext,
} from "@chaste/module-inventory";

export interface ModuleDeps {
  db: Database["db"];
}
type Tx = Parameters<Parameters<ModuleDeps["db"]["transaction"]>[0]>[0];
type DbLike = Tx | Database["db"];

type RunActor = { orgId: string; type: "human" | "agent" | "system"; id: string | null };
const pctInput = z
  .number()
  .int()
  .min(0)
  .max(1_000_000)
  .describe("thousandths of a percent: 5% = 5000");

export async function avgUnitCost(db: DbLike, orgId: string, itemId: string): Promise<number> {
  const history = await movementHistory(db, orgId, itemId);
  const state = replayValuation(
    history.map((h) => ({ quantityDelta: h.quantityDelta, unitCostMinor: h.unitCostMinor ?? undefined })),
  );
  if (state.quantityOnHand <= 0) return 0;
  return Math.round((state.totalValueMinor * 1000) / state.quantityOnHand);
}

/** Exploded (scrap-inclusive) requirements for one assembly quantity. */
export async function scrapAdjustedRequirements(
  tx: Parameters<Parameters<ModuleDeps["db"]["transaction"]>[0]>[0],
  orgId: string,
  assemblyItemId: string,
  quantityThousandths: number,
) {
  // The whole graph must be loaded: sub-assemblies expand through their own
  // edges, so filtering to this assembly would stop recursion at level one.
  const edges = await tx
    .select()
    .from(bomLines)
    .where(eq(bomLines.orgId, orgId));
  if (!edges.some((e) => e.assemblyItemId === assemblyItemId)) return null;
  const raw = explodeBom(
    edges.map((e) => ({
      assemblyItemId: e.assemblyItemId,
      componentItemId: e.componentItemId,
      quantityThousandths: e.quantityThousandths,
    })),
    assemblyItemId,
    quantityThousandths,
  );
  // Scrap lives per BOM edge; take the max allowance per component so a part
  // reached through several sub-assembly paths keeps its protection.
  const scrapByComponent = new Map<string, number>();
  for (const e of edges) {
    scrapByComponent.set(e.componentItemId, Math.max(scrapByComponent.get(e.componentItemId) ?? 0, e.scrapPctThousandths));
  }
  return { edges, requirements: requirementsWithScrap(raw, scrapByComponent) };
}

async function skuById(db: DbLike, orgId: string, itemId: string): Promise<string> {
  const [row] = await db.select({ sku: items.sku }).from(items).where(and(eq(items.orgId, orgId), eq(items.id, itemId))).limit(1);
  return row?.sku ?? String(itemId);
}

// ── Work orders ─────────────────────────────────────────────────────────

async function loadWorkOrder(tx: Parameters<Parameters<ModuleDeps["db"]["transaction"]>[0]>[0], orgId: string, workOrderId: string) {
  const [wo] = await tx
    .select()
    .from(workOrders)
    .where(and(eq(workOrders.orgId, orgId), eq(workOrders.id, workOrderId)))
    .limit(1);
  if (!wo) throw new Error(`no work order ${workOrderId}`);
  return wo;
}

const createWorkOrder = (deps: ModuleDeps) =>
  defineCapability({
    id: "manufacturing.createWorkOrder",
    title: "Create work order",
    intent:
      "Plan a production run for an assembled product as a draft work order with a planned quantity and expected yield; release it later to build",
    module: "manufacturing",
    risk: "write",
    permission: "manufacturing.write",
    inverse: {
      capabilityId: "manufacturing.cancelWorkOrder",
      buildInput: (_input, output) => ({ workOrderId: (output as { workOrderId: string }).workOrderId }),
    },
    input: z.object({
      assemblySku: z.string(),
      plannedQtyThousandths: z.number().int().positive(),
      yieldPctThousandths: pctInput.default(1_000_000),
      /** Work center that runs this order (M11 planning-lite). */
      workCenter: z.string().max(80).optional(),
      note: z.string().max(500).optional(),
    }),
    output: z.object({ workOrderId: z.string(), number: z.number(), expectedGoodThousandths: z.number() }),
    execute: async (ctx, input) =>
      withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const assembly = await itemBySku(tx, ctx.actor.orgId, input.assemblySku);
        if (!assembly) throw new Error(`no item with SKU ${input.assemblySku}`);
        const prepared = await scrapAdjustedRequirements(tx, ctx.actor.orgId, assembly.id, input.plannedQtyThousandths);
        if (!prepared) throw new Error(`${input.assemblySku} has no bill of materials; define one first`);

        const [maxRow] = await tx
          .select({ maxNumber: sql<number>`coalesce(max(${workOrders.number}), 0)` })
          .from(workOrders)
          .where(eq(workOrders.orgId, ctx.actor.orgId));
        const number = Number(maxRow?.maxNumber ?? 0) + 1;
        const [row] = await tx
          .insert(workOrders)
          .values({
            orgId: ctx.actor.orgId,
            number,
            assemblyItemId: assembly.id,
            plannedQtyThousandths: input.plannedQtyThousandths,
            workCenter: input.workCenter ?? null,
            yieldPctThousandths: input.yieldPctThousandths,
            note: input.note ?? null,
            createdByActorType: ctx.actor.type,
            createdByActorId: ctx.actor.id,
          })
          .returning({ id: workOrders.id });
        return {
          workOrderId: row!.id,
          number,
          expectedGoodThousandths: plannedGoodQuantity(input.plannedQtyThousandths, input.yieldPctThousandths),
        };
      }),
  });


const releaseWorkOrder = (deps: ModuleDeps) =>
  defineCapability({
    id: "manufacturing.releaseWorkOrder",
    title: "Release work order",
    intent:
      "Approve a draft work order for the shop floor after confirming every exploded BOM component (including scrap allowances) is in stock",
    module: "manufacturing",
    risk: "write",
    permission: "manufacturing.write",
    inverse: {
      capabilityId: "manufacturing.cancelWorkOrder",
      buildInput: (input) => ({ workOrderId: (input as { workOrderId: string }).workOrderId }),
    },
    input: z.object({ workOrderId: z.string().uuid() }),
    output: z.object({ released: z.boolean() }),
    execute: async (ctx, input) =>
      withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const wo = await loadWorkOrder(tx, ctx.actor.orgId, input.workOrderId);
        if (wo.status !== "draft") throw new Error(`work order #${wo.number} is ${wo.status}; only drafts can be released`);
        const prepared = await scrapAdjustedRequirements(tx, ctx.actor.orgId, wo.assemblyItemId, wo.plannedQtyThousandths);
        if (!prepared) throw new Error(`work order #${wo.number}: its bill of materials was deleted`);
        const onHandByItem = new Map<string, number>();
        for (const r of prepared.requirements) {
          onHandByItem.set(r.itemId, await stockOnHand(tx, ctx.actor.orgId, r.itemId));
        }
        const check = checkAvailability(prepared.requirements, onHandByItem);
        if (!check.producible) {
          const ids = check.lines.filter((l) => l.shortfallThousandths > 0).map((l) => l.itemId);
          const skus = [];
          for (const id of ids) skus.push(await skuById(tx, ctx.actor.orgId, id));
          throw new Error(`cannot release: components short of stock (${skus.join(", ")})`);
        }
        await tx.update(workOrders).set({ status: "released", releasedAt: new Date() }).where(eq(workOrders.id, wo.id));
        return { released: true };
      }),
  });

const cancelWorkOrder = (deps: ModuleDeps) =>
  defineCapability({
    id: "manufacturing.cancelWorkOrder",
    title: "Cancel work order",
    intent:
      "Cancel a draft or released work order that will not be produced; completed orders are immutable and reverse via run reversal instead",
    module: "manufacturing",
    risk: "write",
    permission: "manufacturing.write",
    // No mechanical inverse: cancellation is itself the compensation for
    // create/release; a completed run's ledger effects are undone by
    // manufacturing.reverseProductionRun instead.
    input: z.object({ workOrderId: z.string().uuid() }),
    output: z.object({ cancelled: z.boolean() }),
    execute: async (ctx, input) =>
      withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const wo = await loadWorkOrder(tx, ctx.actor.orgId, input.workOrderId);
        if (wo.status === "completed") throw new Error(`work order #${wo.number} is completed and cannot be cancelled; use reverseProductionRun`);
        if (wo.status === "cancelled") throw new Error(`work order #${wo.number} is already cancelled`);
        if (wo.producedQtyThousandths > 0) {
          throw new Error(`work order #${wo.number} has partial completions and cannot be cancelled; reverse them via manufacturing.reverseProductionRun first`);
        }
        await tx.update(workOrders).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(workOrders.id, wo.id));
        return { cancelled: true };
      }),
  });


// ── Production posting + reversal ───────────────────────────────────────

/**
 * Shared completion posting: consumes exploded+scrap-adjusted components and
 * adds finished goods inside one transaction — the same math as an instant
 * run, but tagged with a run reference so reversal and traceability find it.
 */
async function postRun(
  deps: ModuleDeps,
  actor: RunActor,
  opts: { assemblyItemId: string; assemblySku: string; quantityThousandths: number; runRef: string; lotCode?: string | undefined },
) {
  return withOrgContext(deps.db, actor.orgId, async (tx) => {
    const prepared = await scrapAdjustedRequirements(tx, actor.orgId, opts.assemblyItemId, opts.quantityThousandths);
    if (!prepared) throw new Error(`${opts.assemblySku} has no bill of materials`);
    const allItems = await tx.select({ id: items.id, sku: items.sku }).from(items).where(eq(items.orgId, actor.orgId));
    const bySku = new Map(allItems.map((r) => [r.id, r.sku]));

    const onHandByItem = new Map<string, number>();
    for (const r of prepared.requirements) {
      onHandByItem.set(r.itemId, await stockOnHand(tx, actor.orgId, r.itemId));
    }
    const check = checkAvailability(prepared.requirements, onHandByItem);
    if (!check.producible) {
      const short = check.lines
        .filter((l) => l.shortfallThousandths > 0)
        .map((l) => `${bySku.get(l.itemId) ?? l.itemId} short ${(l.shortfallThousandths / 1000).toFixed(3)}`)
        .join("; ");
      throw new Error(`insufficient stock: ${short}`);
    }

    let valueConsumedMinor = 0;
    const consumed: { sku: string; quantityThousandths: number }[] = [];
    const outLotId = opts.lotCode ? await getOrCreateLot(tx, actor.orgId, opts.assemblyItemId, opts.lotCode) : null;
    for (const req of prepared.requirements) {
      const unitCost = await avgUnitCost(tx, actor.orgId, req.itemId);
      valueConsumedMinor += Math.round((req.quantityThousandths * unitCost) / 1000);
      await recordStockMovement(tx, {
        orgId: actor.orgId,
        itemId: req.itemId,
        quantityDelta: -req.quantityThousandths,
        reason: "production",
        note: `consumed by production of ${opts.assemblySku}`,
        refType: "production",
        refId: opts.runRef,
        unitCostMinor: unitCost > 0 ? unitCost : undefined,
        actorType: actor.type,
        actorId: actor.id,
      });
      consumed.push({ sku: bySku.get(req.itemId) ?? String(req.itemId), quantityThousandths: req.quantityThousandths });
    }

    const rolledUnitCost =
      opts.quantityThousandths > 0 ? Math.round((valueConsumedMinor * 1000) / opts.quantityThousandths) : 0;
    await recordStockMovement(tx, {
      orgId: actor.orgId,
      itemId: opts.assemblyItemId,
      quantityDelta: opts.quantityThousandths,
      reason: "production",
      note: `produced from BOM (${consumed.length} component kinds)`,
      refType: "production",
      refId: opts.runRef,
      unitCostMinor: rolledUnitCost > 0 ? rolledUnitCost : undefined,
      lotId: outLotId ?? undefined,
      actorType: actor.type,
      actorId: actor.id,
    });

    return {
      producedThousandths: opts.quantityThousandths,
      consumedComponents: consumed,
      costRolledUpMinor: valueConsumedMinor,
    };
  });
}


const completeWorkOrder = (deps: ModuleDeps) =>
  defineCapability({
    id: "manufacturing.completeWorkOrder",
    title: "Complete work order",
    intent:
      "Post a released work order's build: consume BOM components with scrap allowances and add finished units at rolled-up cost, closing the order",
    module: "manufacturing",
    risk: "write",
    permission: "manufacturing.write",
    inverse: {
      capabilityId: "manufacturing.reverseProductionRun",
      buildInput: (_input, output) => ({ runRef: (output as { runRef: string }).runRef }),
    },
    input: z.object({
      workOrderId: z.string().uuid(),
      quantityThousandths: z.number().int().positive().describe("good units built, thousandths"),
      lotCode: z.string().min(1).max(40).optional().describe("assign the finished output to this production lot"),
    }),
    output: z.object({
      runRef: z.string(),
      completed: z.boolean(),
      producedTotalThousandths: z.number(),
      status: z.string(),
      producedThousandths: z.number(),
      consumedComponents: z.array(z.object({ sku: z.string(), quantityThousandths: z.number() })),
      costRolledUpMinor: z.number(),
    }),
    execute: async (ctx, input) => {
      const wo = await withOrgContext(deps.db, ctx.actor.orgId, (tx) => loadWorkOrder(tx, ctx.actor.orgId, input.workOrderId));
      if (wo.status !== "released") throw new Error(`work order #${wo.number} is ${wo.status}; only released orders can complete`);
      const remaining = wo.plannedQtyThousandths - wo.producedQtyThousandths;
      if (input.quantityThousandths > remaining) {
        throw new Error(`completion exceeds plan: only ${remaining} thousandths remain on work order #${wo.number}`);
      }
      const assemblySku = await skuById(deps.db, ctx.actor.orgId, wo.assemblyItemId);
      // Each completion posts as its own run so reversals and history can
      // target individual builds; the WO linkage lives on the order row.
      const runRef = crypto.randomUUID();
      const result = await postRun(deps, ctx.actor, {
        assemblyItemId: wo.assemblyItemId,
        assemblySku,
        quantityThousandths: input.quantityThousandths,
        runRef,
        lotCode: input.lotCode,
      });
      const producedTotal = wo.producedQtyThousandths + input.quantityThousandths;
      // The order closes when the plan is reached; partial completions keep it
      // released so the remainder can still be built.
      const done = producedTotal >= wo.plannedQtyThousandths;
      await withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        await tx
          .update(workOrders)
          .set(
            done
              ? { status: "completed", completedAt: new Date(), producedQtyThousandths: producedTotal }
              : { producedQtyThousandths: producedTotal },
          )
          .where(eq(workOrders.id, wo.id));
      });
      return {
        runRef,
        completed: done,
        producedTotalThousandths: producedTotal,
        status: done ? "completed" : "released",
        ...result,
      };
    },
  });


const reverseProductionRun = (deps: ModuleDeps) =>
  defineCapability({
    id: "manufacturing.reverseProductionRun",
    title: "Reverse production run",
    intent:
      "Undo a completed production run or work-order build by mirroring every movement it posted: components return to stock at their recorded costs and finished units leave",
    module: "manufacturing",
    risk: "destructive",
    permission: "manufacturing.write",
    // No mechanical inverse: re-running produceFromBom would value components
    // at current moving-average cost, which can differ from the original run;
    // a silent cost drift is worse than an explicit re-run.
    input: z.object({ runRef: z.string().uuid().describe("run reference returned by produceFromBom/completeWorkOrder") }),
    output: z.object({
      reversedMovements: z.number(),
      removedFinishedThousandths: z.number(),
      restoredComponents: z.array(z.object({ sku: z.string(), quantityThousandths: z.number() })),
      removedProduced: z.array(z.object({ sku: z.string(), quantityThousandths: z.number() })),
    }),
    execute: async (ctx, input) =>
      withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [already] = await tx
          .select({ id: stockMovements.id })
          .from(stockMovements)
          .where(
            and(
              eq(stockMovements.orgId, ctx.actor.orgId),
              eq(stockMovements.refType, "production_reversal"),
              eq(stockMovements.refId, input.runRef),
            ),
          )
          .limit(1);
        if (already) throw new Error("this production run has already been reversed");

        const runMovements = await tx
          .select()
          .from(stockMovements)
          .where(
            and(
              eq(stockMovements.orgId, ctx.actor.orgId),
              eq(stockMovements.refType, "production"),
              eq(stockMovements.refId, input.runRef),
            ),
          )
          .orderBy(desc(stockMovements.createdAt));
        if (runMovements.length === 0) throw new Error(`no production run found for ${input.runRef}`);

        // Net per item; removing produced goods must not drive stock negative.
        const netByItem = new Map<string, number>();
        for (const m of runMovements) {
          netByItem.set(m.itemId, (netByItem.get(m.itemId) ?? 0) + m.quantityDelta);
        }
        for (const [itemId, net] of netByItem) {
          if (net <= 0) continue;
          const onHand = await stockOnHand(tx, ctx.actor.orgId, itemId);
          if (net > onHand) throw new Error("cannot reverse: produced units have already been consumed or sold");
        }

        const restored: { sku: string; quantityThousandths: number }[] = [];
        const removed: { sku: string; quantityThousandths: number }[] = [];
        for (const m of [...runMovements].reverse()) {
          await recordStockMovement(tx, {
            orgId: ctx.actor.orgId,
            itemId: m.itemId,
            quantityDelta: -m.quantityDelta,
            reason: "adjustment",
            note: `reversal of production run ${input.runRef.slice(0, 8)}`,
            refType: "production_reversal",
            refId: input.runRef,
            unitCostMinor: m.unitCostMinor ?? undefined,
            locationId: m.locationId ?? undefined,
            lotId: m.lotId ?? undefined,
            actorType: ctx.actor.type,
            actorId: ctx.actor.id,
          });
          const sku = await skuById(tx, ctx.actor.orgId, m.itemId);
          if (m.quantityDelta > 0) removed.push({ sku, quantityThousandths: m.quantityDelta });
          else restored.push({ sku, quantityThousandths: -m.quantityDelta });
        }
        return {
          reversedMovements: runMovements.length,
          removedFinishedThousandths: removed.reduce((sum, r) => sum + r.quantityThousandths, 0),
          restoredComponents: restored,
          removedProduced: removed,
        };
      }),
  });


const productionRuns = (deps: ModuleDeps) =>
  defineCapability({
    id: "manufacturing.productionRuns",
    title: "Production run history",
    intent:
      "List past production runs (instant or work-order builds) with what was produced, which components were consumed, and the rolled-up cost",
    module: "manufacturing",
    risk: "read",
    permission: "manufacturing.read",
    input: z.object({ limit: z.number().int().min(1).max(100).default(25) }),
    output: z.object({
      runs: z.array(
        z.object({
          runRef: z.string(),
          workOrderNumber: z.number().nullable(),
          assemblySku: z.string(),
          producedThousandths: z.number(),
          consumed: z.array(z.object({ sku: z.string(), quantityThousandths: z.number() })),
          costRolledUpMinor: z.number(),
          reversed: z.boolean(),
          actorType: z.string(),
          createdAt: z.date(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      const rows = await deps.db
        .select()
        .from(stockMovements)
        .where(and(eq(stockMovements.orgId, ctx.actor.orgId), eq(stockMovements.refType, "production")))
        .orderBy(desc(stockMovements.createdAt))
        .limit(input.limit * 20);
      const byRef = new Map<string, typeof rows>();
      for (const r of rows) {
        if (!r.refId) continue;
        const list = byRef.get(r.refId) ?? [];
        list.push(r);
        byRef.set(r.refId, list);
      }
      const wos = await deps.db
        .select({ id: workOrders.id, number: workOrders.number })
        .from(workOrders)
        .where(eq(workOrders.orgId, ctx.actor.orgId));
      const woNumbers = new Map(wos.map((w) => [w.id, w.number]));
      const allItems = await deps.db.select({ id: items.id, sku: items.sku }).from(items).where(eq(items.orgId, ctx.actor.orgId));
      const skuOf = new Map(allItems.map((i) => [i.id, i.sku]));

      const reversalRefs = new Set(
        (
          await deps.db
            .select({ refId: stockMovements.refId })
            .from(stockMovements)
            .where(and(eq(stockMovements.orgId, ctx.actor.orgId), eq(stockMovements.refType, "production_reversal")))
        )
          .map((r) => r.refId)
          .filter((r): r is string => Boolean(r)),
      );
      const runs = [];
      for (const [runRef, movements] of [...byRef.entries()].slice(0, input.limit)) {
        const out = movements.find((m) => m.quantityDelta > 0);
        if (!out) continue;
        let costMinor = 0;
        for (const m of movements) {
          if (m.quantityDelta > 0) continue;
          // Reconstruct consumption value from stored per-movement costs.
          costMinor += Math.round((-m.quantityDelta * (m.unitCostMinor ?? out.unitCostMinor ?? 0)) / 1000);
        }
        runs.push({
          runRef,
          workOrderNumber: woNumbers.get(runRef) ?? null,
          assemblySku: skuOf.get(out.itemId) ?? String(out.itemId),
          producedThousandths: out.quantityDelta,
          consumed: movements
            .filter((m) => m.quantityDelta < 0)
            .map((m) => ({ sku: skuOf.get(m.itemId) ?? String(m.itemId), quantityThousandths: -m.quantityDelta })),
          costRolledUpMinor: costMinor,
          reversed: reversalRefs.has(runRef),
          actorType: out.actorType,
          createdAt: out.createdAt,
        });
      }
      return { runs };
    },
  });


const workOrdersList = (deps: ModuleDeps) =>
  defineCapability({
    id: "manufacturing.workOrdersList",
    title: "Work order list",
    intent:
      "Show planned production work orders with status, planned versus built quantities, and expected good output at yield",
    module: "manufacturing",
    risk: "read",
    permission: "manufacturing.read",
    input: z.object({
      status: z.enum(["draft", "released", "completed", "cancelled"]).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    output: z.object({
      workOrders: z.array(
        z.object({
          id: z.string(),
          number: z.number(),
          assemblySku: z.string(),
          status: z.string(),
          plannedQtyThousandths: z.number(),
          producedQtyThousandths: z.number(),
          yieldPctThousandths: z.number(),
          expectedGoodThousandths: z.number(),
          note: z.string().nullable(),
          createdAt: z.date(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      const conditions = [eq(workOrders.orgId, ctx.actor.orgId)];
      if (input.status) conditions.push(eq(workOrders.status, input.status));
      const rows = await deps.db
        .select({ wo: workOrders, sku: items.sku })
        .from(workOrders)
        .innerJoin(items, eq(workOrders.assemblyItemId, items.id))
        .where(and(...conditions))
        .orderBy(desc(workOrders.createdAt))
        .limit(input.limit);
      return {
        workOrders: rows.map(({ wo, sku }) => ({
          id: wo.id,
          number: wo.number,
          assemblySku: sku,
          status: wo.status,
          plannedQtyThousandths: wo.plannedQtyThousandths,
          producedQtyThousandths: wo.producedQtyThousandths,
          yieldPctThousandths: wo.yieldPctThousandths,
          expectedGoodThousandths: plannedGoodQuantity(wo.plannedQtyThousandths, wo.yieldPctThousandths),
          note: wo.note,
          createdAt: wo.createdAt,
        })),
      };
    },
  });

const bomTree = (deps: ModuleDeps) =>
  defineCapability({
    id: "manufacturing.bomTree",
    title: "BOM tree",
    intent:
      "Show an assembly's bill of materials as a nested multi-level tree with cumulatively scaled component quantities per level",
    module: "manufacturing",
    risk: "read",
    permission: "manufacturing.read",
    input: z.object({ assemblySku: z.string(), quantityThousandths: z.number().int().positive().default(1000) }),
    output: z.object({
      hasBom: z.boolean(),
      root: z.object({ sku: z.string(), name: z.string(), quantityThousandths: z.number(), children: z.array(z.unknown()) }),
    }),
    execute: async (ctx, input) => {
      const edges = await deps.db.select().from(bomLines).where(eq(bomLines.orgId, ctx.actor.orgId));
      const allItems = await deps.db
        .select({ id: items.id, sku: items.sku, name: items.name })
        .from(items)
        .where(eq(items.orgId, ctx.actor.orgId));
      const root = allItems.find((i) => i.sku === input.assemblySku);
      if (!root) throw new Error(`no item with SKU ${input.assemblySku}`);
      const byAssembly = new Map<string, typeof edges>();
      for (const e of edges) {
        const list = byAssembly.get(e.assemblyItemId) ?? [];
        list.push(e);
        byAssembly.set(e.assemblyItemId, list);
      }
      const itemOf = new Map(allItems.map((i) => [i.id, i]));
      const build = (
        itemId: string,
        qty: number,
        path: ReadonlySet<string>,
      ): { sku: string; name: string; quantityThousandths: number; children: unknown[] } => {
        const item = itemOf.get(itemId);
        const children = [];
        if (!path.has(itemId)) {
          const nextPath = new Set(path);
          nextPath.add(itemId);
          for (const e of byAssembly.get(itemId) ?? []) {
            children.push(build(e.componentItemId, Math.round((e.quantityThousandths * qty) / 1000), nextPath));
          }
        }
        return { sku: item?.sku ?? String(itemId), name: item?.name ?? "", quantityThousandths: qty, children };
      };
      const rootNode = build(root.id, input.quantityThousandths, new Set());
      return { hasBom: rootNode.children.length > 0, root: rootNode };
    },
  });


const costPreview = (deps: ModuleDeps) =>
  defineCapability({
    id: "manufacturing.costPreview",
    title: "Production cost preview",
    intent:
      "Preview what producing a quantity would consume and cost at current moving-average unit prices, including scrap allowances and expected yield loss, before posting anything",
    module: "manufacturing",
    risk: "read",
    permission: "manufacturing.read",
    input: z.object({
      assemblySku: z.string(),
      quantityThousandths: z.number().int().positive(),
      yieldPctThousandths: pctInput.optional(),
    }),
    output: z.object({
      plannedThousandths: z.number(),
      expectedGoodThousandths: z.number(),
      lines: z.array(
        z.object({
          sku: z.string(),
          name: z.string(),
          requiredThousandths: z.number(),
          unitCostMinor: z.number(),
          costMinor: z.number(),
        }),
      ),
      totalCostMinor: z.number(),
      resultingAvgFinishedUnitCostMinor: z.number(),
      producible: z.boolean(),
    }),
    execute: async (ctx, input) =>
      withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const assembly = await itemBySku(tx, ctx.actor.orgId, input.assemblySku);
        if (!assembly) throw new Error(`no item with SKU ${input.assemblySku}`);
        const prepared = await scrapAdjustedRequirements(tx, ctx.actor.orgId, assembly.id, input.quantityThousandths);
        if (!prepared) throw new Error(`${input.assemblySku} has no bill of materials`);
        const allItems = await tx.select({ id: items.id, sku: items.sku, name: items.name }).from(items).where(eq(items.orgId, ctx.actor.orgId));
        const itemOf = new Map(allItems.map((i) => [i.id, i]));

        const costs = new Map<string, number>();
        const onHandByItem = new Map<string, number>();
        for (const r of prepared.requirements) {
          costs.set(r.itemId, await avgUnitCost(tx, ctx.actor.orgId, r.itemId));
          onHandByItem.set(r.itemId, await stockOnHand(tx, ctx.actor.orgId, r.itemId));
        }
        const preview = previewProductionCost(prepared.requirements, costs);
        const check = checkAvailability(prepared.requirements, onHandByItem);
        return {
          plannedThousandths: input.quantityThousandths,
          expectedGoodThousandths: plannedGoodQuantity(input.quantityThousandths, input.yieldPctThousandths ?? 1_000_000),
          lines: preview.lines.map((l) => ({
            ...l,
            sku: itemOf.get(l.itemId)?.sku ?? String(l.itemId),
            name: itemOf.get(l.itemId)?.name ?? "",
          })),
          totalCostMinor: preview.totalCostMinor,
          resultingAvgFinishedUnitCostMinor:
            input.quantityThousandths > 0
              ? Math.round((preview.totalCostMinor * 1000) / input.quantityThousandths)
              : 0,
          producible: check.producible,
        };
      }),
  });


const lotTrace = (deps: ModuleDeps) =>
  defineCapability({
    id: "manufacturing.lotTrace",
    title: "Lot traceability",
    intent:
      "Trace a finished-goods lot upstream through every component lot that fed it, for recall investigations and supplier accountability",
    module: "manufacturing",
    risk: "read",
    permission: "manufacturing.read",
    input: z.object({ sku: z.string(), lotCode: z.string() }),
    output: z.object({
      found: z.boolean(),
      tree: z.array(z.object({ lotCode: z.string(), sku: z.string(), fedBy: z.array(z.unknown()) })),
    }),
    execute: async (ctx, input) =>
      withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const item = await itemBySku(tx, ctx.actor.orgId, input.sku);
        if (!item) throw new Error(`no item with SKU ${input.sku}`);
        const [lot] = await tx
          .select()
          .from(lots)
          .where(and(eq(lots.orgId, ctx.actor.orgId), eq(lots.itemId, item.id), eq(lots.lotCode, input.lotCode)))
          .limit(1);
        if (!lot) throw new Error(`no lot "${input.lotCode}" for ${input.sku}`);

        // Production movements carry the run reference; produced outputs
        // (delta > 0, lot set) consumed the component lots (delta < 0, lot
        // set) of the same run — that pairing forms the traceability edges.
        const prodMoves = await tx
          .select({ refId: stockMovements.refId, delta: stockMovements.quantityDelta, lotId: stockMovements.lotId })
          .from(stockMovements)
          .where(
            and(
              eq(stockMovements.orgId, ctx.actor.orgId),
              eq(stockMovements.refType, "production"),
              sql`${stockMovements.lotId} is not null`,
            ),
          );
        const byRef = new Map<string, { delta: number; lotId: string | null }[]>();
        for (const m of prodMoves) {
          if (!m.refId) continue;
          const list = byRef.get(m.refId) ?? [];
          list.push({ delta: m.delta, lotId: m.lotId });
          byRef.set(m.refId, list);
        }
        const edges: LotTraceEdge[] = [];
        for (const [ref, group] of byRef) {
          const outs = group.filter((g) => g.delta > 0 && g.lotId);
          const ins = group.filter((g) => g.delta < 0 && g.lotId);
          for (const o of outs) {
            for (const i of ins) {
              edges.push({ consumerLotId: o.lotId!, sourceLotId: i.lotId!, quantityThousandths: -i.delta, viaRef: ref.slice(0, 8) });
            }
          }
        }
        const trace = traceLotUpstream(edges, lot.id);

        const lotRows = await tx.select({ id: lots.id, itemId: lots.itemId, lotCode: lots.lotCode }).from(lots).where(eq(lots.orgId, ctx.actor.orgId));
        const codeOf = new Map(lotRows.map((l) => [l.id, l.lotCode]));
        const itemSkuOf = new Map<string, string>();
        for (const l of lotRows) itemSkuOf.set(l.id, l.itemId);
        const allItems = await tx.select({ id: items.id, sku: items.sku }).from(items).where(eq(items.orgId, ctx.actor.orgId));
        const skuByIdMap = new Map(allItems.map((i) => [i.id, i.sku]));
        const decorate = (node: ReturnType<typeof traceLotUpstream>): { lotCode: string; sku: string; fedBy: unknown[] } => ({
          lotCode: codeOf.get(node.lotId) ?? node.lotId,
          sku: (() => {
            const itemId = itemSkuOf.get(node.lotId);
            return itemId ? skuByIdMap.get(itemId) ?? "" : "";
          })(),
          fedBy: node.children.map(decorate),
        });
        return { found: true, tree: [decorate(trace)] };
      }),
  });

const deleteBom = (deps: ModuleDeps) =>
  defineCapability({
    id: "manufacturing.deleteBom",
    title: "Delete bill of materials",
    intent:
      "Remove an assembly's bill of materials entirely when the product is no longer built; production and work orders refuse assemblies without a BOM",
    module: "manufacturing",
    risk: "destructive",
    permission: "manufacturing.write",
    // No mechanical inverse: the previous component list is snapshotted into
    // the audit payload; redefinition via defineBom is the recovery path.
    input: z.object({ assemblySku: z.string() }),
    output: z.object({
      removedCount: z.number(),
      removedLines: z.array(
        z.object({ sku: z.string(), quantityThousandths: z.number(), scrapPctThousandths: z.number() }),
      ),
    }),
    execute: async (ctx, input) =>
      withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const assembly = await itemBySku(tx, ctx.actor.orgId, input.assemblySku);
        if (!assembly) throw new Error(`no item with SKU ${input.assemblySku}`);
        const removed = await tx
          .delete(bomLines)
          .where(and(eq(bomLines.orgId, ctx.actor.orgId), eq(bomLines.assemblyItemId, assembly.id)))
          .returning({
            sku: bomLines.componentItemId,
            quantityThousandths: bomLines.quantityThousandths,
            scrapPctThousandths: bomLines.scrapPctThousandths,
          });
        if (removed.length === 0) throw new Error(`${input.assemblySku} has no bill of materials`);
        // Resolve component SKUs for the audit snapshot.
        const allItems = await tx.select({ id: items.id, sku: items.sku }).from(items).where(eq(items.orgId, ctx.actor.orgId));
        const skuOf = new Map(allItems.map((i) => [i.id, i.sku]));
        return {
          removedCount: removed.length,
          removedLines: removed.map((r) => ({
            sku: skuOf.get(r.sku) ?? String(r.sku),
            quantityThousandths: r.quantityThousandths,
            scrapPctThousandths: r.scrapPctThousandths,
          })),
        };
      }),
  });



// ── M11: planning-lite — feasibility answers + lead-time memory ────────

const checkProductionFeasibility = (deps: ModuleDeps) =>
  defineCapability({
    id: "manufacturing.checkProductionFeasibility",
    title: "Check production feasibility",
    intent:
      "Answer can-we-produce-N with the arithmetic: BOM-explosed component needs versus stock, per-component shortfalls, the producible ceiling, and the estimated lead time",
    module: "manufacturing",
    risk: "read",
    permission: "manufacturing.read",
    input: z.object({
      assemblySku: z.string(),
      desiredUnitsThousandths: z.number().int().positive(),
    }),
    output: z.object({
      producible: z.boolean(),
      maxProducibleThousandths: z.number(),
      estimatedLeadTimeDays: z.number().nullable(),
      lines: z.array(
        z.object({
          itemId: z.string(),
          requiredThousandths: z.number(),
          onHandThousandths: z.number(),
          shortfallThousandths: z.number(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const assembly = await itemBySku(tx, ctx.actor.orgId, input.assemblySku);
        if (!assembly) throw new Error(`no item with sku ${input.assemblySku}`);
        const edges = await tx.select().from(bomLines).where(and(eq(bomLines.orgId, ctx.actor.orgId), eq(bomLines.assemblyItemId, assembly.id)));
        if (edges.length === 0) throw new Error(`item ${input.assemblySku} has no bill of materials; nothing to explode`);

        const requirements = explodeBom(
          edges.map((e) => ({ assemblyItemId: e.assemblyItemId, componentItemId: e.componentItemId, quantityThousandths: e.quantityThousandths })),
          assembly.id,
          input.desiredUnitsThousandths,
        );
        const onHand = new Map<string, number>();
        for (const r of requirements) {
          onHand.set(r.itemId, await stockOnHand(tx, ctx.actor.orgId, r.itemId));
        }
        const availability = checkAvailability(requirements, onHand);

        // Ceiling from per-unit needs (explode one unit, scrap applied at
        // the BOM edge level by explodeBom scaling — per-unit re-derivation
        // keeps the ceiling independent of the desired quantity).
        const perUnit = explodeBom(
          edges.map((e) => ({ assemblyItemId: e.assemblyItemId, componentItemId: e.componentItemId, quantityThousandths: e.quantityThousandths })),
          assembly.id,
          1_000,
        );
        const ceiling = maxProducibleUnits(
          perUnit.map((p) => ({ componentItemId: p.itemId, perUnitThousandths: p.quantityThousandths })),
          onHand,
        );

        const [lead] = await tx
          .select({
            avgDays: sql<number>`coalesce(avg(extract(epoch from (${workOrders.completedAt} - ${workOrders.releasedAt})) / 86400), 0)`,
          })
          .from(workOrders)
          .where(and(eq(workOrders.orgId, ctx.actor.orgId), eq(workOrders.assemblyItemId, assembly.id), eq(workOrders.status, "completed")));
        const avgDays = Number(lead?.avgDays ?? 0);

        return {
          producible: availability.producible,
          maxProducibleThousandths: ceiling,
          estimatedLeadTimeDays: avgDays > 0 ? Math.ceil(avgDays) : null,
          lines: availability.lines.map((l) => ({
            itemId: l.itemId,
            requiredThousandths: l.quantityThousandths,
            onHandThousandths: l.onHandThousandths,
            shortfallThousandths: l.shortfallThousandths,
          })),
        };
      });
    },
  });

export function registerManufacturingCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registerManufacturingWriteCapabilities(registry, deps);
  registry.register(productionRuns(deps));
  registry.register(workOrdersList(deps));
  registry.register(bomTree(deps));
  registry.register(checkProductionFeasibility(deps));
  registry.register(costPreview(deps));
  registry.register(defineBom(deps));
  registry.register(produceFromBom(deps));
  registry.register(bomReport(deps));
  registry.register(deleteBom(deps));
  registry.register(lotTrace(deps));
}


export function registerManufacturingWriteCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(createWorkOrder(deps));
  registry.register(releaseWorkOrder(deps));
  registry.register(completeWorkOrder(deps));
  registry.register(cancelWorkOrder(deps));
  registry.register(reverseProductionRun(deps));
}

// ── BOM ─────────────────────────────────────────────────────────────────

const defineBom = (deps: ModuleDeps) =>
  defineCapability({
    id: "manufacturing.defineBom",
    title: "Define bill of materials",
    intent:
      "Set or replace the component list for an assembled product so production can consume parts and build stock; cycles are rejected",
    module: "manufacturing",
    risk: "write",
    permission: "manufacturing.write",
    // No mechanical inverse: restoring a replaced BOM requires the previous
    // definition, which we deliberately snapshot into the proposal/audit
    // payload rather than a second capability call.
    input: z.object({
      assemblySku: z.string(),
      components: z
        .array(
          z.object({
            sku: z.string(),
            quantityThousandths: z.number().int().positive(),
            scrapPctThousandths: pctInput.default(0),
          }),
        )
        .min(1)
        .max(100),
    }),
    output: z.object({ assemblyItemId: z.string(), componentCount: z.number() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const assembly = await itemBySku(tx, ctx.actor.orgId, input.assemblySku);
        if (!assembly) throw new Error(`no item with SKU ${input.assemblySku}`);

        const resolved = new Map<string, string>();
        for (const c of input.components) {
          if (c.sku === input.assemblySku) throw new Error("an assembly cannot contain itself");
          const comp = await itemBySku(tx, ctx.actor.orgId, c.sku);
          if (!comp) throw new Error(`no item with SKU ${c.sku}`);
          resolved.set(c.sku, comp.id);
        }

        await tx.delete(bomLines).where(
          and(eq(bomLines.orgId, ctx.actor.orgId), eq(bomLines.assemblyItemId, assembly.id)),
        );
        await tx.insert(bomLines).values(
          input.components.map((c) => ({
            orgId: ctx.actor.orgId,
            assemblyItemId: assembly.id,
            componentItemId: resolved.get(c.sku)!,
            quantityThousandths: c.quantityThousandths,
            scrapPctThousandths: c.scrapPctThousandths,
          })),
        );

        // Cycle check over the whole graph this assembly participates in.
        const allEdges = await tx
          .select({
            assemblyItemId: bomLines.assemblyItemId,
            componentItemId: bomLines.componentItemId,
            quantityThousandths: bomLines.quantityThousandths,
          })
          .from(bomLines)
          .where(eq(bomLines.orgId, ctx.actor.orgId));
        try {
          explodeBom(allEdges, assembly.id, 1000);
        } catch (err) {
          throw new Error(`rejected: ${err instanceof Error ? err.message : "invalid bill of materials"}`);
        }
        return { assemblyItemId: assembly.id, componentCount: input.components.length };
      });
    },
  });


const produceFromBom = (deps: ModuleDeps) =>
  defineCapability({
    id: "manufacturing.produceFromBom",
    title: "Produce from BOM",
    intent:
      "Build a quantity of an assembled product by consuming its components at moving-average cost and adding finished units at rolled-up cost, refusing when parts are short",
    module: "manufacturing",
    risk: "write",
    permission: "manufacturing.write",
    inverse: {
      capabilityId: "manufacturing.reverseProductionRun",
      buildInput: (_input, output) => ({ runRef: (output as { runRef: string }).runRef }),
    },
    input: z.object({
      assemblySku: z.string(),
      quantityThousandths: z.number().int().positive().describe("assemblies to build, thousandths"),
      lotCode: z.string().min(1).max(40).optional().describe("assign the finished output to a production lot"),
    }),
    output: z.object({
      runRef: z.string(),
      producedThousandths: z.number(),
      consumedComponents: z.array(z.object({ sku: z.string(), quantityThousandths: z.number() })),
      costRolledUpMinor: z.number(),
    }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const assembly = await itemBySku(tx, ctx.actor.orgId, input.assemblySku);
        if (!assembly) throw new Error(`no item with SKU ${input.assemblySku}`);
        const prepared = await scrapAdjustedRequirements(tx, ctx.actor.orgId, assembly.id, input.quantityThousandths);
        if (!prepared) throw new Error(`${input.assemblySku} has no bill of materials; define one first`);

        const onHandByItem = new Map<string, number>();
        for (const r of prepared.requirements) {
          onHandByItem.set(r.itemId, await stockOnHand(tx, ctx.actor.orgId, r.itemId));
        }
        const check = checkAvailability(prepared.requirements, onHandByItem);
        if (!check.producible) {
          const short = check.lines
            .filter((l) => l.shortfallThousandths > 0)
            .map((l) => `${l.itemId} short ${(l.shortfallThousandths / 1000).toFixed(3)}`)
            .join("; ");
          throw new Error(`insufficient stock: ${short}`);
        }

        const runRef = crypto.randomUUID();
        let valueConsumedMinor = 0;
        const consumed = [];
        const outLotId = input.lotCode
          ? await getOrCreateLot(tx, ctx.actor.orgId, assembly.id, input.lotCode)
          : null;
        for (const req of prepared.requirements) {
          const unitCost = await avgUnitCost(tx, ctx.actor.orgId, req.itemId);
          valueConsumedMinor += Math.round((req.quantityThousandths * unitCost) / 1000);
          await recordStockMovement(tx, {
            orgId: ctx.actor.orgId,
            itemId: req.itemId,
            quantityDelta: -req.quantityThousandths,
            reason: "production",
            note: `consumed by production of ${input.assemblySku}`,
            refType: "production",
            refId: runRef,
            unitCostMinor: unitCost > 0 ? unitCost : undefined,
            actorType: ctx.actor.type,
            actorId: ctx.actor.id,
          });
          consumed.push({ itemId: req.itemId, quantityThousandths: req.quantityThousandths });
        }

        const rolledUnitCost =
          input.quantityThousandths > 0 ? Math.round((valueConsumedMinor * 1000) / input.quantityThousandths) : 0;
        await recordStockMovement(tx, {
          orgId: ctx.actor.orgId,
          itemId: assembly.id,
          quantityDelta: input.quantityThousandths,
          reason: "production",
          note: `produced from BOM (${consumed.length} component kinds)`,
          refType: "production",
          refId: runRef,
          unitCostMinor: rolledUnitCost > 0 ? rolledUnitCost : undefined,
          lotId: outLotId ?? undefined,
          actorType: ctx.actor.type,
          actorId: ctx.actor.id,
        });

        const allSkus = await tx.select({ id: items.id, sku: items.sku }).from(items).where(eq(items.orgId, ctx.actor.orgId));
        const skuOf = new Map(allSkus.map((i) => [i.id, i.sku]));
        return {
          runRef,
          producedThousandths: input.quantityThousandths,
          consumedComponents: consumed.map((c) => ({ sku: skuOf.get(c.itemId) ?? String(c.itemId), quantityThousandths: c.quantityThousandths })),
          costRolledUpMinor: valueConsumedMinor,
        };
      });
    },
  });


const bomReport = (deps: ModuleDeps) =>
  defineCapability({
    id: "manufacturing.bomReport",
    title: "BOM report",
    intent:
      "Show a product's bill of materials with exploded, scrap-adjusted component requirements and whether enough stock exists to build a given quantity",
    module: "manufacturing",
    risk: "read",
    permission: "manufacturing.read",
    input: z.object({
      assemblySku: z.string(),
      quantityThousandths: z.number().int().positive().default(1000),
    }),
    output: z.object({
      producible: z.boolean(),
      totalShortfallThousandths: z.number(),
      lines: z.array(
        z.object({
          sku: z.string(),
          name: z.string(),
          requiredThousandths: z.number(),
          onHandThousandths: z.number(),
          shortfallThousandths: z.number(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const assembly = await itemBySku(tx, ctx.actor.orgId, input.assemblySku);
        if (!assembly) throw new Error(`no item with SKU ${input.assemblySku}`);
        const prepared = await scrapAdjustedRequirements(tx, ctx.actor.orgId, assembly.id, input.quantityThousandths);
        if (!prepared) throw new Error(`${input.assemblySku} has no bill of materials`);

        const itemsById = new Map(
          (
            await tx.select({ id: items.id, sku: items.sku, name: items.name }).from(items).where(eq(items.orgId, ctx.actor.orgId))
          ).map((r) => [r.id, r]),
        );
        const onHandByItem = new Map<string, number>();
        for (const r of prepared.requirements) {
          onHandByItem.set(r.itemId, await stockOnHand(tx, ctx.actor.orgId, r.itemId));
        }
        const check = checkAvailability(prepared.requirements, onHandByItem);
        return {
          producible: check.producible,
          totalShortfallThousandths: check.totalShortfallThousandths,
          lines: check.lines.map((l) => ({
            sku: itemsById.get(l.itemId)?.sku ?? String(l.itemId),
            name: itemsById.get(l.itemId)?.name ?? "",
            requiredThousandths: l.quantityThousandths,
            onHandThousandths: l.onHandThousandths,
            shortfallThousandths: l.shortfallThousandths,
          })),
        };
      });
    },
  });

