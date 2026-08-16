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
    /** F5 — bearer tokens now expire. Null = never expires (bootstrap admin). */
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    activeBranchId: uuid("active_branch_id"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_org_email_uidx").on(t.organizationId, t.email),
    uniqueIndex("users_auth_token_uidx").on(t.authToken),
  ],
);

export const businessPartners = pgTable(
  "business_partners",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** What the partner IS: an individual or a company. */
    type: text("type").notNull().default("person"), // "person" | "organization"
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    city: text("city"),
    country: text("country"),
    notes: text("notes"),
    /** Lifecycle: active | archived. Archived hides from default lists. */
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("business_partners_org_idx").on(t.organizationId),
    index("business_partners_org_type_idx").on(t.organizationId, t.type),
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
    /** ADR 0014 — command-envelope provenance (AI/manual parity). */
    origin: text("origin"),
    reason: text("reason"),
    evidenceRefs: jsonb("evidence_refs").$type<unknown[]>(),
    approvalGrantId: text("approval_grant_id"),
    policyContext: jsonb("policy_context").$type<Record<string, unknown>>(),
    idempotencyKey: text("idempotency_key"),
    correlationId: text("correlation_id"),
    causationId: text("causation_id"),
  },
  (t) => [
    index("audit_log_org_idx").on(t.organizationId),
    index("audit_log_origin_idx").on(t.origin),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    organizationId: uuid("organization_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload").notNull(),
    correlationId: text("correlation_id"),
    causationId: text("causation_id"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    /**
     * ARCH-9/REL-2 — durable delivery accounting. `attempts` counts failed
     * executions; `last_error` records the most recent failure. `claimed_at`
     * is the claim lease (set on claim, cleared on ack) so a crashed worker's
     * row is reclaimed after the lease window. `next_attempt_at` gates retry
     * backoff. `dead_lettered_at` marks rows routed to `dead_letter_events`.
     */
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
  },
  (t) => [index("outbox_events_pending_idx").on(t.organizationId, t.occurredAt)],
);

/**
 * ARCH-9/REL-2 — dead-letter outbox. Append-only record of events that
 * exhausted their retries. `replayed_at` marks rows returned to the outbox by
 * `core.outbox.replay` so the DLQ keeps an audit trail of the replay.
 */
export const deadLetterEvents = pgTable(
  "dead_letter_events",
  {
    id: uuid("id").primaryKey(),
    type: text("type").notNull(),
    organizationId: uuid("organization_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    payload: jsonb("payload").notNull(),
    correlationId: text("correlation_id"),
    causationId: text("causation_id"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    errorCode: text("error_code"),
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }).notNull().defaultNow(),
    replayedAt: timestamp("replayed_at", { withTimezone: true }),
  },
  (t) => [index("dead_letter_events_org_idx").on(t.organizationId)],
);

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

/* ─── Branches ───────────────────────────────────────────────── */

export const branches = pgTable(
  "branches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    code: text("code").notNull(),
    timezone: text("timezone"),
    parentBranchId: uuid("parent_branch_id"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("branches_org_code_uidx").on(t.organizationId, t.code),
    index("branches_org_idx").on(t.organizationId),
  ],
);

export const userBranchAccess = pgTable(
  "user_branch_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("user_branch_access_uidx").on(t.userId, t.branchId)],
);

/**
 * API keys — org-scoped machine credentials with their own permission scopes.
 *
 * Keys are a distinct identity class from user bearer tokens: they are owned by
 * an organization (created by a user), exercise only the declared `scopes`
 * (a subset of the permission catalog), and are independently revocable /
 * rotatable / expirable. The raw secret is returned exactly once at creation;
 * the column only ever stores the SHA-256 digest (see `hashApiKeySecret`).
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    description: text("description"),
    /** SHA-256 digest of the raw secret — never the raw value. */
    hashedSecret: text("hashed_secret").notNull(),
    /** Display-only prefix (e.g. `chaste_ab12…`) — not a usable credential. */
    prefix: text("prefix").notNull(),
    /** Permission strings the key may exercise (subset of PERMISSION_CATALOG). */
    scopes: text("scopes").array().notNull().default([]),
    /** "active" | "revoked" */
    status: text("status").notNull().default("active"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("api_keys_secret_uidx").on(t.hashedSecret)],
);

