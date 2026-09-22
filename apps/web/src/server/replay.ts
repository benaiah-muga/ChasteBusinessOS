import { and, asc, eq } from "drizzle-orm";
import { agentSessions, sessionEvents, type Database } from "@chaste/db";
import { replayTrajectory, type ReplayTrace } from "@chaste/kernel";

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
  const events = await db
    .select({ seq: sessionEvents.seq, role: sessionEvents.role, content: sessionEvents.content })
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, sessionId))
    .orderBy(asc(sessionEvents.seq));
  return replayTrajectory(events);
}
