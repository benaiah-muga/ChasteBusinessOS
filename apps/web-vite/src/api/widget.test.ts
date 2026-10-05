import { afterEach, describe, expect, it, vi } from "vitest";
import {
  escalateToHuman,
  pollWidgetThread,
  readStoredThread,
  sendWidgetMessage,
  startWidgetThread,
  storeThread,
  widgetStorageKey,
} from "./widget";

const token = "0123456789abcdef0123456789abcdef";
const conversationId = "3f1b0c6e-2f6a-4a0a-9c9e-6c1a2b3d4e5f";
const secret = "a".repeat(48);

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("public widget API", () => {
  it("starts a thread only after validating the input and response", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_input)).toBe("/api/support/public");
      expect(init?.method).toBe("POST");
      expect(init?.credentials).toBe("omit");
      expect(init?.referrerPolicy).toBe("no-referrer");
      expect(JSON.parse(String(init?.body))).toEqual({
        action: "start",
        token,
        email: "visitor@example.com",
        name: "Visitor",
      });
      return jsonResponse({ conversationId, secret });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(startWidgetThread("short", "visitor@example.com")).resolves.toEqual({ status: "rejected" });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(startWidgetThread(token, "visitor@example.com", "Visitor")).resolves.toEqual({
      status: "started",
      conversationId,
      secret,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("polls with a POST body so thread credentials never enter the URL", async () => {
    const response = {
      status: "open",
      messages: [{
        id: "d6a3b0c1-2f6a-4a0a-9c9e-6c1a2b3d4e5f",
        senderType: "agent",
        body: "How can we help?",
        createdAt: "2026-09-20T09:30:00.000Z",
      }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/support/public");
      expect(init?.method).toBe("POST");
      expect(init?.credentials).toBe("omit");
      expect(init?.referrerPolicy).toBe("no-referrer");
      expect(init?.cache).toBe("no-store");
      expect(JSON.parse(String(init?.body))).toEqual({ action: "poll", token, conversationId, secret });
      return jsonResponse(response);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(pollWidgetThread(token, conversationId, secret)).resolves.toEqual({ status: "ok", thread: response });
  });

  it("rejects invalid thread credentials and malformed server data", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: "open", messages: [{ body: "not a valid message" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(pollWidgetThread(token, "not-a-uuid", secret)).resolves.toEqual({ status: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(pollWidgetThread(token, conversationId, secret)).resolves.toEqual({ status: "unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns failure for rejected sends and validates escalation credentials", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "closed" }, 409));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendWidgetMessage(token, conversationId, secret, " hello ")).resolves.toBe(false);
    await expect(sendWidgetMessage(token, conversationId, secret, "   ")).resolves.toBe(false);
    await expect(escalateToHuman(token, "bad-id", secret)).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stores only a validated thread secret and tolerates corrupt saved state", () => {
    storeThread(token, { conversationId, secret });
    expect(readStoredThread(token)).toEqual({ conversationId, secret });
    expect(localStorage.getItem(widgetStorageKey(token))).toBe(JSON.stringify({ conversationId, secret }));

    localStorage.setItem(widgetStorageKey(token), JSON.stringify({ conversationId: "bad", secret }));
    expect(readStoredThread(token)).toBeNull();
    storeThread("bad-token", { conversationId, secret });
    expect(localStorage.getItem(widgetStorageKey("bad-token"))).toBeNull();
  });
});
