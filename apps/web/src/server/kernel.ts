import { and, desc, eq, sql } from "drizzle-orm";
import {
  GENESIS,
  KernelExecutor,
  OrgPolicyEngine,
  CapabilityRegistry,
  computeEntryHash,
  type ActionContext,
  type ApprovalFlow,
  type ApprovalRequest,
  type LedgerStore,
  type NewLedgerEntry,
  type OrgPolicyRule,
} from "@chaste/kernel";
import {
  approvals,
  ledgerEvents,
  memberships,
  policies,
  rolePermissions,
  users,
  userRoles,
  type Database,
} from "@chaste/db";
import { registerAccountingCapabilities } from "@chaste/module-accounting";
import { registerCrmCapabilities } from "@chaste/module-crm";
import { registerMessagingCapabilities } from "@chaste/module-messaging";
import { registerPurchasingCapabilities } from "@chaste/module-purchasing";
import { registerPosCapabilities } from "@chaste/module-pos";
import { registerIamCapabilities } from "@chaste/module-iam";
import { registerInventoryCapabilities } from "@chaste/module-inventory";
import { registerCreatorCapabilities } from "@chaste/module-creator";
import { registerDocumentCapabilities } from "@chaste/module-documents";
import { registerHrCapabilities } from "@chaste/module-hr";

export function buildRegistry(db: Database["db"]): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registerCrmCapabilities(registry, { db });
  registerAccountingCapabilities(registry, { db });
  registerMessagingCapabilities(registry, { db });
  registerPurchasingCapabilities(registry, { db });
  registerPosCapabilities(registry, { db });
  registerIamCapabilities(registry, { db });
  registerInventoryCapabilities(registry, { db });
  registerCreatorCapabilities(registry, { db });
  registerDocumentCapabilities(registry, { db });
  registerHrCapabilities(registry, { db });

  // Boot-time ecosystem check: broken inverses are fatal, missing inverses
  // are surfaced debt. Never discover these at runtime.
  const issues = registry.validateAll();
  for (const issue of issues) {
    const tag = issue.level === "error" ? "[conformance-error]" : "[conformance-warning]";
    console.warn(`${tag} ${issue.capabilityId}: ${issue.rule} — ${issue.message}`);
  }
  if (issues.some((i) => i.level === "error")) {
    throw new Error("capability registry failed conformance; refusing to boot");
  }
  return registry;
}

/** Append-only Postgres-backed event ledger (single global hash chain). */
export class PgLedgerStore implements LedgerStore {
  constructor(private readonly db: Database["db"]) {}

  async lastHash(): Promise<string | null> {
    const rows = await this.db
      .select({ hash: ledgerEvents.hash })
      .from(ledgerEvents)
      .orderBy(desc(ledgerEvents.seq))
      .limit(1);
    return rows[0]?.hash ?? GENESIS;
  }

  async append(entry: NewLedgerEntry): Promise<number> {
    const prevHash = entry.prevHash ?? (await this.lastHash()) ?? GENESIS;
    const { prevHash: _ignored, ...rest } = entry;
    const hash = computeEntryHash(rest, prevHash);
    const [row] = await this.db
      .insert(ledgerEvents)
      .values({ ...rest, prevHash, hash })
      .returning({ seq: ledgerEvents.seq });
    return Number(row?.seq ?? 0);
  }
}

export interface NotificationSink {
  approvalRequested(req: ApprovalRequest, orgId: string): Promise<void>;
  ticketFiled(title: string, orgId: string): Promise<void>;
}

/**
 * Console always logs; if NOTIFICATION_WEBHOOK_URL is set, approvals and
 * tickets are POSTed as JSON (Slack/Discord/Zapier-compatible seam).
 * Email plugs in here later behind the same interface.
 */
export const consoleNotifications: NotificationSink = {
  async approvalRequested(req) {
    console.info(`[approval-requested] ${req.capabilityId}: ${req.rationale}`);
    await postWebhook({ event: "approval.requested", capabilityId: req.capabilityId, risk: req.riskClass, rationale: req.rationale });
  },
  async ticketFiled(title) {
    console.info(`[ticket] ${title}`);
    await postWebhook({ event: "ticket.filed", title });
  },
};

async function postWebhook(payload: Record<string, unknown>): Promise<void> {
  const url = process.env.NOTIFICATION_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, at: new Date().toISOString() }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.warn("[webhook] delivery failed:", err instanceof Error ? err.message : err);
  }
}

export class DbApprovalFlow implements ApprovalFlow {
  constructor(
    private readonly db: Database["db"],
    private readonly notifications: NotificationSink = consoleNotifications,
  ) {}

