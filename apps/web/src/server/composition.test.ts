import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  accounts,
  createDb,
  journalEntries,
  journalLines,
  ledgerEvents,
  organizations,
  type Database,
} from "@chaste/db";
import { buildExecutor, buildRegistry } from "./kernel";

/**
 * Composition conformance (ADR 0035): the full registry is safe under module
 * subsets. A disabled module's capabilities are refused wholesale; an enabled
 * capability keeps working with its disabled siblings' effects skipped.
 *
 * Runs against the local database (owner role: RLS-exempt).
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let store: Database;
let db: Database["db"];
const orgId = crypto.randomUUID();
const SUBSET = ["pos", "accounting"]; // deliberately without inventory/crm

async function purge(): Promise<void> {
  // The event ledger restricts org deletion on purpose (append-only), so
  // purge each probe org's events before the org row itself.
  const probes = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.name, "Composition Probe"));
  for (const probe of probes) {
    const entries = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(eq(journalEntries.orgId, probe.id));
    for (const e of entries) {
      await db.delete(journalLines).where(eq(journalLines.entryId, e.id));
    }
    await db.delete(journalEntries).where(eq(journalEntries.orgId, probe.id));
    await db.delete(ledgerEvents).where(eq(ledgerEvents.orgId, probe.id));
    await db.delete(organizations).where(eq(organizations.id, probe.id));
  }
}

beforeAll(async () => {
  store = createDb(url);
  db = store.db;
  await purge();
  await db.insert(organizations).values({
    id: orgId,
    name: "Composition Probe",
    slug: `cmp-${orgId.slice(0, 8)}`,
    enabledModules: SUBSET,
  });
  await db.insert(accounts).values([
    { orgId, code: "1000", name: "Cash", type: "asset" },
    { orgId, code: "1200", name: "Inventory", type: "asset" },
    { orgId, code: "2100", name: "Sales Tax Payable", type: "liability" },
    { orgId, code: "4000", name: "Sales Revenue", type: "income" },
    { orgId, code: "5000", name: "Cost of Goods Sold", type: "expense" },
  ]);
});

afterAll(async () => {
  await purge();
  await store.client.end();
});

function executor() {
  return buildExecutor(db, buildRegistry(db));
}

function ctx(now = new Date()) {
  return {
    actor: { type: "human" as const, id: null, orgId, permissions: new Set(["*"]) },
    now,
    services: {},
  };
}

describe("module subset matrix (ADR 0035)", () => {
  it("refuses capabilities of modules outside the org's subset", async () => {
    const fx = executor();
    const offInventory = await fx.execute("inventory.stockReport", ctx(), { belowReorderOnly: false });
    expect(offInventory.ok).toBe(false);
    expect(offInventory.error).toContain('module "inventory" is disabled');

    const offCrm = await fx.execute("crm.createCustomer", ctx(), { name: "Should Refuse" });
    expect(offCrm.ok).toBe(false);
    expect(offCrm.error).toContain('module "crm" is disabled');
  });

  it("keeps enabled modules fully functional under the same registry", async () => {
    const fx = executor();
    const opened = await fx.execute("pos.openSession", ctx(), {});
    expect(opened.ok).toBe(true);
    const tb = await fx.execute("accounting.trialBalance", ctx(), {});
    expect(tb.ok).toBe(true);
    const tbData = tb.data as { balanced?: boolean } | undefined;
    expect(tbData?.balanced).toBe(true);
  });
});

