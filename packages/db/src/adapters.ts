import type { AuditEntry, AuditWriter, DomainEvent, OutboxWriter } from "@chaste/kernel";
import { eq, and, desc, sql } from "drizzle-orm";
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

  async listUnprocessed(limit = 50) {
    return this.db
      .select()
      .from(schema.outboxEvents)
      .where(sql`${schema.outboxEvents.processedAt} IS NULL`)
      .orderBy(schema.outboxEvents.occurredAt)
      .limit(limit);
  }

  async markProcessed(id: string) {
    await this.db
      .update(schema.outboxEvents)
      .set({ processedAt: new Date() })
      .where(eq(schema.outboxEvents.id, id));
  }
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
