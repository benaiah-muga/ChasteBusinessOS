import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PurchasingAgingPage } from "./PurchasingAgingPage";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const enabledSwitchboard = { catalog: [{ id: "purchasing" }], enabledModules: ["purchasing"] };
const report = {
  baseCurrency: "BHD",
  apAging: { buckets: { current: 1200, d30: 300, d60: 200, d90plus: 100, totalOutstanding: 1800 } },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PurchasingAgingPage", () => {
  it("shows the aging bands in the workspace currency and links bill actions to Purchasing", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(enabledSwitchboard))
      .mockResolvedValueOnce(jsonResponse(report));
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingAgingPage />);

    expect(screen.getByRole("status").textContent).toContain("Loading payable balances");
    expect(await screen.findByRole("heading", { name: /BHD\s+1\.800/ })).toBeTruthy();
    expect(screen.getByText(/BHD\s+0\.600/)).toBeTruthy();
    expect(screen.getByRole("row", { name: /31-60 days.*BHD\s+0\.300/ })).toBeTruthy();
    expect(screen.getByRole("img", { name: /Payables by age: Current BHD\s+1\.200/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open full Purchasing workspace" }).getAttribute("href")).toContain("/purchasing?tab=bills");
    expect(fetchMock).toHaveBeenCalledWith("/api/purchasing", expect.objectContaining({ credentials: "same-origin" }));
  });

  it("shows a clear zero-balance state without hiding the aging rows", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse(enabledSwitchboard))
      .mockResolvedValueOnce(jsonResponse({
        baseCurrency: "UGX",
        apAging: { buckets: { current: 0, d30: 0, d60: 0, d90plus: 0, totalOutstanding: 0 } },
      })));
    render(<PurchasingAgingPage />);

    expect(await screen.findByText("No unpaid balance")).toBeTruthy();
    expect(screen.getByRole("row", { name: /Over 90 days 91\+ days.*UGX/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /UGX\s+0/ })).toBeTruthy();
  });

  it("reports malformed reports and can retry after a permission or service error", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(enabledSwitchboard))
      .mockResolvedValueOnce(jsonResponse({ baseCurrency: "BHD", apAging: { buckets: { current: -1 } } }))
      .mockResolvedValueOnce(jsonResponse(enabledSwitchboard))
      .mockResolvedValueOnce(jsonResponse(report));
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingAgingPage />);

    expect(await screen.findByRole("heading", { name: "Could not load payable balances" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /BHD\s+1\.800/ })).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not request aging data when Purchasing is disabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ catalog: [{ id: "purchasing" }], enabledModules: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingAgingPage />);

    expect(await screen.findByRole("heading", { name: "Purchasing is turned off" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
