/**
 * Idempotent SQL migrations for the platform SoR.
 */
import postgres from "postgres";

const sql = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  autonomy text NOT NULL DEFAULT 'confirm',
  full_autonomous_ack_at timestamptz,
  region text NOT NULL DEFAULT 'local',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS full_autonomous_ack_at timestamptz;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS region text NOT NULL DEFAULT 'local';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  email text NOT NULL,
  display_name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX IF NOT EXISTS users_org_email_uidx ON users(organization_id, email);

CREATE TABLE IF NOT EXISTS roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  key text NOT NULL,
  name text NOT NULL,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS roles_org_key_uidx ON roles(organization_id, key);

CREATE TABLE IF NOT EXISTS role_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS role_perm_uidx ON role_permissions(role_id, permission);

CREATE TABLE IF NOT EXISTS user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS user_roles_uidx ON user_roles(user_id, role_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at timestamptz NOT NULL DEFAULT now(),
  organization_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  actor_kind text NOT NULL,
  ai_run_id uuid,
  action text NOT NULL,
  resource_type text,
  resource_id text,
  success boolean NOT NULL,
  request_id text NOT NULL,
  input_summary jsonb,
  error_code text,
  error_message text
);
CREATE INDEX IF NOT EXISTS audit_log_org_idx ON audit_log(organization_id);

CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  organization_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL,
  correlation_id text,
  causation_id text,
  processed_at timestamptz
);

CREATE TABLE IF NOT EXISTS module_installs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  module_id text NOT NULL,
  version text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  installed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE module_installs ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX IF NOT EXISTS module_installs_uidx ON module_installs(organization_id, module_id);

CREATE TABLE IF NOT EXISTS marketplace_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id text NOT NULL UNIQUE,
  name text NOT NULL,
  version text NOT NULL,
  summary text NOT NULL,
  category text NOT NULL,
  publisher text NOT NULL DEFAULT 'chaste',
  regions jsonb NOT NULL DEFAULT '["*"]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES chat_sessions(id),
  role text NOT NULL,
  parts jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_explanations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  session_id uuid,
  run_id uuid NOT NULL,
  summary text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS org_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  kind text NOT NULL,
  content text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  name text NOT NULL,
  email text,
  city text,
  country text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_customers_org_idx ON crm_customers(organization_id);

CREATE TABLE IF NOT EXISTS acc_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  type text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS acc_accounts_code_uidx ON acc_accounts(organization_id, code);

CREATE TABLE IF NOT EXISTS acc_journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  reference text NOT NULL,
  memo text,
  status text NOT NULL DEFAULT 'posted',
  entry_date timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS acc_journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES acc_journal_entries(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES acc_accounts(id),
  debit numeric(18,2) NOT NULL DEFAULT 0,
  credit numeric(18,2) NOT NULL DEFAULT 0,
  memo text
);

CREATE TABLE IF NOT EXISTS acc_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  customer_id uuid,
  number text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  currency text NOT NULL DEFAULT 'USD',
  total numeric(18,2) NOT NULL DEFAULT 0,
  issued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inv_warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  city text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS inv_wh_code_uidx ON inv_warehouses(organization_id, code);

CREATE TABLE IF NOT EXISTS inv_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  sku text NOT NULL,
  name text NOT NULL,
  uom text NOT NULL DEFAULT 'ea',
  reorder_level integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS inv_products_sku_uidx ON inv_products(organization_id, sku);

CREATE TABLE IF NOT EXISTS inv_stock_levels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  warehouse_id uuid NOT NULL REFERENCES inv_warehouses(id),
  product_id uuid NOT NULL REFERENCES inv_products(id),
  quantity integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS inv_stock_uidx ON inv_stock_levels(warehouse_id, product_id);

CREATE TABLE IF NOT EXISTS inv_stock_moves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  product_id uuid NOT NULL,
  quantity integer NOT NULL,
  reason text NOT NULL,
  reference text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pur_vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  name text NOT NULL,
  email text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pur_vendors_org_idx ON pur_vendors(organization_id);

