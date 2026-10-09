import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { submitAccountingAction } from "../api/accounting";
import {
  AccountingPage,
  filterByAgingRange,
  filterEntries,
  formatMoney,
  formatMoneyOrMinor,
  hasCurrencyCode,
  invoicePreviewTotals,
  isReversible,
  minorToInput,
  parseFeedCsv,
  readTabParam,
  toMinorUnits,
  type AccountingEntry,
  type AccountingInvoice,
} from "./AccountingPage";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/accounting");
});

/* ------------------------------------------------------------- fixtures -- */

const invoiceEntry: AccountingEntry = {
  id: "entry-1",
  memo: "Invoice 1042 posted",
  sourceType: "invoice",
  reversalOfId: null,
  postedAt: "2026-09-20T10:30:00.000Z",
  actorType: "agent",
  currency: "USD",
  amountMinor: 12_500,
  debitMinor: 12_500,
};

const reversalEntry: AccountingEntry = {
  id: "entry-2",
  memo: "Reversal of invoice 1042",
  sourceType: "reversal",
  reversalOfId: "entry-1",
  postedAt: "2026-09-21T10:30:00.000Z",
  actorType: "human",
  currency: "USD",
  amountMinor: 12_500,
  debitMinor: 12_500,
};

const openInvoice: AccountingInvoice = {
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  number: 1042,
  customerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  customerName: "Kampala Coffee",
  status: "partially_paid",
  currency: "USD",
  totalMinor: 12_500,
  paidMinor: 2_500,
  creditedMinor: 0,
  outstandingMinor: 10_000,
  issuedAt: "2026-09-20T10:30:00.000Z",
};

const voidInvoice: AccountingInvoice = {
  ...openInvoice,
  id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  number: 1043,
  status: "void",
  totalMinor: 5_000,
  paidMinor: 0,
  outstandingMinor: 5_000,
};

const overview = {
  entries: [invoiceEntry, reversalEntry],
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
  filings: [{ id: "filing-1", periodFrom: "2026-01-01", periodTo: "2026-03-31", taxMinor: 1_800, filedAt: "2026-04-20T00:00:00.000Z" }],
  customers: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Kampala Coffee", paymentTermDays: 30 }],
  invoices: [openInvoice, voidInvoice],
  payments: [
    { id: "payment-1", invoiceNumber: 1042, amountMinor: 2_500, method: "bank_transfer", receivedAt: "2026-09-21T08:00:00.000Z", currency: "USD" },
  ],
};

const reports = {
  baseCurrency: "USD",
  unsupportedCurrencies: [],
  pnl: { revenueMinor: 12_500, expenseMinor: 1_000, netIncomeMinor: 11_500, lines: [{ code: "4000", name: "Revenue", amountMinor: 12_500 }] },
  balanceSheet: { assetsMinor: 20_000, liabilitiesMinor: 4_000, equityMinor: 16_000, retainedResultMinor: 0, balanced: true },
  cashFlow: null,
  fxExposure: null,
};

const cashBasis = { cashInMinor: 5_000, cashOutMinor: 1_000, netCashMinor: 4_000, accrualRevenueMinor: 9_000, uncollectedMinor: 1_000 };

interface StubOptions {
  accounting?: unknown;
  enabled?: boolean;
  reports?: unknown;
  reportsStatus?: number;
  banking?: unknown;
  rejectCashBasis?: boolean;
  rejectBanking?: boolean;
  taxCodes?: unknown;
  actionResponse?: Response | (() => Response);
  goPaymentResponse?: () => Response;
  goCreateInvoiceResponse?: () => Response;
  goCreditNoteResponse?: () => Response;
}

