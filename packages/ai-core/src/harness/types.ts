import type {
  Actor,
  ActorOrigin,
  ApprovalGrantStore,
  CommandHelpers,
  CommandRegistry,
  EvidenceRef,
  InboxStore,
  PolicyContext,
  QueryRegistry,
} from "@chaste/kernel";
import type { AgentPlan } from "../planning/index.js";
import type { SessionLog } from "../trajectory/index.js";
import type { ToolOutcome, ToolRegistry } from "../tools/index.js";

/**
 * Native harness (research doc §Agent Harness, ADR 0014 tranche 6).
 *
 * `createHarness` is the additive orchestrator-wiring layer that connects the
 * four harness layers — tool registry, durable approval grants, typed plans,
 * trajectory — into a runnable whole. It leaves the existing ad-hoc
 * orchestrator path untouched (additive pivot): the harness is a new object a
 * host may call instead.
 *
 * The harness never elevates the agent: every tool call dispatches through the
 * bus under the actor's own permissions, approval-required calls become
 * durable grants via the inbox, and plan steps run under those grants with
 * dependency order, stop conditions, and evidence attachment — all recorded on
 * the session trajectory.
 */

export interface HarnessOptions {
  registry: ToolRegistry;
  commands: CommandRegistry;
  queries: QueryRegistry;
  helpers: CommandHelpers;
  /** Durable grant store; without it approval-required calls stay requests. */
  grants?: ApprovalGrantStore;
  /** Human-attention queue used to surface approval-required and plan approvals. */
  inbox?: InboxStore;
  /** Append-only session trajectory. */
  trajectory?: SessionLog;
  /** User id of the human who may approve; absent → fail closed on approvals. */
  approverUserId?: string;
  /** Default lifetime (ms) for grants minted by this harness. */
  grantTtlMs?: number;
  now?: () => Date;
}

export interface ToolCallParams {
  sessionId: string;
  organizationId: string;
  actor: Actor;
  /** Tool name as registered (e.g. `procurement_create_purchase_order`). */
  tool: string;
  args: unknown;
  correlationId: string;
  causationId?: string;
  origin?: ActorOrigin;
  reason?: string;
  evidenceRefs?: EvidenceRef[];
  policyContext?: PolicyContext;
  idempotencyKey?: string;
}

export interface ToolSurface {
  /** Tool names the actor may see and use. */
  names: string[];
  /** Model-facing text surface (full descriptions with schemas). */
  text: string;
}

/** Outcome of one plan step: executed, or skipped because a dependency failed. */
export interface PlanStepRun {
  stepId: string;
  title: string;
  outcome: ToolOutcome | null;
  skipped?: "dep_failed" | "stopped";
  /** Evidence ref ids attached from this step's success. */
  evidenceAttached?: string[];
}

export type PlanRunResult =
  | {
      ok: true;
      /** Durable grants minted by the plan approval (empty for low-risk runs). */
      grantIds: string[];
      steps: PlanStepRun[];
      stopped: boolean;
      stopReason?: string;
    }
  | {
      ok: false;
      reason: string;
      grantIds: string[];
      steps: PlanStepRun[];
    };

/** A runnable harness bound to one organization's stores. */
export interface Harness {
  /** The tool surface the model sees for this actor (Stage 2–3 full surface). */
  toolSurface(actor: Actor): ToolSurface;
  /** Execute one tool call through the registry/bus under the actor's authority. */
  call(params: ToolCallParams): Promise<ToolOutcome>;
  /**
   * Execute a typed plan: gate on plan approval, then run steps in dependency
   * order under the plan's grants, honoring stop conditions and attaching
   * evidence.
   */
  runPlan(params: PlanRunParams): Promise<PlanRunResult>;
}

export interface PlanRunParams {
  sessionId: string;
  organizationId: string;
  actor: Actor;
  plan: AgentPlan;
  correlationId: string;
  causationId?: string;
  origin?: ActorOrigin;
  reason?: string;
  evidenceRefs?: EvidenceRef[];
  policyContext?: PolicyContext;
}