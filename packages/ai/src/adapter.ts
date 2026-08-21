import type { AgentTurn, LoopMessage, ModelAdapter, ToolCall, ToolSpec } from "@chaste/kernel";
import type OpenAI from "openai";
import { nimClient } from "./nim";

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
}

/**
 * Adapts any OpenAI-compatible endpoint (NVIDIA NIM by default) to the
 * kernel's ModelAdapter contract. Streams tokens through `onDelta` while
 * accumulating streamed tool-call fragments into complete calls.
 */
export class OpenAiCompatAdapter implements ModelAdapter {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly temperature: number;

  constructor(opts: { client?: OpenAI; model?: string; temperature?: number } = {}) {
    this.client = opts.client ?? nimClient();
    this.model = opts.model ?? process.env.MODEL_PRIMARY ?? "moonshotai/kimi-k3";
    this.temperature = opts.temperature ?? 0.2;
  }

  async run(
    messages: LoopMessage[],
    tools: ToolSpec[],
    opts: { signal?: AbortSignal; onDelta?: (text: string) => void } = {},
  ): Promise<AgentTurn> {
    const mapped = messages.map((m): OpenAI.Chat.Completions.ChatCompletionMessageParam => {
      if (m.role === "assistant" && m.toolCalls?.length) {
        return {
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
          })),
        };
      }
      if (m.role === "tool") {
        return { role: "tool", content: m.content, tool_call_id: m.toolCallId ?? "adhoc" };
      }
      return { role: m.role, content: m.content };
    });

    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: mapped,
        // biome-ignore lint/suspicious/noExplicitAny: standard OpenAI tool schema
        tools: tools as OpenAI.Chat.Completions.ChatCompletionTool[],
        temperature: this.temperature,
        max_tokens: 4096,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: opts.signal },
    );

    let content = "";
    const pending = new Map<number, PendingToolCall>();
    let usage: { input: number; output: number } | undefined;

    for await (const chunk of stream) {
      // NIM surfaces usage on stream chunks; the SDK type omits it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw: any = chunk;
      if (raw.usage) {
        usage = { input: raw.usage.prompt_tokens ?? 0, output: raw.usage.completion_tokens ?? 0 };
      }
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      // NIM reasoning models stream a nonstandard reasoning_content delta.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d: any = delta;
      if (d.content) {
        content += d.content;
        opts.onDelta?.(d.content);
      }
      for (const tc of d.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const slot = pending.get(idx) ?? { id: "", name: "", args: "" };
        if (tc.id) slot.id += tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        pending.set(idx, slot);
      }
    }

    const toolCalls: ToolCall[] = [...pending.values()].map((tc, i) => ({
      id: tc.id || `call_${i}`,
      name: tc.name,
      args: safeParse(tc.args),
    }));

    return {
      message: content || null,
      toolCalls,
      usage,
    };
  }
}

function safeParse(args: string): unknown {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}
