/**
 * Nile Gold Bakery (Uganda) — synthetic seed for manual NL-request testing.
 *
 * Bootstraps the org (idempotent), renames it to a multi-branch Ugandan bakery,
 * then seeds every business layer through the command bus (AI/manual parity):
 * branches, warehouses, roles, users, products, BOMs, stock, customers,
 * suppliers, purchase orders, sales invoices, journal entries, employees,
 * payroll, and org settings (UGX currency, Kampala timezone).
 *
 * Run: pnpm tsx --env-file=.env scripts/seed-bakery.ts
 */
import { loadConfig } from "@chaste/config";
import { createDb, runMigrations, bootstrapPlatform, schema, createCommandHelpers, cleanupTestData } from "@chaste/db";
import { createRuntime } from "@chaste/runtime";
import { executeCommand, executeQuery, createRequestContext } from "@chaste/kernel";
import type { Actor, CommandHelpers, RequestContext } from "@chaste/kernel";
import { eq } from "drizzle-orm";

const cfg = loadConfig();
const db = createDb(cfg.databaseUrl);

await runMigrations(cfg.databaseUrl);
// Clean slate for a deterministic dev seed. Nothing is preserved — this DB is
// synthetic test data only (no production tenant shares it).
await cleanupTestData(db);
const bootstrap = await bootstrapPlatform(db, cfg);
const { organizationId, adminUserId, roleId } = bootstrap;

const runtime = await createRuntime(cfg, db);

const adminPerms = await db
  .select({ permission: schema.rolePermissions.permission })
  .from(schema.rolePermissions)
  .where(eq(schema.rolePermissions.roleId, roleId));
const perms = adminPerms.map((r) => r.permission);

const actor: Actor = {
  kind: "user",
  userId: adminUserId,
  organizationId,
  permissions: new Set(perms),
  displayName: cfg.bootstrap.adminName,
};

function ctx(): RequestContext {
  return createRequestContext({ actor, requestId: crypto.randomUUID(), origin: "integration" });
}

const helpers: CommandHelpers = createCommandHelpers({
  audit: runtime.audit,
  outbox: runtime.outbox,
  db: runtime.db,
});

async function cmd<T>(name: string, input: unknown): Promise<T> {
  const res = await executeCommand<T>(runtime.commands, name, input, ctx(), helpers);
  return res.data;
}

async function qry<T>(name: string, input: unknown): Promise<T> {
  const res = await executeQuery<T>(runtime.queries, name, input, ctx());
  return res.data;
}

function log(step: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ seed: step, organizationId, ...extra }));
}

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

// ─── Org identity: rename + UGX currency + Kampala timezone ───────────────
await db
  .update(schema.organizations)
  .set({
    name: "Nile Gold Bakery (Uganda)",
    settings: { currency: "UGX", timezone: "Africa/Kampala", locale: "en_UG" },
  })
  .where(eq(schema.organizations.id, organizationId));
log("org-renamed");

// ─── Branches (multi-branch Uganda) ────────────────────────────────────────
const branchDefs = [
  { name: "Ntinda", code: "NTD" },
  { name: "Mukono", code: "MKN" },
  { name: "Jinja", code: "JIN" },
  { name: "Mbarara", code: "MBR" },
] as const;
const branches: Record<string, { id: string; name: string; code: string }> = {};
for (const b of branchDefs) {
  const created = await cmd<{ id: string; name: string; code: string }>("core.branch.create", {
    name: b.name,
    code: b.code,
    timezone: "Africa/Kampala",
  });
  branches[b.code] = created;
}
log("branches-created", { branches: Object.fromEntries(Object.entries(branches).map(([k, v]) => [k, v.code])) });

// ─── Warehouses (one per branch; MAIN comes from bootstrap) ─────────────────
const whDefs = [
  { code: "NTD-WH", name: "Ntinda Bakery Store", city: "Ntinda" },
  { code: "MKN-WH", name: "Mukono Bakery Store", city: "Mukono" },
  { code: "JIN-WH", name: "Jinja Bakery Store", city: "Jinja" },
  { code: "MBR-WH", name: "Mbarara Bakery Store", city: "Mbarara" },
] as const;
const warehouses: Record<string, string> = {};
for (const w of whDefs) {
  const created = await cmd<{ id: string; code: string; name: string }>("inv.warehouse.create", w);
  warehouses[w.code] = created.id;
}
// MAIN warehouse is created by bootstrapPlatform.
const [mainWh] = await db
  .select({ id: schema.invWarehouses.id })
  .from(schema.invWarehouses)
  .where(eq(schema.invWarehouses.code, "MAIN"))
  .limit(1);
