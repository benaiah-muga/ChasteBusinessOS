import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
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
 * AR credit notes (M10.1, ADR 0037): always-gate money class, proportional
 * mirror entry (DR revenue + tax, CR AR), immutable credited column, honest
 * refusal to over-credit, books balanced.
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
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Credit Note Probe"));
  for (const o of orgs) {
    const entries = await db.db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.orgId, o.id));
    for (const e of entries) {
      await db.db.delete(journalLines).where(eq(journalLines.entryId, e.id));
    }
    await db.db.delete(journalEntries).where(eq(journalEntries.orgId, o.id));
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
}

async function booksBalanced(): Promise<boolean> {
  const [row] = await db.db
    .select({ drift: sql<number>`coalesce(sum(${journalLines.debitMinor} - ${journalLines.creditMinor}), 0)` })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(eq(journalEntries.orgId, orgId));
  return Number(row?.drift ?? 0) === 0;
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await purgeProbeOrgs();
  await db.db.insert(organizations).values({ id: orgId, name: "Credit Note Probe", slug: `cn-${orgId.slice(0, 8)}` });
  await db.db.insert(accounts).values([
    { orgId, code: "1000", name: "Cash", type: "asset" },
    { orgId, code: "1100", name: "Accounts Receivable", type: "asset" },
    { orgId, code: "2100", name: "Sales Tax Payable", type: "liability" },
    { orgId, code: "4000", name: "Sales Revenue", type: "income" },
  ]);
  const [cust] = await db.db.insert(customers).values({ orgId, name: "Credit Taker" }).returning({ id: customers.id });
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

describe("AR credit notes (M10.1)", () => {
  it("always gates: moneyAmount is null regardless of input", async () => {
    const cap = makeRegistry().get("accounting.creditNote");
    expect(cap?.moneyAmount?.({ invoiceId: "x", amountMinor: 1, reason: "any" } as never)).toBeNull();
  });

  it("credits proportionally, reduces balance, keeps books balanced", async () => {
    const inv = await run("accounting.createInvoice", {
      customerId,
      lines: [
        { description: "Widget", quantity: 1_000, unitPriceMinor: 1_000_00, taxMinor: 0 },
        { description: "Gadget", quantity: 1_000, unitPriceMinor: 1_000_00, taxMinor: 20_00 },
      ],
    });
    expect(inv.totalMinor).toBe(2_020_00); // $2,000 + $20 tax

    const credited = await run("accounting.creditNote", {
      invoiceId: inv.invoiceId,
      amountMinor: 505_00,
      reason: "damaged in shipping",
    });
    // quarter of the invoice: 500 revenue + 5 tax
    expect(credited.invoiceBalanceMinor).toBe(1_515_00);
    const [row] = await db.db.select({ creditedMinor: invoices.creditedMinor }).from(invoices).where(eq(invoices.id, inv.invoiceId));
    expect(row!.creditedMinor).toBe(505_00);
    expect(await booksBalanced()).toBe(true);

    const mirror = await db.db
      .select({ code: accounts.code, debit: journalLines.debitMinor, credit: journalLines.creditMinor })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
      .where(and(eq(journalEntries.orgId, orgId), eq(journalEntries.sourceType, "invoice_credit_note")));
    const byCode = new Map(mirror.map((l) => [l.code, l]));
    expect(byCode.get("4000")).toMatchObject({ debit: 500_00, credit: 0 });
    expect(byCode.get("2100")).toMatchObject({ debit: 5_00, credit: 0 });
    expect(byCode.get("1100")).toMatchObject({ debit: 0, credit: 505_00 });
  });

  it("refuses to credit more than the open balance", async () => {
    const inv = await run("accounting.createInvoice", {
      customerId,
      lines: [{ description: "Small", quantity: 1_000, unitPriceMinor: 10_00 }],
    });
    await expect(
      run("accounting.creditNote", { invoiceId: inv.invoiceId, amountMinor: 1_001_00, reason: "over the top" }),
    ).rejects.toThrow(/exceeds the open balance/);
  });
});
