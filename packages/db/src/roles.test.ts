import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  ensureMarketingEmailWorkerRole,
  ensureJobsWorkerRole,
  ensureOutboxWorkerRole,
  JOBS_CLAIM_OWNER_ROLE_NAME,
  JOBS_WORKER_ROLE_NAME,
  OUTBOX_CLAIM_OWNER_ROLE_NAME,
  OUTBOX_WORKER_ROLE_NAME,
  MARKETING_EMAIL_CLAIM_OWNER_ROLE_NAME,
  MARKETING_EMAIL_WORKER_PASSWORD_ENV,
  MARKETING_EMAIL_WORKER_ROLE_NAME,
} from "./roles";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
const workerPassword =
  process.env.CHASTE_OUTBOX_WORKER_DB_PASSWORD ??
  "chaste_outbox_worker_dev_only";
const jobsWorkerPassword =
  process.env.CHASTE_JOBS_WORKER_DB_PASSWORD ?? "chaste_jobs_worker_dev_only";
const marketingEmailWorkerPassword =
  process.env[MARKETING_EMAIL_WORKER_PASSWORD_ENV] ?? "chaste_marketing_email_worker_dev_only";

let admin: ReturnType<typeof postgres>;
let jobsWorker: ReturnType<typeof postgres>;
let marketingEmailWorker: ReturnType<typeof postgres>;

beforeAll(async () => {
  admin = postgres(databaseUrl, { max: 1 });
  await ensureOutboxWorkerRole({ databaseUrl, password: workerPassword });
  await admin.unsafe(`GRANT SELECT (name) ON TABLE public.customers TO ${MARKETING_EMAIL_WORKER_ROLE_NAME}`);
  const marketingEmailRole = await ensureMarketingEmailWorkerRole({ databaseUrl, password: marketingEmailWorkerPassword });
  marketingEmailWorker = postgres(marketingEmailRole.workerUrl, { max: 1 });
  const jobsRole = await ensureJobsWorkerRole({
    databaseUrl,
    password: jobsWorkerPassword,
  });
  jobsWorker = postgres(jobsRole.workerUrl, { max: 1 });
});

afterAll(async () => {
  await jobsWorker?.end();
  await marketingEmailWorker?.end();
  await admin?.end();
});

