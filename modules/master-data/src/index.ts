/**
 * Master data — business partners.
 *
 * ARCH-3 — extracted from the platform "god module" as the first bounded
 * context. `core.bpartner.*` command/query names are unchanged, so the API
 * and web surface are untouched; only ownership moved to its own package.
 */
import type { Db } from "@chaste/db";
import { schema } from "@chaste/db";
import { NotFoundError, defineCommand, defineQuery, type BusinessModule } from "@chaste/kernel";
import { and, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";

const bpOutputSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  type: z.enum(["person", "organization"]),
  name: z.string(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

function mapBp(row: typeof schema.businessPartners.$inferSelect) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    type: row.type as "person" | "organization",
    name: row.name,
    email: row.email,
    phone: row.phone,
    city: row.city,
    country: row.country,
    notes: row.notes,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function getBpRow(db: Db, orgId: string, id: string) {
  const rows = await db
    .select()
    .from(schema.businessPartners)
    .where(and(eq(schema.businessPartners.organizationId, orgId), eq(schema.businessPartners.id, id)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError("Business partner");
  return row;
}

export function createMasterDataModule(db: Db): BusinessModule {
  return {
    manifest: {
      id: "master-data",
      name: "Master Data",
      version: "0.1.0",
      description: "Business partner master data (customers, vendors, employees, contacts)",
      dependencies: [],
      permissions: ["core.bpartner.manage", "core.bpartner.read"],
      capabilities: ["core.bpartners"],
      specialist: {
        id: "master-data",
        displayName: "Master Data Agent",
        description: "Business partner master data",
        toolTags: ["core"],
      },
    },
    register({ commands, queries }) {
      commands.register(
        defineCommand({
          name: "core.bpartner.create",
          description: "Create a business partner (person or organization)",
          permissions: ["core.bpartner.manage"],
          tags: ["core"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            type: z.enum(["person", "organization"]).default("person"),
            name: z.string().min(1).max(200),
            email: z.string().email().optional(),
            phone: z.string().max(60).optional(),
            city: z.string().max(120).optional(),
            country: z.string().max(120).optional(),
            notes: z.string().max(2000).optional(),
          }),
          output: bpOutputSchema,
          handler: async (input, ctx, helpers) => {
            const [row] = await db
              .insert(schema.businessPartners)
              .values({
                organizationId: ctx.actor.organizationId,
                type: input.type,
                name: input.name,
                email: input.email,
                phone: input.phone,
                city: input.city,
                country: input.country,
                notes: input.notes,
              })
              .returning();
            await helpers.outbox.enqueue({
              id: crypto.randomUUID(),
              type: "core.bpartner.created",
              organizationId: ctx.actor.organizationId,
              occurredAt: ctx.now().toISOString(),
              payload: { businessPartnerId: row!.id, name: row!.name, type: row!.type },
              correlationId: ctx.requestId,
            });
            return mapBp(row!);
          },
        }),
      );
      commands.register(
        defineCommand({
          name: "core.bpartner.update",
          description: "Update a business partner's shared identity fields",
          permissions: ["core.bpartner.manage"],
          tags: ["core"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            businessPartnerId: z.string().uuid(),
            name: z.string().min(1).max(200).optional(),
            email: z.string().email().optional(),
            phone: z.string().max(60).optional(),
            city: z.string().max(120).optional(),
            country: z.string().max(120).optional(),
            notes: z.string().max(2000).optional(),
          }),
          output: bpOutputSchema,
          handler: async (input, ctx, helpers) => {
            const row = await getBpRow(db, ctx.actor.organizationId, input.businessPartnerId);
            const [updated] = await db
              .update(schema.businessPartners)
              .set({
                name: input.name ?? row.name,
                email: input.email === undefined ? row.email : input.email,
                phone: input.phone === undefined ? row.phone : input.phone,
                city: input.city === undefined ? row.city : input.city,
                country: input.country === undefined ? row.country : input.country,
                notes: input.notes === undefined ? row.notes : input.notes,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(schema.businessPartners.organizationId, ctx.actor.organizationId),
                  eq(schema.businessPartners.id, input.businessPartnerId),
                ),
              )
              .returning();
            await helpers.outbox.enqueue({
              id: crypto.randomUUID(),
              type: "core.bpartner.updated",
              organizationId: ctx.actor.organizationId,
              occurredAt: ctx.now().toISOString(),
              payload: { businessPartnerId: input.businessPartnerId },
              correlationId: ctx.requestId,
            });
            return mapBp(updated!);
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.bpartner.delete",
          description: "Archive a business partner (soft delete; role history preserved)",
          permissions: ["core.bpartner.manage"],
          tags: ["core"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({ businessPartnerId: z.string().uuid() }),
          output: z.object({ businessPartnerId: z.string(), deleted: z.literal(true) }),
          handler: async (input, ctx, helpers) => {
            await getBpRow(db, ctx.actor.organizationId, input.businessPartnerId);
            await db
              .update(schema.businessPartners)
              .set({ status: "archived", updatedAt: new Date() })
              .where(
                and(
                  eq(schema.businessPartners.organizationId, ctx.actor.organizationId),
                  eq(schema.businessPartners.id, input.businessPartnerId),
                ),
              );
            await helpers.outbox.enqueue({
              id: crypto.randomUUID(),
              type: "core.bpartner.archived",
              organizationId: ctx.actor.organizationId,
              occurredAt: ctx.now().toISOString(),
              payload: { businessPartnerId: input.businessPartnerId },
              correlationId: ctx.requestId,
            });
            return { businessPartnerId: input.businessPartnerId, deleted: true as const };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "core.bpartner.list",
          description: "List business partners with optional search and type filter",
          permissions: ["core.bpartner.read"],
          tags: ["core"],
          input: z
            .object({
              search: z.string().max(200).optional(),
              type: z.enum(["person", "organization"]).optional(),
              includeArchived: z.boolean().optional(),
            })
            .default({}),
          output: z.object({ items: z.array(bpOutputSchema) }),
          handler: async (input, ctx) => {
            const org = ctx.actor.organizationId;
            const conds = [eq(schema.businessPartners.organizationId, org)];
            if (!input.includeArchived) conds.push(ne(schema.businessPartners.status, "archived"));
            if (input.type) conds.push(eq(schema.businessPartners.type, input.type));
            const rows = await db
              .select()
              .from(schema.businessPartners)
              .where(and(...conds))
              .orderBy(desc(schema.businessPartners.createdAt));
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
            return { items: filtered.map(mapBp) };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "core.bpartner.get",
          description: "Get a single business partner by id",
          permissions: ["core.bpartner.read"],
          tags: ["core"],
          input: z.object({ businessPartnerId: z.string().uuid() }),
          output: bpOutputSchema,
          handler: async (input, ctx) => {
            const row = await getBpRow(db, ctx.actor.organizationId, input.businessPartnerId);
            return mapBp(row);
          },
        }),
      );
    },
  };
}
