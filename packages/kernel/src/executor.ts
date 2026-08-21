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
}

export interface ExecutorDeps {
  registry: CapabilityRegistry;
  policy?: PolicyEngine;
  approvals?: ApprovalFlow;
  ledger: LedgerStore;
}

export class KernelExecutor {
  private readonly policy: PolicyEngine;
  private readonly approvals: ApprovalFlow;

  constructor(private readonly deps: ExecutorDeps) {
    this.policy = deps.policy ?? new DefaultPolicyEngine();
    this.approvals = deps.approvals ?? { submit: async () => false };
  }

  /**
   * The single execution path for every action — human or agent.
   * validate → authorize → gate → execute → audit.
   * `approvalId` bypasses the gate for actions a human already approved
   * (the approval row itself is the authority; caller must verify it).
   */
  async execute<I, O>(
    capId: string,
    ctx: ActionContext,
    rawInput: unknown,
    opts: { approvedApprovalId?: string } = {},
  ): Promise<CapabilityResult<O>> {
    const cap = this.deps.registry.get(capId) as Capability<I, O> | undefined;
    if (!cap) return { ok: false, error: `unknown capability: ${capId}` };

    const parsed = cap.input.safeParse(rawInput);
    if (!parsed.success) {
      return { ok: false, error: `invalid input: ${parsed.error.message}` };
    }

    const decision = await this.policy.evaluate(ctx, cap, parsed.data);
    if (!decision.allowed) {
      return { ok: false, error: `forbidden: ${decision.reason}` };
    }

    if (decision.requiresApproval && !opts.approvedApprovalId) {
      const request = approvalRequestFor(cap, parsed.data, decision);
      const proceed = await this.approvals.submit(request, ctx);
      if (!proceed) {
        await this.audit(ctx, "approval.requested", cap.id, request);
        return { ok: false, pendingApproval: request, error: "pending human approval" };
      }
      await this.audit(ctx, "approval.granted", cap.id, { capabilityId: cap.id });
    }

    try {
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
