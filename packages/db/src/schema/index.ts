import { type AnyPgColumn,
  bigint,
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
  /**
   * Which platform modules this org runs, e.g. ["accounting","crm","pos"].
   * NULL means every standard module is enabled (pre-toggle orgs keep
   * working unchanged). Enforcement happens at the kernel executor, so
   * disabled modules vanish from human routes, agent tool lists, and the
   * job queue alike.
   */
  enabledModules: jsonb("enabled_modules"),
  /**
   * Data jurisdiction tag for this org's records (e.g. "eu", "us", "ke").
   * NULL means unspecified. Analytics outputs carry it so every number shown
   * to humans or agents states where the underlying data is domiciled;
   * cross-org rollups are impossible by construction because actors are
   * bound to one org (RLS + executor scoping).
   */
  dataRegion: text("data_region"),
  baseCurrency: text("base_currency").notNull().default("USD"),
  fiscalYearStart: integer("fiscal_year_start_month").notNull().default(1),
  profileDescription: text("profile_description"),
  settings: jsonb("settings").notNull().default({}),
  /**
   * The org's standing agent persona and non-negotiable instructions
   * ("Soul"): voice, tone, hard rules the workmate must always follow.
   * Injected into the agent system prompt ahead of any task, never into
   * posted financial documents. NULL means the platform default voice.
   */
  agentSoul: text("agent_soul"),
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
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
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

/** Agent conversation sessions, replayable trajectories. */
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
    /** Confirmed orders beyond this AR ceiling route to refusal (M9); null = no limit. */
    creditLimitMinor: integer("credit_limit_minor"),
    /** Net-days applied to new invoices; null/0 = due on issue (M10). */
    paymentTermDays: integer("payment_term_days"),
    /** Opted out of automated payment reminders (M10). */
    reminderOptOut: boolean("reminder_opt_out").notNull().default(false),
    /** Opted out of marketing sends (M13); honored at send time. */
    marketingOptOut: boolean("marketing_opt_out").notNull().default(false),
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
    /** Captured at creation when currency ≠ org base: 1 unit = num/den base. */
    fxRateNum: bigint("fx_rate_num", { mode: "number" }),
    fxRateDen: integer("fx_rate_den"),
    memo: text("memo"),
    posSessionId: uuid("pos_session_id").references(() => posSessions.id, { onDelete: "set null" }),
    /** When payment is expected; from the customer's payment terms (M10). */
    dueAt: timestamp("due_at", { withTimezone: true }),
    /** Sum of approved credit notes against this invoice; balance = total − paid − credited. */
    creditedMinor: integer("credited_minor").notNull().default(0),
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
    /**
     * One currency per entry (ADR 0021): every line of an entry shares it.
     * Cross-currency settlement is two entries joined by an fx_settlements
     * row, never mixed lines. Legacy rows are USD by default; the posting
     * service stamps the org's base currency unless told otherwise.
     */
    currency: text("currency").notNull().default("USD"),
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
    /** Net-days the vendor expects payment in; drives bill due dates (M10). */
    paymentTermDays: integer("payment_term_days"),
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
    /** When payment is owed; from the vendor's payment terms (M10). */
    dueAt: timestamp("due_at", { withTimezone: true }),
    /** Sum of approved supplier credit notes against this bill. */
    creditedMinor: integer("credited_minor").notNull().default(0),
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
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
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
    /** Where the deal came from (referral, website, walk-in…). */
    source: text("source"),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Required when a deal is marked lost — feeds win/loss analysis. */
    lostReason: text("lost_reason"),
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
    /** Default selling price in minor units; pre-fills quote and invoice lines. */
    salePriceMinor: integer("sale_price_minor").notNull().default(0),
    /** Thousandths of a unit; 0 disables reorder alerts. */
    reorderPointThousandths: integer("reorder_point_thousandths").notNull().default(0),
    /** Product image URL, shown in pickers and the catalog. */
    imageUrl: text("image_url"),
    /** Free-form merchandising tags, e.g. ["bestseller", "fragile"]. */
    tags: jsonb("tags").notNull().default([]),
    /** Scannable barcode (EAN/UPC/code-128); unique per org when set. */
    barcode: text("barcode"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("item_org_sku_idx").on(t.orgId, t.sku),
    uniqueIndex("item_org_barcode_idx").on(t.orgId, t.barcode),
  ],
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
    locationId: uuid("location_id").references(() => stockLocations.id, { onDelete: "set null" }),
    lotId: uuid("lot_id").references(() => lots.id, { onDelete: "set null" }),
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
    /** When the vendor promised delivery; feeds supplier performance (M10). */
    promisedAt: timestamp("promised_at", { withTimezone: true }),
    /** Closed with unfilled quantities — the shortfall is on record (M10). */
    backordered: boolean("backordered").notNull().default(false),
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
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
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
    /**
     * Explicit @mentions carried by this message: [{ type: "user"|"agent",
     * id }]. Users get a notification; mentioning the agent pulls it into
     * threads where it does not otherwise participate.
     */
    mentions: jsonb("mentions"),
    createdAt: createdAt(),
  },
  (t) => [index("message_conversation_idx").on(t.conversationId, t.createdAt)],
);

