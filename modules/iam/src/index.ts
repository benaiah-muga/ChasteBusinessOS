import { randomBytes } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  invitations,
  memberships,
  moduleSettings,
  orgBranding,
  organizations,
  policies,
  rolePermissions,
  roles,
  users,
  userRoles,
} from "@chaste/db";
import { withOrgContext } from "@chaste/db";
import type { Database } from "@chaste/db";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";
import { assertNotLastOwner } from "./last-owner";

export { assertNotLastOwner } from "./last-owner";

export interface ModuleDeps {
  db: Database["db"];
  /**
   * Per-module settings schemas (web layer). When a module has a schema,
   * setModuleConfig validates the payload against it kernel-side, so agents
   * and UI share the same boundary. Modules without a schema accept a plain
   * record.
   */
  settingsSchemas?: Record<string, z.ZodTypeAny>;
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
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
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
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
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
        // N07: replacing roles must never strand the org without an owner.
        if (role.key !== "owner") await assertNotLastOwner(tx, ctx.actor.orgId, input.userId);
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
      "Invite someone by email to join the organization with a specific role; they accept via a token link. Humans only: agents are refused and must ask their principal to invite",
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
      // Adding a person to an org is an identity decision. Agents act on
      // instructions that may arrive injected through documents or chat, so
      // they never extend membership regardless of what org policy allows;
      // the human principal invites directly.
      if (ctx.actor.type !== "human") {
        throw new Error("member invitations require a human actor; ask your principal to send the invite");
      }
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

/**
 * Platform spine modules that can never be switched off: they host the
 * switchboard itself (iam), the needs-attention registry (signals), and the
 * scheduler (routines). Disabling any of them would let one toggle brick the
 * org's ability to govern itself, so every write path unions them back in
 * and the kernel module gate always reports them enabled.
 */
export const PROTECTED_MODULE_IDS = ["iam", "signals", "routines"] as const;

/**
 * Turns platform modules on or off for the org. Identity-class: reshaping
 * which surfaces the business operates is an authority decision, reversible -
 * the previous set rides along in the output so the inverse restores it
 * exactly. Protected spine modules are unioned in: no caller (human route,
 * agent tool call, or a stale inverse) can drop them.
 */
const setModules = (deps: ModuleDeps) =>
  defineCapability({
    id: "iam.setModules",
    title: "Set enabled modules",
    intent:
      "Choose which platform modules this organization runs, such as accounting, pos, inventory, hr or support; disabled modules become unreachable in the UI and to agents until re-enabled",
    module: "iam",
    risk: "identity",
    permission: "iam.admin",
    input: z.object({
      modules: z.array(z.string().min(1).max(40)).min(1),
    }),
    output: z.object({
      enabledModules: z.array(z.string()),
      previousModules: z.array(z.string()),
    }),
    inverse: {
      capabilityId: "iam.restoreModules",
      buildInput: (_input, output) => ({
        modules: output.previousModules,
      }),
    },
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [org] = await tx
          .select({ value: organizations.enabledModules })
          .from(organizations)
          .where(eq(organizations.id, ctx.actor.orgId))
          .limit(1);
        if (!org) throw new Error("organization not found");
        const previousModules = Array.isArray(org.value) ? (org.value as string[]) : [];
        const next = [...new Set([...PROTECTED_MODULE_IDS, ...input.modules])];
        await tx
          .update(organizations)
          .set({ enabledModules: next })
          .where(eq(organizations.id, ctx.actor.orgId));
        return { enabledModules: next, previousModules };
      });
    },
  });

/**
 * The inverse side of the switchboard: put back exactly the module list that
 * was live before a setModules applied. Kept as its own governed id because
 * a capability cannot be its own inverse. Protected modules are unioned in,
 * so even a snapshot from before they existed cannot disable them.
 */
const restoreModules = (deps: ModuleDeps) =>
  defineCapability({
    id: "iam.restoreModules",
    title: "Restore enabled modules",
    intent:
      "Put back the exact module selection that was enabled before a recent change, undoing it when a switchboard edit turns out wrong",
    module: "iam",
    risk: "identity",
    permission: "iam.admin",
    input: z.object({
      modules: z.array(z.string().min(1).max(40)).min(1),
    }),
    output: z.object({ enabledModules: z.array(z.string()) }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const next = [...new Set([...PROTECTED_MODULE_IDS, ...input.modules])];
        await tx
          .update(organizations)
          .set({ enabledModules: next })
          .where(eq(organizations.id, ctx.actor.orgId));
        return { enabledModules: next };
      });
    },
  });

export function registerIamCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(createRole(deps));
  registry.register(updateRolePermissions(deps));
  registry.register(assignRole(deps));
  registry.register(inviteMember(deps));
  registry.register(listMembers(deps));
  registry.register(setModules(deps));
  registry.register(restoreModules(deps));
  registry.register(setModuleConfig(deps));
  registry.register(setOrgPolicy(deps));
  registry.register(setOrgBranding(deps));
}

/**
 * Per-module configuration. One jsonb row per org per module; the payload is
 * validated against the module's registered schema (when one exists) before
 * it is stored, so a malformed settings object is refused at the boundary,
 * not discovered as a broken UI later.
 */
