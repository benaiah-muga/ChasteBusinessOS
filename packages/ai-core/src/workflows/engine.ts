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
      return {
        stepId: stepDef.id,
        status: "failed",
        error: `Unknown step type: ${(stepDef as WorkflowStepDef).type}`,
      };
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
    // F2 — conditions are stored untrusted strings; `evaluateCondition` is a
    // safe predicate interpreter (no `new Function`/`eval` ⇒ no RCE).
    try {
      const result = evaluateCondition(stepDef.condition, context);
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

/**
 * F2 — restricted predicate evaluator for workflow `condition` steps.
 *
 * Conditions are arbitrary LLM/user-authored strings persisted in Postgres, so
 * they must NEVER be executed as code (`new Function`/`eval` = RCE). This is a
 * dependency-free recursive-descent interpreter over a tiny safe grammar:
 *
 *   expr      := or
 *   or        := and ("||" and)*
 *   and       := equality ("&&" equality)*
 *   equality  := comparison (("==" | "!=") comparison)*
 *   comparison:= additive ((">" | "<" | ">=" | "<=") additive)*
 *   additive  := term (("+" | "-") term)*
 *   term      := unary (("*" | "/") unary)*
 *   unary     := ("!" | "-") unary | primary
 *   primary   := NUMBER | STRING | true | false | null | path | "(" expr ")"
 *   path      := IDENT ("." IDENT)*
 *
 * Identifiers resolve ONLY against the provided `scope` — never against the
 * execution environment. There is no function-call syntax, no object/array
 * literals, and no assignment, so a hostile condition can at worst read
 * undefined and evaluate to false.
 */
export function evaluateCondition(condition: string, context: Record<string, unknown>): boolean {
  // Merged keys first so bare identifiers like `total` resolve against the run
  // input (the workflow context), then the legacy `input`/`state`/`context`
  // bindings are overlaid for parity with the old `new Function` invocation.
  const scope: Record<string, unknown> = {
    ...context,
    input: context.input ?? context,
    state: context,
    context,
  };
  try {
    const tokens = tokenizeCondition(condition);
    return Boolean(new ConditionParser(tokens, scope).parse());
  } catch {
    return false;
  }
}

const CONDITION_MAX_LEN = 1000;

type ConditionToken =
  | { type: "num"; value: string }
  | { type: "str"; value: string }
  | { type: "ident"; value: string }
  | { type: "op"; value: string }
  | { type: "lparen"; value: "" }
  | { type: "rparen"; value: "" };

function tokenizeCondition(src: string): ConditionToken[] {
  if (src.length > CONDITION_MAX_LEN) throw new Error("condition too long");
  const tokens: ConditionToken[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen", value: "" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", value: "" });
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      let out = "";
      while (j < src.length && src[j] !== quote) {
        if (src[j] === "\\" && j + 1 < src.length) {
          out += src[j + 1]!;
          j += 2;
        } else {
          out += src[j]!;
          j++;
        }
      }
      if (src[j] !== quote) throw new Error("unterminated string");
      tokens.push({ type: "str", value: out });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (
      two === "==" ||
      two === "!=" ||
      two === ">=" ||
      two === "<=" ||
      two === "&&" ||
      two === "||"
    ) {
      tokens.push({ type: "op", value: two });
      i += 2;
      continue;
    }
    if ("+-*/><!".includes(ch)) {
      tokens.push({ type: "op", value: ch });
      i += 1;
      continue;
    }
    if (ch === ".") {
      tokens.push({ type: "op", value: "." });
      i += 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j++;
      tokens.push({ type: "num", value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j]!)) j++;
      const ident = src.slice(i, j);
      if (["function", "return", "new", "typeof", "delete", "void", "class"].includes(ident)) {
        throw new Error(`disallowed keyword: ${ident}`);
      }
      tokens.push({ type: "ident", value: ident });
      i = j;
      continue;
    }
    throw new Error(`unexpected character: ${ch}`);
  }
  return tokens;
}

class ConditionParser {
  private pos = 0;
  constructor(
    private readonly tokens: ConditionToken[],
    private readonly scope: Record<string, unknown>,
  ) {}

  private peek(): ConditionToken | undefined {
    return this.tokens[this.pos];
  }
  private advance(): ConditionToken {
    const t = this.tokens[this.pos];
    if (!t) throw new Error("unexpected end of condition");
    this.pos += 1;
    return t;
  }

  parse(): unknown {
    return this.parseOr();
  }

