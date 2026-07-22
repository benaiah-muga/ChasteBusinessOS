import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { CommandMeta, CommandRegistry, RequestContext } from "@chaste/kernel";
import { executeCommand, type CommandHelpers } from "@chaste/kernel";

export interface ToolContext {
  registry: CommandRegistry;
  requestCtx: RequestContext;
  helpers: CommandHelpers;
}

const toolContextMap = new Map<string, ToolContext>();

export function setToolContext(key: string, ctx: ToolContext) {
  toolContextMap.set(key, ctx);
}

export function getToolContext(key: string): ToolContext | undefined {
  return toolContextMap.get(key);
}

export function commandToTool(
  cmd: CommandMeta,
  contextKey: string,
) {
  return createTool({
    id: cmd.name,
    description: [
      cmd.description ?? cmd.name,
      cmd.tags?.length ? `Domain: ${cmd.tags.join(", ")}` : "",
      cmd.permissions?.length ? `Requires: ${cmd.permissions.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" — "),
    inputSchema: z.record(z.unknown()),
    execute: async (inputData) => {
      const ctx = getToolContext(contextKey);
      if (!ctx) {
        throw new Error("Tool context not initialized");
      }

      const result = await executeCommand(
        ctx.registry,
        cmd.name,
        inputData,
        ctx.requestCtx,
        ctx.helpers,
      );

      return result.data as Record<string, unknown>;
    },
  });
}

export function buildCommandTools(
  registry: CommandRegistry,
  contextKey: string,
): Record<string, ReturnType<typeof commandToTool>> {
  const tools: Record<string, ReturnType<typeof commandToTool>> = {};
  for (const cmd of registry.list()) {
    tools[cmd.name] = commandToTool(cmd, contextKey);
  }
  return tools;
}

export function buildScopedTools(
  registry: CommandRegistry,
  tag: string,
  contextKey: string,
): Record<string, ReturnType<typeof commandToTool>> {
  const tools: Record<string, ReturnType<typeof commandToTool>> = {};
  for (const cmd of registry.list()) {
    if (cmd.tags?.includes(tag)) {
      tools[cmd.name] = commandToTool(cmd, contextKey);
    }
  }
  return tools;
}
