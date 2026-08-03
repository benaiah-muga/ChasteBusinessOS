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
  WakeStore,
  InMemorySkillStore,
  runFollowUpTurn,
  SUMMARY_SYSTEM_PROMPT,
  type SkillStore,
  type CompactionSummarizer,
  type CompletionRequest,
} from "@chaste/ai-core";
import type { ChatMessage } from "@chaste/ui-schema";
import { loadConfig, publicConfigView, type AppConfig } from "@chaste/config";
import {
  bootstrapPlatform,
  createDb,
  getUserWithOrg,
  PostgresAuditWriter,
  PostgresOutboxWriter,
  resolveUserPermissions,
  DbSessionStore,
  DbMemoryStore,
  schema,
  type Db,
  type SessionStore,
} from "@chaste/db";
import { eq } from "drizzle-orm";
import {
  type AutonomyLevel,
  autonomyLevelSchema,
  createCommandRegistry,
  createModuleRegistry,
  createQueryRegistry,
  createRequestContext,
  executeCommand,
  executeQuery,
  InboxStore,
  NotFoundError,
  type Actor,
  type CommandRegistry,
  type ModuleRegistry,
  type QueryRegistry,
} from "@chaste/kernel";
import { createAccountingModule } from "@chaste/module-accounting";
import { createCrmModule } from "@chaste/module-crm";
import { createHrModule } from "@chaste/module-hr";
import { createInventoryModule } from "@chaste/module-inventory";
import { createManufacturingModule } from "@chaste/module-manufacturing";
import { createPlatformModule } from "@chaste/module-platform";
import { createPurchasingModule } from "@chaste/module-purchasing";

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
  workflows: Map<string, WorkflowDefinition>;
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

  const permissions = await resolveUserPermissions(db, bootstrap.adminUserId);
  const userRow = await getUserWithOrg(db, bootstrap.adminUserId);
  if (!userRow) {
    throw new Error("Bootstrap admin user not found after seed");
  }

  const autonomy = autonomyLevelSchema.catch(config.defaultAutonomy).parse(userRow.autonomy);

  const sessionUser: SessionUser = {
    id: userRow.userId,
    organizationId: userRow.organizationId,
    email: userRow.email,
    displayName: userRow.displayName,
    permissions,
    autonomy,
    orgName: userRow.orgName,
    region: userRow.region,
  };

  const commands = createCommandRegistry();
  const queries = createQueryRegistry();
  const modules = createModuleRegistry(commands, queries);
  const audit = new PostgresAuditWriter(db);
  const outbox = new PostgresOutboxWriter(db);
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

  // Memory store — persistent tiered storage for AI context
  const memoryStore = new DbMemoryStore(db);

  // Domain modules first (dependency order)
  await modules.register(createCrmModule(db));
  await modules.register(createAccountingModule(db));
  await modules.register(createInventoryModule(db));
  await modules.register(createPurchasingModule(db));
  await modules.register(createHrModule(db));
  await modules.register(createManufacturingModule(db));
  await modules.register(
    createPlatformModule(db, modules, {
      allowFullAutonomous: config.allowFullAutonomous,
      regions: config.regions,
    }),
  );

  // Workflow builder uses AiProvider.complete() (rules + structured LLM)
  let workflowBuilder: ReturnType<typeof createWorkflowBuilderAgent> | null = null;
  if (provider.id !== "none") {
    workflowBuilder = createWorkflowBuilderAgent({
      commandRegistry: commands,
      aiProvider: provider,
    });
  }

  // R2/R5/R7 runtime stores — the durable Postgres-backed counterparts
  // (`pending_approvals`, `ai_wakes`, `ai_skills`) exist in the schema; the
  // in-memory kernel stores satisfy the same interfaces so the runtime works
  // today and can be swapped without touching the orchestrator.
  const inbox = new InboxStore();
  const wakes = new WakeStore();
  const skills = new InMemorySkillStore();

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
    sessionStore: new DbSessionStore(db),
    memoryStore,
    inbox,
    wakes,
    skills,
    compaction,
    explanations: [],
    sessionUser,
    provider: tracedProvider,
    tracer,
    workflowBuilder,
    workflows: new Map(),
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

