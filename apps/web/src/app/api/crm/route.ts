import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("convertLead"),
    dealId: z.string().uuid(),
    customerId: z.string().uuid().optional(),
    createCustomer: z.boolean().optional(),
    customerName: z.string().min(1).max(200).optional(),
  }),
  z.object({
    action: z.literal("createTask"),
    title: z.string().min(1).max(200),
    dueAt: z.string().datetime().optional(),
    assigneeUserId: z.string().uuid().optional(),
    refType: z.string().max(50).optional(),
    refId: z.string().uuid().optional(),
    note: z.string().max(2000).optional(),
  }),
  z.object({ action: z.literal("completeTask"), taskId: z.string().uuid() }),
  z.object({
    action: z.literal("updateTaskDetails"),
    taskId: z.string().uuid(),
    dueAt: z.string().datetime().nullable().optional(),
    assigneeUserId: z.string().uuid().nullable().optional(),
  }),
]);

export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const url = new URL(req.url);
  const executor = buildExecutor(getDb().db, buildRegistry(getDb().db));

  const timelineId = url.searchParams.get("timeline");
  if (timelineId) {
    const result = await executor.execute("crm.customerTimeline", ctx, { customerId: timelineId });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
    return NextResponse.json(result.data);
  }

  if (url.searchParams.get("tasks")) {
    const result = await executor.execute("crm.listTasks", ctx, { openOnly: url.searchParams.get("open") === "1" ? true : undefined });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
    return NextResponse.json(result.data);
  }

  return NextResponse.json({ error: "nothing requested" }, { status: 400 });
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const intentId = typeof raw?.intentId === "string" ? raw.intentId : undefined;
  const parsed = actionSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const db = getDb().db;
  const ctx = actorFromResolved(resolved, { intentId });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  const d = parsed.data;
  const capId = d.action === "convertLead" ? "crm.convertLead"
    : d.action === "createTask" ? "crm.createTask"
      : d.action === "completeTask" ? "crm.completeTask" : "crm.updateTaskDetails";
  const input =
    d.action === "convertLead"
      ? {
          dealId: d.dealId,
          customerId: d.customerId,
          createCustomer: d.createCustomer,
          customerName: d.customerName,
        }
      : d.action === "createTask"
        ? {
            title: d.title,
            dueAt: d.dueAt,
            assigneeUserId: d.assigneeUserId,
            refType: d.refType,
            refId: d.refId,
            note: d.note,
          }
        : d.action === "completeTask" ? { taskId: d.taskId }
          : { taskId: d.taskId, ...(d.dueAt !== undefined ? { dueAt: d.dueAt } : {}), ...(d.assigneeUserId !== undefined ? { assigneeUserId: d.assigneeUserId } : {}) };

  const result = await buildExecutor(db, buildRegistry(db)).execute(capId, ctx, input);
  if (!result.ok) {
    const gated = Boolean(result.pendingApproval);
    return NextResponse.json(
      { error: result.error, pendingApproval: gated || undefined },
      { status: gated ? 202 : 422 },
    );
  }
  return NextResponse.json({ ok: true, data: result.data });
}