// ── Purchasing workflow: request → review → RFQ → quotes → award ───────

/**
 * An internal purchase request. The front of the procure-to-pay funnel:
 * anyone can raise one, a reviewer approves or rejects it, and an approved
 * request is what RFQs quote against. Conversion to a purchase order marks
 * it converted; requests are append-only after that.
 */
export const purchaseRequests = pgTable(
  "purchase_requests",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    justification: text("justification").notNull(),
    estimatedAmountMinor: integer("estimated_amount_minor"),
    /** pending_review | approved | rejected | converted */
    status: text("status").notNull().default("pending_review"),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id),
    decisionReason: text("decision_reason"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("purchase_request_org_status_idx").on(t.orgId, t.status, t.createdAt)],
);

/**
 * One RFQ per vendor per approved request. Quotes are recorded on the same
 * row; awarding marks the winner "won", siblings "lost", and mints the
 * purchase order through purchasing.createPurchaseOrder.
 */
export const rfqs = pgTable(
  "rfqs",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    requestId: uuid("request_id")
      .notNull()
      .references(() => purchaseRequests.id, { onDelete: "cascade" }),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "cascade" }),
    /** sent | quoted | won | lost */
    status: text("status").notNull().default("sent"),
    quoteAmountMinor: integer("quote_amount_minor"),
    quoteLeadTimeDays: integer("quote_lead_time_days"),
    quoteNotes: text("quote_notes"),
    quotedAt: timestamp("quoted_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("rfq_org_request_idx").on(t.orgId, t.requestId), index("rfq_vendor_idx").on(t.vendorId)],
);

// ── Document ingestion (OCR → coding suggestions → bills) ──────────────
/**
 * An ingested business document (vendor bill, receipt, statement). Raw bytes
 * stay in the row until parsing; parsed markdown is what memory and the
 * coding suggester read. Append-only discipline applies to status flow:
 * received → parsed → failed; corrections re-parse rather than mutate text.
 */
export const documents = pgTable(
  "documents",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    sourceType: text("source_type").notNull(), // upload | text
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes"),
    contentBase64: text("content_base64"), // uploads only; ≤5MB enforced at boundary
    rawText: text("raw_text"), // pasted text; also used as fallback when OCR unavailable
    parsedMarkdown: text("parsed_markdown"),
    parseError: text("parse_error"),
    status: text("status").notNull().default("received"), // received | parsed | failed
    createdByActorType: text("created_by_actor_type").notNull(),
    createdByActorId: uuid("created_by_actor_id"),
    /** Folder path (M12): simple slash-separated nesting. */
    folder: text("folder"),
    /** Business-record link (M12): what this document is evidence of. */
    refType: text("ref_type"),
    refId: uuid("ref_id"),
    /** When the document loses validity (contracts, licenses) — signals (M12). */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("document_org_status_idx").on(t.orgId, t.status)],
);

/** Append-only version history (M12): the document row is always the latest. */
export const documentVersions = pgTable(
  "document_versions",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    contentBase64: text("content_base64"),
    rawText: text("raw_text"),
    note: text("note"),
    createdByActorType: text("created_by_actor_type").notNull(),
    createdByActorId: uuid("created_by_actor_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("document_version_idx").on(t.documentId, t.version)],
);

/** Suggested expense coding for a document line; humans accept or dismiss. */
export const documentSuggestions = pgTable(
  "document_suggestions",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    quantityThousandths: integer("quantity_thousandths").notNull().default(1000),
    unitPriceMinor: integer("unit_price_minor").notNull().default(0),
    suggestedAccountCode: text("suggested_account_code").notNull(),
    matchScore: integer("match_score").notNull().default(0),
    matchedOn: jsonb("matched_on").notNull().default([]),
    status: text("status").notNull().default("open"), // open | accepted | dismissed
    createdAt: createdAt(),
  },
  (t) => [index("doc_suggestion_doc_idx").on(t.documentId, t.status)],
);

// ── HR (employees, leave, payroll) ──────────────────────────────────────

