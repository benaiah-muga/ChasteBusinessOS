/**
 * F6 — dependency-free fixed-window rate limiter.
 *
 * Chosen over `@fastify/rate-limit` to avoid a new external dependency for a
 * single-process, single-API-node topology (see ADR 0011 / 0012 for the
 * multi-node future: if the API ever scales horizontally this must move to a
 * shared store keyed by IP/user, e.g. Redis). Purely in-memory per server
 * instance; stale windows are pruned lazily.
 */

export interface RateLimitResult {
  ok: boolean;
  /** 0 when `ok`; otherwise milliseconds until the caller may retry. */
  retryAfterMs: number;
}

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
}

export interface RateLimiter {
  /** Record one attempt for `key` and report whether it is within budget. */
  check(key: string): RateLimitResult;
  /** Drop all state — used by tests and not part of the request path. */
  clear(): void;
  /** Number of tracked keys (test/observability aid). */
  readonly size: number;
}

interface WindowEntry {
  windowStart: number;
  count: number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  if (!options || !(options.windowMs > 0) || !(options.max > 0)) {
    throw new Error("createRateLimiter requires windowMs > 0 and max > 0");
  }
  const { windowMs, max } = options;
  const windows = new Map<string, WindowEntry>();
  let lastPrune = 0;

  const prune = (now: number): void => {
    if (now - lastPrune < windowMs) return; // low-frequency sweep, O(1) steady-state
    lastPrune = now;
    for (const [key, entry] of windows) {
      if (now - entry.windowStart >= windowMs) windows.delete(key);
    }
  };

  return {
    check(key: string): RateLimitResult {
      const now = Date.now();
      prune(now);
      const entry = windows.get(key);
      if (!entry || now - entry.windowStart >= windowMs) {
        windows.set(key, { windowStart: now, count: 1 });
        return { ok: true, retryAfterMs: 0 };
      }
      if (entry.count >= max) {
        return { ok: false, retryAfterMs: windowMs - (now - entry.windowStart) };
      }
      entry.count += 1;
      return { ok: true, retryAfterMs: 0 };
    },
    clear(): void {
      windows.clear();
    },
    get size(): number {
      return windows.size;
    },
  };
}

/** Shared 429 response for the API routes that enforce rate limits. */
export interface RateLimitedReply {
  statusCode: number;
  message: string;
  code: string;
  retryAfterSeconds: number;
}

export function rateLimitedPayload(retryAfterMs: number): RateLimitedReply {
  return {
    statusCode: 429,
    message: "Too many requests",
    code: "RATE_LIMITED",
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
  };
}
