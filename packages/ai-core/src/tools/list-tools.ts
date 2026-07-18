import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { CommandRegistry, QueryRegistry } from "@chaste/kernel";

export function createListCommandsTool(registry: CommandRegistry) {
  return createTool({
    id: "list-commands",
    description: "List all available business commands in the system",
    inputSchema: z.object({}),
    execute: async () => {
      return {
        commands: registry.list().map((cmd) => ({
          name: cmd.name,
          description: cmd.description,
          tags: cmd.tags,
          permissions: cmd.permissions,
        })),
      };
    },
  });
}

export function createListQueriesTool(registry: QueryRegistry) {
  return createTool({
    id: "list-queries",
    description: "List all available business queries in the system",
    inputSchema: z.object({}),
    execute: async () => {
      return {
        queries: registry.list().map((q) => ({
          name: q.name,
          description: q.description,
          tags: q.tags,
        })),
      };
    },
  });
}
