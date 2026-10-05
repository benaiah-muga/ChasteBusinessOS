import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccountingApiError,
  emailInvoice,
  fetchAccountingBudgetScenarios,
  fetchAccountingCashBasis,
  fetchAccountingEnabled,
  fetchAccountingOverview,
  fetchAccountingReports,
  fetchAccountingTaxCodes,
  fetchCashForecast,
  fetchCustomerStatement,
  fetchPaymentReminders,
  submitAccountingAction,
} from "./accounting";

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

afterEach(() => vi.unstubAllGlobals());

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
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
  it("accepts the string-encoded debit aggregate the real route sends", async () => {
    // The journal row spreads a SQL sum over a bigint column, and Postgres
    // serialises bigint aggregates as JSON strings. A numeric-only schema made
    // the live page report an unexpected format for a valid response.
    stubFetch(() => Response.json({
      ...overview,
      entries: [{ ...entry, debitMinor: "12500" }],
    }));
    const result = await fetchAccountingOverview();
    expect(result.entries[0]?.debitMinor).toBe(12_500);
  });

  it("still rejects a non-numeric aggregate", async () => {
    stubFetch(() => Response.json({ ...overview, entries: [{ ...entry, debitMinor: "not-a-number" }] }));
    await expect(fetchAccountingOverview()).rejects.toBeInstanceOf(AccountingApiError);
  });

  it("validates the legacy accounting overview strictly", async () => {
    const mock = stubFetch(() => Response.json(overview));
    await expect(fetchAccountingOverview()).resolves.toEqual(overview);
    expect(mock).toHaveBeenCalledWith("/api/accounting", expect.objectContaining({ method: "GET" }));
  });

  it("rejects a body that drifts from the ledger contract", async () => {
    stubFetch(() => Response.json({ ...overview, entries: [{ ...entry, amountMinor: 12.5 }] }));
    await expect(fetchAccountingOverview()).rejects.toMatchObject({
      name: "AccountingApiError",
      message: "The Accounting service returned data in an unexpected format.",
    });
  });

  it("rejects money that is not an integer in minor units", async () => {
    stubFetch(() => Response.json({ ...overview, baseCurrency: "USD", aging: { ...overview.aging, totalOutstanding: 1.5 } }));
    await expect(fetchAccountingOverview()).rejects.toBeInstanceOf(AccountingApiError);
  });

  it("maps a session ending to a sign-in message rather than wire truth", async () => {
    stubFetch(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    await expect(fetchAccountingOverview()).rejects.toMatchObject({
      status: 401,
      message: "Your session has ended. Sign in again to continue.",
    });
  });

  it("hides markup in a server error message", async () => {
    stubFetch(() => Response.json({ message: "<script>alert(1)</script>" }, { status: 500 }));
    await expect(fetchAccountingReports()).rejects.toMatchObject({
      status: 500,
      message: "The Accounting service is unavailable. Try again.",
    });
  });

  it("reads reports and passes through optional sections", async () => {
    stubFetch(() => Response.json(reports));
    await expect(fetchAccountingReports()).resolves.toMatchObject({ baseCurrency: "USD" });
  });
});

