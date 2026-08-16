import type { Actor } from "@chaste/kernel";
import type { z } from "zod";
import type { BusinessToolDefinition, ToolRegistry } from "./types.js";

/**
 * Tool registry (doc §Tool and Capability Registry). `defineBusinessTool` is
 * the doc's Agent Tool Wrapper Template; `createToolRegistry` collects tools
 * and answers visibility questions.
 */

/** Identity helper matching the doc's `defineBusinessTool` template. */
export function defineBusinessTool<TIn extends z.ZodType, TOut extends z.ZodType>(
  def: BusinessToolDefinition<TIn, TOut>,
): BusinessToolDefinition<TIn, TOut> {
  return def;
}

export function createToolRegistry(): ToolRegistry {
  const map = new Map<string, BusinessToolDefinition<z.ZodType, z.ZodType>>();

  return {
    register(tool) {
      if (map.has(tool.name)) {
        throw new Error(`Tool already registered: ${tool.name}`);
      }
      map.set(tool.name, tool as unknown as BusinessToolDefinition<z.ZodType, z.ZodType>);
    },
    get(name) {
      return map.get(name);
    },
    has(name) {
      return map.has(name);
    },
    list() {
      return [...map.values()];
    },
    listForActor(actor: Actor) {
      return [...map.values()].filter((tool) =>
        tool.exposeWhen.every((permission) => actor.permissions.has("*") || actor.permissions.has(permission)),
      );
    },
  };
}