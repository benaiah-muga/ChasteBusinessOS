import { describe, expect, it } from "vitest";
import { checkRateLimit } from "./rate-limit";

/**
 * Pure fixed-window semantics: allow up to max per window, refuse with a
 * retry hint beyond it, and free all slots when the window elapses. The
 * limiter guards LLM spend and token-bearing endpoints, so both the allow
 * and the block path are contract, not implementation detail.
 */

function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe("checkRateLimit", () => {
  it("allows up to max hits within one window", () => {
    const clock = fakeClock();
    const key = `k:${crypto.randomUUID()}`;
    for (let i = 0; i < 3; i += 1) {
      const v = checkRateLimit(key, { max: 3, windowMs: 60_000, now: clock.now });
      expect(v.allowed).toBe(true);
    }
    expect(checkRateLimit(key, { max: 3, windowMs: 60_000, now: clock.now })).toMatchObject({
      allowed: false,
      remaining: 0,
    });
  });

  it("reports a positive retry-after when blocked", () => {
    const clock = fakeClock();
    const key = `k:${crypto.randomUUID()}`;
    for (let i = 0; i < 5; i += 1) {
      checkRateLimit(key, { max: 5, windowMs: 30_000, now: clock.now });
    }
    const blocked = checkRateLimit(key, { max: 5, windowMs: 30_000, now: clock.now });
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(30);
  });

  it("frees every slot once the window elapses", () => {
    const clock = fakeClock();
    const key = `k:${crypto.randomUUID()}`;
    for (let i = 0; i < 4; i += 1) {
      checkRateLimit(key, { max: 4, windowMs: 10_000, now: clock.now });
    }
    expect(checkRateLimit(key, { max: 4, windowMs: 10_000, now: clock.now }).allowed).toBe(false);
    clock.advance(10_001);
    const v = checkRateLimit(key, { max: 4, windowMs: 10_000, now: clock.now });
    expect(v.allowed).toBe(true);
    expect(v.remaining).toBe(3);
  });

  it("keys are isolated", () => {
    const clock = fakeClock();
    const a = `a:${crypto.randomUUID()}`;
    const b = `b:${crypto.randomUUID()}`;
    for (let i = 0; i < 2; i += 1) checkRateLimit(a, { max: 2, windowMs: 60_000, now: clock.now });
    expect(checkRateLimit(a, { max: 2, windowMs: 60_000, now: clock.now }).allowed).toBe(false);
    expect(checkRateLimit(b, { max: 2, windowMs: 60_000, now: clock.now }).allowed).toBe(true);
  });
});
