import type { CommandRegistry } from "@chaste/kernel";
import type { AiProvider } from "../providers.js";
import type { WorkflowDefinition, WorkflowStepDef } from "./engine.js";

export interface WorkflowBuilderConfig {
  commandRegistry: CommandRegistry;
  aiProvider: AiProvider;
}

export interface WorkflowBuilderAgent {
  aiProvider: AiProvider;
  systemPrompt: string;
}

const BUILDER_SYSTEM_PROMPT = `You are a workflow builder for ChasteBusinessOS. Your job is to convert natural language requests into structured workflow definitions.

AVAILABLE COMMAND TYPES:
Every registered business command can be used as a workflow step with type "command".
Common commands include:
- crm.customer.create — Create a new customer
- crm.customer.list — List all customers
- acc.invoice.create — Create an invoice
- acc.journal.create — Create a journal entry
- inv.product.create — Create a product
- inv.stock.adjust — Adjust stock levels
- pur.po.create — Create a purchase order
- pur.vendor.create — Create a vendor
- hr.employee.create — Create an employee
- hr.payroll.prepare — Prepare payroll
- mfg.workorder.create — Create a work order

STEP TYPES:
- "command": Execute a business command
- "approval": Pause for human approval (use before destructive or financial actions)
- "condition": Evaluate a condition and branch
- "agent": Delegate to a specialist AI agent
- "parallel": Run multiple steps concurrently

WORKFLOW RULES:
1. Financial actions (invoices, journal entries, payroll) MUST have an approval step before them
2. Steps can reference previous step outputs using "\${stepId}" syntax in input values
3. Keep workflows linear unless parallel execution is explicitly needed
4. Include descriptive names for each step
5. Set onError to "bail" for critical steps, "continue" for non-critical

OUTPUT FORMAT:
Return ONLY a JSON object matching this exact structure:
{
  "name": "workflow name",
  "description": "what this workflow does",
  "trigger": "manual",
  "steps": [
    {
      "id": "step_id",
      "type": "command|approval|condition|agent|parallel",
      "command": "command.name",
      "description": "what this step does",
      "input": { "field": "value" },
      "onError": "bail"
    }
  ]
}

Do not include any text outside the JSON block. Wrap the JSON in \`\`\`json and \`\`\` markers.`;

export function createWorkflowBuilderAgent(cfg: WorkflowBuilderConfig): WorkflowBuilderAgent {
  const commandList = cfg.commandRegistry
    .list()
    .map((c) => `- ${c.name}: ${c.description ?? c.name}`)
    .join("\n");

  return {
    aiProvider: cfg.aiProvider,
    systemPrompt: BUILDER_SYSTEM_PROMPT + "\n\nAVAILABLE COMMANDS:\n" + commandList,
  };
}

export async function generateWorkflowFromNL(
  agent: WorkflowBuilderAgent,
  request: string,
): Promise<WorkflowDefinition | null> {
  const result = await agent.aiProvider.complete({
    system: agent.systemPrompt,
    user: `Create a workflow for this request: "${request}"`,
  });

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
    (s: Record<string, unknown>) => ({
      id: String(s.id ?? `step_${Date.now()}`),
      type: (["command", "approval", "condition", "agent", "parallel"].includes(String(s.type))
        ? s.type
        : "command") as WorkflowStepDef["type"],
      command: s.command ? String(s.command) : undefined,
      agentId: s.agentId ? String(s.agentId) : undefined,
      condition: s.condition ? String(s.condition) : undefined,
      approveBy: s.approveBy ? String(s.approveBy) : undefined,
      description: s.description ? String(s.description) : undefined,
      input: (typeof s.input === "object" && s.input !== null ? s.input : {}) as Record<string, unknown>,
      steps: Array.isArray(s.steps)
        ? (s.steps as Record<string, unknown>[]).map((sub) => ({
            id: String(sub.id ?? `sub_${Date.now()}`),
            type: (["command", "approval", "condition", "agent", "parallel"].includes(String(sub.type))
              ? sub.type
              : "command") as WorkflowStepDef["type"],
            command: sub.command ? String(sub.command) : undefined,
            description: sub.description ? String(sub.description) : undefined,
            input: (typeof sub.input === "object" && sub.input !== null ? sub.input : {}) as Record<string, unknown>,
            onError: (["bail", "retry", "continue"].includes(String(sub.onError))
              ? sub.onError
              : "bail") as WorkflowStepDef["onError"],
          }))
        : undefined,
      onError: (["bail", "retry", "continue"].includes(String(s.onError))
        ? s.onError
        : "bail") as WorkflowStepDef["onError"],
    }),
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
