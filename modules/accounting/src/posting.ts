import { eq } from "drizzle-orm";
import { accounts, journalEntries, journalLines, organizations, periods } from "@chaste/db";
import { assertBalanced, isPeriodOpen } from "@chaste/erp-core";
import type { Database, Tx } from "@chaste/db";

/**
 * The one way to write to the general ledger.
 *
 * Every money-moving capability across every module composes this service
 * instead of hand-rolling entry+line inserts. It owns the invariants that
 * used to be copy-pasted (and had already drifted): period-open guard with
 * consistent semantics, chart-of-accounts resolution, balance assertion,
 * and the immutable two-row posting pattern. Cross-module imports of this
 * file are deliberate: posting IS accounting's bounded context; other
 * modules hold business events, never GL internals of their own.
 */

export interface PostEntryCmd {
  memo: string;
  sourceType: string;
  sourceId?: string | null;
  reversalOfId?: string | null;
  /** Override the posting timestamp (e.g. year-end close posts Dec 31). */
  postedAt?: Date;
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
 * Asserts balance, resolves account codes, and inserts the entry + its
 * lines atomically inside the caller's transaction. Returns the entry id
 * so callers can link their subledger row and declare inverses.
 */
export async function postEntry(
  tx: Tx,
  orgId: string,
  actor: ActorStamp,
  cmd: PostEntryCmd,
): Promise<string> {
  assertBalanced({ memo: cmd.memo, lines: cmd.lines });
  const map = await loadCoaMap(tx, orgId);
  const accountIds = cmd.lines.map((l) => {
    if (l.accountId) return l.accountId;
    if (l.accountCode) return accountIdOf(map, l.accountCode);
    throw new Error("posting line needs an accountCode or accountId");
  });
  const [entry] = await tx
    .insert(journalEntries)
    .values({
      orgId,
      memo: cmd.memo,
      sourceType: cmd.sourceType,
      sourceId: cmd.sourceId ?? null,
      reversalOfId: cmd.reversalOfId ?? null,
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
