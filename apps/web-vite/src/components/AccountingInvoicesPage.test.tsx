import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountingInvoicesPage } from "./AccountingInvoicesPage";

const invoice = {
  id: "invoice-1",
  number: 1042,
  customerId: "customer-1",
  customerName: "Kampala Coffee",
  status: "partially_paid",
  currency: "UGX",
  totalMinor: 125_000,
  paidMinor: 25_000,
  creditedMinor: 0,
  outstandingMinor: 100_000,
  issuedAt: "2026-09-20T10:30:00.000Z",
};
const switchboard = { catalog: [{ id: "accounting" }], enabledModules: ["accounting"] };

function stubAccounting(invoices: unknown = [invoice]) {
  vi.stubGlobal("__GO_ACCOUNTING_INVOICE_READS__", true);
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/modules"
    ? Response.json(switchboard)
    : Response.json({ ok: true, data: { invoices } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Vite Accounting invoices preview", () => {
  it("shows invoice details and formats each amount in the invoice currency", async () => {
    const fetchMock = stubAccounting();
    render(<AccountingInvoicesPage />);

    expect(await screen.findByRole("heading", { name: "Accounting invoices" })).not.toBeNull();
    expect(screen.getByText("Kampala Coffee")).not.toBeNull();
    expect(screen.getByText("#1042")).not.toBeNull();
    expect(screen.getByText("Partially Paid")).not.toBeNull();
    expect(screen.getAllByText(/UGX/)).toHaveLength(3);
    expect(screen.getByText((value) => value.includes("100,000"))).not.toBeNull();
    expect(screen.getByRole("link", { name: "Open full Accounting workspace" }).getAttribute("href")).toContain("/accounting?tab=invoices");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/modules", "/api/capabilities/execute"]);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({ capabilityId: "accounting.listInvoices", input: {} }),
    }));
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/accounting")).toBe(false);
  });

  it("formats currencies that use three minor units", async () => {
    stubAccounting([{ ...invoice, currency: "BHD", totalMinor: 123_456, paidMinor: 0, outstandingMinor: 123_456 }]);
    render(<AccountingInvoicesPage />);

    expect(await screen.findAllByText((value) => value.includes("123.456"))).toHaveLength(2);
  });

  it("does not call the accounting endpoint when its module is disabled", async () => {
    const fetchMock = vi.fn(async () => Response.json({ catalog: [{ id: "accounting" }], enabledModules: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AccountingInvoicesPage />);

    expect(await screen.findByRole("heading", { name: "Accounting is turned off" })).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows an empty state when there are no invoices", async () => {
    stubAccounting([]);
    render(<AccountingInvoicesPage />);

    expect(await screen.findByRole("heading", { name: "No invoices yet" })).not.toBeNull();
  });

  it("keeps the loading status visible until the Go invoice capability responds", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_INVOICE_READS__", true);
    let resolveInvoices: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL) => String(input) === "/api/modules"
      ? Promise.resolve(Response.json(switchboard))
      : new Promise<Response>((resolve) => { resolveInvoices = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AccountingInvoicesPage />);

    expect(screen.getByRole("status").textContent).toContain("Loading invoices");
    await waitFor(() => expect(resolveInvoices).toBeDefined());
    resolveInvoices?.(Response.json({ ok: true, data: { invoices: [invoice] } }));
    expect(await screen.findByText("Kampala Coffee")).not.toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/modules", "/api/capabilities/execute"]);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/accounting")).toBe(false);
  });

  it("shows permission failures and keeps a route back to the full workspace", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_INVOICE_READS__", true);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => input === "/api/modules"
      ? Response.json(switchboard)
      : Response.json({ ok: false, error: "forbidden: missing accounting.read" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AccountingInvoicesPage />);

    expect(await screen.findByRole("heading", { name: "Access denied" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Open full Accounting workspace" })).not.toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/modules", "/api/capabilities/execute"]);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/accounting")).toBe(false);
  });

  it("offers sign-in when the protected accounting route returns unauthorized", async () => {
    vi.stubGlobal("__GO_ACCOUNTING_INVOICE_READS__", true);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => input === "/api/modules"
      ? Response.json(switchboard)
      : Response.json({ ok: false, error: "unauthorized" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AccountingInvoicesPage />);

    expect(await screen.findByRole("heading", { name: "Sign in again" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe("/login");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/modules", "/api/capabilities/execute"]);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/accounting")).toBe(false);
  });
});
