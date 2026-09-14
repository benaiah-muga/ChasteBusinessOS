import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, organizations, routines, type Database } from "@chaste/db";
import { type ActionContext, CapabilityRegistry } from "@chaste/kernel";
import { registerRoutineCapabilities, type ModuleDeps } from "./index";

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
const orgId = crypto.randomUUID();
let db: Database;
let deps: ModuleDeps;
let ctx: ActionContext;

function capability(id: string) {
  const registry = new CapabilityRegistry();
  registerRoutineCapabilities(registry, deps);
  const found = registry.get(id);
  if (!found) throw new Error(`missing capability ${id}`);
  return found;
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await db.db.insert(organizations).values({ id: orgId, name: "Routine Schedule Probe", slug: `rt-${orgId.slice(0, 8)}` });
  ctx = { actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) }, now: new Date("2026-09-14T08:00:00Z"), services: {} };
});

afterAll(async () => {
  await db.db.delete(organizations).where(eq(organizations.id, orgId));
  await db.client.end();
});

describe("routine schedule edits", () => {
  it("does not move the next run when only the routine metadata changes", async () => {
    const created = (await capability("routines.create").execute(ctx, {
      name: "Morning pulse",
      prompt: "Report the customer count.",
      scheduleText: "daily at 09:00",
      withWebhook: false,
    })) as { routineId: string };
    const [before] = await db.db.select({ nextRunAt: routines.nextRunAt }).from(routines).where(eq(routines.id, created.routineId));
    const updated = (await capability("routines.update").execute(
      { ...ctx, now: new Date("2026-09-14T12:00:00Z") },
      { routineId: created.routineId, name: "Daily pulse" },
    )) as { nextRunAt: string; scheduleLabel: string };
    expect(updated.nextRunAt).toBe(before!.nextRunAt!.toISOString());
    expect(updated.scheduleLabel).toBe("Daily at 09:00");
  });
});
