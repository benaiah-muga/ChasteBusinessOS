import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { items, stockLocations, stockTransferLines, stockTransfers } from "@chaste/db";
import { assertTransferFeasible, transferLegs } from "@chaste/erp-core";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";
import {
  getOrCreateLot,
  recordStockMovement,
  stockOnHand,
  withOrgContext,
  type DbLike,
  type ModuleDeps,
} from "./shared";

/**
 * Internal transfers (M7.2). Quantity is conserved by construction — every
 * confirmed line writes paired out/in legs through the shared ledger writer
 * with reason "transfer" — and value is untouched: transfer legs are
 * value-neutral in valuation replay (ADR 0033), so round trips cannot drift
 * the moving average.
 */

async function nextTransferNumber(tx: DbLike, orgId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number>`coalesce(max(${stockTransfers.number}), 0)` })
    .from(stockTransfers)
    .where(eq(stockTransfers.orgId, orgId));
  return Number(row?.max ?? 0) + 1;
}

async function locationIdByCode(tx: DbLike, orgId: string, code: string): Promise<string> {
  const [loc] = await tx
    .select({ id: stockLocations.id })
    .from(stockLocations)
    .where(and(eq(stockLocations.orgId, orgId), eq(stockLocations.code, code)))
    .limit(1);
  if (!loc) throw new Error(`no location with code ${code}`);
  return loc.id;
}

const lineInput = z.object({
  sku: z.string().min(1),
  quantityThousandths: z.number().int().positive(),
  lotCode: z.string().min(1).max(40).optional(),
});

const createTransfer = (deps: ModuleDeps) =>
  defineCapability({
    id: "inventory.createTransfer",
    title: "Create stock transfer",
    intent:
      "Draft a relocation of stock between two named locations; nothing moves until the transfer is confirmed, and the draft can still be cancelled",
    module: "inventory",
    risk: "write",
    permission: "inventory.write",
    inverse: {
      capabilityId: "inventory.cancelTransfer",
      buildInput: (_input, output) => ({ transferId: (output as { transferId: string }).transferId }),
    },
    input: z.object({
      fromLocationCode: z.string().min(1).max(20),
      toLocationCode: z.string().min(1).max(20),
      lines: z.array(lineInput).min(1).max(50),
      note: z.string().max(300).optional(),
    }),
    output: z.object({ transferId: z.string(), number: z.number(), status: z.string() }),
    execute: async (ctx, input) =>
      withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        if (input.fromLocationCode === input.toLocationCode) {
          throw new Error("source and destination locations must differ");
        }
        const fromLocationId = await locationIdByCode(tx, ctx.actor.orgId, input.fromLocationCode);
        const toLocationId = await locationIdByCode(tx, ctx.actor.orgId, input.toLocationCode);
        for (const line of input.lines) {
          const [item] = await tx
            .select({ id: items.id })
            .from(items)
            .where(and(eq(items.orgId, ctx.actor.orgId), eq(items.sku, line.sku)))
            .limit(1);
          if (!item) throw new Error(`no item with SKU ${line.sku}`);
        }
        const number = await nextTransferNumber(tx, ctx.actor.orgId);
        const [transfer] = await tx
          .insert(stockTransfers)
          .values({
            orgId: ctx.actor.orgId,
            number,
            fromLocationId,
            toLocationId,
            note: input.note ?? null,
            createdByActorType: ctx.actor.type,
            createdByActorId: ctx.actor.id,
          })
          .returning({ id: stockTransfers.id });
        for (const line of input.lines) {
          const [item] = await tx
            .select({ id: items.id })
            .from(items)
            .where(and(eq(items.orgId, ctx.actor.orgId), eq(items.sku, line.sku)))
            .limit(1);
          const lotId = line.lotCode
            ? await getOrCreateLot(tx, ctx.actor.orgId, item!.id, line.lotCode)
            : null;
          await tx.insert(stockTransferLines).values({
            orgId: ctx.actor.orgId,
            transferId: transfer!.id,
            itemId: item!.id,
            quantityThousandths: line.quantityThousandths,
            lotId,
          });
        }
        return { transferId: transfer!.id, number, status: "pending" };
      }),
  });

