import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResolvedUser: vi.fn(),
  actorFromResolved: vi.fn(),
  buildExecutor: vi.fn(),
  buildRegistry: vi.fn(),
  execute: vi.fn(),
  getDb: vi.fn(),
  verifyPlugin: vi.fn(),
  executeGoCapability: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("drizzle-orm", () => ({ desc: vi.fn() }));
vi.mock("@chaste/db", () => ({ getDb: mocks.getDb, marketplaceListings: { id: {}, slug: {}, name: {}, version: {}, summary: {}, status: {}, capabilityIds: {}, installedByOrgIds: {}, updatedAt: {} } }));
vi.mock("@chaste/plugin-kit", () => ({ verifyPlugin: mocks.verifyPlugin }));
vi.mock("@/server/kernel", () => ({ actorFromResolved: mocks.actorFromResolved, buildExecutor: mocks.buildExecutor, buildRegistry: mocks.buildRegistry }));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/go-bridge", () => ({ executeGoCapability: mocks.executeGoCapability }));

import { GET, POST } from "./route";

const user = {
  userId: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  authSessionId: "session-1",
  permissions: new Set(["platform.creator"]),
};
const actionContext = { actor: { type: "human", id: user.userId, orgId: user.orgId }, intentId: "marketplace-intent" };
const listingId = "33333333-3333-4333-8333-333333333333";
const signedManifest = { formatVersion: 1, slug: "acme-warehouse", name: "Acme Warehouse", version: "1.2.3", summary: "Warehouse tools", capabilities: ["acme.count"], risks: { "acme.count": "write" } };

function request(body: unknown) {
  return new Request("http://localhost/api/marketplace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function resultBody(response: Response) {
  return response.json();
}

function mockLegacyListings(rows: Array<Record<string, unknown>>) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ orderBy }));
  const select = vi.fn(() => ({ from }));
  mocks.getDb.mockReturnValue({ db: { select } });
  return { select, from, orderBy, limit };
}

