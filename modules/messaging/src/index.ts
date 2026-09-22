import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { conversationMembers, conversations, memberships, messages, notifications, users, withOrgContext } from "@chaste/db";
import type { Database } from "@chaste/db";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";

export interface ModuleDeps {
  db: Database["db"];
}

type Tx = Parameters<Parameters<ModuleDeps["db"]["transaction"]>[0]>[0];

/** A person or the agent that can be @mentioned in a message. */
const mentionSchema = z.object({
  type: z.enum(["user", "agent"]),
  id: z.string().min(1).max(80),
});

/**
 * Org scope alone does not confer access: DMs are membership-scoped. Every
 * read and write resolves the actor (human principal or the agent acting for
 * one) against conversation_members first.
 */
async function isMember(tx: Tx | ModuleDeps["db"], conversationId: string, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const [member] = await tx
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    )
    .limit(1);
  return Boolean(member);
}

const sendMessage = (deps: ModuleDeps) =>
  defineCapability({
    id: "messaging.sendMessage",
    title: "Send internal message",
    intent:
      "Post a message into an internal team conversation (channel or DM), optionally @mentioning colleagues or the agent so they are notified. Use to keep colleagues informed or answer them in threads",
    module: "messaging",
    risk: "write",
    permission: "messaging.write",
    input: z.object({
      conversationId: z.string(),
      body: z.string().min(1).max(8000),
      mentions: z.array(mentionSchema).max(20).optional(),
    }),
    output: z.object({ messageId: z.string() }),
    execute: async (ctx, input) => {
      const [conv] = await deps.db
        .select({ id: conversations.id, title: conversations.title })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, input.conversationId),
            eq(conversations.orgId, ctx.actor.orgId),
            isNull(conversations.deletedAt),
          ),
        )
        .limit(1);
      if (!conv) throw new Error("conversation not found");
      if (!(await isMember(deps.db, conv.id, ctx.actor.id))) {
        throw new Error("you are not a member of this conversation");
      }
      const [row] = await deps.db
        .insert(messages)
        .values({
          orgId: ctx.actor.orgId,
          conversationId: input.conversationId,
          senderType: ctx.actor.type === "agent" ? "agent" : "human",
          senderUserId: ctx.actor.type === "human" ? ctx.actor.id : null,
          body: input.body,
          mentions: input.mentions?.length ? input.mentions : null,
        })
        .returning({ id: messages.id });

      // Mentioned humans hear about it through the notification bell; agent
      // mentions need no row - the mention itself pulls the agent in.
      if (input.mentions?.length && ctx.actor.type === "human") {
        const [sender] = await deps.db
          .select({ name: users.name, email: users.email })
          .from(users)
          .where(eq(users.id, ctx.actor.id ?? ""))
          .limit(1);
        const senderLabel = sender?.name ?? sender?.email ?? "A colleague";
        const conversationMemberRows = await deps.db
          .select({ userId: conversationMembers.userId })
          .from(conversationMembers)
          .where(eq(conversationMembers.conversationId, conv.id));
        const memberIds = new Set(conversationMemberRows.map((member) => member.userId));
        const mentionedUsers = input.mentions.filter(
          (m) => m.type === "user" && m.id !== ctx.actor.id && memberIds.has(m.id),
        );
        for (const m of mentionedUsers) {
          await deps.db.insert(notifications).values({
            orgId: ctx.actor.orgId,
            userId: m.id,
            kind: "mention",
            title: `${senderLabel} mentioned you in ${conv.title}`,
            body: input.body.slice(0, 200),
            href: "/messages",
          });
        }
      }
      return { messageId: row!.id };
    },
  });

