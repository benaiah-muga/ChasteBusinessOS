import type { Db } from "@chaste/db";
import { schema } from "@chaste/db";
import { NotFoundError, ValidationError } from "@chaste/kernel";
import { defineCommand, defineQuery, type BusinessModule } from "@chaste/kernel";
import { and, desc, eq, ne } from "drizzle-orm";
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

const contactSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  name: z.string(),
  role: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  createdAt: z.string(),
});

const interactionSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  kind: z.string(),
  summary: z.string(),
  detail: z.string().nullable().optional(),
  createdAt: z.string(),
});

const CONTACT_MANAGE = "crm.contact.manage";
const CONTACT_READ = "crm.contact.read";
const INTERACTION_WRITE = "crm.interaction.write";
const INTERACTION_READ = "crm.interaction.read";
const CUSTOMER_UPDATE = "crm.customer.update";

const CUSTOMER_STATUSES = [
  "lead",
  "prospect",
  "qualified",
  "negotiable",
  "won",
  "lost",
  "active",
  "churned",
] as const;

/** Allowed lifecycle transitions. `deleted` is terminal (soft delete only). */
const TRANSITIONS: Record<string, readonly string[]> = {
  lead: ["prospect", "qualified", "lost"],
  prospect: ["lead", "qualified", "lost"],
  qualified: ["prospect", "negotiable", "won", "lost"],
  negotiable: ["qualified", "won", "lost"],
  won: ["active", "churned"],
  active: ["won", "churned"],
  churned: ["active"], // reactivate
  lost: ["lead", "prospect"], // reopen
  deleted: [],
};

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

interface ContactRow {
  id: string;
  customerId: string;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  createdAt: Date;
}

interface InteractionRow {
  id: string;
  customerId: string;
  kind: string;
  summary: string;
  detail: string | null;
  createdAt: Date;
}