  async submit(request: ApprovalRequest, ctx: ActionContext): Promise<boolean> {
    await this.db.insert(approvals).values({
      orgId: ctx.actor.orgId,
      sessionId: ctx.sessionId ?? null,
      requestedByUserId: ctx.actor.type === "human" ? ctx.actor.id : null,
      capabilityId: request.capabilityId,
      riskClass: request.riskClass,
      payload: request.payload as object,
      rationale: request.rationale,
      status: "pending",
    });
    await this.notifications.approvalRequested(request, ctx.actor.orgId);
    return false;
  }
}

export function buildPolicyEngine(db: Database["db"]): OrgPolicyEngine {
  return new OrgPolicyEngine(async (orgId): Promise<OrgPolicyRule[]> => {
    const rows = await db.select().from(policies).where(eq(policies.orgId, orgId));
    return rows.map((r) => ({
      capabilityPattern: r.capabilityPattern,
      maxRiskAutonomous: r.maxRiskAutonomous as OrgPolicyRule["maxRiskAutonomous"],
      moneyThresholdMinor: r.moneyThresholdMinor ?? undefined,
    }));
  });
}

export function buildExecutor(db: Database["db"], registry: CapabilityRegistry): KernelExecutor {
  return new KernelExecutor({
    registry,
    policy: buildPolicyEngine(db),
    approvals: new DbApprovalFlow(db),
    ledger: new PgLedgerStore(db),
  });
}

// ── actor resolution ────────────────────────────────────────────────────

export { hasPermission as hasPermissionFor } from "@chaste/kernel";

export interface ResolvedUser {
  userId: string;
  email: string;
  name: string | null;
  orgId: string | null;
  permissions: Set<string>;
}

/**
 * Mirrors the auth identity into the domain users table so RBAC lives in
 * one place. Auth providers may change; the domain user is stable.
 */
export async function resolveActorFromAuth(
  authEmail: string,
  authName: string | null,
  db: Database["db"],
): Promise<ResolvedUser> {
  let [domainUser] = await db.select().from(users).where(eq(users.email, authEmail)).limit(1);
  if (!domainUser) {
    [domainUser] = await db.insert(users).values({ email: authEmail, name: authName }).returning();
  }
  if (!domainUser) throw new Error("failed to ensure domain user");

  const [membership] = await db
    .select()
    .from(memberships)
    .where(eq(memberships.userId, domainUser.id))
    .limit(1);

  let permissions = new Set<string>();
  if (membership) {
    const perms = await db
      .select({ key: rolePermissions.permissionKey })
      .from(userRoles)
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoles.roleId))
      .where(and(eq(userRoles.userId, domainUser.id), eq(userRoles.orgId, membership.orgId)));
    permissions = new Set(perms.map((p) => p.key));
  }

  return { userId: domainUser.id, email: authEmail, name: authName, orgId: membership?.orgId ?? null, permissions };
}

/** Permissions for one user in one org (multi-membership support). */
export async function resolveForOrg(
  userId: string,
  orgId: string,
  db: Database["db"],
): Promise<ResolvedUser> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new Error("user not found");
  const perms = await db
    .select({ key: rolePermissions.permissionKey })
    .from(userRoles)
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoles.roleId))
    .where(and(eq(userRoles.userId, userId), eq(userRoles.orgId, orgId)));
  return { userId, email: user.email, name: user.name, orgId, permissions: new Set(perms.map((p) => p.key)) };
}

export function actorFromResolved(resolved: ResolvedUser, opts: { asAgent?: boolean; sessionId?: string } = {}): ActionContext | null {
  if (!resolved.orgId) return null;
  return {
    actor: {
      type: opts.asAgent ? "agent" : "human",
      id: resolved.userId,
      orgId: resolved.orgId,
      permissions: resolved.permissions,
    },
    sessionId: opts.sessionId,
    now: new Date(),
    services: {},
  };
}

/** Pending approvals with human-readable rendering data. */
export async function listPendingApprovals(orgId: string, db: Database["db"]) {
  return db
    .select()
    .from(approvals)
    .where(and(eq(approvals.orgId, orgId), eq(approvals.status, "pending")))
    .orderBy(desc(approvals.createdAt))
    .limit(50);
}

export async function recentLedgerEvents(orgId: string, db: Database["db"], limit = 60) {
  return db
    .select({
      seq: sql<number>`${ledgerEvents.seq}`,
      kind: ledgerEvents.kind,
      capabilityId: ledgerEvents.capabilityId,
      actorType: ledgerEvents.actorType,
      payload: ledgerEvents.payload,
      hash: ledgerEvents.hash,
      prevHash: ledgerEvents.prevHash,
      occurredAt: ledgerEvents.occurredAt,
    })
    .from(ledgerEvents)
    .where(eq(ledgerEvents.orgId, orgId))
    .orderBy(desc(ledgerEvents.seq))
    .limit(limit);
}
