import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountingApiError,
  emailInvoice,
  fetchAccountingBanking,
  fetchAccountingBudgetScenarios,
  fetchAccountingCashBasis,
  fetchAccountingEnabled,
  fetchAccountingOverview,
  fetchAccountingReports,
  fetchAccountingTaxCodes,
  fetchCashForecast,
  fetchCustomerStatement,
  fetchPaymentReminders,
  readPendingAccountingRecordPayment,
  readPendingAccountingCreateInvoice,
  readPendingAccountingCreditNote,
  readPendingAccountingReverseEntry,
  readPendingAccountingReversePayment,
  readPendingAccountingBankReconciliationWrite,
  readPendingAccountingCloseYear,
  readPendingAccountingPeriodFxWrite,
  submitAccountingAction,
} from "./accounting";

const ORG_ID = "66666666-6666-4666-8666-666666666666";

const entry = {
  id: "entry-1",
  memo: "Invoice 1042",
  sourceType: "invoice",
  reversalOfId: null,
  postedAt: "2026-09-20T10:30:00.000Z",
  actorType: "agent",
  currency: "USD",
  amountMinor: 125_00,
  debitMinor: 12_500,
};

const invoice = {
  id: "invoice-1",
  number: 1042,
  customerId: "customer-1",
  customerName: "Kampala Coffee",
  status: "partially_paid",
  currency: "USD",
  totalMinor: 12_500,
  paidMinor: 2_500,
  creditedMinor: 0,
  outstandingMinor: 10_000,
  issuedAt: "2026-09-20T10:30:00.000Z",
};

const payment = {
  id: "payment-1",
  invoiceNumber: 1042,
  amountMinor: 2_500,
  method: "bank_transfer",
  receivedAt: "2026-09-21T08:00:00.000Z",
  currency: "USD",
};

const overview = {
  entries: [entry],
  aging: { current: 10_000, d30: 0, d60: 0, d90plus: 0, totalOutstanding: 10_000 },
  agingInvoices: [{ number: 1042, currency: "USD", outstandingMinor: 10_000, ageDays: 12 }],
  baseCurrency: "USD",
  foreignReceivablesCount: 0,
  foreignPayablesCount: 0,
  closedPeriods: [{ year: 2026, month: 1 }],
  bills: [
    {
      id: "bill-1",
      number: 77,
      status: "open",
      currency: "USD",
      totalMinor: 4_000,
      creditedMinor: 0,
      paidMinor: 0,
      vendorName: "Harbor Supplies",
      outstandingMinor: 4_000,
    },
  ],
  filings: [],
  customers: [{ id: "customer-1", name: "Kampala Coffee", paymentTermDays: 30 }],
  invoices: [invoice],
  payments: [payment],
};

const reports = {
  baseCurrency: "USD",
  unsupportedCurrencies: [],
  pnl: { revenueMinor: 12_500, expenseMinor: 1_000, netIncomeMinor: 11_500, lines: [{ code: "4000", name: "Revenue", amountMinor: 12_500 }] },
  balanceSheet: { assetsMinor: 20_000, liabilitiesMinor: 4_000, equityMinor: 16_000, retainedResultMinor: 0, balanced: true },
  cashFlow: null,
  fxExposure: null,
};

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

const paymentRetryScope = {
  actorId: "a5zVJvRUGPkJNBQMEuSH_CkoB7ubSjXd",
  organizationId: "22222222-2222-4222-8222-222222222222",
};

