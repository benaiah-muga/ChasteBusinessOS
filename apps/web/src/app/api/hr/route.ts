import { NextResponse } from "next/server";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, employees, leaveRequests, payrollRuns, jobOpenings, timeEntries } from "@chaste/db";
import { getResolvedUser } from "@/server/session";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { missingPermission } from "@/server/route-guards";
import { executeGoCapability, type GoCapabilityBridgeResult } from "@/server/go-bridge";

const noStore = { "Cache-Control": "no-store" };

function hrEmployeeGoUnavailable() {
  return NextResponse.json(
    { error: "HR service unavailable; check employee status before retrying" },
    { status: 503, headers: noStore },
  );
}

function hrUnavailable(message: string) {
  return NextResponse.json({ error: message }, { status: 503, headers: noStore });
}

async function hrWaveGoResponse(result: GoCapabilityBridgeResult, unavailable: NextResponse) {
  if (result.kind !== "response") return unavailable;
  try {
    const body: unknown = await result.response.json();
    if (result.response.status === 200) {
      const parsed = z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) }).safeParse(body);
      if (!parsed.success) return unavailable;
      return NextResponse.json({ ok: true, data: parsed.data.data }, { headers: noStore });
    }
    if (result.response.status === 202) {
      const parsed = z.object({ ok: z.literal(false), pendingApproval: z.literal(true), reason: z.string() }).safeParse(body);
      if (!parsed.success) return unavailable;
      return NextResponse.json({ ok: false, pendingApproval: true, reason: parsed.data.reason }, { status: 202, headers: noStore });
    }
    if (result.response.status === 401) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return unavailable;
      return NextResponse.json({ error: parsed.data.error }, { status: 401, headers: noStore });
    }
    if ([400, 403, 422].includes(result.response.status)) {
      const parsed = result.response.status === 422
        ? z.object({ ok: z.literal(false), error: z.string() }).safeParse(body)
        : z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return unavailable;
      return NextResponse.json({ ok: false, error: parsed.data.error }, { status: 422, headers: noStore });
    }
  } catch {
    return unavailable;
  }
  return unavailable;
}

