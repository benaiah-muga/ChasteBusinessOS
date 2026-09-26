import { and, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { crmCustomerViews, customers, deals, documents, invoices, memberships, payments, quotes, tasks, users, withOrgContext } from "@chaste/db";
import type { Database } from "@chaste/db";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";
import { findDuplicate } from "@chaste/erp-core";

export interface ModuleDeps {
  db: Database["db"];
}

export const DEAL_STAGES = ["lead", "qualified", "proposal", "negotiation", "won", "lost"] as const;

const customerViewFilter = z.object({
  status: z.enum(["active", "inactive", "all"]),
  owner: z.string().max(64),
  staleOnly: z.boolean(),
  duplicateOnly: z.boolean(),
  tag: z.string().max(40),
});
const customerViewSnapshot = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(60),
  filters: customerViewFilter,
  isShared: z.boolean(),
  isPinned: z.boolean(),
  createdByUserId: z.string().uuid(),
});

const listCustomerViews = (deps: ModuleDeps) => defineCapability({
  id: "crm.listCustomerViews",
  title: "List saved customer views",
  intent: "Show shared workspace customer filters and private views created by the current user",
  module: "crm",
  risk: "read",
  permission: "crm.read",
  input: z.object({}),
  output: z.object({ views: z.array(customerViewSnapshot.extend({ updatedAt: z.string() })) }),
  execute: async (ctx) => {
    const rows = await deps.db.select().from(crmCustomerViews)
      .where(and(
        eq(crmCustomerViews.orgId, ctx.actor.orgId),
        ctx.actor.id ? or(eq(crmCustomerViews.isShared, true), eq(crmCustomerViews.createdByUserId, ctx.actor.id)) : eq(crmCustomerViews.isShared, true),
      ))
      .orderBy(desc(crmCustomerViews.isPinned), desc(crmCustomerViews.updatedAt));
    return { views: rows.map((row) => ({
      id: row.id,
      name: row.name,
      filters: row.filters,
      isShared: row.isShared,
      isPinned: row.isPinned,
      createdByUserId: row.createdByUserId,
      updatedAt: row.updatedAt.toISOString(),
    })) };
  },
});

const saveCustomerView = (deps: ModuleDeps) => defineCapability({
  id: "crm.saveCustomerView",
  title: "Save customer view",
  intent: "Save a reusable customer filter to the workspace, with optional team sharing and pinning",
  module: "crm",
  risk: "write",
  permission: "crm.write",
  inverse: {
    capabilityId: "crm.restoreCustomerView",
    buildInput: (input, output) => ({ viewId: output.viewId, previous: output.previous }),
  },
  input: z.object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(60),
    filters: customerViewFilter,
    isShared: z.boolean(),
    isPinned: z.boolean(),
  }),
  output: z.object({ viewId: z.string().uuid(), previous: customerViewSnapshot.nullable() }),
  execute: async (ctx, input) => {
    if (!ctx.actor.id) throw new Error("A signed-in user is required to save a customer view");
    const [existing] = input.id
      ? await deps.db.select().from(crmCustomerViews).where(and(eq(crmCustomerViews.id, input.id), eq(crmCustomerViews.orgId, ctx.actor.orgId))).limit(1)
      : await deps.db.select().from(crmCustomerViews).where(and(eq(crmCustomerViews.orgId, ctx.actor.orgId), eq(crmCustomerViews.name, input.name))).limit(1);
    if (existing && !existing.isShared && existing.createdByUserId !== ctx.actor.id) throw new Error("This private view belongs to another team member");
    const previous = existing ? {
      id: existing.id,
      name: existing.name,
      filters: existing.filters,
      isShared: existing.isShared,
      isPinned: existing.isPinned,
      createdByUserId: existing.createdByUserId,
    } : null;
    if (existing) {
      await deps.db.update(crmCustomerViews).set({
        name: input.name,
        filters: input.filters,
        isShared: input.isShared,
        isPinned: input.isPinned,
        updatedByUserId: ctx.actor.id,
        updatedAt: ctx.now,
      }).where(and(eq(crmCustomerViews.id, existing.id), eq(crmCustomerViews.orgId, ctx.actor.orgId)));
      return { viewId: existing.id, previous };
    }
    const [row] = await deps.db.insert(crmCustomerViews).values({
      orgId: ctx.actor.orgId,
      name: input.name,
      filters: input.filters,
      isShared: input.isShared,
      isPinned: input.isPinned,
      createdByUserId: ctx.actor.id,
      updatedByUserId: ctx.actor.id,
    }).returning({ id: crmCustomerViews.id });
    return { viewId: row!.id, previous };
  },
});

