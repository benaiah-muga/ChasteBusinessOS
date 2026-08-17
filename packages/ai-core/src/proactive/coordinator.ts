/**
 * Proactive coordinator — turns durable triggers into authority-safe,
 * fatigue-managed suggestions (research doc §Proactive Agent Acceptance
 * Criteria).
 *
 * Inputs (all interfaces, so tests use in-memory stores and hosts use the
 * Postgres-backed ones): watch rules, self-wakes, and overdue activities. The
 * coordinator never executes a command itself — it produces a
 * `ProactiveSuggestion` with trigger evidence, proposed action, expected
 * impact, and an explicit `requiredApproval` flag, then records the delivery.
 * `draft`/`request_approval` watch-rule actions are always `requiredApproval`,
 * and the host gates those through the existing approval path
 * (`buildProactivePlan` hands back a structured intent for exactly that).
 *
 * Fatigue controls are applied at delivery time via a pure gate: quiet hours,
 * a per-org daily cap, and deduplication by occurrence key. Suppressed items
 * are still recorded (marked suppressed) so users can inspect what was held.
 */
import type { ActivityStore } from "@chaste/kernel";
import { z } from "zod";
import type { WakeStore } from "../selfwake.js";
import { nextFireTime, type WatchRuleStore } from "./watch-rules.js";
import { scheduleSpecSchema } from "./schedule-parser.js";

export const proactivePreferencesSchema = z.object({
  organizationId: z.string(),
  quietHours: z
    .object({
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
      timezone: z.string().min(1).default("UTC"),
    })
    .optional(),
  maxSuggestionsPerDay: z.number().int().nonnegative().default(10),
  channels: z.array(z.string()).default(["inbox"]),
});

export type ProactivePreferences = z.infer<typeof proactivePreferencesSchema>;

export interface ProactivePreferencesStore {
  get(organizationId: string): Promise<ProactivePreferences>;
  set(prefs: ProactivePreferences): Promise<ProactivePreferences>;
}

export class InMemoryProactivePreferencesStore implements ProactivePreferencesStore {
  private readonly prefs = new Map<string, ProactivePreferences>();
  private readonly now: () => Date;

  constructor(opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  async get(organizationId: string): Promise<ProactivePreferences> {
    const existing = this.prefs.get(organizationId);
    if (existing) return existing;
    const created: ProactivePreferences = {
      organizationId,
      maxSuggestionsPerDay: 10,
      channels: ["inbox"],
    };
    this.prefs.set(organizationId, created);
    return created;
  }

  async set(prefs: ProactivePreferences): Promise<ProactivePreferences> {
    const record: ProactivePreferences = {
      ...prefs,
      channels: prefs.channels ? [...prefs.channels] : ["inbox"],
    };
    this.prefs.set(record.organizationId, record);
    return record;
  }
}

export type SuggestionKind = "watch_rule" | "wake" | "overdue_activity";

export interface ProactiveSuggestion {
  id: string;
  organizationId: string;
  kind: SuggestionKind;
  /** The rule/wake/activity that fired. */
  sourceId: string;
  /** The occurrence this firing represents (ISO for schedules, else sourceId). */
  occurrenceKey: string;
  /** Unique key for one firing of one source (rule id + occurrence, or source id). */
  dedupeKey: string;
  /** Why this fired (what the user should see as evidence). */
  triggerEvidence: string;
  /** What the agent proposes to do. */
  proposedAction: string;
  /** What the user should expect if it runs. */
  expectedImpact: string;
  /** True when the action must not run without approval (draft/request_approval). */
  requiredApproval: boolean;
  priority: "low" | "normal" | "high";
  targetUserIds: string[];
  createdAt: string;
}

export interface ProactiveDelivery {
  id: string;
  organizationId: string;
  dedupeKey: string;
  kind: SuggestionKind;
  sourceId: string;
  /** The occurrence key the dedupe advances from (ISO for schedules). */
  occurrenceKey: string;
  triggerEvidence: string;
  proposedAction: string;
  expectedImpact: string;
  requiredApproval: boolean;
  priority: "low" | "normal" | "high";
  targetUserIds: string[];
  suppressed: boolean;
  suppressionReason?: string;
  deliveredAt: string;
}

export interface ProactiveDeliveryStore {
  record(
    d: Omit<ProactiveDelivery, "id" | "deliveredAt">,
    now?: Date,
  ): Promise<ProactiveDelivery>;
  seen(organizationId: string, dedupeKey: string): Promise<boolean>;
  /** Most recent occurrence key recorded for a source (advances schedule rules). */
  lastOccurrence(organizationId: string, sourceId: string): Promise<string | undefined>;
  /** Count of non-suppressed deliveries on a calendar day (fatigue cap). */
  countDeliveredOn(organizationId: string, day: Date): Promise<number>;
  listByOrg(organizationId: string): Promise<ProactiveDelivery[]>;
}

export class InMemoryProactiveDeliveryStore implements ProactiveDeliveryStore {
  private readonly deliveries: ProactiveDelivery[] = [];
  private readonly now: () => Date;

