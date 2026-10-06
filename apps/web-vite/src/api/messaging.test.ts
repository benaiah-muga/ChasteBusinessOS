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
    conversation: { id: conversationId },
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

  it("rejects a message list that is not a strict match for the legacy shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(thread({ messages: [message({ extra: true })] }))));
    await expect(fetchConversationThread(conversationId)).rejects.toBeInstanceOf(MessagingApiError);
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

    const fetchMock = vi.fn(async () => Response.json({
      ok: true,
      data: { messageId, editedAt: "2026-10-01T09:00:00.000Z" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(editMessage(messageId, "Retry me", undefined, options)).resolves.toEqual({ kind: "completed", data: { ok: true } });
    expect(lastBody(fetchMock)).toMatchObject({ intentId: recovered?.intentId });
    await expect(getPendingMessageEdit(scope)).resolves.toBeNull();
  });

  it.each([
    ["malformed envelope", { ok: true, data: { messageId } }],
    ["wrong message ID", { ok: true, data: { messageId: "another-message", editedAt: "2026-10-01T09:00:00.000Z" } }],
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

    responseBody = { ok: true, data: { messageId, editedAt: "2026-10-01T09:00:00.000Z" } };
    await expect(editMessage(messageId, "Retry this exact edit", undefined, options)).resolves.toEqual({
      kind: "completed", data: { ok: true },
    });
    expect(bodies[1]?.intentId).toBe(pending?.intentId);
    await expect(getPendingMessageEdit(scope)).resolves.toBeNull();
  });

  it("uses the same Go edit intent when the capability route is absent", async () => {
    vi.stubGlobal("__GO_MESSAGING_EDIT_SLICE__", true);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === "/api/capabilities/execute") return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(editMessage(messageId, "Legacy fallback", undefined, {
      allowGo: true, actorId: "user-3", organizationId: "org-3", conversationId,
    })).resolves.toEqual({ kind: "completed", data: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(`/api/messages/${messageId}`);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ body: "Legacy fallback", intentId: expect.any(String) });
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

    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { deleted: true } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(deleteMessage(messageId, undefined, options)).resolves.toEqual({ kind: "completed", data: { ok: true } });
    expect(lastBody(fetchMock)).toMatchObject({ intentId: recovered?.intentId });
    await expect(getPendingMessageDelete(scope)).resolves.toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { deleted: false } })));
    await expect(deleteMessage(messageId, undefined, { allowGo: true, actorId: "user-delete-invalid", organizationId: "org-delete-invalid", conversationId }))
      .rejects.toMatchObject({ message: expect.stringContaining("unexpected response") });
  });

  it("falls back to the legacy tombstone route only on a capability 404 with the same intent", async () => {
    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", true);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/capabilities/execute") return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(deleteMessage(messageId, undefined, {
      allowGo: true, actorId: "user-delete-fallback", organizationId: "org-delete-fallback", conversationId,
    })).resolves.toEqual({ kind: "completed", data: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const legacyUrl = new URL(String(fetchMock.mock.calls[1]?.[0]), "http://localhost");
    expect(legacyUrl.pathname).toBe(`/api/messages/${messageId}`);
    expect(legacyUrl.searchParams.get("intentId")).toEqual(expect.any(String));
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
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await advanceReadCursor(conversationId, "2026-10-01T09:00:00.000Z");
    await reportConversationPresence(conversationId, true);
    await setMessageReaction(messageId, "👍", true);
    await setMessagePin(messageId, true);
    await deletePendingAttachment(conversationId, messageId);
    await editMessage(messageId, "Corrected");

    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
      expect(body.intentId).toEqual(expect.any(String));
    }
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

  it("rejects a presence payload that is missing the typing flag", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ people: [{ userId: "user-2", name: "Grace" }] })));
    await expect(fetchConversationPresence(conversationId)).rejects.toBeInstanceOf(MessagingApiError);
  });

  it("surfaces an unreadable body as a format error rather than a crash", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200, headers: { "content-type": "text/plain" } })));
    await expect(fetchConversations()).rejects.toMatchObject({ name: "MessagingApiError" });
  });
});
