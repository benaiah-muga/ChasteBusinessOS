import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  accounts,
  createDb,
  customers,
  invoices,
  organizations,
  payments,
  type Database,
  purgeTenantFinancials,
} from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerAccountingCapabilities, type ModuleDeps } from "./index";

/**
 * N11: one document-balance contract everywhere. Credits reduce the
 * outstanding every surface shows; money application is serialized per
 * document so simultaneous payments cannot race the cap; collections age
 * runs from the due date, not the issue date.
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
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Balance Probe"));
  for (const o of orgs) {
    await purgeTenantFinancials(db.db, o.id);
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await purgeProbeOrgs();
  await db.db.insert(organizations).values({ id: orgId, name: "Balance Probe", slug: `bal-${orgId.slice(0, 8)}` });
  await db.db.insert(accounts).values([
    { orgId, code: "1000", name: "Cash", type: "asset" },
    { orgId, code: "1100", name: "Accounts Receivable", type: "asset" },
    { orgId, code: "4000", name: "Sales Revenue", type: "income" },
  ]);
  const [cust] = await db.db.insert(customers).values({ orgId, name: "Balance Customer" }).returning({ id: customers.id });
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

describe("N11 balance contract across surfaces", () => {
  let probeInv: { invoiceId: string; invoiceNumber: number; totalMinor: number };

  beforeAll(async () => {
    // total 10,000.00; credit 4,000.00; pay 1,000.00 -> outstanding 5,000.00
    probeInv = await run("accounting.createInvoice", {
      customerId,
      lines: [{ description: "Probe", quantity: 100_000, unitPriceMinor: 100_00, taxMinor: 0 }],
    });
    await run("accounting.creditNote", { invoiceId: probeInv.invoiceId, amountMinor: 4_000_00, reason: "goodwill adjustment" });
    await run("accounting.recordPayment", { invoiceNumber: probeInv.invoiceNumber, amountMinor: 1_000_00 });
  });

  it("listInvoices shows the credit-adjusted outstanding", async () => {
    const listed = await run("accounting.listInvoices", { limit: 50 });
    const row = listed.invoices.find((i: { invoiceNumber?: number; number: number }) => i.number === probeInv.invoiceNumber);
    expect(row).toMatchObject({ totalMinor: 10_000_00, creditedMinor: 4_000_00, paidMinor: 1_000_00, outstandingMinor: 5_000_00 });
  });

  it("arAging chases only the credit-adjusted balance and buckets past due", async () => {
    // A 45-days-past-due invoice, gross 2,000.00, still fully outstanding.
    const late = await run("accounting.createInvoice", {
      customerId,
      lines: [{ description: "Late", quantity: 200_000, unitPriceMinor: 100_00, taxMinor: 0 }],
    });
    const DAY = 86_400_000;
    await db.db
      .update(invoices)
      .set({ issuedAt: new Date(Date.now() - 100 * DAY), dueAt: new Date(Date.now() - 45 * DAY) })
      .where(eq(invoices.id, late.invoiceId));

    // A fully credited invoice disappears from receivables entirely.
    const gone = await run("accounting.createInvoice", {
      customerId,
      lines: [{ description: "Gone", quantity: 300_000, unitPriceMinor: 100_00, taxMinor: 0 }],
    });
    await run("accounting.creditNote", { invoiceId: gone.invoiceId, amountMinor: 3_000_000, reason: "order cancelled" });

    const aging = await run("accounting.arAging", {});
    const probe = aging.invoices.find((i: { number: number }) => i.number === probeInv.invoiceNumber);
    expect(probe).toMatchObject({ outstandingMinor: 5_000_00 });
    expect(aging.invoices.find((i: { number: number }) => i.number === gone.invoiceNumber)).toBeUndefined();

    // The late invoice lands in the 31-60-days-past-due band.
    const lateRow = await db.db.select({ totalMinor: invoices.totalMinor }).from(invoices).where(eq(invoices.id, late.invoiceId));
    expect(aging.buckets.d30).toBe(lateRow[0]!.totalMinor);
    expect(aging.buckets.totalOutstanding).toBe(5_000_00 + lateRow[0]!.totalMinor);
  });

  it("unrealizedFxExposure nets credits against the foreign outstanding", async () => {
    const [eur] = await db.db
      .insert(invoices)
      .values({
        orgId,
        customerId,
        number: 9_900_001,
        status: "sent",
        currency: "EUR",
        subtotalMinor: 2_000_00,
        taxMinor: 0,
        totalMinor: 2_000_00,
        paidMinor: 0,
        creditedMinor: 500_00,
      })
      .returning({ id: invoices.id });
    const fx = await run("accounting.unrealizedFxExposure", {});
    const row = fx.exposures.find((e: { currency: string }) => e.currency === "EUR");
    expect(row).toMatchObject({ outstandingForeignMinor: 1_500_00 });
    await db.db.delete(invoices).where(eq(invoices.id, eur!.id));
  });

  it("simultaneous payments serialize on the document lock: exactly one wins", async () => {
    // outstanding 6,000.00; both contenders are valid alone, not together.
    const race = await run("accounting.createInvoice", {
      customerId,
      lines: [{ description: "Race", quantity: 600_000, unitPriceMinor: 100_00, taxMinor: 0 }],
    });
    const attempts = [
      run("accounting.recordPayment", { invoiceNumber: race.invoiceNumber, amountMinor: 4_000_000 }),
      run("accounting.recordPayment", { invoiceNumber: race.invoiceNumber, amountMinor: 5_000_000 }),
    ];
    const settled = await Promise.allSettled(attempts);
    const rejected = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
    const fulfilled = settled.filter((s) => s.status === "fulfilled") as PromiseFulfilledResult<{ fullyPaid: boolean }>[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]!.reason)).toContain("outstanding is");

    const [row] = await db.db.select({ paidMinor: invoices.paidMinor }).from(invoices).where(eq(invoices.id, race.invoiceId));
    const pays = await db.db.select({ amountMinor: payments.amountMinor }).from(payments).where(eq(payments.invoiceId, race.invoiceId));
    expect(pays).toHaveLength(1);
    expect(row!.paidMinor).toBe(pays[0]!.amountMinor);
    expect(row!.paidMinor === 4_000_000 || row!.paidMinor === 5_000_000).toBe(true);
    // either winner leaves 1,000.00 or 2,000.00 outstanding - never settled
    expect(fulfilled[0]!.value.fullyPaid).toBe(false);
  });
});
