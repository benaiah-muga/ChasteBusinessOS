import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, organizations, users, type Database } from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerProjectsCapabilities, type ModuleDeps } from "./index";

/**
 * Projects standalone proof (M11.5): the module depends on nothing but the
 * kernel and the db — it works in an org with no other module enabled.
 * Kanban moves are honest: states come from the fixed column set.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;
let userId: string;

function makeRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registerProjectsCapabilities(registry, deps);
  return registry;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads heterogeneous capability outputs; each assertion narrows its shape
async function run<I>(id: string, input: I): Promise<any> {
  const cap = makeRegistry().get(id);
  if (!cap) throw new Error(`missing capability ${id}`);
  return cap.execute(ctx, input);
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Projects Standalone Probe"));
  for (const o of orgs) await db.db.delete(organizations).where(eq(organizations.id, o.id));
  await db.db.insert(organizations).values({ id: orgId, name: "Projects Standalone Probe", slug: `pj-${orgId.slice(0, 8)}` });
  const [user] = await db.db.insert(users).values({ email: `pj-${Date.now()}@demo.test`, name: "Assignee" }).returning({ id: users.id });
  userId = user!.id;
  ctx = {
    actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };
});

afterAll(async () => {
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Projects Standalone Probe"));
  for (const o of orgs) await db.db.delete(organizations).where(eq(organizations.id, o.id));
});

describe("projects module (M11.5)", () => {
  it("kanban: create, assign, order, move, subtask", async () => {
    const project = await run("projects.createProject", {
      name: "Warehouse relayout",
      dueAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    const t1 = await run("projects.createTask", { projectId: project.projectId, title: "Measure the floor" });
    const t2 = await run("projects.createTask", { projectId: project.projectId, title: "Order racking" });
    await run("projects.createTask", { projectId: project.projectId, title: "Check rack bolts", parentTaskId: t2.taskId });

    await run("projects.assignTask", { taskId: t1.taskId, assigneeUserId: userId });
    await run("projects.moveTask", { taskId: t1.taskId, status: "doing", position: 1 });

    const board = await run("projects.listBoard", { projectId: project.projectId });
    const doing = board.columns.find((c: { status: string }) => c.status === "doing")!;
    expect(doing.tasks).toHaveLength(1);
    expect(doing.tasks[0]).toMatchObject({ id: t1.taskId, assigneeUserId: userId, position: 1 });
    const todo = board.columns.find((c: { status: string }) => c.status === "todo")!;
    expect(todo.tasks.map((t: { title: string }) => t.title)).toEqual(["Order racking", "Check rack bolts"]);
    const sub = todo.tasks.find((t: { title: string }) => t.title === "Check rack bolts")!;
    expect(sub.parentTaskId).toBe(t2.taskId);

    // done column starts empty and honestly so
    expect(board.columns.find((c: { status: string }) => c.status === "done")!.tasks).toHaveLength(0);
  });

  it("move rejects unknown tasks; archive stops new work", async () => {
    await expect(run("projects.moveTask", { taskId: crypto.randomUUID(), status: "done" })).rejects.toThrow(/not found/);
    const project = await run("projects.createProject", { name: "Short-lived" });
    await run("projects.archiveProject", { projectId: project.projectId });
    await expect(run("projects.createTask", { projectId: project.projectId, title: "Too late" })).rejects.toThrow(/not active/);
  });
});
