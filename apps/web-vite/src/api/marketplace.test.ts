import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMarketplaceListings, MarketplaceApiError, verifyMarketplaceListing } from "./marketplace";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("marketplace read requests", () => {
  it("loads listings through the Go session capability with the legacy listing contract", async () => {
    const listing = {
      id: "listing-1",
      slug: "sales-dashboard",
      name: "Sales dashboard",
      version: "1.2.0",
      summary: "A sales overview plugin",
      status: "verified",
      capabilityIds: ["sales.read"],
      installedByOrgIds: ["org-1"],
      installedHere: true,
      updatedAt: "2026-10-10T12:00:00.000Z",
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { listings: [listing] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchMarketplaceListings()).resolves.toEqual([listing]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
      signal: expect.any(AbortSignal),
    }));
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(requestBody).toEqual({
      capabilityId: "creator.listMarketplace",
      input: {},
      intentId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
    });
  });

  it("rejects invalid Go listing responses without falling back to the legacy route", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { listings: [{ id: "incomplete" }] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchMarketplaceListings()).rejects.toMatchObject({
      name: "MarketplaceApiError",
      status: 200,
      message: "The marketplace returned data in an unexpected format.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.any(Object));
  });

  it("does not fall back to the legacy route when Go returns an HTTP error", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: "service unavailable" }, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchMarketplaceListings()).rejects.toMatchObject({
      name: "MarketplaceApiError",
      status: 503,
      message: "Could not load marketplace listings.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.any(Object));
  });

  it("turns a stalled listing read into a recoverable API error", async () => {
    const timeoutController = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Request timed out", "TimeoutError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const request = fetchMarketplaceListings();
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      signal: expect.any(AbortSignal),
    }));
    timeoutController.abort();
    await expect(request).rejects.toBeInstanceOf(MarketplaceApiError);
    await expect(request).rejects.toMatchObject({
      name: "MarketplaceApiError",
      status: 0,
      message: expect.stringContaining("marketplace service"),
    });
  });

  it("turns a stalled signature verification into a recoverable API error", async () => {
    const timeoutController = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Request timed out", "TimeoutError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const request = verifyMarketplaceListing({
      manifest: {},
      signatureBase64: "sig",
      publisherPublicKeyBase64: "key",
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      signal: expect.any(AbortSignal),
    }));
    timeoutController.abort();
    await expect(request).rejects.toMatchObject({
      name: "MarketplaceApiError",
      status: 0,
      message: expect.stringContaining("marketplace service"),
    });
  });

  it("verifies a valid plugin through the Go capability contract", async () => {
    const verifyInput = {
      manifest: { formatVersion: 1, name: "Acme Plugin" },
      signatureBase64: "c2lnbmF0dXJl",
      publisherPublicKeyBase64: "cHVibGljLWtleQ==",
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { valid: true } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyMarketplaceListing(verifyInput)).resolves.toEqual({ valid: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    }));
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      capabilityId: "creator.verifyPlugin",
      input: verifyInput,
      intentId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
    });
  });

  it("returns an invalid signature as a successful Go verification verdict", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      ok: true,
      data: { valid: false, reason: "signature does not match manifest digest" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyMarketplaceListing({
      manifest: {},
      signatureBase64: "invalid-signature",
      publisherPublicKeyBase64: "invalid-public-key",
    })).resolves.toEqual({ valid: false, reason: "signature does not match manifest digest" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.any(Object));
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/marketplace")).toBe(false);
  });

  it("rejects malformed Go verification envelopes", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { valid: false, problems: ["bad signature"] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyMarketplaceListing({ manifest: {}, signatureBase64: "sig", publisherPublicKeyBase64: "key" }))
      .rejects.toMatchObject({
        name: "MarketplaceApiError",
        status: 200,
        message: "The marketplace returned an unexpected verification response.",
      });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/execute");
  });
});
