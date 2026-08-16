import type { EvidenceRef } from "./context.js";
import type { ApprovalGrant } from "./envelope.js";

/**
 * Durable approval grants (research doc §Human Collaboration).
 *
 * Human approval is a durable grant, not a chat message the model may
 * reinterpret. A grant records *who* approved, *what exact action* was
 * approved (scope), *who* the approval authorizes (grantedToUserId), when it
 * expires, the thresholds/conditions it was granted under, the policy basis,
 * and the evidence shown at approval time.
 *
 * The tool registry (ADR 0014 tranche 2) treats approval-required calls as
 * approval *requests*; this store turns an approved request into a durable
 * grant that the call's envelope carries as `approvalGrantId` and that
 * subsequent identical calls can be checked against (`check` / `grantCovers`)
 * without re-asking.
 *
 * `conditions` are human-readable thresholds/conditions recorded for audit and
 * explanation. Evaluating them (e.g. amount ceilings) is the policy engine's
 * job in a later tranche; matching here is scope + actor + expiry + revocation.
 */

export type ApprovalGrantStatus = "active" | "revoked";

/** A stored approval grant: `ApprovalGrant` plus store bookkeeping. */
export interface ApprovalGrantRecord extends ApprovalGrant {
  organizationId: string;
  /** The actor whose call this grant authorizes. */
  grantedToUserId: string;
  status: ApprovalGrantStatus;
  revokedAt?: string;
  revokedBy?: string;
  revokeReason?: string;
}

export interface CreateApprovalGrantInput {
  organizationId: string;
  /** User id of the approver (who granted). */
  grantedBy: string;
  /** User id of the actor the grant authorizes. */
  grantedToUserId: string;
  /** What exact action/resource the grant covers. */
  scope: { commandType?: string; resourceType?: string; resourceId?: string };
  expiresAt?: string;
  /** Thresholds/conditions recorded when the grant was issued. */
  conditions?: string[];
  /** Policy basis for the grant. */
  policyBasis?: string;
  /** Evidence shown to the approver at grant time. */
  evidenceShown?: EvidenceRef[];
  id?: string;
  grantedAt?: string;
}

export interface GrantCheckRequest {
  organizationId: string;
  /** The actor attempting the call. */
  userId: string;
  commandType?: string;
  resourceType?: string;
  resourceId?: string;
  now?: () => Date;
}

export type GrantCheck =
  | { ok: true; grant: ApprovalGrantRecord }
  | {
      ok: false;
      reason:
        | "not_found"
        | "revoked"
        | "expired"
        | "org_mismatch"
        | "actor_mismatch"
        | "scope_mismatch";
    };

/**
 * Pure grant matcher: does an active grant authorize this exact call right
 * now? A grant whose scope declares a field must match the request's value for
 * that field; a grant with no declared scope fields covers the grantee's calls
 * broadly.
 */
export function grantCovers(grant: ApprovalGrantRecord, opts: GrantCheckRequest): GrantCheck {
  if (grant.organizationId !== opts.organizationId) {
    return { ok: false, reason: "org_mismatch" };
  }
  if (grant.status === "revoked") {
    return { ok: false, reason: "revoked" };
  }
  if (grant.grantedToUserId !== opts.userId) {
    return { ok: false, reason: "actor_mismatch" };
  }
  const now = (opts.now?.() ?? new Date()).toISOString();
  if (grant.expiresAt && grant.expiresAt <= now) {
    return { ok: false, reason: "expired" };
  }
  const scope = grant.scope;
  if (scope.commandType !== undefined && scope.commandType !== opts.commandType) {
    return { ok: false, reason: "scope_mismatch" };
  }
  if (scope.resourceType !== undefined && scope.resourceType !== opts.resourceType) {
    return { ok: false, reason: "scope_mismatch" };
  }
  if (scope.resourceId !== undefined && scope.resourceId !== opts.resourceId) {
    return { ok: false, reason: "scope_mismatch" };
  }
  return { ok: true, grant };
}

export interface ApprovalGrantStore {
  create(input: CreateApprovalGrantInput): Promise<ApprovalGrantRecord>;
  get(id: string): Promise<ApprovalGrantRecord | undefined>;
  /** Find an active grant covering the call (null when none applies). */
  check(opts: GrantCheckRequest): Promise<GrantCheck>;
  /** Revoke exactly once; returns false when already revoked or absent. */
  revoke(
    id: string,
    opts: { by: string; reason?: string; now?: () => Date },
  ): Promise<boolean>;
  list(organizationId: string): Promise<ApprovalGrantRecord[]>;
}

/** In-memory approval grant store (tests, dev, single-process hosts). */
export class InMemoryApprovalGrantStore implements ApprovalGrantStore {
  private readonly grants = new Map<string, ApprovalGrantRecord>();
  private readonly now: () => Date;

  constructor(opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  async create(input: CreateApprovalGrantInput): Promise<ApprovalGrantRecord> {
    const record: ApprovalGrantRecord = {
      id: input.id ?? crypto.randomUUID(),
      organizationId: input.organizationId,
      grantedBy: input.grantedBy,
      grantedToUserId: input.grantedToUserId,
      grantedAt: input.grantedAt ?? this.now().toISOString(),
      scope: input.scope,
      expiresAt: input.expiresAt,
      conditions: input.conditions,
      policyBasis: input.policyBasis,
      evidenceShown: input.evidenceShown,
      status: "active",
    };
    this.grants.set(record.id, record);
    return record;
  }

  async get(id: string): Promise<ApprovalGrantRecord | undefined> {
    return this.grants.get(id);
  }

  async check(opts: GrantCheckRequest): Promise<GrantCheck> {
    for (const grant of this.grants.values()) {
      const result = grantCovers(grant, opts);
      if (result.ok) return result;
    }
    return { ok: false, reason: "not_found" };
  }

  async revoke(
    id: string,
    opts: { by: string; reason?: string; now?: () => Date },
  ): Promise<boolean> {
    const grant = this.grants.get(id);
    if (!grant || grant.status === "revoked") return false;
    grant.status = "revoked";
    grant.revokedAt = (opts.now?.() ?? this.now()).toISOString();
    grant.revokedBy = opts.by;
    grant.revokeReason = opts.reason;
    return true;
  }

  async list(organizationId: string): Promise<ApprovalGrantRecord[]> {
    return [...this.grants.values()]
      .filter((g) => g.organizationId === organizationId)
      .sort((a, b) => a.grantedAt.localeCompare(b.grantedAt));
  }
}