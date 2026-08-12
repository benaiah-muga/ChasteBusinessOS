import {
  type ChatSessionState,
  createAiProvider,
  handleChatTurn,
  type AiExplanation,
  type AiProvider,
  createWorkflowBuilderAgent,
  generateWorkflowFromNL,
  executeDynamicWorkflow,
  type WorkflowDefinition,
  type WorkflowExecutionContext,
  createTracer,
  type AiTracer,
  TracedProvider,
  runFollowUpTurn,
  SUMMARY_SYSTEM_PROMPT,
  type SkillStore,
  type WakeStore,
  type CompactionSummarizer,
  type CompletionRequest,
  type MemoryStore,
} from "@chaste/ai-core";
import type { ChatMessage } from "@chaste/ui-schema";
import { loadConfig, publicConfigView, type AppConfig } from "@chaste/config";
import {
  bootstrapPlatform,
  createCommandHelpers,
  createDb,
  getUserByEmail,
  getUserWithOrg,
  PostgresAuditWriter,
  PostgresOutboxWriter,
  resolveUserPermissions,
  resolveUserByToken,
  resolveApiKeyBySecret,
  type ApiKeyPrincipal,
  DbMemoryStore,
  schema,
  type Db,
  type SessionStore,
  type AuthenticatedUser,
} from "@chaste/db";
import { eq } from "drizzle-orm";
import { createRequire } from "node:module";
const pkgRequire = createRequire(import.meta.url);
const pkg = pkgRequire("../package.json") as { version: string };
import {
  type AutonomyLevel,
  autonomyLevelSchema,
  createRequestContext,
  executeCommand,
  executeQuery,
  FULL_AUTONOMOUS_WARNING,
  NotFoundError,
  PermissionError,
  type Actor,
  type CommandRegistry,
  type InboxStore,
  type ModuleRegistry,
  type QueryRegistry,
} from "@chaste/kernel";
import { createRuntime } from "@chaste/runtime";

export interface SessionUser {
  id: string;
  organizationId: string;
  email: string;
  displayName: string;
  permissions: string[];
  autonomy: AutonomyLevel;
  orgName: string;
  region: string;
}

/**
 * Per-request authenticated principal. Carries the resolved user's session
 * view (permissions, autonomy, org) plus the command-bus Actor. This replaces
 * the boot-time `app.sessionUser` singleton for request handling.
 */
export interface RequestAuth {
  sessionUser: SessionUser;
  actor: Actor;
}

export interface AppContext {
  config: AppConfig;
  db: Db;
  commands: CommandRegistry;
  queries: QueryRegistry;
  modules: ModuleRegistry;
  audit: PostgresAuditWriter;
  outbox: PostgresOutboxWriter;
  sessionStore: SessionStore;
  memoryStore: DbMemoryStore;
  /** AI memory (passive recall + explicit memory tools) over `org_memories`. */
  memory: MemoryStore;
  /** R2 — the canonical human-attention queue (in-memory kernel store; durable `pending_approvals` table exists for the Postgres-backed swap). */
  inbox: InboxStore;
  /** R5 — durable self-wake records for scheduled re-entry. */
  wakes: WakeStore;
  /** R7 — org/platform AI skill catalog (progressive disclosure). */
  skills: SkillStore;
  /** R6 — compaction summarizer over the configured provider. */
  compaction?: { summarizer: CompactionSummarizer };
  explanations: AiExplanation[];
  sessionUser: SessionUser;
  provider: AiProvider;
  tracer: AiTracer;
  workflowBuilder: ReturnType<typeof createWorkflowBuilderAgent> | null;
}

/**
 * Build the bootstrap admin's session view from its id. `getUserWithOrg`
 * fails closed (throws) when the row is gone, so callers can distinguish a
 * truly-unresolvable principal from a plain permission/org read.
 */
