import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb, policies } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry, hasPermissionFor } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
/**
 * The org's blanket autonomy policy (ADR 0055). Reading is open to members;
 * writing is the governed iam.setOrgPolicy capability (identity-class), so
 * a human admin applies changes directly and the workmate's proposals land
 * in the Approvals inbox.
 */
export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const [row] = await getDb()
    .db.select()
    .from(policies)
    .where(and(eq(policies.orgId, resolved.orgId), eq(policies.capabilityPattern, "*")))
    .limit(1);
  return NextResponse.json({
    policy: {
      maxRiskAutonomous: row?.maxRiskAutonomous ?? "write",
      moneyThresholdMinor: row?.moneyThresholdMinor ?? 50_000,
      requiresApprovalFor: Array.isArray(row?.requiresApprovalFor) ? (row?.requiresApprovalFor as string[]) : [],
    },
    canEdit: hasPermissionFor({ permissions: resolved.permissions }, "iam.admin"),
  });
}

const bodySchema = z.object({
  maxRiskAutonomous: z.enum(["read", "write", "money", "identity", "destructive"]),
  moneyThresholdMinor: z.number().int().min(0).max(1_000_000_000).optional(),
  requiresApprovalFor: z.array(z.enum(["identity", "destructive", "money", "*"])).max(4).default([]),
  intentId: z.string().optional(),
});

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const db = getDb().db;
  const ctx = actorFromResolved(resolved, { intentId: parsed.data.intentId });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  const executor = buildExecutor(db, buildRegistry(db));
  const result = await executor.execute("iam.setOrgPolicy", ctx, {
    maxRiskAutonomous: parsed.data.maxRiskAutonomous,
    ...(parsed.data.moneyThresholdMinor !== undefined ? { moneyThresholdMinor: parsed.data.moneyThresholdMinor } : {}),
    requiresApprovalFor: parsed.data.requiresApprovalFor,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  if (result.pendingApproval) {
    return NextResponse.json(
      { pendingApproval: true, hint: "Policy changes proposed by the workmate wait for approval in the Approvals inbox." },
      { status: 202 },
    );
  }
  return NextResponse.json({ ok: true, data: result.data });
}
