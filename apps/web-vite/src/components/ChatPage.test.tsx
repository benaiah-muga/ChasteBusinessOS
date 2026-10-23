import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPage } from "./ChatPage";
import { chatStore, resetChat } from "../chat-store";

const encoder = new TextEncoder();

interface ControlledStream {
  response: Response;
  push: (line: string) => void;
  close: () => void;
}

function controlledStream(): ControlledStream {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next;
    },
  });
  return {
    response: new Response(stream, { status: 200, headers: { "x-session-id": "00000000-0000-4000-8000-000000000001" } }),
    push: (line) => controller.enqueue(encoder.encode(line)),
    close: () => controller.close(),
  };
}

function creatorModulesResponse(enabled: boolean): Response {
  return Response.json({
    catalog: [
      { id: "creator", label: "Creator", description: "Propose platform changes", href: "/proposals" },
      { id: "accounting", label: "Accounting", description: "", href: "/accounting" },
    ],
    enabledModules: enabled ? ["creator"] : [],
    usingDefaults: false,
  });
}

function harness(options: { modules?: () => Response; steer?: () => Response; approvals?: () => Response } = {}) {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const streams: ControlledStream[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/modules") {
      return options.modules ? options.modules() : Response.json({ error: "module switchboard unavailable" }, { status: 500 });
    }
    if (url === "/api/chat/steer") {
      return options.steer ? options.steer() : Response.json({ queued: true });
    }
    if (url === "/api/sessions") return Response.json({ sessions: [] });
    if (url.startsWith("/api/search?")) {
      return Response.json({
        query: "Acme",
        groups: [{ type: "customer", label: "Customers", items: [{ id: "11111111-1111-4111-8111-111111111111", title: "Acme Ltd", href: "/crm" }] }],
      });
    }
    if (url === "/api/approvals") {
      return options.approvals ? options.approvals() : Response.json({ error: "approvals unavailable" }, { status: 500 });
    }
    if (url === "/api/capabilities/execute") {
      return Response.json({ error: "purchasing read unavailable" }, { status: 500 });
    }
    requests.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    const stream = controlledStream();
    streams.push(stream);
    return stream.response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { requests, streams, fetchMock };
}

function textarea(): HTMLTextAreaElement {
  return screen.getByLabelText("Message your workmate") as HTMLTextAreaElement;
}

function sendMessage(text: string) {
  // Enter works whether or not a run is in flight (the send button is
  // replaced by Stop mid-run, so it cannot express steering or queueing).
  fireEvent.change(textarea(), { target: { value: text } });
  fireEvent.keyDown(textarea(), { key: "Enter" });
}

async function completeTurn(stream: ControlledStream, reply: string, sessionId = "00000000-0000-4000-8000-000000000001") {
  stream.push('{"type":"delta","text":"' + reply + '"}\n');
  stream.push(`{"type":"done","sessionId":"${sessionId}","reply":"${reply}","usage":{"turn":{"input":10,"output":5,"cachedInput":0},"session":{"input":10,"output":5,"cachedInput":0}}}\n`);
  stream.close();
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());
}

beforeEach(() => {
  resetChat();
  window.history.replaceState(null, "", "/chat");
});

afterEach(() => {
  cleanup();
  resetChat();
  vi.unstubAllGlobals();
});

