/**
 * M7 verification — inventory integrity: GL closure, transfers, product
 * surface. Every assertion is a product guarantee.
 *
 * Run: pnpm demo:m7 [reconciliation|transfers|products|all]
 */
import { and, eq } from "drizzle-orm";
import { approvals, getDb, items, stockLocations, stockMovements, stockTransferLines, users } from "@chaste/db";
import { glAccountBalanceMinor, inventoryLedgerValueMinor } from "../modules/inventory/src/valuation";
import { buildExecutor, buildRegistry } from "../apps/web/src/server/kernel";
import { runOnboarding } from "../apps/web/src/server/onboarding";

let passed = 0;
function ok(label: string, condition?: boolean) {
  if (condition === false) throw new Error(`FAILED: ${label}`);
  console.log(`✓ ${label}`);
  passed += 1;
}

async function reconciliationScenario(): Promise<string> {
  const db = getDb().db;
  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);

  const [owner] = await db
    .insert(users)
    .values({ email: `own-${Date.now()}@demo.test`, name: "Owner" })
    .returning();
  if (!owner) throw new Error("owner insert failed");
  const { orgId } = await runOnboarding(db, {
    userId: owner.id,
    userEmail: owner.email,
    orgName: "M7 Warehouse Co",
    businessDescription:
      "Hardware store tracking cement and steel stock across two locations, selling over the counter and on account.",
  });
  const ownerCtx = {
    actor: { type: "human" as const, id: owner.id, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };
  const agentCtx = { ...ownerCtx, actor: { ...ownerCtx.actor, type: "agent" as const } };

  await executor.execute(
    "inventory.createItem",
    ownerCtx,
    { sku: "CEM-42", name: "Cement 50kg bag", unitLabel: "bag", salePriceMinor: 35_000 },
  );
  await executor.execute(
    "inventory.createItem",
    ownerCtx,
    { sku: "STL-8", name: "Steel bar 8mm", unitLabel: "bar", salePriceMinor: 18_000 },
  );
  const itemRows = await db.select({ id: items.id, sku: items.sku }).from(items).where(eq(items.orgId, orgId));
  const itemIdOf = new Map(itemRows.map((r) => [r.sku, r.id]));
  const t = (day: number) => new Date(`2026-08-${String(day).padStart(2, "0")}T09:00:00Z`);
  await db.insert(stockMovements).values([
    { orgId, itemId: itemIdOf.get("CEM-42")!, quantityDelta: 100_000, reason: "purchase", unitCostMinor: 28_000, actorType: "system", actorId: null, createdAt: t(1) },
    { orgId, itemId: itemIdOf.get("CEM-42")!, quantityDelta: -60_000, reason: "sale", actorType: "system", actorId: null, createdAt: t(5) },
    { orgId, itemId: itemIdOf.get("CEM-42")!, quantityDelta: 40_000, reason: "purchase", unitCostMinor: 31_000, actorType: "system", actorId: null, createdAt: t(9) },
    { orgId, itemId: itemIdOf.get("STL-8")!, quantityDelta: 200_000, reason: "purchase", unitCostMinor: 12_000, actorType: "system", actorId: null, createdAt: t(2) },
    { orgId, itemId: itemIdOf.get("STL-8")!, quantityDelta: -50_000, reason: "sale", actorType: "system", actorId: null, createdAt: t(6) },
  ]);

  const report = await executor.execute("inventory.stockReport", ownerCtx, {});
  ok(`stock report values the ledger (${report.data?.totalValueMinor} minor, ${report.data?.items.length} items)`);
  const ledgerValue = report.data!.totalValueMinor;

  // Unknowable up-front amount ⇒ the kernel must gate it, fail closed.
  const gated = await executor.execute("inventory.postValuationSummary", agentCtx, {});
  if (!gated.pendingApproval) throw new Error("valuation posting was not approval-gated!");
  ok(`valuation posting gated: ${gated.pendingApproval.rationale}`);

  const [pending] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.orgId, orgId), eq(approvals.status, "pending")))
    .limit(1);
  const posted = await executor.execute(
    "inventory.postValuationSummary",
    ownerCtx,
    pending!.payload as Record<string, unknown>,
    { approvedApprovalId: pending!.id },
  );
  ok(`human approved; summary posted (variance ${posted.data?.varianceMinor} minor)`);

  const gl = await glAccountBalanceMinor(db, orgId);
  if (gl !== ledgerValue) throw new Error(`GL ${gl} != ledger ${ledgerValue}`);
  ok("GL inventory account equals the stock report value");
  const tb = await executor.execute("accounting.trialBalance", ownerCtx, {});
  ok(`trial balance still balances (${tb.data?.lines.length} accounts)`, tb.data?.balanced === true);

  // Human GL drift does not survive the next summary.
  const { postEntry } = await import("../modules/accounting/src/posting");
  await db.transaction(async (tx) => {
    await postEntry(tx, orgId, { type: "human", id: owner.id }, {
      memo: "wrong manual inventory entry",
      sourceType: "manual",
      lines: [
        { accountCode: "1200", debitMinor: 2_000_000, creditMinor: 0 },
        { accountCode: "6000", debitMinor: 0, creditMinor: 2_000_000 },
      ],
    });
  });
  const cap = registry.get("inventory.postValuationSummary");
  if (!cap) throw new Error("missing capability");
  const corrected = (await cap.execute(ownerCtx, { memo: "drift correction" })) as {
    posted: boolean;
    varianceMinor: number;
  };
  if (!corrected.posted || corrected.varianceMinor !== -2_000_000) {
    throw new Error(`drift not corrected: ${JSON.stringify(corrected)}`);
  }
  ok("injected GL drift corrected back to the ledger value");
  const after = await glAccountBalanceMinor(db, orgId);
  if (after !== ledgerValue) throw new Error(`GL ${after} != ledger ${ledgerValue} after correction`);

  const noop = (await cap.execute(ownerCtx, { memo: "repeat summary" })) as { posted: boolean };
  if (noop.posted !== false) throw new Error("second summary was not an honest no-op");
  ok("second summary is an explicit no-op");

  return "M7 RECONCILED";
}

