import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { items } from "@chaste/db";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";
import type { ModuleDeps } from "./shared";

/**
 * Product-surface capabilities (M7.3): identity beyond the SKU — image,
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
      buildInput: (_input, output) => (output as { prior: unknown }).prior as Record<string, unknown>,
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
  registry.register(lookupByBarcode(deps));
}

