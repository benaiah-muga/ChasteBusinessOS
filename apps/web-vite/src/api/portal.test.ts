import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPortalInvoice, PORTAL_MESSAGES } from "./portal";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const validInvoice = {
  invoice: {
    number: 77,
    status: "sent",
    currency: "USD",
    totalMinor: 5000,
    creditedMinor: 0,
    paidMinor: 1000,
    outstandingMinor: 4000,
    issuedAt: "2026-02-01T00:00:00.000Z",
    customerName: "Acme",
    lines: [{ description: "Widget", quantity: 2000, unitPriceMinor: 250, taxMinor: 0 }],
  },
};
const shareToken = "share-token-1234567890123456";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchPortalInvoice", () => {
  it("requests the token-scoped invoice", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return jsonResponse(validInvoice);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPortalInvoice(shareToken);

    expect(fetchMock).toHaveBeenCalledWith(`/api/portal/invoice/${shareToken}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      redirect: "error",
      signal: undefined,
    });
    expect(result.status).toBe("ok");
  });

  it("encodes a token that needs escaping", async () => {
    const requested: Array<RequestInfo | URL> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      requested.push(input);
      return jsonResponse(validInvoice);
    });
    vi.stubGlobal("fetch", fetchMock);
    const token = "a b/c-12345678901234567890";
    await fetchPortalInvoice(token);
    expect(requested[0]).toBe(`/api/portal/invoice/${encodeURIComponent(token)}`);
  });

  it("accepts the credit-adjusted payload the legacy route actually sends", async () => {
    // The route includes creditedMinor so outstanding is credit-adjusted.
    // If a future schema drops it, the customer would see the wrong balance.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(validInvoice)));
    const result = await fetchPortalInvoice(shareToken);
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.invoice.creditedMinor).toBe(0);
  });

  it("refuses a payload missing creditedMinor rather than showing a wrong balance", async () => {
    const { creditedMinor, ...withoutCredit } = validInvoice.invoice;
    void creditedMinor;
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ invoice: withoutCredit })));
    expect((await fetchPortalInvoice(shareToken)).status).toBe("error");
  });

  it("maps a revoked or unknown token to not-found", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "not found" }, 404)));
    expect((await fetchPortalInvoice(shareToken)).status).toBe("not-found");
  });

  it("distinguishes throttling from an invalid link", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "slow down" }, 429)));
    expect((await fetchPortalInvoice(shareToken)).status).toBe("rate-limited");
  });

  it("treats an empty invoice as not-found, never as a blank invoice", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ invoice: null })));
    expect((await fetchPortalInvoice(shareToken)).status).toBe("not-found");
  });

  it("fails closed on a malformed body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ invoice: { number: "seventy-seven" } })));
    expect((await fetchPortalInvoice(shareToken)).status).toBe("error");
  });

  it("refuses an invoice carrying an undeclared field", async () => {
    const leaky = structuredClone(validInvoice) as Record<string, unknown>;
    leaky.invoice = { ...validInvoice.invoice, orgEmail: "leak@example.test" };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(leaky)));
    expect((await fetchPortalInvoice(shareToken)).status).toBe("error");
  });

  it("fails closed when the network throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    const result = await fetchPortalInvoice(shareToken);
    expect(result.status).toBe("error");
    expect(result.status === "error" && result.message).toBe(PORTAL_MESSAGES.failed);
  });

  it("does not call the network for malformed or out-of-range tokens", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await fetchPortalInvoice("")).status).toBe("not-found");
    expect((await fetchPortalInvoice("short-token")).status).toBe("not-found");
    expect((await fetchPortalInvoice("x".repeat(65))).status).toBe("not-found");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats backend failures as load errors instead of invalid links", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "unavailable" }, 503)));
    expect(await fetchPortalInvoice(shareToken)).toEqual({ status: "error", message: PORTAL_MESSAGES.failed });
  });

  it("rejects monetary values that cannot be represented safely in JavaScript", async () => {
    const unsafe = structuredClone(validInvoice);
    unsafe.invoice.totalMinor = Number.MAX_SAFE_INTEGER + 1;
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(unsafe)));
    expect((await fetchPortalInvoice(shareToken)).status).toBe("error");
  });
});