const restoreCustomerView = (deps: ModuleDeps) => defineCapability({
  id: "crm.restoreCustomerView",
  title: "Restore saved customer view",
  intent: "Restore the previous workspace filter definition after saving a customer view",
  module: "crm",
  risk: "write",
  permission: "crm.write",
  // This is the compensation for saveCustomerView. Reversing a compensation
  // is handled by saving the restored definition as a new intentional edit.
  input: z.object({ viewId: z.string().uuid(), previous: customerViewSnapshot.nullable() }),
  output: z.object({ restored: z.literal(true) }),
  execute: async (ctx, input) => {
    if (!ctx.actor.id) throw new Error("A signed-in user is required to restore a customer view");
    if (!input.previous) {
      await deps.db.delete(crmCustomerViews).where(and(eq(crmCustomerViews.id, input.viewId), eq(crmCustomerViews.orgId, ctx.actor.orgId)));
    } else {
      await deps.db.insert(crmCustomerViews).values({
        id: input.previous.id,
        orgId: ctx.actor.orgId,
        name: input.previous.name,
        filters: input.previous.filters,
        isShared: input.previous.isShared,
        isPinned: input.previous.isPinned,
        createdByUserId: input.previous.createdByUserId,
        updatedByUserId: ctx.actor.id,
      }).onConflictDoUpdate({
        target: [crmCustomerViews.id],
        set: {
          name: input.previous.name,
          filters: input.previous.filters,
          isShared: input.previous.isShared,
          isPinned: input.previous.isPinned,
          createdByUserId: input.previous.createdByUserId,
          updatedByUserId: ctx.actor.id,
          updatedAt: ctx.now,
        },
      });
    }
    return { restored: true as const };
  },
});

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
      phone: z.string().trim().max(40).optional(),
      preferredContactMethod: z.enum(["email", "phone", "whatsapp", "other"]).default("email"),
      doNotContact: z.boolean().default(false),
    }),
    output: z.object({
      customerId: z.string(),
      /** Present when an existing customer looks like the same one - never a refusal. */
      duplicateWarning: z.string().nullable(),
    }),
    execute: async (ctx, input) => {
      const existing = await deps.db
        .select({ name: customers.name, email: customers.email, phone: customers.phone })
        .from(customers)
        .where(and(eq(customers.orgId, ctx.actor.orgId), isNull(customers.mergedIntoCustomerId)))
        .limit(500);
      const dupe = findDuplicate(existing, { name: input.name, email: input.email, phone: input.phone });
      const [row] = await deps.db
        .insert(customers)
        .values({ orgId: ctx.actor.orgId, name: input.name, email: input.email ?? null, phone: input.phone ?? null, preferredContactMethod: input.preferredContactMethod, doNotContact: input.doNotContact, updatedByUserId: ctx.actor.type === "human" ? ctx.actor.id : null })
        .returning({ id: customers.id });
      return {
        customerId: row!.id,
        duplicateWarning: dupe.duplicate ? `Looks like existing customer "${dupe.existingName}" (matched by ${dupe.reason}). Merge or deactivate one of them.` : null,
      };
    },
  });

