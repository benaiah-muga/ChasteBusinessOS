import { describe, expect, it } from "vitest";
import {
  InMemoryTaskStore,
  canTransition,
  readyTasks,
  taskBlockers,
  type Task,
  type TaskStore,
} from "./tasks.js";

const NOW = () => new Date("2026-01-01T00:00:00Z");

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    organizationId: "org-1",
    title: "Approve payroll",
    createdByUserId: "ai-1",
    status: "pending",
    priority: "normal",
    dependsOn: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("dependency graph", () => {
  it("taskBlockers lists dependencies that are not terminal", () => {
    const dep = baseTask({ id: "dep", status: "completed" });
    const waiting = baseTask({ id: "t", dependsOn: ["dep", "missing"] });
    expect(taskBlockers(waiting, [dep, waiting])).toEqual(["missing"]);

    const depCancelled = baseTask({ id: "dep2", status: "cancelled" });
    expect(taskBlockers(baseTask({ id: "t2", dependsOn: ["dep2"] }), [depCancelled])).toEqual([]);
  });

  it("completed/cancelled tasks are never blocked", () => {
    const t = baseTask({ status: "completed", dependsOn: ["missing"] });
    expect(taskBlockers(t, [t])).toEqual([]);
  });
});

describe("readyTasks (work queue)", () => {
  it("excludes tasks with uncompleted dependencies", () => {
    const dep = baseTask({ id: "dep", status: "pending" });
    const waiting = baseTask({ id: "wait", dependsOn: ["dep"] });
    const free = baseTask({ id: "free" });
    const ready = readyTasks([dep, waiting, free]);
    const ids = ready.map((t) => t.id);
    expect(ids).not.toContain("wait");
    expect(new Set(ids)).toEqual(new Set(["free", "dep"]));
  });

  it("orders by due date first, then priority", () => {
    const late = baseTask({ id: "late", dueAt: "2026-01-10T00:00:00Z", priority: "low" });
    const soon = baseTask({ id: "soon", dueAt: "2026-01-02T00:00:00Z", priority: "normal" });
    const urgentNoDue = baseTask({ id: "urgent", priority: "urgent" });
    const ready = readyTasks([late, soon, urgentNoDue]);
    expect(ready.map((t) => t.id)).toEqual(["soon", "late", "urgent"]);
  });
});

describe("canTransition", () => {
  it("blocks starting or completing when dependencies are unmet", () => {
    const dep = baseTask({ id: "dep", status: "pending" });
    const t = baseTask({ id: "t", dependsOn: ["dep"] });
    expect(canTransition(t, "in_progress", [dep, t])).toEqual({
      ok: false,
      reason: "blocked by dep",
    });
    expect(canTransition(t, "completed", [dep, t]).ok).toBe(false);
  });

  it("allows blocking regardless of dependencies", () => {
    const dep = baseTask({ id: "dep", status: "pending" });
    const t = baseTask({ id: "t", dependsOn: ["dep"] });
    expect(canTransition(t, "blocked", [dep, t])).toEqual({ ok: true });
  });

  it("refuses transitions off a final state", () => {
    const t = baseTask({ status: "completed" });
    expect(canTransition(t, "pending", [t])).toEqual({
      ok: false,
      reason: "task is already completed",
    });
  });
});

describe("InMemoryTaskStore", () => {
  it("creates, lists, and transitions", async () => {
    const store: TaskStore = new InMemoryTaskStore({ now: NOW });
    const dep = await store.create({
      organizationId: "org-1",
      title: "Collect approvals",
      createdByUserId: "ai-1",
    });
    const t = await store.create({
      organizationId: "org-1",
      workflowId: "wf-1",
      title: "Post journal",
      createdByUserId: "ai-1",
      assigneeUserId: "human-1",
      dependsOn: [dep.id],
      priority: "high",
      dueAt: "2026-01-02T09:00:00Z",
    });

    // Blocked until the dependency completes.
    const blocked = await store.transition("org-1", t.id, "in_progress");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toContain(dep.id);

    await store.transition("org-1", dep.id, "completed");
    const started = await store.transition("org-1", t.id, "in_progress");
    expect(started.ok).toBe(true);

    const queue = await store.workQueue("org-1");
    expect(queue.map((x) => x.id)).not.toContain(t.id); // in_progress, not pending
  });

  it("completes once and records timestamps", async () => {
    const store: TaskStore = new InMemoryTaskStore({ now: NOW });
    const t = await store.create({
      organizationId: "org-1",
      title: "Post journal",
      createdByUserId: "ai-1",
    });
    const first = await store.transition("org-1", t.id, "completed");
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.task.completedAt).toBeTruthy();

    const second = await store.transition("org-1", t.id, "cancelled");
    expect(second.ok).toBe(false);
  });

  it("records blocker reasons and cannot cross organizations", async () => {
    const store: TaskStore = new InMemoryTaskStore({ now: NOW });
    const t = await store.create({
      organizationId: "org-1",
      title: "Escalate",
      createdByUserId: "ai-1",
    });
    const blocked = await store.transition("org-1", t.id, "blocked", { reason: "approval overdue" });
    expect(blocked.ok).toBe(true);
    if (blocked.ok) expect(blocked.task.blockedReason).toBe("approval overdue");

    expect((await store.transition("org-other", t.id, "completed")).ok).toBe(false);
  });
});