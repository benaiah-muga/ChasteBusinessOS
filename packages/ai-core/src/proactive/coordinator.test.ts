import { describe, expect, it } from "vitest";
import { InMemoryActivityStore } from "@chaste/kernel";
import { InMemoryWakeStore } from "../selfwake.js";
import {
  confirmSchedule,
  parseScheduleText,
  type ScheduleSpec,
} from "./schedule-parser.js";
import {
  InMemoryWatchRuleStore,
  nextFireTime,
  type WatchRule,
  type WatchRuleStore,
} from "./watch-rules.js";
import {
  InMemoryProactiveDeliveryStore,
  InMemoryProactivePreferencesStore,
  createProactiveCoordinator,
  deliveryGate,
  inQuietHours,
  type ProactivePreferences,
  type ProactiveSuggestion,
} from "./coordinator.js";

const NOW = new Date("2026-08-17T10:30:00Z");

function ruleFixture(partial: Partial<WatchRule> = {}): WatchRule {
  return {
    id: "rule-1",
    organizationId: "org-1",
    name: "Stockout check",
    trigger: {
      kind: "schedule",
      recurrence: { freq: "daily", at: "10:00" },
      timezone: "UTC",
    },
    action: {
      mode: "notify",
      intent: "Check low stock levels and notify the buyer",
      recipients: ["user-1"],
    },
    enabled: true,
    priority: "normal",
    createdByUserId: "user-1",
    createdAt: "2026-08-16T09:00:00Z",
    updatedAt: "2026-08-16T09:00:00Z",
    ...partial,
  };
}

function suggestionFixture(partial: Partial<ProactiveSuggestion> = {}): ProactiveSuggestion {
  return {
    id: "s-1",
    organizationId: "org-1",
    kind: "watch_rule",
    sourceId: "rule-1",
    occurrenceKey: "2026-08-17T10:00:00.000Z",
    dedupeKey: "watch_rule:rule-1:2026-08-17T10:00:00.000Z",
    triggerEvidence: "Watch rule fired",
    proposedAction: "Check stock",
    expectedImpact: "Notify buyer",
    requiredApproval: false,
    priority: "normal",
    targetUserIds: ["user-1"],
    createdAt: NOW.toISOString(),
    ...partial,
  };
}

describe("parseScheduleText", () => {
  it("parses a recurring schedule into exact who/what/when/condition/action objects", () => {
    const result = parseScheduleText(
      "remind the purchasing manager to check low stock every friday at 17:00 quiet hours 22:00-07:00 escalate to the CFO after 30 min only when stockout alert exists",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.who).toBe("the purchasing manager");
    expect(result.spec.what).toBe("check low stock");
    expect(result.spec.when.kind).toBe("recurring");
    if (result.spec.when.kind !== "recurring") return;
    expect(result.spec.when.recurrence).toMatchObject({ freq: "weekly", daysOfWeek: [5] });
    expect(result.spec.when.at).toBe("17:00");
    expect(result.spec.when.timezone).toBe("UTC");
    expect(result.spec.condition).toBe("stockout alert exists");
    expect(result.spec.quietHours).toEqual({ start: "22:00", end: "07:00", timezone: "UTC" });
    expect(result.spec.escalation).toEqual({ afterMinutes: 30, to: "the CFO" });
    expect(result.spec.action).toBe("notify");
  });

  it("parses a one-off date, explicit timezone, and request-approval action", () => {
    const result = parseScheduleText(
      "remind me to approve the invoice on 2026-08-25 at 09:00 timezone Africa/Nairobi and request approval",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.when.kind).toBe("once");
    if (result.spec.when.kind !== "once") return;
    expect(result.spec.when.at).toBe("2026-08-25");
    expect(result.spec.when.timezone).toBe("Africa/Nairobi");
    expect(result.spec.action).toBe("request_approval");
    expect(result.spec.who).toBe("me");
  });

  it("parses interval recurrences (daily every 2 days, monthly)", () => {
    const daily = parseScheduleText("run the check every 2 days at 08:30");
    expect(daily.ok && daily.ok && daily.spec.when.kind === "recurring").toBe(true);
    if (daily.ok && daily.spec.when.kind === "recurring") {
      expect(daily.spec.when.recurrence).toMatchObject({ freq: "daily", interval: 2 });
      expect(daily.spec.when.at).toBe("08:30");
    }

    const monthly = parseScheduleText("reconcile monthly at 06:00");
    expect(monthly.ok && monthly.spec.when.kind === "recurring").toBe(true);
    if (monthly.ok && monthly.spec.when.kind === "recurring") {
      expect(monthly.spec.when.recurrence).toMatchObject({ freq: "monthly" });
    }
  });

  it("returns an error when nothing parseable is present", () => {
    const result = parseScheduleText("hello world");
    expect(result.ok).toBe(false);
  });

  it("confirms a parsed spec in human-readable form", () => {
    const spec: ScheduleSpec = {
      who: "the buyer",
      what: "review stockouts",
      when: {
        kind: "recurring",
        recurrence: { freq: "daily", at: "09:00" },
        timezone: "UTC",
      },
      action: "suggest",
    };
    expect(confirmSchedule(spec)).toContain("the buyer");
    expect(confirmSchedule(spec)).toContain("daily");
    expect(confirmSchedule(spec)).toContain("action: suggest");
  });
});

