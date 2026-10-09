import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchAccountingCloseEnabled,
  fetchAccountingCloseReadiness,
  accountingPeriodCloseReadsUseGo,
  AccountingCloseApiError,
} from "./accounting-close";

afterEach(() => vi.unstubAllGlobals());

function closeReadiness(year: number, month: number) {
  return {
    year,
    month,
    start: new Date(Date.UTC(year, month - 1, 1)).toISOString(),
    end: new Date(Date.UTC(year, month, 1) - 1).toISOString(),
    tasks: [
      { key: "review_journal", label: "Review journals", detail: "Review posted journals.", completed: true, note: "Reviewed", blocking: false, status: "complete" },
      { key: "bank_reconciliation", label: "Reconcile bank activity", detail: "3 statement lines remain unmatched.", completed: false, note: null, blocking: true, status: "blocked" },
    ],
    blockers: ["bank_reconciliation"],
    readyToClose: false,
    unmatchedLineCount: 3,
    currenciesWithExposure: ["EUR", "KES"],
  };
}

describe("accounting close API", () => {
  it("uses the session capability endpoint for Go period-close reads when selected", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_PERIOD_CLOSE_READS__", true);
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: closeReadiness(2026, 8) }));
    vi.stubGlobal("fetch", fetchMock);

    expect(accountingPeriodCloseReadsUseGo()).toBe(true);
    await expect(fetchAccountingCloseReadiness(2026, 8)).resolves.toEqual(closeReadiness(2026, 8));
    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe("/api/capabilities/execute");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      capabilityId: "accounting.periodCloseWorkbench",
      input: { year: 2026, month: 8 },
      intentId: expect.any(String),
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/accounting/close"))).toBe(false);
  });

  it("validates the Accounting switchboard and complete close-readiness response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ catalog: [{ id: "accounting" }], enabledModules: ["accounting"] }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: closeReadiness(2026, 8) }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAccountingCloseEnabled()).resolves.toBe(true);
    await expect(fetchAccountingCloseReadiness(2026, 8)).resolves.toEqual(closeReadiness(2026, 8));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/modules",
      "/api/accounting/close?year=2026&month=8",
    ]);
    expect(fetchMock.mock.calls.every(([, init]) => init?.credentials === "same-origin" && init.cache === "no-store")).toBe(true);
  });

  it("rejects inconsistent blockers, invalid consumed fields, and mismatched periods", async () => {
    const inconsistent = closeReadiness(2026, 8);
    inconsistent.blockers = [];
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, data: inconsistent }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: closeReadiness(2026, 7) })));

    await expect(fetchAccountingCloseReadiness(2026, 8)).rejects.toMatchObject({
      status: 200,
      message: "The Accounting service returned period-close readiness in an unexpected format.",
    });
    await expect(fetchAccountingCloseReadiness(2026, 8)).rejects.toMatchObject({
      status: 200,
      message: "The Accounting service returned readiness for a different close period.",
    });
  });

  it("preserves authentication errors and rejects invalid period arguments before fetching", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAccountingCloseReadiness(2026, 8)).rejects.toMatchObject({
      name: "AccountingCloseApiError",
      status: 401,
      message: "Your session has ended. Sign in again to continue.",
    });
    await expect(fetchAccountingCloseReadiness(2026, 13)).rejects.toBeInstanceOf(AccountingCloseApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
