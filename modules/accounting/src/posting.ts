import { eq, inArray, and, sql } from "drizzle-orm";
import { accounts, journalEntries, journalLines, organizations, periods } from "@chaste/db";
import { assertBalanced, isPeriodOpen } from "@chaste/erp-core";
import type { Database, Tx } from "@chaste/db";

/**
 * The one way to write to the general ledger.
 *
 * Every money-moving capability across every module composes this service
 * instead of hand-rolling entry+line inserts. It owns the invariants that
 * used to be copy-pasted (and had already drifted): the closed-period guard
 * under a lock shared with close/reopen, chart-of-accounts resolution,
 * balance assertion, and the immutable two-row posting pattern.
 * Cross-module imports of this file are deliberate: posting IS accounting's
 * bounded context; other modules hold business events, never GL internals
 * of their own.
 */

export interface PostEntryCmd {
  memo: string;
  sourceType: string;
  sourceId?: string | null;
  reversalOfId?: string | null;
  /**
   * Bookkeeping machinery marker. Only the year-end roll and corrections
   * set a non-operational kind; operating reports exclude both, and at most
   * one live year_end_close roll exists per sealed year.
   */
  entryKind?: "operational" | "year_end_close" | "correction";
  /**
   * For corrections: the original business date whose activity this entry
   * reverses, kept separately from postedAt (the approved open period the
   * correction lands in). A backdated fix must never lie about either.
   */
  businessAt?: Date | null;
  /**
   * The entry's effective posting time. Mandatory: the closed-period guard
   * and the stored column read this same instant, so a caller can never
   * guard one date and silently post under another (N13).
   */
  postedAt: Date;
  /**
   * One currency per entry (ADR 0021). Omitted = this org's base currency,
   * resolved here so callers cannot accidentally post unlabeled foreign
   * amounts.
   */
  currency?: string;
  lines: Array<{
    /** Account code, resolved against this org's chart of accounts. */
    accountCode?: string;
    /** Pre-resolved account id (reversals mirror the original's accounts). */
    accountId?: string;
    debitMinor: number;
    creditMinor: number;
  }>;
}

export type ActorStamp = { type: string; id: string | null };

/**
 * Distinct key class from the ledger chain lock (kernel 7_214_811) so the
 * two never collide; hashtext(orgId) scopes one lock lane per tenant.
 */
const PERIOD_LOCK_CLASS = 7_362_911;

/**
 * Serializes posting against period close/reopen for one org. Transaction-
 * scoped: whoever acquires it first defines the serial order - a close that
 * commits before a posting makes the posting refuse; a posting that commits
 * first is already on the books when the close seals the month.
 */
export async function lockPeriodsForOrg(tx: Tx, orgId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${PERIOD_LOCK_CLASS}, hashtext(${orgId}))`);
}

/** Posting into a closed period is rejected; books are sealed, not edited. */
export async function assertPeriodOpen(tx: Tx | Database["db"], orgId: string, date: Date): Promise<void> {
  const closed = await tx
    .select({ year: periods.year, month: periods.month })
    .from(periods)
    .where(eq(periods.orgId, orgId));
  if (!isPeriodOpen(closed, date)) {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    throw new Error(`period ${y}-${String(m).padStart(2, "0")} is closed; post to the current period or reopen it`);
  }
}

export async function loadCoaMap(tx: Tx | Database["db"], orgId: string): Promise<Map<string, string>> {
  const rows = await tx.select({ code: accounts.code, id: accounts.id }).from(accounts).where(eq(accounts.orgId, orgId));
  return new Map(rows.map((r) => [r.code, r.id]));
}

export function accountIdOf(map: Map<string, string>, code: string): string {
  const id = map.get(code);
  if (!id) throw new Error(`account ${code} missing from chart of accounts`);
  return id;
}

/**
 * Asserts the period is open under the close/reopen lock, asserts balance,
 * resolves account codes, and inserts the entry + its lines inside the
 * caller's transaction. Returns the entry id so callers can link their
 * subledger row and declare inverses.
 */
export async function postEntry(
  tx: Tx,
  orgId: string,
  actor: ActorStamp,
  cmd: PostEntryCmd,
): Promise<string> {
  await lockPeriodsForOrg(tx, orgId);
  await assertPeriodOpen(tx, orgId, cmd.postedAt);
  assertBalanced({ memo: cmd.memo, lines: cmd.lines });
  const map = await loadCoaMap(tx, orgId);
  const accountIds = cmd.lines.map((l) => {
    if (l.accountId) return l.accountId;
    if (l.accountCode) return accountIdOf(map, l.accountCode);
    throw new Error("posting line needs an accountCode or accountId");
  });
  // Pre-resolved ids (reversals mirror the original's accounts) are validated
  // against posting eligibility here, in the one door to the ledger: an id
  // from another org would cross the tenant boundary, an archived account
  // would post behind the chart of accounts' back.
  const known = await tx
    .select({ id: accounts.id, code: accounts.code, archivedAt: accounts.archivedAt })
    .from(accounts)
    .where(and(inArray(accounts.id, accountIds), eq(accounts.orgId, orgId)));
  const byId = new Map(known.map((a) => [a.id, a]));
  for (const id of accountIds) {
    const acct = byId.get(id);
    if (!acct) throw new Error(`account ${id} does not belong to this organization or does not exist`);
    if (acct.archivedAt) throw new Error(`account ${acct.code} is archived; reopen it before posting`);
  }
  const [entry] = await tx
    .insert(journalEntries)
    .values({
      orgId,
      memo: cmd.memo,
      sourceType: cmd.sourceType,
      sourceId: cmd.sourceId ?? null,
      reversalOfId: cmd.reversalOfId ?? null,
      entryKind: cmd.entryKind ?? "operational",
      businessAt: cmd.businessAt ?? null,
      currency: cmd.currency ?? (await baseCurrencyOf(tx, orgId)),
      postedAt: cmd.postedAt,
      postedByActorType: actor.type,
      postedByActorId: actor.id,
    })
    .returning({ id: journalEntries.id });
  await tx.insert(journalLines).values(
    cmd.lines.map((l, i) => ({
      entryId: entry!.id,
      accountId: accountIds[i]!,
      debitMinor: l.debitMinor,
      creditMinor: l.creditMinor,
    })),
  );
  return entry!.id;
}

/** Org base currency; USD fallback mirrors the column default for tests. */
export async function baseCurrencyOf(tx: Tx | Database["db"], orgId: string): Promise<string> {
  const [org] = await tx
    .select({ code: organizations.baseCurrency })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return org?.code ?? "USD";
}