/** Confirms `quantityThousandths` of one line, writing the paired legs. */
async function confirmLine(
  tx: DbLike,
  orgId: string,
  transfer: { id: string; fromLocationId: string; toLocationId: string },
  line: { id: string; itemId: string; lotId: string | null; quantityThousandths: number; confirmedThousandths: number },
  quantityThousandths: number,
  actor: { type: "human" | "agent" | "system"; id: string | null },
): Promise<void> {
  const remaining = line.quantityThousandths - line.confirmedThousandths;
  if (quantityThousandths <= 0 || quantityThousandths > remaining) {
    throw new Error(`confirm quantity must be between 1 and ${remaining} thousandths for this line`);
  }
  const atSource = await stockOnHand(tx, orgId, line.itemId, transfer.fromLocationId);
  assertTransferFeasible(atSource, quantityThousandths);
  const legs = transferLegs(quantityThousandths);
  await recordStockMovement(tx, {
    orgId,
    itemId: line.itemId,
    quantityDelta: legs.out,
    reason: "transfer",
    refType: "stock_transfer",
    refId: transfer.id,
    locationId: transfer.fromLocationId,
    lotId: line.lotId ?? undefined,
    actorType: actor.type,
    actorId: actor.id,
  });
  await recordStockMovement(tx, {
    orgId,
    itemId: line.itemId,
    quantityDelta: legs.inn,
    reason: "transfer",
    refType: "stock_transfer",
    refId: transfer.id,
    locationId: transfer.toLocationId,
    lotId: line.lotId ?? undefined,
    actorType: actor.type,
    actorId: actor.id,
  });
  await tx
    .update(stockTransferLines)
    .set({ confirmedThousandths: line.confirmedThousandths + quantityThousandths })
    .where(eq(stockTransferLines.id, line.id));
}

const confirmTransfer = (deps: ModuleDeps) =>
  defineCapability({
    id: "inventory.confirmTransfer",
    title: "Confirm stock transfer",
    intent:
      "Move the stock: write the paired out/in ledger legs for a transfer, fully or line-by-line for partial confirmations; source location availability is enforced",
    module: "inventory",
    risk: "write",
    permission: "inventory.write",
    inverse: {
      capabilityId: "inventory.reverseTransfer",
      buildInput: (_input, output) => ({ transferId: (output as { transferId: string }).transferId }),
    },
    input: z.object({
      transferId: z.string().uuid(),
      lines: z
        .array(z.object({ lineId: z.string().uuid(), quantityThousandths: z.number().int().positive() }))
        .max(50)
        .optional()
        .describe("partial confirmation; omitted lines confirm their remaining quantity"),
    }),
    output: z.object({
      transferId: z.string(),
      status: z.string(),
      confirmedNowThousandths: z.number(),
    }),
    execute: async (ctx, input) =>
      withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [transfer] = await tx
          .select()
          .from(stockTransfers)
          .where(and(eq(stockTransfers.orgId, ctx.actor.orgId), eq(stockTransfers.id, input.transferId)))
          .limit(1);
        if (!transfer) throw new Error(`no transfer ${input.transferId}`);
        if (transfer.status === "confirmed") throw new Error("transfer is already fully confirmed");
        if (transfer.status !== "pending" && transfer.status !== "partial") {
          throw new Error(`transfer is ${transfer.status}; only pending or partial transfers can be confirmed`);
        }
        const lines = await tx
          .select()
          .from(stockTransferLines)
          .where(eq(stockTransferLines.transferId, transfer.id));
        const overrides = new Map((input.lines ?? []).map((l) => [l.lineId, l.quantityThousandths]));
        let confirmedNow = 0;
        for (const line of lines) {
          const quantity = overrides.get(line.id) ?? line.quantityThousandths - line.confirmedThousandths;
          overrides.delete(line.id);
          if (line.confirmedThousandths >= line.quantityThousandths) continue;
          await confirmLine(
            tx,
            ctx.actor.orgId,
            { id: transfer.id, fromLocationId: transfer.fromLocationId, toLocationId: transfer.toLocationId },
            line,
            quantity,
            { type: ctx.actor.type, id: ctx.actor.id },
          );
          confirmedNow += quantity;
        }
        if (overrides.size > 0) throw new Error("confirmation references a line that does not belong to this transfer");
        const refreshed = await tx
          .select({ confirmed: stockTransferLines.confirmedThousandths, quantity: stockTransferLines.quantityThousandths })
          .from(stockTransferLines)
          .where(eq(stockTransferLines.transferId, transfer.id));
        const fullyConfirmed = refreshed.every((l) => l.confirmed >= l.quantity);
        const status = fullyConfirmed ? "confirmed" : "partial";
        await tx
          .update(stockTransfers)
          .set({ status, confirmedAt: fullyConfirmed ? new Date() : null })
          .where(eq(stockTransfers.id, transfer.id));
        return { transferId: transfer.id, status, confirmedNowThousandths: confirmedNow };
      }),
  });

