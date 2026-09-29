import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResolvedUser: vi.fn(),
  actorFromResolved: vi.fn(),
  buildExecutor: vi.fn(),
  buildRegistry: vi.fn(),
  execute: vi.fn(),
  getDb: vi.fn(),
  ensureBuiltinTemplates: vi.fn(),
  executeGoCapability: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("@chaste/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/server/kernel", () => ({ actorFromResolved: mocks.actorFromResolved, buildExecutor: mocks.buildExecutor, buildRegistry: mocks.buildRegistry }));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/doc-templates", () => ({ ensureBuiltinTemplates: mocks.ensureBuiltinTemplates }));
vi.mock("@/server/go-bridge", () => ({ executeGoCapability: mocks.executeGoCapability }));

import { GET } from "./route";

const resolved = {
  userId: "0b9e1bd3-8432-4059-a0b1-902ff8d520d0",
  orgId: "a5cb2579-9d6e-41ee-96d6-9af1c89bf250",
  authSessionId: "better-auth-session",
  permissions: new Set(["documents.read"]),
};
const actor = {
  type: "human",
  id: resolved.userId,
  orgId: resolved.orgId,
  permissions: resolved.permissions,
};
const actionContext = { actor, intentId: "docs-list-intent" };
const doc = {
  id: "7a7b152e-7e80-496b-952c-275067fef54f",
  title: "Invoice proof",
  status: "draft",
  versions: 2,
  templateId: null,
  folder: "Finance",
  documentType: "invoice",
  linkedRecordType: "customer",
  linkedRecordId: null,
  linkedRecordLabel: "Acme",
  updatedAt: "2026-09-09T12:30:15.123Z",
};
const templates = [{ id: "8b8c263f-8e81-407c-a963-386be680654f", name: "Invoice", placeholders: [], content: {} }];

describe("Documents authored-list Go bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_DOCUMENTS_LIST_READS", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    mocks.getDb.mockReturnValue({ db: { handle: "legacy-db" } });
    mocks.buildRegistry.mockReturnValue({ handle: "legacy-registry" });
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockImplementation(async (capabilityId: string) => capabilityId === "documents.listDocs"
      ? { ok: true, data: { documents: [doc] } }
      : { ok: true, data: { templates } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("keeps authored documents on the legacy executor when the flag is off", async () => {
    const response = await GET(new Request("http://localhost/api/docs"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ documents: [doc], templates });
    expect(mocks.execute).toHaveBeenNthCalledWith(1, "documents.listDocs", actionContext, {});
    expect(mocks.execute).toHaveBeenNthCalledWith(2, "documents.listTemplates", actionContext, {});
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("reads authored documents through Go and keeps templates on the legacy executor", async () => {
    vi.stubEnv("GO_DOCUMENTS_LIST_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { documents: [doc] } }) });

    const response = await GET(new Request("http://localhost/api/docs"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ documents: [doc], templates });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext,
      session: resolved,
      capabilityId: "documents.listDocs",
      input: {},
    });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.execute).toHaveBeenCalledWith("documents.listTemplates", actionContext, {});
  });

  it("fails closed after Go dispatch without retrying the authored-document read", async () => {
    vi.stubEnv("GO_DOCUMENTS_LIST_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "outcome-unknown" });

    const response = await GET(new Request("http://localhost/api/docs"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Go documents service unavailable" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { status: 401, body: { error: "unauthorized" }, expected: { error: "unauthorized" } },
    { status: 403, body: { error: "forbidden" }, expected: { error: "forbidden" } },
    { status: 422, body: { ok: false, error: "forbidden: missing permission: documents.read" }, expected: { error: "forbidden: missing permission: documents.read" } },
  ])("preserves Go authorization responses with status $status", async ({ status, body, expected }) => {
    vi.stubEnv("GO_DOCUMENTS_LIST_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json(body, { status }) });

    const response = await GET(new Request("http://localhost/api/docs"));

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(expected);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects malformed Go documents before returning the legacy templates", async () => {
    vi.stubEnv("GO_DOCUMENTS_LIST_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { documents: [{ id: doc.id }] } }) });

    const response = await GET(new Request("http://localhost/api/docs"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Go documents service unavailable" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
