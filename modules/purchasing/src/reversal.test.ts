import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  accounts,
  createDb,
  journalEntries,
  journalLines,
  organizations,
  vendorBills,
  vendorPayments,
  vendors,
  type Database,
  purgeTenantFinancials,
} from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerPurchasingCapabilities, type ModuleDeps } from "./index";
import { registerAccountingCapabilities } from "@chaste/module-accounting";

/**
 * N12 (ADR 0051 extension): a vendor payment is undone by its own domain
 * compensation, not the generic journal mirror — the mirror posts in the
 * original currency, releases the bill's paid amount through the balance
 * contract, demotes a paid bill back to open, and a second or replayed
 * reversal has no second effect. The generic reverseEntry refuses the
 * protected source type with named routing.
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
  registerAccountingCapabilities(registry, deps);
  return registry;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads heterogeneous capability outputs; each assertion narrows its shape
async function run<I>(id: string, input: I): Promise<any> {
  const cap = makeRegistry().get(id);
  if (!cap) throw new Error(`missing capability ${id}`);
  return cap.execute(ctx, input);
}

async function billIdByNumber(billNumber: number): Promise<string> {
  const [row] = await db.db.select({ id: vendorBills.id }).from(vendorBills).where(eq(vendorBills.number, billNumber));
  return row!.id;
}

async function booksBalanced(): Promise<boolean> {
  const [row] = await db.db
    .select({ drift: sql<number>`coalesce(sum(${journalLines.debitMinor} - ${journalLines.creditMinor}), 0)` })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(eq(journalEntries.orgId, orgId));
  return Number(row?.drift ?? 0) === 0;
}

async function purgeProbeOrgs(): Promise<void> {
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Vendor Reversal Probe"));
  for (const o of orgs) {
    await purgeTenantFinancials(db.db, o.id);
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await purgeProbeOrgs();
  await db.db.insert(organizations).values({ id: orgId, name: "Vendor Reversal Probe", slug: `vrp-${orgId.slice(0, 8)}` });
  await db.db.insert(accounts).values([
    { orgId, code: "1000", name: "Cash", type: "asset" },
    { orgId, code: "2000", name: "Accounts Payable", type: "liability" },
    { orgId, code: "6000", name: "Operating Expenses", type: "expense" },
  ]);
  const [vendor] = await db.db.insert(vendors).values({ orgId, name: "Reversal Vendor" }).returning({ id: vendors.id });
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

describe("N12 vendor payment reversal", () => {
  it("pays, then reverses: books balance, the bill is released and demoted to open", async () => {
    const bill = await run("purchasing.createBill", {
      vendorId,
      lines: [{ description: "Backup service", quantity: 1_000, unitPriceMinor: 80_000, expenseAccountCode: "6000" }],
    });
    expect(bill.totalMinor).toBe(80_000);

    const paid = await run("purchasing.payBill", { billNumber: bill.billNumber, amountMinor: 80_000 });
    expect(paid.fullyPaid).toBe(true);
    let [row] = await db.db.select({ status: vendorBills.status, paidMinor: vendorBills.paidMinor }).from(vendorBills).where(eq(vendorBills.id, await billIdByNumber(bill.billNumber)));
    expect(row).toMatchObject({ status: "paid", paidMinor: 80_000 });

    // The inverse generates its input from the payment's actual output.
    const undone = await run("purchasing.reverseVendorPayment", {
      vendorPaymentId: paid.paymentId,
      reason: "paid the wrong invoice",
    });
    expect(undone).toMatchObject({ refundedMinor: 80_000, billNumber: bill.billNumber, outstandingMinor: 80_000 });
    [row] = await db.db.select({ status: vendorBills.status, paidMinor: vendorBills.paidMinor }).from(vendorBills).where(eq(vendorBills.id, await billIdByNumber(bill.billNumber)));
    expect(row).toMatchObject({ status: "open", paidMinor: 0 });
    expect(await booksBalanced()).toBe(true);

    // The mirror flips the payment entry: cash comes back, AP is restored.
    const mirror = await db.db
      .select({ code: accounts.code, debit: journalLines.debitMinor, credit: journalLines.creditMinor })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
      .where(eq(journalEntries.reversalOfId, paid.entryId));
    const byCode = new Map(mirror.map((l) => [l.code, l]));
    expect(byCode.get("1000")).toMatchObject({ debit: 80_000, credit: 0 });
    expect(byCode.get("2000")).toMatchObject({ debit: 0, credit: 80_000 });
  });

  it("a second or replayed reversal has no second effect", async () => {
    const bill = await run("purchasing.createBill", {
      vendorId,
      lines: [{ description: "Second case", quantity: 1_000, unitPriceMinor: 30_000, expenseAccountCode: "6000" }],
    });
    const paid = await run("purchasing.payBill", { billNumber: bill.billNumber, amountMinor: 30_000 });
    await run("purchasing.reverseVendorPayment", { vendorPaymentId: paid.paymentId, reason: "first reversal" });
    await expect(
      run("purchasing.reverseVendorPayment", { vendorPaymentId: paid.paymentId, reason: "replayed reversal" }),
    ).rejects.toThrow("already been reversed");

    const [pay] = await db.db.select().from(vendorPayments).where(eq(vendorPayments.id, paid.paymentId));
    const reversals = await db.db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(eq(journalEntries.reversalOfId, pay!.entryId!));
    expect(reversals).toHaveLength(1);
  });

  it("credits reduce the outstanding the reversal reports", async () => {
    const bill = await run("purchasing.createBill", {
      vendorId,
      lines: [{ description: "Credited case", quantity: 1_000, unitPriceMinor: 50_000, expenseAccountCode: "6000" }],
    });
    await run("purchasing.billCreditNote", { billId: await billIdByNumber(bill.billNumber), amountMinor: 20_000, reason: "partial service credit" });
    const paid = await run("purchasing.payBill", { billNumber: bill.billNumber, amountMinor: 30_000 });
    expect(paid.fullyPaid).toBe(true);

    const undone = await run("purchasing.reverseVendorPayment", {
      vendorPaymentId: paid.paymentId,
      reason: "corrected payment",
    });
    expect(undone.outstandingMinor).toBe(30_000);
    const [row] = await db.db.select({ status: vendorBills.status, creditedMinor: vendorBills.creditedMinor }).from(vendorBills).where(eq(vendorBills.number, bill.billNumber));
    expect(row!.creditedMinor).toBe(20_000);
    expect(row!.status).toBe("open");
  });

  it("the generic journal reversal routes vendor payments to the domain workflow", async () => {
    const bill = await run("purchasing.createBill", {
      vendorId,
      lines: [{ description: "Routing case", quantity: 1_000, unitPriceMinor: 10_000, expenseAccountCode: "6000" }],
    });
    const paid = await run("purchasing.payBill", { billNumber: bill.billNumber, amountMinor: 10_000 });
    await expect(run("accounting.reverseEntry", { entryId: paid.entryId })).rejects.toThrow(
      /vendor_payment.*purchasing\.reverseVendorPayment/s,
    );
  });
});