describe("WatchRuleStore", () => {
  it("scopes CRUD by organization", async () => {
    const store: WatchRuleStore = new InMemoryWatchRuleStore();
    const created = await store.create(ruleFixture());
    const other = await store.create(ruleFixture({ id: "rule-2", organizationId: "org-2" }));

    expect(await store.listByOrg("org-1")).toHaveLength(1);
    expect(await store.get("org-1", created.id)).toBeDefined();
    expect(await store.get("org-2", created.id)).toBeUndefined();

    const updated = await store.update("org-1", created.id, { enabled: false });
    expect(updated?.enabled).toBe(false);
    expect(await store.update("org-2", created.id, { name: "nope" })).toBeUndefined();

    expect(await store.remove("org-2", created.id)).toBe(false);
    expect(await store.remove("org-1", created.id)).toBe(true);
    expect(await store.listByOrg("org-1")).toHaveLength(0);
    expect(await store.listByOrg("org-2")).toHaveLength(1);
  });

  it("computes the next fire time for daily, weekly, and monthly schedules", () => {
    const daily = ruleFixture();
    expect(nextFireTime(daily, new Date("2026-08-16T09:00:00Z"))?.toISOString()).toBe(
      "2026-08-17T10:00:00.000Z",
    );

    const weekly = ruleFixture({
      trigger: {
        kind: "schedule",
        recurrence: { freq: "weekly", daysOfWeek: [5], at: "10:00" },
        timezone: "UTC",
      },
      createdAt: "2026-08-07T10:00:00Z",
    });
    expect(nextFireTime(weekly, new Date("2026-08-07T10:00:00Z"))?.toISOString()).toBe(
      "2026-08-14T10:00:00.000Z",
    );

    const monthly = ruleFixture({
      trigger: { kind: "schedule", recurrence: { freq: "monthly", at: "10:00" }, timezone: "UTC" },
      createdAt: "2026-07-17T10:00:00Z",
    });
    expect(nextFireTime(monthly, new Date("2026-07-17T10:00:00Z"))?.toISOString()).toBe(
      "2026-08-17T10:00:00.000Z",
    );

    const event = ruleFixture({ trigger: { kind: "event", eventKey: "webhook" } });
    expect(nextFireTime(event, NOW)).toBeNull();
  });
});

describe("deliveryGate + inQuietHours", () => {
  it("delivers when nothing is blocking", () => {
    expect(deliveryGate({ inQuietHours: false, todayDelivered: 0, maxPerDay: 10, alreadyDelivered: false })).toEqual({
      deliver: true,
      suppressed: false,
      reason: "ok",
    });
  });

  it("suppresses during quiet hours, over the daily cap, and duplicates", () => {
    expect(deliveryGate({ inQuietHours: true, todayDelivered: 0, maxPerDay: 10, alreadyDelivered: false }).reason).toBe(
      "quiet_hours",
    );
    expect(
      deliveryGate({ inQuietHours: false, todayDelivered: 10, maxPerDay: 10, alreadyDelivered: false }).reason,
    ).toBe("daily_cap");
    expect(deliveryGate({ inQuietHours: false, todayDelivered: 0, maxPerDay: 10, alreadyDelivered: true }).reason).toBe(
      "duplicate",
    );
  });

  it("detects overnight quiet hours", () => {
    const prefs: ProactivePreferences = {
      organizationId: "org-1",
      quietHours: { start: "22:00", end: "07:00", timezone: "UTC" },
    };
    expect(inQuietHours(prefs, new Date("2026-08-17T23:00:00Z"))).toBe(true);
    expect(inQuietHours(prefs, new Date("2026-08-17T06:00:00Z"))).toBe(true);
    expect(inQuietHours(prefs, new Date("2026-08-17T12:00:00Z"))).toBe(false);
  });
});

