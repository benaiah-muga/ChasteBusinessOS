import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubWebLocks } from "../test/web-locks";
import {
  createSupportCustomer,
  fetchSupportChannels,
  fetchSupportConversations,
  fetchSupportCustomerOptions,
  fetchSupportDraft,
  fetchSupportEnabled,
  fetchSupportLibrary,
  fetchSupportThread,
  readPendingSupportCannedResponse,
  readPendingSupportKbArticle,
  readPendingSupportTicket,
  readPendingSupportConversationWrite,
  supportWriteActionFromPending,
  submitSupportConversationAction,
  submitSupportCannedResponse,
  submitSupportKbArticle,
  submitSupportTicket,
  submitSupportAction,
  SupportApiError,
  SupportWriteActionSchema,
  updateSupportChannels,
} from "./support";

const conversationId = "3f1b0c6e-2f6a-4a0a-9c9e-6c1a2b3d4e5f";
const organizationId = "66666666-6666-4666-8666-666666666666";
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

beforeEach(stubWebLocks);

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

    await expect(fetchSupportConversations(organizationId)).rejects.toBeInstanceOf(SupportApiError);
    await expect(fetchSupportConversations(organizationId)).rejects.toMatchObject({
      name: "SupportApiError",
      status: 0,
      message: expect.stringContaining("Could not reach the support service"),
    });
  });

  it("rejects a conversation row carrying fields the contract does not declare", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, data: { conversations: [{ ...conversationRow, unexpected: true }] } })));

    await expect(fetchSupportConversations(organizationId)).rejects.toMatchObject({
      status: 200,
      message: "The Go support service returned data in an unexpected format.",
    });
  });
});

describe("support Go inbox reads", () => {
  it("loads the inbox through the strict Go capability contract", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: { conversations: [conversationRow] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSupportConversations(organizationId)).resolves.toEqual([conversationRow]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      body: expect.stringContaining('"capabilityId":"support.listConversations"'),
    }));
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Organization-ID")).toBe(organizationId);
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { input?: unknown; intentId?: string };
    expect(request.input).toEqual({ customerBoundOnly: true, limit: 100 });
    expect(request.intentId).toEqual(expect.any(String));
  });

  it("uses Go full-detail mode and projects its strict guest-customer shape", async () => {
    const goThread = {
      conversation: { ...threadResponse.conversation, customerId: null, customerEmail: "guest@example.test" },
      messages: [message],
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: goThread }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchSupportThread(conversationId, organizationId);

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
    const fetchMock = vi.fn(async () => jsonResponse({ error: "support backend unavailable" }, 503));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSupportConversations(organizationId)).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.anything());
  });

  it("fails closed before sending a Go read without a valid organization", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSupportConversations(null)).rejects.toMatchObject({ status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed Go success data without retrying the legacy Support route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: { conversations: [{ ...conversationRow, unexpected: true }] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSupportConversations(organizationId)).rejects.toMatchObject({
      status: 200,
      message: "The Go support service returned data in an unexpected format.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.anything());
  });
});

describe("support Go library read", () => {
  it("loads canned responses and knowledge articles through the Go capability", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: supportLibrary }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSupportLibrary(organizationId)).resolves.toEqual(supportLibrary);
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
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: { ...supportLibrary, unexpected: true } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSupportLibrary(organizationId)).rejects.toMatchObject({
      status: 200,
      message: "The Go support service returned data in an unexpected format.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.anything());
  });
});

