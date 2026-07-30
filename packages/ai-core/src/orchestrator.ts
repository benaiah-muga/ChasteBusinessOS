import {
  type AutonomyLevel,
  type CommandMeta,
  type CommandRegistry,
  type QueryRegistry,
  type RequestContext,
  canAutoExecute,
  executeCommand,
  type CommandHelpers,
  stricterAutonomy,
  FULL_AUTONOMOUS_WARNING,
} from "@chaste/kernel";
import type { ChatMessage, UiPart } from "@chaste/ui-schema";
import type { AiExplanation } from "./explanation.js";
import { toExplanationPart } from "./explanation.js";
import type { AiProvider } from "./providers.js";
import { generateSuggestions } from "./suggestions.js";
import { normalizeFieldNames, resolveInput } from "./workflows/engine.js";
import { looksLikePromptInjection, shouldCheckInjection } from "./guardrails/index.js";

export interface PendingPlanStep {
  command: string;
  input: unknown;
  description: string;
}

export interface PendingConfirmation {
  id: string;
  command: string;
  input: unknown;
  createdAt: string;
  /** When set, confirmation executes all plan steps in order. */
  plan?: PendingPlanStep[];
}

export interface ChatSessionState {
  id: string;
  messages: ChatMessage[];
  pending?: PendingConfirmation;
}

export interface OrchestratorDeps {
  commands: CommandRegistry;
  queries: QueryRegistry;
  helpers: CommandHelpers;
  autonomy: AutonomyLevel;
  provider?: AiProvider;
  allowFullAutonomous?: boolean;
}

export interface ChatTurnInput {
  session: ChatSessionState;
  userText?: string;
  confirmId?: string;
  cancelId?: string;
  ctx: RequestContext;
}

export interface ChatTurnResult {
  session: ChatSessionState;
  explanation?: AiExplanation;
}

function msg(role: ChatMessage["role"], parts: UiPart[]): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    parts,
    createdAt: new Date().toISOString(),
  };
}

export interface PlannedAction {
  command: string;
  input: Record<string, unknown>;
  summary: string;
  specialist?: string;
}

/** Split compound requests into segments for multi-step planning. */
function splitCompoundRequest(text: string): string[] {
  const parts = text
    .split(/\s+(?:and also|then|and then|, then)\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length > 1) return parts;

  // "create X and create Y" / "create X and also create Y"
  const andCreate = text.split(/\s+and\s+(?=create\s+|prepare\s+)/i);
  if (andCreate.length > 1) {
    return andCreate.map((p) => p.trim()).filter(Boolean);
  }
  return [text.trim()];
}

/** Parse a single intent segment (no compound splitting). */
function planSingleSegment(text: string): PlannedAction | null {
  const trimmed = text.trim().replace(/[.!]+$/, "");

  let m = trimmed.match(
    /^create\s+customer\s+(.+?)(?:\s+in\s+([A-Za-z][A-Za-z\s-]+))?$/i,
  );
  if (m?.[1]) {
    return {
      command: "crm.customer.create",
      input: { name: m[1].trim(), city: m[2]?.trim() },
      summary: `Create customer ${m[1].trim()}`,
      specialist: "crm",
    };
  }

  m = trimmed.match(/^prepare\s+payroll\s+for\s+(.+)$/i);
  if (m?.[1]) {
    return {
      command: "hr.payroll.prepare",
      input: { periodLabel: m[1].trim() },
      summary: `Prepare payroll for ${m[1].trim()}`,
      specialist: "hr",
    };
  }

  m = trimmed.match(
    /^create\s+(?:invoice|bill)\s+(\S+)(?:\s+for\s+([\d.]+))?(?:\s+([A-Z]{3}))?$/i,
  );
  if (m?.[1]) {
    return {
      command: "acc.invoice.create",
      input: {
        number: m[1],
        total: m[2] ? Number(m[2]) : 0,
        currency: m[3] ?? "USD",
      },
      summary: `Create invoice ${m[1]}`,
      specialist: "accounting",
    };
  }

  m = trimmed.match(/^create\s+vendor\s+(.+)$/i);
  if (m?.[1]) {
    return {
      command: "pur.vendor.create",
      input: { name: m[1].trim() },
      summary: `Create vendor ${m[1].trim()}`,
      specialist: "purchasing",
    };
  }

  m = trimmed.match(/^create\s+product\s+(\S+)\s+(.+)$/i);
  if (m?.[1] && m[2]) {
    return {
      command: "inv.product.create",
      input: { sku: m[1], name: m[2].trim() },
      summary: `Create product ${m[1]} (${m[2].trim()})`,
      specialist: "inventory",
    };
  }

  m = trimmed.match(/^create\s+employee\s+(\S+)\s+(.+)$/i);
  if (m?.[1] && m[2]) {
    return {
      command: "hr.employee.create",
      input: { employeeNumber: m[1], fullName: m[2].trim() },
      summary: `Create employee ${m[2].trim()}`,
      specialist: "hr",
    };
  }

  return null;
}

