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
export const OUTBOX_WORKER_ROLE_NAME = "chaste_outbox_worker";
export const OUTBOX_CLAIM_OWNER_ROLE_NAME = "chaste_outbox_claim_owner";
export const OUTBOX_WORKER_PASSWORD_ENV = "CHASTE_OUTBOX_WORKER_DB_PASSWORD";
/** Dev/CI fallback only; production must supply a distinct worker credential. */
export const DEFAULT_OUTBOX_WORKER_PASSWORD = "chaste_outbox_worker_dev_only";
export const JOBS_WORKER_ROLE_NAME = "chaste_jobs_worker";
export const JOBS_CLAIM_OWNER_ROLE_NAME = "chaste_jobs_claim_owner";
export const JOBS_WORKER_PASSWORD_ENV = "CHASTE_JOBS_WORKER_DB_PASSWORD";
/** Dev/CI fallback only; production must supply a distinct worker credential. */
export const DEFAULT_JOBS_WORKER_PASSWORD = "chaste_jobs_worker_dev_only";
export const DEFAULT_DATABASE_URL =
  "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

const OUTBOX_COLUMNS = [
  "id",
  "org_id",
  "kind",
  "dedupe_key",
  "provider_operation_id",
  "payload",
  "status",
  "attempts",
  "max_attempts",
  "available_at",
  "lease_owner",
  "lease_expires_at",
  "fencing_token",
  "provider_receipt",
  "last_error",
  "created_at",
  "updated_at",
  "completed_at",
] as const;

const CLAIM_SELECT_COLUMNS = [
  "id",
  "org_id",
  "kind",
  "provider_operation_id",
  "status",
  "attempts",
  "max_attempts",
  "available_at",
  "lease_owner",
  "created_at",
  "lease_expires_at",
  "fencing_token",
] as const;

const CLAIM_UPDATE_COLUMNS = [
  "status",
  "attempts",
  "lease_owner",
  "lease_expires_at",
  "fencing_token",
  "last_error",
  "updated_at",
  "completed_at",
] as const;

const WORKER_SELECT_COLUMNS = [
  "id",
  "org_id",
  "kind",
  "provider_operation_id",
  "payload",
  "status",
  "attempts",
  "max_attempts",
  "available_at",
  "lease_owner",
  "lease_expires_at",
  "fencing_token",
] as const;

const WORKER_UPDATE_COLUMNS = [
  "status",
  "available_at",
  "lease_owner",
  "lease_expires_at",
  "fencing_token",
  "provider_receipt",
  "last_error",
  "updated_at",
  "completed_at",
] as const;

const JOBS_CLAIM_SELECT_COLUMNS = [
  "id",
  "org_id",
  "type",
  "status",
  "attempts",
  "max_attempts",
  "available_at",
  "lease_owner",
  "created_at",
  "lease_expires_at",
  "fencing_token",
  "run_id",
  "run_step_index",
  "approved_approval_id",
] as const;

const JOBS_CLAIM_UPDATE_COLUMNS = [
  "status",
  "attempts",
  "lease_owner",
  "lease_expires_at",
  "fencing_token",
  "last_error",
  "updated_at",
] as const;

const JOBS_WORKER_SELECT_COLUMNS = [
  "id",
  "org_id",
  "type",
  "payload",
  "status",
  "attempts",
  "max_attempts",
  "available_at",
  "lease_owner",
  "lease_expires_at",
  "fencing_token",
  "run_id",
  "run_step_index",
  "approved_approval_id",
] as const;

const JOBS_WORKER_UPDATE_COLUMNS = [
  "status",
  "available_at",
  "lease_owner",
  "lease_expires_at",
  "last_error",
  "updated_at",
] as const;

/**
 * Append-only financial records (N09): the runtime role inserts and reads
 * these but never mutates them. Revoked here after the broad grant because
 * `GRANT ... ON ALL TABLES` would otherwise re-confer mutation rights on
 * every provisioning run; migration 0046 enforces the same boundary with
 * triggers for roles that hold the privilege.
 */
export const APPEND_ONLY_TABLES = [
  "journal_entries",
  "journal_lines",
  "ledger_events",
  "stock_movements",
] as const;

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
  /** Connection URL for the runtime role. Contains the password - never log it. */
  runtimeUrl: string;
}

