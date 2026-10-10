import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSupportCustomer,
  fetchSupportChannels,
  fetchSupportConversations,
  fetchSupportDraft,
  fetchSupportEnabled,
  fetchSupportLibrary,
  fetchSupportThread,
  goSupportInboxReadsUseGo,
  goSupportLibraryReadsUseGo,
  goSupportCannedResponseWriteUseGo,
  goSupportConversationWritesUseGo,
  readPendingSupportCannedResponse,
  readPendingSupportConversationWrite,
  supportWriteActionFromPending,
  submitSupportConversationAction,
  submitSupportCannedResponse,
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

const supportLibrary = {
  canned: [{ id: "9a145d87-5642-4c92-9d87-67f93b63b327", shortcut: "/refund", title: "Refund status", body: "Your refund is being processed." }],
  articles: [{ id: "cc4ec95d-9332-4c4e-8d63-7b065cc88442", title: "Returns", body: "Return policy details.", category: "orders", isPublic: false }],
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
  window.localStorage.clear();
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

describe("support Go inbox reads", () => {
  it("loads the inbox through the strict Go capability contract", async () => {
    vi.stubGlobal("__GO_SUPPORT_INBOX_READS__", true);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: { conversations: [conversationRow] } }));
    vi.stubGlobal("fetch", fetchMock);

    expect(goSupportInboxReadsUseGo()).toBe(true);
    await expect(fetchSupportConversations()).resolves.toEqual([conversationRow]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      body: expect.stringContaining('"capabilityId":"support.listConversations"'),
    }));
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { input?: unknown; intentId?: string };
    expect(request.input).toEqual({ customerBoundOnly: true, limit: 100 });
    expect(request.intentId).toEqual(expect.any(String));
  });

  it("uses Go full-detail mode and projects its strict guest-customer shape", async () => {
    vi.stubGlobal("__GO_SUPPORT_INBOX_READS__", true);
    const goThread = {
      conversation: { ...threadResponse.conversation, customerId: null, customerEmail: "guest@example.test" },
      messages: [message],
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: goThread }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchSupportThread(conversationId);

    expect(result.conversation.customerId).toBe("");
    expect(result.conversation).not.toHaveProperty("customerEmail");
    expect(result.messages).toEqual([message]);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      body: expect.stringContaining('"capabilityId":"support.readConversation"'),
    }));
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { input?: unknown };
    expect(request.input).toEqual({ conversationId, limit: 200 });
  });

  it("fails closed on Go read errors without retrying the legacy Support route", async () => {
    vi.stubGlobal("__GO_SUPPORT_INBOX_READS__", true);
    const fetchMock = vi.fn(async () => jsonResponse({ error: "support backend unavailable" }, 503));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSupportConversations()).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.anything());
  });

  it("rejects malformed Go success data without retrying the legacy Support route", async () => {
    vi.stubGlobal("__GO_SUPPORT_INBOX_READS__", true);
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: { conversations: [{ ...conversationRow, unexpected: true }] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSupportConversations()).rejects.toMatchObject({
      status: 200,
      message: "The Go support service returned data in an unexpected format.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.anything());
  });
});

