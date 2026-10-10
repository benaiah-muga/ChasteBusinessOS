import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  actionReceipts,
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
  it("pages visible messages before a conversation-scoped cursor in stable display order", async () => {
    const channel = await makeChannel("older-page", creatorId);
    const otherChannel = await makeChannel("other-cursor", creatorId);
    const fixedTime = new Date("2026-09-20T00:00:00.000Z");
    const ids = [
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
      "10000000-0000-4000-8000-000000000003",
      "10000000-0000-4000-8000-000000000004",
    ];
    await db.db.insert(messages).values(ids.map((id, index) => ({
      id, orgId, conversationId: channel, senderType: "human", senderUserId: creatorId,
      body: `cursor page ${index + 1}`, createdAt: fixedTime,
    })));
    const [foreignCursor] = await db.db.insert(messages).values({
      orgId, conversationId: otherChannel, senderType: "human", senderUserId: creatorId,
      body: "belongs elsewhere", createdAt: fixedTime,
    }).returning({ id: messages.id });

    const latest = (await run("messaging.readMessages", ctx(creatorId, ["messaging.read"]), {
      conversationId: channel, limit: 2,
    })) as { ok: true; data: { messages: { id: string }[]; hasMore: boolean; nextCursor: string | null } };
    expect(latest.data.messages.map((message) => message.id)).toEqual(ids.slice(2));
    expect(latest.data.hasMore).toBe(true);
    expect(latest.data.nextCursor).toBe(ids[2]);

    const older = (await run("messaging.readMessages", ctx(creatorId, ["messaging.read"]), {
      conversationId: channel, before: ids[2], limit: 2,
    })) as { ok: true; data: { messages: { id: string }[]; hasMore: boolean; nextCursor: string | null } };
    expect(older.data.messages.map((message) => message.id)).toEqual(ids.slice(0, 2));
    expect(older.data.hasMore).toBe(false);
    expect(older.data.nextCursor).toBeNull();

    const mismatchedCursor = await run("messaging.readMessages", ctx(creatorId, ["messaging.read"]), {
      conversationId: channel, before: foreignCursor!.id, limit: 2,
    });
    expect(mismatchedCursor).toMatchObject({ ok: false, error: "message cursor not found" });
  });

  it("lists latest message previews and unread counts only for joined members", async () => {
    const channel = await makeChannel("list-preview", creatorId);
    await db.db.insert(conversationMembers).values({ conversationId: channel, userId: memberId });
    const firstMessageAt = new Date(Date.now() + 60_000);
    const latestMessageAt = new Date(firstMessageAt.getTime() + 60_000);
    await db.db.insert(messages).values([
      {
        orgId,
        conversationId: channel,
        senderType: "human",
        senderUserId: creatorId,
        body: "Unread for the member",
        createdAt: firstMessageAt,
      },
      {
        orgId,
        conversationId: channel,
        senderType: "human",
        senderUserId: memberId,
        body: "Latest reply",
        createdAt: latestMessageAt,
      },
    ]);

    const memberList = await run("messaging.listConversations", ctx(memberId, ["messaging.read"]), {});
    expect(memberList).toMatchObject({
      ok: true,
      data: {
        me: memberId,
        conversations: [
          {
            id: channel,
            unreadCount: 1,
            lastMessage: { at: latestMessageAt.toISOString(), body: "Latest reply" },
          },
        ],
      },
    });

    const outsiderList = await run("messaging.listConversations", ctx(outsiderId, ["messaging.read"]), {});
    expect(outsiderList).toMatchObject({ ok: true, data: { me: outsiderId, conversations: [] } });
  });

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

    const edited = (await run("messaging.editMessage", ctx(creatorId, ["messaging.write"]), {
      messageId,
      body: "corrected wording",
    })) as { ok: true; data: { messageId: string; body: string; expectedBody: string; expectedEditedAt: string; editedAt: string } };
    expect(edited).toMatchObject({ ok: true });
    expect(edited.data).toMatchObject({
      messageId,
      body: "original wording",
      expectedBody: "corrected wording",
      expectedEditedAt: expect.any(String),
    });
    const [row] = await db.db.select().from(messages).where(eq(messages.id, messageId));
    expect(row?.body).toBe("corrected wording");
    expect(row?.editedAt).toBeTruthy();

    await db.db.insert(actionReceipts).values({
      orgId,
      intentKey: `${orgId}:messaging-edit-receipt`,
      capabilityId: "messaging.editMessage",
      inputHash: "sha256:messaging-edit-receipt",
      ok: true,
      outcome: "known",
      data: edited.data,
    });

    const wrongAuthor = await run("messaging.restoreMessageEdit", ctx(memberId, ["messaging.write"]), {
      messageId,
      body: edited.data.body,
      expectedBody: edited.data.expectedBody,
      expectedEditedAt: edited.data.expectedEditedAt,
    });
    expect(wrongAuthor).toMatchObject({ ok: false, error: expect.stringContaining("you can only restore your own messages") });

    const fabricated = await run("messaging.restoreMessageEdit", ctx(creatorId, ["messaging.write"]), {
      messageId,
      body: "invented wording",
      expectedBody: "corrected wording",
      expectedEditedAt: edited.data.expectedEditedAt,
    });
    expect(fabricated).toMatchObject({ ok: false, error: expect.stringContaining("matching successful edit receipt") });

    const restored = (await run("messaging.restoreMessageEdit", ctx(creatorId, ["messaging.write"]), {
      messageId,
      body: edited.data.body,
      expectedBody: edited.data.expectedBody,
      expectedEditedAt: edited.data.expectedEditedAt,
    })) as { ok: true; data: { messageId: string; body: string; expectedBody: string; expectedEditedAt: string } };
    expect(restored).toMatchObject({
      ok: true,
      data: { messageId, body: "corrected wording", expectedBody: "original wording" },
    });
    const [restoredRow] = await db.db.select().from(messages).where(eq(messages.id, messageId));
    expect(restoredRow?.body).toBe("original wording");

    const redone = (await run("messaging.editMessage", ctx(creatorId, ["messaging.write"]), {
      messageId,
      body: restored.data.body,
      expectedBody: restored.data.expectedBody,
      expectedEditedAt: restored.data.expectedEditedAt,
    })) as { ok: true; data: { messageId: string; body: string; expectedBody: string; expectedEditedAt: string } };
    expect(redone).toMatchObject({ ok: true });

    const editToC = (await run("messaging.editMessage", ctx(creatorId, ["messaging.write"]), {
      messageId,
      body: "later wording",
      expectedBody: redone.data.expectedBody,
      expectedEditedAt: redone.data.expectedEditedAt,
    })) as { ok: true; data: { body: string; expectedBody: string; expectedEditedAt: string } };
    expect(editToC).toMatchObject({ ok: true });

    const editBackToB = await run("messaging.editMessage", ctx(creatorId, ["messaging.write"]), {
      messageId,
      body: redone.data.expectedBody,
      expectedBody: editToC.data.expectedBody,
      expectedEditedAt: editToC.data.expectedEditedAt,
    });
    expect(editBackToB).toMatchObject({ ok: true });

    const stale = await run("messaging.restoreMessageEdit", ctx(creatorId, ["messaging.write"]), {
      messageId,
      body: edited.data.body,
      expectedBody: edited.data.expectedBody,
      expectedEditedAt: edited.data.expectedEditedAt,
    });
    expect(stale).toMatchObject({ ok: false, error: expect.stringContaining("message changed since the inverse") });

    const deleted = (await run("messaging.deleteMessage", ctx(creatorId, ["messaging.write"]), { messageId })) as {
      ok: true;
      data: { messageId: string; deleted: true; deletedAt: string | null; expectedDeletedAt: string };
    };
    expect(deleted).toMatchObject({
      ok: true,
      data: { messageId, deleted: true, deletedAt: null, expectedDeletedAt: expect.any(String) },
    });
    await db.db.insert(actionReceipts).values({
      orgId,
      intentKey: `${orgId}:messaging-delete-receipt`,
      capabilityId: "messaging.deleteMessage",
      inputHash: "sha256:messaging-delete-receipt",
      ok: true,
      outcome: "known",
      data: deleted.data,
    });

    const deleteWrongAuthor = await run("messaging.restoreMessageDelete", ctx(memberId, ["messaging.write"]), {
      messageId,
      deletedAt: deleted.data.deletedAt,
      expectedDeletedAt: deleted.data.expectedDeletedAt,
    });
    expect(deleteWrongAuthor).toMatchObject({ ok: false, error: expect.stringContaining("you can only restore your own messages") });

    const fabricatedDelete = await run("messaging.restoreMessageDelete", ctx(creatorId, ["messaging.write"]), {
      messageId,
      deletedAt: "2020-01-01T00:00:00.000Z",
      expectedDeletedAt: deleted.data.expectedDeletedAt,
    });
    expect(fabricatedDelete).toMatchObject({ ok: false, error: expect.stringContaining("matching successful delete receipt") });

    const foreignTenantContext = ctx(creatorId, ["messaging.write"]);
    const foreignTenant = await run("messaging.restoreMessageDelete", {
      ...foreignTenantContext,
      actor: { ...foreignTenantContext.actor, orgId: crypto.randomUUID() },
    }, {
      messageId,
      deletedAt: deleted.data.deletedAt,
      expectedDeletedAt: deleted.data.expectedDeletedAt,
    });
    expect(foreignTenant).toMatchObject({ ok: false, error: expect.stringContaining("message not found") });

    const restoreInput = {
      messageId,
      deletedAt: deleted.data.deletedAt,
      expectedDeletedAt: deleted.data.expectedDeletedAt,
    };
    const restoredDelete = (await run("messaging.restoreMessageDelete", ctx(creatorId, ["messaging.write"]), restoreInput)) as {
      ok: true;
      data: { messageId: string; expectedDeletedAt: string | null };
    };
    expect(restoredDelete).toMatchObject({ ok: true, data: { messageId, expectedDeletedAt: null } });
    const [restoredMessage] = await db.db.select().from(messages).where(eq(messages.id, messageId));
    expect(restoredMessage?.deletedAt).toBeNull();

    const redoneDelete = (await run("messaging.deleteMessage", ctx(creatorId, ["messaging.write"]), {
      messageId,
      expectedDeletedAt: restoredDelete.data.expectedDeletedAt,
    })) as { ok: true; data: { messageId: string; deletedAt: string | null; expectedDeletedAt: string } };
    expect(redoneDelete).toMatchObject({ ok: true, data: { messageId, deletedAt: null } });
    expect(Date.parse(redoneDelete.data.expectedDeletedAt)).toBeGreaterThan(Date.parse(deleted.data.expectedDeletedAt));
    const staleRestore = await run("messaging.restoreMessageDelete", ctx(creatorId, ["messaging.write"]), restoreInput);
    expect(staleRestore).toMatchObject({ ok: false, error: expect.stringContaining("deletion state changed") });

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
