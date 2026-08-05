/**
 * Messaging module contract tests: thread lifecycle, permissions, tenancy,
 * read cursors, and cross-org guards (spec: messaging-and-buzz.md).
 *
 * Guarded by DATABASE_URL, mirroring the platform module e2e tests.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createCommandRegistry,
  createQueryRegistry,
  createRequestContext,
  executeCommand,
  executeQuery,
  InMemoryAuditWriter,
  InMemoryOutboxWriter,
  type CommandRegistry,
  type QueryRegistry,
} from "@chaste/kernel";
import {
  createDb,
  runMigrations,
  schema,
  cleanupTestData,
  type Db,
} from "@chaste/db";
import { eq } from "drizzle-orm";
import { createMessagingModule } from "./index.js";

const hasDb = Boolean(process.env.DATABASE_URL);
const DB_URL = process.env.DATABASE_URL!;

const THREAD_READ = "messaging.thread.read";
const THREAD_WRITE = "messaging.thread.write";
const GROUP_CREATE = "messaging.group.create";
const GROUP_MANAGE = "messaging.group.manage";

let db: Db;
let commands: CommandRegistry;
let queries: QueryRegistry;
let audit: InMemoryAuditWriter;
let outbox: InMemoryOutboxWriter;

interface TUser {
  id: string;
  orgId: string;
  email: string;
  displayName: string;
  permissions: string[];
}

function ctxFor(user: TUser) {
  return createRequestContext({
    actor: {
      kind: "user" as const,
      userId: user.id,
      organizationId: user.orgId,
      displayName: user.displayName,
      permissions: new Set(user.permissions),
    },
  });
}

async function cmd(user: TUser, name: string, input: unknown) {
  const result = await executeCommand(commands, name, input, ctxFor(user), { audit, outbox });
  return result.data as any;
}

async function qry(user: TUser, name: string, input: unknown = {}) {
  const result = await executeQuery(queries, name, input, ctxFor(user));
  return result.data as any;
}

async function cmdFails(user: TUser, name: string, input: unknown) {
  try {
    await executeCommand(commands, name, input, ctxFor(user), { audit, outbox });
    throw new Error("expected to throw");
  } catch (e: any) {
    return e;
  }
}

async function qryFails(user: TUser, name: string, input: unknown = {}) {
  try {
    await executeQuery(queries, name, input, ctxFor(user));
    throw new Error("expected to throw");
  } catch (e: any) {
    return e;
  }
}

async function seedUser(orgId: string, email: string, displayName: string, permissions: string[]): Promise<TUser> {
  const [row] = await db
    .insert(schema.users)
    .values({ organizationId: orgId, email, displayName })
    .returning();
  return { id: row!.id, orgId, email, displayName, permissions };
}

describe.skipIf(!hasDb)("Messaging module E2E", () => {
  let alice: TUser;
  let bob: TUser;
  let carol: TUser;
  let stranger: TUser;

  beforeAll(async () => {
    db = createDb(DB_URL);
    await runMigrations(DB_URL);
    await cleanupTestData(db);

    commands = createCommandRegistry();
    queries = createQueryRegistry();
    audit = new InMemoryAuditWriter();
    outbox = new InMemoryOutboxWriter();

    const [orgA] = await db.insert(schema.organizations).values({ name: "Messaging A", autonomy: "confirm", region: "local" }).returning();
    const [orgB] = await db.insert(schema.organizations).values({ name: "Messaging B", autonomy: "confirm", region: "local" }).returning();

    alice = await seedUser(orgA!.id, "alice@a.com", "Alice", [THREAD_READ, THREAD_WRITE, GROUP_CREATE, GROUP_MANAGE]);
    bob = await seedUser(orgA!.id, "bob@a.com", "Bob", [THREAD_READ, THREAD_WRITE, GROUP_CREATE, GROUP_MANAGE]);
    carol = await seedUser(orgA!.id, "carol@a.com", "Carol", [THREAD_READ, THREAD_WRITE]);
    stranger = await seedUser(orgB!.id, "eve@b.com", "Eve", [THREAD_READ, THREAD_WRITE, GROUP_CREATE]);

    const messaging = createMessagingModule(db);
    messaging.register({ commands, queries });
  });

  afterAll(async () => {
    await cleanupTestData(db);
  });

  it("advertises commands and queries", () => {
    const cmdNames = commands.list().map((c) => c.name);
    const qryNames = queries.list().map((q) => q.name);
    for (const name of [
      "messaging.thread.create",
      "messaging.thread.send",
      "messaging.thread.add_member",
      "messaging.thread.remove_member",
      "messaging.thread.leave",
      "messaging.thread.rename",
      "messaging.thread.archive",
      "messaging.thread.mark_read",
    ]) {
      expect(cmdNames).toContain(name);
    }
    for (const name of ["messaging.thread.list", "messaging.thread.get", "messaging.unread.count"]) {
      expect(qryNames).toContain(name);
    }
  });

  it("creates a direct thread deterministically and dedupes", async () => {
    const a = await cmd(alice, "messaging.thread.create", { kind: "direct", memberIds: [bob.id] });
    expect(a.type).toBe("direct");
    expect(a.members.map((m: any) => m.userId).sort()).toEqual([alice.id, bob.id].sort());

    const again = await cmd(alice, "messaging.thread.create", { kind: "direct", memberIds: [bob.id] });
    expect(again.id).toBe(a.id);
  });

  it("requires a direct thread to have exactly one other member", async () => {
    const e = await cmdFails(alice, "messaging.thread.create", { kind: "direct", memberIds: [] });
    expect(e.code).toBe("VALIDATION_ERROR");
  });

  it("requires group.create permission for groups", async () => {
    const e = await cmdFails(carol, "messaging.thread.create", {
      kind: "group",
      name: "Ops",
      memberIds: [bob.id],
    });
    expect(e.code).toBe("PERMISSION_DENIED");
  });

  it("allows group.create, adds members, and reflects membership", async () => {
    const g = await cmd(alice, "messaging.thread.create", { kind: "group", name: "Marketing", memberIds: [bob.id] });
    expect(g.type).toBe("group");
    expect(g.members.map((m: any) => m.userId)).toContain(alice.id);
    expect(g.members.map((m: any) => m.userId)).toContain(bob.id);

    const updated = await cmd(alice, "messaging.thread.add_member", { threadId: g.id, userId: carol.id });
    expect(updated.members.map((m: any) => m.userId)).toContain(carol.id);
  });

  it("rejects cross-org members", async () => {
    const e = await cmdFails(alice, "messaging.thread.add_member", { threadId: (await cmd(alice, "messaging.thread.create", { kind: "group", name: "Secure", memberIds: [bob.id] })).id, userId: stranger.id });
    expect(e.code).toBe("VALIDATION_ERROR");
  });

  it("sends a message, notifies the other member, and marks the sender read", async () => {
    const t = await cmd(alice, "messaging.thread.create", { kind: "direct", memberIds: [bob.id] });
    const msg = await cmd(alice, "messaging.thread.send", { threadId: t.id, body: "Hello Bob" });
    expect(msg.body).toBe("Hello Bob");

    // Sender read cursor advanced.
    const countA = await qry(alice, "messaging.unread.count");
    expect(countA.unread).toBe(0);

    // Bob has an unread message + an in-app notification.
    const countB = await qry(bob, "messaging.unread.count");
    expect(countB.unread).toBe(1);
    const notis = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, bob.id));
    expect(notis.some((n) => n.kind === "message")).toBe(true);

    // Outbox event surfaces to the bus.
    expect(outbox.events.some((e) => e.type === "messaging.message.sent")).toBe(true);
  });

  it("prevents non-members from reading or sending", async () => {
    const t = await cmd(alice, "messaging.thread.create", { kind: "direct", memberIds: [bob.id] });
    const listErr = await qryFails(carol, "messaging.thread.get", { threadId: t.id });
    expect(listErr.code).toBe("PERMISSION_DENIED");
    const sendErr = await cmdFails(carol, "messaging.thread.send", { threadId: t.id, body: "nope" });
    expect(sendErr.code).toBe("PERMISSION_DENIED");
  });

  it("scopes threads by organization", async () => {
    // Eve (org B) cannot read a thread even with full perms.
    const t = await cmd(alice, "messaging.thread.create", { kind: "direct", memberIds: [bob.id] });
    const e = await qryFails(stranger, "messaging.thread.get", { threadId: t.id });
    expect(e.code).toBe("NOT_FOUND"); // no existence leak to other orgs
    expect(await qry(stranger, "messaging.unread.count")).toEqual({ unread: 0 });
  });

  it("mark_read resets the unread count for that thread", async () => {
    const t = await cmd(alice, "messaging.thread.create", { kind: "direct", memberIds: [bob.id] });
    const listFor = async () => {
      const list = await qry(bob, "messaging.thread.list");
      return (list.items as any[]).find((i: any) => i.id === t.id);
    };
    const before = (await listFor())!.unreadCount;
    await cmd(alice, "messaging.thread.send", { threadId: t.id, body: "second wave" });
    expect((await listFor())!.unreadCount).toBe(before + 1);
    const getB = await qry(bob, "messaging.thread.get", { threadId: t.id });
    const lastId = getB.messages[getB.messages.length - 1].id;
    await cmd(bob, "messaging.thread.mark_read", { threadId: t.id, lastReadMessageId: lastId });
    expect((await listFor())!.unreadCount).toBe(0);
  });

  it("lists threads with previews and unread counts", async () => {
    const list = await qry(bob, "messaging.thread.list");
    const items = list.items as any[];
    expect(items.length).toBeGreaterThan(0);
    const withPreview = items.find((i) => i.lastMessageBody !== null);
    expect(withPreview).toBeTruthy();
    expect(typeof withPreview!.unreadCount).toBe("number");
    expect(Array.isArray(withPreview!.otherMemberNames)).toBe(true);
  });

  it("supports leave, rename, and archive", async () => {
    const g = await cmd(alice, "messaging.thread.create", { kind: "group", name: "Project", memberIds: [bob.id, carol.id] });
    const renamed = await cmd(alice, "messaging.thread.rename", { threadId: g.id, name: "Project Alpha" });
    expect(renamed.name).toBe("Project Alpha");

    // Carol leaves.
    await cmd(carol, "messaging.thread.leave", { threadId: g.id });
    const listErr = await qryFails(carol, "messaging.thread.get", { threadId: g.id });
    expect(listErr.code).toBe("PERMISSION_DENIED");

    // Alice archives; it disappears from her default list but shows with includeArchived.
    await cmd(alice, "messaging.thread.archive", { threadId: g.id, archived: true });
    const list = await qry(alice, "messaging.thread.list");
    expect((list.items as any[]).some((i) => i.id === g.id)).toBe(false);
    const arch = await qry(alice, "messaging.thread.list", { includeArchived: true });
    expect((arch.items as any[]).some((i) => i.id === g.id)).toBe(true);
  });

  it("writes audit entries for commands", async () => {
    audit.entries = [];
    const t = await cmd(alice, "messaging.thread.create", { kind: "direct", memberIds: [bob.id] });
    await cmd(alice, "messaging.thread.send", { threadId: t.id, body: "audited" });
    const sent = audit.entries.filter((e) => e.action === "messaging.thread.send");
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((e) => e.success)).toBe(true);
  });
});