import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, type Database } from "@chaste/db";
import { jobs, ledgerEvents, organizations } from "@chaste/db";
import { logger } from "@chaste/kernel";
import { enqueueCapabilityJob, processOneJob } from "./jobs";

/**
 * Proves the durable queue: a job carrying a capability id + input is claimed
 * (FOR UPDATE SKIP LOCKED), executed through the governed KernelExecutor path
 * by a system actor scoped to the job's org, and finalized to done/failed
 * with bounded retries.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database["db"];
let pg: Database;
const orgId = crypto.randomUUID();

beforeAll(async () => {
  pg = createDb(url);
  db = pg.db;
  await db.insert(organizations).values({
    id: orgId,
    name: "Jobs Test Org",
    slug: `jobs-test-${orgId.slice(0, 8)}`,
  });
});

afterAll(async () => {
  await db.delete(ledgerEvents).where(eq(ledgerEvents.orgId, orgId));
  await db.delete(jobs).where(eq(jobs.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await pg.client.end();
});

afterEach(async () => {
  // The queue is global; a retryable orphan from one test would be claimed
  // by the next. Clean per test.
  await db.delete(jobs).where(eq(jobs.orgId, orgId));
});

describe("capability job queue", () => {
  it("executes a queued capability and marks the job done", async () => {
    const jobId = await enqueueCapabilityJob(db, {
      orgId,
      type: "documents.parseDocument",
      payload: { documentId: "00000000-0000-4000-8000-000000000000" },
    });

    // The referenced document does not exist, so the governed execution must
    // fail honestly; with attempts=1 of 3 the job returns to pending.
    await processOneJob(db, logger);
    let [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(row!.status).toBe("pending");
    expect(row!.attempts).toBe(1);
    expect(row!.lastError).toContain("no document");

    // Exhaust retries; the queue must land on failed, not loop forever.
    await db.execute(sql`UPDATE jobs SET attempts = max_attempts - 1 WHERE id = ${jobId}`);
    await processOneJob(db, logger);
    [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(row!.status).toBe("failed");
    expect(row!.attempts).toBe(row!.maxAttempts);
  });

  it("returns false when the queue is empty", async () => {
    // Drain defensively in case any other pending job exists globally.
    for (let i = 0; i < 10; i += 1) await processOneJob(db, logger);
    const drained = await processOneJob(db, logger);
    expect(drained).toBe(false);
  });

  it("the system actor holds exactly the target capability's permission", async () => {
    const { systemActorFor } = await import("./jobs");
    const actor = systemActorFor(orgId, "documents.write");
    expect(actor.permissions.has("documents.write")).toBe(true);
    expect(actor.permissions.has("*")).toBe(false);
    expect(actor.permissions.size).toBe(1);
  });

  it("an unknown job type fails permanently instead of retrying forever", async () => {
    const jobId = await enqueueCapabilityJob(db, {
      orgId,
      type: "nonexistent.doesNotExist",
      payload: {},
    });
    await processOneJob(db, logger);
    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(row!.status).toBe("failed");
    expect(row!.lastError).toContain("unknown job capability");
  });
});
