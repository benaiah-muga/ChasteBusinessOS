import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, withOrgContext, type Database } from "./client";
import { dropFixtureDatabase, provisionFixtureDatabase } from "./test-fixture";

/**
 * S01 floor, swept mechanically over every org-scoped table of a fresh
 * fixture database migrated from this branch: RLS enabled, a tenant
 * isolation policy present, DML granted to the least-privilege runtime role,
 * and that role provably fail-closed — no rows visible without tenant
 * context, and no cross-tenant rows even when filtering by the other org's
 * id. Any new tenant table that skips its RLS policy fails this suite.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
const APP_ROLE = "chaste_app";

let admin: Database;
let app: Database;
let fixture: { url: string; database: string };
const orgA = crypto.randomUUID();
const orgB = crypto.randomUUID();

beforeAll(async () => {
  fixture = await provisionFixtureDatabase({ database: `chaste_test_rls_sweep_${crypto.randomUUID().slice(0, 8)}` });
  admin = createDb(url);
  await admin.db.execute(`INSERT INTO organizations (id, name, slug) VALUES ('${orgA}', 'Sweep A', 'sweep-a'), ('${orgB}', 'Sweep B', 'sweep-b')`);
  const u = new URL(fixture.url);
  u.username = APP_ROLE;
  u.password = "chaste_app_dev_only";
  app = createDb(u.toString());
});

afterAll(async () => {
  await app.client.end();
  await admin.client.end();
  await dropFixtureDatabase({ database: fixture.database });
});

type TableRow = { table_name: string; rls_enabled: boolean; policy: string | null };

describe("RLS conformance sweep (S01 floor)", () => {
  let tables: TableRow[];

  beforeAll(async () => {
    const res = await admin.db.execute<TableRow>(`
      SELECT c.relname AS table_name,
             c.relrowsecurity AS rls_enabled,
             (SELECT policyname FROM pg_policies p
               WHERE p.schemaname = 'public' AND p.tablename = c.relname
                 AND p.policyname = 'tenant_isolation' LIMIT 1) AS policy
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND EXISTS (SELECT 1 FROM information_schema.columns col
                     WHERE col.table_schema = 'public' AND col.table_name = c.relname
                       AND col.column_name = 'org_id')
      ORDER BY c.relname
    `);
    tables = res as unknown as TableRow[];
    expect(tables.length).toBeGreaterThan(30);
  });

  it("every org-scoped table has RLS enabled and a tenant_isolation policy", () => {
    const violations = tables.filter((t) => !t.rls_enabled || !t.policy).map((t) => t.table_name);
    expect(violations).toEqual([]);
  });

  it("the runtime role holds DML on every org-scoped table", async () => {
    const missing: string[] = [];
    for (const t of tables) {
      const res = await admin.db.execute<{ sel: boolean; ins: boolean; upd: boolean; del: boolean }>(
        `SELECT has_table_privilege('${APP_ROLE}', 'public."${t.table_name}"', 'SELECT') AS sel,
                has_table_privilege('${APP_ROLE}', 'public."${t.table_name}"', 'INSERT') AS ins,
                has_table_privilege('${APP_ROLE}', 'public."${t.table_name}"', 'UPDATE') AS upd,
                has_table_privilege('${APP_ROLE}', 'public."${t.table_name}"', 'DELETE') AS del`,
      );
      const row = res[0] as unknown as { sel: boolean; ins: boolean; upd: boolean; del: boolean };
      if (!row?.sel || !row?.ins || !row?.upd || !row?.del) missing.push(t.table_name);
    }
    expect(missing).toEqual([]);
  });

  it("the runtime role sees nothing without tenant context (fail closed)", async () => {
    for (const t of tables) {
      const res = await app.db.execute<{ n: number }>(`SELECT count(*)::int AS n FROM public."${t.table_name}"`);
      const n = Number((res[0] as unknown as { n: number })?.n ?? -1);
      expect(n, `${t.table_name} leaked rows to the runtime role without tenant context`).toBe(0);
    }
  });

  it("the runtime role cannot read another org's rows even under its own org context", async () => {
    for (const t of tables) {
      await withOrgContext(app.db, orgA, async (tx) => {
        const res = await tx.execute<{ n: number }>(
          `SELECT count(*)::int AS n FROM public."${t.table_name}" WHERE org_id = '${orgB}'`,
        );
        const n = Number((res[0] as unknown as { n: number })?.n ?? -1);
        expect(n, `${t.table_name} leaked org B rows to the runtime role under org A context`).toBe(0);
      });
    }
  });
});
