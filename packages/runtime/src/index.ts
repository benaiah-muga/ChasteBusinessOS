/**
 * `createRuntime` — the single place that builds registries, registers every
 * shipped module, and constructs the durable runtime stores.
 *
 * ARCH-4 — both `apps/api` (via app-context) and `apps/worker` (via the
 * follow-up harness) consume this factory instead of each wiring the 8 modules
 * + in-memory stores independently. Because the stores are Postgres-backed
 * (`pending_approvals`, `ai_wakes`, `ai_skills`), a standing approval rule or
 * wake scheduled through the API is honored by the worker — the autonomy
 * guarantees are real, not process-local.
 */
import type { AppConfig } from "@chaste/config";
import {
  PostgresAuditWriter,
  PostgresOutboxWriter,
  DbSessionStore,
  DbMemoryStore,
  createCommandHelpers,
  type Db,
} from "@chaste/db";
import {
  createCommandRegistry,
  createModuleRegistry,
  createQueryRegistry,
  type CommandRegistry,
  type ModuleRegistry,
  type QueryRegistry,
  type InboxStore,
  type ApprovalGrantStore,
  type ActivityStore,
  type TaskStore,
  type WorkflowInstanceStore,
} from "@chaste/kernel";
import type {
  MemoryStore,
  PlanStore,
  ProactiveDeliveryStore,
  ProactivePreferencesStore,
  SkillStore,
  SessionLog,
  UsageLedger,
  WakeStore,
  WatchRuleStore,
} from "@chaste/ai-core";
import { createAccountingModule } from "@chaste/module-accounting";
import { createCrmModule } from "@chaste/module-crm";
import { createHrModule } from "@chaste/module-hr";
import { createIdentityModule } from "@chaste/module-identity";
import { createInventoryModule } from "@chaste/module-inventory";
import { createManufacturingModule } from "@chaste/module-manufacturing";
import { createMasterDataModule } from "@chaste/module-master-data";
import { createMessagingModule } from "@chaste/module-messaging";
import { createPlatformModule } from "@chaste/module-platform";
import { createPurchasingModule } from "@chaste/module-purchasing";
import { createSchedulingModule } from "@chaste/module-scheduling";
import { createWorkflowTasksModule } from "@chaste/module-workflow-tasks";
import { createWorkflowInstancesModule } from "@chaste/module-workflow-instances";
import { PostgresInboxStore } from "./postgres-inbox-store.js";
import { PostgresWakeStore } from "./postgres-wake-store.js";
import { PostgresSkillStore } from "./postgres-skill-store.js";
import { PostgresMemoryStore } from "./postgres-memory-store.js";
import { PostgresSessionLog } from "./postgres-session-log.js";
import { PostgresContextBundleStore } from "./postgres-context-bundle-store.js";
import { PostgresApprovalGrantStore } from "./postgres-approval-grant-store.js";
import { PostgresActivityStore } from "./postgres-activity-store.js";
import { PostgresTaskStore } from "./postgres-task-store.js";
import { PostgresWorkflowInstanceStore } from "./postgres-workflow-instance-store.js";
import { PostgresPlanStore } from "./postgres-plan-store.js";
import { PostgresUsageLedger } from "./postgres-usage-ledger.js";
import {
  PostgresWatchRuleStore,
  PostgresProactivePreferencesStore,
  PostgresProactiveDeliveryStore,
} from "./postgres-proactive.js";

export {
  PostgresInboxStore,
  PostgresWakeStore,
  PostgresSkillStore,
  PostgresMemoryStore,
  PostgresSessionLog,
  PostgresContextBundleStore,
  PostgresApprovalGrantStore,
  PostgresActivityStore,
  PostgresTaskStore,
  PostgresWorkflowInstanceStore,
  PostgresPlanStore,
  PostgresUsageLedger,
  PostgresWatchRuleStore,
  PostgresProactivePreferencesStore,
  PostgresProactiveDeliveryStore,
};

/**
 * The shared, durable runtime every host builds from. Host-specific concerns
 * (Fastify routing, worker loop, auth) live in thin adapters on top.
 */
