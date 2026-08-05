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
  const customerId = (customer as { id: string }).id;

  // CRM depth contract (update, status, contact, interaction, soft delete)
  const updated = await fetch(`${base}/api/v1/crm/customers/${customerId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ city: "Mombasa", name: "E2E Acme Updated" }),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`update customer ${r.status} ${await r.text()}`);
    return r.json();
  });
  results.crmUpdatedCity = (updated as { city: string }).city;

  const moved = await fetch(`${base}/api/v1/crm/customers/${customerId}/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "negotiable", note: "Moved in e2e" }),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`setStatus ${r.status} ${await r.text()}`);
    return r.json();
  });
  results.crmStatus = (moved as { status: string }).status;

  const contact = await fetch(`${base}/api/v1/crm/customers/${customerId}/contacts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Jane Ops", role: "Procurement", email: "jane@acme.example" }),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`create contact ${r.status} ${await r.text()}`);
    return r.json();
  });
  results.crmContact = (contact as { name: string }).name;

  const contacts = await fetch(`${base}/api/v1/crm/customers/${customerId}/contacts`).then(
    (r) => r.json() as Promise<{ items: unknown[] }>,
  );
  results.crmContactCount = contacts.items.length;

  const interaction = await fetch(`${base}/api/v1/crm/customers/${customerId}/interactions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "call", summary: "Discovery call", detail: "Discussed needs" }),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`log interaction ${r.status} ${await r.text()}`);
    return r.json();
  });
  results.crmInteraction = (interaction as { kind: string }).kind;

  const interactions = await fetch(`${base}/api/v1/crm/customers/${customerId}/interactions`).then(
    (r) => r.json() as Promise<{ items: unknown[] }>,
  );
  results.crmInteractionCount = interactions.items.length;

  const archived = await fetch(`${base}/api/v1/crm/customers/${customerId}`, {
    method: "DELETE",
  }).then(async (r) => {
    if (!r.ok) throw new Error(`delete customer ${r.status} ${await r.text()}`);
    return r.json();
  });
  results.crmDeleted = (archived as { deleted: boolean }).deleted;

  const afterDelete = await fetch(
    `${base}/api/v1/crm/customers?search=E2E%20Acme%20Updated`,
  ).then((r) => r.json() as Promise<{ items: { name: string; status: string }[] }>);
  results.crmHiddenAfterDelete = afterDelete.items.length === 0;

  // Business partner master data (ADR 0009): create, update, list-filter, archive
  const bp = await fetch(`${base}/api/v1/business-partners`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "organization", name: "E2E Partner Co", email: "ops@partner.example", city: "Kisumu" }),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`create bp ${r.status} ${await r.text()}`);
    return r.json();
  });
  results.bpCreated = (bp as { name: string }).name;
  const bpId = (bp as { id: string }).id;

  const bpUpdated = await fetch(`${base}/api/v1/business-partners/${bpId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ city: "Eldoret", notes: "Updated in e2e" }),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`update bp ${r.status} ${await r.text()}`);
    return r.json();
  });
  results.bpUpdatedCity = (bpUpdated as { city: string }).city;

  const bpList = await fetch(`${base}/api/v1/business-partners?type=organization&search=Partner`).then(
    (r) => r.json() as Promise<{ items: { id: string }[] }>,
  );
  results.bpListFound = bpList.items.length === 1 && bpList.items[0].id === bpId;

  const bpPerson = await fetch(`${base}/api/v1/business-partners`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "person", name: "E2E Jane Smith", email: "jane@example.com" }),
  }).then((r) => r.json() as Promise<{ id: string; type: string }>);

  const bpPeopleOnly = await fetch(`${base}/api/v1/business-partners?type=person`).then(
    (r) => r.json() as Promise<{ items: { type: string }[] }>,
  );
  results.bpPeopleFilter = bpPeopleOnly.items.every((p) => p.type === "person");
  results.bpPersonType = bpPerson.type;

  const bpArchived = await fetch(`${base}/api/v1/business-partners/${bpId}`, {
    method: "DELETE",
  }).then(async (r) => {
    if (!r.ok) throw new Error(`archive bp ${r.status} ${await r.text()}`);
    return r.json();
  });
  results.bpArchived = (bpArchived as { deleted: boolean }).deleted;

  const bpAfterArchive = await fetch(`${base}/api/v1/business-partners?search=Partner Co`).then(
    (r) => r.json() as Promise<{ items: unknown[] }>,
  );
  results.bpHiddenAfterArchive = bpAfterArchive.items.length === 0;


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
