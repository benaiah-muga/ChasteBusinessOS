import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  accounts,
  bankAccounts,
  bankTransactions,
  createDb,
  customers,
  journalEntries,
  organizations,
  type Database,
  purgeTenantFinancials,
} from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerAccountingCapabilities, type ModuleDeps } from "./index";

/**
 * N14 slice 2: explicit allocation alternatives. A statement line can be
 * explained by a payment plus a reviewed fee, plus an FX difference, or by
 * several payments together (grouped settlement); a payment's remaining
 * amount supports splits; and a statement period is reconciled when the
 * unexplained difference is exactly zero.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;
let customerId: string;
let usdAccountId: string;
let recAccountId: string;

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

async function feedLine(amountMinor: number, description: string, bankAccountId = usdAccountId): Promise<string> {
  await run("accounting.importBankFeed", {
    bankAccountId,
    rows: [{ postedAt: "2026-09-16", amountMinor, description }],
  });
  const [row] = await db.db
    .select({ id: bankTransactions.id })
    .from(bankTransactions)
    .where(eq(bankTransactions.description, description));
  return row!.id;
}

async function newPayment(invoiceTotal: number, description: string): Promise<string> {
  const inv = await run("accounting.createInvoice", {
    customerId,
    lines: [{ description, quantity: invoiceTotal * 10, unitPriceMinor: 100 }],
  });
  const pay = await run("accounting.recordPayment", { invoiceNumber: inv.invoiceNumber, amountMinor: invoiceTotal });
  return pay.paymentId;
}

async function purgeProbeOrgs(): Promise<void> {
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Bank Rec Probe"));
  for (const o of orgs) {
    await purgeTenantFinancials(db.db, o.id);
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await purgeProbeOrgs();
  await db.db.insert(organizations).values({ id: orgId, name: "Bank Rec Probe", slug: `brc-${orgId.slice(0, 8)}` });
  await db.db.insert(accounts).values([
    { orgId, code: "1000", name: "Cash", type: "asset" },
    { orgId, code: "1100", name: "Accounts Receivable", type: "asset" },
    { orgId, code: "4000", name: "Sales Revenue", type: "income" },
  ]);
  const [cust] = await db.db.insert(customers).values({ orgId, name: "Rec Probe Buyer" }).returning({ id: customers.id });
  customerId = cust!.id;
  const [usd] = await db.db
    .insert(bankAccounts)
    .values({ orgId, name: "Rec USD", currencyCode: "USD" })
    .returning({ id: bankAccounts.id });
  usdAccountId = usd!.id;
  const [rec] = await db.db
    .insert(bankAccounts)
    .values({ orgId, name: "Rec Definition USD", currencyCode: "USD" })
    .returning({ id: bankAccounts.id });
  recAccountId = rec!.id;
  ctx = { actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) }, now: new Date(), services: {} };
});

afterAll(async () => {
  await purgeProbeOrgs();
});

describe("N14 explicit allocation alternatives", () => {
  it("a reviewed bank fee explains the difference: 100,050 banked = 100,000 payment + 50 fee", async () => {
    const p1 = await newPayment(100_000, "fee case invoice");
    const lineId = await feedLine(100_050, "fee case line");
    const matched = await run("accounting.matchBankTransaction", { transactionId: lineId, paymentId: p1, feeMinor: 50 });
    expect(matched).toMatchObject({ status: "matched", allocatedMinor: 100_050, lineUnexplainedMinor: 0 });
  });

  it("a wrong decomposition is still refused", async () => {
    const p = await newPayment(200_000, "wrong fee invoice");
    const lineId = await feedLine(200_050, "wrong fee line");
    await expect(run("accounting.matchBankTransaction", { transactionId: lineId, paymentId: p, feeMinor: 60 })).rejects.toThrow(
      /amount mismatch/,
    );
  });

  it("an FX difference explains a settlement gap", async () => {
    const p = await newPayment(300_000, "fx case invoice");
    const lineId = await feedLine(300_120, "fx case line");
    const matched = await run("accounting.matchBankTransaction", { transactionId: lineId, paymentId: p, fxGainLossMinor: 120 });
    expect(matched).toMatchObject({ status: "matched", lineUnexplainedMinor: 0 });
  });

  it("a grouped settlement: several payments explain one line together", async () => {
    const p3 = await newPayment(60_000, "grouped A");
    const p4 = await newPayment(40_000, "grouped B");
    const lineId = await feedLine(100_000, "grouped line");
    const first = await run("accounting.matchBankTransaction", { transactionId: lineId, paymentId: p3, amountMinor: 60_000 });
    expect(first).toMatchObject({ status: "matched", lineUnexplainedMinor: 40_000 });
    const second = await run("accounting.matchBankTransaction", { transactionId: lineId, paymentId: p4, amountMinor: 40_000 });
    expect(second).toMatchObject({ status: "matched", allocatedMinor: 100_000, lineUnexplainedMinor: 0 });
  });

  it("unmatch releases every allocation, fees included", async () => {
    const p = await newPayment(500_000, "unmatch fee invoice");
    const lineId = await feedLine(500_250, "unmatch fee line");
    await run("accounting.matchBankTransaction", { transactionId: lineId, paymentId: p, feeMinor: 250 });
    const released = await run("accounting.unmatchBankTransaction", { transactionId: lineId });
    expect(released).toMatchObject({ status: "unmatched", releasedMinor: 500_250 });
    // The payment is spendable again: a clean exact match succeeds.
    const again = await feedLine(500_000, "unmatch fee re-match");
    const rematch = await run("accounting.matchBankTransaction", { transactionId: again, paymentId: p });
    expect(rematch.status).toBe("matched");
  });
});

describe("N14 reconciled definition", () => {
  it("a period is reconciled only when the unexplained difference is zero", async () => {
    // Fully matched line.
    const p1 = await newPayment(10_000, "rec invoice one");
    const fullId = await feedLine(10_000, "rec line full", recAccountId);
    await run("accounting.matchBankTransaction", { transactionId: fullId, paymentId: p1 });

    // Partially matched line (60,000 of 100,000 explained).
    const p2 = await newPayment(60_000, "rec invoice two");
    const partialId = await feedLine(100_000, "rec line partial", recAccountId);
    await run("accounting.matchBankTransaction", { transactionId: partialId, paymentId: p2, amountMinor: 60_000 });

    // Excluded line: deliberately out of the difference.
    const excludedId = await feedLine(-7_000, "rec line excluded", recAccountId);
    await run("accounting.excludeBankTransaction", { transactionId: excludedId });

    // Untouched unmatched line.
    const untouchedId = await feedLine(5_000, "rec line untouched", recAccountId);

    const before = await run("accounting.bankReconciliation", { bankAccountId: recAccountId });
    expect(before.totals).toMatchObject({ linesMinor: 115_000, allocatedMinor: 70_000, unexplainedMinor: 45_000, reconciled: false });
    const partial = before.lines.find((l: { id: string }) => l.id === partialId);
    expect(partial).toMatchObject({ allocatedMinor: 60_000, unexplainedMinor: 40_000 });
    const excluded = before.lines.find((l: { id: string }) => l.id === excludedId);
    expect(excluded).toMatchObject({ allocatedMinor: 0, unexplainedMinor: 0, status: "excluded" });

    // Explain the remainder: another payment covers the rest of the partial
    // line, and a journal entry (a transfer in) explains the untouched one.
    const p3 = await newPayment(40_000, "rec invoice three");
    await run("accounting.matchBankTransaction", { transactionId: partialId, paymentId: p3, amountMinor: 40_000 });

    await deps.db.transaction(async (tx) => {
      const { postEntry } = await import("./posting");
      await postEntry(tx, orgId, { type: "human", id: null }, {
        memo: "rec transfer in",
        sourceType: "manual",
        postedAt: ctx.now,
        currency: "USD",
        lines: [
          { accountCode: "1000", debitMinor: 5_000, creditMinor: 0 },
          { accountCode: "4000", debitMinor: 0, creditMinor: 5_000 },
        ],
      });
    });
    const [entry] = await db.db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(eq(journalEntries.memo, "rec transfer in"));
    await run("accounting.matchBankTransaction", { transactionId: untouchedId, entryId: entry!.id });

    const after = await run("accounting.bankReconciliation", { bankAccountId: recAccountId });
    expect(after.totals).toMatchObject({ linesMinor: 115_000, allocatedMinor: 115_000, unexplainedMinor: 0, reconciled: true });
  });
});