CREATE TABLE IF NOT EXISTS pur_purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  vendor_id uuid NOT NULL REFERENCES pur_vendors(id),
  number text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  total numeric(18,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hr_employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  employee_number text NOT NULL,
  full_name text NOT NULL,
  email text,
  department text,
  job_title text,
  status text NOT NULL DEFAULT 'active',
  base_salary numeric(18,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hr_emp_num_uidx ON hr_employees(organization_id, employee_number);

CREATE TABLE IF NOT EXISTS hr_payroll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  period_label text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  total_gross numeric(18,2) NOT NULL DEFAULT 0,
  employee_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mfg_boms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL,
  name text NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mfg_boms_org_idx ON mfg_boms(organization_id);

CREATE TABLE IF NOT EXISTS mfg_bom_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bom_id uuid NOT NULL REFERENCES mfg_boms(id) ON DELETE CASCADE,
  component_product_id uuid NOT NULL,
  quantity integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS mfg_work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  bom_id uuid NOT NULL,
  number text NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'planned',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pending jsonb;
CREATE INDEX IF NOT EXISTS chat_sess_org_idx ON chat_sessions(organization_id);
CREATE INDEX IF NOT EXISTS chat_sess_user_idx ON chat_sessions(user_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role text NOT NULL,
  parts jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Memory store: add key, user_id, session_id, expires_at for tiered storage
ALTER TABLE org_memories ADD COLUMN IF NOT EXISTS key text;
ALTER TABLE org_memories ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE org_memories ADD COLUMN IF NOT EXISTS session_id uuid;
ALTER TABLE org_memories ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- Users: add auth_token for simple token-based auth
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_token text;
CREATE UNIQUE INDEX IF NOT EXISTS users_auth_token_uidx ON users (auth_token) WHERE auth_token IS NOT NULL;

-- Unique constraint: one memory per org+kind+key
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_memories_org_kind_key
  ON org_memories (organization_id, kind, key)
  WHERE key IS NOT NULL;

-- Index for user-scoped queries
CREATE INDEX IF NOT EXISTS idx_org_memories_user
  ON org_memories (organization_id, user_id)
  WHERE user_id IS NOT NULL;

-- Index for session-scoped queries
CREATE INDEX IF NOT EXISTS idx_org_memories_session
  ON org_memories (session_id)
  WHERE session_id IS NOT NULL;

-- Index for TTL cleanup
CREATE INDEX IF NOT EXISTS idx_org_memories_expires
  ON org_memories (expires_at)
  WHERE expires_at IS NOT NULL;

-- User preferences: add settings jsonb column
ALTER TABLE users ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Split core.rbac.manage into fine-grained permissions
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM role_permissions WHERE permission = 'core.rbac.manage') THEN
    INSERT INTO role_permissions (role_id, permission)
      SELECT role_id, 'core.user.manage' FROM role_permissions WHERE permission = 'core.rbac.manage'
      ON CONFLICT DO NOTHING;
    INSERT INTO role_permissions (role_id, permission)
      SELECT role_id, 'core.role.manage' FROM role_permissions WHERE permission = 'core.rbac.manage'
      ON CONFLICT DO NOTHING;
    INSERT INTO role_permissions (role_id, permission)
      SELECT role_id, 'core.role.assign' FROM role_permissions WHERE permission = 'core.rbac.manage'
      ON CONFLICT DO NOTHING;
    DELETE FROM role_permissions WHERE permission = 'core.rbac.manage';
  END IF;
END $$;
`;

export async function runMigrations(databaseUrl?: string): Promise<void> {
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required");
  }
  const client = postgres(url, { max: 1 });
  try {
    await client.unsafe(sql);
  } finally {
    await client.end({ timeout: 5 });
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations().then(() => {
    console.log("Migrations applied successfully.");
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
