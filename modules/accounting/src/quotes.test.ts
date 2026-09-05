import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { accounts, createDb, customers, journalEntries, journalLines, organizations, quotes, type Database } from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerAccountingCapabilities, createAccountingSignalProducer, type ModuleDeps } from "./index";

/**
 * Quote lifecycle proof (M9.1): an expired quote cannot be accepted — the
 * refusal is honest and actionable — the sweep archives lapsed quotes
 * idempotently, the expired-quote signal names the governed decline, and a
 * quote without an expiry still converts through the one shared invoice
 * write path (books stay balanced).
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;
let customerId: string;

function makeRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registerAccountingCapabilities(registry, deps);
  return registry;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads heterogeneous capability outputs; each assertion narrows its shape
async function run<I>(id: string, input: I): Promise<any> {
  const cap = makeRegistry().get(id);
  if (!cap) throw new Error(`missing capability ${id}`);
  return cap.execute(ctx, input);
}

async function purgeProbeOrgs(): Promise<void> {
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Quotes Probe"));
  for (const o of orgs) {
    const entries = await db.db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.orgId, o.id));
    for (const e of entries) {
      await db.db.delete(journalLines).where(eq(journalLines.entryId, e.id));
    }
    await db.db.delete(journalEntries).where(eq(journalEntries.orgId, o.id));
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await purgeProbeOrgs();
  await db.db.insert(organizations).values({ id: orgId, name: "Quotes Probe", slug: `q-${orgId.slice(0, 8)}` });
  await db.db.insert(accounts).values([
    { orgId, code: "1100", name: "Accounts Receivable", type: "asset" },
    { orgId, code: "2100", name: "Sales Tax Payable", type: "liability" },
    { orgId, code: "4000", name: "Sales Revenue", type: "income" },
  ]);
  const [cust] = await db.db.insert(customers).values({ orgId, name: "Quote Buyer" }).returning({ id: customers.id });
  customerId = cust!.id;
  ctx = {
    actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };
});

afterAll(async () => {
  await purgeProbeOrgs();
});

describe("quote lifecycle (M9.1)", () => {
  it("accepting an expired quote is refused with an honest error", async () => {
    const q = await run("accounting.createQuote", {
      customerId,
      expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
      lines: [{ description: "Legacy migration", quantity: 1_000, unitPriceMinor: 5_000_00 }],
    });
    await expect(run("accounting.acceptQuote", { quoteId: q.quoteId })).rejects.toThrow(/quote expired on/);
  });

  it("the sweep archives lapsed quotes idempotently and the signal names the decline", async () => {
    const first = await run("accounting.expireQuote", {});
    expect(first.expiredCount).toBeGreaterThanOrEqual(1);
    const again = await run("accounting.expireQuote", {});
    expect(again.expiredCount).toBe(0);

    const [row] = await db.db.select({ status: quotes.status }).from(quotes).where(eq(quotes.orgId, orgId));
    expect(row!.status).toBe("expired");

    const signals = await createAccountingSignalProducer(deps.db)(orgId, new Date());
    const expired = signals.filter((s) => s.id.startsWith("accounting.quoteExpired:"));
    // The row is already marked expired, so the producer stays quiet —
    // signals point at lapsed-but-unmarked quotes only.
    expect(expired).toHaveLength(0);
  });

  it("a lapsed-but-unmarked quote raises a red signal suggesting the governed decline", async () => {
    const q = await run("accounting.createQuote", {
      customerId,
      expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
      lines: [{ description: "Lapsed offer", quantity: 2_000, unitPriceMinor: 1_000_00 }],
    });
    const signals = await createAccountingSignalProducer(deps.db)(orgId, new Date());
    const hit = signals.find((s) => s.id === `accounting.quoteExpired:${q.quoteId}`);
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("red");
    expect(hit!.suggestedAction?.capabilityId).toBe("accounting.declineQuote");
  });

  it("a quote without expiry still converts and keeps books balanced", async () => {
    const q = await run("accounting.createQuote", {
      customerId,
      lines: [{ description: "Fresh offer", quantity: 1_000, unitPriceMinor: 10_000_00 }],
    });
    const accepted = await run("accounting.acceptQuote", { quoteId: q.quoteId });
    expect(accepted.totalMinor).toBe(1_000_000);
    const [drift] = await db.db
      .select({ d: sql<number>`coalesce(sum(${journalLines.debitMinor} - ${journalLines.creditMinor}), 0)` })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(eq(journalEntries.orgId, orgId));
    expect(Number(drift!.d)).toBe(0);
  });
});
