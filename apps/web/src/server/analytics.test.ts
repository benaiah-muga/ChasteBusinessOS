import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { CapabilityRegistry } from "@chaste/kernel";
import { DefaultPolicyEngine, InMemoryLedger, KernelExecutor, type ActionContext } from "@chaste/kernel";
import {
  createDb,
  customers,
  deals,
  items,
  invoices,
  memberships,
  organizations,
  stockMovements,
  users,
  type Database,
} from "@chaste/db";
import { applyFrameOps, frameOpSchema } from "@chaste/module-analytics";
import { buildRegistry } from "./kernel";

/**
 * Analytics contract against real Postgres:
 *  - extractors compute correct aggregates over seeded books
 *  - every extractor is org-scoped: a second org's data never leaks
 *  - each dataset is gated by its source module's read permission
 *  - reports render deterministic HTML/SVG tagged with the org's data region
 *  - frame ops are pure declarative transforms (no code execution surface)
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let pg: Database;
let db: Database["db"];
let registry: CapabilityRegistry;
let executor: KernelExecutor;
const orgId = crypto.randomUUID();
const otherOrgId = crypto.randomUUID();
let userId: string;
let customerA: string;

function ctxFor(type: "human" | "agent", org: string, permissions: string[]): ActionContext {
  return {
    actor: { type, id: userId, orgId: org, permissions: new Set(permissions) },
    now: new Date(),
    services: {},
  };
}

async function insertInvoice(opts: {
  orgId: string;
  customerId: string;
  number: number;
  totalMinor: number;
  paidMinor?: number;
  status?: string;
}): Promise<string> {
  const [row] = await db
    .insert(invoices)
    .values({
      orgId: opts.orgId,
      customerId: opts.customerId,
      number: opts.number,
      subtotalMinor: opts.totalMinor,
      taxMinor: 0,
      totalMinor: opts.totalMinor,
      paidMinor: opts.paidMinor ?? 0,
      status: opts.status ?? "sent",
    })
    .returning({ id: invoices.id });
  return row!.id;
}

beforeAll(async () => {
  pg = createDb(url);
  db = pg.db;
  const [user] = await db
    .insert(users)
    .values({ email: `analytics-${orgId.slice(0, 8)}@example.com`, name: "Owner" })
    .returning();
  userId = user!.id;
  await db.insert(organizations).values([
    { id: orgId, name: "Analytics Org", slug: `ana-${orgId.slice(0, 8)}`, dataRegion: "eu" },
    { id: otherOrgId, name: "Other Region Org", slug: `oth-${otherOrgId.slice(0, 8)}`, dataRegion: "us" },
  ]);
  await db.insert(memberships).values({ orgId, userId });

  const [cust] = await db
    .insert(customers)
    .values({ orgId, name: "Beta GmbH", email: "beta@x.y" })
    .returning();
  customerA = cust!.id;
  await db.insert(customers).values({ orgId, name: "Alpha SA" });
  await db.insert(customers).values({ orgId: otherOrgId, name: "Foreign LLC" });

  // Revenue spread over this month (200_00), last month (50_00) and a voided one.
  const recent = await insertInvoice({ orgId, customerId: customerA, number: 1, totalMinor: 200_00 });
  const older = await insertInvoice({ orgId, customerId: customerA, number: 2, totalMinor: 50_00 });
  await insertInvoice({ orgId, customerId: customerA, number: 3, totalMinor: 999_00, status: "void" });
  // Aging: one current partial, one 100 days old.
  await insertInvoice({ orgId, customerId: customerA, number: 4, totalMinor: 300_00, paidMinor: 100_00 });
  const stale = await insertInvoice({ orgId, customerId: customerA, number: 5, totalMinor: 400_00 });
  await db.execute(sql`UPDATE invoices SET created_at = now() - interval '100 days' WHERE id = ${stale}`);
  await db.execute(sql`UPDATE invoices SET issued_at = now() - interval '40 days' WHERE id = ${older}`);
  void recent;

  // Pipeline: two proposals (10k + 5k), one lead (20k).
  await db.insert(deals).values([
    { orgId, title: "D1", stage: "proposal", valueMinor: 10_000_00 },
    { orgId, title: "D2", stage: "proposal", valueMinor: 5_000_00 },
    { orgId, title: "D3", stage: "lead", valueMinor: 20_000_00 },
  ]);

  // Stock: widget +500 @ 200 minor cost, then -120 sale.
  const [item] = await db
    .insert(items)
    .values({ orgId, sku: "WID-1", name: "Widget", reorderPointThousandths: 0 })
    .returning();
  await db.insert(stockMovements).values([
    { orgId, itemId: item!.id, quantityDelta: 500_000, reason: "purchase", unitCostMinor: 200, actorType: "human" },
    { orgId, itemId: item!.id, quantityDelta: -120_000, reason: "sale", actorType: "agent" },
  ]);

  registry = buildRegistry(db);
  executor = new KernelExecutor({
    registry,
    policy: new DefaultPolicyEngine(),
    ledger: new InMemoryLedger(),
  });
});

afterAll(async () => {
  for (const org of [orgId, otherOrgId]) {
    await db.delete(stockMovements).where(eq(stockMovements.orgId, org));
    await db.delete(items).where(eq(items.orgId, org));
    await db.delete(deals).where(eq(deals.orgId, org));
    await db.delete(invoices).where(eq(invoices.orgId, org));
    await db.delete(customers).where(eq(customers.orgId, org));
    await db.delete(organizations).where(eq(organizations.id, org));
  }
  await db.delete(memberships).where(eq(memberships.orgId, orgId));
  await db.delete(users).where(eq(users.id, userId));
  await pg.client.end();
});

interface DatasetRows {
  region: string | null;
  columns: string[];
  rows: Record<string, unknown>[];
}

describe("analytics frame ops (pure)", () => {
  const rows = [
    { stage: "proposal", totalMinor: 10_000_00 },
    { stage: "lead", totalMinor: 20_000_00 },
    { stage: "proposal", totalMinor: 5_000_00 },
  ];

  it("validates the op schema: unknown verbs and shapes are refused", () => {
    expect(frameOpSchema.safeParse([{ op: "eval", code: "process.exit()" }]).success).toBe(false);
    expect(frameOpSchema.safeParse([{ op: "sort" }]).success).toBe(false);
  });

  it("groups and sums, sorts, and takes top N deterministically", () => {
    const grouped = applyFrameOps(rows, [
      { op: "groupBy", keys: ["stage"], aggregations: [{ column: "totalMinor", fn: "sum", as: "sumMinor" }] },
      { op: "sort", by: "sumMinor", desc: true },
      { op: "top", n: 1 },
    ]);
    expect(grouped.rows).toEqual([{ stage: "lead", sumMinor: 20_000_00 }]);
  });

  it("computes share of total", () => {
    const out = applyFrameOps(rows.slice(0, 2), [{ op: "pctOfTotal", column: "totalMinor", as: "share" }]);
    const lead = out.rows.find((r) => r.stage === "lead");
    expect(lead?.share).toBeCloseTo(20_000_00 / 30_000_00, 6);
  });
});

describe("analytics extractors", () => {
  it("reports pipeline totals with weighted forecast per stage", async () => {
    const res = await executor.execute("analytics.pipelineByStage", ctxFor("human", orgId, ["crm.read"]), {});
    expect(res.ok).toBe(true);
    const proposal = (res.data as DatasetRows)?.rows.find((r) => r.stage === "proposal");
    // Invariants hold regardless of leftovers from other suites.
    expect(Number(proposal?.count) >= 2).toBe(true);
    expect(Number(proposal?.weightedMinor)).toBe(Math.round(Number(proposal?.totalMinor) * 0.5));
    expect((res.data as DatasetRows | undefined)?.region).toBe("eu");
  });

  it("extracts monthly revenue excluding voided invoices", async () => {
    const res = await executor.execute(
      "analytics.revenueByMonth",
      ctxFor("human", orgId, ["accounting.read"]),
      { monthsBack: 3 },
    );
    expect(res.ok).toBe(true);
    const thisMonth = (res.data as DatasetRows)?.rows.find((r) => String(r.month).startsWith(new Date().toISOString().slice(0, 7)));
    expect(thisMonth && Number(thisMonth.totalMinor) >= 500_00).toBe(true); // 200 + 300, voided excluded
    expect(JSON.stringify(res.data)).not.toContain("99900");
  });

  it("buckets unpaid invoices into aging with the org's region tag", async () => {
    const res = await executor.execute("analytics.invoiceAging", ctxFor("human", orgId, ["accounting.read"]), {});
    expect(res.ok).toBe(true);
    const current = (res.data as DatasetRows)?.rows.find((r) => r.bucket === "current");
    expect(Number(current?.balanceMinor) >= 200_00).toBe(true);
    expect((res.data as DatasetRows | undefined)?.region).toBe("eu");
  });

  it("ranks customers by invoiced value within the org only", async () => {
    const res = await executor.execute(
      "analytics.salesByCustomer",
      ctxFor("human", orgId, ["accounting.read"]),
      { limit: 5 },
    );
    expect(res.ok).toBe(true);
    expect(JSON.stringify(res.data)).not.toContain("Foreign LLC");
    expect(((res.data as DatasetRows)?.rows ?? []).some((r) => r.customerName === "Beta GmbH")).toBe(true);
  });

  it("values stock from on-hand times latest unit cost", async () => {
    const res = await executor.execute("analytics.stockLevels", ctxFor("human", orgId, ["inventory.read"]), {});
    expect(res.ok).toBe(true);
    const widget = (res.data as DatasetRows)?.rows.find((r) => r.sku === "WID-1");
    expect(widget).toBeTruthy();
    // 500 - 120 = 380 units at 2.00 each = 760.00
    expect(Number(widget!.onHandThousandths)).toBe(380_000);
    expect(Number(widget!.unitCostMinor)).toBe(200);
    expect(Number(widget!.valueMinor)).toBe(76_000);
  });

  it("gates each dataset behind its source module permission, agents included", async () => {
    const noCrm = await executor.execute("analytics.pipelineByStage", ctxFor("human", orgId, ["accounting.read"]), {});
    expect(noCrm.ok).toBe(false);
    expect(noCrm.error).toMatch(/crm\.read/);

    const agentWithRead = await executor.execute(
      "analytics.revenueByMonth",
      ctxFor("agent", orgId, ["accounting.read"]),
      { monthsBack: 1 },
    );
    expect(agentWithRead.ok).toBe(true);
  });

  it("never leaks another org's data through any dataset", async () => {
    for (const [id, perms] of [
      ["analytics.pipelineByStage", ["crm.read"]],
      ["analytics.invoiceAging", ["accounting.read"]],
      ["analytics.stockLevels", ["inventory.read"]],
    ] as const) {
      const res = await executor.execute(id, ctxFor("human", orgId, [...perms]), {});
      expect(res.ok).toBe(true);
      expect(JSON.stringify(res.data)).not.toContain("Foreign LLC");
    }
  });
});

describe("analytics.renderReport", () => {
  it("renders narrative, chart SVG, exact tables, and the data region into downloadable HTML", async () => {
    const pipeline = await executor.execute("analytics.pipelineByStage", ctxFor("human", orgId, ["*"]), {});
    const aging = await executor.execute("analytics.invoiceAging", ctxFor("human", orgId, ["accounting.read"]), {});
    expect(pipeline.ok && aging.ok).toBe(true);

    const report = await executor.execute(
      "analytics.renderReport",
      ctxFor("human", orgId, ["analytics.report"]),
      {
      title: "Q3 review",
      narrative: "Pipeline holds steady; collections need attention.",
      sections: [
        {
          heading: "Pipeline",
          columns: ["stage", "count", "totalMinor"],
          rows: (pipeline.data as DatasetRows).rows,
          ops: [],
          chart: { type: "bar", x: "stage", y: ["totalMinor"] },
        },
        {
          heading: "Aging",
          columns: ["bucket", "balanceMinor"],
          rows: (aging.data as DatasetRows).rows,
          ops: [{ op: "top", n: 2 }],
        },
      ],
    });
    expect(report.ok).toBe(true);
    const html = (report.data as { html: string }).html;
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Q3 review");
    expect(html).toContain("Data region: eu");
    expect(html).toContain("collections need attention");
    expect(html).toContain("<svg"); // chart rendered server-side
    expect((report.data as { sections: unknown[] }).sections).toHaveLength(2);

    // The renderer is refused without its formatting-only permission, even
    // though the caller holds source-module reads.
    const denied = await executor.execute(
      "analytics.renderReport",
      ctxFor("human", orgId, ["accounting.read"]),
      { title: "x", sections: [{ heading: "h", columns: ["a"], rows: [{ a: 1 }], ops: [] }] },
    );
    expect(denied.ok).toBe(false);
  });
});
