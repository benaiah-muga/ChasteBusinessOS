import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { projectTasks, projects } from "@chaste/db";
import { withOrgContext } from "@chaste/db";
import type { Database } from "@chaste/db";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";

/**
 * Projects (M11, ADR 0038): a small, standalone module - projects with
 * kanban tasks, subtasks via parent links, assignment, due dates,
 * priorities, and explicit column ordering. No cross-module imports: it
 * works in a subset org with every other module disabled.
 */

export interface ModuleDeps {
  db: Database["db"];
}

const TASK_STATUSES = ["todo", "doing", "done"] as const;
const TASK_PRIORITIES = ["low", "medium", "high"] as const;
const ProjectTaskSnapshotSchema = z.object({
  taskId: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string(),
  parentTaskId: z.string().uuid().nullable(),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES),
  assigneeUserId: z.string().uuid().nullable(),
  dueAt: z.string().datetime().nullable(),
  position: z.number().int().nonnegative(),
  note: z.string().nullable(),
  createdAt: z.string().datetime(),
});
const projectTaskSnapshot = (row: typeof projectTasks.$inferSelect) => ({
  taskId: row.id,
  projectId: row.projectId,
  title: row.title,
  parentTaskId: row.parentTaskId,
  status: row.status as (typeof TASK_STATUSES)[number],
  priority: row.priority as (typeof TASK_PRIORITIES)[number],
  assigneeUserId: row.assigneeUserId,
  dueAt: row.dueAt?.toISOString() ?? null,
  position: row.position,
  note: row.note,
  createdAt: row.createdAt.toISOString(),
});

const createProject = (deps: ModuleDeps) =>
  defineCapability({
    id: "projects.createProject",
    title: "Create project",
    intent: "Start a project with a name and an optional due date so work has a home and a deadline",
    module: "projects",
    risk: "write",
    permission: "projects.write",
    inverse: {
      capabilityId: "projects.archiveProject",
      buildInput: (_input, output) => ({ projectId: output.projectId }),
    },
    input: z.object({ name: z.string().min(1).max(120), dueAt: z.string().datetime().optional() }),
    output: z.object({ projectId: z.string() }),
    execute: async (ctx, input) => {
      const [row] = await deps.db
        .insert(projects)
        .values({
          orgId: ctx.actor.orgId,
          name: input.name,
          dueAt: input.dueAt ? new Date(input.dueAt) : null,
          createdByActorType: ctx.actor.type,
          createdByActorId: ctx.actor.id,
        })
        .returning({ id: projects.id });
      return { projectId: row!.id };
    },
  });

const archiveProject = (deps: ModuleDeps) =>
  defineCapability({
    id: "projects.archiveProject",
    title: "Archive project",
    intent: "Retire a finished or abandoned project; its history stays queryable",
    module: "projects",
    risk: "write",
    permission: "projects.write",
    input: z.object({ projectId: z.string().uuid() }),
    inverse: {
      capabilityId: "projects.restoreProject",
      buildInput: (_input, output) => ({ projectId: output.projectId }),
    },
    output: z.object({ archived: z.literal(true), projectId: z.string().uuid() }),
    execute: async (ctx, input) => {
      const updated = await deps.db
        .update(projects)
        .set({ status: "archived" })
        .where(and(eq(projects.id, input.projectId), eq(projects.orgId, ctx.actor.orgId)))
        .returning({ id: projects.id });
      if (updated.length === 0) throw new Error("project not found");
      return { archived: true as const, projectId: updated[0]!.id };
    },
  });

const restoreProject = (deps: ModuleDeps) =>
  defineCapability({
    id: "projects.restoreProject",
    title: "Restore project",
    intent: "Restore a project that was archived by its matching project action",
    module: "projects",
    risk: "write",
    permission: "projects.write",
    inverse: { capabilityId: "projects.archiveProject", buildInput: (_input, output) => ({ projectId: output.projectId }) },
    input: z.object({ projectId: z.string().uuid() }),
    output: z.object({ projectId: z.string().uuid(), restored: z.literal(true) }),
    execute: async (ctx, input) => {
      const updated = await deps.db.update(projects).set({ status: "active" })
        .where(and(eq(projects.id, input.projectId), eq(projects.orgId, ctx.actor.orgId), eq(projects.status, "archived")))
        .returning({ id: projects.id });
      if (updated.length === 0) throw new Error("archived project not found");
      return { projectId: updated[0]!.id, restored: true as const };
    },
  });

