import { and, eq, sql } from "drizzle-orm";
import { agentSessions, type Database, withOrgContext } from "@chaste/db";
import { logger } from "@chaste/kernel";

/**
 * Appends one trajectory event in its tenant scope. Locking the parent session
 * row serializes sequence allocation across TypeScript and Go writers.
 */
export async function appendSessionEvent(
  db: Database["db"],
  orgId: string,
  sessionId: string,
  role: string,
  content: object,
): Promise<void> {
  try {
    await withOrgContext(db, orgId, async (tx) => {
      const [session] = await tx
        .select({ id: agentSessions.id })
        .from(agentSessions)
        .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.orgId, orgId)))
        .for("update")
        .limit(1);
      if (!session) throw new Error("agent session not found for organization");
      await tx.execute(sql`
        INSERT INTO session_events (session_id, seq, role, content)
        SELECT ${sessionId}, COALESCE(MAX(seq), 0) + 1, ${role}, ${JSON.stringify(content)}::jsonb
        FROM session_events WHERE session_id = ${sessionId}
      `);
    });
  } catch (err) {
    // Trajectory gaps break replay and audit; never swallow this quietly.
    logger.error("failed to persist session event", {
      sessionId,
      orgId,
      role,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Atomically accumulates token usage on the session row. The previous
 * read-add-write lost updates whenever two turns ran concurrently.
 */
export async function addTokenUsage(
  db: Database["db"],
  orgId: string,
  sessionId: string,
  usage: { input: number; output: number; cachedInput?: number },
): Promise<void> {
  await withOrgContext(db, orgId, async (tx) => {
    await tx
      .update(agentSessions)
      .set({
        tokenUsage: sql`jsonb_build_object(
          'input', COALESCE((${agentSessions.tokenUsage} ->> 'input')::bigint, 0) + ${usage.input},
          'output', COALESCE((${agentSessions.tokenUsage} ->> 'output')::bigint, 0) + ${usage.output},
          'cachedInput', COALESCE((${agentSessions.tokenUsage} ->> 'cachedInput')::bigint, 0) + ${usage.cachedInput ?? 0}
        )`,
        updatedAt: new Date(),
      })
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.orgId, orgId)));
  });
}
