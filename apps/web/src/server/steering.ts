/**
 * Mid-run steering (opencode-style): messages typed while the agent is
 * working are held here and drained by the running loop between model
 * steps, so a user can redirect an in-flight run without waiting for it to
 * finish. Process-local by design: Next.js route handlers share this module
 * scope in a single dev/prod server process, and steering is a
 * conversational affordance, not a durable record (the drained messages are
 * persisted into the session trajectory at injection time).
 */
const queues = new Map<string, string[]>();

export function pushSteering(sessionId: string, text: string): void {
  const list = queues.get(sessionId) ?? [];
  list.push(text);
  queues.set(sessionId, list);
}

export function drainSteering(sessionId: string): string[] {
  const list = queues.get(sessionId);
  queues.delete(sessionId);
  return list ?? [];
}

/** Anything still queued when a run ends is dropped; show the count first. */
export function peekSteering(sessionId: string): string[] {
  return queues.get(sessionId) ?? [];
}
