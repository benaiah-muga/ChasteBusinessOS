import type { Db } from "@chaste/db";
import { schema } from "@chaste/db";
import { defineCommand, defineQuery, type BusinessModule } from "@chaste/kernel";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

const customerSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  email: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  status: z.string(),
  createdAt: z.string(),
});

function mapCustomer(row: typeof schema.crmCustomers.$inferSelect) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    email: row.email,
    city: row.city,
    country: row.country,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createCrmModule(db: Db): BusinessModule {
  return {
    manifest: {
      id: "crm",
      name: "CRM",
      version: "0.1.0",
      description: "Customer relationship management",
      dependencies: [],
      permissions: ["crm.customer.create", "crm.customer.read"],
      capabilities: ["crm.customers"],
      specialist: {
        id: "crm",
        displayName: "CRM Agent",
        description: "Customers and relationship data",
        toolTags: ["crm"],
      },
    },
    register({ commands, queries }) {
      commands.register(
        defineCommand({
          name: "crm.customer.create",
          description: "Create a customer",
          permissions: ["crm.customer.create"],
          tags: ["crm"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            name: z.string().min(1).max(200),
            email: z.string().email().optional(),
            city: z.string().max(120).optional(),
            country: z.string().max(120).optional(),
          }),
          output: customerSchema,
          handler: async (input, ctx, helpers) => {
            const [row] = await db
              .insert(schema.crmCustomers)
              .values({
                organizationId: ctx.actor.organizationId,
                name: input.name,
                email: input.email,
                city: input.city,
                country: input.country,
              })
              .returning();
            await helpers.outbox.enqueue({
              id: crypto.randomUUID(),
              type: "crm.customer.created",
              organizationId: ctx.actor.organizationId,
              occurredAt: ctx.now().toISOString(),
              payload: { customerId: row!.id, name: row!.name },
              correlationId: ctx.requestId,
            });
            return mapCustomer(row!);
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "crm.customer.list",
          permissions: ["crm.customer.read"],
          tags: ["crm"],
          input: z.object({}).default({}),
          output: z.object({ items: z.array(customerSchema) }),
          handler: async (_i, ctx) => {
            const rows = await db
              .select()
              .from(schema.crmCustomers)
              .where(eq(schema.crmCustomers.organizationId, ctx.actor.organizationId))
              .orderBy(desc(schema.crmCustomers.createdAt));
            return { items: rows.map(mapCustomer) };
          },
        }),
      );
    },
  };
}
