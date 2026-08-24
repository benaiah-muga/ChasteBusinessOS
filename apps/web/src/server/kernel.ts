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
  notifications as notificationsTable,
  organizations,
  policies,
  rolePermissions,
  users,
  userRoles,
  type Database,
} from "@chaste/db";
import { getDb } from "@chaste/db";
import { registerAccountingCapabilities } from "@chaste/module-accounting";
import { registerAnalyticsCapabilities } from "@chaste/module-analytics";
import { registerCrmCapabilities } from "@chaste/module-crm";
import { registerMessagingCapabilities } from "@chaste/module-messaging";
import { registerPurchasingCapabilities } from "@chaste/module-purchasing";
import { registerPosCapabilities } from "@chaste/module-pos";
import { registerIamCapabilities } from "@chaste/module-iam";
import { registerInventoryCapabilities } from "@chaste/module-inventory";
import { registerManufacturingCapabilities } from "@chaste/module-manufacturing";
import { registerCreatorCapabilities } from "@chaste/module-creator";
import { registerDocumentCapabilities } from "@chaste/module-documents";
import { registerHrCapabilities } from "@chaste/module-hr";
import { registerSupportCapabilities } from "@chaste/module-support";

const registryCache = globalThis as unknown as {
  __chasteRegistry?: { version: string; registry: CapabilityRegistry };
};

/**
 * Registries are static after boot: capabilities close over the process-wide
 * db pool (see getDb), so one instance per process is correct. Rebuilding per
 * request re-ran full conformance validation every call. Bump REGISTRY_VERSION
 * (or restart dev) when changing capability definitions.
 */
export function buildRegistry(db: Database["db"]): CapabilityRegistry {
  const version = process.env.REGISTRY_VERSION ?? "1";
  if (registryCache.__chasteRegistry?.version === version) {
    return registryCache.__chasteRegistry.registry;
  }

  const registry = new CapabilityRegistry();
  registerCrmCapabilities(registry, { db });
  registerAccountingCapabilities(registry, { db });
  registerAnalyticsCapabilities(registry, { db });
  registerMessagingCapabilities(registry, { db });
  registerPurchasingCapabilities(registry, { db });
  registerPosCapabilities(registry, { db });
  registerIamCapabilities(registry, { db });
  registerInventoryCapabilities(registry, { db });
  registerManufacturingCapabilities(registry, { db });
  registerCreatorCapabilities(registry, { db });
  registerDocumentCapabilities(registry, { db });
  registerHrCapabilities(registry, { db });
  registerSupportCapabilities(registry, { db });

  // Boot-time ecosystem check: broken inverses are fatal, missing inverses
  // are surfaced debt. Never discover these at runtime.
  const issues = registry.validateAll();
  for (const issue of issues) {
    const tag = issue.level === "error" ? "[conformance-error]" : "[conformance-warning]";
    console.warn(`${tag} ${issue.capabilityId}: ${issue.rule}, ${issue.message}`);
  }
  if (issues.some((i) => i.level === "error")) {
    throw new Error("capability registry failed conformance; refusing to boot");
  }
  registryCache.__chasteRegistry = { version, registry };
  return registry;
}

/**
 * Append-only Postgres event ledger. The hash chain is the tamper-evidence
 * guarantee, so chain-head updates are serialized by a transaction-scoped
 * advisory lock: without it, two concurrent appends read the same tail and
 * the second insert chains off a stale hash, silently forking the chain.
 */
