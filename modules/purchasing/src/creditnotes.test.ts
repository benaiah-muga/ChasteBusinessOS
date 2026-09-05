import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  accounts,
  createDb,
  journalEntries,
  journalLines,
  organizations,
  vendorBills,
  vendors,
  type Database,
} from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerPurchasingCapabilities, type ModuleDeps } from "./index";

/**
 * AP credit notes (M10.1, ADR 0037): always-gate money class, mirror entry
 * (DR AP, CR expenses), immutable credited column, honest over-credit
 * refusal, books balanced.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;
let vendorId: string;

function makeRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registerPurchasingCapabilities(registry, deps);
  return registry;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads heterogeneous capability outputs; each assertion narrows its shape
async function run<I>(id: string, input: I): Promise<any> {
  const cap = makeRegistry().get(id);
  if (!cap) throw new Error(`missing capability ${id}`);
  return cap.execute(ctx, input);
}

async function purgeProbeOrgs(): Promise<void> {
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "AP Credit Probe"));
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
  await db.db.insert(organizations).values({ id: orgId, name: "AP Credit Probe", slug: `ap-${orgId.slice(0, 8)}` });
  await db.db.insert(accounts).values([
    { orgId, code: "1000", name: "Cash", type: "asset" },
    { orgId, code: "2000", name: "Accounts Payable", type: "liability" },
    { orgId, code: "6000", name: "Operating Expenses", type: "expense" },
  ]);
  const [vendor] = await db.db.insert(vendors).values({ orgId, name: "Credit Giver Ltd" }).returning({ id: vendors.id });
  vendorId = vendor!.id;
  ctx = {
    actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };
});

afterAll(async () => {
  await purgeProbeOrgs();
});

describe("AP credit notes (M10.1)", () => {
  it("always gates: moneyAmount is null regardless of input", () => {
    const cap = makeRegistry().get("purchasing.billCreditNote");
    expect(cap?.moneyAmount?.({ billId: "x", amountMinor: 1, reason: "any" } as never)).toBeNull();
  });

  it("credits the bill through a mirror entry and keeps books balanced", async () => {
    const bill = await run("purchasing.createBill", {
      vendorId,
      lines: [{ description: "Consulting retainer", quantity: 1_000, unitPriceMinor: 500_00, expenseAccountCode: "6000" }],
    });
    expect(bill.totalMinor).toBe(500_00);

    const credited = await run("purchasing.billCreditNote", {
      billId: (await db.db.select({ id: vendorBills.id }).from(vendorBills).where(eq(vendorBills.orgId, orgId)))[0]!.id,
      amountMinor: 100_00,
      reason: "service credit issued by vendor",
    });
    expect(credited.billBalanceMinor).toBe(400_00);
    expect(credited.creditedMinor).toBe(100_00);

    const mirror = await db.db
      .select({ code: accounts.code, debit: journalLines.debitMinor, credit: journalLines.creditMinor })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
      .where(eq(journalEntries.sourceType, "vendor_credit_note"));
    const byCode = new Map(mirror.map((l) => [l.code, l]));
    expect(byCode.get("2000")).toMatchObject({ debit: 100_00, credit: 0 });
    expect(byCode.get("6000")).toMatchObject({ debit: 0, credit: 100_00 });

    const [row] = await db.db
      .select({ drift: sql<number>`coalesce(sum(${journalLines.debitMinor} - ${journalLines.creditMinor}), 0)` })
      .from(journalLines);
    expect(Number(row!.drift)).toBe(0);
  });

  it("refuses to credit more than the open balance", async () => {
    const billId = (await db.db.select({ id: vendorBills.id }).from(vendorBills).where(eq(vendorBills.orgId, orgId)))[0]!.id;
    await expect(
      run("purchasing.billCreditNote", { billId, amountMinor: 999_00, reason: "too much credit" }),
    ).rejects.toThrow(/exceeds the open balance/);
  });
});
