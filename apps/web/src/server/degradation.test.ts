import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  accounts,
  createDb,
  organizations,
  posSessions,
  stockMovements,
  journalEntries,
  journalLines,
  ledgerEvents,
  type Database,
} from "@chaste/db";
import { buildExecutor, buildRegistry } from "./kernel";

/**
 * Graceful degradation (ADR 0035): an org running POS without Inventory
 * still sells — the money path posts, the stock ledger is untouched, and
 * the audit chain records everything.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let store: Database;
let db: Database["db"];
const orgId = crypto.randomUUID();

async function purge(): Promise<void> {
  // The event ledger restricts org deletion on purpose (append-only), so
  // purge each probe org's events before the org row itself.
  const probes = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.name, "Degradation Probe"));
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
    name: "Degradation Probe",
    slug: `deg-${orgId.slice(0, 8)}`,
    enabledModules: ["pos", "accounting"],
  });
  await db.insert(accounts).values([
    { orgId, code: "1000", name: "Cash", type: "asset" },
    { orgId, code: "4000", name: "Sales Revenue", type: "income" },
  ]);
});

afterAll(async () => {
  await purge();
  await store.client.end();
});

function executor() {
  return buildExecutor(db, buildRegistry(db));
}

function ctx() {
  return {
    actor: { type: "human" as const, id: null, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };
}

describe("graceful degradation (ADR 0035)", () => {
  it("POS sale with Inventory disabled: money posts, stock ledger untouched", async () => {
    const fx = executor();
    const [session] = await db
      .insert(posSessions)
      .values({ orgId, openedAt: new Date() })
      .returning({ id: posSessions.id });

    const sale = await fx.execute("pos.completeSale", ctx(), {
      sessionId: session!.id,
      lines: [{ description: "Counter sale", quantity: 2_000, unitPriceMinor: 15_000, taxMinor: 0, sku: "NOSKU-1" }],
      method: "cash",
    });
    expect(sale.ok).toBe(true);
    const saleData = sale.data as { totalMinor?: number } | undefined;
    expect(saleData?.totalMinor).toBe(30_000);

    // The money path ran; the inventory effect was skipped entirely.
    const movements = await db.select().from(stockMovements).where(eq(stockMovements.orgId, orgId));
    expect(movements).toHaveLength(0);

    // The audit chain still recorded the executed capability.
    const tb = await fx.execute("accounting.trialBalance", ctx(), {});
    const tbData = tb.data as { balanced?: boolean; lines?: { code: string }[] } | undefined;
    expect(tbData?.balanced).toBe(true);
    expect(tbData?.lines?.some((l) => l.code === "4000")).toBe(true);
  });
});
