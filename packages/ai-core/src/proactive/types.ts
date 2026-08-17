/**
 * Shared zod contracts for the proactive coordinator. Kept dependency-free so
 * `schedule-parser.ts` and `watch-rules.ts` can both import them without a
 * circular import.
 */
import { z } from "zod";

export const actionModeSchema = z.enum(["notify", "suggest", "draft", "request_approval"]);
export type ActionMode = z.infer<typeof actionModeSchema>;

export const quietHoursSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/, "quiet-hours start must be HH:MM"),
  end: z.string().regex(/^\d{2}:\d{2}$/, "quiet-hours end must be HH:MM"),
  timezone: z.string().min(1).default("UTC"),
});
export type QuietHours = z.infer<typeof quietHoursSchema>;

/** Same `RecurrenceRule` shape as kernel activities — one scheduling model. */
export const recurrenceRuleSchema = z.object({
  freq: z.enum(["daily", "weekly", "monthly"]),
  interval: z.number().int().positive().optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
  at: z.string().regex(/^\d{2}:\d{2}$/).optional(),
});
export type RecurrenceRule = z.infer<typeof recurrenceRuleSchema>;