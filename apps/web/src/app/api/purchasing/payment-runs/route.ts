import { NextResponse } from "next/server";
import { z } from "zod";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { missingPermission } from "@/server/route-guards";
import { getDb } from "@chaste/db";
import { dispatchGoCapabilityRoute, goCapabilityUnavailable } from "@/server/go-route-response";

const paymentRunsOutputSchema = z.object({
  runs: z.array(z.object({
    id: z.string(),
    reference: z.string(),
    currency: z.string(),
    totalMinor: z.number().int().refine(Number.isSafeInteger),
    status: z.string(),
    createdAt: z.string(),
    instructedAt: z.string().nullable(),
    confirmedAt: z.string().nullable(),
    entryId: z.string().nullable(),
    lines: z.array(z.object({
      billId: z.string(),
      billNumber: z.number().int().refine(Number.isSafeInteger),
      vendorName: z.string(),
      vendorRef: z.string().nullable(),
      amountMinor: z.number().int().refine(Number.isSafeInteger),
    })),
  })),
});

async function dispatchPaymentRunsRead(ctx: NonNullable<ReturnType<typeof actorFromResolved>>, session: NonNullable<Awaited<ReturnType<typeof getResolvedUser>>>) {
  const unavailableMessage = "purchasing service unavailable; check payment run status before retrying";
  const response = await dispatchGoCapabilityRoute({ actionContext: ctx, session, capabilityId: "purchasing.listPaymentRuns", input: {} }, unavailableMessage);
  if (response.status !== 200) return response;

  const parsed = z.object({ ok: z.literal(true), data: paymentRunsOutputSchema }).safeParse(await response.clone().json().catch(() => null));
  if (!parsed.success) return goCapabilityUnavailable(unavailableMessage);
  return NextResponse.json(parsed.data, { status: 200, headers: { "Cache-Control": "no-store" } });
}

function respond(result: { ok: boolean; data?: unknown; error?: string; pendingApproval?: unknown }) {
  if (result.pendingApproval) return NextResponse.json({ ok: false, pendingApproval: true, reason: result.error }, { status: 202 });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const denied = missingPermission(resolved, "purchasing.read");
  if (denied) return denied;
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  if (process.env.GO_PURCHASING_PAYMENT_RUN_READS === "1" || process.env.GO_PURCHASING_PAYMENT_RUN_WRITES === "1") {
    return dispatchPaymentRunsRead(ctx, resolved);
  }
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));
  return respond(await executor.execute("purchasing.listPaymentRuns", ctx, {}));
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const bodySchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("create"), intentId: z.string().optional(), memo: z.string().max(500).optional(), lines: z.array(z.object({ billId: z.string().uuid(), amountMinor: z.number().int().positive() })).min(1).max(100) }),
    z.object({ action: z.literal("instruct"), intentId: z.string().optional(), paymentRunId: z.string().uuid() }),
    z.object({ action: z.literal("cancel"), intentId: z.string().optional(), paymentRunId: z.string().uuid() }),
    z.object({ action: z.literal("reverse"), intentId: z.string().optional(), paymentRunId: z.string().uuid(), reason: z.string().min(3).max(500) }),
  ]);
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const body = parsed.data;
  const requiredPermission = body.action === "instruct" || body.action === "reverse" ? "purchasing.post"
    : body.action === "cancel" ? "purchasing.write"
    : "purchasing.write";
  const denied = missingPermission(resolved, requiredPermission);
  if (denied) return denied;
  const ctx = actorFromResolved(resolved, { intentId: body.intentId });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  if (process.env.GO_PURCHASING_PAYMENT_RUN_WRITES === "1") {
    if (body.action === "create") {
      return dispatchGoCapabilityRoute({ actionContext: ctx, session: resolved, capabilityId: "purchasing.createPaymentRun", input: { memo: body.memo, lines: body.lines } }, "purchasing service unavailable; check payment run status before retrying");
    }
    if (body.action === "instruct") {
      return dispatchGoCapabilityRoute({ actionContext: ctx, session: resolved, capabilityId: "purchasing.instructPaymentRun", input: { paymentRunId: body.paymentRunId } }, "purchasing service unavailable; check payment run status before retrying");
    }
    if (body.action === "cancel") {
      return dispatchGoCapabilityRoute({ actionContext: ctx, session: resolved, capabilityId: "purchasing.cancelPaymentRunDraft", input: { paymentRunId: body.paymentRunId } }, "purchasing service unavailable; check payment run status before retrying");
    }
    if (body.action === "reverse") {
      return dispatchGoCapabilityRoute({ actionContext: ctx, session: resolved, capabilityId: "purchasing.reversePaymentRun", input: { paymentRunId: body.paymentRunId, reason: body.reason } }, "purchasing service unavailable; check payment run status before retrying");
    }
  }
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));
  if (body.action === "create") {
    return respond(await executor.execute("purchasing.createPaymentRun", ctx, {
      memo: body.memo,
      lines: body.lines,
    }));
  }
  if (body.action === "instruct") {
    return respond(await executor.execute("purchasing.instructPaymentRun", ctx, { paymentRunId: body.paymentRunId }));
  }
  if (body.action === "cancel") {
    return respond(await executor.execute("purchasing.cancelPaymentRunDraft", ctx, { paymentRunId: body.paymentRunId }));
  }
  if (body.action === "reverse") {
    return respond(await executor.execute("purchasing.reversePaymentRun", ctx, { paymentRunId: body.paymentRunId, reason: body.reason }));
  }
  return NextResponse.json({ error: "unsupported payment run action" }, { status: 400 });
}
