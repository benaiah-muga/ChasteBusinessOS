import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, organizations, tickets, type Database } from "@chaste/db";
import { purgeTenantFinancials } from "@chaste/db";
import { CapabilityRegistry, KernelExecutor, type LedgerStore, type ActionContext } from "@chaste/kernel";
import { registerSupportCapabilities, type ModuleDeps } from "./index";

/** Audit sink for executor-run assertions; module tests need no real chain. */
const memoryLedger: LedgerStore = {
  lastHash: async () => null,
  append: async () => 1,
};

/**
 * I1 (N08): ticket filing - the agent honesty path - is a governed action:
 * audited through the kernel, contracted output, durable id in the receipt.
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
  registerSupportCapabilities(registry, deps);
  // Through the kernel executor: authority (policy) is part of the contract,
  // exactly as it stands for the chat sink that files tickets.
  const executor = new KernelExecutor({ registry, ledger: memoryLedger });
  return executor.execute(id, ctxValue, input);
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await db.db.insert(organizations).values({ id: orgId, name: "Ticket Probe", slug: `ticket-${orgId.slice(0, 8)}` });
});

afterAll(async () => {
  await purgeTenantFinancials(db.db, orgId);
  await db.db.delete(tickets).where(eq(tickets.orgId, orgId));
  await db.db.delete(organizations).where(eq(organizations.id, orgId));
  await db.client.end();
});

describe("support.createTicket (N08)", () => {
  it("files an audited ticket and returns its durable id", async () => {
    const result = (await run("support.createTicket", ctx(["support.write"]), {
      title: "Cannot honestly refund without a capability",
      description: "Customer asks for a refund; no refund capability for this surface.",
      origin: "capability_gap",
    })) as { ok: true; data: { ticketId: string } };
    const [row] = await db.db.select().from(tickets).where(eq(tickets.id, result.data.ticketId));
    expect(row!.title).toContain("refund");
    expect(row!.origin).toBe("capability_gap");
    expect(row!.status).toBe("open");
  });

  it("refuses an actor without support authority", async () => {
    const result = (await run("support.createTicket", ctx([]), {
      title: "smuggled",
      description: "no authority",
    })) as { ok: false; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/forbidden.*support\.write/);
  });
});
