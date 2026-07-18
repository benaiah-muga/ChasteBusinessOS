import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/* ─── Platform / tenancy ─────────────────────────────────────────── */

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  autonomy: text("autonomy").notNull().default("confirm"),
  fullAutonomousAcknowledgedAt: timestamp("full_autonomous_ack_at", { withTimezone: true }),
  region: text("region").notNull().default("local"),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    authToken: text("auth_token"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_org_email_uidx").on(t.organizationId, t.email),
    uniqueIndex("users_auth_token_uidx").on(t.authToken),
  ],
);

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("roles_org_key_uidx").on(t.organizationId, t.key)],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
  },
  (t) => [uniqueIndex("role_perm_uidx").on(t.roleId, t.permission)],
);

export const userRoles = pgTable(
  "user_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("user_roles_uidx").on(t.userId, t.roleId)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    organizationId: uuid("organization_id").notNull(),
    actorUserId: uuid("actor_user_id").notNull(),
    actorKind: text("actor_kind").notNull(),
    aiRunId: uuid("ai_run_id"),
    action: text("action").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    success: boolean("success").notNull(),
    requestId: text("request_id").notNull(),
    inputSummary: jsonb("input_summary"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
  },
  (t) => [index("audit_log_org_idx").on(t.organizationId)],
);

export const outboxEvents = pgTable("outbox_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").notNull(),
  organizationId: uuid("organization_id").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  payload: jsonb("payload").notNull(),
  correlationId: text("correlation_id"),
  causationId: text("causation_id"),
  processedAt: timestamp("processed_at", { withTimezone: true }),
});

export const moduleInstalls = pgTable(
  "module_installs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    moduleId: text("module_id").notNull(),
    version: text("version").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("module_installs_uidx").on(t.organizationId, t.moduleId)],
);

export const marketplaceListings = pgTable("marketplace_listings", {
  id: uuid("id").primaryKey().defaultRandom(),
  moduleId: text("module_id").notNull().unique(),
  name: text("name").notNull(),
  version: text("version").notNull(),
  summary: text("summary").notNull(),
  category: text("category").notNull(),
  publisher: text("publisher").notNull().default("chaste"),
  regions: jsonb("regions").$type<string[]>().notNull().default(["*"]),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    pending: jsonb("pending").$type<{ id: string; command: string; input: unknown; createdAt: string }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("chat_sess_org_idx").on(t.organizationId),
    index("chat_sess_user_idx").on(t.userId),
  ],
);

