import { describe, expect, it } from "vitest";
import { describeSchedule, MIN_INTERVAL_MINUTES, nextRoutineRun, parseScheduleText } from "./routines";

describe("parseScheduleText", () => {
  it("parses interval schedules", () => {
    expect(parseScheduleText("every 30 minutes")).toMatchObject({
      ok: true,
      schedule: { kind: "interval", everyMinutes: 30 },
    });
    expect(parseScheduleText("Every 2 hours")).toMatchObject({
      ok: true,
      schedule: { kind: "interval", everyMinutes: 120 },
    });
    expect(parseScheduleText("hourly")).toMatchObject({ ok: true, schedule: { kind: "interval", everyMinutes: 60 } });
    expect(parseScheduleText("every half hour")).toMatchObject({
      ok: true,
      schedule: { kind: "interval", everyMinutes: 30 },
    });
  });

  it("rejects intervals below the 5-minute floor", () => {
    expect(parseScheduleText(`every ${MIN_INTERVAL_MINUTES - 1} minutes`).ok).toBe(false);
    expect(parseScheduleText("every 20000 minutes").ok).toBe(false);
  });

  it("parses daily and weekday schedules with 12h or 24h times", () => {
    expect(parseScheduleText("daily at 08:00")).toMatchObject({
      ok: true,
      schedule: { kind: "daily", atTime: "08:00" },
    });
    expect(parseScheduleText("every day at 9pm")).toMatchObject({
      ok: true,
      schedule: { kind: "daily", atTime: "21:00" },
    });
    expect(parseScheduleText("at 7:30am daily")).toMatchObject({
      ok: true,
      schedule: { kind: "daily", atTime: "07:30" },
    });
    expect(parseScheduleText("weekdays at 9am")).toMatchObject({
      ok: true,
      schedule: { kind: "weekdays", atTime: "09:00" },
    });
  });

  it("parses weekly schedules by day name", () => {
    expect(parseScheduleText("weekly on monday at 09:00")).toMatchObject({
      ok: true,
      schedule: { kind: "weekly", atTime: "09:00", dayOfWeek: 1 },
    });
    expect(parseScheduleText("every friday at 5pm")).toMatchObject({
      ok: true,
      schedule: { kind: "weekly", atTime: "17:00", dayOfWeek: 5 },
    });
    expect(parseScheduleText("mondays at 9am")).toMatchObject({
      ok: true,
      schedule: { kind: "weekly", atTime: "09:00", dayOfWeek: 1 },
    });
  });

  it("rejects gibberish rather than guessing", () => {
    expect(parseScheduleText("whenever I feel like it").ok).toBe(false);
    expect(parseScheduleText("daily at 25:00").ok).toBe(false);
    expect(parseScheduleText("weekly on someday at 9am").ok).toBe(false);
    expect(parseScheduleText("").ok).toBe(false);
  });

  it("normalizes to a human description", () => {
    const every30 = parseScheduleText("every 30 minutes");
    expect(every30.ok && every30.normalized).toBe("Every 30 minutes");
    const weekdays = parseScheduleText("weekdays at 9am");
    expect(weekdays.ok && weekdays.normalized).toBe("Weekdays at 09:00");
    const weekly = parseScheduleText("weekly on monday at 09:00");
    expect(weekly.ok && weekly.normalized).toBe("Weekly on Monday at 09:00");
  });
});

describe("nextRoutineRun", () => {
  const from = new Date(2026, 7, 29, 10, 0, 0); // Sat Aug 29 2026, 10:00 local

  it("intervals add strictly future minutes", () => {
    expect(nextRoutineRun({ kind: "interval", everyMinutes: 30 }, from)).toEqual(new Date(2026, 7, 29, 10, 30));
  });

  it("daily returns today when the time is still ahead", () => {
    expect(nextRoutineRun({ kind: "daily", atTime: "08:00" }, from)).toEqual(new Date(2026, 7, 30, 8, 0));
    expect(nextRoutineRun({ kind: "daily", atTime: "11:00" }, from)).toEqual(new Date(2026, 7, 29, 11, 0));
  });

  it("weekdays skips the weekend", () => {
    // Sat 10:00 -> Mon 09:00
    expect(nextRoutineRun({ kind: "weekdays", atTime: "09:00" }, from)).toEqual(new Date(2026, 7, 31, 9, 0));
  });

  it("weekly lands on the next matching day", () => {
    // Sat -> next Monday 09:00
    expect(nextRoutineRun({ kind: "weekly", atTime: "09:00", dayOfWeek: 1 }, from)).toEqual(
      new Date(2026, 7, 31, 9, 0),
    );
    // Sat at 12:00 -> today
    expect(nextRoutineRun({ kind: "weekly", atTime: "12:00", dayOfWeek: 6 }, from)).toEqual(
      new Date(2026, 7, 29, 12, 0),
    );
  });

  it("never returns a past or identical instant", () => {
    const schedule: Parameters<typeof nextRoutineRun>[0] = { kind: "daily", atTime: "10:00" };
    const next = nextRoutineRun(schedule, from);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });
});

describe("describeSchedule", () => {
  it("renders every kind", () => {
    expect(describeSchedule({ kind: "interval", everyMinutes: 60 })).toBe("Hourly");
    expect(describeSchedule({ kind: "interval", everyMinutes: 90 })).toBe("Every 90 minutes");
    expect(describeSchedule({ kind: "interval", everyMinutes: 120 })).toBe("Every 2 hours");
    expect(describeSchedule({ kind: "daily", atTime: "08:00" })).toBe("Daily at 08:00");
    expect(describeSchedule({ kind: "weekdays", atTime: "09:00" })).toBe("Weekdays at 09:00");
    expect(describeSchedule({ kind: "weekly", atTime: "09:00", dayOfWeek: 1 })).toBe("Weekly on Monday at 09:00");
  });
});