export const employees = pgTable(
  "employees",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email"),
    title: text("title"),
    monthlySalaryMinor: integer("monthly_salary_minor").notNull(),
    /** Annual paid-leave entitlement in days; accrues monthly. */
    annualLeaveDays: integer("annual_leave_days").notNull().default(21),
    /** Org structure (M11): plain columns, no org-chart document zoo. */
    department: text("department"),
    managerEmployeeId: uuid("manager_employee_id").references((): AnyPgColumn => employees.id, { onDelete: "set null" }),
    emergencyContactName: text("emergency_contact_name"),
    emergencyContactPhone: text("emergency_contact_phone"),
    taxRateBps: integer("tax_rate_bps").notNull().default(1000),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    hiredAt: timestamp("hired_at", { withTimezone: true }).notNull().defaultNow(),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  },
  (t) => [index("employee_org_idx").on(t.orgId)],
);

export const leaveRequests = pgTable(
  "leave_requests",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("annual"), // annual | sick | unpaid
    startDate: timestamp("start_date", { withTimezone: true }).notNull(),
    endDate: timestamp("end_date", { withTimezone: true }).notNull(),
    calendarDays: integer("calendar_days").notNull(),
    status: text("status").notNull().default("pending"), // pending | approved | rejected | cancelled
    requestedByActorType: text("requested_by_actor_type").notNull(),
    requestedByActorId: uuid("requested_by_actor_id"),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("leave_org_status_idx").on(t.orgId, t.status), index("leave_employee_idx").on(t.employeeId)],
);

/**
 * A payroll run drafts payslips for a month; executing it posts one balanced
 * journal entry (DR salary expense / CR cash) and is money-class gated.
 */
export const payrollRuns = pgTable(
  "payroll_runs",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    year: integer("year").notNull(),
    month: integer("month").notNull(), // 1-12
    status: text("status").notNull().default("draft"), // draft | executed | voided
    totalGrossMinor: integer("total_gross_minor").notNull().default(0),
    totalTaxMinor: integer("total_tax_minor").notNull().default(0),
    totalNetMinor: integer("total_net_minor").notNull().default(0),
    headcount: integer("headcount").notNull().default(0),
    entryId: uuid("entry_id"),
    executedByActorType: text("executed_by_actor_type"),
    executedByActorId: uuid("executed_by_actor_id"),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("payroll_run_org_period_idx").on(t.orgId, t.year, t.month)],
);

export const payslips = pgTable(
  "payslips",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => payrollRuns.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    grossMinor: integer("gross_minor").notNull(),
    taxMinor: integer("tax_minor").notNull().default(0),
    netMinor: integer("net_minor").notNull(),
    workedFractionThousandths: integer("worked_fraction_thousandths").notNull().default(1000),
  },
  (t) => [index("payslip_run_idx").on(t.runId)],
);

// ── BOM-lite (assembly → components) ───────────────────────────────────

/** Flat component list per assembly. Replaced wholesale on redefinition. */
export const bomLines = pgTable(
  "bom_lines",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    assemblyItemId: uuid("assembly_item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    componentItemId: uuid("component_item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    quantityThousandths: integer("quantity_thousandths").notNull(),
    /** Extra allowance per unit consumed (thousandths of a percent). */
    scrapPctThousandths: integer("scrap_pct_thousandths").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index("bom_line_assembly_idx").on(t.orgId, t.assemblyItemId),
    uniqueIndex("bom_line_edge_idx").on(t.assemblyItemId, t.componentItemId),
  ],
);

// ── Manufacturing (locations, lots, work orders, reservations, counts) ──

/** Physical stock location (warehouse, bin, shop-floor staging). */
export const stockLocations = pgTable(
  "stock_locations",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("stock_location_org_code_idx").on(t.orgId, t.code)],
);

/**
 * A production/consumption batch of one item. Movements optionally carry a
 * lot so recalls can be traced upstream through the consumption graph.
 */
export const lots = pgTable(
  "lots",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    lotCode: text("lot_code").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("lot_org_item_code_idx").on(t.orgId, t.itemId, t.lotCode)],
);

/**
 * Planned production run. Draft → released → completed/cancelled; release
 * is policy-gated like any other governed write, completion posts the same
 * atomic component-consumption/finished-goods movements as an instant run.
 */