export interface Runtime {
  config: AppConfig;
  db: Db;
  commands: CommandRegistry;
  queries: QueryRegistry;
  modules: ModuleRegistry;
  inbox: InboxStore;
  wakes: WakeStore;
  skills: SkillStore;
  /** AI memory (passive recall + explicit memory tools) over `org_memories`. */
  memory: MemoryStore;
  /** ADR 0014 — append-only agent trajectory log over `agent_session_events`. */
  sessionLog: SessionLog;
  /** ADR 0014 — versioned context bundles over `context_bundles`. */
  contextBundles: PostgresContextBundleStore;
  /** ADR 0014 — durable approval grants over `approval_grants`. */
  approvalGrants: ApprovalGrantStore;
  /** ADR 0014 — durable activities over `activities`. */
  activities: ActivityStore;
  /** ADR 0014 — durable workflow tasks over `workflow_tasks`. */
  tasks: TaskStore;
  /** ADR 0014 — durable workflow instances over `workflow_runs`. */
  workflowInstances: WorkflowInstanceStore;
  /** ADR 0014 — durable pending plans over `harness_plans`. */
  planStore: PlanStore;
  /** ADR 0014 — durable model usage ledger over `model_usage`. */
  usage: UsageLedger;
  /** ADR 0014 — durable watch rules over `watch_rules`. */
  watchRules: WatchRuleStore;
  /** ADR 0014 — durable proactive preferences over `proactive_preferences`. */
  proactivePreferences: ProactivePreferencesStore;
  /** ADR 0014 — durable proactive delivery ledger over `proactive_deliveries`. */
  proactiveDeliveries: ProactiveDeliveryStore;
  audit: PostgresAuditWriter;
  outbox: PostgresOutboxWriter;
  sessionStore: DbSessionStore;
  memoryStore: DbMemoryStore;
}

export async function createRuntime(config: AppConfig, db: Db): Promise<Runtime> {
  const commands = createCommandRegistry();
  const queries = createQueryRegistry();
  const modules = createModuleRegistry(commands, queries);

  // ARCH-4 — durable, process-shared stores over the existing tables. Built
  // before module registration so modules that layer command surfaces over
  // these stores receive them (workflow-tasks).
  const inbox = new PostgresInboxStore(db);
  const wakes = new PostgresWakeStore(db);
  const skills = new PostgresSkillStore(db);
  const memoryStore = new DbMemoryStore(db);
  const sessionLog = new PostgresSessionLog(db);
  const contextBundles = new PostgresContextBundleStore(db);
  const approvalGrants = new PostgresApprovalGrantStore(db);
  const activities = new PostgresActivityStore(db);
  const tasks = new PostgresTaskStore(db);
  const workflowInstances = new PostgresWorkflowInstanceStore(db);
  const planStore = new PostgresPlanStore(db);
  const usage = new PostgresUsageLedger(db);
  const watchRules = new PostgresWatchRuleStore(db);
  const proactivePreferences = new PostgresProactivePreferencesStore(db);
  const proactiveDeliveries = new PostgresProactiveDeliveryStore(db);

  // Domain modules first (dependency order); platform depends on the registry
  // for `core.modules.list` and its permission list.
  await modules.register(createCrmModule(db));
  await modules.register(createAccountingModule(db));
  await modules.register(createInventoryModule(db));
  await modules.register(createPurchasingModule(db));
  await modules.register(createHrModule(db));
  await modules.register(
    // Defensive TTL read: hosts pass full configs, but tolerate partial ones.
    createIdentityModule(db, {
      authTokenTtlMs: (config.session?.tokenTtlSeconds ?? 90 * 24 * 60 * 60) * 1000,
    }),
  );
  await modules.register(createManufacturingModule(db));
  await modules.register(createMasterDataModule(db));
  await modules.register(createMessagingModule(db));
  await modules.register(createSchedulingModule(db));
  await modules.register(
    createWorkflowTasksModule({
      activities,
      tasks,
    }),
  );
  await modules.register(
    createWorkflowInstancesModule({
      instances: workflowInstances,
    }),
  );
  await modules.register(
    createPlatformModule(db, modules, {
      allowFullAutonomous: config.allowFullAutonomous,
      regions: config.regions,
      watchRules,
    }),
  );

  return {
    config,
    db,
    commands,
    queries,
    modules,
    inbox,
    wakes,
    skills,
    audit: new PostgresAuditWriter(db),
    outbox: new PostgresOutboxWriter(db),
    sessionStore: new DbSessionStore(db),
    memoryStore,
    memory: new PostgresMemoryStore(memoryStore),
    sessionLog,
    contextBundles,
    approvalGrants,
    activities,
    tasks,
    workflowInstances,
    planStore,
    usage,
    watchRules,
    proactivePreferences,
    proactiveDeliveries,
  };
}

export { createCommandHelpers };
