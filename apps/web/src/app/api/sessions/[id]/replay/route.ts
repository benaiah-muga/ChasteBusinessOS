import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { agentSessions, getDb } from "@chaste/db";
import { hasPermission } from "@chaste/kernel";
import { replaySession } from "@/server/replay";
import { getResolvedUser } from "@/server/session";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const [session] = await getDb()
    .db.select({ id: agentSessions.id, userId: agentSessions.userId })
    .from(agentSessions)
    .where(and(eq(agentSessions.id, id), eq(agentSessions.orgId, resolved.orgId)))
    .limit(1);
  if (!session) return NextResponse.json({ error: "not found" }, { status: 404 });

  const isAdmin = hasPermission({ permissions: resolved.permissions }, "iam.admin");
  if (!isAdmin && session.userId !== resolved.userId) return NextResponse.json({ error: "not found" }, { status: 404 });
  const trace = await replaySession(getDb().db, resolved.orgId, id);
  if (!trace) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ trace });
}