function stubPaymentLocks(): void {
  const tails = new Map<string, Promise<void>>();
  const locks = {
    request: async <T>(name: string, _options: LockOptions, callback: () => Promise<T>): Promise<T> => {
      const previous = tails.get(name) ?? Promise.resolve();
      let release = (): void => {};
      const current = new Promise<void>((resolve) => { release = resolve; });
      tails.set(name, current);
      await previous;
      try { return await callback(); }
      finally {
        release();
        if (tails.get(name) === current) tails.delete(name);
      }
    },
  };
  vi.stubGlobal("navigator", Object.assign(Object.create(navigator) as Navigator, { locks }));
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("accounting API: module switchboard", () => {
  it("accepts the real switchboard payload, whose catalog entries carry more than an id", async () => {
    // /api/modules returns the whole MODULE_CATALOG, so each entry also has
    // label, description, href, and protected. Treating those as unexpected made
    // the live page report an invalid format for a valid response.
    stubFetch(() => Response.json({
      catalog: [
        {
          id: "accounting",
          label: "Accounting",
          description: "Ledger, invoicing, bills, payments, reports",
          href: "/accounting",
        },
        { id: "iam", label: "IAM", description: "Access governance", href: "/team" },
        { id: "signals", label: "Signals", description: "Attention feeds", href: "/approvals" },
        { id: "routines", label: "Routines", description: "Scheduled work", href: "/approvals" },
      ],
      // The route always prepends the protected modules to a saved list.
      enabledModules: ["accounting", "iam", "signals", "routines"],
    }));
    await expect(fetchAccountingEnabled()).resolves.toBe(true);
  });

  it("reports Accounting as enabled only when the catalog backs it", async () => {
    stubFetch(() => Response.json({ catalog: [{ id: "accounting" }, { id: "sales" }], enabledModules: ["accounting", "sales"] }));
    await expect(fetchAccountingEnabled()).resolves.toBe(true);
  });

  it("reports Accounting as disabled without touching the books", async () => {
    const mock = stubFetch(() => Response.json({ catalog: [{ id: "accounting" }], enabledModules: [] }));
    await expect(fetchAccountingEnabled()).resolves.toBe(false);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("rejects an enabled module the catalog does not describe", async () => {
    stubFetch(() => Response.json({ catalog: [{ id: "accounting" }], enabledModules: ["ghost"] }));
    await expect(fetchAccountingEnabled()).rejects.toBeInstanceOf(AccountingApiError);
  });
});

describe("accounting API: books and reports", () => {
  it("accepts the Go integer debit aggregate", async () => {
    const mock = stubFetch(() => Response.json({ ok: true, data: {
      ...overview,
      entries: [{ ...entry, debitMinor: 12_500 }],
    } }));
    const result = await fetchAccountingOverview(ORG_ID);
    expect(result.entries[0]?.debitMinor).toBe(12_500);
    expect(mock).toHaveBeenCalledWith("/api/capabilities/execute", expect.anything());
  });

  it("fails closed before requesting overview or reports without a valid organization", async () => {
    const mock = stubFetch(() => Response.json({ ok: true, data: overview }));
    await expect(fetchAccountingOverview(null)).rejects.toMatchObject({ status: 0 });
    await expect(fetchAccountingReports("not-an-org-id")).rejects.toMatchObject({ status: 0 });
    expect(mock).not.toHaveBeenCalled();
  });

  it("still rejects a non-numeric aggregate", async () => {
    stubFetch(() => Response.json({ ok: true, data: { ...overview, entries: [{ ...entry, debitMinor: "not-a-number" }] } }));
    await expect(fetchAccountingOverview(ORG_ID)).rejects.toBeInstanceOf(AccountingApiError);
  });

  it("always loads the strict overview from Go with a session capability request", async () => {
    const mock = stubFetch(() => Response.json({ ok: true, data: overview }));
    await expect(fetchAccountingOverview(ORG_ID)).resolves.toEqual(overview);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: expect.objectContaining({ "X-Organization-ID": ORG_ID }),
      body: expect.stringContaining('"capabilityId":"accounting.overview"'),
    }));
    const requestBody = JSON.parse(String(mock.mock.calls[0]?.[1]?.body ?? "{}")) as { input?: unknown; intentId?: string };
    expect(requestBody.input).toEqual({});
    expect(requestBody.intentId).toEqual(expect.any(String));
  });

  it("fails closed on a Go error without retrying the legacy overview", async () => {
    const mock = stubFetch(() => Response.json({ message: "service unavailable" }, { status: 503 }));

    await expect(fetchAccountingOverview(ORG_ID)).rejects.toMatchObject({ status: 503 });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith("/api/capabilities/execute", expect.anything());
  });

  it("rejects an unsafe Go debit aggregate", async () => {
    stubFetch(() => Response.json({
      ok: true,
      data: { ...overview, entries: [{ ...entry, debitMinor: Number.MAX_SAFE_INTEGER + 1 }] },
    }));

    await expect(fetchAccountingOverview(ORG_ID)).rejects.toMatchObject({
      name: "AccountingApiError",
      message: "The Go Accounting service returned an unexpected result.",
    });
  });

  it("rejects a body that drifts from the ledger contract", async () => {
    stubFetch(() => Response.json({ ok: true, data: { ...overview, entries: [{ ...entry, amountMinor: 12.5 }] } }));
    await expect(fetchAccountingOverview(ORG_ID)).rejects.toMatchObject({
      name: "AccountingApiError",
      message: "The Go Accounting service returned an unexpected result.",
    });
  });

  it("rejects money that is not an integer in minor units", async () => {
    stubFetch(() => Response.json({ ok: true, data: { ...overview, baseCurrency: "USD", aging: { ...overview.aging, totalOutstanding: 1.5 } } }));
    await expect(fetchAccountingOverview(ORG_ID)).rejects.toBeInstanceOf(AccountingApiError);
  });

  it("maps a session ending to a sign-in message rather than wire truth", async () => {
    stubFetch(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    await expect(fetchAccountingOverview(ORG_ID)).rejects.toMatchObject({
      status: 401,
      message: "Your session has ended. Sign in again to continue.",
    });
  });

  it("hides markup in a server error message", async () => {
    stubFetch(() => Response.json({ message: "<script>alert(1)</script>" }, { status: 500 }));
    await expect(fetchAccountingReports(ORG_ID)).rejects.toMatchObject({
      status: 500,
      message: "The Accounting service is unavailable. Try again.",
    });
  });

  it("loads the aggregate from the five session Go report capabilities with no-store caching", async () => {
    const dataByCapability: Record<string, unknown> = {
      "accounting.incomeStatement": reports.pnl,
      "accounting.balanceSheet": reports.balanceSheet,
      "accounting.cashFlow": null,
      "accounting.unrealizedFxExposure": { exposures: [] },
      "accounting.reportCurrencyMetadata": { baseCurrency: "USD", unsupportedCurrencies: ["EUR"] },
    };
    const mock = stubFetch((_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { capabilityId?: string };
      if (body.capabilityId === "accounting.cashFlow") {
        return Response.json({ ok: false, error: "No optional report data." }, { status: 422 });
      }
      return Response.json({ ok: true, data: dataByCapability[body.capabilityId ?? ""] });
    });

    await expect(fetchAccountingReports(ORG_ID)).resolves.toEqual({
      baseCurrency: "USD",
      unsupportedCurrencies: ["EUR"],
      pnl: reports.pnl,
      balanceSheet: reports.balanceSheet,
      cashFlow: null,
      fxExposure: { exposures: [] },
    });
    expect(mock).toHaveBeenCalledTimes(5);
    const calls = mock.mock.calls.map(([url, init]) => ({
      url,
      init,
      body: JSON.parse(String(init?.body ?? "{}")) as { capabilityId?: string; input?: unknown; intentId?: string },
    }));
    expect(calls.map((call) => call.body.capabilityId).sort()).toEqual([
      "accounting.balanceSheet",
      "accounting.cashFlow",
      "accounting.incomeStatement",
      "accounting.reportCurrencyMetadata",
      "accounting.unrealizedFxExposure",
    ]);
    for (const call of calls) {
      expect(call.url).toBe("/api/capabilities/execute");
      expect(call.init).toMatchObject({ method: "POST", cache: "no-store", credentials: "same-origin" });
      expect(call.init?.headers).toMatchObject({ "X-Organization-ID": ORG_ID });
      expect(call.body.input).toEqual({});
      expect(call.body.intentId).toEqual(expect.any(String));
    }
  });

  it("preserves Go FX permission errors instead of treating them as missing data", async () => {
    stubFetch((_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { capabilityId?: string };
      if (body.capabilityId === "accounting.unrealizedFxExposure") {
        return Response.json({ ok: false, error: "forbidden: missing accounting.read" }, { status: 422 });
      }
      if (body.capabilityId === "accounting.cashFlow") return Response.json({ ok: false, error: "cash basis unavailable" }, { status: 422 });
      if (body.capabilityId === "accounting.incomeStatement") return Response.json({ ok: true, data: reports.pnl });
      if (body.capabilityId === "accounting.balanceSheet") return Response.json({ ok: true, data: reports.balanceSheet });
      return Response.json({ ok: true, data: { baseCurrency: "USD", unsupportedCurrencies: [] } });
    });
    await expect(fetchAccountingReports(ORG_ID)).rejects.toMatchObject({
      status: 422,
      message: "forbidden: missing accounting.read",
    });
  });

  it("preserves Go cash-flow permission errors instead of treating them as optional data", async () => {
    stubFetch((_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { capabilityId?: string };
      if (body.capabilityId === "accounting.cashFlow") {
        return Response.json({ ok: false, error: "forbidden: missing accounting.read" }, { status: 422 });
      }
      if (body.capabilityId === "accounting.incomeStatement") return Response.json({ ok: true, data: reports.pnl });
      if (body.capabilityId === "accounting.balanceSheet") return Response.json({ ok: true, data: reports.balanceSheet });
      if (body.capabilityId === "accounting.unrealizedFxExposure") return Response.json({ ok: true, data: { exposures: [] } });
      return Response.json({ ok: true, data: { baseCurrency: "USD", unsupportedCurrencies: [] } });
    });
    await expect(fetchAccountingReports(ORG_ID)).rejects.toMatchObject({
      status: 422,
      message: "forbidden: missing accounting.read",
    });
  });

  it.each([
    { label: "incomplete Go FX rate tuple", latestRateNum: null, latestRateDen: null, outstandingBaseMinor: 120 },
    { label: "zero Go FX numerator", latestRateNum: 0, latestRateDen: 1, outstandingBaseMinor: 120 },
    { label: "negative Go FX numerator", latestRateNum: -1, latestRateDen: 1, outstandingBaseMinor: 120 },
    { label: "zero Go FX denominator", latestRateNum: 1, latestRateDen: 0, outstandingBaseMinor: 120 },
    { label: "negative Go FX denominator", latestRateNum: 1, latestRateDen: -1, outstandingBaseMinor: 120 },
  ])("rejects $label", async ({ latestRateNum, latestRateDen, outstandingBaseMinor }) => {
    stubFetch((_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { capabilityId?: string };
      if (body.capabilityId === "accounting.incomeStatement") return Response.json({ ok: true, data: reports.pnl });
      if (body.capabilityId === "accounting.balanceSheet") return Response.json({ ok: true, data: reports.balanceSheet });
      if (body.capabilityId === "accounting.cashFlow") return Response.json({ ok: false, error: "cash basis unavailable" }, { status: 422 });
      if (body.capabilityId === "accounting.unrealizedFxExposure") {
        return Response.json({ ok: true, data: { exposures: [{
          currency: "EUR",
          outstandingForeignMinor: 100,
          latestRateNum,
          latestRateDen,
          outstandingBaseMinor,
        }] } });
      }
      return Response.json({ ok: true, data: { baseCurrency: "USD", unsupportedCurrencies: [] } });
    });
    await expect(fetchAccountingReports(ORG_ID)).rejects.toMatchObject({
      message: "The Accounting reports service returned an unexpected result.",
    });
  });

  it.each([
    { label: "pending", response: () => Response.json({ pendingApproval: true }, { status: 202 }), status: 202 },
    { label: "unavailable", response: () => Response.json({ error: "not found" }, { status: 404 }), status: 404 },
    { label: "malformed", response: () => Response.json({ ok: true, data: { revenueMinor: "12" } }), status: 200 },
    { label: "required domain error", response: () => Response.json({ ok: false, error: "P&L failed" }, { status: 422 }), status: 422 },
  ])("fails closed on $label Go report responses", async ({ response, status }) => {
    const mock = stubFetch((url, init) => {
      if (url !== "/api/capabilities/execute") return Response.json(reports);
      const body = JSON.parse(String(init?.body ?? "{}")) as { capabilityId?: string };
      return body.capabilityId === "accounting.incomeStatement" ? response() : Response.json({ ok: true, data: reports.pnl });
    });
    await expect(fetchAccountingReports(ORG_ID)).rejects.toMatchObject({ name: "AccountingApiError", status });
    expect(mock.mock.calls.every(([url]) => url === "/api/capabilities/execute")).toBe(true);
  });

  it("rejects malformed Go currency metadata", async () => {
    const validCashFlow = {
      openingMinor: 0, closingMinor: 0, netMinor: 0, cashBalanceMinor: 0, ties: true,
      operating: { inflowMinor: 0, outflowMinor: 0, netMinor: 0, entries: 0 },
      investing: { inflowMinor: 0, outflowMinor: 0, netMinor: 0, entries: 0 },
      financing: { inflowMinor: 0, outflowMinor: 0, netMinor: 0, entries: 0 },
    };
    const mock = stubFetch((_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { capabilityId?: string };
      if (body.capabilityId === "accounting.reportCurrencyMetadata") {
        return Response.json({ ok: true, data: { baseCurrency: "USD", unsupportedCurrencies: ["EUR", "EUR"] } });
      }
      const data = body.capabilityId === "accounting.incomeStatement" ? reports.pnl
        : body.capabilityId === "accounting.balanceSheet" ? reports.balanceSheet
          : body.capabilityId === "accounting.cashFlow" ? validCashFlow
            : { exposures: [] };
      return Response.json({ ok: true, data });
    });
    await expect(fetchAccountingReports(ORG_ID)).rejects.toMatchObject({ name: "AccountingApiError" });
    expect(mock).toHaveBeenCalledTimes(5);
  });

  it("does not turn unavailable optional Go reports into null", async () => {
    const validCashFlow = {
      openingMinor: 0, closingMinor: 0, netMinor: 0, cashBalanceMinor: 0, ties: true,
      operating: { inflowMinor: 0, outflowMinor: 0, netMinor: 0, entries: 0 },
      investing: { inflowMinor: 0, outflowMinor: 0, netMinor: 0, entries: 0 },
      financing: { inflowMinor: 0, outflowMinor: 0, netMinor: 0, entries: 0 },
    };
    const mock = stubFetch((_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { capabilityId?: string };
      if (body.capabilityId === "accounting.cashFlow") return Response.json({ error: "cash flow unavailable" }, { status: 503 });
      const data = body.capabilityId === "accounting.incomeStatement" ? reports.pnl
        : body.capabilityId === "accounting.balanceSheet" ? reports.balanceSheet
          : body.capabilityId === "accounting.reportCurrencyMetadata" ? { baseCurrency: "USD", unsupportedCurrencies: [] }
            : body.capabilityId === "accounting.unrealizedFxExposure" ? { exposures: [] }
              : validCashFlow;
      return Response.json({ ok: true, data });
    });
    await expect(fetchAccountingReports(ORG_ID)).rejects.toMatchObject({ name: "AccountingApiError", status: 503 });
    expect(mock).toHaveBeenCalledTimes(5);
  });
});

describe("accounting API: auxiliary reads never blank the books", () => {
  it("returns null cash basis when the capability answers with an error", async () => {
    stubFetch(() => Response.json({ error: "nope" }, { status: 400 }));
    await expect(fetchAccountingCashBasis(2026, ORG_ID)).resolves.toBeNull();
  });

  it("loads cash basis from Go and never calls the legacy accounting route", async () => {
    const mock = stubFetch(() =>
      Response.json({ ok: true, data: { cashInMinor: 5_000, cashOutMinor: 1_000, netCashMinor: 4_000, accrualRevenueMinor: 9_000, accrualExpenseMinor: 2_000, uncollectedMinor: 1_000 } }),
    );
    await expect(fetchAccountingCashBasis(2026, ORG_ID)).resolves.toMatchObject({ netCashMinor: 4_000 });
    expect(mock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      cache: "no-store",
      headers: expect.objectContaining({ "X-Organization-ID": ORG_ID }),
      body: expect.stringContaining('"capabilityId":"accounting.cashBasisReport"'),
    }));
  });

  it("uses Go cash basis even when the former selector is off and projects the strict contract", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_CASH_BASIS__", false);
    const mock = stubFetch(() => Response.json({ ok: true, data: {
      cashInMinor: 5_000,
      cashOutMinor: 1_000,
      netCashMinor: 4_000,
      accrualRevenueMinor: 9_000,
      accrualExpenseMinor: 2_000,
      uncollectedMinor: 1_000,
    } }));

    await expect(fetchAccountingCashBasis(2026, ORG_ID)).resolves.toEqual({
      cashInMinor: 5_000,
      cashOutMinor: 1_000,
      netCashMinor: 4_000,
      accrualRevenueMinor: 9_000,
      uncollectedMinor: 1_000,
    });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(mock.mock.calls[0]?.[1]?.headers).toMatchObject({ "X-Organization-ID": ORG_ID });
    expect(JSON.parse(String(mock.mock.calls[0]?.[1]?.body))).toMatchObject({
      capabilityId: "accounting.cashBasisReport",
      input: { year: 2026 },
      intentId: expect.any(String),
    });
  });

  it.each([
    { label: "unavailable", response: () => Response.json({ error: "not found" }, { status: 404 }) },
    { label: "capability rejection", response: () => Response.json({ ok: false, error: "Cash basis failed" }, { status: 422 }) },
    { label: "missing Go-only expense", response: () => Response.json({ ok: true, data: { cashInMinor: 1, cashOutMinor: 0, netCashMinor: 1, accrualRevenueMinor: 1, uncollectedMinor: 0 } }) },
    { label: "unsafe integer", response: () => Response.json({ ok: true, data: { cashInMinor: Number.MAX_SAFE_INTEGER + 1, cashOutMinor: 0, netCashMinor: 1, accrualRevenueMinor: 1, accrualExpenseMinor: 0, uncollectedMinor: 0 } }) },
    { label: "unknown field", response: () => Response.json({ ok: true, data: { cashInMinor: 1, cashOutMinor: 0, netCashMinor: 1, accrualRevenueMinor: 1, accrualExpenseMinor: 0, uncollectedMinor: 0, extra: true } }) },
  ])("keeps Go cash-basis $label nullable without legacy fallback", async ({ response }) => {
    vi.stubGlobal("__GO_ACCOUNTING_CASH_BASIS__", false);
    const mock = stubFetch(response);
    await expect(fetchAccountingCashBasis(2026, ORG_ID)).resolves.toBeNull();
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
  });

  it("preserves caller cancellation for a Go cash-basis read", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_CASH_BASIS__", false);
    const controller = new AbortController();
    controller.abort();
    const mock = stubFetch(() => { throw new DOMException("Aborted", "AbortError"); });
    await expect(fetchAccountingCashBasis(2026, ORG_ID, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
  });

  it("rejects an out-of-range reporting year before making a request", async () => {
    const mock = stubFetch(() => Response.json({}));
    await expect(fetchAccountingCashBasis(1999, ORG_ID)).rejects.toMatchObject({ status: 400 });
    expect(mock).not.toHaveBeenCalled();
  });

  it("loads budget scenarios from the Go capability and keeps the UI summary shape", async () => {
    const mock = stubFetch(() => Response.json({ ok: true, data: { scenarios: [{
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      key: "base",
      name: "Base plan",
      fiscalYear: 2026,
      version: 2,
      currency: "USD",
      isCurrent: true,
      assumptions: {
        collectionDelayDays: 14,
        spendUpliftBasisPoints: 0,
        expectedMonthlyInflowMinor: 100_000,
        expectedMonthlyOutflowMinor: 75_000,
        minimumCashBufferMinor: 10_000,
      },
      createdAt: "2026-09-28T10:00:00.000Z",
    }] } }));

    await expect(fetchAccountingBudgetScenarios()).resolves.toEqual([{
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Base plan",
      fiscalYear: 2026,
      version: 2,
      isCurrent: true,
    }]);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      body: expect.any(String),
    }));
    expect(JSON.parse(String(mock.mock.calls[0]?.[1]?.body))).toMatchObject({
      capabilityId: "accounting.listBudgetScenarios",
      input: {},
      intentId: expect.any(String),
    });
  });

  it.each([
    { label: "unavailable", response: () => Response.json({ error: "nope" }, { status: 500 }), status: 500 },
    { label: "malformed envelope", response: () => Response.json({ unexpected: true }), status: 200 },
    { label: "invalid scenario UUID", response: () => Response.json({ ok: true, data: { scenarios: [{
      id: "scenario-1",
      key: "base",
      name: "Base plan",
      fiscalYear: 2026,
      version: 2,
      currency: "USD",
      isCurrent: true,
      assumptions: {
        collectionDelayDays: 14,
        spendUpliftBasisPoints: 0,
        expectedMonthlyInflowMinor: 100_000,
        expectedMonthlyOutflowMinor: 75_000,
        minimumCashBufferMinor: 10_000,
      },
      createdAt: "2026-09-28T10:00:00.000Z",
    }] } }), status: 200 },
  ])("surfaces Go budget-scenario $label responses", async ({ response, status }) => {
    const mock = stubFetch(response);
    await expect(fetchAccountingBudgetScenarios()).rejects.toMatchObject({ name: "AccountingApiError", status });
    expect(mock.mock.calls).toHaveLength(1);
    expect(mock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
  });

  it("keeps only active output tax codes, since invoices cannot use the others", async () => {
    const fetchMock = stubFetch((url) => {
      expect(url).toBe("/api/capabilities/execute");
      return Response.json({
        ok: true,
        data: { codes: [
          { id: "vat", code: "VAT", name: "VAT", direction: "output", rateBasisPoints: 1800, priceIncludesTax: false, active: true },
          { id: "vat-retired", code: "VAT9", name: "Retired", direction: "output", rateBasisPoints: 900, priceIncludesTax: false, active: false },
          { id: "vat-input", code: "VATIN", name: "Input", direction: "input", rateBasisPoints: 1800, priceIncludesTax: false, active: true },
        ] },
      });
    });
    const codes = await fetchAccountingTaxCodes();
    expect(codes.map((code) => code.id)).toEqual(["vat"]);
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { capabilityId: string; input: unknown; intentId: string };
    expect(request).toMatchObject({ capabilityId: "accounting.listTaxCodes", input: {} });
    expect(request.intentId).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe("accounting API: capability reads", () => {
  const forecast = {
    startMinor: 10_000,
    finalMinor: 12_000,
    lowestCloseMinor: 8_000,
    lowestWeekIndex: 3,
    scenarioName: "Base plan",
    minimumCashBufferMinor: 5_000,
    weeks: [{ weekStart: "2026-10-05T00:00:00.000Z", inflowMinor: 3_000, outflowMinor: 1_000, closeMinor: 12_000 }],
  };

  it("loads every banking projection from accounting.listBankingWorkspace", async () => {
    const workspace = {
      accounts: [{ id: "go-account", name: "Operating", currencyCode: "USD", last4: "1234", balanceMinor: 2_000 }],
      unmatched: [{ id: "line-unmatched", bankAccountId: "go-account", currencyCode: "USD", postedAt: "2026-10-01T00:00:00.000Z", amountMinor: 100, description: "Incoming wire" }],
      matched: [{ id: "line-matched", bankAccountId: "go-account", currencyCode: "USD", postedAt: "2026-10-02T00:00:00.000Z", amountMinor: 200, description: "Matched receipt" }],
      excluded: [{ id: "line-excluded", bankAccountId: "go-account", currencyCode: "USD", postedAt: "2026-10-03T00:00:00.000Z", amountMinor: -50, description: "Bank fee" }],
      payments: [{ id: "payment-1", invoiceNumber: 4, currencyCode: "USD", customerName: "Buyer", amountMinor: 100, receivedAt: "2026-10-01T00:00:00.000Z" }],
      summary: {
        accounts: [{ bankAccountId: "go-account", name: "Operating", currencyCode: "USD", last4: "1234", balanceMinor: 2_000, count: 3, moneyInMinor: 300, moneyOutMinor: 50 }],
        unmatchedCount: 1,
      },
    };
    const mock = stubFetch(() => Response.json({ ok: true, data: workspace }));

    await expect(fetchAccountingBanking(ORG_ID)).resolves.toEqual(workspace);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(mock.mock.calls[0]?.[1]?.headers).toMatchObject({ "X-Organization-ID": ORG_ID });
    expect(JSON.parse(String(mock.mock.calls[0]?.[1]?.body))).toMatchObject({
      capabilityId: "accounting.listBankingWorkspace",
      input: {},
      intentId: expect.any(String),
    });
  });

  it("fails closed on an incomplete Go banking workspace without a legacy read", async () => {
    const mock = stubFetch(() => Response.json({ ok: true, data: {
      accounts: [], unmatched: [], payments: [], summary: { accounts: [], unmatchedCount: 0 },
    } }));

    await expect(fetchAccountingBanking(ORG_ID)).rejects.toMatchObject({ name: "AccountingApiError", status: 200 });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
  });

  it("passes the budget scenario only when one is chosen", async () => {
    const mock = stubFetch(() => Response.json({ ok: true, data: forecast }));
    await expect(fetchCashForecast("")).resolves.toEqual(forecast);
    expect(mock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
    }));
    expect(JSON.parse(String(mock.mock.calls[0]?.[1]?.body))).toMatchObject({
      capabilityId: "accounting.cashForecast",
      input: {},
      intentId: expect.any(String),
    });

    await fetchCashForecast("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(JSON.parse(String(mock.mock.calls[1]?.[1]?.body))).toMatchObject({
      capabilityId: "accounting.cashForecast",
      input: { budgetScenarioId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      intentId: expect.any(String),
    });
  });

  it("rejects invalid budget scenario IDs before calling Go", async () => {
    const mock = stubFetch(() => Response.json({ ok: true, data: forecast }));
    await expect(fetchCashForecast("scenario-1")).rejects.toMatchObject({
      name: "AccountingApiError",
      status: 400,
      message: "Choose a valid budget scenario.",
    });
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([
    { label: "pending", response: () => Response.json({ pendingApproval: true, reason: "Review required." }, { status: 202 }), status: 202 },
    { label: "unavailable", response: () => Response.json({ error: "not found" }, { status: 404 }), status: 404 },
    { label: "malformed", response: () => Response.json({ ok: true, data: { finalMinor: "12000" } }), status: 200 },
    { label: "capability error", response: () => Response.json({ ok: false, error: "Forecast failed" }, { status: 422 }), status: 422 },
  ])("fails closed on Go cash forecast $label responses", async ({ response, status }) => {
    const mock = stubFetch(response);
    await expect(fetchCashForecast("")).rejects.toMatchObject({ name: "AccountingApiError", status });
    expect(mock.mock.calls).toHaveLength(1);
    expect(mock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
  });

  it("unwraps reminder drafts from the envelope", async () => {
    stubFetch(() =>
      Response.json({
        ok: true,
        data: {
          reminders: [{ customerId: "customer-1", customerName: "Kampala Coffee", currency: "USD", overdueCount: 2, oldestDaysOverdue: 40, totalOverdueMinor: 9_000, message: "Hello" }],
        },
      }),
    );
    const reminders = await fetchPaymentReminders();
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.oldestDaysOverdue).toBe(40);
  });

  it("uses the Go reminder capability without a legacy selector and validates the strict result", async () => {
    const reminder = { customerId: "customer-1", customerName: "Kampala Coffee", currency: "USD", overdueCount: 2, oldestDaysOverdue: 40, totalOverdueMinor: 9_000, message: "Hello" };
    const mock = stubFetch(() => Response.json({ ok: true, data: { reminders: [reminder] } }));

    await expect(fetchPaymentReminders()).resolves.toEqual([reminder]);
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0]!;
    expect(url).toBe("/api/capabilities/execute");
    expect(init).toMatchObject({ method: "POST", cache: "no-store", credentials: "same-origin" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      capabilityId: "accounting.buildReminders",
      input: {},
      intentId: expect.any(String),
    });
  });

  it.each([
    { label: "pending", response: () => Response.json({ pendingApproval: true, reason: "Review required." }, { status: 202 }), status: 202 },
    { label: "unavailable", response: () => Response.json({ error: "not found" }, { status: 404 }), status: 404 },
    { label: "malformed", response: () => Response.json({ ok: true, data: { reminders: [{ customerId: "customer-1", extra: true }] } }), status: 200 },
    { label: "capability error", response: () => Response.json({ ok: false, error: "Reminder report failed" }, { status: 422 }), status: 422 },
  ])("fails closed on Go reminder $label responses", async ({ response, status }) => {
    const mock = stubFetch(response);
    await expect(fetchPaymentReminders()).rejects.toMatchObject({ name: "AccountingApiError", status });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
  });

  it("refuses to build a statement without a customer", async () => {
    const mock = stubFetch(() => Response.json({}));
    await expect(fetchCustomerStatement("")).rejects.toMatchObject({ status: 400 });
    expect(mock).not.toHaveBeenCalled();
  });

  it("loads customer statements from the Go capability without a legacy selector", async () => {
    const currencies = [{
      currency: "USD",
      openingBalanceMinor: 0,
      closingBalanceMinor: 2_500,
      rows: [{ date: "2026-09-20T10:30:00.000Z", kind: "invoice", ref: "1042", amountMinor: 2_500, balanceMinor: 2_500 }],
    }];
    const mock = stubFetch(() => Response.json({ ok: true, data: { currencies } }));

    await expect(fetchCustomerStatement("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).resolves.toEqual({ currencies });
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0]!;
    expect(url).toBe("/api/capabilities/execute");
    expect(init).toMatchObject({ method: "POST", cache: "no-store", credentials: "same-origin" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      capabilityId: "accounting.customerStatement",
      input: { customerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      intentId: expect.any(String),
    });
  });

  it("validates customer UUIDs before Go reads", async () => {
    const mock = stubFetch(() => Response.json({ ok: true, data: { currencies: [] } }));
    await expect(fetchCustomerStatement("customer-1")).rejects.toMatchObject({ status: 400 });
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([
    { label: "pending", response: () => Response.json({ pendingApproval: true, reason: "Review required." }, { status: 202 }), status: 202 },
    { label: "unavailable", response: () => Response.json({ error: "not found" }, { status: 404 }), status: 404 },
    { label: "malformed", response: () => Response.json({ ok: true, data: { currencies: [{ currency: "USD", rows: [] }] } }), status: 200 },
    { label: "invalid row timestamp", response: () => Response.json({ ok: true, data: { currencies: [{ currency: "USD", openingBalanceMinor: 0, closingBalanceMinor: 0, rows: [{ date: "not-a-date", kind: "invoice", ref: "1042", amountMinor: 0, balanceMinor: 0 }] }] } }), status: 200 },
    { label: "capability error", response: () => Response.json({ ok: false, error: "Customer statement failed" }, { status: 422 }), status: 422 },
  ])("fails closed on Go statement $label responses", async ({ response, status }) => {
    const mock = stubFetch(response);
    await expect(fetchCustomerStatement("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).rejects.toMatchObject({
      name: "AccountingApiError",
      status,
    });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
  });

  it("fails loudly when a capability result breaks shape", async () => {
    stubFetch(() => Response.json({ ok: true, data: { reminders: "nope" } }));
    await expect(fetchPaymentReminders()).rejects.toMatchObject({
      message: "The Go Accounting service returned an unexpected result.",
    });
  });
});

describe("accounting API: governed writes", () => {
  it("does not fall back to Next-owned accounting endpoints for unsupported actions", async () => {
    const mock = stubFetch(() => Response.json({ ok: true, data: {} }));
    await expect(submitAccountingAction("/api/accounting", { action: "legacy-only-action" }))
      .rejects.toMatchObject({ status: 400 });
    expect(mock).not.toHaveBeenCalled();
  });

  it("fails closed on invoice writes without an organization", async () => {
    const mock = stubFetch(() => Response.json({ ok: true, data: {} }));
    await expect(submitAccountingAction("/api/accounting", {
      action: "recordPayment", invoiceNumber: 1042, amountMinor: 5_000, method: "bank_transfer",
    })).rejects.toMatchObject({ status: 0 });
    await expect(submitAccountingAction("/api/accounting", {
      action: "createInvoice",
      customerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      lines: [{ description: "Advisory", quantity: 1_000, unitPriceMinor: 100, taxMinor: 0 }],
      currency: "USD",
      dueAt: "2026-11-01T12:00:00.000Z",
    })).rejects.toMatchObject({ status: 0 });
    expect(mock).not.toHaveBeenCalled();
  });

  it("reports a 202 as pending rather than completed", async () => {
    stubPaymentLocks();
    stubFetch(() => Response.json({ pendingApproval: true, reason: "Payment above threshold" }, { status: 202 }));
    await expect(
      submitAccountingAction("/api/accounting", { action: "payBill", billNumber: 77, amountMinor: 4_000 }, undefined, paymentRetryScope),
    ).resolves.toEqual({ kind: "pending", reason: "Payment above threshold" });
  });

  it("always routes bill payments through the Go Purchasing capability", async () => {
    vi.stubGlobal("__GO_PURCHASING_FINANCE_WRITES__", false);
    stubPaymentLocks();
    const mock = stubFetch(() => Response.json({ ok: true, data: {
      paymentId: "33333333-3333-4333-8333-333333333333",
      entryId: "44444444-4444-4444-8444-444444444444",
      fullyPaid: true,
    } }));
    await submitAccountingAction("/api/accounting", {
      action: "payBill",
      billNumber: 77,
      amountMinor: 4_000,
      intentId: "ignored-ui-attempt",
    }, undefined, paymentRetryScope);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({ method: "POST" }));
    const posted = JSON.parse(String(mock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(posted).toMatchObject({
      capabilityId: "purchasing.payBill",
      input: { billNumber: 77, amountMinor: 4_000 },
      intentId: expect.any(String),
    });
    expect(posted.intentId).not.toBe("ignored-ui-attempt");
    expect(mock.mock.calls[0]?.[0]).not.toBe("/api/accounting");
  });

  it("reports a completed write only when a 200 envelope comes back", async () => {
    stubPaymentLocks();
    const mock = stubFetch(() => Response.json({ ok: true, data: { status: "excluded" } }));
    await expect(submitAccountingAction("/api/banking", { action: "excludeBankTransaction", transactionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, undefined, paymentRetryScope)).resolves.toEqual({
      kind: "completed",
    });
    expect(mock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({ method: "POST" }));
  });

  it("rejects a 202 that is missing its Go year-end pending marker", async () => {
    stubPaymentLocks();
    stubFetch(() => Response.json({ ok: true, data: {} }, { status: 202 }));
    await expect(submitAccountingAction("/api/accounting", { action: "closeYear", year: 2025 }, undefined, paymentRetryScope)).rejects.toMatchObject({
      status: 202,
      message: "The Go Accounting service returned an invalid year-end approval response.",
    });
  });

  it("routes year-end close through Go and validates its result", async () => {
    stubPaymentLocks();
    const output = {
      closingEntryId: "11111111-1111-4111-8111-111111111111",
      replacedEntryId: null,
      netIncomeMinor: -1_250,
      retainedEarningsMinor: 1_250,
    };
    const mock = stubFetch(() => Response.json({ ok: true, data: output }));
    await expect(submitAccountingAction("/api/accounting", { action: "closeYear", year: 2025 }, undefined, paymentRetryScope)).resolves.toEqual({ kind: "completed" });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      cache: "no-store",
      body: expect.stringContaining('"capabilityId":"accounting.closeYear"'),
    }));
    expect(JSON.parse(String(mock.mock.calls[0]?.[1]?.body))).toMatchObject({
      capabilityId: "accounting.closeYear",
      input: { year: 2025 },
      intentId: expect.any(String),
    });
    await expect(readPendingAccountingCloseYear(paymentRetryScope)).resolves.toBeNull();
  });

  it("retains a pending year-end close and only retries the exact scoped year", async () => {
    stubPaymentLocks();
    const mock = stubFetch(() => Response.json({ pendingApproval: true, reason: "Controller review." }, { status: 202 }));
    const action = { action: "closeYear", year: 2025 };
    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).resolves.toEqual({ kind: "pending", reason: "Controller review." });
    await expect(readPendingAccountingCloseYear(paymentRetryScope)).resolves.toBe(2025);
    await expect(submitAccountingAction("/api/accounting", { ...action, year: 2024 }, undefined, paymentRetryScope)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: true });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("fails closed on invalid year-end-close inputs and malformed Go output", async () => {
    stubPaymentLocks();
    const mock = stubFetch(() => Response.json({ ok: true, data: { closingEntryId: "not-a-uuid" } }));
    await expect(submitAccountingAction("/api/accounting", { action: "closeYear", year: 1999 }, undefined, paymentRetryScope)).rejects.toMatchObject({ status: 400 });
    expect(mock).not.toHaveBeenCalled();
    await expect(submitAccountingAction("/api/accounting", { action: "closeYear", year: 2025 }, undefined, paymentRetryScope)).rejects.toMatchObject({ status: 200, requestMayHaveReachedServer: true });
    await expect(readPendingAccountingCloseYear(paymentRetryScope)).resolves.toBe(2025);
    expect(mock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
  });

  it("turns a rejected write into a readable failure", async () => {
    stubPaymentLocks();
    vi.stubGlobal("__GO_ACCOUNTING_RECORD_PAYMENT__", false);
    stubFetch(() => Response.json({ message: "Period is sealed" }, { status: 422 }));
    await expect(submitAccountingAction("/api/accounting", {
      action: "recordPayment",
      invoiceNumber: 1042,
      amountMinor: 5_000,
      method: "bank_transfer",
    }, undefined, paymentRetryScope)).rejects.toMatchObject({
      status: 422,
      message: "Period is sealed",
    });
  });
});

describe("accounting API: Go Accounting period and FX writes", () => {
  beforeEach(stubPaymentLocks);

  it("routes reopening through the organization-scoped Go capability and clears success", async () => {
    const mock = stubFetch(() => Response.json({ ok: true, data: { reopened: true } }));
    await expect(submitAccountingAction("/api/accounting", { action: "reopenPeriod", year: 2026, month: 1 }, undefined, paymentRetryScope))
      .resolves.toEqual({ kind: "completed" });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      cache: "no-store",
      headers: expect.objectContaining({ "X-Organization-ID": paymentRetryScope.organizationId }),
    }));
    expect(JSON.parse(String(mock.mock.calls[0]?.[1]?.body))).toMatchObject({
      capabilityId: "accounting.reopenPeriod",
      input: { year: 2026, month: 1 },
      intentId: expect.any(String),
    });
    await expect(readPendingAccountingPeriodFxWrite(paymentRetryScope)).resolves.toBeNull();
  });

  it("routes FX-rate recording through Go and reuses only the exact scoped retry", async () => {
    const output = { rateId: "11111111-1111-4111-8111-111111111111", num: 10875, den: 10000 };
    const mock = stubFetch(() => Response.json({ ok: true, data: output }));
    const action = { action: "recordFxRate", quoteCurrency: "eur", rate: "1.0875", effectiveAt: "2026-10-14T12:00:00.000Z" };
    await submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope);
    const first = JSON.parse(String(mock.mock.calls[0]?.[1]?.body));
    expect(first).toMatchObject({
      capabilityId: "accounting.recordFxRate",
      input: { quoteCurrency: "EUR", rate: "1.0875", effectiveAt: action.effectiveAt },
    });
    expect(mock.mock.calls[0]?.[1]?.headers).toMatchObject({ "X-Organization-ID": paymentRetryScope.organizationId });
    expect(mock).toHaveBeenCalledTimes(1);
    await expect(readPendingAccountingPeriodFxWrite(paymentRetryScope)).resolves.toBeNull();
  });

  it("keeps exact period or FX details unresolved through pending and transport failures", async () => {
    const action = { action: "recordFxRate", quoteCurrency: "EUR", rate: "1.0875" };
    const pending = stubFetch(() => Response.json({ pendingApproval: true, reason: "Controller review." }, { status: 202 }));
    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).resolves.toEqual({ kind: "pending", reason: "Controller review." });
    const saved = await readPendingAccountingPeriodFxWrite(paymentRetryScope);
    expect(saved).toMatchObject(action);
    await expect(submitAccountingAction("/api/accounting", { ...action, rate: "1.09" }, undefined, paymentRetryScope)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: true });
    expect(pending).toHaveBeenCalledTimes(1);
    const pendingIntentId = JSON.parse(String(pending.mock.calls[0]?.[1]?.body)).intentId;
    const retry = stubFetch(() => { throw new TypeError("offline"); });
    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: true });
    expect(JSON.parse(String(retry.mock.calls[0]?.[1]?.body)).intentId).toBe(pendingIntentId);
    expect(await readPendingAccountingPeriodFxWrite(paymentRetryScope)).toMatchObject(action);
  });

  it("preserves an unresolved reopen and rejects a different period before another request", async () => {
    const mock = stubFetch(() => Response.json({ pendingApproval: true }, { status: 202 }));
    const action = { action: "reopenPeriod", year: 2026, month: 1 };
    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope))
      .resolves.toEqual({ kind: "pending", reason: "This Accounting action is waiting for approval." });
    await expect(readPendingAccountingPeriodFxWrite(paymentRetryScope)).resolves.toMatchObject(action);
    await expect(submitAccountingAction("/api/accounting", { ...action, month: 2 }, undefined, paymentRetryScope))
      .rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: true });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when organization scope or action data is invalid", async () => {
    const mock = stubFetch(() => Response.json({ ok: true, data: { reopened: true } }));
    await expect(submitAccountingAction("/api/accounting", { action: "reopenPeriod", year: 2026, month: 13 }, undefined, paymentRetryScope)).rejects.toMatchObject({ status: 400 });
    await expect(submitAccountingAction("/api/accounting", { action: "recordFxRate", quoteCurrency: "EURO", rate: "1.2" }, undefined, paymentRetryScope)).rejects.toMatchObject({ status: 400 });
    await expect(submitAccountingAction("/api/accounting", { action: "reopenPeriod", year: 2026, month: 1 })).rejects.toMatchObject({ status: 0 });
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("accounting API: Go invoice payments", () => {
  const action = { action: "recordPayment", invoiceNumber: 1042, amountMinor: 5_000, method: "bank_transfer" };
  const paymentOutput = {
    paymentId: "33333333-3333-4333-8333-333333333333",
    entryId: "44444444-4444-4444-8444-444444444444",
    fullyPaid: false,
  };

  beforeEach(stubPaymentLocks);

  it("serializes cross-tab payment reservations for one actor and organization", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_RECORD_PAYMENT__", true);
    const mock = stubFetch(() => Response.json({ pendingApproval: true }, { status: 202 }));
    const alternatePayment = { ...action, method: "cash" };

    const outcomes = await Promise.allSettled([
      submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope),
      submitAccountingAction("/api/accounting", alternatePayment, undefined, paymentRetryScope),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(mock).toHaveBeenCalledTimes(1);
    await expect(readPendingAccountingRecordPayment(paymentRetryScope)).resolves.toEqual(action);
  });

  it("fails closed when browser-wide payment locks are unavailable", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_RECORD_PAYMENT__", true);
    vi.stubGlobal("navigator", {} as Navigator);
    const mock = stubFetch(() => Response.json({ ok: true, data: paymentOutput }));

    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining("cannot safely reserve an invoice payment"),
    });
    expect(mock).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
  });

  it("routes payment reversals through the Go capability executor and validates its result", async () => {
    stubPaymentLocks();
    const action = { action: "reversePayment", paymentId: paymentOutput.paymentId, reason: "Correct payment" };
    const result = {
      reversalEntryIds: ["55555555-5555-4555-8555-555555555555"],
      refundedMinor: 5_000,
      invoiceNumber: 1042,
      outstandingMinor: 5_000,
    };
    const mock = stubFetch(() => Response.json({ ok: true, data: result }));

    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).resolves.toEqual({ kind: "completed" });
    const body = JSON.parse(String(mock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(mock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({ method: "POST", credentials: "same-origin" }));
    expect(body).toMatchObject({
      capabilityId: "accounting.reversePayment",
      input: { paymentId: action.paymentId, reason: action.reason },
      intentId: expect.any(String),
    });
    expect(body).not.toHaveProperty("actorId");
    expect(body).not.toHaveProperty("organizationId");
    await expect(readPendingAccountingReversePayment(paymentRetryScope)).resolves.toBeNull();
  });

  it("keeps the payment reversal's intent stable until a validated result arrives", async () => {
    stubPaymentLocks();
    const action = { action: "reversePayment", paymentId: paymentOutput.paymentId, reason: "Correct payment" };
    const mock = stubFetch((_url, _init) => mock.mock.calls.length === 1
      ? Response.json({ pendingApproval: true, reason: "Approval required" }, { status: 202 })
      : Response.json({ ok: true, data: {
        reversalEntryIds: ["55555555-5555-4555-8555-555555555555"],
        refundedMinor: 5_000,
        invoiceNumber: 1042,
        outstandingMinor: 5_000,
      } }));

    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).resolves.toMatchObject({ kind: "pending" });
    await expect(readPendingAccountingReversePayment(paymentRetryScope)).resolves.toEqual(action);
    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).resolves.toEqual({ kind: "completed" });
    const first = JSON.parse(String(mock.mock.calls[0]?.[1]?.body)) as { intentId: string };
    const retry = JSON.parse(String(mock.mock.calls[1]?.[1]?.body)) as { intentId: string };
    expect(retry.intentId).toBe(first.intentId);
    await expect(readPendingAccountingReversePayment(paymentRetryScope)).resolves.toBeNull();
  });

  it("does not let a delayed duplicate response clear a newer reversal marker", async () => {
    stubPaymentLocks();
    const action = { action: "reversePayment", paymentId: paymentOutput.paymentId, reason: "Correct payment" };
    const newerAction = { ...action, paymentId: "77777777-7777-4777-8777-777777777777" };
    const deferred: Array<(response: Response) => void> = [];
    const mock = stubFetch(() => new Promise((resolve) => deferred.push(resolve)));
    const success = () => Response.json({ ok: true, data: {
      reversalEntryIds: ["55555555-5555-4555-8555-555555555555"],
      refundedMinor: 5_000,
      invoiceNumber: 1042,
      outstandingMinor: 5_000,
    } });

    const original = submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope);
    await vi.waitFor(() => expect(deferred).toHaveLength(1));
    const duplicate = submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope);
    await vi.waitFor(() => expect(deferred).toHaveLength(2));
    const originalIntent = JSON.parse(String(mock.mock.calls[0]?.[1]?.body)) as { intentId: string };
    const duplicateIntent = JSON.parse(String(mock.mock.calls[1]?.[1]?.body)) as { intentId: string };
    expect(duplicateIntent.intentId).toBe(originalIntent.intentId);

    deferred[1]!(success());
    await duplicate;
    const newer = submitAccountingAction("/api/accounting", newerAction, undefined, paymentRetryScope);
    await vi.waitFor(() => expect(deferred).toHaveLength(3));
    const newerIntent = JSON.parse(String(mock.mock.calls[2]?.[1]?.body)) as { intentId: string };
    expect(newerIntent.intentId).not.toBe(originalIntent.intentId);

    deferred[0]!(success());
    await original;
    await expect(readPendingAccountingReversePayment(paymentRetryScope)).resolves.toEqual(newerAction);

    deferred[2]!(success());
    await newer;
    await expect(readPendingAccountingReversePayment(paymentRetryScope)).resolves.toBeNull();
  });

  it("rejects malformed payment reversal input before sending a request", async () => {
    const mock = stubFetch(() => Response.json({ ok: true, data: {} }));
    await expect(submitAccountingAction("/api/accounting", {
      action: "reversePayment",
      paymentId: "not-a-uuid",
      reason: "ok",
    }, undefined, paymentRetryScope)).rejects.toMatchObject({ status: 400 });
    expect(mock).not.toHaveBeenCalled();
  });

  it("sends only the Go capability input and clears the marker after validated success", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_RECORD_PAYMENT__", false);
    const mock = stubFetch(() => Response.json({ ok: true, data: paymentOutput }));

    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).resolves.toEqual({ kind: "completed" });
    const body = JSON.parse(String(mock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(mock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({ method: "POST", credentials: "same-origin" }));
    expect(mock.mock.calls[0]?.[1]?.headers).toMatchObject({ "X-Organization-ID": paymentRetryScope.organizationId });
    expect(body).toMatchObject({ capabilityId: "accounting.recordPayment", input: { invoiceNumber: 1042, amountMinor: 5000, method: "bank_transfer" }, intentId: expect.any(String) });
    expect(body).not.toHaveProperty("actorId");
    expect(body).not.toHaveProperty("organizationId");

    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).resolves.toEqual({ kind: "completed" });
    const nextBody = JSON.parse(String(mock.mock.calls[1]?.[1]?.body)) as { intentId: string };
    expect(nextBody.intentId).not.toBe(body.intentId);
  });

  it("retains the exact actor/org attempt through approval and Go 404 without selector fallback", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_RECORD_PAYMENT__", true);
    const mock = stubFetch((_url, _init) => {
      const calls = mock.mock.calls.length;
      return calls === 1
        ? Response.json({ pendingApproval: true, reason: "Payment needs approval" }, { status: 202 })
        : Response.json({ error: "capability not found" }, { status: 404 });
    });

    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).resolves.toMatchObject({ kind: "pending", reason: "Payment needs approval" });
    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    const stored = await readPendingAccountingRecordPayment(paymentRetryScope);
    expect(stored).toEqual(action);
    const calls = mock.mock.calls;
    expect(JSON.parse(String(calls[0]?.[1]?.body)).intentId).toBe(JSON.parse(String(calls[1]?.[1]?.body)).intentId);
    vi.stubGlobal("__GO_ACCOUNTING_RECORD_PAYMENT__", false);
    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    expect(mock).toHaveBeenCalledTimes(3);
    expect(mock.mock.calls.every(([url]) => url === "/api/capabilities/execute")).toBe(true);
  });

  it("keeps a malformed success unresolved and retries with the same intent", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_RECORD_PAYMENT__", true);
    const intents: string[] = [];
    const mock = stubFetch((_url, init) => {
      intents.push(String(JSON.parse(String(init?.body)).intentId));
      return intents.length === 1
        ? Response.json({ ok: true, data: { paymentId: "not-a-uuid" } })
        : Response.json({ ok: true, data: paymentOutput });
    });

    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).rejects.toMatchObject({ status: 200, requestMayHaveReachedServer: true });
    await expect(readPendingAccountingRecordPayment(paymentRetryScope)).resolves.toEqual(action);
    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).resolves.toEqual({ kind: "completed" });
    expect(intents).toHaveLength(2);
    expect(intents[1]).toBe(intents[0]);
    expect(mock.mock.calls.every(([url]) => url === "/api/capabilities/execute")).toBe(true);
  });
});

