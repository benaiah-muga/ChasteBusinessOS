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

CREATE TABLE IF NOT EXISTS business_partners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  type text NOT NULL DEFAULT 'person',
  name text NOT NULL,
  email text,
  phone text,
  city text,
  country text,
  notes text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS business_partners_org_idx ON business_partners(organization_id);
CREATE INDEX IF NOT EXISTS business_partners_org_type_idx ON business_partners(organization_id, type);

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
ALTER TABLE crm_customers ADD COLUMN IF NOT EXISTS business_partner_id uuid;

CREATE TABLE IF NOT EXISTS crm_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  customer_id uuid NOT NULL REFERENCES crm_customers(id) ON DELETE CASCADE,
  name text NOT NULL,
  role text,
  email text,
  phone text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_contacts_org_idx ON crm_contacts(organization_id);
CREATE INDEX IF NOT EXISTS crm_contacts_customer_idx ON crm_contacts(customer_id);
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS business_partner_id uuid;

CREATE TABLE IF NOT EXISTS crm_interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  customer_id uuid NOT NULL REFERENCES crm_customers(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'note',
  summary text NOT NULL,
  detail text,
  actor_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_interactions_org_idx ON crm_interactions(organization_id);
CREATE INDEX IF NOT EXISTS crm_interactions_customer_idx ON crm_interactions(customer_id);

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
ALTER TABLE pur_vendors ADD COLUMN IF NOT EXISTS business_partner_id uuid;

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
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS business_partner_id uuid;

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
ALTER TABLE users ADD COLUMN IF NOT EXISTS active_branch_id uuid;

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

-- Branches
CREATE TABLE IF NOT EXISTS branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  code text NOT NULL,
  timezone text,
  parent_branch_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS branches_org_code_uidx ON branches(organization_id, code);
CREATE INDEX IF NOT EXISTS branches_org_idx ON branches(organization_id);

CREATE TABLE IF NOT EXISTS user_branch_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS user_branch_access_uidx ON user_branch_access(user_id, branch_id);

-- Chat session metadata
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS active_branch_id uuid;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS chat_sess_updated_idx ON chat_sessions(updated_at);

CREATE TABLE IF NOT EXISTS chat_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  message_id text NOT NULL,
  rating text NOT NULL,
  comment text,
  run_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_feedback_sess_idx ON chat_feedback(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS chat_feedback_msg_user_uidx ON chat_feedback(session_id, message_id, user_id);

CREATE TABLE IF NOT EXISTS capability_gap_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  proposed_capability_id text NOT NULL,
  title text NOT NULL,
  abstract_requirement text NOT NULL,
  acceptance_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  example_scenarios jsonb NOT NULL DEFAULT '[]'::jsonb,
  suggested_module_id text,
  non_goals jsonb NOT NULL DEFAULT '[]'::jsonb,
  deployment_target text NOT NULL DEFAULT 'undecided',
  coding_agent text,
  artifact_ref text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gap_tickets_org_idx ON capability_gap_tickets(organization_id);
CREATE INDEX IF NOT EXISTS gap_tickets_status_idx ON capability_gap_tickets(status);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'info',
  title text NOT NULL,
  body text,
  href text,
  resource_type text,
  resource_id text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id);
CREATE INDEX IF NOT EXISTS notifications_org_idx ON notifications(organization_id);

-- Chat session agent-runtime columns
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS unattended boolean NOT NULL DEFAULT false;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS compaction_state jsonb;

-- R2 -- pending approvals (the canonical human-attention queue)
CREATE TABLE IF NOT EXISTS pending_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  kind text NOT NULL,
  title text NOT NULL,
  body text,
  state text NOT NULL DEFAULT 'pending',
  resolution text,
  inbox text NOT NULL DEFAULT 'default',
  visibility text NOT NULL DEFAULT 'inline',
  tool_call_id text,
  options jsonb DEFAULT '[]'::jsonb,
  allow_text boolean NOT NULL DEFAULT true,
  multi boolean NOT NULL DEFAULT false,
  data jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS pending_approvals_session_idx ON pending_approvals(session_id);
CREATE INDEX IF NOT EXISTS pending_approvals_org_state_idx ON pending_approvals(organization_id, state);
CREATE UNIQUE INDEX IF NOT EXISTS pending_approvals_toolcall_uidx ON pending_approvals(session_id, tool_call_id);

-- R5 -- durable self-wake records
CREATE TABLE IF NOT EXISTS ai_wakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  task_id uuid,
  proactive_text text,
  kind text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  fire_at timestamptz,
  job_id text,
  event_key text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_wakes_due_idx ON ai_wakes(state, fire_at);
CREATE INDEX IF NOT EXISTS ai_wakes_session_idx ON ai_wakes(session_id);
CREATE INDEX IF NOT EXISTS ai_wakes_job_idx ON ai_wakes(job_id);
CREATE INDEX IF NOT EXISTS ai_wakes_event_idx ON ai_wakes(event_key);

-- R7 -- org/platform AI skill catalog
CREATE TABLE IF NOT EXISTS ai_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL DEFAULT 'organization',
  organization_id uuid,
  branch_id uuid,
  name text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  instructions text NOT NULL,
  files jsonb DEFAULT '[]'::jsonb,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_skills_name_scope_uidx ON ai_skills(name, organization_id, branch_id);
CREATE INDEX IF NOT EXISTS ai_skills_org_idx ON ai_skills(organization_id);

-- R10 -- inbound channel to session ownership
CREATE TABLE IF NOT EXISTS channel_session_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_target text NOT NULL,
  session_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  branch_id uuid,
  channel text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_bindings_target_uidx ON channel_session_bindings(thread_target);
CREATE INDEX IF NOT EXISTS channel_bindings_session_idx ON channel_session_bindings(session_id);
CREATE INDEX IF NOT EXISTS channel_bindings_org_idx ON channel_session_bindings(organization_id);

-- C2/C5 -- reminders and agent follow-ups (scheduling-and-comms.md)
CREATE TABLE IF NOT EXISTS reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_by uuid NOT NULL,
  title text NOT NULL,
  body text,
  href text,
  fire_at timestamptz NOT NULL,
  channel text NOT NULL DEFAULT 'in_app',
  status text NOT NULL DEFAULT 'scheduled',
  branch_id uuid,
  fired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders(status, fire_at);
CREATE INDEX IF NOT EXISTS reminders_user_idx ON reminders(user_id);
CREATE INDEX IF NOT EXISTS reminders_org_idx ON reminders(organization_id);

CREATE TABLE IF NOT EXISTS follow_ups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_by uuid NOT NULL,
  goal text NOT NULL,
  fire_at timestamptz NOT NULL,
  session_id uuid,
  branch_id uuid,
  autonomy_override text,
  status text NOT NULL DEFAULT 'scheduled',
  fired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS follow_ups_due_idx ON follow_ups(status, fire_at);
CREATE INDEX IF NOT EXISTS follow_ups_user_idx ON follow_ups(user_id);
CREATE INDEX IF NOT EXISTS follow_ups_org_idx ON follow_ups(organization_id);

-- C3 -- calendars and shared calendar events (scheduling-and-comms.md §2.1)
CREATE TABLE IF NOT EXISTS calendars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  scope text NOT NULL DEFAULT 'org',
  name text NOT NULL,
  owner_user_id uuid,
  branch_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calendars_org_idx ON calendars(organization_id);
CREATE INDEX IF NOT EXISTS calendars_owner_idx ON calendars(owner_user_id);

CREATE TABLE IF NOT EXISTS calendar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  calendar_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  branch_id uuid,
  attendees jsonb NOT NULL DEFAULT '[]'::jsonb,
  linked_resources jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'scheduled',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calendar_events_org_idx ON calendar_events(organization_id);
CREATE INDEX IF NOT EXISTS calendar_events_calendar_idx ON calendar_events(calendar_id);
CREATE INDEX IF NOT EXISTS calendar_events_range_idx
  ON calendar_events(organization_id, starts_at, ends_at);

-- C6 -- outbound email delivery records (scheduling-and-comms.md §5)
CREATE TABLE IF NOT EXISTS email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  "to" text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  template text,
  status text NOT NULL DEFAULT 'queued',
  provider text,
  provider_message_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS email_outbox_status_idx ON email_outbox(status);
CREATE INDEX IF NOT EXISTS email_outbox_org_idx ON email_outbox(organization_id);

-- Backup / export / restore -- job ledger (backup-and-deploy.md)
CREATE TABLE IF NOT EXISTS backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  provider text,
  storage_key text,
  size_bytes integer,
  checksum text,
  created_by uuid,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS backups_org_idx ON backups(organization_id);
CREATE INDEX IF NOT EXISTS backups_status_idx ON backups(status);

-- Messaging -- threads, members, messages, read cursors (messaging-and-buzz.md)
CREATE TABLE IF NOT EXISTS msg_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  type text NOT NULL DEFAULT 'direct',
  name text,
  created_by uuid NOT NULL,
  is_archived boolean NOT NULL DEFAULT FALSE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS msg_threads_org_idx ON msg_threads(organization_id);
CREATE INDEX IF NOT EXISTS msg_threads_member_updated_idx ON msg_threads(organization_id, updated_at);

CREATE TABLE IF NOT EXISTS msg_thread_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES msg_threads(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member',
  joined_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS msg_thread_members_uidx ON msg_thread_members(thread_id, user_id);
CREATE INDEX IF NOT EXISTS msg_thread_members_user_idx ON msg_thread_members(user_id);

CREATE TABLE IF NOT EXISTS msg_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  thread_id uuid NOT NULL REFERENCES msg_threads(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'text',
  body text NOT NULL,
  parent_id uuid,
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS msg_messages_thread_created_idx ON msg_messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS msg_messages_org_idx ON msg_messages(organization_id);

CREATE TABLE IF NOT EXISTS msg_reads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES msg_threads(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  last_read_message_id uuid,
  last_read_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS msg_reads_uidx ON msg_reads(thread_id, user_id);

-- S0 -- machine-readable capability catalog (self-development.md §6)
CREATE TABLE IF NOT EXISTS capability_catalog_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id text NOT NULL,
  capability_id text NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
  implemented boolean NOT NULL DEFAULT TRUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS capability_catalog_module_cap_uidx
  ON capability_catalog_items(module_id, capability_id);
CREATE INDEX IF NOT EXISTS capability_catalog_cap_idx
  ON capability_catalog_items(capability_id);

-- Seed the curated platform capability catalog (idempotent).
INSERT INTO capability_catalog_items (module_id, capability_id, name, description, keywords) VALUES
  ('platform', 'core.branches', 'Branches',
   'Create and switch organizational branches (HQ, locations) and scope work to a branch.',
   '["branch","location","site","office"]'),
  ('platform', 'core.users', 'Users & invites',
   'Invite users to the organization, optionally scoped to a branch, and manage profiles.',
   '["user","invite","team","member","people"]'),
  ('platform', 'core.rbac', 'Roles & permissions',
   'Define roles and assign granular permissions per organization.',
   '["rbac","role","permission","access","security"]'),
  ('platform', 'core.marketplace', 'Marketplace & modules',
   'Browse, install, and manage business modules from the marketplace.',
   '["marketplace","module","install","extension","app"]'),
  ('platform', 'core.autonomy', 'Autonomy policy',
   'Govern whether the AI can auto-execute commands or requires human confirmation.',
   '["autonomy","ai","guarded","confirm","policy","automation"]'),
  ('platform', 'core.notifications', 'Notifications',
   'Record and list in-app notifications; mark them read.',
   '["notification","alert","bell","inbox"]'),
  ('platform', 'core.chat', 'AI chat & agent runtime',
   'Natural-language chat that plans and executes commands under the organization autonomy policy.',
   '["chat","ai","agent","assistant","nlu","language"]'),
  ('platform', 'core.capabilities', 'Capability gaps',
   'Search what the product can do and file capability gap tickets for what it cannot.',
   '["gap","capability","customize","request","roadmap"]'),
  ('platform', 'core.reminders', 'Reminders',
   'Schedule one-off reminders that surface as in-app notifications at the chosen time.',
   '["reminder","schedule","todo","nudge","notify"]'),
  ('platform', 'core.followups', 'Agent follow-ups',
   'Ask the agent to follow up on a goal later; it re-enters and executes under org policy.',
   '["followup","follow up","agent","later","recurring"]'),
  ('platform', 'core.calendar', 'Calendar & scheduling',
   'Create, update, and list shared calendar events for the organization or a branch.',
   '["calendar","event","meeting","schedule","block","appointment"]'),
  ('crm', 'crm.customers', 'Customer relationships',
   'Manage customers, contacts, and sales follow-up.',
   '["customer","sales","account","lead","contact","crm"]'),
  ('accounting', 'acc.accounts', 'Accounting & finance',
   'Ledger, journal entries, invoices, and financial accounting.',
   '["account","ledger","journal","invoice","invoice","bookkeeping","finance"]'),
  ('inventory', 'inventory.items', 'Inventory management',
   'Track inventory items, stock levels, and warehouses.',
   '["inventory","stock","warehouse","item","reorder","sku"]'),
  ('purchasing', 'purchasing.orders', 'Purchasing & procurement',
   'Create and manage purchase orders and vendor procurement.',
   '["purchase","procurement","vendor","supplier","po"]'),
  ('hr', 'hr.employees', 'HR & people',
   'Manage employees, hiring, and HR records.',
   '["hr","employee","people","hiring","onboarding","payslip"]'),
  ('manufacturing', 'manufacturing.orders', 'Manufacturing',
   'Create and route manufacturing orders and production.',
   '["manufacturing","production","batch","routing","work order"]')
ON CONFLICT (module_id, capability_id) DO NOTHING;

-- ARCH-5 -- AI workflows. These mirror Drizzle schema workflow_definitions /
-- workflow_runs; they were absent from this blob and are now persisted so a
-- process restart no longer loses user-built automations (ARCH-5).
CREATE TABLE IF NOT EXISTS workflow_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  description text NOT NULL,
  trigger text NOT NULL DEFAULT 'manual',
  trigger_config jsonb NOT NULL DEFAULT '{}',
  steps jsonb NOT NULL,
  created_by text NOT NULL DEFAULT 'user',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wf_def_org_idx ON workflow_definitions(organization_id);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'running',
  context jsonb NOT NULL DEFAULT '{}',
  steps jsonb NOT NULL DEFAULT '[]',
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS wf_run_org_idx ON workflow_runs(organization_id);
CREATE INDEX IF NOT EXISTS wf_run_wf_idx ON workflow_runs(workflow_id);
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
