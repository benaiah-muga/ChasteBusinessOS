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

export interface WorkflowExecuteOptions {
  /** Step IDs that have already been approved (skip approval gates). */
  approvedStepIds?: string[];
  /** Max retries for steps with onError: "retry". */
  maxRetries?: number;
}

/**
 * Common LLM field-name mistakes → canonical command input fields.
 * Applied after variable resolution, before command execution.
 */
const FIELD_ALIASES: Record<string, string> = {
  location: "city",
  amount: "total",
  total_amount: "total",
  invoice_total: "total",
  customer_id: "customerId",
  customer_name: "name",
  vendor_name: "name",
  product_name: "name",
  full_name: "fullName",
  employee_name: "fullName",
  employee_number: "employeeNumber",
  employee_no: "employeeNumber",
  period_label: "periodLabel",
  period: "periodLabel",
  invoice_number: "number",
  invoice_no: "number",
  sku_code: "sku",
  product_sku: "sku",
};

export async function executeDynamicWorkflow(
  def: WorkflowDefinition,
  input: Record<string, unknown>,
  ctx: WorkflowExecutionContext,
  options: WorkflowExecuteOptions = {},
): Promise<WorkflowRunResult> {
  const runId = crypto.randomUUID();
  const stepResults: StepResult[] = [];
  /** Run input stays under `input`; step outputs under their step ids — no flat merge pollution. */
  const context: Record<string, unknown> = {
    input: { ...input },
    ...input,
  };
  const approved = new Set(options.approvedStepIds ?? []);
  const maxRetries = options.maxRetries ?? 2;

  for (const stepDef of def.steps) {
    const result = await executeStep(stepDef, context, ctx, runId, approved, maxRetries);
    stepResults.push(result);

    if (result.status === "failed" && stepDef.onError !== "continue") {
      return {
        success: false,
        runId,
        stepResults,
        error: `Step "${stepDef.id}" failed: ${result.error}`,
        output: context,
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
        output: context,
      };
    }

    if (result.output) {
      context[stepDef.id] = result.output;
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
  approved: Set<string>,
  maxRetries: number,
): Promise<StepResult> {
  switch (stepDef.type) {
    case "command":
      return executeCommandStep(stepDef, context, ctx, maxRetries);
    case "approval":
      if (approved.has(stepDef.id)) {
        return {
          stepId: stepDef.id,
          status: "completed",
          output: { approved: true, approvedAt: new Date().toISOString() },
        };
      }
      return { stepId: stepDef.id, status: "pending_approval" };
    case "condition":
      return executeConditionStep(stepDef, context);
    case "agent":
      return executeAgentStep(stepDef, context);
    case "parallel":
      return executeParallelStep(stepDef, context, ctx, runId, approved, maxRetries);
    default:
      return { stepId: stepDef.id, status: "failed", error: `Unknown step type: ${(stepDef as WorkflowStepDef).type}` };
  }
}

async function executeCommandStep(
  stepDef: WorkflowStepDef,
  context: Record<string, unknown>,
  ctx: WorkflowExecutionContext,
  maxRetries: number,
): Promise<StepResult> {
  if (!stepDef.command) {
    return { stepId: stepDef.id, status: "failed", error: "No command specified" };
  }

  const attempts = stepDef.onError === "retry" ? maxRetries + 1 : 1;
  let lastError = "Unknown error";

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const resolved = resolveInput(stepDef.input ?? {}, context);
      const input = normalizeFieldNames(resolved);
      const result = await executeCommand(
        ctx.registry,
        stepDef.command,
        input,
        ctx.requestCtx,
        ctx.helpers,
      );
      return {
        stepId: stepDef.id,
        status: "completed",
        output: result.data as Record<string, unknown>,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    stepId: stepDef.id,
    status: "failed",
    error: lastError,
  };
}

function executeConditionStep(
  stepDef: WorkflowStepDef,
  context: Record<string, unknown>,
): StepResult {
  if (stepDef.condition) {
    try {
      const fn = new Function("input", "state", "context", `return ${stepDef.condition}`);
      const result = fn(context.input ?? context, context, context);
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
  approved: Set<string>,
  maxRetries: number,
): Promise<StepResult> {
  const subSteps = stepDef.steps ?? [];
  const results = await Promise.all(
    subSteps.map(async (sub) => {
      const result = await executeStep(sub, context, ctx, runId, approved, maxRetries);
      return { stepId: sub.id, status: result.status, output: result.output, error: result.error };
    }),
  );
  for (const r of results) {
    if (r.output) {
      context[r.stepId] = r.output;
    }
  }
  return {
    stepId: stepDef.id,
    status: results.every((r) => r.status === "completed") ? "completed" : "failed",
    output: { parallelResults: results },
    error: results.every((r) => r.status === "completed")
      ? undefined
      : results.find((r) => r.status === "failed")?.error,
  };
}

/**
 * Resolve template variables in step input.
 * Supports:
 * - `${customerName}` — top-level context / run input key
 * - `${step1.id}` — nested path under a prior step's output
 * - `${input.total}` — explicit run-input path
 * - Nested objects/arrays recursively
 */
export function resolveInput(
  input: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    resolved[key] = resolveValue(value, context);
  }
  return resolved;
}

function resolveValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const full = value.match(/^\$\{([^}]+)\}$/);
    if (full?.[1]) {
      return lookupPath(context, full[1].trim());
    }
    // Partial interpolation: "INV-${suffix}"
    if (value.includes("${")) {
      return value.replace(/\$\{([^}]+)\}/g, (_m, path: string) => {
        const v = lookupPath(context, path.trim());
        return v === undefined || v === null ? "" : String(v);
      });
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, context));
  }
  if (value && typeof value === "object") {
    return resolveInput(value as Record<string, unknown>, context);
  }
  return value;
}

export function lookupPath(context: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = context;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Rename common LLM field aliases to schema field names (non-destructive for unknowns). */
export function normalizeFieldNames(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const canonical = FIELD_ALIASES[key] ?? key;
    // Prefer explicit canonical key if both present
    if (out[canonical] === undefined || key === canonical) {
      out[canonical] = value;
    }
  }
  return out;
}
