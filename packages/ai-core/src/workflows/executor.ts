/**
 * Thin compatibility layer over the primary workflow engine.
 * Prefer `executeDynamicWorkflow` from `./engine.js` for new code.
 */
import type { CommandRegistry, RequestContext, CommandHelpers } from "@chaste/kernel";
import {
  executeDynamicWorkflow,
  type WorkflowDefinition,
  type WorkflowExecuteOptions,
  type WorkflowRunResult,
  type StepResult,
} from "./engine.js";

export type { WorkflowDefinition, WorkflowExecuteOptions, WorkflowRunResult, StepResult };

export interface WorkflowExecutionContext {
  registry: CommandRegistry;
  requestCtx: RequestContext;
  helpers: CommandHelpers;
  variables?: Record<string, unknown>;
}

export interface WorkflowExecutionResult {
  success: boolean;
  steps: StepResult[];
  output?: Record<string, unknown>;
  error?: string;
  runId?: string;
  pendingApproval?: WorkflowRunResult["pendingApproval"];
}

export async function executeWorkflow(
  definition: WorkflowDefinition,
  requestCtx: RequestContext,
  registry: CommandRegistry,
  helpers: CommandHelpers,
  initialContext: Record<string, unknown> = {},
  options: WorkflowExecuteOptions = {},
): Promise<WorkflowExecutionResult> {
  const result = await executeDynamicWorkflow(
    definition,
    initialContext,
    { registry, requestCtx, helpers },
    options,
  );

  return {
    success: result.success,
    steps: result.stepResults,
    output: result.output,
    error: result.error,
    runId: result.runId,
    pendingApproval: result.pendingApproval,
  };
}
