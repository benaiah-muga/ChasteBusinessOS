import { NextResponse } from "next/server";
import { and, desc, eq, or } from "drizzle-orm";
import { agentRuns, agentSessions, getDb } from "@chaste/db";
import { hasPermission } from "@chaste/kernel";
import { getResolvedUser } from "@/server/session";

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const isAdmin = hasPermission({ permissions: resolved.permissions }, "iam.admin");
  const rows = await getDb()
    .db.select({
      id: agentRuns.id,
      sessionId: agentRuns.sessionId,
      goal: agentRuns.goal,
      status: agentRuns.status,
      currentStep: agentRuns.currentStep,
      modelRef: agentRuns.modelRef,
      harnessProfileId: agentRuns.harnessProfileId,
      harnessProfileVersion: agentRuns.harnessProfileVersion,
      harnessCompositionDigest: agentRuns.harnessCompositionDigest,
      lastError: agentRuns.lastError,
      createdAt: agentRuns.createdAt,
      updatedAt: agentRuns.updatedAt,
      startedAt: agentRuns.startedAt,
      finishedAt: agentRuns.finishedAt,
    })
    .from(agentRuns)
    .leftJoin(agentSessions, eq(agentRuns.sessionId, agentSessions.id))
    .where(
      isAdmin
        ? eq(agentRuns.orgId, resolved.orgId)
        : and(
            eq(agentRuns.orgId, resolved.orgId),
            or(eq(agentRuns.initiatedByActorId, resolved.userId), eq(agentSessions.userId, resolved.userId)),
          ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(50);

  return NextResponse.json({
    runs: rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
    })),
  });
}
