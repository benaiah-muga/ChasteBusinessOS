import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleProvider } from "./providers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function requestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]![1] as { body?: string } | undefined;
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

describe("OpenAiCompatibleProvider — native tool calling", () => {
  it("declares toolCalling capability", () => {
    const p = new OpenAiCompatibleProvider("k", "m", "http://example.test/v1");
    expect(p.toolCalling).toBe(true);
  });

  it("sends tools and parses tool_calls from the response", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call_1",
                    function: {
                      name: "acc_journal_post",
                      arguments: JSON.stringify({ debitAccountId: "a1", amount: 100 }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProvider("k", "meta/muse-glimmer-30b", "http://example.test/v1");
    const result = await provider.complete({
      system: "sys",
      user: "hello",
      tools: [
        {
          name: "acc_journal_post",
          description: "Post a journal entry",
          parameters: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
        },
      ],
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toEqual({
      id: "call_1",
      name: "acc_journal_post",
      arguments: { debitAccountId: "a1", amount: 100 },
    });
    expect(result.usage?.totalTokens).toBe(15);

    const body = requestBody(fetchMock);
    const tools = body.tools as Array<{ type: string; function: { name: string; parameters: unknown } }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.type).toBe("function");
    expect(tools[0]!.function.name).toBe("acc_journal_post");
    expect(body.tool_choice).toBe("auto");
    expect(body.max_tokens).toBe(4096);
  });

  it("feeds tool history back as assistant tool_calls + tool results", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "done" } }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProvider("k", "m", "http://example.test/v1");
    await provider.complete({
      system: "sys",
      user: "go",
      toolHistory: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "acc_journal_post", arguments: { amount: 1 } }],
        },
        { role: "tool", toolCallId: "call_1", content: "ok" },
      ],
    });

    const body = requestBody(fetchMock);
    const messages = body.messages as Array<{ role: string; tool_calls?: unknown[]; tool_call_id?: string }>;
    const roles = messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool"]);
    const assistant = messages[2]!;
    expect(
      (assistant.tool_calls![0] as { function: { arguments: string } }).function.arguments,
    ).toBe('{"amount":1}');
    const tool = messages[3]!;
    expect(tool.tool_call_id).toBe("call_1");
    expect(tool.content).toBe("ok");
  });

  it("omits tools entirely when none are offered", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "plain" } }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProvider("k", "m", "http://example.test/v1");
    const result = await provider.complete({ system: "s", user: "u" });

    expect(result.text).toBe("plain");
    expect(result.toolCalls).toBeUndefined();
    const body = requestBody(fetchMock);
    expect(body.tools).toBeUndefined();
    expect(body.max_tokens).toBe(1024);
  });
});
