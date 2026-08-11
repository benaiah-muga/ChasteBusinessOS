import { describe, expect, it, vi } from "vitest";
import { createRateLimiter, rateLimitedPayload } from "./rate-limit.js";

describe("createRateLimiter (F6 — fixed-window per key)", () => {
  it("allows up to `max` calls within a window then rejects", () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 3 });
    expect(rl.check("ip:1.2.3.4").ok).toBe(true);
    expect(rl.check("ip:1.2.3.4").ok).toBe(true);
    expect(rl.check("ip:1.2.3.4").ok).toBe(true);
    const fourth = rl.check("ip:1.2.3.4");
    expect(fourth.ok).toBe(false);
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
  });

  it("tracks keys independently", () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 1 });
    expect(rl.check("ip:a").ok).toBe(true);
    expect(rl.check("ip:a").ok).toBe(false);
    expect(rl.check("ip:b").ok).toBe(true);
  });

  it("resets after the window elapses", () => {
    vi.useFakeTimers();
    try {
      const rl = createRateLimiter({ windowMs: 1000, max: 1 });
      expect(rl.check("k").ok).toBe(true);
      expect(rl.check("k").ok).toBe(false);
      vi.advanceTimersByTime(1001);
      expect(rl.check("k").ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prunes stale keys so the map does not grow unboundedly", () => {
    vi.useFakeTimers();
    try {
      const rl = createRateLimiter({ windowMs: 500, max: 5 });
      rl.check("a");
      rl.check("b");
      expect(rl.size).toBe(2);
      vi.advanceTimersByTime(501);
      rl.check("c"); // triggers the lazy prune sweep
      expect(rl.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid construction", () => {
    expect(() => createRateLimiter({ windowMs: 0, max: 1 })).toThrow();
    expect(() => createRateLimiter({ windowMs: 1000, max: 0 })).toThrow();
  });
});

describe("rateLimitedPayload", () => {
  it("builds a 429 payload with a retry-after header value", () => {
    const p = rateLimitedPayload(1500);
    expect(p).toMatchObject({ statusCode: 429, code: "RATE_LIMITED", retryAfterSeconds: 2 });
  });
});