warehouses["MAIN"] = mainWh!.id;
log("warehouses-created", { warehouses });

// ─── Roles ─────────────────────────────────────────────────────────────────
const roleDefs = [
  {
    key: "branch_manager",
    name: "Branch Manager",
    permissions: [
      "core.branch.read",
      "crm.customer.read",
      "crm.customer.create",
      "crm.customer.update",
      "crm.contact.read",
      "crm.contact.manage",
      "crm.interaction.read",
      "crm.interaction.write",
      "inv.product.manage",
      "inv.warehouse.manage",
      "inv.stock.read",
      "inv.stock.move",
      "acc.invoice.read",
      "acc.invoice.manage",
      "acc.account.read",
      "mfg.bom.manage",
      "mfg.wo.manage",
      "mfg.wo.read",
      "core.reminder.write",
      "core.followup.write",
      "core.calendar.read",
      "core.calendar.write",
      "hr.employee.read",
      "messaging.thread.read",
      "messaging.thread.write",
      "pur.po.read",
    ],
  },
  {
    key: "finance",
    name: "Finance",
    permissions: [
      "acc.account.manage",
      "acc.account.read",
      "acc.journal.post",
      "acc.invoice.manage",
      "acc.invoice.read",
      "hr.payroll.run",
      "hr.payroll.read",
      "hr.employee.read",
      "core.settings.read",
      "core.settings.manage",
      "core.rbac.read",
      "core.branch.read",
      "core.notification.read",
      "core.email.send",
      "core.reminder.write",
      "core.followup.write",
      "pur.po.read",
    ],
  },
  {
    key: "ops_manager",
    name: "Ops Manager",
    permissions: [
      "inv.warehouse.manage",
      "inv.product.manage",
      "inv.stock.move",
      "inv.stock.read",
      "mfg.bom.manage",
      "mfg.wo.manage",
      "mfg.wo.read",
      "pur.vendor.manage",
"pur.po.manage",
      "pur.po.read",
      "core.branch.read",
      "core.rbac.read",
      "core.settings.read",
      "hr.employee.read",
      "core.reminder.write",
      "core.followup.write",
      "core.calendar.read",
      "core.calendar.write",
    ],
  },
  {
    key: "sales",
    name: "Sales",
    permissions: [
      "crm.customer.read",
      "crm.customer.create",
      "crm.contact.read",
      "crm.contact.manage",
      "crm.interaction.read",
      "crm.interaction.write",
      "acc.invoice.read",
      "acc.invoice.manage",
      "inv.stock.read",
      "core.calendar.read",
    ],
  },
] as const;
const roles: Record<string, string> = {};
for (const r of roleDefs) {
  const created = await cmd<{ id: string; key: string }>("core.role.create", {
    key: r.key,
    name: r.name,
    permissions: [...r.permissions],
  });
  roles[r.key] = created.id;
}
log("roles-created", { roles });

// ─── Users (staff) ─────────────────────────────────────────────────────────
const userDefs = [
  { email: "mbabazi.kirabo@nilegold.ug", displayName: "Mbabazi Kirabo", roleKey: "branch_manager", branchCode: "NTD" },
  { email: "okello.denis@nilegold.ug", displayName: "Okello Denis", roleKey: "branch_manager", branchCode: "MKN" },
  { email: "namutebi.joan@nilegold.ug", displayName: "Namutebi Joan", roleKey: "branch_manager", branchCode: "JIN" },
  { email: "tumusiime.frank@nilegold.ug", displayName: "Tumusiime Frank", roleKey: "branch_manager", branchCode: "MBR" },
  { email: "nansubuga.grace@nilegold.ug", displayName: "Nansubuga Grace", roleKey: "finance", branchCode: "HQ" },
  { email: "ssentongo.paul@nilegold.ug", displayName: "Ssentongo Paul", roleKey: "ops_manager", branchCode: "HQ" },
] as const;
const users: Record<string, { id: string; email: string }> = {};
for (const u of userDefs) {
  const created = await cmd<{ id: string; email: string }>("core.user.invite", {
    email: u.email,
    displayName: u.displayName,
    roleId: roles[u.roleKey],
    branchId: u.branchCode === "HQ" ? undefined : branches[u.branchCode]!.id,
  });
  users[u.email] = created;
}
log("users-created", { count: Object.keys(users).length });

