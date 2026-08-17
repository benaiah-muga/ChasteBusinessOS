import type { Actor, ActorOrigin, EvidenceRef, PolicyContext } from "@chaste/kernel";
import type { SessionLog } from "../trajectory/index.js";
import { executeBusinessTool } from "../tools/execute.js";
import type { ToolContext, ToolOutcome, ToolRegistry } from "../tools/index.js";
import type { AgentPlan } from "../planning/index.js";
import type { PlanStepRun, ToolCallParams } from "./types.js";
import { attachStepEvidence, matchesStopCondition, topoSort } from "./plan-steps.js";

/**
 * The plan's step-execution loop (dependency-ordered, stop-condition-aware,
 * evidence-attaching), shared by the harness `runPlan` and the host layer's
 * post-approval execution. The caller supplies the `ToolContext` factory so
 * both paths run steps under identical authority (the same grants/policy).
 */

export interface RunPlanStepsOptions {
  plan: AgentPlan;
  actor: Actor;
  sessionId: string;
  organizationId: string;
  correlationId: string;
  causationId?: string;
  origin?: ActorOrigin;
  reason?: string;
  evidenceRefs?: EvidenceRef[];
  policyContext?: PolicyContext;
  registry: ToolRegistry;
  buildToolContext: (params: ToolCallParams) => ToolContext;
  trajectory?: SessionLog;
  now?: () => Date;
}

export interface RunPlanStepsResult {
  steps: PlanStepRun[];
  stopped: boolean;
  stopReason?: string;
}

export async function runPlanSteps(opts: RunPlanStepsOptions): Promise<RunPlanStepsResult> {
  const steps: PlanStepRun[] = [];
  const ordering = topoSort(opts.plan.steps);
  if (!ordering.ok) {
    return {
      steps: opts.plan.steps.map((step) => ({
        stepId: step.id,
        title: step.title,
        outcome: null,
        skipped: "dep_failed" as const,
      })),
      stopped: false,
    };
  }

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
    const tool = opts.registry.listForActor(opts.actor).find((t) => t.command === step.command);
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

    const outcome: ToolOutcome = await executeBusinessTool(
      tool,
      step.args ?? {},
      opts.buildToolContext({
        sessionId: opts.sessionId,
        organizationId: opts.organizationId,
        actor: opts.actor,
        tool: tool.name,
        args: step.args ?? {},
        correlationId: opts.correlationId,
        causationId: opts.causationId,
        origin: opts.origin,
        reason: opts.reason ?? step.title,
        evidenceRefs: opts.evidenceRefs,
        policyContext: opts.policyContext,
      }),
    );

    let evidenceAttached: string[] | undefined;
    if (outcome.ok) {
      evidenceAttached = await attachStepEvidence(opts.trajectory, {
        sessionId: opts.sessionId,
        organizationId: opts.organizationId,
        step,
        commandType: outcome.commandType,
        requestId: outcome.requestId,
        now: opts.now,
      });
      const condition = matchesStopCondition(
        opts.plan.stopConditions,
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

  return { steps, stopped, stopReason };
}
