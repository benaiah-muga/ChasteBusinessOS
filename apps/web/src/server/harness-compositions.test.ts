import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, harnessCompositions, organizations, type Database } from "@chaste/db";
import { BUILTIN_PROFILES } from "@chaste/harness";
import {
  inspectHarnessComposition,
  persistHarnessComposition,
} from "./harness-compositions";

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
const orgId = crypto.randomUUID();
const otherOrgId = crypto.randomUUID();
let pg: Database;
let db: Database["db"];

const composition = {
  profile: BUILTIN_PROFILES["erp-prod"],
  bundles: [{ id: "erp", version: "1.0.0", serviceIds: ["chaste.capability.bridge"] }],
  patches: [{ id: "runtime-secrets", version: "1.0.0", values: { apiKey: "do-not-inspect" } }],
};

beforeAll(async () => {
  pg = createDb(url);
  db = pg.db;
  await db.insert(organizations).values([
    { id: orgId, name: "Harness Persistence Test Org", slug: `harness-persist-${orgId.slice(0, 8)}` },
    { id: otherOrgId, name: "Harness Other Org", slug: `harness-other-${otherOrgId.slice(0, 8)}` },
  ]);
});

afterAll(async () => {
  await db.delete(harnessCompositions).where(eq(harnessCompositions.orgId, orgId));
  await db.delete(harnessCompositions).where(eq(harnessCompositions.orgId, otherOrgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(organizations).where(eq(organizations.id, otherOrgId));
  await pg.client.end();
});

describe("persisted harness compositions", () => {
  it("is idempotent and pins a deterministic identity", async () => {
    const first = await persistHarnessComposition(db, { orgId, ...composition });
    const second = await persistHarnessComposition(db, { orgId, ...composition });
    expect(second.id).toBe(first.id);
    expect(first.profileId).toBe("erp-prod");
    expect(first.profileDigest).toHaveLength(64);
    expect(first.compositionDigest).toHaveLength(64);
    console.log("HARNESS-PERSISTENCE-OK");
  });

  it("returns only safe metadata and does not cross tenant boundaries", async () => {
    const saved = await persistHarnessComposition(db, { orgId, ...composition });
    const inspected = await inspectHarnessComposition(db, orgId, saved.id);
    expect(inspected?.id).toBe(saved.id);
    expect(inspected?.patches).toEqual([{ id: "runtime-secrets", version: "1.0.0", configKeys: ["apiKey"] }]);
    expect(JSON.stringify(inspected)).not.toContain("do-not-inspect");
    expect(await inspectHarnessComposition(db, otherOrgId, saved.id)).toBeNull();
    console.log("HARNESS-INSPECTION-OK");
  });
});
