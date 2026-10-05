import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketingPage } from "./MarketingPage";

const segmentId = "0f3d0f52-4a51-4c6a-9a52-6f7a2e5c9b11";
const campaignId = "b6f4b0e2-2f2c-4a55-9d2e-8a2a2b7c4f10";

const segment = { id: segmentId, name: "Big spenders", minSpendMinor: 250_000, createdAt: "2026-09-18T08:00:00.000Z" };
const draftCampaign = {
  id: campaignId,
  segmentId,
  name: "Spring renewal",
  subject: "Your renewal",
  body: "Here is what changed.",
  queuedAt: null,
  createdAt: "2026-09-19T09:30:00.000Z",
};

function modules(enabled = true) {
  return Response.json({
    catalog: [{ id: "marketing", label: "Marketing", description: "Segments and campaigns", href: "/marketing" }],
    enabledModules: enabled ? ["marketing"] : [],
    usingDefaults: false,
  });
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return Response.json({
    segments: [segment],
    campaigns: [draftCampaign],
    sendCounts: [],
    recentSends: [],
    ...overrides,
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Each case renders a full page with its scoped stylesheet, so jsdom pays the
// CSS parse on the first render of a file. A loaded machine needs more than the
// default 5s budget for that warmup.
const PAGE_TEST_TIMEOUT = 20_000;

describe("Vite marketing page", () => {
  it("renders the append-only send log without claiming anything was delivered", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      if (path === "/api/marketing") {
        return snapshot({
          campaigns: [{ ...draftCampaign, queuedAt: "2026-09-20T09:30:00.000Z" }],
          sendCounts: [{ campaignId, count: 1 }],
          recentSends: [
            {
              id: "5c3f7c5c-9a2a-4d3e-8c0b-1f2a3b4c5d6e",
              campaignId,
              customerName: "Northwind",
              customerEmail: "contact@northwind.test",
              queuedAt: "2026-09-20T09:30:00.000Z",
              status: "sent",
              sentAt: "2026-09-20T09:31:00.000Z",
            },
            {
              id: "6d4a8d6d-0b3b-4e4f-9d1c-2a3b4c5d6e7f",
              campaignId,
              customerName: "Opted out Ltd",
              customerEmail: null,
              queuedAt: "2026-09-20T09:30:00.000Z",
              status: "pending",
              sentAt: null,
            },
          ],
        });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketingPage baseCurrency="USD" />);

    expect(await screen.findByRole("heading", { name: "Marketing", level: 1 })).not.toBeNull();
    expect(screen.getByText(/1 provider-confirmed/)).not.toBeNull();
    expect(screen.getByText("delivered")).not.toBeNull();
    expect(screen.getByText("queued, not confirmed")).not.toBeNull();
    expect(screen.getByText(/No pixels, no open tracking, no click capture/)).not.toBeNull();
  }, PAGE_TEST_TIMEOUT);

  it("creates a segment through the governed path and keeps money in minor units", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      if (path === "/api/marketing" && init?.method === "POST") {
        const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(payload).toMatchObject({ action: "createSegment", name: "Wholesale", minSpendMinor: 125_050 });
        expect(payload.intentId).toEqual(expect.any(String));
        return Response.json({ ok: true, data: { segmentId } });
      }
      if (path === "/api/marketing") return snapshot();
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketingPage baseCurrency="USD" />);
    await screen.findByRole("heading", { name: "Marketing", level: 1 });

    fireEvent.change(screen.getByLabelText("Segment name"), { target: { value: "Wholesale" } });
    fireEvent.change(screen.getByLabelText("Min lifetime spend"), { target: { value: "1250.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Create segment" }));

    expect(await screen.findByText(/Segment saved\./)).not.toBeNull();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ minSpendMinor: 125_050 });
  }, PAGE_TEST_TIMEOUT);

  it("refuses an amount it cannot read as minor units instead of rounding it away", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => (String(input) === "/api/modules" ? modules() : snapshot()));
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketingPage baseCurrency="USD" />);
    await screen.findByRole("heading", { name: "Marketing", level: 1 });

    fireEvent.change(screen.getByLabelText("Segment name"), { target: { value: "Broken" } });
    fireEvent.change(screen.getByLabelText("Min lifetime spend"), { target: { value: "ten dollars" } });
    fireEvent.click(screen.getByRole("button", { name: "Create segment" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Enter the minimum lifetime spend");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  }, PAGE_TEST_TIMEOUT);

  it("surfaces an approval-pending send as pending, never as a delivery", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      if (path === "/api/marketing" && init?.method === "POST") {
        return Response.json({ ok: false, pendingApproval: true, reason: "marketing.write needs approval" }, { status: 202 });
      }
      if (path === "/api/marketing") return snapshot();
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketingPage baseCurrency="USD" />);
    await screen.findByRole("heading", { name: "Marketing", level: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("marketing.write needs approval")).not.toBeNull();
    expect(screen.queryByText(/Those rows are queued, not delivered/)).toBeNull();
  }, PAGE_TEST_TIMEOUT);

  it("counts what was queued and says plainly that it is not delivery", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      if (path === "/api/marketing" && init?.method === "POST") {
        const payload = JSON.parse(String(init.body)) as { action?: string };
        if (payload.action !== "sendCampaign") return Response.json({ error: "unexpected" }, { status: 400 });
        return Response.json({ ok: true, data: { recipients: 3, skippedOptOut: 1, skippedNoAddress: 2, alreadySent: 0 } });
      }
      if (path === "/api/marketing") return snapshot();
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketingPage baseCurrency="USD" />);
    await screen.findByRole("heading", { name: "Marketing", level: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(/Those rows are queued, not delivered: only the send log below can say a provider acknowledged them\./)).not.toBeNull();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Queued 3 recipients, 1 opted-out skipped, 2 without an address skipped"));
  }, PAGE_TEST_TIMEOUT);

  it("reports provider-confirmed deliveries only through the analytics capability", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      if (path === "/api/marketing" && init?.method === "POST") {
        return Response.json({ ok: true, data: { campaignName: "Spring renewal", sentCount: 2, queuedAt: "2026-09-20T09:30:00.000Z" } });
      }
      if (path === "/api/marketing") return snapshot();
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketingPage baseCurrency="USD" />);
    await screen.findByRole("heading", { name: "Marketing", level: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Analytics" }));

    expect(await screen.findByText(/2 provider-confirmed deliveries/)).not.toBeNull();
  }, PAGE_TEST_TIMEOUT);

  it("does not read marketing data while the module is disabled", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => (String(input) === "/api/modules" ? modules(false) : snapshot()));
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketingPage baseCurrency="USD" />);

    expect(await screen.findByText("Marketing is disabled")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, PAGE_TEST_TIMEOUT);
});