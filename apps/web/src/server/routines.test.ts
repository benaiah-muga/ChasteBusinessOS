import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, jobs, organizations, routineOccurrences, routines, type Database } from "@chaste/db";
import { logger } from "@chaste/kernel";
import { claimDueRoutines, executeRoutine } from "./routines";

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
const orgId = crypto.randomUUID();
let pg: Database;
let db: Database["db"];
let routineId: string;

beforeAll(async () => {
  pg = createDb(url);
  db = pg.db;
  await db.insert(organizations).values({ id: orgId, name: "Routine Occurrence Probe", slug: `ro-${orgId.slice(0, 8)}` });
  const [routine] = await db
    .insert(routines)
    .values({
      orgId,
      name: "Due routine",
      prompt: "Report whether anything needs attention.",
      scheduleText: "every 5 minutes",
      schedule: { kind: "interval", everyMinutes: 5 },
      triggerType: "schedule",
      nextRunAt: new Date(Date.now() - 1_000),
      createdByActorType: "human",
    })
    .returning({ id: routines.id });
  routineId = routine!.id;
});

afterAll(async () => {
  await db.delete(jobs).where(eq(jobs.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await pg.client.end();
});

describe("scheduled routine occurrences", () => {
  it("claims one occurrence when two scheduler ticks race", async () => {
    const [first, second] = await Promise.all([claimDueRoutines(db), claimDueRoutines(db)]);
    expect(first.length + second.length).toBe(1);
    const occurrences = await db.select().from(routineOccurrences).where(eq(routineOccurrences.routineId, routineId));
    const queuedJobs = await db.select().from(jobs).where(eq(jobs.orgId, orgId));
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.jobId).toBe(queuedJobs[0]!.id);
    expect((queuedJobs[0]!.payload as { occurrenceId: string }).occurrenceId).toBe(occurrences[0]!.id);
    const [updated] = await db.select({ nextRunAt: routines.nextRunAt }).from(routines).where(eq(routines.id, routineId));
    expect(updated!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("cancels a scheduled occurrence disabled after it was queued", async () => {
    const [routine] = await db
      .insert(routines)
      .values({
        orgId,
        name: "Disabled routine",
        prompt: "This must not run.",
        schedule: { kind: "interval", everyMinutes: 5 },
        triggerType: "schedule",
        enabled: false,
        nextRunAt: new Date(Date.now() + 60_000),
        createdByActorType: "human",
      })
      .returning({ id: routines.id });
    const [occurrence] = await db
      .insert(routineOccurrences)
      .values({ orgId, routineId: routine!.id, scheduledAt: new Date() })
      .returning({ id: routineOccurrences.id });

    await executeRoutine(db, logger, { routineId: routine!.id, trigger: "schedule", occurrenceId: occurrence!.id });

    const [updated] = await db.select({ status: routineOccurrences.status }).from(routineOccurrences).where(eq(routineOccurrences.id, occurrence!.id));
    expect(updated!.status).toBe("cancelled");
  });
});
