import type { CommandHelpers } from "@chaste/kernel";
import * as schema from "./schema.js";
import { PostgresAuditWriter, PostgresOutboxWriter } from "./adapters.js";
import type { Db } from "./client.js";

/**
 * Build a `CommandHelpers` whose transaction scopes business writes, the outbox
 * event, and the success audit into a single DB transaction (transactional
 * outbox pattern). The kernel's `executeCommand` owns the transaction boundary
 * and calls `transaction()`; each command handler writes via `helpers.db`
 * (the transaction-scoped handle).
 */
export function createCommandHelpers(base: {
  audit: PostgresAuditWriter;
  outbox: PostgresOutboxWriter;
  db: Db;
}): CommandHelpers {
  const runTransaction: CommandHelpers["transaction"] = (fn) =>
    // `tx` (drizzle PgTransaction) is structurally compatible with `Db` for the
    // query methods used here; the cast is confined to this adapter boundary.
    base.db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const txHelpers: CommandHelpers = {
        audit: new PostgresAuditWriter(txDb),
        outbox: new PostgresOutboxWriter(txDb),
        db: txDb,
        transaction: runTransaction,
      };
      return fn(txHelpers);
    });

  return {
    audit: base.audit,
    outbox: base.outbox,
    db: base.db,
    transaction: runTransaction,
  };
}