async function sessionUserForBootstrapAdmin(
  db: Db,
  config: AppConfig,
  adminUserId: string,
): Promise<SessionUser> {
  const permissions = await resolveUserPermissions(db, adminUserId);
  const userRow = await getUserWithOrg(db, adminUserId);
  if (!userRow) {
    throw new Error("Bootstrap admin user not found after seed");
  }
  const autonomy = autonomyLevelSchema.catch(config.defaultAutonomy).parse(userRow.autonomy);
  return {
    id: userRow.userId,
    organizationId: userRow.organizationId,
    email: userRow.email,
    displayName: userRow.displayName,
    permissions,
    autonomy,
    orgName: userRow.orgName,
    region: userRow.region,
  };
}

/**
 * Re-resolve the anonymous (dev-only) fallback session from the database.
 *
 * The boot-time `app.sessionUser` is a snapshot taken when the process started.
 * When the DB is truncated/reseeded while the API is alive (test runs, manual
 * resets, seed scripts), that snapshot's org/user ids point at deleted rows and
 * every org-scoped query silently returns empty. Instead of trusting the cached
 * snapshot, resolve the bootstrap admin fresh on each anonymous request:
 *
 *  - find the first org, then the bootstrap admin by `config.bootstrap.adminEmail`;
 *  - if bootstrap is disabled, fall back to the first org's first user
 *    (mirrors `bootstrapPlatform`'s disabled branch);
 *  - if the org/admin rows are missing entirely (freshly-wiped DB), re-run the
 *    idempotent `bootstrapPlatform` to re-seed, then re-read;
 *  - keep `app.sessionUser` in sync so `actorFromSession`/`requestCtx`/`runChat`
 *    fallback stay fresh for the whole process.
 */
async function resolveBootstrapSession(app: AppContext): Promise<SessionUser> {
  const db = app.db;
  const config = app.config;

  const [org] = await db.select().from(schema.organizations).limit(1);
  if (org) {
    const admin = config.bootstrap.enabled
      ? await getUserByEmail(db, org.id, config.bootstrap.adminEmail)
      : (
          await db
            .select()
            .from(schema.users)
            .where(eq(schema.users.organizationId, org.id))
            .limit(1)
        )[0];
    if (admin) {
      const sessionUser = await sessionUserForBootstrapAdmin(db, config, admin.id);
      app.sessionUser = sessionUser;
      return sessionUser;
    }
  }

  // DB was wiped under us — re-seed idempotently, then resolve the fresh admin.
  const bootstrap = await bootstrapPlatform(db, config);
  const sessionUser = await sessionUserForBootstrapAdmin(db, config, bootstrap.adminUserId);
  app.sessionUser = sessionUser;
  return sessionUser;
}

