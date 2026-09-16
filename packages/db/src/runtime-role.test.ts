import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, withOrgContext, type Database } from "./client";
import { customers, organizations } from "./schema/index";
import { APPEND_ONLY_TABLES, ensureAppRole } from "./roles";

/**
 * Executable S01 baseline: the least-privilege runtime role (chaste_app,
 * NOBYPASSRLS, DML-only) sees tenant rows only through app.org_id, cannot
 * escalate to DDL, and fails closed when the tenant context is absent.
 * This is the role the application must eventually run under; the test
 * pins its contract so the S01 role matrix has a floor to build on.
 *
 * Uses the run's fixture database provisioned by globalSetup (DATABASE_URL).
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let admin: Database;
let app: Database;
const orgA = crypto.randomUUID();
const orgB = crypto.randomUUID();

beforeAll(async () => {
  admin = createDb(url);
  await admin.db.insert(organizations).values([
    { id: orgA, name: "Role Probe A", slug: `role-probe-a-${orgA.slice(0, 8)}` },
    { id: orgB, name: "Role Probe B", slug: `role-probe-b-${orgB.slice(0, 8)}` },
  ]);
  await admin.db.insert(customers).values([
    { orgId: orgA, name: "Customer of A" },
    { orgId: orgB, name: "Customer of B" },
  ]);
  const { runtimeUrl } = await ensureAppRole({ databaseUrl: url });
  app = createDb(runtimeUrl);
});

afterAll(async () => {
  await app?.client.end();
  await admin.db.delete(customers).where(eq(customers.orgId, orgA));
  await admin.db.delete(customers).where(eq(customers.orgId, orgB));
  await admin.client.end();
});

describe("least-privilege runtime role", () => {
  it("sees only the tenant named by app.org_id", async () => {
    const seenA = await withOrgContext(app.db, orgA, (tx) =>
      tx.select({ name: customers.name }).from(customers).where(eq(customers.orgId, orgA)),
    );
    expect(seenA.map((r) => r.name)).toEqual(["Customer of A"]);

    const seenB = await withOrgContext(app.db, orgB, (tx) =>
      tx.select({ name: customers.name }).from(customers).where(eq(customers.orgId, orgB)),
    );
    expect(seenB.map((r) => r.name)).toEqual(["Customer of B"]);
  });

  it("cannot read another tenant's rows even when filtering by their org id", async () => {
    const crossTenant = await withOrgContext(app.db, orgA, (tx) =>
      tx.select().from(customers).where(eq(customers.orgId, orgB)),
    );
    expect(crossTenant).toEqual([]);
  });

  it("fails closed with no tenant context: policy hides every row", async () => {
    const rows = await app.db.select().from(customers).where(eq(customers.orgId, orgB));
    expect(rows).toEqual([]);
  });

  it("can write within its tenant context and not outside it", async () => {
    await withOrgContext(app.db, orgB, (tx) =>
      tx.insert(customers).values({ orgId: orgB, name: "Added by app role" }),
    );
    const outside = withOrgContext(app.db, orgA, (tx) =>
      tx.insert(customers).values({ orgId: orgB, name: "smuggled into B" }),
    );
    await expect(outside).rejects.toThrow();
  });

  it("has no DDL rights", async () => {
    await expect(app.db.execute("CREATE TABLE role_escalation_probe (id int)")).rejects.toThrow();
  });

  it("cannot mutate the append-only financial tables (N09)", async () => {
    for (const table of APPEND_ONLY_TABLES) {
      await expect(app.db.execute(`DELETE FROM ${table}`), `${table} DELETE`).rejects.toThrow();
      await expect(app.db.execute(`TRUNCATE ${table}`), `${table} TRUNCATE`).rejects.toThrow();
    }
    await expect(app.db.execute(`UPDATE journal_entries SET memo = 'x'`)).rejects.toThrow();
    await expect(app.db.execute(`UPDATE ledger_events SET kind = 'x'`)).rejects.toThrow();
  });

  it("keeps insert and read rights on the append-only tables", async () => {
    for (const table of APPEND_ONLY_TABLES) {
      const res = await admin.db.execute<{ sel: boolean; ins: boolean }>(
        `SELECT has_table_privilege('chaste_app', '${table}', 'SELECT') AS sel,
                has_table_privilege('chaste_app', '${table}', 'INSERT') AS ins`,
      );
      const row = res[0] as unknown as { sel: boolean; ins: boolean };
      expect(row.sel, `${table} SELECT`).toBe(true);
      expect(row.ins, `${table} INSERT`).toBe(true);
    }
  });

  it("the append-only revocation survives an ensureAppRole re-grant (N09)", async () => {
    await ensureAppRole({ databaseUrl: url });
    for (const table of APPEND_ONLY_TABLES) {
      const res = await admin.db.execute<{ upd: boolean; del: boolean; trunc: boolean }>(
        `SELECT has_table_privilege('chaste_app', '${table}', 'UPDATE') AS upd,
                has_table_privilege('chaste_app', '${table}', 'DELETE') AS del,
                has_table_privilege('chaste_app', '${table}', 'TRUNCATE') AS trunc`,
      );
      const row = res[0] as unknown as { upd: boolean; del: boolean; trunc: boolean };
      expect(row.upd, `${table} UPDATE revoked`).toBe(false);
      expect(row.del, `${table} DELETE revoked`).toBe(false);
      expect(row.trunc, `${table} TRUNCATE revoked`).toBe(false);
    }
  });
});
