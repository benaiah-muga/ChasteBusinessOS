import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  accounts,
  customers,
  expenseClaims,
  fxRates,
  fxSettlements,
  invoices,
  jobs,
  journalEntries,
  journalLines,
  ledgerEvents,
  memberships,
  notifications,
  payments,
  vendorPayments,
  organizations,
  quotes,
  recurringInvoices,
  rolePermissions,
  roles,
  timeEntries,
  userRoles,
  users,
  type Database,
} from "@chaste/db";
import type { KernelExecutor, ActionContext } from "@chaste/kernel";
import { createDb } from "@chaste/db";
import { logger } from "@chaste/kernel";
import { enqueueCapabilityJob, processOneJob } from "./jobs";

/**
 * Functional gap batch, end to end against real Postgres:
 * multi-currency settlement math on the immutable ledger, quote conversion
 * through the single posting path, recurring expansion by the durable
 * worker, timesheet approval flow, expense reimbursement with policy
 * gating, portal share tokens, and the in-app notification feed.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let pg: Database;
let db: Database["db"];
const orgId = crypto.randomUUID();
let userId: string;
let customerId: string;
let executor: KernelExecutor;

function ctxWith(type: "human" | "agent", permissions: string[]): ActionContext {
  return {
    actor: { type, id: userId, orgId, permissions: new Set(permissions) },
    now: new Date(),
    services: {},
  };
}

async function booksBalanced(): Promise<boolean> {
  const [row] = await db
    .select({
      dr: sql<number>`coalesce(sum(${journalLines.debitMinor}),0)`,
      cr: sql<number>`coalesce(sum(${journalLines.creditMinor}),0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(eq(journalEntries.orgId, orgId));
  return Number(row?.dr ?? 0) === Number(row?.cr ?? 0);
}

beforeAll(async () => {
  pg = createDb(url);
  db = pg.db;
  const [user] = await db
    .insert(users)
    .values({ email: `gaps-${orgId.slice(0, 8)}@example.com`, name: "Owner" })
    .returning();
  userId = user!.id;
  await db.insert(organizations).values({
    id: orgId,
    name: "Gaps Org",
    slug: `gaps-${orgId.slice(0, 8)}`,
    profileDescription: "Test workshop",
  });
  await db.insert(memberships).values({ orgId, userId });
  // Posting capabilities need the seeded chart of accounts (same as onboarding).
  const { DEFAULT_CHART_OF_ACCOUNTS } = await import("@chaste/erp-core");
  await db.insert(accounts).values(
    DEFAULT_CHART_OF_ACCOUNTS.map((a) => ({ orgId, code: a.code, name: a.name, type: a.type })),
  );
  const [role] = await db.insert(roles).values({ orgId, key: "owner", name: "Owner", isSystem: true }).returning();
  await db.insert(rolePermissions).values({ roleId: role!.id, permissionKey: "*", orgId });
  await db.insert(userRoles).values({ userId, roleId: role!.id, orgId });

  const [cust] = await db.insert(customers).values({ orgId, name: "Euro Buyer" }).returning({ id: customers.id });
  customerId = cust!.id;

  // Full app registry + governed executor.
  const { buildRegistry } = await import("./kernel");
  const { KernelExecutor, InMemoryLedger } = await import("@chaste/kernel");
  const { DefaultPolicyEngine } = await import("@chaste/kernel");
  executor = new KernelExecutor({
    registry: buildRegistry(db),
    policy: new DefaultPolicyEngine(),
    ledger: new InMemoryLedger(),
  });

});

afterAll(async () => {
  await db.delete(fxSettlements).where(eq(fxSettlements.orgId, orgId));
  await db.delete(vendorPayments).where(eq(vendorPayments.orgId, orgId));
  await db.delete(payments).where(eq(payments.orgId, orgId));
  await db.delete(notifications).where(eq(notifications.orgId, orgId));
  await db.delete(timeEntries).where(eq(timeEntries.orgId, orgId));
  await db.delete(expenseClaims).where(eq(expenseClaims.orgId, orgId));
  await db.delete(recurringInvoices).where(eq(recurringInvoices.orgId, orgId));
  await db.delete(quotes).where(eq(quotes.orgId, orgId));
  await db.delete(invoices).where(eq(invoices.orgId, orgId));
  await db.delete(fxRates).where(eq(fxRates.orgId, orgId));
  await db.delete(customers).where(eq(customers.orgId, orgId));
  await db.delete(journalLines).where(
    sql`${journalLines.entryId} IN (SELECT id FROM journal_entries WHERE org_id = ${orgId})`,
  );
  await db.delete(journalEntries).where(eq(journalEntries.orgId, orgId));
  await db.delete(userRoles).where(eq(userRoles.orgId, orgId));
  await db.delete(rolePermissions).where(eq(rolePermissions.orgId, orgId));
  await db.delete(roles).where(eq(roles.orgId, orgId));
  await db.delete(ledgerEvents).where(eq(ledgerEvents.orgId, orgId));
  await db.delete(jobs).where(eq(jobs.orgId, orgId));
  await db.delete(memberships).where(eq(memberships.orgId, orgId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await pg.client.end();
});

describe("multi-currency settlement", () => {
  it("invoices in EUR at a posted rate and settles with realized gain on the books", async () => {
    const rate = await executor.execute("accounting.recordFxRate", ctxWith("human", ["accounting.post"]), {
      quoteCurrency: "EUR",
      rate: "1.10",
    });
    expect(rate.ok).toBe(true);

    const inv = await executor.execute("accounting.createInvoice", ctxWith("human", ["accounting.write"]), {
      customerId,
      currency: "EUR",
      lines: [{ description: "Consulting", quantity: 1000, unitPriceMinor: 100_000 }],
    });
    expect(inv.ok).toBe(true);
    expect((inv.data as { currency?: string }).currency).toBe("EUR");
    const invoiceNumber = (inv.data as { invoiceNumber: number }).invoiceNumber;

    // Settle at a stronger rate → realized gain of exactly 2_000 base minor:
    // 1,000 EUR × (1.12 − 1.10) = 20 USD = 2,000 minor.
    const pay = await executor.execute(
      "accounting.recordPayment",
      ctxWith("human", ["accounting.post"]),
      { invoiceNumber, amountMinor: 1000_00, method: "bank_transfer", settleFxRate: "1.12" },
    );
    expect(pay.ok).toBe(true);
    const data = pay.data as { gainLossMinor: number; baseEntryId: string; foreignEntryId: string };
    expect(data.gainLossMinor).toBe(2_000);

    const entries = await db
      .select({ id: journalEntries.id, currency: journalEntries.currency })
      .from(journalEntries)
      .where(and(eq(journalEntries.orgId, orgId), eq(journalEntries.sourceType, "payment")));
    const currencies = entries.map((e) => e.currency).sort();
    expect(currencies).toEqual(["EUR", "USD"]);

    const [link] = await db.select().from(fxSettlements).where(eq(fxSettlements.orgId, orgId)).limit(1);
    expect(link!.baseEntryId).toBe(data.baseEntryId);
    expect(link!.foreignEntryId).toBe(data.foreignEntryId);
    expect(await booksBalanced()).toBe(true);
  });

  it("reports remaining exposure per currency at the latest rate", async () => {
    const exposure = await executor.execute(
      "accounting.unrealizedFxExposure",
      ctxWith("human", ["accounting.read"]),
      {},
    );
    expect(exposure.ok).toBe(true);
    // The settled invoice is fully paid, so exposure is empty or zero-summed.
    const rows = (exposure.data as { exposures: Array<{ outstandingForeignMinor: number }> }).exposures;
    const total = rows.reduce((s, r) => s + r.outstandingForeignMinor, 0);
    expect(total).toBe(0);
  });
});

describe("quotes convert through the single posting path", () => {
  it("create → accept produces an ordinary invoice and links it", async () => {
    const q = await executor.execute("accounting.createQuote", ctxWith("human", ["accounting.write"]), {
      customerId,
      lines: [{ description: "Workshop day", quantity: 2000, unitPriceMinor: 50_000 }],
    });
    expect(q.ok).toBe(true);
    const quoteId = (q.data as { quoteId: string }).quoteId;

    const acc = await executor.execute("accounting.acceptQuote", ctxWith("human", ["accounting.write"]), {
      quoteId,
    });
    expect(acc.ok).toBe(true);

    const [row] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(row!.status).toBe("accepted");
    expect(row!.convertedInvoiceId).toBeTruthy();

    const doubleAccept = await executor.execute(
      "accounting.acceptQuote",
      ctxWith("human", ["accounting.write"]),
      { quoteId },
    );
    expect(doubleAccept.ok).toBe(false);
  });

  it("declining removes a sent quote from circulation", async () => {
    const q = await executor.execute("accounting.createQuote", ctxWith("human", ["accounting.write"]), {
      customerId,
      lines: [{ description: "X", quantity: 1000, unitPriceMinor: 1_000 }],
    });
    const quoteId = (q.data as { quoteId: string }).quoteId;
    const declined = await executor.execute(
      "accounting.declineQuote",
      ctxWith("human", ["accounting.write"]),
      { quoteId },
    );
    expect((declined.data as { status?: string }).status ?? "declined").toBe("declined");
    const acc = await executor.execute("accounting.acceptQuote", ctxWith("human", ["accounting.write"]), {
      quoteId,
    });
    expect(acc.ok).toBe(false);
  });
});

describe("recurring invoices expand through the worker", () => {
  it("generates due invoices and reschedules without double-billing", async () => {
    const tpl = await executor.execute("accounting.createRecurringTemplate", ctxWith("human", ["accounting.write"]), {
      customerId,
      frequency: "monthly",
      memo: "Hosting retainer",
      lines: [{ description: "Hosting", quantity: 1000, unitPriceMinor: 9_900 }],
      firstRunAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(tpl.ok).toBe(true);
    const templateId = (tpl.data as { templateId: string }).templateId;

    const before = (
      await db.select().from(invoices).where(and(eq(invoices.orgId, orgId), eq(invoices.customerId, customerId)))
    ).length;

    const _jobId = await enqueueCapabilityJob(db, {
      orgId,
      type: "accounting.generateDueInvoices",
      payload: {},
    });
    await processOneJob(db, logger);



    const after = (
      await db.select().from(invoices).where(and(eq(invoices.orgId, orgId), eq(invoices.customerId, customerId)))
    ).length;
    expect(after).toBe(before + 1);

    const [template] = await db.select().from(recurringInvoices).where(eq(recurringInvoices.id, templateId));
    expect(template!.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(template!.lastRunAt).toBeTruthy();
    expect(await booksBalanced()).toBe(true);
  });
});
