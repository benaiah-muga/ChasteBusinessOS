/**
 * Routine scheduling math: pure functions, no IO, no model.
 *
 * A routine is a recurring agent run (Paperclip-style). Users type a
 * natural-language schedule ("every 30 minutes", "weekdays at 9am"); the
 * deterministic fallback parser below recognizes the common shapes and the
 * web layer may refine anything else with the model before persisting the
 * structured schedule. Execution cadence comes from the Postgres jobs
 * queue; nothing here touches a database.
 */

export interface RoutineSchedule {
  kind: "interval" | "daily" | "weekdays" | "weekly";
  /** interval only: minutes between runs. */
  everyMinutes?: number;
  /** daily/weekdays/weekly: local time "HH:MM" (24h). */
  atTime?: string;
  /** weekly only: 0=Sunday .. 6=Saturday. */
  dayOfWeek?: number;
}

export type ParsedSchedule =
  | { ok: true; schedule: RoutineSchedule; normalized: string }
  | { ok: false };

export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 10_080; // one week

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function parseTime(hhmm: string): string | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(hhmm.trim());
  if (!m) return null;
  let hours = Number(m[1]);
  const minutes = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3]?.toLowerCase();
  if (meridiem === "pm" && hours < 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function dayFromName(word: string): number | null {
  const idx = DAY_NAMES.findIndex((d) => d.startsWith(word.toLowerCase()));
  return idx >= 0 && word.length >= 3 ? idx : null;
}

/**
 * Recognizes common natural-language schedules. Returns ok:false for
 * anything it cannot parse confidently; callers may then ask the model to
 * structure the text or reject the input.
 */
export function parseScheduleText(raw: string): ParsedSchedule {
  const text = raw.trim().toLowerCase();
  if (!text) return { ok: false };

  // "every N minutes/hours", "hourly", "every half/quarter hour"
  let minutes: number | null = null;
  const interval = /^every\s+(\d+)\s*(min(?:ute)?s?|hours?|h)\b/.exec(text);
  if (interval) {
    const n = Number(interval[1]);
    minutes = interval[2]!.startsWith("h") ? n * 60 : n;
  } else if (/^every\s+half\s+hour$/.test(text)) {
    minutes = 30;
  } else if (/^every\s+quarter\s+hour$/.test(text)) {
    minutes = 15;
  } else if (/^hourly$/.test(text)) {
    minutes = 60;
  }
  if (minutes !== null) {
    if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
      return { ok: false };
    }
    const schedule: RoutineSchedule = { kind: "interval", everyMinutes: minutes };
    return { ok: true, schedule, normalized: describeSchedule(schedule) };
  }

  // "weekdays at 9am"
  const weekdays = /^weekdays?\s+(?:at\s+)?(.+)$/.exec(text);
  if (weekdays) {
    const atTime = parseTime(weekdays[1]!);
    if (!atTime) return { ok: false };
    const schedule: RoutineSchedule = { kind: "weekdays", atTime };
    return { ok: true, schedule, normalized: describeSchedule(schedule) };
  }

  // "daily at 08:00", "every day at 9am", "at 17:30 daily"
  const daily =
    /^(?:daily|every\s+day)\s+(?:at\s+)?(.+)$/.exec(text) ?? /^at\s+(.+)\s+(?:daily|every\s+day)$/.exec(text);
  if (daily) {
    const atTime = parseTime(daily[1]!);
    if (!atTime) return { ok: false };
    const schedule: RoutineSchedule = { kind: "daily", atTime };
    return { ok: true, schedule, normalized: describeSchedule(schedule) };
  }

  // "weekly on monday at 09:00", "every monday at 9", "mondays at 9am"
  const weekly =
    /^(?:weekly\s+(?:on\s+)?|every\s+)([a-z]+)\s+(?:at\s+)?(.+)$/.exec(text) ??
    /^([a-z]+)s\s+at\s+(.+)$/.exec(text);
  if (weekly) {
    const day = dayFromName(weekly[1]!);
    if (day === null) return { ok: false };
    const atTime = parseTime(weekly[2]!);
    if (!atTime) return { ok: false };
    const schedule: RoutineSchedule = { kind: "weekly", atTime, dayOfWeek: day };
    return { ok: true, schedule, normalized: describeSchedule(schedule) };
  }

  return { ok: false };
}

const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Human-readable schedule for lists and confirmations. */
export function describeSchedule(schedule: RoutineSchedule): string {
  switch (schedule.kind) {
    case "interval": {
      const m = schedule.everyMinutes ?? 60;
      if (m % 60 === 0) {
        const h = m / 60;
        return h === 1 ? "Hourly" : `Every ${h} hours`;
      }
      return `Every ${m} minutes`;
    }
    case "daily":
      return `Daily at ${schedule.atTime}`;
    case "weekdays":
      return `Weekdays at ${schedule.atTime}`;
    case "weekly":
      return `Weekly on ${DAY_LABELS[schedule.dayOfWeek ?? 0]} at ${schedule.atTime}`;
  }
}

function atOrAfter(from: Date, atTime: string): Date {
  const [h, m] = atTime.split(":").map(Number);
  const d = new Date(from);
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d;
}

/**
 * Next run strictly after `from`, in local time. Pure: pass any Date, get
 * a Date; no DB, no clock reads.
 */
export function nextRoutineRun(schedule: RoutineSchedule, from: Date): Date {
  switch (schedule.kind) {
    case "interval":
      return new Date(from.getTime() + (schedule.everyMinutes ?? 60) * 60_000);
    case "daily": {
      const today = atOrAfter(from, schedule.atTime ?? "08:00");
      return today > from ? today : new Date(today.getTime() + 24 * 3600_000);
    }
    case "weekdays": {
      const probe = new Date(from);
      for (let i = 0; i < 8; i++) {
        const candidate = atOrAfter(probe, schedule.atTime ?? "08:00");
        const day = candidate.getDay();
        if (day >= 1 && day <= 5 && candidate > from) return candidate;
        probe.setDate(probe.getDate() + 1);
        probe.setHours(0, 0, 0, 0);
      }
      return new Date(from.getTime() + 24 * 3600_000);
    }
    case "weekly": {
      const target = schedule.dayOfWeek ?? 1;
      const probe = new Date(from);
      for (let i = 0; i < 8; i++) {
        const candidate = atOrAfter(probe, schedule.atTime ?? "08:00");
        if (candidate.getDay() === target && candidate > from) return candidate;
        probe.setDate(probe.getDate() + 1);
        probe.setHours(0, 0, 0, 0);
      }
      return new Date(from.getTime() + 7 * 24 * 3600_000);
    }
  }
}
