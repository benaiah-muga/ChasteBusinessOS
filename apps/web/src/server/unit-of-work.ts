import type { ActionContext, CapabilityResult } from "@chaste/kernel";
import { withOrgContext, type Database } from "@chaste/db";
import { buildExecutor, composeRegistry } from "./kernel";

/**
 * B02 unit of work for one governed action: mutation, audit fact and action
 * receipt commit or roll back together. Modules open their own transactions
 * from their `db` handle — handed a transaction they nest via savepoints, so
 * a capability executing against the transaction-scoped registry lands
 * entirely inside this unit. Audit failures rethrow (failOnAuditError),
 * rolling the whole unit back: a retry starts clean instead of reconciling
 * an unknown outcome.
 */
export async function executeAtomically<O>(options: {
  db: Database["db"];
  orgId: string;
  ctx: ActionContext;
  capabilityId: string;
  input: unknown;
}): Promise<CapabilityResult<O>> {
  return withOrgContext(options.db, options.orgId, async (tx) => {
    // The transaction handle satisfies the db interface at runtime; the cast
    // is the B02 seam until module repositories accept an executor directly.
    const txAsDb = tx as unknown as Database["db"];
    const executor = buildExecutor(txAsDb, composeRegistry(txAsDb), { failOnAuditError: true });
    const result = await executor.execute(options.capabilityId, options.ctx, options.input);
    return result as CapabilityResult<O>;
  });
}
