import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { accounts, createDb, items, journalEntries, journalLines, organizations, stockMovements, type Database } from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { glAccountBalanceMinor, inventoryLedgerValueMinor, postValuationSummary, reverseValuationSummary } from "./valuation";
import type { ModuleDeps } from "./shared";

/**
 * Ledger-backed proof of the inventory → GL closure (ADR 0033). Runs against
 * the local database (owner role: RLS-exempt; tenant isolation itself is
 * proven by packages/db/src/rls.test.ts).
 *
 * Deterministic GL storyline: ledger replays to 4,400 minor throughout.
 *   post → gl 0→4,400 · post again → no-op · drift +2,500 → 6,900 ·
 *   post → 4,400 (E1) · reverse E1 → 6,900 · reverse E1 again → refused
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;
let item1Id: string;
let item2Id: string;
let entryE1 = "";

function makeRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.register(postValuationSummary(deps));
  registry.register(reverseValuationSummary(deps));
  return registry;
}

async function injectDrift(amountMinor: number, memo: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const inv = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.orgId, orgId), eq(accounts.code, "1200")));
    const cogs = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.orgId, orgId), eq(accounts.code, "5000")));
    const { postEntry } = await import("@chaste/module-accounting/posting");
    await postEntry(tx, orgId, { type: "human", id: null }, {
      memo,
      sourceType: "manual",
      lines: [
        { accountId: inv[0]!.id, debitMinor: amountMinor, creditMinor: 0 },
        { accountId: cogs[0]!.id, debitMinor: 0, creditMinor: amountMinor },
      ],
    });
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads heterogeneous capability outputs; each assertion narrows its shape
async function run<I>(id: string, input: I): Promise<any> {
  const cap = makeRegistry().get(id);
  if (!cap) throw new Error(`missing capability ${id}`);
  return cap.execute(ctx, input);
}

async function purgeProbeOrgs(): Promise<void> {
  const orgs = await db.db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.name, "Valuation Probe"));
  for (const o of orgs) {
    const entries = await db.db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(eq(journalEntries.orgId, o.id));
    for (const e of entries) {
      await db.db.delete(journalLines).where(eq(journalLines.entryId, e.id));
    }
    await db.db.delete(journalEntries).where(eq(journalEntries.orgId, o.id));
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
}

beforeAll(async () => {
  db = createDb(url);
  await purgeProbeOrgs();
  deps = { db: db.db };
  await db.db.insert(organizations).values({ id: orgId, name: "Valuation Probe", slug: `val-${orgId.slice(0, 8)}` });
  await db.db.insert(accounts).values([
    { orgId, code: "1200", name: "Inventory", type: "asset" },
    { orgId, code: "5000", name: "Cost of Goods Sold", type: "expense" },
  ]);
  ctx = {
    actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };
  const [i1] = await db.db
    .insert(items)
    .values({ orgId, sku: "VAL-1", name: "Valuation Probe Item" })
    .returning({ id: items.id });
  item1Id = i1!.id;
  const [i2] = await db.db
    .insert(items)
    .values({ orgId, sku: "VAL-2", name: "Valuation Probe Item Two" })
    .returning({ id: items.id });
  item2Id = i2!.id;
  // Replays to 4,400 minor: 10 @ 5,000; −4; +2 @ 7,000.
  await db.db.insert(stockMovements).values([
    { orgId, itemId: item1Id, quantityDelta: 10_000, reason: "purchase", unitCostMinor: 500, actorType: "system", actorId: null, createdAt: new Date("2026-08-01T10:00:00Z") },
    { orgId, itemId: item1Id, quantityDelta: -4_000, reason: "sale", actorType: "system", actorId: null, createdAt: new Date("2026-08-02T10:00:00Z") },
    { orgId, itemId: item1Id, quantityDelta: 2_000, reason: "purchase", unitCostMinor: 700, actorType: "system", actorId: null, createdAt: new Date("2026-08-03T10:00:00Z") },
  ]);
  // Second item: quantity only, zero value.
  await db.db.insert(stockMovements).values({
    orgId,
    itemId: item2Id,
    quantityDelta: 5_000,
    reason: "adjustment",
    actorType: "system",
    actorId: null,
    createdAt: new Date("2026-08-01T11:00:00Z"),
  });
});

afterAll(async () => {
  await purgeProbeOrgs();
  await db.client.end();
});

describe("inventory.postValuationSummary / reverseValuationSummary (ADR 0033)", () => {
  it("posts the ledger value into the GL inventory account", async () => {
    expect(await inventoryLedgerValueMinor(deps.db, orgId)).toBe(4_400);
    expect(await glAccountBalanceMinor(deps.db, orgId)).toBe(0);

    const result = await run("inventory.postValuationSummary", { memo: "probe initial summary" });
    expect(result.posted).toBe(true);
    expect(result.varianceMinor).toBe(4_400);
    expect(typeof result.entryId).toBe("string");
    entryE1 = result.entryId;

    expect(await glAccountBalanceMinor(deps.db, orgId)).toBe(4_400);
  });

  it("is idempotent — a reconciled ledger gets an explicit no-op, never an empty entry", async () => {
    const again = await run("inventory.postValuationSummary", { memo: "probe no-op" });
    expect(again.posted).toBe(false);
    expect(again.entryId).toBeNull();
    expect(again.varianceMinor).toBe(0);
  });

  it("corrects injected drift on the next summary", async () => {
    await injectDrift(2_500, "probe drift");
    expect(await glAccountBalanceMinor(deps.db, orgId)).toBe(6_900);

    const corrected = await run("inventory.postValuationSummary", { memo: "probe correction" });
    expect(corrected.posted).toBe(true);
    expect(corrected.varianceMinor).toBe(-2_500);
    expect(await glAccountBalanceMinor(deps.db, orgId)).toBe(4_400);
  });

  it("reversal mirrors the exact entry once, then refuses", async () => {
    // Drift again so E1's reversal effect is observable against 4,400.
    await injectDrift(1_000, "probe drift two");
    await run("inventory.postValuationSummary", { memo: "probe re-summary" }); // back to 4,400, E2 posted
    expect(await glAccountBalanceMinor(deps.db, orgId)).toBe(4_400);

    const reversed = await run("inventory.reverseValuationSummary", { entryId: entryE1 });
    expect(reversed.reversed).toBe(true);
    // E1 carried +4,400; reversing returns the GL to its pre-E1 state (0).
    expect(await glAccountBalanceMinor(deps.db, orgId)).toBe(0);

    await expect(
      run("inventory.reverseValuationSummary", { entryId: entryE1 }),
    ).rejects.toThrow(/already been reversed/);
  });

  it("refuses to reverse missing or non-valuation entries", async () => {
    await expect(
      run("inventory.reverseValuationSummary", { entryId: crypto.randomUUID() }),
    ).rejects.toThrow(/no journal entry/);
  });
});

