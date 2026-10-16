import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSignals } from "./signals";
import type { SignalsApiError } from "./signals";

const signal = {
  id: "cash.low",
  severity: "orange",
  module: "cash",
  subject: "Low cash balance",
  detail: "Cash is below the configured threshold.",
  evidence: { refType: "accounting.account", refId: "cash" },
  suggestedAction: { capabilityId: "accounting.reviewCash", inputDraft: { accountId: "cash" } },
} as const;

afterEach(() => vi.unstubAllGlobals());

describe("signals API client", () => {
  it("validates and returns generated signal models with same-origin session credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ signals: [signal] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSignals()).resolves.toEqual([signal]);
    expect(fetchMock).toHaveBeenCalledWith("/api/signals", expect.objectContaining({
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal: expect.any(AbortSignal),
    }));
  });

  it("serializes severity and module filters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ signals: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchSignals({ severity: "orange", module: "cash flow" });

    expect(fetchMock).toHaveBeenCalledWith("/api/signals?severity=orange&module=cash+flow", expect.any(Object));
  });

  it("rejects invalid filter byte lengths before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSignals({ module: "x" })).rejects.toMatchObject({ name: "SignalsApiError", status: 400 });
    await expect(fetchSignals({ module: "é".repeat(21) })).rejects.toMatchObject({ name: "SignalsApiError", status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects incomplete and unexpected response fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ signals: [{ ...signal, severity: "urgent" }] })));
    await expect(fetchSignals()).rejects.toMatchObject({ name: "SignalsApiError", status: 200 });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ signals: [{ ...signal, privateToken: "unexpected" }] })));
    await expect(fetchSignals()).rejects.toMatchObject({ name: "SignalsApiError", status: 200 });
  });

  it.each([[401], [403], [503]])("maps HTTP %s to a safe client error", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret detail", { status })));
    await expect(fetchSignals()).rejects.toMatchObject({
      name: "SignalsApiError",
      status,
      message: expect.not.stringContaining("secret detail"),
    } satisfies Partial<SignalsApiError>);
  });
});
