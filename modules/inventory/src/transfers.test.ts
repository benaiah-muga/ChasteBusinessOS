import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  accounts,
  createDb,
  items,
  journalEntries,
  journalLines,
  organizations,
  stockLocations,
  stockMovements,
  stockTransferLines,
  type Database,
} from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerInventoryCapabilities } from "./index";
import { glAccountBalanceMinor, inventoryLedgerValueMinor } from "./valuation";
import { stockOnHand } from "./shared";
import type { ModuleDeps } from "./shared";

/**
 * Ledger-backed proof of internal transfers (M7.2): paired legs conserve
 * quantity across locations, partial confirmations work, source-location
 * oversell is refused, reversal restores the start state, and — the ADR 0033
 * invariant — transfer legs never move valuation value.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;
let itemId: string;

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

async function purgeProbeOrgs(): Promise<void> {
  const orgs = await db.db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.name, "Transfer Probe"));
  for (const o of orgs) {
    const entries = await db.db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(eq(journalEntries.orgId, o.id));
    for (const e of entries) {
      await db.db.delete(journalLines).where(eq(journalLines.entryId, e.id));
    }
    await db.db.delete(journalEntries).where(eq(journalEntries.orgId, o.id));
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await purgeProbeOrgs();
  await db.db.insert(organizations).values({ id: orgId, name: "Transfer Probe", slug: `tr-${orgId.slice(0, 8)}` });
  await db.db.insert(accounts).values([
    { orgId, code: "1200", name: "Inventory", type: "asset" },
    { orgId, code: "5000", name: "Cost of Goods Sold", type: "expense" },
  ]);
  ctx = {
    actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };
  await run("inventory.createLocation", { code: "WH-A", name: "Warehouse A" });
  await run("inventory.createLocation", { code: "WH-B", name: "Warehouse B" });
  const [item] = await db.db
    .insert(items)
    .values({ orgId, sku: "TRF-1", name: "Transfer Probe Item" })
    .returning({ id: items.id });
  itemId = item!.id;
  // Costed stock lands at WH-A: +20k thousandths @ 500 minor → value 10,000.
  const [locA] = await db.db.select().from(stockLocations).where(eq(stockLocations.code, "WH-A"));
  await db.db.insert(stockMovements).values({
    orgId,
    itemId,
    quantityDelta: 20_000,
    reason: "purchase",
    unitCostMinor: 500,
    locationId: locA!.id,
    actorType: "system",
    actorId: null,
    createdAt: new Date("2026-08-01T09:00:00Z"),
  });
});

afterAll(async () => {
  await purgeProbeOrgs();
  await db.client.end();
});

async function locationOnHand(code: "WH-A" | "WH-B"): Promise<number> {
  const [loc] = await deps.db.select().from(stockLocations).where(eq(stockLocations.code, code));
  return stockOnHand(deps.db, orgId, itemId, loc!.id);
}

describe("inventory transfers (M7.2)", () => {
  it("moves quantity location-to-location in partial steps, conserving totals and value", async () => {
    const valueBefore = await inventoryLedgerValueMinor(deps.db, orgId);
    expect(valueBefore).toBe(10_000);

    const created = await run("inventory.createTransfer", {
      fromLocationCode: "WH-A",
      toLocationCode: "WH-B",
      lines: [{ sku: "TRF-1", quantityThousandths: 12_000 }],
      note: "weekly replenishment",
    });
    expect(created.status).toBe("pending");
    const transferId = created.transferId;

    const partial = await run("inventory.confirmTransfer", {
      transferId,
      lines: [{ lineId: (await db.db.select().from(stockTransferLines).where(eq(stockTransferLines.transferId, transferId)))[0]!.id, quantityThousandths: 7_000 }],
    });
    expect(partial.status).toBe("partial");
    expect(await locationOnHand("WH-A")).toBe(13_000);
    expect(await locationOnHand("WH-B")).toBe(7_000);

    await run("inventory.confirmTransfer", { transferId });
    expect(await locationOnHand("WH-A")).toBe(8_000);
    expect(await locationOnHand("WH-B")).toBe(12_000);
    expect(await locationOnHand("WH-A") + (await locationOnHand("WH-B"))).toBe(20_000);

    // The ADR 0033 invariant: transfers relocate, they do not reprice.
    expect(await inventoryLedgerValueMinor(deps.db, orgId)).toBe(10_000);
    expect(await glAccountBalanceMinor(deps.db, orgId)).toBe(0);
  });

  it("refuses to confirm more than the source location holds", async () => {
    const created = await run("inventory.createTransfer", {
      fromLocationCode: "WH-B",
      toLocationCode: "WH-A",
      lines: [{ sku: "TRF-1", quantityThousandths: 999_000 }],
    });
    await expect(run("inventory.confirmTransfer", { transferId: created.transferId })).rejects.toThrow(
      /insufficient stock at source/,
    );
    await run("inventory.cancelTransfer", { transferId: created.transferId });
  });

  it("cancels untouched drafts but refuses once quantity has moved", async () => {
    const created = await run("inventory.createTransfer", {
      fromLocationCode: "WH-A",
      toLocationCode: "WH-B",
      lines: [{ sku: "TRF-1", quantityThousandths: 1_000 }],
    });
    const cancelled = await run("inventory.cancelTransfer", { transferId: created.transferId });
    expect(cancelled.cancelled).toBe(true);
    await expect(run("inventory.cancelTransfer", { transferId: created.transferId })).rejects.toThrow(/cancelled/);
  });

  it("reverses a confirmed transfer exactly once and restores the start state", async () => {
    const aBefore = await locationOnHand("WH-A");
    const bBefore = await locationOnHand("WH-B");

    const created = await run("inventory.createTransfer", {
      fromLocationCode: "WH-A",
      toLocationCode: "WH-B",
      lines: [{ sku: "TRF-1", quantityThousandths: 5_000 }],
    });
    await run("inventory.confirmTransfer", { transferId: created.transferId });
    expect(await locationOnHand("WH-A")).toBe(aBefore - 5_000);
    expect(await locationOnHand("WH-B")).toBe(bBefore + 5_000);

    const reversed = await run("inventory.reverseTransfer", { transferId: created.transferId });
    expect(reversed.reversed).toBe(true);
    expect(await locationOnHand("WH-A")).toBe(aBefore);
    expect(await locationOnHand("WH-B")).toBe(bBefore);
    expect(await inventoryLedgerValueMinor(deps.db, orgId)).toBe(10_000);

    await expect(run("inventory.reverseTransfer", { transferId: created.transferId })).rejects.toThrow(
      /already been reversed/,
    );
  });

  it("lists transfers", async () => {
    const list = await run("inventory.listTransfers", { openOnly: false });
    expect(list.transfers.length).toBeGreaterThanOrEqual(3);
  });
});

