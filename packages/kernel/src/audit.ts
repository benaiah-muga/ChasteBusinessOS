import type { Actor, ActorOrigin, EvidenceRef, PolicyContext } from "./context.js";

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
  /** Envelope provenance (AI/manual parity): who reached the bus and why. */
  origin?: ActorOrigin;
  reason?: string;
  evidenceRefs?: EvidenceRef[];
  approvalGrantId?: string;
  policyContext?: PolicyContext;
  idempotencyKey?: string;
  correlationId?: string;
  causationId?: string;
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
