import {
  type ChatSessionState,
  handleChatTurn,
  InMemoryMemoryStore,
  type AiExplanation,
} from "@chaste/ai-core";
import {
  type AutonomyLevel,
  autonomyLevelSchema,
  createCommandRegistry,
  createModuleRegistry,
  createQueryRegistry,
  createRequestContext,
  executeCommand,
  executeQuery,
  InMemoryAuditWriter,
  InMemoryOutboxWriter,
  type Actor,
} from "@chaste/kernel";
import { createCoreSystemModule } from "@chaste/module-core-system";
import { createDemoCrmModule, InMemoryCustomerStore } from "@chaste/module-demo-crm";

export interface DemoUser {
  id: string;
  organizationId: string;
  email: string;
  displayName: string;
  permissions: string[];
}

export interface AppContext {
  commands: ReturnType<typeof createCommandRegistry>;
  queries: ReturnType<typeof createQueryRegistry>;
  modules: ReturnType<typeof createModuleRegistry>;
  audit: InMemoryAuditWriter;
  outbox: InMemoryOutboxWriter;
  memory: InMemoryMemoryStore;
  customers: InMemoryCustomerStore;
  sessions: Map<string, ChatSessionState>;
  explanations: AiExplanation[];
  demoUser: DemoUser;
  autonomy: AutonomyLevel;
}

export async function createAppContext(): Promise<AppContext> {
  const commands = createCommandRegistry();
  const queries = createQueryRegistry();
  const modules = createModuleRegistry(commands, queries);
  const audit = new InMemoryAuditWriter();
  const outbox = new InMemoryOutboxWriter();
  const memory = new InMemoryMemoryStore();
  const customers = new InMemoryCustomerStore();

  const autonomy = autonomyLevelSchema.catch("confirm").parse(
    process.env.CHASTE_DEFAULT_AUTONOMY ?? "confirm",
  );

  const demoUser: DemoUser = {
    id: "00000000-0000-4000-8000-000000000001",
    organizationId: "00000000-0000-4000-8000-000000000010",
    email: process.env.CHASTE_DEMO_USER_EMAIL ?? "owner@demo.local",
    displayName: process.env.CHASTE_DEMO_USER_NAME ?? "Demo Owner",
    permissions: [
      "*", // foundation demo — replace with real RBAC
    ],
  };

  // Register business modules (order: deps first)
  await modules.register(createDemoCrmModule(customers));
  // core-system lists modules — register after others so list is complete on query
  await modules.register(createCoreSystemModule(modules));

  return {
    commands,
    queries,
    modules,
    audit,
    outbox,
    memory,
    customers,
    sessions: new Map(),
    explanations: [],
    demoUser,
    autonomy,
  };
}

export function actorFromDemo(app: AppContext, aiRunId?: string): Actor {
  return {
    kind: aiRunId ? "ai_assisted" : "user",
    userId: app.demoUser.id,
    organizationId: app.demoUser.organizationId,
    displayName: app.demoUser.displayName,
    permissions: new Set(app.demoUser.permissions),
    aiRunId,
  };
}

export function requestCtx(app: AppContext, requestId?: string) {
  return createRequestContext({
    actor: actorFromDemo(app),
    requestId,
    autonomy: app.autonomy,
  });
}

export async function runCommand(app: AppContext, name: string, input: unknown, requestId?: string) {
  return executeCommand(app.commands, name, input, requestCtx(app, requestId), {
    audit: app.audit,
    outbox: app.outbox,
  });
}

export async function runQuery(app: AppContext, name: string, input: unknown, requestId?: string) {
  return executeQuery(app.queries, name, input, requestCtx(app, requestId));
}

export async function runChat(
  app: AppContext,
  body: { sessionId?: string; message?: string; confirmId?: string; cancelId?: string },
) {
  const sessionId = body.sessionId ?? crypto.randomUUID();
  let session = app.sessions.get(sessionId);
  if (!session) {
    session = { id: sessionId, messages: [] };
    app.sessions.set(sessionId, session);
  }

  const result = await handleChatTurn(
    {
      commands: app.commands,
      queries: app.queries,
      helpers: { audit: app.audit, outbox: app.outbox },
      autonomy: app.autonomy,
    },
    {
      session,
      userText: body.message,
      confirmId: body.confirmId,
      cancelId: body.cancelId,
      ctx: requestCtx(app),
    },
  );

  app.sessions.set(sessionId, result.session);
  if (result.explanation) {
    app.explanations.push(result.explanation);
    await app.memory.write({
      organizationId: app.demoUser.organizationId,
      kind: "short_term_chat",
      content: result.explanation.summary,
      metadata: { runId: result.explanation.runId },
    });
  }

  return {
    sessionId,
    messages: result.session.messages,
    pendingConfirmationId: result.session.pending?.id,
  };
}
