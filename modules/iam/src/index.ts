import { randomBytes } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  invitations,
  memberships,
  rolePermissions,
  roles,
  users,
  userRoles,
} from "@chaste/db";
import type { Database } from "@chaste/db";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";

export interface ModuleDeps {
  db: Database["db"];
}

/**
 * Authority over authority. Every capability here is identity-class:
 * policy can never make it autonomous, and execution always follows a
 * human approval.
 */

const createRole = (deps: ModuleDeps) =>
  defineCapability({
    id: "iam.createRole",
    title: "Create role",
    intent:
      "Create a named role in the organization that groups permissions for assignment to members",
    module: "iam",
    risk: "identity",
    permission: "iam.admin",
    input: z.object({
      key: z
        .string()
        .regex(/^[a-z][a-z0-9-]*$/)
        .describe("stable identifier, e.g. accountant"),
      name: z.string().min(1).max(60),
    }),
    output: z.object({ roleId: z.string() }),
    execute: async (ctx, input) => {
      const [existing] = await deps.db
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.orgId, ctx.actor.orgId), eq(roles.key, input.key)))
        .limit(1);
      if (existing) throw new Error(`role "${input.key}" already exists`);
      const [row] = await deps.db
        .insert(roles)
        .values({ orgId: ctx.actor.orgId, key: input.key, name: input.name })
        .returning({ id: roles.id });
      return { roleId: row!.id };
    },
  });

const updateRolePermissions = (deps: ModuleDeps) =>
  defineCapability({
    id: "iam.updateRolePermissions",
    title: "Set role permissions",
    intent:
      "Replace the full permission set of a role; whoever holds the role gains exactly these powers",
    module: "iam",
    risk: "identity",
    permission: "iam.admin",
    input: z.object({
      roleId: z.string(),
      permissions: z.array(z.string().min(1)).max(200),
    }),
    output: z.object({ permissionCount: z.number() }),
    execute: async (ctx, input) => {
      return deps.db.transaction(async (tx) => {
        const [role] = await tx
          .select()
          .from(roles)
          .where(and(eq(roles.id, input.roleId), eq(roles.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!role) throw new Error("role not found");
        if (role.isSystem && role.key === "owner") {
          throw new Error("the owner role cannot be edited");
        }
        await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, role.id));
        const unique = [...new Set(input.permissions)];
        if (unique.length > 0) {
          await tx.insert(rolePermissions).values(
            unique.map((key) => ({ roleId: role.id, permissionKey: key, orgId: ctx.actor.orgId })),
          );
        }
        return { permissionCount: unique.length };
      });
    },
  });

