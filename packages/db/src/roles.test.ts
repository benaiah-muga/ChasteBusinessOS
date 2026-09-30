import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  ensureJobsWorkerRole,
  ensureOutboxWorkerRole,
  JOBS_CLAIM_OWNER_ROLE_NAME,
  JOBS_WORKER_ROLE_NAME,
  OUTBOX_CLAIM_OWNER_ROLE_NAME,
  OUTBOX_WORKER_ROLE_NAME,
} from "./roles";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
const workerPassword =
  process.env.CHASTE_OUTBOX_WORKER_DB_PASSWORD ??
  "chaste_outbox_worker_dev_only";
const jobsWorkerPassword =
  process.env.CHASTE_JOBS_WORKER_DB_PASSWORD ?? "chaste_jobs_worker_dev_only";

let admin: ReturnType<typeof postgres>;

beforeAll(async () => {
  admin = postgres(databaseUrl, { max: 1 });
  await ensureOutboxWorkerRole({ databaseUrl, password: workerPassword });
  await ensureJobsWorkerRole({ databaseUrl, password: jobsWorkerPassword });
});

afterAll(async () => {
  await admin?.end();
});

describe("webhook outbox worker role provisioning", () => {
  it("creates a non-escalating login and a non-login function owner with no memberships", async () => {
    const roles = await admin.unsafe<
      {
        role_name: string;
        can_login: boolean;
        superuser: boolean;
        create_db: boolean;
        create_role: boolean;
        replication: boolean;
        bypasses_rls: boolean;
        inherits: boolean;
        memberships: number;
      }[]
    >(
      `SELECT role.rolname AS role_name,
              role.rolcanlogin AS can_login,
              role.rolsuper AS superuser,
              role.rolcreatedb AS create_db,
              role.rolcreaterole AS create_role,
              role.rolreplication AS replication,
              role.rolbypassrls AS bypasses_rls,
              role.rolinherit AS inherits,
              (SELECT count(*)::int FROM pg_auth_members membership WHERE membership.member = role.oid) AS memberships
       FROM pg_roles role
       WHERE role.rolname IN ('${OUTBOX_WORKER_ROLE_NAME}', '${OUTBOX_CLAIM_OWNER_ROLE_NAME}')
       ORDER BY role.rolname`,
    );
    expect(roles).toHaveLength(2);
    const worker = roles.find(
      (role) => role.role_name === OUTBOX_WORKER_ROLE_NAME,
    );
    const owner = roles.find(
      (role) => role.role_name === OUTBOX_CLAIM_OWNER_ROLE_NAME,
    );
    expect(worker).toMatchObject({
      can_login: true,
      superuser: false,
      create_db: false,
      create_role: false,
      replication: false,
      bypasses_rls: false,
      inherits: false,
      memberships: 0,
    });
    expect(owner).toMatchObject({
      can_login: false,
      superuser: false,
      create_db: false,
      create_role: false,
      replication: false,
      bypasses_rls: false,
      inherits: false,
      memberships: 0,
    });
  });

  it("keeps the function owner and column grants narrow", async () => {
    const result = await admin.unsafe<
      {
        function_owner: string;
        security_definer: boolean;
        public_execute: boolean;
        worker_execute: boolean;
        app_execute: boolean;
        worker_table_select: boolean;
        worker_table_insert: boolean;
        worker_payload_select: boolean;
        worker_org_select: boolean;
        claim_payload_select: boolean;
        claim_status_update: boolean;
        claim_fence_update: boolean;
        claim_other_table_access: boolean;
      }[]
    >(
      `SELECT owner.rolname AS function_owner,
              procedure.prosecdef AS security_definer,
              EXISTS (
                SELECT 1 FROM aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) acl
                WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
              ) AS public_execute,
              has_function_privilege('${OUTBOX_WORKER_ROLE_NAME}', procedure.oid, 'EXECUTE') AS worker_execute,
              has_function_privilege('chaste_app', procedure.oid, 'EXECUTE') AS app_execute,
              has_table_privilege('${OUTBOX_WORKER_ROLE_NAME}', 'public.outbox_messages', 'SELECT') AS worker_table_select,
              has_table_privilege('${OUTBOX_WORKER_ROLE_NAME}', 'public.outbox_messages', 'INSERT') AS worker_table_insert,
              has_column_privilege('${OUTBOX_WORKER_ROLE_NAME}', 'public.outbox_messages', 'payload', 'SELECT') AS worker_payload_select,
              has_column_privilege('${OUTBOX_WORKER_ROLE_NAME}', 'public.outbox_messages', 'org_id', 'SELECT') AS worker_org_select,
              has_column_privilege('${OUTBOX_CLAIM_OWNER_ROLE_NAME}', 'public.outbox_messages', 'payload', 'SELECT') AS claim_payload_select,
              has_column_privilege('${OUTBOX_CLAIM_OWNER_ROLE_NAME}', 'public.outbox_messages', 'status', 'UPDATE') AS claim_status_update,
              has_column_privilege('${OUTBOX_CLAIM_OWNER_ROLE_NAME}', 'public.outbox_messages', 'fencing_token', 'UPDATE') AS claim_fence_update,
              EXISTS (
                SELECT 1 FROM pg_class relation
                JOIN pg_namespace rel_namespace ON rel_namespace.oid = relation.relnamespace
                WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'S')
                  AND rel_namespace.nspname = 'public'
                  AND has_any_column_privilege('${OUTBOX_CLAIM_OWNER_ROLE_NAME}', relation.oid, 'SELECT')
                  AND relation.oid <> 'public.outbox_messages'::regclass
              ) AS claim_other_table_access
       FROM pg_proc procedure
       JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
       JOIN pg_roles owner ON owner.oid = procedure.proowner
       WHERE namespace.nspname = 'outbox_worker' AND procedure.proname = 'claim_webhook'`,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      function_owner: OUTBOX_CLAIM_OWNER_ROLE_NAME,
      security_definer: true,
      public_execute: false,
      worker_execute: true,
      app_execute: false,
      worker_table_select: false,
      worker_table_insert: false,
      worker_payload_select: true,
      worker_org_select: true,
      claim_payload_select: false,
      claim_status_update: true,
      claim_fence_update: true,
      claim_other_table_access: false,
    });
  });

  it("makes repeat provisioning idempotent", async () => {
    const role = await ensureOutboxWorkerRole({
      databaseUrl,
      password: workerPassword,
    });
    expect(role.roleName).toBe(OUTBOX_WORKER_ROLE_NAME);
    expect(role.functionOwnerRoleName).toBe(OUTBOX_CLAIM_OWNER_ROLE_NAME);
    expect(new URL(role.workerUrl).username).toBe(OUTBOX_WORKER_ROLE_NAME);
  });
});