function stubAccounting(options: StubOptions = {}) {
  const calls: { url: string; method: string; body: string | null }[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, method, body });
    if (url === "/api/modules") {
      return Response.json({
        catalog: [{ id: "accounting" }],
        enabledModules: options.enabled === false ? [] : ["accounting"],
      });
    }
    if (url === "/api/capabilities/execute") {
      const capabilityId = body ? (JSON.parse(body) as { capabilityId?: string }).capabilityId : undefined;
      if (capabilityId === "accounting.creditNote") {
        return options.goCreditNoteResponse?.() ?? Response.json({ ok: true, data: {
          entryId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          creditedMinor: 2500,
          invoiceBalanceMinor: 7500,
        } });
      }
      if (capabilityId === "accounting.createInvoice") {
        return options.goCreateInvoiceResponse?.() ?? Response.json({ ok: true, data: {
          invoiceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          invoiceNumber: 2048,
          totalMinor: 2500,
          entryId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          currency: "USD",
        } });
      }
      return options.goPaymentResponse?.() ?? Response.json({ ok: true, data: {
        paymentId: "33333333-3333-4333-8333-333333333333",
        entryId: "44444444-4444-4444-8444-444444444444",
        fullyPaid: false,
      } });
    }
    if (url === "/api/accounting" && method === "POST") {
      const action = body ? (JSON.parse(body) as { action?: string }).action : undefined;
      if (action === "cashBasis") {
        if (options.rejectCashBasis) throw new TypeError("Network unavailable");
        return Response.json({ ok: true, data: cashBasis });
      }
      if (action === "cashForecast") {
        return Response.json({
          ok: true,
          data: {
            startMinor: 10_000,
            finalMinor: 12_000,
            lowestCloseMinor: 8_000,
            lowestWeekIndex: 0,
            scenarioName: null,
            minimumCashBufferMinor: 5_000,
            weeks: [
              { weekStart: "2026-10-05T00:00:00.000Z", inflowMinor: 3_000, outflowMinor: 1_000, closeMinor: 12_000 },
            ],
          },
        });
      }
      if (action === "buildReminders") {
        return Response.json({ ok: true, data: { reminders: [] } });
      }
      if (action === "customerStatement") {
        return Response.json({ ok: true, data: { currencies: [] } });
      }
      if (options.actionResponse) {
        return typeof options.actionResponse === "function" ? options.actionResponse() : options.actionResponse.clone();
      }
      return Response.json({ ok: true, data: {} });
    }
    if (url === "/api/accounting") {
      return Response.json(options.accounting ?? overview);
    }
    if (url === "/api/reports") {
      return options.reportsStatus
        ? Response.json({ error: "reports unavailable" }, { status: options.reportsStatus })
        : Response.json(options.reports ?? reports);
    }
    if (url === "/api/banking") {
      if (options.rejectBanking) throw new TypeError("Network unavailable");
      return options.banking === null
        ? Response.json({ error: "no banking" }, { status: 500 })
        : Response.json(options.banking ?? { accounts: [], unmatched: [], payments: [], summary: { accounts: [], unmatchedCount: 0 } });
    }
    if (url === "/api/accounting/tax") {
      return Response.json(options.taxCodes ?? { codes: [] });
    }
    return Response.json({ ok: true, data: {} });
  });
  vi.stubGlobal("fetch", mock);
  return { mock, calls };
}

/** Renders and waits for the initial books load so tab clicks land on a live nav. */
async function renderReady(props: { actorId?: string | null; organizationId?: string | null } = {
  actorId: "55555555-5555-4555-8555-555555555555",
  organizationId: "66666666-6666-4666-8666-666666666666",
}) {
  render(<AccountingPage {...props} />);
  return screen.findByRole("navigation", { name: "Accounting sections" });
}

/* ------------------------------------------------------------ pure logic -- */

describe("money helpers", () => {
  it("formats integer minor units in each currency's own exponent", () => {
    expect(formatMoney("USD", 12_500)).toBe("$125.00");
    expect(formatMoney("JPY", 12_500)).toBe("¥12,500");
    expect(formatMoney("KWD", 1_250)).toContain("1.250");
  });

  it("never silently renders a zero when the currency is missing", () => {
    expect(hasCurrencyCode("USD")).toBe(true);
    expect(hasCurrencyCode(null)).toBe(false);
    expect(hasCurrencyCode("ZZ")).toBe(false);
    expect(formatMoneyOrMinor(null, 12_500)).toBe("12,500 minor units · currency unavailable");
    expect(formatMoneyOrMinor("USD", 12_500)).toBe("$125.00");
  });

  it("parses decimal input into exact minor units with half-up rounding", () => {
    expect(toMinorUnits("USD", "125")).toBe(12_500);
    expect(toMinorUnits("USD", "125.005")).toBe(12_501);
    expect(toMinorUnits("USD", "-42.10")).toBe(-4_210);
    expect(toMinorUnits("JPY", "1250")).toBe(1_250);
    expect(toMinorUnits("USD", "abc")).toBeNaN();
    expect(toMinorUnits("ZZ", "1")).toBeNaN();
    expect(toMinorUnits("USD", "")).toBe(0);
  });

  it("round-trips minor units back into an input value", () => {
    expect(minorToInput("USD", 12_500)).toBe("125.00");
    expect(minorToInput("USD", 12_506)).toBe("125.06");
    expect(minorToInput("ZZ", 12_500)).toBe("");
  });
});

describe("tab deep-linking", () => {
  it("accepts a known tab and falls back otherwise", () => {
    expect(readTabParam("?tab=journal")).toBe("journal");
    expect(readTabParam("?tab=nonsense")).toBe("overview");
    expect(readTabParam("")).toBe("overview");
  });

  it("opens the tab named in the URL on first paint", async () => {
    window.history.replaceState(null, "", "/accounting?tab=payables");
    stubAccounting();
    render(<AccountingPage />);

    expect(await screen.findByRole("table", { name: "Vendor bills" })).toBeTruthy();
    expect(window.location.search).toBe("?tab=payables");
  });

  it("rewrites the URL in place when the tab changes", async () => {
    stubAccounting();
    render(<AccountingPage />);
    await screen.findByRole("table", { name: "Journal entries" }).catch(() => undefined);

    fireEvent.click(screen.getByRole("button", { name: /Journal/ }));
    expect(window.location.search).toBe("?tab=journal");
    expect(window.location.hash).toBe("#journal");
  });
});

