import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMarketplaceListings, MarketplaceApiError, verifyMarketplaceListing } from "./marketplace";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("marketplace read requests", () => {
  it("turns a stalled listing read into a recoverable API error", async () => {
    const timeoutController = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Request timed out", "TimeoutError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const request = fetchMarketplaceListings();
    expect(fetchMock).toHaveBeenCalledWith("/api/marketplace", expect.objectContaining({ signal: expect.any(AbortSignal) }));
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

    const request = verifyMarketplaceListing({ action: "verify", manifest: {} });
    expect(fetchMock).toHaveBeenCalledWith("/api/marketplace", expect.objectContaining({
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
});
