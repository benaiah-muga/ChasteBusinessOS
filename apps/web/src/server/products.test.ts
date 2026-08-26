import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  accounts,
  customers,
  invoiceLines,
  invoices,
  items,
  payments,
  quoteLines,
  journalEntries,
  journalLines,
  memberships,
  organizations,
  quotes,
  rolePermissions,
  roles,
  userRoles,
  users,
  type Database,
} from "@chaste/db";
import type { KernelExecutor, ActionContext } from "@chaste/kernel";
import { createDb } from "@chaste/db";

/**
 * Products & sales surface, end to end against real Postgres: item catalog
 * with sale price exposure, archiving (history kept, pickers clean), and the
 * quote lifecycle — create as sent, accept converts through the single
 * posting path into a balanced invoice, decline is terminal.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let pg: Database;
let db: Database["db"];
const orgId = crypto.randomUUID();
let userId: string;
let customerId: string;
let executor: KernelExecutor;

function ctx(): ActionContext {
  return {
    actor: { type: "human", id: userId, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };
}

beforeAll(async () => {
  pg = createDb(url);
  db = pg.db;
  const [user] = await db
    .insert(users)
    .values({ email: `products-${orgId.slice(0, 8)}@example.com`, name: "Owner" })
    .returning();
  userId = user!.id;
  await db.insert(organizations).values({
    id: orgId,
    name: "Products Org",
    slug: `products-${orgId.slice(0, 8)}`,
    profileDescription: "Test shop",
  });
  await db.insert(memberships).values({ orgId, userId });
  const { DEFAULT_CHART_OF_ACCOUNTS } = await import("@chaste/erp-core");
  await db.insert(accounts).values(
    DEFAULT_CHART_OF_ACCOUNTS.map((a) => ({ orgId, code: a.code, name: a.name, type: a.type })),
  );
  const [role] = await db.insert(roles).values({ orgId, key: "owner", name: "Owner", isSystem: true }).returning();
  await db.insert(rolePermissions).values({ roleId: role!.id, permissionKey: "*", orgId });
  await db.insert(userRoles).values({ userId, roleId: role!.id, orgId });
  const [cust] = await db.insert(customers).values({ orgId, name: "Catalog Buyer" }).returning({ id: customers.id });
  customerId = cust!.id;

  const { buildRegistry } = await import("./kernel");
  const { KernelExecutor, InMemoryLedger, DefaultPolicyEngine } = await import("@chaste/kernel");
  executor = new KernelExecutor({
    registry: buildRegistry(db),
    policy: new DefaultPolicyEngine(),
    ledger: new InMemoryLedger(),
  });
});

afterAll(async () => {
  await db.delete(quoteLines).where(
    sql`${quoteLines.quoteId} IN (SELECT id FROM quotes WHERE org_id = ${orgId})`,
  );
  await db.delete(payments).where(eq(payments.orgId, orgId));
  await db.delete(invoiceLines).where(
    sql`${invoiceLines.invoiceId} IN (SELECT id FROM invoices WHERE org_id = ${orgId})`,
  );
  await db.delete(invoices).where(eq(invoices.orgId, orgId));
  await db.delete(quotes).where(eq(quotes.orgId, orgId));
  await db.delete(journalLines).where(
    sql`${journalLines.entryId} IN (SELECT id FROM journal_entries WHERE org_id = ${orgId})`,
  );
  await db.delete(journalEntries).where(eq(journalEntries.orgId, orgId));
  await db.delete(customers).where(eq(customers.orgId, orgId));
  await db.delete(items).where(eq(items.orgId, orgId));
  await db.delete(userRoles).where(eq(userRoles.orgId, orgId));
  await db.delete(rolePermissions).where(eq(rolePermissions.orgId, orgId));
  await db.delete(roles).where(eq(roles.orgId, orgId));
  await db.delete(memberships).where(eq(memberships.orgId, orgId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await pg.client.end();
});

describe("product catalog", () => {
  it("creates an item with sale price and exposes it in the stock report", async () => {
    const created = await executor.execute(
      "inventory.createItem",
      ctx(),
      { sku: "LAMP-1", name: "Brass Lamp", salePriceMinor: 4500, unitLabel: "piece" },
    );
    expect(created.ok).toBe(true);

    const report = await executor.execute("inventory.stockReport", ctx(), {});
    expect(report.ok).toBe(true);
    const lamp = (report.data as { items: { sku: string; salePriceMinor: number }[] }).items.find(
      (i) => i.sku === "LAMP-1",
    );
    expect(lamp?.salePriceMinor).toBe(4500);
  });

  it("refuses duplicate SKUs", async () => {
    const dupe = await executor.execute("inventory.createItem", ctx(), {
      sku: "LAMP-1",
      name: "Another Lamp",
    });
    expect(dupe.ok).toBe(false);
    expect(dupe.error).toMatch(/already exists/);
  });

  it("archives without deleting: hidden from report, row and history intact", async () => {
    const archived = await executor.execute("inventory.archiveItem", ctx(), {
      sku: "LAMP-1",
      archive: true,
    });
    expect(archived.ok).toBe(true);

    const report = await executor.execute("inventory.stockReport", ctx(), {});
    const visible = (report.data as { items: { sku: string }[] }).items.some((i) => i.sku === "LAMP-1");
    expect(visible).toBe(false);

    const [row] = await db.select().from(items).where(eq(items.orgId, orgId));
    expect(row?.archivedAt).not.toBeNull();

    // The declared inverse restores it.
    const restored = await executor.execute("inventory.archiveItem", ctx(), {
      sku: "LAMP-1",
      archive: false,
    });
    expect(restored.ok).toBe(true);
    const again = await executor.execute("inventory.stockReport", ctx(), {});
    const back = (again.data as { items: { sku: string }[] }).items.some((i) => i.sku === "LAMP-1");
    expect(back).toBe(true);
  });
});

describe("quote lifecycle", () => {
  it("creates quotes already sent with computed totals", async () => {
    const result = await executor.execute("accounting.createQuote", ctx(), {
      customerId,
      lines: [{ description: "Two lamps", quantity: 2000, unitPriceMinor: 4500, taxMinor: 500 }],
    });
    expect(result.ok).toBe(true);
    const data = result.data as { quoteNumber: number; totalMinor: number };
    expect(data.quoteNumber).toBe(1);
    expect(data.totalMinor).toBe(9500);
  });

  it("converts an accepted quote into a posted, balanced invoice verbatim", async () => {
    const list = await executor.execute("accounting.listQuotes", ctx(), {});
    const quote = (list.data as { quotes: { id: string; status: string }[] }).quotes[0]!;
    expect(quote.status).toBe("sent");

    const accepted = await executor.execute("accounting.acceptQuote", ctx(), { quoteId: quote.id });
    expect(accepted.ok).toBe(true);
    expect((accepted.data as { totalMinor: number }).totalMinor).toBe(9500);

    const [row] = await db.select().from(quotes).where(eq(quotes.orgId, orgId));
    expect(row?.status).toBe("accepted");
    expect(row?.convertedInvoiceId).not.toBeNull();

    const [bal] = await db
      .select({
        dr: sql<number>`coalesce(sum(${journalLines.debitMinor}),0)`,
        cr: sql<number>`coalesce(sum(${journalLines.creditMinor}),0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(eq(journalEntries.orgId, orgId));
    expect(Number(bal?.dr ?? 0)).toBe(Number(bal?.cr ?? 0));

    // A decided quote cannot convert twice.
    const race = await executor.execute("accounting.acceptQuote", ctx(), { quoteId: quote.id });
    expect(race.ok).toBe(false);
  });

  it("declines open quotes terminally", async () => {
    const made = await executor.execute("accounting.createQuote", ctx(), {
      customerId,
      lines: [{ description: "One shade", quantity: 1000, unitPriceMinor: 1200 }],
    });
    const id = (made.data as { quoteId: string }).quoteId;
    const declined = await executor.execute("accounting.declineQuote", ctx(), { quoteId: id });
    expect(declined.ok).toBe(true);
    const second = await executor.execute("accounting.acceptQuote", ctx(), { quoteId: id });
    expect(second.ok).toBe(false);
  });
});
