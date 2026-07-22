import type { AppConfig } from "@chaste/config";
import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import * as schema from "./schema.js";

/** Platform permission catalog used by seed + RBAC UI. */
export const PERMISSION_CATALOG: { permission: string; module: string; description: string }[] = [
  { permission: "core.modules.read", module: "core", description: "List modules" },
  { permission: "core.modules.manage", module: "core", description: "Install/enable modules" },
  { permission: "core.rbac.read", module: "core", description: "View roles and users" },
  { permission: "core.user.manage", module: "core", description: "Create, activate, deactivate users" },
  { permission: "core.user.read", module: "core", description: "List users in organization" },
  { permission: "core.role.manage", module: "core", description: "Create, update, delete roles" },
  { permission: "core.role.assign", module: "core", description: "Assign or remove roles from users" },
  { permission: "core.autonomy.manage", module: "core", description: "Change AI autonomy" },
  { permission: "core.marketplace.read", module: "core", description: "Browse marketplace" },
  { permission: "core.settings.read", module: "core", description: "Read org settings" },
  { permission: "core.settings.manage", module: "core", description: "Manage org settings" },
  { permission: "crm.customer.create", module: "crm", description: "Create customers" },
  { permission: "crm.customer.read", module: "crm", description: "Read customers" },
  { permission: "acc.account.manage", module: "accounting", description: "Manage chart of accounts" },
  { permission: "acc.account.read", module: "accounting", description: "Read accounts" },
  { permission: "acc.journal.post", module: "accounting", description: "Post journal entries" },
  { permission: "acc.invoice.manage", module: "accounting", description: "Manage invoices" },
  { permission: "acc.invoice.read", module: "accounting", description: "Read invoices" },
  { permission: "inv.warehouse.manage", module: "inventory", description: "Manage warehouses" },
  { permission: "inv.product.manage", module: "inventory", description: "Manage products" },
  { permission: "inv.stock.move", module: "inventory", description: "Adjust stock" },
  { permission: "inv.stock.read", module: "inventory", description: "Read stock" },
  { permission: "pur.vendor.manage", module: "purchasing", description: "Manage vendors" },
  { permission: "pur.po.manage", module: "purchasing", description: "Manage purchase orders" },
  { permission: "pur.po.read", module: "purchasing", description: "Read purchase orders" },
  { permission: "hr.employee.manage", module: "hr", description: "Manage employees" },
  { permission: "hr.employee.read", module: "hr", description: "Read employees" },
  { permission: "hr.payroll.run", module: "hr", description: "Run payroll" },
  { permission: "hr.payroll.read", module: "hr", description: "Read payroll" },
  { permission: "mfg.bom.manage", module: "manufacturing", description: "Manage BOMs" },
  { permission: "mfg.wo.manage", module: "manufacturing", description: "Manage work orders" },
  { permission: "mfg.wo.read", module: "manufacturing", description: "Read work orders" },
];

const ALL_PERMS = PERMISSION_CATALOG.map((p) => p.permission);

const MARKETPLACE = [
  {
    moduleId: "crm",
    name: "CRM",
    version: "0.1.0",
    summary: "Customers, pipeline, and relationship records",
    category: "sales",
    kind: "builtin" as const,
  },
  {
    moduleId: "accounting",
    name: "Accounting",
    version: "0.1.0",
    summary: "Chart of accounts, journals, and invoices",
    category: "finance",
    kind: "builtin" as const,
  },
  {
    moduleId: "inventory",
    name: "Inventory",
    version: "0.1.0",
    summary: "Warehouses, products, and stock moves",
    category: "operations",
    kind: "builtin" as const,
  },
  {
    moduleId: "purchasing",
    name: "Purchasing",
    version: "0.1.0",
    summary: "Vendors and purchase orders",
    category: "operations",
    kind: "builtin" as const,
  },
  {
    moduleId: "hr",
    name: "Human Resources",
    version: "0.1.0",
    summary: "Employees and payroll preparation",
    category: "people",
    kind: "builtin" as const,
  },
  {
    moduleId: "manufacturing",
    name: "Manufacturing",
    version: "0.1.0",
    summary: "Bills of materials and work orders",
    category: "operations",
    kind: "builtin" as const,
  },
  {
    moduleId: "demo-crm",
    name: "Demo CRM Extension",
    version: "0.1.0",
    summary: "Sample custom module showing third-party style packaging",
    category: "sales",
    publisher: "community",
    kind: "custom" as const,
  },
];

export interface BootstrapResult {
  organizationId: string;
  adminUserId: string;
  roleId: string;
}

