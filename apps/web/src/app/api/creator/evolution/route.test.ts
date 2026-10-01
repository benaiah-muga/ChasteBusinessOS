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

import { POST } from "./route";

const user = {
  userId: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  authSessionId: "33333333-3333-4333-8333-333333333333",
  permissions: new Set(["platform.creator", "platform.creator.release"]),
};
const ctx = { actor: { type: "human", id: user.userId, orgId: user.orgId }, intentId: "creator-evolution-intent" };
const proposalId = "44444444-4444-4444-8444-444444444444";
const gapTicketId = "55555555-5555-4555-8555-555555555555";
const releaseId = "66666666-6666-4666-8666-666666666666";
const candidateDigest = "a".repeat(64);
const artifactRef = "artifact://creator/acme-plugin/1.2.3";

function request(body: unknown) {
  return new Request("http://localhost/api/creator/evolution", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Creator evolution Go route adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_CREATOR_EVOLUTION_WRITES", "0");
    mocks.getResolvedUser.mockResolvedValue(user);
    mocks.actorFromResolved.mockReturnValue(ctx);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { releaseId, status: "staged" } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    {
      action: "stage",
      body: { action: "stage", proposalId, gapTicketId, candidateDigest, artifactRef },
      capabilityId: "creator.stageCandidate",
      input: { proposalId, gapTicketId, candidateDigest, artifactRef },
      data: { releaseId, status: "staged", gapTicketId, candidateDigest, artifactRef },
    },
    {
      action: "promote",
      body: { action: "promote", releaseId, candidateDigest },
      capabilityId: "creator.promoteCandidate",
      input: { releaseId, candidateDigest },
      data: { releaseId, status: "promoted", gapTicketId, candidateDigest, artifactRef },
    },
    {
      action: "rollback",
      body: { action: "rollback", releaseId, candidateDigest },
      capabilityId: "creator.rollbackCandidate",
      input: { releaseId, candidateDigest },
      data: { releaseId, status: "rolled_back", candidateDigest, artifactRef },
    },
    {
      action: "canary",
      body: {
        action: "canary", releaseId, gapTicketId, candidateDigest, verdict: "pass",
        evidenceRef: "evidence://creator/canary/run-1", metrics: { errors: 0 },
      },
      capabilityId: "creator.recordCanaryOutcome",
      input: {
        releaseId, gapTicketId, candidateDigest, verdict: "pass",
        evidenceRef: "evidence://creator/canary/run-1", metrics: { errors: 0 },
      },
      data: { outcomeId: "77777777-7777-4777-8777-777777777777", releaseId, gapTicketId, candidateDigest, phase: "canary", verdict: "pass" },
    },
  ])("dispatches $action through the governed Go capability", async ({ body, capabilityId, input, data }) => {
    vi.stubEnv("GO_CREATOR_EVOLUTION_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data, replayed: true }),
    });

    const response = await POST(request({ ...body, intentId: ctx.intentId }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: ctx,
      session: user,
      capabilityId,
      input,
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps TypeScript as the default route owner when the Go flag is off", async () => {
    const body = { action: "stage", proposalId, gapTicketId, candidateDigest, artifactRef, intentId: ctx.intentId };

    const response = await POST(request(body));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { releaseId, status: "staged" } });
    expect(mocks.execute).toHaveBeenCalledWith("creator.stageCandidate", ctx, {
      proposalId, gapTicketId, candidateDigest, artifactRef,
    });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("preserves human approval responses without exposing internal approval IDs", async () => {
    vi.stubEnv("GO_CREATOR_EVOLUTION_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({
        ok: false, pendingApproval: true, reason: "Human approval required", approvalId: "private-id",
      }, { status: 202 }),
    });

    const response = await POST(request({ action: "promote", releaseId, candidateDigest }));

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: false, pendingApproval: true, reason: "Human approval required" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("preserves governed capability failures", async () => {
    vi.stubEnv("GO_CREATOR_EVOLUTION_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: false, error: "release digest mismatch" }, { status: 422 }),
    });

    const response = await POST(request({ action: "rollback", releaseId, candidateDigest }));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ ok: false, error: "release digest mismatch" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "not-dispatched" },
    { kind: "outcome-unknown" },
  ])("fails closed without replaying through TypeScript on Go result $kind", async (result) => {
    vi.stubEnv("GO_CREATOR_EVOLUTION_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue(result);

    const response = await POST(request({ action: "promote", releaseId, candidateDigest }));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { ok: true, data: { releaseId, status: "promoted", gapTicketId, candidateDigest, artifactRef } },
    { ok: true, data: { releaseId, status: "staged", gapTicketId, candidateDigest, artifactRef, unexpected: true } },
  ])("fails closed on malformed or non-exact Go outputs", async (body) => {
    vi.stubEnv("GO_CREATOR_EVOLUTION_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json(body) });

    const response = await POST(request({ action: "stage", proposalId, gapTicketId, candidateDigest, artifactRef }));

    expect(response.status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("retains authentication, validation, and onboarding gates before Go dispatch", async () => {
    vi.stubEnv("GO_CREATOR_EVOLUTION_WRITES", "1");
    mocks.getResolvedUser.mockResolvedValue(null);
    const unauthorized = await POST(request({ action: "stage" }));
    expect(unauthorized.status).toBe(401);

    mocks.getResolvedUser.mockResolvedValue(user);
    const invalid = await POST(request({ action: "unknown" }));
    expect(invalid.status).toBe(400);

    mocks.actorFromResolved.mockReturnValue(null);
    const onboarding = await POST(request({ action: "stage", proposalId, gapTicketId, candidateDigest, artifactRef }));
    expect(onboarding.status).toBe(428);
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });
});
