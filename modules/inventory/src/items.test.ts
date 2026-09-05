import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, organizations, type Database } from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerInventoryCapabilities } from "./index";
import type { ModuleDeps } from "./shared";

/**
 * Product-surface proof (M7.3): barcode identity, honest misses, update with
 * a working snapshot inverse, and uniqueness guards.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;

function makeRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registerInventoryCapabilities(registry, deps);
  return registry;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads heterogeneous capability outputs; each assertion narrows its shape
async function run<I>(id: string, input: I): Promise<any> {
  const cap = makeRegistry().get(id);
  if (!cap) throw new Error(`missing capability ${id}`);
  return cap.execute(ctx, input);
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await db.db.delete(organizations).where(eq(organizations.name, "Items Probe"));
  await db.db.insert(organizations).values({ id: orgId, name: "Items Probe", slug: `itm-${orgId.slice(0, 8)}` });
  ctx = {
    actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };
});

afterAll(async () => {
  await db.db.delete(organizations).where(eq(organizations.id, orgId));
  await db.client.end();
});

describe("product surface (M7.3)", () => {
  it("creates items with image, tags, and barcode", async () => {
    const created = await run("inventory.createItem", {
      sku: "SCAN-1",
      name: "Scannable Widget",
      imageUrl: "https://cdn.example.test/widget.jpg",
      tags: ["bestseller", "fragile"],
      barcode: "6001234500017",
    });
    expect(typeof created.itemId).toBe("string");
  });

  it("looks up by barcode — positive control before trusting the miss", async () => {
    const hit = await run("inventory.lookupByBarcode", { barcode: "6001234500017" });
    expect(hit.item).not.toBeNull();
    expect(hit.item.sku).toBe("SCAN-1");
    expect(hit.item.tags).toContain("fragile");
    expect(hit.item.imageUrl).toContain("widget.jpg");
  });

  it("answers an unknown barcode with an explicit null, never a guess", async () => {
    const miss = await run("inventory.lookupByBarcode", { barcode: "0000000000000" });
    expect(miss.item).toBeNull();
  });

  it("updates details and the snapshot inverse restores them exactly", async () => {
    const updated = await run("inventory.updateItem", {
      sku: "SCAN-1",
      name: "Scannable Widget Pro",
      salePriceMinor: 12_500,
      tags: ["bestseller"],
    });
    expect(updated.sku).toBe("SCAN-1");
    const afterUpdate = await run("inventory.lookupByBarcode", { barcode: "6001234500017" });
    expect(afterUpdate.item.name).toBe("Scannable Widget Pro");
    expect(afterUpdate.item.tags).toEqual(["bestseller"]);

    await run("inventory.restoreItem", updated.prior);
    const restored = await run("inventory.lookupByBarcode", { barcode: "6001234500017" });
    expect(restored.item.name).toBe("Scannable Widget");
    expect(restored.item.tags).toEqual(["bestseller", "fragile"]);
  });

  it("guards barcode uniqueness inside the org", async () => {
    await run("inventory.createItem", { sku: "SCAN-2", name: "Second Widget" });
    await expect(
      run("inventory.updateItem", { sku: "SCAN-2", barcode: "6001234500017" }),
    ).rejects.toThrow(/already on another item/);
    await expect(
      run("inventory.createItem", { sku: "SCAN-3", name: "Third Widget", barcode: "6001234500017" }),
    ).rejects.toThrow(/already on another item/);
  });
});
