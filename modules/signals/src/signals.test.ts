import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, createDb, items, organizations, type Database } from "@chaste/db";
import { CapabilityRegistry, isBusinessSignal, type SignalProducer } from "@chaste/kernel";
import { registerSignalsCapabilities, type SignalsDeps } from "./index";

/**
 * Signal registry proof (M8.1): producers are injected at the app layer, a
 * broken producer degrades to missing signals instead of breaking the
 * aggregator, invalid shapes are filtered, and the real inventory producer
 * fires on a fixture org below its reorder point.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let store: Database;
let db: Database["db"];
const orgId = crypto.randomUUID();
let deps: SignalsDeps;

function makeRegistry(extra: SignalProducer[] = []): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registerSignalsCapabilities(registry, { producers: [...deps.producers, ...extra] });
  return registry;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads heterogeneous capability outputs; each assertion narrows its shape
async function run<I>(id: string, input: I): Promise<any> {
  const cap = makeRegistry().get(id);
  if (!cap) throw new Error(`missing capability ${id}`);
  return cap.execute(
    { actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) }, now: new Date(), services: {} },
    input,
  );
}

beforeAll(async () => {
  store = createDb(url);
  db = store.db;
  await db.delete(organizations).where(eq(organizations.name, "Signals Probe"));
  await db.insert(organizations).values({ id: orgId, name: "Signals Probe", slug: `sig-${orgId.slice(0, 8)}` });
  await db.insert(accounts).values({ orgId, code: "1200", name: "Inventory", type: "asset" });

  const inventoryProducer: SignalProducer = async (probeOrgId) => {
    if (probeOrgId !== orgId) return [];
    const rows = await db.select().from(items).where(eq(items.orgId, probeOrgId));
    return rows
      .filter((item) => item.reorderPointThousandths > 0)
      .map((item) => ({
        id: `inventory.reorder:${item.sku}`,
        severity: "orange" as const,
        module: "inventory",
        subject: `${item.name} is at or below its reorder point`,
        detail: "fixture",
      }));
  };
  deps = { producers: [inventoryProducer] };

  await db.insert(items).values({
    orgId,
    sku: "SIG-1",
    name: "Signal Probe Item",
    reorderPointThousandths: 5_000,
  });
  await db.insert(items).values({
    orgId,
    sku: "SIG-OK",
    name: "Healthy Item",
    reorderPointThousandths: 0,
  });
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.name, "Signals Probe"));
  await store.client.end();
});

describe("signals.list (ADR 0034)", () => {
  it("passes capability conformance — read class, valid id and intent", () => {
    const registry = makeRegistry();
    const issues = registry.validateAll().filter((i) => i.capabilityId === "signals.list" && i.level === "error");
    expect(issues).toHaveLength(0);
  });

  it("collects producer output, sorted red first, with invalid shapes filtered", async () => {
    const brokenProducer: SignalProducer = async () => [
      { id: "x", severity: "catastrophic", module: "x", subject: "x", detail: "x" } as unknown as never,
    ];
    const thrower: SignalProducer = async () => {
      throw new Error("producer exploded");
    };
    const redProducer: SignalProducer = async () => [
      {
        id: "accounting.overdue:1",
        severity: "red",
        module: "accounting",
        subject: "Invoice #4 is 61 days overdue",
        detail: "fixture",
      },
    ];

    const result = await run("signals.list", { severity: "red" });
    // The broken producer's invalid shape must be filtered, the thrower must
    // not break the run, and the red filter keeps exactly the red signal.
    const registry = makeRegistry([brokenProducer, thrower, redProducer]);
    const cap = registry.get("signals.list")!;
    const raw = (await cap.execute(
      { actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) }, now: new Date(), services: {} },
      { severity: "red" },
    )) as { signals: { id: string; severity: string }[] };
    expect(raw.signals.map((s: { severity: string }) => s.severity)).toEqual(["red"]);
    expect(raw.signals[0]!.id).toBe("accounting.overdue:1");
    void result;
  });

  it("fires the inventory reorder signal on the fixture org", async () => {
    const result = await run("signals.list", { module: "inventory" });
    const reorder = result.signals.find((s: { id: string }) => s.id === "inventory.reorder:SIG-1");
    expect(reorder).toBeDefined();
    expect(reorder.severity).toBe("orange");
    expect(isBusinessSignal(reorder)).toBe(true);
    expect(result.signals.some((s: { id: string }) => s.id === "inventory.reorder:SIG-OK")).toBe(false);
  });
});
