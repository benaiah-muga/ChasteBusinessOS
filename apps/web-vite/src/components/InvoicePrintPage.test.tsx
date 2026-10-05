import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as invoiceApi from "../api/print-invoice";
import type { PrintInvoice } from "../api/print-invoice";
import { InvoicePrintPage } from "./InvoicePrintPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const invoice: PrintInvoice = {
  order: {
    number: 1042,
    status: "sent",
    createdAt: "2026-03-04T10:00:00.000Z",
    customerName: "Acme",
    customerEmail: null,
    paymentTermDays: 30,
    orgName: "Acme Trading",
  },
  lines: [{ description: "Widget", quantity: 2000, unitPriceMinor: 1250, taxMinor: 100 }],
  branding: { accentColor: "#112233", invoiceFooter: "Thanks", layout: "modern" },
};

describe("InvoicePrintPage", () => {
  it("announces loading and renders the branded invoice after authorization", async () => {
    vi.spyOn(invoiceApi, "fetchPrintInvoice").mockResolvedValue({ status: "ok", invoice });

    render(<InvoicePrintPage pathname="/print/invoice/order-1" />);

    expect(screen.getByRole("status").textContent).toBe("Loading this invoice.");
    expect(await screen.findByRole("heading", { name: "Acme Trading" })).toBeTruthy();
    expect(screen.getByText("Invoice #1042")).toBeTruthy();
    expect(screen.getAllByText("25.00")).toHaveLength(2);
  });

  it("renders customer content as text instead of interpreting markup", async () => {
    const hostileInvoice = structuredClone(invoice);
    hostileInvoice.order.orgName = "<img src=x onerror=alert(1)>";
    hostileInvoice.lines[0]!.description = "<script>alert(1)</script>";
    vi.spyOn(invoiceApi, "fetchPrintInvoice").mockResolvedValue({ status: "ok", invoice: hostileInvoice });

    render(<InvoicePrintPage pathname="/print/invoice/order-1" />);

    expect(await screen.findByRole("heading", { name: "<img src=x onerror=alert(1)>" })).toBeTruthy();
    expect(screen.getByText("<script>alert(1)</script>")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("shows a sign-in error and does not request an invalid encoded path", async () => {
    const fetchInvoice = vi.spyOn(invoiceApi, "fetchPrintInvoice").mockResolvedValue({ status: "unauthorized" });

    render(<InvoicePrintPage pathname="/print/invoice/%E0%A4%A" />);

    expect((await screen.findByRole("alert")).textContent).toBe("Sign in to view this invoice.");
    expect(fetchInvoice).toHaveBeenCalledWith("");
  });
});