export const workOrders = pgTable(
  "work_orders",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    assemblyItemId: uuid("assembly_item_id")
      .notNull()
      .references(() => items.id, { onDelete: "restrict" }),
    plannedQtyThousandths: integer("planned_qty_thousandths").notNull(),
    producedQtyThousandths: integer("produced_qty_thousandths").notNull().default(0),
    /** Expected good-output fraction for planning previews. */
    yieldPctThousandths: integer("yield_pct_thousandths").notNull().default(1_000_000),
    /** Work center that runs this order (M11 planning-lite). */
    workCenter: text("work_center"),
    status: text("status").notNull().default("draft"), // draft | released | completed | cancelled
    note: text("note"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdByActorType: text("created_by_actor_type"),
    createdByActorId: uuid("created_by_actor_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("work_order_org_number_idx").on(t.orgId, t.number), index("work_order_org_status_idx").on(t.orgId, t.status)],
);

// ── Recruitment-lite + projects (M11) ──────────────────────────────────

export const jobOpenings = pgTable(
  "job_openings",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    department: text("department"),
    status: text("status").notNull().default("open"), // open | closed
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("job_opening_org_status_idx").on(t.orgId, t.status)],
);

export const jobApplicants = pgTable(
  "job_applicants",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    openingId: uuid("opening_id")
      .notNull()
      .references(() => jobOpenings.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email"),
    stage: text("stage").notNull().default("applied"), // applied | screening | interview | offer | hired | rejected
    hiredEmployeeId: uuid("hired_employee_id").references(() => employees.id, { onDelete: "set null" }),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("job_applicant_opening_idx").on(t.orgId, t.openingId)],
);

export const projects = pgTable(
  "projects",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"), // active | done | archived
    dueAt: timestamp("due_at", { withTimezone: true }),
    createdByActorType: text("created_by_actor_type"),
    createdByActorId: uuid("created_by_actor_id"),
    createdAt: createdAt(),
  },
  (t) => [index("project_org_status_idx").on(t.orgId, t.status)],
);

export const projectTasks = pgTable(
  "project_tasks",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    parentTaskId: uuid("parent_task_id"),
    title: text("title").notNull(),
    status: text("status").notNull().default("todo"), // todo | doing | done
    priority: text("priority").notNull().default("medium"), // low | medium | high
    assigneeUserId: uuid("assignee_user_id").references(() => users.id, { onDelete: "set null" }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    position: integer("position").notNull().default(0), // kanban order within a column
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("project_task_project_idx").on(t.orgId, t.projectId, t.status)],
);

/** Per-category spend ceilings for expense claims (M11). */
export const expensePolicies = pgTable(
  "expense_policies",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    limitMinor: integer("limit_minor").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("expense_policy_org_category_idx").on(t.orgId, t.category)],
);

/**
 * An open claim against on-hand stock (e.g. a sales order or another work
 * order). Reservations never move the ledger; they reduce what is
 * available-to-promise until released or consumed by a real movement.
 */
export const stockReservations = pgTable(
  "stock_reservations",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "restrict" }),
    quantityThousandths: integer("quantity_thousandths").notNull(),
    reason: text("reason").notNull(),
    refType: text("ref_type"),
    refId: uuid("ref_id"),
    status: text("status").notNull().default("open"), // open | released | consumed
    createdByActorType: text("created_by_actor_type"),
    createdByActorId: uuid("created_by_actor_id"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("stock_reservation_org_item_status_idx").on(t.orgId, t.itemId, t.status)],
);

/** A scheduled stock take. Posting writes adjustments through the ledger. */
export const cycleCounts = pgTable(
  "cycle_counts",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    locationId: uuid("location_id").references(() => stockLocations.id, { onDelete: "set null" }),
    status: text("status").notNull().default("open"), // open | posted | cancelled
    note: text("note"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdByActorType: text("created_by_actor_type"),
    createdByActorId: uuid("created_by_actor_id"),
    createdAt: createdAt(),
  },
  (t) => [index("cycle_count_org_status_idx").on(t.orgId, t.status)],
);

export const cycleCountLines = pgTable(
  "cycle_count_lines",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    countId: uuid("count_id")
      .notNull()
      .references(() => cycleCounts.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "restrict" }),
    expectedThousandths: integer("expected_thousandths").notNull(),
    countedThousandths: integer("counted_thousandths"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("cycle_count_line_unique_idx").on(t.countId, t.itemId)],
);

// ── Internal transfers (value-conserving relocation between locations) ──

/**
 * A relocation of stock between two locations. Quantity is conserved by
 * construction (paired out/in legs through the shared ledger writer, reason
 * "transfer") and value is untouched: transfer legs are value-neutral in
 * valuation replay (ADR 0033). Partial confirms move what was confirmed;
 * cancellation is only possible while nothing has moved.
 */
export const stockTransfers = pgTable(
  "stock_transfers",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    fromLocationId: uuid("from_location_id")
      .notNull()
      .references(() => stockLocations.id, { onDelete: "restrict" }),
    toLocationId: uuid("to_location_id")
      .notNull()
      .references(() => stockLocations.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("pending"), // pending | partial | confirmed | cancelled | reversed
    note: text("note"),
    reversalOfId: uuid("reversal_of_id"),
    createdByActorType: text("created_by_actor_type"),
    createdByActorId: uuid("created_by_actor_id"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("stock_transfer_org_number_idx").on(t.orgId, t.number),
    index("stock_transfer_org_status_idx").on(t.orgId, t.status),
  ],
);

export const stockTransferLines = pgTable(
  "stock_transfer_lines",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    transferId: uuid("transfer_id")
      .notNull()
      .references(() => stockTransfers.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "restrict" }),
    quantityThousandths: integer("quantity_thousandths").notNull(),
    confirmedThousandths: integer("confirmed_thousandths").notNull().default(0),
    lotId: uuid("lot_id").references(() => lots.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("stock_transfer_line_transfer_idx").on(t.transferId)],
);