describe("ProactiveCoordinator", () => {
  function build() {
    const watchRules = new InMemoryWatchRuleStore({ now: () => NOW });
    const wakes = new InMemoryWakeStore({ now: () => NOW });
    const activities = new InMemoryActivityStore({ now: () => NOW });
    const preferences = new InMemoryProactivePreferencesStore({ now: () => NOW });
    const deliveries = new InMemoryProactiveDeliveryStore({ now: () => NOW });
    const coordinator = createProactiveCoordinator({
      watchRules,
      wakes,
      activities,
      preferences,
      deliveries,
      now: () => NOW,
    });
    return { watchRules, wakes, activities, preferences, deliveries, coordinator };
  }

  it("collects a due schedule rule and advances past the delivered occurrence", async () => {
    const { watchRules, coordinator } = build();
    await watchRules.create(ruleFixture());

    const first = await coordinator.collect("org-1", NOW);
    expect(first).toHaveLength(1);
    expect(first[0]!.kind).toBe("watch_rule");
    expect(first[0]!.dedupeKey).toBe("watch_rule:rule-1:2026-08-17T10:00:00.000Z");
    expect(first[0]!.requiredApproval).toBe(false);

    // Deliver advances the last-occurrence cursor.
    const d1 = await coordinator.deliver(first[0]!, NOW);
    expect(d1.suppressed).toBe(false);

    // Same tick: now a duplicate.
    const dup = await coordinator.deliver(first[0]!, NOW);
    expect(dup.suppressed).toBe(true);
    expect(dup.suppressionReason).toBe("duplicate");

    // Next tick (same day, later): the next occurrence is tomorrow → nothing new.
    const second = await coordinator.collect("org-1", new Date("2026-08-17T11:00:00Z"));
    expect(second).toHaveLength(0);

    // Following day at 10:00 → the next occurrence is due.
    const third = await coordinator.collect("org-1", new Date("2026-08-18T10:05:00Z"));
    expect(third).toHaveLength(1);
    expect(third[0]!.dedupeKey).toBe("watch_rule:rule-1:2026-08-18T10:00:00.000Z");
  });

  it("marks draft/request_approval rules as requiredApproval and never executes", async () => {
    const { watchRules, coordinator, deliveries } = build();
    await watchRules.create(
      ruleFixture({
        id: "rule-gated",
        action: { mode: "request_approval", intent: "Draft a purchase order for the buyer", recipients: ["user-1"] },
      }),
    );

    const suggestions = await coordinator.collect("org-1", NOW);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.requiredApproval).toBe(true);

    const plan = coordinator.buildProactivePlan(suggestions[0]!);
    expect(plan.requiredApproval).toBe(true);
    expect(plan.intent).toBe("Draft a purchase order for the buyer");
    expect(plan.sourceId).toBe("rule-gated");

    // Delivering records the suggestion; nothing is executed on real state.
    const delivery = await coordinator.deliver(suggestions[0]!, NOW);
    expect(delivery.requiredApproval).toBe(true);
    expect(await deliveries.listByOrg("org-1")).toHaveLength(1);
  });

  it("includes due self-wakes and overdue activities as suggestions", async () => {
    const { wakes, activities, coordinator } = build();
    await wakes.addTimer("session-1", new Date("2026-08-17T10:00:00Z"), {
      proactiveText: "Follow up on the customer invoice",
    });
    await activities.create({
      organizationId: "org-1",
      kind: "follow_up",
      title: "Chase invoice payment",
      createdByUserId: "user-1",
      dueAt: "2026-08-16T09:00:00Z",
      assigneeUserId: "user-1",
    });

    const suggestions = await coordinator.collect("org-1", NOW);
    const kinds = suggestions.map((s) => s.kind).sort();
    expect(kinds).toEqual(["overdue_activity", "wake"]);
    const wake = suggestions.find((s) => s.kind === "wake")!;
    expect(wake.proposedAction).toBe("Follow up on the customer invoice");
    const activity = suggestions.find((s) => s.kind === "overdue_activity")!;
    expect(activity.targetUserIds).toEqual(["user-1"]);
    expect(activity.requiredApproval).toBe(false);
  });

  it("applies quiet hours and the daily cap when delivering due items", async () => {
    const { watchRules, preferences, coordinator, deliveries } = build();
    await watchRules.create(ruleFixture({ id: "rule-qh" }));
    await preferences.set({
      organizationId: "org-1",
      quietHours: { start: "22:00", end: "07:00", timezone: "UTC" },
      maxSuggestionsPerDay: 1,
    });

    // 23:00 is inside quiet hours → suppressed, but still recorded for audit.
    const night = await coordinator.deliverDue("org-1", new Date("2026-08-17T23:00:00Z"));
    expect(night[0]?.suppressed).toBe(true);
    expect(night[0]?.suppressionReason).toBe("quiet_hours");
    expect(await deliveries.listByOrg("org-1")).toHaveLength(1);

    // Delivery (even suppressed) advances the cursor — the same occurrence
    // does not pile up on the next tick.
    const again = await coordinator.deliverDue("org-1", new Date("2026-08-17T23:30:00Z"));
    expect(again).toHaveLength(0);

    // Outside quiet hours with a per-day cap of 1: the first distinct item
    // delivers, the second is capped.
    const prefs = await preferences.get("org-1");
    prefs.quietHours = undefined;
    await preferences.set(prefs);
    const at = new Date("2026-08-18T12:00:00Z");
    const ok = await coordinator.deliver(suggestionFixture({ dedupeKey: "cap:a", sourceId: "a" }), at, prefs);
    expect(ok.suppressed).toBe(false);
    const capped = await coordinator.deliver(suggestionFixture({ dedupeKey: "cap:b", sourceId: "b" }), at, prefs);
    expect(capped.suppressed).toBe(true);
    expect(capped.suppressionReason).toBe("daily_cap");
  });
});