export async function refreshSessionUser(app: AppContext): Promise<void> {
  const userRow = await getUserWithOrg(app.db, app.sessionUser.id);
  if (!userRow) return;
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
  return executeCommand(app.commands, name, input, requestCtx(app, requestId), {
    audit: app.audit,
    outbox: app.outbox,
  });
}

export async function runQuery(app: AppContext, name: string, input: unknown, requestId?: string) {
  return executeQuery(app.queries, name, input, requestCtx(app, requestId));
}

function buildOrchestratorDeps(app: AppContext, activeBranch?: { name: string; code: string }) {
  return {
    commands: app.commands,
    queries: app.queries,
    helpers: { audit: app.audit, outbox: app.outbox },
    autonomy: app.sessionUser.autonomy,
    provider: app.provider,
    allowFullAutonomous: app.config.allowFullAutonomous,
    inbox: app.inbox,
    wake: app.wakes,
    skills: app.skills,
    compaction: app.compaction,
    defaultInboxVisibility: app.config.ai.defaultInboxVisibility,
    activeBranch,
  };
}

export async function runChat(
  app: AppContext,
  body: { sessionId?: string; message?: string; confirmId?: string; cancelId?: string },
) {
  await refreshSessionUser(app);
  let sessionId = body.sessionId ?? crypto.randomUUID();

  // Load session from DB or create new.
  // Only reuse org+user sticky session when the client omits sessionId.
  // An explicit unknown sessionId always starts a fresh conversation (isolation).
  let dbSession = await app.sessionStore.load(sessionId);
  let session: ChatSessionState;
  if (dbSession) {
    session = {
      id: dbSession.id,
      messages: dbSession.messages as ChatSessionState["messages"],
      pending: dbSession.pending,
      unattended: dbSession.unattended ?? false,
      compactionState: dbSession.compactionState as ChatSessionState["compactionState"],
    };
  } else if (!body.sessionId) {
    const existing = await app.sessionStore.loadByOrgUser(
      app.sessionUser.organizationId,
      app.sessionUser.id,
    );
    if (existing) {
      sessionId = existing.id;
      session = {
        id: existing.id,
        messages: existing.messages as ChatSessionState["messages"],
        pending: existing.pending,
        unattended: existing.unattended ?? false,
        compactionState: existing.compactionState as ChatSessionState["compactionState"],
      };
    } else {
      await app.sessionStore.create(sessionId, app.sessionUser.organizationId, app.sessionUser.id);
      session = { id: sessionId, messages: [] };
    }
  } else {
    await app.sessionStore.create(sessionId, app.sessionUser.organizationId, app.sessionUser.id);
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

  const result = await handleChatTurn(
    buildOrchestratorDeps(app, activeBranch),
    {
      session,
      userText: body.message,
      confirmId: body.confirmId,
      cancelId: body.cancelId,
      ctx: requestCtx(app),
    },
  );

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
      pending: dbSession.pending,
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
        pending: sticky.pending,
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
    const result = await runFollowUpTurn(
      buildOrchestratorDeps(app, activeBranch),
      { session, ctx, goal: fu.goal },
    );
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
      return { workflow: null, error: "Failed to generate workflow from request. Try a more specific description." };
    }
    app.workflows.set(workflow.id, workflow);
    return { workflow };
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
) {
  const wf = app.workflows.get(workflowId);
  if (!wf) {
    throw new NotFoundError("Workflow");
  }

  const ctx: WorkflowExecutionContext = {
    registry: app.commands,
    requestCtx: requestCtx(app),
    helpers: { audit: app.audit, outbox: app.outbox },
  };

  return executeDynamicWorkflow(wf, input, ctx, {
    approvedStepIds: options.approvedStepIds,
  });
}

export function healthPayload(app: AppContext) {
  return {
    ok: true as const,
    service: "chaste-api",
    version: "0.4.0",
    config: publicConfigView(app.config),
  };
}
