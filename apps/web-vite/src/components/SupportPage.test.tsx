import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SupportPage } from "./SupportPage";

const conversationId = "3f1b0c6e-2f6a-4a0a-9c9e-6c1a2b3d4e5f";
const otherConversationId = "5c2d1e7b-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const customerId = "b2b7d5f0-9a3a-4f38-8f47-1a2b3c4d5e6f";

const conversations = [
  {
    id: conversationId,
    customerId,
    customerName: "Ada Lovelace",
    subject: "Invoice question",
    status: "open",
    lastMessageAt: "2026-09-20T09:30:00.000Z",
    lastMessagePreview: "My invoice looks wrong",
  },
  {
    id: otherConversationId,
    customerId,
    customerName: "Grace Hopper",
    subject: "Refund request",
    status: "escalated",
    lastMessageAt: "2026-09-19T09:30:00.000Z",
    lastMessagePreview: "I would like a refund",
  },
];

const thread = {
  conversation: {
    id: conversationId,
    customerId,
    customerName: "Ada Lovelace",
    subject: "Invoice question",
    status: "open",
    priority: "normal",
    category: null,
    assignedUserId: null,
    slaDueAt: null,
  },
  messages: [
    {
      id: "d6a3b0c1-2f6a-4a0a-9c9e-6c1a2b3d4e5f",
      orgId: customerId,
      conversationId,
      senderType: "customer",
      senderUserId: null,
      body: "My invoice looks wrong",
      createdAt: "2026-09-20T09:30:00.000Z",
    },
  ],
};

function moduleSwitchboard(enabled = true) {
  return Response.json({
    catalog: [
      { id: "support", label: "Customer care", description: "Support desk", href: "/support" },
      { id: "crm", label: "CRM", description: "Customer relationships", href: "/crm" },
    ],
    enabledModules: enabled ? ["support", "crm"] : ["crm"],
    usingDefaults: false,
  });
}

interface Handlers {
  post?: (payload: Record<string, unknown>) => Response;
  execute?: (payload: Record<string, unknown>) => Response;
}

function supportFetch(handlers: Handlers = {}) {
  const calls: Array<{ path: string; payload: Record<string, unknown> | null }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === "POST") {
      const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ path, payload });
      if (path === "/api/capabilities/execute") {
        return handlers.execute?.(payload) ?? Response.json({ ok: true, data: {} });
      }
      return handlers.post?.(payload) ?? Response.json({ ok: true, data: { updated: true } });
    }
    if (path === "/api/modules") return moduleSwitchboard();
    if (path === "/api/support") return Response.json({ conversations });
    if (path.startsWith("/api/support?")) return Response.json(thread);
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

