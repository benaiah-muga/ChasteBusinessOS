import { z } from "zod";
import type { CommandRegistry, RequestContext } from "@chaste/kernel";
import { executeCommand, type CommandHelpers } from "@chaste/kernel";

export interface WorkflowStepDef {
  id: string;
  type: "command" | "agent" | "approval" | "condition" | "parallel";
  command?: string;
  agentId?: string;
  condition?: string;
  approveBy?: string;
  description?: string;
  input?: Record<string, unknown>;
  steps?: WorkflowStepDef[];
  onError?: "bail" | "retry" | "continue";
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  trigger: "manual" | "event" | "schedule";
  triggerConfig?: Record<string, unknown>;
  steps: WorkflowStepDef[];
  createdBy: "user" | "ai";
  createdAt: string;
}

export interface WorkflowExecutionContext {
  registry: CommandRegistry;
  requestCtx: RequestContext;
  helpers: CommandHelpers;
}

export interface StepResult {
  stepId: string;
  status: "completed" | "failed" | "skipped" | "pending_approval";
  output?: Record<string, unknown>;
  error?: string;
}

export interface WorkflowRunResult {
  success: boolean;
  runId: string;
  stepResults: StepResult[];
  output?: Record<string, unknown>;
  error?: string;
  pendingApproval?: {
    stepId: string;
    description: string;
    approveBy?: string;
  };
}

export async function executeDynamicWorkflow(
  def: WorkflowDefinition,
  input: Record<string, unknown>,
  ctx: WorkflowExecutionContext,
): Promise<WorkflowRunResult> {
  const runId = crypto.randomUUID();
  const stepResults: StepResult[] = [];
  const context: Record<string, unknown> = { ...input };

  for (const stepDef of def.steps) {
    const result = await executeStep(stepDef, context, ctx, runId);
    stepResults.push(result);

    if (result.status === "failed" && stepDef.onError !== "continue") {
      return {
        success: false,
        runId,
        stepResults,
        error: `Step "${stepDef.id}" failed: ${result.error}`,
      };
    }

    if (result.status === "pending_approval") {
      return {
        success: false,
        runId,
        stepResults,
        pendingApproval: {
          stepId: stepDef.id,
          description: stepDef.description ?? `Approval needed for step ${stepDef.id}`,
          approveBy: stepDef.approveBy,
        },
      };
    }

    if (result.output) {
      context[stepDef.id] = result.output;
      Object.assign(context, result.output);
    }
  }

  return {
    success: true,
    runId,
    stepResults,
    output: context,
  };
}

async function executeStep(
  stepDef: WorkflowStepDef,
  context: Record<string, unknown>,
  ctx: WorkflowExecutionContext,
  runId: string,
): Promise<StepResult> {
  switch (stepDef.type) {
    case "command":
      return executeCommandStep(stepDef, context, ctx);
    case "approval":
      return { stepId: stepDef.id, status: "pending_approval" };
    case "condition":
      return executeConditionStep(stepDef, context);
    case "agent":
      return executeAgentStep(stepDef, context);
    case "parallel":
      return executeParallelStep(stepDef, context, ctx, runId);
    default:
      return { stepId: stepDef.id, status: "failed", error: `Unknown step type: ${stepDef.type}` };
  }
}

async function executeCommandStep(
  stepDef: WorkflowStepDef,
  context: Record<string, unknown>,
  ctx: WorkflowExecutionContext,
): Promise<StepResult> {
  try {
    const input = resolveInput(stepDef.input ?? {}, context);
    const mergedInput = { ...input, ...context };
    const result = await executeCommand(
      ctx.registry,
      stepDef.command!,
      mergedInput,
      ctx.requestCtx,
      ctx.helpers,
    );
    return {
      stepId: stepDef.id,
      status: "completed",
      output: result.data as Record<string, unknown>,
    };
  } catch (err) {
    return {
      stepId: stepDef.id,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function executeConditionStep(
  stepDef: WorkflowStepDef,
  context: Record<string, unknown>,
): StepResult {
  if (stepDef.condition) {
    try {
      const fn = new Function("input", "state", `return ${stepDef.condition}`);
      const result = fn(context, context);
      return {
        stepId: stepDef.id,
        status: "completed",
        output: { conditionResult: Boolean(result) },
      };
    } catch {
      return {
        stepId: stepDef.id,
        status: "completed",
        output: { conditionResult: false },
      };
    }
  }
  return {
    stepId: stepDef.id,
    status: "completed",
    output: { conditionResult: true },
  };
}

function executeAgentStep(
  stepDef: WorkflowStepDef,
  _context: Record<string, unknown>,
): StepResult {
  return {
    stepId: stepDef.id,
    status: "completed",
    output: {
      delegated: true,
      agentId: stepDef.agentId,
    },
  };
}

async function executeParallelStep(
  stepDef: WorkflowStepDef,
  context: Record<string, unknown>,
  ctx: WorkflowExecutionContext,
  runId: string,
): Promise<StepResult> {
  const subSteps = stepDef.steps ?? [];
  const results = await Promise.all(
    subSteps.map(async (sub) => {
      const result = await executeStep(sub, context, ctx, runId);
      return { stepId: sub.id, status: result.status, output: result.output };
    }),
  );
  return {
    stepId: stepDef.id,
    status: results.every((r) => r.status === "completed") ? "completed" : "failed",
    output: { parallelResults: results },
  };
}

function resolveInput(
  input: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.startsWith("${") && value.endsWith("}")) {
      const varName = value.slice(2, -1);
      resolved[key] = context[varName];
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}
