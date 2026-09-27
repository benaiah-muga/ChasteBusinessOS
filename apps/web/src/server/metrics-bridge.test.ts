import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoMetricsAssertion, readGoMetrics } from "./metrics-bridge";

const secret = "test-only-shared-secret-value-32-bytes";
const input = {
  userId: "0b9e1bd3-8432-4059-a0b1-902ff8d520d0",
  orgId: "a5cb2579-9d6e-41ee-96d6-9af1c89bf250",
};
const payload = {
  totals: { sessionsTracked: 3, inputTokens: 800, outputTokens: 160, cachedInputTokens: 300, cacheHitRatePct: 38 },
  note: "cachedInputTokens reflects provider-reported cache reads when available; null hit rate means no usage recorded yet.",
};

describe("signed Go metrics bridge", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("creates a short-lived HMAC assertion bound to the resolved user and organization", () => {
    const assertion = createGoMetricsAssertion(input, secret, Date.UTC(2026, 8, 27, 10, 0, 0));
    const [encoded, signature] = assertion.split(".");
    const claims: unknown = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8"));

    expect(claims).toEqual({
      aud: "go.metrics.read",
      sub: input.userId,
      org_id: input.orgId,
      iat: 1790503200,
      exp: 1790503230,
    });
    expect(signature).toBe(createHmac("sha256", secret).update(encoded!).digest("base64url"));
  });

  it("rejects short secrets and malformed identity claims", () => {
    expect(() => createGoMetricsAssertion(input, "short")).toThrow(/at least 32 bytes/);
    expect(() => createGoMetricsAssertion({ ...input, orgId: "unknown" }, secret)).toThrow(/valid user and organization UUIDs/);
  });

  it("uses the signed loopback endpoint without cookies or cache", async () => {
    vi.stubEnv("GO_INTERNAL_AUTH_SECRET", secret);
    vi.stubEnv("GO_API_INTERNAL_URL", "http://127.0.0.1:8080");
    const fetchMock = vi.fn().mockResolvedValue(Response.json(payload));
    vi.stubGlobal("fetch", fetchMock);

    await expect(readGoMetrics(input)).resolves.toEqual(payload);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:8080/__go/metrics");
    expect(init).toMatchObject({ method: "GET", cache: "no-store", credentials: "omit", redirect: "error" });
    expect(new Headers(init?.headers).get("X-Chaste-Session-Assertion")).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("refuses unsafe bridge origins before contacting Go", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(readGoMetrics(input, { secret, baseUrl: "http://metrics.internal:8080" })).resolves.toBeNull();
    await expect(readGoMetrics(input, { secret, baseUrl: "http://user:pass@127.0.0.1:8080" })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for HTTP errors and invalid Go response contracts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ...payload, totals: { ...payload.totals, cacheHitRatePct: "38" } }))
      .mockResolvedValueOnce(Response.json({ ...payload, note: "unexpected note" })));

    await expect(readGoMetrics(input, { secret })).resolves.toBeNull();
    await expect(readGoMetrics(input, { secret })).resolves.toBeNull();
    await expect(readGoMetrics(input, { secret })).resolves.toBeNull();
  });
});
