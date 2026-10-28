import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SalesQuoteWorkspace } from "./SalesQuoteWorkspace";
import { acceptSalesQuote, createOrderFromSalesQuote, createSalesQuote, declineSalesQuote, fetchSalesQuoteCustomers, fetchSalesQuoteDeals, fetchSalesQuotes } from "../api/sales-quotes";

vi.mock("../api/sales-quotes", () => ({
  SALES_QUOTE_DATABASE_INTEGER_MAX: 2_147_483_647,
  SalesQuoteApiError: class SalesQuoteApiError extends Error { status = 0; },
  acceptSalesQuote: vi.fn(),
  createOrderFromSalesQuote: vi.fn(),
  createSalesQuote: vi.fn(),
  declineSalesQuote: vi.fn(),
  fetchSalesQuoteCustomers: vi.fn(),
  fetchSalesQuoteDeals: vi.fn(),
  fetchSalesQuotes: vi.fn(),
}));

const actorId = "10000000-0000-4000-8000-000000000001";
const organizationId = "10000000-0000-4000-8000-000000000002";
const customerId = "20000000-0000-4000-8000-000000000001";
const quoteId = "30000000-0000-4000-8000-000000000001";
const customer = { id: customerId, name: "Acme Foods", email: "buy@acme.test" };
const quote = { id: quoteId, number: 25, status: "sent" as const, totalMinor: 12500, customerId, createdAt: "2026-10-01T10:00:00.000Z", expiresAt: null, invoiceId: null, orderId: null };
const otherCustomer = { id: "20000000-0000-4000-8000-000000000002", name: "Globex", email: null };
const otherQuote = { ...quote, id: "30000000-0000-4000-8000-000000000002", number: 26, customerId: otherCustomer.id };

