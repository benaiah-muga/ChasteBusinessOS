/**
 * Memory ports — first-class architecture.
 * Permanent business facts never live only here; they go through commands.
 *
 * `MemoryStore` is the port the orchestrator consumes: passive recall injects
 * a small budgeted block of learned context into the LLM's per-turn view, and
 * explicit `memory.search`/`memory.store` agent tools let the model pull in or
 * record context itself. Postgres/durable implementations (see @chaste/runtime)
 * back this over the `org_memories` table.
 */

export type MemoryKind =
  | "short_term_chat"
  | "workflow_session"
  | "long_term_org"
  | "permanent_business_pointer";

export interface MemoryRecord {
  id: string;
  organizationId: string;
  kind: MemoryKind;
  content: string;
  metadata?: Record<string, unknown>;
  /** Optional dedupe key within (organizationId, kind). Upserts when set. */
  key?: string;
  userId?: string;
  sessionId?: string;
  expiresAt?: string;
  createdAt: string;
}

export type MemoryWrite = Omit<MemoryRecord, "id" | "createdAt"> & { id?: string };

export interface MemoryStore {
  write(record: MemoryWrite): Promise<MemoryRecord>;
  search(organizationId: string, query: string, limit?: number): Promise<MemoryRecord[]>;
  /** Remove a specific record by its dedupe key. Returns false when absent. */
  forget(organizationId: string, kind: string, key: string): Promise<boolean>;
}

export class InMemoryMemoryStore implements MemoryStore {
  private records: MemoryRecord[] = [];

  async write(record: MemoryWrite): Promise<MemoryRecord> {
    const full: MemoryRecord = {
      id: record.id ?? crypto.randomUUID(),
      organizationId: record.organizationId,
      kind: record.kind,
      content: record.content,
      metadata: record.metadata,
      key: record.key,
      userId: record.userId,
      sessionId: record.sessionId,
      expiresAt: record.expiresAt,
      createdAt: new Date().toISOString(),
    };
    if (full.key) {
      const existing = this.records.findIndex(
        (r) =>
          r.organizationId === full.organizationId &&
          r.kind === full.kind &&
          r.key === full.key,
      );
      if (existing >= 0) {
        this.records[existing] = { ...this.records[existing]!, ...full, createdAt: this.records[existing]!.createdAt };
        return this.records[existing]!;
      }
    }
    this.records.push(full);
    return full;
  }

  async search(organizationId: string, query: string, limit = 10): Promise<MemoryRecord[]> {
    const q = query.toLowerCase();
    return this.records
      .filter((r) => r.organizationId === organizationId && r.content.toLowerCase().includes(q))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, limit);
  }

  async forget(organizationId: string, kind: string, key: string): Promise<boolean> {
    const before = this.records.length;
    this.records = this.records.filter(
      (r) => !(r.organizationId === organizationId && r.kind === kind && r.key === key),
    );
    return this.records.length !== before;
  }
}
