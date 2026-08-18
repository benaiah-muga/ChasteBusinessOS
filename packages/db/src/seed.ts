import type { AppConfig } from "@chaste/config";
import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import * as schema from "./schema.js";
import { hashAuthToken } from "./auth.js";

/** Platform permission catalog used by seed + RBAC UI. */
export const PERMISSION_CATALOG: { permission: string; module: string; description: string }[] = [
  { permission: "core.modules.read", module: "core", description: "List modules" },
  { permission: "core.modules.manage", module: "core", description: "Install/enable modules" },
  { permission: "core.rbac.read", module: "core", description: "View roles and users" },
  {
    permission: "core.user.manage",
    module: "core",
    description: "Create, activate, deactivate users",
  },
  { permission: "core.user.read", module: "core", description: "List users in organization" },
  { permission: "core.role.manage", module: "core", description: "Create, update, delete roles" },
  {
    permission: "core.role.assign",
    module: "core",
    description: "Assign or remove roles from users",
  },
  { permission: "core.autonomy.manage", module: "core", description: "Change AI autonomy" },
  { permission: "core.marketplace.read", module: "core", description: "Browse marketplace" },
  { permission: "core.settings.read", module: "core", description: "Read org settings" },
  { permission: "core.settings.manage", module: "core", description: "Manage org settings" },
  { permission: "core.branch.read", module: "core", description: "List and view branches" },
  { permission: "core.branch.manage", module: "core", description: "Create and update branches" },
  {
    permission: "core.branch.all",
    module: "core",
    description: "Access all branches without explicit grant",
  },
  {
    permission: "core.capability.gap.read",
    module: "core",
    description: "View capability gap tickets",
  },
  {
    permission: "core.capability.gap.manage",
    module: "core",
    description: "Create and update capability gap tickets",
  },
  {
    permission: "core.capability.catalog.read",
    module: "core",
    description: "Search the machine capability catalog",
  },
  { permission: "core.notification.read", module: "core", description: "Read own notifications" },
  { permission: "core.reminder.write", module: "core", description: "Set and manage reminders" },
  { permission: "core.followup.write", module: "core", description: "Schedule agent follow-ups" },
  {
    permission: "core.calendar.read",
    module: "core",
    description: "See calendars and events in scope",
  },
  {
    permission: "core.calendar.write",
    module: "core",
    description: "Create and update calendar events",
  },
  { permission: "core.email.send", module: "core", description: "Send outbound email" },
  { permission: "core.outbox.manage", module: "core", description: "Replay dead-lettered outbox events" },
  { permission: "core.outbox.read", module: "core", description: "Read the dead-letter queue" },
  {
    permission: "messaging.thread.read",
    module: "messaging",
    description: "List threads and read messages you belong to",
  },
  {
    permission: "messaging.thread.write",
    module: "messaging",
    description: "Send messages and open direct conversations",
  },
  {
    permission: "messaging.group.create",
    module: "messaging",
    description: "Create group conversations",
  },
  {
    permission: "messaging.group.manage",
    module: "messaging",
    description: "Add/remove members, rename, archive groups",
  },
  {
    permission: "core.marketplace.publish",
    module: "core",
    description: "Publish a module listing from a gap ticket",
  },
  {
    permission: "core.bpartner.manage",
    module: "core",
    description: "Create and update business partners",
  },
  { permission: "core.bpartner.read", module: "core", description: "Read business partners" },
  {
    permission: "core.workflow.read",
    module: "core",
    description: "List and read persisted AI workflows",
  },
  {
    permission: "core.workflow.manage",
    module: "core",
    description: "Create, update, and delete persisted AI workflows",
  },
  {
    permission: "core.workflow.run",
    module: "core",
    description: "Trigger persisted AI workflow runs",
  },
  {
    permission: "core.apikey.manage",
    module: "core",
    description: "Create, revoke, and rotate API keys",
  },
  { permission: "core.apikey.read", module: "core", description: "List API keys" },
  { permission: "crm.customer.create", module: "crm", description: "Create customers" },
  { permission: "crm.customer.read", module: "crm", description: "Read customers" },
  {
    permission: "crm.customer.update",
    module: "crm",
    description: "Update customers, change status",
  },
  { permission: "crm.contact.manage", module: "crm", description: "Manage customer contacts" },
  { permission: "crm.contact.read", module: "crm", description: "Read customer contacts" },
  { permission: "crm.interaction.write", module: "crm", description: "Log customer interactions" },
  { permission: "crm.interaction.read", module: "crm", description: "Read customer interactions" },
  {
    permission: "acc.account.manage",
    module: "accounting",
    description: "Manage chart of accounts",
  },
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
  {
    permission: "acc.invoice.create",
    module: "accounting",
    description: "Create invoices (legacy single-verb alias)",
  },
  { permission: "core.backup.manage", module: "core", description: "Create and restore backups" },
  { permission: "core.backup.read", module: "core", description: "Read backups" },
  { permission: "core.watchRule.manage", module: "core", description: "Create, update, and delete watch rules" },
  { permission: "core.watchRule.read", module: "core", description: "List watch rules" },
  { permission: "activities.write", module: "workflow", description: "Create, complete, and cancel activities" },
  { permission: "activities.read", module: "workflow", description: "Read activities" },
  { permission: "workflow.tasks.write", module: "workflow", description: "Manage workflow tasks" },
  { permission: "workflow.tasks.read", module: "workflow", description: "Read workflow tasks" },
  { permission: "workflow.instance.write", module: "workflow", description: "Manage workflow instances" },
  { permission: "workflow.instance.read", module: "workflow", description: "Read workflow instances" },
  { permission: "core.analytics.read", module: "core", description: "Read verifiable analytics queries (sales/margin summaries)" },
  { permission: "core.replenishment.read", module: "core", description: "Read stockout-risk and replenishment proposals" },
  { permission: "core.importRule.manage", module: "core", description: "Create, update, and delete data-quality/import transform rules" },
  { permission: "core.importRule.read", module: "core", description: "List data-quality/import transform rules" },
  { permission: "core.dashboard.manage", module: "core", description: "Create, update, and delete saved dashboards" },
  { permission: "core.dashboard.read", module: "core", description: "List saved dashboards" },
];