export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    title: text("title"),
    activeBranchId: uuid("active_branch_id"),
    pending: jsonb("pending").$type<{
      id: string;
      createdAt: string;
      [key: string]: unknown;
    } | null>(),
    /** R3 — unattended sessions park approvals in the cross-session Inbox queue instead of inline. */
    unattended: boolean("unattended").notNull().default(false),
    /** R6 — outbound compaction boundary + summary + mechanical working state (JSONB). */
    compactionState: jsonb("compaction_state").$type<unknown | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("chat_sess_org_idx").on(t.organizationId),
    index("chat_sess_user_idx").on(t.userId),
    index("chat_sess_updated_idx").on(t.updatedAt),
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

export const chatFeedback = pgTable(
  "chat_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    rating: text("rating").notNull(), // "up" | "down"
    comment: text("comment"),
    runId: text("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("chat_feedback_sess_idx").on(t.sessionId),
    uniqueIndex("chat_feedback_msg_user_uidx").on(t.sessionId, t.messageId, t.userId),
  ],
);

export const capabilityGapTickets = pgTable(
  "capability_gap_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    status: text("status").notNull().default("draft"),
    proposedCapabilityId: text("proposed_capability_id").notNull(),
    title: text("title").notNull(),
    abstractRequirement: text("abstract_requirement").notNull(),
    acceptanceCriteria: jsonb("acceptance_criteria").$type<string[]>().notNull().default([]),
    exampleScenarios: jsonb("example_scenarios").$type<string[]>().notNull().default([]),
    suggestedModuleId: text("suggested_module_id"),
    nonGoals: jsonb("non_goals").$type<string[]>().notNull().default([]),
    deploymentTarget: text("deployment_target").notNull().default("undecided"),
    codingAgent: text("coding_agent"),
    artifactRef: text("artifact_ref"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("gap_tickets_org_idx").on(t.organizationId),
    index("gap_tickets_status_idx").on(t.status),
  ],
);

/**
 * S0 — machine-readable capability catalog (spec: self-development.md §6).
 * Product-level knowledge of what the platform + registered modules can do,
 * searched by the operations agent before falling back to gap tickets.
 */
export const capabilityCatalogItems = pgTable(
  "capability_catalog_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    moduleId: text("module_id").notNull(),
    capabilityId: text("capability_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    keywords: jsonb("keywords").$type<string[]>().notNull().default([]),
    implemented: boolean("implemented").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("capability_catalog_module_cap_uidx").on(t.moduleId, t.capabilityId),
    index("capability_catalog_cap_idx").on(t.capabilityId),
  ],
);

/** C2 — user reminders. Fired by the schedule processor into in-app notifications. */
export const reminders = pgTable(
  "reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    createdBy: uuid("created_by").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    href: text("href"),
    fireAt: timestamp("fire_at", { withTimezone: true }).notNull(),
    channel: text("channel").notNull().default("in_app"),
    status: text("status").notNull().default("scheduled"),
    branchId: uuid("branch_id"),
    firedAt: timestamp("fired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("reminders_due_idx").on(t.status, t.fireAt),
    index("reminders_user_idx").on(t.userId),
    index("reminders_org_idx").on(t.organizationId),
  ],
);

/** C5 — durable agent follow-ups that re-enter the harness at fire time. */
export const followUps = pgTable(
  "follow_ups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    createdBy: uuid("created_by").notNull(),
    goal: text("goal").notNull(),
    fireAt: timestamp("fire_at", { withTimezone: true }).notNull(),
    sessionId: uuid("session_id"),
    branchId: uuid("branch_id"),
    autonomyOverride: text("autonomy_override"),
    status: text("status").notNull().default("scheduled"),
    firedAt: timestamp("fired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("follow_ups_due_idx").on(t.status, t.fireAt),
    index("follow_ups_user_idx").on(t.userId),
    index("follow_ups_org_idx").on(t.organizationId),
  ],
);