describe("accounting API: Go invoice creation", () => {
  const action = {
    action: "createInvoice",
    customerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    memo: "Consulting work",
    lines: [{ description: "Advisory", quantity: 1000, unitPriceMinor: 2500, taxMinor: 0 }],
    currency: "USD",
    dueAt: "2026-11-01T12:00:00.000Z",
  };
  const output = {
    invoiceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    invoiceNumber: 2048,
    totalMinor: 2500,
    entryId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    currency: "USD",
  };

  beforeEach(stubPaymentLocks);

  it("serializes cross-tab invoice reservations for one actor and organization", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_CREATE_INVOICE__", true);
    const mock = stubFetch(() => Response.json({ pendingApproval: true }, { status: 202 }));
    const alternateInvoice = { ...action, memo: "Different invoice" };

    const outcomes = await Promise.allSettled([
      submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope),
      submitAccountingAction("/api/accounting", alternateInvoice, undefined, paymentRetryScope),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(mock).toHaveBeenCalledTimes(1);
    const stored = await readPendingAccountingCreateInvoice(paymentRetryScope);
    expect([action, alternateInvoice]).toContainEqual(stored);
  });

  it("fails closed when browser-wide invoice locks are unavailable", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_CREATE_INVOICE__", true);
    vi.stubGlobal("navigator", {} as Navigator);
    const mock = stubFetch(() => Response.json({ ok: true, data: output }));

    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining("cannot safely reserve an invoice creation"),
    });
    expect(mock).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
  });

  it("routes payment reversal through Go even when invoice creation is selected", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_CREATE_INVOICE__", true);
    const mock = stubFetch(() => Response.json({ ok: true, data: {
      reversalEntryIds: ["55555555-5555-4555-8555-555555555555"], refundedMinor: 5_000, invoiceNumber: 1042, outstandingMinor: 5_000,
    } }));
    await expect(submitAccountingAction("/api/accounting", { action: "reversePayment", paymentId: "33333333-3333-4333-8333-333333333333", reason: "Correction" }, undefined, paymentRetryScope)).resolves.toEqual({ kind: "completed" });
    expect(mock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({ method: "POST" }));
  });

  it("routes only createInvoice to Go, preserving the parser's input/output contract", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_CREATE_INVOICE__", false);
    const mock = stubFetch(() => Response.json({ ok: true, data: output }));
    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).resolves.toEqual({ kind: "completed" });
    const body = JSON.parse(String(mock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(mock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({ method: "POST", credentials: "same-origin" }));
    expect(mock.mock.calls[0]?.[1]?.headers).toMatchObject({ "X-Organization-ID": paymentRetryScope.organizationId });
    expect(body).toMatchObject({ capabilityId: "accounting.createInvoice", input: { customerId: action.customerId, memo: action.memo, lines: action.lines, currency: "USD", dueAt: action.dueAt }, intentId: expect.any(String) });
    expect((body.input as Record<string, unknown>).action).toBeUndefined();
    expect(body).not.toHaveProperty("actorId");
    expect(body).not.toHaveProperty("organizationId");
    await expect(readPendingAccountingCreateInvoice(paymentRetryScope)).resolves.toBeNull();
  });

  it("accepts UTC Z dueAt values and rejects non-UTC offsets before sending", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_CREATE_INVOICE__", true);
    const mock = stubFetch(() => Response.json({ ok: true, data: output }));
    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).resolves.toEqual({ kind: "completed" });
    await expect(submitAccountingAction("/api/accounting", { ...action, dueAt: "2026-11-01T15:00:00+03:00" }, undefined, paymentRetryScope)).rejects.toMatchObject({ status: 400 });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("retains the exact intent across approval and Go 404 without selector fallback", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_CREATE_INVOICE__", true);
    const mock = stubFetch((_url, _init) => mock.mock.calls.length === 1
      ? Response.json({ pendingApproval: true, reason: "Invoice approval required" }, { status: 202 })
      : Response.json({ error: "capability not found" }, { status: 404 }));
    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).resolves.toMatchObject({ kind: "pending" });
    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    await expect(readPendingAccountingCreateInvoice(paymentRetryScope)).resolves.toEqual(action);
    const calls = mock.mock.calls;
    expect(JSON.parse(String(calls[0]?.[1]?.body)).intentId).toBe(JSON.parse(String(calls[1]?.[1]?.body)).intentId);
    vi.stubGlobal("__GO_ACCOUNTING_CREATE_INVOICE__", false);
    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    expect(mock).toHaveBeenCalledTimes(3);
    expect(mock.mock.calls.every(([url]) => url === "/api/capabilities/execute")).toBe(true);
  });

  it("keeps malformed success unresolved and refuses changed payloads", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_CREATE_INVOICE__", true);
    const mock = stubFetch(() => Response.json({ ok: true, data: { ...output, invoiceId: "forged" } }));
    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).rejects.toMatchObject({ status: 200, requestMayHaveReachedServer: true });
    await expect(readPendingAccountingCreateInvoice(paymentRetryScope)).resolves.toEqual(action);
    await expect(submitAccountingAction("/api/accounting", { ...action, memo: "changed" }, undefined, paymentRetryScope)).rejects.toMatchObject({ requestMayHaveReachedServer: true });
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe("accounting API: Go credit notes", () => {
  const action = {
    action: "creditNote",
    invoiceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    amountMinor: 2500,
    reason: "Goodwill credit",
  };
  const output = {
    entryId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    creditedMinor: 2500,
    invoiceBalanceMinor: 8000,
  };

  beforeEach(stubPaymentLocks);

  it("serializes cross-tab credit reservations for one actor and organization", async () => {
    const mock = stubFetch(() => Response.json({ pendingApproval: true }, { status: 202 }));
    const alternateCredit = { ...action, reason: "Correction credit" };

    const outcomes = await Promise.allSettled([
      submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope),
      submitAccountingAction("/api/accounting", alternateCredit, undefined, paymentRetryScope),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(mock).toHaveBeenCalledTimes(1);
    const stored = await readPendingAccountingCreditNote(paymentRetryScope);
    expect([action, alternateCredit]).toContainEqual(stored);
  });

  it("fails closed when browser-wide credit locks are unavailable", async () => {
    vi.stubGlobal("navigator", {} as Navigator);
    const mock = stubFetch(() => Response.json({ ok: true, data: output }));

    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining("cannot safely reserve a credit note"),
    });
    expect(mock).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
  });

  it("routes payment reversal through Go independently of credit-note routing", async () => {
    const mock = stubFetch(() => Response.json({ ok: true, data: {
      reversalEntryIds: ["55555555-5555-4555-8555-555555555555"], refundedMinor: 5_000, invoiceNumber: 1042, outstandingMinor: 5_000,
    } }));
    await expect(submitAccountingAction("/api/accounting", { action: "reversePayment", paymentId: "33333333-3333-4333-8333-333333333333", reason: "Correction" }, undefined, paymentRetryScope)).resolves.toEqual({ kind: "completed" });
    expect(mock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({ method: "POST" }));
  });

  it("matches the Go parser bounds and keeps invoice balance authority on the server", async () => {
    const mock = stubFetch(() => Response.json({ ok: true, data: output }));
    await expect(submitAccountingAction("/api/accounting", { ...action, reason: "abc" }, undefined, paymentRetryScope)).resolves.toEqual({ kind: "completed" });
    expect(mock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({ method: "POST" }));
    const payload = JSON.parse(String(mock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({ capabilityId: "accounting.creditNote", input: { invoiceId: action.invoiceId, amountMinor: 2500, reason: "abc" }, intentId: expect.any(String) });
    expect((payload.input as Record<string, unknown>).action).toBeUndefined();
    expect(payload).not.toHaveProperty("actorId");
    expect(payload).not.toHaveProperty("organizationId");
    expect(mock.mock.calls[0]?.[1]?.headers).toMatchObject({ "X-Organization-ID": paymentRetryScope.organizationId });

    for (const invalid of [
      { ...action, invoiceId: "not-a-uuid" },
      { ...action, amountMinor: 0 },
      { ...action, amountMinor: Number.MAX_SAFE_INTEGER + 1 },
      { ...action, reason: "ab" },
      { ...action, reason: "r".repeat(501) },
    ]) {
      await expect(submitAccountingAction("/api/accounting", invalid, undefined, paymentRetryScope)).rejects.toMatchObject({ status: 400 });
    }
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("uses Go's live balance rejection and never falls back to the legacy writer", async () => {
    const mock = stubFetch(() => Response.json({ error: "credit 9000 exceeds the open balance 5000" }, { status: 422 }));
    await expect(submitAccountingAction("/api/accounting", { ...action, amountMinor: 9000 }, undefined, paymentRetryScope)).rejects.toMatchObject({ status: 422, message: "credit 9000 exceeds the open balance 5000" });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({ method: "POST" }));
  });

  it("retains the exact actor/org intent and retries Go after the former selector is off", async () => {
    const mock = stubFetch(() => {
      if (mock.mock.calls.length === 1) return Response.json({ pendingApproval: true, reason: "Credit approval required" }, { status: 202 });
      if (mock.mock.calls.length === 2) return Response.json({ error: "capability not found" }, { status: 404 });
      return Response.json({ ok: true, data: output });
    });
    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).resolves.toMatchObject({ kind: "pending" });
    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    await expect(readPendingAccountingCreditNote(paymentRetryScope)).resolves.toEqual(action);
    await expect(readPendingAccountingCreditNote({ actorId: "77777777-7777-4777-8777-777777777777", organizationId: paymentRetryScope.organizationId })).resolves.toBeNull();
    const calls = mock.mock.calls;
    expect(JSON.parse(String(calls[0]?.[1]?.body)).intentId).toBe(JSON.parse(String(calls[1]?.[1]?.body)).intentId);
    vi.stubGlobal("__GO_ACCOUNTING_CREDIT_NOTE__", false);
    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).resolves.toEqual({ kind: "completed" });
    expect(JSON.parse(String(mock.mock.calls[2]?.[1]?.body)).intentId).toBe(JSON.parse(String(calls[0]?.[1]?.body)).intentId);
    expect(mock).toHaveBeenCalledTimes(3);
    await expect(readPendingAccountingCreditNote(paymentRetryScope)).resolves.toBeNull();
  });

  it("does not let a delayed duplicate response clear a newer credit note marker", async () => {
    const newerAction = { ...action, amountMinor: 3000, reason: "Updated credit" };
    const deferred: Array<(response: Response) => void> = [];
    const mock = stubFetch(() => new Promise((resolve) => deferred.push(resolve)));

    const original = submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope);
    await vi.waitFor(() => expect(deferred).toHaveLength(1));
    const duplicate = submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope);
    await vi.waitFor(() => expect(deferred).toHaveLength(2));
    const originalIntent = JSON.parse(String(mock.mock.calls[0]?.[1]?.body)) as { intentId: string };
    const duplicateIntent = JSON.parse(String(mock.mock.calls[1]?.[1]?.body)) as { intentId: string };
    expect(duplicateIntent.intentId).toBe(originalIntent.intentId);

    deferred[0]!(Response.json({ error: "credit rejected" }, { status: 422 }));
    await expect(original).rejects.toMatchObject({ status: 422 });
    await expect(readPendingAccountingCreditNote(paymentRetryScope)).resolves.toBeNull();

    const newer = submitAccountingAction("/api/accounting", newerAction, undefined, paymentRetryScope);
    await vi.waitFor(() => expect(deferred).toHaveLength(3));
    const newerIntent = JSON.parse(String(mock.mock.calls[2]?.[1]?.body)) as { intentId: string };
    expect(newerIntent.intentId).not.toBe(originalIntent.intentId);
    deferred[2]!(Response.json({ pendingApproval: true, reason: "Review required" }, { status: 202 }));
    await expect(newer).resolves.toMatchObject({ kind: "pending" });

    deferred[1]!(Response.json({ ok: true, data: output }));
    await duplicate;
    await expect(readPendingAccountingCreditNote(paymentRetryScope)).resolves.toEqual(newerAction);
  });

  it("validates the Go response and keeps malformed success retryable", async () => {
    const mock = stubFetch(() => Response.json({ ok: true, data: { ...output, entryId: "invalid" } }));
    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).rejects.toMatchObject({ status: 200, requestMayHaveReachedServer: true });
    await expect(readPendingAccountingCreditNote(paymentRetryScope)).resolves.toEqual(action);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe("accounting API: Go journal reversals", () => {
  const action = { action: "reverse", entryId: "99999999-9999-4999-8999-999999999999" };
  const output = { reversalEntryId: "88888888-8888-4888-8888-888888888888" };

  beforeEach(stubPaymentLocks);

  it("serializes cross-tab reversal reservations for one actor and organization", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_REVERSE_ENTRY__", true);
    const mock = stubFetch(() => Response.json({ pendingApproval: true }, { status: 202 }));
    const alternateReversal = { ...action, entryId: "77777777-7777-4777-8777-777777777777" };

    const outcomes = await Promise.allSettled([
      submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope),
      submitAccountingAction("/api/accounting", alternateReversal, undefined, paymentRetryScope),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(mock).toHaveBeenCalledTimes(1);
    const stored = await readPendingAccountingReverseEntry(paymentRetryScope);
    expect([action, alternateReversal]).toContainEqual(stored);
  });

  it("does not let a delayed duplicate response clear a newer journal reversal marker", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_REVERSE_ENTRY__", true);
    const newerAction = { ...action, entryId: "77777777-7777-4777-8777-777777777777" };
    const deferred: Array<(response: Response) => void> = [];
    const mock = stubFetch(() => new Promise((resolve) => deferred.push(resolve)));

    const original = submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope);
    await vi.waitFor(() => expect(deferred).toHaveLength(1));
    const duplicate = submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope);
    await vi.waitFor(() => expect(deferred).toHaveLength(2));
    const originalIntent = JSON.parse(String(mock.mock.calls[0]?.[1]?.body)) as { intentId: string };
    const duplicateIntent = JSON.parse(String(mock.mock.calls[1]?.[1]?.body)) as { intentId: string };
    expect(duplicateIntent.intentId).toBe(originalIntent.intentId);

    deferred[0]!(Response.json({ error: "reversal rejected" }, { status: 422 }));
    await expect(original).rejects.toMatchObject({ status: 422 });
    await expect(readPendingAccountingReverseEntry(paymentRetryScope)).resolves.toBeNull();

    const newer = submitAccountingAction("/api/accounting", newerAction, undefined, paymentRetryScope);
    await vi.waitFor(() => expect(deferred).toHaveLength(3));
    const newerIntent = JSON.parse(String(mock.mock.calls[2]?.[1]?.body)) as { intentId: string };
    expect(newerIntent.intentId).not.toBe(originalIntent.intentId);
    deferred[2]!(Response.json({ pendingApproval: true, reason: "Review required" }, { status: 202 }));
    await expect(newer).resolves.toMatchObject({ kind: "pending" });

    deferred[1]!(Response.json({ ok: true, data: output }));
    await duplicate;
    await expect(readPendingAccountingReverseEntry(paymentRetryScope)).resolves.toEqual(newerAction);
  });

  it("fails closed when browser-wide reversal locks are unavailable", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_REVERSE_ENTRY__", true);
    vi.stubGlobal("navigator", {} as Navigator);
    const mock = stubFetch(() => Response.json({ ok: true, data: output }));

    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining("cannot safely reserve a journal reversal"),
    });
    expect(mock).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
  });

  it("routes only the manual reverse action to Go and validates the output", async () => {
    const mock = stubFetch(() => Response.json({ ok: true, data: output }));
    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).resolves.toEqual({ kind: "completed" });
    const payload = JSON.parse(String(mock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(mock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: expect.objectContaining({ "X-Organization-ID": paymentRetryScope.organizationId }),
    }));
    expect(payload).toMatchObject({ capabilityId: "accounting.reverseEntry", input: { entryId: action.entryId }, intentId: expect.any(String) });
    expect((payload.input as Record<string, unknown>).action).toBeUndefined();
    expect(payload).not.toHaveProperty("actorId");
    expect(payload).not.toHaveProperty("organizationId");
    await expect(readPendingAccountingReverseEntry(paymentRetryScope)).resolves.toBeNull();
  });

  it("routes payment reversal through Go when journal reversal is selected", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_REVERSE_ENTRY__", true);
    const mock = stubFetch(() => Response.json({ ok: true, data: {
      reversalEntryIds: ["55555555-5555-4555-8555-555555555555"], refundedMinor: 5_000, invoiceNumber: 1042, outstandingMinor: 5_000,
    } }));
    await expect(submitAccountingAction("/api/accounting", { action: "reversePayment", paymentId: "33333333-3333-4333-8333-333333333333", reason: "Correction" }, undefined, paymentRetryScope)).resolves.toEqual({ kind: "completed" });
    expect(mock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({ method: "POST" }));
  });

  it("retains the exact attempt through pending, 404, and rollback", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_REVERSE_ENTRY__", true);
    const mock = stubFetch(() => mock.mock.calls.length === 1
      ? Response.json({ pendingApproval: true, reason: "Reversal approval required" }, { status: 202 })
      : Response.json({ error: "capability not found" }, { status: 404 }));
    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).resolves.toMatchObject({ kind: "pending" });
    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    await expect(readPendingAccountingReverseEntry(paymentRetryScope)).resolves.toEqual(action);
    const calls = mock.mock.calls;
    expect(JSON.parse(String(calls[0]?.[1]?.body)).intentId).toBe(JSON.parse(String(calls[1]?.[1]?.body)).intentId);
    vi.stubGlobal("__GO_ACCOUNTING_REVERSE_ENTRY__", false);
    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    expect(mock).toHaveBeenCalledTimes(3);
    expect(mock.mock.calls[2]?.[0]).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(calls[0]?.[1]?.body)).intentId).toBe(JSON.parse(String(mock.mock.calls[2]?.[1]?.body)).intentId);
    await expect(readPendingAccountingReverseEntry(paymentRetryScope)).resolves.toEqual(action);
  });

  it("validates the entry and organization before any Go request", async () => {
    const mock = stubFetch(() => Response.json({ ok: true, data: output }));
    await expect(submitAccountingAction("/api/accounting", { action: "reverse", entryId: "not-a-uuid" }, undefined, paymentRetryScope))
      .rejects.toMatchObject({ status: 400 });
    await expect(submitAccountingAction("/api/accounting", action))
      .rejects.toMatchObject({ status: 0 });
    expect(mock).not.toHaveBeenCalled();
  });

  it("surfaces Go domain eligibility rejections without legacy fallback", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_REVERSE_ENTRY__", true);
    const mock = stubFetch(() => Response.json({ error: "a invoice entry is undone by its domain workflow: use accounting.creditNote against the invoice" }, { status: 422 }));
    await expect(submitAccountingAction("/api/accounting", action, undefined, paymentRetryScope)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("domain workflow") });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({ method: "POST" }));
  });
});

