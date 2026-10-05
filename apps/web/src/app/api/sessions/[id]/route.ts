import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { agentSessions, getDb, sessionEvents } from "@chaste/db";
import { hasPermission } from "@chaste/kernel";
import { getResolvedUser } from "@/server/session";
import { sessionEventPayloadExceedsBounds } from "@/server/replay";
import { sessionResponseExceedsBounds } from "@/server/response-limits";

type Params = { params: Promise<{ id: string }> };

/**
 * Full trajectory replay: every event in the session, in order. Tool results
 * can carry data the viewer's own role would never authorize (payroll runs,
 * approvals payloads), so replay is limited to the session's owner; org
 * admins may audit their people's sessions.
 */
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

  const isOwner = session.userId === resolved.userId;
  const isAdmin = hasPermission({ permissions: resolved.permissions }, "iam.admin");
  if (!isOwner && !isAdmin) {
    // Existence of a colleague's session is not disclosed either way.
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (await sessionEventPayloadExceedsBounds(db, id)) {
    return NextResponse.json({ error: "session trajectory exceeds the response limit" }, { status: 413 });
  }
  const events = await db
    .select({
      seq: sessionEvents.seq,
      role: sessionEvents.role,
      content: sessionEvents.content,
      createdAt: sessionEvents.createdAt,
    })
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, id))
    .orderBy(asc(sessionEvents.seq))
    .limit(10_001);

  const response = {
    session: { ...session, createdAt: session.createdAt.toISOString(), updatedAt: session.updatedAt.toISOString() },
    events: events.map((e) => ({ seq: e.seq, role: e.role, content: e.content, at: e.createdAt.toISOString() })),
  };
  if (sessionResponseExceedsBounds(response)) {
    return NextResponse.json({ error: "session trajectory exceeds the response limit" }, { status: 413 });
  }
  return NextResponse.json(response);
}