export async function createAppContext(env: NodeJS.ProcessEnv = process.env): Promise<AppContext> {
  const config = loadConfig(env);

  // Handle Unix socket URLs that postgres.js v3 can't parse
  let dbConfig: string | { host: string; database: string; username: string } = config.databaseUrl;
  const urlMatch = config.databaseUrl.match(/^postgres:\/\/([^@]*)@\/([^?]+)\?host=(.+)$/);
  if (urlMatch) {
    dbConfig = {
      host: urlMatch[3]!,
      database: urlMatch[2]!,
      username: urlMatch[1]!,
    };
  }
  // Also handle unix:// scheme
  const unixMatch = config.databaseUrl.match(/^unix:\/\/(.+)\?db=([^&]+)&user=([^&]+)$/);
  if (unixMatch) {
    dbConfig = {
      host: unixMatch[1]!,
      database: unixMatch[2]!,
      username: unixMatch[3]!,
    };
  }

  const db = createDb(dbConfig);
  const bootstrap = await bootstrapPlatform(db, config);

  // F1 — prod never reveals a generated admin credential; dev prints it once so
  // a fresh local database can be driven over HTTP (the anonymous fallback is
  // also still on in dev, but this gives a first real bearer credential).
  if (bootstrap.adminAuthToken && config.nodeEnv !== "production") {
    console.warn(`[auth] Bootstrap admin token (dev, show once): ${bootstrap.adminAuthToken}`);
  }

  const sessionUser = await sessionUserForBootstrapAdmin(db, config, bootstrap.adminUserId);

  // ARCH-4 — the shared runtime factory builds registries, registers every
  // module once, and wires the durable Postgres-backed stores
  // (`pending_approvals`, `ai_wakes`, `ai_skills`). The worker consumes the
  // same factory, so standing rules / wakes / skills minted here are honored
  // by scheduled follow-ups — no more process-local store drift.
  const runtime = await createRuntime(config, db);
  const {
    commands,
    queries,
    modules,
    inbox,
    wakes,
    skills,
    audit,
    outbox,
    sessionStore,
    memoryStore,
    memory,
  } = runtime;

  const provider = createAiProvider(config.ai);

  // Observability — Langfuse traces all LLM calls when configured
  const tracer = createTracer({
    langfusePublicKey: config.observability.langfusePublicKey,
    langfuseSecretKey: config.observability.langfuseSecretKey,
    langfuseBaseUrl: config.observability.langfuseBaseUrl,
    observabilityEnabled: config.observability.enabled,
  });

  // Wrap provider with tracing if Langfuse is enabled
  const tracedProvider = config.observability.enabled
    ? new TracedProvider(provider, tracer)
    : provider;

  // Workflow builder uses AiProvider.complete() (rules + structured LLM)
  let workflowBuilder: ReturnType<typeof createWorkflowBuilderAgent> | null = null;
  if (provider.id !== "none") {
    workflowBuilder = createWorkflowBuilderAgent({
      commandRegistry: commands,
      aiProvider: provider,
    });
  }

  // R6 — compaction summarizer reuses the configured provider with the
  // fixed 8-section OpenWorker summary contract.
  const compaction =
    provider.id !== "none"
      ? {
          summarizer: {
            modelUsed: provider.id,
            async summarize(messages: ChatMessage[], priorSummary: string): Promise<string> {
              const req: CompletionRequest = {
                system: SUMMARY_SYSTEM_PROMPT,
                messages,
              };
              if (priorSummary) {
                req.messages = [
                  ...messages,
                  {
                    id: crypto.randomUUID(),
                    role: "user",
                    parts: [
                      {
                        type: "text",
                        text: `Previous compaction summary — fold its still-relevant content into the new summary:\n${priorSummary}`,
                      },
                    ],
                    createdAt: new Date().toISOString(),
                  },
                ];
              }
              const res = await provider.complete(req);
              return res.text || "(no summary returned by provider)";
            },
          },
        }
      : undefined;

  return {
    config,
    db,
    commands,
    queries,
    modules,
    audit,
    outbox,
    sessionStore,
    memoryStore,
    memory,
    inbox,
    wakes,
    skills,
    compaction,
    explanations: [],
    sessionUser,
    provider: tracedProvider,
    tracer,
    workflowBuilder,
  };
}

export function actorFromSession(app: AppContext, aiRunId?: string): Actor {
  return {
    kind: aiRunId ? "ai_assisted" : "user",
    userId: app.sessionUser.id,
    organizationId: app.sessionUser.organizationId,
    displayName: app.sessionUser.displayName,
    permissions: new Set(app.sessionUser.permissions),
    aiRunId,
  };
}

export function requestCtx(app: AppContext, requestId?: string) {
  return createRequestContext({
    actor: actorFromSession(app),
    requestId,
    autonomy: app.sessionUser.autonomy,
  });
}

/**
 * ARCH-1 — build an `Actor` from an authenticated `AuthenticatedUser`.
 * Shared by the HTTP auth preHandler and the follow-up harness.
 */
export function actorFromAuthenticatedUser(au: AuthenticatedUser, aiRunId?: string): Actor {
  return {
    kind: aiRunId ? "ai_assisted" : "user",
    userId: au.userId,
    organizationId: au.organizationId,
    displayName: au.displayName,
    permissions: new Set(au.permissions),
    aiRunId,
  };
}

/**
 * ARCH-1 — resolve a per-request principal from an HTTP Authorization header.
 *
 * Two credential classes are supported:
 *  - `Authorization: Bearer <user-token>` — a user bearer credential;
 *  - `X-Api-Key: <secret>` — an org-scoped API key with its own permission scopes.
 *
 * Returns the session user + actor whose permissions/org are used for the
 * request. When no credential is supplied we fall back to the bootstrap admin
 * ONLY if `auth.allowAnonymousAdmin` is enabled (local dev); otherwise null.
 * An invalid/revoked/expired credential always yields null (caller → 401).
 */
