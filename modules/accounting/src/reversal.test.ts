import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  accounts,
  createDb,
  customers,
  fxSettlements,
  invoices,
  journalEntries,
  journalLines,
  organizations,
  payments,
  type Database,
  purgeTenantFinancials,
} from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerAccountingCapabilities, type ModuleDeps } from "./index";

/**
 * Domain compensations (N12, ADR 0051): a payment reversal mirrors every
 * entry in its original currency, releases the invoice's paid balance, and
 * refuses a second reversal; the generic journal mirror routes protected
 * source types to their domain workflow; a foreign-currency manual entry
 * reverses in its own currency, never the base.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads heterogeneous capability outputs
async function run<I>(id: string, input: I): Promise<any> {
  const cap = makeRegistry().get(id);
  if (!cap) throw new Error(`missing capability ${id}`);
  return cap.execute(ctx, input);
}

async function purgeProbeOrgs(): Promise<void> {
  const orgs = await db.db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.name, "Reversal Probe"));
  for (const o of orgs) {
    await purgeTenantFinancials(db.db, o.id);
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await purgeProbeOrgs();
  await db.db.insert(organizations).values({ id: orgId, name: "Reversal Probe", slug: `rv-${orgId.slice(0, 8)}` });
  await db.db.insert(accounts).values([
    { orgId, code: "1000", name: "Cash", type: "asset" },
    { orgId, code: "1100", name: "Accounts Receivable", type: "asset" },
    { orgId, code: "2100", name: "Sales Tax Payable", type: "liability" },
    { orgId, code: "4000", name: "Sales Revenue", type: "income" },
  ]);
  await db.db.insert(customers).values({ orgId, name: "Reversal Probe Customer" });
  customerId = (await db.db.select().from(customers).where(eq(customers.orgId, orgId)))[0]!.id;
  ctx = {
    actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };
});

afterAll(async () => {
  await purgeProbeOrgs();
  await db.db.$client.end();
});

describe("N12 payment compensation", () => {
  it("pay → reverse → pay leaves invoice, GL and payments consistent", async () => {
    const inv = await run("accounting.createInvoice", {
      customerId,
      lines: [{ description: "consulting", quantity: 1000, unitPriceMinor: 100_000 }],
    });
    expect(inv.invoiceId).toBeTruthy();

    const pay1 = await run("accounting.recordPayment", {
      invoiceNumber: inv.invoiceNumber,
      amountMinor: 40_000,
      method: "bank_transfer",
    });
    let [row] = await db.db.select().from(invoices).where(eq(invoices.id, inv.invoiceId));
    expect(row!.paidMinor).toBe(40_000);

    const rev = await run("accounting.reversePayment", {
      paymentId: pay1.paymentId,
      reason: "customer paid from the wrong account",
    });
    expect(rev.reversalEntryIds).toHaveLength(1);
    expect(rev.outstandingMinor).toBe(100_000);
    [row] = await db.db.select().from(invoices).where(eq(invoices.id, inv.invoiceId));
    expect(row!.paidMinor).toBe(0);
    expect(row!.status).not.toBe("paid");

    const mirror = await db.db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.orgId, orgId), eq(journalEntries.reversalOfId, pay1.entryId)));
    expect(mirror).toHaveLength(1);
    expect(mirror[0]!.sourceType).toBe("payment-reversal");
    const lines = await db.db
      .select()
      .from(journalLines)
      .where(eq(journalLines.entryId, mirror[0]!.id));
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => `${l.debitMinor}/${l.creditMinor}`).sort()).toEqual(["0/40000", "40000/0"]);

    // Unique at the business-operation level: replay refuses.
    await expect(
      run("accounting.reversePayment", { paymentId: pay1.paymentId, reason: "replay of the same undo" }),
    ).rejects.toThrow("already been reversed");

    // The corrected payment lands on the full outstanding again.
    const pay2 = await run("accounting.recordPayment", {
      invoiceNumber: inv.invoiceNumber,
      amountMinor: 100_000,
      method: "bank_transfer",
    });
    expect(pay2.fullyPaid).toBe(true);
    [row] = await db.db.select().from(invoices).where(eq(invoices.id, inv.invoiceId));
    expect(row!.status).toBe("paid");

    // The whole story nets to zero: every entry the flow posted balances.
    const entries = await db.db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.orgId, orgId));
    let net = 0;
    for (const e of entries) {
      const ls = await db.db.select().from(journalLines).where(eq(journalLines.entryId, e.id));
      net += ls.reduce((s, l) => s + l.debitMinor - l.creditMinor, 0);
    }
    expect(net).toBe(0);
  });

  it("reverses an FX settlement as one coherent pair, each entry in its own currency", async () => {
    await run("accounting.recordFxRate", { quoteCurrency: "EUR", rate: "2" });
    const inv = await run("accounting.createInvoice", {
      customerId,
      currency: "EUR",
      lines: [{ description: "licence", quantity: 1000, unitPriceMinor: 50_000 }],
    });
    expect(inv.currency).toBe("EUR");

    const pay = await run("accounting.recordPayment", {
      invoiceNumber: inv.invoiceNumber,
      amountMinor: 50_000,
      method: "bank_transfer",
      settleFxRate: "2.5",
    });
    expect(pay.gainLossMinor).toBe(25_000);
    const [settlement] = await db.db.select().from(fxSettlements).where(eq(fxSettlements.paymentId, pay.paymentId));
    expect(settlement).toBeTruthy();

    const rev = await run("accounting.reversePayment", {
      paymentId: pay.paymentId,
      reason: "settled at the wrong rate",
    });
    expect(rev.reversalEntryIds).toHaveLength(2);

    const baseEntry = await db.db.select().from(journalEntries).where(eq(journalEntries.id, pay.baseEntryId));
    const foreignEntry = await db.db.select().from(journalEntries).where(eq(journalEntries.id, pay.foreignEntryId));
    const baseMirror = await db.db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.reversalOfId, pay.baseEntryId));
    const foreignMirror = await db.db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.reversalOfId, pay.foreignEntryId));
    expect(baseMirror).toHaveLength(1);
    expect(foreignMirror).toHaveLength(1);
    // Foreign reversal retains its currency; never laundered into the base.
    expect(baseMirror[0]!.currency).toBe(baseEntry[0]!.currency);
    expect(foreignMirror[0]!.currency).toBe("EUR");
    expect(foreignMirror[0]!.currency).toBe(foreignEntry[0]!.currency);

    const [row] = await db.db.select().from(invoices).where(eq(invoices.id, inv.invoiceId));
    expect(row!.paidMinor).toBe(0);
  });

  it("reversing a foreign-currency manual entry keeps that currency", async () => {
    const [ar] = await db.db.select().from(accounts).where(and(eq(accounts.orgId, orgId), eq(accounts.code, "4000")));
    const entryId = await db.db.transaction(async (tx) => {
      const [entry] = await tx
        .insert(journalEntries)
        .values({
          orgId,
          memo: "EUR adjustment",
          sourceType: "manual",
          currency: "EUR",
          postedAt: ctx.now,
          postedByActorType: "human",
        })
        .returning({ id: journalEntries.id });
      await tx.insert(journalLines).values([
        { entryId: entry!.id, accountId: ar!.id, debitMinor: 5000, creditMinor: 0 },
        { entryId: entry!.id, accountId: ar!.id, debitMinor: 0, creditMinor: 5000 },
      ]);
      return entry!.id;
    });

    const rev = await run("accounting.reverseEntry", { entryId });
    const [mirror] = await db.db.select().from(journalEntries).where(eq(journalEntries.id, rev.reversalEntryId));
    expect(mirror!.currency).toBe("EUR");
  });
});

describe("N12 generic reversal routing", () => {
  it("refuses protected source types and names the domain workflow", async () => {
    const inv = await run("accounting.createInvoice", {
      customerId,
      lines: [{ description: "routing probe", quantity: 1000, unitPriceMinor: 10_000 }],
    });
    await expect(run("accounting.reverseEntry", { entryId: inv.entryId })).rejects.toThrow(
      /accounting\.creditNote/,
    );

    const pay = await run("accounting.recordPayment", {
      invoiceNumber: inv.invoiceNumber,
      amountMinor: 10_000,
      method: "cash",
    });
    await expect(run("accounting.reverseEntry", { entryId: pay.entryId })).rejects.toThrow(
      /accounting\.reversePayment/,
    );

    // A payroll posting and a POS sale route the same way; the guard reads
    // the entry's declared source, so the rows are stamped directly.
    const [revenue] = await db.db.select().from(accounts).where(and(eq(accounts.orgId, orgId), eq(accounts.code, "4000")));
    for (const sourceType of ["payroll_run", "pos_sale", "inventory-valuation"]) {
      const e = await db.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(journalEntries)
          .values({
            orgId,
            memo: `routing probe ${sourceType}`,
            sourceType,
            postedAt: ctx.now,
            postedByActorType: "human",
          })
          .returning({ id: journalEntries.id });
        await tx.insert(journalLines).values([
          { entryId: row!.id, accountId: revenue!.id, debitMinor: 100, creditMinor: 0 },
          { entryId: row!.id, accountId: revenue!.id, debitMinor: 0, creditMinor: 100 },
        ]);
        return row!;
      });
      await expect(run("accounting.reverseEntry", { entryId: e!.id })).rejects.toThrow(
        /domain workflow/,
      );
    }
  });

  it("a vendor payment entry routes to purchasing.reverseVendorPayment", async () => {
    const [revenue] = await db.db.select().from(accounts).where(and(eq(accounts.orgId, orgId), eq(accounts.code, "4000")));
    const e = await db.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(journalEntries)
        .values({
          orgId,
          memo: "routing probe vendor_payment",
          sourceType: "vendor_payment",
          postedAt: ctx.now,
          postedByActorType: "human",
        })
        .returning({ id: journalEntries.id });
      await tx.insert(journalLines).values([
        { entryId: row!.id, accountId: revenue!.id, debitMinor: 100, creditMinor: 0 },
        { entryId: row!.id, accountId: revenue!.id, debitMinor: 0, creditMinor: 100 },
      ]);
      return row!;
    });
    await expect(run("accounting.reverseEntry", { entryId: e!.id })).rejects.toThrow(
      /vendor_payment.*purchasing\.reverseVendorPayment/s,
    );
  });

  it("a payment on a POS sale routes to pos.returnSale, and void invoices refuse reversal", async () => {
    const inv = await run("accounting.createInvoice", {
      customerId,
      lines: [{ description: "pos routing", quantity: 1000, unitPriceMinor: 20_000 }],
    });
    // A register sale's payment row points at the pos_sale entry.
    const [cash] = await db.db.select().from(accounts).where(and(eq(accounts.orgId, orgId), eq(accounts.code, "1000")));
    const posEntry = await db.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(journalEntries)
        .values({
          orgId,
          memo: "POS sale routing probe",
          sourceType: "pos_sale",
          sourceId: inv.invoiceId,
          postedAt: ctx.now,
          postedByActorType: "human",
        })
        .returning({ id: journalEntries.id });
      await tx.insert(journalLines).values([
        { entryId: row!.id, accountId: cash!.id, debitMinor: 20000, creditMinor: 0 },
        { entryId: row!.id, accountId: cash!.id, debitMinor: 0, creditMinor: 20000 },
      ]);
      return row!;
    });
    const [payment] = await db.db
      .insert(payments)
      .values({ orgId, invoiceId: inv.invoiceId, amountMinor: 20_000, method: "cash", entryId: posEntry!.id })
      .returning({ id: payments.id });
    await expect(run("accounting.reversePayment", { paymentId: payment!.id, reason: "register sale undo" })).rejects.toThrow(
      /pos\.returnSale/,
    );

    await db.db.update(invoices).set({ status: "void" }).where(eq(invoices.id, inv.invoiceId));
    const [directPayment] = await db.db
      .insert(payments)
      .values({ orgId, invoiceId: inv.invoiceId, amountMinor: 1000, method: "cash", entryId: inv.entryId })
      .returning({ id: payments.id });
    await expect(
      run("accounting.reversePayment", { paymentId: directPayment!.id, reason: "void invoice probe" }),
    ).rejects.toThrow(/void/);
  });
});