const ALL_PERMS = PERMISSION_CATALOG.map((p) => p.permission);

const MARKETPLACE: {
  moduleId: string;
  name: string;
  version: string;
  summary: string;
  category: string;
  kind: "builtin" | "marketplace" | "local_extension" | "private_cloud" | "custom";
  publisher?: string;
}[] = [
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
    moduleId: "messaging",
    name: "Messaging",
    version: "0.1.0",
    summary: "Direct and group conversations for your organization",
    category: "collaboration",
    kind: "builtin" as const,
  },
];

export interface BootstrapResult {
  organizationId: string;
  adminUserId: string;
  roleId: string;
  /**
   * The raw bootstrap-admin credential, present ONLY when this boot minted a
   * fresh token (no `CHASTE_ADMIN_TOKEN` was configured). The caller decides
   * whether/where to reveal it — dev may print, production must not.
   */
  adminAuthToken?: string;
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
      ? await db.select().from(schema.users).where(eq(schema.users.organizationId, org.id)).limit(1)
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

  // Default HQ branch + grant admin access
  let [hqBranch] = await db
    .select()
    .from(schema.branches)
    .where(eq(schema.branches.organizationId, org.id))
    .limit(1);
  if (!hqBranch) {
    const [created] = await db
      .insert(schema.branches)
      .values({
        organizationId: org.id,
        name: "Headquarters",
        code: "HQ",
        timezone: "UTC",
        active: true,
      })
      .returning();
    hqBranch = created!;
  }
  await db
    .insert(schema.userBranchAccess)
    .values({ userId: admin.id, branchId: hqBranch.id })
    .onConflictDoNothing({
      target: [schema.userBranchAccess.userId, schema.userBranchAccess.branchId],
    });
  if (!admin.activeBranchId) {
    await db
      .update(schema.users)
      .set({ activeBranchId: hqBranch.id })
      .where(eq(schema.users.id, admin.id));
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
      (p) =>
        p.endsWith(".read") ||
        p.includes(".create") ||
        p.includes(".move") ||
        p.includes(".run") ||
        p.includes(".write"),
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

  // F1 — the bootstrap admin must be able to authenticate over HTTP once the
  // anonymous fallback is gone. Mint a hashed-at-rest credential on first boot:
  // either the operator-provided `CHASTE_ADMIN_TOKEN` or a generated secret
  // surfaced exactly once by the caller (dev only). Never overwrite an existing
  // token, so restarts and re-seeds don't invalidate the current credential.
  let adminAuthToken: string | undefined;
  if (!admin.authToken) {
    const rawToken =
      cfg.auth.bootstrapAdminToken ??
      `chaste_${globalThis.crypto.randomUUID().replaceAll("-", "")}${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
    await db
      .update(schema.users)
      .set({ authToken: hashAuthToken(rawToken) })
      .where(eq(schema.users.id, admin.id));
    if (!cfg.auth.bootstrapAdminToken) {
      adminAuthToken = rawToken;
    }
  }

  return {
    organizationId: org.id,
    adminUserId: admin.id,
    roleId: adminRole.id,
    adminAuthToken,
  };
}
