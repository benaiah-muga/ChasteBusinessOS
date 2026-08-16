import type { Actor } from "@chaste/kernel";
import { planRequiresApproval, requestPlanApproval, validatePlan } from "../planning/index.js";
import { describeToolSet } from "../tools/describe.js";
import { executeBusinessTool } from "../tools/execute.js";
import {
  grantCoveredToolPolicy,
  grantStoreApprovalResolver,
} from "../tools/approvals.js";
import type { ToolOutcome, ToolRegistry, ToolContext } from "../tools/index.js";
import { attachStepEvidence, matchesStopCondition, topoSort } from "./plan-steps.js";
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
  const grants = opts.grants;

  function toolSurface(actor: Actor): ToolSurface {
    const tools = opts.registry.listForActor(actor);
    return {
      names: tools.map((t) => t.name),
      text: describeToolSet(tools, { includeSchema: true, includeExamples: true }),
    };
  }

  function toolContext(params: ToolCallParams): ToolContext {
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
    return executeBusinessTool(tool, params.args, toolContext(params));
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
      grants,
      trajectory: opts.trajectory,
      now: opts.now,
    });
    if (!approval.approved) return fail(approval.reason, []);
    const grantIds = approval.grantIds;

    const ordering = topoSort(validPlan.steps);
    if (!ordering.ok) return fail(ordering.reason, grantIds);

    let stopped = false;
    let stopReason: string | undefined;
    for (const step of ordering.order) {
      if (stopped) {
        steps.push({ stepId: step.id, title: step.title, outcome: null, skipped: "stopped" });
        continue;
      }
      const depFailed = (step.dependsOn ?? []).some((depId) => {
        const run = steps.find((s) => s.stepId === depId);
        return run !== undefined && (run.skipped === "dep_failed" || run.outcome?.ok === false);
      });
      if (depFailed) {
        steps.push({ stepId: step.id, title: step.title, outcome: null, skipped: "dep_failed" });
        continue;
      }

      if (!step.command) {
        steps.push({
          stepId: step.id,
          title: step.title,
          outcome: {
            ok: false,
            kind: "error",
            commandType: "",
            message: `step ${step.id} declares no command`,
            policyDecisions: [],
          },
        });
        continue;
      }
      const tool = opts.registry
        .listForActor(actor)
        .find((t) => t.command === step.command);
      if (!tool) {
        steps.push({
          stepId: step.id,
          title: step.title,
          outcome: {
            ok: false,
            kind: "error",
            commandType: step.command,
            message: `No tool dispatches ${step.command} for this actor`,
            policyDecisions: [],
          },
        });
        continue;
      }

      const outcome = await executeBusinessTool(
        tool,
        step.args ?? {},
        toolContext({
          sessionId: params.sessionId,
          organizationId: params.organizationId,
          actor,
          tool: tool.name,
          args: step.args ?? {},
          correlationId: params.correlationId,
          causationId: params.causationId,
          origin: params.origin,
          reason: params.reason ?? step.title,
          evidenceRefs: params.evidenceRefs,
          policyContext: params.policyContext,
        }),
      );

      let evidenceAttached: string[] | undefined;
      if (outcome.ok) {
        evidenceAttached = await attachStepEvidence(opts.trajectory, {
          sessionId: params.sessionId,
          organizationId: params.organizationId,
          step,
          commandType: outcome.commandType,
          requestId: outcome.requestId,
          now: opts.now,
        });
        const condition = matchesStopCondition(
          validPlan.stopConditions,
          outcome.result.summary,
          outcome.result.structured,
        );
        if (condition) {
          stopped = true;
          stopReason = condition;
        }
      }
      steps.push({ stepId: step.id, title: step.title, outcome, evidenceAttached });
    }

    return { ok: true, grantIds, steps, stopped, stopReason };
  }

  return { toolSurface, call, runPlan };
}