const customerMergeSnapshot = z.object({
  customerId: z.string().uuid(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  preferredContactMethod: z.enum(["email", "phone", "whatsapp", "other"]),
  doNotContact: z.boolean(),
  reminderOptOut: z.boolean(),
  marketingOptOut: z.boolean(),
  ownerUserId: z.string().uuid().nullable(),
  tags: z.array(z.string().max(40)),
  notes: z.string().nullable(),
  creditLimitMinor: z.number().int().nullable(),
  paymentTermDays: z.number().int().nullable(),
  deactivatedAt: z.string().nullable(),
  mergedIntoCustomerId: z.string().uuid().nullable(),
  mergedAt: z.string().nullable(),
});

type CustomerMergeSnapshot = z.infer<typeof customerMergeSnapshot>;

function snapshotCustomerMerge(row: {
  id: string;
  email: string | null;
  phone: string | null;
  preferredContactMethod: string;
  doNotContact: boolean;
  reminderOptOut: boolean;
  marketingOptOut: boolean;
  ownerUserId: string | null;
  tags: string[];
  notes: string | null;
  creditLimitMinor: number | null;
  paymentTermDays: number | null;
  deactivatedAt: Date | null;
  mergedIntoCustomerId: string | null;
  mergedAt: Date | null;
}): CustomerMergeSnapshot {
  return {
    customerId: row.id,
    email: row.email,
    phone: row.phone,
    preferredContactMethod: row.preferredContactMethod as CustomerMergeSnapshot["preferredContactMethod"],
    doNotContact: row.doNotContact,
    reminderOptOut: row.reminderOptOut,
    marketingOptOut: row.marketingOptOut,
    ownerUserId: row.ownerUserId,
    tags: row.tags,
    notes: row.notes,
    creditLimitMinor: row.creditLimitMinor,
    paymentTermDays: row.paymentTermDays,
    deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
    mergedIntoCustomerId: row.mergedIntoCustomerId,
    mergedAt: row.mergedAt?.toISOString() ?? null,
  };
}

const mergeCustomers = (deps: ModuleDeps) => defineCapability({
  id: "crm.mergeCustomers",
  title: "Merge duplicate customers",
  intent: "Merge a reviewed duplicate into the chosen customer while keeping original invoices and activity linked and available in the surviving profile",
  module: "crm",
  risk: "write",
  permission: "crm.write",
  inverse: {
    capabilityId: "crm.restoreCustomerMerge",
    buildInput: (_input, output) => output,
  },
  input: z.object({ survivorCustomerId: z.string().uuid(), duplicateCustomerId: z.string().uuid() }).refine((input) => input.survivorCustomerId !== input.duplicateCustomerId, "Choose two different customers"),
  output: z.object({
    survivorCustomerId: z.string().uuid(),
    duplicateCustomerId: z.string().uuid(),
    previous: z.array(customerMergeSnapshot).min(2).max(502),
  }),
  execute: async (ctx, input) => withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
    const ids = [input.survivorCustomerId, input.duplicateCustomerId];
    const rows = await tx.select().from(customers)
      .where(and(eq(customers.orgId, ctx.actor.orgId), inArray(customers.id, ids)))
      .for("update");
    if (rows.length !== 2) throw new Error("both customers must belong to this organization");
    const survivor = rows.find((row) => row.id === input.survivorCustomerId)!;
    const duplicate = rows.find((row) => row.id === input.duplicateCustomerId)!;
    if (survivor.mergedIntoCustomerId) throw new Error("the surviving customer was already merged; choose the current surviving record");
    if (duplicate.mergedIntoCustomerId || duplicate.deactivatedAt) throw new Error("the duplicate is inactive or already merged");
    const children = await tx.select().from(customers)
      .where(and(eq(customers.orgId, ctx.actor.orgId), eq(customers.mergedIntoCustomerId, duplicate.id)));
    const affected = [survivor, duplicate, ...children];
    const previous = affected.map(snapshotCustomerMerge);
    const tags = [...survivor.tags];
    const seenTags = new Set(tags.map((tag) => tag.trim().toLowerCase()));
    for (const tag of duplicate.tags) {
      const key = tag.trim().toLowerCase();
      if (!seenTags.has(key)) { tags.push(tag); seenTags.add(key); }
    }
    const contact = survivor.email || survivor.phone ? survivor : duplicate;
    await tx.update(customers).set({
      email: survivor.email ?? duplicate.email,
      phone: survivor.phone ?? duplicate.phone,
      preferredContactMethod: contact.preferredContactMethod,
      ownerUserId: survivor.ownerUserId ?? duplicate.ownerUserId,
      tags,
      doNotContact: survivor.doNotContact || duplicate.doNotContact,
      reminderOptOut: survivor.reminderOptOut || duplicate.reminderOptOut,
      marketingOptOut: survivor.marketingOptOut || duplicate.marketingOptOut,
      creditLimitMinor: survivor.creditLimitMinor ?? duplicate.creditLimitMinor,
      paymentTermDays: survivor.paymentTermDays ?? duplicate.paymentTermDays,
      updatedByUserId: ctx.actor.type === "human" ? ctx.actor.id : null,
      updatedAt: ctx.now,
    }).where(and(eq(customers.orgId, ctx.actor.orgId), eq(customers.id, survivor.id)));
    await tx.update(customers).set({
      mergedIntoCustomerId: survivor.id,
      mergedAt: ctx.now,
      deactivatedAt: ctx.now,
      updatedByUserId: ctx.actor.type === "human" ? ctx.actor.id : null,
      updatedAt: ctx.now,
    }).where(and(eq(customers.orgId, ctx.actor.orgId), inArray(customers.id, [duplicate.id, ...children.map((row) => row.id)])));
    return { survivorCustomerId: survivor.id, duplicateCustomerId: duplicate.id, previous };
  }),
});

