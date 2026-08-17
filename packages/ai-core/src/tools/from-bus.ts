import type { CommandRegistry, QueryRegistry } from "@chaste/kernel";
import type { z } from "zod";
import { createToolRegistry, defineBusinessTool } from "./registry.js";
import type { ToolRegistry } from "./types.js";

/**
 * Generic command/query → tool adapter (research doc §Tool and Capability
 * Registry, build item 6: "tool registry that wraps command/query bus only").
 *
 * The harness's tool surface is populated *from the bus*: every registered
 * command and query becomes a tool whose `command` is the bus name, whose
 * `exposeWhen` is the command's own permission strings, and whose input/output
 * are the very Zod contracts the bus validates. No tool implements business
 * logic and none may hide a write outside the bus — the pipeline dispatches
 * through `dispatchCommand`/`executeQuery` under the actor's own (never
 * elevated) permissions, exactly like the harness's hand-authored tools.
 *
 * Risk is *not* invented here: with no `risk` override the execution pipeline
 * derives it from the command metadata via `classify`, so a tool can never
 * disagree with the command it wraps.
 */

export interface BusToolInfo {
  /** Dotted bus name, e.g. `activities.create`. */
  name: string;
  kind: "command" | "query";
  permissions: string[];
  tags?: string[];
}

/** Tool-facing name for a dotted bus name (`activities.create` → `activities_create`). */
export function toolNameForBusName(name: string): string {
  return name.replaceAll(".", "_");
}

export interface BuildToolsFromBusOptions {
  commands: CommandRegistry;
  queries: QueryRegistry;
  /** Restrict which bus entries become tools; default: every command/query. */
  include?: (def: BusToolInfo) => boolean;
}

export function buildToolsFromBus(opts: BuildToolsFromBusOptions): ToolRegistry {
  const registry = createToolRegistry();

  const register = (
    kind: "command" | "query",
    meta: { name: string; permissions: string[]; tags?: string[]; description?: string },
    input: z.ZodType,
    output: z.ZodType,
  ): void => {
    const info: BusToolInfo = { name: meta.name, kind, permissions: meta.permissions, tags: meta.tags };
    if (opts.include && !opts.include(info)) return;
    registry.register(
      defineBusinessTool({
        name: toolNameForBusName(meta.name),
        description: meta.description ?? `${kind} ${meta.name} through the command/query bus`,
        kind,
        command: meta.name,
        exposeWhen: meta.permissions,
        input,
        output,
        idempotent: kind === "query",
      }),
    );
  };

  for (const meta of opts.commands.list()) {
    const def = opts.commands.get(meta.name);
    if (!def) continue;
    register("command", meta, def.input, def.output);
  }
  for (const meta of opts.queries.list()) {
    const def = opts.queries.get(meta.name);
    if (!def) continue;
    register("query", meta, def.input, def.output);
  }

  return registry;
}
