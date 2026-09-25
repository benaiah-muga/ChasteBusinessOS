import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { customers, deals, documents, invoices, memberships, payments, quotes, tasks } from "@chaste/db";
import type { Database } from "@chaste/db";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";
import { findDuplicate } from "@chaste/erp-core";

export interface ModuleDeps {
  db: Database["db"];
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
      buildInput: (_input, output) => ({ customerId: output.customerId }),
    },
    input: z.object({
      name: z.string().min(1).describe("Customer display name"),
      email: z.string().email().optional(),
    }),
    output: z.object({
      customerId: z.string(),
      /** Present when an existing customer looks like the same one - never a refusal. */
      duplicateWarning: z.string().nullable(),
    }),
    execute: async (ctx, input) => {
      const existing = await deps.db
        .select({ name: customers.name, email: customers.email })
        .from(customers)
        .where(eq(customers.orgId, ctx.actor.orgId))
        .limit(500);
      const dupe = findDuplicate(existing, { name: input.name, email: input.email });
      const [row] = await deps.db
        .insert(customers)
        .values({ orgId: ctx.actor.orgId, name: input.name, email: input.email ?? null })
        .returning({ id: customers.id });
      return {
        customerId: row!.id,
        duplicateWarning: dupe.duplicate ? `Looks like existing customer "${dupe.existingName}" (matched by ${dupe.reason}). Merge or deactivate one of them.` : null,
      };
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

const customerProfileSnapshot = z.object({
  customerId: z.string().uuid(),
  ownerUserId: z.string().uuid().nullable(),
  tags: z.array(z.string().max(40)),
  notes: z.string().nullable(),
});

const applyCustomerProfileSnapshots = (
  deps: ModuleDeps,
  id: `crm.${string}`,
  title: string,
  intent: string,
  inverseId: `crm.${string}`,
) =>
  defineCapability({
    id,
    title,
    intent,
    module: "crm",
    risk: "write",
    permission: "crm.write",
    inverse: {
      capabilityId: inverseId,
      buildInput: (_input, output) => ({ profiles: output.previous }),
    },
    input: z.object({ profiles: z.array(customerProfileSnapshot).min(1).max(100) }),
    output: z.object({ updatedCount: z.number().int(), previous: z.array(customerProfileSnapshot) }),
    execute: async (ctx, input) => {
      const owners = [...new Set(input.profiles.map((profile) => profile.ownerUserId).filter((owner): owner is string => owner !== null))];
      if (owners.length) {
        const currentMembers = await deps.db
          .select({ userId: memberships.userId })
          .from(memberships)
          .where(and(eq(memberships.orgId, ctx.actor.orgId), inArray(memberships.userId, owners)));
        if (currentMembers.length !== owners.length) throw new Error("a previous owner is no longer a member of this organization");
      }
      return deps.db.transaction(async (tx) => {
        const ids = [...new Set(input.profiles.map((profile) => profile.customerId))];
        const rows = await tx
          .select({ id: customers.id, ownerUserId: customers.ownerUserId, tags: customers.tags, notes: customers.notes })
          .from(customers)
          .where(and(eq(customers.orgId, ctx.actor.orgId), inArray(customers.id, ids)));
        if (rows.length !== ids.length) throw new Error("one or more customers were not found in this organization");
        const previous = rows.map((row) => ({
          customerId: row.id,
          ownerUserId: row.ownerUserId,
          tags: row.tags,
          notes: row.notes,
        }));
        for (const profile of input.profiles) {
          await tx
            .update(customers)
            .set({ ownerUserId: profile.ownerUserId, tags: profile.tags, notes: profile.notes, updatedAt: ctx.now })
            .where(and(eq(customers.orgId, ctx.actor.orgId), eq(customers.id, profile.customerId)));
        }
        return { updatedCount: input.profiles.length, previous };
      });
    },
  });

const restoreCustomerProfiles = (deps: ModuleDeps) =>
  applyCustomerProfileSnapshots(
    deps,
    "crm.restoreCustomerProfiles",
    "Restore customer profile details",
    "Restore customer owners, tags, and notes to their previous recorded values",
    "crm.reapplyCustomerProfiles",
  );

const reapplyCustomerProfiles = (deps: ModuleDeps) =>
  applyCustomerProfileSnapshots(
    deps,
    "crm.reapplyCustomerProfiles",
    "Reapply customer profile details",
    "Reapply recorded customer owners, tags, and notes after restoring a profile change",
    "crm.restoreCustomerProfiles",
  );

const updateCustomerProfiles = (deps: ModuleDeps) =>
  defineCapability({
    id: "crm.updateCustomerProfiles",
    title: "Update customer profiles",
    intent: "Assign a customer owner or update tags and notes across selected CRM records",
    module: "crm",
    risk: "write",
    permission: "crm.write",
    inverse: {
      capabilityId: "crm.restoreCustomerProfiles",
      buildInput: (_input, output) => ({ profiles: output.previous }),
    },
    input: z
      .object({
        customerIds: z.array(z.string().uuid()).min(1).max(100),
        ownerUserId: z.string().uuid().nullable().optional(),
        addTags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
        removeTags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
        notes: z.string().max(4000).nullable().optional(),
      })
      .refine(
        (input) => input.ownerUserId !== undefined || input.notes !== undefined || Boolean(input.addTags?.length || input.removeTags?.length),
        "provide at least one profile change",
      ),
    output: z.object({ updatedCount: z.number().int(), previous: z.array(customerProfileSnapshot) }),
    execute: async (ctx, input) => {
      const customerIds = [...new Set(input.customerIds)];
      if (input.ownerUserId) {
        const [member] = await deps.db
          .select({ userId: memberships.userId })
          .from(memberships)
          .where(and(eq(memberships.orgId, ctx.actor.orgId), eq(memberships.userId, input.ownerUserId)))
          .limit(1);
        if (!member) throw new Error("the selected owner is not a member of this organization");
      }
      return deps.db.transaction(async (tx) => {
        const rows = await tx
          .select({ id: customers.id, ownerUserId: customers.ownerUserId, tags: customers.tags, notes: customers.notes })
          .from(customers)
          .where(and(eq(customers.orgId, ctx.actor.orgId), inArray(customers.id, customerIds)));
        if (rows.length !== customerIds.length) throw new Error("one or more customers were not found in this organization");
        const previous = rows.map((row) => ({
          customerId: row.id,
          ownerUserId: row.ownerUserId,
          tags: row.tags,
          notes: row.notes,
        }));
        const add = new Set((input.addTags ?? []).map((tag) => tag.trim().toLocaleLowerCase()));
        const remove = new Set((input.removeTags ?? []).map((tag) => tag.trim().toLocaleLowerCase()));
        for (const row of rows) {
          const retained = row.tags.filter((tag) => !remove.has(tag.toLocaleLowerCase()));
          const seen = new Set(retained.map((tag) => tag.toLocaleLowerCase()));
          const tags = [...retained, ...(input.addTags ?? []).map((tag) => tag.trim()).filter((tag) => {
            const normalized = tag.toLocaleLowerCase();
            if (!add.has(normalized) || seen.has(normalized)) return false;
            seen.add(normalized);
            return true;
          })];
          await tx
            .update(customers)
            .set({
              ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
              tags,
              ...(input.notes !== undefined ? { notes: input.notes } : {}),
              updatedAt: ctx.now,
            })
            .where(and(eq(customers.orgId, ctx.actor.orgId), eq(customers.id, row.id)));
        }
        return { updatedCount: rows.length, previous };
      });
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
      /** Where this deal came from (referral, website, walk-in…). */
      source: z.string().max(200).optional(),
      ownerUserId: z.string().uuid().optional(),
      note: z.string().max(2000).optional(),
    }),
    output: z.object({ dealId: z.string() }),
    execute: async (ctx, input) => {
      // A customer id must point at this org's customer. The FK alone cannot
      // check tenancy (ids are global), so without this guard a deal could
      // silently attach to another organization's customer.
      if (input.customerId) {
        const [owned] = await deps.db
          .select({ id: customers.id })
          .from(customers)
          .where(and(eq(customers.id, input.customerId), eq(customers.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!owned) throw new Error("customer not found in this organization");
      }
      const [row] = await deps.db
        .insert(deals)
        .values({
          orgId: ctx.actor.orgId,
          title: input.title,
          customerId: input.customerId ?? null,
          valueMinor: input.valueMinor,
          source: input.source ?? null,
          ownerUserId: input.ownerUserId ?? null,
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
    input: z.object({
      dealId: z.string(),
      stage: z.enum(DEAL_STAGES),
      /** Why the deal died - feeds win/loss analysis. Stored when moving to lost. */
      lostReason: z.string().max(500).optional(),
    }),
    output: z.object({ moved: z.boolean(), stage: z.string() }),
    execute: async (ctx, input) => {
      await deps.db
        .update(deals)
        .set({
          stage: input.stage,
          updatedAt: ctx.now,
          lostReason: input.stage === "lost" ? (input.lostReason ?? null) : null,
        })
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

const convertLead = (deps: ModuleDeps) =>
  defineCapability({
    id: "crm.convertLead",
    title: "Convert lead",
    intent:
      "Promote a lead-stage deal to qualified and attach the customer it belongs to, creating the customer record on the fly when asked",
    module: "crm",
    risk: "write",
    permission: "crm.write",
    input: z.object({
      dealId: z.string(),
      /** Create a fresh customer record named after the deal when no id is given. */
      createCustomer: z.boolean().optional(),
      customerName: z.string().min(1).optional(),
      customerId: z.string().optional(),
    }),
    output: z.object({ dealId: z.string(), customerId: z.string(), stage: z.literal("qualified") }),
    execute: async (ctx, input) => {
      const [deal] = await deps.db
        .select()
        .from(deals)
        .where(and(eq(deals.id, input.dealId), eq(deals.orgId, ctx.actor.orgId)))
        .limit(1);
      if (!deal) throw new Error("deal not found");
      if (deal.stage !== "lead") throw new Error(`deal is ${deal.stage}; only lead-stage deals convert`);

      let customerId = input.customerId ?? null;
      if (customerId) {
        const [owned] = await deps.db
          .select({ id: customers.id })
          .from(customers)
          .where(and(eq(customers.id, customerId), eq(customers.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!owned) throw new Error("customer not found in this organization");
      } else if (input.createCustomer || input.customerName) {
        const name = input.customerName ?? deal.title;
        const [created] = await deps.db
          .insert(customers)
          .values({ orgId: ctx.actor.orgId, name })
          .returning({ id: customers.id });
        customerId = created!.id;
      }
      if (!customerId) throw new Error("pass customerId, or createCustomer true, so the deal has a customer to attach to");

      await deps.db
        .update(deals)
        .set({ stage: "qualified", customerId, updatedAt: ctx.now })
        .where(and(eq(deals.id, deal.id), eq(deals.orgId, ctx.actor.orgId)));
      return { dealId: deal.id, customerId, stage: "qualified" as const };
    },
  });

// ── Tasks (M9.3): follow-ups with due dates; overdue ones signal ────────

const createTask = (deps: ModuleDeps) =>
  defineCapability({
    id: "crm.createTask",
    title: "Create task",
    intent:
      "Record a follow-up task with an optional due date and back-reference so nothing promised to a customer quietly evaporates",
    module: "crm",
    risk: "write",
    permission: "crm.write",
    input: z.object({
      title: z.string().min(1),
      dueAt: z.string().datetime().optional(),
      assigneeUserId: z.string().uuid().optional(),
      refType: z.string().max(50).optional(),
      refId: z.string().uuid().optional(),
      note: z.string().max(2000).optional(),
    }),
    output: z.object({ taskId: z.string() }),
    execute: async (ctx, input) => {
      const [row] = await deps.db
        .insert(tasks)
        .values({
          orgId: ctx.actor.orgId,
          title: input.title,
          dueAt: input.dueAt ? new Date(input.dueAt) : null,
          assigneeUserId: input.assigneeUserId ?? null,
          refType: input.refId ? (input.refType ?? "customer") : null,
          refId: input.refId ?? null,
          note: input.note ?? null,
          createdByActorType: ctx.actor.type,
          createdByActorId: ctx.actor.id,
        })
        .returning({ id: tasks.id });
      return { taskId: row!.id };
    },
  });

const completeTask = (deps: ModuleDeps) =>
  defineCapability({
    id: "crm.completeTask",
    title: "Complete task",
    intent: "Mark a follow-up task done so it stops showing as open and overdue",
    // No inverse: completion is the honest terminal state; reopening would
    // need its own capability with a reason, not a silent undo.
    module: "crm",
    risk: "write",
    permission: "crm.write",
    input: z.object({ taskId: z.string() }),
    output: z.object({ completed: z.literal(true) }),
    execute: async (ctx, input) => {
      const updated = await deps.db
        .update(tasks)
        .set({ doneAt: ctx.now })
        .where(and(eq(tasks.id, input.taskId), eq(tasks.orgId, ctx.actor.orgId), isNull(tasks.doneAt)))
        .returning({ id: tasks.id });
      if (updated.length === 0) throw new Error("task not found or already completed");
      return { completed: true as const };
    },
  });

const listTasks = (deps: ModuleDeps) =>
  defineCapability({
    id: "crm.listTasks",
    title: "List tasks",
    intent: "Show the organization's follow-up tasks, open or done, with due dates and what they reference",
    module: "crm",
    risk: "read",
    permission: "crm.read",
    input: z.object({ openOnly: z.boolean().optional() }),
    output: z.object({
      tasks: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          dueAt: z.string().nullable(),
          doneAt: z.string().nullable(),
          refType: z.string().nullable(),
          refId: z.string().nullable(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      const rows = await deps.db
        .select()
        .from(tasks)
        .where(
          input.openOnly
            ? and(eq(tasks.orgId, ctx.actor.orgId), isNull(tasks.doneAt))
            : eq(tasks.orgId, ctx.actor.orgId),
        )
        .orderBy(tasks.doneAt, tasks.dueAt)
        .limit(200);
      return {
        tasks: rows.map((t) => ({
          id: t.id,
          title: t.title,
          dueAt: t.dueAt?.toISOString() ?? null,
          doneAt: t.doneAt?.toISOString() ?? null,
          refType: t.refType,
          refId: t.refId,
        })),
      };
    },
  });

const customerTimeline = (deps: ModuleDeps) =>
  defineCapability({
    id: "crm.customerTimeline",
    title: "Customer timeline",
    intent:
      "Assemble one reverse-chronological view of everything that happened with a customer - quotes, invoices, payments, deals, and tasks - from a single read",
    module: "crm",
    risk: "read",
    permission: "crm.read",
    input: z.object({ customerId: z.string(), limit: z.number().int().positive().max(200).optional() }),
    output: z.object({
      entries: z.array(
        z.object({
          kind: z.string(),
          date: z.string(),
          refId: z.string(),
          summary: z.string(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      const limit = input.limit ?? 50;
      const [owned] = await deps.db
        .select({ id: customers.id, name: customers.name })
        .from(customers)
        .where(and(eq(customers.id, input.customerId), eq(customers.orgId, ctx.actor.orgId)))
        .limit(1);
      if (!owned) throw new Error("customer not found in this organization");

      type Entry = { kind: string; date: Date; refId: string; summary: string };
      const entries: Entry[] = [];

      const invRows = await deps.db
        .select({ id: invoices.id, number: invoices.number, status: invoices.status, totalMinor: invoices.totalMinor, issuedAt: invoices.issuedAt })
        .from(invoices)
        .where(and(eq(invoices.orgId, ctx.actor.orgId), eq(invoices.customerId, owned.id)))
        .orderBy(desc(invoices.issuedAt))
        .limit(limit);
      for (const i of invRows) {
        if (!i.issuedAt) continue;
        entries.push({ kind: "invoice", date: i.issuedAt, refId: i.id, summary: `Invoice #${i.number} (${i.status}, ${(i.totalMinor / 100).toFixed(2)})` });
      }

      const payRows = await deps.db
        .select({ id: payments.id, amountMinor: payments.amountMinor, method: payments.method, receivedAt: payments.receivedAt })
        .from(payments)
        .innerJoin(invoices, eq(payments.invoiceId, invoices.id))
        .where(and(eq(payments.orgId, ctx.actor.orgId), eq(invoices.customerId, owned.id)))
        .orderBy(desc(payments.receivedAt))
        .limit(limit);
      for (const p of payRows) {
        entries.push({ kind: "payment", date: p.receivedAt, refId: p.id, summary: `Payment ${(p.amountMinor / 100).toFixed(2)} via ${p.method}` });
      }

      const quoteRows = await deps.db
        .select({ id: quotes.id, number: quotes.number, status: quotes.status, totalMinor: quotes.totalMinor, decidedAt: quotes.decidedAt, createdAt: quotes.createdAt })
        .from(quotes)
        .where(and(eq(quotes.orgId, ctx.actor.orgId), eq(quotes.customerId, owned.id)))
        .limit(limit);
      for (const q of quoteRows) {
        entries.push({ kind: "quote", date: q.decidedAt ?? q.createdAt, refId: q.id, summary: `Quote #${q.number} (${q.status}, ${(q.totalMinor / 100).toFixed(2)})` });
      }

      const dealRows = await deps.db
        .select({ id: deals.id, title: deals.title, stage: deals.stage, valueMinor: deals.valueMinor, updatedAt: deals.updatedAt })
        .from(deals)
        .where(and(eq(deals.orgId, ctx.actor.orgId), eq(deals.customerId, owned.id)))
        .limit(limit);
      for (const d of dealRows) {
        entries.push({ kind: "deal", date: d.updatedAt, refId: d.id, summary: `Deal "${d.title}" (${d.stage}, ${(d.valueMinor / 100).toFixed(2)})` });
      }

      const taskRows = await deps.db
        .select({ id: tasks.id, title: tasks.title, dueAt: tasks.dueAt, doneAt: tasks.doneAt, createdAt: tasks.createdAt })
        .from(tasks)
        .where(and(eq(tasks.orgId, ctx.actor.orgId), eq(tasks.refType, "customer"), eq(tasks.refId, owned.id)))
        .limit(limit);
      for (const t of taskRows) {
        entries.push({ kind: "task", date: t.doneAt ?? t.dueAt ?? t.createdAt, refId: t.id, summary: `Task "${t.title}"${t.doneAt ? " (done)" : ""}` });
      }

      const documentRows = await deps.db
        .select({ id: documents.id, title: documents.title, status: documents.status, updatedAt: documents.updatedAt })
        .from(documents)
        .where(and(eq(documents.orgId, ctx.actor.orgId), eq(documents.refType, "customer"), eq(documents.refId, owned.id)))
        .limit(limit);
      for (const document of documentRows) {
        entries.push({
          kind: "document",
          date: document.updatedAt,
          refId: document.id,
          summary: `Document "${document.title}" (${document.status})`,
        });
      }

      entries.sort((a, b) => b.date.getTime() - a.date.getTime());
      return {
        entries: entries.slice(0, limit).map((e) => ({
          kind: e.kind,
          date: e.date.toISOString(),
          refId: e.refId,
          summary: e.summary,
        })),
      };
    },
  });

export function registerCrmCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(createCustomer(deps));
  registry.register(deactivateCustomer(deps));
  registry.register(updateCustomerProfiles(deps));
  registry.register(restoreCustomerProfiles(deps));
  registry.register(reapplyCustomerProfiles(deps));
  registry.register(listCustomers(deps));
  registry.register(createDeal(deps));
  registry.register(moveDealStage(deps));
  registry.register(pipelineReport(deps));
  registry.register(convertLead(deps));
  registry.register(createTask(deps));
  registry.register(completeTask(deps));
  registry.register(listTasks(deps));
  registry.register(customerTimeline(deps));
}

export { createCrmSignalProducer } from "./signals";
