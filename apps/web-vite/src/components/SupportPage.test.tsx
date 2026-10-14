import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SupportPage } from "./SupportPage";

const conversationId = "3f1b0c6e-2f6a-4a0a-9c9e-6c1a2b3d4e5f";
const organizationId = "66666666-6666-4666-8666-666666666666";
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
  draft?: (conversationId: string) => Response;
  getThread?: () => Response;
  team?: () => Response;
}

function supportFetch(handlers: Handlers = {}) {
  const calls: Array<{ path: string; payload: Record<string, unknown> | null }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === "POST") {
      const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ path, payload });
      if (path === "/api/support/draft") return handlers.draft?.(String(payload.conversationId)) ?? Response.json({ draft: "Draft unavailable." });
      if (path === "/api/capabilities/execute") {
        if (payload.capabilityId === "support.listConversations") return Response.json({ ok: true, data: { conversations } });
        if (payload.capabilityId === "support.readConversation") {
          const legacyThread = handlers.getThread ? await handlers.getThread().json() : thread;
          const current = legacyThread as typeof thread;
          return Response.json({ ok: true, data: { ...current, conversation: { ...current.conversation, customerEmail: null } } });
        }
        if (payload.capabilityId === "support.listLibrary") return Response.json({ ok: true, data: { canned: [], articles: [] } });
        const defaultRead = () => {
          if (payload.capabilityId === "support.listConversations") return Response.json({ ok: true, data: { conversations } });
          if (payload.capabilityId === "support.readConversation") return Response.json({ ok: true, data: { ...thread, conversation: { ...thread.conversation, customerEmail: null } } });
          return Response.json({ ok: true, data: { canned: [], articles: [] } });
        };
        if (handlers.execute) {
          const response = handlers.execute(payload);
          if (["support.listConversations", "support.readConversation", "support.listLibrary"].includes(String(payload.capabilityId))) {
            const result = await response.clone().json().catch(() => null) as { data?: unknown } | null;
            if (result?.data && typeof result.data === "object" && Object.keys(result.data).length === 0) return defaultRead();
          }
          return response;
        }
        if (["support.listConversations", "support.readConversation", "support.listLibrary"].includes(String(payload.capabilityId))) return defaultRead();
        if (payload.capabilityId === "support.postMessage") return Response.json({ ok: true, data: { messageId: "m1", senderType: "staff" } });
        if (payload.capabilityId === "support.resolveConversation") return Response.json({ ok: true, data: { status: "resolved" } });
        if (payload.capabilityId === "support.escalateConversation") return Response.json({ ok: true, data: { status: "escalated" } });
        if (payload.capabilityId === "support.updateTicket") return Response.json({ ok: true, data: { updated: true } });
        if (payload.capabilityId === "support.reopenConversation") return Response.json({ ok: true, data: { status: "open" } });
        if (payload.capabilityId === "support.startConversation") return Response.json({ ok: true, data: { conversationId } });
        if (payload.capabilityId === "support.createCannedResponse") return Response.json({ ok: true, data: { cannedResponseId: "c1" } });
        if (payload.capabilityId === "support.createKbArticle") return Response.json({ ok: true, data: { articleId: conversationId } });
        return Response.json({ error: "unexpected capability" }, { status: 400 });
      }
      return handlers.post?.(payload) ?? Response.json({ ok: true, data: { updated: true } });
    }
    if (path === "/api/modules") return moduleSwitchboard();
    if (path === "/api/team") return handlers.team?.() ?? Response.json({ members: [] });
    if (path === "/api/support/customers") return Response.json({ customers: [] });
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
  window.localStorage.clear();
});

// The desk renders a full thread plus tab chrome, so each case needs more room
// than the default 5s on a loaded machine.
const SLOW = 20_000;