export async function resolveRequestAuth(
  app: AppContext,
  authorizationHeader?: string,
  apiKeyHeader?: string,
): Promise<RequestAuth | null> {
  const apiKey = typeof apiKeyHeader === "string" ? apiKeyHeader.trim() : undefined;
  if (apiKey) {
    const ak = await resolveApiKeyBySecret(app.db, apiKey);
    if (!ak) return null;
    return apiKeyAuthToRequestAuth(app, ak);
  }

  const token = extractBearerToken(authorizationHeader);
  if (!token) {
    if (app.config.auth.allowAnonymousAdmin) {
      const sessionUser = await resolveBootstrapSession(app);
      return {
        sessionUser,
        actor: actorFromSession(app),
      };
    }
    return null;
  }
  const au = await resolveUserByToken(app.db, token);
  if (!au) return null;
  const autonomy = autonomyLevelSchema.catch(app.config.defaultAutonomy).parse(au.autonomy);
  return {
    sessionUser: {
      id: au.userId,
      organizationId: au.organizationId,
      email: au.email,
      displayName: au.displayName,
      permissions: au.permissions,
      autonomy,
      orgName: au.orgName,
      region: au.region,
    },
    actor: actorFromAuthenticatedUser(au),
  };
}

/**
 * Build the session+actor view for an org API key. The actor is
 * `kind: "api_key"`, carries the key's id as `clientId` (audit attribution),
 * and its permissions are the key's declared scopes — never the creator's
 * fuller role set.
 */
export function apiKeyAuthToRequestAuth(app: AppContext, ak: ApiKeyPrincipal): RequestAuth {
  const displayName = `apikey:${ak.name}`;
  const actor: Actor = {
    kind: "api_key",
    userId: ak.createdByUserId,
    organizationId: ak.organizationId,
    displayName,
    clientId: ak.apiKeyId,
    permissions: new Set(ak.scopes),
  };
  const sessionUser: SessionUser = {
    id: ak.createdByUserId,
    organizationId: ak.organizationId,
    email: `api-key:${ak.apiKeyId}`,
    displayName,
    permissions: ak.scopes,
    autonomy: app.config.defaultAutonomy,
    orgName: ak.orgName,
    region: ak.region,
  };
  return { sessionUser, actor };
}

export function extractBearerToken(header?: string): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1] ?? null;
}

/** Shared session payload returned by `/session` and `/auth/login`. */
export function getSessionPayload(auth: RequestAuth, app: AppContext) {
  return {
    userId: auth.sessionUser.id,
    organizationId: auth.sessionUser.organizationId,
    email: auth.sessionUser.email,
    displayName: auth.sessionUser.displayName,
    permissions: auth.sessionUser.permissions,
    autonomy: auth.sessionUser.autonomy,
    orgName: auth.sessionUser.orgName,
    region: auth.sessionUser.region,
    fullAutonomousWarning: FULL_AUTONOMOUS_WARNING,
    allowFullAutonomous: app.config.allowFullAutonomous,
    aiProvider: app.provider.id,
  };
}

/** Per-request variant of `requestCtx` driven by an explicit `RequestAuth`. */
export function requestCtxForAuth(auth: RequestAuth, requestId?: string) {
  return createRequestContext({
    actor: auth.actor,
    requestId,
    autonomy: auth.sessionUser.autonomy,
  });
}

/**
 * Run a command under a request-scoped principal. Uses the authenticated
 * actor + autonomy; the per-request audit/outbox still share the same DB
 * transaction via createCommandHelpers.
 */
export async function runCommandAsAuth(
  app: AppContext,
  name: string,
  input: unknown,
  auth: RequestAuth,
  requestId?: string,
) {
  return executeCommand(
    app.commands,
    name,
    input,
    createRequestContext({ actor: auth.actor, requestId, autonomy: auth.sessionUser.autonomy }),
    createCommandHelpers({ audit: app.audit, outbox: app.outbox, db: app.db }),
  );
}

export async function runQueryAsAuth(
  app: AppContext,
  name: string,
  input: unknown,
  auth: RequestAuth,
  requestId?: string,
) {
  return executeQuery(
    app.queries,
    name,
    input,
    createRequestContext({ actor: auth.actor, requestId, autonomy: auth.sessionUser.autonomy }),
  );
}

