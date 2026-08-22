import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { approvals, getDb } from "@chaste/db";
import { ledgerEventFor } from "@chaste/kernel";
import { buildExecutor, buildRegistry } from "@/server/kernel";
import { actorFromResolved } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = getDb().db;
  const rows = await db
    .select()
    .from(approvals)
    .where(eq(approvals.orgId, resolved.orgId))
    .limit(100);
  return NextResponse.json({ approvals: rows.filter((r) => r.status === "pending") });
}

const decideSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  comment: z.string().max(2000).optional(),
});

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = decideSchema.safeParse(await req.json());
  const approvalId = new URL(req.url).searchParams.get("id");
  if (!body.success || !approvalId) return NextResponse.json({ error: "invalid request" }, { status: 400 });

  const db = getDb().db;
  const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1);
  if (!approval || approval.orgId !== resolved.orgId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (approval.status !== "pending") {
    return NextResponse.json({ error: `already ${approval.status}` }, { status: 409 });
  }

  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);

  if (body.data.decision === "reject") {
    await db
      .update(approvals)
      .set({
        status: "rejected",
        decidedByUserId: resolved.userId,
        decisionComment: body.data.comment ?? null,
        decidedAt: new Date(),
      })
      .where(eq(approvals.id, approval.id));
    const humanCtx = actorFromResolved(resolved, {});
    if (humanCtx) {
      const { PgLedgerStore } = await import("@/server/kernel");
      await new PgLedgerStore(db).append(
        ledgerEventFor(humanCtx, "approval.rejected", approval.capabilityId, { approvalId, comment: body.data.comment ?? null }),
      );
    }
    return NextResponse.json({ ok: true, status: "rejected" });
  }

  // Approver must hold the capability's own permission — authority can't be laundered.
  const cap = registry.get(approval.capabilityId);
  const humanCtx = actorFromResolved(resolved, {});
  if (!cap || !humanCtx) return NextResponse.json({ error: "unknown capability" }, { status: 400 });

  const result = await executor.execute(approval.capabilityId, humanCtx, approval.payload, {
    approvedApprovalId: approval.id,
  });
  if (!result.ok && !result.pendingApproval) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  }

  await db
    .update(approvals)
    .set({
      status: result.ok ? "executed" : "approved",
      decidedByUserId: resolved.userId,
      decisionComment: body.data.comment ?? null,
      decidedAt: new Date(),
    })
    .where(eq(approvals.id, approval.id));

  return NextResponse.json({ ok: true, result });
}