/**
 * Deterministic multi-domain intent parser (always available; LLM is optional assist).
 * Returns the first matched action for back-compat with single-intent callers.
 */
export function planFromText(text: string): PlannedAction | null {
  const many = planManyFromText(text);
  return many[0] ?? null;
}

/** Parse one or more sequential intents from a compound natural-language request. */
export function planManyFromText(text: string): PlannedAction[] {
  const segments = splitCompoundRequest(text);
  const plans: PlannedAction[] = [];
  for (const segment of segments) {
    const plan = planSingleSegment(segment);
    if (plan) plans.push(plan);
  }
  // Fall back: try whole string if compound split produced nothing useful
  if (plans.length === 0) {
    const single = planSingleSegment(text.trim());
    if (single) plans.push(single);
  }
  return wireSequentialPlanInputs(plans);
}

/**
 * When multi-step plans omit cross-step links (e.g. invoice without customerId),
 * inject `${stepN.field}` templates so execution can resolve prior outputs.
 */
export function wireSequentialPlanInputs(plans: PlannedAction[]): PlannedAction[] {
  if (plans.length < 2) return plans;
  return plans.map((plan, index) => {
    if (index === 0) return plan;
    const input = { ...plan.input };
    const prior = plans.slice(0, index);

    if (
      (plan.command === "acc.invoice.create" || plan.command.startsWith("acc.invoice.")) &&
      input.customerId == null
    ) {
      const custIdx = prior.findIndex((p) => p.command === "crm.customer.create");
      if (custIdx >= 0) input.customerId = `\${step${custIdx + 1}.id}`;
    }

    if (
      (plan.command === "inv.stock.adjust" || plan.command.startsWith("inv.stock.")) &&
      input.productId == null
    ) {
      const prodIdx = prior.findIndex((p) => p.command === "inv.product.create");
      if (prodIdx >= 0) input.productId = `\${step${prodIdx + 1}.id}`;
    }

    if (
      (plan.command === "pur.po.create" || plan.command.startsWith("pur.po.")) &&
      input.vendorId == null
    ) {
      const vendIdx = prior.findIndex((p) => p.command === "pur.vendor.create");
      if (vendIdx >= 0) input.vendorId = `\${step${vendIdx + 1}.id}`;
    }

    return { ...plan, input };
  });
}

/**
 * Resolve step input against prior step outputs + auto-fill common foreign keys.
 */