// ─── Products ──────────────────────────────────────────────────────────────
const productDefs = [
  { sku: "FLOUR50", name: "Wheat Flour 50kg", uom: "bag", reorderLevel: 40 },
  { sku: "SUGAR50", name: "Sugar 50kg", uom: "bag", reorderLevel: 20 },
  { sku: "YEAST1", name: "Fresh Yeast 1kg", uom: "kg", reorderLevel: 30 },
  { sku: "MARG10", name: "Margarine 10kg", uom: "box", reorderLevel: 15 },
  { sku: "SALT1", name: "Salt 1kg", uom: "kg", reorderLevel: 10 },
  { sku: "BAKEPW1", name: "Baking Powder 1kg", uom: "kg", reorderLevel: 8 },
  { sku: "MILK1L", name: "Fresh Milk 1L", uom: "litre", reorderLevel: 24 },
  { sku: "EGGSX30", name: "Eggs (tray of 30)", uom: "tray", reorderLevel: 20 },
  { sku: "BUTTER1", name: "Butter 1kg", uom: "kg", reorderLevel: 12 },
  { sku: "BREAD500", name: "White Bread 500g", uom: "loaf", reorderLevel: 50 },
  { sku: "CHAPATI1", name: "Chapati", uom: "pc", reorderLevel: 60 },
  { sku: "MANDAZI1", name: "Mandazi", uom: "pc", reorderLevel: 40 },
  { sku: "CAKEVAN1", name: "Vanilla Cake 1kg", uom: "cake", reorderLevel: 10 },
  { sku: "ROLEX1", name: "Rolex (egg & chapati roll)", uom: "pc", reorderLevel: 30 },
  { sku: "SAMOSA1", name: "Beef Samosa", uom: "pc", reorderLevel: 40 },
  { sku: "DONUT1", name: "Doughnut", uom: "pc", reorderLevel: 35 },
] as const;
const products: Record<string, string> = {};
for (const p of productDefs) {
  const created = await cmd<{ id: string; sku: string; name: string }>("inv.product.create", p);
  products[p.sku] = created.id;
}
log("products-created", { count: Object.keys(products).length });

// ─── Opening stock per warehouse (target quantities) ───────────────────────
// Stockout-risk products (below reorderLevel) for the morning-risk report and
// replenishment request: FLOUR50, YEAST1, MILK1L, EGGSX30, BREAD500, CHAPATI1.
const targetStock: Record<string, Record<string, number>> = {
  MAIN: { FLOUR50: 25, SUGAR50: 34, YEAST1: 10, MARG10: 18, SALT1: 22, BAKEPW1: 9, MILK1L: 20, EGGSX30: 15, BUTTER1: 14, BREAD500: 60, CHAPATI1: 80, MANDAZI1: 55, CAKEVAN1: 12, ROLEX1: 45, SAMOSA1: 60, DONUT1: 50 },
  "NTD-WH": { FLOUR50: 12, SUGAR50: 10, YEAST1: 4, MARG10: 6, SALT1: 5, BAKEPW1: 3, MILK1L: 8, EGGSX30: 5, BUTTER1: 4, BREAD500: 15, CHAPATI1: 20, MANDAZI1: 12, CAKEVAN1: 4, ROLEX1: 10, SAMOSA1: 14, DONUT1: 12 },
  "MKN-WH": { FLOUR50: 8, SUGAR50: 9, YEAST1: 3, MARG10: 4, SALT1: 4, BAKEPW1: 2, MILK1L: 6, EGGSX30: 4, BUTTER1: 3, BREAD500: 10, CHAPATI1: 14, MANDAZI1: 9, CAKEVAN1: 3, ROLEX1: 8, SAMOSA1: 10, DONUT1: 9 },
  "JIN-WH": { FLOUR50: 18, SUGAR50: 14, YEAST1: 6, MARG10: 7, SALT1: 6, BAKEPW1: 4, MILK1L: 10, EGGSX30: 6, BUTTER1: 5, BREAD500: 25, CHAPATI1: 30, MANDAZI1: 18, CAKEVAN1: 5, ROLEX1: 15, SAMOSA1: 20, DONUT1: 16 },
  "MBR-WH": { FLOUR50: 6, SUGAR50: 7, YEAST1: 2, MARG10: 3, SALT1: 3, BAKEPW1: 2, MILK1L: 5, EGGSX30: 3, BUTTER1: 2, BREAD500: 8, CHAPATI1: 12, MANDAZI1: 7, CAKEVAN1: 2, ROLEX1: 6, SAMOSA1: 9, DONUT1: 7 },
};

