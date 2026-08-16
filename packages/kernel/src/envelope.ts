import type { Actor, ActorOrigin, EvidenceRef, PolicyContext } from "./context.js";
import { createRequestContext } from "./context.js";
import type { CommandHelpers, CommandRegistry, ExecuteCommandResult } from "./command.js";
import { executeCommand } from "./command.js";

/**
 * The command envelope — the single write contract shared by humans and AI
 * (research doc §Command and Query Bus). Every write path (UI, agent harness,
 * workflow, integration, scheduled job) funnels through `dispatchCommand`,
 * which builds a `RequestContext` carrying the envelope's provenance and then
 * runs the exact same `executeCommand` path used by every other caller.
 *
 * `origin` marks the channel; it is never a privilege. The actor's permission
 * set is unchanged regardless of origin — AI/manual parity by construction.
 */
export interface CommandEnvelope {
  commandId: string;
  idempotencyKey: string;
  tenantId: string;
  actor: Actor;
  origin: ActorOrigin;
  requestedAt: string;
  commandType: string;
  payload: unknown;
  /** Human- or agent-supplied reason for the operation (audit + approval). */
  reason?: string;
  /** Evidence refs justifying the operation. */
  evidenceRefs?: EvidenceRef[];
  correlationId: string;
  causationId?: string;
  /** Durable approval grant that authorizes this operation. */
  approvalGrantId?: string;
  policyContext: PolicyContext;
}

/** A durable human approval grant. Never a chat message — a durable fact. */
export interface ApprovalGrant {
  id: string;
  /** Actor id of the grantor. */
  grantedBy: string;
  grantedAt: string;
  /** What exact action/resource the grant covers. */
  scope: { commandType?: string; resourceType?: string; resourceId?: string };
  expiresAt?: string;
  conditions?: string[];
  /** Policy basis for the grant. */
  policyBasis?: string;
  /** Evidence shown to the approver at grant time. */
  evidenceShown?: EvidenceRef[];
}

export type PolicyDecisionKind = "allow" | "deny" | "approval_required";

/** A recorded authorization/approval decision (feeds policy decision logs). */
export interface PolicyDecision {
  kind: PolicyDecisionKind;
  /** Policy id/name that produced the decision. */
  policy: string;
  reason: string;
  evaluatedAt: string;
  context: PolicyContext;
}

export function createCommandEnvelope(
  partial: Pick<CommandEnvelope, "commandType" | "actor" | "tenantId" | "payload"> &
    Partial<Omit<CommandEnvelope, "commandType" | "actor" | "tenantId" | "payload">>,
  opts: { now?: () => Date } = {},
): CommandEnvelope {
  const now = (opts.now?.() ?? new Date()).toISOString();
  return {
    commandId: partial.commandId ?? crypto.randomUUID(),
    idempotencyKey: partial.idempotencyKey ?? crypto.randomUUID(),
    tenantId: partial.tenantId,
    actor: partial.actor,
    origin: partial.origin ?? "human",
    requestedAt: partial.requestedAt ?? now,
    commandType: partial.commandType,
    payload: partial.payload,
    reason: partial.reason,
    evidenceRefs: partial.evidenceRefs,
    correlationId: partial.correlationId ?? crypto.randomUUID(),
    causationId: partial.causationId,
    approvalGrantId: partial.approvalGrantId,
    policyContext: partial.policyContext ?? {},
  };
}

/**
 * Dispatch a command envelope through the same command bus humans use. Returns
 * the typed command result plus the envelope (so callers can correlate the
 * response to the audit/outbox records).
 */
export async function dispatchCommand<T = unknown>(
  registry: CommandRegistry,
  envelope: CommandEnvelope,
  helpers: CommandHelpers,
  opts: { now?: () => Date } = {},
): Promise<ExecuteCommandResult<T> & { envelope: CommandEnvelope }> {
  const ctx = createRequestContext({
    actor: envelope.actor,
    requestId: envelope.commandId,
    now: opts.now,
    origin: envelope.origin,
    reason: envelope.reason,
    evidenceRefs: envelope.evidenceRefs,
    approvalGrantId: envelope.approvalGrantId,
    policyContext: envelope.policyContext,
    idempotencyKey: envelope.idempotencyKey,
    correlationId: envelope.correlationId,
    causationId: envelope.causationId,
  });
  const result = await executeCommand<T>(
    registry,
    envelope.commandType,
    envelope.payload,
    ctx,
    helpers,
  );
  return { ...result, envelope };
}
