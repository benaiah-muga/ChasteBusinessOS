import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PurchasingAgingPage } from "./PurchasingAgingPage";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const enabledSwitchboard = { catalog: [{ id: "purchasing" }], enabledModules: ["purchasing"] };
const buckets = { current: 1200, d30: 300, d60: 200, d90plus: 100, totalOutstanding: 1800 };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PurchasingAgingPage", () => {
  it("shows the Go aging bands in workspace currency and links bill actions to Purchasing", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(enabledSwitchboard))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { buckets } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingAgingPage baseCurrency="BHD" organizationId="org-test" />);

    expect(screen.getByRole("status").textContent).toContain("Loading payable balances");
    expect(await screen.findByRole("heading", { name: /BHD\s+1\.800/ })).toBeTruthy();
    expect(screen.getByText(/BHD\s+0\.600/)).toBeTruthy();
    expect(screen.getByRole("row", { name: /31-60 days.*BHD\s+0\.300/ })).toBeTruthy();
    expect(screen.getByRole("img", { name: /Payables by age: Current BHD\s+1\.200/ })).toBeTruthy();
    const workspaceLink = screen.getByRole("link", { name: "Open full Purchasing workspace" }) as HTMLAnchorElement;
    expect(workspaceLink.getAttribute("href")).toBe("/purchasing?tab=bills");
    expect(new URL(workspaceLink.href).origin).toBe(window.location.origin);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/modules", "/api/capabilities/execute"]);
  });

  it("uses the Go A/P aging capability and falls back to workspace currency", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(enabledSwitchboard))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { buckets } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingAgingPage baseCurrency="UGX" organizationId="org-test" />);

    expect(await screen.findByRole("heading", { name: /UGX\s+1,800/ })).toBeTruthy();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/modules", "/api/capabilities/execute"]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      capabilityId: "purchasing.apAging",
      input: {},
      intentId: expect.any(String),
    });
  });

  it("shows a clear zero-balance state without hiding the aging rows", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse(enabledSwitchboard))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { buckets: { current: 0, d30: 0, d60: 0, d90plus: 0, totalOutstanding: 0 } } })));
    render(<PurchasingAgingPage baseCurrency="UGX" organizationId="org-test" />);

    expect(await screen.findByText("No unpaid balance")).toBeTruthy();
    expect(screen.getByRole("row", { name: /Over 90 days 91\+ days.*UGX/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /UGX\s+0/ })).toBeTruthy();
  });

  it("reports malformed reports and can retry after a permission or service error", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(enabledSwitchboard))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { buckets: { ...buckets, current: -1 } } }))
      .mockResolvedValueOnce(jsonResponse(enabledSwitchboard))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { buckets } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingAgingPage baseCurrency="BHD" organizationId="org-test" />);

    expect(await screen.findByRole("heading", { name: "Could not load payable balances" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /BHD\s+1\.800/ })).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not request aging data when Purchasing is disabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ catalog: [{ id: "purchasing" }], enabledModules: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingAgingPage organizationId="org-test" />);

    expect(await screen.findByRole("heading", { name: "Purchasing is turned off" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