const cancelTransfer = (deps: ModuleDeps) =>
  defineCapability({
    id: "inventory.cancelTransfer",
    title: "Cancel stock transfer",
    intent:
      "Cancel a transfer draft that has not moved anything yet; once any quantity is confirmed the transfer must be reversed instead of cancelled",
    module: "inventory",
    risk: "write",
    permission: "inventory.write",
    // No mechanical inverse: cancelling an untouched draft is itself the
    // compensation; the stock never moved and a new draft re-creates it.
    input: z.object({ transferId: z.string().uuid() }),
    output: z.object({ cancelled: z.boolean() }),
    execute: async (ctx, input) =>
      withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [transfer] = await tx
          .select()
          .from(stockTransfers)
          .where(and(eq(stockTransfers.orgId, ctx.actor.orgId), eq(stockTransfers.id, input.transferId)))
          .limit(1);
        if (!transfer) throw new Error(`no transfer ${input.transferId}`);
        if (transfer.status !== "pending") {
          throw new Error(`transfer is ${transfer.status}; only untouched drafts can be cancelled — reverse it instead`);
        }
        const movedRows = await tx
          .select({ moved: sql<number>`coalesce(sum(${stockTransferLines.confirmedThousandths}), 0)` })
          .from(stockTransferLines)
          .where(eq(stockTransferLines.transferId, transfer.id));
        if (Number(movedRows[0]?.moved ?? 0) > 0) {
          throw new Error("quantity already moved; reverse the transfer instead");
        }
        await tx
          .update(stockTransfers)
          .set({ status: "cancelled", cancelledAt: new Date() })
          .where(eq(stockTransfers.id, transfer.id));
        return { cancelled: true };
      }),
  });