describe("support Go library read", () => {
  it("loads canned responses and knowledge articles through the Go capability", async () => {
    vi.stubGlobal("__GO_SUPPORT_LIBRARY_READS__", true);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: supportLibrary }));
    vi.stubGlobal("fetch", fetchMock);

    expect(goSupportLibraryReadsUseGo()).toBe(true);
    await expect(fetchSupportLibrary()).resolves.toEqual(supportLibrary);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      body: expect.stringContaining('"capabilityId":"support.listLibrary"'),
    }));
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { input?: unknown; intentId?: string };
    expect(request.input).toEqual({});
    expect(request.intentId).toEqual(expect.any(String));
  });

  it("rejects malformed Go library data without retrying the legacy read", async () => {
    vi.stubGlobal("__GO_SUPPORT_LIBRARY_READS__", true);
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: { ...supportLibrary, unexpected: true } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSupportLibrary()).rejects.toMatchObject({
      status: 200,
      message: "The Go support service returned data in an unexpected format.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.anything());
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

describe("Go canned-response write", () => {
  const scope = {
    actorId: "55555555-5555-4555-8555-555555555555",
    organizationId: "66666666-6666-4666-8666-666666666666",
  };
  const action = { action: "createCannedResponse" as const, shortcut: "/refund", title: "Refund policy", body: "We can help with eligible returns." };

  it("submits the existing Go capability contract with a persisted idempotency intent", async () => {
    vi.stubGlobal("__GO_SUPPORT_CANNED_RESPONSE_WRITE__", true);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: { cannedResponseId: conversationId } }));
    vi.stubGlobal("fetch", fetchMock);

    expect(goSupportCannedResponseWriteUseGo()).toBe(true);
    await expect(submitSupportCannedResponse(action, scope)).resolves.toEqual({ kind: "completed", data: { cannedResponseId: conversationId } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({ method: "POST", cache: "no-store" }));
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { capabilityId: string; input: unknown; intentId: string };
    expect(payload.capabilityId).toBe("support.createCannedResponse");
    expect(payload.input).toEqual({ shortcut: "/refund", title: "Refund policy", body: "We can help with eligible returns." });
    expect(payload.intentId).toEqual(expect.any(String));
    expect(readPendingSupportCannedResponse(scope)).toBeNull();
  });

  it("keeps exact retry details after an uncertain result and blocks changed or rolled-back writes", async () => {
    vi.stubGlobal("__GO_SUPPORT_CANNED_RESPONSE_WRITE__", true);
    const fetchMock = vi.fn(async () => jsonResponse({ error: "temporarily unavailable" }, 503));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitSupportCannedResponse(action, scope)).rejects.toMatchObject({ status: 503 });
    const pending = readPendingSupportCannedResponse(scope);
    expect(pending).toEqual({ shortcut: action.shortcut, title: action.title, body: action.body });
    const retryRecord = JSON.parse(window.localStorage.getItem("chaste.support.canned-response-intent.v1:55555555-5555-4555-8555-555555555555:66666666-6666-4666-8666-666666666666") ?? "{}") as { intentId?: unknown };

    await expect(submitSupportCannedResponse({ ...action, body: "Changed copy" }, scope)).rejects.toMatchObject({ status: 0, message: expect.stringContaining("exact saved details") });
    vi.stubGlobal("__GO_SUPPORT_CANNED_RESPONSE_WRITE__", false);
    await expect(submitSupportCannedResponse(action, scope)).rejects.toMatchObject({ status: 0, message: expect.stringContaining("Restore Go canned-response writes") });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(retryRecord.intentId).toEqual(expect.any(String));
  });

  it("retains a pending or malformed success response without trying the legacy route", async () => {
    vi.stubGlobal("__GO_SUPPORT_CANNED_RESPONSE_WRITE__", true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: false, pendingApproval: true, reason: "Needs approval." }, 202))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { unexpected: true } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitSupportCannedResponse(action, scope)).resolves.toEqual({ kind: "pending", reason: "Needs approval." });
    expect(readPendingSupportCannedResponse(scope)).toEqual({ shortcut: action.shortcut, title: action.title, body: action.body });
    await expect(submitSupportCannedResponse(action, scope)).rejects.toMatchObject({
      status: 200,
      message: "The Go support service returned an unexpected canned-response result.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([path]) => String(path))).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
  });

  it("retains the same intent after a 422 executor conflict", async () => {
    vi.stubGlobal("__GO_SUPPORT_CANNED_RESPONSE_WRITE__", true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: "intent conflict" }, 422))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { cannedResponseId: conversationId } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitSupportCannedResponse(action, scope)).rejects.toMatchObject({ status: 422 });
    const firstPayload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { intentId: string };
    expect(readPendingSupportCannedResponse(scope)).toEqual({ shortcut: action.shortcut, title: action.title, body: action.body });
    await expect(submitSupportCannedResponse(action, scope)).resolves.toMatchObject({ kind: "completed" });
    const retryPayload = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { intentId: string };
    expect(retryPayload.intentId).toBe(firstPayload.intentId);
  });
});

