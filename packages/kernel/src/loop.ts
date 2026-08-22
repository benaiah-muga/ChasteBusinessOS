import type { ActionContext } from "./capability";
import type { KernelExecutor } from "./executor";
import type { CapabilityRegistry } from "./registry";

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface AgentTurn {
  message: string | null;
  toolCalls: ToolCall[];
  usage?: { input: number; output: number };
}

/**
 * The kernel is model-agnostic: apps adapt NIM/OpenAI-compat/local agents to this.
 * Tools are presented OpenAI-style so any mainstream model works.
 */
export interface ModelAdapter {
  run(
    messages: LoopMessage[],
    tools: ToolSpec[],
    opts: { signal?: AbortSignal; onDelta?: (text: string) => void },
  ): Promise<AgentTurn>;
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

export interface LoopMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present on assistant messages that requested tools (OpenAI protocol). */
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface TicketSink {
  file(orgId: string, title: string, description: string): Promise<void>;
}

export interface LoopOptions {
  sessionId: string;
  maxSteps?: number;
  systemPrompt: string;
  userGoal: string;
  onEvent?: (event: { seq: number; role: string; content: unknown }) => void;
  /** Token-level deltas from the model, for streaming UIs. */
  onDelta?: (text: string) => void;
}

const NO_CAPABILITY_NOTE =
  "No registered capability can do this. State honestly that you cannot, and call file_ticket.";

/**
 * ReAct loop: model proposes capability calls, harness executes them through
 * governance. Blocked goals become tickets, never improvisation.
 */
export async function runAgentLoop(
  model: ModelAdapter,
  registry: CapabilityRegistry,
  executor: KernelExecutor,
  ctx: ActionContext,
  opts: LoopOptions,
  tickets?: TicketSink,
): Promise<{ finalMessage: string; steps: number }> {
  const caps = registry.forActor(ctx.actor);
  // Some OpenAI-compatible providers (e.g. NIM) reject "." in function names.
  const nameOf = new Map<string, string>();
  const resolve = new Map<string, string>();
  for (const c of caps) {
    const safe = c.id.replace(/[^a-zA-Z0-9_-]/g, "_");
    nameOf.set(c.id, safe);
    resolve.set(safe, c.id);
  }
  const tools: ToolSpec[] = caps.map((c) => ({
    type: "function" as const,
    function: {
      name: nameOf.get(c.id)!,
      description: `[${c.risk}] ${c.title}. ${c.intent}`,
      parameters: zodToOpenAiSchema(c),
    },
  }));
  if (tickets) {
    tools.push({
      type: "function",
      function: {
        name: "file_ticket",
        description:
          "File a ticket for a missing capability or blocked goal. Use when no available capability fits.",
        parameters: {
          type: "object",
          properties: { title: { type: "string" }, description: { type: "string" } },
          required: ["title", "description"],
        },
      },
    });
  }

  const messages: LoopMessage[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: `${opts.userGoal}\n\n${NO_CAPABILITY_NOTE}` },
  ];

  const maxSteps = opts.maxSteps ?? 12;
  let steps = 0;
  let finalMessage = "";

  while (steps < maxSteps) {
    steps += 1;
    const turn = await model.run(messages, tools, { onDelta: opts.onDelta });
    if (turn.message) {
      finalMessage = turn.message;
      messages.push({ role: "assistant", content: turn.message });
    }
    if (turn.toolCalls.length === 0) break;

    messages.push({
      role: "assistant",
      content: turn.message ?? "",
      toolCalls: turn.toolCalls,
    });

    for (const call of turn.toolCalls) {
      opts.onEvent?.({ seq: steps, role: "tool_call", content: { name: call.name, args: call.args } });
      let result: string;
      const capId = resolve.get(call.name) ?? call.name;
      if (capId === "file_ticket") {
        const t = call.args as { title: string; description: string };
        await tickets?.file(ctx.actor.orgId, t.title, t.description);
        result = JSON.stringify({ ok: true, note: "ticket filed" });
      } else {
        const out = await executor.execute(capId, ctx, call.args);
        result = JSON.stringify(out.ok ? out.data : { error: out.error, pendingApproval: Boolean(out.pendingApproval) });
        opts.onEvent?.({ seq: steps, role: "tool_result", content: { name: capId, ok: out.ok, error: out.error } });
      }
      opts.onEvent?.({ seq: steps, role: "tool", content: { name: call.name, result } });
      messages.push({ role: "tool", content: result, toolCallId: call.id });
    }
  }

  return { finalMessage, steps };
}

/** Minimal structural projection of a zod schema to JSON Schema via zod's toJSONSchema. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function zodToOpenAiSchema(cap: any): Record<string, unknown> {
  try {
    return zodToJSONSchema(cap.input);
  } catch {
    return { type: "object", properties: {} };
  }
}

// Lazy import avoids hard dependency cycles in bundlers.
import { z } from "zod";
function zodToJSONSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
}
