import type { Db } from "@chaste/db";
import { schema } from "@chaste/db";
import { defineCommand, defineQuery, type BusinessModule } from "@chaste/kernel";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

export function createManufacturingModule(db: Db): BusinessModule {
  return {
    manifest: {
      id: "manufacturing",
      name: "Manufacturing",
      version: "0.1.0",
      description: "BOMs and work orders",
      dependencies: ["inventory"],
      permissions: ["mfg.bom.manage", "mfg.wo.manage", "mfg.wo.read"],
      capabilities: ["mfg.production"],
      specialist: {
        id: "manufacturing",
        displayName: "Manufacturing Agent",
        description: "Bills of materials and work orders",
        toolTags: ["manufacturing"],
      },
    },
    register({ commands, queries }) {
      commands.register(
        defineCommand({
          name: "mfg.bom.create",
          permissions: ["mfg.bom.manage"],
          tags: ["manufacturing"],
          input: z.object({
            productId: z.string().uuid(),
            name: z.string().min(1),
            quantity: z.number().int().positive().default(1),
            components: z
              .array(
                z.object({
                  componentProductId: z.string().uuid(),
                  quantity: z.number().int().positive(),
                }),
              )
              .default([]),
          }),
          output: z.object({ id: z.string(), name: z.string() }),
          handler: async (input, ctx) => {
            const [bom] = await db
              .insert(schema.mfgBoms)
              .values({
                organizationId: ctx.actor.organizationId,
                productId: input.productId,
                name: input.name,
                quantity: input.quantity,
              })
              .returning();
            for (const c of input.components) {
              await db.insert(schema.mfgBomLines).values({
                bomId: bom!.id,
                componentProductId: c.componentProductId,
                quantity: c.quantity,
              });
            }
            return { id: bom!.id, name: bom!.name };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "mfg.wo.create",
          permissions: ["mfg.wo.manage"],
          tags: ["manufacturing"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            bomId: z.string().uuid(),
            number: z.string().min(1),
            quantity: z.number().int().positive().default(1),
          }),
          output: z.object({
            id: z.string(),
            number: z.string(),
            status: z.string(),
            quantity: z.number(),
          }),
          handler: async (input, ctx, helpers) => {
            const [row] = await db
              .insert(schema.mfgWorkOrders)
              .values({
                organizationId: ctx.actor.organizationId,
                bomId: input.bomId,
                number: input.number,
                quantity: input.quantity,
                status: "planned",
              })
              .returning();
            await helpers.outbox.enqueue({
              id: crypto.randomUUID(),
              type: "mfg.wo.created",
              organizationId: ctx.actor.organizationId,
              occurredAt: ctx.now().toISOString(),
              payload: { workOrderId: row!.id, number: row!.number },
              correlationId: ctx.requestId,
            });
            return {
              id: row!.id,
              number: row!.number,
              status: row!.status,
              quantity: row!.quantity,
            };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "mfg.overview",
          permissions: ["mfg.wo.read"],
          tags: ["manufacturing"],
          input: z.object({}).default({}),
          output: z.object({
            boms: z.array(z.object({ id: z.string(), name: z.string(), productId: z.string() })),
            workOrders: z.array(
              z.object({
                id: z.string(),
                number: z.string(),
                status: z.string(),
                quantity: z.number(),
              }),
            ),
          }),
          handler: async (_i, ctx) => {
            const org = ctx.actor.organizationId;
            const boms = await db
              .select()
              .from(schema.mfgBoms)
              .where(eq(schema.mfgBoms.organizationId, org));
            const workOrders = await db
              .select()
              .from(schema.mfgWorkOrders)
              .where(eq(schema.mfgWorkOrders.organizationId, org))
              .orderBy(desc(schema.mfgWorkOrders.createdAt));
            return {
              boms: boms.map((b) => ({ id: b.id, name: b.name, productId: b.productId })),
              workOrders: workOrders.map((w) => ({
                id: w.id,
                number: w.number,
                status: w.status,
                quantity: w.quantity,
              })),
            };
          },
        }),
      );
    },
  };
}