/** C3 — calendars (org | user | branch-scoped). */
export const calendars = pgTable(
  "calendars",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    scope: text("scope").notNull().default("org"),
    name: text("name").notNull(),
    ownerUserId: uuid("owner_user_id"),
    branchId: uuid("branch_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("calendars_org_idx").on(t.organizationId),
    index("calendars_owner_idx").on(t.ownerUserId),
  ],
);

/** C3 — calendar events shared by humans and agents. Stored UTC + zone. */
export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    calendarId: uuid("calendar_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    branchId: uuid("branch_id"),
    attendees: jsonb("attendees").$type<string[]>().notNull().default([]),
    linkedResources: jsonb("linked_resources")
      .$type<Array<{ type: string; id: string }>>()
      .notNull()
      .default([]),
    status: text("status").notNull().default("scheduled"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("calendar_events_org_idx").on(t.organizationId),
    index("calendar_events_calendar_idx").on(t.calendarId),
    index("calendar_events_range_idx").on(t.organizationId, t.startsAt, t.endsAt),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    kind: text("kind").notNull().default("info"),
    title: text("title").notNull(),
    body: text("body"),
    href: text("href"),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("notifications_user_idx").on(t.userId),
    index("notifications_org_idx").on(t.organizationId),
  ],
);

/** C6 — outbound email delivery records. Idempotent via provider message ids. */
export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    to: text("to").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    template: text("template"),
    status: text("status").notNull().default("queued"),
    provider: text("provider"),
    providerMessageId: text("provider_message_id"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    index("email_outbox_status_idx").on(t.status),
    index("email_outbox_org_idx").on(t.organizationId),
  ],
);

/* ─── Backup / export / restore (spec: backup-and-deploy.md) ──────── */

/**
 * Org-scoped backup job records. The payload (a versioned JSON manifest,
 * AES-256-GCM encrypted) lives in the configured object store; this table is
 * the job ledger used by the worker for idempotent delivery, like email_outbox.
 */
export const backups = pgTable(
  "backups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    status: text("status").notNull().default("queued"), // queued | running | success | failed
    provider: text("provider"),
    storageKey: text("storage_key"),
    sizeBytes: integer("size_bytes"),
    checksum: text("checksum"),
    createdBy: uuid("created_by"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("backups_org_idx").on(t.organizationId), index("backups_status_idx").on(t.status)],
);

/* ─── Messaging (spec: messaging-and-buzz.md) ─────────────────────── */

/** A conversation: `direct` (two members) or `group`. */
export const msgThreads = pgTable(
  "msg_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    type: text("type").notNull().default("direct"), // direct | group
    name: text("name"),
    createdBy: uuid("created_by").notNull(),
    isArchived: boolean("is_archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("msg_threads_org_idx").on(t.organizationId),
    index("msg_threads_member_updated_idx").on(t.organizationId, t.updatedAt),
  ],
);

export const msgThreadMembers = pgTable(
  "msg_thread_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => msgThreads.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    role: text("role").notNull().default("member"), // member | admin
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("msg_thread_members_uidx").on(t.threadId, t.userId),
    index("msg_thread_members_user_idx").on(t.userId),
  ],
);

export const msgMessages = pgTable(
  "msg_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => msgThreads.id, { onDelete: "cascade" }),
    senderId: uuid("sender_id").notNull(),
    kind: text("kind").notNull().default("text"), // text | system
    body: text("body").notNull(),
    parentId: uuid("parent_id"),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("msg_messages_thread_created_idx").on(t.threadId, t.createdAt),
    index("msg_messages_org_idx").on(t.organizationId),
  ],
);

/** Per-member read cursor for unread counts. */
export const msgReads = pgTable(
  "msg_reads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => msgThreads.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    lastReadMessageId: uuid("last_read_message_id"),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("msg_reads_uidx").on(t.threadId, t.userId)],
);