describe("marketing email outbox worker role provisioning", () => {
  it("is a dedicated non-escalating login with only delivery and eligibility reads", async () => {
    const result = await admin.unsafe<{
      worker_login: boolean;
      worker_safe: boolean;
      owner_no_login: boolean;
      owner_safe: boolean;
      worker_can_claim: boolean;
      app_can_claim: boolean;
      worker_outbox_table_select: boolean;
      worker_payload_select: boolean;
      worker_dedupe_select: boolean;
      worker_customer_email_select: boolean;
      worker_customer_optout_select: boolean;
      worker_customer_name_select: boolean;
      owner_payload_select: boolean;
      function_owner: string;
      function_security_definer: boolean;
      function_public_execute: boolean;
    }[]>(`SELECT worker.rolcanlogin AS worker_login,
        NOT worker.rolsuper AND NOT worker.rolcreatedb AND NOT worker.rolcreaterole AND NOT worker.rolreplication AND NOT worker.rolbypassrls AND NOT worker.rolinherit AS worker_safe,
        NOT owner.rolcanlogin AS owner_no_login,
        NOT owner.rolsuper AND NOT owner.rolcreatedb AND NOT owner.rolcreaterole AND NOT owner.rolreplication AND NOT owner.rolbypassrls AND NOT owner.rolinherit AS owner_safe,
        has_function_privilege('${MARKETING_EMAIL_WORKER_ROLE_NAME}', procedure.oid, 'EXECUTE') AS worker_can_claim,
        has_function_privilege('chaste_app', procedure.oid, 'EXECUTE') AS app_can_claim,
        has_table_privilege('${MARKETING_EMAIL_WORKER_ROLE_NAME}', 'public.outbox_messages', 'SELECT') AS worker_outbox_table_select,
        has_column_privilege('${MARKETING_EMAIL_WORKER_ROLE_NAME}', 'public.outbox_messages', 'payload', 'SELECT') AS worker_payload_select,
        has_column_privilege('${MARKETING_EMAIL_WORKER_ROLE_NAME}', 'public.outbox_messages', 'dedupe_key', 'SELECT') AS worker_dedupe_select,
        has_column_privilege('${MARKETING_EMAIL_WORKER_ROLE_NAME}', 'public.customers', 'email', 'SELECT') AS worker_customer_email_select,
        has_column_privilege('${MARKETING_EMAIL_WORKER_ROLE_NAME}', 'public.customers', 'marketing_opt_out', 'SELECT') AS worker_customer_optout_select,
        has_column_privilege('${MARKETING_EMAIL_WORKER_ROLE_NAME}', 'public.customers', 'name', 'SELECT') AS worker_customer_name_select,
        has_column_privilege('${MARKETING_EMAIL_CLAIM_OWNER_ROLE_NAME}', 'public.outbox_messages', 'payload', 'SELECT') AS owner_payload_select,
        role_owner.rolname AS function_owner, procedure.prosecdef AS function_security_definer,
        EXISTS (SELECT 1 FROM aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS function_public_execute
      FROM pg_proc procedure JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
      JOIN pg_roles role_owner ON role_owner.oid=procedure.proowner
      CROSS JOIN pg_roles worker CROSS JOIN pg_roles owner
      WHERE namespace.nspname='outbox_worker' AND procedure.proname='claim_marketing_email'
        AND worker.rolname='${MARKETING_EMAIL_WORKER_ROLE_NAME}' AND owner.rolname='${MARKETING_EMAIL_CLAIM_OWNER_ROLE_NAME}'`);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      worker_login: true, worker_safe: true, owner_no_login: true, owner_safe: true,
      worker_can_claim: true, app_can_claim: false, worker_outbox_table_select: false,
      worker_payload_select: true, worker_dedupe_select: true,
      worker_customer_email_select: true, worker_customer_optout_select: true,
      worker_customer_name_select: false, owner_payload_select: false,
      function_owner: MARKETING_EMAIL_CLAIM_OWNER_ROLE_NAME,
      function_security_definer: true, function_public_execute: false,
    });

    const customerColumns = await admin.unsafe<{
      column_name: string;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_reference: boolean;
    }[]>(`SELECT attribute.attname AS column_name,
        has_column_privilege('${MARKETING_EMAIL_WORKER_ROLE_NAME}', 'public.customers', attribute.attname, 'SELECT') AS can_select,
        has_column_privilege('${MARKETING_EMAIL_WORKER_ROLE_NAME}', 'public.customers', attribute.attname, 'INSERT') AS can_insert,
        has_column_privilege('${MARKETING_EMAIL_WORKER_ROLE_NAME}', 'public.customers', attribute.attname, 'UPDATE') AS can_update,
        has_column_privilege('${MARKETING_EMAIL_WORKER_ROLE_NAME}', 'public.customers', attribute.attname, 'REFERENCES') AS can_reference
      FROM pg_attribute attribute
      WHERE attribute.attrelid='public.customers'::regclass AND attribute.attnum > 0 AND NOT attribute.attisdropped`);
    const eligibilityColumns = new Set(["id", "org_id", "email", "marketing_opt_out", "deactivated_at"]);
    for (const column of customerColumns) {
      expect(column.can_select, `${column.column_name} SELECT`).toBe(eligibilityColumns.has(column.column_name));
      expect(column.can_insert, `${column.column_name} INSERT`).toBe(false);
      expect(column.can_update, `${column.column_name} UPDATE`).toBe(false);
      expect(column.can_reference, `${column.column_name} REFERENCES`).toBe(false);
    }
  });

  it("reuses the provisioned worker credentials", async () => {
    const result = await ensureMarketingEmailWorkerRole({ databaseUrl, password: marketingEmailWorkerPassword });
    expect(result.roleName).toBe(MARKETING_EMAIL_WORKER_ROLE_NAME);
    expect(result.functionOwnerRoleName).toBe(MARKETING_EMAIL_CLAIM_OWNER_ROLE_NAME);
    expect(new URL(result.workerUrl).username).toBe(MARKETING_EMAIL_WORKER_ROLE_NAME);
  });
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
                    'public.routines'::regclass,
                    'public.support_kb_article_embedding_jobs'::regclass,
                    'public.recurring_invoices'::regclass,
                    'public.recurring_invoice_runs'::regclass
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

  it("limits recurring invoice discovery to occurrence metadata", async () => {
    const result = await admin.unsafe<{
      owner: string;
      security_definer: boolean;
      worker_execute: boolean;
      public_execute: boolean;
      worker_template_select: boolean;
      worker_organization_select: boolean;
      owner_template_id_select: boolean;
      owner_template_lines_select: boolean;
      owner_occurrence_status_select: boolean;
    }[]>(
      `SELECT owner.rolname AS owner,
              procedure.prosecdef AS security_definer,
              has_function_privilege('${JOBS_WORKER_ROLE_NAME}', procedure.oid, 'EXECUTE') AS worker_execute,
              EXISTS (
                SELECT 1 FROM aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) acl
                WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
              ) AS public_execute,
              has_table_privilege('${JOBS_WORKER_ROLE_NAME}', 'public.recurring_invoices', 'SELECT') AS worker_template_select,
              has_table_privilege('${JOBS_WORKER_ROLE_NAME}', 'public.organizations', 'SELECT') AS worker_organization_select,
              has_column_privilege('${JOBS_CLAIM_OWNER_ROLE_NAME}', 'public.recurring_invoices', 'id', 'SELECT') AS owner_template_id_select,
              has_column_privilege('${JOBS_CLAIM_OWNER_ROLE_NAME}', 'public.recurring_invoices', 'lines', 'SELECT') AS owner_template_lines_select,
              has_column_privilege('${JOBS_CLAIM_OWNER_ROLE_NAME}', 'public.recurring_invoice_runs', 'status', 'SELECT') AS owner_occurrence_status_select
       FROM pg_proc procedure
       JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
       JOIN pg_roles owner ON owner.oid = procedure.proowner
       WHERE namespace.nspname = 'jobs_worker' AND procedure.proname = 'list_due_recurring_invoice_candidates'`,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      owner: JOBS_CLAIM_OWNER_ROLE_NAME,
      security_definer: true,
      worker_execute: true,
      public_execute: false,
      worker_template_select: false,
      worker_organization_select: false,
      owner_template_id_select: true,
      owner_template_lines_select: false,
      owner_occurrence_status_select: true,
    });
  });

  it("limits support embedding discovery to tenant metadata", async () => {
    const result = await admin.unsafe<{
      owner: string;
      security_definer: boolean;
      worker_execute: boolean;
      public_execute: boolean;
      worker_table_select: boolean;
      owner_org_id_select: boolean;
      owner_article_id_select: boolean;
      owner_queued_at_select: boolean;
      owner_available_at_select: boolean;
      owner_content_digest_select: boolean;
    }[]>(
      `SELECT owner.rolname AS owner,
              procedure.prosecdef AS security_definer,
              has_function_privilege('${JOBS_WORKER_ROLE_NAME}', procedure.oid, 'EXECUTE') AS worker_execute,
              EXISTS (
                SELECT 1 FROM aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) acl
                WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
              ) AS public_execute,
              has_table_privilege('${JOBS_WORKER_ROLE_NAME}', 'public.support_kb_article_embedding_jobs', 'SELECT') AS worker_table_select,
              has_column_privilege('${JOBS_CLAIM_OWNER_ROLE_NAME}', 'public.support_kb_article_embedding_jobs', 'org_id', 'SELECT') AS owner_org_id_select,
              has_column_privilege('${JOBS_CLAIM_OWNER_ROLE_NAME}', 'public.support_kb_article_embedding_jobs', 'article_id', 'SELECT') AS owner_article_id_select,
              has_column_privilege('${JOBS_CLAIM_OWNER_ROLE_NAME}', 'public.support_kb_article_embedding_jobs', 'queued_at', 'SELECT') AS owner_queued_at_select,
              has_column_privilege('${JOBS_CLAIM_OWNER_ROLE_NAME}', 'public.support_kb_article_embedding_jobs', 'available_at', 'SELECT') AS owner_available_at_select,
              has_column_privilege('${JOBS_CLAIM_OWNER_ROLE_NAME}', 'public.support_kb_article_embedding_jobs', 'content_md5', 'SELECT') AS owner_content_digest_select
       FROM pg_proc procedure
       JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
       JOIN pg_roles owner ON owner.oid = procedure.proowner
       WHERE namespace.nspname = 'jobs_worker' AND procedure.proname = 'list_public_support_embedding_orgs'`,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      owner: JOBS_CLAIM_OWNER_ROLE_NAME,
      security_definer: true,
      worker_execute: true,
      public_execute: false,
      worker_table_select: false,
      owner_org_id_select: true,
      owner_article_id_select: true,
      owner_queued_at_select: true,
      owner_available_at_select: true,
      owner_content_digest_select: false,
    });
  });

  it("lets the app enqueue a routine webhook without granting schema creation", async () => {
    const result = await admin.unsafe<{
      schema_usage: boolean;
      schema_create: boolean;
      enqueue_execute: boolean;
      enqueue_public_execute: boolean;
    }[]>(
      `SELECT has_schema_privilege('chaste_app', 'jobs_worker', 'USAGE') AS schema_usage,
              has_schema_privilege('chaste_app', 'jobs_worker', 'CREATE') AS schema_create,
              has_function_privilege('chaste_app', 'jobs_worker.enqueue_routine_webhook(text)', 'EXECUTE') AS enqueue_execute,
              EXISTS (
                SELECT 1
                FROM aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) acl
                WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
              ) AS enqueue_public_execute
       FROM pg_proc procedure
       JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
       WHERE namespace.nspname = 'jobs_worker' AND procedure.proname = 'enqueue_routine_webhook'`,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      schema_usage: true,
      schema_create: false,
      enqueue_execute: true,
      enqueue_public_execute: false,
    });
  });

  it("allows the dedicated worker to call bounded support embedding discovery", async () => {
    const result = await jobsWorker<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM jobs_worker.list_public_support_embedding_orgs(10, NULL)
    `;
    expect(result[0]?.count).toBeGreaterThanOrEqual(0);
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
