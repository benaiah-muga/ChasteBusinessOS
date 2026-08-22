import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { agentSessions, getDb, sessionEvents } from "@chaste/db";
import { getResolvedUser } from "@/server/session";

type Params = { params: Promise<{ id: string }> };

/** Full trajectory replay: every event in the session, in order. */
export async function GET(_req: Request, { params }: Params) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const db = getDb().db;

  const [session] = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.id, id), eq(agentSessions.orgId, resolved.orgId)))
    .limit(1);
  if (!session) return NextResponse.json({ error: "not found" }, { status: 404 });

  const events = await db
    .select()
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, id))
    .orderBy(asc(sessionEvents.seq));

  return NextResponse.json({
    session: { ...session, createdAt: session.createdAt.toISOString(), updatedAt: session.updatedAt.toISOString() },
    events: events.map((e) => ({ seq: e.seq, role: e.role, content: e.content, at: e.createdAt.toISOString() })),
  });
}
