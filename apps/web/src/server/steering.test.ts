import { beforeEach, describe, expect, it } from "vitest";
import { drainSteering, peekSteering, pushSteering } from "./steering";

beforeEach(() => {
  drainSteering("test-session");
});

describe("steering queue", () => {
  it("preserves order and drains exactly once", () => {
    pushSteering("s", "focus on invoices");
    pushSteering("s", "ignore the July numbers");
    expect(peekSteering("s")).toEqual(["focus on invoices", "ignore the July numbers"]);
    expect(drainSteering("s")).toEqual(["focus on invoices", "ignore the July numbers"]);
    expect(drainSteering("s")).toEqual([]);
    expect(peekSteering("s")).toEqual([]);
  });

  it("keeps sessions isolated", () => {
    pushSteering("a", "for a");
    pushSteering("b", "for b");
    expect(drainSteering("a")).toEqual(["for a"]);
    expect(drainSteering("b")).toEqual(["for b"]);
  });

  it("draining an unknown session is empty, not a crash", () => {
    expect(drainSteering("never-pushed")).toEqual([]);
  });
});
