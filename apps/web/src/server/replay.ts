import { and, asc, count, eq, sql } from "drizzle-orm";
import { agentSessions, sessionEvents, type Database } from "@chaste/db";
import { replayTrajectory, type ReplayTrace } from "@chaste/kernel";
import { sessionEventMetricsExceedBounds, sessionResponseExceedsBounds } from "./response-limits";

export class SessionResponseLimitError extends Error {
  constructor() {
    super("session trajectory exceeds the response limit");
    this.name = "SessionResponseLimitError";
  }
}

export async function sessionEventPayloadExceedsBounds(db: Database["db"], sessionId: string): Promise<boolean> {
  const [metrics] = await db
    .select({
      eventCount: count(),
      maxEventBytes: sql<number>`COALESCE(max(octet_length(${sessionEvents.content}::text)), 0)`,
      totalEventBytes: sql<number>`COALESCE(sum(octet_length(${sessionEvents.content}::text)), 0)`,
    })
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, sessionId));
  return sessionEventMetricsExceedBounds(
    Number(metrics?.eventCount ?? 0),
    Number(metrics?.maxEventBytes ?? 0),
    Number(metrics?.totalEventBytes ?? 0),
  );
}

export async function replaySession(
  db: Database["db"],
  orgId: string,
  sessionId: string,
): Promise<ReplayTrace | null> {
  const [session] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.orgId, orgId)))
    .limit(1);
  if (!session) return null;
  if (await sessionEventPayloadExceedsBounds(db, sessionId)) throw new SessionResponseLimitError();
  const events = await db
    .select({
      seq: sessionEvents.seq,
      role: sessionEvents.role,
      content: sessionEvents.content,
    })
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, sessionId))
    .orderBy(asc(sessionEvents.seq))
    .limit(10_001);
  const trace = replayTrajectory(events.map(({ seq, role, content }) => ({ seq, role, content })));
  if (sessionResponseExceedsBounds({ trace })) throw new SessionResponseLimitError();
  return trace;
}
