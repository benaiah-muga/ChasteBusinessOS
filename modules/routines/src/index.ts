import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { jobs, routines, type Database } from "@chaste/db";
import { withOrgContext } from "@chaste/db";
import { describeSchedule, nextRoutineRun, parseScheduleText } from "@chaste/erp-core";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";

export interface ModuleDeps {
  db: Database["db"];
}

export const ROUTINE_NAME_MAX = 120;
export const ROUTINE_PROMPT_MAX = 4000;
export const ROUTINE_SCHEDULE_TEXT_MAX = 200;
const ROUTINE_LIST_LIMIT = 100;

/** Execution job type handled by the worker (apps/web/src/server/jobs.ts). */
export const ROUTINE_JOB_TYPE = "routines.executeRoutine";

const scheduleSchema = z.object({
  kind: z.enum(["interval", "daily", "weekdays", "weekly"]),
  everyMinutes: z.number().int().min(1).max(10_080).optional(),
  atTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
});

const createRoutine = (deps: ModuleDeps) =>
  defineCapability({
    id: "routines.create",
    title: "Create routine",
    intent:
      "Create a recurring agent routine from a natural-language schedule so the workmate repeats this task automatically",
    module: "routines",
    risk: "write",
    permission: "routines.write",
    input: z.object({
      name: z.string().min(1).max(ROUTINE_NAME_MAX),
      prompt: z.string().min(1).max(ROUTINE_PROMPT_MAX),
      scheduleText: z.string().min(3).max(ROUTINE_SCHEDULE_TEXT_MAX).optional(),
      schedule: scheduleSchema.optional(),
      withWebhook: z.boolean().default(false),
    }),
    output: z.object({
      routineId: z.string(),
      schedule: scheduleSchema,
      scheduleLabel: z.string(),
      nextRunAt: z.string(),
      webhookToken: z.string().nullable(),
    }),
    inverse: {
      capabilityId: "routines.delete",
      buildInput: (_input, output) => ({
        routineId: (output as { routineId: string }).routineId,
      }),
    },
    execute: async (ctx, input) => {
      // Either the user's words or a pre-structured schedule must be present;
      // when both arrive the structured one wins (it is already normalized).
      let schedule: z.infer<typeof scheduleSchema>;
      const scheduleText: string | null = input.scheduleText ?? null;
      if (input.schedule) {
        schedule = input.schedule;
      } else if (input.scheduleText) {
        const parsed = parseScheduleText(input.scheduleText);
        if (!parsed.ok) {
          throw new Error(
            "could not parse the schedule: try shapes like 'every 30 minutes', 'daily at 08:00', 'weekdays at 9am' or 'weekly on monday at 09:00'",
          );
        }
        schedule = parsed.schedule as z.infer<typeof scheduleSchema>;
      } else {
        throw new Error("a schedule is required: pass scheduleText or a structured schedule");
      }
      if (schedule.kind === "interval" && !schedule.everyMinutes) {
        throw new Error("interval schedules need everyMinutes");
      }
      if (schedule.kind !== "interval" && !schedule.atTime) {
        throw new Error("time-based schedules need atTime (HH:MM)");
      }
      if (schedule.kind === "weekly" && schedule.dayOfWeek === undefined) {
        throw new Error("weekly schedules need dayOfWeek (0=Sunday..6=Saturday)");
      }
      const nextRunAt = nextRoutineRun(schedule as never, ctx.now);
      const webhookToken = input.withWebhook ? crypto.randomUUID() : null;
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [row] = await tx
          .insert(routines)
          .values({
            orgId: ctx.actor.orgId,
            name: input.name,
            prompt: input.prompt,
            scheduleText,
            schedule: schedule as unknown as object,
            triggerType: webhookToken ? "webhook" : "schedule",
            webhookToken,
            nextRunAt,
            createdByActorType: ctx.actor.type,
            createdByActorId: ctx.actor.id,
          })
          .returning({ id: routines.id });
        return {
          routineId: row!.id,
          schedule: schedule as z.infer<typeof scheduleSchema>,
          scheduleLabel: describeSchedule(schedule as never),
          nextRunAt: nextRunAt.toISOString(),
          webhookToken,
        };
      });
    },
  });

const listRoutines = (deps: ModuleDeps) =>
  defineCapability({
    id: "routines.list",
    title: "List routines",
    intent:
      "List the org's recurring agent routines with their schedules, next run times, and last run status",
    module: "routines",
    risk: "read",
    permission: "routines.read",
    input: z.object({ limit: z.number().int().min(1).max(ROUTINE_LIST_LIMIT).default(50) }),
    output: z.object({
      routines: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          scheduleLabel: z.string(),
          triggerType: z.string(),
          enabled: z.boolean(),
          nextRunAt: z.string().nullable(),
          lastRunAt: z.string().nullable(),
          lastStatus: z.string().nullable(),
          lastError: z.string().nullable(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const rows = await tx
          .select()
          .from(routines)
          .where(eq(routines.orgId, ctx.actor.orgId))
          .orderBy(desc(routines.createdAt))
          .limit(input.limit);
        return {
          routines: rows.map((r) => ({
            id: r.id,
            name: r.name,
            scheduleLabel: describeSchedule(r.schedule as never),
            triggerType: r.triggerType,
            enabled: r.enabled,
            nextRunAt: r.nextRunAt?.toISOString() ?? null,
            lastRunAt: r.lastRunAt?.toISOString() ?? null,
            lastStatus: r.lastStatus,
            lastError: r.lastError,
          })),
        };
      });
    },
  });