async function hrEmployeeGoResponse(
  result: GoCapabilityBridgeResult,
  action: "hireEmployee" | "deactivateEmployee" | "updateStructure",
) {
  if (result.kind !== "response") return hrEmployeeGoUnavailable();

  try {
    const body: unknown = await result.response.json();
    if (result.response.status === 200) {
      const employeeDataSchema = action === "hireEmployee"
        ? z.object({ employeeId: z.string() })
        : action === "deactivateEmployee"
          ? z.object({ deactivated: z.boolean() })
          : z.object({ updated: z.literal(true) });
      const parsed = z.object({ ok: z.literal(true), data: employeeDataSchema }).safeParse(body);
      if (!parsed.success) return hrEmployeeGoUnavailable();
      return NextResponse.json({ ok: true, data: parsed.data.data }, { headers: noStore });
    }
    if (result.response.status === 202) {
      const parsed = z.object({ ok: z.literal(false), pendingApproval: z.literal(true), reason: z.string() }).safeParse(body);
      if (!parsed.success) return hrEmployeeGoUnavailable();
      return NextResponse.json(
        { ok: false, pendingApproval: true, reason: parsed.data.reason },
        { status: 202, headers: noStore },
      );
    }
    if (result.response.status === 401) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return hrEmployeeGoUnavailable();
      return NextResponse.json({ error: parsed.data.error }, { status: 401, headers: noStore });
    }
    if ([400, 403, 422].includes(result.response.status)) {
      const parsed = result.response.status === 422
        ? z.object({ ok: z.literal(false), error: z.string() }).safeParse(body)
        : z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return hrEmployeeGoUnavailable();
      return NextResponse.json({ ok: false, error: parsed.data.error }, { status: 422, headers: noStore });
    }
  } catch {
    return hrEmployeeGoUnavailable();
  }

  return hrEmployeeGoUnavailable();
}

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const denied = missingPermission(resolved, "hr.read");
  if (denied) return denied;
  const db = getDb().db;
  const orgId = resolved.orgId;

  const staff = await db
    .select()
    .from(employees)
    .where(eq(employees.orgId, orgId))
    .orderBy(desc(employees.hiredAt))
    .limit(200);

  const leave = await db
    .select({
      id: leaveRequests.id,
      employeeName: employees.name,
      kind: leaveRequests.kind,
      startDate: leaveRequests.startDate,
      endDate: leaveRequests.endDate,
      calendarDays: leaveRequests.calendarDays,
      status: leaveRequests.status,
    })
    .from(leaveRequests)
    .innerJoin(employees, eq(employees.id, leaveRequests.employeeId))
    .where(eq(leaveRequests.orgId, orgId))
    .orderBy(desc(leaveRequests.createdAt))
    .limit(50);

  const runs = await db
    .select()
    .from(payrollRuns)
    .where(eq(payrollRuns.orgId, orgId))
    .orderBy(desc(payrollRuns.year), desc(payrollRuns.month))
    .limit(24);

  // Recruitment + attendance surface (M11 capabilities; no org-wide list
  // capability exists for openings, so the opening index is a plain read and
  // each open opening's pipeline goes through the governed read).
  const openings = await db
    .select()
    .from(jobOpenings)
    .where(eq(jobOpenings.orgId, orgId))
    .orderBy(desc(jobOpenings.createdAt))
    .limit(50);

  const ctx = actorFromResolved(resolved, {});
  const executor = ctx ? buildExecutor(db, buildRegistry(db)) : null;
  const applicants: Array<{ id: string; openingId: string; name: string; stage: string; note: string | null }> = [];
  if (executor && ctx) {
    for (const opening of openings.filter((o) => o.status === "open")) {
      const result = await executor.execute("hr.listApplicants", ctx, { openingId: opening.id });
      const data = result.data as { applicants: { id: string; name: string; stage: string; note: string | null }[] } | undefined;
      if (result.ok && data) {
        for (const a of data.applicants) applicants.push({ ...a, openingId: opening.id });
      }
    }
  }

  const openClocks = await db
    .select({
      employeeId: timeEntries.employeeId,
      clockedInAt: timeEntries.clockedInAt,
      late: timeEntries.late,
    })
    .from(timeEntries)
    .where(
      and(eq(timeEntries.orgId, orgId), isNull(timeEntries.clockedOutAt), sql`${timeEntries.clockedInAt} is not null`),
    )
    .limit(200);

  return NextResponse.json({
    employees: staff.map((e) => ({
      id: e.id,
      name: e.name,
      email: e.email,
      title: e.title,
      department: e.department,
      managerEmployeeId: e.managerEmployeeId,
      emergencyContactName: e.emergencyContactName,
      emergencyContactPhone: e.emergencyContactPhone,
      monthlySalaryMinor: e.monthlySalaryMinor,
      taxRateBps: e.taxRateBps,
      active: e.deactivatedAt === null,
    })),
    leave: leave.map((l) => ({
      ...l,
      startDate: l.startDate.toISOString(),
      endDate: l.endDate.toISOString(),
    })),
    runs,
    openings: openings.map((o) => ({
      id: o.id,
      title: o.title,
      department: o.department,
      note: o.note,
      status: o.status,
      createdAt: o.createdAt.toISOString(),
    })),
    applicants,
    attendance: openClocks.map((c) => ({
      employeeId: c.employeeId,
      clockedInAt: c.clockedInAt!.toISOString(),
      late: c.late,
    })),
  });
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const executor = buildExecutor(getDb().db, buildRegistry(getDb().db));
  const body = (await req.json()) as {
    action?: string;
    name?: string;
    email?: string;
    title?: string;
    monthlySalaryMinor?: number;
    taxRateBps?: number;
    annualLeaveDays?: number;
    employeeId?: string;
    requestId?: string;
    kind?: string;
    startDate?: string;
    endDate?: string;
    approve?: boolean;
    year?: number;
    month?: number;
    runId?: string;
    expectedTotalNetMinor?: number;
    department?: string;
    position?: string;
    managerEmployeeId?: string;
    emergencyContactName?: string;
    emergencyContactPhone?: string;
    openingId?: string;
    applicantId?: string;
    stage?: string;
    note?: string;
    intentId?: string;
  };
  if (!body.action) return NextResponse.json({ error: "action required" }, { status: 400 });
  const intentId = typeof body.intentId === "string" ? body.intentId : undefined;
  const ctx = actorFromResolved(resolved, { intentId });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  // Missing required fields keep the legacy switch's parameter checks below.
  if (
    process.env.GO_HR_EMPLOYEE_WRITES === "1" &&
    (body.action === "hireEmployee" ||
      ((body.action === "deactivateEmployee" || body.action === "updateStructure") && body.employeeId))
  ) {
    const capabilityId = body.action === "hireEmployee"
      ? "hr.hireEmployee"
      : body.action === "deactivateEmployee"
        ? "hr.deactivateEmployee"
        : "hr.updateEmployeeStructure";
    const input = body.action === "hireEmployee"
      ? {
          name: body.name ?? "",
          email: body.email || undefined,
          title: body.title || undefined,
          monthlySalaryMinor: body.monthlySalaryMinor ?? 0,
          taxRateBps: body.taxRateBps,
          annualLeaveDays: body.annualLeaveDays,
        }
      : body.action === "deactivateEmployee"
        ? { employeeId: body.employeeId }
        : {
            employeeId: body.employeeId,
            department: body.department,
            position: body.position,
            managerEmployeeId: body.managerEmployeeId,
            emergencyContactName: body.emergencyContactName,
            emergencyContactPhone: body.emergencyContactPhone,
          };
    try {
      const result = await executeGoCapability({
        actionContext: ctx,
        session: resolved,
        capabilityId,
        input,
      });
      return hrEmployeeGoResponse(result, body.action);
    } catch {
      return hrEmployeeGoUnavailable();
    }
  }

  if (
    process.env.GO_HR_LEAVE_TIME_WRITES === "1" &&
    ["requestLeave", "decideLeave", "cancelLeave", "clockIn", "clockOut"].includes(body.action ?? "")
  ) {
    let capabilityId: string;
    let input: Record<string, unknown>;
    if (body.action === "requestLeave") {
      if (!body.employeeId || !body.startDate || !body.endDate)
        return NextResponse.json({ error: "employeeId, startDate and endDate are required" }, { status: 400 });
      capabilityId = "hr.requestLeave";
      input = { employeeId: body.employeeId as string, kind: body.kind as string, startDate: body.startDate as string, endDate: body.endDate as string };
    } else if (body.action === "decideLeave") {
      if (!body.requestId) return NextResponse.json({ error: "requestId is required" }, { status: 400 });
      capabilityId = "hr.decideLeave";
      input = { requestId: body.requestId as string, approve: Boolean(body.approve) };
    } else if (body.action === "cancelLeave") {
      if (!body.requestId) return NextResponse.json({ error: "requestId is required" }, { status: 400 });
      capabilityId = "hr.cancelLeave";
      input = { requestId: body.requestId as string };
    } else {
      if (!body.employeeId) return NextResponse.json({ error: "employeeId is required" }, { status: 400 });
      capabilityId = body.action === "clockIn" ? "hr.clockIn" : "hr.clockOut";
      input = { employeeId: body.employeeId as string };
    }
    const unavailable = hrUnavailable("HR service unavailable; check leave or time entry status before retrying");
    try {
      return await hrWaveGoResponse(await executeGoCapability({ actionContext: ctx, session: resolved, capabilityId, input }), unavailable);
    } catch {
      return unavailable;
    }
  }

  if (
    process.env.GO_HR_PAYROLL_APPLICANT_WRITES === "1" &&
    ["createPayrollRun", "executePayrollRun", "voidPayrollRun", "addApplicant", "moveApplicant", "hireApplicant"].includes(body.action ?? "")
  ) {
    let capabilityId: string;
    let input: Record<string, unknown>;
    if (body.action === "createPayrollRun") {
      if (!body.year || !body.month) return NextResponse.json({ error: "year and month are required" }, { status: 400 });
      capabilityId = "hr.createPayrollRun";
      input = { year: body.year as number, month: body.month as number };
    } else if (body.action === "executePayrollRun") {
      if (!body.runId || body.expectedTotalNetMinor === undefined)
        return NextResponse.json({ error: "runId and expectedTotalNetMinor are required" }, { status: 400 });
      capabilityId = "hr.executePayrollRun";
      input = { runId: body.runId as string, expectedTotalNetMinor: body.expectedTotalNetMinor as number };
    } else if (body.action === "voidPayrollRun") {
      if (!body.runId) return NextResponse.json({ error: "runId is required" }, { status: 400 });
      capabilityId = "hr.voidPayrollRun";
      input = { runId: body.runId as string };
    } else if (body.action === "addApplicant") {
      if (!body.openingId || !body.name) return NextResponse.json({ error: "openingId and name are required" }, { status: 400 });
      capabilityId = "hr.addApplicant";
      input = { openingId: body.openingId as string, name: body.name as string, email: (body.email as string) || undefined, note: (body.note as string) || undefined };
    } else if (body.action === "moveApplicant") {
      if (!body.applicantId || !body.stage) return NextResponse.json({ error: "applicantId and stage are required" }, { status: 400 });
      capabilityId = "hr.moveApplicant";
      input = { applicantId: body.applicantId as string, stage: body.stage as string };
    } else {
      if (!body.applicantId || !body.monthlySalaryMinor) return NextResponse.json({ error: "applicantId and monthlySalaryMinor are required" }, { status: 400 });
      capabilityId = "hr.hireApplicant";
      input = { applicantId: body.applicantId as string, monthlySalaryMinor: body.monthlySalaryMinor as number, annualLeaveDays: (body.annualLeaveDays as number) || undefined };
    }
    const unavailable = hrUnavailable("HR service unavailable; check payroll run or applicant status before retrying");
    try {
      return await hrWaveGoResponse(await executeGoCapability({ actionContext: ctx, session: resolved, capabilityId, input }), unavailable);
    } catch {
      return unavailable;
    }
  }

  // Dispatch explicitly so each capability gets exactly the input its schema declares.
  switch (body.action) {
    case "hireEmployee": {
      const result = await executor.execute("hr.hireEmployee", ctx, {
        name: body.name ?? "",
        email: body.email || undefined,
        title: body.title || undefined,
        monthlySalaryMinor: body.monthlySalaryMinor ?? 0,
        taxRateBps: body.taxRateBps,
        annualLeaveDays: body.annualLeaveDays,
      });
      return respond(result);
    }
    case "deactivateEmployee":
      if (!body.employeeId) break;
      return respond(await executor.execute("hr.deactivateEmployee", ctx, { employeeId: body.employeeId }));
    case "requestLeave":
      if (!body.employeeId || !body.startDate || !body.endDate) break;
      return respond(
        await executor.execute("hr.requestLeave", ctx, {
          employeeId: body.employeeId,
          kind: body.kind,
          startDate: body.startDate,
          endDate: body.endDate,
        }),
      );
    case "decideLeave":
      if (!body.requestId) break;
      return respond(await executor.execute("hr.decideLeave", ctx, { requestId: body.requestId, approve: Boolean(body.approve) }));
    case "cancelLeave":
      if (!body.requestId) break;
      return respond(await executor.execute("hr.cancelLeave", ctx, { requestId: body.requestId }));
    case "createPayrollRun":
      if (!body.year || !body.month) break;
      return respond(await executor.execute("hr.createPayrollRun", ctx, { year: body.year, month: body.month }));
    case "executePayrollRun":
      if (!body.runId || body.expectedTotalNetMinor === undefined) break;
      return respond(
        await executor.execute("hr.executePayrollRun", ctx, {
          runId: body.runId,
          expectedTotalNetMinor: body.expectedTotalNetMinor,
        }),
      );
    case "voidPayrollRun":
      if (!body.runId) break;
      return respond(await executor.execute("hr.voidPayrollRun", ctx, { runId: body.runId }));
    case "clockIn":
      if (!body.employeeId) break;
      return respond(await executor.execute("hr.clockIn", ctx, { employeeId: body.employeeId }));
    case "clockOut":
      if (!body.employeeId) break;
      return respond(await executor.execute("hr.clockOut", ctx, { employeeId: body.employeeId }));
    case "updateStructure":
      if (!body.employeeId) break;
      return respond(
        await executor.execute("hr.updateEmployeeStructure", ctx, {
          employeeId: body.employeeId,
          department: body.department,
          position: body.position,
          managerEmployeeId: body.managerEmployeeId,
          emergencyContactName: body.emergencyContactName,
          emergencyContactPhone: body.emergencyContactPhone,
        }),
      );
    case "createOpening":
      if (!body.title) break;
      return respond(
        await executor.execute("hr.createOpening", ctx, {
          title: body.title,
          department: body.department || undefined,
          note: body.note || undefined,
        }),
      );
    case "closeOpening":
      if (!body.openingId) break;
      return respond(await executor.execute("hr.closeOpening", ctx, { openingId: body.openingId }));
    case "addApplicant":
      if (!body.openingId || !body.name) break;
      return respond(
        await executor.execute("hr.addApplicant", ctx, {
          openingId: body.openingId,
          name: body.name,
          email: body.email || undefined,
          note: body.note || undefined,
        }),
      );
    case "moveApplicant":
      if (!body.applicantId || !body.stage) break;
      return respond(await executor.execute("hr.moveApplicant", ctx, { applicantId: body.applicantId, stage: body.stage }));
    case "hireApplicant":
      if (!body.applicantId || !body.monthlySalaryMinor) break;
      return respond(
        await executor.execute("hr.hireApplicant", ctx, {
          applicantId: body.applicantId,
          monthlySalaryMinor: body.monthlySalaryMinor,
          annualLeaveDays: body.annualLeaveDays,
        }),
      );
    default:
      return NextResponse.json({ error: "invalid action" }, { status: 400 });
  }
  return NextResponse.json({ error: "missing parameters for action" }, { status: 400 });
}

function respond(result: { ok: boolean; data?: unknown; error?: string; pendingApproval?: unknown }) {
  if (result.pendingApproval) {
    return NextResponse.json({ ok: false, pendingApproval: true, reason: result.error }, { status: 202 });
  }
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}
