import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResolvedUser: vi.fn(),
  actorFromResolved: vi.fn(),
  buildExecutor: vi.fn(),
  buildRegistry: vi.fn(),
  execute: vi.fn(),
  getDb: vi.fn(),
  executeGoCapability: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("@chaste/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/server/kernel", () => ({
  actorFromResolved: mocks.actorFromResolved,
  buildExecutor: mocks.buildExecutor,
  buildRegistry: mocks.buildRegistry,
}));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/go-bridge", () => ({ executeGoCapability: mocks.executeGoCapability }));

import { GET, POST } from "./route";

const resolved = {
  userId: "0b9e1bd3-8432-4059-a0b1-902ff8d520d0",
  orgId: "a5cb2579-9d6e-41ee-96d6-9af1c89bf250",
  authSessionId: "better-auth-session",
  email: "owner@example.test",
  name: "Owner",
  permissions: new Set(["accounting.read", "accounting.write"]),
  allOrgIds: ["a5cb2579-9d6e-41ee-96d6-9af1c89bf250"],
  emailVerified: true,
};
const actionContext = {
  actor: {
    type: "human",
    id: resolved.userId,
    orgId: resolved.orgId,
    permissions: resolved.permissions,
  },
  now: new Date("2026-09-27T12:00:00.000Z"),
  services: {},
};
const customerId = "d00d512e-ab21-4f45-9199-f53d81e9597f";
const quoteId = "8c1e6f4a-2b3d-4e5f-8a9b-0c1d2e3f4a5b";
const quoteBody = {
  action: "create",
  intentId: "quote-intent-1",
  customerId,
  memo: "Q4 pricing",
  expiresAt: "2026-10-31",
  lines: [{ description: "Consulting", quantity: 1000, unitPriceMinor: 125000, taxMinor: 0 }],
};

