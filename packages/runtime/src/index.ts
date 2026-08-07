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
} from "@chaste/kernel";
import type { SkillStore, WakeStore } from "@chaste/ai-core";
import { createAccountingModule } from "@chaste/module-accounting";
import { createCrmModule } from "@chaste/module-crm";
import { createHrModule } from "@chaste/module-hr";
import { createInventoryModule } from "@chaste/module-inventory";
import { createManufacturingModule } from "@chaste/module-manufacturing";
import { createMasterDataModule } from "@chaste/module-master-data";
import { createMessagingModule } from "@chaste/module-messaging";
import { createPlatformModule } from "@chaste/module-platform";
import { createPurchasingModule } from "@chaste/module-purchasing";
import { createSchedulingModule } from "@chaste/module-scheduling";
import { PostgresInboxStore } from "./postgres-inbox-store.js";
import { PostgresWakeStore } from "./postgres-wake-store.js";
import { PostgresSkillStore } from "./postgres-skill-store.js";

export { PostgresInboxStore, PostgresWakeStore, PostgresSkillStore };

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
  audit: PostgresAuditWriter;
  outbox: PostgresOutboxWriter;
  sessionStore: DbSessionStore;
  memoryStore: DbMemoryStore;
}

export async function createRuntime(config: AppConfig, db: Db): Promise<Runtime> {
  const commands = createCommandRegistry();
  const queries = createQueryRegistry();
  const modules = createModuleRegistry(commands, queries);

  // Domain modules first (dependency order); platform depends on the registry
  // for `core.modules.list` and its permission list.
  await modules.register(createCrmModule(db));
  await modules.register(createAccountingModule(db));
  await modules.register(createInventoryModule(db));
  await modules.register(createPurchasingModule(db));
  await modules.register(createHrModule(db));
  await modules.register(createManufacturingModule(db));
  await modules.register(createMasterDataModule(db));
  await modules.register(createMessagingModule(db));
  await modules.register(createSchedulingModule(db));
  await modules.register(
    createPlatformModule(db, modules, {
      allowFullAutonomous: config.allowFullAutonomous,
      regions: config.regions,
    }),
  );

  // ARCH-4 — durable, process-shared stores over the existing tables.
  const inbox = new PostgresInboxStore(db);
  const wakes = new PostgresWakeStore(db);
  const skills = new PostgresSkillStore(db);

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
    memoryStore: new DbMemoryStore(db),
  };
}

export { createCommandHelpers };
