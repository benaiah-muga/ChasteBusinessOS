import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchMarketingEnabled,
  fetchMarketingSnapshot,
  MarketingApiError,
  submitMarketingAction,
} from "./marketing";

const segmentId = "0f3d0f52-4a51-4c6a-9a52-6f7a2e5c9b11";
const campaignId = "b6f4b0e2-2f2c-4a55-9d2e-8a2a2b7c4f10";

const campaign = {
  id: campaignId,
  segmentId,
  name: "Spring renewal",
  subject: "Your renewal",
  body: "Here is what changed.",
  queuedAt: "2026-09-20T09:30:00.000Z",
  createdAt: "2026-09-19T09:30:00.000Z",
};

function modules(enabled = true) {
  return Response.json({
    catalog: [{ id: "marketing", label: "Marketing", description: "Segments and campaigns", href: "/marketing" }],
    enabledModules: enabled ? ["marketing"] : [],
    usingDefaults: false,
  });
}

function snapshot() {
  return {
    segments: [{ id: segmentId, name: "Big spenders", minSpendMinor: 250_000, createdAt: "2026-09-18T08:00:00.000Z" }],
    campaigns: [campaign],
    sendCounts: [{ campaignId, count: 1 }],
    recentSends: [{
      id: "5c3f7c5c-9a2a-4d3e-8c0b-1f2a3b4c5d6e",
      campaignId,
      customerName: "Northwind",
      customerEmail: "contact@northwind.test",
      queuedAt: "2026-09-20T09:30:00.000Z",
      status: "sent",
      sentAt: "2026-09-20T09:31:00.000Z",
    }],
  };
}

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("marketing reads", () => {
  it("turns a stalled snapshot read into a recoverable API error", async () => {
    const timeoutController = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Request timed out", "TimeoutError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const request = fetchMarketingSnapshot();
    expect(fetchMock).toHaveBeenCalledWith("/api/marketing", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    timeoutController.abort();
    await expect(request).rejects.toBeInstanceOf(MarketingApiError);
    await expect(request).rejects.toMatchObject({ status: 0, message: expect.stringContaining("marketing service") });
  });

  it("refuses a snapshot that is missing the honest send log", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      const body = snapshot() as Record<string, unknown>;
      delete body.recentSends;
      return Response.json(body);
    }));

    await expect(fetchMarketingSnapshot()).rejects.toMatchObject({
      name: "MarketingApiError",
      message: "The marketing service returned data in an unexpected format.",
    });
  });

  it("keeps money in integer minor units and reports the module state", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => (String(input) === "/api/modules" ? modules() : Response.json(snapshot())));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchMarketingEnabled()).resolves.toBe(true);
    const loaded = await fetchMarketingSnapshot();
    expect(loaded.segments[0]?.minSpendMinor).toBe(250_000);
    expect(Number.isInteger(loaded.segments[0]?.minSpendMinor)).toBe(true);
  });

  it("does not read campaign data while marketing is disabled", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => (String(input) === "/api/modules" ? modules(false) : Response.json(snapshot())));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchMarketingEnabled()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("marketing governed writes", () => {
  it("sends an idempotent intent and returns the completed output", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(payload).toMatchObject({ action: "createSegment", name: "Big spenders", minSpendMinor: 250_000 });
      expect(payload.intentId).toEqual(expect.any(String));
      return Response.json({ ok: true, data: { segmentId } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await submitMarketingAction({ action: "createSegment", name: "Big spenders", minSpendMinor: 250_000 });

    expect(outcome).toEqual({ kind: "completed", data: { segmentId } });
    expect(fetchMock).toHaveBeenCalledWith("/api/marketing", expect.objectContaining({ method: "POST", credentials: "same-origin" }));
  });

  it("creates a segment through the authenticated Go capability route when opted in", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(payload).toMatchObject({
        capabilityId: "marketing.createSegment",
        input: { name: "Big spenders", minSpendMinor: 250_000 },
        intentId: expect.any(String),
      });
      return Response.json({ ok: true, data: { segmentId } });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_MARKETING_SEGMENT_SLICE__", true);

    await expect(submitMarketingAction({ action: "createSegment", name: "Big spenders", minSpendMinor: 250_000 }))
      .resolves.toEqual({ kind: "completed", data: { segmentId } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    }));
  });

  it("preserves Go approval-pending behavior for segment creation", async () => {
    vi.stubGlobal("__GO_MARKETING_SEGMENT_SLICE__", true);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      {
        ok: false,
        pendingApproval: true,
        reason: "Marketing writes need approval.",
        approvalId: "dcfdc40d-b2bd-4a2d-b0c0-ae5401a792e1",
      },
      { status: 202 },
    )));

    await expect(submitMarketingAction({ action: "createSegment", name: "Big spenders", minSpendMinor: 250_000 }))
      .resolves.toEqual({ kind: "pending", reason: "Marketing writes need approval." });
  });

  it("fails closed instead of falling back when the Go segment route is absent", async () => {
    const intentId = "marketing-segment-intent";
    vi.stubGlobal("__GO_MARKETING_SEGMENT_SLICE__", true);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ error: "not found" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitMarketingAction({ action: "createSegment", name: "Big spenders", minSpendMinor: 250_000 }, intentId))
      .rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ intentId });
  });

  it("keeps legacy marketing actions as the default when the Go slice flag is off", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { segmentId } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitMarketingAction({ action: "createSegment", name: "Big spenders", minSpendMinor: 250_000 }))
      .resolves.toEqual({ kind: "completed", data: { segmentId } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/marketing", expect.objectContaining({ method: "POST" }));
  });

  it("reports an approval-pending write as pending, never as a completed send", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: false, pendingApproval: true, reason: "marketing.write needs approval" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await submitMarketingAction({ action: "sendCampaign", campaignId });

    expect(outcome).toEqual({ kind: "pending", reason: "marketing.write needs approval" });
  });

  it("refuses to read an approval response that is missing its envelope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ pendingApproval: true }, { status: 202 })));

    await expect(submitMarketingAction({ action: "sendCampaign", campaignId })).rejects.toMatchObject({
      name: "MarketingApiError",
      status: 202,
      message: "The marketing service returned an unexpected approval response.",
    });
  });

  it("surfaces the capability refusal instead of claiming the campaign went out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, error: "campaign already sent" }, { status: 422 })));

    await expect(submitMarketingAction({ action: "sendCampaign", campaignId })).rejects.toMatchObject({
      status: 422,
      message: "campaign already sent",
    });
  });

  it("does not report success when the action result violates its contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { recipients: "three" } })));

    await expect(submitMarketingAction({ action: "sendCampaign", campaignId })).rejects.toMatchObject({
      message: "The marketing service returned an unexpected action result.",
    });
  });

  it("refuses an action that does not validate before reaching the network", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitMarketingAction({ action: "sendCampaign", campaignId: "not-a-uuid" })).rejects.toMatchObject({
      name: "MarketingApiError",
      message: "The marketing action contains invalid details.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const retryScope = { actorId: "5c3f7c5c-9a2a-4d3e-8c0b-1f2a3b4c5d6e", organizationId: "6d4a8d6d-0b3b-4e4f-9d1c-2a3b4c5d6e7f" };
const createCampaignAction = { action: "createCampaign" as const, segmentId, name: "Spring renewal", subject: "Renewal", body: "A note" };

describe("marketing campaign Go routing", () => {
  it("routes createCampaign through Go with a durable scoped intent and strict output", async () => {
    vi.stubGlobal("__GO_MARKETING_CAMPAIGN_WRITES__", true);
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { campaignId: "7ed25b56-02d4-4f5b-b858-9681920abdd0" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitMarketingAction(createCampaignAction, undefined, retryScope)).resolves.toEqual({
      kind: "completed", data: { campaignId: "7ed25b56-02d4-4f5b-b858-9681920abdd0" },
    });
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(init.body))).toMatchObject({
      capabilityId: "marketing.createCampaign",
      input: { segmentId, name: "Spring renewal", subject: "Renewal", body: "A note" },
      intentId: expect.any(String),
    });
    expect(window.localStorage.length).toBe(0);
  });

  it("routes campaign analytics through the Go capability and validates its output envelope", async () => {
    vi.stubGlobal("__GO_MARKETING_CAMPAIGN_WRITES__", true);
    const fetchMock = vi.fn(async () => Response.json({
      ok: true,
      data: { campaignName: "Spring renewal", sentCount: 2, queuedAt: "2026-09-20T09:30:00.000Z" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitMarketingAction({ action: "campaignAnalytics", campaignId })).resolves.toEqual({
      kind: "completed",
      data: { campaignName: "Spring renewal", sentCount: 2, queuedAt: "2026-09-20T09:30:00.000Z" },
    });
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(init.body))).toMatchObject({
      capabilityId: "marketing.campaignAnalytics",
      input: { campaignId },
      intentId: expect.any(String),
    });
  });

  it("rejects malformed queued timestamps in a Go analytics result without a legacy retry", async () => {
    vi.stubGlobal("__GO_MARKETING_CAMPAIGN_WRITES__", true);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      ok: true,
      data: { campaignName: "Spring renewal", sentCount: 2, queuedAt: "soon" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitMarketingAction({ action: "campaignAnalytics", campaignId })).rejects.toMatchObject({
      message: "The marketing service returned an unexpected action result.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
  });

  it("reuses the exact send intent through pending and uncertain outcomes", async () => {
    vi.stubGlobal("__GO_MARKETING_CAMPAIGN_WRITES__", true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Needs review" }, { status: 202 }))
      .mockRejectedValueOnce(new TypeError("network lost"))
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Still waiting" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitMarketingAction({ action: "sendCampaign", campaignId }, undefined, retryScope)).resolves.toMatchObject({ kind: "pending" });
    await expect(submitMarketingAction({ action: "sendCampaign", campaignId }, undefined, retryScope)).rejects.toBeInstanceOf(MarketingApiError);
    await expect(submitMarketingAction({ action: "sendCampaign", campaignId }, undefined, retryScope)).resolves.toMatchObject({ kind: "pending" });
    const intentIds = fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)).intentId);
    expect(intentIds[0]).toBe(intentIds[1]);
    expect(intentIds[1]).toBe(intentIds[2]);
  });

  it("blocks a changed campaign payload while the prior create is pending", async () => {
    vi.stubGlobal("__GO_MARKETING_CAMPAIGN_WRITES__", true);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json({ ok: false, pendingApproval: true, reason: "Needs review" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await submitMarketingAction(createCampaignAction, undefined, retryScope);
    await expect(submitMarketingAction({ ...createCampaignAction, body: "A changed body" }, undefined, retryScope)).rejects.toThrow(/previous campaign attempt is still unresolved/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retains the same attempt after timeout and rate-limit responses", async () => {
    vi.stubGlobal("__GO_MARKETING_CAMPAIGN_WRITES__", true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "timed out" }, { status: 408 }))
      .mockResolvedValueOnce(Response.json({ error: "rate limited" }, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Still waiting" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitMarketingAction({ action: "sendCampaign", campaignId }, undefined, retryScope)).rejects.toMatchObject({ requestMayHaveReachedServer: true });
    await expect(submitMarketingAction({ action: "sendCampaign", campaignId }, undefined, retryScope)).rejects.toMatchObject({ requestMayHaveReachedServer: true });
    await submitMarketingAction({ action: "sendCampaign", campaignId }, undefined, retryScope);
    const intentIds = fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)).intentId);
    expect(new Set(intentIds).size).toBe(1);
  });

  it("separates retry identities by actor and organization", async () => {
    vi.stubGlobal("__GO_MARKETING_CAMPAIGN_WRITES__", true);
    const fetchMock = vi.fn(async () => Response.json({ ok: false, pendingApproval: true, reason: "Needs review" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await submitMarketingAction(createCampaignAction, undefined, retryScope);
    await submitMarketingAction(createCampaignAction, undefined, { ...retryScope, organizationId: "aa8c635d-405e-4488-824c-a557b1c1fbe1" });
    const first = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const second = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(first[1].body)).intentId).not.toBe(JSON.parse(String(second[1].body)).intentId);
  });

  it("retains the exact send intent after Go 404 and retries only Go", async () => {
    vi.stubGlobal("__GO_MARKETING_CAMPAIGN_WRITES__", true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Needs review" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitMarketingAction({ action: "sendCampaign", campaignId }, undefined, retryScope)).rejects.toMatchObject({
      status: 404,
      requestMayHaveReachedServer: true,
    });
    await expect(submitMarketingAction({ action: "sendCampaign", campaignId }, undefined, retryScope)).resolves.toMatchObject({ kind: "pending" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([path]) => path)).toEqual(["/api/capabilities/execute", "/api/capabilities/execute"]);
    expect(JSON.parse(String(calls[0]?.[1].body)).intentId).toBe(JSON.parse(String(calls[1]?.[1].body)).intentId);
  });

  it.each([
    {
      label: "segment creation",
      selector: "__GO_MARKETING_SEGMENT_SLICE__",
      action: { action: "createSegment" as const, name: "Big spenders", minSpendMinor: 25_000 },
    },
    { label: "campaign creation", selector: "__GO_MARKETING_CAMPAIGN_WRITES__", action: createCampaignAction },
    { label: "campaign send", selector: "__GO_MARKETING_CAMPAIGN_WRITES__", action: { action: "sendCampaign" as const, campaignId } },
  ])("does not fall back to legacy after Go 404 for $label", async ({ selector, action }) => {
    vi.stubGlobal(selector, true);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitMarketingAction(action, undefined, retryScope)).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
  });

  it("retains the exact send attempt after a malformed Go success envelope", async () => {
    vi.stubGlobal("__GO_MARKETING_CAMPAIGN_WRITES__", true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, data: { recipients: "three" } }))
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Needs review" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitMarketingAction({ action: "sendCampaign", campaignId }, undefined, retryScope)).rejects.toMatchObject({
      requestMayHaveReachedServer: true,
      message: "The marketing service returned an unexpected action result.",
    });
    await expect(submitMarketingAction({ action: "sendCampaign", campaignId }, undefined, retryScope)).resolves.toMatchObject({ kind: "pending" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).intentId).toBe(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).intentId);
    expect(fetchMock.mock.calls.every(([path]) => path === "/api/capabilities/execute")).toBe(true);
  });

  it.each([401, 403, 500])("does not fall back to legacy after Go returns %s", async (status) => {
    vi.stubGlobal("__GO_MARKETING_CAMPAIGN_WRITES__", true);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ error: "unavailable" }, { status }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitMarketingAction({ action: "sendCampaign", campaignId }, undefined, retryScope)).rejects.toBeInstanceOf(MarketingApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
  });

  it.each([
    { label: "creation", action: createCampaignAction },
    { label: "send", action: { action: "sendCampaign" as const, campaignId } },
  ])("blocks legacy $label after an unresolved Go attempt when the selector is off", async ({ action }) => {
    vi.stubGlobal("__GO_MARKETING_CAMPAIGN_WRITES__", true);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json({ ok: false, pendingApproval: true, reason: "Needs review" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitMarketingAction(action, undefined, retryScope)).resolves.toMatchObject({ kind: "pending" });
    vi.stubGlobal("__GO_MARKETING_CAMPAIGN_WRITES__", false);

    await expect(submitMarketingAction(action, undefined, retryScope)).rejects.toThrow(/Restore Go campaign writes and retry that exact action/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
  });

  it("allows a fresh scoped legacy campaign action when there is no unresolved Go marker", async () => {
    vi.stubGlobal("__GO_MARKETING_CAMPAIGN_WRITES__", false);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json({ ok: true, data: { campaignId: "7ed25b56-02d4-4f5b-b858-9681920abdd0" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitMarketingAction(createCampaignAction, undefined, retryScope)).resolves.toMatchObject({ kind: "completed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/marketing");
  });

  it("fails closed without scope or when a stored intent marker is malformed", async () => {
    vi.stubGlobal("__GO_MARKETING_CAMPAIGN_WRITES__", true);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitMarketingAction(createCampaignAction, undefined, { actorId: null, organizationId: retryScope.organizationId })).rejects.toThrow(/active user and organization/);
    expect(fetchMock).not.toHaveBeenCalled();

    const scopeHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(retryScope)));
    const scopeHex = Array.from(new Uint8Array(scopeHash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    window.localStorage.setItem(`chaste.marketing.campaign-intent.v1:${scopeHex}:create`, "not-json");
    await expect(submitMarketingAction(createCampaignAction, undefined, retryScope)).rejects.toThrow(/previous campaign attempt is still unresolved/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears the old scoped intent on terminal 4xx and does not change segment routing", async () => {
    vi.stubGlobal("__GO_MARKETING_CAMPAIGN_WRITES__", true);
    vi.stubGlobal("__GO_MARKETING_SEGMENT_SLICE__", true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "invalid campaign" }, { status: 422 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { campaignId: "7ed25b56-02d4-4f5b-b858-9681920abdd0" } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { segmentId } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitMarketingAction(createCampaignAction, undefined, retryScope)).rejects.toBeInstanceOf(MarketingApiError);
    await submitMarketingAction(createCampaignAction, undefined, retryScope);
    await submitMarketingAction({ action: "createSegment", name: "All", minSpendMinor: 0 });
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(JSON.parse(String(calls[0]?.[1].body)).intentId).not.toBe(JSON.parse(String(calls[1]?.[1].body)).intentId);
    expect(JSON.parse(String(calls[2]?.[1].body))).toMatchObject({ capabilityId: "marketing.createSegment" });
  });
});
