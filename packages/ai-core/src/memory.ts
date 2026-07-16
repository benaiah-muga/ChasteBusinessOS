/**
 * Memory ports — first-class architecture.
 * Permanent business facts never live only here; they go through commands.
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
  createdAt: string;
}

export interface MemoryStore {
  write(record: Omit<MemoryRecord, "id" | "createdAt"> & { id?: string }): Promise<MemoryRecord>;
  search(organizationId: string, query: string, limit?: number): Promise<MemoryRecord[]>;
}

export class InMemoryMemoryStore implements MemoryStore {
  private records: MemoryRecord[] = [];

  async write(
    record: Omit<MemoryRecord, "id" | "createdAt"> & { id?: string },
  ): Promise<MemoryRecord> {
    const full: MemoryRecord = {
      id: record.id ?? crypto.randomUUID(),
      organizationId: record.organizationId,
      kind: record.kind,
      content: record.content,
      metadata: record.metadata,
      createdAt: new Date().toISOString(),
    };
    this.records.push(full);
    return full;
  }

  async search(organizationId: string, query: string, limit = 10): Promise<MemoryRecord[]> {
    const q = query.toLowerCase();
    return this.records
      .filter((r) => r.organizationId === organizationId && r.content.toLowerCase().includes(q))
      .slice(0, limit);
  }
}
