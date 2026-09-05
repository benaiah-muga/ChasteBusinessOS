import { and, desc, eq, ilike, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { embed } from "@chaste/ai";
import {
  customers,
  invoices,
  memories,
  supportConversations,
  supportMessages,
  type Database,
  supportCannedResponses,
  supportKbArticles,
} from "@chaste/db";
import { withOrgContext } from "@chaste/db";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";

export interface ModuleDeps {
  db: Database["db"];
}

type Tx = Parameters<Parameters<ModuleDeps["db"]["transaction"]>[0]>[0];

/** Bounded transcript window for agent drafting. */
export const TRANSCRIPT_MAX_MESSAGES = 20;
const SUBJECT_MAX = 200;
export const MESSAGE_BODY_MAX = 4000;

const CONVERSATION_STATUSES = ["open", "escalated", "resolved"] as const;


/**
 * Loads a conversation scoped to org and returns it with its bound customer.
 * Every capability funnels through here: the customer binding is resolved
 * server-side from trusted data, never accepted as model input.
 */
async function loadBoundConversation(
  tx: Tx | ModuleDeps["db"],
  orgId: string,
  conversationId: string,
) {
  const [row] = await tx
    .select({
      id: supportConversations.id,
      status: supportConversations.status,
      customerId: supportConversations.customerId,
      subject: supportConversations.subject,
      customerName: customers.name,
      customerEmail: customers.email,
    })
    .from(supportConversations)
    .innerJoin(customers, eq(customers.id, supportConversations.customerId))
    .where(
      and(eq(supportConversations.id, conversationId), eq(supportConversations.orgId, orgId)),
    )
    .limit(1);
  return row ?? null;
}

const startConversation = (deps: ModuleDeps) =>
  defineCapability({
    id: "support.startConversation",
    title: "Start support conversation",
    intent:
      "Open a customer care thread bound to one existing customer so inquiries about them are handled on the record",
    module: "support",
    risk: "write",
    permission: "support.write",
    input: z.object({
      customerId: z.string().uuid(),
      subject: z.string().min(1).max(SUBJECT_MAX),
    }),
    output: z.object({ conversationId: z.string() }),
    inverse: {
      capabilityId: "support.resolveConversation",
      buildInput: (_input, output) => ({
        conversationId: (output as { conversationId: string }).conversationId,
      }),
    },
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        // The customer must exist in this org; a foreign id must never bind.
        const [customer] = await tx
          .select({ id: customers.id })
          .from(customers)
          .where(and(eq(customers.id, input.customerId), eq(customers.orgId, ctx.actor.orgId)))
          .limit(1);
        if (!customer) throw new Error("customer not found in this organization");
        const [conv] = await tx
          .insert(supportConversations)
          .values({
            orgId: ctx.actor.orgId,
            customerId: input.customerId,
            subject: input.subject,
            status: "open",
            createdByActorType: ctx.actor.type,
            createdByActorId: ctx.actor.id,
            ticketNumber: ((await deps.db.select({ n: sql<number>`coalesce(max(${supportConversations.ticketNumber}), 0)` }).from(supportConversations).where(eq(supportConversations.orgId, ctx.actor.orgId)))[0]?.n ?? 0) + 1,})
          .returning({ id: supportConversations.id });
        await tx.insert(supportMessages).values({
          orgId: ctx.actor.orgId,
          conversationId: conv!.id,
          senderType: "system",
          body: `Conversation opened about ${input.subject}.`,
        });
        return { conversationId: conv!.id };
      });
    },
  });

