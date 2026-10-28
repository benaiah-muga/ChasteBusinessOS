import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerChatAsk,
  chatStore,
  refreshChatCreatorAvailability,
  removeQueuedChatMessage,
  resetChat,
  restoreChatSession,
  resumeChat,
  setChatCreator,
  stopChatRun,
  transcriptFromEvents,
} from "./chat-store";

const encoder = new TextEncoder();

interface ControlledStream {
  response: Response;
  push: (line: string) => void;
  close: () => void;
}

function controlledStream(sessionId: string): ControlledStream {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next;
    },
  });
  return {
    response: new Response(stream, { status: 200, headers: { "x-session-id": sessionId } }),
    push: (line) => controller.enqueue(encoder.encode(line)),
    close: () => controller.close(),
  };
}

function harness(options: { steer?: () => Response; chat?: (call: number) => Response | undefined } = {}) {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const steerRequests: Array<Record<string, unknown>> = [];
  const streams: ControlledStream[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/chat/steer") {
      steerRequests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return options.steer ? options.steer() : Response.json({ queued: true });
    }
    requests.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    const custom = options.chat?.(requests.length);
    if (custom) return custom;
    const controlled = controlledStream(`00000000-0000-4000-8000-00000000000${streams.length + 1}`);
    streams.push(controlled);
    return controlled.response;
  }));
  return { requests, steerRequests, streams };
}

function lastMessage() {
  return chatStore.getState().messages[chatStore.getState().messages.length - 1]!;
}

function lastAssistant() {
  const messages = chatStore.getState().messages;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role === "assistant") return messages[index]!;
  }
  throw new Error("no assistant message in the transcript");
}

beforeEach(() => {
  resetChat();
});

afterEach(() => {
  resetChat();
  vi.unstubAllGlobals();
});

