import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, organizations, tickets, type Database } from "@chaste/db";
import { capabilityGapContractSchema, fileCapabilityGap } from "./capability-gaps";

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
const orgId = crypto.randomUUID();
let pg: Database;
let db: Database["db"];

beforeAll(async () => {
  pg = createDb(url);
  db = pg.db;
  await db.insert(organizations).values({
    id: orgId,
    name: "Capability Gap Test Org",
    slug: `cap-gap-${orgId.slice(0, 8)}`,
  });
});

afterAll(async () => {
  await db.delete(tickets).where(eq(tickets.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await pg.client.end();
});

describe("capability gaps", () => {
  it("files a durable desired-behavior contract and never claims execution", async () => {
    const contract = capabilityGapContractSchema.parse({
      requestedCapabilityId: "inventory.reserveStock",
      desiredBehavior: "Reserve the requested quantity for an approved customer order.",
      acceptanceCriteria: [
        "Reject quantities above available stock.",
        "Return a reservation id that can be released.",
      ],
      exampleInput: { sku: "CEM-42", quantity: 5_000 },
    });
    const id = await fileCapabilityGap(db, {
      orgId,
      title: "Reserve stock for a customer order",
      contract,
    });
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, id));
    expect(ticket?.origin).toBe("capability_gap");
    expect(ticket?.status).toBe("open");
    expect(ticket?.description).toContain("no execution was attempted");
    expect(ticket?.description).toContain("inventory.reserveStock");
    expect(ticket?.description).toContain("Reject quantities above available stock.");
    console.log("CAPABILITY-GAP-OK");
  });

  it("rejects a gap without a concrete desired behavior", () => {
    expect(() =>
      capabilityGapContractSchema.parse({
        requestedCapabilityId: "inventory.reserveStock",
        desiredBehavior: "reserve",
        acceptanceCriteria: [],
      }),
    ).toThrow();
  });
});
