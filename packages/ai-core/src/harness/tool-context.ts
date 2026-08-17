import type {
  ApprovalGrantStore,
  CommandHelpers,
  CommandRegistry,
  InboxStore,
  QueryRegistry,
} from "@chaste/kernel";
import type { SessionLog } from "../trajectory/index.js";
import { grantCoveredToolPolicy, grantStoreApprovalResolver } from "../tools/approvals.js";
import type { ToolContext } from "../tools/index.js";
import type { ToolCallParams } from "./types.js";

/**
 * Builds the per-call `ToolContext` the execution pipeline needs. Shared by the
 * harness and the host layer so both execute tools under identical authority:
 * permission-filtered bus dispatch, durable-grant auto-allow when grants are
 * configured, and an inbox-backed approval resolver (never silently granting).
 */

export interface ToolContextFactoryOptions {
  commands: CommandRegistry;
  queries: QueryRegistry;
  helpers: CommandHelpers;
  grants?: ApprovalGrantStore;
  inbox?: InboxStore;
  approverUserId?: string;
  trajectory?: SessionLog;
  now?: () => Date;
  grantTtlMs?: number;
}

export function createToolContextFactory(
  opts: ToolContextFactoryOptions,
): (params: ToolCallParams) => ToolContext {
  const grants = opts.grants;
  return (params: ToolCallParams) => {
    const ctx: ToolContext = {
      sessionId: params.sessionId,
      organizationId: params.organizationId,
      actor: params.actor,
      origin: params.origin,
      correlationId: params.correlationId,
      causationId: params.causationId,
      reason: params.reason,
      evidenceRefs: params.evidenceRefs,
      policyContext: params.policyContext,
      idempotencyKey: params.idempotencyKey,
      commands: opts.commands,
      queries: opts.queries,
      helpers: opts.helpers,
      trajectory: opts.trajectory,
      now: opts.now,
    };
    if (grants) {
      ctx.policy = grantCoveredToolPolicy(grants, {
        organizationId: params.organizationId,
        userId: params.actor.userId,
        now: opts.now,
      });
      if (opts.inbox && opts.approverUserId) {
        ctx.approvals = grantStoreApprovalResolver(grants, {
          organizationId: params.organizationId,
          grantedToUserId: params.actor.userId,
          approverUserId: opts.approverUserId,
          inbox: opts.inbox,
          sessionId: params.sessionId,
          now: opts.now,
          grantTtlMs: opts.grantTtlMs,
        });
      }
    }
    return ctx;
  };
}