describe("journal filtering and reversibility", () => {
  it("matches memo, source, and actor", () => {
    expect(filterEntries([invoiceEntry, reversalEntry], "reversal")).toHaveLength(1);
    expect(filterEntries([invoiceEntry, reversalEntry], "agent")).toEqual([invoiceEntry]);
    expect(filterEntries([invoiceEntry, reversalEntry], "")).toHaveLength(2);
  });

  it("refuses to reverse a reversal or an already-mirrored entry", () => {
    expect(isReversible(invoiceEntry, [invoiceEntry, reversalEntry])).toBe(false);
    expect(isReversible(reversalEntry, [invoiceEntry, reversalEntry])).toBe(false);
    expect(isReversible({ ...invoiceEntry, id: "entry-9", reversalOfId: null }, [invoiceEntry, reversalEntry])).toBe(true);
  });

  it("buckets invoices by age and drops settled or void ones", () => {
    const ages = new Map([[1042, 45]]);
    expect(filterByAgingRange([openInvoice, voidInvoice], ages, "all")).toHaveLength(2);
    expect(filterByAgingRange([openInvoice, voidInvoice], ages, "current")).toHaveLength(0);
    expect(filterByAgingRange([openInvoice, voidInvoice], ages, "d30")).toEqual([openInvoice]);
    expect(filterByAgingRange([openInvoice, voidInvoice], ages, "d90plus")).toHaveLength(0);
    expect(filterByAgingRange([openInvoice, voidInvoice], ages, "outstanding")).toEqual([openInvoice]);
  });
});

describe("invoice preview totals", () => {
  it("sums quantity thousandths by unit price in minor units", () => {
    const totals = invoicePreviewTotals(
      [
        { description: "Bag", quantity: "2", unitPrice: "10.00", tax: "0" },
        { description: "Cord", quantity: "3", unitPrice: "1.50", tax: "0.25" },
      ],
      "USD",
    );
    expect(totals).not.toBeNull();
    expect(totals?.subtotalMinor).toBe(2_450);
    expect(totals?.taxMinor).toBe(25);
    expect(totals?.totalMinor).toBe(2_475);
  });

  it("splits tax out of the price when the code includes tax", () => {
    const totals = invoicePreviewTotals(
      [{ description: "Bag", quantity: "1", unitPrice: "118.00", tax: "0", taxCodeId: "vat" }],
      "USD",
      [{ id: "vat", code: "VAT", name: "VAT", direction: "output", rateBasisPoints: 1800, priceIncludesTax: true, active: true }],
    );
    expect(totals?.subtotalMinor).toBe(10_000);
    expect(totals?.taxMinor).toBe(1_800);
    expect(totals?.totalMinor).toBe(11_800);
  });

  it("refuses to show a total it cannot compute exactly", () => {
    expect(invoicePreviewTotals([{ description: "Bag", quantity: "0", unitPrice: "10", tax: "0" }], "USD")).toBeNull();
    expect(invoicePreviewTotals([{ description: "Bag", quantity: "1", unitPrice: "abc", tax: "0" }], "USD")).toBeNull();
    expect(invoicePreviewTotals([{ description: "", quantity: "1", unitPrice: "1", tax: "0" }], "USD")).toBeNull();
    expect(invoicePreviewTotals([{ description: "Bag", quantity: "1", unitPrice: "0", tax: "0" }], "USD")).toBeNull();
  });
});

describe("bank feed CSV parsing", () => {
  it("reads date,amount,description rows and keeps thousand separators", () => {
    const parsed = parseFeedCsv("2026-06-01,1250.00,ACME wire\n2026-06-02,-42.10,Card fees", "USD");
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual([
      { postedAt: "2026-06-01", amountMinor: 125_000, description: "ACME wire" },
      { postedAt: "2026-06-02", amountMinor: -4_210, description: "Card fees" },
    ]);
  });

  it("reports the offending line and keeps parsing the rest", () => {
    const parsed = parseFeedCsv("06/01/2026,10.00,Bad date\n2026-06-02,1.00,Good", "USD");
    expect(parsed.errors).toEqual(["line 1: expected date,amount,description"]);
    expect(parsed.rows).toHaveLength(1);
  });
});

/* ------------------------------------------------------------- rendering -- */

