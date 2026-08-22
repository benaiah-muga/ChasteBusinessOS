import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

export const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIMENSIONS ?? 1024);

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  baseCurrency: text("base_currency").notNull().default("USD"),
  fiscalYearStart: integer("fiscal_year_start_month").notNull().default(1),
  profileDescription: text("profile_description"),
  settings: jsonb("settings").notNull().default({}),
  createdAt: createdAt(),
});

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name"),
  isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
  createdAt: createdAt(),
});

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("membership_org_user_idx").on(t.orgId, t.userId)],
);

export const permissions = pgTable(
  "permissions",
  {
    id: id(),
    key: text("key").notNull().unique(), // "accounting.postJournalEntry"
    description: text("description"),
  },
);

export const roles = pgTable(
  "roles",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(), // "owner" | "accountant" | ...
    name: text("name").notNull(),
    isSystem: boolean("is_system").notNull().default(false),
  },
  (t) => [uniqueIndex("role_org_key_idx").on(t.orgId, t.key)],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionKey: text("permission_key").notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionKey] })],
);

export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    assignedBy: uuid("assigned_by").references(() => users.id),
    assignedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] })],
);

/** Append-only, hash-chained. Every consequential event lands here exactly once. */
export const ledgerEvents = pgTable(
  "ledger_events",
  {
    seq: bigserial("seq", { mode: "number" }).notNull(),
    id: id(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "restrict" }),
    actorType: text("actor_type").notNull(), // human | agent | system
    actorId: uuid("actor_id"),
    kind: text("kind").notNull(), // domain event type
    capabilityId: text("capability_id"),
    payload: jsonb("payload").notNull(),
    prevHash: text("prev_hash"),
    hash: text("hash").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ledger_org_kind_idx").on(t.orgId, t.kind),
    index("ledger_occurred_idx").on(t.occurredAt),
    uniqueIndex("ledger_seq_idx").on(t.seq),
  ],
);

/** Agent conversation sessions — replayable trajectories. */
export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id),
    title: text("title"),
    mode: text("mode").notNull().default("assist"), // assist | autopilot | creator
    status: text("status").notNull().default("open"), // open | done | blocked | cancelled
    summary: text("summary"),
    modelRef: text("model_ref"),
    tokenUsage: jsonb("token_usage").notNull().default({ input: 0, output: 0 }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("session_org_idx").on(t.orgId, t.createdAt)],
);

/** Trajectory entries: every model call, tool call, decision within a session. */
export const sessionEvents = pgTable(
  "session_events",
  {
    id: id(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    role: text("role").notNull(), // system | user | assistant | tool | approval | compaction
    content: jsonb("content").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("session_event_seq_idx").on(t.sessionId, t.seq)],
);

/** Human-in-the-loop gates. */
export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => agentSessions.id, { onDelete: "set null" }),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id),
    capabilityId: text("capability_id").notNull(),
    riskClass: text("risk_class").notNull(),
    payload: jsonb("payload").notNull(),
    rationale: text("rationale"),
    status: text("status").notNull().default("pending"), // pending | approved | rejected | expired | executed
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id),
    decisionComment: text("decision_comment"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("approval_org_status_idx").on(t.orgId, t.status)],
);

/** Org-level autonomy policies. */
export const policies = pgTable("policies", {
  id: id(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  capabilityPattern: text("capability_pattern").notNull(), // glob e.g. "accounting.*"
  maxRiskAutonomous: text("max_risk_autonomous").notNull().default("write"),
  moneyThresholdMinor: integer("money_threshold_minor"),
  requiresApprovalFor: jsonb("requires_approval_for").notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Semantic memory store (pgvector). Tenant-scoped retrieval. */
export const memories = pgTable(
  "memories",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // business_profile | sop | decision | preference | doc_chunk
    source: text("source"),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("memory_org_kind_idx").on(t.orgId, t.kind)],
);

export const tickets = pgTable(
  "tickets",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => agentSessions.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    origin: text("origin").notNull().default("capability_gap"), // capability_gap | bug | request
    status: text("status").notNull().default("open"),
    createdAt: createdAt(),
  },
  (t) => [index("ticket_org_status_idx").on(t.orgId, t.status)],
);

// ── Business domain ─────────────────────────────────────────────────────

export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull(), // asset | liability | equity | income | expense
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("account_org_code_idx").on(t.orgId, t.code)],
);

export const customers = pgTable(
  "customers",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email"),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("customer_org_idx").on(t.orgId, t.name)],
);

