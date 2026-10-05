import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  getDurableRun: vi.fn(),
  getResolvedUser: vi.fn(),
  hasPermission: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("@chaste/db", () => ({ getDb: mocks.getDb }));
vi.mock("@chaste/kernel", () => ({ hasPermission: mocks.hasPermission }));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/durable-runs", () => ({
  getDurableRun: mocks.getDurableRun,
  DurableRunResponseLimitError: class DurableRunResponseLimitError extends Error {
    constructor() { super("durable run detail exceeds response limits"); }
  },
}));

import { GET } from "./route";
import { DurableRunResponseLimitError } from "@/server/durable-runs";

const user = {
  orgId: "a5cb2579-9d6e-41ee-96d6-9af1c89bf250",
  userId: "0b9e1bd3-8432-4059-a0b1-902ff8d520d0",
  permissions: new Set<string>(),
};
const runId = "7a7b152e-7e80-496b-952c-275067fef54f";

describe("durable-run detail visibility and size limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getResolvedUser.mockResolvedValue(user);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.hasPermission.mockReturnValue(false);
  });

  it("keeps missing and invisible oversized runs indistinguishable", async () => {
    mocks.getDurableRun.mockResolvedValue(null);
    const response = await GET(new Request(`http://localhost/api/durable-runs/${runId}`), { params: Promise.resolve({ id: runId }) });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
    expect(mocks.getDurableRun).toHaveBeenCalledWith({}, user.orgId, runId, { userId: user.userId, admin: false });
  });

  it("returns 413 only after the scoped reader confirms the run is visible", async () => {
    mocks.getDurableRun.mockRejectedValue(new DurableRunResponseLimitError());
    const response = await GET(new Request(`http://localhost/api/durable-runs/${runId}`), { params: Promise.resolve({ id: runId }) });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "durable run detail exceeds response limits" });
    expect(mocks.getDurableRun).toHaveBeenCalledWith({}, user.orgId, runId, { userId: user.userId, admin: false });
  });
});
