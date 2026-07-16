import {
  defineCommand,
  defineQuery,
  type BusinessModule,
  type ModuleManifest,
} from "@chaste/kernel";
import { z } from "zod";
import { type CustomerStore, InMemoryCustomerStore } from "./store.js";

export const demoCrmManifest: ModuleManifest = {
  id: "demo-crm",
  name: "Demo CRM",
  version: "0.1.0",
  description: "Thin CRM vertical slice: customers",
  dependencies: [],
  permissions: ["crm.customer.create", "crm.customer.read"],
  capabilities: ["crm.customers"],
  specialist: {
    id: "crm",
    displayName: "CRM Agent",
    description: "Customers and relationship data (scoped tools from this module).",
    toolTags: ["crm"],
  },
};

const customerSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  email: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  createdAt: z.string(),
});

export function createDemoCrmModule(store: CustomerStore = new InMemoryCustomerStore()): BusinessModule {
  return {
    manifest: demoCrmManifest,
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
            city: z.string().min(1).max(120).optional(),
          }),
          output: customerSchema,
          handler: async (input, ctx, helpers) => {
            const row = await store.create({
              organizationId: ctx.actor.organizationId,
              name: input.name,
              email: input.email,
              city: input.city,
            });
            await helpers.outbox.enqueue({
              id: crypto.randomUUID(),
              type: "crm.customer.created",
              organizationId: ctx.actor.organizationId,
              occurredAt: ctx.now().toISOString(),
              payload: { customerId: row.id, name: row.name },
              correlationId: ctx.requestId,
            });
            return row;
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "crm.customer.list",
          description: "List customers for the current organization",
          permissions: ["crm.customer.read"],
          tags: ["crm"],
          input: z.object({}).default({}),
          output: z.object({ items: z.array(customerSchema) }),
          handler: async (_input, ctx) => {
            const items = await store.list(ctx.actor.organizationId);
            return { items };
          },
        }),
      );
    },
  };
}

export { InMemoryCustomerStore };
export type { CustomerStore, CustomerRecord } from "./store.js";
