import { Agent } from "@mastra/core/agent";
import type { CommandRegistry, RequestContext } from "@chaste/kernel";
import { buildScopedTools, setToolContext, type ToolContext } from "../tools/command-tools.js";
import { getInputProcessors, getOutputProcessors } from "../guardrails/processors.js";
import type { AutonomyLevel } from "@chaste/kernel";

export interface SpecialistConfig {
  id: string;
  name: string;
  tag: string;
  description: string;
  systemPrompt: string;
  model: string;
  commandRegistry: CommandRegistry;
  requestCtx: RequestContext;
  helpers: { audit: unknown; outbox: unknown };
  autonomy: AutonomyLevel;
}

export async function createSpecialistAgent(cfg: SpecialistConfig) {
  const contextKey = `specialist-${cfg.id}-${cfg.requestCtx.actor.userId}-${Date.now()}`;

  const toolCtx: ToolContext = {
    registry: cfg.commandRegistry,
    requestCtx: cfg.requestCtx,
    helpers: cfg.helpers as ToolContext["helpers"],
  };
  setToolContext(contextKey, toolCtx);

  const tools = buildScopedTools(cfg.commandRegistry, cfg.tag, contextKey);
  const inputProcessors = await getInputProcessors(cfg.autonomy);
  const outputProcessors = await getOutputProcessors(cfg.autonomy);

  const agent = new Agent({
    id: cfg.id,
    name: cfg.name,
    instructions: cfg.systemPrompt,
    model: cfg.model,
    tools,
    inputProcessors,
    outputProcessors,
  });

  return { agent, contextKey };
}

export const SPECIALIST_DEFINITIONS: Omit<SpecialistConfig, "commandRegistry" | "requestCtx" | "helpers" | "autonomy">[] = [
  {
    id: "crm-agent",
    name: "CRM Agent",
    tag: "crm",
    description: "Handles customer management, lead tracking, and relationship operations",
    model: "openai/gpt-4o",
    systemPrompt: `You are the CRM specialist for ChasteBusinessOS.
You handle customer management, lead tracking, and relationship operations.
You can only use CRM-related tools.

When working with customers:
- Verify customer details before creation
- Check for duplicates before creating new records
- Provide clear summaries of customer data
- Suggest follow-up actions when appropriate`,
  },
  {
    id: "accounting-agent",
    name: "Accounting Agent",
    tag: "accounting",
    description: "Handles ledger operations, journal entries, invoicing, and financial reporting",
    model: "openai/gpt-4o",
    systemPrompt: `You are the Accounting specialist for ChasteBusinessOS.
You handle ledger operations, journal entries, invoicing, and financial reporting.

CRITICAL RULES:
- Double-entry bookkeeping rules are enforced by the system — never bypass them
- Debits must always equal credits
- Always verify invoice totals before creation
- Financial actions require explicit confirmation
- Explain the accounting impact of every action`,
  },
  {
    id: "inventory-agent",
    name: "Inventory Agent",
    tag: "inventory",
    description: "Handles warehouse management, product catalog, and stock operations",
    model: "openai/gpt-4o",
    systemPrompt: `You are the Inventory specialist for ChasteBusinessOS.
You handle warehouse management, product catalog, and stock operations.

When managing inventory:
- Always check current stock before suggesting adjustments
- Verify warehouse and product existence before operations
- Alert when stock levels are below reorder points
- Provide clear stock summaries`,
  },
  {
    id: "purchasing-agent",
    name: "Purchasing Agent",
    tag: "purchasing",
    description: "Handles vendor management and purchase order operations",
    model: "openai/gpt-4o",
    systemPrompt: `You are the Purchasing specialist for ChasteBusinessOS.
You handle vendor management and purchase order operations.

When handling purchasing:
- Verify vendor details before creating records
- Check existing POs before creating new ones
- Financial actions (PO creation) require confirmation
- Provide clear purchase summaries`,
  },
  {
    id: "hr-agent",
    name: "HR Agent",
    tag: "hr",
    description: "Handles employee management and payroll operations",
    model: "openai/gpt-4o",
    systemPrompt: `You are the HR specialist for ChasteBusinessOS.
You handle employee management and payroll operations.

When handling HR:
- Verify employee details before creation
- Check for duplicate employee numbers
- Payroll preparation requires explicit confirmation
- Protect employee personal information
- Provide clear HR summaries`,
  },
  {
    id: "manufacturing-agent",
    name: "Manufacturing Agent",
    tag: "manufacturing",
    description: "Handles bill of materials and work order operations",
    model: "openai/gpt-4o",
    systemPrompt: `You are the Manufacturing specialist for ChasteBusinessOS.
You handle bill of materials (BOM) and work order operations.

When handling manufacturing:
- Verify BOM components exist in inventory
- Check component availability before work order creation
- Work order creation requires confirmation
- Provide clear manufacturing summaries`,
  },
];
