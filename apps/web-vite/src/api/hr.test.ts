import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGoHrReport, fetchHrEnabled, fetchHrReport, readPendingHrLeaveAction, submitHrAction, submitHrLeaveAction } from "./hr";
import type { HrApiError } from "./hr";

const switchboard = { catalog: [{ id: "hr" }], enabledModules: ["hr"] };
const report = {
  employees: [],
  leave: [],
  runs: [],
  openings: [],
  applicants: [],
  attendance: [],
};

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("Vite People API", () => {
  it("validates the module switchboard and employee report responses", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => input === "/api/modules"
      ? Response.json(switchboard)
      : Response.json(report));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchHrEnabled()).resolves.toBe(true);
    await expect(fetchHrReport()).resolves.toEqual(report);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/modules", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/hr", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
  });

  it("rejects malformed HR data instead of rendering partial records", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...report, employees: [{ id: "incomplete" }] })));
    await expect(fetchHrReport()).rejects.toMatchObject({
      name: "HrApiError",
      message: "The People service returned data in an unexpected format.",
    });
  });

  it("submits governed actions with a unique intent id and retains approval status", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.intentId).toEqual(expect.any(String));
      expect(body.action).toBe("hireEmployee");
      return new Response(JSON.stringify({ ok: false, pendingApproval: true, reason: "Approval required" }), { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitHrAction({ action: "hireEmployee", name: "Amina", monthlySalaryMinor: 100_000 })).resolves.toEqual({
      kind: "pending",
      data: { reason: "Approval required" },
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/hr", expect.objectContaining({ method: "POST", credentials: "same-origin" }));
  });

  it("reuses the intent id when retrying a write after a network timeout", async () => {
    const intentIds: string[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      intentIds.push(String(body.intentId));
      if (intentIds.length === 1) throw new Error("connection reset");
      return Response.json({ ok: true, data: { employeeId: "employee-1" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "hireEmployee" as const, name: "Amina", monthlySalaryMinor: 100_000 };

    await expect(submitHrAction(action)).rejects.toMatchObject({ status: 0 });
    await expect(submitHrAction(action)).resolves.toMatchObject({ kind: "success" });

    expect(intentIds).toHaveLength(2);
    expect(intentIds[1]).toBe(intentIds[0]);
  });

  it("keeps the intent id after an unreadable success response", async () => {
    const intentIds: string[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      intentIds.push(String(body.intentId));
      return intentIds.length === 1
        ? Response.json({ unexpected: true })
        : Response.json({ ok: true, data: { employeeId: "employee-1" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "hireEmployee" as const, name: "Mira", monthlySalaryMinor: 125_000 };

    await expect(submitHrAction(action)).rejects.toMatchObject({ status: 200 });
    await expect(submitHrAction(action)).resolves.toMatchObject({ kind: "success" });

    expect(intentIds).toHaveLength(2);
    expect(intentIds[1]).toBe(intentIds[0]);
  });

  it("surfaces permission failures as actionable API errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "forbidden: hr.read" }, { status: 403 })));
    await expect(fetchHrReport()).rejects.toEqual(expect.objectContaining({
      status: 403,
      message: "forbidden: hr.read",
    } satisfies Partial<HrApiError>));
  });

  it("loads the Go HR report through the session capability route", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ capabilityId: "hr.report", input: {}, intentId: expect.any(String) });
      return Response.json({ ok: true, data: report });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchGoHrReport()).resolves.toEqual(report);
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
  });

  it("keeps actor and organization scoped exact leave attempts through approval and Go 404", async () => {
    const action = {
      action: "requestLeave" as const,
      employeeId: "11111111-1111-4111-8111-111111111111",
      kind: "annual",
      startDate: "2026-10-12",
      endDate: "2026-10-14",
    };
    const scope = { actorId: "22222222-2222-4222-8222-222222222222", organizationId: "33333333-3333-4333-8333-333333333333" };
    const intents: string[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      intents.push(String(body.intentId));
      expect(body).toMatchObject({ capabilityId: "hr.requestLeave", input: { employeeId: action.employeeId, kind: action.kind }, intentId: expect.any(String) });
      return intents.length === 1
        ? Response.json({ pendingApproval: true, reason: "Manager approval required." }, { status: 202 })
        : Response.json({ error: "capability not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitHrLeaveAction(action, scope, undefined, true)).resolves.toMatchObject({ kind: "pending" });
    await expect(submitHrLeaveAction(action, scope, undefined, true)).rejects.toMatchObject({ status: 404, requestMayHaveReachedServer: true });
    await expect(readPendingHrLeaveAction(scope)).resolves.toEqual(action);
    await expect(submitHrLeaveAction(action, scope, undefined, false)).rejects.toMatchObject({ status: 0, requestMayHaveReachedServer: true });
    expect(intents).toHaveLength(2);
    expect(intents[1]).toBe(intents[0]);
    expect(fetchMock.mock.calls.every(([path]) => path === "/api/capabilities/execute")).toBe(true);
  });

  it("maps leave decisions and cancellation to their Go capability contracts", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown> };
      if (body.capabilityId === "hr.decideLeave") return Response.json({ ok: true, data: { status: "approved" } });
      return Response.json({ ok: true, data: { cancelled: true } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const scope = { actorId: "22222222-2222-4222-8222-222222222222", organizationId: "33333333-3333-4333-8333-333333333333" };

    await expect(submitHrLeaveAction({ action: "decideLeave", requestId: "44444444-4444-4444-8444-444444444444", approve: true }, scope, undefined, true)).resolves.toMatchObject({ kind: "success", data: { status: "approved" } });
    await expect(submitHrLeaveAction({ action: "cancelLeave", requestId: "55555555-5555-4555-8555-555555555555" }, scope, undefined, true)).resolves.toMatchObject({ kind: "success", data: { cancelled: true } });
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      expect.objectContaining({ capabilityId: "hr.decideLeave", input: { requestId: "44444444-4444-4444-8444-444444444444", approve: true } }),
      expect.objectContaining({ capabilityId: "hr.cancelLeave", input: { requestId: "55555555-5555-4555-8555-555555555555" } }),
    ]);
  });
});
