/**
 * Backup / export / restore E2E (Workstream C): enqueue, worker flush to the
 * object store (encrypted), list, restore, and org-scoping guards.
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
import { createDb, runMigrations, schema, cleanupTestData, type Db } from "@chaste/db";
import { eq } from "drizzle-orm";
import { createPlatformModule } from "@chaste/module-platform";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hasDb = Boolean(process.env.DATABASE_URL);
const DB_URL = process.env.DATABASE_URL!;

let db: ReturnType<typeof createDb>;
let commands: CommandRegistry;
let queries: QueryRegistry;
let backupDir: string;
let orgA: { orgId: string; admin: User }; 
let orgB: { orgId: string; admin: User };

const BACKUP_PERMS = ["core.backup.read", "core.backup.manage"];
const KEY = "f".repeat(64);

type User = { id: string; email: string; displayName: string; permissions: string[] };

function ctxFor(user: User, orgId: string) {
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

async function cmd(user: User, orgId: string, name: string, input: unknown) {
  const result = await executeCommand(commands, name, input, ctxFor(user, orgId), {
    audit: new InMemoryAuditWriter(),
    outbox: new InMemoryOutboxWriter(),
  });
  return result.data;
}

async function qry(user: User, orgId: string, name: string, input: unknown = {}) {
  const result = await executeQuery(queries, name, input, ctxFor(user, orgId));
  return result.data;
}

async function cmdFails(user: User, orgId: string, name: string, input: unknown): Promise<any> {
  try {
    await cmd(user, orgId, name, input);
    expect.fail("Should have thrown");
  } catch (e: any) {
    return e;
  }
}

async function makeOrg(name: string, email: string): Promise<{ orgId: string; admin: User }> {
  const [org] = await db.insert(schema.organizations).values({ name, autonomy: "confirm", region: "local" }).returning();
  const [admin] = await db.insert(schema.users).values({ organizationId: org!.id, email, displayName: name }).returning();
  const [role] = await db.insert(schema.roles).values({ organizationId: org!.id, key: "admin", name: "Administrator", isSystem: true }).returning();
  for (const perm of BACKUP_PERMS) {
    await db.insert(schema.rolePermissions).values({ roleId: role!.id, permission: perm });
  }
  await db.insert(schema.userRoles).values({ userId: admin!.id, roleId: role!.id });
  return { orgId: org!.id, admin: { id: admin!.id, email: admin!.email, displayName: name, permissions: BACKUP_PERMS } };
}

describe.skipIf(!hasDb)("Backup / export / restore E2E", () => {
  beforeAll(async () => {
    process.env.CHASTE_BACKUP_KEY = KEY;
    backupDir = await mkdtemp(join(tmpdir(), "chaste-backups-"));
    process.env.CHASTE_BACKUP_DIR = backupDir;

    db = createDb(DB_URL);
    await runMigrations(DB_URL);
    await cleanupTestData(db);

    commands = createCommandRegistry();
    queries = createQueryRegistry();
    const modules = createModuleRegistry();
    const platform = createPlatformModule(db, modules, { allowFullAutonomous: true, regions: ["local"] });
    platform.register({ commands, queries });

    orgA = await makeOrg("Backup Test A", "badmin-a@test.com");
    orgB = await makeOrg("Backup Test B", "badmin-b@test.com");
  });

  afterAll(async () => {
    if (db) {
      await cleanupTestData(db);
      await db.$client.end({ timeout: 5 });
    }
    delete process.env.CHASTE_BACKUP_KEY;
    delete process.env.CHASTE_BACKUP_DIR;
  });

  it("core.backup.provider.status reports the object store without secrets", async () => {
    const status = await qry(orgA.admin, orgA.orgId, "core.backup.provider.status");
    expect(status.provider).toBe("local");
    expect(status.encryptionConfigured).toBe(true);
    expect(JSON.stringify(status)).not.toMatch(/CHASTE_|API_KEY|SECRET/);
  });

  it("core.backup.create enqueues a queued job and lists it", async () => {
    const created = await cmd(orgA.admin, orgA.orgId, "core.backup.create", {});
    expect(created.status).toBe("queued");

    const list = await qry(orgA.admin, orgA.orgId, "core.backup.list");
    expect(list.backups.some((b: any) => b.id === created.id)).toBe(true);
  });

  it("worker flush snapshots, encrypts, and stores the backup", async () => {
    const { createBackupProcessor } = await import("@chaste/module-platform");
    const processor = createBackupProcessor(db);
    const done = await processor.flushBackupJobs();
    expect(done).toBeGreaterThanOrEqual(1);

    const list = await qry(orgA.admin, orgA.orgId, "core.backup.list");
    const row = list.backups.find((b: any) => b.status === "success");
    expect(row).toBeTruthy();
    expect(row.storageKey).toContain("json.enc");
    expect(row.sizeBytes).toBeGreaterThan(0);
    expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(row.provider).toBe("local");
  });

  it("stored payload is encrypted (ciphertext, not JSON manifest)", async () => {
    const { readFile } = await import("node:fs/promises");
    const list = await qry(orgA.admin, orgA.orgId, "core.backup.list");
    const row = list.backups.find((b: any) => b.status === "success");
    const file = join(backupDir, row.storageKey.replace(/\//g, "/"));
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.alg).toBe("aes-256-gcm");
    expect(parsed.ct).toBeTruthy();
    expect(JSON.stringify(parsed)).not.toContain("chaste-backup.v1");
  });

  it("core.backup.restore re-inserts rows deleted after the snapshot", async () => {
    // Seed data BEFORE the snapshot so the manifest definitely has it.
    const [note] = await db
      .insert(schema.notifications)
      .values({ organizationId: orgA.orgId, userId: orgA.admin.id, kind: "info", title: "Restore me" })
      .returning();
    expect(note).toBeTruthy();

    const created = await cmd(orgA.admin, orgA.orgId, "core.backup.create", {});
    const { createBackupProcessor } = await import("@chaste/module-platform");
    await createBackupProcessor(db).flushBackupJobs();

    // Wipe every notification for the org, then prove restore brings it back.
    await db.delete(schema.notifications).where(eq(schema.notifications.organizationId, orgA.orgId));

    const result = await cmd(orgA.admin, orgA.orgId, "core.backup.restore", { backupId: created.id });
    expect(result.organizationId).toBe(orgA.orgId);
    expect(result.restoredTables).toBeGreaterThan(0);
    expect(result.rowCount).toBeGreaterThan(0);

    const [restored] = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.organizationId, orgA.orgId))
      .limit(1);
    expect(restored).toBeTruthy();
    expect(restored!.title).toBe("Restore me");
  });

  it("backup list and restore are org-scoped", async () => {
    const list = await qry(orgB.admin, orgB.orgId, "core.backup.list");
    expect(list.backups.length).toBe(0);

    const created = await cmd(orgA.admin, orgA.orgId, "core.backup.create", {});
    const e = await cmdFails(orgB.admin, orgB.orgId, "core.backup.restore", { backupId: created.id });
    expect(e.code).toBe("NOT_FOUND");
  });

  it("permission-less users cannot create backups", async () => {
    const stranger = { id: "00000000-0000-0000-0000-000000000001", email: "x@test.com", displayName: "X", permissions: [] };
    await expect(
      cmd(stranger, orgA.orgId, "core.backup.create", {}),
    ).rejects.toThrow();
  });
});