describe("Vite support page", () => {
  it("summarises the inbox and opens the first conversation from Go capabilities", async () => {
    const { fetchMock } = supportFetch();
    render(<SupportPage organizationId={organizationId} />);

    expect(await screen.findByRole("heading", { name: "Support" })).not.toBeNull();
    expect(await screen.findByText("Invoice question")).not.toBeNull();
    expect(fetchMock.mock.calls.map(([path]) => String(path))).toContain("/api/capabilities/execute");
  }, SLOW);

  it("quick-creates a conversation customer through the Go CRM capability with organization-scoped retry", async () => {
    vi.stubGlobal("__GO_CRM_CUSTOMER_CREATE__", true);
    const actorId = "55555555-5555-4555-8555-555555555555";
    const organizationId = "66666666-6666-4666-8666-666666666666";
    const { calls } = supportFetch({
      execute: (payload) => payload.capabilityId === "crm.createCustomer"
        ? Response.json({ ok: true, data: { customerId, duplicateWarning: null } })
        : Response.json({ ok: true, data: {} }),
    });
    render(<SupportPage actorId={actorId} organizationId={organizationId} />);

    await openTab(/^Inbox/);
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    await screen.findByRole("dialog", { name: "New support conversation" });
    fireEvent.click(screen.getByRole("button", { name: "+ New customer" }));
    fireEvent.change(screen.getByLabelText("New customer name"), { target: { value: "Grace Hopper" } });
    fireEvent.change(screen.getByLabelText("New customer email"), { target: { value: "grace@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and use" }));

    await waitFor(() => expect((screen.getByLabelText("Customer") as HTMLSelectElement).value).toBe(customerId));
    expect(calls).toContainEqual({
      path: "/api/capabilities/execute",
      payload: expect.objectContaining({
        capabilityId: "crm.createCustomer",
        input: { name: "Grace Hopper", email: "grace@example.test", preferredContactMethod: "email", doNotContact: false },
        intentId: expect.any(String),
      }),
    });
    expect(calls.map((call) => call.path)).not.toContain("/api/customers");
  }, SLOW);

  it("loads the inbox and selected thread from Go capabilities without legacy reads", async () => {
    const { fetchMock, calls } = supportFetch({
      execute: (payload) => payload.capabilityId === "support.listConversations"
        ? Response.json({ ok: true, data: { conversations } })
        : Response.json({ ok: true, data: {
          ...thread,
          conversation: { ...thread.conversation, customerEmail: null },
        } }),
    });
    render(<SupportPage organizationId={organizationId} />);

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

  it("loads the library through the Go capability", async () => {
    const { fetchMock, calls } = supportFetch({
      execute: (payload) => Response.json({ ok: true, data: payload.capabilityId === "support.listLibrary"
        ? { canned: [], articles: [] }
        : {} }),
    });
    render(<SupportPage organizationId={organizationId} />);

    await screen.findByText("Latest activity");
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    expect(await screen.findByText("Knowledge base")).not.toBeNull();
    expect(calls.some((call) => call.path === "/api/capabilities/execute" && call.payload !== null && call.payload.capabilityId === "support.listLibrary" && JSON.stringify(call.payload.input) === "{}")).toBe(true);
    expect(fetchMock.mock.calls.map(([path]) => String(path))).not.toContain("/api/support?library=1");
  }, SLOW);

  it("restores and retries an unresolved Go canned-response save after reload", async () => {
    const actorId = "55555555-5555-4555-8555-555555555555";
    const organizationId = "66666666-6666-4666-8666-666666666666";
    const storageKey = `chaste.support.canned-response-intent.v1:${actorId}:${organizationId}`;
    const first = supportFetch({
      execute: (payload) => payload.capabilityId === "support.listLibrary"
        ? Response.json({ ok: true, data: { canned: [], articles: [] } })
        : Response.json({ error: "temporarily unavailable" }, { status: 503 }),
    });
    const firstView = render(<SupportPage actorId={actorId} organizationId={organizationId} />);
    await screen.findByText("Latest activity");
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    await screen.findByText("Knowledge base");
    fireEvent.change(screen.getByLabelText("Canned shortcut"), { target: { value: "/refund" } });
    fireEvent.change(screen.getByLabelText("Canned response title"), { target: { value: "Refund policy" } });
    fireEvent.change(screen.getByLabelText("Reply body"), { target: { value: "Eligible refunds take five days." } });
    fireEvent.click(screen.getByRole("button", { name: "Save response" }));
    await screen.findByText("The support service is unavailable. Try again.");
    const firstIntent = JSON.parse(window.localStorage.getItem(storageKey) ?? "{}").intentId;
    expect(firstIntent).toEqual(expect.any(String));
    firstView.unmount();

    const second = supportFetch({
      execute: (payload) => payload.capabilityId === "support.listLibrary"
        ? Response.json({ ok: true, data: { canned: [], articles: [] } })
        : Response.json({ ok: true, data: { cannedResponseId: "canned-1" } }),
    });
    render(<SupportPage actorId={actorId} organizationId={organizationId} />);
    await screen.findByText("Latest activity");
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    expect(await screen.findByText("An unresolved Go canned-response save was restored. Save these exact details to retry it.")).not.toBeNull();
    expect((screen.getByLabelText("Canned shortcut") as HTMLInputElement).value).toBe("/refund");
    fireEvent.change(screen.getByLabelText("Reply body"), { target: { value: "Changed while the original result was unknown." } });
    fireEvent.click(screen.getByRole("button", { name: "Save response" }));
    expect(await screen.findByText("A previous Go canned-response save is unresolved. Its exact saved details were restored; retry them before making changes.")).not.toBeNull();
    expect((screen.getByLabelText("Reply body") as HTMLTextAreaElement).value).toBe("Eligible refunds take five days.");
    fireEvent.click(screen.getByRole("button", { name: "Save response" }));
    await waitFor(() => expect(second.calls.some((call) => call.payload?.capabilityId === "support.createCannedResponse")).toBe(true));
    const retry = second.calls.find((call) => call.payload?.capabilityId === "support.createCannedResponse")?.payload;
    expect(retry?.input).toEqual({ shortcut: "/refund", title: "Refund policy", body: "Eligible refunds take five days." });
    expect(retry?.intentId).toBe(firstIntent);
    expect(window.localStorage.getItem(storageKey)).toBeNull();
    expect(first.calls.map((call) => call.path)).not.toContain("/api/support");
  }, SLOW);

  it("restores an uncertain Go message and retries the same actor-scoped intent without legacy fallback", async () => {
    const actorId = "55555555-5555-4555-8555-555555555555";
    const organizationId = "66666666-6666-4666-8666-666666666666";
    const storageKey = `chaste.support.conversation-write-intent.v1:pending:${actorId}:${organizationId}`;

    const execute = (result: "uncertain" | "complete") => (payload: Record<string, unknown>) => {
      if (payload.capabilityId === "support.listConversations") return Response.json({ ok: true, data: { conversations } });
      if (payload.capabilityId === "support.readConversation") return Response.json({ ok: true, data: { ...thread, conversation: { ...thread.conversation, customerEmail: null } } });
      if (payload.capabilityId === "support.postMessage") {
        return result === "uncertain"
          ? Response.json({ error: "temporarily unavailable" }, { status: 503 })
          : Response.json({ ok: true, data: { messageId: customerId, senderType: "staff" } });
      }
      return Response.json({ error: "unexpected capability" }, { status: 400 });
    };

    const first = supportFetch({ execute: execute("uncertain") });
    const firstView = render(<SupportPage actorId={actorId} organizationId={organizationId} />);
    await screen.findByText("Latest activity");
    fireEvent.click(screen.getByRole("button", { name: /Inbox/ }));
    const composer = await screen.findByPlaceholderText("Log what the customer wrote, or write the staff reply…");
    fireEvent.change(composer, { target: { value: "Please check the invoice." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("button", { name: "Retry saved action" })).not.toBeNull();
    const saved = JSON.parse(window.localStorage.getItem(storageKey) ?? "{}") as { intentId?: string };
    expect(saved.intentId).toEqual(expect.any(String));
    expect((composer as HTMLTextAreaElement).value).toBe("Please check the invoice.");
    firstView.unmount();

    const second = supportFetch({ execute: execute("complete") });
    render(<SupportPage actorId={actorId} organizationId={organizationId} />);
    await screen.findByRole("button", { name: "Retry saved action" });
    expect((screen.getByPlaceholderText("Log what the customer wrote, or write the staff reply…") as HTMLTextAreaElement).value)
      .toBe("Please check the invoice.");
    fireEvent.click(screen.getByRole("button", { name: "Retry saved action" }));

    await waitFor(() => expect(window.localStorage.getItem(storageKey)).toBeNull());
    const attempts = [...first.calls, ...second.calls].filter((call) => call.payload?.capabilityId === "support.postMessage");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.payload).toMatchObject({
      capabilityId: "support.postMessage",
      input: { conversationId, body: "Please check the invoice.", from: "staff" },
      intentId: saved.intentId,
    });
    expect(attempts[1]?.payload).toMatchObject({
      capabilityId: "support.postMessage",
      input: { conversationId, body: "Please check the invoice.", from: "staff" },
      intentId: saved.intentId,
    });
    expect(first.fetchMock.mock.calls.map(([path]) => String(path))).not.toContain("/api/support");
    expect(second.fetchMock.mock.calls.map(([path]) => String(path))).not.toContain("/api/support");
  }, SLOW);

  it("restores and retries an unresolved Go action without a legacy fallback", async () => {
    const actorId = "55555555-5555-4555-8555-555555555555";
    const organizationId = "66666666-6666-4666-8666-666666666666";
    const storageKey = `chaste.support.conversation-write-intent.v1:pending:${actorId}:${organizationId}`;
    const input = { conversationId, body: "Please check the invoice.", from: "staff" };
    const capabilityId = "support.postMessage";
    const intentId = "77777777-7777-4777-8777-777777777777";
    window.localStorage.setItem(storageKey, JSON.stringify({
      version: 1,
      intentId,
      capabilityId,
      input,
      fingerprint: JSON.stringify({ capabilityId, input }),
    }));
    const { calls } = supportFetch({
      execute: (payload) => {
        if (payload.capabilityId === "support.listConversations") return Response.json({ ok: true, data: { conversations } });
        if (payload.capabilityId === "support.readConversation") return Response.json({ ok: true, data: { ...thread, conversation: { ...thread.conversation, customerEmail: null } } });
        if (payload.capabilityId === "support.postMessage") return Response.json({ ok: true, data: { messageId: customerId, senderType: "staff" } });
        return Response.json({ error: "unexpected capability" }, { status: 400 });
      },
    });
    render(<SupportPage actorId={actorId} organizationId={organizationId} />);

    const retry = await screen.findByRole("button", { name: "Retry saved action" });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    expect((await screen.findByPlaceholderText("Log what the customer wrote, or write the staff reply…") as HTMLTextAreaElement).value).toBe(input.body);
    fireEvent.click(retry);
    await waitFor(() => expect(window.localStorage.getItem(storageKey)).toBeNull());
    expect(calls.find((call) => call.payload?.capabilityId === "support.postMessage")?.payload).toMatchObject({
      capabilityId,
      input,
      intentId,
    });
  }, SLOW);

  it("restores an unresolved escalation reason after the thread selection loads", async () => {
    const actorId = "55555555-5555-4555-8555-555555555555";
    const organizationId = "66666666-6666-4666-8666-666666666666";
    const storageKey = `chaste.support.conversation-write-intent.v1:pending:${actorId}:${organizationId}`;
    const input = { conversationId, reason: "Customer requested a manager callback" };
    const capabilityId = "support.escalateConversation";
    window.localStorage.setItem(storageKey, JSON.stringify({
      version: 1,
      intentId: "77777777-7777-4777-8777-777777777777",
      capabilityId,
      input,
      fingerprint: JSON.stringify({ capabilityId, input }),
    }));
    supportFetch({
      execute: (payload) => payload.capabilityId === "support.listConversations"
        ? Response.json({ ok: true, data: { conversations } })
        : Response.json({ ok: true, data: { ...thread, conversation: { ...thread.conversation, customerEmail: null } } }),
    });
    render(<SupportPage actorId={actorId} organizationId={organizationId} />);

    expect(await screen.findByLabelText("Why does this need a human owner?")).not.toBeNull();
    expect((screen.getByLabelText("Why does this need a human owner?") as HTMLInputElement).value).toBe(input.reason);
    expect(await screen.findByRole("button", { name: "Retry saved action" })).not.toBeNull();
  }, SLOW);

  it("restores and retries pending Go ticket metadata after reload", async () => {
    const actorId = "55555555-5555-4555-8555-555555555555";
    const organizationId = "66666666-6666-4666-8666-666666666666";
    const storageKey = `chaste.support.conversation-write-intent.v1:pending:${actorId}:${organizationId}`;
    const input = { conversationId, priority: "urgent", category: "billing", slaDueAt: "2026-10-12T12:00:00.000Z" };
    const capabilityId = "support.updateTicket";
    const intentId = "77777777-7777-4777-8777-777777777777";
    window.localStorage.setItem(storageKey, JSON.stringify({
      version: 1,
      intentId,
      capabilityId,
      input,
      fingerprint: JSON.stringify({ capabilityId, input }),
    }));
    const { fetchMock, calls } = supportFetch({
      execute: (payload) => {
        if (payload.capabilityId === "support.listConversations") return Response.json({ ok: true, data: { conversations } });
        if (payload.capabilityId === "support.readConversation") return Response.json({ ok: true, data: { ...thread, conversation: { ...thread.conversation, customerEmail: null } } });
        if (payload.capabilityId === "support.updateTicket") return Response.json({ ok: true, data: { updated: true } });
        return Response.json({ error: "unexpected capability" }, { status: 400 });
      },
    });
    render(<SupportPage actorId={actorId} organizationId={organizationId} />);

    await screen.findByRole("button", { name: "Retry saved action" });
    const priority = await screen.findByLabelText("Priority") as HTMLSelectElement;
    expect(priority.value).toBe("urgent");
    expect((screen.getByLabelText("Category") as HTMLInputElement).value).toBe("billing");
    expect((screen.getByLabelText("SLA due") as HTMLInputElement).value).toBe("2026-10-12T12:00");
    fireEvent.click(screen.getByRole("button", { name: "Retry saved action" }));

    await waitFor(() => expect(window.localStorage.getItem(storageKey)).toBeNull());
    expect(calls.find((call) => call.payload?.capabilityId === "support.updateTicket")?.payload).toMatchObject({
      capabilityId,
      input,
      intentId,
    });
    expect(fetchMock.mock.calls.map(([path]) => String(path))).not.toContain("/api/support");
  }, SLOW);

  it("sends explicit nulls when saving cleared ticket metadata", async () => {
    const actorId = "55555555-5555-4555-8555-555555555555";
    const organizationId = "66666666-6666-4666-8666-666666666666";
    const assigneeId = "77777777-7777-4777-8777-777777777777";
    const { calls } = supportFetch({
      getThread: () => Response.json({
        ...thread,
        conversation: {
          ...thread.conversation,
          category: "billing",
          assignedUserId: assigneeId,
          slaDueAt: "2026-10-13T12:00:00.000Z",
        },
      }),
      team: () => Response.json({ members: [{ userId: assigneeId, name: "Proof Assignee", email: "proof-assignee@example.test" }] }),
      execute: (payload) => payload.capabilityId === "support.updateTicket"
        ? Response.json({ ok: true, data: { updated: true } })
        : Response.json({ error: "unexpected capability" }, { status: 400 }),
    });
    render(<SupportPage actorId={actorId} organizationId={organizationId} />);

    await openTab(/^Inbox/);
    fireEvent.click(await screen.findByRole("button", { name: "Ticket" }));
    fireEvent.change(await screen.findByLabelText("Category"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Assignee"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("SLA due"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(calls.find((call) => call.payload?.capabilityId === "support.updateTicket")?.payload).toMatchObject({
        capabilityId: "support.updateTicket",
        input: { conversationId, priority: "normal", category: null, assigneeUserId: null, slaDueAt: null },
      });
    });
  }, SLOW);

  it("does not load customer care while the module is disabled", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/modules");
      return moduleSwitchboard(false);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SupportPage organizationId={organizationId} />);

    expect(await screen.findByText(/Customer care is switched off/)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps an AI reply as a draft until a human sends it", async () => {
    const { calls } = supportFetch({
      draft: (requestedConversationId) => {
        expect(requestedConversationId).toBe(conversationId);
        return Response.json({ draft: "Thanks for flagging this.", sessionId: "s1", steps: 4 });
      },
      execute: (payload) => {
        if (payload.capabilityId === "support.postMessage") return Response.json({ ok: true, data: { messageId: customerId, senderType: "agent" } });
        return Response.json({ ok: true, data: { updated: true } });
      },
    });
    render(<SupportPage actorId="55555555-5555-4555-8555-555555555555" organizationId="66666666-6666-4666-8666-666666666666" />);
    await openTab(/^Inbox/);

    fireEvent.click(await screen.findByRole("button", { name: "Draft reply" }));

    const draftBox = await screen.findByLabelText("AI draft reply");
    expect((draftBox as HTMLTextAreaElement).value).toBe("Thanks for flagging this.");
    expect(calls.filter((call) => call.path === "/api/support/draft")).toHaveLength(1);
    expect(calls.find((call) => call.path === "/api/support/draft")?.payload).toEqual({ conversationId });
    expect(calls.some((call) => call.payload!.capabilityId === "support.postMessage")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Send to customer" }));

    await waitFor(() => expect(calls.some((call) => call.payload!.capabilityId === "support.postMessage")).toBe(true));
    expect(calls.find((call) => call.payload!.capabilityId === "support.postMessage")?.payload).toMatchObject({
      capabilityId: "support.postMessage",
      input: { conversationId, body: "Thanks for flagging this.", from: "staff" },
    });
    await waitFor(() => expect(screen.queryByLabelText("AI draft reply")).toBeNull());
  }, SLOW);

  it("surfaces an approval-pending write as pending, not as a failure or a save", async () => {
    const { calls } = supportFetch({
      execute: (payload) => {
        if (payload.capabilityId === "support.resolveConversation") return Response.json({ ok: false, pendingApproval: true, reason: "Resolving needs human approval." }, { status: 202 });
        return Response.json({ ok: true, data: { updated: true } });
      },
    });
    render(<SupportPage actorId="55555555-5555-4555-8555-555555555555" organizationId="66666666-6666-4666-8666-666666666666" />);
    await openTab(/^Inbox/);

    fireEvent.click(await screen.findByRole("button", { name: "Resolve" }));

    expect(await screen.findByText("Resolving needs human approval.")).not.toBeNull();
    expect(calls.filter((call) => call.payload!.capabilityId === "support.resolveConversation")).toHaveLength(1);
  }, SLOW);

  it("requires a reason before escalating a conversation", async () => {
    const { calls } = supportFetch({
      execute: (payload) => payload.capabilityId === "support.escalateConversation" ? Response.json({ ok: true, data: { status: "escalated" } }) : Response.json({ ok: true, data: { updated: true } }),
    });
    render(<SupportPage actorId="55555555-5555-4555-8555-555555555555" organizationId="66666666-6666-4666-8666-666666666666" />);
    await openTab(/^Inbox/);

    fireEvent.click(await screen.findByRole("button", { name: "Escalate" }));

    const confirm = screen.getByRole("button", { name: "Confirm escalation" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirm);
    expect(calls.some((call) => call.payload!.capabilityId === "support.escalateConversation")).toBe(false);

    fireEvent.change(screen.getByLabelText("Why does this need a human owner?"), { target: { value: "Customer asked for a refund above policy" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm escalation" }));

    await waitFor(() => expect(calls.some((call) => call.payload!.capabilityId === "support.escalateConversation")).toBe(true));
    expect(calls.find((call) => call.payload!.capabilityId === "support.escalateConversation")?.payload).toMatchObject({
      capabilityId: "support.escalateConversation",
      input: { conversationId, reason: "Customer asked for a refund above policy" },
    });
  }, SLOW);

  it("publishes a canned response with an intent identity and never without one", async () => {
    const actorId = "55555555-5555-4555-8555-555555555555";
    const organizationId = "66666666-6666-4666-8666-666666666666";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "POST") {
        const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (payload.capabilityId === "support.createCannedResponse") {
          expect(payload.intentId).toEqual(expect.any(String));
          return Response.json({ ok: true, data: { cannedResponseId: "c1" } });
        }
        if (payload.capabilityId === "support.listConversations") return Response.json({ ok: true, data: { conversations } });
        if (payload.capabilityId === "support.readConversation") return Response.json({ ok: true, data: { ...thread, conversation: { ...thread.conversation, customerEmail: null } } });
        if (payload.capabilityId === "support.listLibrary") return Response.json({ ok: true, data: { canned: [], articles: [] } });
        return Response.json({ ok: true, data: { updated: true } });
      }
      if (path === "/api/modules") return moduleSwitchboard();
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SupportPage actorId={actorId} organizationId={organizationId} />);
    await screen.findByText("Latest activity");
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    await screen.findByText("Knowledge base");

    fireEvent.change(screen.getByLabelText("Canned shortcut"), { target: { value: "/refund" } });
    fireEvent.change(screen.getByLabelText("Canned response title"), { target: { value: "Refund policy answer" } });
    fireEvent.change(screen.getByLabelText("Reply body"), { target: { value: "Refunds are processed within five days." } });
    fireEvent.click(screen.getByRole("button", { name: "Save response" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([input, init]) => String(input) === "/api/capabilities/execute" && JSON.parse(String(init?.body)).capabilityId === "support.listLibrary")).toHaveLength(2),
    );
    expect((screen.getByLabelText("Canned shortcut") as HTMLInputElement).value).toBe("");
  }, SLOW);

  it("saves support articles through Go as internal unless staff explicitly publish them", async () => {
    const actorId = "55555555-5555-4555-8555-555555555555";
    const organizationId = "66666666-6666-4666-8666-666666666666";
    let createPayload: { capabilityId?: string; input?: Record<string, unknown> } | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/capabilities/execute" && init?.method === "POST") {
        const payload = JSON.parse(String(init.body)) as { capabilityId?: string; input?: Record<string, unknown> };
        if (payload.capabilityId === "support.createKbArticle") {
          createPayload = payload;
          return Response.json({ ok: true, data: { articleId: conversationId } });
        }
        if (payload.capabilityId === "support.listConversations") return Response.json({ ok: true, data: { conversations: [] } });
        if (payload.capabilityId === "support.listLibrary") return Response.json({ ok: true, data: { canned: [], articles: [] } });
        return Response.json({ error: "unexpected capability" }, { status: 400 });
      }
      if (path === "/api/modules") return moduleSwitchboard();
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SupportPage actorId={actorId} organizationId={organizationId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Library" }));
    fireEvent.change(screen.getByLabelText("Article title"), { target: { value: "Return policy" } });
    fireEvent.change(screen.getByLabelText("Article body"), { target: { value: "Keep this article private until approved." } });
    expect(screen.getByRole("checkbox", { name: "Make this article available to public support replies" })).toHaveProperty("checked", false);
    fireEvent.click(screen.getByRole("button", { name: "Save internal article" }));

    await waitFor(() => expect(createPayload).toMatchObject({
      capabilityId: "support.createKbArticle",
      input: { title: "Return policy", body: "Keep this article private until approved.", isPublic: false },
    }));
    expect(fetchMock.mock.calls.some(([path, init]) => String(path) === "/api/support" && init?.method === "POST")).toBe(false);
  }, SLOW);
});
