/**
 * Settings & Preferences E2E tests.
 *
 * Tests org settings CRUD, user preferences CRUD, permission enforcement,
 * merge semantics, and defaults.
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
} from "@chaste/kernel";
import { createDb, runMigrations, resolveUserPermissions, schema, type Db, cleanupTestData } from "@chaste/db";
import { createPlatformModule } from "@chaste/module-platform";
import { createIdentityModule } from "@chaste/module-identity";

const hasDb = Boolean(process.env.DATABASE_URL);
const DB_URL = process.env.DATABASE_URL!;

let db: ReturnType<typeof createDb>;
let commands: CommandRegistry;
let queries: QueryRegistry;
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
  adminUser: TestUser;
  operatorUser: TestUser;
}

let company: TestCompany;

const ADMIN_PERMISSIONS = [
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
  "core.modules.read", "core.rbac.read", "core.marketplace.read", "core.settings.read",
  "crm.customer.create", "crm.customer.read",
  "acc.account.read", "acc.invoice.read",
  "inv.stock.read", "inv.stock.move", "inv.product.manage", "inv.warehouse.manage",
  "pur.vendor.manage", "pur.po.manage", "pur.po.read",
  "hr.employee.read", "hr.payroll.read",
  "mfg.bom.manage", "mfg.wo.manage", "mfg.wo.read",
];

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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)("settings & preferences E2E", () => {
  beforeAll(async () => {
    db = createDb(DB_URL);
    await runMigrations(DB_URL);

    commands = createCommandRegistry();
    queries = createQueryRegistry();
    audit = new InMemoryAuditWriter();
    outbox = new InMemoryOutboxWriter();

    const modules = createModuleRegistry();
    const platform = createPlatformModule(db, modules, {
      allowFullAutonomous: true,
      regions: ["local", "us-east", "eu-west"],
    });
    platform.register({ commands, queries });
    createIdentityModule(db).register({ commands, queries });

    // Create test org
    const [org] = await db.insert(schema.organizations).values({
      name: "Settings Test Co",
      autonomy: "confirm",
      region: "local",
    }).returning();

    // Admin user
    const adminToken = crypto.randomUUID();
    const [adminRow] = await db.insert(schema.users).values({
      organizationId: org!.id,
      email: "admin@settings-test.com",
      displayName: "Admin User",
      authToken: adminToken,
    }).returning();

    const [adminRole] = await db.insert(schema.roles).values({
      organizationId: org!.id,
      key: "admin",
      name: "Administrator",
      isSystem: true,
    }).returning();

    for (const perm of ADMIN_PERMISSIONS) {
      await db.insert(schema.rolePermissions).values({ roleId: adminRole!.id, permission: perm });
    }
    await db.insert(schema.userRoles).values({ userId: adminRow!.id, roleId: adminRole!.id });

    // Operator user (no core.settings.manage)
    const opToken = crypto.randomUUID();
    const [opRow] = await db.insert(schema.users).values({
      organizationId: org!.id,
      email: "operator@settings-test.com",
      displayName: "Operator User",
      authToken: opToken,
    }).returning();

    const [opRole] = await db.insert(schema.roles).values({
      organizationId: org!.id,
      key: "operator",
      name: "Operator",
      isSystem: true,
    }).returning();

    for (const perm of OPERATOR_PERMISSIONS) {
      await db.insert(schema.rolePermissions).values({ roleId: opRole!.id, permission: perm });
    }
    await db.insert(schema.userRoles).values({ userId: opRow!.id, roleId: opRole!.id });

    // Install platform module
    await db.insert(schema.moduleInstalls).values({
      organizationId: org!.id,
      moduleId: "platform",
      version: "0.1.0",
      enabled: true,
    });

    company = {
      orgId: org!.id,
      adminUser: {
        id: adminRow!.id,
        email: adminRow!.email,
        displayName: adminRow!.displayName,
        authToken: adminToken,
        roleId: adminRole!.id,
        permissions: ADMIN_PERMISSIONS,
      },
      operatorUser: {
        id: opRow!.id,
        email: opRow!.email,
        displayName: opRow!.displayName,
        authToken: opToken,
        roleId: opRole!.id,
        permissions: OPERATOR_PERMISSIONS,
      },
    };
  });

  afterAll(async () => {
    if (db && company) {
      await cleanupTestData(db, [company.orgId]);
      await db.$client.end({ timeout: 5 });
    }
  });

  // ─── Org Settings ────────────────────────────────────────────────────

  describe("core.settings.get", () => {
    it("returns defaults for fresh org", async () => {
      const result = await qry(company.adminUser, company.orgId, "core.settings.get");
      expect(result.settings.timezone).toBe("UTC");
      expect(result.settings.locale).toBe("en");
      expect(result.settings.currency).toBe("USD");
      expect(result.settings.emailNotifications).toBe(true);
      expect(result.settings.notificationDigest).toBe("daily");
      expect(result.settings.auditRetentionDays).toBe(365);
      expect(result.settings.chatHistoryRetentionDays).toBe(90);
      expect(result.settings.modules).toEqual({});
    });

    it("operator can read settings", async () => {
      const result = await qry(company.operatorUser, company.orgId, "core.settings.get");
      expect(result.settings.timezone).toBe("UTC");
    });
  });

  describe("core.settings.update", () => {
    it("admin can update settings", async () => {
      const result = await cmd(company.adminUser, company.orgId, "core.settings.update", {
        settings: {
          timezone: "America/New_York",
          currency: "EUR",
          aiModel: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
        },
      });
      expect(result.settings.timezone).toBe("America/New_York");
      expect(result.settings.currency).toBe("EUR");
      expect(result.settings.aiModel).toBe("nvidia/llama-3.3-nemotron-super-49b-v1.5");
      // Defaults preserved
      expect(result.settings.locale).toBe("en");
      expect(result.settings.emailNotifications).toBe(true);
    });

    it("partial update preserves existing values", async () => {
      // First set some values
      await cmd(company.adminUser, company.orgId, "core.settings.update", {
        settings: { locale: "fr", aiTemperature: 0.7 },
      });

      // Then update only currency
      const result = await cmd(company.adminUser, company.orgId, "core.settings.update", {
        settings: { currency: "GBP" },
      });
      expect(result.settings.currency).toBe("GBP");
      // Previous values preserved
      expect(result.settings.locale).toBe("fr");
      expect(result.settings.aiTemperature).toBe(0.7);
      expect(result.settings.timezone).toBe("America/New_York");
    });

    it("updates module settings", async () => {
      const result = await cmd(company.adminUser, company.orgId, "core.settings.update", {
        settings: {
          modules: {
            crm: { defaultTaxRate: 0.15, currency: "USD" },
            inventory: { lowStockThreshold: 10 },
          },
        },
      });
      expect(result.settings.modules.crm).toEqual({ defaultTaxRate: 0.15, currency: "USD" });
      expect(result.settings.modules.inventory).toEqual({ lowStockThreshold: 10 });
    });

    it("replaces module settings entirely (not deep merge)", async () => {
      const result = await cmd(company.adminUser, company.orgId, "core.settings.update", {
        settings: {
          modules: { crm: { defaultTaxRate: 0.2 } },
        },
      });
      // modules.crm is replaced, not merged
      expect(result.settings.modules.crm).toEqual({ defaultTaxRate: 0.2 });
      // inventory is gone because we sent a new modules object
      expect(result.settings.modules.inventory).toBeUndefined();
    });

    it("operator cannot update settings", async () => {
      try {
        await cmd(company.operatorUser, company.orgId, "core.settings.update", {
          settings: { timezone: "Asia/Tokyo" },
        });
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.code).toBe("PERMISSION_DENIED");
      }
    });

    it("persists across reads", async () => {
      await cmd(company.adminUser, company.orgId, "core.settings.update", {
        settings: { notificationDigest: "weekly" },
      });
      const result = await qry(company.adminUser, company.orgId, "core.settings.get");
      expect(result.settings.notificationDigest).toBe("weekly");
    });
  });

  // ─── User Preferences ────────────────────────────────────────────────

  describe("core.preferences.get", () => {
    it("returns defaults for fresh user", async () => {
      const result = await qry(company.adminUser, company.orgId, "core.preferences.get");
      expect(result.preferences.theme).toBe("system");
      expect(result.preferences.timezone).toBeUndefined();
      expect(result.preferences.locale).toBeUndefined();
      expect(result.preferences.notifications).toEqual({});
    });
  });

  describe("core.preferences.update", () => {
    it("user can update own preferences", async () => {
      const result = await cmd(company.adminUser, company.orgId, "core.preferences.update", {
        preferences: {
          theme: "dark",
          timezone: "Asia/Tokyo",
          locale: "ja",
        },
      });
      expect(result.preferences.theme).toBe("dark");
      expect(result.preferences.timezone).toBe("Asia/Tokyo");
      expect(result.preferences.locale).toBe("ja");
    });

    it("partial update preserves existing values", async () => {
      // Update only theme
      const result = await cmd(company.adminUser, company.orgId, "core.preferences.update", {
        preferences: { theme: "light" },
      });
      expect(result.preferences.theme).toBe("light");
      // Previous values preserved
      expect(result.preferences.timezone).toBe("Asia/Tokyo");
      expect(result.preferences.locale).toBe("ja");
    });

    it("deep merges notification prefs", async () => {
      // Set initial notification prefs
      await cmd(company.adminUser, company.orgId, "core.preferences.update", {
        preferences: {
          notifications: { emailDigest: "weekly", pushEnabled: true },
        },
      });

      // Update only pushEnabled
      const result = await cmd(company.adminUser, company.orgId, "core.preferences.update", {
        preferences: {
          notifications: { pushEnabled: false },
        },
      });
      expect(result.preferences.notifications.pushEnabled).toBe(false);
      expect(result.preferences.notifications.emailDigest).toBe("weekly");
    });

    it("different users have independent prefs", async () => {
      // Admin sets dark theme
      await cmd(company.adminUser, company.orgId, "core.preferences.update", {
        preferences: { theme: "dark" },
      });

      // Operator sets light theme
      await cmd(company.operatorUser, company.orgId, "core.preferences.update", {
        preferences: { theme: "light" },
      });

      const adminPrefs = await qry(company.adminUser, company.orgId, "core.preferences.get");
      const opPrefs = await qry(company.operatorUser, company.orgId, "core.preferences.get");

      expect(adminPrefs.preferences.theme).toBe("dark");
      expect(opPrefs.preferences.theme).toBe("light");
    });

    it("persists across reads", async () => {
      await cmd(company.adminUser, company.orgId, "core.preferences.update", {
        preferences: { theme: "system" },
      });
      const result = await qry(company.adminUser, company.orgId, "core.preferences.get");
      expect(result.preferences.theme).toBe("system");
    });
  });

  // ─── Permission edge cases ───────────────────────────────────────────

  describe("permission enforcement", () => {
    it("unauthenticated user cannot read settings", async () => {
      const noPermsUser: TestUser = {
        id: "00000000-0000-0000-0000-000000000000",
        email: "noperms@test.com",
        displayName: "No Perms",
        authToken: "",
        roleId: "",
        permissions: [],
      };
      try {
        await qry(noPermsUser, company.orgId, "core.settings.get");
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.code).toBe("PERMISSION_DENIED");
      }
    });

    it("user without settings.manage cannot update settings", async () => {
      try {
        await cmd(company.operatorUser, company.orgId, "core.settings.update", {
          settings: { timezone: "UTC" },
        });
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.code).toBe("PERMISSION_DENIED");
      }
    });

    it("preferences commands require no special permissions", async () => {
      // Operator can update own preferences
      const result = await cmd(company.operatorUser, company.orgId, "core.preferences.update", {
        preferences: { theme: "dark" },
      });
      expect(result.preferences.theme).toBe("dark");
    });
  });

  // ─── Default values & validation ─────────────────────────────────────

  describe("defaults and validation", () => {
    it("settings update with empty object preserves all defaults", async () => {
      // Reset by updating with defaults
      await cmd(company.adminUser, company.orgId, "core.settings.update", {
        settings: {
          timezone: "UTC",
          locale: "en",
          currency: "USD",
          emailNotifications: true,
          notificationDigest: "daily",
          auditRetentionDays: 365,
          chatHistoryRetentionDays: 90,
          modules: {},
        },
      });

      const result = await qry(company.adminUser, company.orgId, "core.settings.get");
      expect(result.settings.timezone).toBe("UTC");
      expect(result.settings.currency).toBe("USD");
    });

    it("preferences update with empty object preserves defaults", async () => {
      await cmd(company.adminUser, company.orgId, "core.preferences.update", {
        preferences: { theme: "system" },
      });
      const result = await qry(company.adminUser, company.orgId, "core.preferences.get");
      expect(result.preferences.theme).toBe("system");
    });
  });
});
