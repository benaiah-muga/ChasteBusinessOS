import {
  type ChatSessionState,
  createAiProvider,
  handleChatTurn,
  type AiExplanation,
  type AiProvider,
  createMastraInstance,
  type ChasteMastra,
  createConversationalAgent,
  createNvidiaProvider,
  createWorkflowBuilderAgent,
  generateWorkflowFromNL,
  executeDynamicWorkflow,
  type WorkflowDefinition,
  type NvidiaProvider,
  type WorkflowExecutionContext,
  createTracer,
  type AiTracer,
  TracedProvider,
} from "@chaste/ai-core";
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
  type Db,
  type SessionStore,
} from "@chaste/db";
import {
  type AutonomyLevel,
  autonomyLevelSchema,
  createCommandRegistry,
  createModuleRegistry,
  createQueryRegistry,
  createRequestContext,
  executeCommand,
  executeQuery,
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
  explanations: AiExplanation[];
  sessionUser: SessionUser;
  provider: AiProvider;
  tracer: AiTracer;
  mastra: ChasteMastra;
  nvidiaProvider: NvidiaProvider | null;
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
    langfusePublicKey: config.mastra.langfusePublicKey,
    langfuseSecretKey: config.mastra.langfuseSecretKey,
    langfuseBaseUrl: config.mastra.langfuseBaseUrl,
    observabilityEnabled: config.mastra.observabilityEnabled,
  });

  // Wrap provider with tracing if Langfuse is enabled
  const tracedProvider = config.mastra.observabilityEnabled
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

  // Mastra instance (PG storage is optional — degrades gracefully)
  const mastra = createMastraInstance({
    databaseUrl: config.databaseUrl,
    schemaName: config.mastra.storageSchema,
  });

  // Nvidia NIM provider (for Mastra agents)
  let nvidiaProvider: NvidiaProvider | null = null;
  let workflowBuilder: ReturnType<typeof createWorkflowBuilderAgent> | null = null;

  const nvidiaKey = config.ai.nvidiaApiKey;
  if (nvidiaKey) {
    nvidiaProvider = createNvidiaProvider({
      apiKey: nvidiaKey,
      baseUrl: config.ai.nvidiaBaseUrl,
      model: config.ai.model,
    });
  }

  // Workflow builder uses the simpler AiProvider.complete() for reliability
  if (provider.id !== "none") {
    workflowBuilder = createWorkflowBuilderAgent({
      commandRegistry: commands,
      aiProvider: provider,
    });
  }

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
    explanations: [],
    sessionUser,
    provider: tracedProvider,
    tracer,
    mastra,
    nvidiaProvider,
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

export async function getMastraAgent(app: AppContext) {
  const modelId = app.config.ai.model ?? "nvidia/llama-3.3-nemotron-super-49b-v1.5";
  const model = app.nvidiaProvider
    ? app.nvidiaProvider.model(modelId)
    : modelId;

  const { agent } = await createConversationalAgent({
    model,
    commandRegistry: app.commands,
    queryRegistry: app.queries,
    requestCtx: requestCtx(app),
    helpers: { audit: app.audit, outbox: app.outbox },
    autonomy: app.sessionUser.autonomy,
  });
  return agent;
}

export async function runChat(
  app: AppContext,
  body: { sessionId?: string; message?: string; confirmId?: string; cancelId?: string },
) {
  await refreshSessionUser(app);
  let sessionId = body.sessionId ?? crypto.randomUUID();

  // Load session from DB or create new
  let dbSession = await app.sessionStore.load(sessionId);
  let session: ChatSessionState;
  if (dbSession) {
    session = {
      id: dbSession.id,
      messages: dbSession.messages as ChatSessionState["messages"],
      pending: dbSession.pending,
    };
  } else {
    // Try loading by org+user for existing sessions
    const existing = await app.sessionStore.loadByOrgUser(
      app.sessionUser.organizationId,
      app.sessionUser.id,
    );
    if (existing && existing.id !== sessionId) {
      sessionId = existing.id;
      session = {
        id: existing.id,
        messages: existing.messages as ChatSessionState["messages"],
        pending: existing.pending,
      };
    } else {
      await app.sessionStore.create(sessionId, app.sessionUser.organizationId, app.sessionUser.id);
      session = { id: sessionId, messages: [] };
    }
  }

  const mastraAgent = await getMastraAgent(app);

  const result = await handleChatTurn(
    {
      commands: app.commands,
      queries: app.queries,
      helpers: { audit: app.audit, outbox: app.outbox },
      autonomy: app.sessionUser.autonomy,
      provider: app.provider,
      allowFullAutonomous: app.config.allowFullAutonomous,
      mastraAgent,
    },
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

export async function buildWorkflow(
  app: AppContext,
  request: string,
): Promise<{ workflow: WorkflowDefinition | null; error?: string }> {
  if (!app.workflowBuilder) {
    return { workflow: null, error: "Nvidia NIM not configured. Set NVIDIA_API_KEY to enable workflow builder." };
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
) {
  const wf = app.workflows.get(workflowId);
  if (!wf) {
    return { success: false, error: "Workflow not found" };
  }

  const ctx: WorkflowExecutionContext = {
    registry: app.commands,
    requestCtx: requestCtx(app),
    helpers: { audit: app.audit, outbox: app.outbox },
  };

  return executeDynamicWorkflow(wf, input, ctx);
}

export function healthPayload(app: AppContext) {
  return {
    ok: true as const,
    service: "chaste-api",
    version: "0.4.0",
    config: publicConfigView(app.config),
  };
}
