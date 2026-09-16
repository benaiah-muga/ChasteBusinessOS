import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, withOrgContext, type Database } from "./client";
import { APPEND_ONLY_TABLES, ensureAppRole } from "./roles";

/**
 * S01 floor, swept mechanically over every org-scoped table of a fresh
 * fixture database migrated from this branch: RLS enabled, a tenant
 * isolation policy present, DML granted to the least-privilege runtime role,
 * and that role provably fail-closed — no rows visible without tenant
 * context, and no cross-tenant rows even when filtering by the other org's
 * id. Any new tenant table that skips its RLS policy fails this suite.
 *
 * N09: the append-only financial tables (journal, event ledger) are swept
 * for reads/inserts like every other table but must LACK mutation rights —
 * the runtime role appends to history, it never rewrites it.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
const APP_ROLE = "chaste_app";

let admin: Database;
let app: Database;
const orgA = crypto.randomUUID();
const orgB = crypto.randomUUID();

/**
 * Both handles address the same database: the one globalSetup provisioned
 * and migrated for this run. Seeding the orgs into one database while the
 * runtime role read another made every leak assertion below pass on empty
 * tables, so the sweep could not have caught a missing RLS policy.
 */
beforeAll(async () => {
  admin = createDb(url);
  await admin.db.execute(`INSERT INTO organizations (id, name, slug) VALUES ('${orgA}', 'Sweep A', 'sweep-a'), ('${orgB}', 'Sweep B', 'sweep-b')`);
  // Idempotent, and yields the runtime URL for the very database just seeded.
  const { runtimeUrl } = await ensureAppRole({ databaseUrl: url });
  app = createDb(runtimeUrl);
});

afterAll(async () => {
  await app?.client.end();
  await admin?.client.end();
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

  // Positive control: the orgs must exist in the database the runtime role
  // reads. Without this, a wiring mistake that points the two handles at
  // different databases makes every "no rows leaked" assertion below pass on
  // empty tables and the sweep stops being able to fail.
  it("the runtime role reads the same database the sweep seeds (positive control)", async () => {
    const seedRes = await admin.db.execute<{ n: number }>(
      `SELECT count(*)::int AS n FROM organizations WHERE id IN ('${orgA}', '${orgB}')`,
    );
    const seeded = Number((seedRes[0] as unknown as { n: number })?.n ?? 0);
    expect(seeded, "the sweep must seed its orgs before testing for leaks").toBe(2);

    // The invariant whose violation made this suite unable to fail: two
    // handles on two different databases mean every leak check below counts
    // rows in a database that was never seeded.
    const adminDb = await admin.db.execute<{ name: string }>(`SELECT current_database() AS name`);
    const appDb = await app.db.execute<{ name: string }>(`SELECT current_database() AS name`);
    expect((appDb[0] as unknown as { name: string })?.name).toBe(
      (adminDb[0] as unknown as { name: string })?.name,
    );
  });

  it("every org-scoped table has RLS enabled and a tenant_isolation policy", () => {
    const violations = tables.filter((t) => !t.rls_enabled || !t.policy).map((t) => t.table_name);
    expect(violations).toEqual([]);
  });

  it("the runtime role holds DML on every org-scoped table (append-only tables: reads and inserts)", async () => {
    const missing: string[] = [];
    for (const t of tables) {
      const res = await admin.db.execute<{ sel: boolean; ins: boolean; upd: boolean; del: boolean }>(
        `SELECT has_table_privilege('${APP_ROLE}', 'public."${t.table_name}"', 'SELECT') AS sel,
                has_table_privilege('${APP_ROLE}', 'public."${t.table_name}"', 'INSERT') AS ins,
                has_table_privilege('${APP_ROLE}', 'public."${t.table_name}"', 'UPDATE') AS upd,
                has_table_privilege('${APP_ROLE}', 'public."${t.table_name}"', 'DELETE') AS del`,
      );
      const row = res[0] as unknown as { sel: boolean; ins: boolean; upd: boolean; del: boolean };
      const appendOnly = (APPEND_ONLY_TABLES as readonly string[]).includes(t.table_name);
      if (!row?.sel || !row?.ins) missing.push(t.table_name);
      if (!appendOnly && (!row?.upd || !row?.del)) missing.push(t.table_name);
    }
    expect(missing).toEqual([]);
  });

  it("the runtime role cannot mutate the append-only financial tables (N09)", async () => {
    const mutating: string[] = [];
    for (const t of APPEND_ONLY_TABLES) {
      const res = await admin.db.execute<{ upd: boolean; del: boolean; trunc: boolean }>(
        `SELECT has_table_privilege('${APP_ROLE}', '${t}', 'UPDATE') AS upd,
                has_table_privilege('${APP_ROLE}', '${t}', 'DELETE') AS del,
                has_table_privilege('${APP_ROLE}', '${t}', 'TRUNCATE') AS trunc`,
      );
      const row = res[0] as unknown as { upd: boolean; del: boolean; trunc: boolean };
      if (row?.upd || row?.del || row?.trunc) mutating.push(t);
    }
    expect(mutating).toEqual([]);
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
