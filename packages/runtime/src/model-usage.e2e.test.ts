/**
 * ADR 0014 tranche 11 — model usage ledger + budget enforcement E2E over
 * Postgres.
 *
 * Proves cost controls are durable and process-shared: a completion routed on
 * one host records estimated spend into `model_usage`; an independent host
 * enforcing the same budget sees that spend and hard-refuses the next
 * completion once the cap is reached. Rows are append-only and survive a
 * fresh ledger instance (host restart).
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, runMigrations, schema, type Db, cleanupTestData } from "@chaste/db";
import {
  createModelRouter,
  BudgetLimitError,
  type AiProvider,
  type CompletionRequest,
  type CompletionResult,
} from "@chaste/ai-core";
import { PostgresUsageLedger } from "./postgres-usage-ledger.js";

const hasDb = Boolean(process.env.DATABASE_URL);
const DB_URL = process.env.DATABASE_URL!;

function fakeProvider(id: string): AiProvider {
  return {
    id,
    async complete(_req: CompletionRequest): Promise<CompletionResult> {
      return {
        text: `from ${id}`,
        provider: id,
        model: `model-${id}`,
        usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      };
    },
  };
}

describe.skipIf(!hasDb)("Durable model usage + budget E2E", () => {
  let db: Db;
  let orgId: string;
  let sessionId: string;

  beforeAll(async () => {
    db = createDb(DB_URL);
    await runMigrations(DB_URL);
    await cleanupTestData(db);

    const [org] = await db
      .insert(schema.organizations)
      .values({ name: "Usage Ledger Org", autonomy: "guarded_auto", region: "local" })
      .returning();
    orgId = org!.id;
    sessionId = crypto.randomUUID();
  });

  afterAll(async () => {
    await cleanupTestData(db);
  });

  it("shares spend across hosts and enforces a global budget cap", async () => {
    // Two hosts, each with its own ledger instance over the same table.
    const hostA = new PostgresUsageLedger(db);
    const hostB = new PostgresUsageLedger(db);
    const routerA = createModelRouter({
      providers: { main: fakeProvider("main") },
      config: { defaultRoute: "main" },
      budget: { enabled: true, sessionCents: 1 },
      prices: { main: { promptCents: 300, completionCents: 1500 } },
      ledger: hostA,
      now: () => new Date(),
    });
    const routerB = createModelRouter({
      providers: { main: fakeProvider("main") },
      config: { defaultRoute: "main" },
      budget: { enabled: true, sessionCents: 1 },
      prices: { main: { promptCents: 300, completionCents: 1500 } },
      ledger: hostB,
      now: () => new Date(),
    });

    // Host A records spend; the row lands in the shared table.
    await routerA.complete("report", { user: "analyze" }, { organizationId: orgId, sessionId });
    const [row] = await db
      .select()
      .from(schema.modelUsage)
      .where(eq(schema.modelUsage.organizationId, orgId))
      .limit(1);
    expect(row?.estimatedCostCents).toBe(1);
    expect(row?.taskClass).toBe("report");
    expect(row?.sessionId).toBe(sessionId);

    // Host B enforces the same cap: with spend already recorded, its
    // pre-dispatch budget check refuses the next completion.
    await expect(
      routerB.complete("report", { user: "over budget" }, { organizationId: orgId, sessionId }),
    ).rejects.toThrow(BudgetLimitError);

    // A fresh host (restart) still sees the durable spend.
    const restarted = new PostgresUsageLedger(db);
    expect(await restarted.spendForSession(sessionId)).toBe(1);
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    expect(await restarted.spendForOrganization(orgId, monthStart)).toBe(1);
  });

  it("records usage even when no budget cap is configured", async () => {
    const ledger = new PostgresUsageLedger(db);
    const router = createModelRouter({
      providers: { main: fakeProvider("main") },
      config: { defaultRoute: "main" },
      budget: { enabled: false },
      prices: { main: { promptCents: 300, completionCents: 1500 } },
      ledger,
      now: () => new Date(),
    });
    const otherSession = crypto.randomUUID();
    await router.complete("chat", { user: "hello" }, { organizationId: orgId, sessionId: otherSession });
    // Recording is unconditional; the `enabled` flag gates only the cap check.
    expect(await ledger.spendForSession(otherSession)).toBe(1);
  });
});
