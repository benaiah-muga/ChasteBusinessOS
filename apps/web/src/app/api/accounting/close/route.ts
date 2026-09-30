import { NextResponse } from "next/server";
import { z } from "zod";
import { buildExecutor, buildRegistry, actorFromResolved } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { missingPermission } from "@/server/route-guards";
import { getDb } from "@chaste/db";
import { dispatchGoCapabilityRoute } from "@/server/go-route-response";

const closeWindow = z.object({ year: z.coerce.number().int().min(2000).max(2100), month: z.coerce.number().int().min(1).max(12) });
const fxRateUnavailableMessage = "accounting service unavailable; check FX rate status before retrying";
const fxRevaluationInteger = z.number().int().safe();
const fxRevaluationAmount = fxRevaluationInteger.nonnegative();
const fxRevaluationPositiveRate = fxRevaluationInteger.positive();
const fxRevaluationOutputSchema = z.object({
  revaluationId: z.string().uuid(),
  entryId: z.string().uuid().nullable(),
  totalAdjustmentMinor: fxRevaluationInteger,
  currencies: z.array(z.object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    foreignMinor: fxRevaluationAmount,
    historicalBaseMinor: fxRevaluationAmount,
    closeBaseMinor: fxRevaluationAmount,
    adjustmentMinor: fxRevaluationInteger,
    rateNum: fxRevaluationPositiveRate,
    rateDen: fxRevaluationPositiveRate,
  }).strict()),
  alreadyReviewed: z.boolean(),
}).strict();
const fxRevaluationEnvelopeSchema = z.object({ ok: z.literal(true), data: fxRevaluationOutputSchema }).strict();
const closeTaskKeys = [
  "review_journal",
  "review_receivables",
  "review_payables",
  "review_tax",
  "bank_reconciliation",
  "fx_revaluation",
] as const;
const periodCloseWorkbenchSchema = z.object({
  year: z.number().int().safe().min(2000).max(2100),
  month: z.number().int().safe().min(1).max(12),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  tasks: z.array(z.object({
    key: z.enum(closeTaskKeys),
    label: z.string().min(1),
    detail: z.string(),
    completed: z.boolean(),
    note: z.string().nullable(),
    blocking: z.boolean(),
    status: z.string().min(1),
  }).strict()),
  blockers: z.array(z.string().min(1)),
  readyToClose: z.boolean(),
  unmatchedLineCount: z.number().int().safe().nonnegative(),
  currenciesWithExposure: z.array(z.string().regex(/^[A-Z]{3}$/)),
}).strict().superRefine((readiness, context) => {
  const taskKeys = readiness.tasks.map((task) => task.key);
  if (taskKeys.length !== closeTaskKeys.length || closeTaskKeys.some((key, index) => taskKeys[index] !== key)) {
    context.addIssue({ code: "custom", path: ["tasks"], message: "Close tasks must contain the six supported keys in order." });
  }
  for (const task of readiness.tasks) {
    const completedStatus = task.completed ? "complete" : task.key === "bank_reconciliation"
      ? "blocked"
      : task.key === "fx_revaluation" ? "needs_revaluation" : "needs_review";
    if (task.blocking === task.completed || task.status !== completedStatus) {
      context.addIssue({ code: "custom", path: ["tasks"], message: `Close task ${task.key} has inconsistent completion, blocking, or status fields.` });
    }
  }
  const blockingKeys = readiness.tasks.filter((task) => task.blocking).map((task) => task.key);
  if (readiness.blockers.length !== blockingKeys.length || readiness.blockers.some((key, index) => key !== blockingKeys[index])) {
    context.addIssue({ code: "custom", path: ["blockers"], message: "Close blockers must match the blocking tasks." });
  }
  if (readiness.readyToClose !== (readiness.blockers.length === 0)) {
    context.addIssue({ code: "custom", path: ["readyToClose"], message: "Readiness must match the blocker list." });
  }
  const bankTask = readiness.tasks.find((task) => task.key === "bank_reconciliation");
  if (bankTask && bankTask.completed !== (readiness.unmatchedLineCount === 0)) {
    context.addIssue({ code: "custom", path: ["tasks"], message: "Bank reconciliation status must match the unmatched line count." });
  }
  const fxTask = readiness.tasks.find((task) => task.key === "fx_revaluation");
  if (fxTask && readiness.currenciesWithExposure.length === 0 && !fxTask.completed) {
    context.addIssue({ code: "custom", path: ["tasks"], message: "FX review cannot block when there is no foreign exposure." });
  }
});
const periodCloseWorkbenchEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: periodCloseWorkbenchSchema,
}).strict();