  constructor(opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  async record(
    d: Omit<ProactiveDelivery, "id" | "deliveredAt">,
    now?: Date,
  ): Promise<ProactiveDelivery> {
    const at = (now ?? this.now()).toISOString();
    const record: ProactiveDelivery = { ...d, id: crypto.randomUUID(), deliveredAt: at };
    this.deliveries.push(record);
    return record;
  }

  async seen(organizationId: string, dedupeKey: string): Promise<boolean> {
    return this.deliveries.some(
      (d) => d.organizationId === organizationId && d.dedupeKey === dedupeKey,
    );
  }

  async lastOccurrence(organizationId: string, sourceId: string): Promise<string | undefined> {
    const rows = this.deliveries
      .filter((d) => d.organizationId === organizationId && d.sourceId === sourceId)
      .sort((a, b) => a.occurrenceKey.localeCompare(b.occurrenceKey));
    return rows[rows.length - 1]?.occurrenceKey;
  }

  async countDeliveredOn(organizationId: string, day: Date): Promise<number> {
    const start = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
    const end = start + 86_400_000;
    return this.deliveries.filter(
      (d) =>
        d.organizationId === organizationId &&
        !d.suppressed &&
        (() => {
          const t = new Date(d.deliveredAt).getTime();
          return t >= start && t < end;
        })(),
    ).length;
  }

  async listByOrg(organizationId: string): Promise<ProactiveDelivery[]> {
    return this.deliveries
      .filter((d) => d.organizationId === organizationId)
      .sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt));
  }
}

export type GateReason = "ok" | "quiet_hours" | "daily_cap" | "duplicate";

export interface GateContext {
  inQuietHours: boolean;
  todayDelivered: number;
  maxPerDay: number;
  alreadyDelivered: boolean;
}

/** Pure fatigue/authority gate. Delivers only when quiet hours allow, the daily
 * cap is not exhausted, and the occurrence has not already been delivered. */
export function deliveryGate(
  ctx: GateContext,
): { deliver: boolean; suppressed: boolean; reason: GateReason } {
  if (ctx.alreadyDelivered) return { deliver: false, suppressed: true, reason: "duplicate" };
  if (ctx.inQuietHours) return { deliver: false, suppressed: true, reason: "quiet_hours" };
  if (ctx.todayDelivered >= ctx.maxPerDay) return { deliver: false, suppressed: true, reason: "daily_cap" };
  return { deliver: true, suppressed: false, reason: "ok" };
}