describe("AccountingPage states", () => {
  it("shows the overview position and working capital once loaded", async () => {
    stubAccounting();
    render(<AccountingPage />);

    expect(await screen.findByText("Net income · to date")).toBeTruthy();
    expect(screen.getByText("$115.00")).toBeTruthy();
    expect(screen.getByText("books balanced")).toBeTruthy();
    expect(screen.getByText("Harbor Supplies")).toBeTruthy();
    expect(screen.getByText("Who I owe")).toBeTruthy();
    expect(screen.getByText("Invoice #1042")).toBeTruthy();
  });

  it("does not fetch the books when Accounting is disabled", async () => {
    const { mock } = stubAccounting({ enabled: false });
    render(<AccountingPage />);

    expect(await screen.findByText("Accounting is turned off")).toBeTruthy();
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a load failure with a retry that refetches", async () => {
    const { mock } = stubAccounting({ accounting: { nope: true } });
    render(<AccountingPage />);

    expect(await screen.findByRole("heading", { name: "Could not load your books" })).toBeTruthy();
    const callsBefore = mock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mock.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it("keeps the books when an auxiliary read fails", async () => {
    stubAccounting({ banking: null });
    render(<AccountingPage />);

    expect(await screen.findByText("Net income · to date")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Bank/ }));
    expect(await screen.findByText("Bank feeds could not load")).toBeTruthy();
  });

  it("keeps the books when auxiliary requests fail at the network layer", async () => {
    stubAccounting({ rejectCashBasis: true, rejectBanking: true });
    render(<AccountingPage />);

    expect(await screen.findByText("Net income · to date")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Bank/ }));
    expect(await screen.findByText("Bank feeds could not load")).toBeTruthy();
  });
});

