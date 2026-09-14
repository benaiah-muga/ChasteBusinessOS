import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  accounts,
  createDb,
  customers,
  invoices,
  journalEntries,
  journalLines,
  organizations,
  recurringInvoiceRuns,
  recurringInvoices,
  type Database,
} from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerAccountingCapabilities, type ModuleDeps } from "./index";

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
const orgId = crypto.randomUUID();
const templateId = crypto.randomUUID();
const scheduledFor = new Date("2026-09-01T00:00:00.000Z");

let db: Database;
let deps: ModuleDeps;
let customerId: string;
let ctx: ActionContext;

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await db.db.insert(organizations).values({ id: orgId, name: "Recurring Invoice Probe", slug: `rec-${orgId.slice(0, 8)}` });
  await db.db.insert(accounts).values([
    { orgId, code: "1100", name: "Accounts Receivable", type: "asset" },
    { orgId, code: "4000", name: "Sales Revenue", type: "income" },
    { orgId, code: "2100", name: "Sales Tax Payable", type: "liability" },
  ]);
  const [customer] = await db.db.insert(customers).values({ orgId, name: "Recurring Buyer" }).returning({ id: customers.id });
  customerId = customer!.id;
  await db.db.insert(recurringInvoices).values({
    id: templateId,
    orgId,
    customerId,
    frequency: "monthly",
    lines: [{ description: "Hosting", quantity: 1_000, unitPriceMinor: 9_900, taxMinor: 0 }],
    nextRunAt: scheduledFor,
    createdByActorType: "human",
  });
  ctx = { actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) }, now: new Date("2026-09-02T00:00:00.000Z"), services: {} };
});

afterAll(async () => {
  const entries = await db.db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.orgId, orgId));
  for (const entry of entries) {
    await db.db.delete(journalLines).where(eq(journalLines.entryId, entry.id));
  }
  await db.db.delete(journalEntries).where(eq(journalEntries.orgId, orgId));
  await db.db.delete(organizations).where(eq(organizations.id, orgId));
  await db.client.end();
});

function generateDueInvoices(): (ctx: ActionContext, input: unknown) => Promise<{ generated: number }> {
  const registry = new CapabilityRegistry();
  registerAccountingCapabilities(registry, deps);
  const cap = registry.get("accounting.generateDueInvoices");
  if (!cap) throw new Error("recurring invoice capability is not registered");
  return cap.execute as (ctx: ActionContext, input: unknown) => Promise<{ generated: number }>;
}

describe("recurring invoice occurrences", () => {
  it("uses the scheduled instant as a unique idempotency boundary", async () => {
    const run = generateDueInvoices();
    const first = await run(ctx, {});
    expect(first.generated).toBe(1);

    // Simulate a legacy/recovery path that has selected the same due instant
    // again. The occurrence key must prevent a second posted invoice.
    await db.db.update(recurringInvoices).set({ nextRunAt: scheduledFor }).where(eq(recurringInvoices.id, templateId));
    const second = await run(ctx, {});
    expect(second.generated).toBe(0);

    const invoiceRows = await db.db.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.orgId, orgId), eq(invoices.customerId, customerId)));
    const occurrenceRows = await db.db.select().from(recurringInvoiceRuns).where(eq(recurringInvoiceRuns.recurringInvoiceId, templateId));
    expect(invoiceRows).toHaveLength(1);
    expect(occurrenceRows).toHaveLength(1);
    expect(occurrenceRows[0]!.invoiceId).toBe(invoiceRows[0]!.id);
    expect(occurrenceRows[0]!.status).toBe("completed");
  });
});
