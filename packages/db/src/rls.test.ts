import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, withOrgContext, type Database } from "./client";
import {
  accounts,
  cycleCountLines,
  cycleCounts,
  items,
  journalEntries,
  journalLines,
  lots,
  memberships,
  organizations,
  stockLocations,
  stockReservations,
  workOrders,
} from "./schema/index";

/**
 * Proof that migration 0014's RLS policies actually isolate tenants when the
 * connection cannot bypass RLS. The app owner (who ran migrations) is exempt
 * by Postgres design; this probe connects as a dedicated NOBYPASSRLS role.
 */

const PROBE_PASSWORD = "rls_probe_dev_only";
const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let admin: Database;
let probe: Database;
const orgA = crypto.randomUUID();
const orgB = crypto.randomUUID();

function asProbeRole(): Database {
  const u = new URL(url);
  u.username = "chaste_rls_probe";
  u.password = PROBE_PASSWORD;
  return createDb(u.toString());
}

beforeAll(async () => {
  admin = createDb(url);
  await admin.db.insert(organizations).values([
    { id: orgA, name: "RLS Probe A", slug: `rls-probe-a-${orgA.slice(0, 8)}` },
    { id: orgB, name: "RLS Probe B", slug: `rls-probe-b-${orgB.slice(0, 8)}` },
  ]);
  await admin.db.insert(accounts).values([
    { orgId: orgA, code: "1000", name: "Cash A", type: "asset" },
    { orgId: orgB, code: "1000", name: "Cash B", type: "asset" },
  ]);
  await admin.client.unsafe(`
    DROP ROLE IF EXISTS chaste_rls_probe;
    CREATE ROLE chaste_rls_probe LOGIN PASSWORD '${PROBE_PASSWORD}' NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO chaste_rls_probe;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO chaste_rls_probe;
  `);
  probe = asProbeRole();
});

afterAll(async () => {
  await admin.db.delete(memberships).where(sql`org_id in (${orgA}, ${orgB})`);
  await admin.db.delete(accounts).where(sql`org_id in (${orgA}, ${orgB})`);
  await admin.db.delete(organizations).where(sql`id in (${orgA}, ${orgB})`);
  await admin.client.unsafe(`DROP OWNED BY chaste_rls_probe; DROP ROLE IF EXISTS chaste_rls_probe`);
  await admin.client.end();
  if (probe) await probe.client.end();
});

