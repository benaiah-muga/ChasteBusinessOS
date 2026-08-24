import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { CapabilityRegistry } from "@chaste/kernel";
import { DefaultPolicyEngine, InMemoryLedger, KernelExecutor, type ActionContext } from "@chaste/kernel";
import { createDb, customers, deals, memberships, organizations, users, type Database } from "@chaste/db";
import { buildRegistry } from "./kernel";

/**
 * CRM module contract against real Postgres:
 *  - customer lifecycle: create → list → deactivate → hidden from list,
 *    history intact (soft delete only)
 *  - deal lifecycle: create with optional customer link → stage moves
 *    validated against the known stages
 *  - pipeline report math: stage totals move by exactly the deal's value
 *  - org isolation: another org's rows are invisible to every capability
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

interface CustomerRow {
  id: string;
  name: string;
}
interface ListCustomersData {
  customers: CustomerRow[];
}
interface StageRow {
  stage: string;
  totalMinor: number;
}
interface PipelineReportData {
  stages: StageRow[];
  weightedForecastMinor: number;
}

let pg: Database;
let db: Database["db"];
let registry: CapabilityRegistry;
let executor: KernelExecutor;
const orgId = crypto.randomUUID();
const otherOrgId = crypto.randomUUID();
let userId: string;

function ctxFor(type: "human" | "agent", org: string, permissions: string[]): ActionContext {
  return {
    actor: { type, id: userId, orgId: org, permissions: new Set(permissions) },
    now: new Date(),
    services: {},
  };
}

beforeAll(async () => {
  pg = createDb(url);
  db = pg.db;
  const [user] = await db
    .insert(users)
    .values({ email: `crm-${orgId.slice(0, 8)}@example.com`, name: "Owner" })
    .returning();
  userId = user!.id;
  await db.insert(organizations).values([
    { id: orgId, name: "CRM Org", slug: `crm-${orgId.slice(0, 8)}` },
    { id: otherOrgId, name: "Other Org", slug: `other-${otherOrgId.slice(0, 8)}` },
  ]);
  await db.insert(memberships).values({ orgId, userId });

  registry = buildRegistry(db);
  executor = new KernelExecutor({
    registry,
    policy: new DefaultPolicyEngine(),
    ledger: new InMemoryLedger(),
  });
});

afterAll(async () => {
  for (const org of [orgId, otherOrgId]) {
    const orgCustomers = await db.select().from(customers).where(eq(customers.orgId, org));
    for (const c of orgCustomers) await db.delete(deals).where(eq(deals.customerId, c.id));
    await db.delete(deals).where(eq(deals.orgId, org));
    await db.delete(customers).where(eq(customers.orgId, org));
    await db.delete(organizations).where(eq(organizations.id, org));
  }
  await db.delete(memberships).where(eq(memberships.orgId, orgId));
  await db.delete(users).where(eq(users.id, userId));
  await pg.client.end();
});

describe("crm customer lifecycle", () => {
  it("creates a customer and lists it", async () => {
    const created = await executor.execute("crm.createCustomer", ctxFor("human", orgId, ["crm.write"]), {
      name: "Acme Ltd",
      email: "acme@example.com",
    });
    expect(created.ok).toBe(true);

    const listed = await executor.execute("crm.listCustomers", ctxFor("human", orgId, ["crm.read"]), {});
    expect(listed.ok).toBe(true);
    expect((listed.data as ListCustomersData)?.customers.some((c) => c.name === "Acme Ltd")).toBe(true);
  });

  it("deactivates softly: hidden from list, row still present", async () => {
    const [row] = await db
      .insert(customers)
      .values({ orgId, name: "Ghost Co" })
      .returning();

    const off = await executor.execute("crm.deactivateCustomer", ctxFor("human", orgId, ["crm.write"]), {
      customerId: row!.id,
    });
    expect(off.ok).toBe(true);

    const listed = await executor.execute("crm.listCustomers", ctxFor("human", orgId, ["crm.read"]), {});
    expect((listed.data as ListCustomersData)?.customers.some((c) => c.id === row!.id)).toBe(false);

    const [still] = await db.select().from(customers).where(eq(customers.id, row!.id));
    expect(still!.name).toBe("Ghost Co");
    expect(still!.deactivatedAt).not.toBeNull();
  });

  it("refuses writes without crm.write and reads without crm.read", async () => {
    const deniedWrite = await executor.execute("crm.createCustomer", ctxFor("human", orgId, []), { name: "X" });
    expect(deniedWrite.ok).toBe(false);
    expect(deniedWrite.error).toMatch(/permission/);

    const deniedRead = await executor.execute("crm.listCustomers", ctxFor("human", orgId, ["crm.write"]), {});
    expect(deniedRead.ok).toBe(false);
  });
});

describe("crm deals and pipeline", () => {
  it("moves a deal through stages and shifts the report by exactly its value", async () => {
    const before = await executor.execute("crm.pipelineReport", ctxFor("human", orgId, ["crm.read"]), {});
    const proposalBefore = (before.data as PipelineReportData)?.stages
      .find((s: StageRow) => s.stage === "proposal")?.totalMinor ?? 0;

    const deal = await executor.execute("crm.createDeal", ctxFor("human", orgId, ["crm.write"]), {
      title: "Big rollout",
      valueMinor: 10_000_00,
    });
    expect(deal.ok).toBe(true);
    const dealId = (deal.data as { dealId: string }).dealId;

    for (const stage of ["qualified", "proposal"] as const) {
      const moved = await executor.execute("crm.moveDealStage", ctxFor("agent", orgId, ["crm.write"]), {
        dealId,
        stage,
      });
      expect(moved.ok).toBe(true);
    }

    // Unknown stage is rejected by input validation.
    const bad = await executor.execute("crm.moveDealStage", ctxFor("human", orgId, ["crm.write"]), {
      dealId,
      stage: "skyrocketing",
    });
    expect(bad.ok).toBe(false);

    const [row] = await db.select().from(deals).where(eq(deals.id, dealId));
    expect(row!.stage).toBe("proposal");

    const after = await executor.execute("crm.pipelineReport", ctxFor("human", orgId, ["crm.read"]), {});
    const proposalAfter = (after.data as PipelineReportData)?.stages
      .find((s: StageRow) => s.stage === "proposal")?.totalMinor ?? 0;
    expect(proposalAfter - proposalBefore).toBe(10_000_00);

    // Won deals drop out of the open weighted forecast entirely: net change
    // versus the pre-deal baseline is zero.
    await executor.execute("crm.moveDealStage", ctxFor("human", orgId, ["crm.write"]), { dealId, stage: "won" });
    const won = await executor.execute("crm.pipelineReport", ctxFor("human", orgId, ["crm.read"]), {});
    expect(
      ((won.data as PipelineReportData)?.weightedForecastMinor ?? 0) -
        ((before.data as PipelineReportData)?.weightedForecastMinor ?? 0),
    ).toBe(0);
  });

  it("links a deal to a customer", async () => {
    const [cust] = await db.select().from(customers).where(eq(customers.orgId, orgId)).limit(1);
    const deal = await executor.execute("crm.createDeal", ctxFor("human", orgId, ["crm.write"]), {
      title: "Linked deal",
      valueMinor: 5_000_00,
      customerId: cust!.id,
    });
    expect(deal.ok).toBe(true);
    const dealId = (deal.data as { dealId: string }).dealId;
    const [row] = await db.select().from(deals).where(eq(deals.id, dealId));
    expect(row!.customerId).toBe(cust!.id);
  });
});

describe("crm org isolation", () => {
  it("never sees another org's customers or deals", async () => {
    const [foreignCustomer] = await db
      .insert(customers)
      .values({ orgId: otherOrgId, name: "Foreign Customer" })
      .returning();

    const listed = await executor.execute("crm.listCustomers", ctxFor("human", orgId, ["*"]), {});
    expect((listed.data as ListCustomersData)?.customers.some((c) => c.id === foreignCustomer!.id)).toBe(false);

    // A foreign customer id is refused outright; the pivot fails closed.
    const deal = await executor.execute("crm.createDeal", ctxFor("human", orgId, ["*"]), {
      title: "Pivot attempt",
      valueMinor: 100,
      customerId: foreignCustomer!.id,
    });
    expect(deal.ok).toBe(false);
    expect(deal.error).toMatch(/not found/);
  });
});
