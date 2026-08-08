import type { Db } from "@chaste/db";
import { schema } from "@chaste/db";
import { defineCommand, defineQuery, type BusinessModule } from "@chaste/kernel";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

export function createInventoryModule(db: Db): BusinessModule {
  return {
    manifest: {
      id: "inventory",
      name: "Inventory",
      version: "0.1.0",
      description: "Warehouses, products, stock",
      dependencies: [],
      permissions: [
        "inv.warehouse.manage",
        "inv.product.manage",
        "inv.stock.move",
        "inv.stock.read",
      ],
      capabilities: ["inv.stock"],
      specialist: {
        id: "inventory",
        displayName: "Inventory Agent",
        description: "Stock levels, warehouses, products",
        toolTags: ["inventory"],
      },
    },
    register({ commands, queries }) {
      commands.register(
        defineCommand({
          name: "inv.warehouse.create",
          permissions: ["inv.warehouse.manage"],
          tags: ["inventory"],
          input: z.object({
            code: z.string().min(1).max(32),
            name: z.string().min(1),
            city: z.string().optional(),
          }),
          output: z.object({ id: z.string(), code: z.string(), name: z.string() }),
          handler: async (input, ctx, helpers) => {
            const tx = (helpers.db ?? db) as Db;
            const [row] = await tx
              .insert(schema.invWarehouses)
              .values({
                organizationId: ctx.actor.organizationId,
                code: input.code,
                name: input.name,
                city: input.city,
              })
              .returning();
            return { id: row!.id, code: row!.code, name: row!.name };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "inv.product.create",
          permissions: ["inv.product.manage"],
          tags: ["inventory"],
          input: z.object({
            sku: z.string().min(1),
            name: z.string().min(1),
            uom: z.string().default("ea"),
            reorderLevel: z.number().int().nonnegative().default(0),
          }),
          output: z.object({ id: z.string(), sku: z.string(), name: z.string() }),
          handler: async (input, ctx, helpers) => {
            const tx = (helpers.db ?? db) as Db;
            const [row] = await tx
              .insert(schema.invProducts)
              .values({
                organizationId: ctx.actor.organizationId,
                sku: input.sku,
                name: input.name,
                uom: input.uom,
                reorderLevel: input.reorderLevel,
              })
              .returning();
            return { id: row!.id, sku: row!.sku, name: row!.name };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "inv.stock.adjust",
          permissions: ["inv.stock.move"],
          tags: ["inventory"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            warehouseId: z.string().uuid(),
            productId: z.string().uuid(),
            quantityDelta: z.number().int(),
            reason: z.string().min(1),
            reference: z.string().optional(),
          }),
          output: z.object({
            warehouseId: z.string(),
            productId: z.string(),
            quantity: z.number(),
          }),
          handler: async (input, ctx, helpers) => {
            const tx = (helpers.db ?? db) as Db;
            const [existing] = await tx
              .select()
              .from(schema.invStockLevels)
              .where(
                and(
                  eq(schema.invStockLevels.warehouseId, input.warehouseId),
                  eq(schema.invStockLevels.productId, input.productId),
                ),
              )
              .limit(1);

            let quantity: number;
            if (existing) {
              quantity = existing.quantity + input.quantityDelta;
              await tx
                .update(schema.invStockLevels)
                .set({ quantity, updatedAt: new Date() })
                .where(eq(schema.invStockLevels.id, existing.id));
            } else {
              quantity = input.quantityDelta;
              await tx.insert(schema.invStockLevels).values({
                organizationId: ctx.actor.organizationId,
                warehouseId: input.warehouseId,
                productId: input.productId,
                quantity,
              });
            }

            await tx.insert(schema.invStockMoves).values({
              organizationId: ctx.actor.organizationId,
              warehouseId: input.warehouseId,
              productId: input.productId,
              quantity: input.quantityDelta,
              reason: input.reason,
              reference: input.reference,
            });

            await helpers.outbox.enqueue({
              id: crypto.randomUUID(),
              type: "inv.stock.adjusted",
              organizationId: ctx.actor.organizationId,
              occurredAt: ctx.now().toISOString(),
              payload: {
                warehouseId: input.warehouseId,
                productId: input.productId,
                quantity,
                delta: input.quantityDelta,
              },
              correlationId: ctx.requestId,
            });

            return {
              warehouseId: input.warehouseId,
              productId: input.productId,
              quantity,
            };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "inv.stock.list",
          permissions: ["inv.stock.read"],
          tags: ["inventory"],
          input: z.object({}).default({}),
          output: z.object({
            warehouses: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })),
            products: z.array(z.object({ id: z.string(), sku: z.string(), name: z.string() })),
            levels: z.array(
              z.object({
                warehouseId: z.string(),
                productId: z.string(),
                quantity: z.number(),
              }),
            ),
          }),
          handler: async (_i, ctx) => {
            const org = ctx.actor.organizationId;
            const warehouses = await db
              .select()
              .from(schema.invWarehouses)
              .where(eq(schema.invWarehouses.organizationId, org));
            const products = await db
              .select()
              .from(schema.invProducts)
              .where(eq(schema.invProducts.organizationId, org));
            const levels = await db
              .select()
              .from(schema.invStockLevels)
              .where(eq(schema.invStockLevels.organizationId, org));
            return {
              warehouses: warehouses.map((w) => ({ id: w.id, code: w.code, name: w.name })),
              products: products.map((p) => ({ id: p.id, sku: p.sku, name: p.name })),
              levels: levels.map((l) => ({
                warehouseId: l.warehouseId,
                productId: l.productId,
                quantity: l.quantity,
              })),
            };
          },
        }),
      );
    },
  };
}
