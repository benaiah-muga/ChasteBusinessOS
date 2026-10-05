import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  getResolvedUser: vi.fn(),
  hasPermission: vi.fn(),
  actorFromResolved: vi.fn(),
  buildExecutor: vi.fn(),
  buildRegistry: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("@chaste/db", () => ({ getDb: mocks.getDb }));
vi.mock("@chaste/kernel", () => ({ hasPermission: mocks.hasPermission }));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/kernel", () => ({
  actorFromResolved: mocks.actorFromResolved,
  buildExecutor: mocks.buildExecutor,
  buildRegistry: mocks.buildRegistry,
}));

import { POST } from "./route";

const resolved = {
  orgId: "a5cb2579-9d6e-41ee-96d6-9af1c89bf250",
  userId: "0b9e1bd3-8432-4059-a0b1-902ff8d520d0",
  permissions: new Set(["iam.admin"]),
};
const actionContext = { actor: { id: resolved.userId }, intentId: undefined };

describe("POST /api/modules request parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.hasPermission.mockReturnValue(true);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.actorFromResolved.mockReturnValue(actionContext);
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { enabledModules: ["iam", "routines", "signals"] } });
  });

  it("rejects request bodies over the Go route limit", async () => {
    const body = JSON.stringify({ modules: Array.from({ length: 12_000 }, () => "projects") });
    const response = await POST(new Request("http://localhost/api/modules", { method: "POST", body }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid body" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("preserves valid selection order and rejects invalid intent IDs", async () => {
    const invalid = await POST(new Request("http://localhost/api/modules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modules: ["projects"], intentId: "bad\u0000intent" }),
    }));
    expect(invalid.status).toBe(400);
    expect(mocks.execute).not.toHaveBeenCalled();

    const response = await POST(new Request("http://localhost/api/modules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modules: ["projects", "accounting", "projects"] }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledWith("iam.setModules", actionContext, {
      modules: ["projects", "accounting", "iam", "routines", "signals"],
    });
  });
});
