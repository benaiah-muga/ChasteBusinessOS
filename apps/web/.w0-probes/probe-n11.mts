/**
 * W0 probe — N11 (AR side): "outstanding balances have diverged across
 * consumers".
 *
 * schema/index.ts documents `balance = total − paid − credited` for
 * invoices, but `accounting.recordPayment` gates on
 * `paid + amount <= total` only (modules/accounting/src/index.ts:304).
 * Demonstrates that a 100.00 invoice carrying a 40.00 credit accepts a
 * full 100.00 payment — 40.00 beyond the true 60.00 outstanding.
 * Runs on a throwaway fixture database.
 */
import { eq } from "drizzle-orm";
import { createDb, invoices } from "@chaste/db";
import { CapabilityRegistry, KernelExecutor } from "@chaste/kernel";
import { registerAccountingCapabilities } from "@chaste/module-accounting";
import { dropFixtureDatabase, provisionFixtureDatabase } from "@chaste/db/test-fixture";

const fixture = await provisionFixtureDatabase({ prefix: "probe_n11" });
const pg = createDb(fixture.url);
const db = pg.db;

const orgId = crypto.randomUUID();
await db.execute(`INSERT INTO organizations (id, name, slug) VALUES ('${orgId}', 'N11 Probe Org', 'n11-probe')`);
await db.execute(`INSERT INTO accounts (id, org_id, code, name, type) VALUES
  ('${crypto.randomUUID()}', '${orgId}', '1000', 'Cash', 'asset'),
  ('${crypto.randomUUID()}', '${orgId}', '1100', 'AR', 'asset')`);
const customerId = crypto.randomUUID();
await db.execute(`INSERT INTO customers (id, org_id, name) VALUES ('${customerId}', '${orgId}', 'Probe Customer')`);
await db.execute(`INSERT INTO invoices (id, org_id, customer_id, number, status, subtotal_minor, tax_minor,
  total_minor, paid_minor, credited_minor, currency, issued_at)
  VALUES ('${crypto.randomUUID()}', '${orgId}', '${customerId}', 1, 'sent', 10000, 0, 10000, 0, 4000, 'USD', now())`);

const registry = new CapabilityRegistry();
registerAccountingCapabilities(registry, { db });
const executor = new KernelExecutor({ registry, ledger: { append: async () => {} } });

const result = await executor.execute(
  "accounting.recordPayment",
  {
    actor: { type: "human", id: crypto.randomUUID(), orgId, permissions: new Set(["accounting.post"]) },
    now: new Date(),
    services: {},
  },
  { invoiceNumber: 1, amountMinor: 10000, method: "bank_transfer" },
);

const [inv] = await db.select().from(invoices).where(eq(invoices.orgId, orgId)).limit(1);

console.log("N11 probe (fresh fixture DB):");
console.log("  invoice state before payment: total 10000, credited 4000, paid 0 (true outstanding 6000)");
console.log("  recordPayment of full 10000:", result.ok ? "ACCEPTED" : `refused (${result.error})`);
console.log("  invoice after payment: paid", inv!.paidMinor, "credited", inv!.creditedMinor);
const discharged = !result.ok && typeof result.error === "string" && result.error.includes("outstanding is 6000");
console.log(
  "  VERDICT:",
  discharged
    ? "DISCHARGED — payment capped at credit-adjusted outstanding (6000) by the shared balance contract"
    : result.ok
      ? "REGRESSION — payment still accepted past credit-adjusted outstanding"
      : "NOT REPRODUCED",
);
if (!discharged) process.exit(1);

await pg.client.end();
await dropFixtureDatabase({ database: fixture.database });
