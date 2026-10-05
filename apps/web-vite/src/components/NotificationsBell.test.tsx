import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchNotifications, NotificationsApiError, safeNotificationHref } from "../api/notifications";
import { NotificationsBell } from "./NotificationsBell";

const row = {
  id: "notice-1",
  kind: "approval",
  title: "An approval needs your attention",
  href: "/approvals?state=pending",
  readAt: null,
  createdAt: "2026-10-03T09:30:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("notifications API client", () => {
  it("requests and validates the recent notification feed", async () => {
    const fetchMock = vi.fn(async () => Response.json({ notifications: [row], unreadCount: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchNotifications()).resolves.toEqual({ notifications: [row], unreadCount: 1 });
    expect(fetchMock).toHaveBeenCalledWith("/api/notifications?limit=20", expect.objectContaining({
      credentials: "same-origin",
      headers: { accept: "application/json" },
    }));
  });

  it("rejects malformed payloads and only returns safe same-origin paths", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ notifications: [{ ...row, createdAt: "yesterday" }], unreadCount: 1 })));
    await expect(fetchNotifications()).rejects.toBeInstanceOf(NotificationsApiError);
    await expect(fetchNotifications()).rejects.toMatchObject({ message: "The notifications service returned data in an unexpected format." });

    expect(safeNotificationHref("/approvals/1?tab=mine#top")).toBe("/approvals/1?tab=mine#top");
    expect(safeNotificationHref("//evil.example/path")).toBeNull();
    expect(safeNotificationHref("/\\evil.example/path")).toBeNull();
    expect(safeNotificationHref("https://evil.example/path")).toBeNull();
    expect(safeNotificationHref(null)).toBeNull();
  });
});

describe("NotificationsBell", () => {
  it("shows the unread count, renders only safe links, and leaves read updates on POST", async () => {
    const pendingPost: { resolve?: (response: Response) => void } = {};
    const pendingGet: { resolve?: (response: Response) => void } = {};
    let getCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Promise<Response>((resolve) => { pendingPost.resolve = resolve; });
      }
      getCount += 1;
      if (getCount === 2) return new Promise<Response>((resolve) => { pendingGet.resolve = resolve; });
      return Response.json({
        notifications: [row, { ...row, id: "notice-2", href: "https://evil.example/phishing", title: "Unsafe destination" }],
        unreadCount: 2,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const navigate = vi.fn();

    render(<NotificationsBell onNavigate={navigate} />);
    const trigger = await screen.findByRole("button", { name: "Notifications, 2 unread" });
    expect(trigger.textContent).toContain("2");
    fireEvent.click(trigger);

    const safeLink = await screen.findByRole("link", { name: /An approval needs your attention/ });
    expect(safeLink.getAttribute("href")).toBe("/approvals?state=pending");
    expect(screen.getByText("Unsafe destination").closest("div")?.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(safeLink);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/notifications", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({ id: "notice-1" }),
    })));
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => {
      pendingGet.resolve?.(Response.json({ notifications: [row], unreadCount: 2 }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(screen.getByRole("button", { name: "Notifications, 1 unread" })).toBeTruthy();
    pendingPost.resolve?.(new Response(null, { status: 204 }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/approvals?state=pending"));
  });

  it("keeps the popover keyboard-native and returns focus on Escape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ notifications: [row], unreadCount: 1 })));
    render(<NotificationsBell />);
    const trigger = await screen.findByRole("button", { name: "Notifications, 1 unread" });
    fireEvent.click(trigger);
    const link = await screen.findByRole("link", { name: /An approval needs your attention/ });
    link.focus();

    fireEvent.keyDown(link, { key: "Escape" });

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("reloads after a failed read even when another read is still pending", async () => {
    const secondRow = { ...row, id: "notice-2", href: "/sessions", title: "A session needs review" };
    const pendingPosts: Record<string, (response: Response) => void> = {};
    let getCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { id: string };
        return new Promise<Response>((resolve) => { pendingPosts[body.id] = resolve; });
      }
      getCount += 1;
      if (getCount < 3) return Response.json({ notifications: [row, secondRow], unreadCount: 2 });
      return Response.json({
        notifications: [row, { ...secondRow, readAt: "2026-10-04T12:00:00.000Z" }],
        unreadCount: 1,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const navigate = vi.fn();

    render(<NotificationsBell onNavigate={navigate} />);
    const trigger = await screen.findByRole("button", { name: "Notifications, 2 unread" });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("link", { name: /An approval needs your attention/ }));
    fireEvent.click(await screen.findByRole("link", { name: /A session needs review/ }));
    await waitFor(() => {
      expect(pendingPosts["notice-1"]).toBeTruthy();
      expect(pendingPosts["notice-2"]).toBeTruthy();
    });

    pendingPosts["notice-1"]?.(Response.json({ error: "unavailable" }, { status: 503 }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/approvals?state=pending"));
    expect(getCount).toBe(2);
    pendingPosts["notice-2"]?.(new Response(null, { status: 204 }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    expect(screen.getByRole("button", { name: "Notifications, 1 unread" })).toBeTruthy();
  });

  it("shows a recoverable error when the feed fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "unavailable" }, { status: 503 })));
    render(<NotificationsBell />);
    fireEvent.click(await screen.findByRole("button", { name: "Notifications" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The notifications service is unavailable. Try again.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
