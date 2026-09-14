import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, customers, items, organizations, users, type Database } from "@chaste/db";

/**
 * Slice D import boundaries (X15/N08): writing imported rows demands domain
 * authority (crm.write / inventory.write), and money parses exactly from the
 * raw string — "1,234.56" is 123456 minor units, "19.999" and negatives are
 * row errors, never silent float coercion.
 */

const state = vi.hoisted(() => ({
  current: null as {
    userId: string;
    email: string;
    name: string | null;
    orgId: string | null;
    permissions: Set<string>;
  } | null,
}));

vi.mock("@/server/session", () => ({
  getResolvedUser: async () => state.current,
}));

const { POST: importPOST } = await import("@/app/api/import/route");

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database["db"];
let pg: Database;
const orgId = crypto.randomUUID();
const userId = crypto.randomUUID();

function asUser(permissions: string[]) {
  state.current = { userId, email: `${userId}@probe.test`, name: null, orgId, permissions: new Set(permissions) };
}

function post(payload: unknown): Promise<Response> {
  return importPOST(new Request("http://probe.test/api/import", { method: "POST", body: JSON.stringify(payload) }));
}

beforeAll(async () => {
  pg = createDb(url);
  db = pg.db;
  await db.insert(users).values({ id: userId, email: `${userId}@probe.test` });
  await db.insert(organizations).values({ id: orgId, name: "Import Probe Org", slug: `import-probe-${orgId.slice(0, 8)}` });
});

afterAll(async () => {
  await db.delete(items).where(eq(items.orgId, orgId));
  await db.delete(customers).where(eq(customers.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
  await pg.client.end();
});

describe("import write boundaries (X15)", () => {
  it("customer import requires crm.write", async () => {
    asUser(["hr.read"]);
    const denied = await post({ entity: "customers", rows: [{ name: "X" }] });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toContain("crm.write");
  });

  it("product import requires inventory.write", async () => {
    asUser(["crm.write"]);
    const denied = await post({ entity: "products", rows: [{ name: "X", sku: "X1" }] });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toContain("inventory.write");
  });

  it("parses money exactly from strings: grouped thousands, cents, no float drift", async () => {
    asUser(["crm.write"]);
    const res = await post({
      entity: "customers",
      rows: [
        { name: "Exact Cents", creditLimit: "19.99" },
        { name: "Grouped", creditLimit: "1,234.56" },
        { name: "Whole", creditLimit: "20" },
        { name: "One Decimal", creditLimit: "0.1" },
      ],
    });
    expect(res.status).toBe(200);
    const rows = await db.select().from(customers).where(eq(customers.orgId, orgId));
    const byName = new Map(rows.map((r) => [r.name, r.creditLimitMinor]));
    expect(byName.get("Exact Cents")).toBe(1999);
    expect(byName.get("Grouped")).toBe(123456);
    expect(byName.get("Whole")).toBe(2000);
    expect(byName.get("One Decimal")).toBe(10);
  });

  it("rejects sub-cent precision, negatives and garbage as row errors", async () => {
    asUser(["inventory.write"]);
    const res = await post({
      entity: "products",
      rows: [
        { name: "SubCent", sku: "P1", salePrice: "19.999" },
        { name: "Negative", sku: "P2", salePrice: "-5" },
        { name: "Garbage", sku: "P3", salePrice: "12.34.56" },
        { name: "Valid", sku: "P4", salePrice: "19.99" },
      ],
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as { inserted: number; errors: { field: string; message: string }[] };
    expect(result.inserted).toBe(1);
    expect(result.errors).toHaveLength(3);
    expect(result.errors.map((e) => e.field)).toEqual(["salePrice", "salePrice", "salePrice"]);
    const [valid] = await db.select().from(items).where(eq(items.orgId, orgId));
    expect(valid!.salePriceMinor).toBe(1999);
  });
});
