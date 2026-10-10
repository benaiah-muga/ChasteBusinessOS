import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MessagingApiError,
  advanceReadCursor,
  changeConversation,
  checkAttachmentLimits,
  createConversation,
  deleteMessage,
  deletePendingAttachment,
  editMessage,
  fetchConversationPeople,
  fetchConversationPresence,
  fetchConversationThread,
  fetchConversations,
  fetchMessagingEnabled,
  fetchOlderMessages,
  getPendingMessageDelete,
  getPendingMessageEdit,
  reportConversationPresence,
  searchMessages,
  sendConversationMessage,
  setMessagePin,
  setMessageReaction,
  uploadConversationAttachment,
} from "./messaging";

const conversationId = "6f1c1f4a-2f6f-4a2a-9d0a-0b9a5f1c1f4a";
const messageId = "2b0f9a11-1c3d-4e5f-8a7b-9c0d1e2f3a4b";

const conversation = {
  id: conversationId,
  kind: "channel",
  title: "general",
  agentEnabled: true,
  archivedAt: null,
  createdByMe: true,
  unreadCount: 2,
  lastMessage: { at: "2026-10-01T09:00:00.000Z", body: "Morning all" },
};

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: messageId,
    senderType: "human",
    senderUserId: "user-1",
    body: "Morning all",
    createdAt: "2026-10-01T09:00:00.000Z",
    editedAt: null,
    parentMessageId: null,
    pinnedAt: null,
    attachments: [],
    reactions: [],
    ...overrides,
  };
}

function thread(overrides: Record<string, unknown> = {}) {
  return {
    conversation: {
      id: conversationId,
      orgId: "8e5cb82c-5b5c-47f5-9e8a-089f6f482126",
      kind: "channel",
      title: "general",
      agentEnabled: true,
      createdByUserId: "user-1",
      createdAt: "2026-10-01T08:00:00.000Z",
      archivedAt: null,
      deletedAt: null,
    },
    messages: [message()],
    me: "user-1",
    readers: [{ userId: "user-1", name: "Ada", lastReadAt: null }],
    pinnedMessages: [],
    hasMore: false,
    nextCursor: null,
    ...overrides,
  };
}

