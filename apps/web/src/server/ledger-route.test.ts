import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResolvedUser: vi.fn(),
  missingPermission: vi.fn(),
  createGoLedgerAssertion: vi.fn(),
  recentLedgerEvents: vi.fn(),
  getDb: vi.fn(),
  logger: { warn: vi.fn() },
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("@chaste/db", () => ({ getDb: mocks.getDb }));
vi.mock("@chaste/kernel", () => ({ logger: mocks.logger }));
vi.mock("@/server/go-bridge", () => ({ createGoLedgerAssertion: mocks.createGoLedgerAssertion }));
vi.mock("@/server/kernel", () => ({ recentLedgerEvents: mocks.recentLedgerEvents }));
vi.mock("@/server/route-guards", () => ({ missingPermission: mocks.missingPermission }));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));

import { GET } from "../app/api/ledger/route";

const resolved = {
  userId: "0b9e1bd3-8432-4059-a0b1-902ff8d520d0",
  orgId: "a5cb2579-9d6e-41ee-96d6-9af1c89bf250",
  permissions: ["accounting.read"],
};
const legacyEvent = {
  seq: 42,
  kind: "capability.executed",
  capabilityId: "crm.createCustomer",
  actorType: "human",
  actorId: null,
  sessionId: null,
  payload: { customerId: "c-1" },
  hash: "hash-42",
  prevHash: null,
  occurredAt: new Date("2026-09-27T10:11:12.130Z"),
};
const goEvent = { ...legacyEvent, occurredAt: "2026-09-27T10:11:12.130Z" };

describe("ledger route ownership adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_INTERNAL_AUTH_SECRET", "test-only-shared-secret-value-32-bytes");
    vi.stubEnv("GO_API_INTERNAL_URL", "http://127.0.0.1:8080");
    vi.stubEnv("GO_LEDGER_READ", "0");
    vi.stubEnv("GO_LEDGER_SHADOW", "0");
    vi.stubEnv("NODE_ENV", "test");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.missingPermission.mockReturnValue(null);
    mocks.createGoLedgerAssertion.mockReturnValue("signed-ledger-assertion");
    mocks.getDb.mockReturnValue({ db: { handle: "legacy-db" } });
    mocks.recentLedgerEvents.mockResolvedValue([legacyEvent]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("keeps the legacy response and default limit when Go is not enabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(new Request("http://localhost/api/ledger"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ events: [{ ...legacyEvent, occurredAt: "2026-09-27T10:11:12.130Z" }] });
    expect(mocks.recentLedgerEvents).toHaveBeenCalledWith(resolved.orgId, { handle: "legacy-db" }, 60);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects anonymous requests before reading either backend", async () => {
    mocks.getResolvedUser.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(new Request("http://localhost/api/ledger"));

    expect(response.status).toBe(401);
    expect(mocks.recentLedgerEvents).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires accounting.read before it contacts Go", async () => {
    mocks.missingPermission.mockReturnValue(Response.json({ error: "forbidden" }, { status: 403 }));
    vi.stubEnv("GO_LEDGER_READ", "1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(new Request("http://localhost/api/ledger"));

    expect(response.status).toBe(403);
    expect(mocks.recentLedgerEvents).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a Go response only after permission checks and validates the wire shape", async () => {
    vi.stubEnv("GO_LEDGER_READ", "1");
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ events: [goEvent] }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(new Request("http://localhost/api/ledger?limit=0"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ events: [goEvent] });
    expect(mocks.createGoLedgerAssertion).toHaveBeenCalledWith(
      { userId: resolved.userId, orgId: resolved.orgId, canReadLedger: true },
      "test-only-shared-secret-value-32-bytes",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/__go/ledger?limit=1",
      expect.objectContaining({
        headers: { "X-Chaste-Session-Assertion": "signed-ledger-assertion" },
        cache: "no-store",
      }),
    );
  });

  it("fails closed when the Go owner does not return a valid response", async () => {
    vi.stubEnv("GO_LEDGER_READ", "1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "internal error" }, { status: 500 })));

    const response = await GET(new Request("http://localhost/api/ledger"));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "ledger service unavailable" });
  });

  it("returns legacy data in development shadow mode and reports differences", async () => {
    vi.stubEnv("GO_LEDGER_SHADOW", "1");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ events: [{ ...goEvent, hash: "different" }] })));

    const response = await GET(new Request("http://localhost/api/ledger"));

    expect(await response.json()).toEqual({ events: [{ ...legacyEvent, occurredAt: "2026-09-27T10:11:12.130Z" }] });
    expect(mocks.logger.warn).toHaveBeenCalledWith("Go ledger read differs from legacy data");
  });
});
