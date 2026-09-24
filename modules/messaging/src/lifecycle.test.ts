import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  conversationMembers,
  conversationPresence,
  conversations,
  createDb,
  memberships,
  messageAttachments,
  messageReactions,
  messages,
  organizations,
  users,
  type Database,
} from "@chaste/db";
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

    const readDeleted = await run("messaging.readMessages", ctx(creatorId, ["messaging.read"]), {
      conversationId: channel,
      limit: 10,
    });
    expect(readDeleted).toMatchObject({ ok: false });

    const sendDeleted = await run("messaging.sendMessage", ctx(creatorId, ["messaging.write"]), {
      conversationId: channel,
      body: "should be refused",
    });
    expect(sendDeleted).toMatchObject({ ok: false });
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

describe("messaging collaboration features", () => {
  it("stores read cursors, replies, reactions, pins, presence, and private attachments", async () => {
    const channel = await makeChannel("collaboration-features", creatorId);
    await db.db.insert(conversationMembers).values({ conversationId: channel, userId: memberId });

    const people = await run("messaging.listPeople", ctx(memberId, ["messaging.read"]), {
      query: "lifecycle-creator",
      limit: 30,
    }) as { ok: true; data: { people: { type: string; id: string }[] } };
    expect(people.data.people).toContainEqual({ type: "user", id: creatorId, name: "lifecycle-creator" });
    expect(people.data.people.some((person) => person.id === outsiderId)).toBe(false);

    const root = (await run("messaging.sendMessage", ctx(creatorId, ["messaging.write"]), {
      conversationId: channel,
      body: "A searchable parent message",
    })) as { ok: true; data: { messageId: string } };
    const reply = await run("messaging.sendMessage", ctx(memberId, ["messaging.write"]), {
      conversationId: channel,
      body: "A threaded reply",
      parentMessageId: root.data.messageId,
    });
    expect(reply).toMatchObject({ ok: true });
    const [replyRow] = await db.db.select().from(messages).where(eq(messages.parentMessageId, root.data.messageId));
    expect(replyRow?.body).toBe("A threaded reply");

    const marked = await run("messaging.advanceReadCursor", ctx(memberId, ["messaging.write"]), { conversationId: channel });
    expect(marked).toMatchObject({ ok: true });
    const [member] = await db.db
      .select({ lastReadAt: conversationMembers.lastReadAt })
      .from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, channel), eq(conversationMembers.userId, memberId)));
    expect(member?.lastReadAt).toBeInstanceOf(Date);

    const reacted = await run("messaging.setMessageReaction", ctx(memberId, ["messaging.write"]), {
      messageId: root.data.messageId,
      emoji: "👍",
      active: true,
    });
    expect(reacted).toMatchObject({ ok: true });
    const [reaction] = await db.db
      .select()
      .from(messageReactions)
      .where(and(eq(messageReactions.messageId, root.data.messageId), eq(messageReactions.userId, memberId)));
    expect(reaction?.emoji).toBe("👍");

    const pinned = await run("messaging.setMessagePin", ctx(creatorId, ["messaging.write"]), {
      messageId: root.data.messageId,
      pinned: true,
    });
    expect(pinned).toMatchObject({ ok: true });
    const [pinnedMessage] = await db.db.select().from(messages).where(eq(messages.id, root.data.messageId));
    expect(pinnedMessage?.pinnedAt).toBeInstanceOf(Date);

    const presence = await run("messaging.updateConversationPresence", ctx(memberId, ["messaging.write"]), {
      conversationId: channel,
      typing: true,
    });
    expect(presence).toMatchObject({ ok: true });
    const [status] = await db.db
      .select()
      .from(conversationPresence)
      .where(and(eq(conversationPresence.conversationId, channel), eq(conversationPresence.userId, memberId)));
    expect(status?.typingUntil).toBeInstanceOf(Date);

    const upload = (await run("messaging.uploadMessageAttachment", ctx(creatorId, ["messaging.write"]), {
      conversationId: channel,
      filename: "brief.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.from("hello from a private attachment").toString("base64"),
    })) as { ok: true; data: { attachmentId: string } };
    const sentWithFile = await run("messaging.sendMessage", ctx(creatorId, ["messaging.write"]), {
      conversationId: channel,
      body: "",
      attachmentIds: [upload.data.attachmentId],
    });
    expect(sentWithFile).toMatchObject({ ok: true });
    const [attachment] = await db.db
      .select()
      .from(messageAttachments)
      .where(eq(messageAttachments.id, upload.data.attachmentId));
    expect(attachment?.messageId).toBeTruthy();
    expect(attachment?.content.toString()).toBe("hello from a private attachment");
  });

  it("rejects a non-member's private attachment upload and reaction", async () => {
    const channel = await makeChannel("private-features", creatorId);
    const sent = (await run("messaging.sendMessage", ctx(creatorId, ["messaging.write"]), {
      conversationId: channel,
      body: "Member only",
    })) as { ok: true; data: { messageId: string } };
    const upload = await run("messaging.uploadMessageAttachment", ctx(outsiderId, ["messaging.write"]), {
      conversationId: channel,
      filename: "private.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.from("no").toString("base64"),
    });
    const reaction = await run("messaging.setMessageReaction", ctx(outsiderId, ["messaging.write"]), {
      messageId: sent.data.messageId,
      emoji: "👀",
      active: true,
    });
    expect(upload).toMatchObject({ ok: false });
    expect(reaction).toMatchObject({ ok: false });
  });
});