describe("AccountingPage governed writes", () => {
  it("pays a bill with a minted intentId and confirms completion", async () => {
    const { calls } = stubAccounting();
    await renderReady();

    fireEvent.click(await screen.findByRole("button", { name: "Pay" }));
    const confirm = await screen.findByRole("button", { name: /^Pay \$/ });
    fireEvent.click(confirm);

    await waitFor(() => {
      const write = calls.find((call) => call.body?.includes("payBill"));
      expect(write).toBeTruthy();
      const payload = JSON.parse(write!.body!) as { intentId: string; amountMinor: number };
      expect(payload.amountMinor).toBe(4_000);
      expect(payload.intentId).toMatch(/^[0-9a-f-]{36}$/);
    });
    expect(await screen.findByText(/^Payment of \$40.00 done\.$/)).toBeTruthy();
  });

  it("surfaces a 202 as pending approval, never as success", async () => {
    stubAccounting({ actionResponse: () => Response.json({ pendingApproval: true, reason: "Payment above threshold" }, { status: 202 }) });
    await renderReady();

    fireEvent.click(await screen.findByRole("button", { name: "Pay" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Pay \$/ }));

    const pending = await screen.findByText(/needs human approval. It is in the Approvals inbox\./);
    expect(pending).toBeTruthy();
    expect(screen.queryByText(/done\.$/)).toBeNull();
    const notice = screen.getByRole("status");
    expect(notice.className).toContain("accounting-notice-pending");
  });

  it("reports a rejected write as an error with the server reason", async () => {
    stubAccounting({ actionResponse: () => Response.json({ message: "Period is sealed" }, { status: 422 }) });
    await renderReady();

    fireEvent.click(await screen.findByRole("button", { name: "Pay" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Pay \$/ }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Period is sealed")).toBeTruthy();
  });

  it("records a payment on an invoice only within its outstanding balance", async () => {
    const { calls } = stubAccounting();
    await renderReady();

    fireEvent.click(screen.getByRole("button", { name: /Receivables/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Pay" }));

    const amount = screen.getByLabelText("Amount received");
    fireEvent.change(amount, { target: { value: "500" } });
    expect(screen.getByText("Payment exceeds this invoice outstanding balance.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Record payment" }).hasAttribute("disabled")).toBe(true);

    fireEvent.change(amount, { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Record payment" }));
    await waitFor(() => {
      const write = calls.find((call) => call.body?.includes("recordPayment"));
      expect(JSON.parse(write!.body!) as { amountMinor: number }).toMatchObject({ amountMinor: 5_000 });
    });
  });

  it("routes invoice payments to Go and restores the exact pending payment after reload", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_RECORD_PAYMENT__", true);
    const sent: Array<{ capabilityId: string; input: Record<string, unknown>; intentId: string }> = [];
    const ids = {
      actorId: "55555555-5555-4555-8555-555555555555",
      organizationId: "66666666-6666-4666-8666-666666666666",
    };
    const { calls } = stubAccounting({
      goPaymentResponse: () => {
        const body = JSON.parse(String(calls.at(-1)?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string };
        sent.push(body);
        return sent.length === 1
          ? Response.json({ pendingApproval: true, reason: "Payment approval required" }, { status: 202 })
          : Response.json({ ok: true, data: { paymentId: "33333333-3333-4333-8333-333333333333", entryId: "44444444-4444-4444-8444-444444444444", fullyPaid: false } });
      },
    });
    const first = render(<AccountingPage {...ids} />);
    await screen.findByRole("navigation", { name: "Accounting sections" });
    fireEvent.click(screen.getByRole("button", { name: /Receivables/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Pay" }));
    fireEvent.change(screen.getByLabelText("Amount received"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Record payment" }));

    expect(await screen.findByRole("button", { name: "Retry exact payment" })).not.toBeNull();
    expect((screen.getByLabelText("Amount received") as HTMLInputElement).disabled).toBe(true);
    expect(sent[0]).toMatchObject({ capabilityId: "accounting.recordPayment", input: { invoiceNumber: 1042, amountMinor: 5_000, method: "bank_transfer" } });
    expect(calls.some((call) => call.url === "/api/accounting" && call.method === "POST" && call.body?.includes("recordPayment"))).toBe(false);

    first.unmount();
    render(<AccountingPage {...ids} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry exact payment" }));
    expect(await screen.findByText(/^Payment on invoice #1042 done\.$/)).not.toBeNull();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.input).toEqual(sent[0]?.input);
    expect(sent[1]?.intentId).toBe(sent[0]?.intentId);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("offers exact recovery from the global notice when the invoice is absent after reload", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_RECORD_PAYMENT__", true);
    const ids = {
      actorId: "55555555-5555-4555-8555-555555555555",
      organizationId: "66666666-6666-4666-8666-666666666666",
    };
    const action = { action: "recordPayment", invoiceNumber: 1042, amountMinor: 5_000, method: "cash" };
    const sent: Array<{ capabilityId: string; input: Record<string, unknown>; intentId: string }> = [];
    let attempt = 0;
    const { calls } = stubAccounting({
      accounting: { ...overview, invoices: [] },
      goPaymentResponse: () => {
        const body = JSON.parse(String(calls.at(-1)?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string };
        sent.push(body);
        attempt += 1;
        return attempt === 1
          ? Response.json({ pendingApproval: true, reason: "Payment approval required" }, { status: 202 })
          : Response.json({ ok: true, data: { paymentId: "33333333-3333-4333-8333-333333333333", entryId: "44444444-4444-4444-8444-444444444444", fullyPaid: true } });
      },
    });
    await expect(submitAccountingAction("/api/accounting", action, undefined, ids)).resolves.toMatchObject({ kind: "pending" });
    render(<AccountingPage {...ids} />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry exact payment" }));
    expect(await screen.findByText(/^Payment on invoice #1042 done\.$/)).not.toBeNull();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.input).toEqual(sent[0]?.input);
    expect(sent[1]?.intentId).toBe(sent[0]?.intentId);
    expect(calls.some((call) => call.url === "/api/accounting" && call.method === "POST" && call.body?.includes("recordPayment"))).toBe(false);
  });

  it("routes invoice creation to Go and restores an exact pending attempt after reload", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_CREATE_INVOICE__", true);
    const ids = {
      actorId: "55555555-5555-4555-8555-555555555555",
      organizationId: "66666666-6666-4666-8666-666666666666",
    };
    const sent: Array<{ capabilityId: string; input: Record<string, unknown>; intentId: string }> = [];
    let attempt = 0;
    const { calls } = stubAccounting({
      accounting: { ...overview, invoices: [] },
      goCreateInvoiceResponse: () => {
        const body = JSON.parse(String(calls.at(-1)?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string };
        sent.push(body);
        attempt += 1;
        return attempt === 1
          ? Response.json({ pendingApproval: true, reason: "Invoice approval required" }, { status: 202 })
          : Response.json({ ok: true, data: { invoiceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", invoiceNumber: 2048, totalMinor: 2500, entryId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", currency: "USD" } });
      },
    });
    const first = render(<AccountingPage {...ids} />);
    await screen.findByRole("navigation", { name: "Accounting sections" });
    fireEvent.click(screen.getByRole("button", { name: /Receivables/ }));
    fireEvent.click(screen.getByRole("button", { name: "New invoice" }));
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } });
    fireEvent.change(screen.getByLabelText("Line 1 description"), { target: { value: "Advisory" } });
    fireEvent.change(screen.getByLabelText("Line 1 unit price"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Post invoice" }));

    expect(await screen.findByRole("button", { name: "Retry exact invoice" })).not.toBeNull();
    expect((screen.getByLabelText("Line 1 description") as HTMLInputElement).disabled).toBe(true);
    expect(sent[0]).toMatchObject({ capabilityId: "accounting.createInvoice", input: { customerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", lines: [{ description: "Advisory", quantity: 1000, unitPriceMinor: 2500 }] } });
    expect(calls.some((call) => call.url === "/api/accounting" && call.method === "POST" && call.body?.includes("createInvoice"))).toBe(false);

    first.unmount();
    render(<AccountingPage {...ids} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry exact invoice" }));
    expect(await screen.findByText(/^Invoice creation done\.$/)).not.toBeNull();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.input).toEqual(sent[0]?.input);
    expect(sent[1]?.intentId).toBe(sent[0]?.intentId);
  });

  it("closes and resets invoice creation after same-session exact recovery", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_CREATE_INVOICE__", true);
    let attempt = 0;
    const { calls } = stubAccounting({
      goCreateInvoiceResponse: () => {
        attempt += 1;
        return attempt === 1
          ? Response.json({ pendingApproval: true, reason: "Invoice approval required" }, { status: 202 })
          : Response.json({ ok: true, data: { invoiceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", invoiceNumber: 2048, totalMinor: 2500, entryId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", currency: "USD" } });
      },
    });
    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: /Receivables/ }));
    fireEvent.click(screen.getByRole("button", { name: "New invoice" }));
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } });
    fireEvent.change(screen.getByLabelText("Line 1 description"), { target: { value: "Advisory" } });
    fireEvent.change(screen.getByLabelText("Line 1 unit price"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Post invoice" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry exact invoice" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("button", { name: "Retry exact invoice" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New invoice" }));
    expect((screen.getByLabelText("Line 1 description") as HTMLInputElement).value).toBe("");
    expect(calls.filter((call) => call.url === "/api/capabilities/execute" && call.method === "POST")).toHaveLength(2);
  });

  it("guards a credit note behind a positive amount and a real reason", async () => {
    const { calls } = stubAccounting();
    await renderReady();

    fireEvent.click(screen.getByRole("button", { name: /Receivables/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Credit" }));

    const apply = screen.getByRole("button", { name: "Apply credit" });
    expect(apply.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "goodwill" } });
    expect(apply.hasAttribute("disabled")).toBe(false);

    fireEvent.click(apply);
    await waitFor(() => expect(calls.some((call) => call.body?.includes("creditNote"))).toBe(true));
  });

  it("routes credit notes to Go and restores the exact pending credit after reload", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_CREDIT_NOTE__", true);
    const ids = {
      actorId: "55555555-5555-4555-8555-555555555555",
      organizationId: "66666666-6666-4666-8666-666666666666",
    };
    const sent: Array<{ capabilityId: string; input: Record<string, unknown>; intentId: string }> = [];
    let attempt = 0;
    const { calls } = stubAccounting({
      goCreditNoteResponse: () => {
        const body = JSON.parse(String(calls.at(-1)?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string };
        sent.push(body);
        attempt += 1;
        return attempt === 1
          ? Response.json({ pendingApproval: true, reason: "Credit approval required" }, { status: 202 })
          : Response.json({ ok: true, data: { entryId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", creditedMinor: 2500, invoiceBalanceMinor: 7500 } });
      },
    });
    const first = render(<AccountingPage {...ids} />);
    await screen.findByRole("navigation", { name: "Accounting sections" });
    fireEvent.click(screen.getByRole("button", { name: /Receivables/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Credit" }));
    fireEvent.change(screen.getByLabelText("Amount to credit"), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Goodwill credit" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply credit" }));

    expect(await screen.findByRole("button", { name: "Retry exact credit" })).not.toBeNull();
    expect((screen.getByLabelText("Amount to credit") as HTMLInputElement).disabled).toBe(true);
    expect(sent[0]).toMatchObject({ capabilityId: "accounting.creditNote", input: { invoiceId: openInvoice.id, amountMinor: 2500, reason: "Goodwill credit" } });
    expect(calls.some((call) => call.url === "/api/accounting" && call.method === "POST" && call.body?.includes("creditNote"))).toBe(false);

    first.unmount();
    render(<AccountingPage {...ids} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry exact credit" }));
    expect(await screen.findByText(/^Credit on invoice done\.$/)).not.toBeNull();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.input).toEqual(sent[0]?.input);
    expect(sent[1]?.intentId).toBe(sent[0]?.intentId);
  });

  it("closes the credit form after same-session exact recovery", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_CREDIT_NOTE__", true);
    const sent: Array<{ capabilityId: string; input: Record<string, unknown>; intentId: string }> = [];
    let attempt = 0;
    const { calls } = stubAccounting({
      goCreditNoteResponse: () => {
        sent.push(JSON.parse(String(calls.at(-1)?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string });
        attempt += 1;
        return attempt === 1
          ? Response.json({ pendingApproval: true, reason: "Credit approval required" }, { status: 202 })
          : Response.json({ ok: true, data: { entryId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", creditedMinor: 2500, invoiceBalanceMinor: 7500 } });
      },
    });
    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: /Receivables/ }));
    fireEvent.click((await screen.findAllByRole("button", { name: "Credit" }))[0]!);
    fireEvent.change(screen.getByLabelText("Amount to credit"), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Goodwill credit" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply credit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry exact credit" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("button", { name: "Retry exact credit" })).toBeNull();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.input).toEqual(sent[0]?.input);
    expect(sent[1]?.intentId).toBe(sent[0]?.intentId);
  });

  it("surfaces Go's live balance rejection when the displayed invoice balance is stale", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_CREDIT_NOTE__", true);
    const { calls } = stubAccounting({
      goCreditNoteResponse: () => Response.json({ error: "credit 9000 exceeds the open balance 5000" }, { status: 422 }),
    });
    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: /Receivables/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Credit" }));
    fireEvent.change(screen.getByLabelText("Amount to credit"), { target: { value: "90" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Goodwill credit" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply credit" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("credit 9000 exceeds the open balance 5000")).toBeTruthy();
    expect(calls.some((call) => call.url === "/api/capabilities/execute" && call.body?.includes("accounting.creditNote"))).toBe(true);
    expect(calls.some((call) => call.url === "/api/accounting" && call.method === "POST" && call.body?.includes("creditNote"))).toBe(false);
  });
});

describe("AccountingPage tabs", () => {
  it("filters the journal by the search box and honours the slash shortcut", async () => {
    stubAccounting();
    await renderReady();

    fireEvent.click(screen.getByRole("button", { name: /Journal/ }));
    expect(await screen.findByRole("table", { name: "Journal entries" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search journal entries"), { target: { value: "reversal" } });
    const table = screen.getByRole("table", { name: "Journal entries" });
    expect(within(table).queryByText(/Invoice 1042 posted/)).toBeNull();
    expect(within(table).getByText(/Reversal of invoice 1042/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search journal entries"), { target: { value: "" } });
    fireEvent.keyDown(window, { key: "/" });
    expect(window.location.search).toBe("?tab=journal");
  });

  it("never offers to reverse an entry that already has a mirror", async () => {
    stubAccounting();
    await renderReady();

    fireEvent.click(screen.getByRole("button", { name: /Journal/ }));
    const table = await screen.findByRole("table", { name: "Journal entries" });
    expect(within(table).queryByRole("button", { name: "Reverse" })).toBeNull();
    expect(within(table).getByText("reversed")).toBeTruthy();
  });

  it("filters receivables by aging range", async () => {
    stubAccounting({
      accounting: {
        ...overview,
        aging: { current: 0, d30: 10_000, d60: 0, d90plus: 0, totalOutstanding: 10_000 },
        agingInvoices: [{ number: 1042, currency: "USD", outstandingMinor: 10_000, ageDays: 45 }],
      },
    });
    await renderReady();

    fireEvent.click(screen.getByRole("button", { name: /Receivables/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^31 to 60 days/ }));
    expect(await screen.findByRole("table", { name: "Invoices" })).toBeTruthy();
    expect(screen.getByText("1 invoices in this aging range")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^90 days and over/ }));
    expect(await screen.findByText("No invoices match this aging range.")).toBeTruthy();
  });

  it("shows reports and keeps foreign bills out of the base-currency payable total", async () => {
    stubAccounting({
      accounting: {
        ...overview,
        bills: [overview.bills[0], { ...overview.bills[0], id: "bill-2", number: 78, currency: "EUR", outstandingMinor: 9_000 }],
      },
    });
    await renderReady();

    fireEvent.click(screen.getByRole("button", { name: /Reports/ }));
    expect(await screen.findByRole("table", { name: "Balance sheet" })).toBeTruthy();
    expect(screen.getByText("Profit and loss · to date")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Payables/ }));
    const table = await screen.findByRole("table", { name: "Vendor bills" });
    expect(within(table).getByText("$40.00")).toBeTruthy();
    expect(within(table).getByText("€90.00")).toBeTruthy();
    expect(screen.getByText(/1 foreign-currency bill is shown/)).toBeTruthy();
  });

  it("fails the page when the books or reports cannot load, matching the legacy route", async () => {
    stubAccounting({ reportsStatus: 500 });
    render(<AccountingPage />);

    expect(await screen.findByRole("heading", { name: "Could not load your books" })).toBeTruthy();
    expect(screen.getByText("The Accounting service is unavailable. Try again.")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Accounting sections" })).toBeNull();
  });

  it("confirms a period reopen before posting it", async () => {
    const { calls } = stubAccounting();
    await renderReady();

    fireEvent.click(screen.getByRole("button", { name: /Periods & close/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Reopen" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reopen period" }));

    await waitFor(() => {
      const write = calls.find((call) => call.body?.includes("reopenPeriod"));
      expect(JSON.parse(write!.body!)).toMatchObject({ action: "reopenPeriod", year: 2026, month: 1 });
    });
  });

  it("parses a pasted feed before importing it", async () => {
    const { calls } = stubAccounting({
      banking: {
        accounts: [{ id: "acct-1", name: "Operating", currencyCode: "USD", last4: "0042", balanceMinor: 125_000 }],
        unmatched: [],
        payments: [],
        summary: { accounts: [{ bankAccountId: "acct-1", name: "Operating", currencyCode: "USD", last4: "0042", balanceMinor: 125_000, count: 2, moneyInMinor: 125_000, moneyOutMinor: 0 }], unmatchedCount: 0 },
      },
    });
    await renderReady();

    fireEvent.click(screen.getByRole("button", { name: /Bank/ }));
    fireEvent.change(await screen.findByLabelText("Statement lines"), {
      target: { value: "not a row\n2026-06-01,1250.00,ACME wire" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import lines" }));

    expect(await screen.findByText("line 1: expected date,amount,description")).toBeTruthy();
    await waitFor(() => {
      const write = calls.find((call) => call.body?.includes("importBankFeed"));
      expect(JSON.parse(write!.body!) as { rows: unknown[] }).toMatchObject({
        rows: [{ postedAt: "2026-06-01", amountMinor: 125_000, description: "ACME wire" }],
      });
    });
  });

  it("matches a bank line to a payment through the banking route", async () => {
    const { calls } = stubAccounting({
      banking: {
        accounts: [{ id: "acct-1", name: "Operating", currencyCode: "USD", last4: null, balanceMinor: 0 }],
        unmatched: [{ id: "txn-1", bankAccountId: "acct-1", currencyCode: "USD", postedAt: "2026-06-01T00:00:00.000Z", amountMinor: 2_500, description: "Incoming transfer" }],
        payments: [{ id: "payment-1", invoiceNumber: 1042, currencyCode: "USD", customerName: "Kampala Coffee", amountMinor: 2_500, receivedAt: "2026-06-01T00:00:00.000Z" }],
        summary: { accounts: [], unmatchedCount: 1 },
      },
    });
    await renderReady();

    fireEvent.click(screen.getByRole("button", { name: /Bank/ }));
    fireEvent.change(await screen.findByLabelText("Match Incoming transfer against payment"), {
      target: { value: "payment-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Match" }));

    await waitFor(() => {
      const write = calls.find((call) => call.url === "/api/banking" && call.body?.includes("matchBankTransaction"));
      expect(JSON.parse(write!.body!)).toEqual({
        action: "matchBankTransaction",
        transactionId: "txn-1",
        paymentId: "payment-1",
      });
    });
  });

  it("lists return filings and active output tax codes on the tax tab", async () => {
    stubAccounting({
      taxCodes: {
        codes: [
          { id: "vat", code: "VAT", name: "Value added tax", direction: "output", rateBasisPoints: 1800, priceIncludesTax: false, active: true },
          { id: "vat-in", code: "VATIN", name: "Input tax", direction: "input", rateBasisPoints: 1800, priceIncludesTax: false, active: true },
        ],
      },
    });
    await renderReady();

    fireEvent.click(screen.getByRole("button", { name: /Tax/ }));
    const filings = await screen.findByRole("table", { name: "Tax return filings" });
    expect(within(filings).getByText("2026-01-01 to 2026-03-31")).toBeTruthy();

    const codes = await screen.findByRole("table", { name: "Active output tax codes" });
    expect(within(codes).getByText("VAT")).toBeTruthy();
    expect(within(codes).queryByText("VATIN")).toBeNull();
  });

  it("projects the 13-week forecast on the cash tab", async () => {
    stubAccounting();
    await renderReady();

    fireEvent.click(screen.getByRole("button", { name: /Cash & collections/ }));
    expect(await screen.findByText("13-week cash forecast")).toBeTruthy();
    expect(await screen.findByRole("table", { name: "Weekly cash forecast" })).toBeTruthy();
  });

  it("loads a customer statement on demand and explains a failure", async () => {
    stubAccounting();
    await renderReady();

    fireEvent.click(screen.getByRole("button", { name: /Cash & collections/ }));
    await screen.findByRole("table", { name: "Weekly cash forecast" });

    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } });
    fireEvent.click(screen.getByRole("button", { name: "Load statement" }));
    expect(await screen.findByText("No activity on this account yet.")).toBeTruthy();
  });

  it("shows budget scenarios and their projected cash", async () => {
    stubAccounting();
    await renderReady();

    fireEvent.click(screen.getByRole("button", { name: /Budgets/ }));
    expect(await screen.findByText("No saved scenarios yet. The operational forecast runs on live due dates.")).toBeTruthy();
  });
});
