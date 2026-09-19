import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { agentSessions, getDb } from "@chaste/db";
import { hasPermission } from "@chaste/kernel";
import { getDurableRun } from "@/server/durable-runs";
import { getResolvedUser } from "@/server/session";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const detail = await getDurableRun(getDb().db, resolved.orgId, id);
  if (!detail) return NextResponse.json({ error: "not found" }, { status: 404 });

  const isAdmin = hasPermission({ permissions: resolved.permissions }, "iam.admin");
  if (!isAdmin) {
    const session = detail.run.sessionId
      ? await getDb().db
          .select({ userId: agentSessions.userId })
          .from(agentSessions)
          .where(and(eq(agentSessions.id, detail.run.sessionId), eq(agentSessions.orgId, resolved.orgId)))
          .limit(1)
      : [];
    const visible = detail.run.initiatedByActorId === resolved.userId || session[0]?.userId === resolved.userId;
    if (!visible) return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const serialize = (value: Date | null) => value?.toISOString() ?? null;
  return NextResponse.json({
    run: {
      ...detail.run,
      createdAt: detail.run.createdAt.toISOString(),
      updatedAt: detail.run.updatedAt.toISOString(),
      startedAt: serialize(detail.run.startedAt),
      finishedAt: serialize(detail.run.finishedAt),
    },
    steps: detail.steps.map((step) => ({
      ...step,
      createdAt: step.createdAt.toISOString(),
      startedAt: serialize(step.startedAt),
      finishedAt: serialize(step.finishedAt),
    })),
  });
}
