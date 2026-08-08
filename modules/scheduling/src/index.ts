/**
 * Scheduling — reminders, follow-ups, and calendar.
 *
 * ARCH-3 — extracted from the platform "god module" as a bounded context.
 * `core.reminder.*`, `core.followup.*`, and `core.calendar.*` command/query
 * names are unchanged, so the API and web surface are untouched; only
 * ownership moved to its own package.
 */
import type { Db } from "@chaste/db";
import { schema } from "@chaste/db";
import { ValidationError, defineCommand, defineQuery, type BusinessModule } from "@chaste/kernel";
import { and, eq, gte, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";

/** R1-aligned: in-app notification (spec: scheduling-and-comms.md §4). */
async function notifyUser(
  db: Db,
  input: {
    organizationId: string;
    userId: string;
    kind?: string;
    title: string;
    body?: string;
    href?: string;
    resourceType?: string;
    resourceId?: string;
  },
): Promise<void> {
  await db.insert(schema.notifications).values({
    organizationId: input.organizationId,
    userId: input.userId,
    kind: input.kind ?? "info",
    title: input.title,
    body: input.body,
    href: input.href,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
  });
}

export function createSchedulingModule(db: Db): BusinessModule {
  return {
    manifest: {
      id: "scheduling",
      name: "Scheduling",
      version: "0.1.0",
      description: "Reminders, follow-ups, and calendar",
      dependencies: [],
      permissions: [
        "core.reminder.write",
        "core.followup.write",
        "core.calendar.read",
        "core.calendar.write",
      ],
      capabilities: ["core.scheduling", "core.calendar"],
      specialist: {
        id: "scheduling",
        displayName: "Scheduling Agent",
        description: "Reminders, follow-ups, and calendar",
        toolTags: ["core"],
      },
    },
    register({ commands, queries }) {
      // ─── Reminders & Follow-ups (spec: scheduling-and-comms §2/§3) ──────

      const reminderOutputSchema = z.object({
        id: z.string(),
        title: z.string(),
        body: z.string().nullable(),
        href: z.string().nullable(),
        fireAt: z.string(),
        channel: z.string(),
        status: z.string(),
        branchId: z.string().nullable(),
      });

      const followUpOutputSchema = z.object({
        id: z.string(),
        goal: z.string(),
        fireAt: z.string(),
        sessionId: z.string().nullable(),
        branchId: z.string().nullable(),
        status: z.string(),
      });

      const fireAtSchema = z.string().refine((v) => {
        const t = Date.parse(v);
        return Number.isFinite(t) && t > Date.now();
      }, "fireAt must be a future ISO timestamp");

      commands.register(
        defineCommand({
          name: "core.reminder.set",
          permissions: ["core.reminder.write"],
          tags: ["core"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            title: z.string().min(1),
            body: z.string().optional(),
            href: z.string().optional(),
            fireAt: fireAtSchema,
            channel: z.enum(["in_app", "email", "both"]).optional(),
            branchId: z.string().uuid().optional(),
          }),
          output: reminderOutputSchema,
          handler: async (input, ctx) => {
            if (input.branchId) {
              const [branch] = await db
                .select()
                .from(schema.branches)
                .where(
                  and(
                    eq(schema.branches.id, input.branchId),
                    eq(schema.branches.organizationId, ctx.actor.organizationId),
                  ),
                );
              if (!branch) {
                throw new ValidationError("Branch not found", { branchId: input.branchId });
              }
            }
            const [row] = await db
              .insert(schema.reminders)
              .values({
                organizationId: ctx.actor.organizationId,
                userId: ctx.actor.userId,
                createdBy: ctx.actor.userId,
                title: input.title,
                body: input.body ?? null,
                href: input.href ?? null,
                fireAt: new Date(input.fireAt),
                channel: input.channel ?? "in_app",
                branchId: input.branchId ?? null,
              })
              .returning();
            await notifyUser(db, {
              organizationId: ctx.actor.organizationId,
              userId: ctx.actor.userId,
              kind: "system",
              title: "Reminder scheduled",
              body: `${input.title} — I'll nudge you at ${new Date(input.fireAt).toISOString()}.`,
            });
            return {
              id: row!.id,
              title: row!.title,
              body: row!.body,
              href: row!.href,
              fireAt: row!.fireAt.toISOString(),
              channel: row!.channel,
              status: row!.status,
              branchId: row!.branchId,
            };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.reminder.cancel",
          permissions: ["core.reminder.write"],
          tags: ["core"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({ reminderId: z.string().uuid() }),
          output: z.object({ cancelled: z.boolean() }),
          handler: async (input, ctx) => {
            const rows = await db
              .update(schema.reminders)
              .set({ status: "cancelled" })
              .where(
                and(
                  eq(schema.reminders.id, input.reminderId),
                  eq(schema.reminders.userId, ctx.actor.userId),
                  eq(schema.reminders.status, "scheduled"),
                ),
              )
              .returning();
            if (rows.length === 0) {
              throw new ValidationError("Reminder not found or already fired", {
                reminderId: input.reminderId,
              });
            }
            return { cancelled: true };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.followup.create",
          permissions: ["core.followup.write"],
          tags: ["core"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            goal: z.string().min(1),
            fireAt: fireAtSchema,
            sessionId: z.string().uuid().optional(),
            branchId: z.string().uuid().optional(),
          }),
          output: followUpOutputSchema,
          handler: async (input, ctx) => {
            if (input.branchId) {
              const [branch] = await db
                .select()
                .from(schema.branches)
                .where(
                  and(
                    eq(schema.branches.id, input.branchId),
                    eq(schema.branches.organizationId, ctx.actor.organizationId),
                  ),
                );
              if (!branch) {
                throw new ValidationError("Branch not found", { branchId: input.branchId });
              }
            }
            const [row] = await db
              .insert(schema.followUps)
              .values({
                organizationId: ctx.actor.organizationId,
                userId: ctx.actor.userId,
                createdBy: ctx.actor.userId,
                goal: input.goal,
                fireAt: new Date(input.fireAt),
                sessionId: input.sessionId ?? null,
                branchId: input.branchId ?? null,
              })
              .returning();
            await notifyUser(db, {
              organizationId: ctx.actor.organizationId,
              userId: ctx.actor.userId,
              kind: "system",
              title: "Follow-up scheduled",
              body: `I'll come back to this on ${new Date(input.fireAt).toISOString()}: ${input.goal}`,
            });
            return {
              id: row!.id,
              goal: row!.goal,
              fireAt: row!.fireAt.toISOString(),
              sessionId: row!.sessionId,
              branchId: row!.branchId,
              status: row!.status,
            };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.followup.cancel",
          permissions: ["core.followup.write"],
          tags: ["core"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({ followUpId: z.string().uuid() }),
          output: z.object({ cancelled: z.boolean() }),
          handler: async (input, ctx) => {
            const rows = await db
              .update(schema.followUps)
              .set({ status: "cancelled" })
              .where(
                and(
                  eq(schema.followUps.id, input.followUpId),
                  eq(schema.followUps.userId, ctx.actor.userId),
                  or(
                    eq(schema.followUps.status, "scheduled"),
                    eq(schema.followUps.status, "running"),
                  ),
                ),
              )
              .returning();
            if (rows.length === 0) {
              throw new ValidationError("Follow-up not found", { followUpId: input.followUpId });
            }
            return { cancelled: true };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "core.reminder.list",
          permissions: ["core.reminder.write"],
          tags: ["core"],
          input: z.object({ status: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }).default({}),
          output: z.object({
            reminders: z.array(reminderOutputSchema),
          }),
          handler: async (input, ctx) => {
            const where = and(
              eq(schema.reminders.userId, ctx.actor.userId),
              eq(schema.reminders.organizationId, ctx.actor.organizationId),
              input.status ? eq(schema.reminders.status, input.status) : undefined,
            );
            const rows = await db
              .select()
              .from(schema.reminders)
              .where(where)
              .orderBy(schema.reminders.fireAt)
              .limit(input.limit ?? 50);
            return {
              reminders: rows.map((r) => ({
                id: r.id,
                title: r.title,
                body: r.body,
                href: r.href,
                fireAt: r.fireAt.toISOString(),
                channel: r.channel,
                status: r.status,
                branchId: r.branchId,
              })),
            };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "core.followup.list",
          permissions: ["core.followup.write"],
          tags: ["core"],
          input: z.object({ status: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }).default({}),
          output: z.object({
            followUps: z.array(followUpOutputSchema),
          }),
          handler: async (input, ctx) => {
            const where = and(
              eq(schema.followUps.userId, ctx.actor.userId),
              eq(schema.followUps.organizationId, ctx.actor.organizationId),
              input.status ? eq(schema.followUps.status, input.status) : undefined,
            );
            const rows = await db
              .select()
              .from(schema.followUps)
              .where(where)
              .orderBy(schema.followUps.fireAt)
              .limit(input.limit ?? 50);
            return {
              followUps: rows.map((f) => ({
                id: f.id,
                goal: f.goal,
                fireAt: f.fireAt.toISOString(),
                sessionId: f.sessionId,
                branchId: f.branchId,
                status: f.status,
              })),
            };
          },
        }),
      );

      // ─── Calendar (C3) ────────────────────────────────────────────────

      const tsSchema = z.string().refine((v) => Number.isFinite(Date.parse(v)), "must be an ISO timestamp");
      const calendarEventOutputSchema = z.object({
        id: z.string(),
        organizationId: z.string(),
        calendarId: z.string(),
        title: z.string(),
        description: z.string().nullable(),
        startsAt: z.string(),
        endsAt: z.string(),
        timezone: z.string(),
        branchId: z.string().nullable(),
        attendees: z.array(z.string()),
        linkedResources: z.array(z.object({ type: z.string(), id: z.string() })),
        status: z.string(),
        createdBy: z.string(),
        createdAt: z.string(),
        updatedAt: z.string(),
      });

      function toCalendarEvent(row: typeof schema.calendarEvents.$inferSelect) {
        return {
          id: row.id,
          organizationId: row.organizationId,
          calendarId: row.calendarId,
          title: row.title,
          description: row.description,
          startsAt: row.startsAt.toISOString(),
          endsAt: row.endsAt.toISOString(),
          timezone: row.timezone,
          branchId: row.branchId,
          attendees: row.attendees,
          linkedResources: row.linkedResources,
          status: row.status,
          createdBy: row.createdBy,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        };
      }

      async function defaultOrgCalendar(orgId: string) {
        const [existing] = await db
          .select()
          .from(schema.calendars)
          .where(and(eq(schema.calendars.organizationId, orgId), isNull(schema.calendars.ownerUserId)))
          .limit(1);
        if (existing) return existing;
        const [created] = await db
          .insert(schema.calendars)
          .values({ organizationId: orgId, scope: "org", name: "Organization calendar" })
          .returning();
        return created!;
      }

      queries.register(
        defineQuery({
          name: "core.calendar.list",
          permissions: ["core.calendar.read"],
          tags: ["core"],
          input: z
            .object({
              from: tsSchema.optional(),
              to: tsSchema.optional(),
              branchId: z.string().uuid().optional(),
              includeCancelled: z.boolean().optional(),
              limit: z.number().int().min(1).max(500).optional(),
            })
            .default({}),
          output: z.object({ events: z.array(calendarEventOutputSchema) }),
          handler: async (input, ctx) => {
            const where = and(
              eq(schema.calendarEvents.organizationId, ctx.actor.organizationId),
              input.from ? gte(schema.calendarEvents.startsAt, new Date(input.from)) : undefined,
              input.to ? lte(schema.calendarEvents.startsAt, new Date(input.to)) : undefined,
              input.branchId ? eq(schema.calendarEvents.branchId, input.branchId) : undefined,
              input.includeCancelled ? undefined : eq(schema.calendarEvents.status, "scheduled"),
            );
            const rows = await db
              .select()
              .from(schema.calendarEvents)
              .where(where)
              .orderBy(schema.calendarEvents.startsAt)
              .limit(input.limit ?? 200);
            return { events: rows.map(toCalendarEvent) };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.calendar.event.create",
          permissions: ["core.calendar.write"],
          tags: ["core"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            title: z.string().min(1),
            startsAt: tsSchema,
            endsAt: tsSchema,
            timezone: z.string().default("UTC"),
            description: z.string().optional(),
            calendarId: z.string().uuid().optional(),
            branchId: z.string().uuid().optional(),
            attendees: z.array(z.string()).optional(),
            linkedResources: z.array(z.object({ type: z.string(), id: z.string() })).optional(),
          }),
          output: calendarEventOutputSchema,
          handler: async (input, ctx) => {
            const startsAt = new Date(input.startsAt);
            const endsAt = new Date(input.endsAt);
            if (endsAt <= startsAt) {
              throw new ValidationError("endsAt must be after startsAt", {
                startsAt: input.startsAt,
                endsAt: input.endsAt,
              });
            }
            if (input.branchId) {
              const [branch] = await db
                .select()
                .from(schema.branches)
                .where(
                  and(
                    eq(schema.branches.id, input.branchId),
                    eq(schema.branches.organizationId, ctx.actor.organizationId),
                  ),
                );
              if (!branch) {
                throw new ValidationError("Branch not found", { branchId: input.branchId });
              }
            }
            let calendarId = input.calendarId;
            if (calendarId) {
              const [calendar] = await db
                .select()
                .from(schema.calendars)
                .where(
                  and(
                    eq(schema.calendars.id, calendarId),
                    eq(schema.calendars.organizationId, ctx.actor.organizationId),
                  ),
                );
              if (!calendar) {
                throw new ValidationError("Calendar not found", { calendarId });
              }
            } else {
              calendarId = (await defaultOrgCalendar(ctx.actor.organizationId)).id;
            }

            const [row] = await db
              .insert(schema.calendarEvents)
              .values({
                organizationId: ctx.actor.organizationId,
                calendarId,
                title: input.title,
                description: input.description ?? null,
                startsAt,
                endsAt,
                timezone: input.timezone,
                branchId: input.branchId ?? null,
                attendees: input.attendees ?? [],
                linkedResources: input.linkedResources ?? [],
                createdBy: ctx.actor.userId,
              })
              .returning();

            await notifyUser(db, {
              organizationId: ctx.actor.organizationId,
              userId: ctx.actor.userId,
              kind: "system",
              title: "Event scheduled",
              body: `${input.title} — ${startsAt.toISOString()} to ${endsAt.toISOString()}.`,
              resourceType: "calendar_event",
              resourceId: row!.id,
            });

            return toCalendarEvent(row!);
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.calendar.event.update",
          permissions: ["core.calendar.write"],
          tags: ["core"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({
            eventId: z.string().uuid(),
            title: z.string().min(1).optional(),
            description: z.string().nullable().optional(),
            startsAt: tsSchema.optional(),
            endsAt: tsSchema.optional(),
            timezone: z.string().optional(),
            branchId: z.string().uuid().nullable().optional(),
            attendees: z.array(z.string()).optional(),
            linkedResources: z.array(z.object({ type: z.string(), id: z.string() })).optional(),
          }),
          output: calendarEventOutputSchema,
          handler: async (input, ctx) => {
            const [event] = await db
              .select()
              .from(schema.calendarEvents)
              .where(
                and(
                  eq(schema.calendarEvents.id, input.eventId),
                  eq(schema.calendarEvents.organizationId, ctx.actor.organizationId),
                ),
              );
            if (!event) {
              throw new ValidationError("Calendar event not found", { eventId: input.eventId });
            }
            if (input.branchId !== undefined) {
              if (input.branchId === null) {
                // allow clearing branch scope
              } else {
                const [branch] = await db
                  .select()
                  .from(schema.branches)
                  .where(
                    and(
                      eq(schema.branches.id, input.branchId),
                      eq(schema.branches.organizationId, ctx.actor.organizationId),
                    ),
                  );
                if (!branch) {
                  throw new ValidationError("Branch not found", { branchId: input.branchId });
                }
              }
            }

            const startsAt = input.startsAt !== undefined ? new Date(input.startsAt) : event.startsAt;
            const endsAt = input.endsAt !== undefined ? new Date(input.endsAt) : event.endsAt;
            if (endsAt <= startsAt) {
              throw new ValidationError("endsAt must be after startsAt");
            }

            const updates: Record<string, unknown> = { updatedAt: new Date() };
            if (input.title !== undefined) updates.title = input.title;
            if (input.description !== undefined) updates.description = input.description;
            if (input.startsAt !== undefined) updates.startsAt = startsAt;
            if (input.endsAt !== undefined) updates.endsAt = endsAt;
            if (input.timezone !== undefined) updates.timezone = input.timezone;
            if (input.branchId !== undefined) updates.branchId = input.branchId;
            if (input.attendees !== undefined) updates.attendees = input.attendees;
            if (input.linkedResources !== undefined) updates.linkedResources = input.linkedResources;

            await db
              .update(schema.calendarEvents)
              .set(updates)
              .where(eq(schema.calendarEvents.id, input.eventId));

            const [updated] = await db
              .select()
              .from(schema.calendarEvents)
              .where(eq(schema.calendarEvents.id, input.eventId));
            return toCalendarEvent(updated!);
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "core.calendar.event.cancel",
          permissions: ["core.calendar.write"],
          tags: ["core"],
          minAutonomyForAuto: "guarded_auto",
          input: z.object({ eventId: z.string().uuid() }),
          output: z.object({ cancelled: z.boolean() }),
          handler: async (input, ctx) => {
            const rows = await db
              .update(schema.calendarEvents)
              .set({ status: "cancelled", updatedAt: new Date() })
              .where(
                and(
                  eq(schema.calendarEvents.id, input.eventId),
                  eq(schema.calendarEvents.organizationId, ctx.actor.organizationId),
                  eq(schema.calendarEvents.status, "scheduled"),
                ),
              )
              .returning();
            if (rows.length === 0) {
              throw new ValidationError("Calendar event not found or already cancelled", {
                eventId: input.eventId,
              });
            }
            return { cancelled: true };
          },
        }),
      );
    },
  };
}