const postMessage = (deps: ModuleDeps) =>
  defineCapability({
    id: "support.postMessage",
    title: "Log support message",
    intent:
      "Append an entry to a customer care thread: what the customer wrote, what staff replied, or an AI-drafted reply released by a human",
    module: "support",
    risk: "write",
    permission: "support.write",
    input: z.object({
      conversationId: z.string().uuid(),
      body: z.string().min(1).max(MESSAGE_BODY_MAX),
      // Humans may record either side of the exchange (staff often paste the
      // customer's email verbatim); agents always record as themselves.
      from: z.enum(["customer", "staff"]).default("staff"),
    }),
    output: z.object({ messageId: z.string(), senderType: z.string() }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const conv = await loadBoundConversation(tx, ctx.actor.orgId, input.conversationId);
        if (!conv) throw new Error("conversation not found");
        if (conv.status === "resolved") throw new Error("conversation is resolved; reopen it first");
        // Provenance honesty: an actor of type agent can never masquerade as
        // a human or a customer in the record.
        const senderType = ctx.actor.type === "agent" ? "agent" : input.from;
        const [msg] = await tx
          .insert(supportMessages)
          .values({
            orgId: ctx.actor.orgId,
            conversationId: conv.id,
            senderType,
            senderUserId: ctx.actor.type === "human" ? ctx.actor.id : null,
            body: input.body,
          })
          .returning({ id: supportMessages.id });
        await tx
          .update(supportConversations)
          .set({ updatedAt: new Date() })
          .where(eq(supportConversations.id, conv.id));
        return { messageId: msg!.id, senderType };
      });
    },
  });

const listConversations = (deps: ModuleDeps) =>
  defineCapability({
    id: "support.listConversations",
    title: "List support conversations",
    intent:
      "List the organization's customer care threads with their latest activity, optionally filtered by status",
    module: "support",
    risk: "read",
    permission: "support.read",
    input: z.object({
      status: z.enum(CONVERSATION_STATUSES).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    output: z.object({
      conversations: z.array(
        z.object({
          id: z.string(),
          customerId: z.string(),
          customerName: z.string(),
          subject: z.string(),
          status: z.string(),
          lastMessageAt: z.date(),
          lastMessagePreview: z.string(),
        }),
      ),
    }),
    execute: async (ctx, _input) => {
      // Latest message per conversation via DISTINCT ON keeps previews honest
      // without N+1 queries; everything stays inside one org scope.
      const rows = (await deps.db.execute(sql`
        SELECT c.id, c.customer_id AS "customerId", cu.name AS "customerName",
               c.subject, c.status,
               m.created_at AS "lastMessageAt",
               left(m.body, 140) AS "lastMessagePreview"
        FROM support_conversations c
        JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = ${ctx.actor.orgId}
        LEFT JOIN LATERAL (
          SELECT body, created_at FROM support_messages sm
          WHERE sm.conversation_id = c.id ORDER BY created_at DESC LIMIT 1
        ) m ON true
        WHERE c.org_id = ${ctx.actor.orgId}
          ${_input.status ? sql`AND c.status = ${_input.status}` : sql``}
        ORDER BY COALESCE(m.created_at, c.created_at) DESC
        LIMIT ${_input.limit}
      `)) as unknown as Record<string, unknown>[] | { rows: Record<string, unknown>[] };
      const list: Record<string, unknown>[] = Array.isArray(rows) ? rows : (rows.rows ?? []);
      return {
        conversations: list.map((r) => ({
          id: String(r.id),
          customerId: String(r.customerId),
          customerName: String(r.customerName),
          subject: String(r.subject),
          status: String(r.status),
          lastMessageAt: new Date(String(r.lastMessageAt)),
          lastMessagePreview: r.lastMessagePreview == null ? "" : String(r.lastMessagePreview),
        })),
      };
    },
  });

const readConversation = (deps: ModuleDeps) =>
  defineCapability({
    id: "support.readConversation",
    title: "Read support conversation",
    intent:
      "Load a customer care thread's messages in order, including who sent each entry, before replying or handing off",
    module: "support",
    risk: "read",
    permission: "support.read",
    input: z.object({ conversationId: z.string().uuid() }),
    output: z.object({
      conversation: z.object({
        id: z.string(),
        status: z.string(),
        customerName: z.string(),
        customerEmail: z.string().nullable(),
        subject: z.string(),
      }),
      messages: z.array(z.object({ senderType: z.string(), body: z.string(), createdAt: z.date() })),
    }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const conv = await loadBoundConversation(tx, ctx.actor.orgId, input.conversationId);
        if (!conv) throw new Error("conversation not found");
        const msgs = await tx
          .select({
            senderType: supportMessages.senderType,
            body: supportMessages.body,
            createdAt: supportMessages.createdAt,
          })
          .from(supportMessages)
          .where(eq(supportMessages.conversationId, conv.id))
          .orderBy(desc(supportMessages.createdAt))
          .limit(TRANSCRIPT_MAX_MESSAGES);
        return {
          conversation: {
            id: conv.id,
            status: conv.status,
            customerName: conv.customerName,
            customerEmail: conv.customerEmail,
            subject: conv.subject,
          },
          messages: msgs.reverse(),
        };
      });
    },
  });