beforeEach(() => {
  vi.mocked(fetchSalesQuotes).mockResolvedValue([quote]);
  vi.mocked(fetchSalesQuoteCustomers).mockResolvedValue([customer]);
  vi.mocked(fetchSalesQuoteDeals).mockResolvedValue([{
    id: "60000000-0000-4000-8000-000000000001", title: "Website renewal", stage: "proposal", valueMinor: 250000,
    source: "Referral", ownerUserId: "70000000-0000-4000-8000-000000000001", ownerName: "Morgan Lee",
    note: null, customerId, customerName: customer.name, createdAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-02T10:00:00.000Z",
  }]);
  vi.mocked(createSalesQuote).mockResolvedValue({ kind: "completed", data: { quoteId: "30000000-0000-4000-8000-000000000002", quoteNumber: 26, totalMinor: 22500 } });
  vi.mocked(acceptSalesQuote).mockResolvedValue({ kind: "completed", data: { invoiceId: "40000000-0000-4000-8000-000000000001", invoiceNumber: 701, totalMinor: 12500 } });
  vi.mocked(createOrderFromSalesQuote).mockResolvedValue({ kind: "completed", data: { orderId: "80000000-0000-4000-8000-000000000001", orderNumber: 9, quoteNumber: 25, totalMinor: 12500 } });
  vi.mocked(declineSalesQuote).mockResolvedValue({ kind: "completed", data: { status: "declined" } });
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
    fireEvent.click(within(row).getByRole("button", { name: "Invoice immediately" }));
    await waitFor(() => expect(acceptSalesQuote).toHaveBeenCalledWith(quoteId, { actorId, organizationId }));
    expect((await screen.findByRole("status")).textContent).toContain("Quote #25 accepted. Invoice #701 was created.");
  });

  it("awards a sent quote into a sales order and points to fulfilment", async () => {
    const accepted = { ...quote, status: "accepted" as const, orderId: "80000000-0000-4000-8000-000000000001" };
    vi.mocked(fetchSalesQuotes).mockResolvedValueOnce([quote]).mockResolvedValue([accepted]);
    render(<SalesQuoteWorkspace actorId={actorId} organizationId={organizationId} baseCurrency="USD" />);
    const row = await screen.findByRole("row", { name: /#25 Acme Foods sent/ });
    fireEvent.click(within(row).getByRole("button", { name: "Create sales order" }));
    await waitFor(() => expect(createOrderFromSalesQuote).toHaveBeenCalledWith(quoteId, { actorId, organizationId }));
    expect((await screen.findByRole("status")).textContent).toContain("Quote #25 became sales order #9.");
    expect(screen.getByRole("link", { name: "Open sales order" }).getAttribute("href")).toBe("/sales");
  });

  it("declines a sent quote only after confirmation and refreshes the list", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SalesQuoteWorkspace actorId={actorId} organizationId={organizationId} baseCurrency="USD" />);
    const row = await screen.findByRole("row", { name: /#25 Acme Foods sent/ });
    fireEvent.click(within(row).getByRole("button", { name: "Decline quote" }));
    await waitFor(() => expect(declineSalesQuote).toHaveBeenCalledWith(quoteId, { actorId, organizationId }));
    expect(confirm).toHaveBeenCalledWith("Decline quote #25? This cannot be undone.");
    expect((await screen.findByRole("status")).textContent).toContain("Quote #25 declined.");
    expect(fetchSalesQuotes).toHaveBeenCalledTimes(2);
  });

  it("ignores a decline result and reload after switching organizations", async () => {
    let resolveDecline!: (result: Awaited<ReturnType<typeof declineSalesQuote>>) => void;
    const pendingDecline = new Promise<Awaited<ReturnType<typeof declineSalesQuote>>>((resolve) => { resolveDecline = resolve; });
    vi.mocked(declineSalesQuote).mockReturnValueOnce(pendingDecline);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { rerender } = render(<SalesQuoteWorkspace actorId={actorId} organizationId={organizationId} baseCurrency="USD" />);
    const firstRow = await screen.findByRole("row", { name: /#25 Acme Foods sent/ });
    fireEvent.click(within(firstRow).getByRole("button", { name: "Decline quote" }));
    await waitFor(() => expect(declineSalesQuote).toHaveBeenCalledWith(quoteId, { actorId, organizationId }));

    const salesReadCount = vi.mocked(fetchSalesQuotes).mock.calls.length;
    vi.mocked(fetchSalesQuotes).mockImplementation(async () => vi.mocked(fetchSalesQuotes).mock.calls.length > salesReadCount ? [otherQuote] : [quote]);
    const customerReadCount = vi.mocked(fetchSalesQuoteCustomers).mock.calls.length;
    vi.mocked(fetchSalesQuoteCustomers).mockImplementation(async () => vi.mocked(fetchSalesQuoteCustomers).mock.calls.length > customerReadCount ? [otherCustomer] : [customer]);
    rerender(<SalesQuoteWorkspace actorId={actorId} organizationId="10000000-0000-4000-8000-000000000003" baseCurrency="USD" />);

    expect(await screen.findByRole("row", { name: /#26 Globex sent/ })).not.toBeNull();
    expect(screen.queryByRole("row", { name: /#25 Acme Foods sent/ })).toBeNull();
    const callsAfterScopeChange = vi.mocked(fetchSalesQuotes).mock.calls.length;
    await act(async () => {
      resolveDecline({ kind: "completed", data: { status: "declined" } });
      await pendingDecline;
    });

    expect(screen.queryByText("Quote #25 declined.")).toBeNull();
    expect(vi.mocked(fetchSalesQuotes).mock.calls).toHaveLength(callsAfterScopeChange);
  });

  it("clears a prior action notice when the active organization changes", async () => {
    const { rerender } = render(<SalesQuoteWorkspace actorId={actorId} organizationId={organizationId} baseCurrency="USD" />);
    const row = await screen.findByRole("row", { name: /#25 Acme Foods sent/ });
    fireEvent.click(within(row).getByRole("button", { name: "Invoice immediately" }));
    expect((await screen.findByRole("status")).textContent).toContain("Quote #25 accepted.");

    const salesReadCount = vi.mocked(fetchSalesQuotes).mock.calls.length;
    vi.mocked(fetchSalesQuotes).mockImplementation(async () => vi.mocked(fetchSalesQuotes).mock.calls.length > salesReadCount ? [otherQuote] : [quote]);
    const customerReadCount = vi.mocked(fetchSalesQuoteCustomers).mock.calls.length;
    vi.mocked(fetchSalesQuoteCustomers).mockImplementation(async () => vi.mocked(fetchSalesQuoteCustomers).mock.calls.length > customerReadCount ? [otherCustomer] : [customer]);
    rerender(<SalesQuoteWorkspace actorId={actorId} organizationId="10000000-0000-4000-8000-000000000003" baseCurrency="USD" />);

    expect(screen.queryByText(/Quote #25 accepted\./)).toBeNull();
    expect(await screen.findByRole("row", { name: /#26 Globex sent/ })).not.toBeNull();
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
