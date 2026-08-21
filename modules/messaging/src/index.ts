import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { conversations, conversationMembers, messages } from "@chaste/db";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";

export interface ModuleDeps {
  db: import("@chaste/db").Database["db"];
}

const sendMessage = (deps: ModuleDeps) =>
  defineCapability({
    id: "messaging.sendMessage",
    title: "Send internal message",
    intent:
      "Post a message into an internal team conversation (channel or DM). Use to keep colleagues informed or answer them in threads",
    module: "messaging",
    risk: "write",
    permission: "messaging.write",
    input: z.object({
      conversationId: z.string(),
      body: z.string().min(1).max(8000),
    }),
    output: z.object({ messageId: z.string() }),
    execute: async (ctx, input) => {
      const [conv] = await deps.db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.id, input.conversationId), eq(conversations.orgId, ctx.actor.orgId)))
        .limit(1);
      if (!conv) throw new Error("conversation not found");
      const [row] = await deps.db
        .insert(messages)
        .values({
          orgId: ctx.actor.orgId,
          conversationId: input.conversationId,
          senderType: ctx.actor.type === "agent" ? "agent" : "human",
          senderUserId: ctx.actor.type === "human" ? ctx.actor.id : null,
          body: input.body,
        })
        .returning({ id: messages.id });
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

export function registerMessagingCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(sendMessage(deps));
  registry.register(listConversations(deps));
  registry.register(readMessages(deps));
}