/**
 * THE scoped-data tool for the care agent. It takes only a conversation id:
 * the customer is resolved from that trusted row, so even a fully hijacked
 * model cannot pivot the lookup onto another customer. This implements the
 * OWASP "scoped tool" pattern at the type level instead of trusting prompts.
 */
const lookupOrderStatus = (deps: ModuleDeps) =>
  defineCapability({
    id: "support.lookupOrderStatus",
    title: "Look up this customer's order status",
    intent:
      "For the current support thread's own customer only: recent invoices with payment status and outstanding amounts, to answer where-things-stand questions from real records",
    module: "support",
    risk: "read",
    permission: "support.read",
    input: z.object({ conversationId: z.string().uuid() }),
    output: z.object({
      customerName: z.string(),
      invoices: z.array(
        z.object({
          number: z.number(),
          status: z.string(),
          totalMinor: z.number(),
          paidMinor: z.number(),
          outstandingMinor: z.number(),
          issuedAt: z.date(),
        }),
      ),
      totalOutstandingMinor: z.number(),
    }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const conv = await loadBoundConversation(tx, ctx.actor.orgId, input.conversationId);
        if (!conv) throw new Error("conversation not found");
        const rows = await tx
          .select({
            number: invoices.number,
            status: invoices.status,
            totalMinor: invoices.totalMinor,
            paidMinor: invoices.paidMinor,
            issuedAt: invoices.issuedAt,
          })
          .from(invoices)
          .where(and(eq(invoices.orgId, ctx.actor.orgId), eq(invoices.customerId, conv.customerId)))
          .orderBy(desc(invoices.issuedAt))
          .limit(10);
        return {
          customerName: conv.customerName,
          invoices: rows.map((r) => ({
            number: r.number,
            status: r.status,
            totalMinor: r.totalMinor,
            paidMinor: r.paidMinor,
            outstandingMinor: Math.max(0, r.totalMinor - r.paidMinor),
            issuedAt: r.issuedAt,
          })),
          totalOutstandingMinor: Math.max(0, rows.reduce((s, r) => s + r.totalMinor - r.paidMinor, 0)),
        };
      });
    },
  });

/**
 * Org-knowledge search for care answers (policies, SOPs, business profile).
 * Same retrieval contract as documents.searchMemory but gated by
 * support.read so care staff need no documents permission.
 */
const searchKnowledge = (deps: ModuleDeps) =>
  defineCapability({
    id: "support.searchKnowledge",
    title: "Search knowledge base",
    intent:
      "Search the organization's remembered policies and business profile to ground customer answers in real facts instead of inventing them",
    module: "support",
    risk: "read",
    permission: "support.read",
    input: z.object({ query: z.string().min(2).max(500) }),
    output: z.object({
      mode: z.enum(["semantic", "text"]),
      results: z.array(
        z.object({ kind: z.string(), source: z.string().nullable(), content: z.string() }),
      ),
    }),
    execute: async (ctx, input) => {
      try {
        const [vec] = await embed([input.query], { inputType: "query" });
        if (vec) {
          const literal = JSON.stringify(vec);
          const rows = await deps.db
            .select({ kind: memories.kind, source: memories.source, content: memories.content })
            .from(memories)
            .where(and(eq(memories.orgId, ctx.actor.orgId), isNotNull(memories.embedding)))
            .orderBy(sql`${memories.embedding} <=> ${literal}::vector`)
            .limit(5);
          if (rows.length > 0) return { mode: "semantic" as const, results: rows };
        }
      } catch {
        // fall through to text search; retrieval never hard-fails
      }
      const needle = `%${input.query.replace(/[%_]/g, "").trim()}%`;
      const rows = await deps.db
        .select({ kind: memories.kind, source: memories.source, content: memories.content })
        .from(memories)
        .where(and(eq(memories.orgId, ctx.actor.orgId), ilike(memories.content, needle)))
        .limit(5);
      return { mode: "text" as const, results: rows };
    },
  });

