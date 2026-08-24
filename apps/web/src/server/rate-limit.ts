/**
 * Dependency-free fixed-window rate limiter for boundaries better-auth does
 * not cover (LLM spend, token-bearing endpoints). Keyed per instance: with
 * multiple replicas each keeps its own window, so limits are a floor not a
 * ceiling. Expensive endpoints must never depend on this alone for cost
 * control; it exists to blunt abuse bursts.
 */
export interface RateLimitOptions {
  /** Allowed hits per window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until the window frees a slot; 0 when allowed. */
  retryAfterSec: number;
  remaining: number;
}

interface WindowState {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, WindowState>();
const MAX_TRACKED_KEYS = 50_000;

/**
 * Records one hit and reports whether the caller may proceed. Fixed windows
 * trade a small burst factor at boundaries for O(1) memory and no timers.
 */
export function checkRateLimit(key: string, opts: RateLimitOptions): RateLimitVerdict {
  const nowMs = (opts.now ?? Date.now)();
  let state = buckets.get(key);
  if (!state || state.resetAt <= nowMs) {
    // Sweep occasionally so abandoned keys cannot grow the map unbounded
    // behind attacker-chosen high-cardinality key material.
    if (buckets.size > MAX_TRACKED_KEYS) {
      for (const [k, s] of buckets) {
        if (s.resetAt <= nowMs) buckets.delete(k);
        if (buckets.size <= MAX_TRACKED_KEYS / 2) break;
      }
    }
    state = { count: 0, resetAt: nowMs + opts.windowMs };
    buckets.set(key, state);
  }
  state.count += 1;
  if (state.count > opts.max) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((state.resetAt - nowMs) / 1000)),
      remaining: 0,
    };
  }
  return { allowed: true, retryAfterSec: 0, remaining: opts.max - state.count };
}

/** Intended call budget for agent turns per user per minute. */
export function chatLimitForUser(userId: string): RateLimitVerdict {
  const max = Number(process.env.CHAT_RATE_LIMIT_MAX ?? 12);
  return checkRateLimit(`chat:${userId}`, { max, windowMs: 60_000 });
}

/** Invitation-accept attempts per IP+token prefix; blunts token grinding. */
export function inviteAttemptLimit(ip: string): RateLimitVerdict {
  return checkRateLimit(`invite:${ip}`, { max: 30, windowMs: 60_000 });
}

/** SCIM bearer authentication attempts per source IP. */
export function scimAuthLimit(ip: string): RateLimitVerdict {
  return checkRateLimit(`scim:${ip}`, { max: 60, windowMs: 60_000 });
}

/** Best-effort client IP from proxy headers, falling back to "unknown". */
export function requestIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