for (const [whCode, levels] of Object.entries(targetStock)) {
  const whId = warehouses[whCode];
  for (const [sku, qty] of Object.entries(levels)) {
    await cmd("inv.stock.adjust", {
      warehouseId: whId,
      productId: products[sku],
      quantityDelta: qty,
      reason: "Opening stock (seed)",
    });
  }
}
log("stock-seeded");

// ─── BOMs (recipes, int quantities per batch of N) ─────────────────────────
const bomDefs = [
  { productId: products.BREAD500, name: "White Bread recipe", quantity: 100, components: { FLOUR50: 50, YEAST1: 1, SALT1: 1, SUGAR50: 2, MARG10: 3 } },
  { productId: products.CHAPATI1, name: "Chapati recipe", quantity: 100, components: { FLOUR50: 30, MARG10: 2, SALT1: 1 } },
  { productId: products.MANDAZI1, name: "Mandazi recipe", quantity: 100, components: { FLOUR50: 25, SUGAR50: 8, YEAST1: 1, MILK1L: 10 } },
  { productId: products.CAKEVAN1, name: "Vanilla Cake recipe", quantity: 10, components: { FLOUR50: 5, SUGAR50: 4, BUTTER1: 2, EGGSX30: 12, MILK1L: 2 } },
  { productId: products.ROLEX1, name: "Rolex recipe", quantity: 100, components: { FLOUR50: 20, EGGSX30: 15, MARG10: 1 } },
  { productId: products.SAMOSA1, name: "Beef Samosa recipe", quantity: 100, components: { FLOUR50: 15, MARG10: 2 } },
  { productId: products.DONUT1, name: "Doughnut recipe", quantity: 100, components: { FLOUR50: 20, SUGAR50: 6, YEAST1: 1, MILK1L: 8 } },
] as const;
const boms: Record<string, string> = {};
for (const b of bomDefs) {
  const created = await cmd<{ id: string; name: string }>("mfg.bom.create", {
    productId: b.productId,
    name: b.name,
    quantity: b.quantity,
    components: Object.entries(b.components).map(([sku, quantity]) => ({
      componentProductId: products[sku],
      quantity,
    })),
  });
  boms[b.productId!] = created.id;
}
log("boms-created", { count: Object.keys(boms).length });

// ─── Work orders ───────────────────────────────────────────────────────────
await cmd("mfg.wo.create", { bomId: boms[products.BREAD500!], number: "WO-2026-0141", quantity: 200 });
await cmd("mfg.wo.create", { bomId: boms[products.CHAPATI1!], number: "WO-2026-0142", quantity: 150 });
log("work-orders-created");

// ─── Customers ─────────────────────────────────────────────────────────────
const customerDefs = [
  { name: "Kampala Corner Store", email: "sales@kampalacorner.ug", city: "Kampala", country: "Uganda" },
  { name: "Lugogo Wholesale", email: "orders@lugogowholesale.ug", city: "Kampala", country: "Uganda" },
  { name: "Ntinda Supermarket", email: "buyer@ntindasupermarket.ug", city: "Ntinda", country: "Uganda" },
  { name: "Jinja Hotel Ltd", email: "procurement@jinjahotel.ug", city: "Jinja", country: "Uganda" },
  { name: "Mbarara Campus Canteen", email: "canteen@mbararacampus.ug", city: "Mbarara", country: "Uganda" },
  { name: "Mukono Bakery Mart", email: "mart@mukonobakery.ug", city: "Mukono", country: "Uganda" },
  { name: "Namugongo Church Guild", email: "guild@namugongo.ug", city: "Namugongo", country: "Uganda" },
  { name: "Kira Road Deli", email: "deli@kiraroad.ug", city: "Kampala", country: "Uganda" },
] as const;
const customers: Record<string, string> = {};
for (const c of customerDefs) {
  const created = await cmd<{ id: string; name: string }>("crm.customer.create", c);
  customers[c.name] = created.id;
}
log("customers-created", { count: Object.keys(customers).length });

