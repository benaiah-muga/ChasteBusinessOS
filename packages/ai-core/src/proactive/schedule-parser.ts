/**
 * Natural-language schedule parsing → an exact, confirmable `ScheduleSpec`.
 *
 * Proactive-agent acceptance criterion: "Natural-language schedules are parsed
 * into exact who/what/when/condition/action objects before confirmation." This
 * parser is deliberately deterministic (no LLM) so the confirmation object is
 * stable, testable, and explainable: the user is shown the parsed spec and
 * confirms before a watch rule is created. Recurrence, timezone, quiet hours,
 * and escalation are explicit fields, never hidden in prose.
 */
import { z } from "zod";
import { actionModeSchema, quietHoursSchema, recurrenceRuleSchema } from "./types.js";

export { actionModeSchema, quietHoursSchema };
export type { ActionMode, QuietHours } from "./types.js";

export const scheduleSpecSchema = z.object({
  /** Who this is for (assignee/recipients). Optional — falls back to the rule owner. */
  who: z.string().optional(),
  /** What to do/remind about — the intent text the agent would act on. */
  what: z.string().min(1),
  when: z.object({
    kind: z.enum(["once", "recurring"]),
    /** ISO-8601 for `once`; ignored for `recurring`. */
    at: z.string().optional(),
    recurrence: recurrenceRuleSchema.optional(),
    timezone: z.string().min(1).default("UTC"),
  }),
  /** Optional precondition for the action to fire. */
  condition: z.string().optional(),
  /** What the agent may do. Never silently exceeds the rule owner's authority. */
  action: actionModeSchema.default("notify"),
  quietHours: quietHoursSchema.optional(),
  escalation: z
    .object({
      afterMinutes: z.number().int().positive(),
      to: z.string().min(1),
    })
    .optional(),
});

export type ScheduleSpec = z.infer<typeof scheduleSpecSchema>;

export type ParseScheduleResult =
  | { ok: true; spec: ScheduleSpec }
  | { ok: false; error: string };

const DAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/**
 * Deterministic, regex-driven extraction of who/what/when/condition/action from
 * a schedule sentence. Returns a structured spec for confirmation — never
 * executes anything.
 *
 * Supported patterns (case-insensitive):
 *   "remind {who} to {what} every {n} days|weeks|months at HH:MM"
 *   "... every friday at 17:00"
 *   "... daily at 08:30"
 *   "... on 2026-08-25 at 09:00"
 *   "... quiet hours 22:00-07:00"
 *   "... escalate to {to} after {n} minutes"
 *   "... only when {condition}"
 *   "... and request approval before ..." / "... draft ..."
 */