export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => chatSessions.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  parts: jsonb("parts").$type<unknown[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const aiExplanations = pgTable("ai_explanations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  userId: uuid("user_id").notNull(),
  sessionId: uuid("session_id"),
  runId: uuid("run_id").notNull(),
  summary: text("summary").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orgMemories = pgTable("org_memories", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  kind: text("kind").notNull(),
  key: text("key"),
  content: text("content").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  userId: uuid("user_id"),
  sessionId: uuid("session_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ─── CRM ────────────────────────────────────────────────────────── */

export const crmCustomers = pgTable(
  "crm_customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    name: text("name").notNull(),
    email: text("email"),
    city: text("city"),
    country: text("country"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("crm_customers_org_idx").on(t.organizationId)],
);

/* ─── Accounting ─────────────────────────────────────────────────── */

export const accAccounts = pgTable(
  "acc_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull(), // asset|liability|equity|revenue|expense
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("acc_accounts_code_uidx").on(t.organizationId, t.code)],
);

export const accJournalEntries = pgTable("acc_journal_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  reference: text("reference").notNull(),
  memo: text("memo"),
  status: text("status").notNull().default("posted"),
  entryDate: timestamp("entry_date", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const accJournalLines = pgTable("acc_journal_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  entryId: uuid("entry_id")
    .notNull()
    .references(() => accJournalEntries.id, { onDelete: "cascade" }),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accAccounts.id),
  debit: numeric("debit", { precision: 18, scale: 2 }).notNull().default("0"),
  credit: numeric("credit", { precision: 18, scale: 2 }).notNull().default("0"),
  memo: text("memo"),
});

export const accInvoices = pgTable("acc_invoices", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  customerId: uuid("customer_id"),
  number: text("number").notNull(),
  status: text("status").notNull().default("draft"),
  currency: text("currency").notNull().default("USD"),
  total: numeric("total", { precision: 18, scale: 2 }).notNull().default("0"),
  issuedAt: timestamp("issued_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ─── Inventory ──────────────────────────────────────────────────── */

export const invWarehouses = pgTable(
  "inv_warehouses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    city: text("city"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("inv_wh_code_uidx").on(t.organizationId, t.code)],
);

export const invProducts = pgTable(
  "inv_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    uom: text("uom").notNull().default("ea"),
    reorderLevel: integer("reorder_level").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("inv_products_sku_uidx").on(t.organizationId, t.sku)],
);

export const invStockLevels = pgTable(
  "inv_stock_levels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => invWarehouses.id),
    productId: uuid("product_id")
      .notNull()
      .references(() => invProducts.id),
    quantity: integer("quantity").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("inv_stock_uidx").on(t.warehouseId, t.productId)],
);

export const invStockMoves = pgTable("inv_stock_moves", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  warehouseId: uuid("warehouse_id").notNull(),
  productId: uuid("product_id").notNull(),
  quantity: integer("quantity").notNull(),
  reason: text("reason").notNull(),
  reference: text("reference"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ─── Purchasing ─────────────────────────────────────────────────── */

export const purVendors = pgTable(
  "pur_vendors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    name: text("name").notNull(),
    email: text("email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pur_vendors_org_idx").on(t.organizationId)],
);

export const purPurchaseOrders = pgTable("pur_purchase_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  vendorId: uuid("vendor_id")
    .notNull()
    .references(() => purVendors.id),
  number: text("number").notNull(),
  status: text("status").notNull().default("draft"),
  total: numeric("total", { precision: 18, scale: 2 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ─── HR / Payroll ───────────────────────────────────────────────── */

export const hrEmployees = pgTable(
  "hr_employees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    employeeNumber: text("employee_number").notNull(),
    fullName: text("full_name").notNull(),
    email: text("email"),
    department: text("department"),
    jobTitle: text("job_title"),
    status: text("status").notNull().default("active"),
    baseSalary: numeric("base_salary", { precision: 18, scale: 2 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("hr_emp_num_uidx").on(t.organizationId, t.employeeNumber)],
);

export const hrPayrollRuns = pgTable("hr_payroll_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  periodLabel: text("period_label").notNull(),
  status: text("status").notNull().default("draft"),
  totalGross: numeric("total_gross", { precision: 18, scale: 2 }).notNull().default("0"),
  employeeCount: integer("employee_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ─── Manufacturing ──────────────────────────────────────────────── */

export const mfgBoms = pgTable(
  "mfg_boms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    productId: uuid("product_id").notNull(),
    name: text("name").notNull(),
    quantity: integer("quantity").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("mfg_boms_org_idx").on(t.organizationId)],
);

export const mfgBomLines = pgTable("mfg_bom_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  bomId: uuid("bom_id")
    .notNull()
    .references(() => mfgBoms.id, { onDelete: "cascade" }),
  componentProductId: uuid("component_product_id").notNull(),
  quantity: integer("quantity").notNull().default(1),
});

export const mfgWorkOrders = pgTable("mfg_work_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  bomId: uuid("bom_id").notNull(),
  number: text("number").notNull(),
  quantity: integer("quantity").notNull().default(1),
  status: text("status").notNull().default("planned"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ─── AI workflows ──────────────────────────────────────────── */

export const workflowDefinitions = pgTable(
  "workflow_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    description: text("description").notNull(),
    trigger: text("trigger").notNull().default("manual"),
    triggerConfig: jsonb("trigger_config").$type<Record<string, unknown>>().default({}),
    steps: jsonb("steps").$type<unknown[]>().notNull(),
    createdBy: text("created_by").notNull().default("user"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("wf_def_org_idx").on(t.organizationId)],
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflowDefinitions.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").notNull(),
    status: text("status").notNull().default("running"),
    context: jsonb("context").$type<Record<string, unknown>>().default({}),
    steps: jsonb("steps").$type<unknown[]>().default([]),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("wf_run_org_idx").on(t.organizationId), index("wf_run_wf_idx").on(t.workflowId)],
);
