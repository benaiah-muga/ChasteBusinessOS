import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  accounts,
  actionReceipts,
  createDb,
  customers,
  invoices,
  organizations,
  payments,
  withOrgContext,
  type Database,
  purgeTenantFinancials,
} from "@chaste/db";
import { KernelExecutor } from "@chaste/kernel";
import { pgEffectReceiptStore } from "./effect-receipts";
import { PgLedgerStore } from "./kernel";
import { composeRegistry } from "./kernel";
import { executeAtomically } from "./unit-of-work";

/**
 * B02 unit-of-work proof: with a transaction-backed executor, mutation,
 * audit fact and receipt commit together. An audit failure after the write
 * rolls the whole unit back - payments, ledger events and receipts all gone
 * - so the retry starts clean instead of reconciling an unknown outcome.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database["db"];
let pg: Database;
const orgId = crypto.randomUUID();

const ctx = (intentId: string) => ({
  actor: { type: "human" as const, id: crypto.randomUUID(), orgId, permissions: new Set(["accounting.post"]) },
  intentId,
  now: new Date(),
  services: {},
});

async function countPayments(): Promise<number> {
  return (await db.select().from(payments).where(eq(payments.orgId, orgId))).length;
}

beforeAll(async () => {
  pg = createDb(url);
  db = pg.db;
  await db.insert(organizations).values({ id: orgId, name: "UoW Org", slug: `uow-org-${orgId.slice(0, 8)}` });
  await db.insert(accounts).values([
    { orgId, code: "1000", name: "Cash", type: "asset" },
    { orgId, code: "1100", name: "AR", type: "asset" },
  ]);
  const customerId = crypto.randomUUID();
  await db.insert(customers).values({ id: customerId, orgId, name: "UoW Customer" });
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
});

afterAll(async () => {
  await db.delete(actionReceipts).where(eq(actionReceipts.orgId, orgId));
  await db.delete(payments).where(eq(payments.orgId, orgId));
  await db.delete(invoices).where(eq(invoices.orgId, orgId));
await purgeTenantFinancials(db, orgId);
  await purgeTenantFinancials(db, orgId);
  await db.delete(accounts).where(eq(accounts.orgId, orgId));
  await db.delete(customers).where(eq(customers.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await pg.client.end();
});

describe("atomic unit of work (B02)", () => {
  it("commits mutation, audit and receipt together; a retry replays the receipt", async () => {
    const first = await executeAtomically<{ paymentId: string; entryId: string }>({
      db,
      orgId,
      ctx: ctx("uow-1"),
      capabilityId: "accounting.recordPayment",
      input: { invoiceNumber: 1, amountMinor: 3000, method: "bank_transfer" },
    });
    expect(first.ok).toBe(true);
    expect(await countPayments()).toBe(1);
    const receipts = await db.select().from(actionReceipts).where(eq(actionReceipts.orgId, orgId));
    expect(receipts).toHaveLength(1);

    const retry = await executeAtomically({
      db,
      orgId,
      ctx: ctx("uow-1"),
      capabilityId: "accounting.recordPayment",
      input: { invoiceNumber: 1, amountMinor: 3000, method: "bank_transfer" },
    });
    expect(retry.replayed).toBe(true);
    expect(await countPayments()).toBe(1);
  });

  it("an audit failure after the write rolls back the whole unit", async () => {
    let auditCalls = 0;
    // The throw must escape the unit-of-work callback: swallowing it inside
    // would let the transaction commit a half-proven action.
    await expect(
      withOrgContext(db, orgId, async (rawTx) => {
        // Runtime-identical to the db handle; the cast is the B02 seam.
        const tx = rawTx as unknown as Database["db"];
        const inner = new PgLedgerStore(tx);
        const executor = new KernelExecutor({
          registry: composeRegistry(tx),
          ledger: {
            lastHash: async () => inner.lastHash(),
            append: async (entry) => {
              auditCalls += 1;
              if (auditCalls === 1) throw new Error("audit storage down");
              return inner.append(entry);
            },
          },
          receipts: pgEffectReceiptStore(tx),
          failOnAuditError: true,
        });
        await executor.execute("accounting.recordPayment", ctx("uow-crash"), {
          invoiceNumber: 1,
          amountMinor: 2000,
          method: "bank_transfer",
        });
      }),
    ).rejects.toThrow("audit storage down");

    expect(await countPayments()).toBe(1); // only uow-1's payment survives
    const receipts = await db.select().from(actionReceipts).where(eq(actionReceipts.orgId, orgId));
    expect(receipts).toHaveLength(1);
  });

  it("the retry after a rolled-back unit starts clean and commits once", async () => {
    const result = await executeAtomically({
      db,
      orgId,
      ctx: ctx("uow-crash"),
      capabilityId: "accounting.recordPayment",
      input: { invoiceNumber: 1, amountMinor: 2000, method: "bank_transfer" },
    });
    expect(result.ok).toBe(true);
    expect(result.replayed).toBeUndefined();
    expect(await countPayments()).toBe(2); // uow-1's 3000 plus this 2000
  });
});
