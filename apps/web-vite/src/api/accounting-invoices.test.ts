import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountingInvoicesApiError, fetchAccountingEnabled, fetchAccountingInvoices } from "./accounting-invoices";

const invoice = {
  id: "invoice-1",
  number: 1042,
  customerId: "customer-1",
  customerName: "Kampala Coffee",
  status: "partially_paid",
  currency: "UGX",
  totalMinor: 125_000,
  paidMinor: 25_000,
  outstandingMinor: 100_000,
  issuedAt: "2026-09-20T10:30:00.000Z",
};
const goInvoice = { ...invoice, creditedMinor: 0 };

afterEach(() => vi.unstubAllGlobals());

describe("Accounting invoices API", () => {
  it("checks the catalog and returns whether Accounting is enabled", async () => {
    const fetchMock = vi.fn(async () => Response.json({ catalog: [{ id: "accounting" }], enabledModules: ["accounting"] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAccountingEnabled()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/modules", expect.objectContaining({
      credentials: "same-origin",
      cache: "no-store",
    }));
  });

  it("validates the legacy accounting invoice response shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ invoices: [invoice] })));

    await expect(fetchAccountingInvoices()).resolves.toEqual([invoice]);
  });

  it("reads invoices through accounting.listInvoices when the Go selector is enabled", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { invoices: [goInvoice] } }));
    vi.stubGlobal("__GO_ACCOUNTING_INVOICE_READS__", true);
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAccountingInvoices()).resolves.toEqual([goInvoice]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/capabilities/execute");
    expect(init).toEqual(expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({ capabilityId: "accounting.listInvoices", input: {} }),
    }));
    const headers = new Headers(init?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("fails closed on selected Go errors without retrying the legacy route", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: false, error: "forbidden: missing accounting.read" }, { status: 403 }));
    vi.stubGlobal("__GO_ACCOUNTING_INVOICE_READS__", true);
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAccountingInvoices()).rejects.toMatchObject({
      name: "AccountingInvoicesApiError",
      status: 403,
      message: "forbidden: missing accounting.read",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.anything());
  });

  it("rejects malformed Go capability envelopes without using the legacy route", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { invoices: [invoice] }, ignored: true }));
    vi.stubGlobal("__GO_ACCOUNTING_INVOICE_READS__", true);
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAccountingInvoices()).rejects.toMatchObject({
      name: "AccountingInvoicesApiError",
      status: 200,
      message: "The Accounting service returned an unexpected capability response.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing creditedMinor", invoice],
    ["unsafe creditedMinor", { ...goInvoice, creditedMinor: Number.MAX_SAFE_INTEGER + 1 }],
    ["unknown invoice fields", { ...goInvoice, extra: "unexpected" }],
  ])("rejects Go invoice rows with %s", async (_caseName, row) => {
    vi.stubGlobal("__GO_ACCOUNTING_INVOICE_READS__", true);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { invoices: [row] } })));

    await expect(fetchAccountingInvoices()).rejects.toMatchObject({
      name: "AccountingInvoicesApiError",
      status: 200,
      message: "The Accounting service returned invoices in an unexpected format.",
    });
  });

  it("rejects malformed invoice data and unsafe minor units", async () => {
    const fetchMock = vi.fn(async () => Response.json({ invoices: [{ ...invoice, totalMinor: Number.MAX_SAFE_INTEGER + 1 }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAccountingInvoices()).rejects.toMatchObject({
      name: "AccountingInvoicesApiError",
      status: 200,
      message: "The Accounting service returned invoices in an unexpected format.",
    });
  });

  it("maps unauthorized and permission errors without bypassing the legacy route", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "forbidden: missing accounting.read" }, { status: 403 })));

    await expect(fetchAccountingInvoices()).rejects.toMatchObject({
      name: "AccountingInvoicesApiError",
      status: 403,
      message: "forbidden: missing accounting.read",
    });
  });

  it("returns unauthorized as a sign-in error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "unauthorized" }, { status: 401 })));

    await expect(fetchAccountingInvoices()).rejects.toMatchObject({
      name: "AccountingInvoicesApiError",
      status: 401,
      message: "Your session has ended. Sign in again to continue.",
    });
  });

  it("rejects a switchboard that omits Accounting from its catalog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ catalog: [{ id: "sales" }], enabledModules: [] })));

    await expect(fetchAccountingEnabled()).rejects.toBeInstanceOf(AccountingInvoicesApiError);
  });
});