async function openTab(name: string | RegExp) {
  await screen.findByText("Latest activity");
  fireEvent.click(screen.getByRole("button", { name }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// The desk renders a full thread plus tab chrome, so each case needs more room
// than the default 5s on a loaded machine.
const SLOW = 20_000;

describe("Vite support page", () => {
  it("summarises the inbox and opens the first conversation", async () => {
    const { fetchMock } = supportFetch();
    render(<SupportPage />);

    expect(await screen.findByRole("heading", { name: "Support" })).not.toBeNull();
    expect(await screen.findByText("Invoice question")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/support", expect.objectContaining({ credentials: "same-origin" }));
  }, SLOW);

  it("loads the inbox and selected thread from Go capabilities without legacy reads", async () => {
    vi.stubGlobal("__GO_SUPPORT_INBOX_READS__", true);
    const { fetchMock, calls } = supportFetch({
      execute: (payload) => payload.capabilityId === "support.listConversations"
        ? Response.json({ ok: true, data: { conversations } })
        : Response.json({ ok: true, data: {
          ...thread,
          conversation: { ...thread.conversation, customerEmail: null },
        } }),
    });
    render(<SupportPage />);

    expect(await screen.findByRole("heading", { name: "Support" })).not.toBeNull();
    expect(await screen.findByText("Invoice question")).not.toBeNull();
    await waitFor(() => {
      const paths = fetchMock.mock.calls.map(([path]) => String(path));
      expect(paths.filter((path) => path === "/api/capabilities/execute")).toHaveLength(2);
      expect(paths).not.toContain("/api/support");
      expect(paths).not.toContain(`/api/support?id=${conversationId}`);
      expect(calls[0]?.payload).toMatchObject({
        capabilityId: "support.listConversations",
        input: { customerBoundOnly: true, limit: 100 },
      });
      expect(calls[1]?.payload).toMatchObject({
        capabilityId: "support.readConversation",
        input: { conversationId, limit: 200 },
      });
    });
  }, SLOW);

  it("does not load customer care while the module is disabled", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/modules");
      return moduleSwitchboard(false);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SupportPage />);

    expect(await screen.findByText(/Customer care is switched off/)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps an AI reply as a draft until a human sends it", async () => {
    const { calls } = supportFetch({
      post: (payload) => {
        if (payload.action === "draft") return Response.json({ draft: "Thanks for flagging this.", sessionId: "s1", steps: 4 });
        if (payload.action === "send") return Response.json({ ok: true, data: { messageId: "m1", senderType: "agent" } });
        return Response.json({ ok: true, data: { updated: true } });
      },
    });
    render(<SupportPage />);
    await openTab(/^Inbox/);

    fireEvent.click(await screen.findByRole("button", { name: "Draft reply" }));

    const draftBox = await screen.findByLabelText("AI draft reply");
    expect((draftBox as HTMLTextAreaElement).value).toBe("Thanks for flagging this.");
    expect(calls.filter((call) => call.payload!.action === "draft")).toHaveLength(1);
    expect(calls.some((call) => call.payload!.action === "send")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Send to customer" }));

    await waitFor(() => expect(calls.some((call) => call.payload!.action === "send")).toBe(true));
    expect(calls.find((call) => call.payload!.action === "send")?.payload).toMatchObject({
      conversationId,
      body: "Thanks for flagging this.",
    });
    await waitFor(() => expect(screen.queryByLabelText("AI draft reply")).toBeNull());
  }, SLOW);

  it("surfaces an approval-pending write as pending, not as a failure or a save", async () => {
    const { calls } = supportFetch({
      post: (payload) => {
        if (payload.action === "resolve") return Response.json({ ok: false, pendingApproval: true, reason: "Resolving needs human approval." }, { status: 202 });
        return Response.json({ ok: true, data: { updated: true } });
      },
    });
    render(<SupportPage />);
    await openTab(/^Inbox/);

    fireEvent.click(await screen.findByRole("button", { name: "Resolve" }));

    expect(await screen.findByText("Resolving needs human approval.")).not.toBeNull();
    expect(calls.filter((call) => call.payload!.action === "resolve")).toHaveLength(1);
  }, SLOW);

  it("requires a reason before escalating a conversation", async () => {
    const { calls } = supportFetch({
      post: (payload) => (payload.action === "escalate" ? Response.json({ ok: true, data: { status: "escalated" } }) : Response.json({ ok: true, data: { updated: true } })),
    });
    render(<SupportPage />);
    await openTab(/^Inbox/);

    fireEvent.click(await screen.findByRole("button", { name: "Escalate" }));

    const confirm = screen.getByRole("button", { name: "Confirm escalation" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirm);
    expect(calls.some((call) => call.payload!.action === "escalate")).toBe(false);

    fireEvent.change(screen.getByLabelText("Why does this need a human owner?"), { target: { value: "Customer asked for a refund above policy" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm escalation" }));

    await waitFor(() => expect(calls.some((call) => call.payload!.action === "escalate")).toBe(true));
    expect(calls.find((call) => call.payload!.action === "escalate")?.payload).toMatchObject({
      conversationId,
      reason: "Customer asked for a refund above policy",
    });
  }, SLOW);

  it("publishes a canned response with an intent identity and never without one", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "POST") {
        const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (payload.action === "createCannedResponse") {
          expect(payload.intentId).toEqual(expect.any(String));
          return Response.json({ ok: true, data: { cannedResponseId: "c1" } });
        }
        return Response.json({ ok: true, data: { updated: true } });
      }
      if (path === "/api/modules") return moduleSwitchboard();
      if (path === "/api/support?library=1") return Response.json({ canned: [], articles: [] });
      if (path === "/api/support") return Response.json({ conversations });
      if (path.startsWith("/api/support?")) return Response.json(thread);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SupportPage />);
    await screen.findByText("Latest activity");
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    await screen.findByText("Knowledge base");

    fireEvent.change(screen.getByLabelText("Canned shortcut"), { target: { value: "/refund" } });
    fireEvent.change(screen.getByLabelText("Canned response title"), { target: { value: "Refund policy answer" } });
    fireEvent.change(screen.getByLabelText("Reply body"), { target: { value: "Refunds are processed within five days." } });
    fireEvent.click(screen.getByRole("button", { name: "Save response" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/support?library=1")).toHaveLength(2),
    );
    expect((screen.getByLabelText("Canned shortcut") as HTMLInputElement).value).toBe("");
  }, SLOW);

  it("saves support articles as internal unless staff explicitly publish them", async () => {
    let createPayload: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "POST") {
        createPayload = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Response.json({ ok: true, data: { articleId: "article-1" } });
      }
      if (path === "/api/modules") return moduleSwitchboard();
      if (path === "/api/support?library=1") return Response.json({ canned: [], articles: [] });
      if (path === "/api/support") return Response.json({ conversations: [] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SupportPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Library" }));
    fireEvent.change(screen.getByLabelText("Article title"), { target: { value: "Return policy" } });
    fireEvent.change(screen.getByLabelText("Article body"), { target: { value: "Keep this article private until approved." } });
    expect(screen.getByRole("checkbox", { name: "Make this article available to public support replies" })).toHaveProperty("checked", false);
    fireEvent.click(screen.getByRole("button", { name: "Save internal article" }));

    await waitFor(() => expect(createPayload).toMatchObject({ action: "createKbArticle", isPublic: false }));
  }, SLOW);
});