function mapContact(row: ContactRow) {
  return {
    id: row.id,
    customerId: row.customerId,
    name: row.name,
    role: row.role,
    email: row.email,
    phone: row.phone,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapInteraction(row: InteractionRow) {
  return {
    id: row.id,
    customerId: row.customerId,
    kind: row.kind,
    summary: row.summary,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
  };
}

async function getCustomerRow(db: Db, orgId: string, customerId: string) {
  const rows = await db
    .select()
    .from(schema.crmCustomers)
    .where(and(eq(schema.crmCustomers.organizationId, orgId), eq(schema.crmCustomers.id, customerId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError("Customer");
  return row;
}

function actorUserId(ctx: { actor: { kind: string; userId: string } }) {
  return ctx.actor.kind === "user" ? ctx.actor.userId : null;
}

function nextId() {
  return crypto.randomUUID();
}

export function createCrmModule(db: Db): BusinessModule {
  return {
    manifest: {
      id: "crm",
      name: "CRM",
      version: "0.2.0",
      description: "Customer relationship management",
      dependencies: [],
      permissions: [
        "crm.customer.create",
        "crm.customer.read",
        CUSTOMER_UPDATE,
        CONTACT_MANAGE,
        CONTACT_READ,
        INTERACTION_WRITE,
        INTERACTION_READ,
      ],
      capabilities: ["crm.customers", "crm.contacts", "crm.interactions"],
      specialist: {
        id: "crm",
        displayName: "CRM Agent",
        description: "Customers, contacts and relationship activity",
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
            const tx = (helpers.db ?? db) as Db;
            const [row] = await tx
              .insert(schema.crmCustomers)
              .values({
                organizationId: ctx.actor.organizationId,
                name: input.name,
                email: input.email,
                city: input.city,
                country: input.country,
              })
              .returning();
            await tx.insert(schema.crmInteractions).values({
              organizationId: ctx.actor.organizationId,
              customerId: row!.id,
              kind: "created",
              summary: "Customer created",
              actorUserId: actorUserId(ctx),
            });
            await helpers.outbox.enqueue({
              id: nextId(),
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
      commands.register(
        defineCommand({
          name: "crm.customer.update",
          description: "Update customer contact details",
          permissions: [CUSTOMER_UPDATE],
          tags: ["crm"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            customerId: z.string().uuid(),
            name: z.string().min(1).max(200).optional(),
            email: z.string().email().optional(),
            city: z.string().max(120).optional(),
            country: z.string().max(120).optional(),
          }),
          output: customerSchema,
          handler: async (input, ctx, helpers) => {
            const tx = (helpers.db ?? db) as Db;
            const row = await getCustomerRow(tx, ctx.actor.organizationId, input.customerId);
            const [updated] = await tx
              .update(schema.crmCustomers)
              .set({
                name: input.name ?? row.name,
                email: input.email === undefined ? row.email : input.email,
                city: input.city === undefined ? row.city : input.city,
                country: input.country === undefined ? row.country : input.country,
              })
              .where(
                and(
                  eq(schema.crmCustomers.organizationId, ctx.actor.organizationId),
                  eq(schema.crmCustomers.id, input.customerId),
                ),
              )
              .returning();
            await helpers.outbox.enqueue({
              id: nextId(),
              type: "crm.customer.updated",
              organizationId: ctx.actor.organizationId,
              occurredAt: ctx.now().toISOString(),
              payload: { customerId: input.customerId },
              correlationId: ctx.requestId,
            });
            return mapCustomer(updated!);
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "crm.customer.setStatus",
          description: "Transition a customer to a new pipeline status",
          permissions: [CUSTOMER_UPDATE],
          tags: ["crm"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            customerId: z.string().uuid(),
            status: z.enum(CUSTOMER_STATUSES),
            note: z.string().max(500).optional(),
          }),
          output: customerSchema,
          handler: async (input, ctx, helpers) => {
            const tx = (helpers.db ?? db) as Db;
            const row = await getCustomerRow(tx, ctx.actor.organizationId, input.customerId);
            if (row.status === input.status) return mapCustomer(row);
            const allowed = TRANSITIONS[row.status] ?? [];
            if (!allowed.includes(input.status)) {
              throw new ValidationError(
                `Cannot move customer from "${row.status}" to "${input.status}"`,
              );
            }
            const [updated] = await tx
              .update(schema.crmCustomers)
              .set({ status: input.status })
              .where(
                and(
                  eq(schema.crmCustomers.organizationId, ctx.actor.organizationId),
                  eq(schema.crmCustomers.id, input.customerId),
                ),
              )
              .returning();
            await tx.insert(schema.crmInteractions).values({
              organizationId: ctx.actor.organizationId,
              customerId: input.customerId,
              kind: "status_change",
              summary: `Status changed from "${row.status}" to "${input.status}"`,
              detail: input.note,
              actorUserId: actorUserId(ctx),
            });
            await helpers.outbox.enqueue({
              id: nextId(),
              type: "crm.customer.status_changed",
              organizationId: ctx.actor.organizationId,
              occurredAt: ctx.now().toISOString(),
              payload: { customerId: input.customerId, from: row.status, to: input.status },
              correlationId: ctx.requestId,
            });
            return mapCustomer(updated!);
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "crm.customer.delete",
          description: "Soft-delete a customer (archived, history preserved)",
          permissions: [CUSTOMER_UPDATE],
          tags: ["crm"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({ customerId: z.string().uuid() }),
          output: z.object({ customerId: z.string(), deleted: z.literal(true) }),
          handler: async (input, ctx, helpers) => {
            const tx = (helpers.db ?? db) as Db;
            await getCustomerRow(tx, ctx.actor.organizationId, input.customerId);
            await tx
              .update(schema.crmCustomers)
              .set({ status: "deleted" })
              .where(
                and(
                  eq(schema.crmCustomers.organizationId, ctx.actor.organizationId),
                  eq(schema.crmCustomers.id, input.customerId),
                ),
              );
            await tx.insert(schema.crmInteractions).values({
              organizationId: ctx.actor.organizationId,
              customerId: input.customerId,
              kind: "deleted",
              summary: "Customer deleted (archived)",
              actorUserId: actorUserId(ctx),
            });
            await helpers.outbox.enqueue({
              id: nextId(),
              type: "crm.customer.deleted",
              organizationId: ctx.actor.organizationId,
              occurredAt: ctx.now().toISOString(),
              payload: { customerId: input.customerId },
              correlationId: ctx.requestId,
            });
            return { customerId: input.customerId, deleted: true as const };
          },
        }),
      );
      commands.register(
        defineCommand({
          name: "crm.contact.create",
          description: "Add a contact to a customer",
          permissions: [CONTACT_MANAGE],
          tags: ["crm"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            customerId: z.string().uuid(),
            name: z.string().min(1).max(200),
            role: z.string().max(120).optional(),
            email: z.string().email().optional(),
            phone: z.string().max(60).optional(),
          }),
          output: contactSchema,
          handler: async (input, ctx, helpers) => {
            const tx = (helpers.db ?? db) as Db;
            await getCustomerRow(tx, ctx.actor.organizationId, input.customerId);
            const [row] = await tx
              .insert(schema.crmContacts)
              .values({
                organizationId: ctx.actor.organizationId,
                customerId: input.customerId,
                name: input.name,
                role: input.role,
                email: input.email,
                phone: input.phone,
              })
              .returning();
            await tx.insert(schema.crmInteractions).values({
              organizationId: ctx.actor.organizationId,
              customerId: input.customerId,
              kind: "contact_added",
              summary: `Contact "${input.name}" added`,
              actorUserId: actorUserId(ctx),
            });
            await helpers.outbox.enqueue({
              id: nextId(),
              type: "crm.contact.created",
              organizationId: ctx.actor.organizationId,
              occurredAt: ctx.now().toISOString(),
              payload: { customerId: input.customerId, contactId: row!.id, name: row!.name },
              correlationId: ctx.requestId,
            });
            return mapContact(row!);
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "crm.contact.delete",
          description: "Remove a contact from a customer",
          permissions: [CONTACT_MANAGE],
          tags: ["crm"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({ contactId: z.string().uuid() }),
          output: z.object({ contactId: z.string(), deleted: z.literal(true) }),
          handler: async (input, ctx, helpers) => {
            const tx = (helpers.db ?? db) as Db;
            const rows = await tx
              .select()
              .from(schema.crmContacts)
              .where(
                and(
                  eq(schema.crmContacts.organizationId, ctx.actor.organizationId),
                  eq(schema.crmContacts.id, input.contactId),
                ),
              )
              .limit(1);
            const contact = rows[0];
            if (!contact) throw new NotFoundError("Contact");
            await tx.delete(schema.crmContacts).where(eq(schema.crmContacts.id, input.contactId));
            await tx.insert(schema.crmInteractions).values({
              organizationId: ctx.actor.organizationId,
              customerId: contact.customerId,
              kind: "contact_removed",
              summary: `Contact "${contact.name}" removed`,
              actorUserId: actorUserId(ctx),
            });
            await helpers.outbox.enqueue({
              id: nextId(),
              type: "crm.contact.deleted",
              organizationId: ctx.actor.organizationId,
              occurredAt: ctx.now().toISOString(),
              payload: { customerId: contact.customerId, contactId: input.contactId },
              correlationId: ctx.requestId,
            });
            return { contactId: input.contactId, deleted: true as const };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "crm.interaction.log",
          description: "Record an activity note against a customer",
          permissions: [INTERACTION_WRITE],
          tags: ["crm"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            customerId: z.string().uuid(),
            kind: z.enum(["note", "email", "call", "meeting"]).default("note"),
            summary: z.string().min(1).max(300),
            detail: z.string().max(2000).optional(),
          }),
          output: interactionSchema,
          handler: async (input, ctx, helpers) => {
            const tx = (helpers.db ?? db) as Db;
            await getCustomerRow(tx, ctx.actor.organizationId, input.customerId);
            const [row] = await tx
              .insert(schema.crmInteractions)
              .values({
                organizationId: ctx.actor.organizationId,
                customerId: input.customerId,
                kind: input.kind,
                summary: input.summary,
                detail: input.detail,
                actorUserId: actorUserId(ctx),
              })
              .returning();
            await helpers.outbox.enqueue({
              id: nextId(),
              type: "crm.interaction.logged",
              organizationId: ctx.actor.organizationId,
              occurredAt: ctx.now().toISOString(),
              payload: { customerId: input.customerId, interactionId: row!.id },
              correlationId: ctx.requestId,
            });
            return mapInteraction(row!);
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "crm.customer.list",
          description: "List customers with optional search and status filter",
          permissions: ["crm.customer.read"],
          tags: ["crm"],
          input: z.object({
            search: z.string().max(200).optional(),
            status: z.string().max(60).optional(),
            includeDeleted: z.boolean().optional(),
          }).default({}),
          output: z.object({ items: z.array(customerSchema) }),
          handler: async (input, ctx) => {
            const org = ctx.actor.organizationId;
            const conds = [eq(schema.crmCustomers.organizationId, org)];
            if (!input.includeDeleted) {
              conds.push(ne(schema.crmCustomers.status, "deleted"));
            }
            if (input.status) conds.push(eq(schema.crmCustomers.status, input.status));
            const rows = await db
              .select()
              .from(schema.crmCustomers)
              .where(and(...conds))
              .orderBy(desc(schema.crmCustomers.createdAt));
            const term = input.search?.toLowerCase().trim();
            const filtered = term
              ? rows.filter(
                  (r) =>
                    r.name.toLowerCase().includes(term) ||
                    (r.email ?? "").toLowerCase().includes(term) ||
                    (r.city ?? "").toLowerCase().includes(term) ||
                    (r.country ?? "").toLowerCase().includes(term),
                )
              : rows;
            return { items: filtered.map(mapCustomer) };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "crm.customer.get",
          description: "Get a single customer by id",
          permissions: ["crm.customer.read"],
          tags: ["crm"],
          input: z.object({ customerId: z.string().uuid() }),
          output: customerSchema,
          handler: async (input, ctx) => {
            const row = await getCustomerRow(db, ctx.actor.organizationId, input.customerId);
            return mapCustomer(row);
          },
        }),
      );
      queries.register(
        defineQuery({
          name: "crm.contact.list",
          description: "List contacts for a customer",
          permissions: [CONTACT_READ],
          tags: ["crm"],
          input: z.object({ customerId: z.string().uuid() }),
          output: z.object({ items: z.array(contactSchema) }),
          handler: async (input, ctx) => {
            await getCustomerRow(db, ctx.actor.organizationId, input.customerId);
            const rows = await db
              .select()
              .from(schema.crmContacts)
              .where(
                and(
                  eq(schema.crmContacts.organizationId, ctx.actor.organizationId),
                  eq(schema.crmContacts.customerId, input.customerId),
                ),
              )
              .orderBy(desc(schema.crmContacts.createdAt));
            return { items: rows.map(mapContact) };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "crm.interaction.list",
          description: "List activity for a customer",
          permissions: [INTERACTION_READ],
          tags: ["crm"],
          input: z.object({ customerId: z.string().uuid() }),
          output: z.object({ items: z.array(interactionSchema) }),
          handler: async (input, ctx) => {
            await getCustomerRow(db, ctx.actor.organizationId, input.customerId);
            const rows = await db
              .select()
              .from(schema.crmInteractions)
              .where(
                and(
                  eq(schema.crmInteractions.organizationId, ctx.actor.organizationId),
                  eq(schema.crmInteractions.customerId, input.customerId),
                ),
              )
              .orderBy(desc(schema.crmInteractions.createdAt));
            return { items: rows.map(mapInteraction) };
          },
        }),
      );
    },
  };
}