const restoreCustomerMerge = (deps: ModuleDeps) => defineCapability({
  id: "crm.restoreCustomerMerge",
  title: "Undo customer merge",
  intent: "Restore customer records and their prior profile details after reversing a reviewed duplicate merge",
  module: "crm",
  risk: "write",
  permission: "crm.write",
  inverse: {
    capabilityId: "crm.mergeCustomers",
    buildInput: (_input, output) => ({ survivorCustomerId: output.survivorCustomerId, duplicateCustomerId: output.duplicateCustomerId }),
  },
  input: z.object({
    survivorCustomerId: z.string().uuid(),
    duplicateCustomerId: z.string().uuid(),
    previous: z.array(customerMergeSnapshot).min(2).max(502),
  }),
  output: z.object({
    survivorCustomerId: z.string().uuid(),
    duplicateCustomerId: z.string().uuid(),
    previous: z.array(customerMergeSnapshot).min(2).max(502),
  }),
  execute: async (ctx, input) => withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
    const customerIds = input.previous.map((snapshot) => snapshot.customerId);
    const rows = await tx.select().from(customers)
      .where(and(eq(customers.orgId, ctx.actor.orgId), inArray(customers.id, customerIds)))
      .for("update");
    if (rows.length !== customerIds.length) throw new Error("a merged customer record is no longer available to restore");
    const current = rows.map(snapshotCustomerMerge);
    for (const snapshot of input.previous) {
      await tx.update(customers).set({
        email: snapshot.email,
        phone: snapshot.phone,
        preferredContactMethod: snapshot.preferredContactMethod,
        doNotContact: snapshot.doNotContact,
        reminderOptOut: snapshot.reminderOptOut,
        marketingOptOut: snapshot.marketingOptOut,
        ownerUserId: snapshot.ownerUserId,
        tags: snapshot.tags,
        notes: snapshot.notes,
        creditLimitMinor: snapshot.creditLimitMinor,
        paymentTermDays: snapshot.paymentTermDays,
        deactivatedAt: snapshot.deactivatedAt ? new Date(snapshot.deactivatedAt) : null,
        mergedIntoCustomerId: snapshot.mergedIntoCustomerId,
        mergedAt: snapshot.mergedAt ? new Date(snapshot.mergedAt) : null,
        updatedByUserId: ctx.actor.type === "human" ? ctx.actor.id : null,
        updatedAt: ctx.now,
      }).where(and(eq(customers.orgId, ctx.actor.orgId), eq(customers.id, snapshot.customerId)));
    }
    return { survivorCustomerId: input.survivorCustomerId, duplicateCustomerId: input.duplicateCustomerId, previous: current };
  }),
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

