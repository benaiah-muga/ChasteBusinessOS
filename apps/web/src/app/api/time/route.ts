import { NextResponse } from "next/server";
import { and, desc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { getDb, employees, timeEntries } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("log"),
    employeeId: z.string().uuid(),
    workDate: z.coerce.date(),
    minutes: z.number().int().positive().max(1440),
    note: z.string().max(300).optional(),
  }),
  z.object({
    action: z.literal("decide"),
    entryId: z.string().uuid(),
    decision: z.enum(["approved", "rejected"]),
  }),
]);

export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);

  // Entry-level approval queue: the report capability is aggregate-only, so
  // pending submitted entries (with ids to decide on) are a plain read.
  if (url.searchParams.get("pending")) {
    const rows = await getDb().db
      .select({
        id: timeEntries.id,
        employeeId: timeEntries.employeeId,
        employeeName: employees.name,
        workDate: timeEntries.workDate,
        minutes: timeEntries.minutes,
        note: timeEntries.note,
        late: timeEntries.late,
      })
      .from(timeEntries)
      .innerJoin(employees, eq(employees.id, timeEntries.employeeId))
      .where(and(eq(timeEntries.orgId, resolved.orgId), eq(timeEntries.status, "submitted"), gt(timeEntries.minutes, 0)))
      .orderBy(desc(timeEntries.workDate))
      .limit(100);
    return NextResponse.json({
      entries: rows.map((r) => ({ ...r, workDate: r.workDate.toISOString() })),
    });
  }

  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) return NextResponse.json({ error: "from and to are required" }, { status: 400 });
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return NextResponse.json({ error: "invalid dates" }, { status: 400 });
  }
  const employeeId = url.searchParams.get("employeeId") ?? undefined;
  const db = getDb().db;
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const result = await buildExecutor(db, buildRegistry(db)).execute("hr.timeReport", ctx, {
    from: fromDate,
    to: toDate,
    employeeId,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  return NextResponse.json(result.data);
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const db = getDb().db;
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  const capId = parsed.data.action === "log" ? "hr.logTime" : "hr.decideTimeEntry";
  const input =
    parsed.data.action === "log"
      ? {
          employeeId: parsed.data.employeeId,
          workDate: parsed.data.workDate,
          minutes: parsed.data.minutes,
          note: parsed.data.note,
        }
      : { entryId: parsed.data.entryId, decision: parsed.data.decision };

  const result = await buildExecutor(db, buildRegistry(db)).execute(capId, ctx, input);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}
