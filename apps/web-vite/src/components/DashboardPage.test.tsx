import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "./DashboardPage";
import { dashboardFixture, myWorkFixture, setupFixture } from "../test/dashboard-fixture";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function responseFor(path: string, setup: unknown = { items: setupFixture, remaining: 1 }) {
  if (path === "/api/dashboard") return Response.json(dashboardFixture);
  if (path === "/api/setup") return Response.json(setup);
  if (path === "/api/my-work") return Response.json({ cards: myWorkFixture, generatedAt: "2026-09-27T10:15:00.000Z" });
  if (path === "/api/my-work/summarize") return Response.json({ brief: "Two actions need review, and one delivery remains open.", model: "test-model" });
  return new Response(null, { status: 404 });
}

describe("Vite home dashboard", () => {
  it("loads dashboard and setup in parallel and shows the financial cover", async () => {
    let releaseDashboard: ((response: Response) => void) | undefined;
    let releaseSetup: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      return new Promise<Response>((resolve) => {
        if (path === "/api/dashboard") releaseDashboard = resolve;
        else releaseSetup = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<DashboardPage />);
    expect(screen.getByRole("status", { name: "Loading dashboard" })).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([path]) => path).sort()).toEqual(["/api/dashboard", "/api/setup"]);

    await act(async () => {
      releaseDashboard?.(responseFor("/api/dashboard"));
      releaseSetup?.(responseFor("/api/setup"));
    });

    expect(await screen.findByText("$3,500")).not.toBeNull();
    expect(screen.getByText("Revenue").parentElement?.textContent).toContain("$12,500.00");
    expect(screen.getByRole("region", { name: "Needs you" })).not.toBeNull();
    expect(screen.getByText("One item reached its reorder point")).not.toBeNull();
    expect(screen.getByRole("region", { name: "Working capital" })).not.toBeNull();
    expect(screen.getByRole("region", { name: "Workspace setup" })).not.toBeNull();
    expect(screen.getByRole("region", { name: "Recent ledger activity" })).not.toBeNull();
  });

  it("shows a recoverable dashboard failure and retries the legacy API", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/dashboard" && fetchMock.mock.calls.filter(([path]) => String(path) === "/api/dashboard").length === 1) {
        return new Response(null, { status: 503 });
      }
      return responseFor(String(input));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<DashboardPage />);
    expect(await screen.findByText("The dashboard service is unavailable. Try again.")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("region", { name: "Needs you" })).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/dashboard", expect.objectContaining({
      credentials: "same-origin",
      headers: { accept: "application/json" },
    }));
  });

  it("keeps the dashboard usable when setup tips are forbidden or unavailable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/setup"
      ? new Response(null, { status: 403 })
      : responseFor(String(input)));
    vi.stubGlobal("fetch", fetchMock);
    const firstView = render(<DashboardPage />);

    expect(await screen.findByRole("region", { name: "Needs you" })).not.toBeNull();
    expect(screen.queryByRole("region", { name: "Workspace setup" })).toBeNull();
    expect(screen.queryByText("Workspace setup tips could not load.")).toBeNull();

    firstView.unmount();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/setup"
      ? new Response(null, { status: 503 })
      : responseFor(String(input))));
    render(<DashboardPage />);
    expect(await screen.findByText("Workspace setup tips could not load.")).not.toBeNull();
    expect(screen.getByRole("region", { name: "Needs you" })).not.toBeNull();
  });

  it("expands and dismisses setup tips using the existing local preference key", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => responseFor(String(input))));
    render(<DashboardPage />);

    expect(await screen.findByText("Add what you sell")).not.toBeNull();
    expect(screen.queryByText("Add a vendor")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show 1 more step/ }));
    expect(await screen.findByText("Add a vendor")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: 'Hide "Add what you sell"' }));
    await waitFor(() => expect(screen.queryByText("Add what you sell")).toBeNull());
    expect(JSON.parse(localStorage.getItem("chaste-setup-dismissed") ?? "[]")).toContain("products");
  });

  it("uses the display currency cookie first and the saved device preference second", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => responseFor(String(input))));
    document.cookie = "chaste_display_currency=EUR; path=/";
    const firstView = render(<DashboardPage baseCurrency="UGX" />);
    expect(await screen.findByText("€12,500.00")).not.toBeNull();

    firstView.unmount();
    document.cookie = "chaste_display_currency=; Max-Age=0; path=/";
    localStorage.setItem("chaste-prefs", JSON.stringify({ currency: "KES" }));
    render(<DashboardPage baseCurrency="UGX" />);
    expect(await screen.findByText("KSh12,500.00")).not.toBeNull();
  });

  it("adds receipt remainders, summarizes the ranked work, and preserves the legacy prompt actions", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => responseFor(String(input)));
    vi.stubGlobal("fetch", fetchMock);
    render(<DashboardPage baseCurrency="USD" />);

    expect(await screen.findByText("PO 107: 3 units still outstanding")).not.toBeNull();
    expect(screen.getByRole("link", { name: /PO 107: 3 units still outstanding/ }).getAttribute("href"))
      .toBe("http://localhost:3001/purchasing/receiving?poNumber=107");
    fireEvent.click(screen.getByRole("button", { name: "Brief me" }));
    expect(await screen.findByText("Two actions need review, and one delivery remains open.")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/my-work/summarize", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({ cards: myWorkFixture.map(({ kind, title, detail }) => ({ kind, title, detail })) }),
    }));

    const prompts = [
      ["Draft an invoice", "Draft an invoice for a customer. Ask me for the details you need."],
      ["Record a bill", "Help me record a vendor bill we received."],
      ["Where is my cash?", "Give me the cash position: cash balance in, out, and net this month."],
    ] as const;
    for (const [label, prompt] of prompts) {
      const promptLink = screen.getByRole("link", { name: label }) as HTMLAnchorElement;
      const destination = new URL(promptLink.href);
      expect(destination.origin).toBe("http://localhost:3001");
      expect(destination.pathname).toBe("/");
      expect(destination.searchParams.get("workmatePrompt")).toBe(prompt);
    }
  });
});