const listConversations = (deps: ModuleDeps) =>
  defineCapability({
    id: "messaging.listConversations",
    title: "List conversations",
    intent: "List internal channels and DMs with their latest activity, so you can find where to post or read",
    module: "messaging",
    risk: "read",
    permission: "messaging.read",
    input: z.object({}),
    output: z.object({
      conversations: z.array(
        z.object({
          id: z.string(),
          kind: z.string(),
          title: z.string(),
          agentEnabled: z.boolean(),
          archivedAt: z.string().nullable(),
          createdByMe: z.boolean(),
          lastMessageAt: z.string().nullable(),
        }),
      ),
    }),
    execute: async (ctx) => {
      // The system actor has no user identity and thus no conversations.
      if (!ctx.actor.id) return { conversations: [] };
      // Membership-scoped (N06): the module boundary must agree with the
      // message-read boundary - a nonmember lists neither DMs nor channels
      // they have not joined. Deleted conversations vanish; archived ones
      // ride along so their settings dialog can offer a restore.
      const rows = await deps.db
        .select({
          id: conversations.id,
          kind: conversations.kind,
          title: conversations.title,
          agentEnabled: conversations.agentEnabled,
          archivedAt: conversations.archivedAt,
          createdByUserId: conversations.createdByUserId,
        })
        .from(conversations)
        .innerJoin(
          conversationMembers,
          and(
            eq(conversationMembers.conversationId, conversations.id),
            eq(conversationMembers.userId, ctx.actor.id),
          ),
        )
        .where(and(eq(conversations.orgId, ctx.actor.orgId), isNull(conversations.deletedAt)))
        .orderBy(desc(conversations.createdAt))
        .limit(50);
      const out = [];
      for (const c of rows) {
        const last = await deps.db
          .select({ createdAt: messages.createdAt })
          .from(messages)
          .where(eq(messages.conversationId, c.id))
          .orderBy(desc(messages.createdAt))
          .limit(1);
        out.push({
          id: c.id,
          kind: c.kind,
          title: c.title,
          agentEnabled: c.agentEnabled,
          archivedAt: c.archivedAt?.toISOString() ?? null,
          createdByMe: c.createdByUserId === ctx.actor.id,
          lastMessageAt: last[0]?.createdAt?.toISOString() ?? null,
        });
      }
      return { conversations: out.filter((c) => c !== undefined) };
    },
  });

const readMessages = (deps: ModuleDeps) =>
  defineCapability({
    id: "messaging.readMessages",
    title: "Read conversation messages",
    intent: "Read recent messages from an internal conversation to catch up on context",
    module: "messaging",
    risk: "read",
    permission: "messaging.read",
    input: z.object({ conversationId: z.string(), limit: z.number().int().min(1).max(100).default(30) }),
    output: z.object({
      messages: z.array(
        z.object({
          senderType: z.string(),
          senderUserId: z.string().nullable(),
          body: z.string(),
          createdAt: z.string(),
          editedAt: z.string().nullable(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      const [conv] = await deps.db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, input.conversationId),
            eq(conversations.orgId, ctx.actor.orgId),
            isNull(conversations.deletedAt),
          ),
        )
        .limit(1);
      if (!conv) throw new Error("conversation not found");
      if (!(await isMember(deps.db, conv.id, ctx.actor.id))) {
        throw new Error("you are not a member of this conversation");
      }
      const rows = await deps.db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, input.conversationId),
            eq(messages.orgId, ctx.actor.orgId),
            isNull(messages.deletedAt),
          ),
        )
        .orderBy(asc(messages.createdAt))
        .limit(input.limit);
      return {
        messages: rows.map((m) => ({
          senderType: m.senderType,
          senderUserId: m.senderUserId,
          body: m.body,
          createdAt: m.createdAt.toISOString(),
          editedAt: m.editedAt?.toISOString() ?? null,
        })),
      };
    },
  });

/**
 * Everyone (and everything) that can be @mentioned: the org's people plus
 * the agent. Feeds the composer's mention picker.
 */