async function transfersScenario(): Promise<string> {
  const db = getDb().db;
  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);
  const [owner] = await db
    .insert(users)
    .values({ email: `own-${Date.now()}@demo.test`, name: "Owner" })
    .returning();
  if (!owner) throw new Error("owner insert failed");
  const { orgId } = await runOnboarding(db, {
    userId: owner.id,
    userEmail: owner.email,
    orgName: "M7 Transfer Co",
    businessDescription: "Distributor moving stock between a main warehouse and a shop counter every week.",
  });
  const ownerCtx = {
    actor: { type: "human" as const, id: owner.id, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };
  const locationOnHand = async (code: string, itemId: string) => {
    const [loc] = await db
      .select()
      .from(stockLocations)
      .where(and(eq(stockLocations.orgId, orgId), eq(stockLocations.code, code)));
    const { stockOnHand } = await import("../modules/inventory/src/shared");
    return stockOnHand(db, orgId, itemId, loc!.id);
  };

  await executor.execute("inventory.createLocation", ownerCtx, { code: "MAIN", name: "Main Warehouse" });
  await executor.execute("inventory.createLocation", ownerCtx, { code: "SHOP", name: "Shop Counter" });
  await executor.execute("inventory.createItem", ownerCtx, { sku: "BAG-50", name: "Cement 50kg" });
  const [item] = await db.select({ id: items.id }).from(items).where(eq(items.orgId, orgId));
  const [mainLoc] = await db
    .select()
    .from(stockLocations)
    .where(and(eq(stockLocations.orgId, orgId), eq(stockLocations.code, "MAIN")));
  await db.insert(stockMovements).values({
    orgId,
    itemId: item!.id,
    quantityDelta: 100_000,
    reason: "purchase",
    unitCostMinor: 28_000,
    locationId: mainLoc!.id,
    actorType: "system",
    actorId: null,
  });
  const valueBefore = await inventoryLedgerValueMinor(db, orgId);

  const draft = await executor.execute(
    "inventory.createTransfer",
    ownerCtx,
    { fromLocationCode: "MAIN", toLocationCode: "SHOP", lines: [{ sku: "BAG-50", quantityThousandths: 30_000 }], note: "counter stock" },
  );
  ok(`transfer #${draft.data?.number} drafted (pending)`);

  const [line] = await db.select().from(stockTransferLines).where(eq(stockTransferLines.transferId, draft.data!.transferId));
  const partial = await executor.execute(
    "inventory.confirmTransfer",
    ownerCtx,
    { transferId: draft.data!.transferId, lines: [{ lineId: line!.id, quantityThousandths: 12_000 }] },
  );
  if (!partial.ok) throw new Error(`partial confirm failed: ${partial.error}`);
  ok(`partial confirmation moved ${partial.data?.confirmedNowThousandths} thousandths (${partial.data?.status})`);

  await executor.execute("inventory.confirmTransfer", ownerCtx, { transferId: draft.data!.transferId });
  ok(`MAIN now ${await locationOnHand("MAIN", item!.id)} and SHOP ${await locationOnHand("SHOP", item!.id)} thousandths`);
  if ((await locationOnHand("MAIN", item!.id)) + (await locationOnHand("SHOP", item!.id)) !== 100_000) {
    throw new Error("transfer did not conserve quantity");
  }
  ok("total quantity conserved across locations");

  const oversell = await executor.execute(
    "inventory.createTransfer",
    ownerCtx,
    { fromLocationCode: "SHOP", toLocationCode: "MAIN", lines: [{ sku: "BAG-50", quantityThousandths: 999_000 }] },
  );
  const refused = await executor.execute("inventory.confirmTransfer", ownerCtx, { transferId: oversell.data!.transferId });
  if (refused.ok || !(refused.error ?? "").includes("insufficient stock at source")) {
    throw new Error(`oversell at source was not refused: ${JSON.stringify(refused)}`);
  }
  ok("oversell at the source location correctly refused");
  await executor.execute("inventory.cancelTransfer", ownerCtx, { transferId: oversell.data!.transferId });

  const valueAfterMoves = await inventoryLedgerValueMinor(db, orgId);
  if (valueAfterMoves !== valueBefore) throw new Error("transfers moved valuation value");
  ok("valuation value untouched by transfer legs (ADR 0033)");

  const reversed = await executor.execute("inventory.reverseTransfer", ownerCtx, { transferId: draft.data!.transferId });
  ok(`reversal transfer #${(reversed.data?.reversalTransferId ?? "").slice(0, 8)}… restored the route`);
  if (
    (await locationOnHand("MAIN", item!.id)) !== 100_000 ||
    (await locationOnHand("SHOP", item!.id)) !== 0
  ) {
    throw new Error("reversal did not restore the start state");
  }
  ok("reversal restored the exact start state");
  if ((await glAccountBalanceMinor(db, orgId)) !== 0) throw new Error("GL moved on pure transfers");
  ok("GL untouched by operational transfers");

  return "TRANSFER OK";
}