// ── Sales orders (M9: reservation-anchored fulfillment, ADR 0036) ───────

/**
 * The contract between sales and inventory. Confirming reserves stock via
 * the reservation primitives; delivery consumes the reservation, writes
 * paired ledger legs through the shared stock writer, and invoices what
 * shipped. Backorders are a flag, not a document zoo.
 */
export const salesOrders = pgTable(
  "sales_orders",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("draft"), // draft | confirmed | delivered | cancelled
    backordered: boolean("backordered").notNull().default(false),
    note: text("note"),
    createdByActorType: text("created_by_actor_type"),
    createdByActorId: uuid("created_by_actor_id"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("sales_order_org_number_idx").on(t.orgId, t.number),
    index("sales_order_org_status_idx").on(t.orgId, t.status),
  ],
);

export const salesOrderLines = pgTable(
  "sales_order_lines",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => salesOrders.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull(), // thousandths
    unitPriceMinor: integer("unit_price_minor").notNull(),
    taxMinor: integer("tax_minor").notNull().default(0),
    itemId: uuid("item_id").references(() => items.id, { onDelete: "set null" }),
    deliveredThousandths: integer("delivered_thousandths").notNull().default(0),
    reservedThousandths: integer("reserved_thousandths").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("sales_order_line_order_idx").on(t.orderId)],
);

// ── Tasks (M9: CRM/ops follow-ups with due dates → overdue signals) ─────

export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    doneAt: timestamp("done_at", { withTimezone: true }),
    assigneeUserId: uuid("assignee_user_id").references(() => users.id, { onDelete: "set null" }),
    refType: text("ref_type"),
    refId: uuid("ref_id"),
    note: text("note"),
    createdByActorType: text("created_by_actor_type"),
    createdByActorId: uuid("created_by_actor_id"),
    createdAt: createdAt(),
  },
  (t) => [index("task_org_due_idx").on(t.orgId, t.doneAt, t.dueAt)],
);


/**
 * A federated-identity connection for one org. Credentials live here as
 * configuration, never in code; the certificate is the IdP's public signing
 * cert so there is no secret to leak.
 */
export const ssoConnections = pgTable(
  "sso_connections",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    protocol: text("protocol").notNull(), // saml | oidc
    label: text("label").notNull(),
    idpEntityId: text("idp_entity_id").notNull(),
    ssoUrl: text("sso_url").notNull(),
    /** Public signing certificate from the IdP (X.509 PEM). Not a secret. */
    idpCertificate: text("idp_certificate"),
    /** Email-domain routing: users with this domain start here. */
    domain: text("domain"),
    status: text("status").notNull().default("active"), // active | disabled
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("sso_conn_org_idx").on(t.orgId), index("sso_conn_domain_idx").on(t.domain)],
);

/**
 * SCIM bearer tokens are stored hashed; the raw token is shown once at
 * creation and never again, same discipline as passwords.
 */
export const scimTokens = pgTable(
  "scim_tokens",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    label: text("label").notNull().default("IdP provisioning"),
    active: boolean("active").notNull().default(true),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("scim_token_org_idx").on(t.orgId)],
);

// ── Marketplace groundwork (community capability packages) ──────────────

/**
 * A published capability package. The manifest is canonical JSON signed by
 * the publisher's ed25519 key (see @chaste/plugin-kit); verification happens
 * before a listing can be marked verified, and again on install.
 */
