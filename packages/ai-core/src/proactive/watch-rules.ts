/**
 * Watch rules — the durable, user-owned "if X then Y" surface of the proactive
 * coordinator (research doc §Proactive Agent Acceptance Criteria).
 *
 * A watch rule says: when a schedule fires (or an event key fires), the agent
 * may produce a suggestion with the configured action mode. The mode is a
 * strict authority ladder: `notify` < `suggest` < `draft` < `request_approval`.
 * `draft`/`request_approval` suggestions are marked `requiredApproval` — the
 * coordinator never executes them; it hands the host a structured intent to
 * gate through the existing approval path.
 *
 * Recurrence uses the same `RecurrenceRule` shape as kernel activities, so the
 * two scheduling surfaces share one model.
 */
import { z } from "zod";
import { actionModeSchema, recurrenceRuleSchema, type RecurrenceRule } from "./types.js";

export { recurrenceRuleSchema };

export const watchTriggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("schedule"),
    recurrence: recurrenceRuleSchema,
    timezone: z.string().min(1).default("UTC"),
  }),
  z.object({ kind: z.literal("event"), eventKey: z.string().min(1) }),
]);

export const watchActionSchema = z.object({
  mode: actionModeSchema,
  /** The intent text the agent would act on when the rule fires. */
  intent: z.string().min(1),
  /** Who receives the suggestion. */
  recipients: z.array(z.string()).min(1),
});

export const watchRuleSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string().min(1),
  trigger: watchTriggerSchema,
  action: watchActionSchema,
  condition: z.string().optional(),
  enabled: z.boolean().default(true),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  createdByUserId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type WatchRule = z.infer<typeof watchRuleSchema>;
export type WatchTrigger = z.infer<typeof watchTriggerSchema>;
export type WatchAction = z.infer<typeof watchActionSchema>;

export interface WatchRuleStore {
  create(
    rule: Omit<WatchRule, "id" | "createdAt" | "updatedAt"> & { id?: string; createdAt?: string },
  ): Promise<WatchRule>;
  update(organizationId: string, id: string, patch: Partial<Pick<WatchRule, "name" | "trigger" | "action" | "condition" | "priority" | "enabled">>): Promise<WatchRule | undefined>;
  remove(organizationId: string, id: string): Promise<boolean>;
  get(organizationId: string, id: string): Promise<WatchRule | undefined>;
  listByOrg(organizationId: string): Promise<WatchRule[]>;
}

export class InMemoryWatchRuleStore implements WatchRuleStore {
  private readonly rules = new Map<string, WatchRule>();
  private readonly now: () => Date;

  constructor(opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  async create(
    rule: Omit<WatchRule, "id" | "createdAt" | "updatedAt"> & { id?: string; createdAt?: string },
  ): Promise<WatchRule> {
    const now = this.now().toISOString();
    const record: WatchRule = {
      ...rule,
      id: rule.id ?? crypto.randomUUID(),
      createdAt: rule.createdAt ?? now,
      updatedAt: now,
    };
    this.rules.set(record.id, record);
    return record;
  }

  async update(
    organizationId: string,
    id: string,
    patch: Partial<Pick<WatchRule, "name" | "trigger" | "action" | "condition" | "priority" | "enabled">>,
  ): Promise<WatchRule | undefined> {
    const existing = this.rules.get(id);
    if (!existing || existing.organizationId !== organizationId) return undefined;
    const updated: WatchRule = {
      ...existing,
      ...patch,
      updatedAt: this.now().toISOString(),
    };
    this.rules.set(id, updated);
    return updated;
  }

  async remove(organizationId: string, id: string): Promise<boolean> {
    const existing = this.rules.get(id);
    if (!existing || existing.organizationId !== organizationId) return false;
    this.rules.delete(id);
    return true;
  }

  async get(organizationId: string, id: string): Promise<WatchRule | undefined> {
    const rule = this.rules.get(id);
    return rule && rule.organizationId === organizationId ? rule : undefined;
  }

  async listByOrg(organizationId: string): Promise<WatchRule[]> {
    return [...this.rules.values()]
      .filter((r) => r.organizationId === organizationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

/**
 * Next fire time for a schedule trigger, strictly after `after` (UTC). Uses the
 * same `nextOccurrence` semantics as kernel activities.
 */
export function nextFireTime(rule: WatchRule, after: Date): Date | null {
  if (rule.trigger.kind !== "schedule") return null;
  const recurrence: RecurrenceRule = rule.trigger.recurrence;
  const interval = Math.max(1, recurrence.interval ?? 1);
  const [hh, mm] = (recurrence.at ?? "09:00").split(":").map((n) => parseInt(n, 10));
  const hour = typeof hh === "number" && Number.isFinite(hh) ? hh : 9;
  const minute = typeof mm === "number" && Number.isFinite(mm) ? mm : 0;

  const candidate = new Date(after);
  if (recurrence.freq === "daily") candidate.setUTCDate(candidate.getUTCDate() + interval);
  else if (recurrence.freq === "weekly") candidate.setUTCDate(candidate.getUTCDate() + 7 * interval);
  else candidate.setUTCMonth(candidate.getUTCMonth() + interval);
  candidate.setUTCHours(hour, minute, 0, 0);

  if (recurrence.freq === "weekly" && recurrence.daysOfWeek?.length) {
    const allowed = new Set(recurrence.daysOfWeek);
    for (let i = 0; i < 7; i += 1) {
      if (allowed.has(candidate.getUTCDay())) break;
      candidate.setUTCDate(candidate.getUTCDate() + 1);
    }
    candidate.setUTCHours(hour, minute, 0, 0);
  }
  return candidate.getTime() > after.getTime() ? candidate : null;
}