describe("capability jobs worker role provisioning", () => {
  it("creates a non-escalating login and a non-login function owner with no memberships", async () => {
    const roles = await admin.unsafe<
      {
        role_name: string;
        can_login: boolean;
        superuser: boolean;
        create_db: boolean;
        create_role: boolean;
        replication: boolean;
        bypasses_rls: boolean;
        inherits: boolean;
        memberships: number;
      }[]
    >(
      `SELECT role.rolname AS role_name,
              role.rolcanlogin AS can_login,
              role.rolsuper AS superuser,
              role.rolcreatedb AS create_db,
              role.rolcreaterole AS create_role,
              role.rolreplication AS replication,
              role.rolbypassrls AS bypasses_rls,
              role.rolinherit AS inherits,
              (SELECT count(*)::int FROM pg_auth_members membership WHERE membership.member = role.oid) AS memberships
       FROM pg_roles role
       WHERE role.rolname IN ('${JOBS_WORKER_ROLE_NAME}', '${JOBS_CLAIM_OWNER_ROLE_NAME}')
       ORDER BY role.rolname`,
    );
    expect(roles).toHaveLength(2);
    const worker = roles.find(
      (role) => role.role_name === JOBS_WORKER_ROLE_NAME,
    );
    const owner = roles.find(
      (role) => role.role_name === JOBS_CLAIM_OWNER_ROLE_NAME,
    );
    expect(worker).toMatchObject({
      can_login: true,
      superuser: false,
      create_db: false,
      create_role: false,
      replication: false,
      bypasses_rls: false,
      inherits: false,
      memberships: 0,
    });
    expect(owner).toMatchObject({
      can_login: false,
      superuser: false,
      create_db: false,
      create_role: false,
      replication: false,
      bypasses_rls: false,
      inherits: false,
      memberships: 0,
    });
  });

  it("keeps global claim access metadata-only and payload access tenant-scoped", async () => {
    const result = await admin.unsafe<
      {
        function_owner: string;
        security_definer: boolean;
        public_execute: boolean;
        worker_execute: boolean;
        app_execute: boolean;
        worker_table_select: boolean;
        worker_table_insert: boolean;
        worker_payload_select: boolean;
        worker_org_select: boolean;
        worker_actor_select: boolean;
        claim_payload_select: boolean;
        claim_status_update: boolean;
        claim_fence_update: boolean;
        claim_other_table_access: boolean;
        worker_schema_create: boolean;
      }[]
    >(
      `SELECT owner.rolname AS function_owner,
              procedure.prosecdef AS security_definer,
              EXISTS (
                SELECT 1 FROM aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) acl
                WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
              ) AS public_execute,
              has_function_privilege('${JOBS_WORKER_ROLE_NAME}', procedure.oid, 'EXECUTE') AS worker_execute,
              has_function_privilege('chaste_app', procedure.oid, 'EXECUTE') AS app_execute,
              has_table_privilege('${JOBS_WORKER_ROLE_NAME}', 'public.jobs', 'SELECT') AS worker_table_select,
              has_table_privilege('${JOBS_WORKER_ROLE_NAME}', 'public.jobs', 'INSERT') AS worker_table_insert,
              has_column_privilege('${JOBS_WORKER_ROLE_NAME}', 'public.jobs', 'payload', 'SELECT') AS worker_payload_select,
              has_column_privilege('${JOBS_WORKER_ROLE_NAME}', 'public.jobs', 'org_id', 'SELECT') AS worker_org_select,
              has_column_privilege('${JOBS_WORKER_ROLE_NAME}', 'public.jobs', 'created_by_actor_id', 'SELECT') AS worker_actor_select,
              has_column_privilege('${JOBS_CLAIM_OWNER_ROLE_NAME}', 'public.jobs', 'payload', 'SELECT') AS claim_payload_select,
              has_column_privilege('${JOBS_CLAIM_OWNER_ROLE_NAME}', 'public.jobs', 'status', 'UPDATE') AS claim_status_update,
              has_column_privilege('${JOBS_CLAIM_OWNER_ROLE_NAME}', 'public.jobs', 'fencing_token', 'UPDATE') AS claim_fence_update,
              has_schema_privilege('${JOBS_WORKER_ROLE_NAME}', 'jobs_worker', 'CREATE') AS worker_schema_create,
              EXISTS (
                SELECT 1 FROM pg_class relation
                JOIN pg_namespace rel_namespace ON rel_namespace.oid = relation.relnamespace
                WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'S')
                  AND rel_namespace.nspname = 'public'
                  AND has_any_column_privilege('${JOBS_CLAIM_OWNER_ROLE_NAME}', relation.oid, 'SELECT')
                  AND relation.oid NOT IN (
                    'public.jobs'::regclass,
                    'public.organizations'::regclass,
                    'public.routines'::regclass
                  )
              ) AS claim_other_table_access
       FROM pg_proc procedure
       JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
       JOIN pg_roles owner ON owner.oid = procedure.proowner
       WHERE namespace.nspname = 'jobs_worker' AND procedure.proname = 'claim_capability_job'`,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      function_owner: JOBS_CLAIM_OWNER_ROLE_NAME,
      security_definer: true,
      public_execute: false,
      worker_execute: true,
      app_execute: false,
      worker_table_select: false,
      worker_table_insert: false,
      worker_payload_select: true,
      worker_org_select: true,
      worker_actor_select: false,
      claim_payload_select: false,
      claim_status_update: true,
      claim_fence_update: true,
      claim_other_table_access: false,
      worker_schema_create: false,
    });
  });

  it("limits Go routine scheduling to a metadata-only definer function", async () => {
    const result = await admin.unsafe<{
      owner: string;
      security_definer: boolean;
      worker_execute: boolean;
      public_execute: boolean;
      worker_routines_select: boolean;
      worker_organizations_select: boolean;
      owner_routine_id_select: boolean;
      owner_routine_prompt_select: boolean;
      owner_org_id_select: boolean;
    }[]>(
      `SELECT owner.rolname AS owner,
              procedure.prosecdef AS security_definer,
              has_function_privilege('${JOBS_WORKER_ROLE_NAME}', procedure.oid, 'EXECUTE') AS worker_execute,
              EXISTS (
                SELECT 1 FROM aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) acl
                WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
              ) AS public_execute,
              has_table_privilege('${JOBS_WORKER_ROLE_NAME}', 'public.routines', 'SELECT') AS worker_routines_select,
              has_table_privilege('${JOBS_WORKER_ROLE_NAME}', 'public.organizations', 'SELECT') AS worker_organizations_select,
              has_column_privilege('${JOBS_CLAIM_OWNER_ROLE_NAME}', 'public.routines', 'id', 'SELECT') AS owner_routine_id_select,
              has_column_privilege('${JOBS_CLAIM_OWNER_ROLE_NAME}', 'public.routines', 'prompt', 'SELECT') AS owner_routine_prompt_select,
              has_column_privilege('${JOBS_CLAIM_OWNER_ROLE_NAME}', 'public.organizations', 'id', 'SELECT') AS owner_org_id_select
       FROM pg_proc procedure
       JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
       JOIN pg_roles owner ON owner.oid = procedure.proowner
       WHERE namespace.nspname = 'jobs_worker' AND procedure.proname = 'list_due_routine_candidates'`,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      owner: JOBS_CLAIM_OWNER_ROLE_NAME,
      security_definer: true,
      worker_execute: true,
      public_execute: false,
      worker_routines_select: false,
      worker_organizations_select: false,
      owner_routine_id_select: true,
      owner_routine_prompt_select: false,
      owner_org_id_select: true,
    });
  });

  it("makes repeat provisioning idempotent", async () => {
    const role = await ensureJobsWorkerRole({
      databaseUrl,
      password: jobsWorkerPassword,
    });
    expect(role.roleName).toBe(JOBS_WORKER_ROLE_NAME);
    expect(role.functionOwnerRoleName).toBe(JOBS_CLAIM_OWNER_ROLE_NAME);
    expect(new URL(role.workerUrl).username).toBe(JOBS_WORKER_ROLE_NAME);
  });
});
