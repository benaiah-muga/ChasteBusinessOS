import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResolvedUser: vi.fn(),
  getDb: vi.fn(),
  isEnabled: vi.fn(),
  execute: vi.fn(),
  executeGoCapability: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("drizzle-orm", () => ({ and: vi.fn(), desc: vi.fn(), eq: vi.fn(), gt: vi.fn() }));
vi.mock("@chaste/db", () => ({ getDb: mocks.getDb, employees: {}, timeEntries: {} }));
vi.mock("@/server/kernel", () => ({
  actorFromResolved: vi.fn(() => ({ actor: { orgId: "org-1" } })),
  buildExecutor: vi.fn(() => ({ execute: mocks.execute })),
  buildRegistry: vi.fn(() => ({})),
  createDbModuleGate: vi.fn(() => ({ isEnabled: mocks.isEnabled })),
}));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/go-bridge", () => ({ executeGoCapability: mocks.executeGoCapability }));

import { GET } from "./route";

describe("GET /api/time HR module gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getResolvedUser.mockResolvedValue({ orgId: "org-1" });
    mocks.getDb.mockReturnValue({ db: { select: vi.fn() } });
    mocks.isEnabled.mockResolvedValue(false);
    mocks.execute.mockResolvedValue({ ok: true, data: { rows: [] } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
    vi.stubEnv("GO_HR_TIME_REPORT_READS", "0");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("blocks pending time data when HR is disabled", async () => {
    const response = await GET(new Request("http://localhost/api/time?pending=1"));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "People module is disabled" });
    expect(mocks.isEnabled).toHaveBeenCalledWith("org-1", "hr");
    expect(mocks.getDb.mock.results[0]?.value.db.select).not.toHaveBeenCalled();
  });

  it("returns pending time entries when HR is enabled", async () => {
    const entry = {
      id: "entry-1",
      employeeId: "employee-1",
      employeeName: "Amina",
      workDate: new Date("2026-10-01T00:00:00.000Z"),
      minutes: 60,
      note: null,
      late: false,
    };
    const builder: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ["from", "innerJoin", "where", "orderBy"]) builder[method] = vi.fn(() => builder);
    builder.limit = vi.fn().mockResolvedValue([entry]);
    mocks.getDb.mockReturnValue({ db: { select: vi.fn(() => builder) } });
    mocks.isEnabled.mockResolvedValue(true);

    const response = await GET(new Request("http://localhost/api/time?pending=1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entries: [{ ...entry, workDate: entry.workDate.toISOString() }] });
    expect(mocks.isEnabled).toHaveBeenCalledWith("org-1", "hr");
  });

  it("keeps time reports on the TypeScript capability by default", async () => {
    mocks.isEnabled.mockResolvedValue(true);
    const response = await GET(new Request("http://localhost/api/time?from=2026-09-01&to=2026-09-30"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rows: [] });
    expect(mocks.execute).toHaveBeenCalledWith("hr.timeReport", { actor: { orgId: "org-1" } }, {
      from: new Date("2026-09-01"),
      to: new Date("2026-09-30"),
      employeeId: undefined,
    });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("uses the Go time-report capability when explicitly enabled", async () => {
    vi.stubEnv("GO_HR_TIME_REPORT_READS", "1");
    mocks.isEnabled.mockResolvedValue(true);
    const rows = [{ employeeId: "employee-1", approvedMinutes: 60, pendingMinutes: 30 }];
    mocks.executeGoCapability.mockResolvedValueOnce({
      kind: "response",
      response: Response.json({ ok: true, data: { rows } }),
    });

    const response = await GET(new Request("http://localhost/api/time?from=2026-09-01&to=2026-09-30&employeeId=employee-1"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ rows });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith(expect.objectContaining({
      session: { orgId: "org-1" },
      capabilityId: "hr.timeReport",
      input: { from: "2026-09-01", to: "2026-09-30", employeeId: "employee-1" },
    }));
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("fails closed when the enabled Go time-report bridge is unavailable or malformed", async () => {
    vi.stubEnv("GO_HR_TIME_REPORT_READS", "1");
    mocks.isEnabled.mockResolvedValue(true);
    for (const result of [
      { kind: "outcome-unknown" },
      { kind: "response", response: Response.json({ ok: true, data: { rows: [{ employeeId: "employee-1" }] } }) },
    ]) {
      mocks.executeGoCapability.mockResolvedValueOnce(result);
      const response = await GET(new Request("http://localhost/api/time?from=2026-09-01&to=2026-09-30"));
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "HR time report service unavailable" });
    }
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps pending entries on the org-scoped read with the same response shape when Go is enabled", async () => {
    vi.stubEnv("GO_HR_TIME_REPORT_READS", "1");
    const entry = {
      id: "entry-1",
      employeeId: "employee-1",
      employeeName: "Amina",
      workDate: new Date("2026-10-01T00:00:00.000Z"),
      minutes: 60,
      note: null,
      late: false,
    };
    const builder: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ["from", "innerJoin", "where", "orderBy"]) builder[method] = vi.fn(() => builder);
    builder.limit = vi.fn().mockResolvedValue([entry]);
    mocks.getDb.mockReturnValue({ db: { select: vi.fn(() => builder) } });
    mocks.isEnabled.mockResolvedValue(true);

    const response = await GET(new Request("http://localhost/api/time?pending=1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entries: [{ ...entry, workDate: entry.workDate.toISOString() }] });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });
});
