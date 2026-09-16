import { sql } from "drizzle-orm";
import type { Database, Tx } from "./client";

/**
 * Declared maintenance context for the append-only ledger (N09 / ADR 0052).
 *
 * Migrations enforce at commit time what application code used to merely
 * assert: journals balance, entries are complete, posted rows never change.
 * Those guards fail closed for every ordinary code path. Fixture teardowns
 * and out-of-band repair transactions opt out explicitly, per transaction,
 * by setting `app.ledger_maintenance = 'on'` — every use of this helper is
 * a greppable, intentional act; the runtime application never calls it.
 */

export async function beginLedgerMaintenance<T>(
  db: Database["db"],
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.ledger_maintenance', 'on', true)`);
    return fn(tx);
  });
}

/**
 * Removes a tenant's immutable history — journal lines/entries, event-ledger
 * rows, and stock movements — inside one declared maintenance transaction.
 * Call it before deleting the organization row: the org cascade would
 * otherwise fire the immutability guards, and ledger_events restrict-deletes
 * on a surviving org reference.
 */
export async function purgeTenantFinancials(db: Database["db"], orgId: string): Promise<void> {
  await beginLedgerMaintenance(db, async (tx) => {
    await tx.execute(
      sql`DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE org_id = ${orgId})`,
    );
    await tx.execute(sql`DELETE FROM journal_entries WHERE org_id = ${orgId}`);
    await tx.execute(sql`DELETE FROM ledger_events WHERE org_id = ${orgId}`);
    await tx.execute(sql`DELETE FROM stock_movements WHERE org_id = ${orgId}`);
  });
}
