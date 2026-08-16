import type { AutonomyLevel } from "./autonomy.js";

export type ActorKind = "user" | "system" | "ai_assisted" | "api_key";

export interface Actor {
  kind: ActorKind;
  userId: string;
  organizationId: string;
  /** Present when AI is assisting a user — does not elevate permissions. */
  aiRunId?: string;
  /**
   * Identifier of the API-key principal when `kind === "api_key"`. Lets audit
   * attribute a request to a machine credential, not just its creator.
   */
  clientId?: string;
  displayName?: string;
  permissions: ReadonlySet<string>;
}

/**
 * The channel through which an actor reached the business kernel. This is the
 * AI/manual-parity discriminator: an `agent` origin is never a privileged
 * class — it is just another origin flowing through the same command bus.
 */
export type ActorOrigin = "human" | "agent" | "workflow" | "integration" | "scheduled";

/**
 * Attribute context evaluated by the authorization/approval layer for a
 * command (ABAC inputs): branch, tenant, amount, period, risk tier, and any
 * module-specific extension.
 */
export interface PolicyContext {
  branchId?: string;
  tenantId?: string;
  amount?: number | string;
  currency?: string;
  period?: string;
  riskTier?: string;
  [key: string]: unknown;
}

/**
 * A versioned reference to evidence that justifies an operation: a source
 * document, a query result, an attachment, an approval. Evidence refs are
 * recorded on the envelope and in audit so an explanation can cite *why* an
 * action happened without relying on model memory.
 */
export interface EvidenceRef {
  id: string;
  /** Evidence class, e.g. "document" | "query_result" | "attachment" | "approval". */
  type: string;
  /** Stable locator (artifact id / object key / record id). */
  ref: string;
  /** Version of the referenced artifact, when applicable. */
  version?: string;
  note?: string;
}

export interface RequestContext {
  actor: Actor;
  requestId: string;
  autonomy: AutonomyLevel;
  /** Wall clock injectable for tests */
  now: () => Date;
  /** Origin of the request (human UI, agent, workflow, integration, scheduled). */
  origin?: ActorOrigin;
  /** Free-text reason the actor supplies for the operation (audit + approval). */
  reason?: string;
  /** Evidence refs justifying the operation. */
  evidenceRefs?: EvidenceRef[];
  /** Id of the durable approval grant that authorizes this operation. */
  approvalGrantId?: string;
  /** ABAC/approval attribute context. */
  policyContext?: PolicyContext;
  /** Idempotency key for retryable/external commands. */
  idempotencyKey?: string;
  /** Cross-process correlation id (same value for related commands). */
  correlationId?: string;
  /** Id of the event/command that caused this one (causal chain). */
  causationId?: string;
}

export function createRequestContext(partial: {
  actor: Actor;
  requestId?: string;
  autonomy?: AutonomyLevel;
  now?: () => Date;
  origin?: ActorOrigin;
  reason?: string;
  evidenceRefs?: EvidenceRef[];
  approvalGrantId?: string;
  policyContext?: PolicyContext;
  idempotencyKey?: string;
  correlationId?: string;
  causationId?: string;
}): RequestContext {
  return {
    actor: partial.actor,
    requestId: partial.requestId ?? crypto.randomUUID(),
    autonomy: partial.autonomy ?? "confirm",
    now: partial.now ?? (() => new Date()),
    origin: partial.origin,
    reason: partial.reason,
    evidenceRefs: partial.evidenceRefs,
    approvalGrantId: partial.approvalGrantId,
    policyContext: partial.policyContext,
    idempotencyKey: partial.idempotencyKey,
    correlationId: partial.correlationId,
    causationId: partial.causationId,
  };
}

export function actorHasPermission(actor: Actor, permission: string): boolean {
  if (actor.permissions.has("*")) return true;
  return actor.permissions.has(permission);
}
