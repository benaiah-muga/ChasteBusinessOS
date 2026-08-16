import type { AuditEntry, AuditWriter, DomainEvent, OutboxWriter } from "@chaste/kernel";
import { eq, and, desc, sql, inArray, or } from "drizzle-orm";
import type { Db } from "./client.js";
import * as schema from "./schema.js";

export class PostgresAuditWriter implements AuditWriter {
  constructor(private readonly db: Db) {}

  async write(entry: AuditEntry): Promise<void> {
    await this.db.insert(schema.auditLog).values({
      id: entry.id,
      at: new Date(entry.at),
      organizationId: entry.organizationId,
      actorUserId: entry.actorUserId,
      actorKind: entry.actorKind,
      aiRunId: entry.aiRunId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      success: entry.success,
      requestId: entry.requestId,
      inputSummary: entry.inputSummary as object | undefined,
      errorCode: entry.errorCode,
      errorMessage: entry.errorMessage,
      origin: entry.origin,
      reason: entry.reason,
      evidenceRefs: entry.evidenceRefs as object[] | undefined,
      approvalGrantId: entry.approvalGrantId,
      policyContext: entry.policyContext as Record<string, unknown> | undefined,
      idempotencyKey: entry.idempotencyKey,
      correlationId: entry.correlationId,
      causationId: entry.causationId,
    });
  }

  async list(organizationId: string, limit = 100) {
    return this.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.organizationId, organizationId))
      .orderBy(desc(schema.auditLog.at))
      .limit(limit);
  }
}

export interface MarkFailedOptions {
  maxRetries?: number;
  backoffMs?: number;
  errorCode?: string;
}

export class PostgresOutboxWriter implements OutboxWriter {
  constructor(private readonly db: Db) {}

  async enqueue(event: DomainEvent): Promise<void> {
    await this.db.insert(schema.outboxEvents).values({
      id: event.id,
      type: event.type,
      organizationId: event.organizationId,
      occurredAt: new Date(event.occurredAt),
      payload: event.payload as object,
      correlationId: event.correlationId,
      causationId: event.causationId,
    });
  }

  /**
   * ARCH-9/REL-2 — claim a batch of unprocessed, un-dead-lettered events whose
   * `next_attempt_at` has passed, using `FOR UPDATE SKIP LOCKED` so concurrent
   * workers never claim the same rows. A row is eligible for re-claim after its
   * lease (`leaseMs`) expires, which covers a crashed worker mid-processing.
   */
  async claimUnprocessed(limit = 50, leaseMs = 60_000) {
    const leaseSecs = Math.max(1, Math.floor(leaseMs / 1000));
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.outboxEvents)
        .where(
          and(
            sql`${schema.outboxEvents.processedAt} IS NULL`,
            sql`${schema.outboxEvents.deadLetteredAt} IS NULL`,
            sql`${schema.outboxEvents.nextAttemptAt} <= now()`,
            or(
              sql`${schema.outboxEvents.claimedAt} IS NULL`,
              sql`${schema.outboxEvents.claimedAt} < now() - (${leaseSecs} * interval '1 second')`,
            ),
          ),
        )
        .orderBy(schema.outboxEvents.occurredAt)
        .limit(limit)
        .for("update", { skipLocked: true });
      if (rows.length === 0) return rows;
      await tx
        .update(schema.outboxEvents)
        .set({ claimedAt: new Date() })
        .where(
          inArray(
            schema.outboxEvents.id,
            rows.map((r) => r.id),
          ),
        );
      return rows;
    });
  }

  async markProcessed(id: string) {
    await this.db
      .update(schema.outboxEvents)
      .set({ processedAt: new Date(), claimedAt: null, lastError: null })
      .where(eq(schema.outboxEvents.id, id));
  }

  /**
   * Record a failed execution: bump `attempts`, write `last_error`, release the
   * claim, and schedule the next attempt with `backoffMs`. Once `attempts`
   * reaches `maxRetries`, the event is copied to `dead_letter_events` (append-
   * only) and the outbox row is marked dead so it is never retried again.
   */
  async markFailed(id: string, error: unknown, opts: MarkFailedOptions = {}) {
    const { maxRetries = 3, backoffMs = 10_000, errorCode } = opts;
    const message = error instanceof Error ? error.message : String(error);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.outboxEvents)
        .where(eq(schema.outboxEvents.id, id))
        .limit(1);
      if (!row) return { deadLettered: false, attempts: 0 };
      const attempts = row.attempts + 1;
      const deadLettered = attempts >= maxRetries;
      await tx
        .update(schema.outboxEvents)
        .set({
          attempts,
          lastError: message,
          claimedAt: null,
          nextAttemptAt: deadLettered ? row.nextAttemptAt : new Date(Date.now() + backoffMs),
          deadLetteredAt: deadLettered ? new Date() : null,
        })
        .where(eq(schema.outboxEvents.id, id));
      if (deadLettered) {
        await tx.insert(schema.deadLetterEvents).values({
          id: row.id,
          type: row.type,
          organizationId: row.organizationId,
          occurredAt: row.occurredAt,
          payload: row.payload as object,
          correlationId: row.correlationId,
          causationId: row.causationId,
          attempts,
          lastError: message,
          errorCode,
        });
      }
      return { deadLettered, attempts };
    });
  }
}

