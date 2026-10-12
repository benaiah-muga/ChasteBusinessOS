import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acceptSalesQuote, createSalesQuote, fetchSalesQuoteCustomers, fetchSalesQuoteDeals, fetchSalesQuotes, SalesQuoteApiError } from "./sales-quotes";

const actorId = "10000000-0000-4000-8000-000000000001";
const organizationId = "10000000-0000-4000-8000-000000000002";
const customerId = "20000000-0000-4000-8000-000000000001";
const quoteId = "30000000-0000-4000-8000-000000000001";
const invoiceId = "40000000-0000-4000-8000-000000000001";
const scope = { actorId, organizationId };

function success(data: unknown) { return Response.json({ ok: true, data }); }

function stubWebLocks() {
  const testNavigator = Object.create(navigator) as Navigator;
  Object.defineProperty(testNavigator, "locks", { configurable: true, value: { request: async (_name: string, _options: { mode: "exclusive" }, callback: () => Promise<unknown>) => callback() } });
  vi.stubGlobal("navigator", testNavigator);
}

beforeEach(stubWebLocks);
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Vite Sales quote Go APIs", () => {
  it("loads quotes, customers, and deals directly from their Go capabilities", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { capabilityId: string };
      if (request.capabilityId === "accounting.listQuotes") return success({ quotes: [] });
      if (request.capabilityId === "crm.listCustomers") return success({ customers: [{ id: customerId, name: "Acme", email: null }] });
      if (request.capabilityId === "crm.listDeals") return success({ deals: [] });
      return Response.json({ error: "unexpected capability" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSalesQuotes()).resolves.toEqual([]);
    await expect(fetchSalesQuoteCustomers()).resolves.toEqual([{ id: customerId, name: "Acme", email: null }]);
    await expect(fetchSalesQuoteDeals()).resolves.toEqual([]);
    expect(fetchMock.mock.calls.map(([path, init]) => [path, JSON.parse(String(init?.body))])).toEqual([
      ["/api/capabilities/execute", expect.objectContaining({ capabilityId: "accounting.listQuotes", input: {}, intentId: expect.any(String) })],
      ["/api/capabilities/execute", expect.objectContaining({ capabilityId: "crm.listCustomers", input: {}, intentId: expect.any(String) })],
      ["/api/capabilities/execute", expect.objectContaining({ capabilityId: "crm.listDeals", input: {}, intentId: expect.any(String) })],
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin", cache: "no-store" });
  });

  it("fails closed when Go read outputs contain invalid UUIDs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(success({ quotes: [{ id: "bad-id", number: 1, status: "sent", totalMinor: 1, customerId, createdAt: null, expiresAt: null, invoiceId: null }] })));
    await expect(fetchSalesQuotes()).rejects.toMatchObject({ name: "SalesQuoteApiError", status: 200 });
  });

  it("reuses scoped exact create intent after an unknown result and accepts valid Go output", async () => {
    const intentIds: string[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { capabilityId: string; intentId: string; input: unknown };
      intentIds.push(request.intentId);
      expect(request.capabilityId).toBe("accounting.createQuote");
      expect(request.input).toEqual({ customerId, memo: "Setup", expiresAt: "2027-01-10T23:59:59.000Z", lines: [{ description: "Consulting", quantity: 1500, unitPriceMinor: 10000, taxMinor: 0 }] });
      if (intentIds.length === 1) throw new TypeError("connection dropped");
      return success({ quoteId, quoteNumber: 27, totalMinor: 15000 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const input = { customerId, memo: "Setup", expiresAt: "2027-01-10T23:59:59.000Z", lines: [{ description: "Consulting", quantity: 1500, unitPriceMinor: 10000, taxMinor: 0 }] };
    await expect(createSalesQuote(input, scope)).rejects.toMatchObject({ requestMayHaveReachedServer: true });
    await expect(createSalesQuote(input, scope)).resolves.toEqual({ kind: "completed", data: { quoteId, quoteNumber: 27, totalMinor: 15000 } });
    expect(intentIds[1]).toBe(intentIds[0]);
    expect(Object.keys(localStorage).filter((key) => key.startsWith("chaste:sales-quotes:")).length).toBe(0);
  });

  it("scopes quote retries for non-UUID Better Auth user ids", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(success({ quoteId, quoteNumber: 27, totalMinor: 5000 })));
    await expect(createSalesQuote({ customerId, lines: [{ description: "Work", quantity: 1000, unitPriceMinor: 5000 }] }, {
      actorId: "better-auth-user-id",
      organizationId,
    })).resolves.toEqual({ kind: "completed", data: { quoteId, quoteNumber: 27, totalMinor: 5000 } });
  });

  it("rejects quote amounts outside PostgreSQL integer bounds before sending", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createSalesQuote({ customerId, lines: [{ description: "Work", quantity: 2_147_483_648, unitPriceMinor: 1 }] }, scope))
      .rejects.toMatchObject({ name: "SalesQuoteApiError", status: 0 });
    await expect(createSalesQuote({ customerId, lines: [{ description: "Work", quantity: 2_000, unitPriceMinor: 1_073_741_824 }] }, scope))
      .rejects.toMatchObject({ name: "SalesQuoteApiError", status: 0 });
    await expect(createSalesQuote({ customerId, memo: "bad\u0000memo", lines: [{ description: "Work", quantity: 1_000, unitPriceMinor: 1 }] }, scope))
      .rejects.toMatchObject({ name: "SalesQuoteApiError", status: 0 });
    await expect(createSalesQuote({ customerId, lines: [{ description: "bad\u0000description", quantity: 1_000, unitPriceMinor: 1 }] }, scope))
      .rejects.toMatchObject({ name: "SalesQuoteApiError", status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the exact intent through pending approval and fails closed for another scope", async () => {
    const ids: string[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      ids.push((JSON.parse(String(init?.body)) as { intentId: string }).intentId);
      return Response.json({ ok: false, pendingApproval: true, reason: "Finance approval" }, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const input = { customerId, lines: [{ description: "Work", quantity: 1000, unitPriceMinor: 5000 }] };
    await expect(createSalesQuote(input, scope)).resolves.toEqual({ kind: "pending", reason: "Finance approval" });
    await expect(createSalesQuote(input, scope)).resolves.toMatchObject({ kind: "pending" });
    expect(ids[1]).toBe(ids[0]);
    await expect(createSalesQuote(input, { actorId: "50000000-0000-4000-8000-000000000001", organizationId })).resolves.toMatchObject({ kind: "pending" });
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("accepts a quote through Go and validates invoice UUID output", async () => {
    const fetchMock = vi.fn().mockResolvedValue(success({ invoiceId, invoiceNumber: 701, totalMinor: 25000 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(acceptSalesQuote(quoteId, scope)).resolves.toEqual({ kind: "completed", data: { invoiceId, invoiceNumber: 701, totalMinor: 25000 } });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ capabilityId: "accounting.acceptQuote", input: { quoteId }, intentId: expect.any(String) });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(success({ invoiceId: "invalid", invoiceNumber: 701, totalMinor: 25000 })));
    await expect(acceptSalesQuote(quoteId, scope)).rejects.toBeInstanceOf(SalesQuoteApiError);
  });

  it("does not clear exact retry state after malformed success data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(success({ quoteId: "invalid", quoteNumber: 27, totalMinor: 15000 })));
    await expect(createSalesQuote({ customerId, lines: [{ description: "Work", quantity: 1000, unitPriceMinor: 5000 }] }, scope)).rejects.toMatchObject({ requestMayHaveReachedServer: true });
    expect(Object.keys(localStorage).some((key) => key.startsWith("chaste:sales-quotes:"))).toBe(true);
  });
});