export function resolvePlanStepInput(
  command: string,
  rawInput: unknown,
  stepOutputs: { command: string; data: Record<string, unknown> }[],
  stepIndex: number,
): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  stepOutputs.forEach((s, i) => {
    context[`step${i + 1}`] = s.data;
    context[s.command] = s.data;
  });

  const base =
    typeof rawInput === "object" && rawInput !== null
      ? normalizeFieldNames({ ...(rawInput as Record<string, unknown>) })
      : {};
  const resolved = resolveInput(base, context) as Record<string, unknown>;

  // Auto-wire when templates were not present
  if (
    (command === "acc.invoice.create" || command.startsWith("acc.invoice.")) &&
    (resolved.customerId == null || resolved.customerId === "")
  ) {
    const cust = [...stepOutputs].reverse().find((s) => s.command === "crm.customer.create");
    if (cust?.data.id != null) resolved.customerId = cust.data.id;
  }
  if (
    (command === "inv.stock.adjust" || command.startsWith("inv.stock.")) &&
    (resolved.productId == null || resolved.productId === "")
  ) {
    const prod = [...stepOutputs].reverse().find((s) => s.command === "inv.product.create");
    if (prod?.data.id != null) resolved.productId = prod.data.id;
  }
  if (
    (command === "pur.po.create" || command.startsWith("pur.po.")) &&
    (resolved.vendorId == null || resolved.vendorId === "")
  ) {
    const vend = [...stepOutputs].reverse().find((s) => s.command === "pur.vendor.create");
    if (vend?.data.id != null) resolved.vendorId = vend.data.id;
  }

  void stepIndex;
  return resolved;
}

async function executePlanSteps(
  deps: OrchestratorDeps,
  steps: PendingPlanStep[],
  aiCtx: RequestContext,
): Promise<{ command: string; data: Record<string, unknown> }[]> {
  const stepOutputs: { command: string; data: Record<string, unknown> }[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const input = resolvePlanStepInput(step.command, step.input, stepOutputs, i);
    const result = await executeCommand(deps.commands, step.command, input, aiCtx, deps.helpers);
    stepOutputs.push({
      command: step.command,
      data: result.data as Record<string, unknown>,
    });
  }
  return stepOutputs;
}

