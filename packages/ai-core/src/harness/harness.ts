import type { Actor } from "@chaste/kernel";
import { planRequiresApproval, requestPlanApproval, validatePlan } from "../planning/index.js";
import { describeToolSet } from "../tools/describe.js";
import { executeBusinessTool } from "../tools/execute.js";
import type { ToolOutcome, ToolRegistry, ToolContext } from "../tools/index.js";
import { createToolContextFactory } from "./tool-context.js";
import { runPlanSteps } from "./run-plan-steps.js";
import type {
  Harness,
  HarnessOptions,
  PlanRunParams,
  PlanRunResult,
  PlanStepRun,
  ToolCallParams,
  ToolSurface,
} from "./types.js";

/**
 * The native harness (research doc §Agent Harness): builds the model-facing
 * tool surface from the registry, executes tool calls through the bus under
 * the actor's own permissions, turns approval-required outcomes into durable
 * grants via the inbox, and runs typed plans in dependency order under the
 * plan's grants. Additive — the existing ad-hoc orchestrator is untouched.
 */
export function createHarness(opts: HarnessOptions): Harness {
  const buildToolContext = createToolContextFactory({
    commands: opts.commands,
    queries: opts.queries,
    helpers: opts.helpers,
    grants: opts.grants,
    inbox: opts.inbox,
    approverUserId: opts.approverUserId,
    trajectory: opts.trajectory,
    now: opts.now,
    grantTtlMs: opts.grantTtlMs,
  });

  function toolSurface(actor: Actor): ToolSurface {
    const tools = opts.registry.listForActor(actor);
    return {
      names: tools.map((t) => t.name),
      text: describeToolSet(tools, { includeSchema: true, includeExamples: true }),
    };
  }

  async function call(params: ToolCallParams): Promise<ToolOutcome> {
    const tool = opts.registry.get(params.tool);
    if (!tool) {
      return {
        ok: false,
        kind: "error",
        commandType: params.tool,
        message: `Unknown tool: ${params.tool}`,
        policyDecisions: [],
      };
    }
    return executeBusinessTool(tool, params.args, buildToolContext(params));
  }

  async function runPlan(params: PlanRunParams): Promise<PlanRunResult> {
    const { actor, plan } = params;
    const approverUserId = opts.approverUserId;
    const steps: PlanStepRun[] = [];
    const fail = (reason: string, grantIds: string[]): PlanRunResult => ({
      ok: false,
      reason,
      grantIds,
      steps,
    });

    const validation = validatePlan(plan);
    if (!validation.ok) {
      return fail(
        `plan failed boundary validation: ${validation.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
        [],
      );
    }
    const validPlan = validation.plan;

    if (planRequiresApproval(validPlan) && !approverUserId) {
      return fail("plan requires approval but no approver is configured", []);
    }

    const approval = await requestPlanApproval(validPlan, {
      sessionId: params.sessionId,
      organizationId: params.organizationId,
      userId: actor.userId,
      approverUserId,
      grantTtlMs: opts.grantTtlMs,
      inbox: opts.inbox,
      grants: opts.grants,
      trajectory: opts.trajectory,
      now: opts.now,
    });
    if (!approval.approved) return fail(approval.reason, []);
    const grantIds = approval.grantIds;

    const run = await runPlanSteps({
      plan: validPlan,
      actor,
      sessionId: params.sessionId,
      organizationId: params.organizationId,
      correlationId: params.correlationId,
      causationId: params.causationId,
      origin: params.origin,
      reason: params.reason,
      evidenceRefs: params.evidenceRefs,
      policyContext: params.policyContext,
      registry: opts.registry,
      buildToolContext,
      trajectory: opts.trajectory,
      now: opts.now,
    });

    return { ok: true, grantIds, steps: run.steps, stopped: run.stopped, stopReason: run.stopReason };
  }

  return { toolSurface, call, runPlan };
}

// Re-exported for hosts that execute plan steps after resolving an approval
// through their own decision surface.
export { runPlanSteps };
export type { RunPlanStepsOptions, RunPlanStepsResult } from "./run-plan-steps.js";
export type { ToolContext };