const listPeople = (deps: ModuleDeps) =>
  defineCapability({
    id: "messaging.listPeople",
    title: "List mentionable people",
    intent:
      "List the organization's members and the AI workmate so a message can @mention the right person or pull the agent into a conversation",
    module: "messaging",
    risk: "read",
    permission: "messaging.read",
    input: z.object({}),
    output: z.object({
      people: z.array(
        z.object({
          type: z.enum(["user", "agent"]),
          id: z.string(),
          name: z.string(),
        }),
      ),
    }),
    execute: async (ctx) => {
      const rows = await deps.db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.orgId, ctx.actor.orgId));
      const seen = new Set<string>();
      const people: { type: "user" | "agent"; id: string; name: string }[] = rows
        .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
        .map((r) => ({ type: "user" as const, id: r.id, name: r.name ?? r.email }));
      people.push({ type: "agent", id: "workmate", name: "Chaste · AI workmate" });
      return { people };
    },
  });

/**
 * N08: conversation creation is a governed action, not a route-side insert.
 * The header and the creator's membership commit in one unit - a failed
 * member insert can no longer strand an unusable header.
 */
const createConversation = (deps: ModuleDeps) =>
  defineCapability({
    id: "messaging.createConversation",
    title: "Create internal conversation",
    intent:
      "Open a new internal team channel or direct message in this organization with the actor as its first member, so colleagues can be added and messaged",
    module: "messaging",
    risk: "write",
    permission: "messaging.write",
    input: z.object({
      title: z.string().min(1).max(80),
      kind: z.enum(["channel", "dm"]).default("channel"),
      agentEnabled: z.boolean().default(false),
    }),
    output: z.object({ conversationId: z.string() }),
    execute: async (ctx, input) => {
      const creatorId = ctx.actor.id;
      if (!creatorId) throw new Error("conversation creation needs a named member");
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [conv] = await tx
          .insert(conversations)
          .values({
            orgId: ctx.actor.orgId,
            kind: input.kind,
            title: input.title,
            agentEnabled: input.agentEnabled,
            createdByUserId: creatorId,
          })
          .returning({ id: conversations.id });
        await tx.insert(conversationMembers).values({ conversationId: conv!.id, userId: creatorId });
        return { conversationId: conv!.id };
      });
    },
  });

export function registerMessagingCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(sendMessage(deps));
  registry.register(listConversations(deps));
  registry.register(readMessages(deps));
  registry.register(listPeople(deps));
  registry.register(createConversation(deps));
  registry.register(updateConversation(deps));
  registry.register(archiveConversation(deps));
  registry.register(deleteConversation(deps));
  registry.register(leaveConversation(deps));
  registry.register(addMember(deps));
  registry.register(editMessage(deps));
  registry.register(deleteMessage(deps));
}

/**
 * Rename a channel or flip its workmate participation. Membership-scoped
 * like every write here; renaming a DM is refused (titles are derived from
 * the other member), everything else is fair game.
 */
const updateConversation = (deps: ModuleDeps) =>
  defineCapability({
    id: "messaging.updateConversation",
    title: "Update conversation",
    intent:
      "Rename an internal channel or turn its AI workmate participation on or off, keeping shared spaces named and governed as the team changes",
    module: "messaging",
    risk: "write",
    permission: "messaging.write",
    input: z.object({
      conversationId: z.string(),
      title: z.string().min(1).max(80).optional(),
      agentEnabled: z.boolean().optional(),
    }),
    output: z.object({ conversationId: z.string() }),
    execute: async (ctx, input) => {
      if (!input.title && input.agentEnabled === undefined) throw new Error("nothing to update");
      if (!(await isMember(deps.db, input.conversationId, ctx.actor.id))) {
        throw new Error("you are not a member of this conversation");
      }
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [conv] = await tx
          .select({ id: conversations.id, kind: conversations.kind })
          .from(conversations)
          .where(
            and(
              eq(conversations.id, input.conversationId),
              eq(conversations.orgId, ctx.actor.orgId),
              isNull(conversations.deletedAt),
            ),
          )
          .limit(1);
        if (!conv) throw new Error("conversation not found");
        if (conv.kind === "dm" && input.title) throw new Error("direct messages cannot be renamed");
        await tx
          .update(conversations)
          .set({
            ...(input.title ? { title: input.title } : {}),
            ...(input.agentEnabled !== undefined ? { agentEnabled: input.agentEnabled } : {}),
          })
          .where(eq(conversations.id, conv.id));
        return { conversationId: conv.id };
      });
    },
  });

