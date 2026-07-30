import type { CommandRegistry, QueryRegistry } from "@chaste/kernel";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export function createChasteMCPServer(
  commandRegistry: CommandRegistry,
  queryRegistry: QueryRegistry,
) {
  const commands = commandRegistry.list();
  const queries = queryRegistry.list();

  const toolDefinitions: McpToolDefinition[] = [
    ...commands.map((cmd) => ({
      name: cmd.name,
      description: cmd.description ?? cmd.name,
    })),
    ...queries.map((q) => ({
      name: q.name,
      description: q.description ?? q.name,
    })),
  ];

  return {
    name: "chaste-business-os",
    version: "1.0.0",
    description:
      "ChasteBusinessOS MCP Server — exposes business operations as MCP tools for AI agents and external clients.",
    tools: toolDefinitions,
  };
}
