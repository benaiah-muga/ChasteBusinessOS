import { and, eq, inArray, isNull, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { items } from "@chaste/db";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";
import { withOrgContext, type ModuleDeps } from "./shared";

/**
 * Product-surface capabilities (M7.3): identity beyond the SKU - image,
 * tags, and a scannable barcode. Barcode lookup fails honestly: a miss
 * returns `item: null`, never a guess.
 */

const patchSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  unitLabel: z.string().max(20).optional(),
  salePriceMinor: z.number().int().nonnegative().optional(),
  imageUrl: z.string().url().max(500).nullable().optional(),
  tags: z.array(z.string().min(1).max(30)).max(20).optional(),
  barcode: z.string().min(3).max(64).nullable().optional(),
});

const priorSchema = z.object({
  sku: z.string(),
  name: z.string().optional(),
  unitLabel: z.string().optional(),
  salePriceMinor: z.number().optional(),
  imageUrl: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  barcode: z.string().nullable().optional(),
});

function applyItemPatch(deps: ModuleDeps) {
  return async (ctx: { actor: { orgId: string } }, input: z.infer<typeof patchSchema>) => {
    const [item] = await deps.db
      .select()
      .from(items)
      .where(and(eq(items.orgId, ctx.actor.orgId), eq(items.sku, input.sku)))
      .limit(1);
    if (!item) throw new Error(`no item with SKU ${input.sku}`);
    if (input.barcode != null && input.barcode !== item.barcode) {
      const [dupe] = await deps.db
        .select({ id: items.id })
        .from(items)
        .where(and(eq(items.orgId, ctx.actor.orgId), eq(items.barcode, input.barcode)))
        .limit(1);
      if (dupe) throw new Error(`barcode "${input.barcode}" is already on another item`);
    }
    const prior: Record<string, unknown> = { sku: input.sku };
    const patch: Record<string, unknown> = {};
    for (const key of ["name", "unitLabel", "salePriceMinor", "imageUrl", "tags", "barcode"] as const) {
      if (input[key] !== undefined) {
        patch[key] = input[key];
        prior[key] = item[key];
      }
    }
    if (Object.keys(patch).length === 0) throw new Error("nothing to update");
    await deps.db.update(items).set(patch).where(eq(items.id, item.id));
    return { sku: input.sku, prior: prior as z.infer<typeof priorSchema> };
  };
}

const updateItem = (deps: ModuleDeps) =>
  defineCapability({
    id: "inventory.updateItem",
    title: "Update item details",
    intent:
      "Edit an item's name, unit label, selling price, image, tags, or barcode; the declared inverse restores the exact prior values",
    module: "inventory",
    risk: "write",
    permission: "inventory.write",
    inverse: {
      capabilityId: "inventory.restoreItem",
      buildInput: (_input, output) => output.prior,
    },
    input: patchSchema,
    output: z.object({ sku: z.string(), prior: priorSchema }),
    execute: async (ctx, input) => applyItemPatch(deps)(ctx, input),
  });

const restoreItem = (deps: ModuleDeps) =>
  defineCapability({
    id: "inventory.restoreItem",
    title: "Restore prior item details",
    intent:
      "Re-apply the prior snapshot captured by an item update, undoing that edit; restoring is itself a normal update and can be undone the same way",
    module: "inventory",
    risk: "write",
    permission: "inventory.write",
    // No mechanical inverse: restore captures its own prior in its output and
    // is undone by updateItem with it, which is the same mechanism.
    input: patchSchema,
    output: z.object({ sku: z.string(), prior: priorSchema }),
    execute: async (ctx, input) => applyItemPatch(deps)(ctx, input),
  });

const importedItemRow = z.object({
  rowNumber: z.number().int().positive(),
  sku: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["goods", "service"]).default("goods"),
  unitLabel: z.string().trim().min(1).max(20).default("unit"),
  salePriceMinor: z.number().int().nonnegative(),
  reorderPointThousandths: z.number().int().nonnegative().default(0),
  barcode: z.string().trim().min(3).max(64).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
});

