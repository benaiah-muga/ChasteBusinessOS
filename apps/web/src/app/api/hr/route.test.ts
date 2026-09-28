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
vi.mock("drizzle-orm", () => ({ and: vi.fn(), desc: vi.fn(), eq: vi.fn(), isNull: vi.fn(), sql: vi.fn() }));
vi.mock("@chaste/db", () => ({
  getDb: mocks.getDb,
  employees: {},
  leaveRequests: {},
  payrollRuns: {},
  jobOpenings: {},
  timeEntries: {},
}));
vi.mock("@/server/kernel", () => ({ actorFromResolved: mocks.actorFromResolved, buildExecutor: mocks.buildExecutor, buildRegistry: mocks.buildRegistry }));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/route-guards", () => ({ missingPermission: vi.fn(() => null) }));
vi.mock("@/server/go-bridge", () => ({ executeGoCapability: mocks.executeGoCapability }));

import { POST } from "./route";

const resolved = {
  userId: "0b9e1bd3-8432-4059-a0b1-902ff8d520d0",
  orgId: "a5cb2579-9d6e-41ee-96d6-9af1c89bf250",
  authSessionId: "better-auth-session",
  permissions: new Set(["hr.read", "hr.write"]),
};
const actor = {
  type: "human",
  id: resolved.userId,
  orgId: resolved.orgId,
  permissions: resolved.permissions,
};
const actionContext = { actor, intentId: "hr-intent-1" };
const employeeId = "f3c65071-356d-48e4-b5cb-cccd4fc06f6d";
const managerId = "229cda1d-0ad9-4198-bec0-58858b11610e";