export interface OutboxWorkerRoleOptions {
  databaseUrl?: string;
  password?: string;
  adminUrl?: string;
}

export interface OutboxWorkerRoleResult {
  roleName: string;
  functionOwnerRoleName: string;
  created: boolean;
  /** Connection URL contains the worker password and must never be logged. */
  workerUrl: string;
}

export interface JobsWorkerRoleOptions {
  databaseUrl?: string;
  password?: string;
  adminUrl?: string;
}

export interface JobsWorkerRoleResult {
  roleName: string;
  functionOwnerRoleName: string;
  created: boolean;
  /** Connection URL contains the worker password and must never be logged. */
  workerUrl: string;
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
  return /already exists/i.test(
    err instanceof Error ? err.message : String(err),
  );
}

export async function ensureAppRole(
  options: EnsureAppRoleOptions = {},
): Promise<AppRoleResult> {
  const databaseUrl =
    options.databaseUrl ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const configuredPassword =
    options.password ?? process.env[APP_ROLE_PASSWORD_ENV];
  if (!configuredPassword && process.env.NODE_ENV === "production") {
    throw new Error(
      `${APP_ROLE_PASSWORD_ENV} is required to provision the production runtime role`,
    );
  }
  const password = configuredPassword ?? DEFAULT_APP_ROLE_PASSWORD;
  const parsed = new URL(databaseUrl);
  const owner = parsed.username || "postgres";
  const adminDatabase = new URL(databaseUrl);
  adminDatabase.pathname = "/postgres";
  const adminUrl = options.adminUrl ?? adminDatabase.toString();

  const admin = postgres(adminUrl, { max: 1 });
  let created = false;
  try {
    await admin.begin(async (tx) => {
      // Hold the lock for the transaction: the check and the CREATE then
      // cannot interleave with another process doing the same.
      await tx.unsafe(
        `SELECT pg_advisory_xact_lock(hashtext('chaste_ensure_app_role'), hashtext('role'))`,
      );
      const [existing] = await tx.unsafe<{ present: boolean }[]>(
        `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${sqlString(APP_ROLE_NAME)}) AS present`,
      );
      if (!existing?.present) {
        await tx.unsafe(
          `CREATE ROLE ${APP_ROLE_NAME} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${sqlString(password)}`,
        );
        created = true;
      }
      await tx.unsafe(
        `ALTER ROLE ${APP_ROLE_NAME} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${sqlString(password)}`,
      );
      const memberships = await tx.unsafe<{ role_name: string }[]>(
        `SELECT granted.rolname AS role_name
         FROM pg_auth_members membership
         JOIN pg_roles granted ON granted.oid = membership.roleid
         JOIN pg_roles member ON member.oid = membership.member
         WHERE member.rolname = ${sqlString(APP_ROLE_NAME)}`,
      );
      for (const membership of memberships) {
        await tx.unsafe(
          `REVOKE ${sqlIdent(membership.role_name)} FROM ${APP_ROLE_NAME}`,
        );
      }
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
      await tx.unsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE_NAME}`,
      );
      await tx.unsafe(
        `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE_NAME}`,
      );
      for (const table of APPEND_ONLY_TABLES) {
        await tx.unsafe(
          `REVOKE UPDATE, DELETE, TRUNCATE ON ${table} FROM ${APP_ROLE_NAME}`,
        );
      }
      await tx.unsafe(
        `DO $$ BEGIN
           IF to_regprocedure('public.chaste_ledger_chain_head()') IS NOT NULL THEN
             GRANT EXECUTE ON FUNCTION public.chaste_ledger_chain_head() TO ${APP_ROLE_NAME};
           END IF;
         END $$`,
      );
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

/**
 * Provision the webhook worker login and its non-login claim-function owner.
 * The worker can access webhook outbox columns only, under the existing org
 * RLS context. The function owner can see claim metadata globally but cannot
 * read payloads or access other tables.
 */
export async function ensureOutboxWorkerRole(
  options: OutboxWorkerRoleOptions = {},
): Promise<OutboxWorkerRoleResult> {
  const databaseUrl =
    options.databaseUrl ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const configuredPassword =
    options.password ?? process.env[OUTBOX_WORKER_PASSWORD_ENV];
  if (!configuredPassword && process.env.NODE_ENV === "production") {
    throw new Error(
      `${OUTBOX_WORKER_PASSWORD_ENV} is required to provision the webhook worker role`,
    );
  }
  const password = configuredPassword ?? DEFAULT_OUTBOX_WORKER_PASSWORD;
  const adminDatabase = new URL(databaseUrl);
  adminDatabase.pathname = "/postgres";
  const adminUrl = options.adminUrl ?? adminDatabase.toString();

  const admin = postgres(adminUrl, { max: 1 });
  let created = false;
  try {
    await admin.begin(async (tx) => {
      await tx.unsafe(
        `SELECT pg_advisory_xact_lock(hashtext('chaste_ensure_app_role'), hashtext('role'))`,
      );
      const [existing] = await tx.unsafe<{ present: boolean }[]>(
        `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${sqlString(OUTBOX_WORKER_ROLE_NAME)}) AS present`,
      );
      if (!existing?.present) {
        await tx.unsafe(
          `CREATE ROLE ${OUTBOX_WORKER_ROLE_NAME} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8 PASSWORD ${sqlString(password)}`,
        );
        created = true;
      }
      await tx.unsafe(
        `ALTER ROLE ${OUTBOX_WORKER_ROLE_NAME} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8 PASSWORD ${sqlString(password)}`,
      );

      const [ownerExists] = await tx.unsafe<{ present: boolean }[]>(
        `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${sqlString(OUTBOX_CLAIM_OWNER_ROLE_NAME)}) AS present`,
      );
      if (!ownerExists?.present) {
        await tx.unsafe(
          `CREATE ROLE ${OUTBOX_CLAIM_OWNER_ROLE_NAME} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
        );
      }
      await tx.unsafe(
        `ALTER ROLE ${OUTBOX_CLAIM_OWNER_ROLE_NAME} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD NULL`,
      );

      for (const roleName of [
        OUTBOX_WORKER_ROLE_NAME,
        OUTBOX_CLAIM_OWNER_ROLE_NAME,
      ]) {
        const memberships = await tx.unsafe<{ granted_role: string }[]>(
          `SELECT granted.rolname AS granted_role
           FROM pg_auth_members membership
           JOIN pg_roles granted ON granted.oid = membership.roleid
           JOIN pg_roles member ON member.oid = membership.member
           WHERE member.rolname = ${sqlString(roleName)}`,
        );
        for (const membership of memberships) {
          await tx.unsafe(
            `REVOKE ${sqlIdent(membership.granted_role)} FROM ${sqlIdent(roleName)}`,
          );
        }
        const dependents = await tx.unsafe<{ member_role: string }[]>(
          `SELECT member.rolname AS member_role
           FROM pg_auth_members membership
           JOIN pg_roles granted ON granted.oid = membership.roleid
           JOIN pg_roles member ON member.oid = membership.member
           WHERE granted.rolname = ${sqlString(roleName)}`,
        );
        for (const dependent of dependents) {
          await tx.unsafe(
            `REVOKE ${sqlIdent(roleName)} FROM ${sqlIdent(dependent.member_role)}`,
          );
        }
      }
    });
  } catch (err) {
    if (!isDuplicateObject(err)) throw err;
  } finally {
    await admin.end();
  }

  const db = postgres(databaseUrl, { max: 1 });
  try {
    await db.begin(async (tx) => {
      await tx.unsafe(
        `SELECT pg_advisory_xact_lock(hashtext('chaste_ensure_app_role'), hashtext(current_database()))`,
      );
      await tx.unsafe(
        `GRANT USAGE ON SCHEMA public TO ${OUTBOX_WORKER_ROLE_NAME}`,
      );
      await tx.unsafe(
        `GRANT USAGE ON SCHEMA public TO ${OUTBOX_CLAIM_OWNER_ROLE_NAME}`,
      );
      await tx.unsafe(
        `GRANT USAGE, CREATE ON SCHEMA outbox_worker TO ${OUTBOX_CLAIM_OWNER_ROLE_NAME}`,
      );

      for (const roleName of [
        OUTBOX_WORKER_ROLE_NAME,
        OUTBOX_CLAIM_OWNER_ROLE_NAME,
      ]) {
        await tx.unsafe(
          `REVOKE ALL PRIVILEGES ON TABLE public.outbox_messages FROM ${roleName}`,
        );
        for (const column of OUTBOX_COLUMNS) {
          const ident = sqlIdent(column);
          await tx.unsafe(
            `REVOKE SELECT (${ident}), INSERT (${ident}), UPDATE (${ident}), REFERENCES (${ident}) ON TABLE public.outbox_messages FROM ${roleName}`,
          );
        }
      }

      const grantColumns = async (
        roleName: string,
        selectColumns: readonly string[],
        updateColumns: readonly string[],
      ) => {
        await tx.unsafe(
          `GRANT SELECT (${selectColumns.map(sqlIdent).join(", ")}) ON TABLE public.outbox_messages TO ${roleName}`,
        );
        await tx.unsafe(
          `GRANT UPDATE (${updateColumns.map(sqlIdent).join(", ")}) ON TABLE public.outbox_messages TO ${roleName}`,
        );
      };
      await grantColumns(
        OUTBOX_CLAIM_OWNER_ROLE_NAME,
        CLAIM_SELECT_COLUMNS,
        CLAIM_UPDATE_COLUMNS,
      );
      await grantColumns(
        OUTBOX_WORKER_ROLE_NAME,
        WORKER_SELECT_COLUMNS,
        WORKER_UPDATE_COLUMNS,
      );

      await tx.unsafe(
        `ALTER FUNCTION outbox_worker.claim_webhook(text, integer) OWNER TO ${OUTBOX_CLAIM_OWNER_ROLE_NAME}`,
      );
      await tx.unsafe(
        `REVOKE ALL ON FUNCTION outbox_worker.claim_webhook(text, integer) FROM PUBLIC`,
      );
      await tx.unsafe(
        `REVOKE ALL ON FUNCTION outbox_worker.claim_webhook(text, integer) FROM ${APP_ROLE_NAME}`,
      );
      await tx.unsafe(
        `GRANT USAGE ON SCHEMA outbox_worker TO ${OUTBOX_WORKER_ROLE_NAME}`,
      );
      await tx.unsafe(
        `REVOKE CREATE ON SCHEMA outbox_worker FROM ${OUTBOX_CLAIM_OWNER_ROLE_NAME}`,
      );
      await tx.unsafe(
        `GRANT EXECUTE ON FUNCTION outbox_worker.claim_webhook(text, integer) TO ${OUTBOX_WORKER_ROLE_NAME}`,
      );
    });
  } finally {
    await db.end();
  }

  const runtimeUrl = new URL(databaseUrl);
  runtimeUrl.username = OUTBOX_WORKER_ROLE_NAME;
  runtimeUrl.password = password;
  return {
    roleName: OUTBOX_WORKER_ROLE_NAME,
    functionOwnerRoleName: OUTBOX_CLAIM_OWNER_ROLE_NAME,
    created,
    workerUrl: runtimeUrl.toString(),
  };
}

