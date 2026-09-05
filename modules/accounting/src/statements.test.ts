import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  accounts,
  createDb,
  customers,
  invoices,
  journalEntries,
  journalLines,
  organizations,
  type Database,
} from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerAccountingCapabilities, type ModuleDeps } from "./index";

/**
 * Customer statements + reminder drafting (M10.2, ADR 0037): the statement
 * nets invoices, payments, and credits into an ordered running balance;
 * reminders skip opt-outs and draft exact, honest messages.
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
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Statement Probe"));
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
  await db.db.insert(organizations).values({ id: orgId, name: "Statement Probe", slug: `st-${orgId.slice(0, 8)}` });
  await db.db.insert(accounts).values([
    { orgId, code: "1000", name: "Cash", type: "asset" },
    { orgId, code: "1100", name: "Accounts Receivable", type: "asset" },
    { orgId, code: "2100", name: "Sales Tax Payable", type: "liability" },
    { orgId, code: "4000", name: "Sales Revenue", type: "income" },
  ]);
  const [cust] = await db.db
    .insert(customers)
    .values({ orgId, name: "Statement Buyer", paymentTermDays: 30 })
    .returning({ id: customers.id });
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

describe("statements + reminders (M10.2)", () => {
  it("payment terms set the due date and the statement nets everything in order", async () => {
    const inv = await run("accounting.createInvoice", {
      customerId,
      lines: [{ description: "Net-30 goods", quantity: 1_000, unitPriceMinor: 200_00 }],
    });
    const [row] = await db.db.select({ dueAt: invoices.dueAt, issuedAt: invoices.issuedAt }).from(invoices).where(eq(invoices.id, inv.invoiceId));
    const termDays = Math.round((row!.dueAt!.getTime() - row!.issuedAt!.getTime()) / 86_400_000);
    expect(termDays).toBe(30);

    await run("accounting.recordPayment", { invoiceNumber: inv.invoiceNumber, amountMinor: 50_00 });
    await run("accounting.creditNote", { invoiceId: inv.invoiceId, amountMinor: 30_00, reason: "goodwill adjustment" });

    const stmt = await run("accounting.customerStatement", { customerId });
    const kinds = stmt.rows.map((r: { kind: string }) => r.kind);
    expect(kinds).toEqual(["invoice", "payment", "credit_note"]);
    expect(stmt.closingBalanceMinor).toBe(200_00 - 50_00 - 30_00);
    const dates = stmt.rows.map((r: { date: string }) => r.date);
    expect([...dates].sort()).toEqual(dates);
    expect(stmt.rows.at(-1)!.balanceMinor).toBe(stmt.closingBalanceMinor);
  });

  it("reminders skip opt-outs and draft honest overdue messages", async () => {
    const past = new Date(Date.now() - 12 * 86_400_000);
    const inv = await run("accounting.createInvoice", {
      customerId,
      lines: [{ description: "Overdue goods", quantity: 1_000, unitPriceMinor: 80_00 }],
      dueAt: past,
    });
    void inv;
    // Opt this customer out and confirm they vanish from the draft list.
    await db.db.update(customers).set({ reminderOptOut: true }).where(eq(customers.id, customerId));
    const quiet = await run("accounting.buildReminders", {});
    expect(quiet.reminders.find((r: { customerId: string }) => r.customerId === customerId)).toBeUndefined();

    await db.db.update(customers).set({ reminderOptOut: false }).where(eq(customers.id, customerId));
    const reminders = await run("accounting.buildReminders", {});
    const mine = reminders.reminders.find((r: { customerId: string }) => r.customerId === customerId);
    expect(mine).toBeDefined();
    expect(mine.totalOverdueMinor).toBeGreaterThanOrEqual(80_00);
    expect(mine.message).toContain("past due");
    expect(mine.oldestDaysOverdue).toBeGreaterThanOrEqual(10);
  });

  it("cash flow ties on live books", async () => {
    const cf = await run("accounting.cashFlow", { cashAccountCodes: ["1000"] });
    expect(cf.ties).toBe(true);
    const fc = await run("accounting.cashForecast", { cashAccountCodes: ["1000"] });
    expect(fc.weeks).toHaveLength(13);
  });
});
