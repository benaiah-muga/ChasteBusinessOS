import type { EvidenceRef, PolicyDecision } from "@chaste/kernel";

/**
 * Append-only agent trajectory log (research doc §Session and Trajectory Log).
 *
 * One stream of events per conversation/task. The stream is the audit spine for
 * agent activity: everything the model saw, called, was granted, and produced
 * is represented here, in order, so a session can be replayed, inspected,
 * forked, and evaluated.
 *
 * Hard invariant (doc §Session and Trajectory Log): a model request is valid
 * only if its system prompt, developer instructions, user messages, tool
 * schemas, retrieved evidence, memory reads, and injected context can be
 * reconstructed from durable events and versioned referenced artifacts.
 */

export const AGENT_SESSION_EVENT_TYPES = [
  "session/start",
  "user/message",
  "context/assembled",
  "prompt/rendered",
  "model/request",
  "model/chunk",
  "model/message",
  "plan/proposed",
  "tool/schema-presented",
  "tool/call",
  "policy/decision",
  "approval/requested",
  "approval/granted",
  "approval/rejected",
  "command/dispatched",
  "command/result",
  "query/dispatched",
  "query/result",
  "evidence/attached",
  "memory/read",
  "memory/write",
  "workflow/scheduled",
  "session/forked",
  "session/resumed",
  "session/end",
] as const;

export type AgentSessionEventType = (typeof AGENT_SESSION_EVENT_TYPES)[number];

export interface AgentSessionEventBase {
  id: string;
  sessionId: string;
  organizationId: string;
  type: AgentSessionEventType;
  at: string;
  payload: unknown;
}

/** Payloads for the reconstruction-critical event types. */
export interface ModelRequestPayload {
  modelRoute: string;
  provider: string;
  model: string;
  systemPromptSections: string[];
  messages: Array<{ role: string; content: string }>;
  toolSchemas: unknown[];
  evidenceRefs: EvidenceRef[];
  memoryReads: string[];
  contextBundleId?: string;
  tokenEstimate?: number;
}

export interface ContextAssembledPayload {
  bundleId: string;
  turn: number;
  sections: Array<{
    key: string;
    tier: number;
    purpose: string;
    source: string;
    tokenEstimate: number;
    visibility: "model" | "trace_only";
  }>;
}

export interface CommandDispatchedPayload {
  commandType: string;
  envelopeId: string;
  correlationId: string;
  causationId?: string;
  reason?: string;
}

export interface ToolCallPayload {
  tool: string;
  args: unknown;
  riskClass?: string;
}

export interface PolicyDecisionPayload extends PolicyDecision {
  envelopeId?: string;
}

/** A durable, append-only agent trajectory event. */
export type AgentSessionEvent = AgentSessionEventBase & {
  payload: unknown;
};

/**
 * Build a trajectory event with stable defaults. `at` defaults to now;
 * callers pass a fixed `now` in tests.
 */
export function sessionEvent(
  sessionId: string,
  organizationId: string,
  type: AgentSessionEventType,
  payload: unknown,
  opts: { now?: () => Date; id?: string } = {},
): AgentSessionEvent {
  return {
    id: opts.id ?? crypto.randomUUID(),
    sessionId,
    organizationId,
    type,
    at: (opts.now?.() ?? new Date()).toISOString(),
    payload,
  };
}

export interface SessionLog {
  /** Append an event to the session stream. The log is append-only. */
  append(event: AgentSessionEvent): Promise<AgentSessionEvent>;
  /** All events for a session in append order. */
  list(sessionId: string): Promise<AgentSessionEvent[]>;
  /** Session ids that have at least one event for an organization. */
  listSessions(organizationId: string): Promise<string[]>;
}

/** In-memory append-only session log (tests, dev, single-process hosts). */
export class InMemorySessionLog implements SessionLog {
  private readonly events: AgentSessionEvent[] = [];

  async append(event: AgentSessionEvent): Promise<AgentSessionEvent> {
    this.events.push(event);
    return event;
  }

  async list(sessionId: string): Promise<AgentSessionEvent[]> {
    return this.events.filter((e) => e.sessionId === sessionId);
  }

  async listSessions(organizationId: string): Promise<string[]> {
    const seen = new Set<string>();
    for (const e of this.events) {
      if (e.organizationId === organizationId) seen.add(e.sessionId);
    }
    return [...seen];
  }
}
