import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketingPage } from "./MarketingPage";

const segmentId = "0f3d0f52-4a51-4c6a-9a52-6f7a2e5c9b11";
const campaignId = "b6f4b0e2-2f2c-4a55-9d2e-8a2a2b7c4f10";
const actorId = "5c3f7c5c-9a2a-4d3e-8c0b-1f2a3b4c5d6e";
const organizationId = "6d4a8d6d-0b3b-4e4f-9d1c-2a3b4c5d6e7f";

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
  window.localStorage.clear();
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

  it("hides the previous organization campaign data and analytics while reloading the new scope", async () => {
    let marketingReads = 0;
    let finishNextSnapshot!: (response: Response) => void;
    const nextSnapshot = new Promise<Response>((resolve) => { finishNextSnapshot = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      if (path === "/api/marketing" && init?.method === "POST") {
        return Response.json({ ok: true, data: { campaignName: "Org A analytics", sentCount: 1, queuedAt: null } });
      }
      if (path === "/api/marketing") {
        marketingReads += 1;
        if (marketingReads <= 2) {
          return snapshot({
            campaigns: [{ ...draftCampaign, name: "Org A campaign" }],
            recentSends: [{
              id: "9b4fae02-ccbf-4c53-9b4d-a9a25b99ca8f",
              campaignId,
              customerName: "Org A contact",
              customerEmail: "a@example.test",
              queuedAt: "2026-09-20T09:30:00.000Z",
              status: "sent",
              sentAt: "2026-09-20T09:31:00.000Z",
            }],
          });
        }
        if (marketingReads === 3) return nextSnapshot;
        return snapshot({ campaigns: [{ ...draftCampaign, name: "Org B campaign" }] });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<MarketingPage actorId={actorId} organizationId={organizationId} />);
    expect(await screen.findByText("Org A campaign")).not.toBeNull();
    expect(screen.getByText(/Org A contact/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Analytics" }));
    expect(await screen.findByText(/Org A analytics: 1 provider-confirmed delivery/)).not.toBeNull();

    const nextOrganizationId = "aa8c635d-405e-4488-824c-a557b1c1fbe1";
    view.rerender(<MarketingPage actorId={actorId} organizationId={nextOrganizationId} />);
    expect(screen.queryByText("Org A campaign")).toBeNull();
    expect(screen.queryByText(/Org A contact/)).toBeNull();
    expect(screen.queryByText(/Org A analytics/)).toBeNull();
    await waitFor(() => expect(marketingReads).toBe(3));

    finishNextSnapshot(snapshot({ campaigns: [{ ...draftCampaign, name: "Org B campaign" }] }));
    expect(await screen.findByText("Org B campaign")).not.toBeNull();
    expect(screen.queryByText("Org A campaign")).toBeNull();
    expect(screen.queryByText(/Org A contact/)).toBeNull();
    expect(screen.queryByText(/Org A analytics/)).toBeNull();
  }, PAGE_TEST_TIMEOUT);

  it("restores an uncertain campaign draft after reload and retries with the same intent", async () => {
    vi.stubGlobal("__GO_MARKETING_CAMPAIGN_WRITES__", true);
    let postAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      if (path === "/api/marketing" && init?.method !== "POST") return snapshot();
      if (path === "/api/capabilities/execute" && init?.method === "POST") {
        postAttempts += 1;
        if (postAttempts === 1) throw new TypeError("connection lost after submit");
        return Response.json({ ok: false, pendingApproval: true, reason: "Campaign needs approval" }, { status: 202 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const props = { actorId, organizationId };

    render(<MarketingPage {...props} />);
    await screen.findByRole("heading", { name: "Marketing", level: 1 });
    await waitFor(() => expect((screen.getByLabelText("Campaign name") as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Segment"), { target: { value: segmentId } });
    fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: "Spring renewal retry" } });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Renewal details" } });
    fireEvent.change(screen.getByLabelText("Body"), { target: { value: "The exact pending campaign text." } });
    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    expect(await screen.findByText(/Could not reach the marketing service/)).not.toBeNull();
    expect((screen.getByLabelText("Campaign name") as HTMLInputElement).value).toBe("Spring renewal retry");
    const firstCall = fetchMock.mock.calls.find(([path, init]) => String(path) === "/api/capabilities/execute" && init?.method === "POST");
    const firstBody = JSON.parse(String(firstCall?.[1]?.body)) as Record<string, unknown>;
    expect((screen.getByLabelText("Campaign name") as HTMLInputElement).disabled).toBe(true);

    cleanup();
    render(<MarketingPage {...props} />);
    await waitFor(() => expect((screen.getByLabelText("Campaign name") as HTMLInputElement).value).toBe("Spring renewal retry"));
    expect((screen.getByLabelText("Body") as HTMLTextAreaElement).value).toBe("The exact pending campaign text.");
    expect((screen.getByLabelText("Campaign name") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry campaign attempt" }));
    await screen.findByText("Campaign needs approval");
    const goCalls = fetchMock.mock.calls.filter(([path, init]) => String(path) === "/api/capabilities/execute" && init?.method === "POST");
    const secondBody = JSON.parse(String(goCalls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(secondBody.input).toEqual({ segmentId, name: "Spring renewal retry", subject: "Renewal details", body: "The exact pending campaign text." });
    expect(secondBody.intentId).toBe(firstBody.intentId);
  }, PAGE_TEST_TIMEOUT);

  it("gates campaign actions immediately when the active scope changes", async () => {
    vi.stubGlobal("__GO_MARKETING_CAMPAIGN_WRITES__", true);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => (String(input) === "/api/modules" ? modules() : snapshot()));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<MarketingPage actorId={actorId} organizationId={organizationId} />);
    await waitFor(() => expect((screen.getByLabelText("Campaign name") as HTMLInputElement).disabled).toBe(false));

    const nextActorId = "aa8c635d-405e-4488-824c-a557b1c1fbe1";
    view.rerender(<MarketingPage actorId={nextActorId} organizationId={organizationId} />);
    expect(screen.queryByLabelText("Campaign name")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Checking whether marketing is available");
    await waitFor(() => expect((screen.getByLabelText("Campaign name") as HTMLInputElement).disabled).toBe(false));
  }, PAGE_TEST_TIMEOUT);

  it("does not let a stale create response overwrite the next organization draft", async () => {
    vi.stubGlobal("__GO_MARKETING_CAMPAIGN_WRITES__", true);
    const finishCreates: Array<(response: Response) => void> = [];
    let createRequestsStarted = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      if (path === "/api/marketing" && init?.method !== "POST") return snapshot();
      if (path === "/api/capabilities/execute" && init?.method === "POST") {
        createRequestsStarted += 1;
        return new Promise<Response>((resolve) => { finishCreates.push(resolve); });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<MarketingPage actorId={actorId} organizationId={organizationId} />);
    await waitFor(() => expect((screen.getByLabelText("Campaign name") as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Segment"), { target: { value: segmentId } });
    fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: "Organization A campaign" } });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Organization A subject" } });
    fireEvent.change(screen.getByLabelText("Body"), { target: { value: "Organization A body" } });
    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    await waitFor(() => expect(createRequestsStarted).toBe(1));

    const nextActorId = "aa8c635d-405e-4488-824c-a557b1c1fbe1";
    const nextScopeIdentity = JSON.stringify({ actorId: nextActorId, organizationId });
    const nextScopeHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nextScopeIdentity));
    const nextScopeHex = Array.from(new Uint8Array(nextScopeHash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    window.localStorage.setItem(`chaste.marketing.campaign-draft.v1:${nextScopeHex}`, JSON.stringify({
      campaignForm: { segmentId, name: "Organization B campaign", subject: "Organization B subject", body: "Organization B body" },
      unresolved: false,
    }));
    view.rerender(<MarketingPage actorId={nextActorId} organizationId={organizationId} />);
    await waitFor(() => expect((screen.getByLabelText("Campaign name") as HTMLInputElement).value).toBe("Organization B campaign"));
    await waitFor(() => expect((screen.getByLabelText("Campaign name") as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    await waitFor(() => expect(createRequestsStarted).toBe(2));
    expect((screen.getByLabelText("Campaign name") as HTMLInputElement).disabled).toBe(true);

    finishCreates[0]?.(Response.json({ ok: true, data: { campaignId } }));
    await waitFor(() => expect((screen.getByLabelText("Campaign name") as HTMLInputElement).disabled).toBe(true));
    expect((screen.getByLabelText("Campaign name") as HTMLInputElement).value).toBe("Organization B campaign");
    expect((screen.getByLabelText("Body") as HTMLTextAreaElement).value).toBe("Organization B body");
    expect(screen.queryByText("Campaign drafted. Nothing goes out until you press Send.")).toBeNull();

    finishCreates[1]?.(Response.json({ ok: false, pendingApproval: true, reason: "Org B needs approval" }, { status: 202 }));
    expect(await screen.findByText("Org B needs approval")).not.toBeNull();
    expect((screen.getByLabelText("Campaign name") as HTMLInputElement).value).toBe("Organization B campaign");
  }, PAGE_TEST_TIMEOUT);

  it("keeps an old A response stale after switching A to B to A", async () => {
    vi.stubGlobal("__GO_MARKETING_CAMPAIGN_WRITES__", true);
    const nextActorId = "aa8c635d-405e-4488-824c-a557b1c1fbe1";
    const finishCreates: Array<(response: Response) => void> = [];
    let createRequestsStarted = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      if (path === "/api/marketing" && init?.method !== "POST") return snapshot();
      if (path === "/api/capabilities/execute" && init?.method === "POST") {
        createRequestsStarted += 1;
        return new Promise<Response>((resolve) => { finishCreates.push(resolve); });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<MarketingPage actorId={actorId} organizationId={organizationId} />);
    await waitFor(() => expect((screen.getByLabelText("Campaign name") as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Segment"), { target: { value: segmentId } });
    fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: "Organization A campaign" } });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Organization A subject" } });
    fireEvent.change(screen.getByLabelText("Body"), { target: { value: "Organization A body" } });
    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    await waitFor(() => expect(createRequestsStarted).toBe(1));

    view.rerender(<MarketingPage actorId={nextActorId} organizationId={organizationId} />);
    await screen.findByRole("heading", { name: "Marketing", level: 1 });
    view.rerender(<MarketingPage actorId={actorId} organizationId={organizationId} />);
    await waitFor(() => expect((screen.getByLabelText("Campaign name") as HTMLInputElement).value).toBe("Organization A campaign"));
    expect((screen.getByLabelText("Campaign name") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry campaign attempt" }));
    await waitFor(() => expect(createRequestsStarted).toBe(2));
    const campaignForm = within(screen.getByLabelText("Campaign name").closest("form")!);
    expect(campaignForm.getByRole("button", { name: "Working…" })).not.toBeNull();

    finishCreates[0]?.(Response.json({ ok: true, data: { campaignId } }));
    await waitFor(() => expect((screen.getByLabelText("Campaign name") as HTMLInputElement).value).toBe("Organization A campaign"));
    expect((screen.getByLabelText("Campaign name") as HTMLInputElement).disabled).toBe(true);
    expect(campaignForm.getByRole("button", { name: "Working…" })).not.toBeNull();
    expect(screen.queryByText("Campaign drafted. Nothing goes out until you press Send.")).toBeNull();

    finishCreates[1]?.(Response.json({ ok: false, pendingApproval: true, reason: "Current A needs approval" }, { status: 202 }));
    expect(await screen.findByText("Current A needs approval")).not.toBeNull();
    expect((screen.getByLabelText("Campaign name") as HTMLInputElement).value).toBe("Organization A campaign");
  }, PAGE_TEST_TIMEOUT);

  it("routes campaign sends through Go and preserves the queued-not-delivered result", async () => {
    vi.stubGlobal("__GO_MARKETING_CAMPAIGN_WRITES__", true);
    let snapshotCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      if (path === "/api/marketing" && init?.method !== "POST") {
        snapshotCount += 1;
        return snapshot(snapshotCount > 1 ? { campaigns: [{ ...draftCampaign, queuedAt: "2026-09-20T09:30:00.000Z" }] } : {});
      }
      if (path === "/api/capabilities/execute" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body).toMatchObject({ capabilityId: "marketing.sendCampaign", input: { campaignId } });
        return Response.json({ ok: true, data: { recipients: 3, skippedOptOut: 1, skippedNoAddress: 2, alreadySent: 0 } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketingPage actorId={actorId} organizationId={organizationId} />);
    await screen.findByRole("heading", { name: "Marketing", level: 1 });
    await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(/Those rows are queued, not delivered/)).not.toBeNull();
    await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getAllByText(/Queued 3 recipients, 1 opted-out skipped, 2 without an address skipped/).length).toBeGreaterThan(0);
  }, PAGE_TEST_TIMEOUT);

  it("does not read marketing data while the module is disabled", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => (String(input) === "/api/modules" ? modules(false) : snapshot()));
    vi.stubGlobal("fetch", fetchMock);

    render(<MarketingPage baseCurrency="USD" />);

    expect(await screen.findByText("Marketing is disabled")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, PAGE_TEST_TIMEOUT);
});