describe("row-level security", () => {
  it("a scoped role with no app.org_id sees nothing tenant-owned", async () => {
    const rows = await probe.db.select().from(organizations);
    expect(rows).toHaveLength(0);
  });

  it("withOrgContext scopes reads to exactly one tenant", async () => {
    const seenA = await withOrgContext(probe.db, orgA, (tx) => tx.select().from(organizations));
    expect(seenA.map((r) => r.id)).toEqual([orgA]);
    const seenB = await withOrgContext(probe.db, orgB, (tx) => tx.select().from(organizations));
    expect(seenB.map((r) => r.id)).toEqual([orgB]);
  });

  it("child tables inherit tenancy through their parent row", async () => {
    const [acct] = await admin.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(sql`${accounts.orgId} = ${orgA}`)
      .limit(1);
    const [entry] = await admin.db
      .insert(journalEntries)
      .values({ orgId: orgA, memo: "rls probe", postedByActorType: "system" })
      .returning({ id: journalEntries.id });
    await admin.db.insert(journalLines).values({
      entryId: entry!.id,
      accountId: acct!.id,
      debitMinor: 1,
    });
    try {
      const seenFromB = await withOrgContext(probe.db, orgB, (tx) => tx.select().from(journalLines));
      expect(seenFromB).toHaveLength(0);
      const seenFromA = await withOrgContext(probe.db, orgA, (tx) => tx.select().from(journalLines));
      expect(seenFromA).toHaveLength(1);
    } finally {
      await admin.db.delete(journalEntries).where(sql`id = ${entry!.id}`);
    }
  });

  it("writes into another tenant violate the WITH CHECK clause", async () => {
    await expect(
      withOrgContext(probe.db, orgA, (tx) =>
        tx.insert(accounts).values({ orgId: orgB, code: "9999", name: "Smuggled", type: "asset" }),
      ),
    ).rejects.toThrow();
  });

  it("the setting cannot leak across transactions in a pooled connection", async () => {
    await withOrgContext(probe.db, orgA, async () => undefined);
    const rows = await probe.db.select().from(organizations);
    expect(rows).toHaveLength(0);
  });

  it("manufacturing tables (migration 0020) are tenant-isolated", async () => {
    // Seed org A's manufacturing data as the admin (RLS-exempt owner).
    const [itemA] = await admin.db
      .insert(items)
      .values({ orgId: orgA, sku: "WO-ITEM-A", name: "Probe assembly A" })
      .returning({ id: items.id });
    const [locA] = await admin.db
      .insert(stockLocations)
      .values({ orgId: orgA, code: "WH-A", name: "Warehouse A" })
      .returning({ id: stockLocations.id });
    await admin.db.insert(lots).values({ orgId: orgA, itemId: itemA!.id, lotCode: "LOT-A1" });
    await admin.db
      .insert(workOrders)
      .values({ orgId: orgA, number: 1, assemblyItemId: itemA!.id, plannedQtyThousandths: 1000 });
    await admin.db
      .insert(stockReservations)
      .values({ orgId: orgA, itemId: itemA!.id, quantityThousandths: 500, reason: "probe" });
    const [countA] = await admin.db
      .insert(cycleCounts)
      .values({ orgId: orgA, locationId: locA!.id })
      .returning({ id: cycleCounts.id });
    await admin.db.insert(cycleCountLines).values({
      orgId: orgA,
      countId: countA!.id,
      itemId: itemA!.id,
      expectedThousandths: 1000,
    });

    try {
      // Org B sees none of it.
      const seenLocations = await withOrgContext(probe.db, orgB, (tx) => tx.select().from(stockLocations));
      expect(seenLocations).toHaveLength(0);
      const seenLots = await withOrgContext(probe.db, orgB, (tx) => tx.select().from(lots));
      expect(seenLots).toHaveLength(0);
      const seenWorkOrders = await withOrgContext(probe.db, orgB, (tx) => tx.select().from(workOrders));
      expect(seenWorkOrders).toHaveLength(0);
      const seenReservations = await withOrgContext(probe.db, orgB, (tx) => tx.select().from(stockReservations));
      expect(seenReservations).toHaveLength(0);
      const seenCounts = await withOrgContext(probe.db, orgB, (tx) => tx.select().from(cycleCountLines));
      expect(seenCounts).toHaveLength(0);

      // Org A sees exactly its own rows.
      expect(await withOrgContext(probe.db, orgA, (tx) => tx.select().from(stockLocations))).toHaveLength(1);
      expect(await withOrgContext(probe.db, orgA, (tx) => tx.select().from(lots))).toHaveLength(1);
      expect(await withOrgContext(probe.db, orgA, (tx) => tx.select().from(workOrders))).toHaveLength(1);
      expect(await withOrgContext(probe.db, orgA, (tx) => tx.select().from(stockReservations))).toHaveLength(1);
      expect(await withOrgContext(probe.db, orgA, (tx) => tx.select().from(cycleCounts))).toHaveLength(1);
      expect(await withOrgContext(probe.db, orgA, (tx) => tx.select().from(cycleCountLines))).toHaveLength(1);

      // Cross-tenant writes are refused by the WITH CHECK clause.
      await expect(
        withOrgContext(probe.db, orgA, (tx) =>
          tx.insert(workOrders).values({
            orgId: orgB,
            number: 99,
            assemblyItemId: itemA!.id,
            plannedQtyThousandths: 1000,
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await admin.db.delete(cycleCounts).where(sql`org_id = ${orgA}`);
      await admin.db.delete(stockReservations).where(sql`org_id = ${orgA}`);
      await admin.db.delete(workOrders).where(sql`org_id = ${orgA}`);
      await admin.db.delete(lots).where(sql`org_id = ${orgA}`);
      await admin.db.delete(stockLocations).where(sql`org_id = ${orgA}`);
      await admin.db.delete(items).where(sql`org_id = ${orgA}`);
    }
  });
});
