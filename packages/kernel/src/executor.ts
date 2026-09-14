import type { ActionContext, ApprovalRequest, Capability, CapabilityResult } from "./capability";
import { ledgerEventFor, type LedgerStore } from "./ledger";
import { approvalRequestFor, DefaultPolicyEngine, type PolicyEngine } from "./policy";
import type { CapabilityRegistry } from "./registry";
import { logger } from "./logger";

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
  /**
   * Action receipts (B02). When provided together with `ctx.intentId`,
   * retries of one intended action serve the prior receipt instead of
   * re-executing; key reuse with a different payload is a conflict.
   */
  receipts?: EffectReceiptStore;
  /**
   * For transaction-backed callers (B02 unit of work): rethrow audit append
   * failures after a committed write so the caller's transaction rolls back
   * everything atomically, instead of returning outcome "unknown" (which is
   * the honest semantics when audit and effect cannot share a transaction).
   */
  failOnAuditError?: boolean;
}

export interface ModuleGate {
  isEnabled(orgId: string, moduleId: string): boolean | Promise<boolean>;
}

/**
 * Recorded outcome of one action attempt (B02). Stored by the app under the
 * action key `(orgId, intentId)`; the executor serves it on retry instead of
 * re-executing, so a committed effect is never duplicated and an unproven one
 * is never silently repeated.
 */
export interface EffectReceipt {
  capabilityId: string;
  /** Canonical-input digest; a reused key with a different payload is a conflict. */
  inputHash: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  outcome: "known" | "unknown";
  recordedAt: string;
}

export interface EffectReceiptStore {
  get(key: string): Promise<EffectReceipt | null>;
  put(key: string, receipt: EffectReceipt): Promise<void>;
}

/** Stable JSON digest for payload-conflict detection (canonical key order). */
export async function canonicalInputHash(input: unknown): Promise<string> {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, canonical(v)]),
      );
    }
    return value;
  };
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(input)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
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

    // Idempotent action identity (B02): consulted only after authorization,
    // so a stored receipt can never leak to a caller who is not currently
    // permitted to execute the capability themselves.
    const receipts = this.deps.receipts;
    const actionKey =
      ctx.intentId && receipts ? `${ctx.actor.orgId}:${ctx.intentId}` : null;
    if (actionKey && receipts) {
      const prior = await receipts.get(actionKey).catch(() => null);
      if (prior) {
        if (prior.capabilityId !== cap.id) {
          return { ok: false, error: `action intent conflict: key already used for ${prior.capabilityId}` };
        }
        const priorHash = await canonicalInputHash(parsed.data);
        if (prior.inputHash !== priorHash) {
          return { ok: false, error: "action intent conflict: same action key used with a different payload" };
        }
        return { ok: prior.ok, data: prior.data as O | undefined, error: prior.error, outcome: prior.outcome, replayed: true };
      }
    }
    const inputHash = actionKey ? await canonicalInputHash(parsed.data) : null;

    // Only the capability's own execution is treated as "the action failed";
    // audit and receipt handling live outside this try so their failures can
    // propagate to transaction-backed callers (failOnAuditError) instead of
    // being misread as a domain failure.
    let data: O;
    try {
      // Surface the module gate to capabilities whose cross-module effects
      // must degrade gracefully (ADR 0035): an enabled capability can ask
      // whether a sibling module is enabled and skip that effect only.
      if (this.deps.modules) {
        ctx.services.moduleGate = this.deps.modules;
      }
      data = await cap.execute(ctx, parsed.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.audit(ctx, "capability.failed", cap.id, { input: parsed.data, error: message });
      return { ok: false, error: message };
    }

    // Output conformance at the trust boundary (F02): a write whose output
    // violates its declared schema may have committed an effect that cannot
    // be trusted or blindly retried — report unknown, never a retryable
    // plain failure. Read-class capabilities have no effect to orphan.
    const outputCheck = cap.output.safeParse(data);
    if (!outputCheck.success) {
      const message = `capability returned invalid output: ${outputCheck.error.message}`;
      if (cap.risk === "read") {
        await this.auditBestEffort(ctx, "capability.failed", cap.id, { input: parsed.data, error: message });
        return { ok: false, error: message };
      }
      // A transaction-backed caller rolls the effect back entirely.
      if (this.deps.failOnAuditError) throw new Error(message);
      await this.recordReceipt(actionKey, {
        capabilityId: cap.id,
        inputHash: inputHash ?? "",
        ok: false,
        error: message,
        outcome: "unknown",
        recordedAt: new Date().toISOString(),
      });
      await this.auditBestEffort(ctx, "capability.failed", cap.id, { input: parsed.data, error: message, outcome: "unknown" });
      return { ok: false, outcome: "unknown", error: message };
    }

    try {
      await this.audit(ctx, "capability.executed", cap.id, { input: parsed.data });
    } catch (err) {
      // The write committed but the audit append failed. Without a shared
      // transaction the honest answer is "unknown" (F01). A transaction-
      // backed caller (failOnAuditError) takes the throw instead, so its
      // unit of work rolls the whole effect back and a retry starts clean.
      if (this.deps.failOnAuditError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      await this.recordReceipt(actionKey, {
        capabilityId: cap.id,
        inputHash: inputHash ?? "",
        ok: false,
        error: message,
        outcome: "unknown",
        recordedAt: new Date().toISOString(),
      });
      return { ok: false, outcome: "unknown", error: `effect committed but audit failed: ${message}` };
    }

    // Receipt persistence follows the authoritative audit; a failed put
    // degrades idempotency for this intent but never falsifies the result.
    await this.recordReceipt(actionKey, {
      capabilityId: cap.id,
      inputHash: inputHash ?? "",
      ok: true,
      data,
      outcome: "known",
      recordedAt: new Date().toISOString(),
    });
    return { ok: true, data, outcome: "known" };
  }

  /** Receipt persistence is an idempotency aid, never a result authority. */
  private async recordReceipt(key: string | null, receipt: EffectReceipt): Promise<void> {
    if (!key || !this.deps.receipts) return;
    try {
      await this.deps.receipts.put(key, receipt);
    } catch (err) {
      logger.warn("failed to persist action receipt", {
        capabilityId: receipt.capabilityId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async auditBestEffort(ctx: ActionContext, kind: string, capabilityId: string | null, payload: unknown) {
    try {
      await this.audit(ctx, kind, capabilityId, payload);
    } catch (err) {
      logger.warn("audit append failed for an already-unproven outcome", {
        capabilityId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async audit(ctx: ActionContext, kind: string, capabilityId: string | null, payload: unknown) {
    await this.deps.ledger.append(ledgerEventFor(ctx, kind, capabilityId, payload));
  }
}
