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
vi.mock("@/server/kernel", () => ({ actorFromResolved: mocks.actorFromResolved, buildExecutor: mocks.buildExecutor, buildRegistry: mocks.buildRegistry }));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/go-bridge", () => ({ executeGoCapability: mocks.executeGoCapability }));

import { GET } from "./route";

const resolved = {
  userId: "0b9e1bd3-8432-4059-a0b1-902ff8d520d0",
  orgId: "a5cb2579-9d6e-41ee-96d6-9af1c89bf250",
  authSessionId: "better-auth-session",
  permissions: new Set(["documents.read"]),
};
const actor = { type: "human", id: resolved.userId, orgId: resolved.orgId, permissions: resolved.permissions };
const actionContext = { actor, intentId: null };
const document = { id: "7a7b152e-7e80-496b-952c-275067fef54f", title: "Versioned proof" };
const versions = [{ version: 2, note: null, createdBy: "workmate", createdAt: "2026-09-30T10:11:12.345Z" }];

describe("Authored document version Go bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_DOCUMENTS_VERSION_READS", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockImplementation(async (capabilityId: string) => capabilityId === "documents.getDoc"
      ? { ok: true, data: { document } }
      : { ok: true, data: { versions } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("keeps version history reads on the legacy executor when the flag is off", async () => {
    const response = await GET(new Request(`http://localhost/api/docs/${document.id}`), { params: Promise.resolve({ id: document.id }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ document, versions });
    expect(mocks.execute).toHaveBeenNthCalledWith(1, "documents.getDoc", actionContext, { documentId: document.id });
    expect(mocks.execute).toHaveBeenNthCalledWith(2, "documents.listDocVersions", actionContext, { documentId: document.id });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("uses signed Go for the version list while preserving the TypeScript document read", async () => {
    vi.stubEnv("GO_DOCUMENTS_VERSION_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { versions } }) });

    const response = await GET(new Request(`http://localhost/api/docs/${document.id}`), { params: Promise.resolve({ id: document.id }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ document, versions });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext,
      session: resolved,
      capabilityId: "documents.listDocVersions",
      input: { documentId: document.id },
    });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it("uses signed Go for a single version and keeps the public response projection", async () => {
    vi.stubEnv("GO_DOCUMENTS_VERSION_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: {
        version: 2, content: { heading: "Signed" }, html: "<p>Signed</p>", note: null, createdAt: "2026-09-30T10:11:12.345Z",
      } }),
    });

    const response = await GET(new Request(`http://localhost/api/docs/${document.id}?version=2`), { params: Promise.resolve({ id: document.id }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: 2, html: "<p>Signed</p>", note: null, createdAt: "2026-09-30T10:11:12.345Z" });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext,
      session: resolved,
      capabilityId: "documents.getDocVersion",
      input: { documentId: document.id, version: 2 },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("maps a missing Go document version to the legacy 404 response", async () => {
    vi.stubEnv("GO_DOCUMENTS_VERSION_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: false, error: "no version 7" }, { status: 422 }),
    });

    const response = await GET(new Request(`http://localhost/api/docs/${document.id}?version=7`), { params: Promise.resolve({ id: document.id }) });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no version 7" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("fails closed without retrying the TypeScript version query after Go dispatch", async () => {
    vi.stubEnv("GO_DOCUMENTS_VERSION_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "outcome-unknown" });

    const response = await GET(new Request(`http://localhost/api/docs/${document.id}`), { params: Promise.resolve({ id: document.id }) });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Go documents service unavailable" });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
});
