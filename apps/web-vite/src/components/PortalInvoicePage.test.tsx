import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as portalApi from "../api/portal";
import { PortalInvoicePage } from "./PortalInvoicePage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PortalInvoicePage", () => {
  it("announces loading, then renders the token-scoped invoice", async () => {
    vi.spyOn(portalApi, "fetchPortalInvoice").mockResolvedValue({
      status: "ok",
      invoice: {
        number: 77,
        status: "sent",
        currency: "USD",
        totalMinor: 5000,
        creditedMinor: 0,
        paidMinor: 1000,
        outstandingMinor: 4000,
        issuedAt: "2026-02-01T00:00:00.000Z",
        customerName: "Acme",
        lines: [{ description: "Widget", quantity: 2000, unitPriceMinor: 250, taxMinor: 0 }],
      },
    });

    render(<PortalInvoicePage pathname="/portal/share-token-1234567890123456" />);
    expect(screen.getByRole("status", { name: "Loading invoice" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Invoice #77" })).toBeTruthy();
    expect(screen.getByText("Outstanding")).toBeTruthy();
    expect(screen.getByText("USD 40.00")).toBeTruthy();
  });

  it("announces invalid links and throttling as errors", async () => {
    const fetchInvoice = vi.spyOn(portalApi, "fetchPortalInvoice");
    fetchInvoice.mockResolvedValueOnce({ status: "not-found" });
    const first = render(<PortalInvoicePage pathname="/portal/share-token-1234567890123456" />);
    expect((await screen.findByRole("alert")).textContent).toContain("This link is not valid.");
    first.unmount();

    fetchInvoice.mockResolvedValueOnce({ status: "rate-limited" });
    render(<PortalInvoicePage pathname="/portal/share-token-1234567890123456" />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Too many requests"));
  });

  it("does not show the previous invoice while a different share token loads", async () => {
    const fetchInvoice = vi.spyOn(portalApi, "fetchPortalInvoice").mockResolvedValueOnce({
      status: "ok",
      invoice: {
        number: 77,
        status: "sent",
        currency: "USD",
        totalMinor: 5000,
        creditedMinor: 0,
        paidMinor: 1000,
        outstandingMinor: 4000,
        issuedAt: "2026-02-01T00:00:00.000Z",
        customerName: "Acme",
        lines: [{ description: "Widget", quantity: 2000, unitPriceMinor: 250, taxMinor: 0 }],
      },
    }).mockImplementationOnce(() => new Promise(() => {}));

    const firstToken = "/portal/share-token-1234567890123456";
    const secondToken = "/portal/other-share-token-12345678901234";
    const view = render(<PortalInvoicePage pathname={firstToken} />);
    expect(await screen.findByRole("heading", { name: "Invoice #77" })).toBeTruthy();

    view.rerender(<PortalInvoicePage pathname={secondToken} />);

    expect(screen.queryByRole("heading", { name: "Invoice #77" })).toBeNull();
    expect(screen.getByRole("status", { name: "Loading invoice" })).toBeTruthy();
    await waitFor(() => expect(fetchInvoice).toHaveBeenCalledTimes(2));
  });

  it("does not throw or request an invoice for malformed percent encoding", async () => {
    const fetchInvoice = vi.spyOn(portalApi, "fetchPortalInvoice");
    fetchInvoice.mockResolvedValue({ status: "not-found" });

    render(<PortalInvoicePage pathname="/portal/%E0%A4%A" />);
    expect((await screen.findByRole("alert")).textContent).toContain("This link is not valid.");
    expect(fetchInvoice).toHaveBeenCalledWith("", expect.any(AbortSignal));
  });
});
