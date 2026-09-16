import { NextResponse } from "next/server";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb, employees, leaveRequests, payrollRuns, jobOpenings, timeEntries } from "@chaste/db";
import { getResolvedUser } from "@/server/session";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { missingPermission } from "@/server/route-guards";

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
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

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
  };
  if (!body.action) return NextResponse.json({ error: "action required" }, { status: 400 });

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
