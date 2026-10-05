// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WidgetChat } from "./widget-chat";

const tokenA = "widget-token-a-0123456789";
const tokenB = "widget-token-b-0123456789";
const conversationId = "3f1b0c6e-2f6a-4a0a-9c9e-6c1a2b3d4e5f";
const secret = "a".repeat(48);

function response(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

function view(token: string) {
  return <WidgetChat token={token} />;
}

describe("legacy public widget chat", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("sends polling credentials in a POST body and hides stale thread responses after token changes", async () => {
    localStorage.setItem(`chaste-widget:${tokenA}`, JSON.stringify({ conversationId, secret }));
    let resolvePoll!: (result: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolvePoll = resolve; }));
    vi.stubGlobal("fetch", fetchMock);

    const rendered = render(view(tokenA));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/support/public");
    expect(init.method).toBe("POST");
    expect(String(init.body)).toContain(secret);
    expect(url).not.toContain(secret);

    await act(async () => rendered.rerender(view(tokenB)));
    expect(await screen.findByLabelText("Your email")).toBeTruthy();

    resolvePoll(response({
      status: "open",
      messages: [{ id: "old", senderType: "agent", body: "Old private thread", createdAt: "2026-10-04T00:00:00.000Z" }],
    }));
    await waitFor(() => expect(screen.queryByText("Old private thread")).toBeNull());
    expect(screen.getByLabelText("Your email")).toBeTruthy();
  });
});
