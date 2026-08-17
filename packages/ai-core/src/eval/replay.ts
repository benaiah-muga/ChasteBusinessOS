import type { ReconstructedModelRequest, AgentSessionEvent } from "../trajectory/index.js";
import { reconstructModelRequest, summarizeModelRequest } from "../trajectory/index.js";
import type { SessionLog } from "../trajectory/index.js";

/**
 * Replay tooling (research doc §Evaluation and Testing, build item 14).
 *
 * `replaySession` reloads a session's append-only stream and rebuilds the
 * model-visible request through the deterministic reconstruction invariant:
 * a model request is valid only if its system prompt, developer instructions,
 * user messages, tool schemas, retrieved evidence, memory reads, and injected
 * context can be reconstructed from durable events. The eval harness verifies
 * this invariant for every scenario's trajectory; a production incident is
 * convertible into a regression scenario by saving its session id and
 * replaying it here.
 */

export interface ReplayTrace {
  sessionId: string;
  /** Events read back from the durable log, in append order. */
  totalEvents: number;
  /** The deterministic model-visible reconstruction of the stream. */
  reconstructed: ReconstructedModelRequest;
  /** Named gaps that would prevent faithful reconstruction. */
  gaps: string[];
  /** True when the stream replays into a complete model-visible request. */
  complete: boolean;
}

/** Thrown by `assertReplayInvariant` when a session log cannot be replayed. */
export class ReplayInvariantViolation extends Error {
  constructor(public readonly trace: ReplayTrace) {
    super(
      `replay invariant violated for session ${trace.sessionId}: ${trace.gaps.join("; ") || "unknown"}`,
    );
    this.name = "ReplayInvariantViolation";
  }
}

/** Replay a session: same log, same reconstruction, every time. */
export async function replaySession(
  log: SessionLog,
  sessionId: string,
): Promise<ReplayTrace> {
  const events: AgentSessionEvent[] = await log.list(sessionId);
  const reconstructed = reconstructModelRequest(sessionId, events);
  return {
    sessionId,
    totalEvents: events.length,
    reconstructed,
    gaps: reconstructed.gaps,
    complete: reconstructed.complete,
  };
}

/** Fail closed when a session log violates the hard reconstruction invariant. */
export function assertReplayInvariant(trace: ReplayTrace): void {
  if (!trace.complete) throw new ReplayInvariantViolation(trace);
}

/** Human-facing summary of a replayed trajectory (audit/report projection). */
export function summarizeTrace(trace: ReplayTrace): string[] {
  return summarizeModelRequest(trace.reconstructed);
}