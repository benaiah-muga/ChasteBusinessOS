import type { Db } from "@chaste/db";
import {
  resolveUserPermissions,
  schema,
  listDeadLetterEvents,
  replayDeadLetterEvents,
} from "@chaste/db";
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
  NotFoundError,
  ValidationError,
} from "@chaste/kernel";
import { and, desc, eq, ilike, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  createEmailAdapter,
  detectEmailProvider,
  emailTemplateSchema,
  renderEmailTemplate,
  type EmailAdapter,
} from "./email.js";
import { createObjectStore, objectStoreStatus, restoreFromStore } from "./backup.js";

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

/** Minimal structural contract for the proactive watch-rule store. */
interface WatchRuleRecord {
  id: string;
  organizationId: string;
  name: string;
  trigger:
    | { kind: "schedule"; recurrence: { freq: "daily" | "weekly" | "monthly"; interval?: number; daysOfWeek?: number[]; at?: string }; timezone: string }
    | { kind: "event"; eventKey: string };
  action: { mode: "notify" | "suggest" | "draft" | "request_approval"; intent: string; recipients: string[] };
  condition?: string;
  enabled: boolean;
  priority: "low" | "normal" | "high";
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

interface WatchRuleStoreLike {
  create(
    rule: Omit<WatchRuleRecord, "id" | "createdAt" | "updatedAt"> & { id?: string; createdAt?: string },
  ): Promise<WatchRuleRecord>;
  update(
    organizationId: string,
    id: string,
    patch: Partial<Pick<WatchRuleRecord, "name" | "trigger" | "action" | "condition" | "priority" | "enabled">>,
  ): Promise<WatchRuleRecord | undefined>;
  remove(organizationId: string, id: string): Promise<boolean>;
  get(organizationId: string, id: string): Promise<WatchRuleRecord | undefined>;
  listByOrg(organizationId: string): Promise<WatchRuleRecord[]>;
}

const watchRuleTriggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("schedule"),
    recurrence: z.object({
      freq: z.enum(["daily", "weekly", "monthly"]),
      interval: z.number().int().positive().optional(),
      daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
      at: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    }),
    timezone: z.string().min(1).default("UTC"),
  }),
  z.object({ kind: z.literal("event"), eventKey: z.string().min(1) }),
]);
const watchRuleActionSchema = z.object({
  mode: z.enum(["notify", "suggest", "draft", "request_approval"]),
  intent: z.string().min(1),
  recipients: z.array(z.string().min(1)).min(1),
});
const watchRuleOutputSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  trigger: watchRuleTriggerSchema,
  action: watchRuleActionSchema,
  condition: z.string().optional(),
  enabled: z.boolean(),
  priority: z.enum(["low", "normal", "high"]),
  resolvedRecipients: z.array(z.string()),
  createdByUserId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Recipient tokens accepted by core.watchRule.*: "me", an email, a role key, or a user id.
 * Resolves what it can; keeps unknown tokens (legacy/external recipient ids) as-is so
 * creating a rule never hard-fails on a group the org hasn't populated yet. The only
 * hard error is a *known* role key whose group has no active users — that is a
 * genuine "nobody to notify" mistake worth surfacing. */
async function resolveWatchRuleRecipients(
  db: Db,
  orgId: string,
  actorUserId: string,
  recipients: string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const raw of recipients) {
    const token = raw.trim();
    if (token.toLowerCase() === "me") {
      ids.push(actorUserId);
      continue;
    }
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
      ids.push(token);
      continue;
    }
    if (token.includes("@")) {
      const [user] = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(
          and(eq(schema.users.organizationId, orgId), eq(schema.users.email, token.toLowerCase())),
        )
        .limit(1);
      ids.push(user?.id ?? token.toLowerCase());
      continue;
    }
    const key = token.toLowerCase();
    const roleRows = await db
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(and(eq(schema.roles.organizationId, orgId), eq(schema.roles.key, key)));
    if (roleRows.length > 0) {
      const roleUsers = await db
        .select({ userId: schema.userRoles.userId })
        .from(schema.userRoles)
        .innerJoin(schema.users, eq(schema.users.id, schema.userRoles.userId))
        .where(
          and(
            inArray(schema.userRoles.roleId, roleRows.map((r) => r.id)),
            eq(schema.users.isActive, true),
          ),
        );
      if (roleUsers.length === 0) {
        throw new ValidationError(`No active users found for recipient group: ${token}`, {
          recipients,
        });
      }
      ids.push(...roleUsers.map((r) => r.userId));
      continue;
    }
    // Unknown token — preserve as-is (legacy id / future external channel).
    ids.push(token);
  }
  return [...new Set(ids)];
}

/** Offset minutes east of UTC for a named IANA timezone at `date`. */
function tzOffsetMinutes(timeZone: string, date: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
    hour12: false,
  });
  const name = fmt.formatToParts(date).find((p) => p.type === "timeZoneName")?.value ?? "";
  const m = name.match(/GMT([+-])(\d{2})(?::?(\d{2}))?/);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** Convert a local HH:MM `at` into UTC HH:MM for a named timezone. */
