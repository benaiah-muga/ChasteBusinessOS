import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { conversationMembers, conversations, createDb, memberships, messages, organizations, users, type Database } from "@chaste/db";
import { purgeTenantFinancials } from "@chaste/db";
import { CapabilityRegistry, KernelExecutor, type LedgerStore, type ActionContext } from "@chaste/kernel";
import { registerMessagingCapabilities, type ModuleDeps } from "./index";

/** Audit sink for executor-run assertions; module tests need no real chain. */
const memoryLedger: LedgerStore = {
  lastHash: async () => null,
  append: async () => 1,
};

/**
 * Messaging lifecycle contract:
 *  - channels rename, archive, restore, and (creator-only) soft-delete
 *  - DMs refuse rename/archive/delete: leaving is the exit
 *  - membership gates every conversation write; addMember only admits
 *    organization members
 *  - messages are edited and deleted by their human sender only; a deleted
 *    message disappears from readMessages (tombstone stays on the row)
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
const creatorId = crypto.randomUUID();
const memberId = crypto.randomUUID();
const outsiderId = crypto.randomUUID();
const orgWideMemberId = crypto.randomUUID();

function ctx(userId: string, permissions: string[]): ActionContext {
  return {
    actor: { type: "human", id: userId, orgId, permissions: new Set(permissions) },
    now: new Date("2026-09-20T00:00:00.000Z"),
    services: {},
  };
}

async function run<I>(id: string, ctxValue: ActionContext, input: I): Promise<unknown> {
  const registry = new CapabilityRegistry();
  registerMessagingCapabilities(registry, deps);
  const executor = new KernelExecutor({ registry, ledger: memoryLedger });
  return executor.execute(id, ctxValue, input);
}

async function makeChannel(title: string, creator: string): Promise<string> {
  const result = (await run("messaging.createConversation", ctx(creator, ["messaging.write"]), {
    title,
    kind: "channel",
    agentEnabled: false,
  })) as { ok: true; data: { conversationId: string } };
  return result.data.conversationId;
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await db.db.insert(organizations).values({ id: orgId, name: "Messaging Lifecycle Probe", slug: `msg-lc-${orgId.slice(0, 8)}` });
  for (const [id, email] of [
    [creatorId, "lifecycle-creator@msg.test"],
    [memberId, "lifecycle-member@msg.test"],
    [outsiderId, "lifecycle-outsider@msg.test"],
    [orgWideMemberId, "lifecycle-colleague@msg.test"],
  ] as const) {
    await db.db.insert(users).values({ id, email, name: email.split("@")[0]! });
  }
  // Organization membership decides who can be added to a channel.
  for (const id of [creatorId, memberId, orgWideMemberId]) {
    await db.db.insert(memberships).values({ orgId, userId: id });
  }
});

afterAll(async () => {
  await purgeTenantFinancials(db.db, orgId);
  await db.db.delete(conversations).where(eq(conversations.orgId, orgId));
  await db.db.delete(users).where(eq(users.id, creatorId));
  await db.db.delete(users).where(eq(users.id, memberId));
  await db.db.delete(users).where(eq(users.id, outsiderId));
  await db.db.delete(users).where(eq(users.id, orgWideMemberId));
  await db.db.delete(organizations).where(eq(organizations.id, orgId));
  await db.client.end();
});

describe("messaging conversation lifecycle", () => {
  it("renames and archives for members; refuses non-members and DMs", async () => {
    const channel = await makeChannel("rename-me", creatorId);

    const renamed = await run("messaging.updateConversation", ctx(creatorId, ["messaging.write"]), {
      conversationId: channel,
      title: "renamed",
    });
    expect(renamed).toMatchObject({ ok: true });

    const outsider = await run("messaging.updateConversation", ctx(outsiderId, ["messaging.write"]), {
      conversationId: channel,
      title: "nope",
    });
    expect(outsider).toMatchObject({ ok: false });

    const archived = await run("messaging.archiveConversation", ctx(creatorId, ["messaging.write"]), {
      conversationId: channel,
      archived: true,
    });
    expect(archived).toMatchObject({ ok: true, data: { archived: true } });

    const restored = await run("messaging.archiveConversation", ctx(creatorId, ["messaging.write"]), {
      conversationId: channel,
      archived: false,
    });
    expect(restored).toMatchObject({ ok: true, data: { archived: false } });
  });

  it("soft-deletes channels, creator only", async () => {
    const channel = await makeChannel("delete-me", creatorId);
    await db.db.insert(conversationMembers).values({ conversationId: channel, userId: memberId });

    const byOther = await run("messaging.deleteConversation", ctx(memberId, ["messaging.write"]), {
      conversationId: channel,
    });
    expect(byOther).toMatchObject({ ok: false });

    const byCreator = await run("messaging.deleteConversation", ctx(creatorId, ["messaging.write"]), {
      conversationId: channel,
    });
    expect(byCreator).toMatchObject({ ok: true, data: { deleted: true } });

    const [row] = await db.db.select().from(conversations).where(eq(conversations.id, channel));
    expect(row?.deletedAt).toBeTruthy();
    const list = await run("messaging.listConversations", ctx(creatorId, ["messaging.read"]), {});
    expect(JSON.stringify(list)).not.toContain("delete-me");
  });

  it("lets members leave and pulls colleagues in, organization members only", async () => {
    const channel = await makeChannel("membership", creatorId);
    await db.db.insert(conversationMembers).values({ conversationId: channel, userId: memberId });

    const notInOrg = await run("messaging.addMember", ctx(creatorId, ["messaging.write"]), {
      conversationId: channel,
      userId: outsiderId,
    });
    expect(notInOrg).toMatchObject({ ok: false });

    const added = await run("messaging.addMember", ctx(creatorId, ["messaging.write"]), {
      conversationId: channel,
      userId: orgWideMemberId,
    });
    expect(added).toMatchObject({ ok: true });

    const left = await run("messaging.leaveConversation", ctx(memberId, ["messaging.write"]), {
      conversationId: channel,
    });
    expect(left).toMatchObject({ ok: true, data: { left: true } });
    const [gone] = await db.db
      .select()
      .from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, channel), eq(conversationMembers.userId, memberId)));
    expect(gone).toBeUndefined();
  });
});

describe("messaging message lifecycle", () => {
  it("edits and tombstone-deletes own messages only, and readers skip deleted ones", async () => {
    const channel = await makeChannel("edits", creatorId);
    const sent = (await run("messaging.sendMessage", ctx(creatorId, ["messaging.write"]), {
      conversationId: channel,
      body: "original wording",
    })) as { ok: true; data: { messageId: string } };
    const messageId = sent.data.messageId;

    // Another member of the same channel cannot edit or delete it.
    await db.db.insert(conversationMembers).values({ conversationId: channel, userId: memberId });
    const foreign = await run("messaging.editMessage", ctx(memberId, ["messaging.write"]), {
      messageId,
      body: "hijacked",
    });
    expect(foreign).toMatchObject({ ok: false });

    const edited = await run("messaging.editMessage", ctx(creatorId, ["messaging.write"]), {
      messageId,
      body: "corrected wording",
    });
    expect(edited).toMatchObject({ ok: true });
    const [row] = await db.db.select().from(messages).where(eq(messages.id, messageId));
    expect(row?.body).toBe("corrected wording");
    expect(row?.editedAt).toBeTruthy();

    const deleted = await run("messaging.deleteMessage", ctx(creatorId, ["messaging.write"]), { messageId });
    expect(deleted).toMatchObject({ ok: true, data: { deleted: true } });

    const read = (await run("messaging.readMessages", ctx(creatorId, ["messaging.read"]), {
      conversationId: channel,
      limit: 30,
    })) as { ok: true; data: { messages: { body: string }[] } };
    expect(read.data.messages).toHaveLength(0);
  });
});
