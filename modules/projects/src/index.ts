import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { projectTasks, projects } from "@chaste/db";
import { withOrgContext } from "@chaste/db";
import type { Database } from "@chaste/db";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";

/**
 * Projects (M11, ADR 0038): a small, standalone module — projects with
 * kanban tasks, subtasks via parent links, assignment, due dates,
 * priorities, and explicit column ordering. No cross-module imports: it
 * works in a subset org with every other module disabled.
 */

export interface ModuleDeps {
  db: Database["db"];
}

const TASK_STATUSES = ["todo", "doing", "done"] as const;
const TASK_PRIORITIES = ["low", "medium", "high"] as const;

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
      buildInput: (_input, output) => ({ projectId: (output as { projectId: string }).projectId }),
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
    output: z.object({ archived: z.literal(true) }),
    execute: async (ctx, input) => {
      const updated = await deps.db
        .update(projects)
        .set({ status: "archived" })
        .where(and(eq(projects.id, input.projectId), eq(projects.orgId, ctx.actor.orgId)))
        .returning({ id: projects.id });
      if (updated.length === 0) throw new Error("project not found");
      return { archived: true as const };
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
    output: z.object({ taskId: z.string() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [project] = await tx
          .select({ id: projects.id, status: projects.status })
          .from(projects)
          .where(and(eq(projects.id, input.projectId), eq(projects.orgId, ctx.actor.orgId)))
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
          .returning({ id: projectTasks.id });
        return { taskId: row!.id };
      });
    },
  });

const moveTask = (deps: ModuleDeps) =>
  defineCapability({
    id: "projects.moveTask",
    title: "Move task",
    intent: "Drag a task across the board — todo, doing, done — with an explicit column position",
    module: "projects",
    risk: "write",
    permission: "projects.write",
    input: z.object({
      taskId: z.string().uuid(),
      status: z.enum(TASK_STATUSES),
      position: z.number().int().nonnegative().optional(),
    }),
    output: z.object({ moved: z.literal(true), status: z.string() }),
    execute: async (ctx, input) => {
      const updated = await deps.db
        .update(projectTasks)
        .set({
          status: input.status,
          ...(input.position !== undefined ? { position: input.position } : {}),
        })
        .where(and(eq(projectTasks.id, input.taskId), eq(projectTasks.orgId, ctx.actor.orgId)))
        .returning({ id: projectTasks.id });
      if (updated.length === 0) throw new Error("task not found");
      return { moved: true as const, status: input.status };
    },
  });

const assignTask = (deps: ModuleDeps) =>
  defineCapability({
    id: "projects.assignTask",
    title: "Assign task",
    intent: "Put a named person on a task so ownership is never ambiguous",
    module: "projects",
    risk: "write",
    permission: "projects.write",
    input: z.object({ taskId: z.string().uuid(), assigneeUserId: z.string().uuid().optional() }),
    output: z.object({ assigned: z.literal(true) }),
    execute: async (ctx, input) => {
      const updated = await deps.db
        .update(projectTasks)
        .set({ assigneeUserId: input.assigneeUserId ?? null })
        .where(and(eq(projectTasks.id, input.taskId), eq(projectTasks.orgId, ctx.actor.orgId)))
        .returning({ id: projectTasks.id });
      if (updated.length === 0) throw new Error("task not found");
      return { assigned: true as const };
    },
  });

const listBoard = (deps: ModuleDeps) =>
  defineCapability({
    id: "projects.listBoard",
    title: "Project board",
    intent: "Render a project's kanban board — every task with its column, position, assignee, due date, and priority",
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
  registry.register(createTask(deps));
  registry.register(moveTask(deps));
  registry.register(assignTask(deps));
  registry.register(listBoard(deps));
}
