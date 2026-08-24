import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb, employees, leaveRequests, payrollRuns } from "@chaste/db";
import { getResolvedUser } from "@/server/session";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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

  return NextResponse.json({
    employees: staff.map((e) => ({
      id: e.id,
      name: e.name,
      email: e.email,
      title: e.title,
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
