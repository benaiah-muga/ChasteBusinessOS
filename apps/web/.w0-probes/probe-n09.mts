/**
 * W0 probe — N09: "database integrity guarantees are not established by
 * migrations". DISCHARGED by migration 0046 (commit-time ledger enforcement).
 *
 * Against a throwaway fixture database migrated from this branch's own
 * migrations, verifies the discharged state:
 *   1. enforcement triggers exist on the journal tables;
 *   2. an unbalanced journal entry is refused at commit;
 *   3. posted journal lines refuse mutation and deletion.
 * Non-mutating in every real environment: the probe runs on a database it
 * created and drops itself.
 */
import { createDb } from "@chaste/db";
import { dropFixtureDatabase, provisionFixtureDatabase } from "@chaste/db/test-fixture";

const fixture = await provisionFixtureDatabase({ prefix: "probe_n09" });
const { db, client } = createDb(fixture.url);

const orgId = crypto.randomUUID();
await db.execute(`INSERT INTO organizations (id, name, slug) VALUES ('${orgId}', 'N09 Probe Org', 'n09-probe')`);
await db.execute(`INSERT INTO accounts (id, org_id, code, name, type) VALUES
  ('${crypto.randomUUID()}', '${orgId}', '1000', 'Cash', 'asset'),
  ('${crypto.randomUUID()}', '${orgId}', '1100', 'AR', 'asset')`);

const triggers = await db.execute<{ n: string }>(
  `SELECT count(*)::text AS n FROM information_schema.triggers
   WHERE event_object_table IN ('journal_entries', 'journal_lines', 'ledger_events')
   AND trigger_name IN (
     'journal_lines_immutable', 'journal_entries_immutable', 'ledger_events_immutable',
     'journal_lines_no_truncate', 'journal_entries_no_truncate', 'ledger_events_no_truncate',
     'journal_lines_balanced_at_commit', 'journal_entries_complete_at_commit')`,
);

// An unbalanced entry must be refused at commit.
const entryId = crypto.randomUUID();
const accountIds = await db.execute<{ id: string }>(`SELECT id FROM accounts WHERE org_id = '${orgId}' ORDER BY code`);
let unbalancedRefused = false;
let unbalancedMessage = "";
try {
  await db.execute(`INSERT INTO journal_entries (id, org_id, memo, posted_by_actor_type)
    VALUES ('${entryId}', '${orgId}', 'probe entry', 'human')`);
  await db.execute(`INSERT INTO journal_lines (id, entry_id, account_id, debit_minor, credit_minor) VALUES
    ('${crypto.randomUUID()}', '${entryId}', '${accountIds[0]!.id}', 10000, 0),
    ('${crypto.randomUUID()}', '${entryId}', '${accountIds[1]!.id}', 0, 5000)`);
} catch (err) {
  unbalancedRefused = true;
  unbalancedMessage = err instanceof Error ? err.message : String(err);
}

// A posted line must refuse mutation and deletion.
let mutationRefused = false;
let deletionRefused = false;
const [lineA] = await db.execute<{ id: string }>(
  `SELECT id FROM journal_lines WHERE entry_id = '${entryId}' LIMIT 1`,
);
try {
  await db.execute(`UPDATE journal_lines SET debit_minor = debit_minor + 1 WHERE id = '${lineA!.id}'`);
} catch {
  mutationRefused = true;
}
try {
  await db.execute(`DELETE FROM journal_lines WHERE id = '${lineA!.id}'`);
} catch {
  deletionRefused = true;
}

console.log("N09 probe (fresh fixture DB, branch migrations):");
console.log("  enforcement triggers on journal/ledger tables:", triggers[0]!.n, "(expect 8)");
console.log("  unbalanced entry (10000/5000) refused at commit:", unbalancedRefused);
console.log("  UPDATE of posted line refused:", mutationRefused);
console.log("  DELETE of posted line refused:", deletionRefused);
const discharged =
  triggers[0]!.n === "8" && unbalancedRefused && mutationRefused && deletionRefused;
console.log("  VERDICT:", discharged ? "N09 DISCHARGED — DB enforces balance and immutability" : "STILL OPEN");
if (unbalancedMessage) console.log("  refusal message:", unbalancedMessage.slice(0, 120));

await client.end();
await dropFixtureDatabase({ database: fixture.database });
if (!discharged) process.exit(1);