const assignRole = (deps: ModuleDeps) =>
  defineCapability({
    id: "iam.assignRole",
    title: "Assign role to member",
    intent:
      "Give a member a role, replacing their previous one; this grants them every power the role holds",
    module: "iam",
    risk: "identity",
    permission: "iam.admin",
    input: z.object({
      userId: z.string(),
      roleId: z.string(),
    }),
    output: z.object({ assigned: z.boolean() }),
    execute: async (ctx, input) => {
      return deps.db.transaction(async (tx) => {
        const [member] = await tx
          .select({ id: memberships.id })
          .from(memberships)
          .where(
            and(eq(memberships.userId, input.userId), eq(memberships.orgId, ctx.actor.orgId)),
          )
          .limit(1);
        if (!member) throw new Error("user is not a member of this organization");
        const [role] = await tx
          .select()
          .from(roles)
          .where(and(eq(roles.id, input.roleId), eq(roles.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!role) throw new Error("role not found");
        await tx
          .delete(userRoles)
          .where(and(eq(userRoles.userId, input.userId), eq(userRoles.orgId, ctx.actor.orgId)));
        await tx.insert(userRoles).values({
          userId: input.userId,
          roleId: role.id,
          orgId: ctx.actor.orgId,
          assignedBy: ctx.actor.id,
        });
        return { assigned: true };
      });
    },
  });

const inviteMember = (deps: ModuleDeps) =>
  defineCapability({
    id: "iam.inviteMember",
    title: "Invite member",
    intent:
      "Invite someone by email to join the organization with a specific role; they accept via a token link",
    module: "iam",
    risk: "write",
    permission: "iam.admin",
    input: z.object({
      email: z.string().email(),
      roleId: z.string(),
      expiresInDays: z.number().int().min(1).max(30).default(7),
    }),
    output: z.object({ invitationId: z.string(), token: z.string(), expiresAt: z.string() }),
    execute: async (ctx, input) => {
      const [role] = await deps.db
        .select()
        .from(roles)
        .where(and(eq(roles.id, input.roleId), eq(roles.orgId, ctx.actor.orgId)))
        .limit(1);
      if (!role) throw new Error("role not found");
      const expiresAt = new Date(ctx.now.getTime() + input.expiresInDays * 86_400_000);
      const token = randomBytes(24).toString("base64url");
      const [row] = await deps.db
        .insert(invitations)
        .values({
          orgId: ctx.actor.orgId,
          email: input.email.toLowerCase(),
          roleId: input.roleId,
          token,
          invitedByUserId: ctx.actor.type === "human" ? ctx.actor.id : null,
          expiresAt,
        })
        .returning({ id: invitations.id });
      return { invitationId: row!.id, token, expiresAt: expiresAt.toISOString() };
    },
  });

const listMembers = (deps: ModuleDeps) =>
  defineCapability({
    id: "iam.listMembers",
    title: "List members and roles",
    intent:
      "Show everyone in the organization with their roles, plus every role and its permission keys",
    module: "iam",
    risk: "read",
    permission: "iam.read",
    input: z.object({}),
    output: z.object({
      members: z.array(
        z.object({
          userId: z.string(),
          name: z.string().nullable(),
          email: z.string(),
          roleKeys: z.array(z.string()),
        }),
      ),
      roles: z.array(
        z.object({
          id: z.string(),
          key: z.string(),
          name: z.string(),
          isSystem: z.boolean(),
          permissions: z.array(z.string()),
        }),
      ),
    }),
    execute: async (ctx) => {
      const orgRoles = await deps.db
        .select()
        .from(roles)
        .where(eq(roles.orgId, ctx.actor.orgId))
        .orderBy(asc(roles.key));
      const perms = await deps.db.select().from(rolePermissions).where(eq(rolePermissions.orgId, ctx.actor.orgId));
      const permsByRole = new Map<string, string[]>();
      for (const p of perms) {
        permsByRole.set(p.roleId, [...(permsByRole.get(p.roleId) ?? []), p.permissionKey]);
      }

      const rows = await deps.db
        .select({
          userId: memberships.userId,
          name: users.name,
          email: users.email,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.orgId, ctx.actor.orgId))
        .orderBy(asc(users.email));

      const userRoleRows = await deps.db
        .select({ userId: userRoles.userId, roleKey: roles.key })
        .from(userRoles)
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .where(eq(userRoles.orgId, ctx.actor.orgId));
      const rolesByUser = new Map<string, string[]>();
      for (const ur of userRoleRows) {
        rolesByUser.set(ur.userId, [...(rolesByUser.get(ur.userId) ?? []), ur.roleKey]);
      }

      return {
        members: rows.map((m) => ({
          ...m,
          roleKeys: rolesByUser.get(m.userId) ?? [],
        })),
        roles: orgRoles.map((r) => ({
          id: r.id,
          key: r.key,
          name: r.name,
          isSystem: r.isSystem,
          permissions: permsByRole.get(r.id) ?? [],
        })),
      };
    },
  });

export function registerIamCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(createRole(deps));
  registry.register(updateRolePermissions(deps));
  registry.register(assignRole(deps));
  registry.register(inviteMember(deps));
  registry.register(listMembers(deps));
}