const importCustomers = (deps: ModuleDeps) => defineCapability({
  id: "crm.importCustomers",
  title: "Import customers",
  intent: "Import reviewed customer rows, skip likely duplicates by default, and keep the inserted records reversible as one batch",
  module: "crm",
  risk: "write",
  permission: "crm.write",
  inverse: {
    capabilityId: "crm.undoCustomerImport",
    buildInput: (_input, output) => ({ customerIds: output.createdIds }),
  },
  input: z.object({ rows: z.array(z.object({
    rowNumber: z.number().int().positive(),
    name: z.string().trim().min(1).max(120),
    email: z.string().email().nullable().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    creditLimitMinor: z.number().int().nonnegative().nullable().optional(),
    paymentTermDays: z.number().int().nonnegative().nullable().optional(),
    allowDuplicate: z.boolean().default(false),
  })).min(1).max(5000) }),
  output: z.object({ createdIds: z.array(z.string().uuid()), imported: z.number().int(), skippedDuplicateRows: z.array(z.number().int()) }),
  execute: async (ctx, input) => withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
    const existing = await tx.select({ name: customers.name, email: customers.email, phone: customers.phone })
      .from(customers).where(and(eq(customers.orgId, ctx.actor.orgId), isNull(customers.deactivatedAt)));
    const fingerprints = [...existing];
    const created: Array<typeof customers.$inferInsert> = [];
    const skippedDuplicateRows: number[] = [];
    for (const row of input.rows) {
      const match = findDuplicate(fingerprints, row);
      if (match.duplicate && !row.allowDuplicate) {
        skippedDuplicateRows.push(row.rowNumber);
        continue;
      }
      fingerprints.push({ name: row.name, email: row.email ?? null, phone: row.phone ?? null });
      created.push({
        id: crypto.randomUUID(),
        orgId: ctx.actor.orgId,
        name: row.name,
        email: row.email ?? null,
        phone: row.phone ?? null,
        creditLimitMinor: row.creditLimitMinor ?? null,
        paymentTermDays: row.paymentTermDays ?? null,
        preferredContactMethod: row.email ? "email" : "phone",
        updatedByUserId: ctx.actor.type === "human" ? ctx.actor.id : null,
      });
    }
    const createdIds: string[] = [];
    for (let offset = 0; offset < created.length; offset += 500) {
      const inserted = await tx.insert(customers).values(created.slice(offset, offset + 500)).returning({ id: customers.id });
      createdIds.push(...inserted.map((row) => row.id));
    }
    return { createdIds, imported: createdIds.length, skippedDuplicateRows };
  }),
});

const undoCustomerImport = (deps: ModuleDeps) => defineCapability({
  id: "crm.undoCustomerImport",
  title: "Undo customer import",
  intent: "Deactivate customers from a recent import while preserving any records already linked to their history",
  module: "crm",
  risk: "write",
  permission: "crm.write",
  inverse: { capabilityId: "crm.restoreImportedCustomers", buildInput: (_input, output) => ({ customerIds: output.customerIds }) },
  input: z.object({ customerIds: z.array(z.string().uuid()).min(1).max(5000) }),
  output: z.object({ customerIds: z.array(z.string().uuid()), deactivated: z.number().int() }),
  execute: async (ctx, input) => withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
    const customerIds = [...new Set(input.customerIds)];
    const changed = await tx.update(customers).set({ deactivatedAt: ctx.now, updatedByUserId: ctx.actor.type === "human" ? ctx.actor.id : null, updatedAt: ctx.now })
      .where(and(eq(customers.orgId, ctx.actor.orgId), inArray(customers.id, customerIds), isNull(customers.deactivatedAt)))
      .returning({ id: customers.id });
    return { customerIds: changed.map((row) => row.id), deactivated: changed.length };
  }),
});

const restoreImportedCustomers = (deps: ModuleDeps) => defineCapability({
  id: "crm.restoreImportedCustomers",
  title: "Restore imported customers",
  intent: "Restore customer records after reversing an import undo action, without changing their linked history",
  module: "crm",
  risk: "write",
  permission: "crm.write",
  inverse: { capabilityId: "crm.undoCustomerImport", buildInput: (_input, output) => ({ customerIds: output.customerIds }) },
  input: z.object({ customerIds: z.array(z.string().uuid()).min(1).max(5000) }),
  output: z.object({ customerIds: z.array(z.string().uuid()), restored: z.number().int() }),
  execute: async (ctx, input) => withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
    const customerIds = [...new Set(input.customerIds)];
    const changed = await tx.update(customers).set({ deactivatedAt: null, updatedByUserId: ctx.actor.type === "human" ? ctx.actor.id : null, updatedAt: ctx.now })
      .where(and(eq(customers.orgId, ctx.actor.orgId), inArray(customers.id, customerIds), isNotNull(customers.deactivatedAt)))
      .returning({ id: customers.id });
    return { customerIds: changed.map((row) => row.id), restored: changed.length };
  }),
});

