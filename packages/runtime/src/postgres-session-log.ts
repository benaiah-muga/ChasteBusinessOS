/**
 * Postgres-backed `SessionLog` over the `agent_session_events` table.
 *
 * ADR 0014 — the durable counterpart to `InMemorySessionLog`. The stream is
 * append-only and shared across processes (API + worker), so a trajectory
 * written while a session is served by one process remains replayable,
 * reconstructable, and auditable from any host.
 */
import { asc, eq } from "drizzle-orm";
import { schema, type Db } from "@chaste/db";
const { agentSessionEvents } = schema;
import type { AgentSessionEvent, SessionLog } from "@chaste/ai-core";

export class PostgresSessionLog implements SessionLog {
  constructor(private readonly db: Db) {}

  async append(event: AgentSessionEvent): Promise<AgentSessionEvent> {
    await this.db.insert(agentSessionEvents).values({
      id: event.id,
      sessionId: event.sessionId,
      organizationId: event.organizationId,
      type: event.type,
      at: new Date(event.at),
      payload: event.payload as object,
    });
    return event;
  }

  async list(sessionId: string): Promise<AgentSessionEvent[]> {
    const rows = await this.db
      .select()
      .from(agentSessionEvents)
      .where(eq(agentSessionEvents.sessionId, sessionId))
      .orderBy(asc(agentSessionEvents.seq));
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      organizationId: r.organizationId,
      type: r.type as AgentSessionEvent["type"],
      at: r.at.toISOString(),
      payload: r.payload as unknown,
    }));
  }

  async listSessions(organizationId: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ sessionId: agentSessionEvents.sessionId })
      .from(agentSessionEvents)
      .where(eq(agentSessionEvents.organizationId, organizationId));
    return rows.map((r) => r.sessionId);
  }
}
