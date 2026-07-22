import type { Db } from "@chaste/db";
import { PERMISSION_CATALOG, schema } from "@chaste/db";
import {
  orgSettingsSchema,
  orgSettingsUpdateSchema,
  userPreferencesSchema,
  userPreferencesUpdateSchema,
} from "@chaste/db";
import {
  FULL_AUTONOMOUS_WARNING,
  autonomyLevelSchema,
  defineCommand,
  defineQuery,
  type BusinessModule,
  type ModuleRegistry,
  ValidationError,
} from "@chaste/kernel";
import { and, eq, or } from "drizzle-orm";
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
        "core.user.manage",
        "core.user.read",
        "core.role.manage",
        "core.role.assign",
        "core.autonomy.manage",
        "core.marketplace.read",
        "core.settings.read",
        "core.settings.manage",
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
          permissions: ["core.role.manage"],
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
          permissions: ["core.role.assign"],
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
          permissions: ["core.user.manage"],
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
          permissions: ["core.user.manage"],
          tags: ["core"],
          input: z.object({ userId: z.string().uuid() }),
          output: z.object({ ok: z.literal(true) }),
          handler: async (input, ctx) => {
            if (input.userId === ctx.actor.userId) {
              throw new ValidationError("Cannot deactivate your own account");
            }

            // Check if target is the last admin
            const adminPerms = await db
              .select({ userId: schema.userRoles.userId })
              .from(schema.userRoles)
              .innerJoin(schema.rolePermissions, eq(schema.userRoles.roleId, schema.rolePermissions.roleId))
              .where(
                or(
                  eq(schema.rolePermissions.permission, "core.user.manage"),
                  eq(schema.rolePermissions.permission, "core.role.manage"),
                ),
              );
            const uniqueAdminIds = [...new Set(adminPerms.map((r) => r.userId))];
            if (uniqueAdminIds.length === 1 && uniqueAdminIds[0] === input.userId) {
              throw new ValidationError("Cannot deactivate the last administrator");
            }

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
          permissions: ["core.role.assign"],
          tags: ["core"],
          input: z.object({ userId: z.string().uuid(), roleId: z.string().uuid() }),
          output: z.object({ ok: z.literal(true) }),
          handler: async (input, ctx) => {
            // Guard: cannot remove own admin-level role
            if (input.userId === ctx.actor.userId) {
              const rolePerms = await db
                .select({ permission: schema.rolePermissions.permission })
                .from(schema.rolePermissions)
                .where(eq(schema.rolePermissions.roleId, input.roleId));
              const hasAdminPerms = rolePerms.some(
                (p) =>
                  p.permission === "core.role.manage" ||
                  p.permission === "core.user.manage",
              );
              if (hasAdminPerms) {
                throw new ValidationError("Cannot remove admin role from yourself");
              }
            }

            // Guard: cannot remove last admin's role
            const targetUserRoles = await db
              .select({ roleId: schema.userRoles.roleId })
              .from(schema.userRoles)
              .where(eq(schema.userRoles.userId, input.userId));
            const isTargetAdmin = targetUserRoles.some((r) => r.roleId === input.roleId);
            if (isTargetAdmin) {
              // Check if removing this role would leave the user with no admin permissions
              const otherAdminRoles = await db
                .select({ roleId: schema.rolePermissions.roleId })
                .from(schema.rolePermissions)
                .innerJoin(schema.userRoles, eq(schema.rolePermissions.roleId, schema.userRoles.roleId))
                .where(
                  and(
                    eq(schema.userRoles.userId, input.userId),
                    or(
                      eq(schema.rolePermissions.permission, "core.user.manage"),
                      eq(schema.rolePermissions.permission, "core.role.manage"),
                    ),
                  ),
                );
              const otherRoleIds = [...new Set(otherAdminRoles.map((r) => r.roleId))].filter(
                (id) => id !== input.roleId,
              );
              if (otherRoleIds.length === 0) {
                throw new ValidationError("Cannot remove the last admin role from a user");
              }
            }

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

      // ─── Role CRUD ─────────────────────────────────────────────────────

      commands.register(
        defineCommand({
          name: "core.role.update",
          permissions: ["core.role.manage"],
          tags: ["core"],
          input: z.object({
            roleId: z.string().uuid(),
            name: z.string().min(1).optional(),
            description: z.string().optional(),
            permissions: z.array(z.string()).optional(),
          }),
          output: z.object({ id: z.string(), key: z.string(), name: z.string() }),
          handler: async (input, ctx) => {
            const [role] = await db
              .select()
              .from(schema.roles)
              .where(eq(schema.roles.id, input.roleId));
            if (!role) {
              throw new ValidationError("Role not found");
            }
            if (role.organizationId !== ctx.actor.organizationId) {
              throw new ValidationError("Role not found");
            }
            if (role.isSystem) {
              throw new ValidationError("Cannot modify system roles");
            }

            const updates: Record<string, unknown> = {};
            if (input.name !== undefined) updates.name = input.name;
            if (input.description !== undefined) updates.description = input.description;

            if (Object.keys(updates).length > 0) {
              await db
                .update(schema.roles)
                .set(updates)
                .where(eq(schema.roles.id, input.roleId));
            }

            if (input.permissions !== undefined) {
              // Replace all permissions
              await db
                .delete(schema.rolePermissions)
                .where(eq(schema.rolePermissions.roleId, input.roleId));
              for (const permission of input.permissions) {
                await db
                  .insert(schema.rolePermissions)
                  .values({ roleId: input.roleId, permission });
              }
            }

            const [updated] = await db
              .select()
              .from(schema.roles)
              .where(eq(schema.roles.id, input.roleId));
            return { id: updated!.id, key: updated!.key, name: updated!.name };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.role.delete",
          permissions: ["core.role.manage"],
          tags: ["core"],
          input: z.object({ roleId: z.string().uuid() }),
          output: z.object({ ok: z.literal(true) }),
          handler: async (input, ctx) => {
            const [role] = await db
              .select()
              .from(schema.roles)
              .where(eq(schema.roles.id, input.roleId));
            if (!role) {
              throw new ValidationError("Role not found");
            }
            if (role.organizationId !== ctx.actor.organizationId) {
              throw new ValidationError("Role not found");
            }
            if (role.isSystem) {
              throw new ValidationError("Cannot delete system roles");
            }

            // Check if any user has this as their only admin role
            const usersWithRole = await db
              .select({ userId: schema.userRoles.userId })
              .from(schema.userRoles)
              .where(eq(schema.userRoles.roleId, input.roleId));

            for (const { userId } of usersWithRole) {
              const otherAdminRoles = await db
                .select({ roleId: schema.rolePermissions.roleId })
                .from(schema.rolePermissions)
                .innerJoin(schema.userRoles, eq(schema.rolePermissions.roleId, schema.userRoles.roleId))
                .where(
                  and(
                    eq(schema.userRoles.userId, userId),
                    or(
                      eq(schema.rolePermissions.permission, "core.user.manage"),
                      eq(schema.rolePermissions.permission, "core.role.manage"),
                    ),
                  ),
                );
              const otherRoleIds = [
                ...new Set(otherAdminRoles.map((r) => r.roleId)),
              ].filter((id) => id !== input.roleId);
              if (otherRoleIds.length === 0) {
                throw new ValidationError(
                  `Cannot delete role: user ${userId} would have no admin permissions`,
                );
              }
            }

            // Cascade delete handles role_permissions and user_roles
            await db.delete(schema.roles).where(eq(schema.roles.id, input.roleId));
            return { ok: true as const };
          },
        }),
      );

      // ─── User management ───────────────────────────────────────────────

      commands.register(
        defineCommand({
          name: "core.user.activate",
          permissions: ["core.user.manage"],
          tags: ["core"],
          input: z.object({ userId: z.string().uuid() }),
          output: z.object({ ok: z.literal(true) }),
          handler: async (input, ctx) => {
            const [user] = await db
              .select()
              .from(schema.users)
              .where(eq(schema.users.id, input.userId));
            if (!user) {
              throw new ValidationError("User not found");
            }
            if (user.organizationId !== ctx.actor.organizationId) {
              throw new ValidationError("User not found");
            }
            await db
              .update(schema.users)
              .set({ isActive: true })
              .where(eq(schema.users.id, input.userId));
            return { ok: true as const };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "core.user.list",
          permissions: ["core.user.read"],
          tags: ["core"],
          input: z.object({}).default({}),
          output: z.object({
            users: z.array(
              z.object({
                id: z.string(),
                email: z.string(),
                displayName: z.string(),
                isActive: z.boolean(),
                roles: z.array(
                  z.object({ id: z.string(), key: z.string(), name: z.string() }),
                ),
                createdAt: z.string(),
              }),
            ),
          }),
          handler: async (_i, ctx) => {
            const users = await db
              .select()
              .from(schema.users)
              .where(eq(schema.users.organizationId, ctx.actor.organizationId));

            const result = [];
            for (const user of users) {
              const userRoles = await db
                .select({
                  id: schema.roles.id,
                  key: schema.roles.key,
                  name: schema.roles.name,
                })
                .from(schema.userRoles)
                .innerJoin(schema.roles, eq(schema.userRoles.roleId, schema.roles.id))
                .where(eq(schema.userRoles.userId, user.id));

              result.push({
                id: user.id,
                email: user.email,
                displayName: user.displayName,
                isActive: user.isActive,
                roles: userRoles,
                createdAt: user.createdAt.toISOString(),
              });
            }

            return { users: result };
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
          input: z
            .object({
              region: z.string().optional(),
              includeArchived: z.boolean().optional(),
            })
            .default({}),
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
                kind: z.enum(["builtin", "custom"]),
                archived: z.boolean(),
                installed: z.boolean(),
                enabled: z.boolean(),
              }),
            ),
            platformRegions: z.array(z.string()),
          }),
          handler: async (input, ctx) => {
            const rows = await db.select().from(schema.marketplaceListings);
            const installs = await db
              .select()
              .from(schema.moduleInstalls)
              .where(eq(schema.moduleInstalls.organizationId, ctx.actor.organizationId));
            const installById = new Map(installs.map((i) => [i.moduleId, i]));
            const region = input.region;
            const items = rows
              .filter((r) => {
                const meta = (r.metadata ?? {}) as { archived?: boolean; kind?: string };
                if (!input.includeArchived && meta.archived === true) return false;
                if (!region) return true;
                const regs = r.regions ?? ["*"];
                return regs.includes("*") || regs.includes(region);
              })
              .map((r) => {
                const meta = (r.metadata ?? {}) as { archived?: boolean; kind?: string };
                const install = installById.get(r.moduleId);
                const kind: "builtin" | "custom" =
                  meta.kind === "custom" || r.publisher !== "chaste" ? "custom" : "builtin";
                return {
                  moduleId: r.moduleId,
                  name: r.name,
                  version: r.version,
                  summary: r.summary,
                  category: r.category,
                  publisher: r.publisher,
                  regions: r.regions ?? ["*"],
                  kind,
                  archived: meta.archived === true,
                  installed: Boolean(install),
                  enabled: install?.enabled ?? false,
                };
              });
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
              .onConflictDoUpdate({
                target: [schema.moduleInstalls.organizationId, schema.moduleInstalls.moduleId],
                set: { enabled: true, version: input.version },
              });
            return { moduleId: input.moduleId, enabled: true };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.module.uninstall",
          permissions: ["core.modules.manage"],
          tags: ["core"],
          input: z.object({ moduleId: z.string().min(1) }),
          output: z.object({ moduleId: z.string(), uninstalled: z.boolean() }),
          handler: async (input, ctx) => {
            await db
              .delete(schema.moduleInstalls)
              .where(
                and(
                  eq(schema.moduleInstalls.organizationId, ctx.actor.organizationId),
                  eq(schema.moduleInstalls.moduleId, input.moduleId),
                ),
              );
            return { moduleId: input.moduleId, uninstalled: true };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.module.set_enabled",
          permissions: ["core.modules.manage"],
          tags: ["core"],
          input: z.object({ moduleId: z.string().min(1), enabled: z.boolean() }),
          output: z.object({ moduleId: z.string(), enabled: z.boolean() }),
          handler: async (input, ctx) => {
            const updated = await db
              .update(schema.moduleInstalls)
              .set({ enabled: input.enabled })
              .where(
                and(
                  eq(schema.moduleInstalls.organizationId, ctx.actor.organizationId),
                  eq(schema.moduleInstalls.moduleId, input.moduleId),
                ),
              )
              .returning();
            if (updated.length === 0) {
              throw new ValidationError("Module is not installed", { moduleId: input.moduleId });
            }
            return { moduleId: input.moduleId, enabled: input.enabled };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.marketplace.archive",
          permissions: ["core.modules.manage"],
          tags: ["core"],
          input: z.object({ moduleId: z.string().min(1), archived: z.boolean() }),
          output: z.object({ moduleId: z.string(), archived: z.boolean() }),
          handler: async (input) => {
            const [row] = await db
              .select()
              .from(schema.marketplaceListings)
              .where(eq(schema.marketplaceListings.moduleId, input.moduleId))
              .limit(1);
            if (!row) {
              throw new ValidationError("Marketplace listing not found", {
                moduleId: input.moduleId,
              });
            }
            const meta = { ...(row.metadata ?? {}), archived: input.archived };
            await db
              .update(schema.marketplaceListings)
              .set({ metadata: meta })
              .where(eq(schema.marketplaceListings.moduleId, input.moduleId));
            return { moduleId: input.moduleId, archived: input.archived };
          },
        }),
      );

      // ─── Settings & Preferences ────────────────────────────────────────

      const orgSettingsOutputSchema = z.object({
        settings: z.object({
          timezone: z.string(),
          locale: z.string(),
          currency: z.string(),
          aiModel: z.string().optional(),
          aiTemperature: z.number().optional(),
          aiMaxTokens: z.number().optional(),
          emailNotifications: z.boolean(),
          notificationDigest: z.enum(["daily", "weekly", "never"]),
          webhookUrl: z.string().optional(),
          auditRetentionDays: z.number(),
          chatHistoryRetentionDays: z.number(),
          modules: z.record(z.string(), z.record(z.string(), z.unknown())),
        }),
      });

      const userPreferencesOutputSchema = z.object({
        preferences: z.object({
          theme: z.enum(["light", "dark", "system"]),
          accent: z.enum([
            "maroon",
            "teal",
            "blue",
            "violet",
            "rose",
            "amber",
            "forest",
            "slate",
          ]),
          timezone: z.string().optional(),
          locale: z.string().optional(),
          notifications: z.object({
            emailDigest: z.enum(["daily", "weekly", "never"]).optional(),
            pushEnabled: z.boolean().optional(),
          }),
        }),
      });

      queries.register(
        defineQuery({
          name: "core.settings.get",
          permissions: ["core.settings.read"],
          tags: ["core"],
          input: z.object({}).default({}),
          output: orgSettingsOutputSchema,
          handler: async (_i, ctx) => {
            const [org] = await db
              .select({ settings: schema.organizations.settings })
              .from(schema.organizations)
              .where(eq(schema.organizations.id, ctx.actor.organizationId));
            const settings = orgSettingsSchema.parse(org?.settings ?? {});
            return { settings };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.settings.update",
          permissions: ["core.settings.manage"],
          tags: ["core"],
          input: z.object({ settings: z.record(z.string(), z.unknown()) }),
          output: orgSettingsOutputSchema,
          handler: async (input, ctx) => {
            const [org] = await db
              .select({ settings: schema.organizations.settings })
              .from(schema.organizations)
              .where(eq(schema.organizations.id, ctx.actor.organizationId));
            const existing = orgSettingsSchema.parse(org?.settings ?? {});
            const partial = orgSettingsUpdateSchema.parse(input.settings);
            const merged = { ...existing, ...partial };
            const settings = orgSettingsSchema.parse(merged);
            await db
              .update(schema.organizations)
              .set({ settings: settings as Record<string, unknown> })
              .where(eq(schema.organizations.id, ctx.actor.organizationId));
            return { settings };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "core.preferences.get",
          permissions: [],
          tags: ["core"],
          input: z.object({}).default({}),
          output: userPreferencesOutputSchema,
          handler: async (_i, ctx) => {
            const [user] = await db
              .select({ settings: schema.users.settings })
              .from(schema.users)
              .where(eq(schema.users.id, ctx.actor.userId));
            const preferences = userPreferencesSchema.parse(user?.settings ?? {});
            return { preferences };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.preferences.update",
          permissions: [],
          tags: ["core"],
          input: z.object({ preferences: z.record(z.string(), z.unknown()) }),
          output: userPreferencesOutputSchema,
          handler: async (input, ctx) => {
            const [user] = await db
              .select({ settings: schema.users.settings })
              .from(schema.users)
              .where(eq(schema.users.id, ctx.actor.userId));
            const existing = userPreferencesSchema.parse(user?.settings ?? {});
            const partial = userPreferencesUpdateSchema.parse(input.preferences);
            const merged = {
              ...existing,
              ...partial,
              notifications: {
                ...existing.notifications,
                ...(partial.notifications ?? {}),
              },
            };
            const preferences = userPreferencesSchema.parse(merged);
            await db
              .update(schema.users)
              .set({ settings: preferences as Record<string, unknown> })
              .where(eq(schema.users.id, ctx.actor.userId));
            return { preferences };
          },
        }),
      );
    },
  };
}
