import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { conversationMembers, conversations, createDb, organizations, users, type Database } from "@chaste/db";
import { purgeTenantFinancials } from "@chaste/db";
import { CapabilityRegistry, KernelExecutor, type LedgerStore, type ActionContext } from "@chaste/kernel";
import { registerMessagingCapabilities, type ModuleDeps } from "./index";

/** Audit sink for executor-run assertions; module tests need no real chain. */
const memoryLedger: LedgerStore = {
  lastHash: async () => null,
  append: async () => 1,
};

/**
 * I1 (N08): conversation creation is a governed capability that commits the
 * header and the creator's membership in one unit — no route-side inserts,
 * no unusable orphan headers.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
const userId = crypto.randomUUID();

function ctx(permissions: string[]): ActionContext {
  return {
    actor: { type: "human", id: userId, orgId, permissions: new Set(permissions) },
    now: new Date("2026-09-16T00:00:00.000Z"),
    services: {},
  };
}

async function run<I>(id: string, ctxValue: ActionContext, input: I): Promise<unknown> {
  const registry = new CapabilityRegistry();
  registerMessagingCapabilities(registry, deps);
  // Through the kernel executor: authority (policy) is part of the contract,
  // exactly as it stands for human routes and agent tools.
  const executor = new KernelExecutor({ registry, ledger: memoryLedger });
  return executor.execute(id, ctxValue, input);
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await db.db.insert(organizations).values({ id: orgId, name: "Messaging Create Probe", slug: `msg-new-${orgId.slice(0, 8)}` });
  await db.db.insert(users).values({ id: userId, email: "creator@msg.test", name: "Creator" });
});

afterAll(async () => {
  await purgeTenantFinancials(db.db, orgId);
  await db.db.delete(conversations).where(eq(conversations.orgId, orgId));
  await db.db.delete(users).where(eq(users.id, userId));
  await db.db.delete(organizations).where(eq(organizations.id, orgId));
  await db.client.end();
});

describe("messaging.createConversation (N08)", () => {
  it("creates the header and the creator membership in one unit", async () => {
    const result = (await run("messaging.createConversation", ctx(["messaging.write"]), {
      title: "ops channel",
      kind: "channel",
      agentEnabled: true,
    })) as { ok: true; data: { conversationId: string } };
    const conversationId = result.data.conversationId;
    const [conv] = await db.db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(conv!.title).toBe("ops channel");
    expect(conv!.agentEnabled).toBe(true);
    const [member] = await db.db
      .select()
      .from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)));
    expect(member).toBeTruthy();
  });

  it("refuses an actor without messaging authority", async () => {
    const result = (await run("messaging.createConversation", ctx([]), {
      title: "smuggled",
    })) as { ok: false; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/forbidden.*messaging\.write/);
  });
});