describe("chat store", () => {
  it("streams a reply, records usage, and reuses the session on the next turn", async () => {
    const { requests, streams } = harness();
    void chatStore.send("How much cash do we have?");
    await vi.waitFor(() => expect(streams).toHaveLength(1));

    streams[0]!.push('{"type":"step","step":1,"maxSteps":8}\n');
    streams[0]!.push('{"type":"tool","name":"analytics.cashPosition"}\n');
    streams[0]!.push('{"type":"delta","text":"You have "}\n');
    streams[0]!.push('{"type":"delta","text":"$1,200."}\n');
    streams[0]!.push('{"type":"done","sessionId":"00000000-0000-4000-8000-000000000001","reply":"You have $1,200.","usage":{"turn":{"input":10,"output":5,"cachedInput":0},"session":{"input":10,"output":5,"cachedInput":0}}}\n');
    streams[0]!.close();

    await vi.waitFor(() => expect(chatStore.getState().busy).toBe(false));
    const state = chatStore.getState();
    expect(state.messages.map((message) => message.role)).toEqual(["assistant", "user", "assistant"]);
    expect(lastMessage().text).toBe("You have $1,200.");
    expect(lastMessage().activity).toEqual(["analytics.cashPosition"]);
    expect(lastMessage().usage).toEqual({ input: 10, output: 5, cachedInput: 0 });
    expect(state.sessionUsage).toEqual({ input: 10, output: 5, cachedInput: 0 });
    expect(state.step).toBeNull();
    expect(state.lastTool).toBeNull();
    expect(requests[0]!.body).toEqual({ message: "How much cash do we have?", mode: "assist" });

    void chatStore.send("And last month?");
    await vi.waitFor(() => expect(streams).toHaveLength(2));
    expect(requests[1]!.body.sessionId).toBe("00000000-0000-4000-8000-000000000001");
    streams[1]!.push('{"type":"done","reply":"Last month: $900."}\n');
    streams[1]!.close();
    await vi.waitFor(() => expect(chatStore.getState().busy).toBe(false));
  });

  it("adopts the server's authoritative final reply when it corrects the stream", async () => {
    const { streams } = harness();
    void chatStore.send("Invoice Acme.");
    await vi.waitFor(() => expect(streams).toHaveLength(1));

    streams[0]!.push('{"type":"delta","text":"Invoice created and sent."}\n');
    streams[0]!.push('{"type":"done","reply":"Invoice created and sent.\\n\\nNot done yet: accounting.createInvoice is waiting for your approval (approval id appr-1). Nothing has changed until you approve or reject it."}\n');
    streams[0]!.close();

    await vi.waitFor(() => expect(chatStore.getState().busy).toBe(false));
    const text = lastAssistant().text;
    expect(text).toContain("Invoice created and sent.");
    expect(text).toContain("waiting for your approval");
    expect(text).toContain("Nothing has changed");
  });

  it("steers a message into the running turn without disturbing the stream", async () => {
    const { steerRequests, streams } = harness();
    void chatStore.send("Draft an invoice.");
    await vi.waitFor(() => expect(streams).toHaveLength(1));

    void chatStore.send("Use UGX, not USD.");
    await vi.waitFor(() => {
      expect(chatStore.getState().messages.some((message) => message.steered)).toBe(true);
    });
    expect(chatStore.getState().queue).toEqual([]);
    expect(steerRequests[0]).toEqual({
      sessionId: "00000000-0000-4000-8000-000000000001",
      message: "Use UGX, not USD.",
    });

    streams[0]!.push('{"type":"delta","text":"Drafting in UGX."}\n');
    await vi.waitFor(() => expect(lastAssistant().text).toBe("Drafting in UGX."));
    streams[0]!.push('{"type":"done","reply":"Drafting in UGX."}\n');
    streams[0]!.close();
    await vi.waitFor(() => expect(chatStore.getState().busy).toBe(false));

    const steered = chatStore.getState().messages.find((message) => message.steered);
    expect(steered?.text).toBe("Use UGX, not USD.");
    expect(lastMessage().text).toBe("Use UGX, not USD.");
    expect(lastAssistant().text).toBe("Drafting in UGX.");
  });

  it("falls back to the visible queue when steering is refused, then auto-sends in order", async () => {
    const { requests, streams } = harness({ steer: () => Response.json({ error: "session not found" }, { status: 404 }) });
    void chatStore.send("First task.");
    await vi.waitFor(() => expect(streams).toHaveLength(1));

    void chatStore.send("Wait, make it two.");
    await vi.waitFor(() => expect(chatStore.getState().queue).toEqual(["Wait, make it two."]));
    expect(chatStore.getState().messages.some((message) => message.steered)).toBe(false);

    streams[0]!.push('{"type":"done","reply":"First task done."}\n');
    streams[0]!.close();
    await vi.waitFor(() => expect(streams).toHaveLength(2));
    expect(chatStore.getState().queue).toEqual([]);
    expect(requests[1]!.body.message).toBe("Wait, make it two.");
    streams[1]!.push('{"type":"done","reply":"Two it is."}\n');
    streams[1]!.close();
    await vi.waitFor(() => expect(chatStore.getState().busy).toBe(false));
  });

  it("queues locally when the steering request cannot reach the server", async () => {
    const streams: ControlledStream[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/chat/steer") throw new TypeError("Failed to fetch");
      const controlled = controlledStream(`00000000-0000-4000-8000-00000000000${streams.length + 1}`);
      streams.push(controlled);
      return controlled.response;
    }));

    void chatStore.send("First task.");
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    void chatStore.send("More context.");
    await vi.waitFor(() => expect(chatStore.getState().queue).toEqual(["More context."]));

    streams[0]!.push('{"type":"done","reply":"ok"}\n');
    streams[0]!.close();
    await vi.waitFor(() => expect(streams).toHaveLength(2));
    expect(chatStore.getState().queue).toEqual([]);
    streams[1]!.push('{"type":"done","reply":"ok"}\n');
    streams[1]!.close();
    await vi.waitFor(() => expect(chatStore.getState().busy).toBe(false));
  });

  it("marks a stopped run and keeps partial text", async () => {
    const { streams } = harness();
    void chatStore.send("Long task.");
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0]!.push('{"type":"delta","text":"Partial answer"}\n');
    await vi.waitFor(() => expect(lastMessage().text).toBe("Partial answer"));

    stopChatRun();
    streams[0]!.close();
    await vi.waitFor(() => expect(chatStore.getState().busy).toBe(false));
    expect(lastMessage().text).toBe("Partial answer");
    expect(lastMessage().error).toBeUndefined();
  });

  it("shows Stopped when a run is aborted before any text arrives", async () => {
    const { streams } = harness();
    void chatStore.send("Long task.");
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    stopChatRun();
    streams[0]!.close();
    await vi.waitFor(() => expect(chatStore.getState().busy).toBe(false));
    expect(lastMessage().text).toBe("Stopped.");
  });

  it("renders 404s and forgets the dead session so the next turn starts fresh", async () => {
    const { requests, streams } = harness({ chat: (call) => (call === 2 ? Response.json({ error: "session not found" }, { status: 404 }) : undefined) });
    void chatStore.send("First.");
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0]!.push('{"type":"done","sessionId":"00000000-0000-4000-8000-000000000001","reply":"done"}\n');
    streams[0]!.close();
    await vi.waitFor(() => expect(chatStore.getState().busy).toBe(false));

    void chatStore.send("Second.");
    await vi.waitFor(() => expect(chatStore.getState().busy).toBe(false));
    expect(lastMessage().text).toContain("no longer exists");
    expect(lastMessage().error).toBe(true);

    void chatStore.send("Third.");
    await vi.waitFor(() => expect(streams).toHaveLength(2));
    expect(requests[2]!.body.sessionId).toBeUndefined();
    streams[1]!.push('{"type":"done","reply":"fresh"}\n');
    streams[1]!.close();
    await vi.waitFor(() => expect(chatStore.getState().busy).toBe(false));
  });

  it("answers a clarification card and locks it to the choice", async () => {
    const { requests, streams } = harness();
    void chatStore.send("Buy something.");
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0]!.push('{"type":"ask","id":"call_9","question":"Which vendor?","options":["Acme","Beta"],"allowOther":true}\n');
    streams[0]!.push('{"type":"done","reply":"Which vendor?"}\n');
    streams[0]!.close();
    await vi.waitFor(() => expect(chatStore.getState().busy).toBe(false));

    const asked = chatStore.getState().messages.find((message) => message.ask);
    expect(asked?.ask).toEqual({ id: "call_9", question: "Which vendor?", options: ["Acme", "Beta"], allowOther: true });

    answerChatAsk("call_9", "Acme");
    await vi.waitFor(() => expect(streams).toHaveLength(2));
    const locked = chatStore.getState().messages.find((message) => message.ask);
    expect(locked?.answered).toBe("Acme");
    expect(requests[1]!.body.message).toBe("Acme");
    streams[1]!.push('{"type":"done","reply":"Ordered from Acme."}\n');
    streams[1]!.close();
    await vi.waitFor(() => expect(chatStore.getState().busy).toBe(false));
  });

  it("removes a queued fallback message by position", async () => {
    const { streams } = harness({ steer: () => Response.json({ error: "nope" }, { status: 400 }) });
    void chatStore.send("First.");
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    void chatStore.send("drop me");
    void chatStore.send("keep me");
    await vi.waitFor(() => expect(chatStore.getState().queue).toEqual(["drop me", "keep me"]));
    removeQueuedChatMessage(0);
    expect(chatStore.getState().queue).toEqual(["keep me"]);

    // The run settles and drains the surviving queued message as its own turn.
    streams[0]!.push('{"type":"done","reply":"ok"}\n');
    streams[0]!.close();
    await vi.waitFor(() => expect(streams).toHaveLength(2));
    expect(chatStore.getState().queue).toEqual([]);
    streams[1]!.push('{"type":"done","reply":"ok"}\n');
    streams[1]!.close();
    await vi.waitFor(() => expect(chatStore.getState().busy).toBe(false));
  });

  it("reset clears the transcript and the session without touching creator mode", async () => {
    const { streams } = harness();
    setChatCreator(false);
    void chatStore.send("Something.");
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0]!.push('{"type":"done","sessionId":"00000000-0000-4000-8000-000000000001","reply":"ok"}\n');
    streams[0]!.close();
    await vi.waitFor(() => expect(chatStore.getState().busy).toBe(false));

    resetChat();
    const state = chatStore.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.text).toContain("business workmate");
    expect(state.sessionUsage).toEqual({ input: 0, output: 0, cachedInput: 0 });

    const { requests: freshRequests, streams: freshStreams } = harness();
    void chatStore.send("Fresh start.");
    await vi.waitFor(() => expect(freshStreams).toHaveLength(1));
    expect(freshRequests[0]!.body.sessionId).toBeUndefined();
    freshStreams[0]!.push('{"type":"done","reply":"ok"}\n');
    freshStreams[0]!.close();
    await vi.waitFor(() => expect(chatStore.getState().busy).toBe(false));
  });

  it("gates the creator toggle on the creator module being enabled", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/modules") {
        return Response.json({
          catalog: [
            { id: "creator", label: "Creator", description: "Propose platform changes", href: "/proposals" },
            { id: "accounting", label: "Accounting", description: "", href: "/accounting" },
          ],
          enabledModules: ["creator"],
          usingDefaults: false,
        });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    }));

    setChatCreator(true);
    expect(chatStore.getState().creator).toBe(false);

    await refreshChatCreatorAvailability();
    expect(chatStore.getState().creatorAvailable).toBe(true);
    setChatCreator(true);
    expect(chatStore.getState().creator).toBe(true);

    const { requests, streams } = harness();
    void chatStore.send("Creator request.");
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    expect(requests[0]!.body.mode).toBe("creator");
    streams[0]!.push('{"type":"done","reply":"ok"}\n');
    streams[0]!.close();
    await vi.waitFor(() => expect(chatStore.getState().busy).toBe(false));
  });

  it("hides creator mode when the switchboard read fails", async () => {
    setChatCreator(false);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "nope" }, { status: 500 })));
    await refreshChatCreatorAvailability();
    expect(chatStore.getState().creatorAvailable).toBe(false);
    setChatCreator(true);
    expect(chatStore.getState().creator).toBe(false);
  });

  it("restores a persisted conversation and appends the next turn to it", async () => {
    const resumedID = "00000000-0000-4000-8000-000000000099";
    const at = "2026-10-20T09:00:00.000Z";
    window.localStorage.setItem("chaste:chat:session:v1", JSON.stringify({
      organizationId: "org-1",
      userId: "user-1",
      sessionId: resumedID,
    }));
    const chatBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/sessions/${resumedID}`) {
        return Response.json({
          session: {
            id: resumedID, orgId: "org-1", userId: "user-1", title: "Quarter close",
            mode: "assist", status: "completed", summary: null, modelRef: null,
            tokenUsage: { input: 40, output: 10, cachedInput: 20 },
            createdAt: at, updatedAt: at,
          },
          events: [
            { seq: 1, role: "user", content: { text: "Check the books" }, at },
            { seq: 2, role: "tool_call", content: { name: "accounting.trialBalance", callId: "call-1" }, at },
            { seq: 3, role: "tool_result", content: { name: "accounting.trialBalance", capabilityId: "accounting.trialBalance", callId: "call-1", ok: true }, at },
            { seq: 4, role: "assistant", content: { text: "The books are balanced." }, at },
          ],
        });
      }
      chatBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return controlledStream(resumedID).response;
    }));

    await expect(restoreChatSession("org-1", "user-1")).resolves.toBe(true);
    const restored = chatStore.getState();
    expect(restored.sessionId).toBe(resumedID);
    expect(restored.sessionTitle).toBe("Quarter close");
    expect(restored.resumed).toBe(true);
    expect(restored.sessionUsage).toEqual({ input: 40, output: 10, cachedInput: 20 });
    expect(restored.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(restored.messages[1]!.text).toBe("The books are balanced.");
    expect(restored.messages[1]!.activity).toEqual(["accounting.trialBalance"]);

    void chatStore.send("And last quarter?");
    await vi.waitFor(() => expect(chatBodies).toHaveLength(1));
    expect(chatBodies[0]!.sessionId).toBe(resumedID);
  });

  it("rebuilds tool activity, record cards, proposals, and clarifications from a trajectory", () => {
    const at = "2026-10-20T09:00:00.000Z";
    const messages = transcriptFromEvents([
      { seq: 1, role: "user", content: { text: "What is blocked?" }, at },
      { seq: 2, role: "tool_call", content: { name: "signals.list" }, at },
      {
        seq: 3,
        role: "tool_result",
        content: {
          name: "signals.list",
          card: { kind: "waiting", title: "Two approvals waiting", status: "open", summary: "Approve the payroll run." },
          pendingApproval: true,
          approvalId: "44444444-4444-4444-8444-444444444444",
          approvalRationale: "Money above your threshold.",
        },
        at,
      },
      { seq: 4, role: "ask", content: { id: "ask-1", question: "Which payroll run?", options: ["October", "September"], allowOther: true }, at },
      { seq: 5, role: "assistant", content: { text: "I need one choice." }, at },
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("user");
    const assistant = messages[1]!;
    expect(assistant.text).toBe("I need one choice.");
    expect(assistant.activity).toEqual(["signals.list"]);
    expect(assistant.card?.title).toBe("Two approvals waiting");
    expect(assistant.proposal?.approvalId).toBe("44444444-4444-4444-8444-444444444444");
    expect(assistant.proposal?.rationale).toBe("Money above your threshold.");
    expect(assistant.ask).toEqual({ id: "ask-1", question: "Which payroll run?", options: ["October", "September"], allowOther: true });
  });

  it("drops a stored session that the server no longer has", async () => {
    window.localStorage.setItem("chaste:chat:session:v1", JSON.stringify({
      organizationId: "org-1",
      userId: "user-1",
      sessionId: "00000000-0000-4000-8000-000000000098",
    }));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "not found" }, { status: 404 })));
    await expect(restoreChatSession("org-1", "user-1")).resolves.toBe(false);
    expect(window.localStorage.getItem("chaste:chat:session:v1")).toBeNull();
    expect(chatStore.getState().sessionId).toBeNull();
  });

  it("reopens a session by id without leaving the previous transcript behind", async () => {
    const resumedID = "00000000-0000-4000-8000-000000000097";
    const at = "2026-10-20T09:00:00.000Z";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      session: {
        id: resumedID, orgId: "org-1", userId: "user-1", title: null,
        mode: "assist", status: "completed", summary: null, modelRef: null,
        createdAt: at, updatedAt: at,
      },
      events: [{ seq: 1, role: "user", content: { text: "Only this turn" }, at }],
    })));
    await resumeChat(resumedID);
    expect(chatStore.getState().messages.map((message) => message.text)).toEqual(["Only this turn"]);
    expect(chatStore.getState().sessionId).toBe(resumedID);
  });

  it("treats an interrupted stream as an error the user can retry from", async () => {
    const { streams } = harness();
    void chatStore.send("Question.");
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0]!.push('{"type":"delta","text":"half an answer"}\n');
    streams[0]!.close();
    await vi.waitFor(() => expect(chatStore.getState().busy).toBe(false));
    expect(lastMessage().text).toContain("before finishing");
    expect(lastMessage().error).toBe(true);
  });
});