  private parseOr(): unknown {
    let left = this.parseAnd();
    while (this.peek()?.type === "op" && this.peek()?.value === "||") {
      this.advance();
      left = Boolean(left) || Boolean(this.parseAnd());
    }
    return left;
  }

  private parseAnd(): unknown {
    let left = this.parseEquality();
    while (this.peek()?.type === "op" && this.peek()?.value === "&&") {
      this.advance();
      left = Boolean(left) && Boolean(this.parseEquality());
    }
    return left;
  }

  private parseEquality(): unknown {
    let left = this.parseComparison();
    while (
      this.peek()?.type === "op" &&
      (this.peek()?.value === "==" || this.peek()?.value === "!=")
    ) {
      const op = this.advance().value as string;
      left =
        op === "=="
          ? looseEquals(left, this.parseComparison())
          : !looseEquals(left, this.parseComparison());
    }
    return left;
  }

  private parseComparison(): unknown {
    let left = this.parseAdditive();
    while (
      this.peek()?.type === "op" &&
      ["<", ">", "<=", ">="].includes(this.peek()!.value as string)
    ) {
      const op = this.advance().value as string;
      const right = this.parseAdditive();
      const a = Number(left);
      const b = Number(right);
      left =
        Number.isNaN(a) || Number.isNaN(b)
          ? false
          : op === "<"
            ? a < b
            : op === ">"
              ? a > b
              : op === "<="
                ? a <= b
                : a >= b;
    }
    return left;
  }

  private parseAdditive(): unknown {
    let left = this.parseTerm();
    while (
      this.peek()?.type === "op" &&
      (this.peek()?.value === "+" || this.peek()?.value === "-")
    ) {
      const op = this.advance().value as string;
      const right = this.parseTerm();
      if (op === "+" && (typeof left === "string" || typeof right === "string")) {
        left = String(left) + String(right);
      } else {
        left = Number(left) + (op === "+" ? Number(right) : -Number(right));
      }
    }
    return left;
  }

  private parseTerm(): unknown {
    let left = this.parseUnary();
    while (
      this.peek()?.type === "op" &&
      (this.peek()?.value === "*" || this.peek()?.value === "/")
    ) {
      const op = this.advance().value as string;
      const right = this.parseUnary();
      left = op === "*" ? Number(left) * Number(right) : Number(left) / Number(right);
    }
    return left;
  }

  private parseUnary(): unknown {
    const t = this.peek();
    if (t?.type === "op" && t.value === "!") {
      this.advance();
      return !Boolean(this.parseUnary());
    }
    if (t?.type === "op" && t.value === "-") {
      this.advance();
      return -Number(this.parseUnary());
    }
    return this.parsePrimary();
  }

  private parsePrimary(): unknown {
    const t = this.peek();
    if (!t) return undefined;
    if (t.type === "num") {
      this.advance();
      return Number(t.value);
    }
    if (t.type === "str") {
      this.advance();
      return t.value;
    }
    if (t.type === "ident") {
      if (t.value === "true") {
        this.advance();
        return true;
      }
      if (t.value === "false") {
        this.advance();
        return false;
      }
      if (t.value === "null") {
        this.advance();
        return null;
      }
      const parts = [this.advance().value];
      while (this.peek()?.type === "op" && this.peek()?.value === ".") {
        this.advance();
        const next = this.peek();
        if (!next || next.type !== "ident") throw new Error("expected identifier after '.'");
        parts.push(this.advance().value);
      }
      return resolveConditionPath(this.scope, parts);
    }
    if (t.type === "lparen") {
      this.advance();
      const value = this.parse();
      const close = this.peek();
      if (!close || close.type !== "rparen") throw new Error("missing ')'");
      this.advance();
      return value;
    }
    throw new Error("unexpected token");
  }
}

/** Resolve a dotted condition path only against workflow-scope keys (F17-safe). */
function resolveConditionPath(root: Record<string, unknown>, parts: string[]): unknown {
  let current: unknown = root;
  for (const part of parts) {
    if (part === "__proto__" || part === "constructor" || part === "prototype") return undefined;
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function looseEquals(a: unknown, b: unknown): boolean {
  // eslint-disable-next-line eqeqeq -- intentional parity with prior JS `==` semantics
  return a == b;
}

function executeAgentStep(stepDef: WorkflowStepDef, _context: Record<string, unknown>): StepResult {
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
    // F17 — never traverse prototype chains (`__proto__` / `constructor`).
    if (part === "__proto__" || part === "constructor" || part === "prototype") return undefined;
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
