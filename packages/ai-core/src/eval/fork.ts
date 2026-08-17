import type { SessionLog } from "../trajectory/index.js";
import { sessionEvent } from "../trajectory/index.js";

/**
 * Fork tooling (research doc §Replay and Fork Are First-Class, build item 14).
 *
 * `forkSession` copies a session's append-only stream up to a 1-based boundary
 * into a brand-new session id, then appends `session/forked` and
 * `session/resumed` markers naming the source and boundary. Enterprise trust
 * improves when a trajectory can be forked *before* a decision and then
 * re-run against another model or policy version — the fork keeps the same
 * durable events (same `at` timeline) but gets a fresh, isolated identity and
 * a fresh decision surface.
 */

export interface ForkOptions {
  /** Identity of the new session. */
  newSessionId: string;
  /** 1-based position in the source stream to fork up to (matches db `seq`). */
  uptoSeq: number;
  organizationId: string;
  forkedByUserId: string;
  reason?: string;
  now?: () => Date;
}

export interface ForkResult {
  sessionId: string;
  sourceSessionId: string;
  uptoSeq: number;
  copied: number;
  forkedAt: string;
}

export async function forkSession(
  log: SessionLog,
  sourceSessionId: string,
  opts: ForkOptions,
): Promise<ForkResult> {
  const events = await log.list(sourceSessionId);
  if (events.length === 0) {
    throw new Error(`Cannot fork unknown or empty session: ${sourceSessionId}`);
  }
  if (opts.uptoSeq < 1 || opts.uptoSeq > events.length) {
    throw new RangeError(
      `Fork boundary ${opts.uptoSeq} is outside the ${events.length}-event stream`,
    );
  }

  const now = opts.now ?? (() => new Date());
  const forkedAt = now().toISOString();
  const head = events.slice(0, opts.uptoSeq);

  let copied = 0;
  for (const e of head) {
    await log.append({
      ...e,
      id: crypto.randomUUID(),
      sessionId: opts.newSessionId,
      organizationId: opts.organizationId,
    });
    copied += 1;
  }

  await log.append(
    sessionEvent(opts.newSessionId, opts.organizationId, "session/forked", {
      sourceSessionId,
      uptoSeq: opts.uptoSeq,
      reason: opts.reason,
      forkedByUserId: opts.forkedByUserId,
      forkedAt,
    }),
  );
  await log.append(
    sessionEvent(opts.newSessionId, opts.organizationId, "session/resumed", {
      sourceSessionId,
      uptoSeq: opts.uptoSeq,
      reason: opts.reason,
      forkedAt,
    }),
  );

  return {
    sessionId: opts.newSessionId,
    sourceSessionId,
    uptoSeq: opts.uptoSeq,
    copied,
    forkedAt,
  };
}