describe("support thread reads", () => {
  it("reads a thread through the Go capability with guest-customer projection", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/capabilities/execute");
      expect(init?.credentials).toBe("same-origin");
      return jsonResponse({ ok: true, data: {
        conversation: { ...threadResponse.conversation, customerEmail: null },
        messages: threadResponse.messages,
      } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const thread = await fetchSupportThread(conversationId, organizationId);

    expect(thread.conversation.customerName).toBe("Ada Lovelace");
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]?.senderType).toBe("customer");
  });

  it("refuses to read a thread for an id that is not a conversation", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(threadResponse));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSupportThread("not-a-uuid", organizationId)).rejects.toMatchObject({ status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("support customer picker read", () => {
  it("reads the Go picker projection with same-origin credentials", async () => {
    const customer = { id: customerId, name: "Ada Lovelace", email: "ada@example.test", purchaseCount: 2, lifetimeSpendMinor: 2500 };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/support/customers");
      expect(init?.credentials).toBe("same-origin");
      return jsonResponse({ customers: [customer] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSupportCustomerOptions()).resolves.toEqual([customer]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed picker rows and preserves HTTP errors", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ customers: [{ id: "not-a-uuid", name: "Ada" }] }))
      .mockResolvedValueOnce(jsonResponse({ error: "forbidden" }, 403));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSupportCustomerOptions()).rejects.toMatchObject({ status: 200, message: "The support service returned data in an unexpected format." });
    await expect(fetchSupportCustomerOptions()).rejects.toMatchObject({ status: 403, message: expect.stringContaining("permission") });
  });
});

describe("governed support writes", () => {
  it("accepts explicit publication choices and rejects non-boolean values", () => {
    expect(SupportWriteActionSchema.safeParse({ action: "createKbArticle", title: "Returns", body: "Policy", isPublic: true }).success).toBe(true);
    expect(SupportWriteActionSchema.safeParse({ action: "createKbArticle", title: "Returns", body: "Policy", isPublic: "true" }).success).toBe(false);
  });

  it("routes category suggestions through the strict Go capability and never retries the legacy Support route", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.cache).toBe("no-store");
      return jsonResponse({ ok: true, data: { category: "billing", draft: true } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitSupportAction({ action: "suggestCategory", text: "The item arrived damaged" }, undefined, undefined, organizationId))
      .resolves.toEqual({ kind: "completed", data: { category: "billing", draft: true } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.anything());
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Organization-ID")).toBe(organizationId);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      capabilityId: "support.suggestCategory",
      input: { text: "The item arrived damaged" },
      intentId: expect.any(String),
    });
  });

  it("rejects unscoped knowledge article writes before they can reach the legacy route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: { articleId: crypto.randomUUID() } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitSupportAction({ action: "createKbArticle", title: "Returns", body: "Policy" })).rejects.toMatchObject({
      status: 503,
      message: "Knowledge articles must be saved through the scoped Go capability.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed on malformed Go category suggestions", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: { category: "billing", draft: false } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitSupportAction({ action: "suggestCategory", text: "The item arrived damaged" }, undefined, undefined, organizationId)).rejects.toMatchObject({
      status: 200,
      message: "The Go support service returned data in an unexpected format.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.anything());
  });

  it("requires organization-scoped Go entry points for conversation and ticket writes", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitSupportAction({ action: "resolve", conversationId })).rejects.toMatchObject({
      status: 503,
      message: "This support change must use its organization-scoped Go capability.",
    });
    await expect(submitSupportAction({ action: "message", conversationId, body: "hi", from: "staff" })).rejects.toMatchObject({
      status: 503,
      message: "This support change must use its organization-scoped Go capability.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const retryScope = {
    actorId: "55555555-5555-4555-8555-555555555555",
    organizationId: "66666666-6666-4666-8666-666666666666",
  };

  it("uses the Go CRM capability and keeps its idempotency intent after an uncertain response", async () => {
    vi.stubGlobal("__GO_CRM_CUSTOMER_CREATE__", true);
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { customerId, duplicateWarning: null } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createSupportCustomer({ name: "Grace Hopper", email: "grace@example.test" }, retryScope)).rejects.toMatchObject({ requestMayHaveReachedServer: true });
    const outcome = await createSupportCustomer({ name: "Grace Hopper", email: "grace@example.test" }, retryScope);

    expect(outcome).toEqual({ kind: "completed", data: { customerId, duplicateWarning: null } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const second = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(first).toMatchObject({
      capabilityId: "crm.createCustomer",
      input: { name: "Grace Hopper", email: "grace@example.test", preferredContactMethod: "email", doNotContact: false },
      intentId: expect.any(String),
    });
    expect(second.intentId).toBe(first.intentId);
    expect(fetchMock.mock.calls.map(([path]) => path)).not.toContain("/api/customers");
  });

  it("validates quick-created customer details before sending a capability request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(createSupportCustomer({ name: "  " }, retryScope)).rejects.toMatchObject({ name: "SupportApiError" });
    await expect(createSupportCustomer({ name: "Grace Hopper", email: "bad" }, retryScope)).rejects.toMatchObject({ name: "SupportApiError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a pending customer creation visible as pending", async () => {
    vi.stubGlobal("__GO_CRM_CUSTOMER_CREATE__", true);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, pendingApproval: true, reason: "Creating customers needs approval." }, 202)));

    await expect(createSupportCustomer({ name: "Grace Hopper" }, retryScope)).resolves.toEqual({
      kind: "pending",
      reason: "Creating customers needs approval.",
    });
  });

  it("fails closed when the Go customer-create route is disabled", async () => {
    vi.stubGlobal("__GO_CRM_CUSTOMER_CREATE__", false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(createSupportCustomer({ name: "Grace Hopper" }, retryScope)).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Go canned-response write", () => {
  const scope = {
    actorId: "55555555-5555-4555-8555-555555555555",
    organizationId: "66666666-6666-4666-8666-666666666666",
  };
  const action = { action: "createCannedResponse" as const, shortcut: "/refund", title: "Refund policy", body: "We can help with eligible returns." };

  it("submits the existing Go capability contract with a persisted idempotency intent", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: { cannedResponseId: conversationId } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitSupportCannedResponse(action, scope)).resolves.toEqual({ kind: "completed", data: { cannedResponseId: conversationId } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({ method: "POST", cache: "no-store" }));
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { capabilityId: string; input: unknown; intentId: string };
    expect(payload.capabilityId).toBe("support.createCannedResponse");
    expect(payload.input).toEqual({ shortcut: "/refund", title: "Refund policy", body: "We can help with eligible returns." });
    expect(payload.intentId).toEqual(expect.any(String));
    expect(readPendingSupportCannedResponse(scope)).toBeNull();
  });

  it("accepts an opaque Better Auth user ID while keeping organization IDs UUID scoped", async () => {
    const opaqueScope = { ...scope, actorId: "user-auth0|opaque-id" };
    const fetchMock = vi.fn(async () => jsonResponse({ error: "temporarily unavailable" }, 503));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitSupportCannedResponse(action, opaqueScope)).rejects.toMatchObject({ status: 503 });
    expect(readPendingSupportCannedResponse(opaqueScope)).toEqual({ shortcut: action.shortcut, title: action.title, body: action.body });
    expect(window.localStorage.getItem(`chaste.support.canned-response-intent.v1:${encodeURIComponent(opaqueScope.actorId)}:${scope.organizationId}`)).not.toBeNull();

    await expect(submitSupportCannedResponse(action, { ...opaqueScope, organizationId: "not-a-uuid" })).rejects.toThrow(/account and organization/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { actorId: null, label: "missing" },
    { actorId: "u".repeat(256), label: "oversized" },
  ])("fails closed for a $label actor ID", async ({ actorId }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitSupportCannedResponse(action, { ...scope, actorId })).rejects.toThrow(/account and organization/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps exact retry details after an uncertain result and blocks changed or rolled-back writes", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "temporarily unavailable" }, 503));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitSupportCannedResponse(action, scope)).rejects.toMatchObject({ status: 503 });
    const pending = readPendingSupportCannedResponse(scope);
    expect(pending).toEqual({ shortcut: action.shortcut, title: action.title, body: action.body });
    const retryRecord = JSON.parse(window.localStorage.getItem("chaste.support.canned-response-intent.v1:55555555-5555-4555-8555-555555555555:66666666-6666-4666-8666-666666666666") ?? "{}") as { intentId?: unknown };

    await expect(submitSupportCannedResponse({ ...action, body: "Changed copy" }, scope)).rejects.toMatchObject({ status: 0, message: expect.stringContaining("exact saved details") });
    const retryFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: { cannedResponseId: conversationId } }));
    vi.stubGlobal("fetch", retryFetch);
    await expect(submitSupportCannedResponse(action, scope)).resolves.toMatchObject({ kind: "completed" });
    expect(new Headers(retryFetch.mock.calls[0]?.[1]?.headers).get("X-Organization-ID")).toBe(scope.organizationId);
    expect(retryFetch).toHaveBeenCalledTimes(1);
    expect(retryRecord.intentId).toEqual(expect.any(String));
  });

  it("retains a pending or malformed success response without trying the legacy route", async () => {
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

describe("Go knowledge article write", () => {
  const scope = {
    actorId: "55555555-5555-4555-8555-555555555555",
    organizationId: "66666666-6666-4666-8666-666666666666",
  };
  const action = { action: "createKbArticle" as const, title: "Returns", body: "Policy", isPublic: false };

  it("uses the Go capability with exact scoped intent and validates its UUID output", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: { articleId: conversationId } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitSupportKbArticle(action, scope)).resolves.toEqual({ kind: "completed", data: { articleId: conversationId } });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Organization-ID")).toBe(scope.organizationId);
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { capabilityId: string; input: unknown; intentId: string };
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({ method: "POST", cache: "no-store" }));
    expect(payload).toMatchObject({ capabilityId: "support.createKbArticle", input: { title: "Returns", body: "Policy", isPublic: false } });
    expect(payload.intentId).toEqual(expect.any(String));
    expect(readPendingSupportKbArticle(scope)).toBeNull();
  });

  it("keeps exact details and intent after uncertain responses, pending approval, malformed success, and rollback", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ error: "unexpected request" }, 500))
      .mockResolvedValueOnce(jsonResponse({ error: "temporarily unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ ok: false, pendingApproval: true, reason: "Needs approval." }, 202))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { articleId: "not-a-uuid" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitSupportKbArticle(action, scope)).rejects.toMatchObject({ status: 503 });
    const pending = readPendingSupportKbArticle(scope);
    expect(pending).toEqual({ title: "Returns", body: "Policy", isPublic: false });
    await expect(submitSupportKbArticle({ ...action, body: "Changed" }, scope)).rejects.toMatchObject({ status: 0, message: expect.stringContaining("exact saved details") });
    await expect(submitSupportKbArticle(action, scope)).resolves.toMatchObject({ kind: "pending" });
    await expect(submitSupportKbArticle(action, scope)).rejects.toMatchObject({ status: 200, message: expect.stringContaining("unexpected article result") });
    const payloads = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { intentId: string });
    expect(payloads).toHaveLength(3);
    expect(new Set(payloads.map((payload) => payload.intentId))).toEqual(new Set([payloads[0]?.intentId]));
    expect(readPendingSupportKbArticle(scope)).toEqual(pending);
  });

});