function respond(result: { ok: boolean; data?: unknown; error?: string; pendingApproval?: unknown }) {
  if (result.pendingApproval) return NextResponse.json({ ok: false, pendingApproval: true, reason: result.error }, { status: 202 });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}

async function revalueForeignReceivablesWithGo(
  ctx: NonNullable<ReturnType<typeof actorFromResolved>>,
  session: NonNullable<Awaited<ReturnType<typeof getResolvedUser>>>,
  year: number,
  month: number,
) {
  const response = await dispatchGoCapabilityRoute({
    actionContext: ctx,
    session,
    capabilityId: "accounting.revalueForeignReceivables",
    input: { year, month },
  }, fxRateUnavailableMessage);
  if (response.status !== 200) return response;

  const parsed = fxRevaluationEnvelopeSchema.safeParse(await response.clone().json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: fxRateUnavailableMessage }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json(parsed.data, { headers: { "Cache-Control": "no-store" } });
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
  if (process.env.GO_ACCOUNTING_PERIOD_CLOSE_WRITES === "1") {
    const unavailable = "accounting service unavailable; check period close status before retrying";
    try {
      const response = await dispatchGoCapabilityRoute({
        actionContext: ctx,
        session: resolved,
        capabilityId: "accounting.periodCloseWorkbench",
        input: period,
      }, unavailable);
      if (response.status !== 200) return response;
      const parsed = periodCloseWorkbenchEnvelopeSchema.safeParse(await response.clone().json().catch(() => null));
      const expectedStart = new Date(Date.UTC(period.year, period.month - 1, 1)).toISOString();
      const expectedEnd = new Date(Date.UTC(period.year, period.month, 1) - 1).toISOString();
      if (
        !parsed.success ||
        parsed.data.data.year !== period.year ||
        parsed.data.data.month !== period.month ||
        parsed.data.data.start !== expectedStart ||
        parsed.data.data.end !== expectedEnd
      ) {
        return NextResponse.json({ error: unavailable }, { status: 503, headers: { "Cache-Control": "no-store" } });
      }
      return NextResponse.json(parsed.data, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return NextResponse.json({ error: unavailable }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  }
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
  if (body.action === "revalue" && process.env.GO_ACCOUNTING_FX_REVALUATION_WRITE === "1") {
    try {
      return await revalueForeignReceivablesWithGo(ctx, resolved, body.year, body.month);
    } catch {
      return NextResponse.json({ error: fxRateUnavailableMessage }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  }
  if (process.env.GO_ACCOUNTING_PERIOD_CLOSE_WRITES === "1") {
    if (body.action === "checklist" && body.taskKey !== undefined && body.completed !== undefined) {
      return dispatchGoCapabilityRoute({ actionContext: ctx, session: resolved, capabilityId: "accounting.updatePeriodCloseCheck", input: { year: body.year, month: body.month, taskKey: body.taskKey, completed: body.completed, note: body.note } }, "accounting service unavailable; check period close status before retrying");
    }
    if (body.action === "close") {
      return dispatchGoCapabilityRoute({ actionContext: ctx, session: resolved, capabilityId: "accounting.closePeriod", input: { year: body.year, month: body.month } }, "accounting service unavailable; check period close status before retrying");
    }
    if (body.action === "reopen") {
      return dispatchGoCapabilityRoute({ actionContext: ctx, session: resolved, capabilityId: "accounting.reopenPeriod", input: { year: body.year, month: body.month } }, "accounting service unavailable; check period close status before retrying");
    }
  }
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
