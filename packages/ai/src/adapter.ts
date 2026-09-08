import type { AgentTurn, LoopMessage, ModelAdapter, ToolCall, ToolSpec } from "@chaste/kernel";
import type OpenAI from "openai";
import { nimClient } from "./providers";

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
  /** Optional secondary route used when the primary is rate-limited (429). */
  private readonly fallback?: { client: OpenAI; model: string };

  constructor(
    opts: {
      client?: OpenAI;
      model?: string;
      temperature?: number;
      fallback?: { client: OpenAI; model: string };
    } = {},
  ) {
    this.client = opts.client ?? nimClient();
    this.model = opts.model ?? process.env.MODEL_PRIMARY ?? "moonshotai/kimi-k3";
    this.temperature = opts.temperature ?? 0.2;
    this.fallback = opts.fallback;
  }

  private isRateLimit(err: unknown): boolean {
    const e = err as { status?: number; message?: string };
    return e?.status === 429 || /rate.?limit/i.test(e?.message ?? "");
  }

  async run(
    messages: LoopMessage[],
    tools: ToolSpec[],
    opts: { signal?: AbortSignal; onDelta?: (text: string) => void } = {},
  ): Promise<AgentTurn> {
    try {
      return await this.runWith(this.client, this.model, messages, tools, opts);
    } catch (err) {
      if (this.fallback && this.isRateLimit(err)) {
        return this.runWith(this.fallback.client, this.fallback.model, messages, tools, opts);
      }
      throw err;
    }
  }

  private async runWith(
    client: OpenAI,
    model: string,
    messages: LoopMessage[],
    tools: ToolSpec[],
    opts: { signal?: AbortSignal; onDelta?: (text: string) => void },
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

    const stream = await client.chat.completions.create(
      {
        model,
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
    let reasoning = "";
    const pending = new Map<number, PendingToolCall>();
    let usage: { input: number; output: number; cachedInput?: number } | undefined;

    for await (const chunk of stream) {
      // NIM surfaces usage on stream chunks; the SDK type omits it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw: any = chunk;
      if (raw.usage) {
        const cached =
          raw.usage.prompt_tokens_details?.cached_tokens ??
          raw.usage.cache_read_input_tokens ??
          undefined;
        usage = {
          input: raw.usage.prompt_tokens ?? 0,
          output: raw.usage.completion_tokens ?? 0,
          ...(cached !== undefined ? { cachedInput: Number(cached) } : {}),
        };
      }
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      // NIM reasoning models stream a nonstandard reasoning_content delta;
      // OpenRouter reasoning models stream delta.reasoning. Both are kept
      // out of the visible reply unless no content follows.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d: any = delta;
      if (d.reasoning) reasoning += d.reasoning;
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
      message: content || reasoning || null,
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
