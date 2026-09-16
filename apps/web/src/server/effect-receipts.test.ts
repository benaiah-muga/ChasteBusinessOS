import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, invoices, payments, organizations, accounts, customers, type Database, purgeTenantFinancials } from "@chaste/db";
import { CapabilityRegistry, KernelExecutor, type NewLedgerEntry } from "@chaste/kernel";
import { registerAccountingCapabilities } from "@chaste/module-accounting";
import { pgEffectReceiptStore } from "./effect-receipts";

/**
 * B02 integration proof on the real receipt store: a governed payment
 * executed twice under one intent key commits once and replays; a reused key
 * with a different payload is a conflict; an unproven outcome (audit failure
 * after commit) persists as unknown so the retry reconciles instead of
 * double-posting.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database["db"];
let pg: Database;
let executor: KernelExecutor;
let failAudit = false;
const orgId = crypto.randomUUID();

const ctx = (intentId: string) => ({
  actor: { type: "human" as const, id: crypto.randomUUID(), orgId, permissions: new Set(["accounting.post"]) },
  intentId,
  now: new Date(),
  services: {},
});

beforeAll(async () => {
  pg = createDb(url);
  db = pg.db;
  await db.insert(organizations).values({ id: orgId, name: "Receipt Org", slug: `receipt-org-${orgId.slice(0, 8)}` });
  await db.insert(accounts).values([
    { orgId, code: "1000", name: "Cash", type: "asset" },
    { orgId, code: "1100", name: "AR", type: "asset" },
  ]);
  const customerId = crypto.randomUUID();
  await db.insert(customers).values({ id: customerId, orgId, name: "Receipt Customer" });
  await db.insert(invoices).values({
    orgId,
    customerId,
    number: 1,
    status: "sent",
    subtotalMinor: 10000,
    taxMinor: 0,
    totalMinor: 10000,
    currency: "USD",
    issuedAt: new Date(),
  });

  const registry = new CapabilityRegistry();
  registerAccountingCapabilities(registry, { db });
  executor = new KernelExecutor({
    registry,
    ledger: {
      lastHash: async () => null,
      append: async (entry: NewLedgerEntry) => {
        if (failAudit && entry.kind === "capability.executed") throw new Error("audit connection lost");
        return 0;
      },
    },
    receipts: pgEffectReceiptStore(db),
  });
});

afterAll(async () => {
  await db.delete(payments).where(eq(payments.orgId, orgId));
  await db.delete(invoices).where(eq(invoices.orgId, orgId));
  await purgeTenantFinancials(db, orgId);
  await db.delete(accounts).where(eq(accounts.orgId, orgId));
  await db.delete(customers).where(eq(customers.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await pg.client.end();
});

describe("action receipts (B02)", () => {
  it("commits once and replays the receipt for a repeated intent", async () => {
    const first = await executor.execute("accounting.recordPayment", ctx("pay-1"), {
      invoiceNumber: 1,
      amountMinor: 4000,
      method: "bank_transfer",
    });
    expect(first.ok).toBe(true);
    expect(first.outcome).toBe("known");
    expect(first.replayed).toBeUndefined();

    const second = await executor.execute("accounting.recordPayment", ctx("pay-1"), {
      invoiceNumber: 1,
      amountMinor: 4000,
      method: "bank_transfer",
    });
    expect(second.replayed).toBe(true);
    expect(second.data).toEqual(first.data);

    const rows = await db.select().from(payments).where(eq(payments.orgId, orgId));
    expect(rows).toHaveLength(1);
  });

  it("refuses a reused intent key carrying a different payload", async () => {
    const conflict = await executor.execute("accounting.recordPayment", ctx("pay-1"), {
      invoiceNumber: 1,
      amountMinor: 6000,
      method: "cash",
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.error).toContain("conflict");
    const rows = await db.select().from(payments).where(eq(payments.orgId, orgId));
    expect(rows).toHaveLength(1);
  });

  it("an unproven outcome persists so the retry reconciles instead of double-posting", async () => {
    failAudit = true;
    const unproven = await executor.execute("accounting.recordPayment", ctx("pay-2"), {
      invoiceNumber: 1,
      amountMinor: 2000,
      method: "bank_transfer",
    });
    expect(unproven.ok).toBe(false);
    expect(unproven.outcome).toBe("unknown");

    const retry = await executor.execute("accounting.recordPayment", ctx("pay-2"), {
      invoiceNumber: 1,
      amountMinor: 2000,
      method: "bank_transfer",
    });
    expect(retry.replayed).toBe(true);
    expect(retry.outcome).toBe("unknown");

    const rows = await db.select().from(payments).where(eq(payments.orgId, orgId));
    expect(rows).toHaveLength(2);
  });
});