const createTask = (deps: ModuleDeps) =>
  defineCapability({
    id: "projects.createTask",
    title: "Create project task",
    intent:
      "Add a task (or a subtask under a parent) to a project with an assignee, due date, and priority, positioned in its kanban column",
    module: "projects",
    risk: "write",
    permission: "projects.write",
    input: z.object({
      projectId: z.string().uuid(),
      title: z.string().min(1).max(200),
      parentTaskId: z.string().uuid().optional(),
      assigneeUserId: z.string().uuid().optional(),
      dueAt: z.string().datetime().optional(),
      priority: z.enum(TASK_PRIORITIES).optional(),
    }),
    inverse: { capabilityId: "projects.deleteTask", buildInput: (_input, output) => output },
    output: ProjectTaskSnapshotSchema,
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [project] = await tx
          .select({ id: projects.id, status: projects.status })
          .from(projects)
          .where(and(eq(projects.id, input.projectId), eq(projects.orgId, ctx.actor.orgId)))
          .for("update")
          .limit(1);
        if (!project) throw new Error("project not found");
        if (project.status !== "active") throw new Error("project is not active");
        if (input.parentTaskId) {
          const [parent] = await tx
            .select({ id: projectTasks.id, projectId: projectTasks.projectId })
            .from(projectTasks)
            .where(and(eq(projectTasks.id, input.parentTaskId), eq(projectTasks.orgId, ctx.actor.orgId)))
            .limit(1);
          if (!parent) throw new Error("parent task not found");
          if (parent.projectId !== input.projectId) throw new Error("parent task belongs to a different project");
        }
        const [agg] = await tx
          .select({ maxPos: sql<number>`coalesce(max(${projectTasks.position}), 0)` })
          .from(projectTasks)
          .where(and(eq(projectTasks.projectId, input.projectId), eq(projectTasks.status, "todo")));
        const [row] = await tx
          .insert(projectTasks)
          .values({
            orgId: ctx.actor.orgId,
            projectId: input.projectId,
            parentTaskId: input.parentTaskId ?? null,
            title: input.title,
            priority: input.priority ?? "medium",
            assigneeUserId: input.assigneeUserId ?? null,
            dueAt: input.dueAt ? new Date(input.dueAt) : null,
            position: Number(agg?.maxPos ?? 0) + 1,
          })
          .returning();
        return projectTaskSnapshot(row!);
      });
    },
  });

const deleteTask = (deps: ModuleDeps) =>
  defineCapability({
    id: "projects.deleteTask",
    title: "Delete task",
    intent: "Remove a task only when its complete saved snapshot is unchanged and it has no children",
    module: "projects",
    risk: "destructive",
    permission: "projects.write",
    inverse: { capabilityId: "projects.restoreTask", buildInput: (_input, output) => output },
    input: ProjectTaskSnapshotSchema,
    output: ProjectTaskSnapshotSchema,
    execute: async (ctx, input) => withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
      const [row] = await tx.select().from(projectTasks).where(and(eq(projectTasks.id, input.taskId), eq(projectTasks.orgId, ctx.actor.orgId))).for("update").limit(1);
      if (!row || JSON.stringify(projectTaskSnapshot(row)) !== JSON.stringify(input)) throw new Error("task changed or has child tasks");
      const [child] = await tx.select({ id: projectTasks.id }).from(projectTasks).where(and(eq(projectTasks.parentTaskId, input.taskId), eq(projectTasks.orgId, ctx.actor.orgId))).limit(1);
      if (child) throw new Error("task changed or has child tasks");
      await tx.delete(projectTasks).where(and(eq(projectTasks.id, input.taskId), eq(projectTasks.orgId, ctx.actor.orgId)));
      return projectTaskSnapshot(row);
    }),
  });

