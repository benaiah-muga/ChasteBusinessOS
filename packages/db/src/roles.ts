import postgres from "postgres";

/**
 * Least-privilege application runtime role (S01/ADR 0017): the app must not
 * connect as the migration owner. The owner (chaste) is a superuser, so RLS
 * is inert for it by Postgres design; `chaste_app` is NOBYPASSRLS, has DML
 * only, and receives grants on future tables through default privileges on
 * the migration owner.
 *
 * Provisioning is idempotent and safe to run from concurrent processes:
 * CREATE ROLE is serialized on a transaction-scoped advisory lock, because
 * concurrent CREATE ROLE against one cluster fails with "tuple concurrently
 * updated" rather than a duplicate-object error, so the duplicate-object
 * handler cannot absorb it. The role is cluster-level; grants and default
 * privileges are per-database, applied to the database of `databaseUrl`.
 */

export const APP_ROLE_NAME = "chaste_app";
export const APP_ROLE_PASSWORD_ENV = "CHASTE_APP_DB_PASSWORD";
/** Dev/CI fallback only; production supplies CHASTE_APP_DB_PASSWORD and its own provisioning. */
export const DEFAULT_APP_ROLE_PASSWORD = "chaste_app_dev_only";
export const DEFAULT_DATABASE_URL = "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

export interface EnsureAppRoleOptions {
  /** Database whose tables receive the grants (defaults DATABASE_URL / dev default). */
  databaseUrl?: string;
  /** Overrides CHASTE_APP_DB_PASSWORD and the dev default. */
  password?: string;
  /** Cluster admin connection for CREATE ROLE (defaults to the same server's maintenance DB). */
  adminUrl?: string;
}

export interface AppRoleResult {
  roleName: string;
  /** True when this call created the role; false when it already existed. */
  created: boolean;
  /** Connection URL for the runtime role. Contains the password — never log it. */
  runtimeUrl: string;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function isDuplicateObject(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: string }).code === "42P04") return true;
  return /already exists/i.test(err instanceof Error ? err.message : String(err));
}

export async function ensureAppRole(options: EnsureAppRoleOptions = {}): Promise<AppRoleResult> {
  const databaseUrl =
    options.databaseUrl ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const password = options.password ?? process.env[APP_ROLE_PASSWORD_ENV] ?? DEFAULT_APP_ROLE_PASSWORD;
  const parsed = new URL(databaseUrl);
  const owner = parsed.username || "postgres";
  // URL.origin is "null" for non-special schemes like postgresql:, so the
  // maintenance connection is assembled from parts.
  const adminUrl =
    options.adminUrl ?? `${parsed.protocol}//${parsed.username}:${encodeURIComponent(parsed.password)}@${parsed.host}/postgres`;

  const admin = postgres(adminUrl, { max: 1 });
  let created = false;
  try {
    await admin.begin(async (tx) => {
      // Hold the lock for the transaction: the check and the CREATE then
      // cannot interleave with another process doing the same.
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext('chaste_ensure_app_role'), hashtext('role'))`);
      const [existing] = await tx.unsafe<{ present: boolean }[]>(
        `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${sqlString(APP_ROLE_NAME)}) AS present`,
      );
      if (existing?.present) return;
      await tx.unsafe(
        `CREATE ROLE ${APP_ROLE_NAME} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${sqlString(password)}`,
      );
      created = true;
    });
  } catch (err) {
    if (!isDuplicateObject(err)) throw err;
  } finally {
    await admin.end();
  }

  const db = postgres(databaseUrl, { max: 1 });
  try {
    await db.begin(async (tx) => {
      // Grants and default privileges update the same catalog rows, so
      // concurrent provisioning against one database fails with "tuple
      // concurrently updated". Keyed on the database: suites that share a
      // fixture database serialize, unrelated databases still run parallel.
      await tx.unsafe(
        `SELECT pg_advisory_xact_lock(hashtext('chaste_ensure_app_role'), hashtext(current_database()))`,
      );
      await tx.unsafe(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE_NAME}`);
      await tx.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE_NAME}`);
      await tx.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE_NAME}`);
      await tx.unsafe(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${sqlIdent(owner)} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE_NAME}`,
      );
      await tx.unsafe(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${sqlIdent(owner)} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE_NAME}`,
      );
    });
  } finally {
    await db.end();
  }

  const runtime = new URL(databaseUrl);
  runtime.username = APP_ROLE_NAME;
  runtime.password = password;
  return { roleName: APP_ROLE_NAME, created, runtimeUrl: runtime.toString() };
}