describe("Go internal ticket write", () => {
  const scope = {
    actorId: "55555555-5555-4555-8555-555555555555",
    organizationId: "66666666-6666-4666-8666-666666666666",
  };
  const input = { title: "Refund flow gap", description: "A customer asked for a refund, but this workspace has no refund action.", origin: "capability_gap" as const };

  it("files through the Go capability with an org scoped intent and validates the UUID receipt", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: { ticketId: conversationId } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitSupportTicket(input, scope)).resolves.toEqual({ kind: "completed", data: { ticketId: conversationId } });
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({ method: "POST", cache: "no-store" }));
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("X-Organization-ID")).toBe(scope.organizationId);
    const payload = JSON.parse(String(init?.body)) as { capabilityId: string; input: unknown; intentId: string };
    expect(payload).toMatchObject({ capabilityId: "support.createTicket", input });
    expect(payload.intentId).toEqual(expect.any(String));
    expect(readPendingSupportTicket(scope)).toBeNull();
  });

  it("retries the exact saved ticket after uncertainty and rejects changed details", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "temporarily unavailable" }, 503));
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitSupportTicket(input, scope)).rejects.toMatchObject({ status: 503 });
    expect(readPendingSupportTicket(scope)).toEqual(input);
    const initial = JSON.parse(window.localStorage.getItem(`chaste.support.ticket-intent.v1:${scope.actorId}:${scope.organizationId}`) ?? "{}") as { intentId?: string };
    await expect(submitSupportTicket({ ...input, title: "Changed request" }, scope)).rejects.toMatchObject({ status: 0, message: expect.stringContaining("exact saved details") });

    const retry = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: { ticketId: conversationId } }));
    vi.stubGlobal("fetch", retry);
    await expect(submitSupportTicket(input, scope)).resolves.toMatchObject({ kind: "completed" });
    const retried = JSON.parse(String(retry.mock.calls[0]?.[1]?.body)) as { intentId: string };
    expect(retried.intentId).toBe(initial.intentId);
  });

  it("retains intent after pending approval and fails closed on malformed success", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: false, pendingApproval: true, reason: "Needs approval." }, 202))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { ticketId: "invalid" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitSupportTicket(input, scope)).resolves.toEqual({ kind: "pending", reason: "Needs approval." });
    await expect(submitSupportTicket(input, scope)).rejects.toMatchObject({ status: 200, message: "The Go support service returned an unexpected ticket result." });
    expect(readPendingSupportTicket(scope)).toEqual(input);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clears a definitive 403 so the user can edit a rejected ticket", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: "forbidden" }, 403))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { ticketId: conversationId } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitSupportTicket(input, scope)).rejects.toMatchObject({ status: 403 });
    expect(readPendingSupportTicket(scope)).toBeNull();

    const corrected = { ...input, title: "Updated request" };
    await expect(submitSupportTicket(corrected, scope)).resolves.toMatchObject({ kind: "completed" });
    const payloads = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { input: unknown; intentId: string });
    expect(payloads[1]?.input).toEqual(corrected);
    expect(payloads[1]?.intentId).not.toBe(payloads[0]?.intentId);
  });

  it("retains 422 intent conflicts for exact recovery", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "action intent conflict" }, 422));
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitSupportTicket(input, scope)).rejects.toMatchObject({ status: 422 });
    expect(readPendingSupportTicket(scope)).toEqual(input);
    const pendingRecord = JSON.parse(window.localStorage.getItem(`chaste.support.ticket-intent.v1:${scope.actorId}:${scope.organizationId}`) ?? "{}") as { intentId?: string };
    await expect(submitSupportTicket({ ...input, title: "Changed details" }, scope)).rejects.toMatchObject({ status: 0, message: expect.stringContaining("exact saved details") });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const retry = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: { ticketId: conversationId } }));
    vi.stubGlobal("fetch", retry);
    await expect(submitSupportTicket(input, scope)).resolves.toMatchObject({ kind: "completed" });
    const retried = JSON.parse(String(retry.mock.calls[0]?.[1]?.body)) as { intentId: string };
    expect(retried.intentId).toBe(pendingRecord.intentId);
  });
});

