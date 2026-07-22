/**
 * End-to-end verification against real PostgreSQL.
 * Usage: DATABASE_URL=... pnpm --filter @chaste/api e2e
 */
import { sql } from "drizzle-orm";
import { buildServer } from "./server.js";

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL required for e2e");
  }

  // Ensure schema
  const { default: postgres } = await import("postgres");
  // migrations already via migrate script — assume applied
  const { server, app } = await buildServer();
  await server.listen({ port: 0, host: "127.0.0.1" });
  const addr = server.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const results: Record<string, unknown> = {};

  const health = await fetch(`${base}/health`).then((r) => r.json());
  results.health = health;

  const session = await fetch(`${base}/api/v1/session`).then((r) => r.json());
  results.sessionEmail = (session as { email: string }).email;
  results.permissionCount = (session as { permissions: string[] }).permissions.length;

  const customer = await fetch(`${base}/api/v1/crm/customers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "E2E Acme", city: "Nairobi", country: "KE" }),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`create customer ${r.status} ${await r.text()}`);
    return r.json();
  });
  results.customer = (customer as { name: string }).name;

  const invoice = await fetch(`${base}/api/v1/accounting/invoices`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ number: `INV-E2E-${Date.now()}`, total: 199.5, currency: "USD" }),
  }).then((r) => r.json());
  results.invoice = (invoice as { number: string }).number;

  const product = await fetch(`${base}/api/v1/inventory/products`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sku: `SKU-${Date.now()}`, name: "E2E Widget" }),
  }).then((r) => r.json());
  results.product = (product as { sku: string }).sku;

  const vendor = await fetch(`${base}/api/v1/purchasing/vendors`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "E2E Vendor Co" }),
  }).then((r) => r.json());
  results.vendor = (vendor as { name: string }).name;

  const employee = await fetch(`${base}/api/v1/hr/employees`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      employeeNumber: `E-${Date.now()}`,
      fullName: "E2E Worker",
      baseSalary: 1200,
    }),
  }).then((r) => r.json());
  results.employee = (employee as { fullName: string }).fullName;

  const payroll = await fetch(`${base}/api/v1/hr/payroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ periodLabel: "E2E-2026-03" }),
  }).then((r) => r.json());
  results.payroll = (payroll as { status: string }).status;

  const chat1 = (await fetch(`${base}/api/v1/ai/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Create customer Beta AI Ltd in Kisumu" }),
  }).then((r) => r.json())) as { sessionId: string; pendingConfirmationId?: string };

  if (!chat1.pendingConfirmationId) {
    throw new Error("AI chat did not return pending confirmation");
  }

  await fetch(`${base}/api/v1/ai/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: chat1.sessionId,
      confirmId: chat1.pendingConfirmationId,
    }),
  });

  const customers = (await fetch(`${base}/api/v1/crm/customers`).then((r) => r.json())) as {
    items: { name: string }[];
  };
  results.customerNames = customers.items.map((c) => c.name);

  const rbac = await fetch(`${base}/api/v1/rbac`).then((r) => r.json());
  results.roles = (rbac as { roles: unknown[] }).roles.length;

  const marketplace = await fetch(`${base}/api/v1/marketplace`).then((r) => r.json());
  results.marketplace = (marketplace as { items: unknown[] }).items.length;

  const audit = await fetch(`${base}/api/v1/audit`).then((r) => r.json());
  results.auditEntries = (audit as { items: unknown[] }).items.length;

  // Prove Postgres persistence
  const countRows = await app.db.execute(sql`select count(*)::int as c from crm_customers`);
  const countArr = countRows as unknown as { c: number }[];
  results.dbCustomerCount = Number(countArr[0]?.c ?? 0);

  const ok =
    results.customer === "E2E Acme" &&
    (results.customerNames as string[]).includes("Beta AI Ltd") &&
    (results.permissionCount as number) > 10 &&
    (results.marketplace as number) >= 6 &&
    (results.auditEntries as number) >= 3;

  console.log(JSON.stringify({ ok, results }, null, 2));
  await server.close();
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
