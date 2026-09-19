import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  accounts,
  beginLedgerMaintenance,
  createDb,
  journalEntries,
  journalLines,
  ledgerEvents,
  organizations,
  purgeTenantFinancials,
  type Database,
} from "./index";

/**
 * N09 executable proof: the balanced-books and append-only invariants are
 * enforced by the database at commit time, not merely asserted by
 * application code. Refusals here are trigger/constraint refusals against
 * the run's fixture database (migrated from this branch by globalSetup -
 * provisioning a second database here was measured losing a hook-timeout
 * race under full-workspace parallel load) - the same negative proofs the
 * audit's N09 gate demands (unbalanced commit, incomplete entry, cross-org
 * account, posted-line mutation, ledger deletion), plus the positive path:
 * valid multi-line entries, governed reversals, and the declared
 * maintenance context used only by teardown and repair. The immutability
 * guards honor the maintenance context; the balance, completeness, and
 * tenancy guards never do - maintenance may delete history, but nothing
 * broken can ever commit.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
const orgA = crypto.randomUUID();
const orgB = crypto.randomUUID();

let cashA: string;
let arA: string;
let cashB: string;

/** Posts an entry and its lines in one transaction, like the posting service. */
async function postWithLines(
  orgId: string,
  lines: Array<{ accountId: string; debit: number; credit: number }>,
  opts: { memo?: string; reversalOfId?: string } = {},
): Promise<string> {
  return db.db.transaction(async (tx) => {
    const [entry] = await tx
      .insert(journalEntries)
      .values({
        orgId,
        memo: opts.memo ?? "guard probe",
        sourceType: "manual",
        reversalOfId: opts.reversalOfId ?? null,
        postedByActorType: "human",
      })
      .returning({ id: journalEntries.id });
    await tx.insert(journalLines).values(
      lines.map((l) => ({
        entryId: entry!.id,
        accountId: l.accountId,
        debitMinor: l.debit,
        creditMinor: l.credit,
      })),
    );
    return entry!.id;
  });
}

/** Adds one line to an existing entry in its own transaction (attack path). */
async function addLine(entryId: string, accountId: string, debit: number, credit: number): Promise<void> {
  await db.db.insert(journalLines).values({ entryId, accountId, debitMinor: debit, creditMinor: credit });
}

/** Drizzle wraps driver errors; match the refusal across message and cause. */
async function expectRefusal(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
    throw new Error(`expected refusal matching ${pattern}`);
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
    expect([err instanceof Error ? err.message : String(err), cause].join(" | ")).toMatch(pattern);
  }
}

beforeAll(async () => {
  db = createDb(url);
  await db.db.insert(organizations).values([
    { id: orgA, name: "Guard Org A", slug: `guard-a-${orgA.slice(0, 8)}` },
    { id: orgB, name: "Guard Org B", slug: `guard-b-${orgB.slice(0, 8)}` },
  ]);
  const rows = await db.db
    .insert(accounts)
    .values([
      { orgId: orgA, code: "1000", name: "Cash A", type: "asset" },
      { orgId: orgA, code: "1100", name: "AR A", type: "asset" },
      { orgId: orgB, code: "1000", name: "Cash B", type: "asset" },
    ])
    .returning({ id: accounts.id });
  cashA = rows[0]!.id;
  arA = rows[1]!.id;
  cashB = rows[2]!.id;
});

afterAll(async () => {
  await db?.client.end();
});