export const marketplaceListings = pgTable(
  "marketplace_listings",
  {
    id: id(),
    slug: text("slug").notNull().unique(),
    businessDescription: text("business_description"),
    name: text("name").notNull(),
    version: text("version").notNull(),
    summary: text("summary").notNull(),
    manifest: jsonb("manifest").notNull(),
    signature: text("signature").notNull(), // base64 ed25519 over canonical manifest
    publisherPublicKey: text("publisher_public_key").notNull(), // base64
    capabilityIds: jsonb("capability_ids").notNull().default([]),
    status: text("status").notNull().default("submitted"), // submitted | verified | rejected
    submittedByOrgId: uuid("submitted_by_org_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    installedByOrgIds: jsonb("installed_by_org_ids").notNull().default([]),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("listing_status_idx").on(t.status)],
);

// ── Customer care (support desk) ────────────────────────────────────────

/**
 * One customer inquiry thread. The conversation is bound to exactly one
 * customer at creation: every downstream tool (status lookups, drafts)
 * resolves through this binding, so the support agent can never be steered
 * into another customer's records by prompt injection.
 */
export const supportConversations = pgTable(
  "support_conversations",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    subject: text("subject").notNull(),
    status: text("status").notNull().default("open"), // open | escalated | resolved
    assignedUserId: uuid("assigned_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Ticket fields (M12). */
    ticketNumber: integer("ticket_number"),
    priority: text("priority").notNull().default("normal"), // low | normal | high | urgent
    category: text("category"),
    slaDueAt: timestamp("sla_due_at", { withTimezone: true }),
    createdByActorType: text("created_by_actor_type").notNull(),
    createdByActorId: uuid("created_by_actor_id"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("support_conv_org_status_idx").on(t.orgId, t.status),
    index("support_conv_customer_idx").on(t.orgId, t.customerId),
  ],
);

/**
 * Thread entries. Provenance is explicit: customer | staff | agent | system.
 * Agent-authored replies keep the releasing staff user on sender_user_id so
 * every AI-sent word traces to the human who approved it.
 */
export const supportMessages = pgTable(
  "support_messages",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => supportConversations.id, { onDelete: "cascade" }),
    senderType: text("sender_type").notNull(), // customer | staff | agent | system
    senderUserId: uuid("sender_user_id").references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("support_msg_conversation_idx").on(t.conversationId, t.createdAt)],
);


// ── Multi-currency (ADR 0021 phases 2-3) ────────────────────────────────

/** Posted FX facts, never live lookups. 1 quote = num/den base units. */
export const fxRates = pgTable(
  "fx_rates",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    base: text("base").notNull(), // org base currency, e.g. "USD"
    quote: text("quote").notNull(), // foreign currency, e.g. "EUR"
    rateNum: bigint("rate_num", { mode: "number" }).notNull(),
    rateDen: integer("rate_den").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull().defaultNow(),
    source: text("source").notNull().default("manual"), // manual | import
    recordedByActorType: text("recorded_by_actor_type").notNull(),
    recordedByActorId: uuid("recorded_by_actor_id"),
    createdAt: createdAt(),
  },
  (t) => [index("fx_rate_org_pair_idx").on(t.orgId, t.base, t.quote, t.effectiveAt)],
);

/**
 * Links the two entries that settle one foreign-currency invoice: a
 * base-currency cash/clearing/gain-loss entry and a foreign-currency
 * clearing/AR entry. Realized gain or loss rides inside the base entry.
 */
export const fxSettlements = pgTable(
  "fx_settlements",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "restrict" }),
    currency: text("currency").notNull(),
    settledForeignMinor: integer("settled_foreign_minor").notNull(),
    baseSettledMinor: integer("base_settled_minor").notNull(),
    gainLossMinor: integer("gain_loss_minor").notNull(),
    settleRateNum: bigint("settle_rate_num", { mode: "number" }).notNull(),
    settleRateDen: integer("settle_rate_den").notNull(),
    baseEntryId: uuid("base_entry_id").notNull(),
    foreignEntryId: uuid("foreign_entry_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("fx_settlement_org_idx").on(t.orgId, t.currency)],
);


// ── Functional gap batch: quotes, recurring billing, timesheets,
//    expense claims, customer portal shares, in-app notifications ──

