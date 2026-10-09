import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountingCloseReadinessPage } from "./AccountingCloseReadinessPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function readiness(year: number, month: number, tasks = [
  { key: "review_journal", label: "Review journals", detail: "Review posted journals for this month.", completed: true, note: "Reviewed with controller", blocking: false, status: "complete" },
  { key: "bank_reconciliation", label: "Reconcile bank activity", detail: "3 statement lines remain unmatched.", completed: false, note: null, blocking: true, status: "blocked" },
  { key: "fx_revaluation", label: "Revalue foreign receivables", detail: "Open foreign receivables: EUR, KES.", completed: false, note: null, blocking: true, status: "needs_revaluation" },
]) {
  const blockers = tasks.filter((task) => task.blocking).map((task) => task.key);
  return {
    year,
    month,
    start: new Date(Date.UTC(year, month - 1, 1)).toISOString(),
    end: new Date(Date.UTC(year, month, 1) - 1).toISOString(),
    tasks,
    blockers,
    readyToClose: blockers.length === 0,
    unmatchedLineCount: 3,
    currenciesWithExposure: ["EUR", "KES"],
  };
}

function stubAccounting(taskList = readiness(2026, 8).tasks) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/modules") {
      return Response.json({ catalog: [{ id: "accounting" }], enabledModules: ["accounting"] });
    }
    if (url.startsWith("/api/accounting/close?")) {
      const query = new URL(url, "http://localhost").searchParams;
      return Response.json({ ok: true, data: readiness(Number(query.get("year")), Number(query.get("month")), taskList) });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("AccountingCloseReadinessPage", () => {
  it("loads readiness through accounting.periodCloseWorkbench when the Go selector is enabled", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_PERIOD_CLOSE_READS__", true);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/modules") {
        return Response.json({ catalog: [{ id: "accounting" }], enabledModules: ["accounting"] });
      }
      if (url === "/api/capabilities/execute") {
        const request = JSON.parse(String(init?.body)) as { input: { year: number; month: number } };
        return Response.json({ ok: true, data: readiness(request.input.year, request.input.month) });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AccountingCloseReadinessPage />);

    expect(await screen.findByRole("heading", { name: "Not ready to close" })).toBeTruthy();
    const capabilityCall = fetchMock.mock.calls.find(([url]) => String(url) === "/api/capabilities/execute");
    expect(capabilityCall?.[1]).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
    expect(JSON.parse(String(capabilityCall?.[1]?.body))).toMatchObject({
      capabilityId: "accounting.periodCloseWorkbench",
      input: { year: expect.any(Number), month: expect.any(Number) },
      intentId: expect.any(String),
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/accounting/close"))).toBe(false);
  });

  it("shows the readiness status, blockers, tasks, period totals, and full-workspace link", async () => {
    const fetchMock = stubAccounting();
    render(<AccountingCloseReadinessPage />);

    expect(await screen.findByRole("heading", { name: "Period close readiness" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Not ready to close" })).toBeTruthy();
    expect(screen.getByText("3 statement lines remain unmatched.")).toBeTruthy();
    expect(screen.getByText("Review posted journals for this month.")).toBeTruthy();
    expect(screen.getByText(/Review note: Reviewed with controller/)).toBeTruthy();
    expect(screen.getByText("3", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText("EUR, KES", { selector: "dd" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open full period close workspace" }).getAttribute("href")).toContain("/accounting/close");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/accounting\/close\?year=\d{4}&month=\d{1,2}$/), expect.objectContaining({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    }));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("reloads readiness when the selected period changes", async () => {
    const fetchMock = stubAccounting();
    render(<AccountingCloseReadinessPage />);
    await screen.findByRole("heading", { name: "Not ready to close" });

    fireEvent.change(screen.getByLabelText("Close period"), { target: { value: "2026-07" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/accounting/close?year=2026&month=7", expect.any(Object)));
    expect(await screen.findByText("July 2026")).toBeTruthy();
  });

  it("shows a ready state when there are no blocking checks", async () => {
    stubAccounting([
      { key: "review_journal", label: "Review journals", detail: "Reviewed.", completed: true, note: null, blocking: false, status: "complete" },
    ]);
    render(<AccountingCloseReadinessPage />);

    expect(await screen.findByRole("heading", { name: "Ready to close" })).toBeTruthy();
    expect(screen.getByText("No blocking checks remain.")).toBeTruthy();
    expect(screen.getByText("Complete")).toBeTruthy();
  });

  it("shows empty readiness when the service returns no tasks", async () => {
    stubAccounting([]);
    render(<AccountingCloseReadinessPage />);

    expect(await screen.findByRole("heading", { name: /No readiness checks for/ })).toBeTruthy();
  });

  it("shows a module-disabled state without requesting readiness", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ catalog: [{ id: "accounting" }], enabledModules: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AccountingCloseReadinessPage />);

    expect(await screen.findByRole("heading", { name: "Accounting is turned off" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/modules", expect.any(Object));
  });

  it("provides a sign-in path when readiness access expires", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/modules"
      ? Response.json({ catalog: [{ id: "accounting" }], enabledModules: ["accounting"] })
      : Response.json({ error: "unauthorized" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AccountingCloseReadinessPage />);

    expect(await screen.findByRole("heading", { name: "Sign in again" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe("/login");
    expect(within(screen.getByRole("alert")).getByText("Your session has ended. Sign in again to continue.")).toBeTruthy();
  });
});
