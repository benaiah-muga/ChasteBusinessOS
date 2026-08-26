import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { conversationMembers, conversations, memberships, messages, notifications, users } from "@chaste/db";
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
        .where(and(eq(conversations.id, input.conversationId), eq(conversations.orgId, ctx.actor.orgId)))
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
      // mentions need no row — the mention itself pulls the agent in.
      if (input.mentions?.length && ctx.actor.type === "human") {
        const [sender] = await deps.db
          .select({ name: users.name, email: users.email })
          .from(users)
          .where(eq(users.id, ctx.actor.id ?? ""))
          .limit(1);
        const senderLabel = sender?.name ?? sender?.email ?? "A colleague";
        const mentionedUsers = input.mentions.filter((m) => m.type === "user" && m.id !== ctx.actor.id);
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
          lastMessageAt: z.string().nullable(),
        }),
      ),
    }),
    execute: async (ctx) => {
      const rows = await deps.db
        .select()
        .from(conversations)
        .where(eq(conversations.orgId, ctx.actor.orgId))
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
          lastMessageAt: last[0]?.createdAt?.toISOString() ?? null,
        });
      }
      return { conversations: out };
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
        }),
      ),
    }),
    execute: async (ctx, input) => {
      const [conv] = await deps.db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.id, input.conversationId), eq(conversations.orgId, ctx.actor.orgId)))
        .limit(1);
      if (!conv) throw new Error("conversation not found");
      if (!(await isMember(deps.db, conv.id, ctx.actor.id))) {
        throw new Error("you are not a member of this conversation");
      }
      const rows = await deps.db
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, input.conversationId), eq(messages.orgId, ctx.actor.orgId)))
        .orderBy(asc(messages.createdAt))
        .limit(input.limit);
      return {
        messages: rows.map((m) => ({
          senderType: m.senderType,
          senderUserId: m.senderUserId,
          body: m.body,
          createdAt: m.createdAt.toISOString(),
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

export function registerMessagingCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(sendMessage(deps));
  registry.register(listConversations(deps));
  registry.register(readMessages(deps));
  registry.register(listPeople(deps));
}