/** Archiving hides a channel from the everyday list without destroying it. */
const archiveConversation = (deps: ModuleDeps) =>
  defineCapability({
    id: "messaging.archiveConversation",
    title: "Archive or restore conversation",
    intent:
      "Move an internal channel out of the everyday list when it is finished, or bring it back, keeping its full history readable",
    module: "messaging",
    risk: "write",
    permission: "messaging.write",
    input: z.object({ conversationId: z.string(), archived: z.boolean().default(true) }),
    output: z.object({ conversationId: z.string(), archived: z.boolean() }),
    execute: async (ctx, input) => {
      if (!(await isMember(deps.db, input.conversationId, ctx.actor.id))) {
        throw new Error("you are not a member of this conversation");
      }
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [conv] = await tx
          .select({ id: conversations.id, kind: conversations.kind })
          .from(conversations)
          .where(
            and(
              eq(conversations.id, input.conversationId),
              eq(conversations.orgId, ctx.actor.orgId),
              isNull(conversations.deletedAt),
            ),
          )
          .limit(1);
        if (!conv) throw new Error("conversation not found");
        if (conv.kind === "dm") throw new Error("direct messages cannot be archived");
        await tx
          .update(conversations)
          .set({ archivedAt: input.archived ? new Date() : null })
          .where(eq(conversations.id, conv.id));
        return { conversationId: conv.id, archived: input.archived };
      });
    },
  });

/**
 * Soft delete for channels the creator wants gone. The row survives (the
 * ledger and member history stay meaningful); readers and lists skip it.
 */
const deleteConversation = (deps: ModuleDeps) =>
  defineCapability({
    id: "messaging.deleteConversation",
    title: "Delete conversation",
    intent:
      "Remove a channel the actor created from the organization's conversation list because it was created by mistake or is no longer wanted, keeping the audit trail intact",
    module: "messaging",
    risk: "destructive",
    permission: "messaging.write",
    input: z.object({ conversationId: z.string() }),
    output: z.object({ deleted: z.literal(true) }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [conv] = await tx
          .select({ id: conversations.id, kind: conversations.kind, createdByUserId: conversations.createdByUserId })
          .from(conversations)
          .where(
            and(
              eq(conversations.id, input.conversationId),
              eq(conversations.orgId, ctx.actor.orgId),
              isNull(conversations.deletedAt),
            ),
          )
          .limit(1);
        if (!conv) throw new Error("conversation not found");
        if (conv.kind === "dm") throw new Error("direct messages are left, not deleted");
        if (conv.createdByUserId !== ctx.actor.id) throw new Error("only the channel creator can delete it");
        await tx.update(conversations).set({ deletedAt: new Date() }).where(eq(conversations.id, conv.id));
        return { deleted: true as const };
      });
    },
  });

/** Walk away from a conversation: membership row goes, history stays. */
const leaveConversation = (deps: ModuleDeps) =>
  defineCapability({
    id: "messaging.leaveConversation",
    title: "Leave conversation",
    intent:
      "Remove the actor's own membership from an internal channel or direct message so it stops appearing in their list, without deleting anything for others",
    module: "messaging",
    risk: "write",
    permission: "messaging.write",
    input: z.object({ conversationId: z.string() }),
    output: z.object({ left: z.literal(true) }),
    execute: async (ctx, input) => {
      const actorId = ctx.actor.id;
      if (!actorId) throw new Error("leaving needs a named member");
      if (!(await isMember(deps.db, input.conversationId, actorId))) {
        throw new Error("you are not a member of this conversation");
      }
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        await tx
          .delete(conversationMembers)
          .where(
            and(
              eq(conversationMembers.conversationId, input.conversationId),
              eq(conversationMembers.userId, actorId),
            ),
          );
        return { left: true as const };
      });
    },
  });

