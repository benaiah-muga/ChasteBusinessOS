/**
 * Workflow Tasks & Activities — the command/query surface for the durable
 * `Activity` and `Task` foundations (research doc §Workflow, Approvals, and
 * Tasks Module + §Proactive Scheduling, Reminders, and Activities Module;
 * ADR 0014 tranche 5).
 *
 * Humans and agents exercise the same bus contract: `activities.*` and
 * `workflow.tasks.*` commands/queries dispatch through the kernel stores
 * (in-memory in tests, Postgres-backed in `@chaste/runtime`). The module owns
 * no storage — it layers Zod-validated boundaries over the store interfaces,
 * so AI/manual parity holds by construction and audit flows through the
 * command bus.
 */
import { ValidationError, defineCommand, defineQuery, type BusinessModule } from "@chaste/kernel";
import type {
  Activity,
  ActivityKind,
  ActivityLink,
  ActivityStore,
  RecurrenceRule,
  Task,
  TaskPriority,
  TaskStore,
  TaskStatus,
} from "@chaste/kernel";
import { z } from "zod";

const activityKindSchema = z.enum(["reminder", "follow_up", "review", "task", "notification"]);
const activityStatusSchema = z.enum(["scheduled", "completed", "cancelled"]);
const taskPrioritySchema = z.enum(["low", "normal", "high", "urgent"]);
const taskStatusSchema = z.enum(["pending", "in_progress", "blocked", "completed", "cancelled"]);
const recurrenceRuleSchema = z
  .object({
    freq: z.enum(["daily", "weekly", "monthly"]),
    interval: z.number().int().positive().optional(),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
    at: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  })
  .strict();

const linkSchema = z
  .object({ resourceType: z.string().min(1), resourceId: z.string().min(1) })
  .strict();

const isoDateSchema = z.string().refine((v) => Number.isFinite(Date.parse(v)), "must be an ISO timestamp");

const activityOutputSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  kind: activityKindSchema,
  title: z.string(),
  body: z.string().nullable(),
  assigneeUserId: z.string().nullable(),
  createdByUserId: z.string(),
  dueAt: z.string(),
  timezone: z.string().nullable(),
  recurrence: z.unknown().nullable(),
  link: linkSchema.nullable(),
  status: activityStatusSchema,
  completedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
type ActivityOutput = z.infer<typeof activityOutputSchema>;

const taskOutputSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  workflowId: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  assigneeUserId: z.string().nullable(),
  createdByUserId: z.string(),
  status: taskStatusSchema,
  priority: taskPrioritySchema,
  dueAt: z.string().nullable(),
  dependsOn: z.array(z.string()),
  blockedReason: z.string().nullable(),
  completedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
type TaskOutput = z.infer<typeof taskOutputSchema>;