const restoreTask = (deps: ModuleDeps) =>
  defineCapability({
    id: "projects.restoreTask",
    title: "Restore task",
    intent: "Restore the exact task row removed by its matching guarded delete action",
    module: "projects",
    risk: "write",
    permission: "projects.write",
    inverse: { capabilityId: "projects.deleteTask", buildInput: (_input, output) => output },
    input: ProjectTaskSnapshotSchema,
    output: ProjectTaskSnapshotSchema,
    execute: async (ctx, input) => withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
      const [project] = await tx.select({ status: projects.status }).from(projects).where(and(eq(projects.id, input.projectId), eq(projects.orgId, ctx.actor.orgId))).limit(1);
      if (!project) throw new Error("project not found");
      if (project.status !== "active") throw new Error("project is not active");
      if (input.parentTaskId) {
        const [parent] = await tx.select({ projectId: projectTasks.projectId }).from(projectTasks).where(and(eq(projectTasks.id, input.parentTaskId), eq(projectTasks.orgId, ctx.actor.orgId))).limit(1);
        if (!parent || parent.projectId !== input.projectId) throw new Error("parent task not found in project");
      }
      const [row] = await tx.insert(projectTasks).values({
        id: input.taskId, orgId: ctx.actor.orgId, projectId: input.projectId, parentTaskId: input.parentTaskId,
        title: input.title, status: input.status, priority: input.priority, assigneeUserId: input.assigneeUserId,
        dueAt: input.dueAt ? new Date(input.dueAt) : null, position: input.position, note: input.note, createdAt: new Date(input.createdAt),
      }).returning();
      return projectTaskSnapshot(row!);
    }),
  });

const moveTask = (deps: ModuleDeps) =>
  defineCapability({
    id: "projects.moveTask",
    title: "Move task",
    intent: "Drag a task across the board - todo, doing, done - with an explicit column position",
    module: "projects",
    risk: "write",
    permission: "projects.write",
    inverse: { capabilityId: "projects.restoreTaskPlacement", buildInput: (_input, output) => output },
    input: z.object({
      taskId: z.string().uuid(),
      status: z.enum(TASK_STATUSES),
      position: z.number().int().nonnegative().optional(),
    }),
    output: z.object({
      moved: z.literal(true), status: z.string(), position: z.number().int().nonnegative(), taskId: z.string().uuid(),
      restoreStatus: z.enum(TASK_STATUSES), restorePosition: z.number().int().nonnegative(),
      expectedStatus: z.enum(TASK_STATUSES), expectedPosition: z.number().int().nonnegative(),
    }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [task] = await tx
          .select({ projectStatus: projects.status, status: projectTasks.status, position: projectTasks.position })
          .from(projectTasks)
          .innerJoin(projects, and(eq(projects.id, projectTasks.projectId), eq(projects.orgId, projectTasks.orgId)))
          .where(and(eq(projectTasks.id, input.taskId), eq(projectTasks.orgId, ctx.actor.orgId)))
          .for("update", { of: projects })
          .limit(1);
        if (!task) throw new Error("task not found");
        if (task.projectStatus !== "active") throw new Error("project is not active");

        const nextPosition = input.position ?? task.position;
        await tx
          .update(projectTasks)
          .set({
            status: input.status,
            ...(input.position !== undefined ? { position: input.position } : {}),
          })
          .where(and(eq(projectTasks.id, input.taskId), eq(projectTasks.orgId, ctx.actor.orgId)));
        return {
          moved: true as const, status: input.status, position: nextPosition, taskId: input.taskId,
          restoreStatus: task.status as (typeof TASK_STATUSES)[number], restorePosition: task.position,
          expectedStatus: input.status, expectedPosition: nextPosition,
        };
      });
    },
  });

