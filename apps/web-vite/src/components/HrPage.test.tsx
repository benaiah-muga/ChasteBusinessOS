import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HrPage } from "./HrPage";

const employee = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Amina Wanjiru",
  email: "amina@example.com",
  title: "Field technician",
  department: "Operations",
  managerEmployeeId: null,
  emergencyContactName: null,
  emergencyContactPhone: null,
  monthlySalaryMinor: 520_000,
  taxRateBps: 1_000,
  active: true,
};

const report = {
  employees: [employee],
  leave: [{
    id: "leave-1",
    employeeName: employee.name,
    kind: "annual",
    startDate: "2026-10-06T00:00:00.000Z",
    endDate: "2026-10-08T00:00:00.000Z",
    calendarDays: 3,
    status: "pending",
  }],
  runs: [],
  openings: [],
  applicants: [],
  attendance: [],
};
const expenseClaim = {
  id: "11111111-1111-4111-8111-111111111111",
  claimantUserId: "22222222-2222-4222-8222-222222222222",
  amountMinor: 12500,
  currency: "USD",
  status: "submitted",
  memo: "Taxi to the client kickoff",
};

function stubHrWriteLocks(): void {
  const tails = new Map<string, Promise<void>>();
  const locks = {
    request: async <T,>(name: string, _options: LockOptions, callback: () => Promise<T>): Promise<T> => {
      const previous = tails.get(name) ?? Promise.resolve();
      let release = (): void => {};
      const current = new Promise<void>((resolve) => { release = resolve; });
      tails.set(name, current);
      await previous;
      try { return await callback(); }
      finally {
        release();
        if (tails.get(name) === current) tails.delete(name);
      }
    },
  };
  vi.stubGlobal("navigator", Object.assign(Object.create(navigator) as Navigator, { locks }));
}

function hrFetch(enabled = true) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: enabled ? ["hr"] : [] });
    if (path === "/api/capabilities/execute" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { capabilityId?: string };
      const outputs: Record<string, unknown> = {
        "hr.report": report,
        "hr.timeReport": { rows: [{ employeeId: employee.id, approvedMinutes: 510, pendingMinutes: 60 }] },
        "hr.pendingTimeEntries": { entries: [] },
        "hr.hireEmployee": { employeeId: "77777777-7777-4777-8777-777777777777" },
        "hr.createOpening": { openingId: "88888888-8888-4888-8888-888888888888" },
        "hr.addApplicant": { applicantId: "99999999-9999-4999-8999-999999999999" },
        "hr.moveApplicant": { stage: "screening" },
        "hr.requestLeave": { requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", calendarDays: 1 },
        "hr.decideLeave": { status: "approved" },
        "hr.cancelLeave": { status: "cancelled" },
        "hr.createPayrollRun": { runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", year: 2026, month: 10 },
        "hr.logTime": { entryId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
        "hr.decideTimeEntry": { entryId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", status: "approved" },
        "accounting.listExpenseClaims": { claims: [] },
        "accounting.listExpensePolicies": { policies: [] },
      };
      if (body.capabilityId && body.capabilityId in outputs) return Response.json({ ok: true, data: outputs[body.capabilityId] });
    }
    return Response.json({ error: `Unexpected route: ${path}` }, { status: 404 });
  });
}

function hrFetchWithPendingActions(paths: string[]) {
  const baseFetch = hrFetch();
  const pendingPaths = new Set(paths);
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === "POST" && path === "/api/capabilities/execute") {
      const body = JSON.parse(String(init.body)) as { capabilityId?: string };
      if (body.capabilityId && pendingPaths.has(body.capabilityId) && !["hr.report", "hr.timeReport", "hr.pendingTimeEntries"].includes(body.capabilityId)) {
        return Response.json({ pendingApproval: true, reason: "Manager approval required." }, { status: 202 });
      }
    }
    return baseFetch(input, init);
  });
}

type HrFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function stubFetchWithGoTimeReads(fetchMock: HrFetch) {
  const wrapped = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/capabilities/execute" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { capabilityId?: string };
      if (body.capabilityId === "hr.timeReport") {
        return Response.json({ ok: true, data: { rows: [{ employeeId: employee.id, approvedMinutes: 510, pendingMinutes: 60 }] } });
      }
      if (body.capabilityId === "hr.pendingTimeEntries") {
        return Response.json({ ok: true, data: { entries: [] } });
      }
    }
    return fetchMock(input, init);
  });
  vi.stubGlobal("fetch", wrapped);
  return wrapped;
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