/* ─── AI runtime stores (OpenWorker-benchmark primitives, R2/R5/R7/R10) ─── */

/**
 * R2 — the canonical human-attention queue. Mirrors `InboxItem` from
 * `@chaste/kernel` so a Postgres-backed InboxStore can be layered on top later;
 * today the runtime uses the in-memory kernel store and this is the durable
 * schema that schema-first flows will target.
 */
export const pendingApprovals = pgTable(
  "pending_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    kind: text("kind").notNull(), // approval | question | notification | plan
    title: text("title").notNull(),
    body: text("body"),
    state: text("state").notNull().default("pending"),
    resolution: text("resolution"),
    inbox: text("inbox").notNull().default("default"),
    visibility: text("visibility").notNull().default("inline"), // inline | inbox
    toolCallId: text("tool_call_id"),
    options: jsonb("options").$type<string[]>().default([]),
    allowText: boolean("allow_text").notNull().default(true),
    multi: boolean("multi").notNull().default(false),
    data: jsonb("data").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("pending_approvals_session_idx").on(t.sessionId),
    index("pending_approvals_org_state_idx").on(t.organizationId, t.state),
    index("pending_approvals_toolcall_uidx").on(t.sessionId, t.toolCallId),
  ],
);

/** R5 — durable self-wake records consumed by the worker tick to re-enter a session. */
export const aiWakes = pgTable(
  "ai_wakes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull(),
    taskId: uuid("task_id"),
    proactiveText: text("proactive_text"),
    kind: text("kind").notNull(), // timer | completion | event
    state: text("state").notNull().default("pending"), // pending | due | fired
    fireAt: timestamp("fire_at", { withTimezone: true }),
    jobId: text("job_id"),
    eventKey: text("event_key"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_wakes_due_idx").on(t.state, t.fireAt),
    index("ai_wakes_session_idx").on(t.sessionId),
    index("ai_wakes_job_idx").on(t.jobId),
    index("ai_wakes_event_idx").on(t.eventKey),
  ],
);

/** R7 — org/platform skill catalog exposed to the AI (progressive disclosure). */
export const aiSkills = pgTable(
  "ai_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").notNull().default("organization"), // platform | organization
    organizationId: uuid("organization_id"),
    branchId: uuid("branch_id"),
    name: text("name").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    instructions: text("instructions").notNull(),
    files: jsonb("files").$type<unknown[]>().default([]),
    refinements: jsonb("refinements").$type<unknown[]>().default([]),
    enabled: boolean("enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ai_skills_name_scope_uidx").on(t.name, t.organizationId, t.branchId),
    index("ai_skills_org_idx").on(t.organizationId),
  ],
);

/** R10 — inbound channel → session ownership (Slack/Telegram/WhatsApp mentions). */
export const channelSessionBindings = pgTable(
  "channel_session_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadTarget: text("thread_target").notNull(), // "platform:chatId:threadTs"
    sessionId: uuid("session_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    branchId: uuid("branch_id"),
    channel: text("channel").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("channel_bindings_target_uidx").on(t.threadTarget),
    index("channel_bindings_session_idx").on(t.sessionId),
    index("channel_bindings_org_idx").on(t.organizationId),
  ],
);

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
    businessPartnerId: uuid("business_partner_id").references(() => businessPartners.id),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("crm_customers_org_idx").on(t.organizationId)],
);

export const crmContacts = pgTable(
  "crm_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => crmCustomers.id, { onDelete: "cascade" }),
    businessPartnerId: uuid("business_partner_id").references(() => businessPartners.id),
    name: text("name").notNull(),
    role: text("role"),
    email: text("email"),
    phone: text("phone"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("crm_contacts_org_idx").on(t.organizationId),
    index("crm_contacts_customer_idx").on(t.customerId),
  ],
);