function request(body: unknown) {
  return new Request("http://localhost/api/hr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("HR route migration adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_HR_EMPLOYEE_WRITES", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    mocks.getDb.mockReturnValue({ db: { handle: "legacy-db" } });
    mocks.buildRegistry.mockReturnValue({ handle: "legacy-registry" });
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { employeeId } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the three employee writes on the legacy executor when the flag is off", async () => {
    const hireInput = {
      name: "Asha Kato",
      email: "asha@example.test",
      title: "Technician",
      monthlySalaryMinor: 900000,
      taxRateBps: 1000,
      annualLeaveDays: 24,
    };
    await POST(request({ action: "hireEmployee", intentId: "hr-intent-1", ...hireInput }));
    await POST(request({ action: "deactivateEmployee", employeeId }));
    await POST(request({
      action: "updateStructure",
      employeeId,
      department: "Operations",
      position: "Lead",
      managerEmployeeId: managerId,
      emergencyContactName: "Jo Musoke",
      emergencyContactPhone: "0770000000",
    }));

    expect(mocks.execute).toHaveBeenNthCalledWith(1, "hr.hireEmployee", actionContext, hireInput);
    expect(mocks.execute).toHaveBeenNthCalledWith(2, "hr.deactivateEmployee", actionContext, { employeeId });
    expect(mocks.execute).toHaveBeenNthCalledWith(3, "hr.updateEmployeeStructure", actionContext, {
      employeeId,
      department: "Operations",
      position: "Lead",
      managerEmployeeId: managerId,
      emergencyContactName: "Jo Musoke",
      emergencyContactPhone: "0770000000",
    });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "hireEmployee",
      body: { action: "hireEmployee", intentId: "hr-intent-1", name: "Asha Kato", email: "asha@example.test", title: "Technician", monthlySalaryMinor: 900000, taxRateBps: 1000, annualLeaveDays: 24 },
      capabilityId: "hr.hireEmployee",
      input: { name: "Asha Kato", email: "asha@example.test", title: "Technician", monthlySalaryMinor: 900000, taxRateBps: 1000, annualLeaveDays: 24 },
      data: { employeeId },
    },
    {
      name: "deactivateEmployee",
      body: { action: "deactivateEmployee", employeeId },
      capabilityId: "hr.deactivateEmployee",
      input: { employeeId },
      data: { deactivated: true },
    },
    {
      name: "updateStructure",
      body: { action: "updateStructure", employeeId, department: "Operations", position: "Lead" },
      capabilityId: "hr.updateEmployeeStructure",
      input: { employeeId, department: "Operations", position: "Lead", managerEmployeeId: undefined, emergencyContactName: undefined, emergencyContactPhone: undefined },
      data: { updated: true },
    },
  ])("dispatches $name to Go with the exact legacy input when the flag is on", async ({ body, capabilityId, input, data }) => {
    vi.stubEnv("GO_HR_EMPLOYEE_WRITES", "1");
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

  it("normalizes approval, auth, and capability errors to the legacy HR response shapes", async () => {
    vi.stubEnv("GO_HR_EMPLOYEE_WRITES", "1");
    mocks.executeGoCapability
      .mockResolvedValueOnce({
        kind: "response",
        response: Response.json({ ok: false, pendingApproval: true, reason: "Approval required", approvalId: "private-approval-id" }, { status: 202 }),
      })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ error: "unauthorized" }, { status: 401 }) })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ error: "forbidden: missing permission: hr.write" }, { status: 403 }) })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ ok: false, error: "employee not found" }, { status: 422 }) });
    const deactivateRequest = () => request({ action: "deactivateEmployee", employeeId });

    const pending = await POST(deactivateRequest());
    const unauthorized = await POST(deactivateRequest());
    const denied = await POST(deactivateRequest());
    const invalid = await POST(deactivateRequest());

    expect(pending.status).toBe(202);
    expect(pending.headers.get("cache-control")).toBe("no-store");
    expect(await pending.json()).toEqual({ ok: false, pendingApproval: true, reason: "Approval required" });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "unauthorized" });
    expect(denied.status).toBe(422);
    expect(await denied.json()).toEqual({ ok: false, error: "forbidden: missing permission: hr.write" });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({ ok: false, error: "employee not found" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { name: "not dispatched", result: { kind: "not-dispatched" } },
    { name: "unknown outcome", result: { kind: "outcome-unknown" } },
    { name: "malformed success", result: { kind: "response", response: Response.json({ ok: true, data: { employeeId: 42 } }) } },
  ])("fails closed on $name without retrying through TypeScript", async ({ result }) => {
    vi.stubEnv("GO_HR_EMPLOYEE_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue(result);

    const response = await POST(request({ action: "hireEmployee", name: "Asha Kato" }));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "HR service unavailable; check employee status before retrying" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("fails closed if the Go dispatch throws", async () => {
    vi.stubEnv("GO_HR_EMPLOYEE_WRITES", "1");
    mocks.executeGoCapability.mockRejectedValue(new Error("bridge timeout"));

    const response = await POST(request({ action: "hireEmployee", name: "Asha Kato" }));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "HR service unavailable; check employee status before retrying" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps other HR actions and the legacy parameter checks outside the bridge", async () => {
    vi.stubEnv("GO_HR_EMPLOYEE_WRITES", "1");

    const leave = await POST(request({
      action: "requestLeave",
      employeeId,
      kind: "annual",
      startDate: "2026-10-01",
      endDate: "2026-10-05",
    }));
    expect(leave.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledWith("hr.requestLeave", actionContext, {
      employeeId,
      kind: "annual",
      startDate: "2026-10-01",
      endDate: "2026-10-05",
    });

    const missingEmployee = await POST(request({ action: "deactivateEmployee" }));
    expect(missingEmployee.status).toBe(400);
    expect(await missingEmployee.json()).toEqual({ error: "missing parameters for action" });

    const noAction = await POST(request({ employeeId }));
    expect(noAction.status).toBe(400);
    expect(await noAction.json()).toEqual({ error: "action required" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("keeps employee writes behind authentication, onboarding, and body validation", async () => {
    vi.stubEnv("GO_HR_EMPLOYEE_WRITES", "1");
    mocks.getResolvedUser.mockResolvedValue(null);
    const anonymous = await POST(request({ action: "hireEmployee", name: "Asha Kato" }));
    expect(anonymous.status).toBe(401);

    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(null);
    const onboarding = await POST(request({ action: "hireEmployee", name: "Asha Kato" }));
    expect(onboarding.status).toBe(428);

    mocks.actorFromResolved.mockReturnValue(actionContext);
    const noName = await POST(request({ action: "hireEmployee" }));
    expect(noName.status).toBe(503);
    expect(await noName.json()).toEqual({ error: "HR service unavailable; check employee status before retrying" });
    expect(mocks.executeGoCapability).toHaveBeenCalledTimes(1);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
