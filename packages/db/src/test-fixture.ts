import { readdirSync } from "node:fs";
import postgres from "postgres";
import { migrationsFolder, runMigrations } from "./migrate";
import { ensureAppRole } from "./roles";

/**
 * Per-run test databases.
 *
 * Tests must never run against the shared long-lived development database:
 * any branch that runs `db:migrate` reshapes it, and code from another branch
 * then fails against a schema it has never seen (this exact drift once made
 * jobs.test.ts fail with a raw SQL error while the code was correct). The
 * default contract is therefore:
 *
 *  - default: provision a throwaway database on the same server as
 *    DATABASE_URL, migrate it with this branch's own migrations, point
 *    DATABASE_URL at it for the duration of the test run, drop it afterwards;
 *  - CHASTE_TEST_DB=1: use DATABASE_URL (or the default) as-is, but only
 *    after proving its applied migrations match this branch's migration files;
 *  - CHASTE_TEST_KEEP_DB=1: skip teardown drop for debugging.
 */

export const DEFAULT_DATABASE_URL = "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

export interface FixtureDatabase {
  url: string;
  database: string;
}

function adminUrlOf(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  parsed.pathname = "/postgres";
  return parsed.toString();
}

function fixtureUrlOf(baseUrl: string, database: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** Global advisory-lock key so concurrent suites provision one at a time. */
const PROVISION_LOCK_KEY = 727_273;

export async function provisionFixtureDatabase(
  options: { baseUrl?: string; database?: string; migrate?: boolean; prefix?: string } = {},
): Promise<FixtureDatabase> {
  const baseUrl = options.baseUrl ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const database =
    options.database ??
    `chaste_test_${options.prefix ?? "run"}_${process.pid.toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  const admin = postgres(adminUrlOf(baseUrl), { max: 1 });
  try {
    // When the whole monorepo tests in parallel, every suite wants CREATE
    // DATABASE + full migrations at once, and the shared server buckles
    // (connection exhaustion, lock timeouts). A session-scoped advisory
    // lock turns the stampede into an orderly queue: provisioning happens
    // one suite at a time, then tests run truly parallel on separate
    // databases.
    await admin.unsafe(`SELECT pg_advisory_lock(${PROVISION_LOCK_KEY})`);
    try {
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await admin.unsafe(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
      if (lastError) {
        throw new Error(`could not create fixture database "${database}": ${String(lastError)}`);
      }
      const url = fixtureUrlOf(baseUrl, database);
      if (options.migrate !== false) {
        await runMigrations({ url, backup: false });
      }
      // Every fixture carries the least-privilege runtime role (S01 floor) so
      // RLS conformance is testable in any suite that needs it.
      if (!process.env.CHASTE_TEST_NO_APP_ROLE) {
        await ensureAppRole({ databaseUrl: url });
      }
      return { url, database };
    } finally {
      await admin.unsafe(`SELECT pg_advisory_unlock(${PROVISION_LOCK_KEY})`).catch(() => undefined);
    }
  } finally {
    await admin.end();
  }
}

export async function dropFixtureDatabase(options: { baseUrl?: string; database: string }): Promise<void> {
  const baseUrl = options.baseUrl ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const admin = postgres(adminUrlOf(baseUrl), { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE "${options.database.replace(/"/g, '""')}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/**
 * Guard for the CHASTE_TEST_DB=1 path: refuses a database whose applied
 * migration count differs from this branch's migration files, which is the
 * signature of a database migrated by another branch.
 */
export async function assertMigrationsInSync(url: string): Promise<void> {
  const applied = await appliedMigrationCount(url);
  const defined = readdirSync(migrationsFolder()).filter((f) => f.endsWith(".sql")).length;
  if (applied !== defined) {
    throw new Error(
      `test database is out of sync with this branch: ${applied} migrations applied, ` +
        `${defined} migration files present - the database was migrated by a different branch. ` +
        `Migrate it with \`pnpm --filter @chaste/db db:migrate\`, or drop CHASTE_TEST_DB so tests ` +
        `provision their own fixture database.`,
    );
  }
}

export async function appliedMigrationCount(url: string): Promise<number> {
  const client = postgres(url, { max: 1 });
  try {
    const rows = await client.unsafe<{ count: string }[]>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations",
    );
    return Number(rows[0]?.count ?? 0);
  } finally {
    await client.end();
  }
}

export interface ChasteTestDbSetupOptions {
  /** Database-name prefix so leftover fixtures identify their owning suite. */
  prefix?: string;
}

/**
 * Vitest globalSetup contract: provisions one database per test run and
 * exports DATABASE_URL to the worker processes, which inherit the environment
 * when they spawn after globalSetup completes.
 */
export function chasteVitestDbSetup(options: ChasteTestDbSetupOptions = {}): {
  setup: () => Promise<void>;
  teardown: () => Promise<void>;
} {
  let baseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  let fixture: FixtureDatabase | null = null;

  return {
    async setup() {
      baseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
      if (process.env.CHASTE_TEST_DB === "1" || process.env.CHASTE_TEST_DB === "true") {
        await assertMigrationsInSync(baseUrl);
        process.env.DATABASE_URL = baseUrl;
        return;
      }
      fixture = await provisionFixtureDatabase({ baseUrl, prefix: options.prefix });
      if (process.env.CHASTE_TEST_VERBOSE === "1") {
        process.stdout.write(`[test-fixture] database ${fixture.database}\n`);
      }
      process.env.DATABASE_URL = fixture.url;
    },
    async teardown() {
      if (!fixture || process.env.CHASTE_TEST_KEEP_DB === "1") return;
      try {
        await dropFixtureDatabase({ baseUrl, database: fixture.database });
      } catch {
        // Teardown must never mask test results; leftover fixtures are
        // identifiable by their prefix and dropped manually if needed.
      }
    },
  };
}
