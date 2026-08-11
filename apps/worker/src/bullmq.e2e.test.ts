/**
 * ARCH-9/REL-2 — schedule driver E2E against a live Redis/BullMQ. Verifies the
 * worker boots in bullmq mode, a due reminder is enqueued by the tick, claimed
 * atomically by the queue worker, and delivered exactly once into the
 * notifications table. Skipped when DATABASE_URL or a reachable REDIS_URL is
 * missing (e.g. CI without Redis) — poll-mode fallback is covered elsewhere.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createDb, runMigrations, schema, type Db, cleanupTestData } from "@chaste/db";
import { createScheduleProcessor } from "@chaste/module-platform";
import { eq } from "drizzle-orm";
import { createScheduleDriver, detectRedis } from "./scheduler.js";
import type { FollowUpHarness } from "./harness.js";

const hasDb = Boolean(process.env.DATABASE_URL);
const DB_URL = process.env.DATABASE_URL!;
const REDIS_URL = process.env.REDIS_URL;

let db: Db;
let orgId: string;
let userId: string;
let reminderId: string;
let futureReminderId: string;

async function redisIsUp(): Promise<boolean> {
  if (process.env.SCHEDULE_DRIVER_FORCE_POLL === "1") return false;
  if (!REDIS_URL) return false;
  return detectRedis(REDIS_URL);
}

describe.skipIf(!hasDb || !(await redisIsUp()))("Schedule driver BullMQ E2E (ARCH-9/REL-2)", () => {
  // Stub harness — reminders-only path never touches the agent harness, and this
  // test fires no follow-up jobs.
  const followUps = {} as FollowUpHarness;

  beforeAll(async () => {
    db = createDb(DB_URL);
    await runMigrations(DB_URL);
    await cleanupTestData(db);

    const [org] = await db
      .insert(schema.organizations)
      .values({ name: "BullMQ Org", autonomy: "confirm", region: "local" })
      .returning();
    orgId = org!.id;

    const [user] = await db
      .insert(schema.users)
      .values({ organizationId: orgId, email: "bmq@test.com", displayName: "BullMQ User" })
      .returning();
    userId = user!.id;

    const [due] = await db
      .insert(schema.reminders)
      .values({
        organizationId: orgId,
        userId,
        createdBy: userId,
        title: "Due reminder",
        body: "should fire",
        fireAt: new Date(Date.now() - 5_000),
        status: "scheduled",
      })
      .returning();
    reminderId = due!.id;

    const [future] = await db
      .insert(schema.reminders)
      .values({
        organizationId: orgId,
        userId,
        createdBy: userId,
        title: "Future reminder",
        body: "should not fire yet",
        fireAt: new Date(Date.now() + 60_000),
        status: "scheduled",
      })
      .returning();
    futureReminderId = future!.id;
  });

  afterAll(async () => {
    if (db && orgId) {
      await cleanupTestData(db);
      await db.$client.end({ timeout: 5 });
    }
  });

  async function waitFor(fn: () => Promise<boolean>, timeoutMs = 8_000, stepMs = 100): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, stepMs));
    }
    return false;
  }

  it("boots in bullmq mode when Redis is reachable", async () => {
    const driver = await createScheduleDriver({
      db,
      redisUrl: REDIS_URL,
      schedule: createScheduleProcessor(db),
      followUps,
    });
    expect(driver.mode).toBe("bullmq");
    await driver.close();
  });

  it("enqueues a due reminder and delivers it exactly once via the queue worker", async () => {
    const schedule = createScheduleProcessor(db);
    const driver = await createScheduleDriver({ db, redisUrl: REDIS_URL, schedule, followUps });
    try {
      const counts = await driver.tick();
      expect(counts.reminders).toBe(1); // only the due reminder is enqueued
      expect(counts.followUps).toBe(0);

      const delivered = await waitFor(async () => {
        const [n] = await db
          .select()
          .from(schema.notifications)
          .where(eq(schema.notifications.resourceId, reminderId));
        return Boolean(n);
      });
      expect(delivered).toBe(true);

      const [reminder] = await db
        .select()
        .from(schema.reminders)
        .where(eq(schema.reminders.id, reminderId));
      expect(reminder!.status).toBe("fired");
      expect(reminder!.firedAt).not.toBeNull();

      // The future reminder was never enqueued or fired.
      const [future] = await db
        .select()
        .from(schema.reminders)
        .where(eq(schema.reminders.id, futureReminderId));
      expect(future!.status).toBe("scheduled");

      // After firing, nothing is re-enqueued (status guard) and the delivery
      // stays exactly one notification — the atomic claim prevents duplicates.
      const second = await driver.tick();
      expect(second.reminders).toBe(0);
      const notifications = await db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.resourceId, reminderId));
      expect(notifications).toHaveLength(1);
    } finally {
      await driver.close();
    }
  }, 30_000);
});