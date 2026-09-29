import { cleanup, render, screen } from "@testing-library/react";
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
  outstandingMinor: 100_000,
  issuedAt: "2026-09-20T10:30:00.000Z",
};
const switchboard = { catalog: [{ id: "accounting" }], enabledModules: ["accounting"] };

function stubAccounting(invoices: unknown = [invoice]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => input === "/api/modules"
    ? Response.json(switchboard)
    : Response.json({ invoices }));
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
    expect(fetchMock).toHaveBeenCalledWith("/api/accounting", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
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

  it("shows permission failures and keeps a route back to the full workspace", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => input === "/api/modules"
      ? Response.json(switchboard)
      : Response.json({ error: "forbidden: missing accounting.read" }, { status: 403 })));
    render(<AccountingInvoicesPage />);

    expect(await screen.findByRole("heading", { name: "Access denied" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Open full Accounting workspace" })).not.toBeNull();
  });

  it("offers sign-in when the protected accounting route returns unauthorized", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => input === "/api/modules"
      ? Response.json(switchboard)
      : Response.json({ error: "unauthorized" }, { status: 401 })));
    render(<AccountingInvoicesPage />);

    expect(await screen.findByRole("heading", { name: "Sign in again" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe("/login");
  });
});