/** Is `now` (UTC) inside the prefs quiet hours window (interpreted as UTC)? */
export function inQuietHours(
  prefs: ProactivePreferences,
  now: Date,
): boolean {
  if (!prefs.quietHours) return false;
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const [sh, sm] = prefs.quietHours.start.split(":").map((n) => parseInt(n, 10));
  const [eh, em] = prefs.quietHours.end.split(":").map((n) => parseInt(n, 10));
  const start = (sh ?? 0) * 60 + (sm ?? 0);
  const end = (eh ?? 0) * 60 + (em ?? 0);
  // Overnight window (end <= start) wraps past midnight.
  if (start <= end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

export interface ProactiveCoordinatorDeps {
  watchRules: WatchRuleStore;
  wakes: WakeStore;
  activities: ActivityStore;
  preferences: ProactivePreferencesStore;
  deliveries: ProactiveDeliveryStore;
  now?: () => Date;
}

export interface ProactiveCoordinator {
  /** Build every due suggestion for an org at `now` (no gating or recording). */
  collect(organizationId: string, now: Date): Promise<ProactiveSuggestion[]>;
  /** Gate + record a suggestion; returns the durable delivery row. */
  deliver(
    suggestion: ProactiveSuggestion,
    now: Date,
    prefs?: ProactivePreferences,
  ): Promise<ProactiveDelivery>;
  /** Collect + gate + record everything due. */
  deliverDue(organizationId: string, now: Date): Promise<ProactiveDelivery[]>;
  /** Authority-safe handoff: the structured intent a host gates via approval. */
  buildProactivePlan(suggestion: ProactiveSuggestion): ProactivePlan;
}

export interface ProactivePlan {
  sourceId: string;
  kind: SuggestionKind;
  intent: string;
  requiredApproval: boolean;
  targetUserIds: string[];
}

export function createProactiveCoordinator(
  deps: ProactiveCoordinatorDeps,
): ProactiveCoordinator {
  const nowFn = deps.now ?? (() => new Date());

  async function collect(organizationId: string, now: Date): Promise<ProactiveSuggestion[]> {
    const out: ProactiveSuggestion[] = [];

    // 1. Watch rules (schedule triggers only — event triggers fire via fireEvent).
    for (const rule of await deps.watchRules.listByOrg(organizationId)) {
      if (!rule.enabled || rule.trigger.kind !== "schedule") continue;
      const lastOccurrence = await deps.deliveries.lastOccurrence(organizationId, rule.id);
      const after = lastOccurrence ? new Date(lastOccurrence) : new Date(rule.createdAt);
      const next = nextFireTime(rule, after);
      if (!next || next.getTime() > now.getTime()) continue;
      const occurrenceKey = next.toISOString();
      const requiredApproval = rule.action.mode === "draft" || rule.action.mode === "request_approval";
      out.push({
        id: crypto.randomUUID(),
        organizationId,
        kind: "watch_rule",
        sourceId: rule.id,
        occurrenceKey,
        dedupeKey: `watch_rule:${rule.id}:${occurrenceKey}`,
        triggerEvidence: `Watch rule "${rule.name}" fired (${describeRecurrence(rule.trigger.recurrence)})`,
        proposedAction: rule.action.intent,
        expectedImpact: `Deliver "${rule.action.intent}" via ${rule.action.mode} to ${rule.action.recipients.join(", ")}`,
        requiredApproval,
        priority: rule.priority,
        targetUserIds: rule.action.recipients,
        createdAt: now.toISOString(),
      });
    }

    // 2. Due self-wakes (the agent scheduled re-entry).
    for (const wake of await deps.wakes.due(now)) {
      const proposedAction = wake.proactiveText ?? "Resume the scheduled session";
      out.push({
        id: crypto.randomUUID(),
        organizationId,
        kind: "wake",
        sourceId: wake.id,
        occurrenceKey: wake.id,
        dedupeKey: `wake:${wake.id}`,
        triggerEvidence: `Scheduled self-wake fired (${wake.kind})`,
        proposedAction,
        expectedImpact: "Re-enters the session with the scheduled call",
        requiredApproval: false,
        priority: "normal",
        targetUserIds: [],
        createdAt: now.toISOString(),
      });
    }

    // 3. Overdue activities.
    for (const activity of await deps.activities.overdue(organizationId, now)) {
      out.push({
        id: crypto.randomUUID(),
        organizationId,
        kind: "overdue_activity",
        sourceId: activity.id,
        occurrenceKey: activity.id,
        dedupeKey: `activity:${activity.id}`,
        triggerEvidence: `Activity "${activity.title}" is overdue (due ${activity.dueAt})`,
        proposedAction: activity.body ?? `Follow up on "${activity.title}"`,
        expectedImpact: `Clears the overdue activity for ${activity.assigneeUserId ?? "the org"}`,
        requiredApproval: false,
        priority: activity.dueAt <= now.toISOString() ? "high" : "normal",
        targetUserIds: activity.assigneeUserId ? [activity.assigneeUserId] : [],
        createdAt: now.toISOString(),
      });
    }

    return out;
  }

  async function deliver(
    suggestion: ProactiveSuggestion,
    now: Date,
    prefs?: ProactivePreferences,
  ): Promise<ProactiveDelivery> {
    const orgPrefs = prefs ?? (await deps.preferences.get(suggestion.organizationId));
    const gate = deliveryGate({
      inQuietHours: inQuietHours(orgPrefs, now),
      todayDelivered: await deps.deliveries.countDeliveredOn(suggestion.organizationId, now),
      maxPerDay: orgPrefs.maxSuggestionsPerDay,
      alreadyDelivered: await deps.deliveries.seen(suggestion.organizationId, suggestion.dedupeKey),
    });
    return deps.deliveries.record(
      {
        organizationId: suggestion.organizationId,
        dedupeKey: suggestion.dedupeKey,
        kind: suggestion.kind,
        sourceId: suggestion.sourceId,
        occurrenceKey: suggestion.occurrenceKey,
        triggerEvidence: suggestion.triggerEvidence,
        proposedAction: suggestion.proposedAction,
        expectedImpact: suggestion.expectedImpact,
        requiredApproval: suggestion.requiredApproval,
        priority: suggestion.priority,
        targetUserIds: suggestion.targetUserIds,
        suppressed: gate.suppressed,
        suppressionReason: gate.deliver ? undefined : gate.reason,
      },
      now,
    );
  }

  async function deliverDue(organizationId: string, now: Date): Promise<ProactiveDelivery[]> {
    const prefs = await deps.preferences.get(organizationId);
    const suggestions = await collect(organizationId, now);
    const out: ProactiveDelivery[] = [];
    for (const s of suggestions) {
      out.push(await deliver(s, now, prefs));
    }
    return out;
  }

  function buildProactivePlan(suggestion: ProactiveSuggestion): ProactivePlan {
    return {
      sourceId: suggestion.sourceId,
      kind: suggestion.kind,
      intent: suggestion.proposedAction,
      requiredApproval: suggestion.requiredApproval,
      targetUserIds: suggestion.targetUserIds,
    };
  }

  return { collect, deliver, deliverDue, buildProactivePlan };
}

function describeRecurrence(r: { freq: "daily" | "weekly" | "monthly"; interval?: number }): string {
  return `${r.freq}${r.interval && r.interval > 1 ? ` (every ${r.interval})` : ""}`;
}
