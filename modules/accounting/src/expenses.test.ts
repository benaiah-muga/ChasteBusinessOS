import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  createDb,
  expenseClaims,
  organizations,
  users,
  type Database,
} from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerAccountingCapabilities, createAccountingSignalProducer, type ModuleDeps } from "./index";

/**
 * Expenses depth (M11.6, ADR 0038): rules-first categories with human
 * override, receipt attachment (stored; degrades when Documents is off —
 * proven in the demo subset), per-category policy limits surfaced as
 * signals, and duplicate-claim detection.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;
const claimantId = crypto.randomUUID();

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
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Expense Depth Probe"));
  for (const o of orgs) await db.db.delete(organizations).where(eq(organizations.id, o.id));
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await purgeProbeOrgs();
  await db.db.insert(organizations).values({ id: orgId, name: "Expense Depth Probe", slug: `ex-${orgId.slice(0, 8)}` });
  await db.db.insert(users).values({ id: claimantId, email: `claimant-${Date.now()}@demo.test`, name: "Claimant" });
  await db.db.insert(users).values({ id: crypto.randomUUID(), email: `x-${Date.now()}@demo.test`, name: "X" });
  ctx = {
    actor: { type: "human", id: claimantId, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };
});

afterAll(async () => {
  await purgeProbeOrgs();
});

describe("expenses depth (M11.6)", () => {
  it("categorizes from the memo, honors overrides, stores the receipt", async () => {
    const a = await run("accounting.submitExpenseClaim", {
      amountMinor: 3_500,
      memo: "Taxi to the airport for the client visit",
    });
    expect(a.category).toBe("travel");
    const receiptId = crypto.randomUUID();
    const b = await run("accounting.submitExpenseClaim", {
      amountMinor: 1_200,
      memo: "Team lunch",
      category: "client-entertainment", // human override wins
      documentId: receiptId,
    });
    expect(b.category).toBe("client-entertainment");
    const [row] = await db.db
      .select({ category: expenseClaims.category, documentId: expenseClaims.documentId })
      .from(expenseClaims)
      .where(eq(expenseClaims.id, b.claimId));
    expect(row!.category).toBe("client-entertainment");
    expect(row!.documentId).toBe(receiptId);
    void a;
  });

  it("policy limits flag over-limit claims as signals", async () => {
    await run("accounting.setExpensePolicy", { category: "travel", limitMinor: 50_000 });
    const over = await run("accounting.submitExpenseClaim", {
      amountMinor: 80_000,
      memo: "Flight to the regional summit",
    });
    expect(over.overPolicyLimit).toBe(true);
    expect(over.policyLimitMinor).toBe(50_000);

    const signals = await createAccountingSignalProducer(deps.db)(orgId, new Date());
    const hit = signals.find((s) => s.id === `accounting.policyOverrun:${over.claimId}`);
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("orange");
  });

  it("duplicate claims raise a signal", async () => {
    await run("accounting.submitExpenseClaim", { amountMinor: 4_400, memo: "Parking fee" });
    await run("accounting.submitExpenseClaim", { amountMinor: 4_400, memo: "Parking fee again (resubmit)" });
    const signals = await createAccountingSignalProducer(deps.db)(orgId, new Date());
    const dupes = signals.filter((s) => s.id.startsWith("accounting.duplicateClaim:"));
    expect(dupes.length).toBeGreaterThanOrEqual(1);
    const [row] = await db.db
      .select({ n: sql<number>`count(*)` })
      .from(expenseClaims)
      .where(eq(expenseClaims.orgId, orgId));
    expect(Number(row!.n)).toBeGreaterThanOrEqual(2);
  });
});