describe("Vite People page", () => {
  it("loads the default Overview report through Go", async () => {
    const organizationId = "33333333-3333-4333-8333-333333333333";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/capabilities/execute") {
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toMatchObject({ capabilityId: "hr.report", input: {}, intentId: expect.any(String) });
        return Response.json({ ok: true, data: report });
      }
      if (path === "/api/time?pending=1") return Response.json({ entries: [] });
      if (path.startsWith("/api/time?")) return Response.json({ rows: [] });
      return Response.json({ error: "Unexpected route" }, { status: 404 });
    });
    stubFetchWithGoTimeReads(fetchMock);
    render(<HrPage organizationId={organizationId} />);

    expect(await screen.findByRole("heading", { name: "Recently added" })).not.toBeNull();
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/capabilities/execute")).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/hr")).toBe(false);
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/capabilities/execute").every(([, init]) => (init?.headers as Record<string, string>)?.["X-Organization-ID"] === organizationId)).toBe(true);
  });

  it("fails closed on a Go Overview report error", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/capabilities/execute") return Response.json({ error: "capability unavailable" }, { status: 404 });
      return Response.json({ error: "Unexpected route" }, { status: 404 });
    });
    stubFetchWithGoTimeReads(fetchMock);
    render(<HrPage organizationId="33333333-3333-4333-8333-333333333333" />);

    expect(await screen.findByText("capability unavailable")).not.toBeNull();
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/capabilities/execute")).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/hr")).toBe(false);
  });

  it("loads the People directory through Go hr.report without calling legacy /api/hr", async () => {
    window.history.replaceState(null, "", "/hr?tab=people");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/capabilities/execute") {
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toMatchObject({ capabilityId: "hr.report", input: {}, intentId: expect.any(String) });
        return Response.json({ ok: true, data: report });
      }
      if (path === "/api/time?pending=1") return Response.json({ entries: [] });
      if (path.startsWith("/api/time?")) return Response.json({ rows: [] });
      return Response.json({ error: "Unexpected route" }, { status: 404 });
    });
    stubFetchWithGoTimeReads(fetchMock);
    render(<HrPage organizationId="33333333-3333-4333-8333-333333333333" />);

    expect(await screen.findByText(/amina@example.com/)).not.toBeNull();
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/capabilities/execute")).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/hr")).toBe(false);
  });

  it("retries an employee hire with the same intent after reload and clears the form", async () => {
    stubHrWriteLocks();
    window.history.replaceState(null, "", "/hr?tab=people");
    vi.stubGlobal("__GO_HR_EMPLOYEE_WRITES__", true);
    const actorId = "22222222-2222-4222-8222-222222222222";
    const organizationId = "33333333-3333-4333-8333-333333333333";
    const intents: string[] = [];
    const hireInputs: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/time?pending=1") return Response.json({ entries: [] });
      if (path.startsWith("/api/time?")) return Response.json({ rows: [] });
      if (path === "/api/capabilities/execute") {
        const body = JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string };
        if (body.capabilityId === "hr.report") return Response.json({ ok: true, data: report });
        expect(body.capabilityId).toBe("hr.hireEmployee");
        intents.push(body.intentId);
        hireInputs.push(body.input);
        return intents.length === 1
          ? Response.json({ pendingApproval: true, reason: "HR approval required." }, { status: 202 })
          : Response.json({ ok: true, data: { employeeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } });
      }
      throw new Error(`Unexpected employee hire route: ${path}`);
    });
    stubFetchWithGoTimeReads(fetchMock);

    const first = render(<HrPage baseCurrency="UGX" actorId={actorId} organizationId={organizationId} />);
    await screen.findByRole("heading", { name: "Hire an employee" });
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Mira Patel" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "mira@example.com" } });
    fireEvent.change(screen.getByLabelText("Job title"), { target: { value: "Field technician" } });
    fireEvent.change(screen.getByLabelText("Monthly salary (UGX)"), { target: { value: "125000" } });
    fireEvent.click(screen.getByRole("button", { name: "Add employee" }));
    expect(await screen.findByRole("button", { name: "Retry exact employee hire" })).not.toBeNull();
    expect((screen.getByLabelText("Full name") as HTMLInputElement).disabled).toBe(true);
    first.unmount();

    render(<HrPage baseCurrency="UGX" actorId={actorId} organizationId={organizationId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry exact employee hire" }));
    expect(await screen.findByText("Employee hire completed.")).not.toBeNull();
    expect((screen.getByLabelText("Full name") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Job title") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Monthly salary (UGX)") as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("button", { name: "Add employee" }) as HTMLButtonElement).disabled).toBe(true);
    expect(intents).toHaveLength(2);
    expect(intents[1]).toBe(intents[0]);
    expect(hireInputs).toEqual([
      { name: "Mira Patel", email: "mira@example.com", title: "Field technician", monthlySalaryMinor: 125000 },
      { name: "Mira Patel", email: "mira@example.com", title: "Field technician", monthlySalaryMinor: 125000 },
    ]);
    expect(fetchMock.mock.calls.some(([path, init]) => path === "/api/hr" && init?.method === "POST")).toBe(false);
  });

  it("requires confirmation before Go deactivation and removes the employee from active actions", async () => {
    window.history.replaceState(null, "", "/hr?tab=people");
    vi.stubGlobal("__GO_HR_EMPLOYEE_WRITES__", true);
    stubHrWriteLocks();
    let currentEmployee = employee;
    const currentReport = { ...report, employees: [currentEmployee] };
    const writes: Array<{ capabilityId: string; input: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/time?pending=1") return Response.json({ entries: [] });
      if (path.startsWith("/api/time?")) return Response.json({ rows: [] });
      if (path === "/api/capabilities/execute") {
        const body = JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown> };
        if (body.capabilityId === "hr.report") return Response.json({ ok: true, data: currentReport });
        if (body.capabilityId === "hr.timeReport") return Response.json({ ok: true, data: { rows: [] } });
        if (body.capabilityId === "hr.pendingTimeEntries") return Response.json({ ok: true, data: { entries: [] } });
        writes.push({ capabilityId: body.capabilityId, input: body.input });
        currentEmployee = { ...currentEmployee, active: false };
        currentReport.employees = [currentEmployee];
        return Response.json({ ok: true, data: { deactivated: true } });
      }
      throw new Error(`Unexpected employee route: ${path}`);
    });
    stubFetchWithGoTimeReads(fetchMock);
    render(<HrPage baseCurrency="UGX" actorId="22222222-2222-4222-8222-222222222222" organizationId="33333333-3333-4333-8333-333333333333" />);

    await screen.findByRole("heading", { name: "Hire an employee" });
    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    expect(screen.getByRole("dialog", { name: "Deactivate Amina Wanjiru?" })).not.toBeNull();
    expect(screen.getByText(/excludes them from future payroll runs/)).not.toBeNull();
    expect(writes).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Confirm deactivation" }));

    expect(await screen.findByText("Employee deactivated.")).not.toBeNull();
    expect(writes).toEqual([{ capabilityId: "hr.deactivateEmployee", input: { employeeId: employee.id } }]);
    await waitFor(() => expect(screen.getAllByText("Inactive")).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
  });

  it("edits employee structure through the Go capability and refreshes from the Go report", async () => {
    window.history.replaceState(null, "", "/hr?tab=people");
    vi.stubGlobal("__GO_HR_EMPLOYEE_WRITES__", true);
    stubHrWriteLocks();
    let currentEmployee = employee;
    const currentReport = { ...report, employees: [currentEmployee] };
    const writes: Array<{ capabilityId: string; input: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/capabilities/execute") {
        const body = JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown> };
        if (body.capabilityId === "hr.report") return Response.json({ ok: true, data: currentReport });
        if (body.capabilityId === "hr.timeReport") return Response.json({ ok: true, data: { rows: [] } });
        if (body.capabilityId === "hr.pendingTimeEntries") return Response.json({ ok: true, data: { entries: [] } });
        writes.push({ capabilityId: body.capabilityId, input: body.input });
        currentEmployee = { ...currentEmployee, department: "Field Ops", title: "Lead Technician" };
        currentReport.employees = [currentEmployee];
        return Response.json({ ok: true, data: { updated: true } });
      }
      throw new Error(`Unexpected employee route: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<HrPage baseCurrency="UGX" actorId="22222222-2222-4222-8222-222222222222" organizationId="33333333-3333-4333-8333-333333333333" />);

    await screen.findByRole("heading", { name: "Hire an employee" });
    fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Amina Wanjiru" });
    fireEvent.change(within(dialog).getByLabelText("Department"), { target: { value: "Field Ops" } });
    fireEvent.change(within(dialog).getByLabelText("Job title"), { target: { value: "Lead Technician" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    expect(await screen.findByText("Employee profile updated.")).not.toBeNull();
    expect(writes).toEqual([{ capabilityId: "hr.updateEmployeeStructure", input: { employeeId: employee.id, department: "Field Ops", position: "Lead Technician" } }]);
    await waitFor(() => expect(screen.getByText("Field Ops")).not.toBeNull());
    expect(screen.getByText(/Lead Technician/)).not.toBeNull();
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/hr")).toBe(false);
  });

  it("retries a pending employee profile update with its saved Go intent", async () => {
    window.history.replaceState(null, "", "/hr?tab=people");
    vi.stubGlobal("__GO_HR_EMPLOYEE_WRITES__", true);
    stubHrWriteLocks();
    const writes: Array<{ capabilityId: string; intentId: string; input: Record<string, unknown> }> = [];
    let requestCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/capabilities/execute") {
        const body = JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string };
        if (body.capabilityId === "hr.report") return Response.json({ ok: true, data: report });
        if (body.capabilityId === "hr.timeReport") return Response.json({ ok: true, data: { rows: [] } });
        if (body.capabilityId === "hr.pendingTimeEntries") return Response.json({ ok: true, data: { entries: [] } });
        writes.push(body);
        requestCount += 1;
        return requestCount === 1
          ? Response.json({ pendingApproval: true, reason: "HR approval required." }, { status: 202 })
          : Response.json({ ok: true, data: { updated: true } });
      }
      throw new Error(`Unexpected employee route: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<HrPage baseCurrency="UGX" actorId="22222222-2222-4222-8222-222222222222" organizationId="33333333-3333-4333-8333-333333333333" />);

    await screen.findByRole("heading", { name: "Hire an employee" });
    fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Amina Wanjiru" });
    fireEvent.change(within(dialog).getByLabelText("Department"), { target: { value: "Field Ops" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    expect(await screen.findByText(/Employee profile update is waiting for approval/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry exact employee profile update" }));
    expect(await screen.findByText("Employee profile updated.")).not.toBeNull();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/hr")).toBe(false);
  });

  it("drops employee hire recovery state immediately when the active organization changes", async () => {
    stubHrWriteLocks();
    window.history.replaceState(null, "", "/hr?tab=people");
    const actorId = "77777777-7777-4777-8777-777777777777";
    const firstOrg = "88888888-8888-4888-8888-888888888888";
    const secondOrg = "99999999-9999-4999-8999-999999999999";
    const hireCalls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/capabilities/execute") {
        const body = JSON.parse(String(init?.body)) as { capabilityId: string };
        if (body.capabilityId === "hr.report") return Response.json({ ok: true, data: report });
        if (body.capabilityId === "hr.hireEmployee") {
          hireCalls.push(body.capabilityId);
          return Response.json({ pendingApproval: true, reason: "HR approval required." }, { status: 202 });
        }
        if (body.capabilityId === "hr.timeReport") return Response.json({ ok: true, data: { rows: [] } });
        if (body.capabilityId === "hr.pendingTimeEntries") return Response.json({ ok: true, data: { entries: [] } });
      }
      return Response.json({ error: `Unexpected route: ${path}` }, { status: 404 });
    });
    stubFetchWithGoTimeReads(fetchMock);

    const page = render(<HrPage baseCurrency="UGX" actorId={actorId} organizationId={firstOrg} />);
    await screen.findByRole("heading", { name: "Hire an employee" });
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Mira Patel" } });
    fireEvent.change(screen.getByLabelText("Monthly salary (UGX)"), { target: { value: "125000" } });
    fireEvent.click(screen.getByRole("button", { name: "Add employee" }));
    expect(await screen.findByRole("button", { name: "Retry exact employee hire" })).not.toBeNull();

    page.rerender(<HrPage baseCurrency="UGX" actorId={actorId} organizationId={secondOrg} />);
    await screen.findByRole("heading", { name: "Hire an employee" });
    expect(screen.queryByRole("button", { name: "Retry exact employee hire" })).toBeNull();
    expect(hireCalls).toHaveLength(1);
  });

  it("does not let an old organization mutation refresh data into the new organization", async () => {
    stubHrWriteLocks();
    window.history.replaceState(null, "", "/hr?tab=people");
    const actorId = "66666666-6666-4666-8666-666666666666";
    const firstOrg = "77777777-7777-4777-8777-777777777777";
    const secondOrg = "88888888-8888-4888-8888-888888888888";
    const secondEmployee = { ...employee, id: "55555555-5555-4555-8555-555555555555", name: "Beatrice Example", email: "bea@example.com" };
    const secondReport = { ...report, employees: [secondEmployee], leave: [] };
    let finishHire!: (response: Response) => void;
    const hireResponse = new Promise<Response>((resolve) => { finishHire = resolve; });
    const reportScopes: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const organization = (init?.headers as Record<string, string> | undefined)?.["X-Organization-ID"];
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/capabilities/execute") {
        const body = JSON.parse(String(init?.body)) as { capabilityId: string };
        if (body.capabilityId === "hr.report") {
          reportScopes.push(organization ?? "missing");
          return Response.json({ ok: true, data: organization === secondOrg ? secondReport : report });
        }
        if (body.capabilityId === "hr.hireEmployee") return hireResponse;
        if (body.capabilityId === "hr.timeReport") return Response.json({ ok: true, data: { rows: [] } });
        if (body.capabilityId === "hr.pendingTimeEntries") return Response.json({ ok: true, data: { entries: [] } });
      }
      return Response.json({ error: `Unexpected route: ${path}` }, { status: 404 });
    });
    stubFetchWithGoTimeReads(fetchMock);

    const page = render(<HrPage baseCurrency="UGX" actorId={actorId} organizationId={firstOrg} />);
    await screen.findByRole("heading", { name: "Hire an employee" });
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Mira Patel" } });
    fireEvent.change(screen.getByLabelText("Monthly salary (UGX)"), { target: { value: "125000" } });
    fireEvent.click(screen.getByRole("button", { name: "Add employee" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST" && JSON.parse(String(init.body)).capabilityId === "hr.hireEmployee")).toBe(true));

    page.rerender(<HrPage baseCurrency="UGX" actorId={actorId} organizationId={secondOrg} />);
    expect(await screen.findByText("Beatrice Example")).not.toBeNull();
    finishHire(Response.json({ ok: true, data: { employeeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } }));

    await waitFor(() => expect(reportScopes.filter((scope) => scope === secondOrg)).toHaveLength(1));
    expect(screen.getByText("Beatrice Example")).not.toBeNull();
    expect(screen.queryByText("Amina Wanjiru")).toBeNull();
    expect(reportScopes.filter((scope) => scope === firstOrg)).toHaveLength(1);
  });

  it("uses Go for the Hiring report and all exposed pipeline changes, with exact retry after reload", async () => {
    window.history.replaceState(null, "", "/hr?tab=hiring");
    vi.stubGlobal("__GO_HR_HIRING__", true);
    stubHrWriteLocks();
    const actorId = "22222222-2222-4222-8222-222222222222";
    const organizationId = "33333333-3333-4333-8333-333333333333";
    const openingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const applicantId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const intents: string[] = [];
    const writeCalls: Array<{ capabilityId: string; input: Record<string, unknown> }> = [];
    let openingCreated = false;
    let openingClosed = false;
    let applicantAdded = false;
    let applicantStage = "applied";
    let applicantHired = false;
    let createCount = 0;
    let addApplicantCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/time?pending=1") return Response.json({ entries: [] });
      if (path.startsWith("/api/time?")) return Response.json({ rows: [] });
      if (path === "/api/capabilities/execute") {
        const body = JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string };
        if (body.capabilityId === "hr.report") return Response.json({ ok: true, data: {
          ...report,
          employees: applicantHired ? [...report.employees, { ...employee, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Mira Patel", email: "mira@example.com", title: "Field Technician", department: null, monthlySalaryMinor: 125_000 }] : report.employees,
          openings: openingCreated ? [{ id: openingId, title: "Field Technician", department: null, note: null, status: openingClosed ? "closed" : "open", createdAt: "2026-10-01T10:00:00.000Z" }] : [],
          applicants: applicantAdded ? [{ id: applicantId, openingId, name: "Mira Patel", stage: applicantHired ? "hired" : applicantStage, note: null }] : [],
        } });
        intents.push(body.intentId);
        writeCalls.push({ capabilityId: body.capabilityId, input: body.input });
        if (body.capabilityId === "hr.createOpening") {
          createCount += 1;
          if (createCount === 1) return Response.json({ pendingApproval: true, reason: "Hiring approval required." }, { status: 202 });
          openingCreated = true;
          return Response.json({ ok: true, data: { openingId } });
        }
        if (body.capabilityId === "hr.addApplicant") {
          addApplicantCount += 1;
          if (addApplicantCount === 1) return Response.json({ pendingApproval: true, reason: "Candidate approval required." }, { status: 202 });
          applicantAdded = true;
          return Response.json({ ok: true, data: { applicantId } });
        }
        if (body.capabilityId === "hr.closeOpening") {
          openingClosed = true;
          return Response.json({ ok: true, data: { closed: true } });
        }
        if (body.capabilityId === "hr.moveApplicant") {
          applicantStage = String(body.input.stage);
          return Response.json({ ok: true, data: { moved: true, stage: applicantStage } });
        }
        if (body.capabilityId === "hr.hireApplicant") {
          applicantHired = true;
          return Response.json({ ok: true, data: { employeeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", applicantId } });
        }
        throw new Error(`Unexpected Hiring capability: ${body.capabilityId}`);
      }
      throw new Error(`Unexpected Hiring route: ${path}`);
    });
    stubFetchWithGoTimeReads(fetchMock);

    const first = render(<HrPage baseCurrency="UGX" actorId={actorId} organizationId={organizationId} />);
    expect(await screen.findByRole("heading", { name: "Open roles" })).not.toBeNull();
    fireEvent.change(screen.getByPlaceholderText("For example, Operations associate"), { target: { value: "Field Technician" } });
    fireEvent.click(screen.getByRole("button", { name: "Create opening" }));
    expect(await screen.findByRole("button", { name: "Retry exact Hiring action" })).not.toBeNull();
    expect((screen.getByPlaceholderText("For example, Operations associate") as HTMLInputElement).disabled).toBe(true);
    first.unmount();

    const openingRecovery = render(<HrPage baseCurrency="UGX" actorId={actorId} organizationId={organizationId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry exact Hiring action" }));
    expect(await screen.findByText("Opening creation completed.")).not.toBeNull();
    expect((screen.getByPlaceholderText("For example, Operations associate") as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("button", { name: "Create opening" }) as HTMLButtonElement).disabled).toBe(true);
    await screen.findByRole("button", { name: "Add applicant" });
    fireEvent.change(screen.getByLabelText("Candidate name"), { target: { value: "Mira Patel" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "mira@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add applicant" }));
    expect(await screen.findByRole("button", { name: "Retry exact Hiring action" })).not.toBeNull();
    expect((screen.getByLabelText("Candidate name") as HTMLInputElement).disabled).toBe(true);
    openingRecovery.unmount();
    render(<HrPage baseCurrency="UGX" actorId={actorId} organizationId={organizationId} />);
    expect(await screen.findByRole("button", { name: "Retry exact Hiring action" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry exact Hiring action" }));
    expect(await screen.findByText("Applicant creation completed.")).not.toBeNull();
    expect((screen.getByLabelText("Candidate name") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("button", { name: "Add applicant" }) as HTMLButtonElement).disabled).toBe(true);
    await screen.findByText("Mira Patel");
    fireEvent.change(screen.getByLabelText("Stage"), { target: { value: "interview" } });
    expect(await screen.findByText("Applicant stage update completed.")).not.toBeNull();
    fireEvent.change(screen.getByLabelText("Stage"), { target: { value: "offer" } });
    await waitFor(() => expect((screen.getByLabelText("Stage") as HTMLSelectElement).value).toBe("offer"));
    fireEvent.change(screen.getByLabelText("Monthly salary for Mira Patel (UGX)"), { target: { value: "1250" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Hire Mira Patel" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Hire Mira Patel" }));
    await waitFor(() => expect(writeCalls.some(({ capabilityId }) => capabilityId === "hr.hireApplicant")).toBe(true));
    expect(await screen.findByText("Applicant hiring completed.")).not.toBeNull();
    expect(await screen.findByText("hired")).not.toBeNull();
    expect(screen.queryByLabelText("Stage")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "People" }));
    expect(await screen.findByText("Mira Patel", { selector: ".hr-table-person" })).not.toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Hiring" }));
    await screen.findByRole("button", { name: "Close Field Technician" });
    fireEvent.click(screen.getByRole("button", { name: "Close Field Technician" }));
    expect(await screen.findByText("Opening closure completed.")).not.toBeNull();
    expect(await screen.findByText("closed", { selector: ".hr-pill" })).not.toBeNull();

    expect(intents[1]).toBe(intents[0]);
    expect(intents[3]).toBe(intents[2]);
    expect(writeCalls).toEqual([
      { capabilityId: "hr.createOpening", input: { title: "Field Technician" } },
      { capabilityId: "hr.createOpening", input: { title: "Field Technician" } },
      { capabilityId: "hr.addApplicant", input: { openingId, name: "Mira Patel", email: "mira@example.com" } },
      { capabilityId: "hr.addApplicant", input: { openingId, name: "Mira Patel", email: "mira@example.com" } },
      { capabilityId: "hr.moveApplicant", input: { applicantId, stage: "interview" } },
      { capabilityId: "hr.moveApplicant", input: { applicantId, stage: "offer" } },
      { capabilityId: "hr.hireApplicant", input: { applicantId, monthlySalaryMinor: 1250 } },
      { capabilityId: "hr.closeOpening", input: { openingId } },
    ]);
    expect(fetchMock.mock.calls.some(([path, init]) => path === "/api/hr" && init?.method === "POST")).toBe(false);
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/capabilities/execute")).toBe(true);
  });

  it("loads Payroll from Go and retries a pending draft with the same intent after reload", async () => {
    window.history.replaceState(null, "", "/hr?tab=payroll");
    vi.stubGlobal("__GO_HR_PAYROLL__", true);
    stubHrWriteLocks();
    const actorId = "22222222-2222-4222-8222-222222222222";
    const organizationId = "33333333-3333-4333-8333-333333333333";
    const intentIds: string[] = [];
    let writes = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/time?pending=1") return Response.json({ entries: [] });
      if (path.startsWith("/api/time?")) return Response.json({ rows: [] });
      if (path === "/api/capabilities/execute") {
        const body = JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string };
        if (body.capabilityId === "hr.report") return Response.json({ ok: true, data: report });
        expect(body).toMatchObject({ capabilityId: "hr.createPayrollRun", input: { year: 2026, month: 9 }, intentId: expect.any(String) });
        intentIds.push(body.intentId);
        writes += 1;
        return writes === 1
          ? Response.json({ pendingApproval: true, reason: "Payroll approval required." }, { status: 202 })
          : Response.json({ ok: true, data: { runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", headcount: 4, totalGrossMinor: 400_000, totalTaxMinor: 40_000, totalNetMinor: 360_000 } });
      }
      throw new Error(`Unexpected payroll route: ${path}`);
    });
    stubFetchWithGoTimeReads(fetchMock);

    const first = render(<HrPage baseCurrency="UGX" actorId={actorId} organizationId={organizationId} />);
    expect(await screen.findByRole("heading", { name: "Prepare a payroll run" })).not.toBeNull();
    fireEvent.change(screen.getByLabelText("Payroll period"), { target: { value: "2026-09" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft run" }));
    expect(await screen.findByRole("button", { name: "Retry exact payroll action" })).not.toBeNull();
    expect((screen.getByRole("button", { name: "Create draft run" }) as HTMLButtonElement).disabled).toBe(true);
    first.unmount();

    render(<HrPage baseCurrency="UGX" actorId={actorId} organizationId={organizationId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry exact payroll action" }));
    expect(await screen.findByText("Payroll draft completed.")).not.toBeNull();
    expect(intentIds).toHaveLength(2);
    expect(intentIds[1]).toBe(intentIds[0]);
    expect(fetchMock.mock.calls.some(([path, init]) => path === "/api/capabilities/execute" && init?.method === "POST")).toBe(true);
    expect(fetchMock.mock.calls.some(([path, init]) => path === "/api/hr" && init?.method === "POST")).toBe(false);
  });

  it("requires confirmation and routes execute, void, and reverse actions to Go", async () => {
    window.history.replaceState(null, "", "/hr?tab=payroll");
    vi.stubGlobal("__GO_HR_PAYROLL__", true);
    stubHrWriteLocks();
    const runs = [
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", year: 2026, month: 9, status: "draft", totalGrossMinor: 400_000, totalTaxMinor: 40_000, totalNetMinor: 360_000, headcount: 4 },
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", year: 2026, month: 10, status: "draft", totalGrossMinor: 300_000, totalTaxMinor: 30_000, totalNetMinor: 270_000, headcount: 3 },
      { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", year: 2026, month: 8, status: "executed", totalGrossMinor: 200_000, totalTaxMinor: 20_000, totalNetMinor: 180_000, headcount: 2 },
      { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", year: 2026, month: 7, status: "voided", totalGrossMinor: 100_000, totalTaxMinor: 10_000, totalNetMinor: 90_000, headcount: 1 },
      { id: "99999999-9999-4999-8999-999999999999", year: 2026, month: 6, status: "reversed", totalGrossMinor: 150_000, totalTaxMinor: 15_000, totalNetMinor: 135_000, headcount: 1 },
    ];
    const currentReport = { ...report, runs };
    const writes: Array<{ capabilityId: string; input: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/time?pending=1") return Response.json({ entries: [] });
      if (path.startsWith("/api/time?")) return Response.json({ rows: [] });
      if (path === "/api/capabilities/execute") {
        const body = JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown> };
        if (body.capabilityId === "hr.report") return Response.json({ ok: true, data: currentReport });
        if (body.capabilityId === "hr.timeReport") return Response.json({ ok: true, data: { rows: [] } });
        if (body.capabilityId === "hr.pendingTimeEntries") return Response.json({ ok: true, data: { entries: [] } });
        writes.push({ capabilityId: body.capabilityId, input: body.input });
        if (body.capabilityId === "hr.executePayrollRun") {
          runs[0] = { ...runs[0]!, status: "executed" };
          return Response.json({ ok: true, data: { entryId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", totalGrossMinor: 400_000, totalNetMinor: 360_000 } });
        }
        if (body.capabilityId === "hr.voidPayrollRun") {
          runs[1] = { ...runs[1]!, status: "voided" };
          return Response.json({ ok: true, data: { voided: true } });
        }
        if (body.capabilityId === "hr.reversePayrollPosting") {
          runs[2] = { ...runs[2]!, status: "reversed" };
          return Response.json({ ok: true, data: { reversalEntryId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", reversedNetMinor: 180_000 } });
        }
      }
      throw new Error(`Unexpected payroll route: ${path}`);
    });
    stubFetchWithGoTimeReads(fetchMock);

    render(<HrPage baseCurrency="UGX" actorId="22222222-2222-4222-8222-222222222222" organizationId="33333333-3333-4333-8333-333333333333" />);
    expect(await screen.findByRole("heading", { name: "Payroll runs" })).not.toBeNull();
    fireEvent.change(screen.getByLabelText("Payroll period"), { target: { value: "2026-10" } });
    expect((screen.getByRole("button", { name: "Create draft run" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("A payroll run already exists for this period.")).not.toBeNull();
    fireEvent.change(screen.getByLabelText("Payroll period"), { target: { value: "2026-11" } });
    expect((screen.getByRole("button", { name: "Create draft run" }) as HTMLButtonElement).disabled).toBe(false);
    const initialRows = screen.getAllByRole("row");
    expect(within(initialRows[4]!).queryByRole("button")).toBeNull();
    expect(within(initialRows[5]!).queryByRole("button")).toBeNull();
    expect(within(initialRows[4]!).getByText("No actions")).not.toBeNull();
    expect(within(initialRows[5]!).getByText("No actions")).not.toBeNull();

    fireEvent.click(within(initialRows[1]!).getByRole("button", { name: "Execute" }));
    expect(screen.getByRole("dialog", { name: "Execute payroll run" })).not.toBeNull();
    expect(within(screen.getByRole("dialog")).getByText(/UGX.*360,000|360,000.*UGX/)).not.toBeNull();
    expect(writes).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Confirm execution" }));
    await waitFor(() => expect(writes).toHaveLength(1));

    fireEvent.click(within(screen.getAllByRole("row")[2]!).getByRole("button", { name: "Void" }));
    expect(screen.getByRole("dialog", { name: "Void payroll draft" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Confirm void" }));
    await waitFor(() => expect(writes).toHaveLength(2));

    fireEvent.click(within(screen.getAllByRole("row")[3]!).getByRole("button", { name: "Reverse posting" }));
    expect(screen.getByRole("dialog", { name: "Reverse payroll posting" })).not.toBeNull();
    expect((screen.getByRole("button", { name: "Confirm reversal" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), { target: { value: "Corrected payroll calculation" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm reversal" }));
    await waitFor(() => expect(writes).toHaveLength(3));
    const finalRows = screen.getAllByRole("row");
    expect(within(finalRows[1]!).getByText("executed")).not.toBeNull();
    expect(within(finalRows[2]!).getByText("voided")).not.toBeNull();
    expect(within(finalRows[3]!).getByText("reversed")).not.toBeNull();
    expect(within(finalRows[4]!).queryByRole("button")).toBeNull();
    expect(within(finalRows[5]!).queryByRole("button")).toBeNull();

    expect(writes).toEqual([
      { capabilityId: "hr.executePayrollRun", input: { runId: runs[0]!.id, expectedTotalNetMinor: 360_000 } },
      { capabilityId: "hr.voidPayrollRun", input: { runId: runs[1]!.id } },
      { capabilityId: "hr.reversePayrollPosting", input: { runId: runs[2]!.id, reason: "Corrected payroll calculation" } },
    ]);
    expect(fetchMock.mock.calls.some(([path, init]) => path === "/api/hr" && init?.method === "POST")).toBe(false);
  });

  it("loads the overview and exposes keyboard accessible section tabs", async () => {
    const fetchMock = hrFetch();
    stubFetchWithGoTimeReads(fetchMock);
    render(<HrPage baseCurrency="UGX" organizationId="33333333-3333-4333-8333-333333333333" />);

    expect(await screen.findByRole("heading", { name: "People" })).not.toBeNull();
    expect(screen.getByText("Active people")).not.toBeNull();
    expect(screen.getByText("8h 30m")).not.toBeNull();
    const overviewTab = screen.getByRole("tab", { name: "Overview" });
    const peopleTab = screen.getByRole("tab", { name: "People" });
    expect(overviewTab.getAttribute("aria-selected")).toBe("true");
    expect(overviewTab.tabIndex).toBe(0);
    expect(peopleTab.tabIndex).toBe(-1);
    expect(fetchMock.mock.calls.some(([path, init]) => path === "/api/capabilities/execute" && init?.method === "POST")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalledWith("/api/hr", expect.anything());

    overviewTab.focus();
    fireEvent.keyDown(overviewTab, { key: "ArrowRight" });
    expect(document.activeElement).toBe(peopleTab);
    expect(peopleTab.getAttribute("aria-selected")).toBe("true");
    expect(overviewTab.tabIndex).toBe(-1);
    fireEvent.keyDown(peopleTab, { key: "End" });
    const expensesTab = screen.getByRole("tab", { name: "Expenses" });
    expect(document.activeElement).toBe(expensesTab);
    fireEvent.keyDown(expensesTab, { key: "Home" });
    expect(document.activeElement).toBe(overviewTab);

    fireEvent.click(screen.getByRole("tab", { name: "People" }));
    expect(screen.getByRole("tabpanel", { name: "People" })).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Hire an employee" })).not.toBeNull();
    expect(screen.getByText("Amina Wanjiru")).not.toBeNull();
  });

  it("routes time queue and decisions through Go and retries the exact action after reload", async () => {
    window.history.replaceState(null, "", "/hr?tab=time");
    stubHrWriteLocks();
    const actorId = "33333333-3333-4333-8333-333333333333";
    const organizationId = "44444444-4444-4444-8444-444444444444";
    const entry = {
      id: "55555555-5555-4555-8555-555555555555",
      employeeId: "66666666-6666-4666-8666-666666666666",
      employeeName: employee.name,
      workDate: "2026-10-04T00:00:00.000Z",
      minutes: 75,
      note: "Client visit",
      late: false,
    };
    const intents: string[] = [];
    let writeCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/capabilities/execute") {
        const body = JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string };
        if (body.capabilityId === "hr.report") return Response.json({ ok: true, data: report });
        if (body.capabilityId === "hr.timeReport") return Response.json({ ok: true, data: { rows: [{ employeeId: entry.employeeId, approvedMinutes: 0, pendingMinutes: 75 }] } });
        if (body.capabilityId === "hr.pendingTimeEntries") return Response.json({ ok: true, data: { entries: [entry] } });
        expect(body).toMatchObject({ capabilityId: "hr.decideTimeEntry", input: { entryId: entry.id, decision: "approved" } });
        intents.push(body.intentId);
        writeCount += 1;
        return writeCount === 1
          ? Response.json({ pendingApproval: true, reason: "Manager approval required." }, { status: 202 })
          : Response.json({ ok: true, data: { entryId: entry.id, status: "approved" } });
      }
      throw new Error(`Unexpected legacy time route: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = render(<HrPage actorId={actorId} organizationId={organizationId} />);
    expect(await screen.findByRole("option", { name: "Amina Wanjiru" })).not.toBeNull();
    expect(await screen.findByText(/Client visit/)).not.toBeNull();
    const capabilityIds = fetchMock.mock.calls
      .filter(([path, init]) => path === "/api/capabilities/execute" && init?.method === "POST")
      .map(([, init]) => (JSON.parse(String(init?.body)) as { capabilityId?: string }).capabilityId);
    expect(capabilityIds).toEqual(expect.arrayContaining(["hr.report", "hr.timeReport", "hr.pendingTimeEntries"]));
    expect(fetchMock.mock.calls.some(([path, init]) => path === "/api/hr" && init?.method !== "POST")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("button", { name: "Retry exact time action" })).not.toBeNull();
    expect((screen.getByLabelText("Hours") as HTMLInputElement).disabled).toBe(true);
    first.unmount();

    render(<HrPage actorId={actorId} organizationId={organizationId} />);
    const retry = await screen.findByRole("button", { name: "Retry exact time action" });
    fireEvent.click(retry);
    expect(await screen.findByText("Time action completed.")).not.toBeNull();
    expect(intents).toHaveLength(2);
    expect(intents[1]).toBe(intents[0]);
    expect(fetchMock.mock.calls.every(([path]) => path !== "/api/time" && !String(path).startsWith("/api/time?"))).toBe(true);
    expect(fetchMock.mock.calls.some(([path, init]) => path === "/api/hr" && init?.method === "POST")).toBe(false);
  });

  it("routes People, time, and employee writes through Go", async () => {
    window.history.replaceState(null, "", "/hr?tab=people");
    stubHrWriteLocks();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/capabilities/execute") {
        const body = JSON.parse(String(init?.body)) as { capabilityId: string };
        if (body.capabilityId === "hr.report") return Response.json({ ok: true, data: report });
        if (body.capabilityId === "hr.timeReport") return Response.json({ ok: true, data: { rows: [] } });
        if (body.capabilityId === "hr.pendingTimeEntries") return Response.json({ ok: true, data: { entries: [] } });
        if (body.capabilityId === "hr.hireEmployee") return Response.json({ ok: true, data: { employeeId: "77777777-7777-4777-8777-777777777777" } });
      }
      throw new Error(`Unexpected route: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<HrPage baseCurrency="UGX" actorId="55555555-5555-4555-8555-555555555555" organizationId="66666666-6666-4666-8666-666666666666" />);
    await screen.findByLabelText("Full name");
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Grace Nambasa" } });
    fireEvent.change(screen.getByLabelText(/Monthly salary/), { target: { value: "1200000" } });
    fireEvent.click(screen.getByRole("button", { name: "Add employee" }));

    expect(await screen.findByText("Employee hire completed.")).not.toBeNull();
    const capabilityIds = fetchMock.mock.calls
      .filter(([path]) => path === "/api/capabilities/execute")
      .map(([, init]) => (JSON.parse(String(init?.body)) as { capabilityId?: string }).capabilityId);
    expect(capabilityIds).toEqual(expect.arrayContaining(["hr.report", "hr.timeReport", "hr.pendingTimeEntries", "hr.hireEmployee"]));
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/hr" || String(path).startsWith("/api/time"))).toBe(false);
  });

  it("opens Expenses from its URL and loads claims through Go", async () => {
    window.history.replaceState(null, "", "/hr?tab=expenses");
    const fetchMock = hrFetch();
    stubFetchWithGoTimeReads(fetchMock);
    render(<HrPage baseCurrency="USD" organizationId="33333333-3333-4333-8333-333333333333" />);

    expect(await screen.findByRole("heading", { name: "Submit an expense claim" })).not.toBeNull();
    expect(screen.getByRole("tab", { name: "Expenses" }).getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(fetchMock.mock.calls.some(([path, init]) => path === "/api/capabilities/execute" && init?.method === "POST" && JSON.parse(String(init.body)).capabilityId === "accounting.listExpenseClaims")).toBe(true));
    const capabilities = fetchMock.mock.calls
      .filter(([path]) => path === "/api/capabilities/execute")
      .map(([, init]) => (JSON.parse(String(init?.body)) as { capabilityId?: string }).capabilityId);
    expect(capabilities).toEqual(expect.arrayContaining(["hr.report", "accounting.listExpenseClaims", "accounting.listExpensePolicies"]));
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/expenses")).toBe(false);
  });

  it("matches the Go memo and policy category limits in the expense form", async () => {
    window.history.replaceState(null, "", "/hr?tab=expenses");
    const baseFetch = hrFetch();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => baseFetch(input, init));
    stubFetchWithGoTimeReads(fetchMock);
    render(<HrPage organizationId="33333333-3333-4333-8333-333333333333" />);
    await screen.findByRole("heading", { name: "Submit an expense claim" });

    const memo = screen.getByRole("textbox", { name: "Expense explanation" }) as HTMLInputElement;
    const category = screen.getByRole("textbox", { name: "Policy category" }) as HTMLInputElement;
    expect([memo.minLength, memo.maxLength]).toEqual([3, 500]);
    expect([category.minLength, category.maxLength]).toEqual([2, 40]);
  });

  it("rejects expense amounts that exceed safe integer minor units", async () => {
    window.history.replaceState(null, "", "/hr?tab=expenses");
    const fetchMock = hrFetch();
    stubFetchWithGoTimeReads(fetchMock);
    render(<HrPage baseCurrency="USD" actorId="55555555-5555-4555-8555-555555555555" organizationId="66666666-6666-4666-8666-666666666666" />);
    await screen.findByRole("heading", { name: "Submit an expense claim" });

    fireEvent.change(screen.getByRole("spinbutton", { name: "Expense amount" }), { target: { value: "999999999999999999999999" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Expense explanation" }), { target: { value: "Client travel" } });
    const submitButton = screen.getByRole("button", { name: "Submit claim" });
    const claimForm = submitButton.closest("form");
    if (!claimForm) throw new Error("Expense form was not found");
    fireEvent.submit(claimForm);

    expect((await screen.findByRole("alert")).textContent).toContain("Enter a valid amount");
    expect(fetchMock.mock.calls.some(([path, init]) => path === "/api/capabilities/execute" && init?.method === "POST" && JSON.parse(String(init.body)).capabilityId === "accounting.submitExpenseClaim")).toBe(false);
  });

  it.each([
    { currency: "JPY", amount: "1250", amountMinor: 1250, limit: "2500", limitMinor: 2500 },
    { currency: "BHD", amount: "1.234", amountMinor: 1234, limit: "2.500", limitMinor: 2500 },
  ])("converts expense and policy amounts using $currency minor units", async ({ currency, amount, amountMinor, limit, limitMinor }) => {
    window.history.replaceState(null, "", "/hr?tab=expenses");
    stubHrWriteLocks();
    const baseFetch = hrFetch();
    const writes: Array<{ capabilityId: string; input: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/capabilities/execute" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { capabilityId: string; input: Record<string, unknown> };
        if (body.capabilityId === "accounting.submitExpenseClaim" || body.capabilityId === "accounting.setExpensePolicy") {
          writes.push(body);
          return body.capabilityId === "accounting.submitExpenseClaim"
            ? Response.json({ ok: true, data: { claimId: "33333333-3333-4333-8333-333333333333", status: "submitted", category: "travel", overPolicyLimit: false, policyLimitMinor: null } })
            : Response.json({ ok: true, data: { set: true, category: "travel", limitMinor } });
        }
      }
      return baseFetch(input, init);
    });
    stubFetchWithGoTimeReads(fetchMock);
    render(<HrPage baseCurrency={currency} actorId="55555555-5555-4555-8555-555555555555" organizationId="66666666-6666-4666-8666-666666666666" />);
    await screen.findByRole("heading", { name: "Submit an expense claim" });

    fireEvent.change(screen.getByRole("spinbutton", { name: "Expense amount" }), { target: { value: amount } });
    fireEvent.change(screen.getByRole("textbox", { name: "Expense explanation" }), { target: { value: "Client travel" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit claim" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Expense claim done."));

    fireEvent.change(screen.getByRole("textbox", { name: "Policy category" }), { target: { value: "travel" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Policy scrutiny limit" }), { target: { value: limit } });
    fireEvent.click(screen.getByRole("button", { name: "Set limit" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Set travel limit done."));

    expect(writes.map(({ capabilityId, input }) => [capabilityId, input])).toEqual([
      ["accounting.submitExpenseClaim", expect.objectContaining({ amountMinor })],
      ["accounting.setExpensePolicy", expect.objectContaining({ limitMinor })],
    ]);
  });

  it.each([
    { currency: "JPY", amount: "1.1" },
    { currency: "BHD", amount: "1.2345" },
  ])("rejects over-precision in both expense forms for $currency", async ({ currency, amount }) => {
    window.history.replaceState(null, "", "/hr?tab=expenses");
    const fetchMock = hrFetch();
    stubFetchWithGoTimeReads(fetchMock);
    render(<HrPage baseCurrency={currency} actorId="55555555-5555-4555-8555-555555555555" organizationId="66666666-6666-4666-8666-666666666666" />);
    await screen.findByRole("heading", { name: "Submit an expense claim" });

    fireEvent.change(screen.getByRole("spinbutton", { name: "Expense amount" }), { target: { value: amount } });
    fireEvent.change(screen.getByRole("textbox", { name: "Expense explanation" }), { target: { value: "Client travel" } });
    const claimForm = screen.getByRole("button", { name: "Submit claim" }).closest("form");
    if (!claimForm) throw new Error("Expense form was not found");
    fireEvent.submit(claimForm);
    expect((await screen.findByRole("alert")).textContent).toContain("Enter a valid amount");

    fireEvent.change(screen.getByRole("textbox", { name: "Policy category" }), { target: { value: "travel" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Policy scrutiny limit" }), { target: { value: amount } });
    const policyForm = screen.getByRole("button", { name: "Set limit" }).closest("form");
    if (!policyForm) throw new Error("Expense policy form was not found");
    fireEvent.submit(policyForm);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("valid non-negative scrutiny limit"));

    expect(fetchMock.mock.calls.some(([path, init]) => path === "/api/capabilities/execute" && init?.method === "POST" && ["accounting.submitExpenseClaim", "accounting.setExpensePolicy"].includes((JSON.parse(String(init.body)) as { capabilityId?: string }).capabilityId ?? ""))).toBe(false);
  });

  it("displays and pays each claim in its stored currency", async () => {
    window.history.replaceState(null, "", "/hr?tab=expenses");
    stubHrWriteLocks();
    const baseFetch = hrFetch();
    const paymentRequests: Array<{ capabilityId: string; input: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/capabilities/execute" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { capabilityId: string; input: Record<string, unknown> };
        if (body.capabilityId === "accounting.listExpenseClaims") {
          return Response.json({ ok: true, data: { claims: [{ ...expenseClaim, currency: "JPY", status: "approved" }] } });
        }
        if (body.capabilityId === "accounting.payExpenseClaim") {
          paymentRequests.push(body);
          return Response.json({ ok: true, data: { claimId: expenseClaim.id, entryId: "55555555-5555-4555-8555-555555555555", paidMinor: 12500 } });
        }
      }
      return baseFetch(input, init);
    });
    stubFetchWithGoTimeReads(fetchMock);
    render(<HrPage baseCurrency="BHD" actorId="55555555-5555-4555-8555-555555555555" organizationId="66666666-6666-4666-8666-666666666666" />);

    const payoutText = new Intl.NumberFormat(undefined, { style: "currency", currency: "JPY" }).format(12500);
    const payButton = await screen.findByRole("button", { name: `Pay ${payoutText}` });
    expect(screen.getByText(payoutText)).not.toBeNull();
    fireEvent.click(payButton);
    await waitFor(() => expect(paymentRequests).toHaveLength(1));
    expect(paymentRequests[0]).toEqual(expect.objectContaining({ capabilityId: "accounting.payExpenseClaim", input: { claimId: expenseClaim.id, amountMinor: 12500 } }));
  });

  it("keeps expense review data behind the existing expenses permission", async () => {
    window.history.replaceState(null, "", "/hr?tab=expenses");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/capabilities/execute" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { capabilityId: string };
        if (body.capabilityId === "hr.report") return Response.json({ ok: true, data: report });
        if (body.capabilityId === "accounting.listExpenseClaims") return Response.json({ error: "forbidden: missing expenses.decide" }, { status: 403 });
        if (body.capabilityId === "hr.timeReport") return Response.json({ ok: true, data: { rows: [] } });
        if (body.capabilityId === "hr.pendingTimeEntries") return Response.json({ ok: true, data: { entries: [] } });
      }
      return Response.json({ error: `Unexpected route: ${path}` }, { status: 404 });
    }));
    render(<HrPage organizationId="33333333-3333-4333-8333-333333333333" />);

    expect(await screen.findByRole("heading", { name: "Access denied" })).not.toBeNull();
    expect(screen.getByText("forbidden: missing expenses.decide")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByText("Taxi to the client kickoff")).toBeNull();
  });

  it("routes Vite expenses to Go and recovers the exact pending claim action", async () => {
    window.history.replaceState(null, "", "/hr?tab=expenses");
    stubHrWriteLocks();
    let pendingFirstSubmit = true;
    const readCapabilities: string[] = [];
    const requests: Array<{ capabilityId: string; intentId: string; input: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/capabilities/execute") {
        const body = JSON.parse(String(init?.body)) as { capabilityId: string; intentId: string; input: Record<string, unknown> };
        if (body.capabilityId === "hr.report") {
          readCapabilities.push(body.capabilityId);
          return Response.json({ ok: true, data: report });
        }
        if (body.capabilityId === "accounting.listExpenseClaims") return Response.json({ ok: true, data: { claims: [expenseClaim] } });
        if (body.capabilityId === "accounting.listExpensePolicies") return Response.json({ ok: true, data: { policies: [] } });
        requests.push(body);
        if (pendingFirstSubmit) {
          pendingFirstSubmit = false;
          return Response.json({ ok: false, pendingApproval: true, reason: "Manager review required" }, { status: 202 });
        }
        return Response.json({ ok: true, data: { claimId: "33333333-3333-4333-8333-333333333333", status: "submitted", category: "travel", overPolicyLimit: false, policyLimitMinor: null } });
      }
      return Response.json({ error: `Unexpected route: ${path}` }, { status: 404 });
    });
    stubFetchWithGoTimeReads(fetchMock);
    const organizationId = "66666666-6666-4666-8666-666666666666";
    const page = render(<HrPage baseCurrency="USD" actorId="55555555-5555-4555-8555-555555555555" organizationId={organizationId} />);

    await screen.findByRole("heading", { name: "Submit an expense claim" });
    expect(readCapabilities).toEqual(["hr.report"]);
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/hr")).toBe(false);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Expense amount" }), { target: { value: "42.50" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Expense explanation" }), { target: { value: "Client travel" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit claim" }));
    expect(await screen.findByText(/Manager review required/)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Retry exact expense action" })).not.toBeNull();

    page.unmount();
    render(<HrPage baseCurrency="USD" actorId="55555555-5555-4555-8555-555555555555" organizationId="66666666-6666-4666-8666-666666666666" />);
    await screen.findByRole("button", { name: "Retry exact expense action" });
    fireEvent.click(screen.getByRole("button", { name: "Retry exact expense action" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Expense action done."));
    expect(requests.map(({ capabilityId }) => capabilityId)).toEqual(["accounting.submitExpenseClaim", "accounting.submitExpenseClaim"]);
    expect(requests[0]?.intentId).toBe(requests[1]?.intentId);
    expect(requests[0]?.input).toEqual({ amountMinor: 4250, memo: "Client travel" });
    expect(requests[1]?.input).toEqual(requests[0]?.input);
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/capabilities/execute").every(([, init]) => (init?.headers as Record<string, string>)?.["X-Organization-ID"] === organizationId)).toBe(true);
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/expenses")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalledWith("/api/expenses", expect.anything());
  });

  it("submits leave through the Go capability and refreshes records", async () => {
    window.history.replaceState(null, "", "/hr?tab=leave");
    const fetchMock = hrFetch();
    stubFetchWithGoTimeReads(fetchMock);
    render(<HrPage actorId="55555555-5555-4555-8555-555555555555" organizationId="66666666-6666-4666-8666-666666666666" />);
    await screen.findByLabelText("Employee");
    fireEvent.click(screen.getByRole("tab", { name: "Leave" }));

    fireEvent.change(screen.getByLabelText("Employee"), { target: { value: employee.id } });
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-10-10" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-10-11" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit leave request" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Leave request completed."));
    const submission = fetchMock.mock.calls.find(([path, init]) => path === "/api/capabilities/execute" && init?.method === "POST" && JSON.parse(String(init.body)).capabilityId === "hr.requestLeave");
    expect(submission).toBeDefined();
    const body = JSON.parse(String(submission?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ capabilityId: "hr.requestLeave", input: { employeeId: employee.id, kind: "annual", startDate: "2026-10-10", endDate: "2026-10-11" }, intentId: expect.any(String) });
  });

  it("uses Go for the Leave route and recovers the exact pending action after reload", async () => {
    window.history.replaceState(null, "", "/hr?tab=leave");
    const employeeId = "11111111-1111-4111-8111-111111111111";
    const requestId = "22222222-2222-4222-8222-222222222222";
    const actorId = "33333333-3333-4333-8333-333333333333";
    const organizationId = "44444444-4444-4444-8444-444444444444";
    const goReport = { ...report, employees: [{ ...employee, id: employeeId }] };
    const writes: Array<{ capabilityId: string; input: Record<string, unknown>; intentId: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/capabilities/execute") {
        const body = JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string };
        if (body.capabilityId === "hr.report") return Response.json({ ok: true, data: goReport });
        writes.push(body);
        return writes.length === 1
          ? Response.json({ pendingApproval: true, reason: "Manager approval required." }, { status: 202 })
          : Response.json({ ok: true, data: { requestId, calendarDays: 2 } });
      }
      if (path === "/api/time?pending=1") return Response.json({ entries: [] });
      if (path.startsWith("/api/time?")) return Response.json({ rows: [] });
      return Response.json({ error: "Unexpected route" }, { status: 404 });
    });
    stubFetchWithGoTimeReads(fetchMock);
    const props = { actorId, organizationId };
    const page = render(<HrPage {...props} />);

    expect(await screen.findByRole("heading", { name: "Request leave" })).not.toBeNull();
    expect(fetchMock.mock.calls.filter(([path, init]) => path === "/api/capabilities/execute" && JSON.parse(String(init?.body)).capabilityId === "hr.report")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Employee"), { target: { value: employeeId } });
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-10-12" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-10-13" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit leave request" }));
    expect(await screen.findByRole("button", { name: "Retry exact leave action" })).not.toBeNull();
    expect((screen.getByLabelText("Start date") as HTMLInputElement).disabled).toBe(true);
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/hr")).toBe(false);

    page.unmount();
    render(<HrPage {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry exact leave action" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Leave action completed."));

    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ capabilityId: "hr.requestLeave", input: { employeeId, kind: "annual", startDate: "2026-10-12", endDate: "2026-10-13" } });
    expect(writes[1]?.input).toEqual(writes[0]?.input);
    expect(writes[1]?.intentId).toBe(writes[0]?.intentId);
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/hr")).toBe(false);
  });

  it("keeps Overview and Go Leave on the same Go report", async () => {
    const employeeId = "11111111-1111-4111-8111-111111111111";
    const goReport = { ...report, employees: [{ ...employee, id: employeeId }] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/capabilities/execute") return Response.json({ ok: true, data: goReport });
      if (path === "/api/time?pending=1") return Response.json({ entries: [] });
      return Response.json({ rows: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<HrPage actorId="33333333-3333-4333-8333-333333333333" organizationId="44444444-4444-4444-8444-444444444444" />);
    await screen.findByRole("heading", { name: "People" });
    fireEvent.click(screen.getByRole("tab", { name: "Leave" }));
    await screen.findByRole("heading", { name: "Request leave" });

    expect(fetchMock.mock.calls.filter(([path, init]) => path === "/api/capabilities/execute" && JSON.parse(String(init?.body)).capabilityId === "hr.report")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/hr")).toHaveLength(0);
  });

  it("keeps a hire draft when the governed action is waiting for approval", async () => {
    window.history.replaceState(null, "", "/hr?tab=people");
    stubHrWriteLocks();
    const fetchMock = hrFetchWithPendingActions(["hr.hireEmployee"]);
    vi.stubGlobal("fetch", fetchMock);
    render(<HrPage baseCurrency="UGX" actorId="55555555-5555-4555-8555-555555555555" organizationId="66666666-6666-4666-8666-666666666666" />);
    await screen.findByLabelText("Full name");
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Grace Nambasa" } });
    fireEvent.change(screen.getByLabelText(/Monthly salary/), { target: { value: "1200000" } });
    fireEvent.click(screen.getByRole("button", { name: "Add employee" }));

    expect(await screen.findByText("Employee hire is waiting for approval or result recovery. Retry the exact details when ready.")).not.toBeNull();
    expect((screen.getByLabelText("Full name") as HTMLInputElement).value).toBe("Grace Nambasa");
    expect((screen.getByLabelText(/Monthly salary/) as HTMLInputElement).value).toBe("1200000");
  });

  it("keeps a time entry draft when the governed action is waiting for approval", async () => {
    window.history.replaceState(null, "", "/hr?tab=time");
    stubHrWriteLocks();
    const fetchMock = hrFetchWithPendingActions(["hr.logTime"]);
    const goFetch = stubFetchWithGoTimeReads(fetchMock);
    render(<HrPage baseCurrency="UGX" actorId="55555555-5555-4555-8555-555555555555" organizationId="66666666-6666-4666-8666-666666666666" />);
    await screen.findByRole("option", { name: "Amina Wanjiru" });
    await waitFor(() => {
      const capabilityIds = goFetch.mock.calls
        .filter(([path, init]) => path === "/api/capabilities/execute" && init?.method === "POST")
        .map(([, init]) => (JSON.parse(String(init?.body)) as { capabilityId?: string }).capabilityId);
      expect(capabilityIds).toEqual(expect.arrayContaining(["hr.report", "hr.timeReport", "hr.pendingTimeEntries"]));
    });
    expect(fetchMock.mock.calls.some(([path, init]) => path === "/api/hr" && init?.method !== "POST")).toBe(false);
    fireEvent.change(screen.getByLabelText("Employee"), { target: { value: employee.id } });
    fireEvent.change(screen.getByLabelText("Hours"), { target: { value: "2.5" } });
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "Month end review" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit time" }));

    expect(await screen.findByText("Time entry needs approval or result recovery. Retry the exact action after approval is complete.")).not.toBeNull();
    expect((screen.getByLabelText("Hours") as HTMLInputElement).value).toBe("2.5");
    expect((screen.getByLabelText("Note") as HTMLInputElement).value).toBe("Month end review");
    expect(fetchMock.mock.calls.some(([path, init]) => path === "/api/hr" && init?.method !== "POST")).toBe(false);
  });

  it("clearly reports when the HR module is disabled", async () => {
    const fetchMock = hrFetch(false);
    vi.stubGlobal("fetch", fetchMock);
    render(<HrPage actorId="55555555-5555-4555-8555-555555555555" organizationId="66666666-6666-4666-8666-666666666666" />);
    expect(await screen.findByRole("heading", { name: "People is turned off" })).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/time?pending=1", expect.any(Object));
  });

  it("does not enable salary entry until the organization currency is known", async () => {
    window.history.replaceState(null, "", "/hr?tab=people");
    vi.stubGlobal("fetch", hrFetch());
    render(<HrPage baseCurrency={null} organizationId="33333333-3333-4333-8333-333333333333" />);
    const salaryField = await screen.findByLabelText(/Monthly salary/);
    expect(salaryField.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Add employee" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByText("Loading currency").length).toBeGreaterThan(0);
  });
});
