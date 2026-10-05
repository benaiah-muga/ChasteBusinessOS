import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { WidgetPage } from "./WidgetPage";
import { widgetStorageKey } from "../api/widget";

const tokenA = "0123456789abcdef-token-a";
const tokenB = "0123456789abcdef-token-b";
const conversationA = "3f1b0c6e-2f6a-4a0a-9c9e-6c1a2b3d4e5f";
const conversationB = "4f1b0c6e-2f6a-4a0a-9c9e-6c1a2b3d4e5f";
const secretA = "a".repeat(48);
const secretB = "b".repeat(48);

function threadMessage(id: string, body: string) {
  return {
    id,
    senderType: "agent",
    body,
    createdAt: "2026-09-20T09:30:00.000Z",
  };
}

function jsonResponse(body: unknown): Response {
  return Response.json(body);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("WidgetPage token changes", () => {
  it("hides the previous thread immediately and polls only the new token's thread", async () => {
    localStorage.setItem(widgetStorageKey(tokenA), JSON.stringify({ conversationId: conversationA, secret: secretA }));
    localStorage.setItem(widgetStorageKey(tokenB), JSON.stringify({ conversationId: conversationB, secret: secretB }));
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { action: string; token: string; conversationId?: string; secret?: string };
      expect(body.action).toBe("poll");
      if (body.token === tokenA) {
        expect(body.conversationId).toBe(conversationA);
        expect(body.secret).toBe(secretA);
        return jsonResponse({ status: "open", messages: [threadMessage("d6a3b0c1-2f6a-4a0a-9c9e-6c1a2b3d4e5f", "A token message")] });
      }
      expect(body.token).toBe(tokenB);
      expect(body.conversationId).toBe(conversationB);
      expect(body.secret).toBe(secretB);
      return jsonResponse({ status: "open", messages: [threadMessage("e6a3b0c1-2f6a-4a0a-9c9e-6c1a2b3d4e5f", "B token message")] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<WidgetPage pathname={`/widget/${tokenA}`} />);
    expect(await screen.findByText("A token message")).toBeTruthy();

    view.rerender(<WidgetPage pathname={`/widget/${tokenB}`} />);
    expect(screen.queryByText("A token message")).toBeNull();
    expect(await screen.findByText("B token message")).toBeTruthy();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