// ─── Suppliers / vendors ───────────────────────────────────────────────────
const vendorDefs = [
  { name: "Kampala Flour Mills", email: "sales@kampalaflourmills.ug" },
  { name: "Uganda Sugar Refinery", email: "orders@ugandasugar.ug" },
  { name: "Brookside Dairy Uganda", email: "supply@brookside.ug" },
  { name: "Bidco Uganda Ltd", email: "b2b@bidco.ug" },
  { name: "Uganda Poultry Farms", email: "eggs@ugandapoultry.ug" },
  { name: "Agro-Chem Yeast Co", email: "yeast@agrochem.ug" },
] as const;
const vendors: Record<string, string> = {};
for (const v of vendorDefs) {
  const created = await cmd<{ id: string; name: string }>("pur.vendor.create", v);
  vendors[v.name] = created.id;
}
log("vendors-created", { count: Object.keys(vendors).length });

// ─── Purchase orders (UGX totals; some > 5,000,000 to trigger the ask-first rule) ─
const poDefs = [
  { vendorId: vendors["Kampala Flour Mills"], number: "PO-2026-0001", total: 6200000 },
  { vendorId: vendors["Uganda Sugar Refinery"], number: "PO-2026-0002", total: 3100000 },
  { vendorId: vendors["Bidco Uganda Ltd"], number: "PO-2026-0003", total: 1400000 },
  { vendorId: vendors["Brookside Dairy Uganda"], number: "PO-2026-0004", total: 2200000 },
  { vendorId: vendors["Uganda Poultry Farms"], number: "PO-2026-0005", total: 960000 },
  { vendorId: vendors["Kampala Flour Mills"], number: "PO-2026-0006", total: 5800000 },
] as const;
for (const po of poDefs) {
  await cmd("pur.po.create", po);
}
log("purchase-orders-created");

// ─── Sales invoices (UGX) ──────────────────────────────────────────────────
const invoiceDefs = [
  { customerId: customers["Kampala Corner Store"], number: "INV-1001", total: 850000, daysAgo: 21 },
  { customerId: customers["Lugogo Wholesale"], number: "INV-1002", total: 4200000, daysAgo: 19 },
  { customerId: customers["Ntinda Supermarket"], number: "INV-1003", total: 1150000, daysAgo: 3 },
  { customerId: customers["Jinja Hotel Ltd"], number: "INV-1004", total: 2300000, daysAgo: 17 },
  { customerId: customers["Mbarara Campus Canteen"], number: "INV-1005", total: 450000, daysAgo: 2 },
  { customerId: customers["Mukono Bakery Mart"], number: "INV-1006", total: 1900000, daysAgo: 16 },
  { customerId: customers["Kampala Corner Store"], number: "INV-1007", total: 320000, daysAgo: 1 },
  { customerId: customers["Namugongo Church Guild"], number: "INV-1008", total: 780000, daysAgo: 15 },
] as const;
const invoiceIds: string[] = [];
for (const inv of invoiceDefs) {
  const created = await cmd<{ id: string; number: string }>("acc.invoice.create", {
    number: inv.number,
    customerId: inv.customerId,
    currency: "UGX",
    total: inv.total,
  });
  invoiceIds.push(created.id);
  if (inv.daysAgo > 0) {
    const backdate = daysAgo(inv.daysAgo);
    await db
      .update(schema.accInvoices)
      .set({ issuedAt: backdate, createdAt: backdate })
      .where(eq(schema.accInvoices.id, created.id));
  }
}
log("invoices-created", { count: invoiceDefs.length, overdue: invoiceDefs.filter((i) => i.daysAgo > 14).length });