const escalateConversation = (deps: ModuleDeps) =>
  defineCapability({
    id: "support.escalateConversation",
    title: "Escalate support conversation",
    intent:
      "Hand a customer care thread to a human owner with the reason spelled out when the answer needs authority the assistant does not have",
    module: "support",
    risk: "write",
    permission: "support.write",
    input: z.object({
      conversationId: z.string().uuid(),
      reason: z.string().min(3).max(MESSAGE_BODY_MAX),
    }),
    output: z.object({ status: z.literal("escalated") }),
    inverse: {
      capabilityId: "support.reopenConversation",
      buildInput: (input) => ({ conversationId: input.conversationId }),
    },
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const conv = await loadBoundConversation(tx, ctx.actor.orgId, input.conversationId);
        if (!conv) throw new Error("conversation not found");
        if (conv.status !== "open") throw new Error(`cannot escalate a ${conv.status} conversation`);
        await tx
          .update(supportConversations)
          .set({ status: "escalated", updatedAt: new Date() })
          .where(eq(supportConversations.id, conv.id));
        await tx.insert(supportMessages).values({
          orgId: ctx.actor.orgId,
          conversationId: conv.id,
          senderType: "system",
          body: `Escalated by ${ctx.actor.type}: ${input.reason.slice(0, 300)}`,
        });
        return { status: "escalated" as const };
      });
    },
  });

const resolveConversation = (deps: ModuleDeps) =>
  defineCapability({
    id: "support.resolveConversation",
    title: "Resolve support conversation",
    intent:
      "Close a customer care thread once the inquiry is answered, keeping the full exchange on record",
    module: "support",
    risk: "write",
    permission: "support.write",
    input: z.object({ conversationId: z.string().uuid() }),
    output: z.object({ status: z.literal("resolved") }),
    inverse: {
      capabilityId: "support.reopenConversation",
      buildInput: (input) => ({ conversationId: input.conversationId }),
    },
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const conv = await loadBoundConversation(tx, ctx.actor.orgId, input.conversationId);
        if (!conv) throw new Error("conversation not found");
        if (conv.status === "resolved") throw new Error("conversation already resolved");
        await tx
          .update(supportConversations)
          .set({ status: "resolved", updatedAt: new Date() })
          .where(eq(supportConversations.id, conv.id));
        await tx.insert(supportMessages).values({
          orgId: ctx.actor.orgId,
          conversationId: conv.id,
          senderType: "system",
          body: `Resolved by ${ctx.actor.type}.`,
        });
        return { status: "resolved" as const };
      });
    },
  });

const reopenConversation = (deps: ModuleDeps) =>
  defineCapability({
    id: "support.reopenConversation",
    title: "Reopen support conversation",
    intent:
      "Reopen a resolved or escalated customer care thread because the customer came back or the handoff was premature",
    module: "support",
    risk: "write",
    permission: "support.write",
    input: z.object({ conversationId: z.string().uuid() }),
    output: z.object({ status: z.literal("open") }),
    execute: async (ctx, input) => {
      return withOrgContext(deps.db, ctx.actor.orgId, async (tx) => {
        const conv = await loadBoundConversation(tx, ctx.actor.orgId, input.conversationId);
        if (!conv) throw new Error("conversation not found");
        if (conv.status === "open") throw new Error("conversation is already open");
        await tx
          .update(supportConversations)
          .set({ status: "open", updatedAt: new Date() })
          .where(eq(supportConversations.id, conv.id));
        await tx.insert(supportMessages).values({
          orgId: ctx.actor.orgId,
          conversationId: conv.id,
          senderType: "system",
          body: `Reopened by ${ctx.actor.type}.`,
        });
        return { status: "open" as const };
      });
    },
  });


// ── M12: ticket depth ──────────────────────────────────────────────────

const suggestTicketCategory = (memo: string): string => {
  const t = memo.toLowerCase();
  if (/(refund|return|damaged)/.test(t)) return "billing";
  if (/(bug|error|crash|not working|broken)/.test(t)) return "technical";
  if (/(how do|how to|question|help)/.test(t)) return "how-to";
  if (/(ship|deliver|tracking|late)/.test(t)) return "shipping";
  return "general";
};