describe("ChatPage", () => {
  it("streams a reply, records usage on the turn and in the session footer", async () => {
    const { requests, streams } = harness();
    render(<ChatPage />);
    expect(await screen.findByText(/Hi, I'm your business workmate/)).not.toBeNull();

    sendMessage("How much cash do we have?");
    await waitFor(() => expect(streams).toHaveLength(1));
    expect(requests[0]!.body).toEqual({ message: "How much cash do we have?", mode: "assist" });

    await completeTurn(streams[0]!, "You have $1,200.");
    expect(await screen.findByText("You have $1,200.")).not.toBeNull();
    expect(screen.getByText("in 10")).not.toBeNull();
    expect(screen.getByText("out 5")).not.toBeNull();
    expect(screen.getByText(/this session: in 10/)).not.toBeNull();
  });

  it("continues a previous conversation from the session query parameter", async () => {
    const sessionID = "00000000-0000-4000-8000-000000000077";
    const at = "2026-10-20T09:00:00.000Z";
    window.history.replaceState(null, "", `/chat?session=${sessionID}`);
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const streams: ControlledStream[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/modules") return creatorModulesResponse(false);
      if (url === "/api/sessions") return Response.json({ sessions: [] });
      if (url === `/api/sessions/${sessionID}`) {
        return Response.json({
          session: {
            id: sessionID, orgId: "org-1", userId: "user-1", title: "Quarter close",
            mode: "assist", status: "completed", summary: null, modelRef: null,
            tokenUsage: { input: 12, output: 4, cachedInput: 8 }, createdAt: at, updatedAt: at,
          },
          events: [
            { seq: 1, role: "user", content: { text: "Earlier question" }, at },
            { seq: 2, role: "assistant", content: { text: "Earlier answer" }, at },
          ],
        });
      }
      requests.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      const stream = controlledStream();
      streams.push(stream);
      return stream.response;
    }));

    render(<ChatPage organizationId="org-1" actorId="user-1" />);
    expect(await screen.findByText("Earlier answer")).not.toBeNull();
    expect(screen.getByText(/Continuing/)).not.toBeNull();
    expect(window.location.search).toBe("");

    sendMessage("Next question");
    await waitFor(() => expect(streams).toHaveLength(1));
    expect(requests[0]!.body.sessionId).toBe(sessionID);
    await completeTurn(streams[0]!, "Next answer", sessionID);
    expect(await screen.findByText("Next answer")).not.toBeNull();
  });

  it("shows the live console strip while the agent works", async () => {
    const { streams } = harness();
    render(<ChatPage />);
    sendMessage("Run payroll.");
    await waitFor(() => expect(streams).toHaveLength(1));

    streams[0]!.push('{"type":"step","step":2,"maxSteps":8}\n');
    streams[0]!.push('{"type":"tool","name":"hr.runPayroll"}\n');
    expect(await screen.findByText("working")).not.toBeNull();
    expect(screen.getByText("step 2/8")).not.toBeNull();
    // Once on the message activity chips and once in the live strip.
    expect(screen.getAllByText("People · Run Payroll")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Stop" })).not.toBeNull();

    await completeTurn(streams[0]!, "Payroll queued.");
  });

  it("auto-sends a dashboard prompt into an untouched conversation and clears the URL", async () => {
    const { requests, streams } = harness();
    window.history.replaceState(null, "", "/chat?prompt=Draft%20an%20invoice%20for%20Acme");
    render(<ChatPage />);

    await waitFor(() => expect(streams).toHaveLength(1));
    expect(requests[0]!.body.message).toBe("Draft an invoice for Acme");
    expect(window.location.search).toBe("");
    await completeTurn(streams[0]!, "Draft ready.");
  });

  it("prefills instead of sending when the conversation already has history", async () => {
    const { requests, streams } = harness();
    render(<ChatPage />);
    sendMessage("Existing turn");
    await waitFor(() => expect(streams).toHaveLength(1));
    await completeTurn(streams[0]!, "Done.");
    expect(requests).toHaveLength(1);

    window.history.replaceState(null, "", "/chat?prompt=Do%20something%20now");
    cleanup();
    render(<ChatPage />);

    await waitFor(() => expect(textarea().value).toBe("Do something now"));
    expect(requests).toHaveLength(1);
    expect(window.location.search).toBe("");
  });

  it("answers a clarification card and locks it", async () => {
    const { requests, streams } = harness();
    render(<ChatPage />);
    sendMessage("Buy stock.");
    await waitFor(() => expect(streams).toHaveLength(1));
    streams[0]!.push('{"type":"ask","id":"call_5","question":"Which supplier?","options":["Acme","Beta"],"allowOther":true}\n');
    streams[0]!.push('{"type":"done","reply":"Which supplier?"}\n');
    streams[0]!.close();

    const option = await screen.findByRole("button", { name: "Acme" });
    fireEvent.click(option);
    await waitFor(() => expect(streams).toHaveLength(2));
    expect(requests[1]!.body.message).toBe("Acme");
    // The card locks to the chosen answer instead of offering options again.
    expect(screen.getByText("Acme", { selector: ".chat-ask-answered" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Beta" })).toBeNull();
    await completeTurn(streams[1]!, "Ordered.");
  });

  it("queues visibly when steering is refused and lets the user remove it", async () => {
    const { streams } = harness({ steer: () => Response.json({ error: "session not found" }, { status: 404 }) });
    render(<ChatPage />);
    sendMessage("First task.");
    await waitFor(() => expect(streams).toHaveLength(1));

    sendMessage("Wait, make it two.");
    expect(await screen.findByText("queued")).not.toBeNull();
    expect(screen.getByText("Wait, make it two.")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove queued message: Wait, make it two." }));
    await waitFor(() => expect(screen.queryByText("Wait, make it two.")).toBeNull());

    await completeTurn(streams[0]!, "First task done.");
  });

  it("shows the creator switch only when the creator module is enabled", async () => {
    const { requests, streams } = harness({ modules: () => creatorModulesResponse(true) });
    render(<ChatPage />);
    const toggle = await screen.findByRole("switch", { name: /creator mode/i });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    sendMessage("Propose something.");
    await waitFor(() => expect(streams).toHaveLength(1));
    expect(requests[0]!.body.mode).toBe("creator");
    await completeTurn(streams[0]!, "Proposal filed.");
  });

  it("hides the creator switch when availability cannot be determined", async () => {
    const { fetchMock } = harness();
    render(<ChatPage />);
    await screen.findByText(/Hi, I'm your business workmate/);
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => String(call[0]) === "/api/modules")).toBe(true));
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("stops an in-flight run and keeps partial text", async () => {
    const { streams } = harness();
    render(<ChatPage />);
    sendMessage("Long job.");
    await waitFor(() => expect(streams).toHaveLength(1));
    streams[0]!.push('{"type":"delta","text":"Partial answer"}\n');
    expect(await screen.findByText("Partial answer")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    streams[0]!.close();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());
    expect(screen.getByText("Partial answer")).not.toBeNull();
  });

  it("keeps the transcript when the page unmounts mid-stream", async () => {
    const { streams } = harness();
    const view = render(<ChatPage />);
    sendMessage("Background job.");
    await waitFor(() => expect(streams).toHaveLength(1));
    streams[0]!.push('{"type":"delta","text":"Continues "}\n');
    await screen.findByText("Continues");

    view.unmount();
    streams[0]!.push('{"type":"delta","text":"after unmount."}\n');
    streams[0]!.push('{"type":"done","reply":"Continues after unmount."}\n');
    streams[0]!.close();
    await waitFor(() => expect(chatStore.getState().busy).toBe(false));
    expect(chatStore.getState().messages.at(-1)?.text).toBe("Continues after unmount.");
  });
  it("renders a structured tool result card in the transcript", async () => {
    const { streams } = harness();
    render(<ChatPage />);
    sendMessage("Check CEM-1 stock.");
    await waitFor(() => expect(streams).toHaveLength(1));
    streams[0]!.push(
      '{"type":"tool_result","name":"inventory.checkStock","ok":true,"card":{"kind":"exception","title":"CEM-1 below reorder point","status":"open","severity":"high","summary":"Available stock is below the reorder point.","next":"Prepare a purchase proposal","evidence":{"sku":"CEM-1","available":5000}}}\n',
    );

    const region = await screen.findByRole("region", { name: "Exception record: CEM-1 below reorder point" });
    expect(within(region).getByText("open")).not.toBeNull();
    expect(within(region).getByText("high")).not.toBeNull();
    expect(within(region).getByText("Prepare a purchase proposal")).not.toBeNull();
    expect(within(region).getByText(/sku: CEM-1/)).not.toBeNull();
    // A record reaches the transcript without turning into an approval.
    expect(within(region).queryByRole("button")).toBeNull();
    await completeTurn(streams[0]!, "CEM-1 is below its reorder point.");
  });

  it("explains context compaction and offers a copy action on the reply", async () => {
    const { streams } = harness();
    render(<ChatPage />);
    sendMessage("Keep going on the long job.");
    await waitFor(() => expect(streams).toHaveLength(1));
    streams[0]!.push('{"type":"compaction","compactedToMessages":12}\n');
    await completeTurn(streams[0]!, "Still here with the full answer.");

    expect(await screen.findByText(/Older context summarized/)).not.toBeNull();
    expect(screen.getByText(/12 recent messages kept/)).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "Copy reply" }).length).toBeGreaterThan(0);
  });

  it("renders the exact stored proposal when a pending approval tool result arrives", async () => {
    const organizationId = "22222222-2222-4222-8222-222222222222";
    const approvalId = "11111111-1111-4111-8111-111111111111";
    const { streams } = harness({
      approvals: () => Response.json({
        approvals: [{
          id: approvalId,
          orgId: organizationId,
          sessionId: null,
          requestedByUserId: null,
          capabilityId: "purchasing.createPurchaseOrder",
          riskClass: "money",
          payload: {
            vendorId: "33333333-3333-4333-8333-333333333333",
            memo: "Restock cement",
            lines: [{ description: "Cement bag", quantity: 2000, unitPriceMinor: 5000 }],
          },
          rationale: "amount 10000 exceeds autonomous threshold 0",
          status: "pending",
          decidedByUserId: null,
          decisionComment: null,
          expiresAt: null,
          decidedAt: null,
          createdAt: "2026-10-19T12:00:00.000Z",
          raisedBy: { name: "Workmate", kind: "agent" },
          decidedBy: null,
          relatedDocuments: [],
        }],
        history: [],
      }),
    });
    render(<ChatPage organizationId={organizationId} />);
    sendMessage("Order two cement bags from the approved supplier.");
    await waitFor(() => expect(streams).toHaveLength(1));
    streams[0]!.push(`{"type":"tool_result","name":"purchasing.createPurchaseOrder","ok":false,"pendingApproval":true,"approvalId":"${approvalId}","approvalRationale":"amount 10000 exceeds autonomous threshold 0"}\n`);
    expect(await screen.findByText("Purchase proposal")).not.toBeNull();
    expect(await screen.findByText("Cement bag")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Approve order" })).not.toBeNull();
    await completeTurn(streams[0]!, "I prepared the order and it is waiting for your approval.");
  });

});


it("attaches a searched record as a source chip and sends its id with the turn", async () => {
  const { requests } = harness();
  render(<ChatPage />);

  fireEvent.click(screen.getByRole("button", { name: /Sources/ }));
  fireEvent.change(screen.getByPlaceholderText("Search customers, invoices, documents…"), { target: { value: "Acme" } });
  fireEvent.click(await screen.findByRole("button", { name: /Acme Ltd/ }));
  expect(screen.getByText("Acme Ltd")).not.toBeNull();
  sendMessage("What changed on this account?");

  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]!.body.attachments).toEqual([
    { type: "customer", id: "11111111-1111-4111-8111-111111111111", title: "Acme Ltd" },
  ]);
});
