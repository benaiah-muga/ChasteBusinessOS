import {
  createCommandRegistry,
  createQueryRegistry,
  createRequestContext,
  executeCommand,
  executeQuery,
  InMemoryActivityStore,
  InMemoryApprovalGrantStore,
  InMemoryAuditWriter,
  InMemoryOutboxWriter,
  InMemoryTaskStore,
} from "@chaste/kernel";
import type { Actor, CommandHelpers, RequestContext } from "@chaste/kernel";
import { beforeEach, describe, expect, it } from "vitest";
import { createWorkflowTasksModule } from "./index.js";

const now = () => new Date("2026-08-16T10:00:00Z");

let commands: ReturnType<typeof createCommandRegistry>;
let queries: ReturnType<typeof createQueryRegistry>;
let activities: InMemoryActivityStore;
let tasks: InMemoryTaskStore;

function actor(permissions: string[]): Actor {
  return { kind: "user", userId: "u1", organizationId: "o1", permissions: new Set(permissions) };
}

function requestCtx(permissions: string[]): RequestContext {
  return createRequestContext({
    actor: actor(permissions),
    requestId: "req-1",
    now,
    origin: "agent",
    reason: "test",
  });
}

function helpers(): CommandHelpers {
  return { audit: new InMemoryAuditWriter(), outbox: new InMemoryOutboxWriter() };
}

type SafeResult<T> =
  | { ok: true; data: T }
  | { ok: false; errorMessage: string };

async function run<T = unknown>(name: string, input: unknown, permissions: string[]): Promise<SafeResult<T>> {
  try {
    const result = await executeCommand<T>(commands, name, input, requestCtx(permissions), helpers());
    return { ok: true, data: result.data };
  } catch (err) {
    return { ok: false, errorMessage: err instanceof Error ? err.message : String(err) };
  }
}

async function ask<T = unknown>(name: string, input: unknown, permissions: string[]): Promise<SafeResult<T>> {
  try {
    const result = await executeQuery<T>(queries, name, input, requestCtx(permissions));
    return { ok: true, data: result.data };
  } catch (err) {
    return { ok: false, errorMessage: err instanceof Error ? err.message : String(err) };
  }
}

beforeEach(async () => {
  commands = createCommandRegistry();
  queries = createQueryRegistry();
  activities = new InMemoryActivityStore({ now });
  tasks = new InMemoryTaskStore({ now });
  const module = createWorkflowTasksModule({ activities, tasks });
  await module.register({ commands, queries });
});

describe("manifest and permissions", () => {
  it("registers the expected permissions and capabilities", () => {
    const manifest = createWorkflowTasksModule({ activities, tasks }).manifest;
    expect(manifest.id).toBe("workflow-tasks");
    expect(manifest.permissions).toEqual([
      "activities.read",
      "activities.write",
      "workflow.tasks.read",
      "workflow.tasks.write",
    ]);
    expect(manifest.capabilities).toEqual(["activities", "workflow.tasks"]);
    expect(commands.get("activities.create")).toBeDefined();
    expect(commands.get("workflow.tasks.complete")).toBeDefined();
    expect(queries.get("workflow.tasks.workQueue")).toBeDefined();
  });
});

describe("activities.* surface", () => {
  it("creates, lists, and completes an activity", async () => {
    const created = await run(
      "activities.create",
      {
        kind: "review",
        title: "Review payroll approval",
        dueAt: "2026-08-17T12:00:00Z",
        assigneeUserId: "11111111-1111-4111-8111-111111111111",
      },
      ["activities.write"],
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.kind).toBe("review");
    const id = created.data.id;

    const listed = await ask("activities.list", {}, ["activities.read"]);
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.data.activities).toHaveLength(1);

    const completed = await run("activities.complete", { activityId: id }, ["activities.write"]);
    expect(completed).toEqual({ ok: true, data: { completed: true } });

    const again = await run("activities.cancel", { activityId: id }, ["activities.write"]);
    expect(again.ok).toBe(false);
  });

  it("rejects unknown fields and reports overdue only for scheduled", async () => {
    await run("activities.create", { kind: "reminder", title: "Remind", dueAt: "2025-12-31T00:00:00Z" }, ["activities.write"]);
    const overdue = await ask("activities.overdue", {}, ["activities.read"]);
    expect(overdue.ok).toBe(true);
    if (overdue.ok) expect(overdue.data.overdue).toHaveLength(1);

    const invalid = await run(
      "activities.create",
      { kind: "reminder", title: "Remind", dueAt: "2025-12-31T00:00:00Z", stray: true },
      ["activities.write"],
    );
    expect(invalid.ok).toBe(false);
    expect(invalid.errorMessage).toContain("Invalid input");
  });
});

describe("workflow.tasks.* surface", () => {
  it("creates a task, enforces dependencies on complete, and completes", async () => {
    const dep = await run("workflow.tasks.create", { title: "Collect approvals" }, ["workflow.tasks.write"]);
    expect(dep.ok).toBe(true);
    if (!dep.ok) return;
    const t = await run(
      "workflow.tasks.create",
      { title: "Post journal", dependsOn: [dep.data.id], priority: "high" },
      ["workflow.tasks.write"],
    );
    expect(t.ok).toBe(true);
    if (!t.ok) return;

    const blocked = await run("workflow.tasks.complete", { taskId: t.data.id }, ["workflow.tasks.write"]);
    expect(blocked.ok).toBe(false);
    expect(blocked.errorMessage).toContain(dep.data.id);

    await run("workflow.tasks.complete", { taskId: dep.data.id }, ["workflow.tasks.write"]);
    const done = await run("workflow.tasks.complete", { taskId: t.data.id }, ["workflow.tasks.write"]);
    expect(done.ok).toBe(true);
    if (done.ok) expect(done.data.status).toBe("completed");
  });

  it("workQueue reports only ready pending tasks", async () => {
    await run("workflow.tasks.create", { title: "Ready task", priority: "urgent" }, ["workflow.tasks.write"]);
    const queue = await ask("workflow.tasks.workQueue", {}, ["workflow.tasks.read"]);
    expect(queue.ok).toBe(true);
    if (queue.ok) {
      expect(queue.data.tasks).toHaveLength(1);
      expect(queue.data.tasks[0].title).toBe("Ready task");
      expect(queue.data.tasks[0].priority).toBe("urgent");
    }
  });

  it("blocks with a recorded reason", async () => {
    const t = await run("workflow.tasks.create", { title: "Escalate" }, ["workflow.tasks.write"]);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    const blocked = await run("workflow.tasks.block", { taskId: t.data.id, reason: "approval overdue" }, ["workflow.tasks.write"]);
    expect(blocked.ok).toBe(true);
    if (blocked.ok) {
      expect(blocked.data.status).toBe("blocked");
      expect(blocked.data.blockedReason).toBe("approval overdue");
    }
  });

  it("enforces permission strings", async () => {
    const result = await run("activities.create", { kind: "review", title: "x", dueAt: "2026-08-17T00:00:00Z" }, []);
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain("permission");
  });
});

describe("AI/manual parity through the bus", () => {
  it("is reachable via the bus with envelope provenance", async () => {
    const c = requestCtx(["workflow.tasks.write"]);
    const result = await executeCommand<{ id: string; title: string }>(
      commands,
      "workflow.tasks.create",
      { title: "From the harness" },
      c,
      helpers(),
    );
    expect(result.ok).toBe(true);
    expect(result.data.title).toBe("From the harness");
    expect(await tasks.list({ organizationId: "o1" })).toHaveLength(1);
  });
});