import type { CommandRegistry } from "@chaste/kernel";
import type { AiProvider } from "../providers.js";
import type { ModelRouter, RouterCallContext, TaskClass } from "../model-router.js";
import type { WorkflowDefinition, WorkflowStepDef } from "./engine.js";
import { normalizeFieldNames } from "./engine.js";

export interface WorkflowBuilderConfig {
  commandRegistry: CommandRegistry;
  aiProvider: AiProvider;
  /** Optional model router; planning completions route through it with ctx. */
  router?: ModelRouter;
  routerTaskClass?: TaskClass;
}

export interface WorkflowBuilderAgent {
  aiProvider: AiProvider;
  systemPrompt: string;
  router?: ModelRouter;
  routerTaskClass: TaskClass;
}

const COMMAND_FIELD_HINTS: Record<string, string> = {
  "crm.customer.create": "{ name: string, email?: string, city?: string, country?: string }",
  "crm.customer.list": "{}",
  "acc.invoice.create": "{ number: string, total: number, currency?: string, customerId?: uuid }",
  "acc.journal.create": "{ reference: string, lines: array }",
  "inv.product.create": "{ sku: string, name: string }",
  "inv.stock.adjust": "{ productId: string, quantity: number, warehouseId?: string }",
  "pur.po.create": "{ vendorId: string, lines?: array }",
  "pur.vendor.create": "{ name: string }",
  "hr.employee.create": "{ employeeNumber: string, fullName: string }",
  "hr.payroll.prepare": "{ periodLabel: string }",
  "mfg.workorder.create": "{ productId: string, quantity: number }",
};

const BUILDER_SYSTEM_PROMPT = `You are a workflow builder for ChasteBusinessOS. Convert natural language into structured workflow definitions.

COMMAND INPUT SCHEMAS (use these exact field names — never invent aliases):
${Object.entries(COMMAND_FIELD_HINTS)
  .map(([cmd, schema]) => `- ${cmd}: ${schema}`)
  .join("\n")}

STEP TYPES:
- "command": Execute a business command (preferred for all business actions)
- "approval": Pause for human approval (only when the user asks, or before irreversible financial posts)
- "condition": Evaluate a condition
- "agent": Delegate to a specialist AI agent
- "parallel": Run multiple steps concurrently

VARIABLE REFERENCES:
- Reference prior step outputs with "\${stepId.field}" e.g. "\${step1.id}" for customerId
- Reference run input with "\${fieldName}" or "\${input.fieldName}"
- Prefer embedding literal values from the user request when they are known

WORKFLOW RULES:
1. Use exact schema field names (city not location, total not amount, customerId not customer_id)
2. Do NOT insert approval steps unless the user asks for approval/review, or the action is posting/voiding financial entries
3. Keep workflows linear unless parallel execution is explicitly needed
4. Include a descriptive name and description
5. Set onError to "bail" for critical steps, "continue" for non-critical
6. Every command step MUST include a "command" field with a registered command name

OUTPUT FORMAT:
Return ONLY a JSON object matching this exact structure:
{
  "name": "workflow name",
  "description": "what this workflow does",
  "trigger": "manual",
  "steps": [
    {
      "id": "step1",
      "type": "command",
      "command": "crm.customer.create",
      "description": "what this step does",
      "input": { "name": "Acme", "city": "Nairobi" },
      "onError": "bail"
    }
  ]
}

Do not include any text outside the JSON block. Wrap the JSON in \`\`\`json and \`\`\` markers.`;

export function createWorkflowBuilderAgent(cfg: WorkflowBuilderConfig): WorkflowBuilderAgent {
  const commandList = cfg.commandRegistry
    .list()
    .map((c) => {
      const hint = COMMAND_FIELD_HINTS[c.name];
      return hint
        ? `- ${c.name}: ${c.description ?? c.name} — input ${hint}`
        : `- ${c.name}: ${c.description ?? c.name}`;
    })
    .join("\n");

  return {
    aiProvider: cfg.aiProvider,
    systemPrompt: BUILDER_SYSTEM_PROMPT + "\n\nAVAILABLE COMMANDS:\n" + commandList,
    router: cfg.router,
    routerTaskClass: cfg.routerTaskClass ?? "planning",
  };
}

export async function generateWorkflowFromNL(
  agent: WorkflowBuilderAgent,
  request: string,
  ctx?: RouterCallContext,
): Promise<WorkflowDefinition | null> {
  const req = {
    system: agent.systemPrompt,
    user: `Create a workflow for this request: "${request}"`,
  };
  const result =
    agent.router && ctx
      ? await agent.router.complete(agent.routerTaskClass, req, ctx)
      : await agent.aiProvider.complete(req);

  const text = result.text;

  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch?.[1]) {
    const fallback = text.match(/\{[\s\S]*\}/);
    if (!fallback) return null;
    try {
      return parseWorkflowJson(fallback[0]);
    } catch {
      return null;
    }
  }

  try {
    return parseWorkflowJson(jsonMatch[1]);
  } catch {
    return null;
  }
}

function parseWorkflowJson(json: string): WorkflowDefinition {
  const parsed = JSON.parse(json) as Record<string, unknown>;

  const steps: WorkflowStepDef[] = (Array.isArray(parsed.steps) ? parsed.steps : []).map(
    (s: Record<string, unknown>, index: number) => normalizeStep(s, index),
  );

  return {
    id: `wf_${Date.now()}`,
    name: String(parsed.name ?? "Unnamed Workflow"),
    description: String(parsed.description ?? ""),
    trigger: (["manual", "event", "schedule"].includes(String(parsed.trigger))
      ? parsed.trigger
      : "manual") as WorkflowDefinition["trigger"],
    steps,
    createdBy: "ai",
    createdAt: new Date().toISOString(),
  };
}

function normalizeStep(s: Record<string, unknown>, index: number): WorkflowStepDef {
  const rawType = String(s.type ?? "command");
  const type = (
    ["command", "approval", "condition", "agent", "parallel"].includes(rawType)
      ? rawType
      : "command"
  ) as WorkflowStepDef["type"];

  const rawInput =
    typeof s.input === "object" && s.input !== null
      ? (s.input as Record<string, unknown>)
      : {};

  return {
    id: String(s.id ?? `step_${index + 1}`),
    type,
    command: s.command ? String(s.command) : undefined,
    agentId: s.agentId ? String(s.agentId) : undefined,
    condition: s.condition ? String(s.condition) : undefined,
    approveBy: s.approveBy ? String(s.approveBy) : undefined,
    description: s.description ? String(s.description) : undefined,
    input: normalizeFieldNames(rawInput),
    steps: Array.isArray(s.steps)
      ? (s.steps as Record<string, unknown>[]).map((sub, i) => normalizeStep(sub, i))
      : undefined,
    onError: (["bail", "retry", "continue"].includes(String(s.onError))
      ? s.onError
      : "bail") as WorkflowStepDef["onError"],
  };
}
