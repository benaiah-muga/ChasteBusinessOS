import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchHrEnabled, fetchHrReport, submitHrAction } from "./hr";
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

afterEach(() => vi.unstubAllGlobals());

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
});
