import { sql, type SQL } from "drizzle-orm";
import type { Database, Tx } from "./client";

type DbLike = Tx | Database["db"];

/**
 * N22: one per-org document-number allocator. Every module used to run its
 * own `max(number)+1`, which races under two concurrent creators and
 * duplicates (or dies on the unique index). The counter row is locked by
 * the UPDATE until the caller's transaction commits, so numbers are unique
 * per (org, kind) with no retry loop; the first allocation seeds from the
 * existing MAX so legacy documents are honored.
 */

const SEQUENCES: Record<string, { table: string; column: string }> = {
  invoice: { table: "invoices", column: "number" },
  quote: { table: "quotes", column: "number" },
  work_order: { table: "work_orders", column: "number" },
  vendor_bill: { table: "vendor_bills", column: "number" },
  purchase_order: { table: "purchase_orders", column: "number" },
  goods_receipt: { table: "goods_receipts", column: "number" },
  sales_order: { table: "sales_orders", column: "number" },
  support_ticket: { table: "support_conversations", column: "ticket_number" },
};

const executeReturningNext = async (db: DbLike, query: SQL): Promise<unknown> => {
  // drizzle's execute() returns bare rows on postgres-js and a { rows }
  // envelope on node-postgres; accept both so the allocator is driver-agnostic.
  const result = (await (db as { execute: (q: SQL) => Promise<unknown> }).execute(query)) as
    | { next?: unknown }[]
    | { rows: { next?: unknown }[] };
  if (Array.isArray(result)) return result[0]?.next;
  return result.rows?.[0]?.next;
};

/** Allocates the next document number for one (org, kind) sequence. */
export async function nextDocNumber(db: DbLike, orgId: string, kind: string): Promise<number> {
  const seq = SEQUENCES[kind];
  if (!seq) throw new Error(`unknown document sequence "${kind}"`);
  const next = await executeReturningNext(
    db,
    sql`INSERT INTO doc_counters (org_id, kind, "next")
        SELECT ${orgId}, ${kind}, COALESCE(MAX(${sql.raw(`"${seq.table}"."${seq.column}"`)}), 0) + 1 FROM ${sql.raw(`"${seq.table}"`)}
        WHERE ${sql.raw(`"${seq.table}"`)}."org_id" = ${orgId}
        ON CONFLICT (org_id, kind) DO UPDATE SET "next" = doc_counters."next" + 1
        RETURNING "next"`,
  );
  if (next === undefined || next === null) throw new Error(`could not allocate a ${kind} number`);
  return Number(next);
}
