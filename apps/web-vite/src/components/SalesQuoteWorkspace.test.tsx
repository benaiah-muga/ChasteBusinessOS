import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SalesQuoteWorkspace } from "./SalesQuoteWorkspace";
import { acceptSalesQuote, createSalesQuote, fetchSalesQuoteCustomers, fetchSalesQuoteDeals, fetchSalesQuotes } from "../api/sales-quotes";

vi.mock("../api/sales-quotes", () => ({
  SALES_QUOTE_DATABASE_INTEGER_MAX: 2_147_483_647,
  SalesQuoteApiError: class SalesQuoteApiError extends Error { status = 0; },
  acceptSalesQuote: vi.fn(),
  createSalesQuote: vi.fn(),
  fetchSalesQuoteCustomers: vi.fn(),
  fetchSalesQuoteDeals: vi.fn(),
  fetchSalesQuotes: vi.fn(),
}));

const actorId = "10000000-0000-4000-8000-000000000001";
const organizationId = "10000000-0000-4000-8000-000000000002";
const customerId = "20000000-0000-4000-8000-000000000001";
const quoteId = "30000000-0000-4000-8000-000000000001";
const customer = { id: customerId, name: "Acme Foods", email: "buy@acme.test" };
const quote = { id: quoteId, number: 25, status: "sent" as const, totalMinor: 12500, customerId, createdAt: "2026-10-01T10:00:00.000Z", expiresAt: null, invoiceId: null };

beforeEach(() => {
  vi.mocked(fetchSalesQuotes).mockResolvedValue([quote]);
  vi.mocked(fetchSalesQuoteCustomers).mockResolvedValue([customer]);
  vi.mocked(fetchSalesQuoteDeals).mockResolvedValue([{
    id: "60000000-0000-4000-8000-000000000001", title: "Website renewal", stage: "proposal", valueMinor: 250000,
    note: null, customerId, customerName: customer.name, createdAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-02T10:00:00.000Z",
  }]);
  vi.mocked(createSalesQuote).mockResolvedValue({ kind: "completed", data: { quoteId: "30000000-0000-4000-8000-000000000002", quoteNumber: 26, totalMinor: 22500 } });
  vi.mocked(acceptSalesQuote).mockResolvedValue({ kind: "completed", data: { invoiceId: "40000000-0000-4000-8000-000000000001", invoiceNumber: 701, totalMinor: 12500 } });
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Vite Sales quote and relationship workspace", () => {
  it("creates a sent quote using the Go API contract and refreshes the list", async () => {
    render(<SalesQuoteWorkspace actorId={actorId} organizationId={organizationId} baseCurrency="USD" />);
    expect(await screen.findByRole("row", { name: /#25 Acme Foods sent/ })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create quote" }));
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: customerId } });
    fireEvent.change(screen.getByLabelText("Memo"), { target: { value: "Initial setup" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Consulting" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "1.5" } });
    fireEvent.change(screen.getByLabelText("Unit price"), { target: { value: "150.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Create and send quote" }));

    await waitFor(() => expect(createSalesQuote).toHaveBeenCalledWith({
      customerId, memo: "Initial setup", lines: [{ description: "Consulting", quantity: 1500, unitPriceMinor: 15000, taxMinor: 0 }],
    }, { actorId, organizationId }));
    expect((await screen.findByRole("status")).textContent).toContain("Quote #26 created and sent.");
    expect(fetchSalesQuotes).toHaveBeenCalledTimes(2);
  });

  it("accepts a sent quote and reports the created invoice", async () => {
    render(<SalesQuoteWorkspace actorId={actorId} organizationId={organizationId} baseCurrency="USD" />);
    const row = await screen.findByRole("row", { name: /#25 Acme Foods sent/ });
    fireEvent.click(within(row).getByRole("button", { name: "Accept and create invoice" }));
    await waitFor(() => expect(acceptSalesQuote).toHaveBeenCalledWith(quoteId, { actorId, organizationId }));
    expect((await screen.findByRole("status")).textContent).toContain("Quote #25 accepted. Invoice #701 was created.");
  });

  it("shows Go-backed customer and deal views with only Vite CRM links", async () => {
    render(<SalesQuoteWorkspace actorId={actorId} organizationId={organizationId} baseCurrency="USD" />);
    await screen.findByRole("heading", { name: "Quotes" });
    fireEvent.click(screen.getByRole("button", { name: "Customers" }));
    expect(await screen.findByText("Acme Foods")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Open CRM" }).getAttribute("href")).toBe("/crm");
    fireEvent.click(screen.getByRole("button", { name: "Deals" }));
    expect(await screen.findByText("Website renewal")).not.toBeNull();
    expect(screen.getByText(/proposal/)).not.toBeNull();
  });

  it("keeps writes disabled by missing actor or organization scope", async () => {
    render(<SalesQuoteWorkspace actorId={null} organizationId={organizationId} baseCurrency="USD" />);
    fireEvent.click(await screen.findByRole("button", { name: "Create quote" }));
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: customerId } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Consulting" } });
    fireEvent.change(screen.getByLabelText("Unit price"), { target: { value: "10.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Create and send quote" }));
    expect((await screen.findByRole("alert")).textContent).toContain("active actor and workspace are required");
    expect(createSalesQuote).not.toHaveBeenCalled();
  });
});