function lastBody(fetchMock: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function lastUrl(fetchMock: ReturnType<typeof vi.fn>, index = 0): string {
  return String(fetchMock.mock.calls[index]?.[0]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("messaging API client", () => {
  it("reads the module switchboard and reports messaging as enabled", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ catalog: [{ id: "messaging" }, { id: "crm" }], enabledModules: ["crm", "messaging"] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchMessagingEnabled()).resolves.toBe(true);
    expect(lastUrl(fetchMock)).toBe("/api/modules");

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ catalog: [{ id: "crm" }], enabledModules: ["crm"] })));
    await expect(fetchMessagingEnabled()).resolves.toBe(false);
  });

  it("rejects a switchboard that enables a module missing from the catalog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ catalog: [{ id: "crm" }, { id: "messaging" }], enabledModules: ["crm", "messaging", "ghost"] })));
    await expect(fetchMessagingEnabled()).rejects.toBeInstanceOf(MessagingApiError);
  });

  it("validates the conversation list and carries the same-origin session", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ conversations: [conversation], me: "user-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchConversations()).resolves.toEqual({ conversations: [conversation], me: "user-1" });
    expect(fetchMock).toHaveBeenCalledWith("/api/conversations", expect.objectContaining({
      cache: "no-store",
      credentials: "same-origin",
      signal: expect.any(AbortSignal),
    }));

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ conversations: [{ id: conversationId }], me: "user-1" })));
    await expect(fetchConversations()).rejects.toBeInstanceOf(MessagingApiError);
  });

  it("routes the conversation list through Go and validates the complete list contract", async () => {
    vi.stubGlobal("__GO_MESSAGING_CONVERSATION_LIST__", true);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { conversations: [conversation], me: "user-1" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchConversations()).resolves.toEqual({ conversations: [conversation], me: "user-1" });
    expect(lastUrl(fetchMock)).toBe("/api/capabilities/execute");
    expect(lastBody(fetchMock)).toMatchObject({
      capabilityId: "messaging.listConversations",
      input: { limit: 100 },
      intentId: expect.any(String),
    });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { conversations: [{ ...conversation, unreadCount: "2" }], me: "user-1" } })));
    await expect(fetchConversations()).rejects.toBeInstanceOf(MessagingApiError);
  });

  it("fails closed when selected Go conversation-list routing fails", async () => {
    vi.stubGlobal("__GO_MESSAGING_CONVERSATION_LIST__", true);
    const fetchMock = vi.fn(async () => Response.json({ error: "capability unavailable" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchConversations()).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastUrl(fetchMock)).toBe("/api/capabilities/execute");
  });

  it("rejects a message list that is not a strict match for the legacy shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(thread({ messages: [message({ extra: true })] }))));
    await expect(fetchConversationThread(conversationId)).rejects.toBeInstanceOf(MessagingApiError);
  });

  it("routes initial and refresh thread reads through Go and validates the complete thread result", async () => {
    vi.stubGlobal("__GO_MESSAGING_THREAD_READ__", true);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: thread() }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchConversationThread(conversationId)).resolves.toEqual(thread());
    expect(lastUrl(fetchMock)).toBe("/api/capabilities/execute");
    expect(lastBody(fetchMock)).toMatchObject({
      capabilityId: "messaging.readMessages",
      input: { conversationId, limit: 60 },
      intentId: expect.any(String),
    });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: thread({
      conversation: { id: conversationId },
    }) })));
    await expect(fetchConversationThread(conversationId)).rejects.toBeInstanceOf(MessagingApiError);

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: thread({ messages: [message({ extra: true })] }) })));
    await expect(fetchConversationThread(conversationId)).rejects.toMatchObject({
      status: 200,
      message: "The messaging service returned this conversation in an unexpected format.",
    });
  });

  it("fails closed when the selected Go thread read fails", async () => {
    vi.stubGlobal("__GO_MESSAGING_THREAD_READ__", true);
    const fetchMock = vi.fn(async () => Response.json({ error: "capability unavailable" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchConversationThread(conversationId)).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastUrl(fetchMock)).toBe("/api/capabilities/execute");
  });

  it("routes around windows and older pages through Go", async () => {
    vi.stubGlobal("__GO_MESSAGING_THREAD_READ__", true);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input) === "/api/capabilities/execute"
        ? Response.json({ ok: true, data: thread() })
        : Response.json(thread()));
    vi.stubGlobal("fetch", fetchMock);

    await fetchConversationThread(conversationId, { aroundId: messageId });
    expect(lastUrl(fetchMock)).toBe("/api/capabilities/execute");
    expect(lastBody(fetchMock)).toMatchObject({
      capabilityId: "messaging.readMessages",
      input: { conversationId, limit: 60, around: messageId },
      intentId: expect.any(String),
    });
    await fetchOlderMessages(conversationId, messageId);
    expect(lastUrl(fetchMock, 1)).toBe("/api/capabilities/execute");
    expect(lastBody(fetchMock, 1)).toMatchObject({
      capabilityId: "messaging.readMessages",
      input: { conversationId, limit: 60, before: messageId },
      intentId: expect.any(String),
    });
  });

  it("fails closed when a selected Go around read fails", async () => {
    vi.stubGlobal("__GO_MESSAGING_THREAD_READ__", true);
    const fetchMock = vi.fn(async () => Response.json({ error: "capability unavailable" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchConversationThread(conversationId, { aroundId: messageId })).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastUrl(fetchMock)).toBe("/api/capabilities/execute");
  });

  it("fails closed and validates the strict Go result for older pages", async () => {
    vi.stubGlobal("__GO_MESSAGING_THREAD_READ__", true);
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: thread({ messages: [message({ extra: true })] }) }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchOlderMessages(conversationId, messageId)).rejects.toMatchObject({
      status: 200,
      message: "The messaging service returned this conversation in an unexpected format.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "capability unavailable" }, { status: 404 })));
    await expect(fetchOlderMessages(conversationId, messageId)).rejects.toMatchObject({ status: 404 });
  });

  it("encodes thread cursors for the around and before windows", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(thread()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchConversationThread(conversationId, { aroundId: messageId })).resolves.toMatchObject({ me: "user-1" });
    expect(lastUrl(fetchMock)).toBe(`/api/conversations/${conversationId}/messages?around=${messageId}`);

    await expect(fetchOlderMessages(conversationId, messageId)).resolves.toMatchObject({ me: "user-1" });
    expect(lastUrl(fetchMock, 1)).toBe(`/api/conversations/${conversationId}/messages?before=${messageId}`);
  });

  it("turns a permission failure into a readable message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: 403 })));
    await expect(fetchConversationThread(conversationId)).rejects.toMatchObject({
      status: 403,
      message: "You do not have permission to use Messages.",
    });
  });

  it("reports a pending send as pending, not as success or failure", async () => {
    vi.stubGlobal("__GO_MESSAGING_SEND_SLICE__", false);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ pendingApproval: true }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await sendConversationMessage(conversationId, { body: "Ship it", mentions: [], attachmentIds: [] });
    expect(outcome).toEqual({ kind: "pending", reason: "Your message is waiting for approval. It is still saved in this composer." });
    const body = lastBody(fetchMock);
    expect(body).toMatchObject({ body: "Ship it", intentId: expect.any(String) });
    expect(body.parentMessageId).toBeUndefined();
    expect(lastUrl(fetchMock)).toBe(`/api/conversations/${conversationId}/messages`);
  });

  it("sends a Go message through the governed capability endpoint and validates its output", async () => {
    vi.stubGlobal("__GO_MESSAGING_SEND_SLICE__", true);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { messageId } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendConversationMessage(conversationId, {
      body: "@Ada, see the update",
      mentions: [{ type: "user", id: "user-1" }],
      parentMessageId: messageId,
      attachmentIds: ["72b99920-8c21-463a-9c5b-479216017501"],
    }, undefined, { allowGo: true })).resolves.toEqual({ kind: "completed", data: { ok: true, agentReply: null } });
    expect(lastUrl(fetchMock)).toBe("/api/capabilities/execute");
    expect(lastBody(fetchMock)).toMatchObject({
      capabilityId: "messaging.sendMessage",
      input: {
        conversationId,
        body: "@Ada, see the update",
        mentions: [{ type: "user", id: "user-1" }],
        parentMessageId: messageId,
        attachmentIds: ["72b99920-8c21-463a-9c5b-479216017501"],
      },
      intentId: expect.any(String),
    });
  });

  it("preserves the Go approval-pending response and rejects malformed success envelopes", async () => {
    vi.stubGlobal("__GO_MESSAGING_SEND_SLICE__", true);
    const approvalId = "550e8400-e29b-41d4-a716-446655440000";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, pendingApproval: true, approvalId, reason: "Manager review required." }, { status: 202 })));
    await expect(sendConversationMessage(conversationId, { body: "Ship it", mentions: [], attachmentIds: [] }, undefined, { allowGo: true, intentId: messageId }))
      .resolves.toEqual({ kind: "pending", reason: "Manager review required." });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { unexpected: true } })));
    await expect(sendConversationMessage(conversationId, { body: "Ship it", mentions: [], attachmentIds: [] }, undefined, { allowGo: true }))
      .rejects.toMatchObject({ name: "MessagingApiError" });
  });

  it("reuses a caller-persisted intent on Go retries and sends approval ids through validation", async () => {
    vi.stubGlobal("__GO_MESSAGING_SEND_SLICE__", true);
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: false, pendingApproval: true, approvalId: "550e8400-e29b-41d4-a716-446655440000", reason: "Review required" }, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const intentId = "72b99920-8c21-463a-9c5b-479216017501";
    const input = { body: "Ship it", mentions: [], attachmentIds: [] };
    await sendConversationMessage(conversationId, input, undefined, { allowGo: true, intentId });
    await sendConversationMessage(conversationId, input, undefined, { allowGo: true, intentId });
    expect(bodies.map((body) => body.intentId)).toEqual([intentId, intentId]);
  });

  it("routes message edits through Go with actor and organization scoped pending recovery", async () => {
    vi.stubGlobal("__GO_MESSAGING_EDIT_SLICE__", true);
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: false, pendingApproval: true, reason: "A manager must review this edit." }, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const scope = { actorId: "user-1", organizationId: "org-1" };
    const options = { allowGo: true, ...scope, conversationId };

    await expect(editMessage(messageId, "Corrected wording", undefined, options)).resolves.toEqual({
      kind: "pending", reason: "A manager must review this edit.",
    });
    const recovered = await getPendingMessageEdit(scope);
    expect(recovered).toMatchObject({ messageId, conversationId, body: "Corrected wording", intentId: expect.any(String) });
    await expect(editMessage(messageId, "Corrected wording", undefined, options)).resolves.toMatchObject({ kind: "pending" });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      capabilityId: "messaging.editMessage",
      input: { messageId, body: "Corrected wording" },
      intentId: recovered?.intentId,
    });
    expect(bodies[1]?.intentId).toBe(bodies[0]?.intentId);
    await expect(editMessage(messageId, "Different edit", undefined, options)).rejects.toMatchObject({
      message: expect.stringContaining("Retry the saved edit"),
    });
    await expect(getPendingMessageEdit({ actorId: "user-1", organizationId: "org-2" })).resolves.toBeNull();
  });

  it("keeps unresolved Go edits blocked if the selector is rolled back", async () => {
    vi.stubGlobal("__GO_MESSAGING_EDIT_SLICE__", true);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ pendingApproval: true }, { status: 202 })));
    const scope = { actorId: "rollback-user", organizationId: "rollback-org" };
    const options = { allowGo: true, ...scope, conversationId };
    await editMessage(messageId, "Saved exact edit", undefined, options);

    vi.stubGlobal("__GO_MESSAGING_EDIT_SLICE__", false);
    const legacyFetch = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", legacyFetch);
    await expect(editMessage(messageId, "Different edit", undefined, { ...scope, conversationId })).rejects.toMatchObject({
      message: expect.stringContaining("Go message edit is unresolved"),
    });
    expect(legacyFetch).not.toHaveBeenCalled();
    await expect(getPendingMessageEdit(scope)).resolves.toMatchObject({ messageId, body: "Saved exact edit" });
  });

  it("keeps the Go edit intent after an uncertain transport failure and clears it on success", async () => {
    vi.stubGlobal("__GO_MESSAGING_EDIT_SLICE__", true);
    const scope = { actorId: "user-2", organizationId: "org-2" };
    const options = { allowGo: true, ...scope, conversationId };
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    await expect(editMessage(messageId, "Retry me", undefined, options)).rejects.toBeInstanceOf(MessagingApiError);
    const recovered = await getPendingMessageEdit(scope);
    expect(recovered).toMatchObject({ messageId, body: "Retry me" });

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      ok: true,
      data: { messageId, body: "Morning all", expectedBody: "Retry me", expectedEditedAt: "2026-10-01T09:00:00.000Z", editedAt: "2026-10-01T09:00:00.000Z" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(editMessage(messageId, "Retry me", undefined, options)).resolves.toEqual({ kind: "completed", data: { ok: true } });
    expect(lastBody(fetchMock)).toMatchObject({ intentId: recovered?.intentId });
    await expect(getPendingMessageEdit(scope)).resolves.toBeNull();
  });

  it.each([
    ["malformed envelope", { ok: true, data: { messageId } }],
    ["wrong message ID", { ok: true, data: { messageId: "another-message", body: "Morning all", expectedBody: "Retry this exact edit", expectedEditedAt: "2026-10-01T09:00:00.000Z", editedAt: "2026-10-01T09:00:00.000Z" } }],
    ["wrong expected body", { ok: true, data: { messageId, body: "Morning all", expectedBody: "A different edit", expectedEditedAt: "2026-10-01T09:00:00.000Z", editedAt: "2026-10-01T09:00:00.000Z" } }],
  ])("keeps the exact Go edit marker after a successful response with %s", async (_case, invalidBody) => {
    vi.stubGlobal("__GO_MESSAGING_EDIT_SLICE__", true);
    const scope = { actorId: "user-invalid-success", organizationId: "org-invalid-success" };
    const options = { allowGo: true, ...scope, conversationId };
    let responseBody: unknown = invalidBody;
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json(responseBody);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(editMessage(messageId, "Retry this exact edit", undefined, options)).rejects.toMatchObject({
      message: expect.stringContaining("unexpected response to edit this message"),
    });
    const pending = await getPendingMessageEdit(scope);
    expect(pending).toMatchObject({ messageId, conversationId, body: "Retry this exact edit", intentId: expect.any(String) });

    responseBody = { ok: true, data: { messageId, body: "Morning all", expectedBody: "Retry this exact edit", expectedEditedAt: "2026-10-01T09:00:00.000Z", editedAt: "2026-10-01T09:00:00.000Z" } };
    await expect(editMessage(messageId, "Retry this exact edit", undefined, options)).resolves.toEqual({
      kind: "completed", data: { ok: true },
    });
    expect(bodies[1]?.intentId).toBe(pending?.intentId);
    await expect(getPendingMessageEdit(scope)).resolves.toBeNull();
  });

  it("fails closed on a Go edit 404 and keeps the exact attempt for a Go-only retry", async () => {
    vi.stubGlobal("__GO_MESSAGING_EDIT_SLICE__", true);
    const scope = { actorId: "user-3", organizationId: "org-3" };
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({ ok: true, data: { messageId, body: "Morning all", expectedBody: "Retry exact edit", expectedEditedAt: "2026-10-01T09:00:00.000Z", editedAt: "2026-10-01T09:00:00.000Z" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const options = { allowGo: true, ...scope, conversationId };
    await expect(editMessage(messageId, "Retry exact edit", undefined, options)).rejects.toMatchObject({ status: 404 });
    const pending = await getPendingMessageEdit(scope);
    expect(pending).toMatchObject({ messageId, body: "Retry exact edit", intentId: expect.any(String) });
    await expect(editMessage(messageId, "Retry exact edit", undefined, options)).resolves.toEqual({ kind: "completed", data: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => url === "/api/capabilities/execute")).toBe(true);
    expect(bodies[1]?.intentId).toBe(bodies[0]?.intentId);
    await expect(getPendingMessageEdit(scope)).resolves.toBeNull();
  });

  it("refuses selector-off edits until actor and organization scope can check Go recovery", async () => {
    vi.stubGlobal("__GO_MESSAGING_EDIT_SLICE__", false);
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(editMessage(messageId, "No scope"))
      .rejects.toMatchObject({ message: expect.stringContaining("actor and active organization") });
    await expect(editMessage(messageId, "Missing organization", undefined, { actorId: "actor-only" }))
      .rejects.toMatchObject({ message: expect.stringContaining("actor and active organization") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a Go message deletion with the exact actor/org scoped intent", async () => {
    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", true);
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ pendingApproval: true, reason: "Manager review required." }, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const scope = { actorId: "user-delete", organizationId: "org-delete" };
    const options = { allowGo: true, ...scope, conversationId };

    await expect(deleteMessage(messageId, undefined, options)).resolves.toEqual({ kind: "pending", reason: "Manager review required." });
    const recovered = await getPendingMessageDelete(scope);
    expect(recovered).toMatchObject({ messageId, conversationId, intentId: expect.any(String) });
    await expect(deleteMessage(messageId, undefined, options)).resolves.toMatchObject({ kind: "pending" });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      capabilityId: "messaging.deleteMessage",
      input: { messageId },
      intentId: recovered?.intentId,
    });
    expect(bodies[1]?.intentId).toBe(bodies[0]?.intentId);
    await expect(deleteMessage("another-message", undefined, options)).rejects.toMatchObject({
      message: expect.stringContaining("Retry the saved deletion"),
    });
    await expect(getPendingMessageDelete({ actorId: "user-delete", organizationId: "org-other" })).resolves.toBeNull();
  });

  it("blocks legacy deletion after selector rollback while the scoped Go delete is unresolved", async () => {
    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", true);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ pendingApproval: true }, { status: 202 })));
    const scope = { actorId: "user-delete-rollback", organizationId: "org-delete-rollback" };
    await deleteMessage(messageId, undefined, { allowGo: true, ...scope, conversationId });

    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", false);
    const legacyFetch = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", legacyFetch);
    await expect(deleteMessage(messageId, undefined, { ...scope, conversationId })).rejects.toMatchObject({
      message: expect.stringContaining("Go message deletion is unresolved"),
    });
    expect(legacyFetch).not.toHaveBeenCalled();
    await expect(getPendingMessageDelete(scope)).resolves.toMatchObject({ messageId, conversationId });
  });

  it("blocks selector-off deletion when actor or organization scope is missing", async () => {
    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", false);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(deleteMessage(messageId)).rejects.toMatchObject({
      message: expect.stringContaining("signed-in actor and active organization"),
    });
    await expect(deleteMessage(messageId, undefined, { actorId: "user-delete-missing-org" })).rejects.toMatchObject({
      message: expect.stringContaining("signed-in actor and active organization"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed on selector-off deletion with an unresolved marker and incomplete scope", async () => {
    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", true);
    const scope = { actorId: "user-delete-unscoped", organizationId: "org-delete-unscoped" };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ pendingApproval: true }, { status: 202 })));
    await deleteMessage(messageId, undefined, { allowGo: true, ...scope, conversationId });
    expect(await getPendingMessageDelete(scope)).toMatchObject({ messageId, conversationId });

    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", false);
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(deleteMessage(messageId)).rejects.toMatchObject({
      message: expect.stringContaining("signed-in actor and active organization"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(getPendingMessageDelete(scope)).resolves.toMatchObject({ messageId, conversationId });
  });

  it("keeps fresh selector-off deletions on the legacy route", async () => {
    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", false);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(deleteMessage(messageId, undefined, {
      actorId: "user-delete-legacy", organizationId: "org-delete-legacy", conversationId,
    })).resolves.toEqual({ kind: "completed", data: { ok: true } });
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(new RegExp(`^/api/messages/${messageId}\\?intentId=`));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a Go deletion after an uncertain result and validates the tombstone output", async () => {
    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", true);
    const scope = { actorId: "user-delete-retry", organizationId: "org-delete-retry" };
    const options = { allowGo: true, ...scope, conversationId };
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    await expect(deleteMessage(messageId, undefined, options)).rejects.toBeInstanceOf(MessagingApiError);
    const recovered = await getPendingMessageDelete(scope);
    expect(recovered).toMatchObject({ messageId, conversationId });

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      ok: true,
      data: { deleted: true, messageId, deletedAt: null, expectedDeletedAt: "2026-10-01T09:00:00.000Z" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(deleteMessage(messageId, undefined, options)).resolves.toEqual({ kind: "completed", data: { ok: true } });
    expect(lastBody(fetchMock)).toMatchObject({ intentId: recovered?.intentId });
    await expect(getPendingMessageDelete(scope)).resolves.toBeNull();

  });

  it.each([
    ["false deleted flag", { deleted: false, messageId, deletedAt: null, expectedDeletedAt: "2026-10-01T09:00:00.000Z" }],
    ["wrong message ID", { deleted: true, messageId: "another-message", deletedAt: null, expectedDeletedAt: "2026-10-01T09:00:00.000Z" }],
    ["malformed previous deletion timestamp", { deleted: true, messageId, deletedAt: "yesterday", expectedDeletedAt: "2026-10-01T09:00:00.000Z" }],
    ["malformed receipt timestamp", { deleted: true, messageId, deletedAt: null, expectedDeletedAt: "yesterday" }],
    ["unexpected receipt field", { deleted: true, messageId, deletedAt: null, expectedDeletedAt: "2026-10-01T09:00:00.000Z", actorId: "spoofed" }],
  ])("retains the Go delete marker after a successful response with %s", async (_case, data) => {
    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", true);
    const scope = { actorId: `user-delete-invalid-${String(_case).replaceAll(" ", "-")}`, organizationId: "org-delete-invalid" };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data })));
    await expect(deleteMessage(messageId, undefined, { allowGo: true, ...scope, conversationId }))
      .rejects.toMatchObject({ message: expect.stringContaining("unexpected response") });
    await expect(getPendingMessageDelete(scope)).resolves.toMatchObject({ messageId, conversationId, intentId: expect.any(String) });
  });

  it("fails closed on a Go delete 404 and retries the same scoped intent through Go", async () => {
    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", true);
    const scope = { actorId: "user-delete-404", organizationId: "org-delete-404" };
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({ ok: true, data: { deleted: true, messageId, deletedAt: null, expectedDeletedAt: "2026-10-01T09:00:00.000Z" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const options = { allowGo: true, ...scope, conversationId };
    await expect(deleteMessage(messageId, undefined, options)).rejects.toMatchObject({ status: 404 });
    const pending = await getPendingMessageDelete(scope);
    expect(pending).toMatchObject({ messageId, conversationId, intentId: expect.any(String) });
    await expect(deleteMessage(messageId, undefined, options)).resolves.toEqual({ kind: "completed", data: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => url === "/api/capabilities/execute")).toBe(true);
    expect(bodies[1]?.intentId).toBe(bodies[0]?.intentId);
    await expect(getPendingMessageDelete(scope)).resolves.toBeNull();
  });

  it("preserves Go capability errors for the composer", async () => {
    vi.stubGlobal("__GO_MESSAGING_SEND_SLICE__", true);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, error: "reply target not found in this conversation" }, { status: 422 })));
    await expect(sendConversationMessage(conversationId, { body: "Ship it", mentions: [], attachmentIds: [] }, undefined, { allowGo: true }))
      .rejects.toMatchObject({ status: 422, message: "reply target not found in this conversation" });
  });

  it("prefers the server hint over the local fallback for a pending send", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ pendingApproval: true, hint: "A manager has to approve this." }, { status: 202 })));
    await expect(sendConversationMessage(conversationId, { body: "Ship it", mentions: [], attachmentIds: [] }))
      .resolves.toEqual({ kind: "pending", reason: "A manager has to approve this." });
  });

  it("returns the completed send result and the agent reply", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, agentReply: "On it" })));
    await expect(sendConversationMessage(conversationId, { body: "Ship it", mentions: [{ type: "agent", id: "agent-1" }], parentMessageId: messageId, attachmentIds: [] }))
      .resolves.toEqual({ kind: "completed", data: { ok: true, agentReply: "On it" } });
  });

  it("carries an intent id on every governed write", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/capabilities/execute") {
        const body = JSON.parse(String(init?.body)) as { capabilityId?: string };
        if (body.capabilityId === "messaging.advanceReadCursor") {
          return Response.json({ ok: true, data: { conversationId, previousReadAt: null } });
        }
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_MESSAGING_READ_CURSOR__", true);

    await advanceReadCursor(conversationId, "2026-10-01T09:00:00.000Z");
    const readCall = fetchMock.mock.calls[0]!;
    const readBody = JSON.parse(String((readCall[1] as RequestInit).body)) as Record<string, unknown>;
    expect(String(readCall[0])).toBe("/api/capabilities/execute");
    expect(readBody).toMatchObject({
      capabilityId: "messaging.advanceReadCursor",
      input: { conversationId, readAt: "2026-10-01T09:00:00.000Z" },
      intentId: expect.any(String),
    });
    await reportConversationPresence(conversationId, true);
    await setMessageReaction(messageId, "👍", true);
    await setMessagePin(messageId, true);
    await deletePendingAttachment(conversationId, messageId);
    await editMessage(messageId, "Corrected", undefined, { actorId: "legacy-actor", organizationId: "legacy-org" });

    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
      expect(body.intentId).toEqual(expect.any(String));
    }
  });

  it("deletes pending attachments through the selected Go capability with strict IDs and output", async () => {
    vi.stubGlobal("__GO_MESSAGING_ATTACHMENT_DELETE__", true);
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { removed: true } }));
    vi.stubGlobal("fetch", fetchMock);

    await deletePendingAttachment(conversationId, messageId);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastUrl(fetchMock)).toBe("/api/capabilities/execute");
    expect(lastBody(fetchMock)).toMatchObject({
      capabilityId: "messaging.deletePendingAttachment",
      input: { attachmentId: messageId },
      intentId: expect.any(String),
    });
    expect(Object.keys((lastBody(fetchMock).input as Record<string, unknown>))).toEqual(["attachmentId"]);
  });

  it("fails closed on invalid IDs, a Go error, or a malformed Go delete response", async () => {
    vi.stubGlobal("__GO_MESSAGING_ATTACHMENT_DELETE__", true);
    const fetchMock = vi.fn(async () => Response.json({ error: "Go route unavailable" }, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deletePendingAttachment("bad-conversation", messageId)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(deletePendingAttachment(conversationId, messageId)).rejects.toMatchObject({ status: 503 });
    expect(lastUrl(fetchMock)).toBe("/api/capabilities/execute");

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { removed: true, extra: "unexpected" } })));
    await expect(deletePendingAttachment(conversationId, messageId)).rejects.toThrow("unexpected response");
  });

  it("keeps the legacy pending attachment DELETE transport when the Go selector is rolled back", async () => {
    vi.stubGlobal("__GO_MESSAGING_ATTACHMENT_DELETE__", false);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await deletePendingAttachment(conversationId, messageId);

    expect(lastUrl(fetchMock)).toBe(`/api/conversations/${conversationId}/attachments`);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe("DELETE");
    expect(lastBody(fetchMock)).toMatchObject({ attachmentId: messageId, intentId: expect.any(String) });
  });

  it("fails closed when the Go read-cursor capability returns an error or malformed output", async () => {
    vi.stubGlobal("__GO_MESSAGING_READ_CURSOR__", true);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true }, { status: 200 })));
    await expect(advanceReadCursor(conversationId, "2026-10-01T09:00:00.000Z")).rejects.toBeInstanceOf(MessagingApiError);

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "cursor denied" }, { status: 403 })));
    await expect(advanceReadCursor(conversationId, "2026-10-01T09:00:00.000Z")).rejects.toMatchObject({ status: 403 });
  });

  it("preserves the legacy read route when the Go selector is off", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_MESSAGING_READ_CURSOR__", false);

    await advanceReadCursor(conversationId, "2026-10-01T09:00:00.000Z");
    expect(lastUrl(fetchMock)).toBe(`/api/conversations/${conversationId}/read`);
    expect(lastBody(fetchMock)).toMatchObject({ readAt: "2026-10-01T09:00:00.000Z", intentId: expect.any(String) });
  });

  it("updates conversation presence through Go with the strict previous-state output", async () => {
    vi.stubGlobal("__GO_MESSAGING_PRESENCE__", true);
    const fetchMock = vi.fn(async () => Response.json({
      ok: true,
      data: { previousLastSeenAt: null, previousTypingUntil: "2026-10-01T09:00:00.000Z" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await reportConversationPresence(conversationId, false);

    expect(lastUrl(fetchMock)).toBe("/api/capabilities/execute");
    expect(lastBody(fetchMock)).toMatchObject({
      capabilityId: "messaging.updateConversationPresence",
      input: { conversationId, typing: false },
      intentId: expect.any(String),
    });
  });

  it("fails closed on invalid input, selected Go errors, and malformed presence output", async () => {
    vi.stubGlobal("__GO_MESSAGING_PRESENCE__", true);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ error: "presence denied" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(reportConversationPresence("not-a-uuid", false)).rejects.toThrow();
    await expect(reportConversationPresence(conversationId, "true" as unknown as boolean)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(reportConversationPresence(conversationId, true)).rejects.toMatchObject({ status: 403 });
    expect(lastUrl(fetchMock)).toBe("/api/capabilities/execute");

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { previousLastSeenAt: null } })));
    await expect(reportConversationPresence(conversationId, false)).rejects.toThrow("unexpected format");
  });

  it("keeps conversation presence writes on the legacy route when Go is rolled back", async () => {
    vi.stubGlobal("__GO_MESSAGING_PRESENCE__", false);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await reportConversationPresence(conversationId, true);

    expect(lastUrl(fetchMock)).toBe(`/api/conversations/${conversationId}/presence`);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe("POST");
    expect(lastBody(fetchMock)).toMatchObject({ typing: true, intentId: expect.any(String) });
  });

  it("sets reactions and pins through their selected Go capabilities and validates their outputs", async () => {
    const requests: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      if (body.capabilityId === "messaging.setMessageReaction") return Response.json({ ok: true, data: { previousActive: false, active: true } });
      return Response.json({ ok: true, data: { previousPinned: false, pinned: true } });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_MESSAGING_REACTIONS__", true);
    vi.stubGlobal("__GO_MESSAGING_PINS__", true);

    await setMessageReaction(messageId, "👍", true);
    await setMessagePin(messageId, true);

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      capabilityId: "messaging.setMessageReaction",
      input: { messageId, emoji: "👍", active: true },
      intentId: expect.any(String),
    });
    expect(requests[1]).toMatchObject({
      capabilityId: "messaging.setMessagePin",
      input: { messageId, pinned: true },
      intentId: expect.any(String),
    });
    expect(fetchMock.mock.calls.every(([path]) => String(path) === "/api/capabilities/execute")).toBe(true);
  });

  it("fails closed for Go reaction or pin errors, malformed output, and mismatched state", async () => {
    vi.stubGlobal("__GO_MESSAGING_REACTIONS__", true);
    vi.stubGlobal("__GO_MESSAGING_PINS__", true);
    const failedFetch = vi.fn(async () => Response.json({ error: "write denied" }, { status: 403 }));
    vi.stubGlobal("fetch", failedFetch);
    await expect(setMessageReaction(messageId, "👍", true)).rejects.toMatchObject({ status: 403 });
    await expect(setMessagePin(messageId, true)).rejects.toMatchObject({ status: 403 });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { previousActive: false, active: true, extra: true } })));
    await expect(setMessageReaction(messageId, "👍", true)).rejects.toThrow("unexpected format");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { previousPinned: false, pinned: false } })));
    await expect(setMessagePin(messageId, true)).rejects.toThrow("unexpected format");

    const invalidIdFetch = vi.fn(async () => Response.json({ ok: true, data: { previousActive: false, active: true } }));
    vi.stubGlobal("fetch", invalidIdFetch);
    await expect(setMessageReaction("not-a-uuid", "👍", true)).rejects.toThrow();
    await expect(setMessagePin("not-a-uuid", true)).rejects.toThrow();
    expect(invalidIdFetch).not.toHaveBeenCalled();
  });

  it("keeps reaction and pin writes on legacy routes when their Go selectors are rolled back", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_MESSAGING_REACTIONS__", false);
    vi.stubGlobal("__GO_MESSAGING_PINS__", false);

    await setMessageReaction(messageId, "👍", true);
    await setMessagePin(messageId, true);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`/api/messages/${messageId}/reactions`);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe("POST");
    expect(lastBody(fetchMock, 0)).toMatchObject({ emoji: "👍", active: true, intentId: expect.any(String) });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(`/api/messages/${messageId}/pin`);
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).method).toBe("PATCH");
    expect(lastBody(fetchMock, 1)).toMatchObject({ pinned: true, intentId: expect.any(String) });
  });

  it("uses a fresh intent id per write so retries never collide", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await setMessagePin(messageId, true);
    await setMessagePin(messageId, true);
    expect(lastBody(fetchMock, 0).intentId).not.toBe(lastBody(fetchMock, 1).intentId);
  });

  it("passes the message tombstone intent id in the query string", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await deleteMessage(messageId, undefined, { actorId: "user-delete-query", organizationId: "org-delete-query" });
    expect(lastUrl(fetchMock)).toMatch(new RegExp(`^/api/messages/${messageId}\\?intentId=.+$`));
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe("DELETE");
  });

  it("sends a distinct intent id alongside the conversation action", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    await changeConversation(conversationId, { action: "archive", archived: true });
    expect(lastBody(fetchMock)).toMatchObject({ action: "archive", archived: true, intentId: expect.any(String) });
  });

  it("treats a pending conversation change as pending", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ pendingApproval: true, hint: "This change waits for approval in the Approvals inbox." }, { status: 202 })));
    await expect(changeConversation(conversationId, { action: "leave" }))
      .resolves.toEqual({ kind: "pending", reason: "This change waits for approval in the Approvals inbox." });
  });

  it("creates a conversation from the 201 body and reports a pending create", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ conversationId }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createConversation({ title: "ops", agentEnabled: true }))
      .resolves.toEqual({ kind: "completed", data: { conversationId } });
    expect(lastBody(fetchMock)).toMatchObject({ title: "ops", agentEnabled: true, intentId: expect.any(String) });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ pendingApproval: true }, { status: 202 })));
    await expect(createConversation({ title: "ops", agentEnabled: true }))
      .resolves.toEqual({ kind: "pending", reason: "Creating this conversation is waiting for approval." });
  });

  it("uploads an attachment as multipart form data and validates the receipt", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ attachmentId: "attach-1", filename: "brief.pdf", mimeType: "application/pdf", sizeBytes: 2048 }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["hello"], "brief.pdf", { type: "application/pdf" });

    await expect(uploadConversationAttachment(conversationId, file)).resolves.toMatchObject({ attachmentId: "attach-1" });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(lastUrl(fetchMock)).toBe(`/api/conversations/${conversationId}/attachments`);
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.headers as Record<string, string>)["content-type"]).toBeUndefined();
  });

  it("rejects an upload receipt that does not carry an attachment id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ filename: "brief.pdf" })));
    await expect(uploadConversationAttachment(conversationId, new File(["x"], "brief.pdf"))).rejects.toBeInstanceOf(MessagingApiError);
  });

  it("mirrors the legacy five file and five megabyte attachment guard", () => {
    expect(MAX_ATTACHMENTS_PER_MESSAGE).toBe(5);
    expect(MAX_ATTACHMENT_BYTES).toBe(5 * 1024 * 1024);
    expect(checkAttachmentLimits(0, [])).toBeNull();
    expect(checkAttachmentLimits(0, Array.from({ length: 6 }, () => new File(["a"], "a.txt")))).toBe("Add up to five files to one message.");
    expect(checkAttachmentLimits(4, [new File(["a"], "a.txt")])).toBeNull();
    expect(checkAttachmentLimits(5, [new File(["a"], "a.txt")])).toBe("Add up to five files to one message.");
    expect(checkAttachmentLimits(0, [new File([""], "empty.txt")])).toBe("empty.txt must be between 1 byte and 5 MB.");
    expect(checkAttachmentLimits(0, [new File(["a"], "ok.txt")])).toBeNull();
  });

  it("reads presence, people, and search through the legacy routes", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith(`/api/conversations/${conversationId}/presence`)) {
        return Response.json({ people: [{ userId: "user-2", name: "Grace", typing: true }] });
      }
      if (path.startsWith("/api/conversations/people")) return Response.json({ people: [{ type: "agent", id: "agent-1", name: "Chaste" }] });
      return Response.json({ results: [{ id: messageId, conversationId, conversationTitle: "general", body: "Morning", createdAt: "2026-10-01T09:00:00.000Z", senderType: "human", senderUserId: "user-1" }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchConversationPresence(conversationId)).resolves.toEqual([{ userId: "user-2", name: "Grace", typing: true }]);
    await expect(fetchConversationPeople("gr")).resolves.toEqual([{ type: "agent", id: "agent-1", name: "Chaste" }]);
    await expect(searchMessages("morning")).resolves.toHaveLength(1);
    expect(lastUrl(fetchMock, 1)).toBe("/api/conversations/people?q=gr");
    expect(lastUrl(fetchMock, 2)).toBe("/api/messages/search?q=morning");
  });

  it("uses Go people lookup with the preserved initial and add-member limits", async () => {
    vi.stubGlobal("__GO_MESSAGING_PEOPLE_READS__", true);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { capabilityId?: string; input?: unknown };
      if (body.capabilityId !== "messaging.listPeople") return Response.json({ error: "unexpected route" }, { status: 404 });
      return Response.json({ ok: true, data: { people: [
        { type: "user", id: "user-1", name: "Ada Lovelace" },
        { type: "agent", id: "workmate", name: "Chaste" },
      ] } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchConversationPeople()).resolves.toEqual([
      { type: "user", id: "user-1", name: "Ada Lovelace" },
      { type: "agent", id: "workmate", name: "Chaste" },
    ]);
    await expect(fetchConversationPeople("  Grace Hopper  ")).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lastUrl(fetchMock, 0)).toBe("/api/capabilities/execute");
    expect(lastBody(fetchMock, 0)).toMatchObject({ capabilityId: "messaging.listPeople", input: { limit: 100 }, intentId: expect.any(String) });
    expect(lastBody(fetchMock, 1)).toMatchObject({ capabilityId: "messaging.listPeople", input: { query: "Grace Hopper", limit: 30 }, intentId: expect.any(String) });
  });

  it("fails closed on selected Go people errors or malformed output without legacy retry", async () => {
    vi.stubGlobal("__GO_MESSAGING_PEOPLE_READS__", true);
    for (const response of [
      () => Response.json({ error: "disabled" }, { status: 503 }),
      () => Response.json({ ok: true, data: { people: [{ type: "user", id: "", name: "Invalid" }] } }),
    ]) {
      const fetchMock = vi.fn(async () => response());
      vi.stubGlobal("fetch", fetchMock);
      await expect(fetchConversationPeople("gr")).rejects.toBeInstanceOf(MessagingApiError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(lastUrl(fetchMock)).toBe("/api/capabilities/execute");
    }
  });

  it("rejects a people type outside the Go capability contract", async () => {
    vi.stubGlobal("__GO_MESSAGING_PEOPLE_READS__", true);
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { people: [
      { type: "workmate", id: "workmate", name: "Chaste" },
    ] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchConversationPeople()).rejects.toBeInstanceOf(MessagingApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastUrl(fetchMock)).toBe("/api/capabilities/execute");
  });

  it("rejects a Go people query longer than 80 characters before dispatch", async () => {
    vi.stubGlobal("__GO_MESSAGING_PEOPLE_READS__", true);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchConversationPeople("x".repeat(81))).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a presence payload that is missing the typing flag", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ people: [{ userId: "user-2", name: "Grace" }] })));
    await expect(fetchConversationPresence(conversationId)).rejects.toBeInstanceOf(MessagingApiError);
  });

  it("surfaces an unreadable body as a format error rather than a crash", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200, headers: { "content-type": "text/plain" } })));
    await expect(fetchConversations()).rejects.toMatchObject({ name: "MessagingApiError" });
  });
});