export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    number: integer("number").notNull(),
    status: text("status").notNull().default("draft"), // draft | sent | paid | void
    currency: text("currency").notNull().default("USD"),
    subtotalMinor: integer("subtotal_minor").notNull(),
    taxMinor: integer("tax_minor").notNull(),
    totalMinor: integer("total_minor").notNull(),
    paidMinor: integer("paid_minor").notNull().default(0),
    memo: text("memo"),
    posSessionId: uuid("pos_session_id").references(() => posSessions.id, { onDelete: "set null" }),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("invoice_org_number_idx").on(t.orgId, t.number), index("invoice_org_customer_idx").on(t.orgId, t.customerId)],
);

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: id(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull(), // thousandths of a unit
    unitPriceMinor: integer("unit_price_minor").notNull(),
    taxMinor: integer("tax_minor").notNull().default(0),
  },
  (t) => [index("invoice_line_invoice_idx").on(t.invoiceId)],
);

export const payments = pgTable(
  "payments",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "restrict" }),
    amountMinor: integer("amount_minor").notNull(),
    method: text("method").notNull().default("bank_transfer"),
    entryId: uuid("entry_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("payment_org_idx").on(t.orgId, t.invoiceId)],
);

/** Posted financial documents are immutable. Corrections are reversal entries. */
export const journalEntries = pgTable(
  "journal_entries",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    memo: text("memo").notNull(),
    sourceType: text("source_type"), // invoice | payment | manual | reversal
    sourceId: uuid("source_id"),
    reversalOfId: uuid("reversal_of_id"),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
    postedByActorType: text("posted_by_actor_type").notNull(),
    postedByActorId: uuid("posted_by_actor_id"),
  },
  (t) => [index("journal_entry_org_idx").on(t.orgId, t.postedAt)],
);

export const journalLines = pgTable(
  "journal_lines",
  {
    id: id(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => journalEntries.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    debitMinor: integer("debit_minor").notNull().default(0),
    creditMinor: integer("credit_minor").notNull().default(0),
  },
  (t) => [index("journal_line_entry_idx").on(t.entryId), index("journal_line_account_idx").on(t.accountId)],
);

// ── Purchasing (AP subledger) ───────────────────────────────────────────

export const vendors = pgTable(
  "vendors",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email"),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("vendor_org_idx").on(t.orgId, t.name)],
);

/** Bills owed to vendors. Immutable once paid; corrections via reversal. */
export const vendorBills = pgTable(
  "vendor_bills",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "restrict" }),
    number: integer("number").notNull(), // internal sequence
    vendorRef: text("vendor_ref"), // the vendor's own invoice reference
    status: text("status").notNull().default("open"), // open | paid | void
    currency: text("currency").notNull().default("USD"),
    totalMinor: integer("total_minor").notNull(),
    paidMinor: integer("paid_minor").notNull().default(0),
    memo: text("memo"),
    entryId: uuid("entry_id"),
    billDate: timestamp("bill_date", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("vendor_bill_org_number_idx").on(t.orgId, t.number), index("vendor_bill_org_vendor_idx").on(t.orgId, t.vendorId)],
);

export const vendorBillLines = pgTable(
  "vendor_bill_lines",
  {
    id: id(),
    billId: uuid("bill_id")
      .notNull()
      .references(() => vendorBills.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull(), // thousandths of a unit
    unitPriceMinor: integer("unit_price_minor").notNull(),
    expenseAccountCode: text("expense_account_code").notNull().default("6000"), // COA code
    poLineId: uuid("po_line_id"),
  },
  (t) => [index("vendor_bill_line_bill_idx").on(t.billId), index("vendor_bill_line_poline_idx").on(t.poLineId)],
);

export const vendorPayments = pgTable(
  "vendor_payments",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    billId: uuid("bill_id")
      .notNull()
      .references(() => vendorBills.id, { onDelete: "restrict" }),
    amountMinor: integer("amount_minor").notNull(),
    method: text("method").notNull().default("bank_transfer"),
    entryId: uuid("entry_id"),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("vendor_payment_org_idx").on(t.orgId, t.billId)],
);

// ── POS (point of sale) ─────────────────────────────────────────────────

// ── Creator Mode (self-development proposals) ───────────────────────────

export const creatorProposals = pgTable(
  "creator_proposals",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    /** Unified diff of the proposed change. */
    diffText: text("diff_text").notNull(),
    testEvidence: text("test_evidence"),
    riskAssessment: text("risk_assessment"),
    status: text("status").notNull().default("in_review"), // in_review | approved | rejected | merged
    sessionId: uuid("session_id").references(() => agentSessions.id, { onDelete: "set null" }),
    proposedByActorType: text("proposed_by_actor_type").notNull(),
    proposedByActorId: uuid("proposed_by_actor_id"),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id),
    reviewComment: text("review_comment"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("creator_proposal_org_status_idx").on(t.orgId, t.status)],
);

