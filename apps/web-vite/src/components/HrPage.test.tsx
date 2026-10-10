import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HrPage } from "./HrPage";

const employee = {
  id: "employee-1",
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
  status: "submitted",
  memo: "Taxi to the client kickoff",
};

function stubHrTimeLocks(): void {
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
    if (path === "/api/hr" && init?.method === "POST") return Response.json({ ok: true, data: { requestId: "leave-2" } });
    if (path === "/api/hr") return Response.json(report);
    if (path === "/api/time?pending=1") return Response.json({ entries: [] });
    return Response.json({ rows: [{ employeeId: employee.id, approvedMinutes: 510, pendingMinutes: 60 }] });
  });
}

function hrFetchWithPendingActions(paths: string[]) {
  const baseFetch = hrFetch();
  const pendingPaths = new Set(paths);
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === "POST" && pendingPaths.has(path)) {
      return Response.json({ ok: false, pendingApproval: true, reason: "Manager approval required." }, { status: 202 });
    }
    return baseFetch(input, init);
  });
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

describe("Vite People page", () => {
  it("loads the default Overview report through Go when its selector is enabled", async () => {
    vi.stubGlobal("__GO_HR_OVERVIEW_REPORT_READS__", true);
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
    vi.stubGlobal("fetch", fetchMock);
    render(<HrPage />);

    expect(await screen.findByRole("heading", { name: "Recently added" })).not.toBeNull();
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/capabilities/execute")).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/hr")).toBe(false);
  });

  it("fails closed on a selected Go Overview report error", async () => {
    vi.stubGlobal("__GO_HR_OVERVIEW_REPORT_READS__", true);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/capabilities/execute") return Response.json({ error: "capability unavailable" }, { status: 404 });
      return Response.json({ error: "Unexpected route" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<HrPage />);

    expect(await screen.findByText("capability unavailable")).not.toBeNull();
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/capabilities/execute")).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/hr")).toBe(false);
  });

  it("keeps the Overview report on legacy when its Go selector is off", async () => {
    vi.stubGlobal("__GO_HR_OVERVIEW_REPORT_READS__", false);
    const fetchMock = hrFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<HrPage />);

    expect(await screen.findByRole("heading", { name: "Recently added" })).not.toBeNull();
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/hr")).toBe(true);
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/capabilities/execute")).toBe(false);
  });

  it("retries an employee hire with the same intent after reload and clears the form", async () => {
    window.history.replaceState(null, "", "/hr?tab=people");
    vi.stubGlobal("__GO_HR_EMPLOYEE_WRITES__", true);
    const actorId = "22222222-2222-4222-8222-222222222222";
    const organizationId = "33333333-3333-4333-8333-333333333333";
    const intents: string[] = [];
    const hireInputs: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/hr") return Response.json(report);
      if (path === "/api/time?pending=1") return Response.json({ entries: [] });
      if (path.startsWith("/api/time?")) return Response.json({ rows: [] });
      if (path === "/api/capabilities/execute") {
        const body = JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string };
        expect(body.capabilityId).toBe("hr.hireEmployee");
        intents.push(body.intentId);
        hireInputs.push(body.input);
        return intents.length === 1
          ? Response.json({ pendingApproval: true, reason: "HR approval required." }, { status: 202 })
          : Response.json({ ok: true, data: { employeeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } });
      }
      throw new Error(`Unexpected employee hire route: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

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

  it("uses Go for the Hiring report and all exposed pipeline changes, with exact retry after reload", async () => {
    window.history.replaceState(null, "", "/hr?tab=hiring");
    vi.stubGlobal("__GO_HR_HIRING__", true);
    const actorId = "22222222-2222-4222-8222-222222222222";
    const organizationId = "33333333-3333-4333-8333-333333333333";
    const openingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const applicantId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const intents: string[] = [];
    const writeCalls: Array<{ capabilityId: string; input: Record<string, unknown> }> = [];
    let openingCreated = false;
    let applicantAdded = false;
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
          openings: openingCreated ? [{ id: openingId, title: "Field Technician", department: null, note: null, status: "open", createdAt: "2026-10-01T10:00:00.000Z" }] : [],
          applicants: applicantAdded ? [{ id: applicantId, openingId, name: "Mira Patel", stage: "applied", note: null }] : [],
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
        return Response.json({ ok: true, data: { moved: true, stage: "interview" } });
      }
      throw new Error(`Unexpected Hiring route: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

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

    expect(intents[1]).toBe(intents[0]);
    expect(intents[3]).toBe(intents[2]);
    expect(writeCalls).toEqual([
      { capabilityId: "hr.createOpening", input: { title: "Field Technician" } },
      { capabilityId: "hr.createOpening", input: { title: "Field Technician" } },
      { capabilityId: "hr.addApplicant", input: { openingId, name: "Mira Patel", email: "mira@example.com" } },
      { capabilityId: "hr.addApplicant", input: { openingId, name: "Mira Patel", email: "mira@example.com" } },
      { capabilityId: "hr.moveApplicant", input: { applicantId, stage: "interview" } },
    ]);
    expect(fetchMock.mock.calls.some(([path, init]) => path === "/api/hr" && init?.method === "POST")).toBe(false);
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/capabilities/execute")).toBe(true);
  });

  it("loads Payroll from Go and retries a pending draft with the same intent after reload", async () => {
    window.history.replaceState(null, "", "/hr?tab=payroll");
    vi.stubGlobal("__GO_HR_PAYROLL__", true);
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
    vi.stubGlobal("fetch", fetchMock);

    const first = render(<HrPage baseCurrency="UGX" actorId={actorId} organizationId={organizationId} />);
    expect(await screen.findByRole("heading", { name: "Prepare a payroll run" })).not.toBeNull();
    fireEvent.change(screen.getByLabelText("Payroll period"), { target: { value: "2026-09" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft run" }));
    expect(await screen.findByRole("button", { name: "Retry exact payroll draft" })).not.toBeNull();
    expect((screen.getByRole("button", { name: "Create draft run" }) as HTMLButtonElement).disabled).toBe(true);
    first.unmount();

    render(<HrPage baseCurrency="UGX" actorId={actorId} organizationId={organizationId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry exact payroll draft" }));
    expect(await screen.findByText("Payroll draft completed.")).not.toBeNull();
    expect(intentIds).toHaveLength(2);
    expect(intentIds[1]).toBe(intentIds[0]);
    expect(fetchMock.mock.calls.some(([path, init]) => path === "/api/capabilities/execute" && init?.method === "POST")).toBe(true);
    expect(fetchMock.mock.calls.some(([path, init]) => path === "/api/hr" && init?.method === "POST")).toBe(false);
  });

  it("loads the overview and exposes keyboard accessible section tabs", async () => {
    const fetchMock = hrFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<HrPage baseCurrency="UGX" />);

    expect(await screen.findByRole("heading", { name: "People" })).not.toBeNull();
    expect(screen.getByText("Active people")).not.toBeNull();
    expect(screen.getByText("8h 30m")).not.toBeNull();
    const overviewTab = screen.getByRole("tab", { name: "Overview" });
    const peopleTab = screen.getByRole("tab", { name: "People" });
    expect(overviewTab.getAttribute("aria-selected")).toBe("true");
    expect(overviewTab.tabIndex).toBe(0);
    expect(peopleTab.tabIndex).toBe(-1);
    expect(fetchMock).toHaveBeenCalledWith("/api/hr", expect.objectContaining({ method: "GET" }));

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
    vi.stubGlobal("__GO_HR_TIME__", true);
    stubHrTimeLocks();
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
      if (path === "/api/hr") return Response.json(report);
      if (path === "/api/capabilities/execute") {
        const body = JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string };
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
    expect(await screen.findByText(/Client visit/)).not.toBeNull();
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

  it("keeps non-time HR writes on their existing route when Go Time is enabled", async () => {
    vi.stubGlobal("__GO_HR_TIME__", true);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/hr" && init?.method === "POST") return Response.json({ ok: true, data: { employeeId: "77777777-7777-4777-8777-777777777777" } });
      if (path === "/api/hr") return Response.json(report);
      if (path === "/api/capabilities/execute") {
        const body = JSON.parse(String(init?.body)) as { capabilityId: string };
        if (body.capabilityId === "hr.timeReport") return Response.json({ ok: true, data: { rows: [] } });
        if (body.capabilityId === "hr.pendingTimeEntries") return Response.json({ ok: true, data: { entries: [] } });
      }
      throw new Error(`Unexpected route: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<HrPage baseCurrency="UGX" actorId="55555555-5555-4555-8555-555555555555" organizationId="66666666-6666-4666-8666-666666666666" />);
    await screen.findByRole("heading", { name: "People" });
    fireEvent.click(screen.getByRole("tab", { name: "People" }));
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Grace Nambasa" } });
    fireEvent.change(screen.getByLabelText(/Monthly salary/), { target: { value: "1200000" } });
    fireEvent.click(screen.getByRole("button", { name: "Add employee" }));

    expect(await screen.findByText("Employee hire completed.")).not.toBeNull();
    expect(fetchMock.mock.calls.some(([path, init]) => path === "/api/hr" && init?.method === "POST")).toBe(true);
    expect(fetchMock.mock.calls.some(([path, init]) => path === "/api/capabilities/execute" && init?.method === "POST")).toBe(true);
  });

  it("opens the Expenses tab from its existing URL and completes governed claim, policy, and payment actions", async () => {
    window.history.replaceState(null, "", "/hr?tab=expenses");
    let claimStatus = "submitted";
    let submittedExpense: typeof expenseClaim | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/hr") return Response.json(report);
      if (path === "/api/time?pending=1") return Response.json({ entries: [] });
      if (path.startsWith("/api/time?")) return Response.json({ rows: [{ employeeId: employee.id, approvedMinutes: 0, pendingMinutes: 0 }] });
      if (path === "/api/expenses" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { action: string; decision?: string; category?: string; limitMinor?: number; amountMinor?: number };
        if (body.action === "decide") {
          claimStatus = body.decision === "approved" ? "approved" : "rejected";
          return Response.json({ ok: true, data: { claimId: expenseClaim.id, status: claimStatus } });
        }
        if (body.action === "pay") {
          claimStatus = "paid";
          return Response.json({ ok: true, data: { claimId: expenseClaim.id, entryId: "entry-1", paidMinor: expenseClaim.amountMinor } });
        }
        if (body.action === "setPolicy") return Response.json({ ok: true, data: { set: true, category: body.category, limitMinor: body.limitMinor } });
        if (body.action === "submit") {
          submittedExpense = { id: "33333333-3333-4333-8333-333333333333", claimantUserId: "44444444-4444-4444-8444-444444444444", amountMinor: body.amountMinor ?? 0, status: "submitted", memo: "Airport parking" };
          return Response.json({ ok: true, data: { claimId: submittedExpense.id, status: "submitted", category: "travel", overPolicyLimit: false, policyLimitMinor: null } });
        }
        return Response.json({ ok: true, data: { claimId: expenseClaim.id, status: "submitted", category: "travel", overPolicyLimit: false, policyLimitMinor: null } });
      }
      if (path === "/api/expenses") return Response.json({ claims: [{ ...expenseClaim, status: claimStatus }, ...(submittedExpense ? [submittedExpense] : [])], policies: [{ category: "travel", limitMinor: 25000 }] });
      return Response.json({ rows: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<HrPage baseCurrency="USD" />);

    expect(await screen.findByRole("heading", { name: "Submit an expense claim" })).not.toBeNull();
    expect(screen.getByRole("tab", { name: "Expenses" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText("Taxi to the client kickoff")).not.toBeNull();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Expense amount" }), { target: { value: "42.50" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Expense explanation" }), { target: { value: "Airport parking" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit claim" }));
    expect(await screen.findByText("Airport parking")).not.toBeNull();
    expect((screen.getByRole("spinbutton", { name: "Expense amount" }) as HTMLInputElement).value).toBe("");
    const expenseWrites = () => fetchMock.mock.calls.filter(([path, init]) => path === "/api/expenses" && init?.method === "POST");
    expect(JSON.parse(String(expenseWrites()[0]?.[1]?.body))).toMatchObject({ action: "submit", amountMinor: 4250, memo: "Airport parking", intentId: expect.any(String) });

    fireEvent.click(screen.getAllByRole("button", { name: "Approve" })[0]!);
    expect(await screen.findByRole("button", { name: /Pay/ })).not.toBeNull();
    expect(fetchMock.mock.calls.map(([path]) => String(path))).toContain("/api/expenses");
    expect(JSON.parse(String(expenseWrites()[1]?.[1]?.body))).toMatchObject({ action: "decide", claimId: expenseClaim.id, decision: "approved", intentId: expect.any(String) });

    fireEvent.click(screen.getByRole("button", { name: /Pay/ }));
    expect(await screen.findByText("paid")).not.toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Policy category" }), { target: { value: "travel" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Policy scrutiny limit" }), { target: { value: "300" } });
    fireEvent.click(screen.getByRole("button", { name: "Set limit" }));
    await waitFor(() => expect(expenseWrites()).toHaveLength(4));
    expect(JSON.parse(String(expenseWrites()[2]?.[1]?.body))).toMatchObject({ action: "pay", claimId: expenseClaim.id, amountMinor: expenseClaim.amountMinor });
    expect(JSON.parse(String(expenseWrites()[3]?.[1]?.body))).toMatchObject({ action: "setPolicy", category: "travel", limitMinor: 30000 });
  });

  it("keeps an expense draft while a governed action is awaiting approval", async () => {
    window.history.replaceState(null, "", "/hr?tab=expenses");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/hr") return Response.json(report);
      if (path === "/api/time?pending=1") return Response.json({ entries: [] });
      if (path.startsWith("/api/time?")) return Response.json({ rows: [] });
      if (path === "/api/expenses" && init?.method === "POST") return Response.json({ error: "Needs human approval.", pendingApproval: true }, { status: 202 });
      if (path === "/api/expenses") return Response.json({ claims: [], policies: [] });
      return Response.json({ rows: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<HrPage />);
    await screen.findByRole("heading", { name: "Submit an expense claim" });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Expense amount" }), { target: { value: "42.50" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Expense explanation" }), { target: { value: "Client travel" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit claim" }));

    expect(await screen.findByText(/is above the payment threshold/)).not.toBeNull();
    expect(screen.getByRole("link", { name: "Open approvals" })).not.toBeNull();
    expect((screen.getByRole("spinbutton", { name: "Expense amount" }) as HTMLInputElement).value).toBe("42.50");
    expect((screen.getByRole("textbox", { name: "Expense explanation" }) as HTMLInputElement).value).toBe("Client travel");
    expect(fetchMock.mock.calls.filter(([path, init]) => path === "/api/expenses" && init?.method === "GET")).toHaveLength(1);
  });

  it("records claim rejection through the same governed review endpoint", async () => {
    window.history.replaceState(null, "", "/hr?tab=expenses");
    let claimStatus = "submitted";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/hr") return Response.json(report);
      if (path === "/api/time?pending=1") return Response.json({ entries: [] });
      if (path.startsWith("/api/time?")) return Response.json({ rows: [] });
      if (path === "/api/expenses" && init?.method === "POST") {
        claimStatus = "rejected";
        return Response.json({ ok: true, data: { claimId: expenseClaim.id, status: "rejected" } });
      }
      if (path === "/api/expenses") return Response.json({ claims: [{ ...expenseClaim, status: claimStatus }], policies: [] });
      return Response.json({ rows: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<HrPage actorId="55555555-5555-4555-8555-555555555555" organizationId="66666666-6666-4666-8666-666666666666" />);
    await screen.findByText("Taxi to the client kickoff");
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    expect(await screen.findByText("rejected")).not.toBeNull();
    const rejectRequest = fetchMock.mock.calls.find(([path, init]) => path === "/api/expenses" && init?.method === "POST");
    expect(JSON.parse(String(rejectRequest?.[1]?.body))).toMatchObject({ action: "decide", claimId: expenseClaim.id, decision: "rejected", intentId: expect.any(String) });
  });

  it("matches the Go memo and policy category limits in the expense form", async () => {
    window.history.replaceState(null, "", "/hr?tab=expenses");
    const baseFetch = hrFetch();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/expenses") return Response.json({ claims: [], policies: [] });
      return baseFetch(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<HrPage />);
    await screen.findByRole("heading", { name: "Submit an expense claim" });

    const memo = screen.getByRole("textbox", { name: "Expense explanation" }) as HTMLInputElement;
    const category = screen.getByRole("textbox", { name: "Policy category" }) as HTMLInputElement;
    expect([memo.minLength, memo.maxLength]).toEqual([3, 500]);
    expect([category.minLength, category.maxLength]).toEqual([2, 40]);
  });

  it("keeps expense review data behind the existing expenses permission", async () => {
    window.history.replaceState(null, "", "/hr?tab=expenses");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/hr") return Response.json(report);
      if (path === "/api/time?pending=1") return Response.json({ entries: [] });
      if (path.startsWith("/api/time?")) return Response.json({ rows: [] });
      if (path === "/api/expenses") return Response.json({ error: "forbidden: missing expenses.decide" }, { status: 403 });
      return Response.json({ rows: [] });
    }));
    render(<HrPage />);

    expect(await screen.findByRole("heading", { name: "Access denied" })).not.toBeNull();
    expect(screen.getByText("forbidden: missing expenses.decide")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByText("Taxi to the client kickoff")).toBeNull();
  });

  it("routes Vite expenses to Go and recovers the exact pending claim action", async () => {
    window.history.replaceState(null, "", "/hr?tab=expenses");
    vi.stubGlobal("__GO_HR_EXPENSES__", true);
    let pendingFirstSubmit = true;
    const requests: Array<{ capabilityId: string; intentId: string; input: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/hr") return Response.json(report);
      if (path === "/api/time?pending=1") return Response.json({ entries: [] });
      if (path.startsWith("/api/time?")) return Response.json({ rows: [] });
      if (path === "/api/capabilities/execute") {
        const body = JSON.parse(String(init?.body)) as { capabilityId: string; intentId: string; input: Record<string, unknown> };
        if (body.capabilityId === "accounting.listExpenseClaims") return Response.json({ ok: true, data: { claims: [expenseClaim] } });
        if (body.capabilityId === "accounting.listExpensePolicies") return Response.json({ ok: true, data: { policies: [] } });
        requests.push(body);
        if (pendingFirstSubmit) {
          pendingFirstSubmit = false;
          return Response.json({ ok: false, pendingApproval: true, reason: "Manager review required" }, { status: 202 });
        }
        return Response.json({ ok: true, data: { claimId: "33333333-3333-4333-8333-333333333333", status: "submitted", category: "travel", overPolicyLimit: false, policyLimitMinor: null } });
      }
      return Response.json({ rows: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const page = render(<HrPage actorId="55555555-5555-4555-8555-555555555555" organizationId="66666666-6666-4666-8666-666666666666" />);

    await screen.findByRole("heading", { name: "Submit an expense claim" });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Expense amount" }), { target: { value: "42.50" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Expense explanation" }), { target: { value: "Client travel" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit claim" }));
    expect(await screen.findByText(/Manager review required/)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Retry exact expense action" })).not.toBeNull();

    page.unmount();
    render(<HrPage actorId="55555555-5555-4555-8555-555555555555" organizationId="66666666-6666-4666-8666-666666666666" />);
    await screen.findByRole("button", { name: "Retry exact expense action" });
    fireEvent.click(screen.getByRole("button", { name: "Retry exact expense action" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Expense action done."));
    expect(requests.map(({ capabilityId }) => capabilityId)).toEqual(["accounting.submitExpenseClaim", "accounting.submitExpenseClaim"]);
    expect(requests[0]?.intentId).toBe(requests[1]?.intentId);
    expect(requests[0]?.input).toEqual({ amountMinor: 4250, memo: "Client travel" });
    expect(requests[1]?.input).toEqual(requests[0]?.input);
    expect(fetchMock).not.toHaveBeenCalledWith("/api/expenses", expect.anything());
  });

  it("submits leave through the existing governed HR API and refreshes records", async () => {
    vi.stubGlobal("__GO_HR_LEAVE__", false);
    const fetchMock = hrFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<HrPage actorId="55555555-5555-4555-8555-555555555555" organizationId="66666666-6666-4666-8666-666666666666" />);
    await screen.findByRole("heading", { name: "People" });
    fireEvent.click(screen.getByRole("tab", { name: "Leave" }));

    fireEvent.change(screen.getByLabelText("Employee"), { target: { value: employee.id } });
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-10-10" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-10-11" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit leave request" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Leave request completed."));
    const submission = fetchMock.mock.calls.find(([path, init]) => path === "/api/hr" && init?.method === "POST");
    expect(submission).toBeDefined();
    const body = JSON.parse(String(submission?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ action: "requestLeave", employeeId: employee.id, startDate: "2026-10-10", endDate: "2026-10-11" });
    expect(body.intentId).toEqual(expect.any(String));
  });

  it("uses Go for the Leave route and recovers the exact pending action after reload", async () => {
    window.history.replaceState(null, "", "/hr?tab=leave");
    vi.stubGlobal("__GO_HR_LEAVE__", true);
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
    vi.stubGlobal("fetch", fetchMock);
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

  it("loads one report when switching to the Go Leave source", async () => {
    vi.stubGlobal("__GO_HR_LEAVE__", true);
    const employeeId = "11111111-1111-4111-8111-111111111111";
    const goReport = { ...report, employees: [{ ...employee, id: employeeId }] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "hr" }], enabledModules: ["hr"] });
      if (path === "/api/hr") return Response.json(report);
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
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/hr")).toHaveLength(1);
  });

  it("keeps a hire draft when the governed action is waiting for approval", async () => {
    const fetchMock = hrFetchWithPendingActions(["/api/hr"]);
    vi.stubGlobal("fetch", fetchMock);
    render(<HrPage baseCurrency="UGX" actorId="55555555-5555-4555-8555-555555555555" organizationId="66666666-6666-4666-8666-666666666666" />);
    await screen.findByRole("heading", { name: "People" });
    fireEvent.click(screen.getByRole("tab", { name: "People" }));
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Grace Nambasa" } });
    fireEvent.change(screen.getByLabelText(/Monthly salary/), { target: { value: "1200000" } });
    fireEvent.click(screen.getByRole("button", { name: "Add employee" }));

    expect(await screen.findByText("Employee hire needs human approval. Check the Approvals inbox.")).not.toBeNull();
    expect((screen.getByLabelText("Full name") as HTMLInputElement).value).toBe("Grace Nambasa");
    expect((screen.getByLabelText(/Monthly salary/) as HTMLInputElement).value).toBe("1200000");
  });

  it("keeps a time entry draft when the governed action is waiting for approval", async () => {
    const fetchMock = hrFetchWithPendingActions(["/api/time"]);
    vi.stubGlobal("fetch", fetchMock);
    render(<HrPage baseCurrency="UGX" actorId="55555555-5555-4555-8555-555555555555" organizationId="66666666-6666-4666-8666-666666666666" />);
    await screen.findByRole("heading", { name: "People" });
    fireEvent.click(screen.getByRole("tab", { name: "Time" }));
    fireEvent.change(screen.getByLabelText("Employee"), { target: { value: employee.id } });
    fireEvent.change(screen.getByLabelText("Hours"), { target: { value: "2.5" } });
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "Month end review" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit time" }));

    expect(await screen.findByText("Time entry needs approval or result recovery. Retry the exact action after approval is complete.")).not.toBeNull();
    expect((screen.getByLabelText("Hours") as HTMLInputElement).value).toBe("2.5");
    expect((screen.getByLabelText("Note") as HTMLInputElement).value).toBe("Month end review");
  });

  it("clearly reports when the HR module is disabled", async () => {
    const fetchMock = hrFetch(false);
    vi.stubGlobal("fetch", fetchMock);
    render(<HrPage actorId="55555555-5555-4555-8555-555555555555" organizationId="66666666-6666-4666-8666-666666666666" />);
    expect(await screen.findByRole("heading", { name: "People is turned off" })).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/time?pending=1", expect.any(Object));
  });

  it("does not enable salary entry until the organization currency is known", async () => {
    vi.stubGlobal("fetch", hrFetch());
    render(<HrPage baseCurrency={null} />);
    await screen.findByRole("heading", { name: "People" });
    fireEvent.click(screen.getByRole("tab", { name: "People" }));
    expect(screen.getByLabelText(/Monthly salary/).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Add employee" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByText("Loading currency").length).toBeGreaterThan(0);
  });
});