const customerProfileSnapshot = z.object({
  customerId: z.string().uuid(),
  name: z.string().min(1).max(120).optional(),
  ownerUserId: z.string().uuid().nullable(),
  tags: z.array(z.string().max(40)),
  notes: z.string().nullable(),
  phone: z.string().nullable(),
  preferredContactMethod: z.enum(["email", "phone", "whatsapp", "other"]),
  doNotContact: z.boolean(),
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
          .select({ id: customers.id, name: customers.name, ownerUserId: customers.ownerUserId, tags: customers.tags, notes: customers.notes, phone: customers.phone, preferredContactMethod: customers.preferredContactMethod, doNotContact: customers.doNotContact })
          .from(customers)
          .where(and(eq(customers.orgId, ctx.actor.orgId), inArray(customers.id, ids)));
        if (rows.length !== ids.length) throw new Error("one or more customers were not found in this organization");
        const previous = rows.map((row) => ({
          customerId: row.id,
          name: row.name,
          ownerUserId: row.ownerUserId,
          tags: row.tags,
          notes: row.notes,
          phone: row.phone,
          preferredContactMethod: row.preferredContactMethod as "email" | "phone" | "whatsapp" | "other",
          doNotContact: row.doNotContact,
        }));
        for (const profile of input.profiles) {
          await tx
            .update(customers)
            .set({ ...(profile.name !== undefined ? { name: profile.name } : {}), ownerUserId: profile.ownerUserId, tags: profile.tags, notes: profile.notes, phone: profile.phone, preferredContactMethod: profile.preferredContactMethod, doNotContact: profile.doNotContact, updatedByUserId: ctx.actor.type === "human" ? ctx.actor.id : null, updatedAt: ctx.now })
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
    "Restore customer names, owners, contact preferences, tags, and notes to their previous recorded values",
    "crm.reapplyCustomerProfiles",
  );

const reapplyCustomerProfiles = (deps: ModuleDeps) =>
  applyCustomerProfileSnapshots(
    deps,
    "crm.reapplyCustomerProfiles",
    "Reapply customer profile details",
    "Reapply recorded customer names, owners, contact preferences, tags, and notes after restoring a profile change",
    "crm.restoreCustomerProfiles",
  );

const updateCustomerProfiles = (deps: ModuleDeps) =>
  defineCapability({
    id: "crm.updateCustomerProfiles",
    title: "Update customer profiles",
    intent: "Update a customer name, owner, contact preferences, tags, and notes while preserving an audit-safe inverse",
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
        name: z.string().trim().min(1).max(120).optional(),
        ownerUserId: z.string().uuid().nullable().optional(),
        addTags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
        removeTags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
        notes: z.string().max(4000).nullable().optional(),
        phone: z.string().trim().max(40).nullable().optional(),
        preferredContactMethod: z.enum(["email", "phone", "whatsapp", "other"]).optional(),
        doNotContact: z.boolean().optional(),
      })
      .refine(
        (input) => input.name === undefined || input.customerIds.length === 1,
        "a customer name can only be changed on one record at a time",
      )
      .refine(
        (input) => input.name !== undefined || input.ownerUserId !== undefined || input.notes !== undefined || input.phone !== undefined || input.preferredContactMethod !== undefined || input.doNotContact !== undefined || Boolean(input.addTags?.length || input.removeTags?.length),
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
          .select({ id: customers.id, name: customers.name, ownerUserId: customers.ownerUserId, tags: customers.tags, notes: customers.notes, phone: customers.phone, preferredContactMethod: customers.preferredContactMethod, doNotContact: customers.doNotContact })
          .from(customers)
          .where(and(eq(customers.orgId, ctx.actor.orgId), inArray(customers.id, customerIds)));
        if (rows.length !== customerIds.length) throw new Error("one or more customers were not found in this organization");
        const previous = rows.map((row) => ({
          customerId: row.id,
          name: row.name,
          ownerUserId: row.ownerUserId,
          tags: row.tags,
          notes: row.notes,
          phone: row.phone,
          preferredContactMethod: row.preferredContactMethod as "email" | "phone" | "whatsapp" | "other",
          doNotContact: row.doNotContact,
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
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
              tags,
              ...(input.notes !== undefined ? { notes: input.notes } : {}),
              ...(input.phone !== undefined ? { phone: input.phone } : {}),
              ...(input.preferredContactMethod !== undefined ? { preferredContactMethod: input.preferredContactMethod } : {}),
              ...(input.doNotContact !== undefined ? { doNotContact: input.doNotContact } : {}),
              updatedByUserId: ctx.actor.type === "human" ? ctx.actor.id : null,
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
        .where(and(eq(customers.orgId, ctx.actor.orgId), isNull(customers.deactivatedAt), isNull(customers.mergedIntoCustomerId)))
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
      lostReason: z.string().trim().min(3).max(500).optional(),
    }).superRefine((input, issue) => {
      if (input.stage === "lost" && !input.lostReason) issue.addIssue({ code: "custom", path: ["lostReason"], message: "Add a short reason before marking this deal lost" });
    }),
    output: z.object({ moved: z.boolean(), stage: z.string() }),
    execute: async (ctx, input) => {
      if (input.stage === "lost" && (!input.lostReason || input.lostReason.trim().length < 3)) {
        throw new Error("Add a short reason before marking this deal lost");
      }
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

const taskDetailsInput = z.object({
  taskId: z.string().uuid(),
  dueAt: z.string().datetime().nullable().optional(),
  assigneeUserId: z.string().uuid().nullable().optional(),
}).refine((input) => input.dueAt !== undefined || input.assigneeUserId !== undefined, "include a due date or assignee change");

const updateTaskDetails = (
  deps: ModuleDeps,
  id: "crm.updateTaskDetails" | "crm.restoreTaskDetails",
  title: string,
  intent: string,
  inverseId: "crm.updateTaskDetails" | "crm.restoreTaskDetails",
) => defineCapability({
  id,
  title,
  intent,
  module: "crm",
  risk: "write",
  permission: "crm.write",
  inverse: {
    capabilityId: inverseId,
    buildInput: (input, output) => ({ taskId: input.taskId, ...output.previous }),
  },
  input: taskDetailsInput,
  output: z.object({
    taskId: z.string(),
    previous: z.object({ dueAt: z.string().nullable(), assigneeUserId: z.string().uuid().nullable() }),
  }),
  execute: async (ctx, input) => {
    const [row] = await deps.db.select({ id: tasks.id, dueAt: tasks.dueAt, assigneeUserId: tasks.assigneeUserId })
      .from(tasks)
      .where(and(eq(tasks.id, input.taskId), eq(tasks.orgId, ctx.actor.orgId), isNull(tasks.doneAt)))
      .limit(1);
    if (!row) throw new Error("open task not found in this organization");
    if (input.assigneeUserId) {
      const [member] = await deps.db.select({ userId: memberships.userId }).from(memberships)
        .where(and(eq(memberships.orgId, ctx.actor.orgId), eq(memberships.userId, input.assigneeUserId))).limit(1);
      if (!member) throw new Error("assignee is not a member of this organization");
    }
    await deps.db.update(tasks).set({
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt ? new Date(input.dueAt) : null } : {}),
      ...(input.assigneeUserId !== undefined ? { assigneeUserId: input.assigneeUserId } : {}),
    }).where(and(eq(tasks.id, input.taskId), eq(tasks.orgId, ctx.actor.orgId), isNull(tasks.doneAt)));
    return { taskId: row.id, previous: { dueAt: row.dueAt?.toISOString() ?? null, assigneeUserId: row.assigneeUserId } };
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
          assigneeUserId: z.string().uuid().nullable(),
          assigneeName: z.string().nullable(),
          customerName: z.string().nullable(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      const rows = await deps.db
        .select({
          id: tasks.id,
          title: tasks.title,
          dueAt: tasks.dueAt,
          doneAt: tasks.doneAt,
          refType: tasks.refType,
          refId: tasks.refId,
          assigneeUserId: tasks.assigneeUserId,
          assigneeName: users.name,
          assigneeEmail: users.email,
          customerName: customers.name,
        })
        .from(tasks)
        .leftJoin(users, eq(tasks.assigneeUserId, users.id))
        .leftJoin(customers, and(eq(tasks.refId, customers.id), eq(tasks.refType, "customer"), eq(customers.orgId, ctx.actor.orgId)))
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
          assigneeUserId: t.assigneeUserId,
          assigneeName: t.assigneeName ?? t.assigneeEmail ?? null,
          customerName: t.customerName,
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
      const mergedRows = await deps.db.select({ id: customers.id }).from(customers)
        .where(and(eq(customers.orgId, ctx.actor.orgId), eq(customers.mergedIntoCustomerId, owned.id)));
      const linkedCustomerIds = [owned.id, ...mergedRows.map((row) => row.id)];

      type Entry = { kind: string; date: Date; refId: string; summary: string };
      const entries: Entry[] = [];

      const invRows = await deps.db
        .select({ id: invoices.id, number: invoices.number, status: invoices.status, totalMinor: invoices.totalMinor, issuedAt: invoices.issuedAt })
        .from(invoices)
        .where(and(eq(invoices.orgId, ctx.actor.orgId), inArray(invoices.customerId, linkedCustomerIds)))
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
        .where(and(eq(payments.orgId, ctx.actor.orgId), inArray(invoices.customerId, linkedCustomerIds)))
        .orderBy(desc(payments.receivedAt))
        .limit(limit);
      for (const p of payRows) {
        entries.push({ kind: "payment", date: p.receivedAt, refId: p.id, summary: `Payment ${(p.amountMinor / 100).toFixed(2)} via ${p.method}` });
      }

      const quoteRows = await deps.db
        .select({ id: quotes.id, number: quotes.number, status: quotes.status, totalMinor: quotes.totalMinor, decidedAt: quotes.decidedAt, createdAt: quotes.createdAt })
        .from(quotes)
        .where(and(eq(quotes.orgId, ctx.actor.orgId), inArray(quotes.customerId, linkedCustomerIds)))
        .limit(limit);
      for (const q of quoteRows) {
        entries.push({ kind: "quote", date: q.decidedAt ?? q.createdAt, refId: q.id, summary: `Quote #${q.number} (${q.status}, ${(q.totalMinor / 100).toFixed(2)})` });
      }

      const dealRows = await deps.db
        .select({ id: deals.id, title: deals.title, stage: deals.stage, valueMinor: deals.valueMinor, updatedAt: deals.updatedAt })
        .from(deals)
        .where(and(eq(deals.orgId, ctx.actor.orgId), inArray(deals.customerId, linkedCustomerIds)))
        .limit(limit);
      for (const d of dealRows) {
        entries.push({ kind: "deal", date: d.updatedAt, refId: d.id, summary: `Deal "${d.title}" (${d.stage}, ${(d.valueMinor / 100).toFixed(2)})` });
      }

      const taskRows = await deps.db
        .select({ id: tasks.id, title: tasks.title, dueAt: tasks.dueAt, doneAt: tasks.doneAt, createdAt: tasks.createdAt })
        .from(tasks)
        .where(and(eq(tasks.orgId, ctx.actor.orgId), eq(tasks.refType, "customer"), inArray(tasks.refId, linkedCustomerIds)))
        .limit(limit);
      for (const t of taskRows) {
        entries.push({ kind: "task", date: t.doneAt ?? t.dueAt ?? t.createdAt, refId: t.id, summary: `Task "${t.title}"${t.doneAt ? " (done)" : ""}` });
      }

      const documentRows = await deps.db
        .select({ id: documents.id, title: documents.title, status: documents.status, updatedAt: documents.updatedAt })
        .from(documents)
        .where(and(eq(documents.orgId, ctx.actor.orgId), eq(documents.refType, "customer"), inArray(documents.refId, linkedCustomerIds)))
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
  registry.register(listCustomerViews(deps));
  registry.register(saveCustomerView(deps));
  registry.register(restoreCustomerView(deps));
  registry.register(createCustomer(deps));
  registry.register(mergeCustomers(deps));
  registry.register(restoreCustomerMerge(deps));
  registry.register(deactivateCustomer(deps));
  registry.register(importCustomers(deps));
  registry.register(undoCustomerImport(deps));
  registry.register(restoreImportedCustomers(deps));
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
  registry.register(updateTaskDetails(deps, "crm.updateTaskDetails", "Update follow-up details", "Change the due date or owner of an open customer follow-up task", "crm.restoreTaskDetails"));
  registry.register(updateTaskDetails(deps, "crm.restoreTaskDetails", "Restore follow-up details", "Restore a follow-up task's earlier due date and owner", "crm.updateTaskDetails"));
  registry.register(listTasks(deps));
  registry.register(customerTimeline(deps));
}

export { createCrmSignalProducer } from "./signals";
