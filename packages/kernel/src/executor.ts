import type { ActionContext, ApprovalRequest, Capability, CapabilityResult } from "./capability";
import { ledgerEventFor, type LedgerStore } from "./ledger";
import { approvalRequestFor, DefaultPolicyEngine, type PolicyEngine } from "./policy";
import type { CapabilityRegistry } from "./registry";

/**
 * How pending approvals surface. Apps implement this: persist an approval row,
 * notify humans, and either block (await) or defer.
 */
export interface ApprovalFlow {
  /** Returns true when execution may proceed immediately. */
  submit(request: ApprovalRequest, ctx: ActionContext): Promise<boolean>;
  /**
   * Verifies that an approval id genuinely authorizes this exact capability
   * and payload. Called by the executor whenever a caller passes
   * `approvedApprovalId`; the kernel never trusts the caller to have checked.
   * Return false when the row is missing, cross-org, consumed, or the payload
   * differs from what was gated. Fail closed when unimplemented.
   */
  verify?(approvalId: string, request: ApprovalRequest, ctx: ActionContext): Promise<boolean>;
}

export interface ExecutorDeps {
  registry: CapabilityRegistry;
  policy?: PolicyEngine;
  approvals?: ApprovalFlow;
  ledger: LedgerStore;
  /**
   * Optional per-org module gate. When provided, capabilities whose `module`
   * is disabled for the acting org are refused before any validation or
   * policy work: disabled means unreachable from human routes, agent tool
   * lists, and the job queue alike.
   */
  modules?: ModuleGate;
}

export interface ModuleGate {
  isEnabled(orgId: string, moduleId: string): boolean | Promise<boolean>;
}

export class KernelExecutor {
  private readonly policy: PolicyEngine;
  private readonly approvals: ApprovalFlow;

  constructor(private readonly deps: ExecutorDeps) {
    this.policy = deps.policy ?? new DefaultPolicyEngine();
    this.approvals = deps.approvals ?? { submit: async () => false };
  }

  /**
   * The single execution path for every action, human or agent.
   * validate → authorize → gate → execute → audit.
   * `approvedApprovalId` bypasses the gate only after the ApprovalFlow's
   * verify() confirms the row authorizes this capability + payload; the
   * kernel never takes the caller's word for it.
   */
  async execute<I, O>(
    capId: string,
    ctx: ActionContext,
    rawInput: unknown,
    opts: { approvedApprovalId?: string } = {},
  ): Promise<CapabilityResult<O>> {
    const cap = this.deps.registry.get(capId) as Capability<I, O> | undefined;
    if (!cap) return { ok: false, error: `unknown capability: ${capId}` };

    // Module availability is checked before anything else about the action:
    // a disabled module must not even validate inputs, appear in tool lists,
    // or run under an approval that predates the disablement.
    if (this.deps.modules && cap.module) {
      const enabled = await this.deps.modules.isEnabled(ctx.actor.orgId, cap.module);
      if (!enabled) {
        return { ok: false, error: `module "${cap.module}" is disabled for this organization` };
      }
    }

    const parsed = cap.input.safeParse(rawInput);
    if (!parsed.success) {
      return { ok: false, error: `invalid input: ${parsed.error.message}` };
    }

    const decision = await this.policy.evaluate(ctx, cap, parsed.data);
    if (!decision.allowed) {
      return { ok: false, error: `forbidden: ${decision.reason}` };
    }

    if (decision.requiresApproval && opts.approvedApprovalId) {
      // A claimed approval must match this capability and this exact payload.
      // The kernel verifies; callers are not trusted to have checked. An app
      // that does not implement verify() gets fail-closed behavior.
      const request = approvalRequestFor(cap, parsed.data, decision);
      const valid = this.approvals.verify
        ? await this.approvals.verify(opts.approvedApprovalId, request, ctx)
        : false;
      if (!valid) {
        return { ok: false, error: "approval verification failed for the supplied approval id" };
      }
      await this.audit(ctx, "approval.granted", cap.id, {
        capabilityId: cap.id,
        approvalId: opts.approvedApprovalId,
      });
    } else if (decision.requiresApproval) {
      const request = approvalRequestFor(cap, parsed.data, decision);
      const proceed = await this.approvals.submit(request, ctx);
      if (!proceed) {
        await this.audit(ctx, "approval.requested", cap.id, request);
        return { ok: false, pendingApproval: request, error: "pending human approval" };
      }
      await this.audit(ctx, "approval.granted", cap.id, { capabilityId: cap.id });
    }

    try {
      // Surface the module gate to capabilities whose cross-module effects
      // must degrade gracefully (ADR 0035): an enabled capability can ask
      // whether a sibling module is enabled and skip that effect only.
      if (this.deps.modules) {
        ctx.services.moduleGate = this.deps.modules;
      }
      const data = await cap.execute(ctx, parsed.data);
      await this.audit(ctx, "capability.executed", cap.id, { input: parsed.data });
      return { ok: true, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.audit(ctx, "capability.failed", cap.id, { input: parsed.data, error: message });
      return { ok: false, error: message };
    }
  }

  private async audit(ctx: ActionContext, kind: string, capabilityId: string | null, payload: unknown) {
    await this.deps.ledger.append(ledgerEventFor(ctx, kind, capabilityId, payload));
  }
}