export async function handleChatTurn(
  deps: OrchestratorDeps,
  input: ChatTurnInput,
): Promise<ChatTurnResult> {
  const session = {
    ...input.session,
    messages: [...input.session.messages],
  };

  if (input.cancelId && session.pending?.id === input.cancelId) {
    session.pending = undefined;
    session.messages.push(
      msg("assistant", [{ type: "text", text: "Cancelled. No changes were made." }]),
    );
    return { session };
  }

  if (
    input.userText &&
    shouldCheckInjection(deps.autonomy) &&
    looksLikePromptInjection(input.userText)
  ) {
    session.messages.push(
      msg("assistant", [
        {
          type: "error",
          message: "That message was blocked by a safety check. Please rephrase your business request.",
          code: "PROMPT_INJECTION",
        },
      ]),
    );
    return { session };
  }

  if (input.confirmId && session.pending?.id === input.confirmId) {
    const pending = session.pending;
    const aiCtx: RequestContext = {
      ...input.ctx,
      actor: {
        ...input.ctx.actor,
        kind: "ai_assisted",
        aiRunId: input.ctx.actor.aiRunId ?? crypto.randomUUID(),
      },
    };

    const stepsToRun: PendingPlanStep[] =
      pending.plan && pending.plan.length > 0
        ? pending.plan
        : [{ command: pending.command, input: pending.input, description: pending.command }];

    const stepOutputs = await executePlanSteps(deps, stepsToRun, aiCtx);

    session.pending = undefined;
    const last = stepOutputs[stepOutputs.length - 1]!;
    const explanation: AiExplanation = {
      runId: aiCtx.actor.aiRunId!,
      summary:
        stepOutputs.length > 1
          ? `Executed ${stepOutputs.length}-step plan after user confirmation.`
          : `Executed ${pending.command} after user confirmation.`,
      reasons: ["User confirmed the prepared action", "Same command path as manual UI"],
      rulesApplied: ["ai_manual_parity", "permission_check", "zod_validation", "autonomy:confirm"],
      dataUsed: ["user confirmation", "prepared command input"],
      autonomy: "confirm",
      plannedCommand: pending.command,
      plannedInput: pending.input,
    };

    const parts: UiPart[] = [
      {
        type: "text",
        text:
          stepOutputs.length > 1
            ? `Done. Executed ${stepOutputs.length} steps: ${stepOutputs.map((s) => `\`${s.command}\``).join(", ")}.`
            : `Done. Executed \`${pending.command}\`.`,
      },
      toExplanationPart(explanation),
    ];

    if (stepOutputs.length > 1) {
      parts.push({
        type: "table",
        columns: [
          { key: "step", label: "Step" },
          { key: "command", label: "Command" },
          { key: "result", label: "Result" },
        ],
        rows: stepOutputs.map((s, i) => ({
          step: String(i + 1),
          command: s.command,
          result: JSON.stringify(s.data).slice(0, 120),
        })),
      });
    } else {
      parts.push({
        type: "table",
        columns: [
          { key: "field", label: "Field" },
          { key: "value", label: "Value" },
        ],
        rows: Object.entries(last.data).map(([field, value]) => ({
          field,
          value: String(value ?? ""),
        })),
      });
    }

    session.messages.push(msg("assistant", parts));

    // Generate proactive follow-up suggestions for the last command
    try {
      const { suggestions } = await generateSuggestions(last.command, last.data, deps.provider);
      if (suggestions.length > 0) {
        session.messages.push(msg("assistant", [{ type: "suggestions", suggestions }]));
      }
    } catch {
      // suggestions are optional — don't fail on errors
    }

    return { session, explanation };
  }

  if (!input.userText?.trim()) {
    session.messages.push(
      msg("assistant", [{ type: "text", text: "Send a message or confirm a pending action." }]),
    );
    return { session };
  }

  session.messages.push(msg("user", [{ type: "text", text: input.userText }]));

  const catalog = deps.commands.list();
  const rulePlans = planManyFromText(input.userText);
  let planned: PlannedAction | null = rulePlans.length === 1 ? rulePlans[0]! : null;
  let multiPlan: PlannedAction[] | null = rulePlans.length > 1 ? rulePlans : null;

  // Optional LLM assist when rules miss (provider may be none)
  if (!planned && !multiPlan && deps.provider && deps.provider.id !== "none") {
    try {
      const toolList = catalog.map((c) => c.name).join(", ");
      const completion = await deps.provider.complete({
        system:
          `You map user requests to JSON actions using only: ${toolList}.\n` +
          `For a single action: {"command":"...","input":{...}}\n` +
          `For multiple sequential actions: {"plan":[{"command":"...","input":{...},"description":"..."},{"command":"...","input":{...}}]}\n` +
          `If ambiguous or missing required info: {"clarify":["question1","question2"]}\n` +
          `Reply JSON only. Never invent field values — use null for unknown required fields.`,
        messages: session.messages,
      });
      const jsonMatch = completion.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as {
          command?: string;
          input?: Record<string, unknown>;
          clarify?: string[];
          plan?: { command: string; input?: Record<string, unknown>; description?: string }[];
        };
        if (parsed.clarify && parsed.clarify.length > 0) {
          session.messages.push({
            id: crypto.randomUUID(),
            role: "assistant",
            parts: [
              { type: "text" as const, text: "I need a bit more information to proceed." },
              { type: "clarify" as const, questions: parsed.clarify },
            ],
            createdAt: new Date().toISOString(),
          });
          return { session, explanation: undefined };
        }
        if (parsed.plan && parsed.plan.length > 0) {
          const steps = wireSequentialPlanInputs(
            parsed.plan
              .filter((s) => s.command && catalog.some((c) => c.name === s.command))
              .map((s) => ({
                command: s.command!,
                input: normalizeFieldNames(s.input ?? {}),
                summary: s.description ?? `Execute ${s.command}`,
                specialist: catalog.find((c) => c.name === s.command)?.tags?.[0],
              })),
          );
          if (steps.length > 1) {
            multiPlan = steps;
          } else if (steps.length === 1) {
            planned = steps[0]!;
          }
        }
        if (!planned && !multiPlan && parsed.command && catalog.some((c) => c.name === parsed.command)) {
          planned = {
            command: parsed.command,
            input: parsed.input ?? {},
            summary: `LLM-planned ${parsed.command}`,
            specialist: catalog.find((c) => c.name === parsed.command)?.tags?.[0],
          };
        }
      }
    } catch {
      // fall through to help text
    }
  }

  // Multi-step plan from rules or LLM
  if (multiPlan && multiPlan.length > 1) {
    const planSteps = multiPlan.map((p) => ({
      command: p.command,
      description: p.summary,
      input: p.input,
    }));
    const effectiveMulti = stricterAutonomy(deps.autonomy, deps.autonomy);
    const runIdMulti = crypto.randomUUID();
    const explanation: AiExplanation = {
      runId: runIdMulti,
      summary: `${multiPlan.length}-step plan prepared`,
      reasons: multiPlan.map((p) => p.summary),
      rulesApplied: [
        "ai_manual_parity",
        "multi_step_plan",
        `autonomy:${effectiveMulti}`,
        "zod_validation_on_execute",
      ],
      dataUsed: ["user message", "command catalog"],
      autonomy: effectiveMulti,
      plannedCommand: multiPlan.map((p) => p.command).join(" → "),
      plannedInput: { steps: planSteps },
    };

    if (canAutoExecute(effectiveMulti)) {
      const aiCtx: RequestContext = {
        ...input.ctx,
        actor: { ...input.ctx.actor, kind: "ai_assisted", aiRunId: runIdMulti },
      };
      const stepOutputs = await executePlanSteps(
        deps,
        multiPlan.map((p) => ({
          command: p.command,
          input: p.input,
          description: p.summary,
        })),
        aiCtx,
      );
      session.messages.push(
        msg("assistant", [
          {
            type: "text",
            text: `Executed ${stepOutputs.length}-step plan automatically (autonomy=${effectiveMulti}).`,
          },
          { type: "plan", id: runIdMulti, title: "Multi-step plan", steps: planSteps },
          toExplanationPart(explanation),
          {
            type: "table",
            columns: [
              { key: "step", label: "Step" },
              { key: "command", label: "Command" },
              { key: "result", label: "Result" },
            ],
            rows: stepOutputs.map((s, i) => ({
              step: String(i + 1),
              command: s.command,
              result: JSON.stringify(s.data).slice(0, 120),
            })),
          },
        ]),
      );
      return { session, explanation };
    }

    const confirmId = crypto.randomUUID();
    session.pending = {
      id: confirmId,
      command: multiPlan[0]!.command,
      input: multiPlan[0]!.input,
      plan: planSteps.map((s) => ({
        command: s.command,
        input: s.input,
        description: s.description,
      })),
      createdAt: new Date().toISOString(),
    };
    session.messages.push(
      msg("assistant", [
        {
          type: "text",
          text: `I've prepared a ${multiPlan.length}-step plan. Confirm to execute each step sequentially through the same command path as the manual UI.`,
        },
        {
          type: "plan",
          id: confirmId,
          title: "Multi-step plan",
          steps: planSteps,
        },
        toExplanationPart(explanation),
        {
          type: "confirm_action",
          id: confirmId,
          title: `Execute ${multiPlan.length}-step plan`,
          description: multiPlan.map((p) => p.summary).join(" → "),
          command: multiPlan.map((p) => p.command).join(", "),
          input: { steps: planSteps },
          confirmLabel: effectiveMulti === "recommend" ? "Disabled" : "Confirm all",
          cancelLabel: "Cancel",
        },
      ]),
    );
    return { session, explanation };
  }

  if (!planned) {
    session.messages.push(
      msg("assistant", [
        {
          type: "text",
          text:
            "I can prepare validated business actions. Examples:\n" +
            "• Create customer Acme Ltd in Nairobi\n" +
            "• Create invoice INV-1001 for 250.00 USD\n" +
            "• Create vendor Contoso Supplies\n" +
            "• Create product SKU-1 Widget\n" +
            "• Create employee E-100 Jane Doe\n" +
            "• Prepare payroll for March 2026",
        },
        {
          type: "explanation",
          summary: "No structured intent matched.",
          reasons: ["Rule parser and optional LLM did not produce a valid command"],
          rulesApplied: ["intent_validation"],
          dataUsed: ["user message", "command catalog", `provider:${deps.provider?.id ?? "none"}`],
        },
      ]),
    );
    return { session };
  }

  const meta = catalog.find((c) => c.name === planned!.command) as CommandMeta | undefined;
  if (!meta) {
    session.messages.push(
      msg("assistant", [
        {
          type: "error",
          message: `Command ${planned.command} is not available (module not loaded).`,
          code: "MODULE_MISSING",
        },
      ]),
    );
    return { session };
  }

  const effective = stricterAutonomy(deps.autonomy, deps.autonomy);
  const runId = crypto.randomUUID();

  const explanation: AiExplanation = {
    runId,
    summary: planned.summary,
    reasons: [
      "Matched business intent",
      planned.specialist ? `Specialist tag: ${planned.specialist}` : "General routing",
      "Tool is module command — not a privileged AI API",
    ],
    rulesApplied: [
      "ai_manual_parity",
      `autonomy:${effective}`,
      "zod_validation_on_execute",
      "permission_check_on_execute",
    ],
    dataUsed: ["user message", "command catalog", "org autonomy policy"],
    autonomy: effective,
    plannedCommand: planned.command,
    plannedInput: planned.input,
  };

  if (effective === "full_autonomous" && deps.allowFullAutonomous === false) {
    session.messages.push(
      msg("assistant", [
        {
          type: "error",
          message: "Full autonomous mode is not enabled on this platform.",
          code: "AUTONOMY_DISABLED",
        },
        {
          type: "text",
          text: FULL_AUTONOMOUS_WARNING,
        },
      ]),
    );
    return { session };
  }

  if (canAutoExecute(effective)) {
    const aiCtx: RequestContext = {
      ...input.ctx,
      actor: { ...input.ctx.actor, kind: "ai_assisted", aiRunId: runId },
    };
    const result = await executeCommand(
      deps.commands,
      planned.command,
      planned.input,
      aiCtx,
      deps.helpers,
    );
    const parts: UiPart[] = [
      { type: "text", text: `Executed automatically (autonomy=${effective}).` },
      toExplanationPart(explanation),
    ];
    if (effective === "full_autonomous") {
      parts.push({ type: "text", text: FULL_AUTONOMOUS_WARNING });
    }
    parts.push({
      type: "table",
      columns: [
        { key: "field", label: "Field" },
        { key: "value", label: "Value" },
      ],
      rows: Object.entries(result.data as Record<string, unknown>).map(([field, value]) => ({
        field,
        value: String(value ?? ""),
      })),
    });
    session.messages.push(msg("assistant", parts));
    return { session, explanation };
  }

  const confirmId = crypto.randomUUID();
  session.pending = {
    id: confirmId,
    command: planned.command,
    input: planned.input,
    createdAt: new Date().toISOString(),
  };

  const recommendOnly = effective === "recommend";
  session.messages.push(
    msg("assistant", [
      {
        type: "text",
        text: recommendOnly
          ? "Recommendation only (autonomy=recommend). Raise autonomy to confirm or auto-execute."
          : "Prepared a validated action. Confirm to run it through the same business command as the manual UI.",
      },
      toExplanationPart(explanation),
      {
        type: "confirm_action",
        id: confirmId,
        title: planned.summary,
        description: `${planned.command}`,
        command: planned.command,
        input: planned.input,
        confirmLabel: recommendOnly ? "Disabled" : "Confirm",
        cancelLabel: "Cancel",
      },
    ]),
  );

  return { session, explanation };
}
