/**
 * Identity — RBAC, users, roles, and invites.
 *
 * ARCH-3 — extracted from the platform "god module" as a bounded context.
 * `core.rbac.*`, `core.role.*`, and `core.user.*` command/query names are
 * unchanged, so the API and web surface are untouched; only ownership moved
 * to its own package.
 */
import type { Db } from "@chaste/db";
import { PERMISSION_CATALOG, hashAuthToken, hashApiKeySecret, schema } from "@chaste/db";
import {
  NotFoundError,
  ValidationError,
  defineCommand,
  defineQuery,
  type BusinessModule,
} from "@chaste/kernel";
import { and, eq, or } from "drizzle-orm";
import { z } from "zod";

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

export interface IdentityModuleOptions {
  /**
   * F5 — bearer token TTL in milliseconds. Tokens minted by `core.user.invite`
   * / `core.user.create` expire after this window (resolved by
   * `resolveUserByToken`, which rejects expired tokens). Defaults to 90 days.
   */
  authTokenTtlMs?: number;
}

const DEFAULT_AUTH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function createIdentityModule(db: Db, opts: IdentityModuleOptions = {}): BusinessModule {
  const authTokenTtlMs = opts.authTokenTtlMs ?? DEFAULT_AUTH_TOKEN_TTL_MS;
  const tokenExpiresAt = () => new Date(Date.now() + authTokenTtlMs);
  return {
    manifest: {
      id: "identity",
      name: "Identity",
      version: "0.1.0",
      description: "RBAC, users, roles, and invites",
      dependencies: [],
      permissions: [
        "core.rbac.read",
        "core.user.manage",
        "core.user.read",
        "core.role.manage",
        "core.role.assign",
        "core.apikey.manage",
        "core.apikey.read",
      ],
      capabilities: ["core.rbac"],
      specialist: {
        id: "identity",
        displayName: "Identity Agent",
        description: "Users, roles, and access control",
        toolTags: ["core"],
      },
    },
    register({ commands, queries }) {
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
          handler: async (input, ctx, helpers) => {
            const tx = (helpers.db ?? db) as Db;
            const [role] = await tx
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
              await tx.insert(schema.rolePermissions).values({ roleId: role!.id, permission });
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
              .where(
                and(eq(schema.roles.id, input.roleId), eq(schema.roles.organizationId, orgId)),
              );
            if (!role) {
              throw new ValidationError("Role not found", { roleId: input.roleId });
            }
            const [user] = await db
              .select()
              .from(schema.users)
              .where(
                and(eq(schema.users.id, input.userId), eq(schema.users.organizationId, orgId)),
              );
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
                .where(
                  and(eq(schema.roles.id, input.roleId), eq(schema.roles.organizationId, orgId)),
                );
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
                // F7 — at-rest the column holds only the digest; the raw token
                // is returned exactly once (same as core.user.invite).
                authToken: hashAuthToken(authToken),
                // F5 — invite tokens expire.
                tokenExpiresAt: tokenExpiresAt(),
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
                .where(
                  and(eq(schema.roles.id, input.roleId), eq(schema.roles.organizationId, orgId)),
                );
              if (!role) {
                throw new ValidationError("Role not found", { roleId: input.roleId });
              }
            }
            if (input.branchId) {
              const [branch] = await db
                .select()
                .from(schema.branches)
                .where(
                  and(
                    eq(schema.branches.id, input.branchId),
                    eq(schema.branches.organizationId, orgId),
                  ),
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
                // F5 — invite tokens expire.
                tokenExpiresAt: tokenExpiresAt(),
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
              .innerJoin(
                schema.rolePermissions,
                eq(schema.userRoles.roleId, schema.rolePermissions.roleId),
              )
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
              .where(
                and(eq(schema.roles.id, input.roleId), eq(schema.roles.organizationId, orgId)),
              );
            if (!role) {
              throw new ValidationError("Role not found", { roleId: input.roleId });
            }
            const [user] = await db
              .select()
              .from(schema.users)
              .where(
                and(eq(schema.users.id, input.userId), eq(schema.users.organizationId, orgId)),
              );
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
                (p) => p.permission === "core.role.manage" || p.permission === "core.user.manage",
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
                .innerJoin(
                  schema.userRoles,
                  eq(schema.rolePermissions.roleId, schema.userRoles.roleId),
                )
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
              await db.update(schema.roles).set(updates).where(eq(schema.roles.id, input.roleId));
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
          handler: async (input, ctx, helpers) => {
            const tx = (helpers.db ?? db) as Db;
            const [role] = await tx
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
            const usersWithRole = await tx
              .select({ userId: schema.userRoles.userId })
              .from(schema.userRoles)
              .where(eq(schema.userRoles.roleId, input.roleId));

            for (const { userId } of usersWithRole) {
              const otherAdminRoles = await tx
                .select({ roleId: schema.rolePermissions.roleId })
                .from(schema.rolePermissions)
                .innerJoin(
                  schema.userRoles,
                  eq(schema.rolePermissions.roleId, schema.userRoles.roleId),
                )
                .where(
                  and(
                    eq(schema.userRoles.userId, userId),
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
                throw new ValidationError(
                  `Cannot delete role: user ${userId} would have no admin permissions`,
                );
              }
            }

            // Cascade delete handles role_permissions and user_roles
            await tx.delete(schema.roles).where(eq(schema.roles.id, input.roleId));
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
                roles: z.array(z.object({ id: z.string(), key: z.string(), name: z.string() })),
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

      // ─── API keys (org-scoped machine credentials with their own scopes) ──

      commands.register(
        defineCommand({
          name: "core.apikey.create",
          permissions: ["core.apikey.manage"],
          tags: ["core"],
          minAutonomyForAuto: "full_autonomous",
          input: z.object({
            name: z.string().min(1).max(80),
            description: z.string().max(500).optional(),
            scopes: z.array(z.string().min(1)).min(1).max(100),
            expiresAt: z.string().datetime().optional(),
          }),
          output: z.object({
            id: z.string(),
            name: z.string(),
            description: z.string().nullable(),
            secret: z.string(),
            prefix: z.string(),
            scopes: z.array(z.string()),
            expiresAt: z.string().nullable(),
          }),
          handler: async (input, ctx) => {
            const orgId = ctx.actor.organizationId;
            // Scopes must be a subset of the permission catalog; a key can never
            // exceed what the platform ships (least privilege, validated here).
            const catalog = new Set(PERMISSION_CATALOG.map((p) => p.permission));
            const unknown = input.scopes.filter((s) => !catalog.has(s));
            if (unknown.length > 0) {
              throw new ValidationError("Unknown permission(s) in scopes", { unknown });
            }
            const secret = `chaste_${globalThis.crypto.randomUUID().replaceAll("-", "")}${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
            const prefix = `chaste_${secret.slice(7, 15)}`;
            const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
            const [key] = await db
              .insert(schema.apiKeys)
              .values({
                organizationId: orgId,
                name: input.name,
                description: input.description ?? null,
                hashedSecret: hashApiKeySecret(secret),
                prefix,
                scopes: input.scopes,
                status: "active",
                createdByUserId: ctx.actor.userId,
                expiresAt,
              })
              .returning();
            return {
              id: key!.id,
              name: key!.name,
              description: key!.description,
              secret,
              prefix: key!.prefix,
              scopes: key!.scopes,
              expiresAt: key!.expiresAt ? key!.expiresAt.toISOString() : null,
            };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.apikey.revoke",
          permissions: ["core.apikey.manage"],
          tags: ["core"],
          minAutonomyForAuto: "full_autonomous",
          input: z.object({ apiKeyId: z.string().uuid() }),
          output: z.object({ id: z.string(), status: z.literal("revoked") }),
          handler: async (input, ctx) => {
            const rows = await db
              .update(schema.apiKeys)
              .set({ status: "revoked" })
              .where(
                and(
                  eq(schema.apiKeys.id, input.apiKeyId),
                  eq(schema.apiKeys.organizationId, ctx.actor.organizationId),
                ),
              )
              .returning({ id: schema.apiKeys.id });
            if (rows.length === 0) {
              throw new NotFoundError("API key");
            }
            return { id: rows[0]!.id, status: "revoked" as const };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.apikey.rotate",
          permissions: ["core.apikey.manage"],
          tags: ["core"],
          minAutonomyForAuto: "full_autonomous",
          input: z.object({ apiKeyId: z.string().uuid() }),
          output: z.object({ id: z.string(), secret: z.string(), prefix: z.string() }),
          handler: async (input, ctx) => {
            const secret = `chaste_${globalThis.crypto.randomUUID().replaceAll("-", "")}${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
            const prefix = `chaste_${secret.slice(7, 15)}`;
            const rows = await db
              .update(schema.apiKeys)
              .set({ hashedSecret: hashApiKeySecret(secret), prefix })
              .where(
                and(
                  eq(schema.apiKeys.id, input.apiKeyId),
                  eq(schema.apiKeys.organizationId, ctx.actor.organizationId),
                ),
              )
              .returning({ id: schema.apiKeys.id });
            if (rows.length === 0) {
              throw new NotFoundError("API key");
            }
            return { id: rows[0]!.id, secret, prefix };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "core.apikey.list",
          permissions: ["core.apikey.read"],
          tags: ["core"],
          input: z.object({}).default({}),
          output: z.object({
            items: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                description: z.string().nullable(),
                prefix: z.string(),
                scopes: z.array(z.string()),
                status: z.string(),
                createdByUserId: z.string(),
                lastUsedAt: z.string().nullable(),
                expiresAt: z.string().nullable(),
                createdAt: z.string(),
              }),
            ),
          }),
          handler: async (_i, ctx) => {
            const rows = await db
              .select()
              .from(schema.apiKeys)
              .where(eq(schema.apiKeys.organizationId, ctx.actor.organizationId))
              .orderBy(schema.apiKeys.createdAt);
            return {
              items: rows.map((k) => ({
                id: k.id,
                name: k.name,
                description: k.description,
                prefix: k.prefix,
                scopes: k.scopes,
                status: k.status,
                createdByUserId: k.createdByUserId,
                lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
                expiresAt: k.expiresAt ? k.expiresAt.toISOString() : null,
                createdAt: k.createdAt.toISOString(),
              })),
            };
          },
        }),
      );
    },
  };
}
