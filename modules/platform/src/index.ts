import type { Db } from "@chaste/db";
import { PERMISSION_CATALOG, hashAuthToken, resolveUserPermissions, schema } from "@chaste/db";
import {
  orgSettingsSchema,
  orgSettingsUpdateSchema,
  userPreferencesSchema,
  userPreferencesUpdateSchema,
} from "@chaste/db";
import {
  FULL_AUTONOMOUS_WARNING,
  actorHasPermission,
  autonomyLevelSchema,
  defineCommand,
  defineQuery,
  type BusinessModule,
  type ModuleRegistry,
  ValidationError,
} from "@chaste/kernel";
import { and, eq, ilike, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";

/** Capability gap ticket lifecycle (spec: self-development.md §4). */
const GAP_STATUS = [
  "draft",
  "confirmed",
  "queued",
  "in_progress",
  "in_review",
  "resolved",
  "wont_fix",
  "duplicate",
] as const;
const gapStatusSchema = z.enum(GAP_STATUS);

const GAP_DEPLOYMENT_TARGET = [
  "undecided",
  "local_extension",
  "marketplace_shared",
  "private_cloud",
  "platform_roadmap",
] as const;
const gapDeploymentTargetSchema = z.enum(GAP_DEPLOYMENT_TARGET);

const gapTicketOutputSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  status: gapStatusSchema,
  proposedCapabilityId: z.string(),
  title: z.string(),
  abstractRequirement: z.string(),
  acceptanceCriteria: z.array(z.string()),
  exampleScenarios: z.array(z.string()),
  suggestedModuleId: z.string().nullable(),
  nonGoals: z.array(z.string()),
  deploymentTarget: gapDeploymentTargetSchema,
  codingAgent: z.string().nullable(),
  artifactRef: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

function toGapTicket(row: typeof schema.capabilityGapTickets.$inferSelect) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    status: row.status as (typeof GAP_STATUS)[number],
    proposedCapabilityId: row.proposedCapabilityId,
    title: row.title,
    abstractRequirement: row.abstractRequirement,
    acceptanceCriteria: row.acceptanceCriteria,
    exampleScenarios: row.exampleScenarios,
    suggestedModuleId: row.suggestedModuleId,
    nonGoals: row.nonGoals,
    deploymentTarget: row.deploymentTarget as (typeof GAP_DEPLOYMENT_TARGET)[number],
    codingAgent: row.codingAgent,
    artifactRef: row.artifactRef,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** R1-aligned: in-app notification (spec: scheduling-and-comms.md §4). */
async function notifyUser(
  db: Db,
  input: {
    organizationId: string;
    userId: string;
    kind?: string;
    title: string;
    body?: string;
    href?: string;
    resourceType?: string;
    resourceId?: string;
  },
): Promise<void> {
  await db.insert(schema.notifications).values({
    organizationId: input.organizationId,
    userId: input.userId,
    kind: input.kind ?? "info",
    title: input.title,
    body: input.body,
    href: input.href,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
  });
}

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
        "core.branch.read",
        "core.branch.manage",
        "core.branch.all",
        "core.capability.gap.read",
        "core.capability.gap.manage",
        "core.notification.read",
        "core.reminder.write",
        "core.followup.write",
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
          minAutonomyForAuto: "full_autonomous",
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
          // Security-sensitive: no auto role elevation under guarded_auto.
          minAutonomyForAuto: "full_autonomous",
          input: z.object({ userId: z.string().uuid(), roleId: z.string().uuid() }),
          output: z.object({ ok: z.literal(true) }),
          handler: async (input, ctx) => {
            const orgId = ctx.actor.organizationId;
            const [role] = await db
              .select()
              .from(schema.roles)
              .where(and(eq(schema.roles.id, input.roleId), eq(schema.roles.organizationId, orgId)));
            if (!role) {
              throw new ValidationError("Role not found", { roleId: input.roleId });
            }
            const [user] = await db
              .select()
              .from(schema.users)
              .where(and(eq(schema.users.id, input.userId), eq(schema.users.organizationId, orgId)));
            if (!user) {
              throw new ValidationError("User not found", { userId: input.userId });
            }
            await db
              .insert(schema.userRoles)
              .values({ userId: input.userId, roleId: input.roleId })
              .onConflictDoNothing();
            await notifyUser(db, {
              organizationId: orgId,
              userId: input.userId,
              kind: "security",
              title: `Role assigned: ${role.name}`,
              body: `You now have the "${role.name}" role.`,
            });
            return { ok: true as const };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.user.create",
          permissions: ["core.user.manage"],
          tags: ["core"],
          minAutonomyForAuto: "full_autonomous",
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
            const orgId = ctx.actor.organizationId;
            if (input.roleId) {
              const [role] = await db
                .select()
                .from(schema.roles)
                .where(and(eq(schema.roles.id, input.roleId), eq(schema.roles.organizationId, orgId)));
              if (!role) {
                throw new ValidationError("Role not found", { roleId: input.roleId });
              }
            }
            const authToken = crypto.randomUUID();
            const [user] = await db
              .insert(schema.users)
              .values({
                organizationId: orgId,
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
          name: "core.user.invite",
          permissions: ["core.user.manage"],
          tags: ["core"],
          minAutonomyForAuto: "full_autonomous",
          input: z.object({
            email: z.string().email(),
            displayName: z.string().min(1),
            roleId: z.string().uuid().optional(),
            branchId: z.string().uuid().optional(),
          }),
          output: z.object({
            id: z.string(),
            email: z.string(),
            displayName: z.string(),
            authToken: z.string(),
            roleId: z.string().nullable(),
            branchId: z.string().nullable(),
          }),
          handler: async (input, ctx) => {
            const orgId = ctx.actor.organizationId;
            if (input.roleId) {
              const [role] = await db
                .select()
                .from(schema.roles)
                .where(and(eq(schema.roles.id, input.roleId), eq(schema.roles.organizationId, orgId)));
              if (!role) {
                throw new ValidationError("Role not found", { roleId: input.roleId });
              }
            }
            if (input.branchId) {
              const [branch] = await db
                .select()
                .from(schema.branches)
                .where(
                  and(eq(schema.branches.id, input.branchId), eq(schema.branches.organizationId, orgId)),
                );
              if (!branch) {
                throw new ValidationError("Branch not found", { branchId: input.branchId });
              }
            }

            const rawToken = crypto.randomUUID();
            const [user] = await db
              .insert(schema.users)
              .values({
                organizationId: orgId,
                email: input.email,
                displayName: input.displayName,
                // At-rest the column holds only the digest; the raw token is
                // returned exactly once (see hashAuthToken in @chaste/db).
                authToken: hashAuthToken(rawToken),
                activeBranchId: input.branchId ?? null,
              })
              .returning();

            if (input.roleId) {
              await db
                .insert(schema.userRoles)
                .values({ userId: user!.id, roleId: input.roleId })
                .onConflictDoNothing();
            }
            if (input.branchId) {
              await db
                .insert(schema.userBranchAccess)
                .values({ userId: user!.id, branchId: input.branchId })
                .onConflictDoNothing();
            }

            await notifyUser(db, {
              organizationId: orgId,
              userId: user!.id,
              kind: "security",
              title: "Welcome to Chaste Business OS",
              body: `Your account for ${input.displayName} is ready. Sign in with the invite token from your administrator.`,
            });

            return {
              id: user!.id,
              email: user!.email,
              displayName: user!.displayName,
              authToken: rawToken,
              roleId: input.roleId ?? null,
              branchId: input.branchId ?? null,
            };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.user.deactivate",
          permissions: ["core.user.manage"],
          tags: ["core"],
          minAutonomyForAuto: "full_autonomous",
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
          minAutonomyForAuto: "full_autonomous",
          input: z.object({ userId: z.string().uuid(), roleId: z.string().uuid() }),
          output: z.object({ ok: z.literal(true) }),
          handler: async (input, ctx) => {
            const orgId = ctx.actor.organizationId;
            const [role] = await db
              .select()
              .from(schema.roles)
              .where(and(eq(schema.roles.id, input.roleId), eq(schema.roles.organizationId, orgId)));
            if (!role) {
              throw new ValidationError("Role not found", { roleId: input.roleId });
            }
            const [user] = await db
              .select()
              .from(schema.users)
              .where(and(eq(schema.users.id, input.userId), eq(schema.users.organizationId, orgId)));
            if (!user) {
              throw new ValidationError("User not found", { userId: input.userId });
            }

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
          minAutonomyForAuto: "full_autonomous",
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
          minAutonomyForAuto: "full_autonomous",
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
          minAutonomyForAuto: "full_autonomous",
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
          minAutonomyForAuto: "guarded_auto",
          input: z.object({ moduleId: z.string().min(1), version: z.string().default("0.1.0") }),
          output: z.object({ moduleId: z.string(), enabled: z.boolean() }),
          handler: async (input, ctx) => {
            // Reject installs of modules that are not in the marketplace catalog —
            // otherwise the installs table accumulates phantom rows with no runtime.
            const [listing] = await db
              .select()
              .from(schema.marketplaceListings)
              .where(eq(schema.marketplaceListings.moduleId, input.moduleId))
              .limit(1);
            if (!listing) {
              throw new ValidationError("Unknown module — not found in marketplace", {
                moduleId: input.moduleId,
              });
            }
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
          minAutonomyForAuto: "guarded_auto",
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
          minAutonomyForAuto: "guarded_auto",
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
          minAutonomyForAuto: "guarded_auto",
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
            // The marketplace catalog is global: archiving hides a listing from
            // every tenant. Restrict this to platform-owned listings so one org
            // cannot hide a community/custom package from the rest of the fleet.
            if (row.publisher !== "chaste") {
              throw new ValidationError(
                "Only platform-owned listings can be archived",
                { moduleId: input.moduleId, publisher: row.publisher },
              );
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

      // ─── Branches (Horizon A — multi-branch) ───────────────────────────

      queries.register(
        defineQuery({
          name: "core.branch.list",
          permissions: ["core.branch.read"],
          tags: ["core"],
          input: z.object({}).default({}),
          output: z.object({
            branches: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                code: z.string(),
                timezone: z.string().nullable(),
                active: z.boolean(),
                isActiveBranch: z.boolean(),
                grantType: z.enum(["all", "explicit"]),
              }),
            ),
          }),
          handler: async (_i, ctx) => {
            const orgId = ctx.actor.organizationId;
            const [me] = await db
              .select({ activeBranchId: schema.users.activeBranchId })
              .from(schema.users)
              .where(eq(schema.users.id, ctx.actor.userId));
            const activeBranchId = me?.activeBranchId ?? null;

            // core.branch.all → every org branch; otherwise only granted ones
            if (actorHasPermission(ctx.actor, "core.branch.all")) {
              const rows = await db
                .select()
                .from(schema.branches)
                .where(eq(schema.branches.organizationId, orgId))
                .orderBy(schema.branches.name);
              return {
                branches: rows.map((b) => ({
                  id: b.id,
                  name: b.name,
                  code: b.code,
                  timezone: b.timezone,
                  active: b.active,
                  isActiveBranch: b.id === activeBranchId,
                  grantType: "all" as const,
                })),
              };
            }

            const rows = await db
              .select({
                id: schema.branches.id,
                name: schema.branches.name,
                code: schema.branches.code,
                timezone: schema.branches.timezone,
                active: schema.branches.active,
              })
              .from(schema.branches)
              .innerJoin(
                schema.userBranchAccess,
                eq(schema.branches.id, schema.userBranchAccess.branchId),
              )
              .where(
                and(
                  eq(schema.branches.organizationId, orgId),
                  eq(schema.userBranchAccess.userId, ctx.actor.userId),
                ),
              )
              .orderBy(schema.branches.name);
            return {
              branches: rows.map((b) => ({
                ...b,
                isActiveBranch: b.id === activeBranchId,
                grantType: "explicit" as const,
              })),
            };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.branch.create",
          permissions: ["core.branch.manage"],
          tags: ["core"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            name: z.string().min(1).max(128),
            code: z.string().min(1).max(16),
            timezone: z.string().optional(),
            parentBranchId: z.string().uuid().optional(),
          }),
          output: z.object({
            id: z.string(),
            name: z.string(),
            code: z.string(),
            timezone: z.string().nullable(),
            active: z.literal(true),
          }),
          handler: async (input, ctx) => {
            const orgId = ctx.actor.organizationId;
            const [dupCode] = await db
              .select()
              .from(schema.branches)
              .where(
                and(
                  eq(schema.branches.organizationId, orgId),
                  eq(schema.branches.code, input.code.toUpperCase()),
                ),
              )
              .limit(1);
            if (dupCode) {
              throw new ValidationError("Branch code already exists in this organization", {
                code: input.code.toUpperCase(),
              });
            }
            if (input.parentBranchId) {
              const [parent] = await db
                .select()
                .from(schema.branches)
                .where(
                  and(
                    eq(schema.branches.id, input.parentBranchId),
                    eq(schema.branches.organizationId, orgId),
                  ),
                );
              if (!parent) {
                throw new ValidationError("Parent branch not found", {
                  parentBranchId: input.parentBranchId,
                });
              }
            }

            const [branch] = await db
              .insert(schema.branches)
              .values({
                organizationId: orgId,
                name: input.name,
                code: input.code.toUpperCase(),
                timezone: input.timezone ?? "UTC",
                parentBranchId: input.parentBranchId,
                active: true,
              })
              .returning();

            // Creator gets explicit access + becomes active branch when none set.
            await db
              .insert(schema.userBranchAccess)
              .values({ userId: ctx.actor.userId, branchId: branch!.id })
              .onConflictDoNothing({
                target: [schema.userBranchAccess.userId, schema.userBranchAccess.branchId],
              });
            await db
              .update(schema.users)
              .set({ activeBranchId: branch!.id })
              .where(
                and(eq(schema.users.id, ctx.actor.userId), isNull(schema.users.activeBranchId)),
              );

            await notifyUser(db, {
              organizationId: orgId,
              userId: ctx.actor.userId,
              kind: "system",
              title: `Branch created: ${branch!.name}`,
              body: `Branch "${branch!.name}" (${branch!.code}) is active.`,
              resourceType: "branch",
              resourceId: branch!.id,
            });

            return {
              id: branch!.id,
              name: branch!.name,
              code: branch!.code,
              timezone: branch!.timezone,
              active: true as const,
            };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.branch.update",
          permissions: ["core.branch.manage"],
          tags: ["core"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            branchId: z.string().uuid(),
            name: z.string().min(1).max(128).optional(),
            code: z.string().min(1).max(16).optional(),
            timezone: z.string().optional(),
            active: z.boolean().optional(),
          }),
          output: z.object({ id: z.string(), name: z.string(), code: z.string(), active: z.boolean() }),
          handler: async (input, ctx) => {
            const [branch] = await db
              .select()
              .from(schema.branches)
              .where(
                and(
                  eq(schema.branches.id, input.branchId),
                  eq(schema.branches.organizationId, ctx.actor.organizationId),
                ),
              );
            if (!branch) {
              throw new ValidationError("Branch not found", { branchId: input.branchId });
            }

            // Guard: never deactivate the last active branch in the org.
            if (input.active === false && branch.active) {
              const activeCount = await db
                .select({ id: schema.branches.id })
                .from(schema.branches)
                .where(
                  and(
                    eq(schema.branches.organizationId, ctx.actor.organizationId),
                    eq(schema.branches.active, true),
                  ),
                );
              if (activeCount.length <= 1) {
                throw new ValidationError("Cannot deactivate the last active branch", {
                  branchId: input.branchId,
                });
              }
            }

            const updates: Record<string, unknown> = {};
            if (input.name !== undefined) updates.name = input.name;
            if (input.code !== undefined) updates.code = input.code.toUpperCase();
            if (input.timezone !== undefined) updates.timezone = input.timezone;
            if (input.active !== undefined) updates.active = input.active;
            if (Object.keys(updates).length === 0) {
              throw new ValidationError("Nothing to update", { branchId: input.branchId });
            }
            await db
              .update(schema.branches)
              .set(updates)
              .where(eq(schema.branches.id, input.branchId));

            const [updated] = await db
              .select()
              .from(schema.branches)
              .where(eq(schema.branches.id, input.branchId));
            return {
              id: updated!.id,
              name: updated!.name,
              code: updated!.code,
              active: updated!.active,
            };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.branch.set_active",
          permissions: ["core.branch.read"],
          tags: ["core"],
          input: z.object({ branchId: z.string().uuid() }),
          output: z.object({ branchId: z.string(), name: z.string(), code: z.string() }),
          handler: async (input, ctx) => {
            const [branch] = await db
              .select()
              .from(schema.branches)
              .where(
                and(
                  eq(schema.branches.id, input.branchId),
                  eq(schema.branches.organizationId, ctx.actor.organizationId),
                ),
              );
            if (!branch) {
              throw new ValidationError("Branch not found", { branchId: input.branchId });
            }
            if (!branch.active) {
              throw new ValidationError("Branch is deactivated", { branchId: input.branchId });
            }

            const hasAllAccess = actorHasPermission(ctx.actor, "core.branch.all");
            if (!hasAllAccess) {
              const [grant] = await db
                .select()
                .from(schema.userBranchAccess)
                .where(
                  and(
                    eq(schema.userBranchAccess.userId, ctx.actor.userId),
                    eq(schema.userBranchAccess.branchId, input.branchId),
                  ),
                );
              if (!grant) {
                throw new ValidationError("You do not have access to this branch", {
                  branchId: input.branchId,
                });
              }
            }

            await db
              .update(schema.users)
              .set({ activeBranchId: input.branchId })
              .where(eq(schema.users.id, ctx.actor.userId));
            return { branchId: branch.id, name: branch.name, code: branch.code };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.branch.grant",
          permissions: ["core.branch.manage"],
          tags: ["core"],
          minAutonomyForAuto: "full_autonomous",
          input: z.object({ userId: z.string().uuid(), branchId: z.string().uuid() }),
          output: z.object({ userId: z.string(), branchId: z.string(), ok: z.literal(true) }),
          handler: async (input, ctx) => {
            const orgId = ctx.actor.organizationId;
            const [user] = await db
              .select()
              .from(schema.users)
              .where(and(eq(schema.users.id, input.userId), eq(schema.users.organizationId, orgId)));
            if (!user) {
              throw new ValidationError("User not found", { userId: input.userId });
            }
            const [branch] = await db
              .select()
              .from(schema.branches)
              .where(
                and(eq(schema.branches.id, input.branchId), eq(schema.branches.organizationId, orgId)),
              );
            if (!branch) {
              throw new ValidationError("Branch not found", { branchId: input.branchId });
            }
            await db
              .insert(schema.userBranchAccess)
              .values({ userId: input.userId, branchId: input.branchId })
              .onConflictDoNothing({
                target: [schema.userBranchAccess.userId, schema.userBranchAccess.branchId],
              });
            await notifyUser(db, {
              organizationId: orgId,
              userId: input.userId,
              kind: "system",
              title: `Access granted to branch: ${branch.name}`,
              body: `${ctx.actor.displayName ?? "An administrator"} gave you access to the "${branch.name}" branch.`,
              resourceType: "branch",
              resourceId: branch.id,
            });
            return { userId: input.userId, branchId: input.branchId, ok: true as const };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.branch.revoke",
          permissions: ["core.branch.manage"],
          tags: ["core"],
          minAutonomyForAuto: "full_autonomous",
          input: z.object({ userId: z.string().uuid(), branchId: z.string().uuid() }),
          output: z.object({ userId: z.string(), branchId: z.string(), ok: z.literal(true) }),
          handler: async (input, ctx) => {
            const orgId = ctx.actor.organizationId;
            const [user] = await db
              .select()
              .from(schema.users)
              .where(and(eq(schema.users.id, input.userId), eq(schema.users.organizationId, orgId)));
            if (!user) {
              throw new ValidationError("User not found", { userId: input.userId });
            }
            const [branch] = await db
              .select()
              .from(schema.branches)
              .where(
                and(eq(schema.branches.id, input.branchId), eq(schema.branches.organizationId, orgId)),
              );
            if (!branch) {
              throw new ValidationError("Branch not found", { branchId: input.branchId });
            }

            if (user.activeBranchId === input.branchId) {
              throw new ValidationError(
                "Cannot revoke the user's active branch — switch them first",
                { userId: input.userId, branchId: input.branchId },
              );
            }

            // Guard: don't lock a non-all-access user out of every branch.
            const perms = await resolveUserPermissions(db, input.userId);
            if (!perms.includes("core.branch.all")) {
              const grants = await db
                .select({ branchId: schema.userBranchAccess.branchId })
                .from(schema.userBranchAccess)
                .where(eq(schema.userBranchAccess.userId, input.userId));
              if (grants.length === 1 && grants[0]!.branchId === input.branchId) {
                throw new ValidationError(
                  "Cannot revoke the user's only branch access",
                  { userId: input.userId, branchId: input.branchId },
                );
              }
            }

            await db
              .delete(schema.userBranchAccess)
              .where(
                and(
                  eq(schema.userBranchAccess.userId, input.userId),
                  eq(schema.userBranchAccess.branchId, input.branchId),
                ),
              );
            return { userId: input.userId, branchId: input.branchId, ok: true as const };
          },
        }),
      );

      // ─── Capability gaps (Horizon A — self-development) ────────────────

      commands.register(
        defineCommand({
          name: "core.capability.gap.create",
          permissions: ["core.capability.gap.manage"],
          tags: ["core"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            proposedCapabilityId: z.string().min(1).max(128),
            title: z.string().min(1).max(200),
            abstractRequirement: z.string().min(1),
            acceptanceCriteria: z.array(z.string()).default([]),
            exampleScenarios: z.array(z.string()).default([]),
            suggestedModuleId: z.string().optional(),
            nonGoals: z.array(z.string()).default([]),
            deploymentTarget: gapDeploymentTargetSchema.default("undecided"),
          }),
          output: gapTicketOutputSchema,
          handler: async (input, ctx) => {
            const orgId = ctx.actor.organizationId;
            const [ticket] = await db
              .insert(schema.capabilityGapTickets)
              .values({
                organizationId: orgId,
                status: "draft",
                proposedCapabilityId: input.proposedCapabilityId,
                title: input.title,
                abstractRequirement: input.abstractRequirement,
                acceptanceCriteria: input.acceptanceCriteria,
                exampleScenarios: input.exampleScenarios,
                suggestedModuleId: input.suggestedModuleId,
                nonGoals: input.nonGoals,
                deploymentTarget: input.deploymentTarget,
                createdBy: ctx.actor.userId,
              })
              .returning();
            return toGapTicket(ticket!);
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.capability.gap.update",
          permissions: ["core.capability.gap.manage"],
          tags: ["core"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            ticketId: z.string().uuid(),
            title: z.string().min(1).max(200).optional(),
            abstractRequirement: z.string().min(1).optional(),
            acceptanceCriteria: z.array(z.string()).optional(),
            exampleScenarios: z.array(z.string()).optional(),
            suggestedModuleId: z.string().nullable().optional(),
            nonGoals: z.array(z.string()).optional(),
            deploymentTarget: gapDeploymentTargetSchema.optional(),
          }),
          output: gapTicketOutputSchema,
          handler: async (input, ctx) => {
            const [ticket] = await db
              .select()
              .from(schema.capabilityGapTickets)
              .where(
                and(
                  eq(schema.capabilityGapTickets.id, input.ticketId),
                  eq(schema.capabilityGapTickets.organizationId, ctx.actor.organizationId),
                ),
              );
            if (!ticket) {
              throw new ValidationError("Gap ticket not found", { ticketId: input.ticketId });
            }
            // Locked once work begins or is closed.
            if (!["draft", "confirmed"].includes(ticket.status)) {
              throw new ValidationError(
                `Cannot edit a ${ticket.status} ticket`,
                { ticketId: input.ticketId, status: ticket.status },
              );
            }

            const updates: Record<string, unknown> = {};
            if (input.title !== undefined) updates.title = input.title;
            if (input.abstractRequirement !== undefined) {
              updates.abstractRequirement = input.abstractRequirement;
            }
            if (input.acceptanceCriteria !== undefined) {
              updates.acceptanceCriteria = input.acceptanceCriteria;
            }
            if (input.exampleScenarios !== undefined) updates.exampleScenarios = input.exampleScenarios;
            if (input.suggestedModuleId !== undefined) {
              updates.suggestedModuleId = input.suggestedModuleId;
            }
            if (input.nonGoals !== undefined) updates.nonGoals = input.nonGoals;
            if (input.deploymentTarget !== undefined) {
              updates.deploymentTarget = input.deploymentTarget;
            }
            updates.updatedAt = new Date();
            await db
              .update(schema.capabilityGapTickets)
              .set(updates)
              .where(eq(schema.capabilityGapTickets.id, input.ticketId));

            const [updated] = await db
              .select()
              .from(schema.capabilityGapTickets)
              .where(eq(schema.capabilityGapTickets.id, input.ticketId));
            return toGapTicket(updated!);
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "core.capability.gap.list",
          permissions: ["core.capability.gap.read"],
          tags: ["core"],
          input: z.object({ status: gapStatusSchema.optional() }).default({}),
          output: z.object({ tickets: z.array(gapTicketOutputSchema) }),
          handler: async (input, ctx) => {
            const where = eq(schema.capabilityGapTickets.organizationId, ctx.actor.organizationId);
            const rows = input.status
              ? await db
                  .select()
                  .from(schema.capabilityGapTickets)
                  .where(
                    and(
                      where,
                      eq(schema.capabilityGapTickets.status, input.status),
                    ),
                  )
                  .orderBy(schema.capabilityGapTickets.createdAt)
              : await db
                  .select()
                  .from(schema.capabilityGapTickets)
                  .where(where)
                  .orderBy(schema.capabilityGapTickets.createdAt);
            return { tickets: rows.map(toGapTicket) };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.capability.gap.confirm",
          permissions: ["core.capability.gap.manage"],
          tags: ["core"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            ticketId: z.string().uuid(),
            suggestedModuleId: z.string().optional(),
            deploymentTarget: gapDeploymentTargetSchema.optional(),
          }),
          output: gapTicketOutputSchema,
          handler: async (input, ctx) => {
            const [ticket] = await db
              .select()
              .from(schema.capabilityGapTickets)
              .where(
                and(
                  eq(schema.capabilityGapTickets.id, input.ticketId),
                  eq(schema.capabilityGapTickets.organizationId, ctx.actor.organizationId),
                ),
              );
            if (!ticket) {
              throw new ValidationError("Gap ticket not found", { ticketId: input.ticketId });
            }
            if (ticket.status !== "draft" && ticket.status !== "confirmed") {
              throw new ValidationError(
                `Cannot confirm a ${ticket.status} ticket`,
                { ticketId: input.ticketId, status: ticket.status },
              );
            }

            const updates: Record<string, unknown> = { status: "confirmed", updatedAt: new Date() };
            if (input.suggestedModuleId !== undefined) updates.suggestedModuleId = input.suggestedModuleId;
            if (input.deploymentTarget !== undefined) updates.deploymentTarget = input.deploymentTarget;
            await db
              .update(schema.capabilityGapTickets)
              .set(updates)
              .where(eq(schema.capabilityGapTickets.id, input.ticketId));

            const [confirmed] = await db
              .select()
              .from(schema.capabilityGapTickets)
              .where(eq(schema.capabilityGapTickets.id, input.ticketId));

            // The creator needs to know their request is confirmed and routed.
            await notifyUser(db, {
              organizationId: ctx.actor.organizationId,
              userId: ticket.createdBy,
              kind: "system",
              title: `Capability gap confirmed: ${confirmed!.title}`,
              body: "The requirement has been confirmed and routed for placement review.",
              resourceType: "capability_gap",
              resourceId: confirmed!.id,
            });

            return toGapTicket(confirmed!);
          },
        }),
      );

      // ─── Capability catalog (S0) + placement recommender (S1) ────────

      const catalogItemSchema = z.object({
        id: z.string(),
        moduleId: z.string(),
        capabilityId: z.string(),
        name: z.string(),
        description: z.string(),
        keywords: z.array(z.string()),
        implemented: z.boolean(),
      });

      queries.register(
        defineQuery({
          name: "core.capability.catalog.list",
          permissions: ["core.capability.catalog.read"],
          tags: ["core"],
          input: z.object({ moduleId: z.string().optional() }).default({}),
          output: z.object({ items: z.array(catalogItemSchema) }),
          handler: async (input) => {
            const rows = await db
              .select()
              .from(schema.capabilityCatalogItems)
              .where(input.moduleId ? eq(schema.capabilityCatalogItems.moduleId, input.moduleId) : undefined)
              .orderBy(schema.capabilityCatalogItems.capabilityId);
            return {
              items: rows.map((r) => ({
                id: r.id,
                moduleId: r.moduleId,
                capabilityId: r.capabilityId,
                name: r.name,
                description: r.description,
                keywords: r.keywords,
                implemented: r.implemented,
              })),
            };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "core.capability.catalog.search",
          permissions: ["core.capability.catalog.read"],
          tags: ["core"],
          input: z.object({ query: z.string().min(1), moduleId: z.string().optional() }),
          output: z.object({ items: z.array(catalogItemSchema) }),
          handler: async (input) => {
            const like = `%${input.query}%`;
            const rows = await db
              .select()
              .from(schema.capabilityCatalogItems)
              .where(
                and(
                  input.moduleId ? eq(schema.capabilityCatalogItems.moduleId, input.moduleId) : undefined,
                  or(ilike(schema.capabilityCatalogItems.name, like), ilike(schema.capabilityCatalogItems.description, like)),
                ),
              )
              .orderBy(schema.capabilityCatalogItems.capabilityId)
              .limit(50);
            return {
              items: rows.map((r) => ({
                id: r.id,
                moduleId: r.moduleId,
                capabilityId: r.capabilityId,
                name: r.name,
                description: r.description,
                keywords: r.keywords,
                implemented: r.implemented,
              })),
            };
          },
        }),
      );

      // Placement recommendation per self-development.md §5. The agent
      // recommends; the user/org policy chooses. Never silent publish.
      const recommendSchema = z.object({
        abstractRequirement: z.string(),
        acceptanceCriteria: z.array(z.string()).default([]),
        exampleScenarios: z.array(z.string()).default([]),
        suggestedModuleId: z.string().optional(),
      });
      const recommendOutputSchema = z.object({
        deploymentTarget: gapDeploymentTargetSchema,
        suggestedModuleId: z.string().nullable(),
        rationale: z.array(z.string()),
        signals: z.array(z.string()),
      });

      queries.register(
        defineQuery({
          name: "core.capability.gap.recommend",
          permissions: ["core.capability.gap.read"],
          tags: ["core"],
          input: recommendSchema,
          output: recommendOutputSchema,
          handler: async (input) => {
            const text = [
              input.abstractRequirement,
              ...input.acceptanceCriteria,
              ...input.exampleScenarios,
            ].join(" ");
            const lower = text.toLowerCase();
            const signals: string[] = [];

            let target: (typeof GAP_DEPLOYMENT_TARGET)[number] = "undecided";
            const rationale: string[] = [];

            if (/\b(private cloud|isolated tenant|cloud tenant)\b/.test(lower)) {
              signals.push("org-specific on cloud tenant");
              target = "private_cloud";
              rationale.push("Requirement describes an org-specific package for a cloud tenant.");
            } else if (/\b(kernel|authz|authorization|payment|billing|security sensitive|permission|rbac|audit)\b/.test(lower)) {
              signals.push("touches kernel authz/payments/core");
              target = "platform_roadmap";
              rationale.push("Touches kernel authz/payments — needs platform maintainers, never a single tenant.");
            } else if (/\b(org-specific|company-specific|internal|our workflow|our process|self-host|local process|proprietary)\b/.test(lower)) {
              signals.push("org-specific local process");
              target = "local_extension";
              rationale.push("Appears to be an org-specific process that should stay a local extension.");
            } else {
              signals.push("common SMB need");
              target = "marketplace_shared";
              rationale.push("Looks like a common, non-proprietary need — suitable for a shared marketplace package.");
            }

            const suggestedModuleId: string | null = input.suggestedModuleId ?? null;
            return { deploymentTarget: target, suggestedModuleId, rationale, signals };
          },
        }),
      );

      // ─── Notifications (foundation) ────────────────────────────────────

      queries.register(
        defineQuery({
          name: "core.notification.list",
          permissions: ["core.notification.read"],
          tags: ["core"],
          input: z.object({ unreadOnly: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() }).default({}),
          output: z.object({
            notifications: z.array(
              z.object({
                id: z.string(),
                kind: z.string(),
                title: z.string(),
                body: z.string().nullable(),
                href: z.string().nullable(),
                resourceType: z.string().nullable(),
                resourceId: z.string().nullable(),
                read: z.boolean(),
                createdAt: z.string(),
              }),
            ),
          }),
          handler: async (input, ctx) => {
            const where = and(
              eq(schema.notifications.userId, ctx.actor.userId),
              eq(schema.notifications.organizationId, ctx.actor.organizationId),
              input.unreadOnly ? isNull(schema.notifications.readAt) : undefined,
            );
            const rows = await db
              .select()
              .from(schema.notifications)
              .where(where)
              .orderBy(schema.notifications.createdAt)
              .limit(input.limit ?? 50);
            return {
              notifications: rows.map((n) => ({
                id: n.id,
                kind: n.kind,
                title: n.title,
                body: n.body,
                href: n.href,
                resourceType: n.resourceType,
                resourceId: n.resourceId,
                read: n.readAt !== null,
                createdAt: n.createdAt.toISOString(),
              })),
            };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.notification.mark_read",
          permissions: ["core.notification.read"],
          tags: ["core"],
          input: z.object({ notificationId: z.string().uuid() }),
          output: z.object({ ok: z.literal(true) }),
          handler: async (input, ctx) => {
            const [n] = await db
              .select()
              .from(schema.notifications)
              .where(
                and(
                  eq(schema.notifications.id, input.notificationId),
                  eq(schema.notifications.userId, ctx.actor.userId),
                ),
              );
            if (!n) {
              throw new ValidationError("Notification not found", {
                notificationId: input.notificationId,
              });
            }
            await db
              .update(schema.notifications)
              .set({ readAt: new Date() })
              .where(eq(schema.notifications.id, input.notificationId));
            return { ok: true as const };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.notification.mark_all_read",
          permissions: ["core.notification.read"],
          tags: ["core"],
          input: z.object({}).default({}),
          output: z.object({ markedCount: z.number().int().nonnegative() }),
          handler: async (_i, ctx) => {
            const rows = await db
              .update(schema.notifications)
              .set({ readAt: new Date() })
              .where(
                and(
                  eq(schema.notifications.userId, ctx.actor.userId),
                  isNull(schema.notifications.readAt),
                ),
              )
              .returning();
            return { markedCount: rows.length };
          },
        }),
      );

      // ─── Reminders & Follow-ups (spec: scheduling-and-comms §2/§3) ──────

      const reminderOutputSchema = z.object({
        id: z.string(),
        title: z.string(),
        body: z.string().nullable(),
        href: z.string().nullable(),
        fireAt: z.string(),
        channel: z.string(),
        status: z.string(),
        branchId: z.string().nullable(),
      });

      const followUpOutputSchema = z.object({
        id: z.string(),
        goal: z.string(),
        fireAt: z.string(),
        sessionId: z.string().nullable(),
        branchId: z.string().nullable(),
        status: z.string(),
      });

      const fireAtSchema = z.string().refine((v) => {
        const t = Date.parse(v);
        return Number.isFinite(t) && t > Date.now();
      }, "fireAt must be a future ISO timestamp");

      commands.register(
        defineCommand({
          name: "core.reminder.set",
          permissions: ["core.reminder.write"],
          tags: ["core"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            title: z.string().min(1),
            body: z.string().optional(),
            href: z.string().optional(),
            fireAt: fireAtSchema,
            channel: z.enum(["in_app", "email", "both"]).optional(),
            branchId: z.string().uuid().optional(),
          }),
          output: reminderOutputSchema,
          handler: async (input, ctx) => {
            if (input.branchId) {
              const [branch] = await db
                .select()
                .from(schema.branches)
                .where(
                  and(
                    eq(schema.branches.id, input.branchId),
                    eq(schema.branches.organizationId, ctx.actor.organizationId),
                  ),
                );
              if (!branch) {
                throw new ValidationError("Branch not found", { branchId: input.branchId });
              }
            }
            const [row] = await db
              .insert(schema.reminders)
              .values({
                organizationId: ctx.actor.organizationId,
                userId: ctx.actor.userId,
                createdBy: ctx.actor.userId,
                title: input.title,
                body: input.body ?? null,
                href: input.href ?? null,
                fireAt: new Date(input.fireAt),
                channel: input.channel ?? "in_app",
                branchId: input.branchId ?? null,
              })
              .returning();
            await notifyUser(db, {
              organizationId: ctx.actor.organizationId,
              userId: ctx.actor.userId,
              kind: "system",
              title: "Reminder scheduled",
              body: `${input.title} — I'll nudge you at ${new Date(input.fireAt).toISOString()}.`,
            });
            return {
              id: row!.id,
              title: row!.title,
              body: row!.body,
              href: row!.href,
              fireAt: row!.fireAt.toISOString(),
              channel: row!.channel,
              status: row!.status,
              branchId: row!.branchId,
            };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.reminder.cancel",
          permissions: ["core.reminder.write"],
          tags: ["core"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({ reminderId: z.string().uuid() }),
          output: z.object({ cancelled: z.boolean() }),
          handler: async (input, ctx) => {
            const rows = await db
              .update(schema.reminders)
              .set({ status: "cancelled" })
              .where(
                and(
                  eq(schema.reminders.id, input.reminderId),
                  eq(schema.reminders.userId, ctx.actor.userId),
                  eq(schema.reminders.status, "scheduled"),
                ),
              )
              .returning();
            if (rows.length === 0) {
              throw new ValidationError("Reminder not found or already fired", {
                reminderId: input.reminderId,
              });
            }
            return { cancelled: true };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.followup.create",
          permissions: ["core.followup.write"],
          tags: ["core"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            goal: z.string().min(1),
            fireAt: fireAtSchema,
            sessionId: z.string().uuid().optional(),
            branchId: z.string().uuid().optional(),
          }),
          output: followUpOutputSchema,
          handler: async (input, ctx) => {
            if (input.branchId) {
              const [branch] = await db
                .select()
                .from(schema.branches)
                .where(
                  and(
                    eq(schema.branches.id, input.branchId),
                    eq(schema.branches.organizationId, ctx.actor.organizationId),
                  ),
                );
              if (!branch) {
                throw new ValidationError("Branch not found", { branchId: input.branchId });
              }
            }
            const [row] = await db
              .insert(schema.followUps)
              .values({
                organizationId: ctx.actor.organizationId,
                userId: ctx.actor.userId,
                createdBy: ctx.actor.userId,
                goal: input.goal,
                fireAt: new Date(input.fireAt),
                sessionId: input.sessionId ?? null,
                branchId: input.branchId ?? null,
              })
              .returning();
            await notifyUser(db, {
              organizationId: ctx.actor.organizationId,
              userId: ctx.actor.userId,
              kind: "system",
              title: "Follow-up scheduled",
              body: `I'll come back to this on ${new Date(input.fireAt).toISOString()}: ${input.goal}`,
            });
            return {
              id: row!.id,
              goal: row!.goal,
              fireAt: row!.fireAt.toISOString(),
              sessionId: row!.sessionId,
              branchId: row!.branchId,
              status: row!.status,
            };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.followup.cancel",
          permissions: ["core.followup.write"],
          tags: ["core"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({ followUpId: z.string().uuid() }),
          output: z.object({ cancelled: z.boolean() }),
          handler: async (input, ctx) => {
            const rows = await db
              .update(schema.followUps)
              .set({ status: "cancelled" })
              .where(
                and(
                  eq(schema.followUps.id, input.followUpId),
                  eq(schema.followUps.userId, ctx.actor.userId),
                  or(
                    eq(schema.followUps.status, "scheduled"),
                    eq(schema.followUps.status, "running"),
                  ),
                ),
              )
              .returning();
            if (rows.length === 0) {
              throw new ValidationError("Follow-up not found", { followUpId: input.followUpId });
            }
            return { cancelled: true };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "core.reminder.list",
          permissions: ["core.reminder.write"],
          tags: ["core"],
          input: z.object({ status: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }).default({}),
          output: z.object({
            reminders: z.array(reminderOutputSchema),
          }),
          handler: async (input, ctx) => {
            const where = and(
              eq(schema.reminders.userId, ctx.actor.userId),
              eq(schema.reminders.organizationId, ctx.actor.organizationId),
              input.status ? eq(schema.reminders.status, input.status) : undefined,
            );
            const rows = await db
              .select()
              .from(schema.reminders)
              .where(where)
              .orderBy(schema.reminders.fireAt)
              .limit(input.limit ?? 50);
            return {
              reminders: rows.map((r) => ({
                id: r.id,
                title: r.title,
                body: r.body,
                href: r.href,
                fireAt: r.fireAt.toISOString(),
                channel: r.channel,
                status: r.status,
                branchId: r.branchId,
              })),
            };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "core.followup.list",
          permissions: ["core.followup.write"],
          tags: ["core"],
          input: z.object({ status: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }).default({}),
          output: z.object({
            followUps: z.array(followUpOutputSchema),
          }),
          handler: async (input, ctx) => {
            const where = and(
              eq(schema.followUps.userId, ctx.actor.userId),
              eq(schema.followUps.organizationId, ctx.actor.organizationId),
              input.status ? eq(schema.followUps.status, input.status) : undefined,
            );
            const rows = await db
              .select()
              .from(schema.followUps)
              .where(where)
              .orderBy(schema.followUps.fireAt)
              .limit(input.limit ?? 50);
            return {
              followUps: rows.map((f) => ({
                id: f.id,
                goal: f.goal,
                fireAt: f.fireAt.toISOString(),
                sessionId: f.sessionId,
                branchId: f.branchId,
                status: f.status,
              })),
            };
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
          minAutonomyForAuto: "guarded_auto",
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

/**
 * C2/C5 schedule processor — the worker's cadence for firing time-bound work.
 *
 * Both claim functions use an atomic UPDATE ... RETURNING so concurrent
 * workers cannot double-fire a job. `processDueReminders` also delivers the
 * in-app notification; `claimDueFollowUps` hands the claimed rows back so the
 * caller can re-enter the agent harness with the follow-up goal.
 */
export function createScheduleProcessor(db: Db) {
  return {
    async processDueReminders(): Promise<number> {
      const now = new Date();
      const rows = await db
        .update(schema.reminders)
        .set({ status: "fired", firedAt: now })
        .where(and(eq(schema.reminders.status, "scheduled"), lte(schema.reminders.fireAt, now)))
        .returning();
      for (const r of rows) {
        await notifyUser(db, {
          organizationId: r.organizationId,
          userId: r.userId,
          kind: "reminder",
          title: r.title,
          body: r.body ?? undefined,
          href: r.href ?? undefined,
          resourceType: "reminder",
          resourceId: r.id,
        });
      }
      return rows.length;
    },

    async claimDueFollowUps(): Promise<(typeof schema.followUps.$inferSelect)[]> {
      const now = new Date();
      return db
        .update(schema.followUps)
        .set({ status: "running" })
        .where(and(eq(schema.followUps.status, "scheduled"), lte(schema.followUps.fireAt, now)))
        .returning();
    },
  };
}
