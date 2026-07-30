import { Agent } from "@mastra/core/agent";
import type { CommandRegistry, QueryRegistry, RequestContext } from "@chaste/kernel";
import { buildCommandTools, setToolContext, type ToolContext } from "../tools/command-tools.js";
import { createListCommandsTool, createListQueriesTool } from "../tools/list-tools.js";
import { getInputProcessors, getOutputProcessors } from "../guardrails/processors.js";
import type { AutonomyLevel } from "@chaste/kernel";

export interface ConversationalAgentConfig {
  id?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any;
  commandRegistry: CommandRegistry;
  queryRegistry: QueryRegistry;
  requestCtx: RequestContext;
  helpers: { audit: unknown; outbox: unknown };
  autonomy: AutonomyLevel;
}

export async function createConversationalAgent(cfg: ConversationalAgentConfig) {
  const contextKey = `chat-${cfg.requestCtx.actor.userId}-${Date.now()}`;

  const toolCtx: ToolContext = {
    registry: cfg.commandRegistry,
    requestCtx: cfg.requestCtx,
    helpers: cfg.helpers as ToolContext["helpers"],
  };
  setToolContext(contextKey, toolCtx);

  const commandTools = buildCommandTools(cfg.commandRegistry, contextKey);
  const listCommands = createListCommandsTool(cfg.commandRegistry);
  const listQueries = createListQueriesTool(cfg.queryRegistry);

  const tools = {
    ...commandTools,
    list_commands: listCommands,
    list_queries: listQueries,
  };

  const systemPrompt = buildSystemPrompt(cfg.autonomy);
  const inputProcessors = await getInputProcessors(cfg.autonomy);
  const outputProcessors = await getOutputProcessors(cfg.autonomy);

  const agent = new Agent({
    id: cfg.id ?? "chaste-assistant",
    name: "ChasteBusinessOS Assistant",
    instructions: systemPrompt,
    model: cfg.model,
    tools,
    inputProcessors,
    outputProcessors,
  });

  return { agent, contextKey };
}

function buildSystemPrompt(autonomy: AutonomyLevel): string {
  return `You are the ChasteBusinessOS assistant — an AI-native business operating system for small and medium businesses.

YOUR ROLE:
- Understand the user's business intent from natural language
- Use the available business tools to fulfill their requests
- Ask 1-2 focused clarifying questions when intent is ambiguous
- Explain what you did and why after every action

RULES:
- You have access to business tools (commands). Use them to fulfill requests.
- NEVER execute destructive actions (delete, financial transfers) without explicit user confirmation.
- When intent is ambiguous, ask clarifying questions BEFORE acting.
- Always explain what you did and why after executing a tool.
- You operate under the organization's autonomy policy (current level: ${autonomy}).
- Never attempt to access files, execute code, or perform actions outside the business tools.
- If a request is outside your capabilities, say so clearly.

AUTONOMY LEVELS:
- recommend: You prepare actions but the user must initiate execution
- confirm: You prepare actions and the user confirms before execution
- guarded_auto: You can auto-execute within allowed boundaries
- full_autonomous: You can auto-execute broadly (with warnings)

Current autonomy: ${autonomy}

TOOL USAGE:
- Use list_commands to see all available business operations
- Use list_queries to see all available data lookups
- Use the domain-specific tools (crm.*, acc.*, inv.*, pur.*, hr.*, mfg.*) to execute business operations
- All tool calls are validated, permission-checked, and audited

Be helpful, concise, and business-focused. Think step-by-step for complex requests.`;
}