/** Sales quotes; accepting one converts it into an invoice verbatim. */
export const quotes = pgTable(
  "quotes",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    number: integer("number").notNull(),
    status: text("status").notNull().default("draft"), // draft | sent | accepted | declined | expired
    currency: text("currency").notNull().default("USD"),
    subtotalMinor: integer("subtotal_minor").notNull(),
    taxMinor: integer("tax_minor").notNull(),
    totalMinor: integer("total_minor").notNull(),
    memo: text("memo"),
    convertedInvoiceId: uuid("converted_invoice_id").references(() => invoices.id, { onDelete: "set null" }),
    /** Past this instant the quote can no longer be accepted (M9). */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdByActorType: text("created_by_actor_type").notNull(),
    createdByActorId: uuid("created_by_actor_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("quote_org_number_idx").on(t.orgId, t.number)],
);

export const quoteLines = pgTable("quote_lines", {
  id: id(),
  quoteId: uuid("quote_id")
    .notNull()
    .references(() => quotes.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  quantity: integer("quantity").notNull(), // thousandths
  unitPriceMinor: integer("unit_price_minor").notNull(),
  taxMinor: integer("tax_minor").notNull().default(0),
});

/**
 * Subscription-style invoicing templates. The durable worker expands due
 * templates into real invoices through the governed path, then advances
 * next_run_at — never posting directly.
 */
export const recurringInvoices = pgTable(
  "recurring_invoices",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    memo: text("memo"),
    frequency: text("frequency").notNull(), // weekly | monthly | quarterly
    /** Frozen price book: [{description, quantity, unitPriceMinor, taxMinor}]. */
    lines: jsonb("lines").notNull(),
    active: boolean("active").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdByActorType: text("created_by_actor_type").notNull(),
    createdByActorId: uuid("created_by_actor_id"),
    createdAt: createdAt(),
  },
  (t) => [index("recurring_due_idx").on(t.orgId, t.active, t.nextRunAt)],
);

/** Employee timesheets: submitted minutes, supervisor-approved. */
export const timeEntries = pgTable(
  "time_entries",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    workDate: timestamp("work_date", { withTimezone: true }).notNull(),
    minutes: integer("minutes").notNull(), // positive, capped at 24h
    /** Attendance (M11): clock-in/out pair; late = checked in after 09:00. */
    clockedInAt: timestamp("clocked_in_at", { withTimezone: true }),
    clockedOutAt: timestamp("clocked_out_at", { withTimezone: true }),
    late: boolean("late").notNull().default(false),
    note: text("note"),
    status: text("status").notNull().default("submitted"), // submitted | approved | rejected
    decidedByActorType: text("decided_by_actor_type"),
    decidedByActorId: uuid("decided_by_actor_id"),
    createdAt: createdAt(),
  },
  (t) => [index("time_entry_org_employee_idx").on(t.orgId, t.employeeId, t.workDate)],
);

/** Employee expense claims; approval gates the reimbursing payment. */
export const expenseClaims = pgTable(
  "expense_claims",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    claimantUserId: uuid("claimant_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull().default("USD"),
    memo: text("memo").notNull(),
    /** GL account to charge on reimbursement (defaults to 6000 series). */
    accountCode: text("account_code"),
    /** Rules-first suggested or human-chosen category (M11). */
    category: text("category").notNull().default("other"),
    /** Receipt attached through the documents seam (M11); degrades without Documents. */
    documentId: uuid("document_id"),
    status: text("status").notNull().default("submitted"), // submitted | approved | rejected | paid
    decidedByActorType: text("decided_by_actor_type"),
    decidedByActorId: uuid("decided_by_actor_id"),
    decisionReason: text("decision_reason"),
    paymentEntryId: uuid("payment_entry_id"),
    createdAt: createdAt(),
  },
  (t) => [index("expense_claim_org_status_idx").on(t.orgId, t.status)],
);

/** Public read-only invoice links for the customer portal (revocable). */
export const invoiceShares = pgTable(
  "invoice_shares",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdByActorType: text("created_by_actor_type").notNull(),
    createdByActorId: uuid("created_by_actor_id"),
    createdAt: createdAt(),
  },
  (t) => [index("invoice_share_invoice_idx").on(t.invoiceId)],
);

/** In-app notification feed; mirrors the NotificationSink events. */
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Null = broadcast to everyone in the org. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // approval.requested | ticket.filed | system
    title: text("title").notNull(),
    body: text("body"),
    href: text("href"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("notification_org_unread_idx").on(t.orgId, t.userId, t.readAt, t.createdAt)],
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
  // better-auth ≥1.7 stamps the credential issuer (e.g. "better-auth") on
  // every account row; missing column breaks all credential sign-ups.
  issuer: text("issuer"),
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

/**
 * Routines (Paperclip-style recurring execution layer): a named agent task
 * with a natural-language schedule, run by the worker when due, triggerable
 * manually, or triggerable via a per-routine webhook token (so external
 * orchestrators like Paperclip can fire Chaste agent runs). A routine never
 * acts by itself: each run goes through the governed executor as a system
 * actor scoped to a least-privilege permission bundle.
 */