function toActivityOutput(a: {
  id: string;
  organizationId: string;
  kind: ActivityKind;
  title: string;
  body?: string;
  assigneeUserId?: string;
  createdByUserId: string;
  dueAt: string;
  timezone?: string;
  recurrence?: RecurrenceRule;
  link?: ActivityLink;
  status: Activity["status"];
  completedAt?: string;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
}): ActivityOutput {
  return {
    id: a.id,
    organizationId: a.organizationId,
    kind: a.kind,
    title: a.title,
    body: a.body ?? null,
    assigneeUserId: a.assigneeUserId ?? null,
    createdByUserId: a.createdByUserId,
    dueAt: a.dueAt,
    timezone: a.timezone ?? null,
    recurrence: a.recurrence ?? null,
    link: a.link ?? null,
    status: a.status,
    completedAt: a.completedAt ?? null,
    cancelledAt: a.cancelledAt ?? null,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

function toTaskOutput(t: Task): TaskOutput {
  return {
    id: t.id,
    organizationId: t.organizationId,
    workflowId: t.workflowId ?? null,
    title: t.title,
    description: t.description ?? null,
    assigneeUserId: t.assigneeUserId ?? null,
    createdByUserId: t.createdByUserId,
    status: t.status,
    priority: t.priority,
    dueAt: t.dueAt ?? null,
    dependsOn: t.dependsOn,
    blockedReason: t.blockedReason ?? null,
    completedAt: t.completedAt ?? null,
    cancelledAt: t.cancelledAt ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

export interface WorkflowTasksModuleStores {
  activities: ActivityStore;
  tasks: TaskStore;
}

export function createWorkflowTasksModule(stores: WorkflowTasksModuleStores): BusinessModule {
  const { activities, tasks } = stores;

  return {
    manifest: {
      id: "workflow-tasks",
      name: "Workflow Tasks & Activities",
      version: "0.1.0",
      description: "Activities, reminders, and workflow tasks over the durable kernel stores",
      dependencies: [],
      permissions: [
        "activities.read",
        "activities.write",
        "workflow.tasks.read",
        "workflow.tasks.write",
      ],
      capabilities: ["activities", "workflow.tasks"],
      specialist: {
        id: "workflow-tasks",
        displayName: "Workflow & Activities Agent",
        description: "Activities, reminders, and workflow task queues",
        toolTags: ["core"],
      },
    },
    register({ commands, queries }) {
      // ─── Activities ───────────────────────────────────────────────────

      commands.register(
        defineCommand({
          name: "activities.create",
          permissions: ["activities.write"],
          tags: ["activities"],
          input: z
            .object({
              kind: activityKindSchema,
              title: z.string().min(1),
              body: z.string().optional(),
              assigneeUserId: z.string().uuid().optional(),
              dueAt: isoDateSchema,
              timezone: z.string().optional(),
              recurrence: recurrenceRuleSchema.optional(),
              link: linkSchema.optional(),
            })
            .strict(),
          output: activityOutputSchema,
          handler: async (input, ctx) => {
            const activity = await activities.create({
              organizationId: ctx.actor.organizationId,
              kind: input.kind,
              title: input.title,
              body: input.body,
              assigneeUserId: input.assigneeUserId,
              createdByUserId: ctx.actor.userId,
              dueAt: input.dueAt,
              timezone: input.timezone,
              recurrence: input.recurrence,
              link: input.link,
            });
            return toActivityOutput(activity);
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "activities.complete",
          permissions: ["activities.write"],
          tags: ["activities"],
          input: z.object({ activityId: z.string().uuid() }),
          output: z.object({ completed: z.boolean() }),
          handler: async (input, ctx) => {
            const ok = await activities.complete(ctx.actor.organizationId, input.activityId);
            if (!ok) throw new ValidationError("activity not found or already final");
            return { completed: true };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "activities.cancel",
          permissions: ["activities.write"],
          tags: ["activities"],
          input: z.object({ activityId: z.string().uuid() }),
          output: z.object({ cancelled: z.boolean() }),
          handler: async (input, ctx) => {
            const ok = await activities.cancel(ctx.actor.organizationId, input.activityId);
            if (!ok) throw new ValidationError("activity not found or already final");
            return { cancelled: true };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "activities.list",
          permissions: ["activities.read"],
          tags: ["activities"],
          input: z
            .object({
              kind: activityKindSchema.optional(),
              status: activityStatusSchema.optional(),
              assigneeUserId: z.string().uuid().optional(),
            })
            .strict(),
          output: z.object({ activities: z.array(activityOutputSchema) }),
          handler: async (input, ctx) => {
            const rows = await activities.list({
              organizationId: ctx.actor.organizationId,
              kind: input.kind,
              status: input.status,
              assigneeUserId: input.assigneeUserId,
            });
            return { activities: rows.map(toActivityOutput) };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "activities.overdue",
          permissions: ["activities.read"],
          tags: ["activities"],
          input: z.object({}),
          output: z.object({ overdue: z.array(activityOutputSchema) }),
          handler: async (_input, ctx) => {
            const rows = await activities.overdue(ctx.actor.organizationId, new Date());
            return { overdue: rows.map(toActivityOutput) };
          },
        }),
      );

      // ─── Workflow tasks ──────────────────────────────────────────────

      commands.register(
        defineCommand({
          name: "workflow.tasks.create",
          permissions: ["workflow.tasks.write"],
          tags: ["workflow"],
          input: z
            .object({
              workflowId: z.string().uuid().optional(),
              title: z.string().min(1),
              description: z.string().optional(),
              assigneeUserId: z.string().uuid().optional(),
              priority: taskPrioritySchema.optional(),
              dueAt: isoDateSchema.optional(),
              dependsOn: z.array(z.string().uuid()).optional(),
            })
            .strict(),
          output: taskOutputSchema,
          handler: async (input, ctx) => {
            const task = await tasks.create({
              organizationId: ctx.actor.organizationId,
              workflowId: input.workflowId,
              title: input.title,
              description: input.description,
              assigneeUserId: input.assigneeUserId,
              createdByUserId: ctx.actor.userId,
              priority: input.priority,
              dueAt: input.dueAt,
              dependsOn: input.dependsOn,
            });
            return toTaskOutput(task);
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "workflow.tasks.complete",
          permissions: ["workflow.tasks.write"],
          tags: ["workflow"],
          input: z.object({ taskId: z.string().uuid() }),
          output: taskOutputSchema,
          handler: async (input, ctx) => {
            const transition = await tasks.transition(ctx.actor.organizationId, input.taskId, "completed");
            if (!transition.ok) throw new ValidationError(transition.reason);
            return toTaskOutput(transition.task);
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "workflow.tasks.block",
          permissions: ["workflow.tasks.write"],
          tags: ["workflow"],
          input: z.object({ taskId: z.string().uuid(), reason: z.string().min(1) }),
          output: taskOutputSchema,
          handler: async (input, ctx) => {
            const transition = await tasks.transition(ctx.actor.organizationId, input.taskId, "blocked", {
              reason: input.reason,
            });
            if (!transition.ok) throw new ValidationError(transition.reason);
            return toTaskOutput(transition.task);
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "workflow.tasks.workQueue",
          permissions: ["workflow.tasks.read"],
          tags: ["workflow"],
          input: z.object({}),
          output: z.object({ tasks: z.array(taskOutputSchema) }),
          handler: async (_input, ctx) => {
            const rows = await tasks.workQueue(ctx.actor.organizationId);
            return { tasks: rows.map(toTaskOutput) };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "workflow.tasks.list",
          permissions: ["workflow.tasks.read"],
          tags: ["workflow"],
          input: z
            .object({
              workflowId: z.string().uuid().optional(),
              assigneeUserId: z.string().uuid().optional(),
              status: taskStatusSchema.optional(),
            })
            .strict(),
          output: z.object({ tasks: z.array(taskOutputSchema) }),
          handler: async (input, ctx) => {
            const rows = await tasks.list({
              organizationId: ctx.actor.organizationId,
              workflowId: input.workflowId,
              assigneeUserId: input.assigneeUserId,
              status: input.status,
            });
            return { tasks: rows.map(toTaskOutput) };
          },
        }),
      );
    },
  };
}