const setModuleConfig = (deps: ModuleDeps) =>
  defineCapability({
    id: "iam.setModuleConfig",
    title: "Set module configuration",
    intent:
      "Save configuration values for one platform module, such as default units or payment terms, so its pages and forms pick the values up as defaults",
    module: "iam",
    risk: "write",
    permission: "iam.admin",
    input: z.object({
      module: z.string().min(1).max(40),
      settings: z.record(z.string(), z.unknown()),
    }),
    output: z.object({ module: z.string(), settings: z.record(z.string(), z.unknown()) }),
    execute: async (ctx, input) => {
      const schema = deps.settingsSchemas?.[input.module];
      let settings = input.settings;
      if (schema) {
        const parsed = schema.safeParse(settings);
        if (!parsed.success) {
          throw new Error(`invalid settings for module "${input.module}": ${parsed.error.issues[0]?.message ?? "shape mismatch"}`);
        }
        settings = parsed.data as Record<string, unknown>;
      }
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        await tx
          .insert(moduleSettings)
          .values({ orgId: ctx.actor.orgId, module: input.module, settings })
          .onConflictDoUpdate({
            target: [moduleSettings.orgId, moduleSettings.module],
            set: { settings, updatedAt: new Date() },
          });
      }).then(() => ({ module: input.module, settings }));
    },
  });

/**
 * The org's blanket autonomy policy. Identity-class: deciding what the
 * workmate may do autonomously - and whether humans are subject to
 * maker-checker - is an authority decision (ADR 0055).
 */
const setOrgPolicy = (deps: ModuleDeps) =>
  defineCapability({
    id: "iam.setOrgPolicy",
    title: "Set organization policy",
    intent:
      "Choose how much the workmate may do autonomously: the highest risk class it may act on without approval, the money amount above which payments need sign-off, and whether humans are also subject to maker-checker",
    module: "iam",
    risk: "identity",
    permission: "iam.admin",
    input: z.object({
      maxRiskAutonomous: z.enum(["read", "write", "money", "identity", "destructive"]),
      moneyThresholdMinor: z.number().int().min(0).max(1_000_000_000).optional(),
      requiresApprovalFor: z.array(z.enum(["identity", "destructive", "money", "*"])).max(4).default([]),
    }),
    output: z.object({ saved: z.literal(true) }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const values = {
          orgId: ctx.actor.orgId,
          capabilityPattern: "*",
          maxRiskAutonomous: input.maxRiskAutonomous,
          moneyThresholdMinor: input.moneyThresholdMinor ?? null,
          requiresApprovalFor: input.requiresApprovalFor,
          updatedAt: new Date(),
        };
        await tx
          .insert(policies)
          .values(values)
          .onConflictDoUpdate({
            target: [policies.orgId, policies.capabilityPattern],
            set: {
              maxRiskAutonomous: values.maxRiskAutonomous,
              moneyThresholdMinor: values.moneyThresholdMinor,
              requiresApprovalFor: values.requiresApprovalFor,
              updatedAt: values.updatedAt,
            },
          });
        return { saved: true as const };
      });
    },
  });

/**
 * The organization's own AI configuration: which provider, which key, which
 * model per role. Secret-class: the key is encrypted at rest (AES-256-GCM),
 * never rendered back, and never included in ledger payloads - the ledger
 * entry records that credentials changed, not the credentials. An org
 * without its own key falls back to the server's env configuration.
 */
/**
 * Print branding for the org's invoices, quotes and printed documents
 * (Phase 4). Single-row config upsert like setModuleConfig: applying new
 * values IS the reversal, so no inverse is declared.
 */
const setOrgBranding = (deps: ModuleDeps) =>
  defineCapability({
    id: "iam.setOrgBranding",
    title: "Set print branding",
    intent:
      "Choose how the organization's printed documents look: upload a logo, pick an accent color, set the small print footer, and pick the invoice layout",
    module: "iam",
    risk: "write",
    permission: "iam.admin",
    input: z.object({
      logoDataUrl: z
        .string()
        .regex(/^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/=]+$/)
        .max(300_000)
        .optional(),
      accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      invoiceFooter: z.string().max(300).optional(),
      layout: z.enum(["classic", "modern"]).optional(),
    }),
    output: z.object({ saved: z.literal(true) }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [existing] = await tx
          .select({
            logoDataUrl: orgBranding.logoDataUrl,
            accentColor: orgBranding.accentColor,
            invoiceFooter: orgBranding.invoiceFooter,
            layout: orgBranding.layout,
          })
          .from(orgBranding)
          .where(eq(orgBranding.orgId, ctx.actor.orgId))
          .limit(1);
        const values = {
          orgId: ctx.actor.orgId,
          // Omitting the logo keeps the stored one; send logoDataUrl: null
          // shape is impossible through zod optional, so clearing is explicit below.
          logoDataUrl: input.logoDataUrl ?? existing?.logoDataUrl ?? null,
          accentColor: input.accentColor ?? existing?.accentColor ?? null,
          invoiceFooter: input.invoiceFooter ?? existing?.invoiceFooter ?? null,
          layout: input.layout ?? existing?.layout ?? "classic",
          updatedAt: ctx.now,
        };
        await tx
          .insert(orgBranding)
          .values(values)
          .onConflictDoUpdate({
            target: orgBranding.orgId,
            set: {
              logoDataUrl: values.logoDataUrl,
              accentColor: values.accentColor,
              invoiceFooter: values.invoiceFooter,
              layout: values.layout,
              updatedAt: values.updatedAt,
            },
          });
        return { saved: true as const };
      });
    },
  });
