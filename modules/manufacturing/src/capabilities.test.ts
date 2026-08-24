import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, organizations, type Database } from "@chaste/db";
import {
  CapabilityRegistry,
  type ActionContext,
} from "@chaste/kernel";
import { registerManufacturingCapabilities, type ModuleDeps } from "./index";
import { registerInventoryCapabilities } from "@chaste/module-inventory";

/**
 * Ledger-backed integration proofs for the manufacturing capability surface.
 * Runs against the local database (owner role: RLS-exempt, which is fine —
 * tenant isolation itself is proven by packages/db/src/rls.test.ts).
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;

function registry(): CapabilityRegistry {
  const r = new CapabilityRegistry();
  registerInventoryCapabilities(r, deps);
  registerManufacturingCapabilities(r, deps);
  return r;
}

async function run<I>(capId: string, input: I): Promise<unknown> {
  const cap = registry().get(capId);
  if (!cap) throw new Error(`missing capability ${capId}`);
  return cap.execute(ctx, input);
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await db.db.insert(organizations).values({ id: orgId, name: "Manufacturing Probe", slug: `mfg-${orgId.slice(0, 8)}` });
  ctx = {
    actor: { type: "human", id: null, orgId, permissions: new Set(["inventory.read", "inventory.write", "manufacturing.read", "manufacturing.write"]) },
    now: new Date(),
    services: {},
  };
});

afterAll(async () => {
  await db.db.delete(organizations).where(eq(organizations.id, orgId));
  await db.client.end();
});

describe("capability conformance", () => {
  it("the whole inventory registry boots without conformance errors", () => {
    const issues = registry().validateAll();
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });
});

describe("production with scrap, lots and multi-level BOMs", () => {
  it("explodes nested assemblies, applies scrap, tags lots and traces them", async () => {
    await run("inventory.createItem", { sku: "FRAME", name: "Bike frame", unitLabel: "unit" });
    await run("inventory.createItem", { sku: "WHEEL-ASSY", name: "Wheel assembly" });
    await run("inventory.createItem", { sku: "SPOKE", name: "Spoke" });
    await run("inventory.createItem", { sku: "RIM", name: "Rim" });
    await run("inventory.createItem", { sku: "BIKE", name: "Bike" });

    // Wheel assembly: 1 rim + 32 spokes at 5% scrap.
    await run("manufacturing.defineBom", {
      assemblySku: "WHEEL-ASSY",
      components: [
        { sku: "RIM", quantityThousandths: 1000 },
        { sku: "SPOKE", quantityThousandths: 32000, scrapPctThousandths: 50_000 },
      ],
    });
    // Bike: 1 frame + 2 wheel assemblies.
    await run("manufacturing.defineBom", {
      assemblySku: "BIKE",
      components: [
        { sku: "FRAME", quantityThousandths: 1000 },
        { sku: "WHEEL-ASSY", quantityThousandths: 2000 },
      ],
    });

    const tree = (await run("manufacturing.bomTree", { assemblySku: "BIKE" })) as {
      hasBom: boolean;
      root: { children: { sku: string; children: { sku: string }[] }[] };
    };
    expect(tree.hasBom).toBe(true);
    const wheels = tree.root.children.find((c) => c.sku === "WHEEL-ASSY");
    expect(wheels?.children.map((c) => c.sku).sort()).toEqual(["RIM", "SPOKE"]);

    // Stock up: leaves only. Sub-assemblies are exploded through, never stocked.
    await run("inventory.adjustStock", { sku: "FRAME", quantityDelta: 10000, note: "initial stock load" });
    await run("inventory.adjustStock", { sku: "RIM", quantityDelta: 10000, note: "initial stock load" });
    await run("inventory.adjustStock", { sku: "SPOKE", quantityDelta: 300000, note: "initial stock load" });

    const baseline = (await run("inventory.stockReport", { belowReorderOnly: false })) as {
      items: { sku: string; onHandThousandths: number }[];
    };
    const baselineBySku = new Map(baseline.items.map((i) => [i.sku, i.onHandThousandths]));

    const report = (await run("manufacturing.bomReport", { assemblySku: "BIKE", quantityThousandths: 2000 })) as {
      producible: boolean;
      lines: { sku: string; requiredThousandths: number }[];
    };
    expect(report.producible).toBe(true);
    const spokes = report.lines.find((l) => l.sku === "SPOKE");
    // 2 bikes → 4 assemblies → each consumes ceil(32000×1.05)=33600 thousandths.
    expect(spokes?.requiredThousandths).toBe(134_400);

    const preview = (await run("manufacturing.costPreview", { assemblySku: "BIKE", quantityThousandths: 2000 })) as {
      totalCostMinor: number;
      lines: { costMinor: number }[];
    };
    expect(preview.totalCostMinor).toBe(preview.lines.reduce((s, l) => s + l.costMinor, 0));

    const produced = (await run("manufacturing.produceFromBom", {
      assemblySku: "BIKE",
      quantityThousandths: 2000,
      lotCode: "BIKE-LOT-1",
    })) as { runRef: string; consumedComponents: { sku: string; quantityThousandths: number }[]; costRolledUpMinor: number };

    const spokeLine = produced.consumedComponents.find((c) => c.sku === "SPOKE");
    expect(spokeLine?.quantityThousandths).toBe(134_400);

    const levels = (await run("inventory.stockReport", { belowReorderOnly: false })) as {
      items: { sku: string; onHandThousandths: number }[];
    };
    const bySku = new Map(levels.items.map((i) => [i.sku, i.onHandThousandths]));
    expect(bySku.get("BIKE")).toBe(2000);
    expect(bySku.get("SPOKE")).toBe(300_000 - 134_400);

    // Lot traceability: the finished lot exists and the trace tree finds it.
    const lotsOut = (await run("inventory.listLots", {})) as {
      lots: { sku: string; lotCode: string; balanceThousandths: number }[];
    };
    expect(lotsOut.lots.find((l) => l.lotCode === "BIKE-LOT-1")?.balanceThousandths).toBe(2000);

    const trace = (await run("manufacturing.lotTrace", { sku: "BIKE", lotCode: "BIKE-LOT-1" })) as {
      found: boolean;
      tree: { lotCode: string; fedBy: unknown[] }[];
    };
    // Components were untracked stock, so no upstream edges yet — but the lot resolves.
    expect(trace.found).toBe(true);
    expect(trace.tree[0]?.lotCode).toBe("BIKE-LOT-1");

    // Reverse the whole run: finished goods out, components back to baseline.
    const reversed = (await run("manufacturing.reverseProductionRun", { runRef: produced.runRef })) as {
      reversedMovements: number;
      removedFinishedThousandths: number;
    };
    expect(reversed.removedFinishedThousandths).toBe(2000);
    const afterLevels = (await run("inventory.stockReport", { belowReorderOnly: false })) as {
      items: { sku: string; onHandThousandths: number }[];
    };
    const afterBySku = new Map(afterLevels.items.map((i) => [i.sku, i.onHandThousandths]));
    expect(afterBySku.get("BIKE")).toBe(0);
    expect(afterBySku.get("SPOKE")).toBe(baselineBySku.get("SPOKE"));
    expect(afterBySku.get("FRAME")).toBe(baselineBySku.get("FRAME"));
    expect(afterBySku.get("RIM")).toBe(baselineBySku.get("RIM"));

    await expect(run("manufacturing.reverseProductionRun", { runRef: produced.runRef })).rejects.toThrow(
      /already been reversed/,
    );
  });
});

describe("work order lifecycle", () => {
  it("draft → release → partial complete → complete posts movements per completion", async () => {
    // Top up: earlier tests in this org already consumed parts.
    for (const [sku, qty] of [["FRAME", 10000], ["RIM", 20000], ["SPOKE", 400000]] as const) {
      await run("inventory.adjustStock", { sku, quantityDelta: qty, note: "wo lifecycle stock" });
    }
    const wo = (await run("manufacturing.createWorkOrder", {
      assemblySku: "BIKE",
      plannedQtyThousandths: 3000,
      yieldPctThousandths: 900_000,
      note: "spring batch",
    })) as { workOrderId: string; number: number; expectedGoodThousandths: number };
    expect(wo.expectedGoodThousandths).toBe(2700); // floor of 90% yield

    await expect(run("manufacturing.completeWorkOrder", { workOrderId: wo.workOrderId, quantityThousandths: 1000 }))
      .rejects.toThrow(/only released/);

    await run("manufacturing.releaseWorkOrder", { workOrderId: wo.workOrderId });

    // Short stock for a full 3: only ~10 frames minus prior consumption exist.
    const first = (await run("manufacturing.completeWorkOrder", {
      workOrderId: wo.workOrderId,
      quantityThousandths: 1000,
    })) as { completed: boolean; producedTotalThousandths: number; status: string };
    expect(first.completed).toBe(false);
    expect(first.producedTotalThousandths).toBe(1000);

    await expect(
      run("manufacturing.completeWorkOrder", { workOrderId: wo.workOrderId, quantityThousandths: 9000 }),
    ).rejects.toThrow(/exceeds plan/);

    const second = (await run("manufacturing.completeWorkOrder", {
      workOrderId: wo.workOrderId,
      quantityThousandths: 2000,
    })) as { completed: boolean; status: string };
    expect(second.completed).toBe(true);
    expect(second.status).toBe("completed");

    await expect(run("manufacturing.cancelWorkOrder", { workOrderId: wo.workOrderId })).rejects.toThrow(
      /cannot be cancelled/,
    );

    const listed = (await run("manufacturing.workOrdersList", { status: "completed" })) as {
      workOrders: { id: string; producedQtyThousandths: number }[];
    };
    expect(listed.workOrders.find((w) => w.id === wo.workOrderId)?.producedQtyThousandths).toBe(3000);

    // Production history now shows runs, including WO completions.
    const runs = (await run("manufacturing.productionRuns", { limit: 50 })) as {
      runs: { assemblySku: string; producedThousandths: number; reversed: boolean }[];
    };
    const openRuns = runs.runs.filter((r) => !r.reversed && r.assemblySku === "BIKE");
    expect(openRuns.length).toBeGreaterThanOrEqual(2);
  });

  it("cancel refuses when partial completions exist", async () => {
    for (const [sku, qty] of [["FRAME", 10000], ["RIM", 20000], ["SPOKE", 400000]] as const) {
      await run("inventory.adjustStock", { sku, quantityDelta: qty, note: "cancel probe stock" });
    }
    const wo = (await run("manufacturing.createWorkOrder", { assemblySku: "BIKE", plannedQtyThousandths: 2000 })) as {
      workOrderId: string;
    };
    await run("manufacturing.releaseWorkOrder", { workOrderId: wo.workOrderId });
    const partial = (await run("manufacturing.completeWorkOrder", {
      workOrderId: wo.workOrderId,
      quantityThousandths: 1000,
    })) as { completed: boolean; status: string };
    expect(partial.completed).toBe(false);
    await expect(run("manufacturing.cancelWorkOrder", { workOrderId: wo.workOrderId })).rejects.toThrow(
      /reverse them via/,
    );
  });
});

describe("reservations & available-to-promise", () => {
  it("reservations reduce ATP and release restores it", async () => {
    await run("inventory.adjustStock", { sku: "FRAME", quantityDelta: 5000, note: "reserve probe stock" });
    const res = (await run("inventory.reserveStock", {
      sku: "FRAME",
      quantityThousandths: 2000,
      reason: "sales order SO-42",
    })) as { reservationId: string; availableAfterThousandths: number };

    const levels = (await run("inventory.stockReport", { belowReorderOnly: false })) as {
      items: { sku: string; onHandThousandths: number; reservedThousandths: number; availableThousandths: number }[];
    };
    const frame = levels.items.find((i) => i.sku === "FRAME")!;
    expect(frame.reservedThousandths).toBe(2000);

    await expect(
      run("inventory.reserveStock", { sku: "FRAME", quantityThousandths: 999_999_999, reason: "overbook attempt" }),
    ).rejects.toThrow(/available to promise/);

    await run("inventory.releaseReservation", { reservationId: res.reservationId });
    const after = (await run("inventory.listReservations", { openOnly: true })) as {
      reservations: { id: string }[];
    };
    expect(after.reservations.find((r) => r.id === res.reservationId)).toBeUndefined();
  });
});

describe("cycle counts", () => {
  it("snapshots expectations, records findings, posts variances through the ledger", async () => {
    const before = (await run("inventory.stockReport", { belowReorderOnly: false })) as {
      items: { sku: string; onHandThousandths: number }[];
    };
    const base = before.items.find((i) => i.sku === "RIM")!.onHandThousandths;

    const count = (await run("inventory.createCycleCount", { skus: ["RIM"], note: "aisle 4 recount" })) as {
      countId: string;
      lineCount: number;
    };
    expect(count.lineCount).toBe(1);

    await expect(run("inventory.postCycleCount", { countId: count.countId })).rejects.toThrow(/no counted quantity/);

    await run("inventory.recordCycleCounts", {
      countId: count.countId,
      counts: [{ sku: "RIM", countedThousandths: base - 200 }],
    });

    // Drift guard: moving stock between snapshot and post must refuse.
    await run("inventory.adjustStock", { sku: "RIM", quantityDelta: -100, note: "drift inducer" });
    await expect(run("inventory.postCycleCount", { countId: count.countId })).rejects.toThrow(/moved since the snapshot/);
    await run("inventory.adjustStock", { sku: "RIM", quantityDelta: 100, note: "undo drift inducer" });

    const posted = (await run("inventory.postCycleCount", { countId: count.countId })) as {
      postedVariances: number;
      netVarianceThousandths: number;
    };
    expect(posted.postedVariances).toBe(1);
    expect(posted.netVarianceThousandths).toBe(-200);

    const hist = (await run("inventory.itemHistory", { sku: "RIM" })) as {
      movements: { refType: string | null; quantityDelta: number }[];
    };
    expect(hist.movements.some((m) => m.refType === "cycle_count" && m.quantityDelta === -200)).toBe(true);

    await expect(run("inventory.cancelCycleCount", { countId: count.countId })).rejects.toThrow(/only open counts/);
  });
});

describe("locations & BOM deletion", () => {
  it("creates locations usable in adjustments and deletes/restores BOMs", async () => {
    await run("inventory.createLocation", { code: "STAGING", name: "Shop floor staging" });
    const locs = (await run("inventory.listLocations", {})) as { locations: { code: string }[] };
    expect(locs.locations.map((l) => l.code)).toContain("STAGING");

    await run("inventory.adjustStock", { sku: "RIM", quantityDelta: 300, note: "moved to staging", locationCode: "STAGING" });
    const hist = (await run("inventory.itemHistory", { sku: "RIM" })) as {
      movements: { locationCode: string | null }[];
    };
    expect(hist.movements.some((m) => m.locationCode === "STAGING")).toBe(true);

    const deleted = (await run("manufacturing.deleteBom", { assemblySku: "WHEEL-ASSY" })) as {
      removedCount: number;
      removedLines: { sku: string; quantityThousandths: number; scrapPctThousandths: number }[];
    };
    expect(deleted.removedCount).toBe(2);
    expect(deleted.removedLines.find((l) => l.sku === "SPOKE")?.scrapPctThousandths).toBe(50_000);

    await expect(run("manufacturing.costPreview", { assemblySku: "WHEEL-ASSY", quantityThousandths: 1000 })).rejects.toThrow(
      /no bill of materials/,
    );

    // Restore via the declared inverse path.
    await run("manufacturing.defineBom", {
      assemblySku: "WHEEL-ASSY",
      components: [
        { sku: "RIM", quantityThousandths: 1000 },
        { sku: "SPOKE", quantityThousandths: 32000, scrapPctThousandths: 50_000 },
      ],
    });
    const restored = (await run("manufacturing.bomTree", { assemblySku: "WHEEL-ASSY" })) as { hasBom: boolean };
    expect(restored.hasBom).toBe(true);
  });
});