describe("Go support conversation writes", () => {
  const scope = {
    actorId: "55555555-5555-4555-8555-555555555555",
    organizationId: "66666666-6666-4666-8666-666666666666",
  };
  const storageKey = `chaste.support.conversation-write-intent.v1:pending:${scope.actorId}:${scope.organizationId}`;

  it("submits conversation creation with a durable intent and validates the strict Go output", async () => {
    vi.stubGlobal("__GO_SUPPORT_CONVERSATION_WRITES__", true);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: { conversationId } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitSupportConversationAction({ action: "create", customerId, subject: "Invoice question" }, scope))
      .resolves.toEqual({ kind: "completed", data: { conversationId } });
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { capabilityId: string; input: unknown; intentId: string };
    expect(payload).toMatchObject({ capabilityId: "support.startConversation", input: { customerId, subject: "Invoice question" } });
    expect(payload.intentId).toEqual(expect.any(String));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(window.localStorage.getItem(storageKey)).toBeNull();
  });

  it("reuses exact message payload and intent after uncertain response or reload", async () => {
    vi.stubGlobal("__GO_SUPPORT_CONVERSATION_WRITES__", true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { messageId: customerId, senderType: "staff" } }));
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "message" as const, conversationId, body: "Please check the invoice.", from: "staff" as const };

    await expect(submitSupportConversationAction(action, scope)).rejects.toMatchObject({ status: 503 });
    const pending = readPendingSupportConversationWrite(scope);
    expect(pending).toEqual({ capabilityId: "support.postMessage", input: { conversationId, body: action.body, from: "staff" } });
    expect(supportWriteActionFromPending(pending!)).toEqual(action);
    const firstIntent = JSON.parse(window.localStorage.getItem(storageKey) ?? "{}").intentId;

    await expect(submitSupportConversationAction({ ...action, body: "Changed reply" }, scope)).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining("exact saved details"),
    });
    await expect(submitSupportConversationAction(action, scope)).resolves.toEqual({
      kind: "completed",
      data: { messageId: customerId, senderType: "staff" },
    });
    const retries = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { intentId: string; input: unknown });
    expect(retries[0]?.intentId).toBe(firstIntent);
    expect(retries[1]?.intentId).toBe(firstIntent);
    expect(retries[1]?.input).toEqual({ conversationId, body: action.body, from: "staff" });
    expect(window.localStorage.getItem(storageKey)).toBeNull();
  });

  it("preserves the supported customer-words attribution choice in the Go message input", async () => {
    vi.stubGlobal("__GO_SUPPORT_CONVERSATION_WRITES__", true);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: { messageId: customerId, senderType: "customer" } }));
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "message" as const, conversationId, body: "I called this morning.", from: "customer" as const };

    await expect(submitSupportConversationAction(action, scope)).resolves.toEqual({
      kind: "completed",
      data: { messageId: customerId, senderType: "customer" },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      capabilityId: "support.postMessage",
      input: { conversationId, body: "I called this morning.", from: "customer" },
    });
  });

  it.each([
    [{ action: "send", conversationId, body: "Draft reply." }, "support.postMessage", { conversationId, body: "Draft reply.", from: "staff" }, { messageId: customerId, senderType: "staff" }],
    [{ action: "escalate", conversationId, reason: "Needs a policy decision" }, "support.escalateConversation", { conversationId, reason: "Needs a policy decision" }, { status: "escalated" }],
    [{ action: "reopen", conversationId }, "support.reopenConversation", { conversationId }, { status: "open" }],
  ] as const)("maps %s to the matching Go capability", async (action, expectedCapability, input, output) => {
    vi.stubGlobal("__GO_SUPPORT_CONVERSATION_WRITES__", true);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: output }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitSupportConversationAction(action, scope)).resolves.toMatchObject({ kind: "completed", data: output });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ capabilityId: expectedCapability, input });
  });

  it("keeps 202, 404, and malformed success outcomes unresolved without legacy fallback", async () => {
    vi.stubGlobal("__GO_SUPPORT_CONVERSATION_WRITES__", true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: false, pendingApproval: true, reason: "Needs approval." }, 202))
      .mockResolvedValueOnce(jsonResponse({ error: "not found" }, 404))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { unexpected: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "resolve" as const, conversationId };

    await expect(submitSupportConversationAction(action, scope)).resolves.toEqual({ kind: "pending", reason: "Needs approval." });
    await expect(submitSupportConversationAction(action, scope)).rejects.toMatchObject({ status: 404 });
    await expect(submitSupportConversationAction(action, scope)).rejects.toMatchObject({ status: 200, message: expect.stringContaining("unexpected conversation result") });
    expect(readPendingSupportConversationWrite(scope)).toEqual({ capabilityId: "support.resolveConversation", input: { conversationId } });
    expect(fetchMock.mock.calls.map(([path]) => String(path))).toEqual([
      "/api/capabilities/execute",
      "/api/capabilities/execute",
      "/api/capabilities/execute",
    ]);
  });

  it("blocks legacy rollback while a Go action remains unresolved", async () => {
    vi.stubGlobal("__GO_SUPPORT_CONVERSATION_WRITES__", true);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "unavailable" }, 503)));
    const action = { action: "reopen" as const, conversationId };
    await expect(submitSupportConversationAction(action, scope)).rejects.toMatchObject({ status: 503 });

    vi.stubGlobal("__GO_SUPPORT_CONVERSATION_WRITES__", false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitSupportConversationAction(action, scope)).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining("Restore Go conversation writes"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(goSupportConversationWritesUseGo()).toBe(false);
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
