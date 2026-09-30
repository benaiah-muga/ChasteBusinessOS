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

import { GET, POST } from "./route";

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
const openingId = "e56d931d-dc62-48cc-81fd-19ca648978aa";
const applicant = { id: "adcb9db9-7864-4d57-94ec-9254f11a6d96", name: "Mira Okello", stage: "screen", note: null };

function request(body: unknown) {
  return new Request("http://localhost/api/hr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function configureHrReadDatabase() {
  const rows = [
    [],
    [],
    [],
    [{ id: openingId, status: "open", title: "Analyst", department: "Finance", note: null, createdAt: new Date("2026-09-30T10:00:00.000Z") }],
    [],
  ];
  let queryIndex = 0;
  mocks.getDb.mockReturnValue({ db: {
    select: vi.fn(() => {
      const result = rows[queryIndex++] ?? [];
      const builder: Record<string, ReturnType<typeof vi.fn>> = {};
      for (const method of ["from", "innerJoin", "where", "orderBy", "limit"]) {
        builder[method] = vi.fn().mockImplementation(() => method === "limit" ? Promise.resolve(result) : builder);
      }
      return builder;
    }),
  } });
}

describe("GET /api/hr Go applicant read bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_HR_APPLICANT_READS", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    configureHrReadDatabase();
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { applicants: [applicant] } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("keeps applicant reads on the TypeScript executor by default", async () => {
    delete process.env.GO_HR_APPLICANT_READS;

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBeNull();
    expect(body.applicants).toEqual([{ ...applicant, openingId }]);
    expect(mocks.execute).toHaveBeenCalledWith("hr.listApplicants", actionContext, { openingId });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("dispatches the matching applicant read with strict output validation", async () => {
    vi.stubEnv("GO_HR_APPLICANT_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: { applicants: [applicant] } }),
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.applicants).toEqual([{ ...applicant, openingId }]);
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext,
      session: {
        userId: resolved.userId,
        orgId: resolved.orgId,
        authSessionId: resolved.authSessionId,
      },
      capabilityId: "hr.listApplicants",
      input: { openingId },
    });
    expect(mocks.buildExecutor).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("fails closed without retrying through TypeScript when Go is unavailable or malformed", async () => {
    vi.stubEnv("GO_HR_APPLICANT_READS", "1");
    mocks.executeGoCapability.mockResolvedValueOnce({ kind: "outcome-unknown" });

    const unavailable = await GET();

    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
    expect(mocks.execute).not.toHaveBeenCalled();

    configureHrReadDatabase();
    mocks.executeGoCapability.mockResolvedValueOnce({
      kind: "response",
      response: Response.json({ ok: true, data: { applicants: [{ ...applicant, unexpected: true }] } }),
    });

    const malformed = await GET();

    expect(malformed.status).toBe(503);
    expect(malformed.headers.get("cache-control")).toBe("no-store");
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

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

describe("HR route Go leave-time and payroll-applicant bridges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_HR_EMPLOYEE_WRITES", "0");
    vi.stubEnv("GO_HR_LEAVE_TIME_WRITES", "0");
    vi.stubEnv("GO_HR_PAYROLL_APPLICANT_WRITES", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    mocks.getDb.mockReturnValue({ db: { handle: "legacy-db" } });
    mocks.buildRegistry.mockReturnValue({ handle: "legacy-registry" });
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { done: true } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { body: { action: "requestLeave", employeeId, kind: "annual", startDate: "2026-10-01", endDate: "2026-10-05" }, capabilityId: "hr.requestLeave", input: { employeeId, kind: "annual", startDate: "2026-10-01", endDate: "2026-10-05" } },
    { body: { action: "decideLeave", requestId: "req-1", approve: true }, capabilityId: "hr.decideLeave", input: { requestId: "req-1", approve: true } },
    { body: { action: "cancelLeave", requestId: "req-1" }, capabilityId: "hr.cancelLeave", input: { requestId: "req-1" } },
    { body: { action: "clockIn", employeeId }, capabilityId: "hr.clockIn", input: { employeeId } },
    { body: { action: "clockOut", employeeId }, capabilityId: "hr.clockOut", input: { employeeId } },
  ])("dispatches $body.action through the signed Go bridge behind GO_HR_LEAVE_TIME_WRITES", async ({ body, capabilityId, input }) => {
    vi.stubEnv("GO_HR_LEAVE_TIME_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { done: true }, replayed: true }) });
    const response = await POST(request({ ...body, intentId: "hr-intent-5" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: { done: true } });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({ actionContext, session: resolved, capabilityId, input });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { body: { action: "createPayrollRun", year: 2026, month: 8 }, capabilityId: "hr.createPayrollRun", input: { year: 2026, month: 8 } },
    { body: { action: "executePayrollRun", runId: "run-1", expectedTotalNetMinor: 96000 }, capabilityId: "hr.executePayrollRun", input: { runId: "run-1", expectedTotalNetMinor: 96000 } },
    { body: { action: "voidPayrollRun", runId: "run-1" }, capabilityId: "hr.voidPayrollRun", input: { runId: "run-1" } },
    { body: { action: "addApplicant", openingId: "opening-1", name: "Asha", email: "a@example.test", note: "Referral" }, capabilityId: "hr.addApplicant", input: { openingId: "opening-1", name: "Asha", email: "a@example.test", note: "Referral" } },
    { body: { action: "moveApplicant", applicantId: "app-1", stage: "interview" }, capabilityId: "hr.moveApplicant", input: { applicantId: "app-1", stage: "interview" } },
    { body: { action: "hireApplicant", applicantId: "app-1", monthlySalaryMinor: 3000000, annualLeaveDays: 21 }, capabilityId: "hr.hireApplicant", input: { applicantId: "app-1", monthlySalaryMinor: 3000000, annualLeaveDays: 21 } },
  ])("dispatches $body.action through the signed Go bridge behind GO_HR_PAYROLL_APPLICANT_WRITES", async ({ body, capabilityId, input }) => {
    vi.stubEnv("GO_HR_PAYROLL_APPLICANT_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { done: true } }) });
    const response = await POST(request({ ...body, intentId: "hr-intent-5" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { done: true } });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({ actionContext, session: resolved, capabilityId, input });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps leave, time, payroll, and applicant actions on the legacy executor while the flags are off", async () => {
    await POST(request({ action: "requestLeave", employeeId, kind: "annual", startDate: "2026-10-01", endDate: "2026-10-05" }));
    await POST(request({ action: "createPayrollRun", year: 2026, month: 8 }));
    expect(mocks.execute).toHaveBeenCalledWith("hr.requestLeave", actionContext, {
      employeeId, kind: "annual", startDate: "2026-10-01", endDate: "2026-10-05",
    });
    expect(mocks.execute).toHaveBeenCalledWith("hr.createPayrollRun", actionContext, { year: 2026, month: 8 });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("normalizes Go approvals and fails closed without retrying through TypeScript", async () => {
    vi.stubEnv("GO_HR_PAYROLL_APPLICANT_WRITES", "1");
    mocks.executeGoCapability
      .mockResolvedValueOnce({
        kind: "response",
        response: Response.json({ ok: false, pendingApproval: true, reason: "Approval required", approvalId: "private-id" }, { status: 202 }),
      })
      .mockResolvedValueOnce({ kind: "outcome-unknown" });

    const pending = await POST(request({ action: "executePayrollRun", runId: "run-1", expectedTotalNetMinor: 96000 }));
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ ok: false, pendingApproval: true, reason: "Approval required" });

    const unavailable = await POST(request({ action: "executePayrollRun", runId: "run-1", expectedTotalNetMinor: 96000 }));
    expect(unavailable.status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe("HR route Go openings bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_HR_EMPLOYEE_WRITES", "0");
    vi.stubEnv("GO_HR_LEAVE_TIME_WRITES", "0");
    vi.stubEnv("GO_HR_PAYROLL_APPLICANT_WRITES", "0");
    vi.stubEnv("GO_HR_OPENINGS_WRITE", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    mocks.getDb.mockReturnValue({ db: { handle: "legacy-db" } });
    mocks.buildRegistry.mockReturnValue({ handle: "legacy-registry" });
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { done: true } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("dispatches opening create and close through the signed Go bridge when enabled", async () => {
    vi.stubEnv("GO_HR_OPENINGS_WRITE", "1");
    mocks.executeGoCapability.mockImplementation(async () => ({
      kind: "response",
      response: Response.json({ ok: true, data: { openingId: "opening-1" }, replayed: true }),
    }));

    const created = await POST(request({ action: "createOpening", title: "Technician", department: "Ops", note: "Backfill" }));
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ ok: true, data: { openingId: "opening-1" } });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext, session: resolved, capabilityId: "hr.createOpening",
      input: { title: "Technician", department: "Ops", note: "Backfill" },
    });

    const closed = await POST(request({ action: "closeOpening", openingId: "opening-1" }));
    expect(closed.status).toBe(200);
    expect(mocks.executeGoCapability).toHaveBeenLastCalledWith({
      actionContext, session: resolved, capabilityId: "hr.closeOpening",
      input: { openingId: "opening-1" },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps openings on the legacy executor while the flag is off", async () => {
    await POST(request({ action: "createOpening", title: "Technician" }));
    expect(mocks.execute).toHaveBeenCalledWith("hr.createOpening", actionContext, { title: "Technician" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("fails closed without retrying through TypeScript when Go is unavailable", async () => {
    vi.stubEnv("GO_HR_OPENINGS_WRITE", "1");
    const response = await POST(request({ action: "closeOpening", openingId: "opening-1" }));
    expect(response.status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
