import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import {
  accounts,
  createDb,
  customers,
  expenseClaims,
  invoices,
  journalEntries,
  organizations,
  periods,
  users,
  type Database,
  purgeTenantFinancials,
} from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerAccountingCapabilities, type ModuleDeps } from "./index";
import { lockPeriodsForOrg, postEntry } from "./posting";

/**
 * N13: the closed-period guard lives in the shared posting service, not in
 * per-caller discipline. Every producer (expense claims, direct postings,
 * year-end close) refuses a sealed month, close/reopen runs under the same
 * lock as posting, and a synchronized close/post commits one serial order.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;

function makeDeps(database: Database = db): ModuleDeps {
  return { db: database.db };
}

function makeRegistry(deps: ModuleDeps): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registerAccountingCapabilities(registry, deps);
  return registry;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads heterogeneous capability outputs; each assertion narrows its shape
async function runOn(deps: ModuleDeps, ctx: ActionContext, id: string, input: unknown): Promise<any> {
  const cap = makeRegistry(deps).get(id);
  if (!cap) throw new Error(`missing capability ${id}`);
  return cap.execute(ctx, input);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function purgeProbeOrgs(): Promise<void> {
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(like(organizations.name, "Period Guard Probe%"));
  for (const o of orgs) {
    await purgeTenantFinancials(db.db, o.id);
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
}

const payCtx = (orgId: string, actorId: string | null = null) => ({
  actor: { type: "human" as const, id: actorId, orgId, permissions: new Set(["*"]) },
  now: new Date(),
  services: {},
});

let orgA: string;
let orgB: string;
let orgC: string;
let claimantUserId: string;
let claimId: string;
let customerId: string;
const year = new Date().getUTCFullYear();
const month = new Date().getUTCMonth() + 1;

beforeAll(async () => {
  db = createDb(url);
  await purgeProbeOrgs();

  // Org A: expense-claim reimbursement against the closed current month.
  orgA = crypto.randomUUID();
  await db.db.insert(organizations).values({ id: orgA, name: "Period Guard Probe A", slug: `pg-a-${orgA.slice(0, 8)}` });
  const [claimant] = await db.db
    .insert(users)
    .values({ id: crypto.randomUUID(), email: `pg-a-${Date.now()}@demo.test`, name: "A" })
    .returning({ id: users.id });
  claimantUserId = claimant!.id;
  await db.db.insert(accounts).values([
    { orgId: orgA, code: "1000", name: "Cash", type: "asset" },
    { orgId: orgA, code: "6900", name: "Other Expense", type: "expense" },
  ]);
  const depsA = makeDeps();
  const submitted = await runOn(depsA, payCtx(orgA, claimantUserId), "accounting.submitExpenseClaim", {
    amountMinor: 5_000,
    memo: "Client visit taxi fare",
  });
  claimId = submitted.claimId;
  await db.db.update(expenseClaims).set({ status: "approved" }).where(eq(expenseClaims.id, claimId));

  // Org B: year-end close seals December.
  orgB = crypto.randomUUID();
  await db.db.insert(organizations).values({ id: orgB, name: "Period Guard Probe B", slug: `pg-b-${orgB.slice(0, 8)}` });
  await db.db.insert(accounts).values([
    { orgId: orgB, code: "1000", name: "Cash", type: "asset" },
    { orgId: orgB, code: "3100", name: "Retained Earnings", type: "equity" },
    { orgId: orgB, code: "4000", name: "Sales Revenue", type: "income" },
    { orgId: orgB, code: "6000", name: "Operating Expense", type: "expense" },
  ]);

  // Org C: close-vs-post race with two independent connections.
  orgC = crypto.randomUUID();
  await db.db.insert(organizations).values({ id: orgC, name: "Period Guard Probe C", slug: `pg-c-${orgC.slice(0, 8)}` });
  await db.db.insert(accounts).values([
    { orgId: orgC, code: "1100", name: "Accounts Receivable", type: "asset" },
    { orgId: orgC, code: "2100", name: "Sales Tax Payable", type: "liability" },
    { orgId: orgC, code: "4000", name: "Sales Revenue", type: "income" },
  ]);
  const [customer] = await db.db.insert(customers).values({ orgId: orgC, name: "Race Buyer" }).returning({ id: customers.id });
  customerId = customer!.id;
});

afterAll(async () => {
  await purgeProbeOrgs();
  await db.client.end();
});

describe("closed-period enforcement (N13)", () => {
  it("refuses to reimburse an expense claim into a sealed month, then allows it after reopen", async () => {
    const depsA = makeDeps();
    const ctx = payCtx(orgA, claimantUserId);

    await runOn(depsA, ctx, "accounting.closePeriod", { year, month });

    await expect(runOn(depsA, ctx, "accounting.payExpenseClaim", { claimId, amountMinor: 5_000 })).rejects.toThrow(
      new RegExp(`period ${year}-${String(month).padStart(2, "0")} is closed`),
    );
    const [entryCount] = await db.db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.orgId, orgA), eq(journalEntries.sourceType, "expense_claim")));
    expect(entryCount).toBeUndefined();

    await runOn(depsA, ctx, "accounting.reopenPeriod", { year, month });
    const paid = await runOn(depsA, ctx, "accounting.payExpenseClaim", { claimId, amountMinor: 5_000 });
    expect(paid.paidMinor).toBe(5_000);
    const [claim] = await db.db.select({ status: expenseClaims.status }).from(expenseClaims).where(eq(expenseClaims.id, claimId));
    expect(claim!.status).toBe("paid");
  });

  it("refuses direct postings into a sealed month at the posting-service level", async () => {
    await db.db.insert(periods).values({ orgId: orgA, year, month, closedByActorId: null }).onConflictDoNothing();
    const depsA = makeDeps();
    await expect(
      depsA.db.transaction(async (tx) =>
        postEntry(tx, orgA, { type: "human", id: null }, {
          memo: "should not land",
          sourceType: "manual",
          postedAt: new Date(),
          lines: [
            { accountCode: "6900", debitMinor: 100, creditMinor: 0 },
            { accountCode: "1000", debitMinor: 0, creditMinor: 100 },
          ],
        }),
      ),
    ).rejects.toThrow(/is closed/);
    await db.db.delete(periods).where(and(eq(periods.orgId, orgA), eq(periods.year, year), eq(periods.month, month)));
  });

  it("closeYear posts the closing entry, seals December, and the guard holds", async () => {
    const depsB = makeDeps();
    const ctx = payCtx(orgB);
    const actor = { type: "human" as const, id: null };

    await depsB.db.transaction(async (tx) => {
      await postEntry(tx, orgB, actor, {
        memo: "service revenue",
        sourceType: "manual",
        postedAt: ctx.now,
        lines: [
          { accountCode: "1000", debitMinor: 50_000, creditMinor: 0 },
          { accountCode: "4000", debitMinor: 0, creditMinor: 50_000 },
        ],
      });
      await postEntry(tx, orgB, actor, {
        memo: "office costs",
        sourceType: "manual",
        postedAt: ctx.now,
        lines: [
          { accountCode: "6000", debitMinor: 20_000, creditMinor: 0 },
          { accountCode: "1000", debitMinor: 0, creditMinor: 20_000 },
        ],
      });
    });

    const close = await runOn(depsB, ctx, "accounting.closeYear", { year });
    expect(close.netIncomeMinor).toBe(30_000);
    const [sealed] = await db.db
      .select({ month: periods.month })
      .from(periods)
      .where(and(eq(periods.orgId, orgB), eq(periods.year, year), eq(periods.month, 12)));
    expect(sealed).toBeDefined();

    // December is sealed: neither a historical December posting nor a second
    // year-end roll (new November activity) can land in the closed year.
    await depsB.db.transaction(async (tx) => {
      await postEntry(tx, orgB, actor, {
        memo: "late November income",
        sourceType: "manual",
        postedAt: new Date(Date.UTC(year, 10, 20)),
        lines: [
          { accountCode: "1000", debitMinor: 10_000, creditMinor: 0 },
          { accountCode: "4000", debitMinor: 0, creditMinor: 10_000 },
        ],
      });
    });
    await expect(depsB.db.transaction(async (tx) =>
      postEntry(tx, orgB, actor, {
        memo: "december posting after close",
        sourceType: "manual",
        postedAt: new Date(Date.UTC(year, 11, 15)),
        lines: [
          { accountCode: "1000", debitMinor: 100, creditMinor: 0 },
          { accountCode: "4000", debitMinor: 0, creditMinor: 100 },
        ],
      }),
    )).rejects.toThrow(`period ${year}-12 is closed`);
    await expect(runOn(depsB, ctx, "accounting.closeYear", { year })).rejects.toThrow(`period ${year}-12 is closed`);

    await runOn(depsB, ctx, "accounting.reopenPeriod", { year, month: 12 });
    await depsB.db.transaction(async (tx) => {
      await postEntry(tx, orgB, actor, {
        memo: "december posting after reopen",
        sourceType: "manual",
        postedAt: new Date(Date.UTC(year, 11, 15)),
        lines: [
          { accountCode: "1000", debitMinor: 100, creditMinor: 0 },
          { accountCode: "4000", debitMinor: 0, creditMinor: 100 },
        ],
      });
    });
  });

  it("serializes a close behind an in-flight posting transaction", async () => {
    const depsC = makeDeps();
    const ctx = payCtx(orgC);

    const hold = db.db.transaction(async (tx) => {
      await lockPeriodsForOrg(tx, orgC);
      await sleep(400);
    });
    await sleep(60); // let the holder take the lock first
    const t0 = Date.now();
    await runOn(depsC, ctx, "accounting.closePeriod", { year, month });
    const elapsed = Date.now() - t0;
    await hold;
    expect(elapsed).toBeGreaterThanOrEqual(250);

    // The month is now sealed; a racing invoice cannot slip in.
    await expect(
      runOn(depsC, ctx, "accounting.createInvoice", {
        customerId,
        memo: "after seal",
        lines: [{ description: "Consulting", quantity: 1_000, unitPriceMinor: 10_000 }],
      }),
    ).rejects.toThrow(/is closed/);
    await runOn(depsC, ctx, "accounting.reopenPeriod", { year, month });
  });

  it("a synchronized close and invoice post commit in exactly one serial order", async () => {
    const depsC = makeDeps();
    const ctx = payCtx(orgC);

    const [invoiceSettled, closeSettled] = await Promise.allSettled([
      runOn(depsC, ctx, "accounting.createInvoice", {
        customerId,
        memo: "race invoice",
        lines: [{ description: "Consulting", quantity: 1_000, unitPriceMinor: 12_000 }],
      }),
      runOn(depsC, ctx, "accounting.closePeriod", { year, month }),
    ]);

    expect(closeSettled.status).toBe("fulfilled");
    const invoiceRows = await db.db.select({ id: invoices.id }).from(invoices).where(eq(invoices.orgId, orgC));
    if (invoiceSettled.status === "fulfilled") {
      // Post committed first: the invoice is on the books and the close
      // sealed the month after it.
      expect(invoiceRows).toHaveLength(1);
    } else {
      // Close committed first: the post refused the sealed month - and no
      // other failure is acceptable.
      expect((invoiceSettled.reason as Error).message).toMatch(/is closed/);
      expect(invoiceRows).toHaveLength(0);
    }
    await runOn(depsC, ctx, "accounting.reopenPeriod", { year, month });
  });
});