export async function refreshSessionUser(app: AppContext): Promise<void> {
  const userRow = await getUserWithOrg(app.db, app.sessionUser.id);
  if (!userRow) {
    // Cached principal no longer exists (DB reseeded) — re-resolve the
    // bootstrap admin from live rows so the fallback session stays valid.
    await resolveBootstrapSession(app);
    return;
  }
  const permissions = await resolveUserPermissions(app.db, app.sessionUser.id);
  app.sessionUser = {
    id: userRow.userId,
    organizationId: userRow.organizationId,
    email: userRow.email,
    displayName: userRow.displayName,
    permissions,
    autonomy: autonomyLevelSchema.catch(app.config.defaultAutonomy).parse(userRow.autonomy),
    orgName: userRow.orgName,
    region: userRow.region,
  };
}

export async function runCommand(
  app: AppContext,
  name: string,
  input: unknown,
  requestId?: string,
) {
  return executeCommand(
    app.commands,
    name,
    input,
    requestCtx(app, requestId),
    createCommandHelpers({
      audit: app.audit,
      outbox: app.outbox,
      db: app.db,
    }),
  );
}

export async function runQuery(app: AppContext, name: string, input: unknown, requestId?: string) {
  return executeQuery(app.queries, name, input, requestCtx(app, requestId));
}

/**
 * Run a command under an explicit actor (used by the Buzz inbound webhook,
 * which posts into a thread as that thread's creator rather than as the
 * request session user). Still goes through the same command bus, permission
 * checks, audit, and outbox as every other path.
 */
export async function runCommandAsActor(
  app: AppContext,
  name: string,
  input: unknown,
  actor: Actor,
  requestId?: string,
  autonomy?: AutonomyLevel,
) {
  const ctx = createRequestContext({ actor, requestId, autonomy });
  return executeCommand(
    app.commands,
    name,
    input,
    ctx,
    createCommandHelpers({ audit: app.audit, outbox: app.outbox, db: app.db }),
  );
}

function buildOrchestratorDeps(
  app: AppContext,
  auth: RequestAuth | null,
  activeBranch?: { name: string; code: string },
) {
  const sessionUser = auth?.sessionUser ?? app.sessionUser;
  return {
    commands: app.commands,
    queries: app.queries,
    helpers: createCommandHelpers({ audit: app.audit, outbox: app.outbox, db: app.db }),
    autonomy: sessionUser.autonomy,
    provider: app.provider,
    allowFullAutonomous: app.config.allowFullAutonomous,
    inbox: app.inbox,
    wake: app.wakes,
    skills: app.skills,
    memory: app.memory,
    compaction: app.compaction,
    defaultInboxVisibility: app.config.ai.defaultInboxVisibility,
    activeBranch,
  };
}