export function parseScheduleText(text: string): ParseScheduleResult {
  const t = text.trim();
  if (!t) return { ok: false, error: "empty schedule" };

  let who: string | undefined;
  let remainder = t;
  const whoMatch = t.match(/remind\s+(.+?)\s+to\b/i);
  if (whoMatch) {
    who = whoMatch[1]!.trim();
    remainder = t.slice(0, whoMatch.index) + t.slice((whoMatch.index ?? 0) + whoMatch[0]!.length);
  }

  const atMatch = remainder.match(/\bat\s+(\d{1,2}):(\d{2})\b/i);
  const at = atMatch ? `${atMatch[1]!.padStart(2, "0")}:${atMatch[2]!}` : undefined;

  const dateMatch = remainder.match(/\bon\s+(\d{4}-\d{2}-\d{2})\b/i);
  const onceAt = dateMatch?.[1];

  let recurrence:
    | { freq: "daily"; interval?: number }
    | { freq: "weekly"; interval?: number; daysOfWeek?: number[]; at?: string }
    | { freq: "monthly"; interval?: number }
    | undefined;

  const dailyMatch = remainder.match(/\bevery\s+(\d+)\s+days\b|\bdaily\b/i);
  if (dailyMatch) {
    recurrence = { freq: "daily", interval: dailyMatch[1] ? Number(dailyMatch[1]) : undefined };
  }
  const weeklyMatch = remainder.match(
    /\bevery\s+(\d+)\s+weeks\b|\bevery\s+([a-z]+day)\b|\bweekly\b/i,
  );
  if (weeklyMatch) {
    const day = weeklyMatch[2] ? DAYS[weeklyMatch[2]!.toLowerCase()] : undefined;
    recurrence = {
      freq: "weekly",
      interval: weeklyMatch[1] ? Number(weeklyMatch[1]) : undefined,
      daysOfWeek: day !== undefined ? [day] : undefined,
      at,
    };
  }
  const monthlyMatch = remainder.match(/\bevery\s+(\d+)\s+months\b|\bmonthly\b/i);
  if (monthlyMatch) {
    recurrence = { freq: "monthly", interval: monthlyMatch[1] ? Number(monthlyMatch[1]) : undefined };
  }

  const timezoneMatch = remainder.match(/\btimezone\s+([a-zA-Z_/]+)\b/);
  const timezone = timezoneMatch?.[1] ?? "UTC";

  const quietHoursMatch = remainder.match(/quiet hours\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/i);
  const quietHours = quietHoursMatch
    ? {
        start: `${quietHoursMatch[1]!.padStart(2, "0")}:${quietHoursMatch[2]!}`,
        end: `${quietHoursMatch[3]!.padStart(2, "0")}:${quietHoursMatch[4]!}`,
        timezone,
      }
    : undefined;

  const escalationMatch = remainder.match(
    /escalate to\s+(.+?)\s+after\s+(\d+)\s+min/i,
  );
  const escalation = escalationMatch
    ? { afterMinutes: Number(escalationMatch[2]!), to: escalationMatch[1]!.trim() }
    : undefined;

  const conditionMatch = remainder.match(/only when\s+(.+?)(?:\bat\b|,|\.|$)/i);
  const condition = conditionMatch?.[1]?.trim();

  const action = remainder.match(/request approval/i)
    ? "request_approval"
    : remainder.match(/\bdraft\b/i)
      ? "draft"
      : remainder.match(/\bsuggest\b/i)
        ? "suggest"
        : "notify";

  // Strip the recognized tokens so `what` is the clean intent.
  let what = remainder
    .replace(/^remind\s+.+?\bto\b/i, "")
    .replace(/\bat\s+\d{1,2}:\d{2}\b/gi, "")
    .replace(/\bon\s+\d{4}-\d{2}-\d{2}\b/gi, "")
    .replace(/\bevery\s+\d+\s+days\b|\bdaily\b/gi, "")
    .replace(/\bevery\s+\d+\s+weeks\b|\bevery\s+[a-z]+day\b|\bweekly\b/gi, "")
    .replace(/\bevery\s+\d+\s+months\b|\bmonthly\b/gi, "")
    .replace(/\btimezone\s+[a-zA-Z_/]+\b/gi, "")
    .replace(/quiet hours\s+\d{1,2}:\d{2}-\d{1,2}:\d{2}/gi, "")
    .replace(/escalate to\s+.+?\s+after\s+\d+\s+min/gi, "")
    .replace(/only when\s+.+?(?:\bat\b|,|\.|$)/gi, "")
    .replace(/request approval|\bdraft\b|\bsuggest\b/gi, "")
    .replace(/[.,;]\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (what.startsWith("to ")) what = what.slice(3);

  if (!at && !recurrence && !onceAt) {
    return { ok: false, error: "could not extract a schedule time (date, time, or recurrence)" };
  }
  if (!what) {
    return { ok: false, error: "could not extract what to do" };
  }

  const when = onceAt
    ? { kind: "once" as const, at: onceAt, timezone }
    : { kind: "recurring" as const, recurrence, at, timezone };

  const spec = scheduleSpecSchema.safeParse({
    who,
    what,
    when,
    condition,
    action,
    quietHours,
    escalation,
  });
  if (!spec.success) {
    return { ok: false, error: spec.error.issues.map((i) => i.message).join("; ") };
  }
  return { ok: true, spec: spec.data };
}

/** Human-readable confirmation sentence for a parsed spec. */
export function confirmSchedule(spec: ScheduleSpec): string {
  const when =
    spec.when.kind === "once"
      ? `on ${spec.when.at}`
      : spec.when.recurrence
        ? describeRecurrence(spec.when.recurrence)
        : "recurring";
  const bits = [
    `Remind${spec.who ? ` ${spec.who}` : ""} to ${spec.what}`,
    `${spec.when.kind === "once" ? "" : "every"} ${when}`,
    spec.when.at ? `at ${spec.when.at}` : undefined,
    spec.when.timezone !== "UTC" ? `(${spec.when.timezone})` : undefined,
    spec.condition ? `only when ${spec.condition}` : undefined,
    spec.quietHours ? `quiet hours ${spec.quietHours.start}-${spec.quietHours.end}` : undefined,
    spec.escalation
      ? `escalate to ${spec.escalation.to} after ${spec.escalation.afterMinutes} minutes`
      : undefined,
    `action: ${spec.action}`,
  ].filter((b): b is string => Boolean(b));
  return bits.join(", ");
}

function describeRecurrence(r: {
  freq: "daily" | "weekly" | "monthly";
  interval?: number;
  daysOfWeek?: number[];
}): string {
  const interval = r.interval && r.interval > 1 ? ` every ${r.interval}` : "";
  if (r.freq === "weekly" && r.daysOfWeek?.length) {
    const names = Object.entries(DAYS)
      .filter(([, n]) => r.daysOfWeek!.includes(n))
      .map(([name]) => name);
    return `on ${names.join(", ")}`;
  }
  return `${r.freq}${interval}`;
}