// ─── Journal entries (must balance) ────────────────────────────────────────
const accounts = await qry<{ items: { id: string; code: string; name: string }[] }>("acc.account.list", {});
const accById = Object.fromEntries(accounts.items.map((a) => [a.code, a.id]));
const jeDefs = [
  {
    reference: "JE-OPEN-001",
    memo: "Opening balances",
    lines: [
      { accountId: accById["1000"], debit: 5000000, credit: 0 },
      { accountId: accById["3000"], debit: 0, credit: 5000000 },
    ],
  },
  {
    reference: "JE-REV-001",
    memo: "Week 1 bakery sales",
    lines: [
      { accountId: accById["1000"], debit: 1200000, credit: 0 },
      { accountId: accById["4000"], debit: 0, credit: 1200000 },
    ],
  },
  {
    reference: "JE-EXP-001",
    memo: "Week 1 flour purchases",
    lines: [
      { accountId: accById["5000"], debit: 600000, credit: 0 },
      { accountId: accById["1000"], debit: 0, credit: 600000 },
    ],
  },
] as const;
for (const je of jeDefs) {
  await cmd("acc.journal.post", {
    reference: je.reference,
    memo: je.memo,
    lines: je.lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit })),
  });
}
log("journal-entries-posted");

// ─── Employees + payroll ───────────────────────────────────────────────────
const employeeDefs = [
  { employeeNumber: "EMP-001", fullName: "Ssentongo Paul", email: "ssentongo.paul@nilegold.ug", department: "Operations", jobTitle: "Ops Manager", baseSalary: 3000000 },
  { employeeNumber: "EMP-002", fullName: "Mbabazi Kirabo", email: "mbabazi.kirabo@nilegold.ug", department: "Branches", jobTitle: "Branch Manager (Ntinda)", baseSalary: 2500000 },
  { employeeNumber: "EMP-003", fullName: "Okello Denis", email: "okello.denis@nilegold.ug", department: "Branches", jobTitle: "Branch Manager (Mukono)", baseSalary: 2500000 },
  { employeeNumber: "EMP-004", fullName: "Namutebi Joan", email: "namutebi.joan@nilegold.ug", department: "Branches", jobTitle: "Branch Manager (Jinja)", baseSalary: 2500000 },
  { employeeNumber: "EMP-005", fullName: "Tumusiime Frank", email: "tumusiime.frank@nilegold.ug", department: "Branches", jobTitle: "Branch Manager (Mbarara)", baseSalary: 2500000 },
  { employeeNumber: "EMP-006", fullName: "Nansubuga Grace", email: "nansubuga.grace@nilegold.ug", department: "Finance", jobTitle: "Accountant", baseSalary: 2800000 },
  { employeeNumber: "EMP-007", fullName: "Kato Godfrey", email: "kato.godfrey@nilegold.ug", department: "Production", jobTitle: "Head Baker", baseSalary: 1800000 },
  { employeeNumber: "EMP-008", fullName: "Nakato Aisha", email: "nakato.aisha@nilegold.ug", department: "Sales", jobTitle: "Cashier", baseSalary: 900000 },
] as const;
for (const e of employeeDefs) {
  await cmd("hr.employee.create", e);
}
await cmd("hr.payroll.prepare", { periodLabel: "July 2026" });
log("employees-payroll-created", { employees: employeeDefs.length });

// ─── Verification summary ──────────────────────────────────────────────────
const branchesList = await qry<{ branches: { id: string; name: string; code: string }[] }>("core.branch.list", {});
const stock = await qry<{ levels: { warehouseId: string; productId: string; quantity: string }[] }>("inv.stock.list", {});
const lowStock = stock.levels.filter((l) => Number(l.quantity) === 0 || Number(l.quantity) < 5);
const rbac = await qry<{ roles: { key: string }[]; users: { email: string }[] }>("core.rbac.overview", {});
const invs = await qry<{ items: { number: string; status: string; total: string }[] }>("acc.invoice.list", {});
const pos = await qry<{ orders: { number: string; total: string }[] }>("pur.po.list", {});

console.log(
  JSON.stringify(
    {
      seed: "complete",
      organizationId,
      orgName: "Nile Gold Bakery (Uganda)",
      branches: branchesList.branches.length,
      roles: rbac.roles.length,
      users: rbac.users.length,
      products: Object.keys(products).length,
      warehouses: Object.keys(warehouses).length,
      lowStockLevels: lowStock.length,
      invoices: invs.items.length,
      purchaseOrders: pos.orders.length,
      adminAuthToken: bootstrap.adminAuthToken ?? null,
    },
    null,
    2,
  ),
);

await runtime.db.$client.end({ timeout: 5 });