import { sql } from "drizzle-orm";
import { agentSessions, type Database } from "@chaste/db";
import { logger } from "@chaste/kernel";

/**
 * Appends one trajectory event with an atomically assigned per-session seq:
 * a single INSERT...SELECT computes MAX(seq)+1 and the (session_id, seq)
 * unique index backstops concurrent writers — a loser retries instead of
 * interleaving duplicate sequence numbers or silently dropping the event.
 */
export async function appendSessionEvent(
  db: Database["db"],
  sessionId: string,
  role: string,
  content: object,
): Promise<void> {
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await db.execute(sql`
        INSERT INTO session_events (session_id, seq, role, content)
        SELECT ${sessionId}, COALESCE(MAX(seq), 0) + 1, ${role}, ${JSON.stringify(content)}::jsonb
        FROM session_events WHERE session_id = ${sessionId}
      `);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < attempts && message.includes("session_event_seq_idx")) continue;
      // Trajectory gaps break replay and audit; never swallow this quietly.
      logger.error("failed to persist session event", { sessionId, role, error: message });
      return;
    }
  }
}

/**
 * Atomically accumulates token usage on the session row. The previous
 * read-add-write lost updates whenever two turns ran concurrently.
 */
export async function addTokenUsage(
  db: Database["db"],
  sessionId: string,
  usage: { input: number; output: number; cachedInput?: number },
): Promise<void> {
  await db
    .update(agentSessions)
    .set({
      tokenUsage: sql`jsonb_build_object(
        'input', COALESCE((${agentSessions.tokenUsage} ->> 'input')::bigint, 0) + ${usage.input},
        'output', COALESCE((${agentSessions.tokenUsage} ->> 'output')::bigint, 0) + ${usage.output},
        'cachedInput', COALESCE((${agentSessions.tokenUsage} ->> 'cachedInput')::bigint, 0) + ${usage.cachedInput ?? 0}
      )`,
      updatedAt: new Date(),
    })
    .where(sql`${agentSessions.id} = ${sessionId}`);
}
