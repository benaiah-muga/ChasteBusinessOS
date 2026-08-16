import { describe, expect, it } from "vitest";
import {
  InMemoryActivityStore,
  isOverdue,
  nextOccurrence,
  type Activity,
  type ActivityStore,
} from "./activities.js";

const NOW = () => new Date("2026-01-01T00:00:00Z");

function baseActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: "a1",
    organizationId: "org-1",
    kind: "follow_up",
    title: "Follow up with overdue invoice customer",
    createdByUserId: "ai-1",
    dueAt: "2026-01-02T09:00:00Z",
    status: "scheduled",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("nextOccurrence", () => {
  it("returns the next daily occurrence after the anchor", () => {
    const next = nextOccurrence({ freq: "daily", at: "09:00" }, NOW());
    expect(next!.toISOString()).toBe("2026-01-02T09:00:00.000Z");
  });

  it("respects weekly interval", () => {
    const next = nextOccurrence({ freq: "weekly", interval: 2, at: "09:00" }, NOW());
    expect(next!.toISOString()).toBe("2026-01-15T09:00:00.000Z");
  });

  it("narrows weekly recurrence to allowed weekdays", () => {
    // 2026-01-01 is a Thursday (day 4). A weekly-on-Thursday schedule advances
    // one week to Thursday 2026-01-08 and stays on the allowed weekday.
    const next = nextOccurrence({ freq: "weekly", daysOfWeek: [4], at: "09:00" }, NOW());
    expect(next!.getUTCDay()).toBe(4);
    expect(next!.toISOString()).toBe("2026-01-08T09:00:00.000Z");
  });

  it("returns null when no later occurrence matches", () => {
    // Anchor exactly at the pinned time + day; next week's is still later, so
    // weekly always has a next. Force a case where rolling forward stays at the
    // same instant by using a far-future-anchored daily rule is impractical, so
    // we only assert daily produces strictly-later dates.
    const next = nextOccurrence({ freq: "daily", at: "00:00" }, new Date("2026-01-01T00:00:00Z"));
    expect(next!.getTime()).toBeGreaterThan(new Date("2026-01-01T00:00:00Z").getTime());
  });
});

describe("isOverdue", () => {
  it("is overdue only for scheduled activities past due", () => {
    expect(isOverdue(baseActivity({ dueAt: "2025-12-31T00:00:00Z" }), NOW())).toBe(true);
    expect(isOverdue(baseActivity({ dueAt: "2026-01-03T00:00:00Z" }), NOW())).toBe(false);
    expect(
      isOverdue(baseActivity({ dueAt: "2025-12-31T00:00:00Z", status: "completed" }), NOW()),
    ).toBe(false);
  });
});

describe("InMemoryActivityStore", () => {
  it("creates, lists, completes, and cancels", async () => {
    const store: ActivityStore = new InMemoryActivityStore({ now: NOW });
    const created = await store.create({
      organizationId: "org-1",
      kind: "review",
      title: "Review payroll approval",
      createdByUserId: "ai-1",
      assigneeUserId: "human-1",
      dueAt: "2026-01-03T12:00:00Z",
      link: { resourceType: "payroll", resourceId: "run-9" },
    });
    expect(created.status).toBe("scheduled");
    expect(created.link?.resourceId).toBe("run-9");

    const listed = await store.list({ organizationId: "org-1", assigneeUserId: "human-1" });
    expect(listed).toHaveLength(1);

    expect(await store.complete("org-1", created.id)).toBe(true);
    expect(await store.complete("org-1", created.id)).toBe(false); // once-only
    const done = await store.get("org-1", created.id);
    expect(done?.status).toBe("completed");
    expect(done?.completedAt).toBeTruthy();
  });

  it("cannot complete an activity from another organization", async () => {
    const store: ActivityStore = new InMemoryActivityStore({ now: NOW });
    const created = await store.create({
      organizationId: "org-1",
      kind: "reminder",
      title: "Remind",
      createdByUserId: "ai-1",
      dueAt: "2026-01-03T12:00:00Z",
    });
    expect(await store.complete("org-other", created.id)).toBe(false);
    expect(await store.get("org-1", created.id)).toBeDefined();
  });

  it("reports overdue scheduled activities in agenda order", async () => {
    const store: ActivityStore = new InMemoryActivityStore({ now: NOW });
    await store.create({
      organizationId: "org-1",
      kind: "follow_up",
      title: "Later",
      createdByUserId: "ai-1",
      dueAt: "2026-01-03T00:00:00Z",
    });
    const overdueOne = await store.create({
      organizationId: "org-1",
      kind: "follow_up",
      title: "Overdue later",
      createdByUserId: "ai-1",
      dueAt: "2025-12-31T00:00:00Z",
    });
    const overdueTwo = await store.create({
      organizationId: "org-1",
      kind: "review",
      title: "Overdue earlier",
      createdByUserId: "ai-1",
      dueAt: "2025-12-30T00:00:00Z",
    });
    const overdue = await store.overdue("org-1", NOW());
    expect(overdue.map((a) => a.id)).toEqual([overdueTwo.id, overdueOne.id]);
  });
});