export async function listDeadLetterEvents(db: Db, organizationId: string, limit = 100) {
  return db
    .select()
    .from(schema.deadLetterEvents)
    .where(eq(schema.deadLetterEvents.organizationId, organizationId))
    .orderBy(desc(schema.deadLetterEvents.deadLetteredAt))
    .limit(limit);
}

/**
 * ARCH-9/REL-2 — return dead-lettered events to the outbox so they are retried.
 * Scoped to `organizationId`; rows already replayed are skipped. `replayed_at`
 * is stamped on the DLQ row to preserve the replay audit trail.
 */
export async function replayDeadLetterEvents(
  db: Db,
  organizationId: string,
  eventIds: string[],
): Promise<number> {
  if (eventIds.length === 0) return 0;
  return db.transaction(async (tx) => {
    const dead = await tx
      .select()
      .from(schema.deadLetterEvents)
      .where(
        and(
          eq(schema.deadLetterEvents.organizationId, organizationId),
          inArray(schema.deadLetterEvents.id, eventIds),
          sql`${schema.deadLetterEvents.replayedAt} IS NULL`,
        ),
      );
    if (dead.length === 0) return 0;
    const deadIds = dead.map((d) => d.id);
    await tx
      .update(schema.deadLetterEvents)
      .set({ replayedAt: new Date() })
      .where(
        and(
          eq(schema.deadLetterEvents.organizationId, organizationId),
          inArray(schema.deadLetterEvents.id, deadIds),
        ),
      );
    for (const d of dead) {
      await tx
        .update(schema.outboxEvents)
        .set({
          attempts: 0,
          lastError: null,
          claimedAt: null,
          nextAttemptAt: new Date(),
          deadLetteredAt: null,
        })
        .where(eq(schema.outboxEvents.id, d.id));
    }
    return dead.length;
  });
}

export async function usersWithPermission(db: Db, organizationId: string, permission: string) {
  return db
    .selectDistinct({
      userId: schema.users.id,
      email: schema.users.email,
      displayName: schema.users.displayName,
    })
    .from(schema.rolePermissions)
    .innerJoin(schema.roles, eq(schema.rolePermissions.roleId, schema.roles.id))
    .innerJoin(schema.userRoles, eq(schema.rolePermissions.roleId, schema.userRoles.roleId))
    .innerJoin(schema.users, eq(schema.userRoles.userId, schema.users.id))
    .where(
      and(
        eq(schema.roles.organizationId, organizationId),
        eq(schema.rolePermissions.permission, permission),
      ),
    );
}

export async function resolveUserPermissions(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ permission: schema.rolePermissions.permission })
    .from(schema.userRoles)
    .innerJoin(schema.rolePermissions, eq(schema.userRoles.roleId, schema.rolePermissions.roleId))
    .where(eq(schema.userRoles.userId, userId));

  const set = new Set(rows.map((r) => r.permission));
  return [...set];
}

export async function getUserWithOrg(db: Db, userId: string) {
  const [row] = await db
    .select({
      userId: schema.users.id,
      email: schema.users.email,
      displayName: schema.users.displayName,
      organizationId: schema.users.organizationId,
      isActive: schema.users.isActive,
      autonomy: schema.organizations.autonomy,
      orgName: schema.organizations.name,
      region: schema.organizations.region,
      fullAutonomousAcknowledgedAt: schema.organizations.fullAutonomousAcknowledgedAt,
    })
    .from(schema.users)
    .innerJoin(schema.organizations, eq(schema.users.organizationId, schema.organizations.id))
    .where(eq(schema.users.id, userId))
    .limit(1);
  return row;
}

export async function getUserByEmail(db: Db, organizationId: string, email: string) {
  const [row] = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.organizationId, organizationId), eq(schema.users.email, email)))
    .limit(1);
  return row;
}
