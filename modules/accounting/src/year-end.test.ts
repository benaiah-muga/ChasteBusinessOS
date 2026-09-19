import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  accounts,
  createDb,
  journalEntries,
  organizations,
  periods,
  purgeTenantFinancials,
  withOrgContext,
  type Database,
} from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerAccountingCapabilities, type ModuleDeps } from "./index";
import { postEntry } from "./posting";

/**
 * N13: exceptional entries are modeled explicitly. The year-end roll carries
 * its own kind, one live roll per sealed year, replaced inside the reopened
 * December on re-close; the P&L report survives the close; corrections post
 * in an approved open period while carrying the original business date; and
 * pre-resolved account ids are validated for posting eligibility in the one
 * door to the ledger.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
const otherOrgId = crypto.randomUUID();
let ctx: ActionContext;

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

function post(
  cmd: Partial<Parameters<typeof postEntry>[3]> & { lines: Array<{ accountCode?: string; accountId?: string; debitMinor: number; creditMinor: number }> },
  at: Date,
): Promise<string> {
  return withOrgContext(db.db, orgId, (tx) =>
    postEntry(tx, orgId, { type: "human", id: null }, { memo: "fixture", sourceType: "manual", postedAt: at, ...cmd }),
  );
}

async function purgeProbeOrgs(): Promise<void> {
  const orgs = await db.db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.name, "Year End Probe"));
  for (const o of orgs) {
    await purgeTenantFinancials(db.db, o.id);
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await purgeProbeOrgs();
  await db.db.insert(organizations).values([
    { id: orgId, name: "Year End Probe", slug: `ye-${orgId.slice(0, 8)}` },
    { id: otherOrgId, name: "Year End Probe", slug: `yo-${otherOrgId.slice(0, 8)}` },
  ]);
  await db.db.insert(accounts).values([
    { orgId, code: "1000", name: "Cash", type: "asset" },
    { orgId, code: "3100", name: "Retained Earnings", type: "equity" },
    { orgId, code: "4000", name: "Sales Revenue", type: "income" },
    { orgId, code: "5000", name: "Operating Expense", type: "expense" },
    { orgId, code: "9000", name: "Doomed Account", type: "asset" },
    { orgId: otherOrgId, code: "1000", name: "Other Org Cash", type: "asset" },
  ]);
  ctx = {
    actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) },
    now: new Date("2026-06-15T12:00:00Z"),
    services: {},
  };
});

afterAll(async () => {
  await purgeProbeOrgs();
});

describe("N13 exceptional entries and posting eligibility", () => {
  it("refuses to post through a pre-resolved account that is archived or foreign", async () => {
    const [doomed] = await db.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.orgId, orgId), eq(accounts.code, "9000")));
    const [foreign] = await db.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.orgId, otherOrgId), eq(accounts.code, "1000")));

    await post({ lines: [{ accountCode: "1000", debitMinor: 100, creditMinor: 0 }, { accountId: doomed!.id, debitMinor: 0, creditMinor: 100 }] }, new Date("2025-01-10T00:00:00Z"));
    await db.db.update(accounts).set({ archivedAt: new Date() }).where(eq(accounts.id, doomed!.id));
    await expect(
      post({ lines: [{ accountCode: "1000", debitMinor: 100, creditMinor: 0 }, { accountId: doomed!.id, debitMinor: 0, creditMinor: 100 }] }, new Date("2025-01-11T00:00:00Z")),
    ).rejects.toThrow(/archived; reopen it before posting/);
    await expect(
      post({ lines: [{ accountCode: "1000", debitMinor: 100, creditMinor: 0 }, { accountId: foreign!.id, debitMinor: 0, creditMinor: 100 }] }, new Date("2025-01-12T00:00:00Z")),
    ).rejects.toThrow(/does not belong to this organization/);
  });

  it("stamps corrections with the original business date, posting in the approved open period", async () => {
    const originalAt = new Date("2024-03-20T10:00:00Z");
    const entryId = await post(
      { memo: "misposted march expense", lines: [{ accountCode: "5000", debitMinor: 50_000, creditMinor: 0 }, { accountCode: "1000", debitMinor: 0, creditMinor: 50_000 }] },
      originalAt,
    );
    await run("accounting.closePeriod", { year: 2024, month: 3 });

    const { reversalEntryId } = await run("accounting.reverseEntry", { entryId });
    const [mirror] = await db.db.select().from(journalEntries).where(eq(journalEntries.id, reversalEntryId));
    expect(mirror!.entryKind).toBe("correction");
    expect(mirror!.businessAt!.toISOString()).toBe(originalAt.toISOString());
    expect(mirror!.postedAt.toISOString()).toBe(ctx.now.toISOString());

    // 2024 also books revenue so the year has a closable result; the roll it
    // produces must not be reversible through the generic mirror.
    await post(
      { memo: "2024 revenue", lines: [{ accountCode: "1000", debitMinor: 120_000, creditMinor: 0 }, { accountCode: "4000", debitMinor: 0, creditMinor: 120_000 }] },
      new Date("2024-07-01T00:00:00Z"),
    );
    const close = await run("accounting.closeYear", { year: 2024 });
    await expect(run("accounting.reverseEntry", { entryId: close.closingEntryId })).rejects.toThrow(
      /replaced by accounting\.closeYear/,
    );
  });

  it("closes 2025 with an explicit year_end_close roll and the P&L report survives it", async () => {
    await post(
      { memo: "revenue", lines: [{ accountCode: "1000", debitMinor: 800_000, creditMinor: 0 }, { accountCode: "4000", debitMinor: 0, creditMinor: 800_000 }] },
      new Date("2025-05-01T00:00:00Z"),
    );
    await post(
      { memo: "expense", lines: [{ accountCode: "5000", debitMinor: 300_000, creditMinor: 0 }, { accountCode: "1000", debitMinor: 0, creditMinor: 300_000 }] },
      new Date("2025-06-01T00:00:00Z"),
    );
    const before = await run("accounting.incomeStatement", {});
    // Self-contained: whatever the all-time operating revenue is (this file
    // alone: 800k; full suite: 2024 adds 120k), the close must not change it.
    const beforeRevenue = before.revenueMinor;
    expect(beforeRevenue).toBeGreaterThanOrEqual(800_000);

    const close = await run("accounting.closeYear", { year: 2025 });
    expect(close.replacedEntryId).toBeNull();
    expect(close.netIncomeMinor).toBe(500_000);
    const [roll] = await db.db.select().from(journalEntries).where(eq(journalEntries.id, close.closingEntryId));
    expect(roll!.entryKind).toBe("year_end_close");
    expect(roll!.postedAt.toISOString()).toBe("2025-12-31T23:59:59.000Z");

    const after = await run("accounting.incomeStatement", {});
    expect(after.revenueMinor).toBe(beforeRevenue);
    expect(after.netIncomeMinor).toBe(before.netIncomeMinor);
    expect((await run("accounting.balanceSheet", {})).balanced).toBe(true);
    expect((await run("accounting.trialBalance", {})).balanced).toBe(true);

    await expect(run("accounting.closeYear", { year: 2025 })).rejects.toThrow(/period 2025-12 is closed/);
  });

  it("two concurrent closes of one year produce exactly one live roll", async () => {
    await post(
      { memo: "2027 revenue", lines: [{ accountCode: "1000", debitMinor: 400_000, creditMinor: 0 }, { accountCode: "4000", debitMinor: 0, creditMinor: 400_000 }] },
      new Date("2027-02-01T00:00:00Z"),
    );
    // Both pass the live-roll check before either commits; the shared
    // posting lock serializes the rolls and the loser must fail closed
    // (December is sealed by the winner) instead of rolling twice.
    const outcomes = await Promise.allSettled([
      run("accounting.closeYear", { year: 2027 }),
      run("accounting.closeYear", { year: 2027 }),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rolls = await db.db
      .select({ id: journalEntries.id, reversalOfId: journalEntries.reversalOfId })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.orgId, orgId),
          eq(journalEntries.entryKind, "year_end_close"),
          sql`extract(year from ${journalEntries.postedAt}) = 2027`,
        ),
      );
    const reversedIds = new Set(rolls.map((r) => r.reversalOfId).filter((v): v is string => v !== null));
    const live = rolls.filter((r) => r.reversalOfId === null && !reversedIds.has(r.id));
    expect(live).toHaveLength(1);
    expect((await run("accounting.balanceSheet", {})).balanced).toBe(true);
    expect((await run("accounting.trialBalance", {})).balanced).toBe(true);
  });

  it("re-closing a reopened year replaces the live roll and rolls the full year once", async () => {
    await post(
      { memo: "2026 revenue", lines: [{ accountCode: "1000", debitMinor: 400_000, creditMinor: 0 }, { accountCode: "4000", debitMinor: 0, creditMinor: 400_000 }] },
      new Date("2026-02-01T00:00:00Z"),
    );
    await post(
      { memo: "2026 expense", lines: [{ accountCode: "5000", debitMinor: 100_000, creditMinor: 0 }, { accountCode: "1000", debitMinor: 0, creditMinor: 100_000 }] },
      new Date("2026-03-01T00:00:00Z"),
    );
    const first = await run("accounting.closeYear", { year: 2026 });
    expect(first.replacedEntryId).toBeNull();
    expect(first.netIncomeMinor).toBe(300_000);

    await run("accounting.reopenPeriod", { year: 2026, month: 12 });
    await post(
      { memo: "late 2026 revenue", lines: [{ accountCode: "1000", debitMinor: 50_000, creditMinor: 0 }, { accountCode: "4000", debitMinor: 0, creditMinor: 50_000 }] },
      new Date("2026-12-20T00:00:00Z"),
    );

    const reclose = await run("accounting.closeYear", { year: 2026 });
    expect(reclose.replacedEntryId).toBe(first.closingEntryId);
    expect(reclose.netIncomeMinor).toBe(350_000);

    const rolls = await db.db
      .select({ id: journalEntries.id, reversalOfId: journalEntries.reversalOfId })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.orgId, orgId),
          eq(journalEntries.entryKind, "year_end_close"),
          sql`extract(year from ${journalEntries.postedAt}) = 2026`,
        ),
      );
    const reversedIds = new Set(rolls.map((r) => r.reversalOfId).filter((v): v is string => v !== null));
    const live = rolls.filter((r) => r.reversalOfId === null && !reversedIds.has(r.id));
    expect(live).toHaveLength(1);
    expect(live[0]!.id).toBe(reclose.closingEntryId);
    expect(rolls.find((r) => r.reversalOfId === reclose.replacedEntryId)).toBeTruthy();

    expect((await run("accounting.balanceSheet", {})).balanced).toBe(true);
    expect((await run("accounting.trialBalance", {})).balanced).toBe(true);
    const sealed = await db.db
      .select({ month: periods.month })
      .from(periods)
      .where(and(eq(periods.orgId, orgId), eq(periods.year, 2026)));
    expect(sealed.map((p) => p.month)).toContain(12);
  });
});