export const routines = pgTable(
  "routines",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** What the agent should do on each run; natural language, bounded. */
    prompt: text("prompt").notNull(),
    /** The user's original scheduling words, kept verbatim for the UI. */
    scheduleText: text("schedule_text"),
    /** Structured schedule the scheduler actually executes (erp-core). */
    schedule: jsonb("schedule").notNull(),
    triggerType: text("trigger_type").notNull().default("schedule"), // schedule | webhook | manual
    /** Secret path segment for webhook triggers; null = webhook disabled. */
    webhookToken: text("webhook_token"),
    enabled: boolean("enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastStatus: text("last_status"), // ok | failed | running
    lastError: text("last_error"),
    createdByActorType: text("created_by_actor_type").notNull().default("user"),
    createdByActorId: uuid("created_by_actor_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("routine_due_idx").on(t.orgId, t.enabled, t.nextRunAt),
    index("routine_webhook_token_idx").on(t.webhookToken),
  ],
);

/**
 * Durable Postgres-backed job queue. Jobs carry a capability id + input and
 * are executed through the governed path by the worker, so asynchronous work
 * obeys the same validation, permission, and audit pipeline as everything
 * else. Claiming uses FOR UPDATE SKIP LOCKED, so multiple workers are safe.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // capability id, e.g. "documents.parseDocument"
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"), // pending | processing | done | failed
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lastError: text("last_error"),
    createdByActorType: text("created_by_actor_type").notNull().default("system"),
    createdByActorId: uuid("created_by_actor_id"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("job_status_idx").on(t.status, t.createdAt), index("job_org_idx").on(t.orgId)],
);

// ── Banking (feeds & reconciliation) ────────────────────────────────────

/**
 * External bank accounts mirrored for reconciliation. balanceMinor is the
 * statement-side balance, not a ledger figure — the GL stays authoritative;
 * this column only feeds the "does the bank agree with the books" check.
 */
export const bankAccounts = pgTable(
  "bank_accounts",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    currencyCode: text("currency_code").notNull().default("USD"),
    last4: text("last4"),
    balanceMinor: bigint("balance_minor", { mode: "number" }).notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("bank_account_org_idx").on(t.orgId, t.name)],
);

/**
 * Statement lines from an imported feed. A row starts unmatched and leaves
 * unmatched only by being matched (linked to a payment or journal entry) or
 * excluded (declared not-a-business-transaction). Both are state changes on
 * the row; the raw line is never rewritten, so re-imports stay idempotent.
 */
export const bankTransactions = pgTable(
  "bank_transactions",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id, { onDelete: "cascade" }),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    /** Signed: positive = money in, negative = money out (bank convention). */
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    description: text("description").notNull(),
    status: text("status").notNull().default("unmatched"), // unmatched | matched | excluded
    matchedPaymentId: uuid("matched_payment_id").references(() => payments.id, { onDelete: "set null" }),
    matchedEntryId: uuid("matched_entry_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("bank_tx_org_account_posted_idx").on(t.orgId, t.bankAccountId, t.postedAt),
    index("bank_tx_org_status_idx").on(t.orgId, t.status),
  ],
);

/**
 * Filed sales-tax returns. One filing per period window: the overlap guard
 * on these rows is what stops double-remitting the same tax to the
 * authority, so it lives in data, not in anyone's memory.
 */
export const salesTaxFilings = pgTable(
  "sales_tax_filings",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    periodFrom: timestamp("period_from", { withTimezone: true }).notNull(),
    periodTo: timestamp("period_to", { withTimezone: true }).notNull(),
    taxMinor: bigint("tax_minor", { mode: "number" }).notNull(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => journalEntries.id, { onDelete: "restrict" }),
    filedByActorType: text("filed_by_actor_type").notNull(),
    filedByActorId: uuid("filed_by_actor_id"),
    createdAt: createdAt(),
  },
  (t) => [index("sales_tax_filing_org_idx").on(t.orgId, t.periodFrom)],
);


/**
 * Customer-care channel configuration: how the embeddable website widget
 * behaves. One row per org; the embed token is what a marketing site script
 * carries, so it must be revocable without touching anything else.
 */
export const supportSettings = pgTable(
  "support_settings",
  {
    orgId: uuid("org_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** 192-bit token embedded in the customer's website snippet. */
    embedToken: text("embed_token").notNull(),
    autoReplyEnabled: boolean("auto_reply_enabled").notNull().default(true),
    greeting: text("greeting")
      .notNull()
      .default("Hi — ask us anything and we'll get right back to you."),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("support_settings_token_idx").on(t.embedToken)],
);

// ── Helpdesk depth (M12) ────────────────────────────────────────────────

export const supportCannedResponses = pgTable(
  "support_canned_responses",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    shortcut: text("shortcut").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("support_canned_org_shortcut_idx").on(t.orgId, t.shortcut)],
);

export const supportKbArticles = pgTable(
  "support_kb_articles",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    category: text("category"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("support_kb_org_idx").on(t.orgId)],
);

// ── Marketing-lite (M13): saved filters, campaigns, honest send log ─────

export const marketingSegments = pgTable(
  "marketing_segments",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Deterministic filter: min lifetime spend in minor units. */
    minSpendMinor: integer("min_spend_minor").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("marketing_segment_org_idx").on(t.orgId)],
);

export const marketingCampaigns = pgTable(
  "marketing_campaigns",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    segmentId: uuid("segment_id")
      .notNull()
      .references(() => marketingSegments.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("marketing_campaign_org_idx").on(t.orgId)],
);

/** Append-only delivery log — the analytics ARE this table. */
export const marketingSends = pgTable(
  "marketing_sends",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => marketingCampaigns.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("marketing_send_unique_idx").on(t.campaignId, t.customerId)],
);