const LEDGER_CHAIN_LOCK_KEY = 7_214_811;

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
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LEDGER_CHAIN_LOCK_KEY})`);
      const [head] = await tx
        .select({ hash: ledgerEvents.hash })
        .from(ledgerEvents)
        .orderBy(desc(ledgerEvents.seq))
        .limit(1);
      const prevHash = entry.prevHash ?? head?.hash ?? GENESIS;
      const { prevHash: _ignored, ...rest } = entry;
      const hash = computeEntryHash(rest, prevHash);
      const [row] = await tx
        .insert(ledgerEvents)
        .values({ ...rest, prevHash, hash })
        .returning({ seq: ledgerEvents.seq });
      return Number(row?.seq ?? 0);
    });
  }
}

export interface NotificationSink {
  approvalRequested(req: ApprovalRequest, orgId: string): Promise<void>;
  ticketFiled(title: string, orgId: string): Promise<void>;
}

/**
 * Fan-out sink: console always logs; webhook fires when
 * NOTIFICATION_WEBHOOK_URL is set; email sends when SMTP_HOST is set.
 * Each channel fails soft, a broken webhook must never block an approval.
 */
/**
 * Sinks fan out to console, webhook/email subscribers, and the in-app
 * notification feed. Feed writes are fire-and-forget best-effort: a failed
 * insert must never block the governed action that produced the event.
 */
async function recordNotification(
  orgId: string | null,
  kind: string,
  title: string,
  href?: string,
): Promise<void> {
  try {
    if (!orgId) return;
    await getDb().db.insert(notificationsTable).values({
      orgId,
      userId: null,
      kind,
      title: headerSafe(title).slice(0, 200),
      href: href ?? null,
    });
  } catch (err) {
    console.warn("[notifications] feed insert failed:", err instanceof Error ? err.message : err);
  }
}

export const consoleNotifications: NotificationSink = {
  async approvalRequested(req, orgId) {
    console.info(`[approval-requested] ${req.capabilityId}: ${req.rationale}`);
    await postWebhook({ event: "approval.requested", capabilityId: req.capabilityId, risk: req.riskClass, rationale: req.rationale });
    await sendApprovalEmail(req);
    await recordNotification(
      orgId,
      "approval.requested",
      `${req.capabilityId} needs approval — ${req.rationale}`.slice(0, 200),
      "/approvals",
    );
  },
  async ticketFiled(title, orgId) {
    console.info(`[ticket] ${title}`);
    await postWebhook({ event: "ticket.filed", title });
    await sendTicketEmail(title);
    await recordNotification(orgId ?? null, "ticket.filed", title);
  },
};

function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_TO);
}

async function mailer() {
  const nodemailer = (await import("nodemailer")).default;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    auth:
      process.env.SMTP_USER && process.env.SMTP_PASS
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
  });
}

/**
 * CRLF and other control characters in subject or body would allow SMTP
 * header injection when the text originates from model-influenced content
 * (ticket titles, rationales). Flatten to a single line at the mail boundary.
 */
function headerSafe(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 32;
    out += code < 32 || code === 127 ? " " : ch;
  }
  return out.trim();
}

async function sendMail(subject: string, text: string): Promise<void> {
  if (!smtpConfigured()) return;
  try {
    const transport = await mailer();
    await transport.sendMail({
      from: process.env.SMTP_FROM ?? "chaste@localhost",
      to: process.env.SMTP_TO,
      subject: headerSafe(subject),
      text,
    });
  } catch (err) {
    console.warn("[smtp] delivery failed:", err instanceof Error ? err.message : err);
  }
}

async function sendApprovalEmail(req: ApprovalRequest): Promise<void> {
  await sendMail(
    `[Chaste] Approval needed: ${req.capabilityId}`,
    `An action is waiting for human approval.\n\nCapability: ${req.capabilityId}\nRisk class: ${req.riskClass}\nRationale: ${req.rationale}\n\nOpen the Approvals inbox to decide.`,
  );
}

async function sendTicketEmail(title: string): Promise<void> {
  await sendMail(`[Chaste] Ticket filed: ${title}`, `A ticket was filed: ${title}`);
}

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

/** Pending gates older than this expire instead of waiting forever. */
const APPROVAL_TTL_MS = 7 * 86_400_000;

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
      expiresAt: new Date(ctx.now.getTime() + APPROVAL_TTL_MS),
    });
    await this.notifications.approvalRequested(request, ctx.actor.orgId);
    return false;
  }

  /**
   * Kernel-side verification of a claimed approval: same org, same
   * capability, still claimable, not expired, and the payload is
   * byte-equivalent to what was gated. jsonb normalizes key order, so both
   * sides are compared via a canonical (sorted-keys) serialization.
   */
  async verify(approvalId: string, request: ApprovalRequest, ctx: ActionContext): Promise<boolean> {
    const [row] = await this.db
      .select({
        orgId: approvals.orgId,
        capabilityId: approvals.capabilityId,
        status: approvals.status,
        payload: approvals.payload,
        expiresAt: approvals.expiresAt,
      })
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .limit(1);
    if (!row) return false;
    if (row.orgId !== ctx.actor.orgId) return false;
    if (row.capabilityId !== request.capabilityId) return false;
    // Only an unclaimed or in-flight gate authorizes. Anything else
    // (executed, rejected, failed) is consumed history and refuses.
    if (!["pending", "executing"].includes(row.status)) return false;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return false;
    return canonicalJson(row.payload) === canonicalJson(request.payload);
  }
}

/** Deterministic JSON with recursively sorted object keys. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
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


/**
 * Module gate backed by the organization row. One small primary-key lookup
 * per execution keeps correctness over cleverness: toggles apply on the next
 * action with no cache-invalidation story to get wrong.
 */
export function createDbModuleGate(db: Database["db"]) {
  return {
    async isEnabled(orgId: string, moduleId: string): Promise<boolean> {
      if (!orgId) return true;
      const [row] = await db
        .select({ value: organizations.enabledModules })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      // Unknown org or NULL column: every standard module is available.
      if (!row || row.value == null) return true;
      return (row.value as string[]).includes(moduleId);
    },
  };
}

export function buildExecutor(
  db: Database["db"],
  registry: CapabilityRegistry,
  opts: { enabledModules?: string[] | null } = {},
): KernelExecutor {
  return new KernelExecutor({
    registry,
    policy: buildPolicyEngine(db),
    approvals: new DbApprovalFlow(db),
    ledger: new PgLedgerStore(db),
    modules: opts.enabledModules
      ? { isEnabled: (orgId, moduleId) => opts.enabledModules!.includes(moduleId) }
      : createDbModuleGate(db),
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
  /** The active org's enabled module ids; null means all standard modules. */
  enabledModules?: string[] | null;
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

  const enabledModules = membership
    ? ((
        await db
          .select({ value: organizations.enabledModules })
          .from(organizations)
          .where(eq(organizations.id, membership.orgId))
          .limit(1)
      )[0]?.value as string[] | null | undefined) ?? null
    : null;

  return {
    userId: domainUser.id,
    email: authEmail,
    name: authName,
    orgId: membership?.orgId ?? null,
    permissions,
    enabledModules,
  };
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
  const [org] = await db
    .select({ value: organizations.enabledModules })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return {
    userId,
    email: user.email,
    name: user.name,
    orgId,
    permissions: new Set(perms.map((p) => p.key)),
    enabledModules: (org?.value as string[] | null | undefined) ?? null,
  };
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