export async function runChat(
  app: AppContext,
  body: { sessionId?: string; message?: string; confirmId?: string; cancelId?: string },
  auth?: RequestAuth,
) {
  const auth0: RequestAuth = auth ?? {
    sessionUser: await resolveBootstrapSession(app),
    actor: actorFromSession(app),
  };
  const sessionUser = auth0.sessionUser;
  let sessionId = body.sessionId ?? crypto.randomUUID();

  // Load session from DB or create new.
  // Only reuse org+user sticky session when the client omits sessionId.
  // An explicit unknown sessionId always starts a fresh conversation (isolation).
  let dbSession = await app.sessionStore.load(sessionId);
  // F4 — sessions are private to their owner: loading another user's session
  // (including its pending planned actions) is an IDOR and must be denied.
  if (dbSession && dbSession.userId !== sessionUser.id) {
    throw new PermissionError("session.access");
  }
  let session: ChatSessionState;
  if (dbSession) {
    session = {
      id: dbSession.id,
      messages: dbSession.messages as ChatSessionState["messages"],
      pending: dbSession.pending as ChatSessionState["pending"],
      unattended: dbSession.unattended ?? false,
      compactionState: dbSession.compactionState as ChatSessionState["compactionState"],
    };
  } else if (!body.sessionId) {
    const existing = await app.sessionStore.loadByOrgUser(
      sessionUser.organizationId,
      sessionUser.id,
    );
    if (existing) {
      sessionId = existing.id;
      session = {
        id: existing.id,
        messages: existing.messages as ChatSessionState["messages"],
        pending: existing.pending as ChatSessionState["pending"],
        unattended: existing.unattended ?? false,
        compactionState: existing.compactionState as ChatSessionState["compactionState"],
      };
    } else {
      await app.sessionStore.create(sessionId, sessionUser.organizationId, sessionUser.id);
      session = { id: sessionId, messages: [] };
    }
  } else {
    await app.sessionStore.create(sessionId, sessionUser.organizationId, sessionUser.id);
    session = { id: sessionId, messages: [] };
  }

  // Branch scope for the LLM's per-turn context (platform spec §4).
  let activeBranch: { name: string; code: string } | undefined;
  if (session.activeBranchId) {
    const [branch] = await app.db
      .select({ name: schema.branches.name, code: schema.branches.code })
      .from(schema.branches)
      .where(eq(schema.branches.id, session.activeBranchId))
      .limit(1);
    if (branch) activeBranch = branch;
  }

  const result = await handleChatTurn(buildOrchestratorDeps(app, auth0, activeBranch), {
    session,
    userText: body.message,
    confirmId: body.confirmId,
    cancelId: body.cancelId,
    ctx: requestCtxForAuth(auth0),
  });

  // Persist to DB
  await app.sessionStore.save(
    sessionId,
    result.session.messages.map((m) => ({
      id: m.id,
      role: m.role,
      parts: m.parts,
      createdAt: m.createdAt,
    })),
    result.session.pending,
    {
      unattended: result.session.unattended ?? false,
      compactionState: result.session.compactionState ?? null,
    },
  );
  if (result.explanation) {
    app.explanations.push(result.explanation);
  }

  return {
    sessionId,
    messages: result.session.messages,
    pendingConfirmationId: result.session.pending?.id,
  };
}

/**
 * C5 — follow-up harness re-entry. Runs a due follow-up through the orchestrator
 * under the follow-up's owning user/org policy, persists the session, and
 * transitions the durable job to done/failed. Returns a short status string.
 */
export async function runFollowUp(
  app: AppContext,
  followUpId: string,
  requestId?: string,
): Promise<{ status: string; sessionId?: string }> {
  const [fu] = await app.db
    .select()
    .from(schema.followUps)
    .where(eq(schema.followUps.id, followUpId))
    .limit(1);
  if (!fu || fu.status !== "running") {
    return { status: fu ? `not_${fu.status}` : "not_found" };
  }

  const userRow = await getUserWithOrg(app.db, fu.userId);
  if (!userRow || !userRow.isActive) {
    await app.db
      .update(schema.followUps)
      .set({ status: "failed" })
      .where(eq(schema.followUps.id, followUpId));
    return { status: "user_missing" };
  }
  const permissions = await resolveUserPermissions(app.db, fu.userId);
  const autonomy = autonomyLevelSchema.catch(app.config.defaultAutonomy).parse(userRow.autonomy);
  const actor: Actor = {
    kind: "ai_assisted",
    userId: fu.userId,
    organizationId: fu.organizationId,
    displayName: userRow.displayName,
    permissions: new Set(permissions),
    aiRunId: crypto.randomUUID(),
  };
  const ctx = createRequestContext({ actor, requestId, autonomy });

  // Session: prefer the follow-up's pinned session, else the user's sticky one.
  let sessionId = fu.sessionId ?? crypto.randomUUID();
  let dbSession = fu.sessionId ? await app.sessionStore.load(sessionId) : undefined;
  let session: ChatSessionState;
  if (dbSession) {
    session = {
      id: dbSession.id,
      messages: dbSession.messages as ChatSessionState["messages"],
      pending: dbSession.pending as ChatSessionState["pending"],
      unattended: dbSession.unattended ?? false,
      compactionState: dbSession.compactionState as ChatSessionState["compactionState"],
    };
  } else {
    const sticky = await app.sessionStore.loadByOrgUser(fu.organizationId, fu.userId);
    if (sticky) {
      sessionId = sticky.id;
      session = {
        id: sticky.id,
        messages: sticky.messages as ChatSessionState["messages"],
        pending: sticky.pending as ChatSessionState["pending"],
        unattended: sticky.unattended ?? false,
        compactionState: sticky.compactionState as ChatSessionState["compactionState"],
      };
    } else {
      await app.sessionStore.create(sessionId, fu.organizationId, fu.userId);
      session = { id: sessionId, messages: [] };
    }
  }

  let activeBranch: { name: string; code: string } | undefined;
  const branchId = fu.branchId ?? session.activeBranchId;
  if (branchId) {
    const [branch] = await app.db
      .select({ name: schema.branches.name, code: schema.branches.code })
      .from(schema.branches)
      .where(eq(schema.branches.id, branchId))
      .limit(1);
    if (branch) activeBranch = branch;
  }

  try {
    const result = await runFollowUpTurn(buildOrchestratorDeps(app, null, activeBranch), {
      session,
      ctx,
      goal: fu.goal,
    });
    await app.sessionStore.save(
      sessionId,
      result.session.messages.map((m: ChatMessage) => ({
        id: m.id,
        role: m.role,
        parts: m.parts,
        createdAt: m.createdAt,
      })),
      result.session.pending,
      {
        unattended: result.session.unattended ?? false,
        compactionState: result.session.compactionState ?? null,
      },
    );
    await app.db
      .update(schema.followUps)
      .set({ status: "done", firedAt: new Date(), sessionId })
      .where(eq(schema.followUps.id, followUpId));
    return { status: "done", sessionId };
  } catch (err) {
    await app.db
      .update(schema.followUps)
      .set({ status: "failed" })
      .where(eq(schema.followUps.id, followUpId));
    return { status: "failed", sessionId };
  }
}