describe("Go support conversation writes", () => {
  const scope = {
    actorId: "55555555-5555-4555-8555-555555555555",
    organizationId: "66666666-6666-4666-8666-666666666666",
  };
  const storageKey = `chaste.support.conversation-write-intent.v1:pending:${scope.actorId}:${scope.organizationId}`;

  it("submits conversation creation with a durable intent and validates the strict Go output", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: { conversationId } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitSupportConversationAction({ action: "create", customerId, subject: "Invoice question" }, scope))
      .resolves.toEqual({ kind: "completed", data: { conversationId } });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Organization-ID")).toBe(scope.organizationId);
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { capabilityId: string; input: unknown; intentId: string };
    expect(payload).toMatchObject({ capabilityId: "support.startConversation", input: { customerId, subject: "Invoice question" } });
    expect(payload.intentId).toEqual(expect.any(String));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(window.localStorage.getItem(storageKey)).toBeNull();
  });

  it("accepts an opaque Better Auth user ID for conversation retry state", async () => {
    const opaqueScope = { ...scope, actorId: "user-auth0|opaque-id" };
    const opaqueStorageKey = `chaste.support.conversation-write-intent.v1:pending:${encodeURIComponent(opaqueScope.actorId)}:${scope.organizationId}`;
    const fetchMock = vi.fn(async () => jsonResponse({ error: "temporarily unavailable" }, 503));
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "message" as const, conversationId, body: "Please check the invoice.", from: "staff" as const };

    await expect(submitSupportConversationAction(action, opaqueScope)).rejects.toMatchObject({ status: 503 });
    expect(readPendingSupportConversationWrite(opaqueScope)).toEqual({ capabilityId: "support.postMessage", input: { conversationId, body: action.body, from: "staff" } });
    expect(window.localStorage.getItem(opaqueStorageKey)).not.toBeNull();

    await expect(submitSupportConversationAction(action, { ...opaqueScope, organizationId: "not-a-uuid" })).rejects.toThrow(/account and organization/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { actorId: null, label: "missing" },
    { actorId: "u".repeat(256), label: "oversized" },
  ])("fails closed for a $label actor ID", async ({ actorId }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitSupportConversationAction({ action: "resolve", conversationId }, { ...scope, actorId })).rejects.toThrow(/account and organization/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reuses exact message payload and intent after uncertain response or reload", async () => {
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
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: output }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitSupportConversationAction(action, scope)).resolves.toMatchObject({ kind: "completed", data: output });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ capabilityId: expectedCapability, input });
  });

  it("routes ticket metadata through the independent Go ticket selector with exact input and intent", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: { updated: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const action = {
      action: "updateTicket" as const,
      conversationId,
      priority: "urgent" as const,
      category: "billing",
      assigneeUserId: customerId,
      slaDueAt: "2026-10-12T12:00:00.000Z",
    };

    await expect(submitSupportConversationAction(action, scope)).resolves.toEqual({ kind: "completed", data: { updated: true } });
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { capabilityId: string; input: unknown; intentId: string };
    expect(payload).toMatchObject({
      capabilityId: "support.updateTicket",
      input: { conversationId, priority: "urgent", category: "billing", assigneeUserId: customerId, slaDueAt: action.slaDueAt },
    });
    expect(payload.intentId).toEqual(expect.any(String));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(window.localStorage.getItem(storageKey)).toBeNull();
  });

  it("routes explicit ticket metadata clears through Go without dropping null fields", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: { updated: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const action = {
      action: "updateTicket" as const,
      conversationId,
      priority: "normal" as const,
      category: null,
      assigneeUserId: null,
      slaDueAt: null,
    };

    await expect(submitSupportConversationAction(action, scope)).resolves.toEqual({ kind: "completed", data: { updated: true } });
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { input: Record<string, unknown> };
    expect(request.input).toEqual({ conversationId, priority: "normal", category: null, assigneeUserId: null, slaDueAt: null });
  });

  it("keeps the exact Go ticket update and intent after an uncertain response", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ error: "temporarily unavailable" }, 503));
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "updateTicket" as const, conversationId, priority: "high" as const, category: null, assigneeUserId: null, slaDueAt: null };

    await expect(submitSupportConversationAction(action, scope)).rejects.toMatchObject({ status: 503 });
    const pending = readPendingSupportConversationWrite(scope);
    expect(pending).toEqual({ capabilityId: "support.updateTicket", input: { conversationId, priority: "high", category: null, assigneeUserId: null, slaDueAt: null } });
    const firstIntent = JSON.parse(window.localStorage.getItem(storageKey) ?? "{}").intentId;
    expect(supportWriteActionFromPending(pending!)).toEqual(action);

    const retryFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: { updated: true } }));
    vi.stubGlobal("fetch", retryFetch);
    await expect(submitSupportConversationAction(action, scope)).resolves.toMatchObject({ kind: "completed" });
    expect(retryFetch).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(retryFetch.mock.calls[0]?.[1]?.body))).toMatchObject({ intentId: firstIntent });
    expect(window.localStorage.getItem(storageKey)).toBeNull();
  });

  it("keeps 202, 404, and malformed success outcomes unresolved without legacy fallback", async () => {
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

  it("keeps retrying through Go while an action remains unresolved", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "unavailable" }, 503)));
    const action = { action: "reopen" as const, conversationId };
    await expect(submitSupportConversationAction(action, scope)).rejects.toMatchObject({ status: 503 });

    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: { status: "open" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitSupportConversationAction(action, scope)).resolves.toMatchObject({ kind: "completed" });
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({ method: "POST" }));
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
    expect(bodies).toEqual([{ conversationId }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/support/draft", expect.objectContaining({
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      signal: expect.any(AbortSignal),
    }));
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