export const crmInteractions = pgTable(
  "crm_interactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => crmCustomers.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("note"),
    summary: text("summary").notNull(),
    detail: text("detail"),
    actorUserId: uuid("actor_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("crm_interactions_org_idx").on(t.organizationId),
    index("crm_interactions_customer_idx").on(t.customerId),
  ],
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
    businessPartnerId: uuid("business_partner_id").references(() => businessPartners.id),
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
    businessPartnerId: uuid("business_partner_id").references(() => businessPartners.id),
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

/* ─── ADR 0014 — agent trajectory + context engine ────────────────── */

/**
 * Append-only agent trajectory log. One row per AgentSessionEvent; `seq`
 * preserves append order for faithful replay.
 */
export const agentSessionEvents = pgTable(
  "agent_session_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    seq: integer("seq").generatedAlwaysAsIdentity(),
    type: text("type").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload").$type<unknown>().notNull().default({}),
  },
  (t) => [
    index("agent_session_events_session_idx").on(t.sessionId, t.seq),
    index("agent_session_events_org_type_idx").on(t.organizationId, t.type),
  ],
);

/** Versioned context bundle backing the model-visible reconstruction invariant. */
export const contextBundles = pgTable(
  "context_bundles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    turn: integer("turn").notNull().default(0),
    modelRoute: text("model_route").notNull(),
    tokenBudget: jsonb("token_budget").$type<unknown>().notNull().default({}),
    evidence: jsonb("evidence").$type<unknown[]>().notNull().default([]),
    redactions: jsonb("redactions").$type<unknown[]>().notNull().default([]),
    omitted: jsonb("omitted").$type<unknown[]>().notNull().default([]),
    summariesUsed: jsonb("summaries_used").$type<unknown[]>().notNull().default([]),
    cacheKeys: jsonb("cache_keys").$type<unknown[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("context_bundles_session_idx").on(t.sessionId, t.turn)],
);

export const contextSections = pgTable(
  "context_sections",
  {
    id: text("id").primaryKey(),
    bundleId: uuid("bundle_id")
      .notNull()
      .references(() => contextBundles.id, { onDelete: "cascade" }),
    sectionKey: text("section_key").notNull(),
    tier: integer("tier").notNull(),
    purpose: text("purpose").notNull(),
    source: text("source").notNull(),
    visibility: text("visibility").notNull().default("model"),
    contentRef: text("content_ref"),
    renderedText: text("rendered_text"),
    tokenEstimate: integer("token_estimate").notNull().default(0),
    required: boolean("required").notNull().default(false),
  },
  (t) => [index("context_sections_bundle_idx").on(t.bundleId)],
);

/**
 * ADR 0014 tranche 3 — durable approval grants (research doc §Human
 * Collaboration). A grant is a durable fact — who approved, what exact action,
 * which actor it authorizes, expiry, conditions, policy basis, and evidence
 * shown — not a chat message. Envelope `approvalGrantId` references it; the
 * tool pipeline checks `approval_grants` before re-asking.
 */
export const approvalGrants = pgTable(
  "approval_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    /** User id of the approver (who granted). */
    grantedBy: uuid("granted_by").notNull(),
    /** User id of the actor whose call the grant authorizes. */
    grantedToUserId: uuid("granted_to_user_id").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    scopeCommandType: text("scope_command_type"),
    scopeResourceType: text("scope_resource_type"),
    scopeResourceId: text("scope_resource_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Human-readable thresholds/conditions recorded at grant time. */
    conditions: jsonb("conditions").$type<string[]>().notNull().default([]),
    policyBasis: text("policy_basis"),
    /** Evidence shown to the approver at grant time. */
    evidenceShown: jsonb("evidence_shown").$type<unknown[]>().notNull().default([]),
    status: text("status").notNull().default("active"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
    revokeReason: text("revoke_reason"),
  },
  (t) => [
    index("approval_grants_org_idx").on(t.organizationId),
    index("approval_grants_active_scope_idx").on(t.organizationId, t.status, t.scopeCommandType),
    index("approval_grants_user_idx").on(t.organizationId, t.grantedToUserId),
  ],
);
