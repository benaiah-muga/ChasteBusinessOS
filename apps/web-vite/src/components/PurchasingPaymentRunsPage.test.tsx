import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PurchasingPaymentRunsPage } from "./PurchasingPaymentRunsPage";

const run = {
  id: "11111111-1111-4111-8111-111111111111",
  reference: "PR-2026-0042",
  currency: "BHD",
  totalMinor: 1234,
  status: "instructed",
  createdAt: "2026-09-29T08:15:00.000Z",
  instructedAt: "2026-09-29T08:20:00.000Z",
  confirmedAt: null,
  entryId: "22222222-2222-4222-8222-222222222222",
  lines: [{
    billId: "33333333-3333-4333-8333-333333333333",
    billNumber: 17,
    vendorName: "Harbor Supplies",
    vendorRef: "HS-17",
    amountMinor: 1234,
  }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const enabledSwitchboard = { catalog: [{ id: "purchasing" }], enabledModules: ["purchasing"] };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PurchasingPaymentRunsPage", () => {
  it("renders payment and remittance details using the run currency minor units", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(enabledSwitchboard))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { runs: [run] } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingPaymentRunsPage />);

    expect(screen.getByRole("status").textContent).toContain("Loading supplier payment runs");
    expect(await screen.findByText("PR-2026-0042")).toBeTruthy();
    expect(screen.getAllByText(/BHD\s+1\.234/)).toHaveLength(2);
    expect(screen.getByText("Harbor Supplies")).toBeTruthy();
    expect(screen.getByText("HS-17")).toBeTruthy();
    expect(screen.getAllByText("Instructed")).toHaveLength(2);
    const workspaceLink = screen.getByRole("link", { name: "Open full Purchasing workspace" });
    expect(workspaceLink.getAttribute("href")).toMatch(/\/purchasing$/);
    expect(fetchMock).toHaveBeenCalledWith("/api/purchasing/payment-runs", expect.objectContaining({ credentials: "same-origin" }));
  });

  it("shows the no-runs state", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse(enabledSwitchboard))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { runs: [] } })));
    render(<PurchasingPaymentRunsPage />);

    expect(await screen.findByRole("heading", { name: "No supplier payment runs yet" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open full Purchasing workspace" })).toBeTruthy();
  });

  it("preserves permission messaging and offers sign-in for expired sessions", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse(enabledSwitchboard))
      .mockResolvedValueOnce(jsonResponse({ error: "Sign in required" }, 401)));
    render(<PurchasingPaymentRunsPage />);

    expect(await screen.findByRole("heading", { name: "Sign in again" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe("/login");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("can retry after the Go read is unavailable", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(enabledSwitchboard))
      .mockResolvedValueOnce(jsonResponse({ error: "purchasing service unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse(enabledSwitchboard))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { runs: [run] } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingPaymentRunsPage />);

    expect(await screen.findByRole("heading", { name: "Could not load payment runs" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("PR-2026-0042")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not request payment runs when Purchasing is disabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ catalog: [{ id: "purchasing" }], enabledModules: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingPaymentRunsPage />);

    expect(await screen.findByRole("heading", { name: "Purchasing is turned off" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/modules", expect.any(Object));
  });
});