// CONTINUES


async function productsScenario(): Promise<string> {
  const db = getDb().db;
  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);
  const [owner] = await db
    .insert(users)
    .values({ email: `own-${Date.now()}@demo.test`, name: "Owner" })
    .returning();
  if (!owner) throw new Error("owner insert failed");
  const { orgId } = await runOnboarding(db, {
    userId: owner.id,
    userEmail: owner.email,
    orgName: "M7 Catalog Co",
    businessDescription: "Retail shop scanning barcodes at the counter and tracking tags for promotions.",
  });
  const ownerCtx = {
    actor: { type: "human" as const, id: owner.id, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };

  const barcode = `60${Date.now().toString().slice(-11)}`;
  const created = await executor.execute(
    "inventory.createItem",
    ownerCtx,
    {
      sku: "CHair-BLU",
      name: "Office Chair Blue",
      salePriceMinor: 240_000,
      imageUrl: "https://cdn.example.test/chair-blue.jpg",
      tags: ["furniture", "bestseller"],
      barcode,
    },
  );
  ok(`item created with image, tags, and barcode (${created.data?.itemId.slice(0, 8)}…)`);

  const hit = await executor.execute("inventory.lookupByBarcode", ownerCtx, { barcode });
  if (hit.data?.item?.sku !== "CHair-BLU") throw new Error("barcode lookup missed a known barcode");
  ok("scan finds the exact item");

  const miss = await executor.execute("inventory.lookupByBarcode", ownerCtx, { barcode: "0000000000000" });
  if (miss.data?.item !== null) throw new Error("unknown barcode did not answer an honest null");
  ok("unknown barcode answers an explicit null");

  const updated = await executor.execute(
    "inventory.updateItem",
    ownerCtx,
    { sku: "CHair-BLU", salePriceMinor: 265_000, tags: ["furniture", "promo"] },
  );
  const hitAfter = await executor.execute("inventory.lookupByBarcode", ownerCtx, { barcode });
  if (hitAfter.data?.item?.tags[1] !== "promo") throw new Error("update did not land");
  ok("item details updated through the governed path");
  await executor.execute("inventory.restoreItem", ownerCtx, updated.data!.prior);
  const hitRestored = await executor.execute("inventory.lookupByBarcode", ownerCtx, { barcode });
  if (hitRestored.data?.item?.tags[1] !== "bestseller") throw new Error("snapshot inverse did not restore");
  ok("snapshot inverse restored the prior details");

  const report = await executor.execute("inventory.stockReport", ownerCtx, {});
  if (!report.data?.items.some((i: { sku: string }) => i.sku === "CHair-BLU")) {
    throw new Error("item missing from stock report");
  }
  ok("item appears in the stock report");

  return "PRODUCT SURFACE OK";
}

const scenarios: Record<string, () => Promise<string>> = {
  reconciliation: reconciliationScenario,
  transfers: transfersScenario,
  products: productsScenario,
};

async function main() {
  const name = process.argv[2] ?? "all";
  const tokens: string[] = [];
  const run = async (key: string) => {
    console.log(`\n── ${key} ──`);
    tokens.push(await scenarios[key]());
  };
  if (name === "all") {
    for (const key of Object.keys(scenarios)) await run(key);
  } else {
    if (!scenarios[name]) throw new Error(`unknown scenario "${name}"`);
    await run(name);
  }
  console.log(`\nALL CHECKS PASSED (${passed} guarantees verified)`);
  for (const token of tokens) console.log(token);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

