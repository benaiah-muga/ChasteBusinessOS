import type { Db } from "@chaste/db";
import { PERMISSION_CATALOG, schema } from "@chaste/db";
import {
  FULL_AUTONOMOUS_WARNING,
  autonomyLevelSchema,
  defineCommand,
  defineQuery,
  type BusinessModule,
  type ModuleRegistry,
  ValidationError,
} from "@chaste/kernel";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

export function createPlatformModule(
  db: Db,
  modules: ModuleRegistry,
  opts: { allowFullAutonomous: boolean; regions: string[] },
): BusinessModule {
  return {
    manifest: {
      id: "platform",
      name: "Platform",
      version: "0.1.0",
      description: "RBAC, modules, autonomy, marketplace, regions",
      dependencies: [],
      permissions: [
        "core.modules.read",
        "core.modules.manage",
        "core.rbac.read",
        "core.rbac.manage",
        "core.autonomy.manage",
        "core.marketplace.read",
      ],
      capabilities: ["core.rbac", "core.marketplace", "core.autonomy"],
      specialist: {
        id: "system",
        displayName: "System Agent",
        description: "Modules, policies, RBAC, marketplace",
        toolTags: ["core"],
      },
    },
    register({ commands, queries }) {
      queries.register(
        defineQuery({
          name: "core.modules.list",
          permissions: ["core.modules.read"],
          tags: ["core"],
          input: z.object({}).default({}),
          output: z.object({
            registered: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                version: z.string(),
                capabilities: z.array(z.string()),
              }),
            ),
            installed: z.array(
              z.object({
                moduleId: z.string(),
                version: z.string(),
                enabled: z.boolean(),
              }),
            ),
          }),
          handler: async (_i, ctx) => {
            const installed = await db
              .select()
              .from(schema.moduleInstalls)
              .where(eq(schema.moduleInstalls.organizationId, ctx.actor.organizationId));
            return {
              registered: modules.list().map((m) => ({
                id: m.id,
                name: m.name,
                version: m.version,
                capabilities: m.capabilities,
              })),
              installed: installed.map((i) => ({
                moduleId: i.moduleId,
                version: i.version,
                enabled: i.enabled,
              })),
            };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "core.rbac.overview",
          permissions: ["core.rbac.read"],
          tags: ["core"],
          input: z.object({}).default({}),
          output: z.object({
            roles: z.array(
              z.object({
                id: z.string(),
                key: z.string(),
                name: z.string(),
                isSystem: z.boolean(),
                permissions: z.array(z.string()),
              }),
            ),
            users: z.array(
              z.object({
                id: z.string(),
                email: z.string(),
                displayName: z.string(),
                roleKeys: z.array(z.string()),
              }),
            ),
            permissionCatalog: z.array(
              z.object({
                permission: z.string(),
                module: z.string(),
                description: z.string(),
              }),
            ),
          }),
          handler: async (_i, ctx) => {
            const org = ctx.actor.organizationId;
            const roles = await db
              .select()
              .from(schema.roles)
              .where(eq(schema.roles.organizationId, org));
            const users = await db
              .select()
              .from(schema.users)
              .where(eq(schema.users.organizationId, org));

            const roleOut = [];
            for (const role of roles) {
              const perms = await db
                .select()
                .from(schema.rolePermissions)
                .where(eq(schema.rolePermissions.roleId, role.id));
              roleOut.push({
                id: role.id,
                key: role.key,
                name: role.name,
                isSystem: role.isSystem,
                permissions: perms.map((p) => p.permission),
              });
            }

            const userOut = [];
            for (const user of users) {
              const urs = await db
                .select({ key: schema.roles.key })
                .from(schema.userRoles)
                .innerJoin(schema.roles, eq(schema.userRoles.roleId, schema.roles.id))
                .where(eq(schema.userRoles.userId, user.id));
              userOut.push({
                id: user.id,
                email: user.email,
                displayName: user.displayName,
                roleKeys: urs.map((r) => r.key),
              });
            }

            return {
              roles: roleOut,
              users: userOut,
              permissionCatalog: PERMISSION_CATALOG,
            };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.role.create",
          permissions: ["core.rbac.manage"],
          tags: ["core"],
          input: z.object({
            key: z.string().min(1).max(64),
            name: z.string().min(1),
            description: z.string().optional(),
            permissions: z.array(z.string()).default([]),
          }),
          output: z.object({ id: z.string(), key: z.string(), name: z.string() }),
          handler: async (input, ctx) => {
            const [role] = await db
              .insert(schema.roles)
              .values({
                organizationId: ctx.actor.organizationId,
                key: input.key,
                name: input.name,
                description: input.description,
                isSystem: false,
              })
              .returning();
            for (const permission of input.permissions) {
              await db.insert(schema.rolePermissions).values({ roleId: role!.id, permission });
            }
            return { id: role!.id, key: role!.key, name: role!.name };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.user.assignRole",
          permissions: ["core.rbac.manage"],
          tags: ["core"],
          input: z.object({ userId: z.string().uuid(), roleId: z.string().uuid() }),
          output: z.object({ ok: z.literal(true) }),
          handler: async (input) => {
            await db
              .insert(schema.userRoles)
              .values({ userId: input.userId, roleId: input.roleId })
              .onConflictDoNothing();
            return { ok: true as const };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.user.create",
          permissions: ["core.rbac.manage"],
          tags: ["core"],
          input: z.object({
            email: z.string().email(),
            displayName: z.string().min(1),
            roleId: z.string().uuid().optional(),
          }),
          output: z.object({
            id: z.string(),
            email: z.string(),
            displayName: z.string(),
            authToken: z.string(),
          }),
          handler: async (input, ctx) => {
            const authToken = crypto.randomUUID();
            const [user] = await db
              .insert(schema.users)
              .values({
                organizationId: ctx.actor.organizationId,
                email: input.email,
                displayName: input.displayName,
                authToken,
              })
              .returning();
            if (input.roleId) {
              await db
                .insert(schema.userRoles)
                .values({ userId: user!.id, roleId: input.roleId })
                .onConflictDoNothing();
            }
            return {
              id: user!.id,
              email: user!.email,
              displayName: user!.displayName,
              authToken,
            };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.user.deactivate",
          permissions: ["core.rbac.manage"],
          tags: ["core"],
          input: z.object({ userId: z.string().uuid() }),
          output: z.object({ ok: z.literal(true) }),
          handler: async (input, ctx) => {
            await db
              .update(schema.users)
              .set({ isActive: false })
              .where(eq(schema.users.id, input.userId));
            return { ok: true as const };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.user.removeRole",
          permissions: ["core.rbac.manage"],
          tags: ["core"],
          input: z.object({ userId: z.string().uuid(), roleId: z.string().uuid() }),
          output: z.object({ ok: z.literal(true) }),
          handler: async (input) => {
            await db
              .delete(schema.userRoles)
              .where(
                and(
                  eq(schema.userRoles.userId, input.userId),
                  eq(schema.userRoles.roleId, input.roleId),
                ),
              );
            return { ok: true as const };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.autonomy.set",
          permissions: ["core.autonomy.manage"],
          tags: ["core"],
          minAutonomyForAuto: "full_autonomous",
          input: z.object({
            autonomy: autonomyLevelSchema,
            acknowledgeFullAutonomous: z.boolean().default(false),
          }),
          output: z.object({
            autonomy: autonomyLevelSchema,
            warning: z.string().optional(),
          }),
          handler: async (input, ctx) => {
            if (input.autonomy === "full_autonomous") {
              if (!opts.allowFullAutonomous) {
                throw new ValidationError(
                  "Full autonomous mode is disabled by platform policy (CHASTE_ALLOW_FULL_AUTONOMOUS)",
                );
              }
              if (!input.acknowledgeFullAutonomous) {
                throw new ValidationError(
                  "Full autonomous mode requires explicit acknowledgement",
                  { warning: FULL_AUTONOMOUS_WARNING },
                );
              }
            }
            await db
              .update(schema.organizations)
              .set({
                autonomy: input.autonomy,
                fullAutonomousAcknowledgedAt:
                  input.autonomy === "full_autonomous" ? new Date() : null,
              })
              .where(eq(schema.organizations.id, ctx.actor.organizationId));
            return {
              autonomy: input.autonomy,
              warning:
                input.autonomy === "full_autonomous" ? FULL_AUTONOMOUS_WARNING : undefined,
            };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "core.marketplace.list",
          permissions: ["core.marketplace.read"],
          tags: ["core"],
          input: z.object({ region: z.string().optional() }).default({}),
          output: z.object({
            items: z.array(
              z.object({
                moduleId: z.string(),
                name: z.string(),
                version: z.string(),
                summary: z.string(),
                category: z.string(),
                publisher: z.string(),
                regions: z.array(z.string()),
              }),
            ),
            platformRegions: z.array(z.string()),
          }),
          handler: async (input) => {
            const rows = await db.select().from(schema.marketplaceListings);
            const region = input.region;
            const items = rows
              .filter((r) => {
                if (!region) return true;
                const regs = r.regions ?? ["*"];
                return regs.includes("*") || regs.includes(region);
              })
              .map((r) => ({
                moduleId: r.moduleId,
                name: r.name,
                version: r.version,
                summary: r.summary,
                category: r.category,
                publisher: r.publisher,
                regions: r.regions ?? ["*"],
              }));
            return { items, platformRegions: opts.regions };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.module.install",
          permissions: ["core.modules.manage"],
          tags: ["core"],
          input: z.object({ moduleId: z.string().min(1), version: z.string().default("0.1.0") }),
          output: z.object({ moduleId: z.string(), enabled: z.boolean() }),
          handler: async (input, ctx) => {
            await db
              .insert(schema.moduleInstalls)
              .values({
                organizationId: ctx.actor.organizationId,
                moduleId: input.moduleId,
                version: input.version,
                enabled: true,
              })
              .onConflictDoNothing();
            return { moduleId: input.moduleId, enabled: true };
          },
        }),
      );
    },
  };
}
