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
 * Bank matching must establish economic equivalence, not just identity
 * (N14): same amount, same direction, same currency, and a payment or entry
 * cannot be claimed by two statement lines. Unmatching restores the claim.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;
let customerId: string;
let paymentId: string;
let invoiceNumber: number;
let usdAccountId: string;
let eurAccountId: string;
const CASH = "1000";
const AR = "1100";
const REVENUE = "4000";

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

async function feedLine(amountMinor: number, description: string): Promise<string> {
  await run("accounting.importBankFeed", {
    bankAccountId: usdAccountId,
    rows: [{ postedAt: "2026-09-15", amountMinor, description }],
  });
  const [row] = await db.db
    .select({ id: bankTransactions.id })
    .from(bankTransactions)
    .where(eq(bankTransactions.description, description));
  return row!.id;
}

async function purgeProbeOrgs(): Promise<void> {
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Bank Match Probe"));
  for (const o of orgs) {
    await purgeTenantFinancials(db.db, o.id);
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await purgeProbeOrgs();
  await db.db.insert(organizations).values({ id: orgId, name: "Bank Match Probe", slug: `bm-${orgId.slice(0, 8)}` });
  await db.db.insert(accounts).values([
    { orgId, code: CASH, name: "Cash", type: "asset" },
    { orgId, code: AR, name: "Accounts Receivable", type: "asset" },
    { orgId, code: REVENUE, name: "Sales Revenue", type: "income" },
  ]);
  const [cust] = await db.db.insert(customers).values({ orgId, name: "Bank Probe Buyer" }).returning({ id: customers.id });
  customerId = cust!.id;
  const [usd] = await db.db
    .insert(bankAccounts)
    .values({ orgId, name: "Operating USD", currencyCode: "USD" })
    .returning({ id: bankAccounts.id });
  usdAccountId = usd!.id;
  const [eur] = await db.db
    .insert(bankAccounts)
    .values({ orgId, name: "Operating EUR", currencyCode: "EUR" })
    .returning({ id: bankAccounts.id });
  eurAccountId = eur!.id;
  ctx = { actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) }, now: new Date(), services: {} };

  const inv = await run("accounting.createInvoice", {
    customerId,
    lines: [{ description: "Consulting", quantity: 1_000, unitPriceMinor: 100_000 }],
  });
  invoiceNumber = inv.invoiceNumber;
  expect(inv.totalMinor).toBe(100_000);
  const pay = await run("accounting.recordPayment", { invoiceNumber, amountMinor: 100_000 });
  paymentId = pay.paymentId;
});

afterAll(async () => {
  await purgeProbeOrgs();
});

describe("bank matching equivalence (N14)", () => {
  it("an exact same-currency receipt matches", async () => {
    const lineId = await feedLine(100_000, "wire from buyer exact");
    const matched = await run("accounting.matchBankTransaction", { transactionId: lineId, paymentId });
    expect(matched.status).toBe("matched");
    // Release the claim so later tests exercise exclusivity from a clean slate.
    await run("accounting.unmatchBankTransaction", { transactionId: lineId });
  });

  it("refuses an amount mismatch: 100 banked does not reconcile a 10 payment", async () => {
    const lineId = await feedLine(10_000, "wire from buyer small");
    await expect(run("accounting.matchBankTransaction", { transactionId: lineId, paymentId })).rejects.toThrow(
      /amount mismatch: statement line is 10000, payment is 100000/,
    );
  });

  it("refuses a direction mismatch: a payment is money in, not money out", async () => {
    const lineId = await feedLine(-100_000, "outgoing refund");
    await expect(run("accounting.matchBankTransaction", { transactionId: lineId, paymentId })).rejects.toThrow(
      /direction mismatch/,
    );
  });

  it("refuses a currency mismatch against the statement account", async () => {
    await run("accounting.importBankFeed", { bankAccountId: eurAccountId, rows: [{ postedAt: "2026-09-15", amountMinor: 100_000, description: "eur wire" }] });
    const [line] = await db.db
      .select({ id: bankTransactions.id })
      .from(bankTransactions)
      .where(eq(bankTransactions.description, "eur wire"));
    await expect(run("accounting.matchBankTransaction", { transactionId: line!.id, paymentId })).rejects.toThrow(
      /currency mismatch: statement account is EUR, payment is USD/,
    );
  });

  it("two statement lines cannot each claim the same payment; unmatch restores availability", async () => {
    const firstId = await feedLine(100_000, "duplicate wire A");
    const secondId = await feedLine(100_000, "duplicate wire B");
    await run("accounting.matchBankTransaction", { transactionId: firstId, paymentId });
    await expect(run("accounting.matchBankTransaction", { transactionId: secondId, paymentId })).rejects.toThrow(
      /already reconciled by another statement line/,
    );

    // The unique claim lives in data, not just the guard clause: a second
    // line pointing at the same payment cannot be matched by any path.
    let accepted = false;
    try {
      await db.db.insert(bankTransactions).values({
        orgId,
        bankAccountId: usdAccountId,
        postedAt: new Date("2026-09-15T00:00:00Z"),
        amountMinor: 100_000,
        description: "rogue claim",
        status: "matched",
        matchedPaymentId: paymentId,
      });
      accepted = true;
    } catch (error) {
      // drizzle wraps the driver error; the unique violation is its cause.
      const cause = String((error as { cause?: unknown }).cause ?? error);
      expect(cause).toMatch(/duplicate key|unique constraint|bank_tx_payment_claim_idx/i);
    }
    expect(accepted).toBe(false);

    await run("accounting.unmatchBankTransaction", { transactionId: firstId });
    const again = await run("accounting.matchBankTransaction", { transactionId: secondId, paymentId });
    expect(again.status).toBe("matched");
  });

  it("entry matches require the entry to move cash by the line's signed amount", async () => {
    await deps.db.transaction(async (tx) => {
      const { postEntry } = await import("./posting");
      await postEntry(tx, orgId, { type: "human", id: null }, {
        memo: "misc cash receipt",
        sourceType: "manual",
        postedAt: ctx.now,
        currency: "USD",
        lines: [
          { accountCode: CASH, debitMinor: 25_000, creditMinor: 0 },
          { accountCode: REVENUE, debitMinor: 0, creditMinor: 25_000 },
        ],
      });
    });
    const [entry] = await db.db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(eq(journalEntries.memo, "misc cash receipt"));

    const wrongId = await feedLine(30_000, "misc receipt wrong amount");
    await expect(run("accounting.matchBankTransaction", { transactionId: wrongId, entryId: entry!.id })).rejects.toThrow(
      /cash effect mismatch: entry nets 25000 on account 1000, statement line is 30000/,
    );

    const rightId = await feedLine(25_000, "misc receipt exact");
    const matched = await run("accounting.matchBankTransaction", { transactionId: rightId, entryId: entry!.id });
    expect(matched.status).toBe("matched");

    // The entry claim is exclusive too: another line cannot claim it.
    const otherId = await feedLine(25_000, "misc receipt second claim");
    await expect(run("accounting.matchBankTransaction", { transactionId: otherId, entryId: entry!.id })).rejects.toThrow(
      /already reconciled by another statement line/,
    );
  });
});
