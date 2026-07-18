import { Agent } from "@mastra/core/agent";
import type { CommandRegistry, RequestContext } from "@chaste/kernel";
import { buildCommandTools, setToolContext, type ToolContext } from "../tools/command-tools.js";
import { createListCommandsTool, createListQueriesTool } from "../tools/list-tools.js";
import { getInputProcessors, getOutputProcessors } from "../guardrails/processors.js";
import type { QueryRegistry } from "@chaste/kernel";
import type { AutonomyLevel } from "@chaste/kernel";
import { SPECIALIST_DEFINITIONS, createSpecialistAgent } from "./specialists.js";

export interface SupervisorConfig {
  model: string;
  commandRegistry: CommandRegistry;
  queryRegistry: QueryRegistry;
  requestCtx: RequestContext;
  helpers: { audit: unknown; outbox: unknown };
  autonomy: AutonomyLevel;
}

export async function createSupervisorAgent(cfg: SupervisorConfig) {
  const contextKey = `supervisor-${cfg.requestCtx.actor.userId}-${Date.now()}`;

  const toolCtx: ToolContext = {
    registry: cfg.commandRegistry,
    requestCtx: cfg.requestCtx,
    helpers: cfg.helpers as ToolContext["helpers"],
  };
  setToolContext(contextKey, toolCtx);

  const commandTools = buildCommandTools(cfg.commandRegistry, contextKey);
  const listCommands = createListCommandsTool(cfg.commandRegistry);
  const listQueries = createListQueriesTool(cfg.queryRegistry);

  const specialistAgents: Record<string, Agent> = {};
  for (const def of SPECIALIST_DEFINITIONS) {
    const specialist = await createSpecialistAgent({
      ...def,
      commandRegistry: cfg.commandRegistry,
      requestCtx: cfg.requestCtx,
      helpers: cfg.helpers,
      autonomy: cfg.autonomy,
    });
    specialistAgents[def.id] = specialist.agent;
  }

  const inputProcessors = await getInputProcessors(cfg.autonomy);
  const outputProcessors = await getOutputProcessors(cfg.autonomy);

  const agent = new Agent({
    id: "chaste-supervisor",
    name: "ChasteBusinessOS Supervisor",
    instructions: buildSupervisorPrompt(cfg.autonomy),
    model: cfg.model,
    agents: specialistAgents,
    tools: {
      ...commandTools,
      list_commands: listCommands,
      list_queries: listQueries,
    },
    inputProcessors,
    outputProcessors,
  });

  return { agent, contextKey };
}

function buildSupervisorPrompt(autonomy: AutonomyLevel): string {
  return `You are the main coordinator for ChasteBusinessOS — an AI-native business operating system.

YOUR ROLE:
- Understand the user's business intent from natural language
- Route to the appropriate specialist agent when the request is domain-specific
- Coordinate multi-domain requests across specialists
- Ask clarifying questions when intent is ambiguous
- Explain what each specialist did after coordination

SPECIALIST AGENTS:
You have access to these specialist agents:
- agent-crm-agent: Customer management, lead tracking, relationships
- agent-accounting-agent: Ledger, journal entries, invoicing, financial reporting
- agent-inventory-agent: Warehouses, products, stock management
- agent-purchasing-agent: Vendors, purchase orders
- agent-hr-agent: Employees, payroll
- agent-manufacturing-agent: BOMs, work orders

MULTI-DOMAIN REQUESTS:
Some requests span multiple domains. For example:
- "Open a second branch in Nairobi" → CRM + HR + Inventory + Accounting
- "Fulfill this order" → Inventory + Purchasing (if stock low) + Accounting
- "Set up a new employee" → HR + Accounting (payroll)

For multi-domain requests, coordinate specialists sequentially. Explain what each specialist did.

RULES:
- You operate under autonomy level: ${autonomy}
- NEVER execute destructive actions without explicit user confirmation
- Always explain your reasoning before acting
- Use the direct tools for simple cross-domain operations
- Delegate to specialists for domain-specific deep work
- If a request is outside your capabilities, say so clearly

Be helpful, concise, and business-focused. Think step-by-step for complex requests.`;
}