const RestoreTaskPlacementSchema = z.object({
  taskId: z.string().uuid(), restoreStatus: z.enum(TASK_STATUSES), restorePosition: z.number().int().nonnegative(),
  expectedStatus: z.enum(TASK_STATUSES), expectedPosition: z.number().int().nonnegative(),
});
const restoreTaskPlacement = (deps: ModuleDeps) =>
  defineCapability({
    id: "projects.restoreTaskPlacement",
    title: "Restore task placement",
    intent: "Restore a task column and position only while it still has the expected placement",
    module: "projects",
    risk: "write",
    permission: "projects.write",
    inverse: { capabilityId: "projects.moveTask", buildInput: (_input, output) => ({ taskId: output.taskId, status: output.expectedStatus, position: output.expectedPosition }) },
    input: RestoreTaskPlacementSchema,
    output: RestoreTaskPlacementSchema.extend({ moved: z.literal(true), status: z.enum(TASK_STATUSES), position: z.number().int().nonnegative() }),
    execute: async (ctx, input) => withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
      const [task] = await tx.select({ id: projectTasks.id, projectStatus: projects.status })
        .from(projectTasks).innerJoin(projects, and(eq(projects.id, projectTasks.projectId), eq(projects.orgId, projectTasks.orgId)))
        .where(and(eq(projectTasks.id, input.taskId), eq(projectTasks.orgId, ctx.actor.orgId))).for("update", { of: projects }).limit(1);
      if (!task) throw new Error("task not found");
      if (task.projectStatus !== "active") throw new Error("project is not active");
      const changed = await tx.update(projectTasks).set({ status: input.restoreStatus, position: input.restorePosition })
        .where(and(eq(projectTasks.id, input.taskId), eq(projectTasks.orgId, ctx.actor.orgId), eq(projectTasks.status, input.expectedStatus), eq(projectTasks.position, input.expectedPosition)))
        .returning({ id: projectTasks.id });
      if (!changed.length) throw new Error("task placement changed since this action");
      return { moved: true as const, taskId: input.taskId, status: input.expectedStatus, position: input.expectedPosition,
        restoreStatus: input.expectedStatus, restorePosition: input.expectedPosition,
        expectedStatus: input.restoreStatus, expectedPosition: input.restorePosition };
    }),
  });

const assignTask = (deps: ModuleDeps) =>
  defineCapability({
    id: "projects.assignTask",
    title: "Assign task",
    intent: "Put a named person on a task so ownership is never ambiguous",
    module: "projects",
    risk: "write",
    permission: "projects.write",
    inverse: { capabilityId: "projects.restoreTaskAssignment", buildInput: (_input, output) => output },
    input: z.object({ taskId: z.string().uuid(), assigneeUserId: z.string().uuid().optional() }),
    output: z.object({ assigned: z.literal(true), taskId: z.string().uuid(), restoreAssigneeUserId: z.string().uuid().nullable(), expectedAssigneeUserId: z.string().uuid().nullable() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [task] = await tx
          .select({ projectStatus: projects.status, assigneeUserId: projectTasks.assigneeUserId })
          .from(projectTasks)
          .innerJoin(projects, and(eq(projects.id, projectTasks.projectId), eq(projects.orgId, projectTasks.orgId)))
          .where(and(eq(projectTasks.id, input.taskId), eq(projectTasks.orgId, ctx.actor.orgId)))
          .for("update", { of: projects })
          .limit(1);
        if (!task) throw new Error("task not found");
        if (task.projectStatus !== "active") throw new Error("project is not active");

        await tx
          .update(projectTasks)
          .set({ assigneeUserId: input.assigneeUserId ?? null })
          .where(and(eq(projectTasks.id, input.taskId), eq(projectTasks.orgId, ctx.actor.orgId)));
        return { assigned: true as const, taskId: input.taskId, restoreAssigneeUserId: task.assigneeUserId,
          expectedAssigneeUserId: input.assigneeUserId ?? null };
      });
    },
  });