export async function bootstrapPlatform(db: Db, cfg: AppConfig): Promise<BootstrapResult> {
  // Marketplace catalog (global)
  for (const listing of MARKETPLACE) {
    await db
      .insert(schema.marketplaceListings)
      .values({
        moduleId: listing.moduleId,
        name: listing.name,
        version: listing.version,
        summary: listing.summary,
        category: listing.category,
        publisher: "publisher" in listing && listing.publisher ? listing.publisher : "chaste",
        regions: cfg.regions.includes("*") ? ["*"] : cfg.regions,
        metadata: { kind: listing.kind, archived: false },
      })
      .onConflictDoNothing({ target: schema.marketplaceListings.moduleId });
  }

  if (!cfg.bootstrap.enabled) {
    const [org] = await db.select().from(schema.organizations).limit(1);
    const [user] = org
      ? await db
          .select()
          .from(schema.users)
          .where(eq(schema.users.organizationId, org.id))
          .limit(1)
      : [];
    if (!org || !user) {
      throw new Error("Bootstrap disabled and no organization/user found");
    }
    const [ur] = await db
      .select()
      .from(schema.userRoles)
      .where(eq(schema.userRoles.userId, user.id))
      .limit(1);
    return {
      organizationId: org.id,
      adminUserId: user.id,
      roleId: ur?.roleId ?? "",
    };
  }

  let [org] = await db.select().from(schema.organizations).limit(1);
  if (!org) {
    const [created] = await db
      .insert(schema.organizations)
      .values({
        name: cfg.bootstrap.orgName,
        autonomy: cfg.defaultAutonomy,
        region: cfg.region,
      })
      .returning();
    org = created!;
  }

  let [admin] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, cfg.bootstrap.adminEmail))
    .limit(1);

  if (!admin) {
    const [created] = await db
      .insert(schema.users)
      .values({
        organizationId: org.id,
        email: cfg.bootstrap.adminEmail,
        displayName: cfg.bootstrap.adminName,
      })
      .returning();
    admin = created!;
  }

  let [adminRole] = await db
    .select()
    .from(schema.roles)
    .where(eq(schema.roles.key, "admin"))
    .limit(1);

  if (!adminRole) {
    const [created] = await db
      .insert(schema.roles)
      .values({
        organizationId: org.id,
        key: "admin",
        name: "Administrator",
        description: "Full platform access",
        isSystem: true,
      })
      .returning();
    adminRole = created!;
  }

  // Ensure admin has all permissions
  for (const permission of ALL_PERMS) {
    await db
      .insert(schema.rolePermissions)
      .values({ roleId: adminRole.id, permission })
      .onConflictDoNothing({
        target: [schema.rolePermissions.roleId, schema.rolePermissions.permission],
      });
  }

  // Operator role (read-heavy)
  let [opsRole] = await db
    .select()
    .from(schema.roles)
    .where(eq(schema.roles.key, "operator"))
    .limit(1);
  if (!opsRole) {
    const [created] = await db
      .insert(schema.roles)
      .values({
        organizationId: org.id,
        key: "operator",
        name: "Operator",
        description: "Day-to-day operations",
        isSystem: true,
      })
      .returning();
    opsRole = created!;
    const opsPerms = ALL_PERMS.filter(
      (p) => p.endsWith(".read") || p.includes(".create") || p.includes(".move") || p.includes(".run"),
    );
    for (const permission of opsPerms) {
      await db.insert(schema.rolePermissions).values({ roleId: opsRole.id, permission });
    }
  }

  await db
    .insert(schema.userRoles)
    .values({ userId: admin.id, roleId: adminRole.id })
    .onConflictDoNothing({
      target: [schema.userRoles.userId, schema.userRoles.roleId],
    });

  // Install all builtin modules for org (custom modules stay available in marketplace)
  for (const listing of MARKETPLACE.filter((l) => l.kind === "builtin")) {
    await db
      .insert(schema.moduleInstalls)
      .values({
        organizationId: org.id,
        moduleId: listing.moduleId,
        version: listing.version,
        enabled: true,
      })
      .onConflictDoNothing({
        target: [schema.moduleInstalls.organizationId, schema.moduleInstalls.moduleId],
      });
  }

  // Default chart of accounts
  const accounts = [
    { code: "1000", name: "Cash", type: "asset" },
    { code: "1100", name: "Accounts Receivable", type: "asset" },
    { code: "2000", name: "Accounts Payable", type: "liability" },
    { code: "3000", name: "Equity", type: "equity" },
    { code: "4000", name: "Revenue", type: "revenue" },
    { code: "5000", name: "Expenses", type: "expense" },
  ];
  for (const a of accounts) {
    await db
      .insert(schema.accAccounts)
      .values({ organizationId: org.id, ...a })
      .onConflictDoNothing({
        target: [schema.accAccounts.organizationId, schema.accAccounts.code],
      });
  }

  // Default warehouse
  await db
    .insert(schema.invWarehouses)
    .values({
      organizationId: org.id,
      code: "MAIN",
      name: "Main Warehouse",
      city: "HQ",
    })
    .onConflictDoNothing({
      target: [schema.invWarehouses.organizationId, schema.invWarehouses.code],
    });

  return {
    organizationId: org.id,
    adminUserId: admin.id,
    roleId: adminRole.id,
  };
}
