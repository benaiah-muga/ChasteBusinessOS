import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { agentSessions, getDb } from "@chaste/db";
import { getResolvedUser } from "@/server/session";

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rows = await getDb()
    .db.select({
      id: agentSessions.id,
      title: agentSessions.title,
      mode: agentSessions.mode,
      status: agentSessions.status,
      modelRef: agentSessions.modelRef,
      createdAt: agentSessions.createdAt,
    })
    .from(agentSessions)
    .where(eq(agentSessions.orgId, resolved.orgId))
    .orderBy(desc(agentSessions.createdAt))
    .limit(50);
  return NextResponse.json({
    sessions: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
  });
}