describe("marketplace Go POST bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_CREATOR_MARKETPLACE_VERIFY", "0");
    vi.stubEnv("GO_CREATOR_MARKETPLACE_WRITES", "0");
    vi.stubEnv("GO_CREATOR_MARKETPLACE_READS", "0");
    mocks.getResolvedUser.mockResolvedValue(user);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    mocks.getDb.mockReturnValue({ db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          orderBy: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })),
        })),
      })),
    } });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { done: true } });
    mocks.verifyPlugin.mockReturnValue({ valid: true });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("keeps Marketplace reads on the legacy query by default", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await resultBody(response)).toEqual({ listings: [] });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("keeps the legacy authenticated-org GET contract for members without platform.browse", async () => {
    const member = { ...user, permissions: new Set<string>(), enabledModules: [] };
    mocks.getResolvedUser.mockResolvedValue(member);
    const rows = [
      {
        id: listingId,
        slug: "submitted-package",
        name: "Submitted Package",
        version: "1.0.0",
        summary: "Awaiting verification",
        status: "submitted",
        capabilityIds: ["acme.read"],
        installedByOrgIds: [user.orgId],
        updatedAt: new Date("2026-01-02T03:04:05.000Z"),
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        slug: "rejected-package",
        name: "Rejected Package",
        version: "0.9.0",
        summary: "Rejected listing",
        status: "rejected",
        capabilityIds: [],
        installedByOrgIds: ["55555555-5555-4555-8555-555555555555"],
        updatedAt: new Date("2026-01-01T03:04:05.000Z"),
      },
    ];
    const query = mockLegacyListings(rows);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await resultBody(response)).toEqual({
      listings: [
        { ...rows[0], updatedAt: "2026-01-02T03:04:05.000Z", installedHere: true },
        { ...rows[1], updatedAt: "2026-01-01T03:04:05.000Z", installedHere: false },
      ],
    });
    expect(query.limit).toHaveBeenCalledWith(100);
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it.each(["0", "1"])("keeps Marketplace GET authentication in front of the %s Go read flag", async (enabled) => {
    vi.stubEnv("GO_CREATOR_MARKETPLACE_READS", enabled);
    mocks.getResolvedUser.mockResolvedValueOnce(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(await resultBody(response)).toEqual({ error: "unauthorized" });
    expect(mocks.actorFromResolved).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("bridges Marketplace reads to the governed Go capability when enabled", async () => {
    vi.stubEnv("GO_CREATOR_MARKETPLACE_READS", "1");
    const listing = {
      id: listingId,
      slug: "acme-warehouse",
      name: "Acme Warehouse",
      version: "1.2.3",
      summary: "Warehouse tools",
      status: "verified",
      capabilityIds: ["acme.count", { experimental: true }],
      installedByOrgIds: [user.orgId],
      installedHere: true,
      updatedAt: "2026-01-02T03:04:05.000Z",
    };
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: { listings: [listing] } }),
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await resultBody(response)).toEqual({ listings: [listing] });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext,
      session: user,
      capabilityId: "creator.listMarketplace",
      input: {},
    });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("dispatches opted-in reads for org members without platform.browse", async () => {
    vi.stubEnv("GO_CREATOR_MARKETPLACE_READS", "1");
    const member = { ...user, permissions: new Set<string>(), enabledModules: [] };
    mocks.getResolvedUser.mockResolvedValue(member);
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { listings: [] } }) });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await resultBody(response)).toEqual({ listings: [] });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext,
      session: member,
      capabilityId: "creator.listMarketplace",
      input: {},
    });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it.each([
    { label: "malformed listing", response: Response.json({ ok: true, data: { listings: [{ id: listingId }] } }) },
    { label: "unexpected envelope field", response: Response.json({ ok: true, data: { listings: [] }, extra: true }) },
    { label: "unknown outcome", result: { kind: "outcome-unknown" } },
    { label: "not dispatched", result: { kind: "not-dispatched" } },
  ])("fails closed on a Go read $label without falling back", async ({ response, result }) => {
    vi.stubEnv("GO_CREATOR_MARKETPLACE_READS", "1");
    mocks.executeGoCapability.mockResolvedValue(result ?? { kind: "response", response });

    const actual = await GET();

    expect(actual.status).toBe(503);
    expect(await resultBody(actual)).toEqual({ error: "Go marketplace service unavailable" });
    expect(actual.headers.get("cache-control")).toBe("no-store");
    expect(mocks.executeGoCapability).toHaveBeenCalledTimes(1);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("keeps verification on the TypeScript verifier by default", async () => {
    mocks.verifyPlugin.mockReturnValue({ valid: false, reason: "invalid signature" });
    const response = await POST(request({ action: "verify", manifest: signedManifest, signatureBase64: "sig", publisherPublicKeyBase64: "key" }));

    expect(response.status).toBe(422);
    expect(await resultBody(response)).toEqual({ valid: false, reason: "invalid signature" });
    expect(mocks.verifyPlugin).toHaveBeenCalledWith(signedManifest, "sig", "key");
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("applies the existing authentication and onboarding gates before Go dispatch", async () => {
    vi.stubEnv("GO_CREATOR_MARKETPLACE_WRITES", "1");
    mocks.getResolvedUser.mockResolvedValueOnce(null);
    const unauthorized = await POST(request({ action: "install", listingId }));
    expect(unauthorized.status).toBe(401);
    expect(await resultBody(unauthorized)).toEqual({ error: "unauthorized" });

    mocks.getResolvedUser.mockResolvedValueOnce(user);
    mocks.actorFromResolved.mockReturnValueOnce(null);
    const onboardingRequired = await POST(request({ action: "install", listingId }));
    expect(onboardingRequired.status).toBe(428);
    expect(await resultBody(onboardingRequired)).toEqual({ error: "onboarding required" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("keeps publish and approval handling on the TypeScript executor by default", async () => {
    mocks.execute.mockResolvedValue({ ok: false, pendingApproval: true, error: "approval required" });
    const response = await POST(request({ action: "publish", manifest: signedManifest, signatureBase64: "sig", publisherPublicKeyBase64: "key" }));

    expect(response.status).toBe(202);
    expect(await resultBody(response)).toEqual({ ok: false, pendingApproval: true, reason: "approval required" });
    expect(mocks.execute).toHaveBeenCalledWith("creator.publishListing", actionContext, {
      manifest: signedManifest,
      signatureBase64: "sig",
      publisherPublicKeyBase64: "key",
    });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it.each([
    { action: "install", capabilityId: "creator.installListing" },
    { action: "uninstall", capabilityId: "creator.uninstallListing" },
  ])("keeps $action on the legacy executor when Go writes are disabled", async ({ action, capabilityId }) => {
    const response = await POST(request({ action, listingId }));

    expect(response.status).toBe(200);
    expect(await resultBody(response)).toEqual({ ok: true, data: { done: true } });
    expect(mocks.execute).toHaveBeenCalledWith(capabilityId, actionContext, { listingId });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("dispatches verification to Go only when its flag is enabled and maps the verdict", async () => {
    vi.stubEnv("GO_CREATOR_MARKETPLACE_VERIFY", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: { valid: false, reason: "signature does not match" } }),
    });
    const response = await POST(request({ action: "verify", manifest: signedManifest, signatureBase64: "sig", publisherPublicKeyBase64: "key" }));

    expect(response.status).toBe(422);
    expect(await resultBody(response)).toEqual({ valid: false, reason: "signature does not match" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext,
      session: user,
      capabilityId: "creator.verifyPlugin",
      input: { manifest: signedManifest, signatureBase64: "sig", publisherPublicKeyBase64: "key" },
    });
    expect(mocks.verifyPlugin).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("maps a Go verification refusal to the legacy verdict contract", async () => {
    vi.stubEnv("GO_CREATOR_MARKETPLACE_VERIFY", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: false, error: "manifest signature is invalid" }, { status: 422 }),
    });
    const response = await POST(request({ action: "verify", manifest: signedManifest, signatureBase64: "sig", publisherPublicKeyBase64: "key" }));

    expect(response.status).toBe(422);
    expect(await resultBody(response)).toEqual({ valid: false, reason: "manifest signature is invalid" });
  });

  it("preserves Go verification permission failures as API errors", async () => {
    vi.stubEnv("GO_CREATOR_MARKETPLACE_VERIFY", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ error: "missing capability permission platform.creator" }, { status: 403 }),
    });
    const response = await POST(request({ action: "verify", manifest: signedManifest, signatureBase64: "sig", publisherPublicKeyBase64: "key" }));

    expect(response.status).toBe(403);
    expect(await resultBody(response)).toEqual({ ok: false, error: "missing capability permission platform.creator" });
  });

  it.each([
    {
      action: "publish",
      capabilityId: "creator.publishListing",
      input: { manifest: signedManifest, signatureBase64: "sig", publisherPublicKeyBase64: "key" },
      output: { listingId, slug: "acme-warehouse", status: "verified" },
    },
    {
      action: "install",
      capabilityId: "creator.installListing",
      input: { listingId },
      output: { installed: true, slug: "acme-warehouse", version: "1.2.3" },
    },
    {
      action: "uninstall",
      capabilityId: "creator.uninstallListing",
      input: { listingId },
      output: { uninstalled: true },
    },
  ])("bridges $action to the governed Go capability and preserves its output", async ({ action, capabilityId, input, output }) => {
    vi.stubEnv("GO_CREATOR_MARKETPLACE_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: output }) });
    const response = await POST(request({ action, ...input }));

    expect(response.status).toBe(200);
    expect(await resultBody(response)).toEqual({ ok: true, data: output });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({ actionContext, session: user, capabilityId, input });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("preserves a pending Go approval without dispatching the legacy executor", async () => {
    vi.stubEnv("GO_CREATOR_MARKETPLACE_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: false, pendingApproval: true, reason: "Publishing requires approval", approvalId: listingId }, { status: 202 }),
    });
    const response = await POST(request({ action: "publish", manifest: signedManifest, signatureBase64: "sig", publisherPublicKeyBase64: "key" }));

    expect(response.status).toBe(202);
    expect(await resultBody(response)).toEqual({ ok: false, pendingApproval: true, reason: "Publishing requires approval" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { status: 422, body: { ok: false, error: "signature no longer verifies" }, expectedStatus: 422, expectedBody: { ok: false, error: "signature no longer verifies" } },
    { status: 400, body: { error: "invalid input" }, expectedStatus: 422, expectedBody: { ok: false, error: "invalid input" } },
    { status: 403, body: { error: "missing permission: platform.creator" }, expectedStatus: 422, expectedBody: { ok: false, error: "missing permission: platform.creator" } },
    { status: 401, body: { error: "unauthorized" }, expectedStatus: 401, expectedBody: { error: "unauthorized" } },
  ])("preserves Go authorization and capability errors with status $status", async ({ status, body, expectedStatus, expectedBody }) => {
    vi.stubEnv("GO_CREATOR_MARKETPLACE_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json(body, { status }) });
    const response = await POST(request({ action: "install", listingId }));

    expect(response.status).toBe(expectedStatus);
    expect(await resultBody(response)).toEqual(expectedBody);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { label: "malformed output", result: { kind: "response", response: Response.json({ ok: true, data: { installed: true, slug: "x", version: "1", unexpected: true } }) } },
    { label: "unexpected envelope field", result: { kind: "response", response: Response.json({ ok: true, data: { installed: true, slug: "x", version: "1" }, extra: true }) } },
    { label: "not dispatched", result: { kind: "not-dispatched" } },
    { label: "outcome unknown", result: { kind: "outcome-unknown" } },
  ])("fails closed on $label after Go write dispatch", async ({ result }) => {
    vi.stubEnv("GO_CREATOR_MARKETPLACE_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue(result);
    const response = await POST(request({ action: "install", listingId }));

    expect(response.status).toBe(503);
    expect(await resultBody(response)).toEqual({ error: "Go marketplace service unavailable" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.executeGoCapability).toHaveBeenCalledTimes(1);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps legacy validation errors while the Go write flag is on", async () => {
    vi.stubEnv("GO_CREATOR_MARKETPLACE_WRITES", "1");
    const response = await POST(request({ action: "publish", manifest: signedManifest }));

    expect(response.status).toBe(400);
    expect(await resultBody(response)).toEqual({ error: "manifest, signature and publisher key required" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