const updateRoutine = (deps: ModuleDeps) =>
  defineCapability({
    id: "routines.update",
    title: "Update routine",
    intent:
      "Rename a routine, edit its prompt, change its schedule, or enable and disable it; schedule changes recompute the next run",
    module: "routines",
    risk: "write",
    permission: "routines.write",
    // No declared inverse: enable/disable is self-inverse (a toggle), and the
    // previous prompt/schedule is not retained, so a compensating action
    // cannot be constructed faithfully. Accepted conformance warning.
    input: z.object({
      routineId: z.string().uuid(),
      name: z.string().min(1).max(ROUTINE_NAME_MAX).optional(),
      prompt: z.string().min(1).max(ROUTINE_PROMPT_MAX).optional(),
      scheduleText: z.string().min(3).max(ROUTINE_SCHEDULE_TEXT_MAX).optional(),
      schedule: scheduleSchema.optional(),
      enabled: z.boolean().optional(),
    }),
    output: z.object({ routineId: z.string(), scheduleLabel: z.string(), nextRunAt: z.string().nullable() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [row] = await tx
          .select()
          .from(routines)
          .where(and(eq(routines.id, input.routineId), eq(routines.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!row) throw new Error("routine not found");
        const patch: Partial<typeof routines.$inferInsert> = {};
        if (input.name !== undefined) patch.name = input.name;
        if (input.prompt !== undefined) patch.prompt = input.prompt;
        if (input.enabled !== undefined) patch.enabled = input.enabled;
        let schedule = row.schedule as z.infer<typeof scheduleSchema> | null;
        if (input.schedule) {
          schedule = input.schedule;
          patch.schedule = input.schedule as unknown as object;
        } else if (input.scheduleText) {
          const parsed = parseScheduleText(input.scheduleText);
          if (!parsed.ok) throw new Error("could not parse the new schedule");
          schedule = parsed.schedule as z.infer<typeof scheduleSchema>;
          patch.schedule = schedule as unknown as object;
          patch.scheduleText = input.scheduleText;
        }
        if (schedule) {
          patch.nextRunAt = nextRoutineRun(schedule as never, ctx.now);
        }
        await tx.update(routines).set(patch).where(eq(routines.id, input.routineId));
        return {
          routineId: input.routineId,
          scheduleLabel: schedule ? describeSchedule(schedule as never) : "(unchanged)",
          nextRunAt: patch.nextRunAt?.toISOString() ?? row.nextRunAt?.toISOString() ?? null,
        };
      });
    },
  });

const deleteRoutine = (deps: ModuleDeps) =>
  defineCapability({
    id: "routines.delete",
    title: "Delete routine",
    intent:
      "Delete a recurring routine by id and return its fields so the deletion can be reversed by recreating it",
    module: "routines",
    risk: "write",
    permission: "routines.write",
    input: z.object({ routineId: z.string().uuid() }),
    output: z.object({
      name: z.string(),
      prompt: z.string(),
      scheduleText: z.string().nullable(),
      schedule: scheduleSchema,
    }),
    inverse: {
      capabilityId: "routines.create",
      buildInput: (_input, output) => {
        const o = output as { name: string; prompt: string; scheduleText: string | null; schedule: z.infer<typeof scheduleSchema> };
        return {
          name: o.name,
          prompt: o.prompt,
          schedule: o.schedule,
          withWebhook: false,
        };
      },
    },
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [row] = await tx
          .delete(routines)
          .where(and(eq(routines.id, input.routineId), eq(routines.orgId, ctx.actor.orgId)))
          .returning();
        if (!row) throw new Error("routine not found");
        return {
          name: row.name,
          prompt: row.prompt,
          scheduleText: row.scheduleText,
          schedule: row.schedule as z.infer<typeof scheduleSchema>,
        };
      });
    },
  });

const runRoutineNow = (deps: ModuleDeps) =>
  defineCapability({
    id: "routines.runNow",
    title: "Run routine now",
    intent:
      "Trigger one immediate run of an existing routine through the durable job queue instead of waiting for its schedule",
    module: "routines",
    risk: "write",
    permission: "routines.write",
    input: z.object({ routineId: z.string().uuid() }),
    output: z.object({ jobId: z.string() }),
    // Not inversible: a run is an execution event, recorded in the ledger and
    // in the routine-run session, not a persistent state change.
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [row] = await tx
          .select({ id: routines.id })
          .from(routines)
          .where(and(eq(routines.id, input.routineId), eq(routines.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!row) throw new Error("routine not found");
        const [job] = await tx
          .insert(jobs)
          .values({
            orgId: ctx.actor.orgId,
            type: ROUTINE_JOB_TYPE,
            payload: { routineId: input.routineId, trigger: "manual" },
            createdByActorType: ctx.actor.type,
            createdByActorId: ctx.actor.id,
          })
          .returning({ id: jobs.id });
        return { jobId: job!.id };
      });
    },
  });

export function registerRoutineCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(createRoutine(deps));
  registry.register(listRoutines(deps));
  registry.register(updateRoutine(deps));
  registry.register(deleteRoutine(deps));
  registry.register(runRoutineNow(deps));
}