const importItems = (deps: ModuleDeps) => defineCapability({
  id: "inventory.importItems",
  title: "Import reviewed catalog items",
  intent: "Add reviewed products and services from a mapped spreadsheet, skip duplicate codes or barcodes, and retain an undo path for the imported batch",
  module: "inventory",
  risk: "write",
  permission: "inventory.write",
  inverse: { capabilityId: "inventory.undoItemImport", buildInput: (_input, output) => ({ itemIds: output.createdIds }) },
  input: z.object({ rows: z.array(importedItemRow).min(1).max(5000) }),
  output: z.object({ createdIds: z.array(z.string().uuid()), imported: z.number().int(), skippedDuplicateRows: z.array(z.number().int()) }),
  execute: async (ctx, input) => withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
    const existing = await tx.select({ sku: items.sku, barcode: items.barcode }).from(items)
      .where(eq(items.orgId, ctx.actor.orgId));
    const seenSku = new Set(existing.map((row) => row.sku.trim().toLowerCase()));
    const seenBarcode = new Set(existing.map((row) => row.barcode?.trim().toLowerCase()).filter((value): value is string => Boolean(value)));
    const skippedDuplicateRows: number[] = [];
    const fresh: Array<z.infer<typeof importedItemRow>> = [];
    for (const row of input.rows) {
      const sku = row.sku.toLowerCase();
      const barcode = row.barcode?.trim().toLowerCase();
      if (seenSku.has(sku) || (barcode && seenBarcode.has(barcode))) {
        skippedDuplicateRows.push(row.rowNumber);
        continue;
      }
      seenSku.add(sku);
      if (barcode) seenBarcode.add(barcode);
      fresh.push(row);
    }
    const createdIds: string[] = [];
    for (let offset = 0; offset < fresh.length; offset += 500) {
      const inserted = await tx.insert(items).values(fresh.slice(offset, offset + 500).map((row) => ({
        orgId: ctx.actor.orgId,
        sku: row.sku,
        name: row.name,
        kind: row.kind,
        unitLabel: row.unitLabel,
        salePriceMinor: row.salePriceMinor,
        reorderPointThousandths: row.kind === "service" ? 0 : row.reorderPointThousandths,
        barcode: row.kind === "service" ? null : row.barcode ?? null,
        tags: row.tags,
      }))).returning({ id: items.id });
      createdIds.push(...inserted.map((row) => row.id));
    }
    return { createdIds, imported: createdIds.length, skippedDuplicateRows };
  }),
});

const undoItemImport = (deps: ModuleDeps) => defineCapability({
  id: "inventory.undoItemImport",
  title: "Undo catalog import",
  intent: "Archive only the items created by a recent spreadsheet import, preserving their references and any stock history",
  module: "inventory",
  risk: "write",
  permission: "inventory.write",
  inverse: { capabilityId: "inventory.restoreItemImport", buildInput: (_input, output) => ({ itemIds: output.itemIds }) },
  input: z.object({ itemIds: z.array(z.string().uuid()).min(1).max(5000) }),
  output: z.object({ itemIds: z.array(z.string().uuid()), archived: z.number().int() }),
  execute: async (ctx, input) => withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
    const changed = await tx.update(items).set({ archivedAt: ctx.now })
      .where(and(eq(items.orgId, ctx.actor.orgId), inArray(items.id, [...new Set(input.itemIds)]), isNull(items.archivedAt)))
      .returning({ id: items.id });
    return { itemIds: changed.map((row) => row.id), archived: changed.length };
  }),
});

const restoreItemImport = (deps: ModuleDeps) => defineCapability({
  id: "inventory.restoreItemImport",
  title: "Restore imported catalog items",
  intent: "Restore catalog items after reversing an import undo while keeping item identity and stock history intact",
  module: "inventory",
  risk: "write",
  permission: "inventory.write",
  inverse: { capabilityId: "inventory.undoItemImport", buildInput: (_input, output) => ({ itemIds: output.itemIds }) },
  input: z.object({ itemIds: z.array(z.string().uuid()).min(1).max(5000) }),
  output: z.object({ itemIds: z.array(z.string().uuid()), restored: z.number().int() }),
  execute: async (ctx, input) => withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
    const changed = await tx.update(items).set({ archivedAt: null })
      .where(and(eq(items.orgId, ctx.actor.orgId), inArray(items.id, [...new Set(input.itemIds)]), isNotNull(items.archivedAt)))
      .returning({ id: items.id });
    return { itemIds: changed.map((row) => row.id), restored: changed.length };
  }),
});

const lookupByBarcode = (deps: ModuleDeps) =>
  defineCapability({
    id: "inventory.lookupByBarcode",
    title: "Look up item by barcode",
    intent:
      "Find the stocked item a barcode belongs to, for scanning at receiving, delivery, or the register; unknown barcodes answer an explicit null, never a guess",
    module: "inventory",
    risk: "read",
    permission: "inventory.read",
    input: z.object({ barcode: z.string().min(3).max(64) }),
    output: z.object({
      item: z
        .object({
          id: z.string(),
          sku: z.string(),
          name: z.string(),
          unitLabel: z.string(),
          imageUrl: z.string().nullable(),
          tags: z.array(z.string()),
        })
        .nullable(),
    }),
    execute: async (ctx, input) => {
      const [row] = await deps.db
        .select({
          id: items.id,
          sku: items.sku,
          name: items.name,
          unitLabel: items.unitLabel,
          imageUrl: items.imageUrl,
          tags: items.tags,
        })
        .from(items)
        .where(and(eq(items.orgId, ctx.actor.orgId), eq(items.barcode, input.barcode)))
        .limit(1);
      return { item: row ?? null };
    },
  });

export function registerItemCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(updateItem(deps));
  registry.register(restoreItem(deps));
  registry.register(importItems(deps));
  registry.register(undoItemImport(deps));
  registry.register(restoreItemImport(deps));
  registry.register(lookupByBarcode(deps));
}
