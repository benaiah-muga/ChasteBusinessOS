import type { Db } from "@chaste/db";
import { schema } from "@chaste/db";
import { defineCommand, defineQuery, type BusinessModule } from "@chaste/kernel";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

export function createPurchasingModule(db: Db): BusinessModule {
  return {
    manifest: {
      id: "purchasing",
      name: "Purchasing",
      version: "0.1.0",
      description: "Vendors and purchase orders",
      dependencies: [],
      permissions: ["pur.vendor.manage", "pur.po.manage", "pur.po.read"],
      capabilities: ["pur.orders"],
      specialist: {
        id: "purchasing",
        displayName: "Purchasing Agent",
        description: "Vendors and procurement",
        toolTags: ["purchasing"],
      },
    },
    register({ commands, queries }) {
      commands.register(
        defineCommand({
          name: "pur.vendor.create",
          permissions: ["pur.vendor.manage"],
          tags: ["purchasing"],
          input: z.object({ name: z.string().min(1), email: z.string().email().optional() }),
          output: z.object({ id: z.string(), name: z.string() }),
          handler: async (input, ctx, helpers) => {
            const tx = (helpers.db ?? db) as Db;
            const [row] = await tx
              .insert(schema.purVendors)
              .values({
                organizationId: ctx.actor.organizationId,
                name: input.name,
                email: input.email,
              })
              .returning();
            return { id: row!.id, name: row!.name };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "pur.po.create",
          permissions: ["pur.po.manage"],
          tags: ["purchasing"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            vendorId: z.string().uuid(),
            number: z.string().min(1),
            total: z.number().nonnegative().default(0),
          }),
          output: z.object({
            id: z.string(),
            number: z.string(),
            status: z.string(),
            total: z.string(),
          }),
          handler: async (input, ctx, helpers) => {
            const tx = (helpers.db ?? db) as Db;
            const [row] = await tx
              .insert(schema.purPurchaseOrders)
              .values({
                organizationId: ctx.actor.organizationId,
                vendorId: input.vendorId,
                number: input.number,
                total: input.total.toFixed(2),
                status: "draft",
              })
              .returning();
            await helpers.outbox.enqueue({
              id: crypto.randomUUID(),
              type: "pur.po.created",
              organizationId: ctx.actor.organizationId,
              occurredAt: ctx.now().toISOString(),
              payload: { poId: row!.id, number: row!.number },
              correlationId: ctx.requestId,
            });
            return {
              id: row!.id,
              number: row!.number,
              status: row!.status,
              total: row!.total,
            };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "pur.po.list",
          permissions: ["pur.po.read"],
          tags: ["purchasing"],
          input: z.object({}).default({}),
          output: z.object({
            vendors: z.array(z.object({ id: z.string(), name: z.string() })),
            orders: z.array(
              z.object({
                id: z.string(),
                number: z.string(),
                vendorId: z.string(),
                status: z.string(),
                total: z.string(),
              }),
            ),
          }),
          handler: async (_i, ctx) => {
            const org = ctx.actor.organizationId;
            const vendors = await db
              .select()
              .from(schema.purVendors)
              .where(eq(schema.purVendors.organizationId, org));
            const orders = await db
              .select()
              .from(schema.purPurchaseOrders)
              .where(eq(schema.purPurchaseOrders.organizationId, org))
              .orderBy(desc(schema.purPurchaseOrders.createdAt));
            return {
              vendors: vendors.map((v) => ({ id: v.id, name: v.name })),
              orders: orders.map((o) => ({
                id: o.id,
                number: o.number,
                vendorId: o.vendorId,
                status: o.status,
                total: o.total,
              })),
            };
          },
        }),
      );
    },
  };
}
