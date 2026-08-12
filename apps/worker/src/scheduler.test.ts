/**
 * ARCH-9/REL-2 — schedule driver unit tests (no Redis required for the pure
 * parts). `enqueueDue` is tested with fakes; `detectRedis` is only probed when
 * REDIS_URL is present so CI without Redis still passes.
 */
import { describe, expect, it } from "vitest";
import { detectRedis, enqueueDue, type DueEnqueuer, type DueScanner } from "./scheduler.js";

const scanner: DueScanner = {
  async listDueReminders() {
    return [
      { id: "r-1", fireAt: new Date("2026-01-01T00:05:00Z") },
      { id: "r-2", fireAt: new Date("2026-01-01T00:02:00Z") },
    ];
  },
  async listDueFollowUps() {
    return [{ id: "f-1", fireAt: new Date("2026-01-01T00:03:00Z") }];
  },
};

describe("enqueueDue", () => {
  it("enqueues every due item with the exact remaining delay", async () => {
    const jobs: { kind: "reminder" | "followup"; id: string; delayMs: number }[] = [];
    const enqueuer: DueEnqueuer = {
      async enqueue(kind, id, delayMs) {
        jobs.push({ kind, id, delayMs });
      },
    };
    const now = new Date("2026-01-01T00:00:00Z");

    const counts = await enqueueDue(scanner, enqueuer, now);

    expect(counts).toEqual({ reminders: 2, followUps: 1 });
    expect(jobs).toEqual([
      { kind: "reminder", id: "r-1", delayMs: 300_000 },
      { kind: "reminder", id: "r-2", delayMs: 120_000 },
      { kind: "followup", id: "f-1", delayMs: 180_000 },
    ]);
  });

  it("enqueues already-due items with zero delay", async () => {
    const jobs: { kind: string; id: string; delayMs: number }[] = [];
    const enqueuer: DueEnqueuer = {
      async enqueue(kind, id, delayMs) {
        jobs.push({ kind, id, delayMs });
      },
    };
    const now = new Date("2026-01-02T00:00:00Z");
    await enqueueDue(scanner, enqueuer, now);
    expect(jobs.every((j) => j.delayMs === 0)).toBe(true);
  });

  it("handles empty schedules", async () => {
    const enqueuer: DueEnqueuer = {
      async enqueue() {
        throw new Error("should not be called");
      },
    };
    const empty: DueScanner = {
      async listDueReminders() {
        return [];
      },
      async listDueFollowUps() {
        return [];
      },
    };
    const counts = await enqueueDue(empty, enqueuer, new Date());
    expect(counts).toEqual({ reminders: 0, followUps: 0 });
  });
});

describe("detectRedis", () => {
  it("returns false when no URL is configured", async () => {
    expect(await detectRedis(undefined)).toBe(false);
  });
});

const redisUrl = process.env.REDIS_URL;
const redisUp = redisUrl ? await detectRedis(redisUrl) : false;

describe.skipIf(!redisUp)("detectRedis against live REDIS_URL", () => {
  it("returns true when Redis is reachable", async () => {
    expect(await detectRedis(redisUrl!)).toBe(true);
  });
});