describe("commit-time ledger enforcement (N09)", () => {
  it("has enforcement triggers on the journal and event ledger", async () => {
    const res = await db.db.execute<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.triggers
       WHERE event_object_table IN ('journal_entries', 'journal_lines', 'ledger_events')
       AND trigger_name IN (
         'journal_lines_immutable', 'journal_entries_immutable', 'ledger_events_immutable',
         'journal_lines_no_truncate', 'journal_entries_no_truncate', 'ledger_events_no_truncate',
         'journal_lines_balanced_at_commit', 'journal_entries_complete_at_commit')`,
    );
    expect(Number((res[0] as unknown as { n: number }).n)).toBe(8);
  });

  it("accepts a valid balanced multi-line entry and its governed reversal", async () => {
    const entryId = await postWithLines(orgA, [
      { accountId: cashA, debit: 10000, credit: 0 },
      { accountId: arA, debit: 0, credit: 10000 },
    ], { memo: "valid sale" });
    const reversalId = await postWithLines(orgA, [
      { accountId: arA, debit: 10000, credit: 0 },
      { accountId: cashA, debit: 0, credit: 10000 },
    ], { memo: "reversal", reversalOfId: entryId });
    expect(reversalId).toBeTruthy();

    const rows = await db.db.select().from(journalLines).where(eq(journalLines.entryId, entryId));
    expect(rows).toHaveLength(2);
  });

  it("refuses an unbalanced entry at commit", async () => {
    await expectRefusal(
      postWithLines(orgA, [
        { accountId: cashA, debit: 10000, credit: 0 },
        { accountId: arA, debit: 0, credit: 5000 },
      ]),
      /unbalanced/,
    );
  });

  it("refuses a single-line entry at commit", async () => {
    await expectRefusal(
      postWithLines(orgA, [{ accountId: cashA, debit: 5000, credit: 0 }]),
      /at least two lines/,
    );
  });

  it("refuses an entry committed with no lines", async () => {
    await expectRefusal(
      db.db
        .insert(journalEntries)
        .values({ orgId: orgA, memo: "empty entry", sourceType: "manual", postedByActorType: "human" }),
      /at least two lines/,
    );
  });

  it("refuses a line whose account belongs to another org", async () => {
    await expectRefusal(
      postWithLines(orgA, [
        { accountId: cashA, debit: 7000, credit: 0 },
        { accountId: cashB, debit: 0, credit: 7000 },
      ]),
      /another organization/,
    );
  });

  it("re-checks balance when a line is added to an existing entry", async () => {
    const entryId = await postWithLines(orgA, [
      { accountId: cashA, debit: 4000, credit: 0 },
      { accountId: arA, debit: 0, credit: 4000 },
    ]);
    await expectRefusal(
      addLine(entryId, arA, 1000, 0),
      /unbalanced/,
    );
  });

  it("refuses UPDATE and DELETE of posted lines and entries outside maintenance", async () => {
    const entryId = await postWithLines(orgA, [
      { accountId: cashA, debit: 2500, credit: 0 },
      { accountId: arA, debit: 0, credit: 2500 },
    ], { memo: "immutable" });

    await expectRefusal(
      db.db.update(journalLines).set({ debitMinor: 2501 }).where(eq(journalLines.entryId, entryId)),
      /immutable/,
    );
    await expectRefusal(
      db.db.delete(journalLines).where(eq(journalLines.entryId, entryId)),
      /immutable/,
    );
    await expectRefusal(
      db.db.delete(journalEntries).where(eq(journalEntries.id, entryId)),
      /immutable/,
    );
    await expectRefusal(
      db.db
        .update(journalEntries)
        .set({ sourceId: crypto.randomUUID() })
        .where(eq(journalEntries.id, entryId)),
      /immutable/,
    );
  });

  it("refuses TRUNCATE of the journal tables outside maintenance", async () => {
    await expectRefusal(db.db.execute("TRUNCATE journal_lines"), /immutable/);
    // journal_entries is refused even earlier: its FK to lines (and lines'
    // rows) would be truncated away - the FK check names it before the
    // trigger can. Either way the table cannot be truncated.
    await expectRefusal(db.db.execute("TRUNCATE journal_entries"), /immutable|foreign key/);
  });

  it("refuses UPDATE, DELETE, and TRUNCATE of event-ledger rows outside maintenance", async () => {
    await db.db.insert(ledgerEvents).values({
      orgId: orgA,
      actorType: "system",
      kind: "guard.probe",
      payload: { n: 1 },
      hash: "0".repeat(64),
    });
    const [event] = await db.db.select({ id: ledgerEvents.id }).from(ledgerEvents).limit(1);
    await expectRefusal(
      db.db.update(ledgerEvents).set({ kind: "rewritten" }).where(eq(ledgerEvents.id, event!.id)),
      /immutable/,
    );
    await expectRefusal(
      db.db.delete(ledgerEvents).where(eq(ledgerEvents.id, event!.id)),
      /immutable/,
    );
    await expectRefusal(
      db.db.execute("TRUNCATE ledger_events"),
      /immutable/,
    );
  });

  it("declared maintenance context permits teardown deletes and repair staging", async () => {
    const entryId = await postWithLines(orgA, [
      { accountId: cashA, debit: 900, credit: 0 },
      { accountId: arA, debit: 0, credit: 900 },
    ], { memo: "repair target" });

    await beginLedgerMaintenance(db.db, async (tx) => {
      await tx.delete(journalLines).where(eq(journalLines.entryId, entryId));
      await tx.delete(journalEntries).where(eq(journalEntries.id, entryId));
      // A repair transaction may stage and remove rows, but it may not
      // COMMIT broken state: the staged row below is balanced, and the
      // commit-time guards stay unconditional for anything that persists.
      const [staged] = await tx
        .insert(journalEntries)
        .values({ orgId: orgA, memo: "staged repair row", sourceType: "manual", postedByActorType: "system" })
        .returning({ id: journalEntries.id });
      await tx.insert(journalLines).values([
        { entryId: staged!.id, accountId: cashA, debitMinor: 300, creditMinor: 0 },
        { entryId: staged!.id, accountId: arA, debitMinor: 0, creditMinor: 300 },
      ]);
      await tx.delete(journalLines).where(eq(journalLines.entryId, staged!.id));
      await tx.delete(journalEntries).where(eq(journalEntries.id, staged!.id));
    });
    const remaining = await db.db.select().from(journalEntries).where(eq(journalEntries.memo, "repair target"));
    expect(remaining).toEqual([]);

    // Negative control: the maintenance context buys deletion rights, not a
    // license to commit broken state.
    await expectRefusal(
      beginLedgerMaintenance(db.db, async (tx) => {
        await tx.insert(journalEntries).values({
          orgId: orgA,
          memo: "broken staged row",
          sourceType: "manual",
          postedByActorType: "system",
        });
      }),
      /at least two lines/,
    );

    await purgeTenantFinancials(db.db, orgA);
    const afterPurge = await db.db.select().from(journalEntries).where(eq(journalEntries.orgId, orgA));
    expect(afterPurge).toEqual([]);
  });
});