const updateTicket = (deps: ModuleDeps) =>
  defineCapability({
    id: "support.updateTicket",
    title: "Update ticket",
    intent:
      "Set a ticket's priority, category, assignee, and SLA due date so aging and breaches are measurable instead of vibes",
    module: "support",
    risk: "write",
    permission: "support.write",
    input: z.object({
      conversationId: z.string().uuid(),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
      category: z.string().max(40).optional(),
      assigneeUserId: z.string().uuid().optional(),
      slaDueAt: z.string().datetime().optional(),
    }),
    output: z.object({ updated: z.literal(true) }),
    execute: async (ctx, input) => {
      const [conv] = await deps.db
        .select({ id: supportConversations.id })
        .from(supportConversations)
        .where(and(eq(supportConversations.id, input.conversationId), eq(supportConversations.orgId, ctx.actor.orgId)))
        .limit(1);
      if (!conv) throw new Error("ticket not found");
      await deps.db
        .update(supportConversations)
        .set({
          ...(input.priority ? { priority: input.priority } : {}),
          ...(input.category ? { category: input.category } : {}),
          ...(input.assigneeUserId ? { assignedUserId: input.assigneeUserId } : {}),
          ...(input.slaDueAt ? { slaDueAt: new Date(input.slaDueAt) } : {}),
          updatedAt: ctx.now,
        })
        .where(eq(supportConversations.id, input.conversationId));
      return { updated: true as const };
    },
  });

const suggestCategory = (_deps: ModuleDeps) =>
  defineCapability({
    id: "support.suggestCategory",
    title: "Suggest ticket category",
    intent: "Draft a category for a ticket from its text using fixed rules — a suggestion, never a decision",
    module: "support",
    risk: "read",
    permission: "support.read",
    input: z.object({ text: z.string().min(1).max(2000) }),
    output: z.object({ category: z.string(), draft: z.literal(true) }),
    execute: async (ctx, input) => ({ category: suggestTicketCategory(input.text), draft: true as const }),
  });

const createCannedResponse = (deps: ModuleDeps) =>
  defineCapability({
    id: "support.createCannedResponse",
    title: "Create canned response",
    intent: "Save a reusable reply under a short shortcut so agents answer consistently in one step",
    module: "support",
    risk: "write",
    permission: "support.write",
    input: z.object({ shortcut: z.string().min(1).max(40), title: z.string().min(1).max(120), body: z.string().min(1).max(4000) }),
    output: z.object({ cannedResponseId: z.string() }),
    execute: async (ctx, input) => {
      const [row] = await deps.db
        .insert(supportCannedResponses)
        .values({ orgId: ctx.actor.orgId, shortcut: input.shortcut, title: input.title, body: input.body })
        .onConflictDoUpdate({ target: [supportCannedResponses.orgId, supportCannedResponses.shortcut], set: { title: input.title, body: input.body } })
        .returning({ id: supportCannedResponses.id });
      return { cannedResponseId: row!.id };
    },
  });

const createKbArticle = (deps: ModuleDeps) =>
  defineCapability({
    id: "support.createKbArticle",
    title: "Create KB article",
    intent: "Author a knowledge-base article so recurring questions get answered once, publicly",
    module: "support",
    risk: "write",
    permission: "support.write",
    input: z.object({ title: z.string().min(1).max(200), body: z.string().min(1).max(20000), category: z.string().max(40).optional() }),
    output: z.object({ articleId: z.string() }),
    execute: async (ctx, input) => {
      const [row] = await deps.db
        .insert(supportKbArticles)
        .values({ orgId: ctx.actor.orgId, title: input.title, body: input.body, category: input.category ?? null })
        .returning({ id: supportKbArticles.id });
      return { articleId: row!.id };
    },
  });
export function registerSupportCapabilities(registry: CapabilityRegistry, deps: ModuleDeps): void {
  registry.register(startConversation(deps));
  registry.register(postMessage(deps));
  registry.register(listConversations(deps));
  registry.register(readConversation(deps));
  registry.register(lookupOrderStatus(deps));
  registry.register(searchKnowledge(deps));
  registry.register(escalateConversation(deps));
  registry.register(resolveConversation(deps));
  registry.register(updateTicket(deps));
  registry.register(suggestCategory(deps));
  registry.register(createCannedResponse(deps));
  registry.register(createKbArticle(deps));
  registry.register(reopenConversation(deps));
}
export { createSupportSignalProducer } from "./signals";
