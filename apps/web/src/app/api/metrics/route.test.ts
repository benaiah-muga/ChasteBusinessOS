import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResolvedUser: vi.fn(),
  getDb: vi.fn(),
  desc: vi.fn(),
  eq: vi.fn(),
  readGoMetrics: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("@chaste/db", () => ({
  agentSessions: { tokenUsage: "tokenUsage", updatedAt: "updatedAt", orgId: "orgId" },
  getDb: mocks.getDb,
}));
vi.mock("drizzle-orm", () => ({ desc: mocks.desc, eq: mocks.eq }));
vi.mock("@/server/metrics-bridge", () => ({ readGoMetrics: mocks.readGoMetrics }));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));

import { GET } from "./route";

const resolved = {
  userId: "0b9e1bd3-8432-4059-a0b1-902ff8d520d0",
  orgId: "a5cb2579-9d6e-41ee-96d6-9af1c89bf250",
};
const note = "cachedInputTokens reflects provider-reported cache reads when available; null hit rate means no usage recorded yet.";
const goPayload = {
  totals: { sessionsTracked: 1, inputTokens: 100, outputTokens: 25, cachedInputTokens: 50, cacheHitRatePct: 50 },
  note,
};

describe("metrics route ownership adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_METRICS_READ", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.readGoMetrics.mockResolvedValue(goPayload);
    mocks.getDb.mockReturnValue({
      db: {
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async () => [
                  { tokenUsage: { input: 100, output: 25, cachedInput: 50 } },
                  { tokenUsage: { input: 0, output: 0, cachedInput: 0 } },
                ],
              }),
            }),
          }),
        }),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the legacy metrics calculation and owner by default", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ totals: goPayload.totals, note });
    expect(mocks.getDb).toHaveBeenCalledOnce();
    expect(mocks.readGoMetrics).not.toHaveBeenCalled();
  });

  it("returns only the explicitly enabled Go metrics response", async () => {
    vi.stubEnv("GO_METRICS_READ", "1");

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(goPayload);
    expect(mocks.readGoMetrics).toHaveBeenCalledWith({ userId: resolved.userId, orgId: resolved.orgId });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("rejects anonymous requests before either backend is used", async () => {
    mocks.getResolvedUser.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.readGoMetrics).not.toHaveBeenCalled();
  });

  it("fails closed when the explicitly selected Go owner is unavailable", async () => {
    vi.stubEnv("GO_METRICS_READ", "1");
    mocks.readGoMetrics.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "metrics service unavailable" });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
});