describe("accounting API: auxiliary reads never blank the books", () => {
  it("returns null cash basis when the capability answers with an error", async () => {
    stubFetch(() => Response.json({ error: "nope" }, { status: 400 }));
    await expect(fetchAccountingCashBasis(2026)).resolves.toBeNull();
  });

  it("unwraps cash basis from the capability envelope", async () => {
    const mock = stubFetch(() =>
      Response.json({ ok: true, data: { cashInMinor: 5_000, cashOutMinor: 1_000, netCashMinor: 4_000, accrualRevenueMinor: 9_000, uncollectedMinor: 1_000 } }),
    );
    await expect(fetchAccountingCashBasis(2026)).resolves.toMatchObject({ netCashMinor: 4_000 });
    expect(mock).toHaveBeenCalledWith("/api/accounting", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ action: "cashBasis", year: 2026 }),
    }));
  });

  it("rejects an out-of-range reporting year before making a request", async () => {
    const mock = stubFetch(() => Response.json({}));
    await expect(fetchAccountingCashBasis(1999)).rejects.toMatchObject({ status: 400 });
    expect(mock).not.toHaveBeenCalled();
  });

  it("returns no scenarios when budgets are unreadable", async () => {
    stubFetch(() => Response.json({ error: "nope" }, { status: 500 }));
    await expect(fetchAccountingBudgetScenarios()).resolves.toEqual([]);
  });

  it("keeps only active output tax codes, since invoices cannot use the others", async () => {
    stubFetch(() =>
      Response.json({
        codes: [
          { id: "vat", code: "VAT", name: "VAT", direction: "output", rateBasisPoints: 1800, priceIncludesTax: false, active: true },
          { id: "vat-retired", code: "VAT9", name: "Retired", direction: "output", rateBasisPoints: 900, priceIncludesTax: false, active: false },
          { id: "vat-input", code: "VATIN", name: "Input", direction: "input", rateBasisPoints: 1800, priceIncludesTax: false, active: true },
        ],
      }),
    );
    const codes = await fetchAccountingTaxCodes();
    expect(codes.map((code) => code.id)).toEqual(["vat"]);
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

  it("passes the budget scenario only when one is chosen", async () => {
    const mock = stubFetch(() => Response.json({ ok: true, data: forecast }));
    await expect(fetchCashForecast("")).resolves.toEqual(forecast);
    expect(mock).toHaveBeenCalledWith("/api/accounting", expect.objectContaining({
      body: JSON.stringify({ action: "cashForecast" }),
    }));

    await fetchCashForecast("scenario-1");
    expect(mock).toHaveBeenLastCalledWith("/api/accounting", expect.objectContaining({
      body: JSON.stringify({ action: "cashForecast", budgetScenarioId: "scenario-1" }),
    }));
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

  it("refuses to build a statement without a customer", async () => {
    const mock = stubFetch(() => Response.json({}));
    await expect(fetchCustomerStatement("")).rejects.toMatchObject({ status: 400 });
    expect(mock).not.toHaveBeenCalled();
  });

  it("fails loudly when a capability result breaks shape", async () => {
    stubFetch(() => Response.json({ ok: true, data: { reminders: "nope" } }));
    await expect(fetchPaymentReminders()).rejects.toMatchObject({
      message: "The Accounting service returned an unexpected result.",
    });
  });
});

describe("accounting API: governed writes", () => {
  it("reports a 202 as pending rather than completed", async () => {
    stubFetch(() => Response.json({ pendingApproval: true, reason: "Payment above threshold" }, { status: 202 }));
    await expect(
      submitAccountingAction("/api/accounting", { action: "payBill", intentId: "intent-1" }),
    ).resolves.toEqual({ kind: "pending", reason: "Payment above threshold" });
  });

  it("keeps the posted intentId on the wire for idempotency", async () => {
    const mock = stubFetch(() => Response.json({ ok: true, data: {} }));
    await submitAccountingAction("/api/accounting", {
      action: "payBill",
      billNumber: 77,
      amountMinor: 4_000,
      intentId: "intent-abc",
    });
    expect(mock).toHaveBeenCalledWith("/api/accounting", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ action: "payBill", billNumber: 77, amountMinor: 4_000, intentId: "intent-abc" }),
    }));
  });

  it("reports a completed write only when a 200 envelope comes back", async () => {
    stubFetch(() => Response.json({ ok: true, data: {} }));
    await expect(submitAccountingAction("/api/banking", { action: "matchBankTransaction" })).resolves.toEqual({
      kind: "completed",
    });
  });

  it("rejects a 202 that is missing its pending marker", async () => {
    stubFetch(() => Response.json({ ok: true, data: {} }, { status: 202 }));
    await expect(submitAccountingAction("/api/accounting", { action: "reverse" })).rejects.toMatchObject({
      status: 202,
      message: "This action is waiting for approval but the Accounting service returned an invalid approval response.",
    });
  });

  it("turns a rejected write into a readable failure", async () => {
    stubFetch(() => Response.json({ message: "Period is sealed" }, { status: 422 }));
    await expect(submitAccountingAction("/api/accounting", { action: "recordPayment" })).rejects.toMatchObject({
      status: 422,
      message: "Period is sealed",
    });
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
    await expect(fetchAccountingOverview()).rejects.toMatchObject({
      status: 0,
      message: "The Accounting service took too long to respond. Check the record before trying again.",
    });
  });

  it("explains an unreachable service", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    await expect(fetchAccountingOverview()).rejects.toMatchObject({
      status: 0,
      message: "Could not reach the Accounting service. Check your connection and try again.",
    });
  });
});