// ── Teams: invitations & multi-membership ───────────────────────────────

export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    status: text("status").notNull().default("pending"), // pending | accepted | revoked | expired
    invitedByUserId: uuid("invited_by_user_id").references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("invitation_org_status_idx").on(t.orgId, t.status)],
);

export const posSessions = pgTable(
  "pos_sessions",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    register: text("register").notNull().default("main"),
    status: text("status").notNull().default("open"), // open | closed
    openingFloatMinor: integer("opening_float_minor").notNull().default(0),
    countedCashMinor: integer("counted_cash_minor"),
    expectedCashMinor: integer("expected_cash_minor").notNull().default(0),
    varianceMinor: integer("variance_minor"),
    openedByUserId: uuid("opened_by_user_id").references(() => users.id),
    closedByUserId: uuid("closed_by_user_id").references(() => users.id),
    openedAt: createdAt(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [index("pos_session_org_idx").on(t.orgId, t.status)],
);

export const deals = pgTable(
  "deals",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    stage: text("stage").notNull().default("lead"), // lead | qualified | proposal | negotiation | won | lost
    valueMinor: integer("value_minor").notNull().default(0),
    note: text("note"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("deal_org_stage_idx").on(t.orgId, t.stage)],
);

// ── Inventory (append-only stock ledger) ────────────────────────────────

export const items = pgTable(
  "items",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    unitLabel: text("unit_label").notNull().default("unit"),
    /** Thousandths of a unit; 0 disables reorder alerts. */
    reorderPointThousandths: integer("reorder_point_thousandths").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("item_org_sku_idx").on(t.orgId, t.sku)],
);

/** Every quantity change has a reason and an actor. On-hand is the derived sum. */
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "restrict" }),
    quantityDelta: integer("quantity_delta").notNull(), // signed thousandths
    reason: text("reason").notNull(), // purchase | sale | adjustment | production
    note: text("note"),
    refType: text("ref_type"), // e.g. "po_line", "pos_sale", "invoice"
    refId: uuid("ref_id"),
    unitCostMinor: integer("unit_cost_minor"),
    actorType: text("actor_type").notNull(),
    actorId: uuid("actor_id"),
    createdAt: createdAt(),
  },
  (t) => [index("stock_movement_org_item_idx").on(t.orgId, t.itemId), index("stock_movement_ref_idx").on(t.refType, t.refId)],
);

// ── Purchase orders ─────────────────────────────────────────────────────

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "restrict" }),
    number: integer("number").notNull(),
    status: text("status").notNull().default("ordered"), // ordered | partial | received | closed | void
    memo: text("memo"),
    orderedAt: timestamp("ordered_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("po_org_number_idx").on(t.orgId, t.number)],
);

export const poLines = pgTable(
  "po_lines",
  {
    id: id(),
    poId: uuid("po_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull(), // thousandths
    unitPriceMinor: integer("unit_price_minor").notNull(),
    itemId: uuid("item_id").references(() => items.id, { onDelete: "set null" }),
  },
  (t) => [index("po_line_po_idx").on(t.poId)],
);

// ── Periods (soft close; posting into a closed period is rejected) ─────

export const periods = pgTable(
  "periods",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    year: integer("year").notNull(),
    month: integer("month").notNull(), // 1-12
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
    closedByActorId: uuid("closed_by_actor_id"),
  },
  (t) => [uniqueIndex("period_org_ym_idx").on(t.orgId, t.year, t.month)],
);

// ── Internal messaging ──────────────────────────────────────────────────

export const conversations = pgTable(
  "conversations",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("channel"), // channel | dm
    title: text("title").notNull(),
    agentEnabled: boolean("agent_enabled").notNull().default(false),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("conversation_org_idx").on(t.orgId)],
);

export const conversationMembers = pgTable(
  "conversation_members",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    joinedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.userId] })],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    senderType: text("sender_type").notNull().default("human"), // human | agent | system
    senderUserId: uuid("sender_user_id").references(() => users.id),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("message_conversation_idx").on(t.conversationId, t.createdAt)],
);

// ── better-auth managed tables ──────────────────────────────────────────

export const authUser = pgTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const authSession = pgTable("auth_session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => authUser.id, { onDelete: "cascade" }),
});

export const authAccount = pgTable("auth_account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => authUser.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const authVerification = pgTable("auth_verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