/**
 * Provision the capability jobs worker login and its non-login claim-function
 * owner. Global claims expose only queue metadata; payload and effect access
 * remains behind tenant RLS and the application runtime role.
 */
export async function ensureJobsWorkerRole(
  options: JobsWorkerRoleOptions = {},
): Promise<JobsWorkerRoleResult> {
  const databaseUrl =
    options.databaseUrl ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const configuredPassword =
    options.password ?? process.env[JOBS_WORKER_PASSWORD_ENV];
  if (!configuredPassword && process.env.NODE_ENV === "production") {
    throw new Error(
      `${JOBS_WORKER_PASSWORD_ENV} is required to provision the production jobs worker role`,
    );
  }
  const password = configuredPassword ?? DEFAULT_JOBS_WORKER_PASSWORD;
  const adminDatabase = new URL(databaseUrl);
  adminDatabase.pathname = "/postgres";
  const adminUrl = options.adminUrl ?? adminDatabase.toString();

  const admin = postgres(adminUrl, { max: 1 });
  let created = false;
  try {
    await admin.begin(async (tx) => {
      await tx.unsafe(
        `SELECT pg_advisory_xact_lock(hashtext('chaste_ensure_app_role'), hashtext('role'))`,
      );
      const [existing] = await tx.unsafe<{ present: boolean }[]>(
        `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${sqlString(JOBS_WORKER_ROLE_NAME)}) AS present`,
      );
      if (!existing?.present) {
        await tx.unsafe(
          `CREATE ROLE ${JOBS_WORKER_ROLE_NAME} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8 PASSWORD ${sqlString(password)}`,
        );
        created = true;
      }
      await tx.unsafe(
        `ALTER ROLE ${JOBS_WORKER_ROLE_NAME} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8 PASSWORD ${sqlString(password)}`,
      );

      const [ownerExists] = await tx.unsafe<{ present: boolean }[]>(
        `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${sqlString(JOBS_CLAIM_OWNER_ROLE_NAME)}) AS present`,
      );
      if (!ownerExists?.present) {
        await tx.unsafe(
          `CREATE ROLE ${JOBS_CLAIM_OWNER_ROLE_NAME} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
        );
      }
      await tx.unsafe(
        `ALTER ROLE ${JOBS_CLAIM_OWNER_ROLE_NAME} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD NULL`,
      );

      for (const roleName of [
        JOBS_WORKER_ROLE_NAME,
        JOBS_CLAIM_OWNER_ROLE_NAME,
      ]) {
        const memberships = await tx.unsafe<{ granted_role: string }[]>(
          `SELECT granted.rolname AS granted_role
           FROM pg_auth_members membership
           JOIN pg_roles granted ON granted.oid = membership.roleid
           JOIN pg_roles member ON member.oid = membership.member
           WHERE member.rolname = ${sqlString(roleName)}`,
        );
        for (const membership of memberships) {
          await tx.unsafe(
            `REVOKE ${sqlIdent(membership.granted_role)} FROM ${sqlIdent(roleName)}`,
          );
        }
        const dependents = await tx.unsafe<{ member_role: string }[]>(
          `SELECT member.rolname AS member_role
           FROM pg_auth_members membership
           JOIN pg_roles granted ON granted.oid = membership.roleid
           JOIN pg_roles member ON member.oid = membership.member
           WHERE granted.rolname = ${sqlString(roleName)}`,
        );
        for (const dependent of dependents) {
          await tx.unsafe(
            `REVOKE ${sqlIdent(roleName)} FROM ${sqlIdent(dependent.member_role)}`,
          );
        }
      }
    });
  } catch (err) {
    if (!isDuplicateObject(err)) throw err;
  } finally {
    await admin.end();
  }

  const db = postgres(databaseUrl, { max: 1 });
  try {
    await db.begin(async (tx) => {
      await tx.unsafe(
        `SELECT pg_advisory_xact_lock(hashtext('chaste_ensure_app_role'), hashtext(current_database()))`,
      );
      await tx.unsafe(
        `GRANT USAGE ON SCHEMA public TO ${JOBS_WORKER_ROLE_NAME}`,
      );
      await tx.unsafe(
        `GRANT USAGE ON SCHEMA public TO ${JOBS_CLAIM_OWNER_ROLE_NAME}`,
      );
      await tx.unsafe(
        `REVOKE ALL PRIVILEGES ON TABLE public.organizations FROM ${JOBS_CLAIM_OWNER_ROLE_NAME}`,
      );
      await tx.unsafe(
        `REVOKE ALL PRIVILEGES ON TABLE public.routines FROM ${JOBS_CLAIM_OWNER_ROLE_NAME}`,
      );
      await tx.unsafe(
        `GRANT SELECT (id) ON TABLE public.organizations TO ${JOBS_CLAIM_OWNER_ROLE_NAME}`,
      );
      await tx.unsafe(
        `GRANT SELECT (id, org_id, enabled, trigger_type, next_run_at) ON TABLE public.routines TO ${JOBS_CLAIM_OWNER_ROLE_NAME}`,
      );
      await tx.unsafe(
        `GRANT USAGE, CREATE ON SCHEMA jobs_worker TO ${JOBS_CLAIM_OWNER_ROLE_NAME}`,
      );

      for (const roleName of [
        JOBS_WORKER_ROLE_NAME,
        JOBS_CLAIM_OWNER_ROLE_NAME,
      ]) {
        await tx.unsafe(
          `REVOKE ALL PRIVILEGES ON TABLE public.jobs FROM ${roleName}`,
        );
        for (const column of new Set([
          ...JOBS_CLAIM_SELECT_COLUMNS,
          ...JOBS_CLAIM_UPDATE_COLUMNS,
          ...JOBS_WORKER_SELECT_COLUMNS,
          ...JOBS_WORKER_UPDATE_COLUMNS,
        ])) {
          const ident = sqlIdent(column);
          await tx.unsafe(
            `REVOKE SELECT (${ident}), INSERT (${ident}), UPDATE (${ident}), REFERENCES (${ident}) ON TABLE public.jobs FROM ${roleName}`,
          );
        }
      }

      const grantColumns = async (
        roleName: string,
        selectColumns: readonly string[],
        updateColumns: readonly string[],
      ) => {
        await tx.unsafe(
          `GRANT SELECT (${selectColumns.map(sqlIdent).join(", ")}) ON TABLE public.jobs TO ${roleName}`,
        );
        await tx.unsafe(
          `GRANT UPDATE (${updateColumns.map(sqlIdent).join(", ")}) ON TABLE public.jobs TO ${roleName}`,
        );
      };
      await grantColumns(
        JOBS_CLAIM_OWNER_ROLE_NAME,
        JOBS_CLAIM_SELECT_COLUMNS,
        JOBS_CLAIM_UPDATE_COLUMNS,
      );
      await grantColumns(
        JOBS_WORKER_ROLE_NAME,
        JOBS_WORKER_SELECT_COLUMNS,
        JOBS_WORKER_UPDATE_COLUMNS,
      );

      await tx.unsafe(
        `ALTER FUNCTION jobs_worker.claim_capability_job(text, integer) OWNER TO ${JOBS_CLAIM_OWNER_ROLE_NAME}`,
      );
      await tx.unsafe(
        `ALTER FUNCTION jobs_worker.list_due_routine_candidates(integer) OWNER TO ${JOBS_CLAIM_OWNER_ROLE_NAME}`,
      );
      await tx.unsafe(
        `REVOKE ALL ON FUNCTION jobs_worker.claim_capability_job(text, integer) FROM PUBLIC`,
      );
      await tx.unsafe(
        `REVOKE ALL ON FUNCTION jobs_worker.claim_capability_job(text, integer) FROM ${APP_ROLE_NAME}`,
      );
      await tx.unsafe(
        `REVOKE ALL ON FUNCTION jobs_worker.list_due_routine_candidates(integer) FROM PUBLIC`,
      );
      await tx.unsafe(
        `REVOKE ALL ON FUNCTION jobs_worker.list_due_routine_candidates(integer) FROM ${APP_ROLE_NAME}`,
      );
      await tx.unsafe(
        `GRANT USAGE ON SCHEMA jobs_worker TO ${JOBS_WORKER_ROLE_NAME}`,
      );
      await tx.unsafe(
        `REVOKE CREATE ON SCHEMA jobs_worker FROM ${JOBS_CLAIM_OWNER_ROLE_NAME}`,
      );
      await tx.unsafe(
        `GRANT EXECUTE ON FUNCTION jobs_worker.claim_capability_job(text, integer) TO ${JOBS_WORKER_ROLE_NAME}`,
      );
      await tx.unsafe(
        `GRANT EXECUTE ON FUNCTION jobs_worker.list_due_routine_candidates(integer) TO ${JOBS_WORKER_ROLE_NAME}`,
      );
    });
  } finally {
    await db.end();
  }

  const runtimeUrl = new URL(databaseUrl);
  runtimeUrl.username = JOBS_WORKER_ROLE_NAME;
  runtimeUrl.password = password;
  return {
    roleName: JOBS_WORKER_ROLE_NAME,
    functionOwnerRoleName: JOBS_CLAIM_OWNER_ROLE_NAME,
    created,
    workerUrl: runtimeUrl.toString(),
  };
}