const RestoreTaskAssignmentSchema = z.object({
  taskId: z.string().uuid(), restoreAssigneeUserId: z.string().uuid().nullable(), expectedAssigneeUserId: z.string().uuid().nullable(),
});
const restoreTaskAssignment = (deps: ModuleDeps) =>
  defineCapability({
    id: "projects.restoreTaskAssignment",
    title: "Restore task assignment",
    intent: "Restore task ownership only while the current assignee still matches the expected value",
    module: "projects",
    risk: "write",
    permission: "projects.write",
    inverse: { capabilityId: "projects.assignTask", buildInput: (_input, output) => ({ taskId: output.taskId, assigneeUserId: output.expectedAssigneeUserId ?? undefined }) },
    input: RestoreTaskAssignmentSchema,
    output: RestoreTaskAssignmentSchema.extend({ assigned: z.literal(true), assigneeUserId: z.string().uuid().nullable() }),
    execute: async (ctx, input) => withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
      const [task] = await tx.select({ projectStatus: projects.status }).from(projectTasks)
        .innerJoin(projects, and(eq(projects.id, projectTasks.projectId), eq(projects.orgId, projectTasks.orgId)))
        .where(and(eq(projectTasks.id, input.taskId), eq(projectTasks.orgId, ctx.actor.orgId))).for("update", { of: projects }).limit(1);
      if (!task) throw new Error("task not found");
      if (task.projectStatus !== "active") throw new Error("project is not active");
      const current = input.expectedAssigneeUserId === null ? sql`${projectTasks.assigneeUserId} is null` : eq(projectTasks.assigneeUserId, input.expectedAssigneeUserId);
      const changed = await tx.update(projectTasks).set({ assigneeUserId: input.restoreAssigneeUserId })
        .where(and(eq(projectTasks.id, input.taskId), eq(projectTasks.orgId, ctx.actor.orgId), current)).returning({ id: projectTasks.id });
      if (!changed.length) throw new Error("task assignment changed since this action");
      return { assigned: true as const, taskId: input.taskId, assigneeUserId: input.expectedAssigneeUserId,
        restoreAssigneeUserId: input.expectedAssigneeUserId,
        expectedAssigneeUserId: input.restoreAssigneeUserId };
    }),
  });

const listBoard = (deps: ModuleDeps) =>
  defineCapability({
    id: "projects.listBoard",
    title: "Project board",
    intent: "Render a project's kanban board - every task with its column, position, assignee, due date, and priority",
    module: "projects",
    risk: "read",
    permission: "projects.read",
    input: z.object({ projectId: z.string().uuid() }),
    output: z.object({
      columns: z.array(
        z.object({
          status: z.string(),
          tasks: z.array(
            z.object({
              id: z.string(),
              title: z.string(),
              parentTaskId: z.string().nullable(),
              priority: z.string(),
              assigneeUserId: z.string().nullable(),
              dueAt: z.string().nullable(),
              position: z.number(),
            }),
          ),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const rows = await tx
          .select()
          .from(projectTasks)
          .where(and(eq(projectTasks.orgId, ctx.actor.orgId), eq(projectTasks.projectId, input.projectId)))
          .orderBy(asc(projectTasks.position));
        return {
          columns: TASK_STATUSES.map((status) => ({
            status,
            tasks: rows
              .filter((t) => t.status === status)
              .map((t) => ({
                id: t.id,
                title: t.title,
                parentTaskId: t.parentTaskId,
                priority: t.priority,
                assigneeUserId: t.assigneeUserId,
                dueAt: t.dueAt?.toISOString() ?? null,
                position: t.position,
              })),
          })),
        };
      });
    },
  });

export function registerProjectsCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(createProject(deps));
  registry.register(archiveProject(deps));
  registry.register(restoreProject(deps));
  registry.register(createTask(deps));
  registry.register(deleteTask(deps));
  registry.register(restoreTask(deps));
  registry.register(moveTask(deps));
  registry.register(restoreTaskPlacement(deps));
  registry.register(assignTask(deps));
  registry.register(restoreTaskAssignment(deps));
  registry.register(listBoard(deps));
}
