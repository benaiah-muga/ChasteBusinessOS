import type { Actor } from "./context.js";

export interface AuditEntry {
  id: string;
  at: string;
  organizationId: string;
  actorUserId: string;
  actorKind: Actor["kind"];
  aiRunId?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  success: boolean;
  requestId: string;
  inputSummary?: unknown;
  errorCode?: string;
  errorMessage?: string;
}

export interface AuditWriter {
  write(entry: AuditEntry): Promise<void>;
}

export class InMemoryAuditWriter implements AuditWriter {
  readonly entries: AuditEntry[] = [];

  async write(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}
