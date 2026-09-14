import { describe, expect, it } from "vitest";
import { routineScheduleSchema } from "./index";

describe("routineScheduleSchema", () => {
  it("requires the fields belonging to each schedule kind", () => {
    expect(routineScheduleSchema.safeParse({ kind: "interval" }).success).toBe(false);
    expect(routineScheduleSchema.safeParse({ kind: "weekly", atTime: "09:00" }).success).toBe(false);
    expect(routineScheduleSchema.safeParse({ kind: "daily", atTime: "09:00" }).success).toBe(true);
    expect(routineScheduleSchema.safeParse({ kind: "weekly", atTime: "09:00", dayOfWeek: 1 }).success).toBe(true);
  });

  it("rejects impossible times and intervals outside the safe cadence", () => {
    expect(routineScheduleSchema.safeParse({ kind: "daily", atTime: "99:99" }).success).toBe(false);
    expect(routineScheduleSchema.safeParse({ kind: "interval", everyMinutes: 4 }).success).toBe(false);
    expect(routineScheduleSchema.safeParse({ kind: "interval", everyMinutes: 5 }).success).toBe(true);
  });
});
