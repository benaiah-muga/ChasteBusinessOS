import type { CommandRegistry, RequestContext } from "@chaste/kernel";
import { executeCommand, type CommandHelpers } from "@chaste/kernel";
import type { WorkflowDefinition, WorkflowStep } from "./types.js";

export interface WorkflowExecutionContext {
  registry: CommandRegistry;
  requestCtx: RequestContext;
  helpers: CommandHelpers;
  variables: Record<string, unknown>;
}

export interface WorkflowExecutionResult {
  success: boolean;
  steps: StepResult[];
  output?: Record<string, unknown>;
  error?: string;
}

export interface StepResult {
  stepId: string;
  status: "completed" | "failed" | "skipped" | "pending_approval";
  output?: Record<string, unknown>;
  error?: string;
}

export async function executeWorkflow(
  definition: WorkflowDefinition,
  requestCtx: RequestContext,
  registry: CommandRegistry,
  helpers: CommandHelpers,
  initialContext: Record<string, unknown> = {},
): Promise<WorkflowExecutionResult> {
  const ctx: WorkflowExecutionContext = {
    registry,
    requestCtx,
    helpers,
    variables: { ...initialContext },
  };

  const results: StepResult[] = [];

  for (const step of definition.steps) {
    const result = await executeStep(step, ctx);
    results.push(result);

    if (result.status === "failed" && step.onError !== "continue") {
      return {
        success: false,
        steps: results,
        error: `Step ${step.id} failed: ${result.error}`,
      };
    }

    if (result.status === "pending_approval") {
      return {
        success: false,
        steps: results,
        error: `Step ${step.id} requires approval`,
      };
    }

    if (result.output) {
      ctx.variables[step.id] = result.output;
    }
  }

  return {
    success: true,
    steps: results,
    output: ctx.variables,
  };
}

async function executeStep(
  step: WorkflowStep,
  ctx: WorkflowExecutionContext,
): Promise<StepResult> {
  try {
    switch (step.type) {
      case "command":
        return await executeCommandStep(step, ctx);
      case "approval":
        return await executeApprovalStep(step, ctx);
      case "condition":
        return await executeConditionStep(step, ctx);
      case "parallel":
        return await executeParallelStep(step, ctx);
      case "agent":
        return { stepId: step.id, status: "completed", output: { delegated: true } };
      default:
        return { stepId: step.id, status: "failed", error: `Unknown step type: ${step.type}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { stepId: step.id, status: "failed", error: message };
  }
}

async function executeCommandStep(
  step: WorkflowStep,
  ctx: WorkflowExecutionContext,
): Promise<StepResult> {
  if (!step.command) {
    return { stepId: step.id, status: "failed", error: "No command specified" };
  }

  const input = resolveInput(step.input ?? {}, ctx.variables);

  const result = await executeCommand(
    ctx.registry,
    step.command,
    input,
    ctx.requestCtx,
    ctx.helpers,
  );

  return {
    stepId: step.id,
    status: "completed",
    output: result.data as Record<string, unknown>,
  };
}

async function executeApprovalStep(
  step: WorkflowStep,
  _ctx: WorkflowExecutionContext,
): Promise<StepResult> {
  return {
    stepId: step.id,
    status: "pending_approval",
    output: {
      required: true,
      approveBy: step.approveBy,
      description: step.description ?? `Approval required for step ${step.id}`,
    },
  };
}

async function executeConditionStep(
  step: WorkflowStep,
  ctx: WorkflowExecutionContext,
): Promise<StepResult> {
  if (!step.condition) {
    return { stepId: step.id, status: "failed", error: "No condition specified" };
  }

  const conditionFn = new Function("context", `return ${step.condition}`);
  const result = conditionFn(ctx.variables);

  return {
    stepId: step.id,
    status: "completed",
    output: { conditionResult: Boolean(result) },
  };
}

async function executeParallelStep(
  step: WorkflowStep,
  ctx: WorkflowExecutionContext,
): Promise<StepResult> {
  if (!step.steps?.length) {
    return { stepId: step.id, status: "completed", output: {} };
  }

  const results = await Promise.all(
    step.steps.map((subStep) => executeStep(subStep, ctx)),
  );

  const allSucceeded = results.every((r) => r.status === "completed");

  return {
    stepId: step.id,
    status: allSucceeded ? "completed" : "failed",
    output: Object.fromEntries(results.map((r) => [r.stepId, r.output])),
    error: allSucceeded ? undefined : results.find((r) => r.status === "failed")?.error,
  };
}

function resolveInput(
  input: Record<string, unknown>,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.startsWith("${") && value.endsWith("}")) {
      const varName = value.slice(2, -1);
      resolved[key] = variables[varName];
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}
