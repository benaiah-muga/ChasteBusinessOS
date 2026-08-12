/**
 * Platform module E2E tests (Horizon A): branches, capability gaps,
 * notifications, invites, and tenancy/security guards.
 *
 * Covers the multi-branch, self-development, and notification surfaces that
 * the platform spec claims as "implemented (Horizon A)" — plus the org-scoping
 * hardening applied to role/user/module/marketplace commands.
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
import { createDb, runMigrations, schema, type Db, cleanupTestData, hashAuthToken, resolveUserByToken } from "@chaste/db";
import { eq } from "drizzle-orm";
import { createEmailProcessor, createPlatformModule, createScheduleProcessor } from "@chaste/module-platform";
import { createSchedulingModule } from "@chaste/module-scheduling";
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
  roleId: string;
  permissions: string[];
}

interface TestCompany {
  orgId: string;
  adminUser: TestUser;
  operatorUser: TestUser;
  operatorRoleId: string;
  noPermUser: TestUser;
}

const ADMIN_PERMISSIONS = [
  "core.modules.read", "core.modules.manage", "core.rbac.read",
  "core.user.manage", "core.user.read", "core.role.manage", "core.role.assign",
  "core.autonomy.manage", "core.marketplace.read",
  "core.settings.read", "core.settings.manage",
  "core.branch.read", "core.branch.manage", "core.branch.all",
  "core.capability.gap.read", "core.capability.gap.manage",
  "core.capability.catalog.read",
  "core.notification.read",
  "core.reminder.write", "core.followup.write",
  "core.calendar.read", "core.calendar.write",
  "core.email.send", "core.marketplace.publish",
];

const OPERATOR_PERMISSIONS = [
  "core.modules.read", "core.rbac.read", "core.marketplace.read", "core.user.read",
  "core.branch.read",
  "core.notification.read",
  "core.capability.catalog.read",
  "core.reminder.write", "core.followup.write",
  "core.calendar.read", "core.calendar.write",
  "core.email.send",
];

let orgA: TestCompany;
let orgB: TestCompany;
let hqBranchA: string;

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

async function cmdFails(user: TestUser, orgId: string, name: string, input: unknown): Promise<any> {
  try {
    await executeCommand(commands, name, input, ctxFor(user, orgId), { audit, outbox });
    expect.fail("Should have thrown");
  } catch (e: any) {
    return e;
  }
}

async function qryFails(user: TestUser, orgId: string, name: string, input: unknown = {}): Promise<any> {
  try {
    await executeQuery(queries, name, input, ctxFor(user, orgId));
    expect.fail("Should have thrown");
  } catch (e: any) {
    return e;
  }
}

async function createCompany(name: string, email: string, display: string): Promise<TestCompany> {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name, autonomy: "confirm", region: "local" })
    .returning();

  const [adminRow] = await db
    .insert(schema.users)
    .values({ organizationId: org!.id, email, displayName: display })
    .returning();

  const [adminRole] = await db
    .insert(schema.roles)
    .values({ organizationId: org!.id, key: "admin", name: "Administrator", isSystem: true })
    .returning();
  for (const perm of ADMIN_PERMISSIONS) {
    await db.insert(schema.rolePermissions).values({ roleId: adminRole!.id, permission: perm });
  }
  await db.insert(schema.userRoles).values({ userId: adminRow!.id, roleId: adminRole!.id });

  const [opRow] = await db
    .insert(schema.users)
    .values({ organizationId: org!.id, email: `op-${email}`, displayName: `Operator ${display}` })
    .returning();
  const [opRole] = await db
    .insert(schema.roles)
    .values({ organizationId: org!.id, key: "operator", name: "Operator", isSystem: true })
    .returning();
  for (const perm of OPERATOR_PERMISSIONS) {
    await db.insert(schema.rolePermissions).values({ roleId: opRole!.id, permission: perm });
  }
  await db.insert(schema.userRoles).values({ userId: opRow!.id, roleId: opRole!.id });

  // HQ branch seeded like bootstrapPlatform does
  const [hq] = await db
    .insert(schema.branches)
    .values({ organizationId: org!.id, name: "Headquarters", code: "HQ", timezone: "UTC", active: true })
    .returning();
  await db
    .insert(schema.userBranchAccess)
    .values({ userId: adminRow!.id, branchId: hq!.id });
  await db
    .update(schema.users)
    .set({ activeBranchId: hq!.id })
    .where(eq(schema.users.id, adminRow!.id));

  return {
    orgId: org!.id,
    adminUser: {
      id: adminRow!.id,
      email: adminRow!.email,
      displayName: adminRow!.displayName,
      roleId: adminRole!.id,
      permissions: ADMIN_PERMISSIONS,
    },
    operatorUser: {
      id: opRow!.id,
      email: opRow!.email,
      displayName: opRow!.displayName,
      roleId: opRole!.id,
      permissions: OPERATOR_PERMISSIONS,
    },
    operatorRoleId: opRole!.id,
    noPermUser: {
      id: "",
      email: "",
      displayName: "No Perms",
      roleId: "",
      permissions: [],
    },
  };
}

describe.skipIf(!hasDb)("Platform module E2E", () => {
  beforeAll(async () => {
    db = createDb(DB_URL);
    await runMigrations(DB_URL);
    await cleanupTestData(db);

    commands = createCommandRegistry();
    queries = createQueryRegistry();
    audit = new InMemoryAuditWriter();
    outbox = new InMemoryOutboxWriter();

    const modules = createModuleRegistry();
    const platform = createPlatformModule(db, modules, {
      allowFullAutonomous: true,
      regions: ["local"],
    });
    platform.register({ commands, queries });

    // ARCH-3 — scheduling lives in its own module; register it so the bus is
    // identical to production (createRuntime) for this test host.
    const scheduling = createSchedulingModule(db);
    scheduling.register({ commands, queries });

    // ARCH-3 — identity (rbac/roles/users) likewise extracted from platform.
    const identity = createIdentityModule(db);
    identity.register({ commands, queries });

    // Seed marketplace listings so install validation has a catalog to check.
    await db.insert(schema.marketplaceListings).values({
      moduleId: "crm",
      name: "CRM",
      version: "0.1.0",
      summary: "Customers",
      category: "sales",
      publisher: "chaste",
      regions: ["*"],
      metadata: { kind: "builtin", archived: false },
    });
    await db.insert(schema.marketplaceListings).values({
      moduleId: "community-ext",
      name: "Community Ext",
      version: "0.1.0",
      summary: "Community package",
      category: "sales",
      publisher: "community",
      regions: ["*"],
      metadata: { kind: "custom", archived: false },
    });

    orgA = await createCompany("Platform Test A", "admin-a@test.com", "Admin A");
    orgB = await createCompany("Platform Test B", "admin-b@test.com", "Admin B");

    // A user with no roles at all — for permission-denied assertions.
    const [bare] = await db
      .insert(schema.users)
      .values({ organizationId: orgA.orgId, email: "bare@test.com", displayName: "No Perms" })
      .returning();
    orgA.noPermUser = { ...orgA.noPermUser, id: bare!.id, email: bare!.email };

    const branchesA = await qry(orgA.adminUser, orgA.orgId, "core.branch.list");
    hqBranchA = branchesA.branches.find((b: any) => b.code === "HQ")!.id;
  });

  afterAll(async () => {
    if (db && orgA) {
      await cleanupTestData(db);
      await db.$client.end({ timeout: 5 });
    }
  });

  // ─── Branches ─────────────────────────────────────────────────────────

  describe("core.branch.list", () => {
    it("admin with core.branch.all sees every org branch", async () => {
      const result = await qry(orgA.adminUser, orgA.orgId, "core.branch.list");
      expect(result.branches.length).toBe(1);
      expect(result.branches[0].code).toBe("HQ");
      expect(result.branches[0].grantType).toBe("all");
      expect(result.branches[0].isActiveBranch).toBe(true);
    });

    it("operator without core.branch.all sees only explicitly granted branches", async () => {
      const result = await qry(orgA.operatorUser, orgA.orgId, "core.branch.list");
      expect(result.branches.length).toBe(0); // no grants yet
    });

    it("user without core.branch.read permission is denied", async () => {
      const e = await qryFails(orgA.noPermUser, orgA.orgId, "core.branch.list", {});
      expect(e.code).toBe("PERMISSION_DENIED");
    });
  });

  describe("core.branch.create", () => {
    it("creates a branch, grants the creator access, and becomes active", async () => {
      const created = await cmd(orgA.adminUser, orgA.orgId, "core.branch.create", {
        name: "Nairobi",
        code: "NBO",
        timezone: "Africa/Nairobi",
      });
      expect(created.code).toBe("NBO");
      expect(created.active).toBe(true);

      const list = await qry(orgA.adminUser, orgA.orgId, "core.branch.list");
      expect(list.branches.map((b: any) => b.code)).toContain("NBO");
    });

    it("operator without core.branch.manage is denied", async () => {
      const e = await cmdFails(orgA.operatorUser, orgA.orgId, "core.branch.create", {
        name: "Nope",
        code: "NOP",
      });
      expect(e.code).toBe("PERMISSION_DENIED");
    });

    it("cannot create a duplicate branch code in the same org", async () => {
      const e = await cmdFails(orgA.adminUser, orgA.orgId, "core.branch.create", {
        name: "Nairobi Again",
        code: "NBO",
      });
      expect(e.message).toContain("already exists");
    });
  });

  describe("core.branch.set_active", () => {
    it("switches the user's active branch", async () => {
      const nbo = (await qry(orgA.adminUser, orgA.orgId, "core.branch.list")).branches.find(
        (b: any) => b.code === "NBO",
      );
      const result = await cmd(orgA.adminUser, orgA.orgId, "core.branch.set_active", {
        branchId: nbo.id,
      });
      expect(result.name).toBe("Nairobi");

      const list = await qry(orgA.adminUser, orgA.orgId, "core.branch.list");
      expect(list.branches.find((b: any) => b.id === nbo.id).isActiveBranch).toBe(true);
    });

    it("operator cannot switch to a branch they were not granted", async () => {
      const nbo = (await qry(orgA.adminUser, orgA.orgId, "core.branch.list")).branches.find(
        (b: any) => b.code === "NBO",
      );
      const e = await cmdFails(orgA.operatorUser, orgA.orgId, "core.branch.set_active", {
        branchId: nbo.id,
      });
      expect(e.message).toContain("do not have access");
    });
  });

  describe("core.branch.grant / revoke", () => {
    it("grant gives an operator explicit access", async () => {
      await cmd(orgA.adminUser, orgA.orgId, "core.branch.grant", {
        userId: orgA.operatorUser.id,
        branchId: hqBranchA,
      });
      const list = await qry(orgA.operatorUser, orgA.orgId, "core.branch.list");
      expect(list.branches.map((b: any) => b.code)).toContain("HQ");
      expect(list.branches[0].grantType).toBe("explicit");
    });

    it("revoke removes explicit access but cannot revoke the user's active branch", async () => {
      // Switch the operator to HQ first (they now have access), then try to revoke it.
      await cmd(orgA.operatorUser, orgA.orgId, "core.branch.set_active", { branchId: hqBranchA });
      const e = await cmdFails(orgA.adminUser, orgA.orgId, "core.branch.revoke", {
        userId: orgA.operatorUser.id,
        branchId: hqBranchA,
      });
      expect(e.message).toContain("active branch");
    });

    it("cannot grant access to a user from another org", async () => {
      const nbo = (await qry(orgA.adminUser, orgA.orgId, "core.branch.list")).branches.find(
        (b: any) => b.code === "NBO",
      );
      const e = await cmdFails(orgA.adminUser, orgA.orgId, "core.branch.grant", {
        userId: orgB.adminUser.id,
        branchId: nbo.id,
      });
      expect(e.message).toContain("User not found");
    });
  });

  describe("core.branch.update", () => {
    it("renames a branch and guards the last active branch", async () => {
      const nbo = (await qry(orgA.adminUser, orgA.orgId, "core.branch.list")).branches.find(
        (b: any) => b.code === "NBO",
      );
      const updated = await cmd(orgA.adminUser, orgA.orgId, "core.branch.update", {
        branchId: nbo.id,
        name: "Nairobi West",
      });
      expect(updated.name).toBe("Nairobi West");

      // Deactivating HQ while NBO is still active is allowed...
      const ok = await cmd(orgA.adminUser, orgA.orgId, "core.branch.update", {
        branchId: hqBranchA,
        active: false,
      });
      expect(ok.active).toBe(false);

      // ...but deactivating the final remaining active branch must fail.
      const e = await cmdFails(orgA.adminUser, orgA.orgId, "core.branch.update", {
        branchId: nbo.id,
        active: false,
      });
      expect(e.message).toContain("Cannot deactivate the last active branch");

      // Reactivate HQ so later tests keep working.
      await cmd(orgA.adminUser, orgA.orgId, "core.branch.update", {
        branchId: hqBranchA,
        active: true,
      });
    });
  });

  // ─── Capability gaps ──────────────────────────────────────────────────

  describe("capability gap tickets", () => {
    let ticketId: string;

    it("create a draft ticket", async () => {
      const created = await cmd(orgA.adminUser, orgA.orgId, "core.capability.gap.create", {
        proposedCapabilityId: "multi-currency-pricing",
        title: "Customer-specific multi-currency price lists",
        abstractRequirement:
          "Allow per-customer price lists with per-currency amounts and tax handling.",
        acceptanceCriteria: [
          "A customer can have a price list per currency",
          "Quotes use the customer's active price list",
        ],
        exampleScenarios: ["Acme buys in EUR with contract pricing"],
        nonGoals: ["FX hedging"],
      });
      expect(created.status).toBe("draft");
      expect(created.proposedCapabilityId).toBe("multi-currency-pricing");
      ticketId = created.id;
    });

    it("list returns the ticket with a status filter", async () => {
      const all = await qry(orgA.adminUser, orgA.orgId, "core.capability.gap.list");
      expect(all.tickets.some((t: any) => t.id === ticketId)).toBe(true);
      const drafts = await qry(orgA.adminUser, orgA.orgId, "core.capability.gap.list", {
        status: "draft",
      });
      expect(drafts.tickets.length).toBeGreaterThanOrEqual(1);
    });

    it("user without gap permission is denied", async () => {
      const e = await qryFails(orgA.noPermUser, orgA.orgId, "core.capability.gap.list", {});
      expect(e.code).toBe("PERMISSION_DENIED");
    });

    it("update edits a draft ticket", async () => {
      const updated = await cmd(orgA.adminUser, orgA.orgId, "core.capability.gap.update", {
        ticketId,
        title: "Multi-currency customer price lists (v2)",
        deploymentTarget: "marketplace_shared",
      });
      expect(updated.status).toBe("draft");
      expect(updated.title).toContain("v2");
    });

    it("confirm moves the ticket to confirmed and notifies the creator", async () => {
      const confirmed = await cmd(orgA.adminUser, orgA.orgId, "core.capability.gap.confirm", {
        ticketId,
        suggestedModuleId: "pricing",
      });
      expect(confirmed.status).toBe("confirmed");

      const notes = await qry(orgA.adminUser, orgA.orgId, "core.notification.list", {
        unreadOnly: true,
      });
      expect(
        notes.notifications.some((n: any) => n.title.includes("Capability gap confirmed")),
      ).toBe(true);
    });

    it("cannot edit a ticket after work begins", async () => {
      await db
        .update(schema.capabilityGapTickets)
        .set({ status: "in_progress" })
        .where(eq(schema.capabilityGapTickets.id, ticketId));
      const e = await cmdFails(orgA.adminUser, orgA.orgId, "core.capability.gap.update", {
        ticketId,
        title: "Late edit",
      });
      expect(e.message).toContain("in_progress");
    });
  });

  // ─── Capability catalog (S0) + placement recommender (S1) ───────────────

  describe("capability catalog + placement recommender", () => {
    it("lists the seeded machine catalog", async () => {
      const result = await qry(orgA.adminUser, orgA.orgId, "core.capability.catalog.list");
      expect(result.items.length).toBeGreaterThanOrEqual(16);
      expect(result.items.some((i: any) => i.capabilityId === "core.branches")).toBe(true);
      const scoped = await qry(orgA.adminUser, orgA.orgId, "core.capability.catalog.list", {
        moduleId: "crm",
      });
      expect(scoped.items.every((i: any) => i.moduleId === "crm")).toBe(true);
    });

    it("searches the catalog by name and description", async () => {
      const hit = await qry(orgA.adminUser, orgA.orgId, "core.capability.catalog.search", {
        query: "invoice",
      });
      expect(hit.items.some((i: any) => i.capabilityId === "acc.accounts")).toBe(true);
      const miss = await qry(orgA.adminUser, orgA.orgId, "core.capability.catalog.search", {
        query: "quantum teleportation",
      });
      expect(miss.items).toHaveLength(0);
    });

    it("operator role can read the catalog", async () => {
      const result = await qry(orgA.operatorUser, orgA.orgId, "core.capability.catalog.list");
      expect(result.items.length).toBeGreaterThan(0);
    });

    it("recommends platform_roadmap for kernel-adjacent requirements", async () => {
      const rec = await qry(orgA.adminUser, orgA.orgId, "core.capability.gap.recommend", {
        abstractRequirement: "Custom authz rules that override role-based permissions.",
        acceptanceCriteria: ["Allow per-branch permission overrides"],
      });
      expect(rec.deploymentTarget).toBe("platform_roadmap");
      expect(rec.signals).toContain("touches kernel authz/payments/core");
    });

    it("recommends local_extension for org-specific processes", async () => {
      const rec = await qry(orgA.adminUser, orgA.orgId, "core.capability.gap.recommend", {
        abstractRequirement: "Our internal purchase approval workflow with company-specific steps.",
      });
      expect(rec.deploymentTarget).toBe("local_extension");
    });

    it("recommends marketplace_shared for common SMB needs", async () => {
      const rec = await qry(orgA.adminUser, orgA.orgId, "core.capability.gap.recommend", {
        abstractRequirement: "Track customer churn and send renewal notices.",
      });
      expect(rec.deploymentTarget).toBe("marketplace_shared");
    });
  });

  // ─── Notifications ────────────────────────────────────────────────────

  describe("notifications", () => {
    it("branch grant creates a notification for the target user", async () => {
      const nbo = (await qry(orgA.adminUser, orgA.orgId, "core.branch.list")).branches.find(
        (b: any) => b.code === "NBO",
      );
      await cmd(orgA.adminUser, orgA.orgId, "core.branch.grant", {
        userId: orgA.operatorUser.id,
        branchId: nbo.id,
      });
      const notes = await qry(orgA.operatorUser, orgA.orgId, "core.notification.list");
      expect(notes.notifications.some((n: any) => n.title.includes("Access granted to branch"))).toBe(
        true,
      );
    });

    it("users only see their own notifications", async () => {
      const adminNotes = await qry(orgA.adminUser, orgA.orgId, "core.notification.list");
      const opNotes = await qry(orgA.operatorUser, orgA.orgId, "core.notification.list");
      for (const n of opNotes.notifications) {
        expect(adminNotes.notifications.some((a: any) => a.id === n.id)).toBe(false);
      }
    });

    it("mark_read and mark_all_read flip read flags", async () => {
      const unread = await qry(orgA.operatorUser, orgA.orgId, "core.notification.list", {
        unreadOnly: true,
      });
      expect(unread.notifications.length).toBeGreaterThan(0);
      const first = unread.notifications[0];
      await cmd(orgA.operatorUser, orgA.orgId, "core.notification.mark_read", {
        notificationId: first.id,
      });
      const after = await qry(orgA.operatorUser, orgA.orgId, "core.notification.list");
      expect(after.notifications.find((n: any) => n.id === first.id).read).toBe(true);

      const marked = await cmd(orgA.operatorUser, orgA.orgId, "core.notification.mark_all_read", {});
      expect(marked.markedCount).toBeGreaterThan(0);
      const empty = await qry(orgA.operatorUser, orgA.orgId, "core.notification.list", {
        unreadOnly: true,
      });
      expect(empty.notifications.length).toBe(0);
    });

    it("cannot mark another user's notification as read", async () => {
      const adminNotes = await qry(orgA.adminUser, orgA.orgId, "core.notification.list");
      const target = adminNotes.notifications[0];
      const e = await cmdFails(orgA.operatorUser, orgA.orgId, "core.notification.mark_read", {
        notificationId: target.id,
      });
      expect(e.message).toContain("Notification not found");
    });
  });

  // ─── Invites ──────────────────────────────────────────────────────────

  describe("core.user.invite", () => {
    it("invites a user with a role and branch access", async () => {
      const invited = await cmd(orgA.adminUser, orgA.orgId, "core.user.invite", {
        email: "ops-a@test.com",
        displayName: "Ops A",
        roleId: orgA.operatorRoleId,
        branchId: hqBranchA,
      });
      expect(invited.authToken).toBeTruthy();
      expect(invited.roleId).toBe(orgA.operatorRoleId);
      expect(invited.branchId).toBe(hqBranchA);

      const list = await qry(orgA.adminUser, orgA.orgId, "core.user.list");
      expect(list.users.some((u: any) => u.email === "ops-a@test.com")).toBe(true);
    });

    it("rejects a roleId that belongs to another org", async () => {
      const e = await cmdFails(orgA.adminUser, orgA.orgId, "core.user.invite", {
        email: "x@test.com",
        displayName: "X",
        roleId: orgB.adminUser.roleId,
      });
      expect(e.message).toContain("Role not found");
    });

    it("stores the invite token hashed at rest and returns it raw once", async () => {
      const invited = await cmd(orgA.adminUser, orgA.orgId, "core.user.invite", {
        email: "hashed-token@test.com",
        displayName: "Hashed Token",
      });
      const raw = invited.authToken as string;
      const [row] = await db
        .select({ stored: schema.users.authToken })
        .from(schema.users)
        .where(eq(schema.users.id, invited.id));
      // Raw token is returned to the inviter; only the digest is at rest.
      expect(row!.stored).toBe(hashAuthToken(raw));
      expect(row!.stored).not.toBe(raw);

      // The raw token still authenticates (hashed lookup path).
      const authed = await resolveUserByToken(db, raw);
      expect(authed?.userId).toBe(invited.id);
    });
  });

  // ─── Reminders & Follow-ups (scheduling-and-comms §2/§3) ─────────────

  describe("core.reminder.set", () => {
    const future = () => new Date(Date.now() + 60_000).toISOString();

    it("schedules a reminder and notifies the scheduler", async () => {
      const created = await cmd(orgA.operatorUser, orgA.orgId, "core.reminder.set", {
        title: "Call Acme re: payment",
        fireAt: future(),
      });
      expect(created.status).toBe("scheduled");
      expect(Date.parse(created.fireAt)).toBeGreaterThan(Date.now());

      const notes = await qry(orgA.operatorUser, orgA.orgId, "core.notification.list", {
        unreadOnly: true,
      });
      expect(notes.notifications.some((n: any) => n.title === "Reminder scheduled")).toBe(true);
    });

    it("rejects a fireAt in the past", async () => {
      const e = await cmdFails(orgA.operatorUser, orgA.orgId, "core.reminder.set", {
        title: "Too late",
        fireAt: new Date(Date.now() - 60_000).toISOString(),
      });
      expect(e.code).toBe("VALIDATION_ERROR");
    });

    it("rejects a branchId from another org", async () => {
      const branchesB = await qry(orgB.adminUser, orgB.orgId, "core.branch.list");
      const otherBranch = branchesB.branches[0].id;
      const e = await cmdFails(orgA.operatorUser, orgA.orgId, "core.reminder.set", {
        title: "Wrong org branch",
        fireAt: future(),
        branchId: otherBranch,
      });
      expect(e.message).toContain("Branch not found");
    });
  });

  describe("core.reminder.list / cancel", () => {
    let reminderId: string;

    it("lists only the caller's own reminders", async () => {
      const mine = await qry(orgA.operatorUser, orgA.orgId, "core.reminder.list");
      expect(mine.reminders.length).toBeGreaterThan(0);
      reminderId = mine.reminders[0].id;

      const adminList = await qry(orgA.adminUser, orgA.orgId, "core.reminder.list");
      expect(adminList.reminders.some((r: any) => r.id === reminderId)).toBe(false);
    });

    it("cancels a scheduled reminder", async () => {
      const result = await cmd(orgA.operatorUser, orgA.orgId, "core.reminder.cancel", {
        reminderId,
      });
      expect(result.cancelled).toBe(true);
      const list = await qry(orgA.operatorUser, orgA.orgId, "core.reminder.list", {
        status: "cancelled",
      });
      expect(list.reminders.some((r: any) => r.id === reminderId)).toBe(true);
    });

    it("cannot cancel another user's reminder", async () => {
      const adminReminder = await cmd(orgA.adminUser, orgA.orgId, "core.reminder.set", {
        title: "Admin only",
        fireAt: new Date(Date.now() + 120_000).toISOString(),
      });
      const e = await cmdFails(orgA.operatorUser, orgA.orgId, "core.reminder.cancel", {
        reminderId: adminReminder.id,
      });
      expect(e.message).toContain("Reminder not found");
    });
  });

  describe("core.followup.create / list / cancel", () => {
    let followUpId: string;

    it("schedules an agent follow-up", async () => {
      const created = await cmd(orgA.operatorUser, orgA.orgId, "core.followup.create", {
        goal: "Review overdue invoices",
        fireAt: new Date(Date.now() + 60_000).toISOString(),
      });
      expect(created.status).toBe("scheduled");
      expect(created.goal).toBe("Review overdue invoices");
      followUpId = created.id;
    });

    it("lists the follow-up for the owner", async () => {
      const list = await qry(orgA.operatorUser, orgA.orgId, "core.followup.list");
      expect(list.followUps.some((f: any) => f.id === followUpId)).toBe(true);
    });

    it("cancels a scheduled follow-up", async () => {
      const result = await cmd(orgA.operatorUser, orgA.orgId, "core.followup.cancel", {
        followUpId,
      });
      expect(result.cancelled).toBe(true);
    });
  });

  describe("core.calendar (C3)", () => {
    let eventId: string;

    it("creates an event on the default org calendar", async () => {
      const created = await cmd(orgA.operatorUser, orgA.orgId, "core.calendar.event.create", {
        title: "Stock count",
        startsAt: new Date(Date.now() + 60_000).toISOString(),
        endsAt: new Date(Date.now() + 120_000).toISOString(),
        timezone: "Africa/Nairobi",
        attendees: [orgA.operatorUser.email],
      });
      expect(created.status).toBe("scheduled");
      expect(created.title).toBe("Stock count");
      expect(created.timezone).toBe("Africa/Nairobi");
      expect(created.attendees).toContain(orgA.operatorUser.email);
      eventId = created.id;

      const notes = await qry(orgA.operatorUser, orgA.orgId, "core.notification.list", {
        unreadOnly: true,
      });
      expect(notes.notifications.some((n: any) => n.title === "Event scheduled")).toBe(true);
    });

    it("creates a branch-scoped event", async () => {
      const created = await cmd(orgA.operatorUser, orgA.orgId, "core.calendar.event.create", {
        title: "Branch standup",
        startsAt: new Date(Date.now() + 180_000).toISOString(),
        endsAt: new Date(Date.now() + 240_000).toISOString(),
        branchId: hqBranchA,
      });
      expect(created.branchId).toBe(hqBranchA);
    });

    it("rejects an event whose end precedes its start", async () => {
      const e = await cmdFails(orgA.operatorUser, orgA.orgId, "core.calendar.event.create", {
        title: "Bad event",
        startsAt: new Date(Date.now() + 60_000).toISOString(),
        endsAt: new Date(Date.now() + 30_000).toISOString(),
      });
      expect(e.message).toContain("after startsAt");
    });

    it("lists events within a date range", async () => {
      const list = await qry(orgA.operatorUser, orgA.orgId, "core.calendar.list", {
        from: new Date(Date.now() - 60_000).toISOString(),
        to: new Date(Date.now() + 300_000).toISOString(),
      });
      expect(list.events.some((ev: any) => ev.id === eventId)).toBe(true);
      expect(list.events.every((ev: any) => ev.status === "scheduled")).toBe(true);
    });

    it("filters the list by branch", async () => {
      const list = await qry(orgA.operatorUser, orgA.orgId, "core.calendar.list", {
        branchId: hqBranchA,
      });
      expect(list.events.every((ev: any) => ev.branchId === hqBranchA)).toBe(true);
    });

    it("updates an event title and attendees", async () => {
      const updated = await cmd(orgA.operatorUser, orgA.orgId, "core.calendar.event.update", {
        eventId,
        title: "Stock count (rescheduled)",
        attendees: [],
      });
      expect(updated.title).toBe("Stock count (rescheduled)");
      expect(updated.attendees).toHaveLength(0);
    });

    it("cancels an event and hides it from the default list", async () => {
      const result = await cmd(orgA.operatorUser, orgA.orgId, "core.calendar.event.cancel", {
        eventId,
      });
      expect(result.cancelled).toBe(true);

      const list = await qry(orgA.operatorUser, orgA.orgId, "core.calendar.list", {
        from: new Date(Date.now() - 60_000).toISOString(),
        to: new Date(Date.now() + 300_000).toISOString(),
      });
      expect(list.events.some((ev: any) => ev.id === eventId)).toBe(false);

      const withCancelled = await qry(orgA.operatorUser, orgA.orgId, "core.calendar.list", {
        includeCancelled: true,
        from: new Date(Date.now() - 60_000).toISOString(),
        to: new Date(Date.now() + 300_000).toISOString(),
      });
      expect(withCancelled.events.some((ev: any) => ev.id === eventId)).toBe(true);
    });

    it("denies calendar read without permission", async () => {
      const e = await qryFails(orgA.noPermUser, orgA.orgId, "core.calendar.list", {});
      expect(e.code).toBe("PERMISSION_DENIED");
    });
  });

  describe("email outbox (C6)", () => {
    it("enqueues a plain send as queued", async () => {
      const created = await cmd(orgA.operatorUser, orgA.orgId, "core.email.send", {
        to: "ops@example.com",
        subject: "Test subject",
        body: "Hello from the outbox",
      });
      expect(created.status).toBe("queued");
      expect(created.subject).toBe("Test subject");

      const list = await qry(orgA.operatorUser, orgA.orgId, "core.email.outbox.list");
      expect(list.emails.some((e: any) => e.id === created.id)).toBe(true);
    });

    it("enqueues a versioned template with rendered vars", async () => {
      const created = await cmd(orgA.operatorUser, orgA.orgId, "core.email.enqueue_template", {
        to: "invitee@example.com",
        template: "invite",
        vars: { name: "Sam", org: "Org A", inviter: "Admin A", link: "https://chaste.local/invite/1" },
      });
      expect(created.status).toBe("queued");
      expect(created.subject).toBe("You're invited to Org A on Chaste BusinessOS");
    });

    it("worker flush sends queued mail through the adapter", async () => {
      const created = await cmd(orgA.operatorUser, orgA.orgId, "core.email.send", {
        to: "worker@example.com",
        subject: "Flush me",
        body: "Send on next tick",
      });
      const email = createEmailProcessor(db);
      const sent = await email.flushEmailOutbox();
      expect(sent).toBeGreaterThanOrEqual(1);

      const [row] = await db
        .select()
        .from(schema.emailOutbox)
        .where(eq(schema.emailOutbox.id, created.id));
      expect(row!.status).toBe("sent");
      expect(row!.providerMessageId).toMatch(/^console:/);
      expect(row!.sentAt).not.toBeNull();
    });

    it("outbox rows expose provider + error + sentAt for the admin UI", async () => {
      const created = await cmd(orgA.operatorUser, orgA.orgId, "core.email.send", {
        to: "fields@example.com",
        subject: "Field check",
        body: "Check the fields",
      });
      const email = createEmailProcessor(db);
      await email.flushEmailOutbox();

      const list = await qry(orgA.operatorUser, orgA.orgId, "core.email.outbox.list");
      const mine = list.emails.find((e: any) => e.id === created.id);
      expect(mine).toBeTruthy();
      expect(mine.provider).toBe("console");
      expect(mine.providerMessageId).toMatch(/^console:/);
      expect(mine.sentAt).not.toBeNull();
      expect(mine.error).toBeNull();
    });

    it("core.email.provider.status reports the active provider without secrets", async () => {
      const status = await qry(orgA.operatorUser, orgA.orgId, "core.email.provider.status");
      expect(["resend", "smtp", "console"]).toContain(status.provider);
      expect(JSON.stringify(status)).not.toMatch(/API_KEY|SMTP_PASS|CHASTE_/);
    });

    it("core.email.retry re-queues a failed email for the owning org", async () => {
      const [failed] = await db
        .insert(schema.emailOutbox)
        .values({
          organizationId: orgA.orgId,
          to: "retry@example.com",
          subject: "Retry me",
          body: "Nudge",
          status: "failed",
          provider: "console",
          error: "simulated provider failure",
        })
        .returning();

      const requeued = await cmd(orgA.operatorUser, orgA.orgId, "core.email.retry", {
        emailId: failed!.id,
      });
      expect(requeued.status).toBe("queued");
      expect(requeued.error).toBeNull();
      expect(requeued.provider).toBeNull();
    });

    it("core.email.retry cannot touch another org's email", async () => {
      const [failed] = await db
        .insert(schema.emailOutbox)
        .values({
          organizationId: orgA.orgId,
          to: "private@example.com",
          subject: "Org A only",
          body: "Secret",
          status: "failed",
          error: "boom",
        })
        .returning();

      const e = await cmdFails(orgB.adminUser, orgB.orgId, "core.email.retry", {
        emailId: failed!.id,
      });
      expect(e.code).toBe("NOT_FOUND");
    });
  });

  describe("marketplace publish (S4)", () => {
    it("publishes a confirmed gap ticket as a local extension", async () => {
      const created = await cmd(orgA.adminUser, orgA.orgId, "core.capability.gap.create", {
        proposedCapabilityId: "custom-approval-flow",
        title: "Custom approval flow",
        abstractRequirement: "Our internal approval workflow with company-specific steps.",
        acceptanceCriteria: ["Approvals route to finance first"],
      });
      const confirmed = await cmd(orgA.adminUser, orgA.orgId, "core.capability.gap.confirm", {
        ticketId: created.id,
        deploymentTarget: "local_extension",
      });
      expect(confirmed.status).toBe("confirmed");

      const result = await cmd(orgA.adminUser, orgA.orgId, "core.marketplace.publish", {
        moduleId: "ext-approval",
        name: "Custom Approval",
        version: "0.1.0",
        summary: "Org-specific approval flow",
        category: "operations",
        kind: "local_extension",
        gapTicketId: created.id,
      });
      expect(result.published).toBe(true);

      const listing = await qry(orgA.adminUser, orgA.orgId, "core.marketplace.list");
      const mine = listing.items.find((i: any) => i.moduleId === "ext-approval");
      expect(mine).toBeTruthy();
      expect(mine.kind).toBe("custom");
      expect(mine.summary).toBe("Org-specific approval flow");
    });

    it("rejects publishing a platform_roadmap ticket", async () => {
      const created = await cmd(orgA.adminUser, orgA.orgId, "core.capability.gap.create", {
        proposedCapabilityId: "authz-overrides",
        title: "Authz overrides",
        abstractRequirement: "Custom authz rules overriding role-based permissions.",
        acceptanceCriteria: ["Per-branch overrides"],
      });
      const confirmed = await cmd(orgA.adminUser, orgA.orgId, "core.capability.gap.confirm", {
        ticketId: created.id,
        deploymentTarget: "platform_roadmap",
      });
      expect(confirmed.status).toBe("confirmed");

      const e = await cmdFails(orgA.adminUser, orgA.orgId, "core.marketplace.publish", {
        moduleId: "ext-authz",
        name: "Authz Overrides",
        version: "0.1.0",
        summary: "Should not publish",
        category: "security",
        kind: "marketplace_shared",
        gapTicketId: created.id,
      });
      expect(e.message).toContain("platform maintainers");
    });
  });

  describe("schedule processor (worker cadence)", () => {
    it("fires due reminders into notifications and marks them fired", async () => {
      const schedule = createScheduleProcessor(db);
      const [due] = await db
        .insert(schema.reminders)
        .values({
          organizationId: orgA.orgId,
          userId: orgA.operatorUser.id,
          createdBy: orgA.operatorUser.id,
          title: "Past due nudge",
          body: "Do the thing",
          fireAt: new Date(Date.now() - 30_000),
        })
        .returning();

      const fired = await schedule.processDueReminders();
      expect(fired).toBeGreaterThanOrEqual(1);

      const [row] = await db
        .select()
        .from(schema.reminders)
        .where(eq(schema.reminders.id, due!.id));
      expect(row!.status).toBe("fired");
      expect(row!.firedAt).not.toBeNull();

      const notes = await qry(orgA.operatorUser, orgA.orgId, "core.notification.list", {
        unreadOnly: true,
      });
      expect(notes.notifications.some((n: any) => n.title === "Past due nudge")).toBe(true);
    });

    it("claims due follow-ups exactly once", async () => {
      const schedule = createScheduleProcessor(db);
      const [due] = await db
        .insert(schema.followUps)
        .values({
          organizationId: orgA.orgId,
          userId: orgA.operatorUser.id,
          createdBy: orgA.operatorUser.id,
          goal: "Recheck the books",
          fireAt: new Date(Date.now() - 30_000),
        })
        .returning();

      const first = await schedule.claimDueFollowUps();
      expect(first.some((f) => f.id === due!.id)).toBe(true);
      const second = await schedule.claimDueFollowUps();
      expect(second.some((f) => f.id === due!.id)).toBe(false); // idempotent claim

      const [row] = await db
        .select()
        .from(schema.followUps)
        .where(eq(schema.followUps.id, due!.id));
      expect(row!.status).toBe("running");
    });
  });

  // ─── Tenancy / security guards ────────────────────────────────────────

  describe("tenancy & security guards", () => {
    it("assignRole rejects a role from another org", async () => {
      const e = await cmdFails(orgA.adminUser, orgA.orgId, "core.user.assignRole", {
        userId: orgA.operatorUser.id,
        roleId: orgB.adminUser.roleId,
      });
      expect(e.message).toContain("Role not found");
    });

    it("assignRole rejects a user from another org", async () => {
      const e = await cmdFails(orgA.adminUser, orgA.orgId, "core.user.assignRole", {
        userId: orgB.operatorUser.id,
        roleId: orgA.operatorRoleId,
      });
      expect(e.message).toContain("User not found");
    });

    it("removeRole rejects cross-org role/user ids", async () => {
      const e = await cmdFails(orgA.adminUser, orgA.orgId, "core.user.removeRole", {
        userId: orgA.operatorUser.id,
        roleId: orgB.adminUser.roleId,
      });
      expect(e.message).toContain("Role not found");
    });

    it("module install rejects unknown module ids", async () => {
      const e = await cmdFails(orgA.adminUser, orgA.orgId, "core.module.install", {
        moduleId: "not-a-real-module",
      });
      expect(e.message).toContain("Unknown module");
    });

    it("module install accepts a listed module", async () => {
      const result = await cmd(orgA.adminUser, orgA.orgId, "core.module.install", {
        moduleId: "crm",
      });
      expect(result.enabled).toBe(true);
    });

    it("marketplace archive rejects community-published listings", async () => {
      const e = await cmdFails(orgA.adminUser, orgA.orgId, "core.marketplace.archive", {
        moduleId: "community-ext",
        archived: true,
      });
      expect(e.message).toContain("Only platform-owned");
    });

    it("marketplace archive works for platform-owned listings", async () => {
      const result = await cmd(orgA.adminUser, orgA.orgId, "core.marketplace.archive", {
        moduleId: "crm",
        archived: true,
      });
      expect(result.archived).toBe(true);
    });

    it("command catalog advertises the new Horizon A commands", async () => {
      const commandNames = commands.list().map((c) => c.name);
      const queryNames = queries.list().map((q) => q.name);
      for (const expected of [
        "core.branch.create",
        "core.branch.update",
        "core.branch.set_active",
        "core.branch.grant",
        "core.branch.revoke",
        "core.capability.gap.create",
        "core.capability.gap.update",
        "core.capability.gap.confirm",
        "core.notification.mark_read",
        "core.notification.mark_all_read",
        "core.user.invite",
        "core.reminder.set",
        "core.reminder.cancel",
        "core.followup.create",
        "core.followup.cancel",
      ]) {
        expect(commandNames).toContain(expected);
      }
      for (const expected of [
        "core.branch.list",
        "core.capability.gap.list",
        "core.notification.list",
        "core.reminder.list",
        "core.followup.list",
      ]) {
        expect(queryNames).toContain(expected);
      }
    });
  });
});