export async function buildWorkflow(
  app: AppContext,
  request: string,
  auth: RequestAuth,
): Promise<{ workflow: WorkflowDefinition | null; error?: string }> {
  if (!app.workflowBuilder) {
    return {
      workflow: null,
      error:
        "AI provider not configured. Set CHASTE_AI_PROVIDER (e.g. nvidia_nim) and the matching API key to enable workflow builder.",
    };
  }

  try {
    const workflow = await generateWorkflowFromNL(app.workflowBuilder, request);
    if (!workflow) {
      return {
        workflow: null,
        error: "Failed to generate workflow from request. Try a more specific description.",
      };
    }
    // ARCH-5 — persist through the command bus so humans and AI share one path
    // and the definition survives restarts. Runs under the authenticated
    // caller so org ownership + audit attribution match the requester (F3).
    const res = await executeCommand(
      app.commands,
      "core.workflow.create",
      {
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        trigger: workflow.trigger,
        triggerConfig: workflow.triggerConfig ?? {},
        steps: workflow.steps,
        createdBy: workflow.createdBy,
      },
      requestCtxForAuth(auth),
      createCommandHelpers({ audit: app.audit, outbox: app.outbox, db: app.db }),
    );
    return { workflow: res.data as WorkflowDefinition };
  } catch (err) {
    return {
      workflow: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function executeWorkflowRun(
  app: AppContext,
  workflowId: string,
  input: Record<string, unknown> = {},
  options: { approvedStepIds?: string[] } = {},
  auth: RequestAuth,
) {
  // ARCH-5 — source the definition from Postgres, not process memory.
  const res = await executeQuery(
    app.queries,
    "core.workflow.get",
    { workflowId },
    requestCtxForAuth(auth),
  );
  const wf = res.data as WorkflowDefinition;
  if (!wf) {
    throw new NotFoundError("Workflow");
  }

  const ctx: WorkflowExecutionContext = {
    registry: app.commands,
    requestCtx: requestCtxForAuth(auth),
    helpers: createCommandHelpers({ audit: app.audit, outbox: app.outbox, db: app.db }),
  };

  return executeDynamicWorkflow(wf, input, ctx, {
    approvedStepIds: options.approvedStepIds,
  });
}

export function healthPayload(app: AppContext) {
  return {
    ok: true as const,
    service: "chaste-api",
    version: pkg.version,
    config: publicConfigView(app.config),
  };
}
