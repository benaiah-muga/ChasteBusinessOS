import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { agentSessions, getDb } from "@chaste/db";
import { hasPermission } from "@chaste/kernel";
import { getResolvedUser } from "@/server/session";

/**
 * One visibility predicate for session lists and details (N01/N07): people
 * see their own sessions; org admins (iam.admin) may audit everyone's.
 * Titles alone reveal who asked what - the detail route's rule applies here
 * too.
 */
export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const isAdmin = hasPermission({ permissions: resolved.permissions }, "iam.admin");
  const rows = await getDb()
    .db.select({
      id: agentSessions.id,
      userId: agentSessions.userId,
      title: agentSessions.title,
      mode: agentSessions.mode,
      status: agentSessions.status,
      modelRef: agentSessions.modelRef,
      createdAt: agentSessions.createdAt,
    })
    .from(agentSessions)
    .where(
      isAdmin
        ? eq(agentSessions.orgId, resolved.orgId)
        : and(eq(agentSessions.orgId, resolved.orgId), eq(agentSessions.userId, resolved.userId)),
    )
    .orderBy(desc(agentSessions.createdAt))
    .limit(50);
  return NextResponse.json({
    sessions: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
  });
}
