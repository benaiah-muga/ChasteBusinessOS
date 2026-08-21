import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { customers, deals } from "@chaste/db";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";

export interface ModuleDeps {
  db: import("@chaste/db").Database["db"];
}

export const DEAL_STAGES = ["lead", "qualified", "proposal", "negotiation", "won", "lost"] as const;

/** Simple weighted-forecast probabilities per stage. */
const STAGE_WEIGHT: Record<(typeof DEAL_STAGES)[number], number> = {
  lead: 0.1,
  qualified: 0.3,
  proposal: 0.5,
  negotiation: 0.7,
  won: 1,
  lost: 0,
};

const createCustomer = (deps: ModuleDeps) =>
  defineCapability({
    id: "crm.createCustomer",
    title: "Create customer",
    intent: "Create a new customer record so invoices can be issued to them",
    module: "crm",
    risk: "write",
    permission: "crm.write",
    inverse: {
      capabilityId: "crm.deactivateCustomer",
      buildInput: (_input, output) => ({ customerId: (output as { customerId: string }).customerId }),
    },
    input: z.object({
      name: z.string().min(1).describe("Customer display name"),
      email: z.string().email().optional(),
    }),
    output: z.object({ customerId: z.string() }),
    execute: async (ctx, input) => {
      const [row] = await deps.db
        .insert(customers)
        .values({ orgId: ctx.actor.orgId, name: input.name, email: input.email ?? null })
        .returning({ id: customers.id });
      return { customerId: row!.id };
    },
  });

const deactivateCustomer = (deps: ModuleDeps) =>
  defineCapability({
    id: "crm.deactivateCustomer",
    title: "Deactivate customer",
    intent: "Soft-delete a customer; history stays intact. Inverse of createCustomer",
    module: "crm",
    risk: "write",
    permission: "crm.write",
    input: z.object({ customerId: z.string() }),
    output: z.object({ deactivated: z.boolean() }),
    execute: async (ctx, input) => {
      await deps.db
        .update(customers)
        .set({ deactivatedAt: ctx.now })
        .where(and(eq(customers.id, input.customerId), eq(customers.orgId, ctx.actor.orgId)));
      return { deactivated: true };
    },
  });

const listCustomers = (deps: ModuleDeps) =>
  defineCapability({
    id: "crm.listCustomers",
    title: "List customers",
    intent: "List active customers with names and emails, for lookup and reporting",
    module: "crm",
    risk: "read",
    permission: "crm.read",
    input: z.object({ query: z.string().optional() }),
    output: z.object({
      customers: z.array(z.object({ id: z.string(), name: z.string(), email: z.string().nullable() })),
    }),
    execute: async (ctx) => {
      const rows = await deps.db
        .select({ id: customers.id, name: customers.name, email: customers.email })
        .from(customers)
        .where(and(eq(customers.orgId, ctx.actor.orgId), isNull(customers.deactivatedAt)))
        .limit(100);
      return { customers: rows };
    },
  });

const createDeal = (deps: ModuleDeps) =>
  defineCapability({
    id: "crm.createDeal",
    title: "Create pipeline deal",
    intent: "Add an opportunity to the sales pipeline for a customer, with its estimated value",
    module: "crm",
    risk: "write",
    permission: "crm.write",
    input: z.object({
      title: z.string().min(1),
      customerId: z.string().optional(),
      valueMinor: z.number().int().nonnegative().default(0),
      note: z.string().max(2000).optional(),
    }),
    output: z.object({ dealId: z.string() }),
    execute: async (ctx, input) => {
      const [row] = await deps.db
        .insert(deals)
        .values({
          orgId: ctx.actor.orgId,
          title: input.title,
          customerId: input.customerId ?? null,
          valueMinor: input.valueMinor,
          note: input.note ?? null,
          createdByUserId: ctx.actor.type === "human" ? ctx.actor.id : null,
        })
        .returning({ id: deals.id });
      return { dealId: row!.id };
    },
  });

const moveDealStage = (deps: ModuleDeps) =>
  defineCapability({
    id: "crm.moveDealStage",
    title: "Move deal stage",
    intent: "Advance a pipeline deal to a new stage (e.g. lead → proposal, or mark won/lost)",
    module: "crm",
    risk: "write",
    permission: "crm.write",
    inverse: {
      capabilityId: "crm.moveDealStage",
      buildInput: (input) => ({ dealId: (input as { dealId: string }).dealId, stage: "previous" as never }),
    },
    input: z.object({
      dealId: z.string(),
      stage: z.enum(DEAL_STAGES),
    }),
    output: z.object({ moved: z.boolean(), stage: z.string() }),
    execute: async (ctx, input) => {
      await deps.db
        .update(deals)
        .set({ stage: input.stage, updatedAt: ctx.now })
        .where(and(eq(deals.id, input.dealId), eq(deals.orgId, ctx.actor.orgId)));
      return { moved: true, stage: input.stage };
    },
  });

const pipelineReport = (deps: ModuleDeps) =>
  defineCapability({
    id: "crm.pipelineReport",
    title: "Sales pipeline report",
    intent:
      "Summarize open deals by stage with total and weighted value, so you can forecast upcoming revenue",
    module: "crm",
    risk: "read",
    permission: "crm.read",
    input: z.object({}),
    output: z.object({
      stages: z.array(
        z.object({
          stage: z.string(),
          count: z.number(),
          totalMinor: z.number(),
          weightedMinor: z.number(),
        }),
      ),
      openValueMinor: z.number(),
      weightedForecastMinor: z.number(),
    }),
    execute: async (ctx) => {
      const rows = await deps.db
        .select({ stage: deals.stage, valueMinor: deals.valueMinor })
        .from(deals)
        .where(eq(deals.orgId, ctx.actor.orgId));
      const byStage = new Map<string, { count: number; totalMinor: number }>();
      let open = 0;
      let weighted = 0;
      for (const r of rows) {
        const entry = byStage.get(r.stage) ?? { count: 0, totalMinor: 0 };
        entry.count += 1;
        entry.totalMinor += r.valueMinor;
        byStage.set(r.stage, entry);
        if (r.stage !== "won" && r.stage !== "lost") {
          open += r.valueMinor;
          weighted += Math.round(r.valueMinor * (STAGE_WEIGHT[r.stage as keyof typeof STAGE_WEIGHT] ?? 0));
        }
      }
      return {
        stages: DEAL_STAGES.map((stage) => {
          const e = byStage.get(stage);
          return {
            stage,
            count: e?.count ?? 0,
            totalMinor: e?.totalMinor ?? 0,
            weightedMinor: Math.round((e?.totalMinor ?? 0) * STAGE_WEIGHT[stage]),
          };
        }),
        openValueMinor: open,
        weightedForecastMinor: weighted,
      };
    },
  });

export function registerCrmCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(createCustomer(deps));
  registry.register(deactivateCustomer(deps));
  registry.register(listCustomers(deps));
  registry.register(createDeal(deps));
  registry.register(moveDealStage(deps));
  registry.register(pipelineReport(deps));
}