function localAtToUtc(at: string, timeZone: string): string {
  if (!timeZone || timeZone === "UTC") return at;
  const [hh, mm] = at.split(":").map((n) => Number(n));
  const total = (hh! * 60 + mm! - tzOffsetMinutes(timeZone, new Date()) + 24 * 60) % (24 * 60);  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function createPlatformModule(
  db: Db,
  modules: ModuleRegistry,
  opts: {
    allowFullAutonomous: boolean;
    regions: string[];
    /** Durable watch-rule store (ADR 0014). Optional so headless/unit callers stay happy. */
    watchRules?: WatchRuleStoreLike;
  },
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
        "core.bpartner.manage",
        "core.bpartner.read",
        "core.backup.read",
        "core.backup.manage",
        "core.outbox.read",
        "core.outbox.manage",
        "core.workflow.read",
        "core.workflow.manage",
        "core.workflow.run",
        "core.watchRule.read",
        "core.watchRule.manage",
        "core.analytics.read",
        "core.replenishment.read",
        "core.importRule.manage",
        "core.importRule.read",
        "core.dashboard.manage",
        "core.dashboard.read",
      ],
      capabilities: ["core.rbac", "core.marketplace", "core.autonomy", "core.bpartners"],
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
              warning: input.autonomy === "full_autonomous" ? FULL_AUTONOMOUS_WARNING : undefined,
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
              throw new ValidationError("Only platform-owned listings can be archived", {
                moduleId: input.moduleId,
                publisher: row.publisher,
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

      commands.register(
        defineCommand({
          name: "core.marketplace.publish",
          permissions: ["core.marketplace.publish"],
          tags: ["core"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            moduleId: z.string().min(1),
            name: z.string().min(1),
            version: z.string().min(1),
            summary: z.string().min(1),
            category: z.string().min(1),
            publisher: z.string().optional(),
            regions: z.array(z.string()).optional(),
            kind: z
              .enum(["marketplace_shared", "local_extension", "private_cloud"])
              .default("marketplace_shared"),
            gapTicketId: z.string().uuid().optional(),
          }),
          output: z.object({ moduleId: z.string(), version: z.string(), published: z.boolean() }),
          handler: async (input, ctx) => {
            // S4 — publish from a resolved gap ticket (self-development.md §4/§9).
            // platform_roadmap is never tenant-published; it goes to maintainers.
            if (input.gapTicketId) {
              const [ticket] = await db
                .select()
                .from(schema.capabilityGapTickets)
                .where(
                  and(
                    eq(schema.capabilityGapTickets.id, input.gapTicketId),
                    eq(schema.capabilityGapTickets.organizationId, ctx.actor.organizationId),
                  ),
                );
              if (!ticket) {
                throw new ValidationError("Gap ticket not found", { ticketId: input.gapTicketId });
              }
              if (ticket.status !== "confirmed" && ticket.status !== "resolved") {
                throw new ValidationError("Only confirmed or resolved tickets can be published", {
                  ticketId: input.gapTicketId,
                  status: ticket.status,
                });
              }
              if (ticket.deploymentTarget === "platform_roadmap") {
                throw new ValidationError(
                  "platform_roadmap work goes to platform maintainers, never a tenant publish",
                  { ticketId: input.gapTicketId },
                );
              }
              if (ticket.deploymentTarget === "undecided") {
                throw new ValidationError("deploymentTarget must be decided before publish", {
                  ticketId: input.gapTicketId,
                });
              }
            }

            const metadata: Record<string, unknown> = { kind: input.kind, archived: false };
            if (input.gapTicketId) metadata.gapTicketId = input.gapTicketId;
            await db
              .insert(schema.marketplaceListings)
              .values({
                moduleId: input.moduleId,
                name: input.name,
                version: input.version,
                summary: input.summary,
                category: input.category,
                publisher: input.publisher ?? ctx.actor.organizationId,
                regions: input.regions ?? ["*"],
                metadata,
              })
              .onConflictDoUpdate({
                target: schema.marketplaceListings.moduleId,
                set: {
                  name: input.name,
                  version: input.version,
                  summary: input.summary,
                  category: input.category,
                  publisher: input.publisher ?? ctx.actor.organizationId,
                  regions: input.regions ?? ["*"],
                  metadata,
                },
              });

            await notifyUser(db, {
              organizationId: ctx.actor.organizationId,
              userId: ctx.actor.userId,
              kind: "system",
              title: `Module published: ${input.moduleId}`,
              body: `${input.name} v${input.version} is now listed (${input.kind}).`,
              resourceType: "marketplace_listing",
              resourceId: input.moduleId,
            });

            return { moduleId: input.moduleId, version: input.version, published: true };
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
          output: z.object({
            id: z.string(),
            name: z.string(),
            code: z.string(),
            active: z.boolean(),
          }),
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
              .where(
                and(eq(schema.users.id, input.userId), eq(schema.users.organizationId, orgId)),
              );
            if (!user) {
              throw new ValidationError("User not found", { userId: input.userId });
            }
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
              .where(
                and(eq(schema.users.id, input.userId), eq(schema.users.organizationId, orgId)),
              );
            if (!user) {
              throw new ValidationError("User not found", { userId: input.userId });
            }
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
                throw new ValidationError("Cannot revoke the user's only branch access", {
                  userId: input.userId,
                  branchId: input.branchId,
                });
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

      // ─── Watch rules (ADR 0014 proactive surface) ────────────────────
      // Durable "if X then Y" rules over the proactive coordinator. `recipients`
      // accept "me", an email, a role key, or a user id — resolved here so the
      // AI and a human both go through one auditable command.

      queries.register(
        defineQuery({
          name: "core.watchRule.list",
          permissions: ["core.watchRule.read"],
          tags: ["core"],
          input: z.object({ enabled: z.boolean().optional() }),
          output: z.object({ rules: z.array(watchRuleOutputSchema) }),
          handler: async (input, ctx) => {
            const store = opts.watchRules;
            if (!store) throw new NotFoundError("Watch rules are not enabled on this host");
            const rules = await store.listByOrg(ctx.actor.organizationId);
            return {
              rules: (input.enabled == null ? rules : rules.filter((r) => r.enabled === input.enabled)).map(
                (r) => ({ ...r, resolvedRecipients: r.action.recipients }),
              ),
            };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.watchRule.create",
          permissions: ["core.watchRule.manage"],
          tags: ["core"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            name: z.string().min(1).max(160),
            trigger: watchRuleTriggerSchema,
            action: watchRuleActionSchema,
            condition: z.string().optional(),
            enabled: z.boolean().optional(),
            priority: z.enum(["low", "normal", "high"]).optional(),
          }),
          output: watchRuleOutputSchema,
          handler: async (input, ctx) => {
            const store = opts.watchRules;
            if (!store) throw new NotFoundError("Watch rules are not enabled on this host");
            const orgId = ctx.actor.organizationId;
            const resolvedRecipients = await resolveWatchRuleRecipients(
              db,
              orgId,
              ctx.actor.userId,
              input.action.recipients,
            );
            const trigger =
              input.trigger.kind === "schedule"
                ? {
                    kind: "schedule" as const,
                    recurrence: {
                      ...input.trigger.recurrence,
                      at: input.trigger.recurrence.at
                        ? localAtToUtc(input.trigger.recurrence.at, input.trigger.timezone)
                        : undefined,
                    },
                    timezone: input.trigger.timezone,
                  }
                : input.trigger;
            const rule = await store.create({
              organizationId: orgId,
              name: input.name,
              trigger,
              action: { ...input.action, recipients: resolvedRecipients },
              condition: input.condition,
              enabled: input.enabled ?? true,
              priority: input.priority ?? "normal",
              createdByUserId: ctx.actor.userId,
            });
            await notifyUser(db, {
              organizationId: orgId,
              userId: ctx.actor.userId,
              kind: "system",
              title: `Watch rule created: ${rule.name}`,
              body: `Rule "${rule.name}" is active and will be evaluated on its schedule.`,
              resourceType: "watch_rule",
              resourceId: rule.id,
            });
            return { ...rule, resolvedRecipients };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.watchRule.update",
          permissions: ["core.watchRule.manage"],
          tags: ["core"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            ruleId: z.string().uuid(),
            name: z.string().min(1).max(160).optional(),
            trigger: watchRuleTriggerSchema.optional(),
            action: watchRuleActionSchema.optional(),
            condition: z.string().optional(),
            enabled: z.boolean().optional(),
            priority: z.enum(["low", "normal", "high"]).optional(),
          }),
          output: watchRuleOutputSchema,
          handler: async (input, ctx) => {
            const store = opts.watchRules;
            if (!store) throw new NotFoundError("Watch rules are not enabled on this host");
            const orgId = ctx.actor.organizationId;
            const patch: {
              name?: string;
              trigger?: WatchRuleRecord["trigger"];
              action?: WatchRuleRecord["action"];
              condition?: string;
              enabled?: boolean;
              priority?: "low" | "normal" | "high";
            } = {};
            if (input.name != null) patch.name = input.name;
            if (input.condition != null) patch.condition = input.condition;
            if (input.enabled != null) patch.enabled = input.enabled;
            if (input.priority != null) patch.priority = input.priority;
            if (input.trigger) {
              patch.trigger =
                input.trigger.kind === "schedule"
                  ? {
                      kind: "schedule" as const,
                      recurrence: {
                        ...input.trigger.recurrence,
                        at: input.trigger.recurrence.at
                          ? localAtToUtc(input.trigger.recurrence.at, input.trigger.timezone)
                          : undefined,
                      },
                      timezone: input.trigger.timezone,
                    }
                  : input.trigger;
            }
            if (input.action) {
              patch.action = {
                ...input.action,
                recipients: await resolveWatchRuleRecipients(
                  db,
                  orgId,
                  ctx.actor.userId,
                  input.action.recipients,
                ),
              };
            }
            const updated = await store.update(orgId, input.ruleId, patch);
            if (!updated) {
              throw new NotFoundError("Watch rule");
            }
            return { ...updated, resolvedRecipients: updated.action.recipients };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.watchRule.delete",
          permissions: ["core.watchRule.manage"],
          tags: ["core"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({ ruleId: z.string().uuid() }),
          output: z.object({ ok: z.literal(true), ruleId: z.string() }),
          handler: async (input, ctx) => {
            const store = opts.watchRules;
            if (!store) throw new NotFoundError("Watch rules are not enabled on this host");
            const removed = await store.remove(ctx.actor.organizationId, input.ruleId);
            if (!removed) {
              throw new NotFoundError("Watch rule");
            }
            return { ok: true as const, ruleId: input.ruleId };
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
              throw new ValidationError(`Cannot edit a ${ticket.status} ticket`, {
                ticketId: input.ticketId,
                status: ticket.status,
              });
            }

            const updates: Record<string, unknown> = {};
            if (input.title !== undefined) updates.title = input.title;
            if (input.abstractRequirement !== undefined) {
              updates.abstractRequirement = input.abstractRequirement;
            }
            if (input.acceptanceCriteria !== undefined) {
              updates.acceptanceCriteria = input.acceptanceCriteria;
            }
            if (input.exampleScenarios !== undefined)
              updates.exampleScenarios = input.exampleScenarios;
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
                  .where(and(where, eq(schema.capabilityGapTickets.status, input.status)))
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
              throw new ValidationError(`Cannot confirm a ${ticket.status} ticket`, {
                ticketId: input.ticketId,
                status: ticket.status,
              });
            }

            const updates: Record<string, unknown> = { status: "confirmed", updatedAt: new Date() };
            if (input.suggestedModuleId !== undefined)
              updates.suggestedModuleId = input.suggestedModuleId;
            if (input.deploymentTarget !== undefined)
              updates.deploymentTarget = input.deploymentTarget;
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
              .where(
                input.moduleId
                  ? eq(schema.capabilityCatalogItems.moduleId, input.moduleId)
                  : undefined,
              )
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
                  input.moduleId
                    ? eq(schema.capabilityCatalogItems.moduleId, input.moduleId)
                    : undefined,
                  or(
                    ilike(schema.capabilityCatalogItems.name, like),
                    ilike(schema.capabilityCatalogItems.description, like),
                  ),
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
            } else if (
              /\b(kernel|authz|authorization|payment|billing|security sensitive|permission|rbac|audit)\b/.test(
                lower,
              )
            ) {
              signals.push("touches kernel authz/payments/core");
              target = "platform_roadmap";
              rationale.push(
                "Touches kernel authz/payments — needs platform maintainers, never a single tenant.",
              );
            } else if (
              /\b(org-specific|company-specific|internal|our workflow|our process|self-host|local process|proprietary)\b/.test(
                lower,
              )
            ) {
              signals.push("org-specific local process");
              target = "local_extension";
              rationale.push(
                "Appears to be an org-specific process that should stay a local extension.",
              );
            } else {
              signals.push("common SMB need");
              target = "marketplace_shared";
              rationale.push(
                "Looks like a common, non-proprietary need — suitable for a shared marketplace package.",
              );
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
          input: z
            .object({
              unreadOnly: z.boolean().optional(),
              limit: z.number().int().min(1).max(200).optional(),
            })
            .default({}),
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

      // ─── Email (C6) ───────────────────────────────────────────────────

      const emailOutputSchema = z.object({
        id: z.string(),
        to: z.string(),
        subject: z.string(),
        template: z.string().nullable(),
        status: z.string(),
        provider: z.string().nullable(),
        providerMessageId: z.string().nullable(),
        error: z.string().nullable(),
        createdAt: z.string(),
        sentAt: z.string().nullable(),
      });

      function toEmailRow(row: typeof schema.emailOutbox.$inferSelect) {
        return {
          id: row.id,
          to: row.to,
          subject: row.subject,
          template: row.template,
          status: row.status,
          provider: row.provider,
          providerMessageId: row.providerMessageId,
          error: row.error,
          createdAt: row.createdAt.toISOString(),
          sentAt: row.sentAt ? row.sentAt.toISOString() : null,
        };
      }

      commands.register(
        defineCommand({
          name: "core.email.send",
          permissions: ["core.email.send"],
          tags: ["core"],
          // F8 — external side effect (leaves the platform). Standing rules bind
          // to the `to` target, and auto-execution requires full autonomy.
          riskClass: "external",
          externalTargetField: "to",
          minAutonomyForAuto: "full_autonomous",
          input: z.object({
            to: z.string().email(),
            subject: z.string().min(1),
            body: z.string().min(1),
          }),
          output: emailOutputSchema,
          handler: async (input, ctx) => {
            const [row] = await db
              .insert(schema.emailOutbox)
              .values({
                organizationId: ctx.actor.organizationId,
                to: input.to,
                subject: input.subject,
                body: input.body,
              })
              .returning();
            return toEmailRow(row!);
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.email.enqueue_template",
          permissions: ["core.email.send"],
          tags: ["core"],
          // F8 — external side effect (leaves the platform); target-bound rules.
          riskClass: "external",
          externalTargetField: "to",
          minAutonomyForAuto: "full_autonomous",
          input: z.object({
            to: z.string().email(),
            template: emailTemplateSchema,
            vars: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
          }),
          output: emailOutputSchema,
          handler: async (input, ctx) => {
            const rendered = renderEmailTemplate(input.template, input.vars);
            const [row] = await db
              .insert(schema.emailOutbox)
              .values({
                organizationId: ctx.actor.organizationId,
                to: input.to,
                subject: rendered.subject,
                body: rendered.body,
                template: input.template,
              })
              .returning();
            return toEmailRow(row!);
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "core.email.outbox.list",
          permissions: ["core.email.send"],
          tags: ["core"],
          input: z
            .object({
              status: z.string().optional(),
              limit: z.number().int().min(1).max(200).optional(),
            })
            .default({}),
          output: z.object({ emails: z.array(emailOutputSchema) }),
          handler: async (input, ctx) => {
            const where = and(
              eq(schema.emailOutbox.organizationId, ctx.actor.organizationId),
              input.status ? eq(schema.emailOutbox.status, input.status) : undefined,
            );
            const rows = await db
              .select()
              .from(schema.emailOutbox)
              .where(where)
              .orderBy(schema.emailOutbox.createdAt)
              .limit(input.limit ?? 50);
            return { emails: rows.map(toEmailRow) };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.email.retry",
          description: "Re-queue a failed email for delivery",
          permissions: ["core.email.send"],
          tags: ["core"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({ emailId: z.string().uuid() }),
          output: emailOutputSchema,
          handler: async (input, ctx) => {
            const [row] = await db
              .update(schema.emailOutbox)
              .set({ status: "queued", error: null, provider: null, sentAt: null })
              .where(
                and(
                  eq(schema.emailOutbox.id, input.emailId),
                  eq(schema.emailOutbox.organizationId, ctx.actor.organizationId),
                ),
              )
              .returning();
            if (!row) throw new NotFoundError("Email");
            return toEmailRow(row);
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "core.email.provider.status",
          description: "Report the active delivery provider (no secrets)",
          permissions: ["core.email.send"],
          tags: ["core"],
          input: z.object({}).default({}),
          output: z.object({
            provider: z.enum(["resend", "smtp", "console"]),
            from: z.string().nullable(),
          }),
          handler: async () => detectEmailProvider(),
        }),
      );

      const backupOutputSchema = z.object({
        id: z.string(),
        status: z.string(),
        provider: z.string().nullable(),
        storageKey: z.string().nullable(),
        sizeBytes: z.number().nullable(),
        checksum: z.string().nullable(),
        error: z.string().nullable(),
        createdAt: z.string(),
        completedAt: z.string().nullable(),
      });

      const toBackupRow = (row: typeof schema.backups.$inferSelect) => ({
        id: row.id,
        status: row.status,
        provider: row.provider,
        storageKey: row.storageKey,
        sizeBytes: row.sizeBytes,
        checksum: row.checksum,
        error: row.error,
        createdAt: row.createdAt.toISOString(),
        completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      });

      commands.register(
        defineCommand({
          name: "core.backup.create",
          description: "Enqueue a full encrypted backup of this organization",
          permissions: ["core.backup.manage"],
          tags: ["core"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({}).default({}),
          output: backupOutputSchema,
          handler: async (_input, ctx) => {
            const [row] = await db
              .insert(schema.backups)
              .values({
                organizationId: ctx.actor.organizationId,
                status: "queued",
                createdBy: ctx.actor.userId ?? null,
              })
              .returning();
            return toBackupRow(row!);
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.backup.restore",
          description: "Restore a successful backup for this organization",
          permissions: ["core.backup.manage"],
          tags: ["core"],
          // F8 — destructive restore is exec-class and must never auto-run below
          // full autonomy, regardless of org settings.
          riskClass: "exec",
          minAutonomyForAuto: "full_autonomous",
          input: z.object({ backupId: z.string().uuid() }),
          output: z.object({
            organizationId: z.string(),
            restoredTables: z.number(),
            rowCount: z.number(),
          }),
          handler: async (input, ctx) => {
            const [row] = await db
              .select()
              .from(schema.backups)
              .where(
                and(
                  eq(schema.backups.id, input.backupId),
                  eq(schema.backups.organizationId, ctx.actor.organizationId),
                  eq(schema.backups.status, "success"),
                ),
              )
              .limit(1);
            if (!row || !row.storageKey) throw new NotFoundError("Backup");
            const store = createObjectStore();
            // F14 — the manifest must belong to the caller's org.
            const result = await restoreFromStore(db, store, row.storageKey, ctx.actor.organizationId);
            return {
              organizationId: result.organizationId,
              restoredTables: result.restoredTables,
              rowCount: result.rowCount,
            };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "core.backup.list",
          description: "List backup jobs for this organization",
          permissions: ["core.backup.read"],
          tags: ["core"],
          input: z
            .object({
              status: z.string().optional(),
              limit: z.number().int().min(1).max(200).optional(),
            })
            .default({}),
          output: z.object({ backups: z.array(backupOutputSchema) }),
          handler: async (input, ctx) => {
            const where = and(
              eq(schema.backups.organizationId, ctx.actor.organizationId),
              input.status ? eq(schema.backups.status, input.status) : undefined,
            );
            const rows = await db
              .select()
              .from(schema.backups)
              .where(where)
              .orderBy(schema.backups.createdAt)
              .limit(input.limit ?? 50);
            return { backups: rows.map(toBackupRow) };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "core.backup.provider.status",
          description: "Report the backup object-store provider (no secrets)",
          permissions: ["core.backup.read"],
          tags: ["core"],
          input: z.object({}).default({}),
          output: z.object({
            provider: z.enum(["s3", "local", "memory", "none"]),
            encryptionConfigured: z.boolean(),
          }),
          handler: async () => objectStoreStatus(),
        }),
      );

      // ─── Dead-letter outbox (ARCH-9/REL-2) ────────────────────────────

      queries.register(
        defineQuery({
          name: "core.outbox.listDead",
          description: "List dead-lettered outbox events for this organization",
          permissions: ["core.outbox.read"],
          tags: ["core"],
          input: z
            .object({
              limit: z.number().int().min(1).max(200).optional(),
              includeReplayed: z.boolean().optional(),
            })
            .default({}),
          output: z.object({
            events: z.array(
              z.object({
                id: z.string(),
                type: z.string(),
                occurredAt: z.string(),
                lastError: z.string().nullable(),
                errorCode: z.string().nullable(),
                attempts: z.number(),
                deadLetteredAt: z.string(),
                replayedAt: z.string().nullable(),
              }),
            ),
          }),
          handler: async (input, ctx) => {
            const rows = await listDeadLetterEvents(
              db,
              ctx.actor.organizationId,
              input.limit ?? 100,
            );
            return {
              events: rows
                .filter((r) => input.includeReplayed || r.replayedAt === null)
                .map((r) => ({
                  id: r.id,
                  type: r.type,
                  occurredAt: r.occurredAt.toISOString(),
                  lastError: r.lastError,
                  errorCode: r.errorCode,
                  attempts: r.attempts,
                  deadLetteredAt: r.deadLetteredAt.toISOString(),
                  replayedAt: r.replayedAt ? r.replayedAt.toISOString() : null,
                })),
            };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.outbox.replay",
          description: "Re-queue dead-lettered outbox events for delivery",
          permissions: ["core.outbox.manage"],
          tags: ["core"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({ eventIds: z.array(z.string().uuid()).min(1).max(100) }),
          output: z.object({ replayed: z.number() }),
          handler: async (input, ctx) => {
            const replayed = await replayDeadLetterEvents(
              db,
              ctx.actor.organizationId,
              input.eventIds,
            );
            return { replayed };
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
          accent: z.enum(["maroon", "teal", "blue", "violet", "rose", "amber", "forest", "slate"]),
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
      // ─── ARCH-5 — AI workflow persistence ────────────────────────────
      // Workflows and their runs are persisted to Postgres (workflow_definitions
      // / workflow_runs) so automations survive process restarts and horizontal
      // scale. Humans and AI reach them through the bus, never process memory.

      const workflowStepInputSchema: z.ZodType<unknown> = z.lazy(() =>
        z.object({
          id: z.string(),
          type: z.enum(["command", "agent", "approval", "condition", "parallel"]),
          command: z.string().optional(),
          agentId: z.string().optional(),
          condition: z.string().optional(),
          approveBy: z.string().optional(),
          description: z.string().optional(),
          input: z.record(z.unknown()).optional(),
          steps: z.array(workflowStepInputSchema).optional(),
          onError: z.enum(["bail", "retry", "continue"]).default("bail"),
        }),
      );

      const workflowInputSchema = z.object({
        id: z.string().min(1).optional(),
        name: z.string().min(1),
        description: z.string().default(""),
        trigger: z.enum(["manual", "event", "schedule"]).default("manual"),
        triggerConfig: z.record(z.unknown()).default({}),
        steps: z.array(workflowStepInputSchema),
        createdBy: z.enum(["user", "ai"]).default("user"),
      });
      type WorkflowInput = z.infer<typeof workflowInputSchema>;
      type WorkflowRow = typeof schema.workflowDefinitions.$inferSelect;

      const workflowOutputSchema = z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        trigger: z.string(),
        triggerConfig: z.record(z.unknown()),
        steps: z.array(z.unknown()),
        createdBy: z.string(),
        createdAt: z.string(),
      });

      async function getWorkflowRow(
        organizationId: string,
        workflowId: string,
      ): Promise<WorkflowRow> {
        const [row] = await db
          .select()
          .from(schema.workflowDefinitions)
          .where(
            and(
              eq(schema.workflowDefinitions.id, workflowId),
              eq(schema.workflowDefinitions.organizationId, organizationId),
            ),
          );
        if (!row) throw new NotFoundError("Workflow");
        return row;
      }

      function mapWorkflow(row: WorkflowRow) {
        return {
          id: row.id,
          name: row.name,
          description: row.description,
          trigger: row.trigger,
          triggerConfig: row.triggerConfig ?? {},
          steps: row.steps as unknown[],
          createdBy: row.createdBy,
          createdAt: row.createdAt.toISOString(),
        };
      }

      commands.register(
        defineCommand({
          name: "core.workflow.create",
          description: "Create or upsert a persisted workflow definition",
          permissions: ["core.workflow.manage"],
          tags: ["core"],
          input: workflowInputSchema,
          output: workflowOutputSchema,
          handler: async (input: WorkflowInput, ctx, helpers) => {
            const tx = (helpers.db ?? db) as Db;
            const workflowId = input.id ?? crypto.randomUUID();
            if (input.id) {
              await getWorkflowRow(ctx.actor.organizationId, input.id);
            }
            const [row] = await tx
              .insert(schema.workflowDefinitions)
              .values({
                id: workflowId,
                organizationId: ctx.actor.organizationId,
                name: input.name,
                description: input.description,
                trigger: input.trigger,
                triggerConfig: input.triggerConfig ?? {},
                steps: input.steps as unknown[],
                createdBy: input.createdBy,
              })
              .onConflictDoUpdate({
                target: [schema.workflowDefinitions.id],
                set: {
                  name: input.name,
                  description: input.description,
                  trigger: input.trigger,
                  triggerConfig: input.triggerConfig ?? {},
                  steps: input.steps as unknown[],
                  updatedAt: new Date(),
                },
              })
              .returning();
            await helpers.outbox.enqueue({
              id: crypto.randomUUID(),
              type: "core.workflow.created",
              organizationId: ctx.actor.organizationId,
              occurredAt: ctx.now().toISOString(),
              payload: { workflowId: row!.id, name: row!.name },
              correlationId: ctx.requestId,
            });
            return mapWorkflow(row!);
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "core.audit.list",
          description: "List the org's audit trail (permissioned — F16)",
          permissions: ["core.rbac.read"],
          tags: ["core"],
          input: z
            .object({
              limit: z.number().int().min(1).max(500).default(100),
              action: z.string().optional(),
              success: z.boolean().optional(),
            })
            .default({}),
          output: z.object({
            items: z.array(
              z.object({
                id: z.string(),
                at: z.string(),
                action: z.string(),
                actorKind: z.string(),
                actorUserId: z.string(),
                success: z.boolean(),
                errorCode: z.string().nullable(),
                errorMessage: z.string().nullable(),
              }),
            ),
          }),
          handler: async (input, ctx) => {
            const where = and(
              eq(schema.auditLog.organizationId, ctx.actor.organizationId),
              input.action ? eq(schema.auditLog.action, input.action) : undefined,
              input.success !== undefined
                ? eq(schema.auditLog.success, input.success)
                : undefined,
            );
            const rows = await db
              .select()
              .from(schema.auditLog)
              .where(where)
              .orderBy(desc(schema.auditLog.at))
              .limit(input.limit);
            return {
              items: rows.map((e) => ({
                id: e.id,
                at: e.at.toISOString(),
                action: e.action,
                actorKind: e.actorKind,
                actorUserId: e.actorUserId,
                success: e.success,
                errorCode: e.errorCode,
                errorMessage: e.errorMessage,
              })),
            };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "core.workflow.list",
          description: "List persisted workflows for the organization",
          permissions: ["core.workflow.read"],
          tags: ["core"],
          input: z.object({}).default({}),
          output: z.object({ items: z.array(workflowOutputSchema) }),
          handler: async (_i, ctx) => {
            const rows = await db
              .select()
              .from(schema.workflowDefinitions)
              .where(eq(schema.workflowDefinitions.organizationId, ctx.actor.organizationId))
              .orderBy(desc(schema.workflowDefinitions.createdAt));
            return { items: rows.map(mapWorkflow) };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "core.workflow.get",
          description: "Get a single persisted workflow by id",
          permissions: ["core.workflow.read"],
          tags: ["core"],
          input: z.object({ workflowId: z.string() }),
          output: workflowOutputSchema,
          handler: async (input, ctx) => {
            return mapWorkflow(await getWorkflowRow(ctx.actor.organizationId, input.workflowId));
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.workflow.delete",
          description: "Delete a persisted workflow definition",
          permissions: ["core.workflow.manage"],
          tags: ["core"],
          input: z.object({ workflowId: z.string() }),
          output: z.object({ ok: z.literal(true) }),
          handler: async (input, ctx) => {
            await getWorkflowRow(ctx.actor.organizationId, input.workflowId);
            await db
              .delete(schema.workflowDefinitions)
              .where(eq(schema.workflowDefinitions.id, input.workflowId));
            return { ok: true as const };
          },
        }),
      );

      // ─── Verifiable analytics reads (research doc §Analytics Acceptance
      // Criteria — no invented numbers: every figure is an aggregation of
      // ledger/invoice rows the caller can drill into) ──────────────────────

      const monthLabel = (iso: string) => iso.slice(0, 7);

      queries.register(
        defineQuery({
          name: "core.analytics.salesSummary",
          description: "Invoice totals grouped by month (verifiable from acc_invoices)",
          permissions: ["core.analytics.read"],
          tags: ["core", "analytics"],
          input: z.object({ months: z.number().int().min(1).max(60).optional() }).default({}),
          output: z.object({
            currency: z.string(),
            monthly: z.array(
              z.object({ month: z.string(), total: z.number(), invoiceCount: z.number() }),
            ),
          }),
          handler: async (input, ctx) => {
            const months = input.months ?? 12;
            const since = new Date();
            since.setUTCDate(1);
            since.setUTCMonth(since.getUTCMonth() - (months - 1));
            // postgres.js needs an ISO string, not a Date, inside raw sql templates.
            const sinceIso = since.toISOString();
            const rows = await db
              .select({
                month: sql<string>`to_char(${schema.accInvoices.issuedAt}, 'YYYY-MM')`,
                total: sql<number>`coalesce(sum(${schema.accInvoices.total}),0)::float8`,
                invoiceCount: sql<number>`count(*)::int`,
              })
              .from(schema.accInvoices)
              .where(
                and(
                  eq(schema.accInvoices.organizationId, ctx.actor.organizationId),
                  sql`${schema.accInvoices.issuedAt} >= ${sinceIso}`,
                  sql`${schema.accInvoices.status} <> 'draft'`,
                ),
              )
              .groupBy(sql`1`)
              .orderBy(sql`1`);
            return {
              currency: "UGX",
              monthly: rows.map((r) => ({
                month: monthLabel(r.month),
                total: Number(r.total),
                invoiceCount: r.invoiceCount,
              })),
            };
          },
        }),
      );


      queries.register(
        defineQuery({
          name: "core.analytics.marginTrend",
          description:
            "Monthly revenue, expenses, and margin from posted journal entries (verifiable from acc_journal_lines)",
          permissions: ["core.analytics.read"],
          tags: ["core", "analytics"],
          input: z.object({ months: z.number().int().min(1).max(60).optional() }).default({}),
          output: z.object({
            currency: z.string(),
            monthly: z.array(
              z.object({
                month: z.string(),
                revenue: z.number(),
                expenses: z.number(),
                margin: z.number(),
              }),
            ),
          }),
          handler: async (input, ctx) => {
            const months = input.months ?? 6;
            const since = new Date();
            since.setUTCDate(1);
            since.setUTCMonth(since.getUTCMonth() - (months - 1));
            const sinceIso = since.toISOString();
            const rows = await db
              .select({
                month: sql<string>`to_char(${schema.accJournalEntries.entryDate}, 'YYYY-MM')`,
                type: schema.accAccounts.type,
                // Revenue accounts carry credits, expense accounts carry debits;
                // the sign must be consistent (both positive) so margin =
                // revenue − expenses is computed correctly below.
                amount: sql<number>`coalesce(sum(case when ${schema.accAccounts.type} = 'expense' then ${schema.accJournalLines.debit} else ${schema.accJournalLines.credit} end),0)::float8`,
              })
              .from(schema.accJournalLines)
              .innerJoin(
                schema.accJournalEntries,
                eq(schema.accJournalEntries.id, schema.accJournalLines.entryId),
              )
              .innerJoin(
                schema.accAccounts,
                eq(schema.accAccounts.id, schema.accJournalLines.accountId),
              )
              .where(
                and(
                  eq(schema.accJournalEntries.organizationId, ctx.actor.organizationId),
                  eq(schema.accJournalEntries.status, "posted"),
                  sql`${schema.accJournalEntries.entryDate} >= ${sinceIso}`,
                ),
              )
              .groupBy(sql`1`, schema.accAccounts.type)
              .orderBy(sql`1`);
            const byMonth = new Map<string, { revenue: number; expenses: number }>();
            for (const r of rows) {
              const m = monthLabel(r.month);
              const cur = byMonth.get(m) ?? { revenue: 0, expenses: 0 };
              if (r.type === "revenue") cur.revenue += Number(r.amount);
              if (r.type === "expense") cur.expenses += Number(r.amount);
              byMonth.set(m, cur);
            }
            return {
              currency: "UGX",
              monthly: [...byMonth.entries()]
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([month, v]) => ({
                  month,
                  revenue: v.revenue,
                  expenses: v.expenses,
                  margin: v.revenue - v.expenses,
                })),
            };
          },
        }),
      );


      queries.register(
        defineQuery({
          name: "core.analytics.salesByLocation",
          description: "Invoice totals grouped by the customer's city (customer location, not branch)",
          permissions: ["core.analytics.read"],
          tags: ["core", "analytics"],
          input: z.object({}).default({}),
          output: z.object({
            currency: z.string(),
            byLocation: z.array(
              z.object({ location: z.string().nullable(), total: z.number(), invoiceCount: z.number() }),
            ),
          }),
          handler: async (_i, ctx) => {
            const rows = await db
              .select({
                location: schema.businessPartners.city,
                total: sql<number>`coalesce(sum(${schema.accInvoices.total}),0)::float8`,
                invoiceCount: sql<number>`count(*)::int`,
              })
              .from(schema.accInvoices)
              .leftJoin(
                schema.businessPartners,
                eq(schema.businessPartners.id, schema.accInvoices.customerId),
              )
              .where(
                and(
                  eq(schema.accInvoices.organizationId, ctx.actor.organizationId),
                  sql`${schema.accInvoices.status} <> 'draft'`,
                ),
              )
              .groupBy(schema.businessPartners.city)
              .orderBy(sql`2 desc`);
            return {
              currency: "UGX",
              byLocation: rows.map((r) => ({
                location: r.location,
                total: Number(r.total),
                invoiceCount: r.invoiceCount,
              })),
            };
          },
        }),
      );


      queries.register(
        defineQuery({
          name: "core.replenishment.propose",
          description: "Stock below reorder level with suggested order quantities (verifiable from inv_stock_levels)",
          permissions: ["core.replenishment.read"],
          tags: ["core", "inventory"],
          input: z.object({}).default({}),
          output: z.object({
            items: z.array(
              z.object({
                sku: z.string(),
                name: z.string(),
                warehouse: z.string(),
                quantity: z.number(),
                reorderLevel: z.number(),
                suggestedQty: z.number(),
              }),
            ),
            summary: z.string(),
          }),
          handler: async (_i, ctx) => {
            const rows = await db
              .select({
                sku: schema.invProducts.sku,
                name: schema.invProducts.name,
                warehouse: schema.invWarehouses.code,
                quantity: schema.invStockLevels.quantity,
                reorderLevel: schema.invProducts.reorderLevel,
              })
              .from(schema.invStockLevels)
              .innerJoin(
                schema.invProducts,
                eq(schema.invProducts.id, schema.invStockLevels.productId),
              )
              .innerJoin(
                schema.invWarehouses,
                eq(schema.invWarehouses.id, schema.invStockLevels.warehouseId),
              )
              .where(
                and(
                  eq(schema.invStockLevels.organizationId, ctx.actor.organizationId),
                  sql`${schema.invStockLevels.quantity} < ${schema.invProducts.reorderLevel}`,
                ),
              )
              .orderBy(schema.invWarehouses.code, schema.invProducts.sku);
            const items = rows.map((r) => ({
              sku: r.sku,
              name: r.name,
              warehouse: r.warehouse,
              quantity: r.quantity,
              reorderLevel: r.reorderLevel,
              suggestedQty: Math.max(r.reorderLevel - r.quantity, 1),
            }));
            return {
              items,
              summary: `${items.length} item(s) below reorder level. Suggested qty brings stock back to the reorder level; pick a supplier to create the purchase order.`,
            };
          },
        }),
      );


      // ─── Data-quality / import transform rules (research doc §Onboarding) ──

      const importRuleScopeSchema = z.enum(["customer", "supplier", "product", "employee"]);
      const importRuleTypeSchema = z.enum(["blank_as_unknown", "split_field", "dedupe_column"]);
      const importRuleOutputSchema = z.object({
        id: z.string(),
        organizationId: z.string(),
        scope: importRuleScopeSchema,
        ruleType: importRuleTypeSchema,
        field: z.string(),
        config: z.record(z.unknown()),
        description: z.string().nullable(),
        enabled: z.boolean(),
        createdByUserId: z.string(),
        createdAt: z.string(),
        updatedAt: z.string(),
      });

      function mapImportRule(row: typeof schema.importRules.$inferSelect) {
        return {
          id: row.id,
          organizationId: row.organizationId,
          scope: row.scope as "customer" | "supplier" | "product" | "employee",
          ruleType: row.ruleType as "blank_as_unknown" | "split_field" | "dedupe_column",
          field: row.field,
          config: row.config,
          description: row.description,
          enabled: row.enabled,
          createdByUserId: row.createdByUserId,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        };
      }

      commands.register(
        defineCommand({
          name: "core.importRule.create",
          description: "Record a deterministic data-quality/import transform rule",
          permissions: ["core.importRule.manage"],
          tags: ["core", "onboarding"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            scope: importRuleScopeSchema,
            ruleType: importRuleTypeSchema,
            field: z.string().min(1).max(120),
            config: z.record(z.unknown()).default({}),
            description: z.string().max(500).optional(),
          }),
          output: importRuleOutputSchema,
          handler: async (input, ctx) => {
            const [row] = await db
              .insert(schema.importRules)
              .values({
                organizationId: ctx.actor.organizationId,
                scope: input.scope,
                ruleType: input.ruleType,
                field: input.field.toLowerCase().trim(),
                config: input.config,
                description: input.description ?? null,
                createdByUserId: ctx.actor.userId,
              })
              .returning();
            return mapImportRule(row!);
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "core.importRule.list",
          description: "List this org's data-quality/import transform rules",
          permissions: ["core.importRule.read"],
          tags: ["core", "onboarding"],
          input: z.object({ scope: importRuleScopeSchema.optional() }).default({}),
          output: z.object({ rules: z.array(importRuleOutputSchema) }),
          handler: async (input, ctx) => {
            const where =
              input.scope != null
                ? and(
                    eq(schema.importRules.organizationId, ctx.actor.organizationId),
                    eq(schema.importRules.scope, input.scope),
                  )
                : eq(schema.importRules.organizationId, ctx.actor.organizationId);
            const rows = await db
              .select()
              .from(schema.importRules)
              .where(where)
              .orderBy(desc(schema.importRules.createdAt));
            return { rules: rows.map(mapImportRule) };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.importRule.delete",
          description: "Delete a data-quality/import transform rule",
          permissions: ["core.importRule.manage"],
          tags: ["core", "onboarding"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({ ruleId: z.string().uuid() }),
          output: z.object({ ok: z.literal(true), ruleId: z.string() }),
          handler: async (input, ctx) => {
            const removed = await db
              .delete(schema.importRules)
              .where(
                and(
                  eq(schema.importRules.id, input.ruleId),
                  eq(schema.importRules.organizationId, ctx.actor.organizationId),
                ),
              )
              .returning({ id: schema.importRules.id });
            if (removed.length === 0) throw new NotFoundError("Import rule");
            return { ok: true as const, ruleId: input.ruleId };
          },
        }),
      );


      // ─── Saved dashboards / reports (deictic "turn this into a dashboard") ─

      const dashboardOutputSchema = z.object({
        id: z.string(),
        organizationId: z.string(),
        name: z.string(),
        description: z.string().nullable(),
        widgets: z.array(z.record(z.unknown())),
        createdByUserId: z.string(),
        createdAt: z.string(),
        updatedAt: z.string(),
      });

      commands.register(
        defineCommand({
          name: "core.dashboard.create",
          description: "Save a dashboard/report from a list of catalog queries",
          permissions: ["core.dashboard.manage"],
          tags: ["core", "analytics"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            name: z.string().min(1).max(160),
            description: z.string().max(500).optional(),
            widgets: z
              .array(
                z.object({
                  query: z.string().min(1),
                  title: z.string().min(1),
                  config: z.record(z.unknown()).optional(),
                }),
              )
              .min(1),
          }),
          output: dashboardOutputSchema,
          handler: async (input, ctx) => {
            const [row] = await db
              .insert(schema.dashboards)
              .values({
                organizationId: ctx.actor.organizationId,
                name: input.name,
                description: input.description ?? null,
                widgetSpec: input.widgets,
                createdByUserId: ctx.actor.userId,
              })
              .returning();
            return {
              id: row!.id,
              organizationId: row!.organizationId,
              name: row!.name,
              description: row!.description,
              widgets: row!.widgetSpec as Record<string, unknown>[],
              createdByUserId: row!.createdByUserId,
              createdAt: row!.createdAt.toISOString(),
              updatedAt: row!.updatedAt.toISOString(),
            };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "core.dashboard.list",
          description: "List saved dashboards/reports",
          permissions: ["core.dashboard.read"],
          tags: ["core", "analytics"],
          input: z.object({}).default({}),
          output: z.object({ dashboards: z.array(dashboardOutputSchema) }),
          handler: async (_i, ctx) => {
            const rows = await db
              .select()
              .from(schema.dashboards)
              .where(eq(schema.dashboards.organizationId, ctx.actor.organizationId))
              .orderBy(desc(schema.dashboards.createdAt));
            return {
              dashboards: rows.map((r) => ({
                id: r.id,
                organizationId: r.organizationId,
                name: r.name,
                description: r.description,
                widgets: r.widgetSpec as Record<string, unknown>[],
                createdByUserId: r.createdByUserId,
                createdAt: r.createdAt.toISOString(),
                updatedAt: r.updatedAt.toISOString(),
              })),
            };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.dashboard.delete",
          description: "Delete a saved dashboard/report",
          permissions: ["core.dashboard.manage"],
          tags: ["core", "analytics"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({ dashboardId: z.string().uuid() }),
          output: z.object({ ok: z.literal(true), dashboardId: z.string() }),
          handler: async (input, ctx) => {
            const removed = await db
              .delete(schema.dashboards)
              .where(
                and(
                  eq(schema.dashboards.id, input.dashboardId),
                  eq(schema.dashboards.organizationId, ctx.actor.organizationId),
                ),
              )
              .returning({ id: schema.dashboards.id });
            if (removed.length === 0) throw new NotFoundError("Dashboard");
            return { ok: true as const, dashboardId: input.dashboardId };
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
    /**
     * Fire due reminders into in-app notifications. The UPDATE … RETURNING claim
     * is atomic (concurrent workers can't double-fire), but delivery is isolated
     * per row: a single notification failure is recorded on THAT reminder
     * (status → "failed", spec §2.2) and the rest of the batch still delivers —
     * a failure never silently drops the whole batch's notifications.
     */
    async processDueReminders(): Promise<number> {
      const rows = await this.claimDueReminders();
      let delivered = 0;
      for (const r of rows) {
        delivered += (await this.deliverReminder(r)) ? 1 : 0;
      }
      return delivered;
    },

    /** Claim ALL currently-due reminders (poll-mode batch claim). */
    async claimDueReminders(): Promise<(typeof schema.reminders.$inferSelect)[]> {
      const now = new Date();
      return db
        .update(schema.reminders)
        .set({ status: "fired", firedAt: now })
        .where(and(eq(schema.reminders.status, "scheduled"), lte(schema.reminders.fireAt, now)))
        .returning();
    },

    /** Non-claiming scan of due reminders — BullMQ enqueue pass. */
    async listDueReminders(now = new Date()): Promise<(typeof schema.reminders.$inferSelect)[]> {
      return db
        .select()
        .from(schema.reminders)
        .where(and(eq(schema.reminders.status, "scheduled"), lte(schema.reminders.fireAt, now)));
    },

    /** Atomic per-id claim used by the BullMQ job handler (single-fire). */
    async claimReminderById(id: string) {
      const [row] = await db
        .update(schema.reminders)
        .set({ status: "fired", firedAt: new Date() })
        .where(and(eq(schema.reminders.id, id), eq(schema.reminders.status, "scheduled")))
        .returning();
      return row ?? null;
    },

    /** Deliver one claimed reminder's in-app notification. Returns true on success. */
    async deliverReminder(r: typeof schema.reminders.$inferSelect): Promise<boolean> {
      try {
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
        // F24 — `channel: email|both` must actually leave the platform: enqueue
        // an outbound email row (the worker's email processor sends it). A
        // reminder that only ever existed as a stored flag was a false promise.
        if (r.channel === "email" || r.channel === "both") {
          const [user] = await db
            .select({ email: schema.users.email })
            .from(schema.users)
            .where(eq(schema.users.id, r.userId))
            .limit(1);
          if (user?.email) {
            await db.insert(schema.emailOutbox).values({
              organizationId: r.organizationId,
              to: user.email,
              subject: `Reminder: ${r.title}`,
              body: [r.body ?? r.title, r.href ?? ""].filter(Boolean).join("\n\n"),
            });
          }
        }
        return true;
      } catch (err) {
        // Record the failure on this reminder instead of aborting the batch.
        await db
          .update(schema.reminders)
          .set({ status: "failed" })
          .where(eq(schema.reminders.id, r.id));
        console.error(
          JSON.stringify({
            service: "chaste-worker",
            action: "reminder_failed",
            reminderId: r.id,
            userId: r.userId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        return false;
      }
    },

    async claimDueFollowUps(): Promise<(typeof schema.followUps.$inferSelect)[]> {
      const now = new Date();
      return db
        .update(schema.followUps)
        .set({ status: "running" })
        .where(and(eq(schema.followUps.status, "scheduled"), lte(schema.followUps.fireAt, now)))
        .returning();
    },

    /** Non-claiming scan of due follow-ups — BullMQ enqueue pass. */
    async listDueFollowUps(now = new Date()): Promise<(typeof schema.followUps.$inferSelect)[]> {
      return db
        .select()
        .from(schema.followUps)
        .where(and(eq(schema.followUps.status, "scheduled"), lte(schema.followUps.fireAt, now)));
    },

    /** Atomic per-id claim used by the BullMQ job handler (single-fire). */
    async claimFollowUpById(id: string) {
      const [row] = await db
        .update(schema.followUps)
        .set({ status: "running" })
        .where(and(eq(schema.followUps.id, id), eq(schema.followUps.status, "scheduled")))
        .returning();
      return row ?? null;


    },
  };
}

/**
 * C6 — email delivery processor. Claims queued rows atomically, sends through
 * the adapter, and records provider ids / failures. Run on the worker cadence.
 */
export function createEmailProcessor(db: Db, adapter: EmailAdapter = createEmailAdapter()) {
  return {
    adapterId: adapter.id,
    /**
     * Flush queued emails through the adapter with crash recovery. Emails left
     * in `sending` longer than `leaseMs` (e.g. a worker crash mid-batch) are
     * reclaimed back to `queued` before the next claim, so they are retried
     * instead of failing silently. No schema column is added: `createdAt` is a
     * safe lease proxy because claim→send happens within a single tick, and the
     * default lease (10 min) is far longer than any single flush.
     */
    async flushEmailOutbox(batch = 25, leaseMs = 10 * 60_000): Promise<number> {
      if (leaseMs > 0) {
        const cutoff = new Date(Date.now() - leaseMs);
        await db
          .update(schema.emailOutbox)
          .set({ status: "queued", provider: null, error: null })
          .where(
            and(eq(schema.emailOutbox.status, "sending"), lt(schema.emailOutbox.createdAt, cutoff)),
          );
      }
      const queued = await db
        .select()
        .from(schema.emailOutbox)
        .where(eq(schema.emailOutbox.status, "queued"))
        .limit(batch);
      if (queued.length === 0) return 0;
      await db
        .update(schema.emailOutbox)
        .set({ status: "sending" })
        .where(
          inArray(
            schema.emailOutbox.id,
            queued.map((r) => r.id),
          ),
        );
      let sent = 0;
      for (const row of queued) {
        try {
          const { messageId } = await adapter.send({
            to: row.to,
            subject: row.subject,
            body: row.body,
          });
          await db
            .update(schema.emailOutbox)
            .set({
              status: "sent",
              provider: adapter.id,
              providerMessageId: messageId,
              sentAt: new Date(),
            })
            .where(eq(schema.emailOutbox.id, row.id));
          sent += 1;
        } catch (err) {
          await db
            .update(schema.emailOutbox)
            .set({
              status: "failed",
              provider: adapter.id,
              error: err instanceof Error ? err.message : String(err),
            })
            .where(eq(schema.emailOutbox.id, row.id));
        }
      }
      return sent;
    },
  };
}

/* ─── Backup / export / restore (Workstream C) ─────────────────────── */

export {
  applyManifest,
  backupManifestSchema,
  buildManifest,
  createBackupProcessor,
  createLocalStore,
  createMemoryStore,
  createNullStore,
  createObjectStore,
  createS3Store,
  decryptBackup,
  encryptBackup,
  encryptedBlobSchema,
  fetchAndDecrypt,
  getBackupKey,
  manifestChecksum,
  objectStoreStatus,
  restoreFromStore,
  runBackupJob,
  snapshotOrganization,
} from "./backup.js";
export type { BackupManifest, EncryptedBlob, ObjectStore } from "./backup.js";
