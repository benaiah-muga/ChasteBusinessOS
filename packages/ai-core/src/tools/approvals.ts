import type { ApprovalGrantStore, InboxStore } from "@chaste/kernel";
import { defaultToolPolicy } from "./execute.js";
import type { ApprovalResolver, ApprovalResolution, ToolPolicy } from "./types.js";

/**
 * Bridges the tool registry's `approval_required` outcomes to durable approval
 * grants (research doc §Human Collaboration, ADR 0014 tranche 3).
 *
 * `grantStoreApprovalResolver` turns an approved request into a durable grant
 * in an `ApprovalGrantStore` — who granted, what exact command, which actor it
 * authorizes, expiry, conditions, policy basis, and evidence shown. Without a
 * decision surface (no `inbox`) it returns "not granted", so the tool pipeline
 * keeps rendering the call as an approval *request*, never as a failure.
 *
 * `grantCoveredToolPolicy` checks the store *before* the fallback policy, so a
 * human's durable grant auto-allows subsequent identical calls until it
 * expires or is revoked — approval is a durable fact, not a one-off chat reply.
 */

export interface GrantStoreApprovalResolverOptions {
  organizationId: string;
  /** The actor whose call the grant will authorize. */
  grantedToUserId: string;
  /** User id of the approver who may grant. */
  approverUserId: string;
  /** Default grant lifetime in ms when policy implies no explicit expiry. */
  grantTtlMs?: number;
  /** Optional human-attention queue: an approval item is surfaced and awaited. */
  inbox?: InboxStore;
  sessionId?: string;
  now?: () => Date;
}

function conditionsFromPolicyContext(policyContext: Record<string, unknown>): string[] {
  return Object.entries(policyContext).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
}

export function grantStoreApprovalResolver(
  store: ApprovalGrantStore,
  opts: GrantStoreApprovalResolverOptions,
): ApprovalResolver {
  const grantTtlMs = opts.grantTtlMs ?? 60 * 60 * 1000;

  return {
    async request(req): Promise<ApprovalResolution> {
      // A decision surface is required to grant: without one, the call stays
      // an approval request.
      if (opts.inbox) {
        const item = await opts.inbox.addApproval({
          sessionId: opts.sessionId ?? "system",
          organizationId: opts.organizationId,
          userId: opts.approverUserId,
          title: `Approve ${req.commandType}`,
          body: `risk=${req.riskClass}${req.reason ? ` · ${req.reason}` : ""}`,
          data: {
            tool: req.tool,
            commandType: req.commandType,
            riskClass: req.riskClass,
            args: req.args,
          },
        });
        const resolution = await opts.inbox.wait(item.id);
        const granted = resolution === "allow" || resolution === "always";
        if (!granted) return { granted: false };
      } else {
        return { granted: false };
      }

      const now = opts.now?.() ?? new Date();
      const grant = await store.create({
        organizationId: opts.organizationId,
        grantedBy: opts.approverUserId,
        grantedToUserId: opts.grantedToUserId,
        scope: { commandType: req.commandType },
        expiresAt: new Date(now.getTime() + grantTtlMs).toISOString(),
        conditions: conditionsFromPolicyContext(req.policyContext),
        policyBasis: req.policyBasis,
        evidenceShown: req.evidenceRefs,
      });

      return { granted: true, grantId: grant.id, policyBasis: grant.policyBasis };
    },
  };
}

export interface GrantCoveredToolPolicyOptions {
  organizationId: string;
  /** The actor attempting the call (grant authorizations are per-actor). */
  userId: string;
  now?: () => Date;
  /** Policy consulted when no grant covers the call. */
  fallback?: ToolPolicy;
}

/**
 * Policy wrapper: an active durable grant covering the exact call allows it;
 * otherwise fall back to the default risk policy. The resulting policy
 * decision names the grant (`policy: "grant:<id>"`) so the trajectory's
 * `policy/decision` event and the envelope's policy context cite it.
 */
export function grantCoveredToolPolicy(
  store: ApprovalGrantStore,
  opts: GrantCoveredToolPolicyOptions,
): ToolPolicy {
  const fallback = opts.fallback ?? ((r) => defaultToolPolicy(r));

  return async (req) => {
    const check = await store.check({
      organizationId: opts.organizationId,
      userId: opts.userId,
      commandType: req.commandType,
      now: opts.now,
    });
    if (check.ok) {
      return {
        kind: "allow",
        policy: `grant:${check.grant.id}`,
        reason: `Covered by durable approval grant ${check.grant.id} (scope ${JSON.stringify(check.grant.scope)})`,
        evaluatedAt: (opts.now?.() ?? new Date()).toISOString(),
        context: {},
      };
    }
    return fallback(req);
  };
}