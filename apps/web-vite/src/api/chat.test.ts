import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatStreamError, isChatAbortError, steerChat, streamChat, type ChatEvent } from "./chat";

const encoder = new TextEncoder();

function byteStream(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
}

function okResponse(chunks: Array<string | Uint8Array>, sessionId = "00000000-0000-4000-8000-000000000001"): Response {
  return new Response(byteStream(chunks), {
    status: 200,
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "x-session-id": sessionId },
  });
}

function stubFetch(response: Response | (() => Promise<Response>)): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => (typeof response === "function" ? response() : response));
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function failureOf(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
    throw new Error("expected the promise to reject");
  } catch (error) {
    return error;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamChat", () => {
  it("parses the frame protocol and reports the session header", async () => {
    const sessionId = "6f1c1f4a-2f6f-4a2a-9d0a-0b9a5f1c1f4a";
    stubFetch(okResponse([
      '{"type":"step","step":1,"maxSteps":8}\n',
      '{"type":"tool","name":"crm.listCustomers"}\n',
      '{"type":"delta","text":"Two customers"}\n',
      '{"type":"delta","text":" match."}\n',
      '{"type":"ask","id":"call_1","question":"Which one?","options":["Acme","Beta"],"allowOther":false}\n',
      '{"type":"done","sessionId":"' + sessionId + '","reply":"Two customers match.","usage":{"turn":{"input":10,"output":4,"cachedInput":2},"session":{"input":30,"output":12,"cachedInput":18}}}\n',
    ], sessionId));

    const events: ChatEvent[] = [];
    const sessions: string[] = [];
    await streamChat({ message: "hi", onSession: (id) => sessions.push(id) }, (event) => events.push(event));

    expect(sessions).toEqual([sessionId]);
    expect(events.map((event) => event.type)).toEqual(["step", "tool", "delta", "delta", "ask", "done"]);
    expect(events[3]).toEqual({ type: "delta", text: " match." });
    expect(events[4]).toEqual({ type: "ask", id: "call_1", question: "Which one?", options: ["Acme", "Beta"], allowOther: false });
    expect(events[5]).toEqual({
      type: "done",
      sessionId,
      reply: "Two customers match.",
      turnUsage: { input: 10, output: 4, cachedInput: 2 },
      sessionUsage: { input: 30, output: 12, cachedInput: 18 },
    });
  });

  it("normalizes an ask frame with no options and defaults allowOther to true", async () => {
    stubFetch(okResponse(['{"type":"ask","id":"call_2","question":"Anything else?"}\n', '{"type":"done","reply":""}\n']));
    const events: ChatEvent[] = [];
    await streamChat({ message: "hi" }, (event) => events.push(event));
    expect(events[0]).toEqual({ type: "ask", id: "call_2", question: "Anything else?", options: [], allowOther: true });
    expect(events[1]).toEqual({ type: "done", sessionId: null, reply: "", turnUsage: null, sessionUsage: null });
  });

  it("reassembles frames split across chunk boundaries and multi-byte characters", async () => {
    const payload = '{"type":"delta","text":"café ☕ done"}\n{"type":"delta","text":"next"}\n{"type":"done","reply":"ok"}\n';
    const bytes = encoder.encode(payload);
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.length; offset += 3) chunks.push(bytes.slice(offset, offset + 3));
    stubFetch(okResponse(chunks));

    const events: ChatEvent[] = [];
    await streamChat({ message: "hi" }, (event) => events.push(event));
    expect(events).toEqual([
      { type: "delta", text: "café ☕ done" },
      { type: "delta", text: "next" },
      { type: "done", sessionId: null, reply: "ok", turnUsage: null, sessionUsage: null },
    ]);
  });

  it("skips malformed lines and unknown frame types without killing the stream", async () => {
    stubFetch(okResponse([
      "not json at all\n",
      '{"type":"mystery","payload":1}\n',
      '{"type":"delta"}\n',
      '{"type":"delta","text":"still here"}\n',
      '{"type":"done","reply":"still here"}\n',
    ]));
    const events: ChatEvent[] = [];
    await streamChat({ message: "hi" }, (event) => events.push(event));
    expect(events).toEqual([
      { type: "delta", text: "still here" },
      { type: "done", sessionId: null, reply: "still here", turnUsage: null, sessionUsage: null },
    ]);
  });

  it("treats a 200 stream that ends without a terminal frame as interrupted", async () => {
    stubFetch(okResponse(['{"type":"delta","text":"partial"}\n']));
    const error = await failureOf(streamChat({ message: "hi" }, () => {}));
    expect(error).toBeInstanceOf(ChatStreamError);
    expect((error as ChatStreamError).status).toBe(0);
    expect((error as ChatStreamError).message).toContain("before finishing");
  });

  it("maps refusal statuses to actionable errors and surfaces Retry-After", async () => {
    const cases: Array<[Response, number, RegExp]> = [
      [Response.json({ error: "unauthorized" }, { status: 401 }), 401, /session has ended/i],
      [Response.json({ error: "onboarding required" }, { status: 428 }), 428, /setting up your workspace/i],
      [Response.json({ error: "session not found" }, { status: 404 }), 404, /no longer exists/i],
      [Response.json({ error: "too many requests" }, { status: 429, headers: { "retry-after": "42" } }), 429, /42s/],
    ];
    for (const [response, status, pattern] of cases) {
      stubFetch(response);
      const error = await failureOf(streamChat({ message: "hi" }, () => {}));
      expect(error).toBeInstanceOf(ChatStreamError);
      expect((error as ChatStreamError).status).toBe(status);
      expect((error as ChatStreamError).message).toMatch(pattern);
      if (status === 429) expect((error as ChatStreamError).retryAfterSeconds).toBe(42);
      vi.unstubAllGlobals();
    }
  });

  it("reports an unreachable server distinctly from a refusal", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const error = await failureOf(streamChat({ message: "hi" }, () => {}));
    expect((error as ChatStreamError).status).toBe(0);
    expect((error as ChatStreamError).message).toContain("Could not reach");
  });

  it("rejects with an AbortError once the signal fires", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(next) {
        controller = next;
      },
    });
    stubFetch(new Response(stream, { status: 200 }));

    const abortController = new AbortController();
    const pending = streamChat({ message: "hi", signal: abortController.signal }, () => {});
    abortController.abort();
    controller.enqueue(encoder.encode('{"type":"delta","text":"a"}\n'));
    const error = await failureOf(pending);
    expect(isChatAbortError(error)).toBe(true);
  });
});

describe("steerChat", () => {
  it("reports accepted, rejected, and unreachable outcomes", async () => {
    const mock = stubFetch(Response.json({ queued: true }));
    expect(await steerChat({ sessionId: "s", message: "go left" })).toBe("accepted");
    expect(mock).toHaveBeenCalledWith("/api/chat/steer", expect.objectContaining({ method: "POST" }));

    stubFetch(Response.json({ error: "session not found" }, { status: 404 }));
    expect(await steerChat({ sessionId: "s", message: "go left" })).toBe("rejected");

    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await steerChat({ sessionId: "s", message: "go left" })).toBe("unreachable");
  });
});
