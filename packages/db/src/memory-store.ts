/**
 * Database-backed memory store using the org_memories table.
 * Supports tiered storage (short_term_chat, workflow_session,
 * long_term_org, permanent_business_pointer) with TTL and scoping.
 */
import { eq, and, ilike, isNotNull, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { orgMemories } from "./schema.js";

export interface DbMemoryRecord {
  id: string;
  organizationId: string;
  kind: string;
  key: string | null;
  content: string;
  metadata: Record<string, unknown>;
  userId: string | null;
  sessionId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface DbMemoryWriteInput {
  organizationId: string;
  kind: string;
  key?: string;
  content: string;
  metadata?: Record<string, unknown>;
  userId?: string;
  sessionId?: string;
  expiresAt?: Date;
}

export class DbMemoryStore {
  constructor(private readonly db: Db) {}

  async write(input: DbMemoryWriteInput): Promise<DbMemoryRecord> {
    const now = new Date();
    // Try to find existing record for upsert
    if (input.key) {
      const existing = await this.db
        .select()
        .from(orgMemories)
        .where(
          and(
            eq(orgMemories.organizationId, input.organizationId),
            eq(orgMemories.kind, input.kind),
            eq(orgMemories.key, input.key),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        const updated = await this.db
          .update(orgMemories)
          .set({
            content: input.content,
            metadata: input.metadata ?? {},
            expiresAt: input.expiresAt ?? null,
            createdAt: now,
          })
          .where(eq(orgMemories.id, existing[0]!.id))
          .returning();
        if (updated.length > 0) return this.toRecord(updated[0]!);
      }
    }

    const inserted = await this.db
      .insert(orgMemories)
      .values({
        organizationId: input.organizationId,
        kind: input.kind,
        key: input.key ?? null,
        content: input.content,
        metadata: input.metadata ?? {},
        userId: input.userId ?? null,
        sessionId: input.sessionId ?? null,
        expiresAt: input.expiresAt ?? null,
      })
      .returning();

    return this.toRecord(inserted[0]!);
  }

  async recall(
    organizationId: string,
    kind: string,
    key: string,
  ): Promise<DbMemoryRecord | null> {
    const rows = await this.db
      .select()
      .from(orgMemories)
      .where(
        and(
          eq(orgMemories.organizationId, organizationId),
          eq(orgMemories.kind, kind),
          eq(orgMemories.key, key),
          sql`(${orgMemories.expiresAt} IS NULL OR ${orgMemories.expiresAt} > NOW())`,
        ),
      )
      .limit(1);

    return rows[0] ? this.toRecord(rows[0]) : null;
  }

  async search(
    organizationId: string,
    query: string,
    limit = 10,
  ): Promise<DbMemoryRecord[]> {
    if (!query.trim()) return [];

    const rows = await this.db
      .select()
      .from(orgMemories)
      .where(
        and(
          eq(orgMemories.organizationId, organizationId),
          ilike(orgMemories.content, `%${query}%`),
          sql`(${orgMemories.expiresAt} IS NULL OR ${orgMemories.expiresAt} > NOW())`,
        ),
      )
      .orderBy(sql`${orgMemories.createdAt} DESC`)
      .limit(limit);

    return rows.map((r) => this.toRecord(r));
  }

  async searchByUser(
    organizationId: string,
    userId: string,
    kind?: string,
    limit = 20,
  ): Promise<DbMemoryRecord[]> {
    const conditions = [
      eq(orgMemories.organizationId, organizationId),
      eq(orgMemories.userId, userId),
      sql`(${orgMemories.expiresAt} IS NULL OR ${orgMemories.expiresAt} > NOW())`,
    ];
    if (kind) conditions.push(eq(orgMemories.kind, kind));

    const rows = await this.db
      .select()
      .from(orgMemories)
      .where(and(...conditions))
      .orderBy(sql`${orgMemories.createdAt} DESC`)
      .limit(limit);

    return rows.map((r) => this.toRecord(r));
  }

  async searchBySession(
    sessionId: string,
    limit = 50,
  ): Promise<DbMemoryRecord[]> {
    const rows = await this.db
      .select()
      .from(orgMemories)
      .where(
        and(
          eq(orgMemories.sessionId, sessionId),
          sql`(${orgMemories.expiresAt} IS NULL OR ${orgMemories.expiresAt} > NOW())`,
        ),
      )
      .orderBy(sql`${orgMemories.createdAt} DESC`)
      .limit(limit);

    return rows.map((r) => this.toRecord(r));
  }

  async forget(organizationId: string, kind: string, key: string): Promise<boolean> {
    const deleted = await this.db
      .delete(orgMemories)
      .where(
        and(
          eq(orgMemories.organizationId, organizationId),
          eq(orgMemories.kind, kind),
          eq(orgMemories.key, key),
        ),
      )
      .returning();
    return deleted.length > 0;
  }

  async cleanupExpired(): Promise<number> {
    const deleted = await this.db
      .delete(orgMemories)
      .where(
        and(
          isNotNull(orgMemories.expiresAt),
          sql`${orgMemories.expiresAt} < NOW()`,
        ),
      )
      .returning();
    return deleted.length;
  }

  async countByOrg(organizationId: string): Promise<Record<string, number>> {
    const rows = await this.db
      .select({
        kind: orgMemories.kind,
        count: sql<string>`COUNT(*)::int`,
      })
      .from(orgMemories)
      .where(eq(orgMemories.organizationId, organizationId))
      .groupBy(orgMemories.kind);

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.kind] = Number(row.count);
    }
    return result;
  }

  private toRecord(row: typeof orgMemories.$inferSelect): DbMemoryRecord {
    return {
      id: row.id,
      organizationId: row.organizationId,
      kind: row.kind,
      key: row.key,
      content: row.content,
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      userId: row.userId,
      sessionId: row.sessionId,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    };
  }
}
