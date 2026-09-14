/**
 * W0 probe — N09: "database integrity guarantees are not established by
 * migrations".
 *
 * Against a throwaway fixture database migrated from this branch's own
 * migrations, demonstrates:
 *   1. no triggers exist on the journal tables;
 *   2. no constraint blocks an unbalanced journal entry;
 *   3. posted journal lines can be mutated and deleted (no immutability).
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

const entryId = crypto.randomUUID();
await db.execute(`INSERT INTO journal_entries (id, org_id, memo, posted_by_actor_type)
  VALUES ('${entryId}', '${orgId}', 'probe entry', 'human')`);
const lineA = crypto.randomUUID();
const lineB = crypto.randomUUID();
const accountIds = await db.execute<{ id: string }>(`SELECT id FROM accounts WHERE org_id = '${orgId}' ORDER BY code`);
await db.execute(`INSERT INTO journal_lines (id, entry_id, account_id, debit_minor, credit_minor) VALUES
  ('${lineA}', '${entryId}', '${accountIds[0]!.id}', 10000, 0),
  ('${lineB}', '${entryId}', '${accountIds[1]!.id}', 0, 5000)`);

const triggers = await db.execute<{ n: string }>(
  `SELECT count(*)::text AS n FROM information_schema.triggers
   WHERE event_object_table IN ('journal_entries', 'journal_lines')`,
);
const constraints = await db.execute<{ conname: string; contype: string }>(
  `SELECT conname, contype FROM pg_constraint
   WHERE conrelid = 'journal_lines'::regclass ORDER BY contype, conname`,
);
const unbalanced = await db.execute<{ n: string }>(
  `SELECT count(*)::text AS n FROM journal_lines WHERE entry_id = '${entryId}'`,
);
await db.execute(`UPDATE journal_lines SET debit_minor = debit_minor + 1 WHERE id = '${lineA}'`);
const afterUpdate = await db.execute<{ debit_minor: number }>(`SELECT debit_minor FROM journal_lines WHERE id = '${lineA}'`);
await db.execute(`DELETE FROM journal_lines WHERE id = '${lineB}'`);
const afterDelete = await db.execute<{ n: string }>(`SELECT count(*)::text AS n FROM journal_lines WHERE id = '${lineB}'`);

console.log("N09 probe (fresh fixture DB, branch migrations):");
console.log("  triggers on journal tables:", triggers[0]!.n);
console.log("  constraints on journal_lines:", constraints.map((r) => `${r.conname}(${r.contype})`).join(", ") || "none");
console.log("  unbalanced entry (10000/5000) committed:", unbalanced[0]!.n === "2");
console.log("  UPDATE of posted line succeeded:", Number(afterUpdate[0]?.debit_minor) === 10001);
console.log("  DELETE of posted line succeeded:", afterDelete[0]?.n === "0");
const confirmed =
  triggers[0]!.n === "0" && unbalanced[0]!.n === "2" && Number(afterUpdate[0]?.debit_minor) === 10001 && afterDelete[0]?.n === "0";
console.log("  VERDICT:", confirmed ? "CONFIRMED — no DB-enforced balance or immutability" : "NOT REPRODUCED");

await client.end();
await dropFixtureDatabase({ database: fixture.database });
