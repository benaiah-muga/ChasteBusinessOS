import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSupportCustomer,
  fetchSupportChannels,
  fetchSupportConversations,
  fetchSupportDraft,
  fetchSupportEnabled,
  fetchSupportThread,
  submitSupportAction,
  SupportApiError,
  SupportWriteActionSchema,
  updateSupportChannels,
} from "./support";

const conversationId = "3f1b0c6e-2f6a-4a0a-9c9e-6c1a2b3d4e5f";
const customerId = "b2b7d5f0-9a3a-4f38-8f47-1a2b3c4d5e6f";

const conversationRow = {
  id: conversationId,
  customerId,
  customerName: "Ada Lovelace",
  subject: "Invoice question",
  status: "open",
  lastMessageAt: "2026-09-20T09:30:00.000Z",
  lastMessagePreview: "My invoice looks wrong",
};

const message = {
  id: "d6a3b0c1-2f6a-4a0a-9c9e-6c1a2b3d4e5f",
  orgId: customerId,
  conversationId,
  senderType: "customer",
  senderUserId: null,
  body: "My invoice looks wrong",
  createdAt: "2026-09-20T09:30:00.000Z",
};

const threadResponse = {
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
  messages: [message],
};

function moduleSwitchboard(enabled = true) {
  return Response.json({
    catalog: [
      { id: "support", label: "Customer care", description: "Support desk with AI-drafted replies", href: "/support" },
      { id: "crm", label: "CRM", description: "Customer relationships", href: "/crm" },
    ],
    enabledModules: enabled ? ["support", "crm"] : ["crm"],
    usingDefaults: false,
  });
}

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("support module switchboard", () => {
  it("reports customer care as disabled without loading the inbox", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/modules");
      return moduleSwitchboard(false);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSupportEnabled()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("turns an unreachable support service into a recoverable API error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));

    await expect(fetchSupportConversations()).rejects.toBeInstanceOf(SupportApiError);
    await expect(fetchSupportConversations()).rejects.toMatchObject({
      name: "SupportApiError",
      status: 0,
      message: expect.stringContaining("Could not reach the support service"),
    });
  });

  it("rejects a conversation row carrying fields the contract does not declare", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ conversations: [{ ...conversationRow, unexpected: true }] })));

    await expect(fetchSupportConversations()).rejects.toMatchObject({
      status: 200,
      message: "The support service returned data in an unexpected format.",
    });
  });
});

describe("support thread reads", () => {
  it("reads a thread through the same-origin legacy endpoint", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/support?id=${conversationId}`);
      expect(init?.credentials).toBe("same-origin");
      return jsonResponse(threadResponse);
    });
    vi.stubGlobal("fetch", fetchMock);

    const thread = await fetchSupportThread(conversationId);

    expect(thread.conversation.customerName).toBe("Ada Lovelace");
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]?.senderType).toBe("customer");
  });

  it("refuses to read a thread for an id that is not a conversation", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(threadResponse));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSupportThread("not-a-uuid")).rejects.toMatchObject({ status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("governed support writes", () => {
  it("accepts explicit publication choices and rejects non-boolean values", () => {
    expect(SupportWriteActionSchema.safeParse({ action: "createKbArticle", title: "Returns", body: "Policy", isPublic: true }).success).toBe(true);
    expect(SupportWriteActionSchema.safeParse({ action: "createKbArticle", title: "Returns", body: "Policy", isPublic: "true" }).success).toBe(false);
  });

  it("surfaces an approval-pending answer as pending, never as a save", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toMatchObject({ action: "resolve", conversationId });
      return jsonResponse({ ok: false, pendingApproval: true, reason: "Resolving needs human approval." }, 202);
    });
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await submitSupportAction({ action: "resolve", conversationId });

    expect(outcome).toEqual({ kind: "pending", reason: "Resolving needs human approval." });
  });

  it("reads the legacy error-plus-flag approval envelope as pending too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "pending human approval", pendingApproval: true }, 202)));

    await expect(submitSupportAction({ action: "resolve", conversationId })).resolves.toEqual({
      kind: "pending",
      reason: "pending human approval",
    });
  });

  it("does not treat an incomplete approval response as a pending action", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ pendingApproval: true }, 202)));

    await expect(submitSupportAction({ action: "resolve", conversationId })).rejects.toMatchObject({
      message: "The support service returned an unexpected approval response.",
    });
  });

  it("does not report success when the action result violates its contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, data: {} })));

    await expect(submitSupportAction({ action: "message", conversationId, body: "hi", from: "staff" })).rejects.toMatchObject({
      message: "The support service returned an unexpected action result.",
    });
  });

  it("stamps an intent identity only where one was supplied", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ ok: true, data: { updated: true } });
    }));

    await submitSupportAction({ action: "updateTicket", conversationId, priority: "high" });
    await submitSupportAction({ action: "updateTicket", conversationId, priority: "high" }, "intent-for-the-ticket");

    expect(bodies[0]).not.toHaveProperty("intentId");
    expect(bodies[1]).toMatchObject({ intentId: "intent-for-the-ticket" });
  });

  it("carries an intent identity when the customer service creates a record", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { action: string; name: string; intentId: string };
      expect(payload).toMatchObject({ action: "create", name: "Grace Hopper" });
      expect(payload.intentId).toEqual(expect.any(String));
      return jsonResponse({ ok: true, data: { customerId, duplicateWarning: null } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await createSupportCustomer({ name: "Grace Hopper" });

    expect(outcome).toEqual({ kind: "completed", data: { customerId, duplicateWarning: null } });
  });

  it("keeps a pending customer creation visible as pending", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, pendingApproval: true, reason: "Creating customers needs approval." }, 202)));

    await expect(createSupportCustomer({ name: "Grace Hopper" })).resolves.toEqual({
      kind: "pending",
      reason: "Creating customers needs approval.",
    });
  });
});

describe("support drafting", () => {
  it("asks for a draft without writing anything to the thread", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ draft: "Thanks for flagging this.", sessionId: "session-1", steps: 4 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const draft = await fetchSupportDraft(conversationId);

    expect(draft.draft).toBe("Thanks for flagging this.");
    expect(bodies).toEqual([{ action: "draft", conversationId }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a drafting refusal with the service's own copy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "nothing to answer yet; log the customer's message first" }, 400)));

    await expect(fetchSupportDraft(conversationId)).rejects.toMatchObject({
      status: 400,
      message: "Nothing to answer yet; log the customer's message first",
    });
  });
});

describe("support channel settings", () => {
  it("reads channel settings using the strict legacy and Go response contract", async () => {
    const expected = { autoReplyEnabled: true, greeting: "Welcome", embedToken: null, canManage: false };
    const fetchMock = vi.fn(async () => jsonResponse(expected));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSupportChannels()).resolves.toEqual(expected);
    expect(fetchMock).toHaveBeenCalledWith("/api/support/channels", expect.objectContaining({
      credentials: "same-origin",
      headers: { accept: "application/json" },
    }));
  });

  it("refuses a channel change that says nothing", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateSupportChannels({})).rejects.toMatchObject({ status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a reply body that breaks the contract instead of reporting a save", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ autoReplyEnabled: true, greeting: "", embedToken: null, canManage: true, extra: 1 })));

    await expect(updateSupportChannels({ autoReplyEnabled: true })).rejects.toMatchObject({
      message: "The support service returned unexpected channel settings.",
    });
  });
});