const reverseTransfer = (deps: ModuleDeps) =>
  defineCapability({
    id: "inventory.reverseTransfer",
    title: "Reverse stock transfer",
    intent:
      "Undo a confirmed transfer by moving the confirmed quantities back in one mirroring transfer, marking the original reversed; each transfer may be reversed once",
    module: "inventory",
    risk: "write",
    permission: "inventory.write",
    // Reversing the reversal is a fresh transfer; no further inverse.
    input: z.object({ transferId: z.string().uuid() }),
    output: z.object({ reversed: z.boolean(), reversalTransferId: z.string() }),
    execute: async (ctx, input) =>
      withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [transfer] = await tx
          .select()
          .from(stockTransfers)
          .where(and(eq(stockTransfers.orgId, ctx.actor.orgId), eq(stockTransfers.id, input.transferId)))
          .limit(1);
        if (!transfer) throw new Error(`no transfer ${input.transferId}`);
        const [already] = await tx
          .select({ id: stockTransfers.id })
          .from(stockTransfers)
          .where(and(eq(stockTransfers.orgId, ctx.actor.orgId), eq(stockTransfers.reversalOfId, input.transferId)))
          .limit(1);
        if (already) throw new Error(`transfer ${input.transferId} has already been reversed`);
        if (transfer.status !== "confirmed" && transfer.status !== "partial") {
          throw new Error(`transfer is ${transfer.status}; only moved transfers can be reversed`);
        }
        const lines = await tx
          .select()
          .from(stockTransferLines)
          .where(eq(stockTransferLines.transferId, transfer.id));
        const moved = lines.filter((l) => l.confirmedThousandths > 0);
        if (moved.length === 0) throw new Error("nothing was confirmed; cancel the draft instead");

        const number = await nextTransferNumber(tx, ctx.actor.orgId);
        const [mirror] = await tx
          .insert(stockTransfers)
          .values({
            orgId: ctx.actor.orgId,
            number,
            fromLocationId: transfer.toLocationId,
            toLocationId: transfer.fromLocationId,
            status: "confirmed",
            note: `Reversal of transfer #${transfer.number}`,
            reversalOfId: transfer.id,
            createdByActorType: ctx.actor.type,
            createdByActorId: ctx.actor.id,
            confirmedAt: new Date(),
          })
          .returning({ id: stockTransfers.id });
        for (const line of moved) {
          const [mirrorLine] = await tx
            .insert(stockTransferLines)
            .values({
              orgId: ctx.actor.orgId,
              transferId: mirror!.id,
              itemId: line.itemId,
              quantityThousandths: line.confirmedThousandths,
              lotId: line.lotId,
            })
            .returning({ id: stockTransferLines.id });
          await confirmLine(
            tx,
            ctx.actor.orgId,
            { id: mirror!.id, fromLocationId: transfer.toLocationId, toLocationId: transfer.fromLocationId },
            { ...line, id: mirrorLine!.id, confirmedThousandths: 0 },
            line.confirmedThousandths,
            { type: ctx.actor.type, id: ctx.actor.id },
          );
        }
        await tx.update(stockTransfers).set({ status: "reversed" }).where(eq(stockTransfers.id, transfer.id));
        return { reversed: true, reversalTransferId: mirror!.id };
      }),
  });

const listTransfers = (deps: ModuleDeps) =>
  defineCapability({
    id: "inventory.listTransfers",
    title: "List stock transfers",
    intent:
      "Show stock transfers with route, status, and notes so pending relocations and their history stay visible alongside the stock ledger",
    module: "inventory",
    risk: "read",
    permission: "inventory.read",
    input: z.object({ openOnly: z.boolean().default(false) }),
    output: z.object({
      transfers: z.array(
        z.object({
          id: z.string(),
          number: z.number(),
          status: z.string(),
          note: z.string().nullable(),
          createdAt: z.date(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      const conditions = [eq(stockTransfers.orgId, ctx.actor.orgId)];
      if (input.openOnly) {
        conditions.push(sql`${stockTransfers.status} IN ('pending', 'partial')` as never);
      }
      const rows = await deps.db
        .select({
          id: stockTransfers.id,
          number: stockTransfers.number,
          status: stockTransfers.status,
          note: stockTransfers.note,
          createdAt: stockTransfers.createdAt,
        })
        .from(stockTransfers)
        .where(and(...conditions))
        .orderBy(desc(stockTransfers.createdAt))
        .limit(100);
      return { transfers: rows };
    },
  });

export function registerTransfersCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(createTransfer(deps));
  registry.register(confirmTransfer(deps));
  registry.register(cancelTransfer(deps));
  registry.register(reverseTransfer(deps));
  registry.register(listTransfers(deps));
}