describe("accounting API: Go bank reconciliation writes", () => {
  const matchAction = {
    action: "matchBankTransaction",
    transactionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    paymentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  };
  const unmatchAction = {
    action: "unmatchBankTransaction",
    transactionId: matchAction.transactionId,
  };

  beforeEach(stubPaymentLocks);

  it("serializes cross-tab match and unmatch reservations for one actor and organization", async () => {
    vi.stubGlobal("__GO_BANK_RECONCILIATION_WRITES__", true);
    const mock = stubFetch(() => Response.json({ pendingApproval: true }, { status: 202 }));

    const outcomes = await Promise.allSettled([
      submitAccountingAction("/api/banking", matchAction, undefined, paymentRetryScope),
      submitAccountingAction("/api/banking", unmatchAction, undefined, paymentRetryScope),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(mock).toHaveBeenCalledTimes(1);
    const stored = await readPendingAccountingBankReconciliationWrite(paymentRetryScope);
    expect([matchAction, unmatchAction]).toContainEqual(stored);
  });

  it("fails closed when browser-wide reconciliation locks are unavailable", async () => {
    vi.stubGlobal("__GO_BANK_RECONCILIATION_WRITES__", true);
    vi.stubGlobal("navigator", {} as Navigator);
    const mock = stubFetch(() => Response.json({ ok: true, data: { status: "matched", allocatedMinor: 5000, lineUnexplainedMinor: 0 } }));

    await expect(submitAccountingAction("/api/banking", matchAction, undefined, paymentRetryScope)).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining("cannot safely reserve a bank action"),
    });
    expect(mock).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
  });

  it("routes every supported bank write through its Go capability with organization scope", async () => {
    const expected = new Map<string, unknown>([
      ["accounting.addBankAccount", { bankAccountId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }],
      ["accounting.importBankFeed", { inserted: 1, skipped: 0 }],
      ["accounting.matchBankTransaction", { status: "matched", allocatedMinor: 5000, lineUnexplainedMinor: 0 }],
      ["accounting.unmatchBankTransaction", { status: "unmatched", releasedMinor: 5000 }],
      ["accounting.excludeBankTransaction", { status: "excluded" }],
      ["accounting.unexcludeBankTransaction", { status: "unmatched" }],
      ["accounting.deleteBankTransaction", { deleted: true }],
    ]);
    const mock = stubFetch((_url, init) => {
      const capabilityId = JSON.parse(String(init?.body)).capabilityId;
      return Response.json({ ok: true, data: expected.get(capabilityId) });
    });
    const actions = [
      { action: "addBankAccount", name: "Operating", currencyCode: "USD", last4: "0042" },
      { action: "importBankFeed", bankAccountId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", rows: [{ postedAt: "2026-06-01", amountMinor: 2500, description: "Receipt" }] },
      matchAction,
      unmatchAction,
      { action: "excludeBankTransaction", transactionId: matchAction.transactionId },
      { action: "unexcludeBankTransaction", transactionId: matchAction.transactionId },
      { action: "deleteBankTransaction", transactionId: matchAction.transactionId },
    ];
    for (const action of actions) {
      await expect(submitAccountingAction("/api/banking", action, undefined, paymentRetryScope)).resolves.toEqual({ kind: "completed" });
    }
    const expectedIDs = [...expected.keys()];
    for (const [index, capabilityId] of expectedIDs.entries()) {
      const [url, init] = mock.mock.calls[index]!;
      expect(url).toBe("/api/capabilities/execute");
      expect(init?.headers).toMatchObject({ "X-Organization-ID": paymentRetryScope.organizationId });
      const posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(posted).toMatchObject({ capabilityId, intentId: expect.any(String) });
      expect(posted).not.toHaveProperty("actorId");
      expect(posted).not.toHaveProperty("organizationId");
      expect((posted.input as Record<string, unknown>).action).toBeUndefined();
    }
    await expect(readPendingAccountingBankReconciliationWrite(paymentRetryScope)).resolves.toBeNull();
  });

  it("validates Go parser constraints before sending", async () => {
    vi.stubGlobal("__GO_BANK_RECONCILIATION_WRITES__", true);
    const mock = stubFetch(() => Response.json({ ok: true, data: { status: "matched", allocatedMinor: 100, lineUnexplainedMinor: 0 } }));
    const valid = { ...matchAction, entryId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
    for (const invalid of [
      { action: "matchBankTransaction", transactionId: "bad", paymentId: matchAction.paymentId },
      { action: "matchBankTransaction", transactionId: matchAction.transactionId },
      { ...valid },
      { ...matchAction, amountMinor: 0 },
      { ...matchAction, feeMinor: -1 },
      { ...matchAction, amountMinor: 1, feeMinor: 1 },
      { ...matchAction, amountMinor: 1, fxGainLossMinor: 1 },
      { ...matchAction, note: "n".repeat(501) },
    ]) {
      await expect(submitAccountingAction("/api/banking", invalid, undefined, paymentRetryScope)).rejects.toMatchObject({ status: 400 });
    }
    expect(mock).not.toHaveBeenCalled();
  });

  it("retains one exact bank intent through 202/404 and blocks a different action", async () => {
    const mock = stubFetch(() => mock.mock.calls.length === 1
      ? Response.json({ pendingApproval: true, reason: "Match approval required" }, { status: 202 })
      : Response.json({ error: "capability not found" }, { status: 404 }));
    await expect(submitAccountingAction("/api/banking", matchAction, undefined, paymentRetryScope)).resolves.toMatchObject({ kind: "pending" });
    await expect(submitAccountingAction("/api/banking", matchAction, undefined, paymentRetryScope)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    await expect(readPendingAccountingBankReconciliationWrite(paymentRetryScope)).resolves.toEqual(matchAction);
    const calls = mock.mock.calls;
    expect(JSON.parse(String(calls[0]?.[1]?.body)).intentId).toBe(JSON.parse(String(calls[1]?.[1]?.body)).intentId);
    await expect(submitAccountingAction("/api/banking", unmatchAction, undefined, paymentRetryScope)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: true });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("does not let a delayed duplicate response clear a newer bank action marker", async () => {
    const action = { action: "excludeBankTransaction", transactionId: matchAction.transactionId };
    const newerAction = { action: "unexcludeBankTransaction", transactionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
    const deferred: Array<(response: Response) => void> = [];
    const mock = stubFetch(() => new Promise((resolve) => deferred.push(resolve)));
    const success = () => Response.json({ ok: true, data: { status: "excluded" } });

    const original = submitAccountingAction("/api/banking", action, undefined, paymentRetryScope);
    await vi.waitFor(() => expect(deferred).toHaveLength(1));
    const duplicate = submitAccountingAction("/api/banking", action, undefined, paymentRetryScope);
    await vi.waitFor(() => expect(deferred).toHaveLength(2));
    const originalIntent = JSON.parse(String(mock.mock.calls[0]?.[1]?.body)) as { intentId: string };
    const duplicateIntent = JSON.parse(String(mock.mock.calls[1]?.[1]?.body)) as { intentId: string };
    expect(duplicateIntent.intentId).toBe(originalIntent.intentId);

    deferred[1]!(success());
    await duplicate;
    const newer = submitAccountingAction("/api/banking", newerAction, undefined, paymentRetryScope);
    await vi.waitFor(() => expect(deferred).toHaveLength(3));
    const newerIntent = JSON.parse(String(mock.mock.calls[2]?.[1]?.body)) as { intentId: string };
    expect(newerIntent.intentId).not.toBe(originalIntent.intentId);

    deferred[2]!(Response.json({ pendingApproval: true, reason: "Review required" }, { status: 202 }));
    await expect(newer).resolves.toMatchObject({ kind: "pending" });
    deferred[0]!(success());
    await original;
    await expect(readPendingAccountingBankReconciliationWrite(paymentRetryScope)).resolves.toEqual(newerAction);
  });

  it("uses Go's authoritative allocation and matched-state rejection", async () => {
    vi.stubGlobal("__GO_BANK_RECONCILIATION_WRITES__", true);
    const mock = stubFetch(() => Response.json({ error: "transaction is excluded; unexclude it before matching" }, { status: 422 }));
    await expect(submitAccountingAction("/api/banking", matchAction, undefined, paymentRetryScope)).rejects.toMatchObject({ status: 422, message: "transaction is excluded; unexclude it before matching" });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({ method: "POST" }));
  });

  it("fails closed without a captured organization before reserving or sending", async () => {
    const mock = stubFetch(() => Response.json({ ok: true, data: { status: "excluded" } }));
    await expect(submitAccountingAction("/api/banking", { action: "excludeBankTransaction", transactionId: matchAction.transactionId }, undefined, { ...paymentRetryScope, organizationId: null })).rejects.toMatchObject({ status: 0 });
    expect(mock).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
  });
});

describe("accounting API: invoice email", () => {
  it("rejects an invalid invoice number or recipient before sending", async () => {
    const mock = stubFetch(() => Response.json({ sent: true }));
    await expect(emailInvoice(0, "a@b.co")).rejects.toMatchObject({ status: 400 });
    await expect(emailInvoice(4, "not-an-email")).rejects.toMatchObject({
      status: 400,
      message: "Enter a valid email address.",
    });
    expect(mock).not.toHaveBeenCalled();
  });

  it("trims the recipient and returns the share link path when one exists", async () => {
    const mock = stubFetch(() => Response.json({ sent: true, urlPath: "/share/1042" }));
    await expect(emailInvoice(1042, "  billing@example.com  ")).resolves.toEqual({ urlPath: "/share/1042" });
    expect(mock).toHaveBeenCalledWith("/api/email", expect.objectContaining({
      body: JSON.stringify({ action: "emailInvoice", invoiceNumber: 1042, to: "billing@example.com" }),
    }));
  });

  it("surfaces an email failure instead of claiming it sent", async () => {
    stubFetch(() => Response.json({ error: "smtp not configured" }, { status: 500 }));
    await expect(emailInvoice(1042, "billing@example.com")).rejects.toMatchObject({ status: 500 });
  });
});

describe("accounting API: transport failures", () => {
  it("explains a timeout instead of leaking a DOM exception", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    }));
    await expect(fetchAccountingOverview(ORG_ID)).rejects.toMatchObject({
      status: 0,
      message: "The Accounting service took too long to respond. Check the record before trying again.",
    });
  });

  it("explains an unreachable service", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    await expect(fetchAccountingOverview(ORG_ID)).rejects.toMatchObject({
      status: 0,
      message: "Could not reach the Accounting service. Check your connection and try again.",
    });
  });
});
