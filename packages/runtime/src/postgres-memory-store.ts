/**
 * Durable MemoryStore backed by the `org_memories` table (via DbMemoryStore).
 *
 * Adapts the richer DB store to the ai-core `MemoryStore` port so the
 * orchestrator's passive-recall hook and `memory.search`/`memory.store` agent
 * tools can be wired with a process-shared, org-scoped Postgres store.
 */
import type { MemoryKind, MemoryRecord, MemoryStore, MemoryWrite } from "@chaste/ai-core";
import { DbMemoryStore } from "@chaste/db";

const KIND_WHITELIST = new Set<MemoryKind>([
  "short_term_chat",
  "workflow_session",
  "long_term_org",
  "permanent_business_pointer",
]);

function toKind(kind: string): MemoryKind {
  if (KIND_WHITELIST.has(kind as MemoryKind)) return kind as MemoryKind;
  return "long_term_org";
}

export class PostgresMemoryStore implements MemoryStore {
  constructor(private readonly inner: DbMemoryStore) {}

  async write(record: MemoryWrite): Promise<MemoryRecord> {
    const saved = await this.inner.write({
      organizationId: record.organizationId,
      kind: record.kind,
      key: record.key,
      content: record.content,
      metadata: record.metadata ?? {},
      userId: record.userId,
      sessionId: record.sessionId,
      expiresAt: record.expiresAt ? new Date(record.expiresAt) : undefined,
    });
    return this.toRecord(saved);
  }

  async search(organizationId: string, query: string, limit = 10): Promise<MemoryRecord[]> {
    const rows = await this.inner.search(organizationId, query, limit);
    return rows.map((r) => this.toRecord(r));
  }

  async forget(organizationId: string, kind: string, key: string): Promise<boolean> {
    return this.inner.forget(organizationId, kind, key);
  }

  private toRecord(row: {
    id: string;
    organizationId: string;
    kind: string;
    content: string;
    metadata: Record<string, unknown>;
    key: string | null;
    userId: string | null;
    sessionId: string | null;
    expiresAt: Date | null;
    createdAt: Date;
  }): MemoryRecord {
    return {
      id: row.id,
      organizationId: row.organizationId,
      kind: toKind(row.kind),
      content: row.content,
      metadata: row.metadata,
      key: row.key ?? undefined,
      userId: row.userId ?? undefined,
      sessionId: row.sessionId ?? undefined,
      expiresAt: row.expiresAt?.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }
}
