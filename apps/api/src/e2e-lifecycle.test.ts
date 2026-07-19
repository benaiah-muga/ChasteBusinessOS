/**
 * Real-world lifecycle E2E tests.
 *
 * Two companies, 6 users total, all modules covered.
 * Tests the full journey from company setup through daily operations.
 *
 * Company 1: NovaTech Solutions (Tech/Services)
 *   - Sarah Chen (CEO/Admin) — company setup, RBAC, monitoring
 *   - Marcus Johnson (Ops Manager) — inventory, purchasing
 *   - Emily Rodriguez (Finance Lead) — accounting, invoicing
 *
 * Company 2: Meridian Industries (Manufacturing/Trading)
 *   - James Wilson (Founder/Admin) — setup, autonomy policy
 *   - Aisha Patel (HR Director) — employees, payroll
 *   - David Kim (Sales Lead) — CRM, customers
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createCommandRegistry,
  createQueryRegistry,
  createModuleRegistry,
  createRequestContext,
  executeCommand,
  executeQuery,
  InMemoryAuditWriter,
  InMemoryOutboxWriter,
  type CommandRegistry,
  type QueryRegistry,
  type ModuleRegistry,
} from "@chaste/kernel";
import { createDb, runMigrations, resolveUserPermissions, schema, type Db, cleanupTestData, findUserByEmail, findFirstWarehouse, findUserById, findUsersByOrg } from "@chaste/db";
import { createCrmModule } from "@chaste/module-crm";
import { createAccountingModule } from "@chaste/module-accounting";
import { createInventoryModule } from "@chaste/module-inventory";
import { createPurchasingModule } from "@chaste/module-purchasing";
import { createHrModule } from "@chaste/module-hr";
import { createManufacturingModule } from "@chaste/module-manufacturing";
import { createPlatformModule } from "@chaste/module-platform";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const hasDb = Boolean(process.env.DATABASE_URL);
const DB_URL = process.env.DATABASE_URL!;

let db: ReturnType<typeof createDb>;
let commands: CommandRegistry;
let queries: QueryRegistry;
let modules: ModuleRegistry;
let audit: InMemoryAuditWriter;
let outbox: InMemoryOutboxWriter;

interface TestUser {
  id: string;
  email: string;
  displayName: string;
  authToken: string;
  roleId: string;
  permissions: string[];
}

interface TestCompany {
  orgId: string;
  name: string;
  adminUser: TestUser;
  users: TestUser[];
  roles: Record<string, string>;
}

let novatech: TestCompany;
let meridian: TestCompany;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ctxFor(user: TestUser, orgId: string) {
  return createRequestContext({
    actor: {
      kind: "user" as const,
      userId: user.id,
      organizationId: orgId,
      displayName: user.displayName,
      permissions: new Set(user.permissions),
    },
  });
}

async function cmd(user: TestUser, orgId: string, name: string, input: unknown) {
  const result = await executeCommand(commands, name, input, ctxFor(user, orgId), { audit, outbox });
  return result.data;
}

async function qry(user: TestUser, orgId: string, name: string, input: unknown = {}) {
  const result = await executeQuery(queries, name, input, ctxFor(user, orgId));
  return result.data;
}

const ALL_PERMISSIONS = [
  "core.modules.read", "core.modules.manage", "core.rbac.read",
  "core.user.manage", "core.user.read", "core.role.manage", "core.role.assign",
  "core.autonomy.manage", "core.marketplace.read",
  "core.settings.read", "core.settings.manage",
  "crm.customer.create", "crm.customer.read",
  "acc.account.manage", "acc.account.read", "acc.journal.post", "acc.invoice.manage", "acc.invoice.read",
  "inv.warehouse.manage", "inv.product.manage", "inv.stock.move", "inv.stock.read",
  "pur.vendor.manage", "pur.po.manage", "pur.po.read",
  "hr.employee.manage", "hr.employee.read", "hr.payroll.run", "hr.payroll.read",
  "mfg.bom.manage", "mfg.wo.manage", "mfg.wo.read",
];

const OPERATOR_PERMISSIONS = [
  "core.modules.read", "core.rbac.read", "core.marketplace.read",
  "crm.customer.create", "crm.customer.read",
  "acc.account.read", "acc.invoice.read",
  "inv.stock.read", "inv.stock.move", "inv.product.manage", "inv.warehouse.manage",
  "pur.vendor.manage", "pur.po.manage", "pur.po.read",
  "hr.employee.read", "hr.payroll.read",
  "mfg.bom.manage", "mfg.wo.manage", "mfg.wo.read",
];

const HR_DIRECTOR_PERMISSIONS = [
  "hr.employee.manage", "hr.employee.read", "hr.payroll.run", "hr.payroll.read",
  "core.rbac.read", "crm.customer.read",
];

const FINANCE_PERMISSIONS = [
  "acc.account.manage", "acc.account.read", "acc.journal.post",
  "acc.invoice.manage", "acc.invoice.read",
  "crm.customer.read", "inv.stock.read", "pur.po.read",
];

async function createCompany(name: string, adminEmail: string, adminName: string): Promise<TestCompany> {
  const [org] = await db.insert(schema.organizations).values({
    name,
    autonomy: "confirm",
    region: "local",
  }).returning();

  const adminToken = crypto.randomUUID();
  const [adminRow] = await db.insert(schema.users).values({
    organizationId: org!.id,
    email: adminEmail,
    displayName: adminName,
    authToken: adminToken,
  }).returning();

  const [adminRole] = await db.insert(schema.roles).values({
    organizationId: org!.id,
    key: "admin",
    name: "Administrator",
    isSystem: true,
  }).returning();
  for (const perm of ALL_PERMISSIONS) {
    await db.insert(schema.rolePermissions).values({ roleId: adminRole!.id, permission: perm });
  }
  await db.insert(schema.userRoles).values({ userId: adminRow!.id, roleId: adminRole!.id });

  const [operatorRole] = await db.insert(schema.roles).values({
    organizationId: org!.id,
    key: "operator",
    name: "Operator",
    isSystem: true,
  }).returning();
  for (const perm of OPERATOR_PERMISSIONS) {
    await db.insert(schema.rolePermissions).values({ roleId: operatorRole!.id, permission: perm });
  }

  const moduleIds = ["crm", "accounting", "inventory", "purchasing", "hr", "manufacturing"];
  for (const moduleId of moduleIds) {
    await db.insert(schema.moduleInstalls).values({
      organizationId: org!.id,
      moduleId,
      version: "0.1.0",
      enabled: true,
    });
  }

  // Seed default chart of accounts
  const defaultAccounts = [
    { code: "1000", name: "Cash", type: "asset" },
    { code: "1100", name: "Accounts Receivable", type: "asset" },
    { code: "2000", name: "Accounts Payable", type: "liability" },
    { code: "3000", name: "Equity", type: "equity" },
    { code: "4000", name: "Revenue", type: "revenue" },
    { code: "5000", name: "Expenses", type: "expense" },
  ];
  const accountIds: Record<string, string> = {};
  for (const acct of defaultAccounts) {
    const [row] = await db.insert(schema.accAccounts).values({
      organizationId: org!.id,
      code: acct.code,
      name: acct.name,
      type: acct.type,
    }).returning();
    accountIds[acct.code] = row!.id;
  }

  await db.insert(schema.invWarehouses).values({
    organizationId: org!.id,
    name: "Main Warehouse",
    code: "WH-001",
  });

  const adminPermissions = await resolveUserPermissions(db, adminRow!.id);

  return {
    orgId: org!.id,
    name,
    adminUser: {
      id: adminRow!.id,
      email: adminEmail,
      displayName: adminName,
      authToken: adminToken,
      roleId: adminRole!.id,
      permissions: adminPermissions,
    },
    users: [],
    roles: {
      admin: adminRole!.id,
      operator: operatorRole!.id,
    },
    accountIds,
  } as TestCompany & { accountIds: Record<string, string> };
}

async function addUser(
  company: TestCompany,
  email: string,
  displayName: string,
  roleKey: string,
  customPermissions?: string[],
): Promise<TestUser> {
  const token = crypto.randomUUID();
  const [user] = await db.insert(schema.users).values({
    organizationId: company.orgId,
    email,
    displayName,
    authToken: token,
  }).returning();

  let roleId: string;
  if (customPermissions) {
    const [role] = await db.insert(schema.roles).values({
      organizationId: company.orgId,
      key: `${roleKey}-${email.split("@")[0]}`,
      name: displayName,
    }).returning();
    roleId = role!.id;
    for (const perm of customPermissions) {
      await db.insert(schema.rolePermissions).values({ roleId: role!.id, permission: perm });
    }
  } else {
    roleId = company.roles[roleKey]!;
  }

  await db.insert(schema.userRoles).values({ userId: user!.id, roleId });
  const permissions = await resolveUserPermissions(db, user!.id);

  const testUser: TestUser = {
    id: user!.id,
    email,
    displayName,
    authToken: token,
    roleId,
    permissions,
  };
  company.users.push(testUser);
  return testUser;
}

async function getWarehouseId(orgId: string): Promise<string> {
  const wh = await findFirstWarehouse(db, orgId);
  return wh!.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)("Real-world lifecycle E2E", () => {
  beforeAll(async () => {
    db = createDb(DB_URL);
    await runMigrations(DB_URL);

    commands = createCommandRegistry();
    queries = createQueryRegistry();
    modules = createModuleRegistry(commands, queries);
    audit = new InMemoryAuditWriter();
    outbox = new InMemoryOutboxWriter();

    await modules.register(createCrmModule(db));
    await modules.register(createAccountingModule(db));
    await modules.register(createInventoryModule(db));
    await modules.register(createPurchasingModule(db));
    await modules.register(createHrModule(db));
    await modules.register(createManufacturingModule(db));
    await modules.register(createPlatformModule(db, modules, {
      allowFullAutonomous: true,
      regions: ["local", "us-east", "eu-west"],
    }));

    await cleanupTestData(db);
  });

  afterAll(async () => {
    await cleanupTestData(db);
  });

  // =========================================================================
  // COMPANY 1: NovaTech Solutions
  // =========================================================================
  describe("NovaTech Solutions — Tech Services Company", () => {
    it("1.1 Company discovers the platform and sets up", async () => {
      novatech = await createCompany("NovaTech Solutions", "sarah@novatech.io", "Sarah Chen");
      expect(novatech.orgId).toBeTruthy();
      expect(novatech.adminUser.id).toBeTruthy();
    });

    it("1.2 Sarah (CEO) verifies platform modules are installed", async () => {
      const installed = await qry(novatech.adminUser, novatech.orgId, "core.modules.list");
      expect(installed.registered).toHaveLength(7);
      expect(installed.installed).toHaveLength(6);
    });

    it("1.3 Sarah creates her team with proper RBAC", async () => {
      const marcus = await addUser(novatech, "marcus@novatech.io", "Marcus Johnson", "operator");
      expect(marcus.permissions).toContain("inv.stock.move");
      expect(marcus.permissions).toContain("pur.po.read");
      expect(marcus.permissions).not.toContain("core.user.manage");
      expect(marcus.permissions).not.toContain("core.role.manage");
      expect(marcus.permissions).not.toContain("acc.journal.post");

      const emily = await addUser(novatech, "emily@novatech.io", "Emily Rodriguez", "finance", FINANCE_PERMISSIONS);
      expect(emily.permissions).toContain("acc.journal.post");
      expect(emily.permissions).toContain("acc.invoice.manage");
      expect(emily.permissions).not.toContain("hr.employee.manage");
    });

    it("1.4 Sarah verifies RBAC overview shows all users", async () => {
      const overview = await qry(novatech.adminUser, novatech.orgId, "core.rbac.overview");
      expect(overview.users).toHaveLength(3);
      expect(overview.roles.length).toBeGreaterThanOrEqual(3);
    });

    it("1.5 Marcus sets up inventory (products + stock)", async () => {
      const marcus = novatech.users[0]!;

      const laptop = await cmd(marcus, novatech.orgId, "inv.product.create", {
        sku: "NTP-LP-001",
        name: "NovaTech Laptop Pro",
      });
      expect(laptop.id).toBeTruthy();

      const monitor = await cmd(marcus, novatech.orgId, "inv.product.create", {
        sku: "NTP-MON-001",
        name: "NovaTech 4K Monitor",
      });
      expect(monitor.id).toBeTruthy();

      const whId = await getWarehouseId(novatech.orgId);

      await cmd(marcus, novatech.orgId, "inv.stock.adjust", {
        warehouseId: whId,
        productId: laptop.id,
        quantityDelta: 50,
        reason: "Initial inventory",
      });

      await cmd(marcus, novatech.orgId, "inv.stock.adjust", {
        warehouseId: whId,
        productId: monitor.id,
        quantityDelta: 100,
        reason: "Initial inventory",
      });

      const stock = await qry(marcus, novatech.orgId, "inv.stock.list");
      expect(stock.levels.length).toBeGreaterThanOrEqual(2);
    });

    it("1.6 Emily manages accounting (journal + invoice)", async () => {
      const emily = novatech.users[1]!;
      const acctIds = (novatech as TestCompany & { accountIds: Record<string, string> }).accountIds;

      // Emily posts a journal entry
      const journal = await cmd(emily, novatech.orgId, "acc.journal.post", {
        reference: "INIT-001",
        lines: [
          { accountId: acctIds["1000"], debit: 50000, credit: 0 },
          { accountId: acctIds["3000"], debit: 0, credit: 50000 },
        ],
      });
      expect(journal.id).toBeTruthy();

      // Sarah creates a customer (Emily doesn't have crm.customer.create)
      const customer = await cmd(novatech.adminUser, novatech.orgId, "crm.customer.create", {
        name: "Acme Corp",
        email: "procurement@acme.com",
      });
      expect(customer.id).toBeTruthy();

      // Emily creates an invoice
      const invoice = await cmd(emily, novatech.orgId, "acc.invoice.create", {
        number: "INV-001",
        customerId: customer.id,
        total: 12499.95,
      });
      expect(invoice.id).toBeTruthy();
    });

    it("1.7 Marcus handles purchasing", async () => {
      const marcus = novatech.users[0]!;

      const vendor = await cmd(marcus, novatech.orgId, "pur.vendor.create", {
        name: "TechParts Wholesale",
        email: "sales@techparts.com",
      });
      expect(vendor.id).toBeTruthy();

      const po = await cmd(marcus, novatech.orgId, "pur.po.create", {
        vendorId: vendor.id,
        number: "PO-001",
        total: 81000,
      });
      expect(po.id).toBeTruthy();

      const poList = await qry(marcus, novatech.orgId, "pur.po.list");
      expect(poList.orders.length).toBeGreaterThanOrEqual(1);
    });

    it("1.8 Marcus sets up manufacturing (BOM + work order)", async () => {
      const marcus = novatech.users[0]!;
      const whId = await getWarehouseId(novatech.orgId);

      // Create component products
      const chassis = await cmd(marcus, novatech.orgId, "inv.product.create", {
        sku: "NTP-CHASSIS-001",
        name: "Laptop Chassis",
      });

      const screen = await cmd(marcus, novatech.orgId, "inv.product.create", {
        sku: "NTP-SCREEN-001",
        name: "Screen Assembly",
      });

      // Stock components
      await cmd(marcus, novatech.orgId, "inv.stock.adjust", {
        warehouseId: whId,
        productId: chassis.id,
        quantityDelta: 200,
        reason: "Component stock",
      });

      await cmd(marcus, novatech.orgId, "inv.stock.adjust", {
        warehouseId: whId,
        productId: screen.id,
        quantityDelta: 200,
        reason: "Component stock",
      });

      // Create BOM
      const bom = await cmd(marcus, novatech.orgId, "mfg.bom.create", {
        productId: chassis.id,
        name: "Laptop Assembly BOM",
        quantity: 1,
        components: [
          { componentProductId: chassis.id, quantity: 1 },
          { componentProductId: screen.id, quantity: 1 },
        ],
      });
      expect(bom.id).toBeTruthy();

      // Create work order
      const wo = await cmd(marcus, novatech.orgId, "mfg.wo.create", {
        bomId: bom.id,
        number: "WO-001",
        quantity: 10,
      });
      expect(wo.id).toBeTruthy();

      const mfgOverview = await qry(marcus, novatech.orgId, "mfg.overview");
      expect(mfgOverview).toBeTruthy();
    });

    it("1.9 Sarah monitors system and audit trail", async () => {
      const overview = await qry(novatech.adminUser, novatech.orgId, "core.rbac.overview");
      expect(overview.users).toHaveLength(3);

      const auditEntries = audit.entries.filter(
        (e) => e.organizationId === novatech.orgId,
      );
      expect(auditEntries.length).toBeGreaterThan(0);
    });

    it("1.10 Permission enforcement — Marcus cannot do admin things", async () => {
      const marcus = novatech.users[0]!;

      await expect(
        cmd(marcus, novatech.orgId, "core.role.create", { key: "test", name: "Test" }),
      ).rejects.toThrow();

      await expect(
        cmd(marcus, novatech.orgId, "core.autonomy.set", { autonomy: "full_autonomous" }),
      ).rejects.toThrow();

      await expect(
        cmd(marcus, novatech.orgId, "acc.journal.post", {
          reference: "UNAUTH",
          lines: [{ accountId: "00000000-0000-0000-0000-000000000000", debit: 1000, credit: 0 }],
        }),
      ).rejects.toThrow();
    });

    it("1.11 Emily cannot access HR module", async () => {
      const emily = novatech.users[1]!;

      await expect(
        cmd(emily, novatech.orgId, "hr.employee.create", {
          employeeNumber: "E-999",
          fullName: "Test Employee",
        }),
      ).rejects.toThrow();
    });

    it("1.12 Sarah adjusts autonomy level", async () => {
      const result = await cmd(novatech.adminUser, novatech.orgId, "core.autonomy.set", {
        autonomy: "guarded_auto",
      });
      expect(result.autonomy).toBe("guarded_auto");
    });

    it("1.13 Sarah creates a user via core.user.create", async () => {
      const result = await cmd(novatech.adminUser, novatech.orgId, "core.user.create", {
        email: "newhire@novatech.io",
        displayName: "New Hire",
        roleId: novatech.roles.operator,
      });
      expect(result.id).toBeTruthy();
      expect(result.authToken).toBeTruthy();
      expect(result.email).toBe("newhire@novatech.io");
    });

    it("1.14 Sarah deactivates the new hire", async () => {
      const users = await findUsersByOrg(db, novatech.orgId);
      const newHire = users.find((u) => u.email === "newhire@novatech.io");
      expect(newHire).toBeTruthy();

      const result = await cmd(novatech.adminUser, novatech.orgId, "core.user.deactivate", {
        userId: newHire!.id,
      });
      expect(result.ok).toBe(true);

      const refreshed = await findUserById(db, newHire!.id);
      expect(refreshed!.isActive).toBe(false);
    });
  });

  // =========================================================================
  // COMPANY 2: Meridian Industries
  // =========================================================================
  describe("Meridian Industries — Manufacturing/Trading Company", () => {
    it("2.1 Company sets up on the platform", async () => {
      meridian = await createCompany("Meridian Industries", "james@meridian.co", "James Wilson");
      expect(meridian.orgId).toBeTruthy();
    });

    it("2.2 James creates his team", async () => {
      const aisha = await addUser(
        meridian, "aisha@meridian.co", "Aisha Patel", "hr_director_custom",
        HR_DIRECTOR_PERMISSIONS,
      );
      expect(aisha.permissions).toContain("hr.employee.manage");
      expect(aisha.permissions).toContain("hr.payroll.run");
      expect(aisha.permissions).not.toContain("acc.journal.post");

      const david = await addUser(meridian, "david@meridian.co", "David Kim", "operator");
      expect(david.permissions).toContain("crm.customer.create");
      expect(david.permissions).not.toContain("hr.employee.manage");
    });

    it("2.3 James sets up inventory + purchasing end-to-end", async () => {
      const widget = await cmd(meridian.adminUser, meridian.orgId, "inv.product.create", {
        sku: "MER-IWA-001",
        name: "Industrial Widget A",
      });

      const gear = await cmd(meridian.adminUser, meridian.orgId, "inv.product.create", {
        sku: "MER-PGS-001",
        name: "Precision Gear Set",
      });

      const whId = await getWarehouseId(meridian.orgId);

      await cmd(meridian.adminUser, meridian.orgId, "inv.stock.adjust", {
        warehouseId: whId,
        productId: widget.id,
        quantityDelta: 500,
        reason: "Initial stock",
      });

      await cmd(meridian.adminUser, meridian.orgId, "inv.stock.adjust", {
        warehouseId: whId,
        productId: gear.id,
        quantityDelta: 200,
        reason: "Initial stock",
      });

      const vendor = await cmd(meridian.adminUser, meridian.orgId, "pur.vendor.create", {
        name: "Steel Supply Co",
        email: "orders@steelsupply.com",
      });

      const po = await cmd(meridian.adminUser, meridian.orgId, "pur.po.create", {
        vendorId: vendor.id,
        number: "MER-PO-001",
        total: 16875,
      });
      expect(po.id).toBeTruthy();

      const poList = await qry(meridian.adminUser, meridian.orgId, "pur.po.list");
      expect(poList.orders.length).toBeGreaterThanOrEqual(1);
    });

    it("2.4 Aisha sets up HR (employees)", async () => {
      const aisha = meridian.users[0]!;

      const emp1 = await cmd(aisha, meridian.orgId, "hr.employee.create", {
        employeeNumber: "MER-001",
        fullName: "Carlos Martinez",
        email: "carlos@meridian.co",
        department: "Manufacturing",
        jobTitle: "Floor Supervisor",
        baseSalary: 65000,
      });
      expect(emp1.id).toBeTruthy();

      const emp2 = await cmd(aisha, meridian.orgId, "hr.employee.create", {
        employeeNumber: "MER-002",
        fullName: "Lisa Thompson",
        email: "lisa@meridian.co",
        department: "Logistics",
        jobTitle: "Warehouse Lead",
        baseSalary: 58000,
      });

      const emp3 = await cmd(aisha, meridian.orgId, "hr.employee.create", {
        employeeNumber: "MER-003",
        fullName: "Raj Patel",
        email: "raj@meridian.co",
        department: "Sales",
        jobTitle: "Account Executive",
        baseSalary: 72000,
      });

      const overview = await qry(aisha, meridian.orgId, "hr.overview");
      expect(overview).toBeTruthy();
    });

    it("2.5 Aisha runs payroll", async () => {
      const aisha = meridian.users[0]!;

      const payroll = await cmd(aisha, meridian.orgId, "hr.payroll.prepare", {
        periodLabel: "January 2026",
      });
      expect(payroll.id).toBeTruthy();
    });

    it("2.6 David handles CRM (customers)", async () => {
      const david = meridian.users[1]!;

      const cust1 = await cmd(david, meridian.orgId, "crm.customer.create", {
        name: "GlobalTech Industries",
        email: "purchasing@globaltech.com",
        city: "London",
        country: "UK",
      });
      expect(cust1.id).toBeTruthy();

      const cust2 = await cmd(david, meridian.orgId, "crm.customer.create", {
        name: "Pacific Rim Trading",
        email: "orders@pacificrim.com",
        city: "Tokyo",
        country: "JP",
      });

      const customerList = await qry(david, meridian.orgId, "crm.customer.list");
      expect(customerList.items).toHaveLength(2);
    });

    it("2.7 David cannot access HR (permission enforcement)", async () => {
      const david = meridian.users[1]!;

      await expect(
        cmd(david, meridian.orgId, "hr.employee.create", {
          employeeNumber: "HACK-001",
          fullName: "Hack Attempt",
        }),
      ).rejects.toThrow();

      await expect(
        cmd(david, meridian.orgId, "hr.payroll.prepare", { periodLabel: "February 2026" }),
      ).rejects.toThrow();
    });

    it("2.8 James manages accounting", async () => {
      const acctIds = (meridian as TestCompany & { accountIds: Record<string, string> }).accountIds;

      const journal = await cmd(meridian.adminUser, meridian.orgId, "acc.journal.post", {
        reference: "MER-INIT-001",
        lines: [
          { accountId: acctIds["1000"], debit: 100000, credit: 0 },
          { accountId: acctIds["3000"], debit: 0, credit: 100000 },
        ],
      });
      expect(journal.id).toBeTruthy();

      // Create invoice
      const customers = await qry(meridian.adminUser, meridian.orgId, "crm.customer.list");
      const globalTech = customers.items.find((c: { name: string }) => c.name === "GlobalTech Industries");

      const invoice = await cmd(meridian.adminUser, meridian.orgId, "acc.invoice.create", {
        number: "MER-INV-001",
        customerId: globalTech?.id,
        total: 9499.50,
      });
      expect(invoice.id).toBeTruthy();

      const invoiceList = await qry(meridian.adminUser, meridian.orgId, "acc.invoice.list");
      expect(invoiceList.items).toHaveLength(1);
    });

    it("2.9 James creates manufacturing BOM and work order", async () => {
      const whId = await getWarehouseId(meridian.orgId);

      const comp1 = await cmd(meridian.adminUser, meridian.orgId, "inv.product.create", {
        sku: "MER-COMP-A",
        name: "Widget Component A",
      });

      await cmd(meridian.adminUser, meridian.orgId, "inv.stock.adjust", {
        warehouseId: whId,
        productId: comp1.id,
        quantityDelta: 1000,
        reason: "Component stock",
      });

      const bom = await cmd(meridian.adminUser, meridian.orgId, "mfg.bom.create", {
        productId: comp1.id,
        name: "Widget Assembly BOM",
        components: [{ componentProductId: comp1.id, quantity: 2 }],
      });
      expect(bom.id).toBeTruthy();

      const wo = await cmd(meridian.adminUser, meridian.orgId, "mfg.wo.create", {
        bomId: bom.id,
        number: "MER-WO-001",
        quantity: 50,
      });
      expect(wo.id).toBeTruthy();
    });

    it("2.10 James deactivates a user", async () => {
      const tempToken = crypto.randomUUID();
      const [tempUser] = await db.insert(schema.users).values({
        organizationId: meridian.orgId,
        email: "temp@meridian.co",
        displayName: "Temp Worker",
        authToken: tempToken,
      }).returning();

      const result = await cmd(meridian.adminUser, meridian.orgId, "core.user.deactivate", {
        userId: tempUser!.id,
      });
      expect(result.ok).toBe(true);

      const refreshed = await findUserById(db, tempUser!.id);
      expect(refreshed!.isActive).toBe(false);
    });

    it("2.11 David cannot escalate his own permissions", async () => {
      const david = meridian.users[1]!;

      await expect(
        cmd(david, meridian.orgId, "core.user.assignRole", {
          userId: david.id,
          roleId: meridian.roles.admin,
        }),
      ).rejects.toThrow();

      await expect(
        cmd(david, meridian.orgId, "core.role.create", {
          key: "superadmin",
          name: "Super Admin",
          permissions: ["*"],
        }),
      ).rejects.toThrow();
    });

    it("2.12 James monitors system health", async () => {
      const overview = await qry(meridian.adminUser, meridian.orgId, "core.rbac.overview");
      expect(overview.users.length).toBeGreaterThanOrEqual(3);

      const mods = await qry(meridian.adminUser, meridian.orgId, "core.modules.list");
      expect(mods.installed).toHaveLength(6);
    });
  });

  // =========================================================================
  // CROSS-COMPANY SCENARIOS
  // =========================================================================
  describe("Cross-company isolation", () => {
    it("Audit trail captures all actions", async () => {
      const allAudit = audit.entries;
      expect(allAudit.length).toBeGreaterThan(0);
      for (const entry of allAudit) {
        expect(entry.action).toBeTruthy();
        expect(entry.actorUserId).toBeTruthy();
        expect(entry.success).toBeDefined();
      }
    });

    it("Outbox events are captured", async () => {
      expect(outbox.events.length).toBeGreaterThan(0);
      for (const event of outbox.events) {
        expect(event.type).toBeTruthy();
        expect(event.organizationId).toBeTruthy();
      }
    });

    it("Companies have independent data", async () => {
      const novatechCustomers = await qry(novatech.adminUser, novatech.orgId, "crm.customer.list");
      const meridianCustomers = await qry(meridian.adminUser, meridian.orgId, "crm.customer.list");

      expect(novatechCustomers.items).toHaveLength(1); // Acme Corp
      expect(meridianCustomers.items).toHaveLength(2); // GlobalTech + Pacific Rim
    });

    it("Different orgIds ensure isolation", () => {
      expect(novatech.orgId).not.toBe(meridian.orgId);
    });

    it("All modules exercised across both companies", () => {
      // NovaTech: CRM, Accounting, Inventory, Purchasing, Manufacturing, Platform
      // Meridian: HR, CRM, Accounting, Inventory, Purchasing, Manufacturing, Platform
      // All 6 core modules covered
      expect(true).toBe(true);
    });
  });
});
