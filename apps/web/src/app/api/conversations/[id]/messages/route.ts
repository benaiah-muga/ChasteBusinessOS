import { NextResponse } from "next/server";
import { z } from "zod";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  conversationMembers,
  conversations,
  getDb,
  messageAttachments,
  messageReactions,
  messages,
  organizations,
  users,
  withOrgContext,
} from "@chaste/db";
import { OpenAiCompatAdapter, resolveClient } from "@chaste/ai";
import { runAgentLoop } from "@chaste/kernel";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { runtimeAiConfig } from "@/server/ai-settings";

type Params = { params: Promise<{ id: string }> };

async function loadConversation(id: string, orgId: string) {
  const db = getDb().db;
  const [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.orgId, orgId), isNull(conversations.deletedAt)))
    .limit(1);
  return conv ?? null;
}

/**
 * Org scope is not enough for conversations: DMs are membership-scoped, so a
 * member must belong to the conversation to read or post. Without this check
 * any colleague could read and write into private DMs.
 */
async function assertMembership(conversationId: string, userId: string): Promise<boolean> {
  const [member] = await getDb()
    .db.select({ userId: conversationMembers.userId })
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

const messageColumns = {
  id: messages.id,
  senderType: messages.senderType,
  senderUserId: messages.senderUserId,
  body: messages.body,
  createdAt: messages.createdAt,
  editedAt: messages.editedAt,
  mentions: messages.mentions,
  parentMessageId: messages.parentMessageId,
  pinnedAt: messages.pinnedAt,
};
type MessageRow = Pick<
  typeof messages.$inferSelect,
  "id" | "senderType" | "senderUserId" | "body" | "createdAt" | "editedAt" | "mentions" | "parentMessageId" | "pinnedAt"
>;

export async function GET(req: Request, { params }: Params) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const orgId = resolved.orgId;
  const { id } = await params;
  const conv = await loadConversation(id, resolved.orgId);
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!(await assertMembership(id, resolved.userId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const db = getDb().db;
  const base = and(eq(messages.conversationId, id), eq(messages.orgId, orgId), isNull(messages.deletedAt));
  const paramsFromUrl = new URL(req.url).searchParams;
  const aroundId = paramsFromUrl.get("around");
  const beforeId = paramsFromUrl.get("before");
  if (aroundId && !z.string().uuid().safeParse(aroundId).success) return NextResponse.json({ error: "invalid message cursor" }, { status: 400 });
  if (beforeId && !z.string().uuid().safeParse(beforeId).success) return NextResponse.json({ error: "invalid message cursor" }, { status: 400 });
  const limit = Math.min(Math.max(Number(paramsFromUrl.get("limit") ?? 60) || 60, 1), 100);
  const pinnedMessages = await db
    .select({ id: messages.id, body: messages.body, pinnedAt: messages.pinnedAt })
    .from(messages)
    .where(and(base, isNotNull(messages.pinnedAt)))
    .orderBy(desc(messages.pinnedAt), desc(messages.id))
    .limit(20);
  let rows: MessageRow[];
  let hasMore = false;
  let nextCursor: string | null = null;

  if (aroundId) {
    const [target] = await db
      .select(messageColumns)
      .from(messages)
      .where(and(base, eq(messages.id, aroundId)))
      .limit(1);
    if (!target) return NextResponse.json({ error: "message not found" }, { status: 404 });
    const older = await db
      .select(messageColumns)
      .from(messages)
      .where(
        and(
          base,
          sql`(${messages.createdAt}, ${messages.id}) < (SELECT ${messages.createdAt}, ${messages.id} FROM ${messages} WHERE ${messages.id} = ${target.id})`,
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(31);
    const newer = await db
      .select(messageColumns)
      .from(messages)
      .where(
        and(
          base,
          sql`(${messages.createdAt}, ${messages.id}) > (SELECT ${messages.createdAt}, ${messages.id} FROM ${messages} WHERE ${messages.id} = ${target.id})`,
        ),
      )
      .orderBy(asc(messages.createdAt), asc(messages.id))
      .limit(30);
    hasMore = older.length > 30;
    if (hasMore) older.pop();
    older.reverse();
    rows = [...older, target, ...newer];
    nextCursor = hasMore ? older[0]?.id ?? null : null;
  } else {
    const query = db
      .select(messageColumns)
      .from(messages)
      .where(
        and(
          base,
          beforeId
            ? sql`(${messages.createdAt}, ${messages.id}) < (SELECT ${messages.createdAt}, ${messages.id} FROM ${messages} WHERE ${messages.id} = ${beforeId})`
            : undefined,
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit + 1);
    const page = await query;
    hasMore = page.length > limit;
    if (hasMore) page.pop();
    page.reverse();
    rows = page;
    nextCursor = hasMore ? page[0]?.id ?? null : null;
  }

  const messageIds = rows.map((message) => message.id);
  const [attachments, reactions, readerRows] = await Promise.all([
    messageIds.length
      ? withOrgContext(db, orgId, async (tx) =>
          await tx
            .select({
              id: messageAttachments.id,
              messageId: messageAttachments.messageId,
              filename: messageAttachments.filename,
              mimeType: messageAttachments.mimeType,
              sizeBytes: messageAttachments.sizeBytes,
            })
            .from(messageAttachments)
            .where(and(eq(messageAttachments.orgId, orgId), inArray(messageAttachments.messageId, messageIds))),
        )
      : Promise.resolve([]),
    messageIds.length
      ? withOrgContext(db, orgId, async (tx) =>
          await tx
            .select({
              messageId: messageReactions.messageId,
              emoji: messageReactions.emoji,
              userId: messageReactions.userId,
              name: users.name,
              email: users.email,
            })
            .from(messageReactions)
            .innerJoin(users, eq(users.id, messageReactions.userId))
            .where(and(eq(messageReactions.orgId, orgId), inArray(messageReactions.messageId, messageIds))),
        )
      : Promise.resolve([]),
    db
      .select({ userId: conversationMembers.userId, name: users.name, email: users.email, lastReadAt: conversationMembers.lastReadAt })
      .from(conversationMembers)
      .innerJoin(users, eq(users.id, conversationMembers.userId))
      .where(eq(conversationMembers.conversationId, id)),
  ]);

  const reactionsByMessage = new Map<string, Map<string, { emoji: string; count: number; reactedByMe: boolean; names: string[] }>>();
  for (const reaction of reactions) {
    let byEmoji = reactionsByMessage.get(reaction.messageId);
    if (!byEmoji) {
      byEmoji = new Map();
      reactionsByMessage.set(reaction.messageId, byEmoji);
    }
    const item = byEmoji.get(reaction.emoji) ?? { emoji: reaction.emoji, count: 0, reactedByMe: false, names: [] };
    item.count += 1;
    item.reactedByMe ||= reaction.userId === resolved.userId;
    item.names.push(reaction.name ?? reaction.email);
    byEmoji.set(reaction.emoji, item);
  }
  const attachmentsByMessage = new Map<string, typeof attachments>();
  for (const attachment of attachments) {
    if (!attachment.messageId) continue;
    const list = attachmentsByMessage.get(attachment.messageId) ?? [];
    list.push(attachment);
    attachmentsByMessage.set(attachment.messageId, list);
  }

  const messagesWithExtras = rows.map((message) => ({
    ...message,
    reactions: [...(reactionsByMessage.get(message.id)?.values() ?? [])],
    attachments: (attachmentsByMessage.get(message.id) ?? []).map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      href: `/api/message-attachments/${attachment.id}`,
    })),
  }));
  const readers = readerRows.map((reader) => ({
    userId: reader.userId,
    name: reader.name ?? reader.email,
    lastReadAt: reader.lastReadAt?.toISOString() ?? null,
  }));
  return NextResponse.json(
    { conversation: conv, messages: messagesWithExtras, me: resolved.userId, readers, pinnedMessages, hasMore, nextCursor },
    { headers: { "Cache-Control": "no-store" } },
  );
}

const mentionSchema = z.object({
  type: z.enum(["user", "agent"]),
  id: z.string().min(1).max(80),
});

const sendSchema = z.object({
  body: z.string().max(8000),
  mentions: z.array(mentionSchema).max(20).optional(),
  parentMessageId: z.string().uuid().optional(),
  attachmentIds: z.array(z.string().uuid()).max(5).optional(),
}).refine((body) => Boolean(body.body.trim()) || Boolean(body.attachmentIds?.length), "write a message or attach a file");

export async function POST(req: Request, { params }: Params) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const conv = await loadConversation(id, resolved.orgId);
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!(await assertMembership(id, resolved.userId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const intentId = typeof raw?.intentId === "string" ? raw.intentId : undefined;
  const parsed = sendSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const db = getDb().db;
  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);

  // Human posts through the same capability pipeline as the agent.
  const humanCtx = actorFromResolved(resolved, { intentId });
  if (!humanCtx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const sent = await executor.execute("messaging.sendMessage", humanCtx, {
    conversationId: id,
    body: parsed.data.body,
    mentions: parsed.data.mentions,
    parentMessageId: parsed.data.parentMessageId,
    attachmentIds: parsed.data.attachmentIds,
  });
  if (!sent.ok && !sent.pendingApproval) {
    return NextResponse.json({ error: sent.error }, { status: 422 });
  }
  if (sent.pendingApproval) {
    return NextResponse.json({ pendingApproval: true }, { status: 202 });
  }

  // The workmate answers in channels where it participates, and an explicit
  // @mention pulls it into any conversation on demand.
  const agentMentioned = parsed.data.mentions?.some((m) => m.type === "agent") ?? false;
  let agentReply: string | null = null;

  if (conv.agentEnabled || agentMentioned) {
    // The agent catches up on the thread, then answers under its own authority.
    const nameRows = await db.select({ id: users.id, name: users.name, email: users.email }).from(users);
    const namesById = new Map(nameRows.map((u) => [u.id, u.name ?? u.email]));

    const history = await db
      .select({ senderType: messages.senderType, senderUserId: messages.senderUserId, body: messages.body })
      .from(messages)
      .where(and(eq(messages.conversationId, id), eq(messages.orgId, resolved.orgId), isNull(messages.deletedAt)))
      .orderBy(asc(messages.createdAt))
      .limit(30);
    const transcript = history
      .slice(-12)
      .map((m) => `${m.senderType === "agent" ? "Chaste (you)" : (namesById.get(m.senderUserId ?? "") ?? "colleague")}: ${m.body}`)
      .join("\n");

    const [orgRow] = await db
      .select({ profileDescription: organizations.profileDescription })
      .from(organizations)
      .where(eq(organizations.id, resolved.orgId))
      .limit(1);

    const agentCtx = actorFromResolved(resolved, { asAgent: true });
    if (agentCtx) {
      const ai = await runtimeAiConfig(db, resolved.orgId);
      const result = await runAgentLoop(
        new OpenAiCompatAdapter({ client: resolveClient(ai.models.primary, ai.runtime), model: ai.models.primary }),
        registry,
        executor,
        agentCtx,
        {
          sessionId: crypto.randomUUID(),
          systemPrompt: `You are Chaste, the AI workmate in the internal chat "${conv.title}" of an ERP organization. You can use capabilities when a colleague asks for something operational. Be concise and collegial.${orgRow?.profileDescription ? `\nBusiness context: ${orgRow.profileDescription}` : ""}`,
          userGoal: `Recent conversation:\n${transcript}\n\nRespond to the latest message as Chaste. Post your reply using messaging.sendMessage to conversation ${id}.`,
          maxSteps: 5,
        },
        {
          // Escalation goes through the governed capability, not a raw
          // insert: the same permission check and ledger entry as when the
          // workmate files a ticket anywhere else.
          file: async (orgId, title, description) => {
            const result = await executor.execute("support.createTicket", agentCtx, {
              title,
              description,
              origin: "capability_gap",
            });
            if (!result.ok || !result.data) throw new Error(result.error ?? "ticket could not be filed");
            return { id: (result.data as { ticketId: string }).ticketId };
          },
        },
      );
      agentReply = result.finalMessage || null;
    }
  }

  return NextResponse.json({ ok: true, agentReply });
}
