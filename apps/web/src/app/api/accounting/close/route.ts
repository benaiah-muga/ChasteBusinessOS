import { NextResponse } from "next/server";
import { z } from "zod";
import { buildExecutor, buildRegistry, actorFromResolved } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { missingPermission } from "@/server/route-guards";
import { getDb } from "@chaste/db";

const closeWindow = z.object({ year: z.coerce.number().int().min(2000).max(2100), month: z.coerce.number().int().min(1).max(12) });

function respond(result: { ok: boolean; data?: unknown; error?: string; pendingApproval?: unknown }) {
  if (result.pendingApproval) return NextResponse.json({ ok: false, pendingApproval: true, reason: result.error }, { status: 202 });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}

export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const denied = missingPermission(resolved, "accounting.read");
  if (denied) return denied;
  const now = new Date();
  const prior = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const query = closeWindow.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  const queryParams = new URL(req.url).searchParams;
  if ((queryParams.has("year") || queryParams.has("month")) && !query.success) {
    return NextResponse.json({ error: "invalid close period" }, { status: 400 });
  }
  const period = query.success ? query.data : { year: prior.getUTCFullYear(), month: prior.getUTCMonth() + 1 };
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));
  return respond(await executor.execute("accounting.periodCloseWorkbench", ctx, period));
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const bodySchema = z.object({
    action: z.enum(["checklist", "revalue", "close", "reopen"]),
    intentId: z.string().optional(),
    year: z.number().int().min(2000).max(2100),
    month: z.number().int().min(1).max(12),
    taskKey: z.enum(["review_journal", "review_receivables", "review_payables", "review_tax"]).optional(),
    completed: z.boolean().optional(),
    note: z.string().max(500).optional(),
  });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const body = parsed.data;
  const requiredPermission = body.action === "checklist" ? "accounting.write"
    : body.action === "reopen" || body.action === "close" ? "accounting.admin"
    : "accounting.post";
  const denied = missingPermission(resolved, requiredPermission);
  if (denied) return denied;
  const ctx = actorFromResolved(resolved, { intentId: body.intentId });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));
  if (body.action === "checklist" && body.taskKey !== undefined && body.completed !== undefined) {
    return respond(await executor.execute("accounting.updatePeriodCloseCheck", ctx, { year: body.year, month: body.month, taskKey: body.taskKey, completed: body.completed, note: body.note }));
  }
  if (body.action === "revalue") return respond(await executor.execute("accounting.revalueForeignReceivables", ctx, { year: body.year, month: body.month }));
  if (body.action === "close") return respond(await executor.execute("accounting.closePeriod", ctx, { year: body.year, month: body.month }));
  if (body.action === "reopen") return respond(await executor.execute("accounting.reopenPeriod", ctx, { year: body.year, month: body.month }));
  return NextResponse.json({ error: "checklist action requires taskKey and completed" }, { status: 400 });
}
