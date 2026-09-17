/**
 * N22: lock-duration and query-plan review against seeded history.
 *
 * Seeds ~40k stock movements across 200 items for one probe org, then
 * compares the two ways to answer "how much of item X is on hand":
 *   ledger sum  — sum(quantity_delta) over the item's movements
 *   projection  — sum(quantity) over its stock_balances rows (trigger-maintained)
 * and prints the EXPLAIN plans and timings. The projection read scans a
 * handful of balance rows; the ledger sum scans every movement of the
 * item's lifetime. Run with the dev database up:
 *
 *   pnpm exec tsx scripts/n22-projection-review.ts
 */
import { sql } from "drizzle-orm";
import { createDb, organizations, purgeTenantFinancials } from "@chaste/db";

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
const db = createDb(url);
const orgId = crypto.randomUUID();
const ITEMS = 200;
const MOVEMENTS_PER_ITEM = 200;

async function timed(query: string): Promise<{ ms: number; result: string }> {
  const start = performance.now();
  const res = await db.db.execute(sql.raw(query));
  const ms = performance.now() - start;
  return { ms, result: JSON.stringify(res.rows ?? res) };
}

async function main() {
  // A previous run may have left its probe org behind; its movements are
  // immutable, so teardown must go through the declared maintenance context.
  const leftover = await db.db.execute(sql`SELECT id FROM organizations WHERE name = 'Projection Review Probe'`);
  const leftoverRows = (Array.isArray(leftover) ? leftover : leftover.rows) as { id: string }[];
  for (const row of leftoverRows) {
    await purgeTenantFinancials(db.db, row.id);
    await db.db.delete(organizations).where(sql`id = ${row.id}`);
  }  await db.db.insert(organizations).values({ id: orgId, name: 'Projection Review Probe', slug: `pr-${orgId.slice(0, 8)}` });

  console.log(`seeding ${ITEMS} items × ${MOVEMENTS_PER_ITEM} movements…`);
  await db.db.execute(sql.raw(`
    INSERT INTO items (id, org_id, sku, name, sale_price_minor)
    SELECT gen_random_uuid(), '${orgId}', 'PR-' || g, 'Review item ' || g, 100
    FROM generate_series(1, ${ITEMS}) g
  `));
  await db.db.execute(sql.raw(`
    INSERT INTO stock_movements (org_id, item_id, quantity_delta, reason, actor_type)
    SELECT '${orgId}', i.id, (floor(random() * 21) - 10)::int * 100, 'adjustment', 'system'
    FROM items i, generate_series(1, ${MOVEMENTS_PER_ITEM}) g
    WHERE i.org_id = '${orgId}'
  `));

  const [oneItem] = await db.db.execute<{ id: string }>(sql.raw(`SELECT id FROM items WHERE org_id = '${orgId}' ORDER BY sku LIMIT 1`)).then((r) => (Array.isArray(r) ? r : r.rows) as { id: string }[]);

  const ledgerPlan = await timed(`EXPLAIN ANALYZE SELECT coalesce(sum(quantity_delta), 0) FROM stock_movements WHERE org_id = '${orgId}' AND item_id = '${oneItem!.id}'`);
  const projPlan = await timed(`EXPLAIN ANALYZE SELECT coalesce(sum(quantity), 0) FROM stock_balances WHERE org_id = '${orgId}' AND item_id = '${oneItem!.id}'`);
  const ledgerAll = await timed(`SELECT coalesce(sum(quantity_delta), 0) AS q FROM stock_movements WHERE org_id = '${orgId}' AND item_id = '${oneItem!.id}'`);
  const projAll = await timed(`SELECT coalesce(sum(quantity), 0) AS q FROM stock_balances WHERE org_id = '${orgId}' AND item_id = '${oneItem!.id}'`);

  console.log("\n─ ledger read (sum over movements) ─");
  console.log(ledgerPlan.result);
  console.log(`first timed read: ${ledgerAll.ms.toFixed(1)}ms → ${ledgerAll.result}`);
  console.log("\n─ projection read (sum over balances) ─");
  console.log(projPlan.result);
  console.log(`first timed read: ${projAll.ms.toFixed(1)}ms → ${projAll.result}`);

  const [{ rows: balanceRows }] = (await db.db.execute(sql.raw(`SELECT count(*)::int AS rows FROM stock_balances WHERE org_id = '${orgId}'`)).then((r) => (Array.isArray(r) ? r : r.rows) as { rows: number }[])) as unknown as [{ rows: number }];
  console.log(`\nprojection rows for ${ITEMS} items: ${balanceRows}`);
  console.log("movements per read only grow with history; balance rows per item stay bounded by locations × lots.");

  await purgeTenantFinancials(db.db, orgId);
  await db.db.delete(organizations).where(sql`id = ${orgId}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