function request(body: unknown) {
  return new Request("http://localhost/api/quotes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/quotes Go bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_ACCOUNTING_QUOTES_WRITE", "0");
    vi.stubEnv("GO_ACCOUNTING_QUOTES_READS", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps quote writes on the TypeScript executor by default and preserves normalized input", async () => {
    mocks.execute.mockResolvedValue({ ok: true, data: { quoteId, quoteNumber: 1, totalMinor: 125000 } });

    const response = await POST(request(quoteBody));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { quoteId, quoteNumber: 1, totalMinor: 125000 } });
    expect(mocks.execute).toHaveBeenCalledWith(
      "accounting.createQuote",
      actionContext,
      {
        customerId,
        memo: "Q4 pricing",
        expiresAt: "2026-10-31T23:59:59.999Z",
        lines: quoteBody.lines,
      },
    );
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("keeps quote approval pending responses on the legacy 202 contract by default", async () => {
    mocks.execute.mockResolvedValue({ ok: false, error: "Approval required", pendingApproval: true });

    const response = await POST(request({ action: "accept", quoteId }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ error: "Approval required", pendingApproval: true });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "create",
      body: quoteBody,
      capabilityId: "accounting.createQuote",
      input: { customerId, memo: "Q4 pricing", expiresAt: "2026-10-31T23:59:59.999Z", lines: quoteBody.lines },
      data: { quoteId, quoteNumber: 12, totalMinor: 125000 },
    },
    {
      name: "accept",
      body: { action: "accept", quoteId },
      capabilityId: "accounting.acceptQuote",
      input: { quoteId },
      data: { invoiceId: "f3c65071-356d-48e4-b5cb-cccd4fc06f6d", invoiceNumber: 105, totalMinor: 125000 },
    },
    {
      name: "decline",
      body: { action: "decline", quoteId },
      capabilityId: "accounting.declineQuote",
      input: { quoteId },
      data: { status: "declined" },
    },
    {
      name: "expire",
      body: { action: "expire" },
      capabilityId: "accounting.expireQuote",
      input: {},
      data: { expiredCount: 3 },
    },
  ])("dispatches $name through the signed Go bridge when enabled", async ({ body, capabilityId, input, data }) => {
    vi.stubEnv("GO_ACCOUNTING_QUOTES_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data, replayed: true }),
    });

    const response = await POST(request(body));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext,
      session: resolved,
      capabilityId,
      input,
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("normalizes Go approvals and capability errors without retrying through TypeScript", async () => {
    vi.stubEnv("GO_ACCOUNTING_QUOTES_WRITE", "1");
    mocks.executeGoCapability
      .mockResolvedValueOnce({
        kind: "response",
        response: Response.json({ ok: false, pendingApproval: true, reason: "Approval required", approvalId: "private-id" }, { status: 202 }),
      })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ error: "unauthorized" }, { status: 401 }) })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ error: "forbidden: missing permission: accounting.write" }, { status: 403 }) })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ ok: false, error: "quote not found" }, { status: 422 }) });
    const declineRequest = () => request({ action: "decline", quoteId });

    const pending = await POST(declineRequest());
    const unauthorized = await POST(declineRequest());
    const denied = await POST(declineRequest());
    const invalid = await POST(declineRequest());

    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ error: "Approval required", pendingApproval: true });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "unauthorized" });
    expect(denied.status).toBe(422);
    expect(await denied.json()).toEqual({ error: "forbidden: missing permission: accounting.write" });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({ error: "quote not found" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing dispatch", result: { kind: "not-dispatched" } },
    { name: "unknown outcome", result: { kind: "outcome-unknown" } },
    { name: "malformed success", result: { kind: "response", response: Response.json({ ok: true, data: { quoteId: 5 } }) } },
    { name: "backend failure", result: { kind: "response", response: Response.json({ error: "internal error" }, { status: 500 }) } },
  ])("fails closed on $name without retrying through TypeScript", async ({ result }) => {
    vi.stubEnv("GO_ACCOUNTING_QUOTES_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue(result);

    const response = await POST(request(quoteBody));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "quotes service unavailable; check quote status before retrying" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("fails closed when the Go dispatch throws", async () => {
    vi.stubEnv("GO_ACCOUNTING_QUOTES_WRITE", "1");
    mocks.executeGoCapability.mockRejectedValue(new Error("bridge timeout"));

    const response = await POST(request({ action: "accept", quoteId }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "quotes service unavailable; check quote status before retrying" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps quote writes behind authentication, onboarding, and body validation", async () => {
    vi.stubEnv("GO_ACCOUNTING_QUOTES_WRITE", "1");
    mocks.getResolvedUser.mockResolvedValue(null);
    const anonymous = await POST(request(quoteBody));
    expect(anonymous.status).toBe(401);

    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(null);
    const onboarding = await POST(request(quoteBody));
    expect(onboarding.status).toBe(428);

    mocks.actorFromResolved.mockReturnValue(actionContext);
    const invalid = await POST(request({ action: "accept", quoteId: "not-a-uuid" }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid body" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps the quote listing GET on TypeScript even when the write flag is on", async () => {
    vi.stubEnv("GO_ACCOUNTING_QUOTES_WRITE", "1");
    mocks.execute.mockResolvedValue({ ok: true, data: { quotes: [] } });

    const response = await GET(new Request("http://localhost/api/quotes?status=sent"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ quotes: [] });
    expect(mocks.execute).toHaveBeenCalledWith("accounting.listQuotes", actionContext, { status: "sent" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("bridges quote listing through Go and keeps the status filter and response contract", async () => {
    vi.stubEnv("GO_ACCOUNTING_QUOTES_READS", "1");
    const quotes = [{
      id: quoteId,
      number: 12,
      status: "sent",
      totalMinor: 125000,
      customerId,
      createdAt: "2026-09-27T12:00:00.000Z",
      expiresAt: "2026-10-31T23:59:59.999Z",
      invoiceId: null,
    }];
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { quotes } }) });

    const response = await GET(new Request("http://localhost/api/quotes?status=sent"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ quotes });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext,
      session: resolved,
      capabilityId: "accounting.listQuotes",
      input: { status: "sent" },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("ignores an unsupported quote status on the Go route as the TypeScript route does", async () => {
    vi.stubEnv("GO_ACCOUNTING_QUOTES_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { quotes: [] } }) });

    const response = await GET(new Request("http://localhost/api/quotes?status=unknown"));

    expect(response.status).toBe(200);
    expect(mocks.executeGoCapability).toHaveBeenCalledWith(expect.objectContaining({
      capabilityId: "accounting.listQuotes",
      input: { status: undefined },
    }));
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { label: "not-dispatched", result: { kind: "not-dispatched" } },
    { label: "outcome-unknown", result: { kind: "outcome-unknown" } },
    { label: "malformed response", result: { kind: "response", response: Response.json({ ok: true, data: { quotes: [{ id: quoteId }] } }) } },
    { label: "null creation timestamp", result: { kind: "response", response: Response.json({ ok: true, data: { quotes: [{ id: quoteId, number: 12, status: "sent", totalMinor: 125000, customerId, createdAt: null, expiresAt: null, invoiceId: null }] } }) } },
  ])("fails closed on $label without retrying the TypeScript read", async ({ result }) => {
    vi.stubEnv("GO_ACCOUNTING_QUOTES_READS", "1");
    mocks.executeGoCapability.mockResolvedValue(result);

    const response = await GET(new Request("http://localhost/api/quotes?status=sent"));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("preserves the legacy validation error response from the Go quote list", async () => {
    vi.stubEnv("GO_ACCOUNTING_QUOTES_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: false, error: "quote status is invalid" }, { status: 422 }) });

    const response = await GET(new Request("http://localhost/api/quotes?status=sent"));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "quote status is invalid" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("maps Go membership denials to the legacy GET error response", async () => {
    vi.stubEnv("GO_ACCOUNTING_QUOTES_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ error: "organization membership required" }, { status: 403 }) });

    const response = await GET(new Request("http://localhost/api/quotes?status=sent"));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "organization membership required" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