/** Pull a colleague into a channel. DMs manage their own membership at creation. */
const addMember = (deps: ModuleDeps) =>
  defineCapability({
    id: "messaging.addMember",
    title: "Add channel member",
    intent:
      "Add a colleague to an internal channel so they can read its history and join the discussion",
    module: "messaging",
    risk: "write",
    permission: "messaging.write",
    input: z.object({
      conversationId: z.string(),
      userId: z.string().uuid(),
    }),
    output: z.object({ added: z.literal(true) }),
    execute: async (ctx, input) => {
      if (!(await isMember(deps.db, input.conversationId, ctx.actor.id))) {
        throw new Error("you are not a member of this conversation");
      }
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const [conv] = await tx
          .select({ id: conversations.id, kind: conversations.kind })
          .from(conversations)
          .where(
            and(
              eq(conversations.id, input.conversationId),
              eq(conversations.orgId, ctx.actor.orgId),
              isNull(conversations.deletedAt),
            ),
          )
          .limit(1);
        if (!conv) throw new Error("conversation not found");
        if (conv.kind === "dm") throw new Error("direct messages cannot gain members");
        const [member] = await tx
          .select({ userId: memberships.userId })
          .from(memberships)
          .where(and(eq(memberships.orgId, ctx.actor.orgId), eq(memberships.userId, input.userId)))
          .limit(1);
        if (!member) throw new Error("that person is not part of this organization");
        await tx
          .insert(conversationMembers)
          .values({ conversationId: conv.id, userId: input.userId })
          .onConflictDoNothing();
        return { added: true as const };
      });
    },
  });

/** Sender-only edit, humans only; the ledger records the edit action. */
const editMessage = (deps: ModuleDeps) =>
  defineCapability({
    id: "messaging.editMessage",
    title: "Edit message",
    intent:
      "Correct the wording of one of your own messages in an internal conversation, marking it as edited while keeping the correction on the record",
    module: "messaging",
    risk: "write",
    permission: "messaging.write",
    input: z.object({
      messageId: z.string(),
      body: z.string().min(1).max(8000),
    }),
    output: z.object({ messageId: z.string(), editedAt: z.string() }),
    execute: async (ctx, input) => {
      if (ctx.actor.type !== "human" || !ctx.actor.id) throw new Error("only your own human messages can be edited");
      const [row] = await deps.db
        .select({ id: messages.id, senderType: messages.senderType, senderUserId: messages.senderUserId })
        .from(messages)
        .where(and(eq(messages.id, input.messageId), eq(messages.orgId, ctx.actor.orgId)))
        .limit(1);
      if (!row) throw new Error("message not found");
      if (row.senderType !== "human" || row.senderUserId !== ctx.actor.id) {
        throw new Error("you can only edit your own messages");
      }
      const editedAt = new Date();
      await deps.db
        .update(messages)
        .set({ body: input.body, editedAt })
        .where(eq(messages.id, row.id));
      return { messageId: row.id, editedAt: editedAt.toISOString() };
    },
  });

/** Tombstone delete: the row stays for the audit trail, readers skip it. */
const deleteMessage = (deps: ModuleDeps) =>
  defineCapability({
    id: "messaging.deleteMessage",
    title: "Delete message",
    intent:
      "Withdraw one of your own messages from an internal conversation, replacing it with a deletion marker while keeping the audit trail intact",
    module: "messaging",
    risk: "write",
    permission: "messaging.write",
    input: z.object({ messageId: z.string() }),
    output: z.object({ deleted: z.literal(true) }),
    execute: async (ctx, input) => {
      if (ctx.actor.type !== "human" || !ctx.actor.id) throw new Error("only your own human messages can be deleted");
      const [row] = await deps.db
        .select({ id: messages.id, senderType: messages.senderType, senderUserId: messages.senderUserId })
        .from(messages)
        .where(and(eq(messages.id, input.messageId), eq(messages.orgId, ctx.actor.orgId)))
        .limit(1);
      if (!row) throw new Error("message not found");
      if (row.senderType !== "human" || row.senderUserId !== ctx.actor.id) {
        throw new Error("you can only delete your own messages");
      }
      await deps.db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, row.id));
      return { deleted: true as const };
    },
  });
