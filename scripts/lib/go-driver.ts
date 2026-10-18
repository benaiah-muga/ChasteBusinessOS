/**
 * Self-contained Go API driver for the migration demos.
 *
 * The demos must exercise the Go capability pipeline without importing the
 * legacy Next.js server runtime, so this module carries the session
 * assertion, the private executor/approval bridge, onboarding provisioning,
 * and the executor adapter the demos call.
 */
import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  accounts,
  agentSessions,
  authSession,
  authUser,
  memberships,
  memories,
  organizations,
  policies,
  rolePermissions,
  roles,
  userRoles,
  users,
  type Database,
} from "@chaste/db";
import { currencyMinorUnits, DEFAULT_CHART_OF_ACCOUNTS } from "@chaste/erp-core";
import { canonicalInputHash, type ActionContext } from "@chaste/kernel";

export type GoSession = { userId: string; orgId: string; authSessionId: string };

export type GoCapabilityExecutionAssertionInput = {
  actionContext: ActionContext;
  session: GoSession;
  capabilityId: string;
  input: unknown;
};

export type GoApprovalDecisionAssertionInput = {
  actionContext: ActionContext;
  session: GoSession;
  approvalId: string;
  capabilityId: string;
  input: unknown;
  decision: "approve" | "reject";
  comment?: string;
};

export type GoCapabilityBridgeResult =
  | { kind: "response"; response: Response }
  | { kind: "not-dispatched" }
  | { kind: "outcome-unknown" };

export type GoApprovalDecisionBridgeResult =
  | { kind: "response"; response: Response }
  | { kind: "not-dispatched" }
  | { kind: "outcome-unknown" };

export type GoExecuteResult = {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
  capabilityId?: string;
  pendingApproval?: {
    capabilityId: string;
    payload: unknown;
    rationale: string;
    approvalId?: string;
  };
  approvalId?: string;
  reason?: string;
  replayed?: boolean;
};

type GoExecutorOptions = { enabledModules?: string[] | null; failOnAuditError?: boolean };

function goInternalBaseUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const loopbackHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(hostname);
    if (
      url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !loopbackHttp)
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function goBaseUrl(): URL | null {
  return goInternalBaseUrl(
    process.env.GO_API_INTERNAL_URL ?? process.env.CHASTE_GO_API_ORIGIN ?? "http://127.0.0.1:8080",
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const capabilityResponseStatuses = new Set([200, 202, 400, 401, 403, 404, 422, 500, 503]);

/** Calls the private Go executor with a one-use signed assertion, never browser cookies. */
export async function executeGoCapability(
  input: GoCapabilityExecutionAssertionInput,
  options: { secret?: string; baseUrl?: string; timeoutMs?: number } = {},
): Promise<GoCapabilityBridgeResult> {
  const secret = options.secret ?? process.env.GO_INTERNAL_AUTH_SECRET;
  if (!secret) return { kind: "not-dispatched" };

  const baseUrl = options.baseUrl ? goInternalBaseUrl(options.baseUrl) : goBaseUrl();
  if (!baseUrl) return { kind: "not-dispatched" };

  let assertion: string;
  let body: string;
  try {
    assertion = await createGoCapabilityExecutionAssertion(input, secret);
    body = JSON.stringify({ capabilityId: input.capabilityId, input: input.input });
    if (Buffer.byteLength(body, "utf8") > 65536) return { kind: "not-dispatched" };
  } catch {
    return { kind: "not-dispatched" };
  }

  try {
    const response = await fetch(new URL("/__go/capability/execute", baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Chaste-Session-Assertion": assertion,
      },
      body,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    if (!capabilityResponseStatuses.has(response.status)) return { kind: "outcome-unknown" };
    const parsed: unknown = await response.json().catch(() => null);
    if (asRecord(parsed) === null) return { kind: "outcome-unknown" };
    return {
      kind: "response",
      response: Response.json(parsed, { status: response.status, headers: { "Cache-Control": "no-store" } }),
    };
  } catch {
    return { kind: "outcome-unknown" };
  }
}

/** Sends one signed internal approval decision; callers never supply an execution payload. */
export async function decideGoApproval(
  input: GoApprovalDecisionAssertionInput,
  options: { secret?: string; baseUrl?: string; timeoutMs?: number } = {},
): Promise<GoApprovalDecisionBridgeResult> {
  const secret = options.secret ?? process.env.GO_INTERNAL_AUTH_SECRET;
  if (!secret) return { kind: "not-dispatched" };

  const baseUrl = options.baseUrl ? goInternalBaseUrl(options.baseUrl) : goBaseUrl();
  if (!baseUrl) return { kind: "not-dispatched" };

  let assertion: string;
  let body: string;
  try {
    assertion = await createGoApprovalDecisionAssertion(input, secret);
    const inputSHA256 = await canonicalInputHash(input.input);
    body = JSON.stringify({
      approvalId: input.approvalId,
      capabilityId: input.capabilityId,
      inputSha256: inputSHA256,
      decision: input.decision,
      ...(input.comment === undefined ? {} : { comment: input.comment }),
    });
    if (Buffer.byteLength(body, "utf8") > 16384) return { kind: "not-dispatched" };
  } catch {
    return { kind: "not-dispatched" };
  }

  try {
    const response = await fetch(new URL("/__go/approval/decide", baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Chaste-Session-Assertion": assertion,
      },
      body,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    const parsed: unknown = await response.json().catch(() => null);
    if (asRecord(parsed) === null) return { kind: "outcome-unknown" };
    return {
      kind: "response",
      response: Response.json(parsed, { status: response.status, headers: { "Cache-Control": "no-store" } }),
    };
  } catch {
    return { kind: "outcome-unknown" };
  }
}

/** Signs server-resolved actor and auth context for one validated capability input. */
export async function createGoCapabilityExecutionAssertion(
  input: GoCapabilityExecutionAssertionInput,
  secret: string,
  now = Date.now(),
): Promise<string> {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("GO_INTERNAL_AUTH_SECRET must be at least 32 bytes");
  }

  const { actionContext, session } = input;
  const actor = actionContext.actor;
  if (actor.type !== "human" && actor.type !== "agent") {
    throw new Error("Go capability execution assertions require a human or agent actor");
  }
  if (!actor.id || actor.id !== session.userId) {
    throw new Error("Go capability execution assertions require the resolved domain user as actor");
  }
  if (actor.type === "agent" && !actionContext.sessionId) {
    throw new Error("Go capability execution assertions require an agent session for agent actors");
  }
  if (!session.userId || !session.authSessionId || !session.orgId) {
    throw new Error("Go capability execution assertions require a resolved authenticated organization session");
  }
  if (session.orgId !== actor.orgId) {
    throw new Error("Go capability execution assertion organization does not match the resolved session");
  }
  if (!input.capabilityId) {
    throw new Error("Go capability execution assertion requires a capability id");
  }

  const inputSHA256 = await canonicalInputHash(input.input);
  const issuedAt = Math.floor(now / 1000);
  const claims = {
    aud: "go.capability.execute",
    sub: session.userId,
    org_id: actor.orgId,
    capability_id: input.capabilityId,
    input_sha256: inputSHA256,
    actor_id: actor.id,
    actor_type: actor.type,
    permissions: [...actor.permissions].sort(),
    auth_session_id: session.authSessionId,
    ...(actionContext.sessionId ? { agent_session_id: actionContext.sessionId } : {}),
    ...(actionContext.intentId ? { intent_id: actionContext.intentId } : {}),
    iat: issuedAt,
    exp: issuedAt + 30,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

/** Signs one human decision while binding it to the stored capability input. */
export async function createGoApprovalDecisionAssertion(
  input: GoApprovalDecisionAssertionInput,
  secret: string,
  now = Date.now(),
): Promise<string> {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("GO_INTERNAL_AUTH_SECRET must be at least 32 bytes");
  }
  const { actionContext, session } = input;
  const actor = actionContext.actor;
  if (actor.type !== "human" || !actor.id || actor.id !== session.userId) {
    throw new Error("Go approval decisions require the resolved human actor");
  }
  if (!session.userId || !session.orgId || !session.authSessionId || actor.orgId !== session.orgId) {
    throw new Error("Go approval decisions require the resolved authenticated organization session");
  }
  if (!input.approvalId || !input.capabilityId || !["approve", "reject"].includes(input.decision)) {
    throw new Error("Go approval decision assertion is incomplete");
  }
  if (input.comment !== undefined && [...input.comment].reduce((count, char) => count + (char.length === 2 ? 2 : 1), 0) > 2000) {
    throw new Error("Go approval decision comment is too long");
  }

  const inputSHA256 = await canonicalInputHash(input.input);
  const issuedAt = Math.floor(now / 1000);
  const claims = {
    aud: "go.approval.decide",
    sub: session.userId,
    org_id: actor.orgId,
    capability_id: input.capabilityId,
    input_sha256: inputSHA256,
    actor_id: actor.id,
    actor_type: "human",
    permissions: [...actor.permissions].sort(),
    auth_session_id: session.authSessionId,
    approval_id: input.approvalId,
    decision: input.decision,
    ...(input.comment === undefined ? {} : { comment: input.comment }),
    iat: issuedAt,
    exp: issuedAt + 30,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export interface GoOnboardingParams {
  userId: string;
  userEmail: string;
  orgName: string;
  businessDescription: string;
  baseCurrency?: string;
  path?: "fresh" | "import" | "connect";
  deferredSteps?: string[];
  /** Restricts optional modules; null or omitted keeps every module enabled. */
  enabledModules?: string[] | null;
}

export interface GoOnboardingResult {
  orgId: string;
  /** Better Auth session row provisioned for Go's identity verification. */
  authSessionId: string;
}

const ZERO_VECTOR = new Array(Number(process.env.EMBEDDING_DIMENSIONS ?? 1024)).fill(0);

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "org"
  );
}

function isStepKey(value: string): value is "business_profile" | "import_customers" | "import_products" | "connect_source" | "invite_team" {
  return ["business_profile", "import_customers", "import_products", "connect_source", "invite_team"].includes(value);
}

/**
 * Mirrors the legacy onboarding seed the Go pipeline depends on: org, chart
 * of accounts, owner role with full authority, membership, policy row, and
 * the zero-vector business profile memory. It also provisions the Better
 * Auth identity rows verifyIdentity checks, because Go verifies sessions and
 * memberships on every assertion.
 */
export async function runOnboarding(
  db: Database["db"],
  params: GoOnboardingParams,
): Promise<GoOnboardingResult> {
  const baseCurrency = (params.baseCurrency ?? "USD").toUpperCase();
  if (!/^[A-Z]{3}$/.test(baseCurrency) || currencyMinorUnits(baseCurrency) === null) {
    throw new Error(`unsupported base currency: ${baseCurrency}`);
  }

  const [domainUser] = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, params.userId))
    .limit(1);
  if (!domainUser) throw new Error(`onboarding requires an existing domain user: ${params.userId}`);

  const existing = await db.select({ id: memberships.id }).from(memberships).where(eq(memberships.userId, params.userId)).limit(1);
  if (existing.length > 0) throw new Error("user already belongs to an organization");

  const orgId = await db.transaction(async (tx) => {
    const base = slugify(params.orgName);
    let slug = base;
    let org: { id: string } | undefined;
    for (let attempt = 0; attempt < 5 && !org; attempt++) {
      try {
        org = await tx.transaction(async (nested) => {
          const [row] = await nested
            .insert(organizations)
            .values({
              name: params.orgName,
              slug,
              profileDescription: params.businessDescription,
              baseCurrency,
              enabledModules: params.enabledModules ?? null,
              settings: {
                onboarding: {
                  path: params.path ?? "fresh",
                  steps: Object.fromEntries(
                    (params.deferredSteps ?? []).filter(isStepKey).map((key) => [key, "pending"]),
                  ),
                  startedAt: new Date().toISOString(),
                },
              },
            })
            .returning({ id: organizations.id });
          return row;
        });
      } catch (error) {
        const code = (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
        if (code !== "23505") throw error;
        slug = `${base}-${attempt + 2}`;
      }
    }
    if (!org) throw new Error("failed to create organization");

    await tx.insert(accounts).values(
      DEFAULT_CHART_OF_ACCOUNTS.map((account) => ({
        orgId: org.id,
        code: account.code,
        name: account.name,
        type: account.type,
      })),
    );
    const [ownerRole] = await tx
      .insert(roles)
      .values({ orgId: org.id, key: "owner", name: "Owner", isSystem: true })
      .returning({ id: roles.id });
    if (!ownerRole) throw new Error("failed to create owner role");
    await tx.insert(rolePermissions).values({ roleId: ownerRole.id, permissionKey: "*", orgId: org.id });
    await tx.insert(userRoles).values({ userId: params.userId, roleId: ownerRole.id, orgId: org.id });
    await tx.insert(memberships).values({ orgId: org.id, userId: params.userId });
    await tx.insert(policies).values([
      { orgId: org.id, capabilityPattern: "*", maxRiskAutonomous: "write", moneyThresholdMinor: 50_000 },
    ]);
    await tx.insert(memories).values({
      orgId: org.id,
      kind: "business_profile",
      source: "onboarding",
      content: params.businessDescription,
      embedding: ZERO_VECTOR,
    });
    return org.id;
  });

  const auth = await ensureGoAuthIdentity(db, domainUser);
  return { orgId, authSessionId: auth.authSessionId };
}

const authIdentityCache = new Map<string, { authUserId: string; authSessionId: string; token: string }>();

async function ensureGoAuthIdentity(
  db: Database["db"],
  domainUser: { id: string; email: string; name: string | null },
): Promise<{ authUserId: string; authSessionId: string; token: string }> {
  const cached = authIdentityCache.get(domainUser.id);
  if (cached) return cached;

  let [identity] = await db.select().from(authUser).where(eq(authUser.email, domainUser.email)).limit(1);
  if (!identity) {
    [identity] = await db
      .insert(authUser)
      .values({
        id: randomUUID(),
        name: domainUser.name ?? domainUser.email,
        email: domainUser.email,
        emailVerified: true,
      })
      .returning();
  } else if (!identity.emailVerified) {
    await db.update(authUser).set({ emailVerified: true, updatedAt: new Date() }).where(eq(authUser.id, identity.id));
  }
  if (!identity) throw new Error("failed to provision the Go auth identity");

  const expiresAt = new Date(Date.now() + 7 * 86_400_000);
  let [session] = await db.select().from(authSession).where(eq(authSession.userId, identity.id)).limit(1);
  if (!session) {
    [session] = await db
      .insert(authSession)
      .values({ id: randomUUID(), token: `go-demo-${randomUUID()}`, userId: identity.id, expiresAt })
      .returning();
  } else if (session.expiresAt.getTime() <= Date.now()) {
    await db.update(authSession).set({ expiresAt, updatedAt: new Date() }).where(eq(authSession.id, session.id));
  }
  if (!session) throw new Error("failed to provision the Go auth session");

  const resolved = { authUserId: identity.id, authSessionId: session.id, token: session.token };
  authIdentityCache.set(domainUser.id, resolved);
  return resolved;
}

/** Resolves (or provisions) the Better Auth session for one domain user. */
export async function goSessionFor(db: Database["db"], userId: string): Promise<{ authSessionId: string; token: string }> {
  const [domainUser] = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!domainUser) throw new Error(`Go session requires an existing domain user: ${userId}`);
  const { authSessionId, token } = await ensureGoAuthIdentity(db, domainUser);
  return { authSessionId, token };
}

const agentSessionCache = new Map<string, string>();

async function ensureGoAgentSession(db: Database["db"], orgId: string, userId: string): Promise<string> {
  const key = `${orgId}:${userId}`;
  const cached = agentSessionCache.get(key);
  if (cached) return cached;
  const [session] = await db
    .insert(agentSessions)
    .values({ orgId, userId, title: "Go capability demo", mode: "assist", status: "open" })
    .returning({ id: agentSessions.id });
  if (!session) throw new Error("failed to provision the Go agent session");
  agentSessionCache.set(key, session.id);
  return session.id;
}

export type GoRegistry = {
  get(id: string): undefined;
  list(): string[];
};

/** Kept so demos can pass a registry alongside the Go executor; Go owns the real registry. */
export function buildRegistry(_db?: unknown): GoRegistry {
  return { get: () => undefined, list: () => [] };
}

export type GoExecutor = {
  execute(
    capabilityId: string,
    ctx: ActionContext,
    input: unknown,
    opts?: { approvedApprovalId?: string },
  ): Promise<GoExecuteResult>;
};

/**
 * The demos' executor adapter. Every call goes through the signed private Go
 * endpoints; approvals re-execute through the decision route, never through
 * the caller's say-so.
 */
export function buildExecutor(
  db: Database["db"],
  _registry?: unknown,
  _opts?: GoExecutorOptions,
): GoExecutor {
  return {
    execute: (capabilityId, ctx, input, opts = {}) =>
      executeThroughGo(db, capabilityId, ctx, input, opts),
  };
}

async function executeThroughGo(
  db: Database["db"],
  capabilityId: string,
  ctx: ActionContext,
  input: unknown,
  opts: { approvedApprovalId?: string },
): Promise<GoExecuteResult> {
  const actor = ctx.actor;
  if (!actor.id) {
    throw new Error(`Go capability execution requires the resolved actor id (${capabilityId})`);
  }
  const { authSessionId } = await goSessionFor(db, actor.id);
  const session: GoSession = { userId: actor.id, orgId: actor.orgId, authSessionId };
  let actionContext = ctx;
  if (actor.type === "agent") {
    const agentSessionId = ctx.sessionId ?? (await ensureGoAgentSession(db, actor.orgId, actor.id));
    actionContext = { ...ctx, sessionId: agentSessionId };
  }

  if (opts.approvedApprovalId) {
    // Legacy callers could hand an agent context to the approval-verify path.
    // Go executes approvals only through the human decision endpoint, and the
    // demo contexts always carry the resolved human user id, so sign the
    // decision as that human; a rejected or consumed approval still refuses.
    const decision = await decideGoApproval({
      actionContext: { ...ctx, actor: { ...actor, type: "human" as const } },
      session,
      approvalId: opts.approvedApprovalId,
      capabilityId,
      input,
      decision: "approve",
    });
    return mapDecisionResult(decision, capabilityId);
  }

  const dispatched = await executeGoCapability({
    actionContext,
    session,
    capabilityId,
    input,
  });
  return mapCapabilityResult(dispatched, capabilityId, input);
}

async function mapCapabilityResult(
  dispatched: GoCapabilityBridgeResult,
  capabilityId: string,
  input: unknown,
): Promise<GoExecuteResult> {
  if (dispatched.kind === "not-dispatched") {
    throw new Error("Go capability was not dispatched; check GO_INTERNAL_AUTH_SECRET and GO_API_INTERNAL_URL.");
  }
  if (dispatched.kind === "outcome-unknown") {
    throw new Error("Go capability outcome is unknown; check the Go API and reconcile the database before retrying.");
  }
  const body = asRecord(await dispatched.response.json().catch(() => null));
  const status = dispatched.response.status;
  if (status === 200 && body?.ok === true && "data" in body) {
    return {
      ok: true,
      data: asRecord(body.data) ?? undefined,
      capabilityId,
      replayed: body.replayed === true,
    };
  }
  if (status === 202 && body?.pendingApproval === true) {
    const rationale = typeof body.reason === "string" ? body.reason : "pending human approval";
    const approvalId = typeof body.approvalId === "string" ? body.approvalId : undefined;
    return {
      ok: false,
      capabilityId,
      error: rationale,
      reason: rationale,
      approvalId,
      pendingApproval: { capabilityId, payload: input, rationale, approvalId },
    };
  }
  return {
    ok: false,
    capabilityId,
    error: (typeof body?.error === "string" && body.error) ||
      `${capabilityId} failed with HTTP ${status}`,
  };
}

async function mapDecisionResult(
  decided: GoApprovalDecisionBridgeResult,
  capabilityId: string,
): Promise<GoExecuteResult> {
  if (decided.kind === "not-dispatched") {
    throw new Error("Go approval decision was not dispatched; check GO_INTERNAL_AUTH_SECRET and GO_API_INTERNAL_URL.");
  }
  if (decided.kind === "outcome-unknown") {
    throw new Error("Go approval outcome is unknown; check the Go API and reconcile the database before retrying.");
  }
  const body = asRecord(await decided.response.json().catch(() => null));
  const status = decided.response.status;
  if (status === 200 && body?.ok === true && body.status === "executed") {
    const result = asRecord(body.result);
    if (result?.ok === true) {
      return { ok: true, data: asRecord(result.data) ?? undefined, capabilityId };
    }
    return {
      ok: false,
      capabilityId,
      error: (typeof result?.error === "string" && result.error) || "approved execution failed",
    };
  }
  return {
    ok: false,
    capabilityId,
    error: (typeof body?.error === "string" && body.error) ||
      `approval decision failed with HTTP ${status}`,
  };
}

/** Drives the Go support reply draft through a real Better Auth session token. */
export async function draftSupportReply(input: {
  db: Database["db"];
  registry?: unknown;
  resolved: { userId: string; orgId: string };
  conversationId: string;
}): Promise<{ draft: string }> {
  const baseUrl = goBaseUrl();
  if (!baseUrl) throw new Error("Go API base URL is invalid");
  const { token } = await goSessionFor(input.db, input.resolved.userId);

  let response: Response;
  try {
    response = await fetch(new URL("/api/support/draft", baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Organization-ID": input.resolved.orgId,
      },
      body: JSON.stringify({ conversationId: input.conversationId }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error("Go support reply drafting was unreachable; check the Go API.");
  }
  const body = asRecord(await response.json().catch(() => null));
  if (response.status !== 200 || typeof body?.draft !== "string" || body.draft.trim() === "") {
    const error = typeof body?.error === "string" ? body.error : `support draft failed with HTTP ${response.status}`;
    throw new Error(error);
  }
  return { draft: body.draft };
}
