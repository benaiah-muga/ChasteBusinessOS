import { NextResponse } from "next/server";
import { z } from "zod";
import { and, count, desc, eq, gt, isNull, ne, or } from "drizzle-orm";
import { conversations, conversationMembers, getDb, messages } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry, hasPermissionFor } from "@/server/kernel";
import { missingPermission } from "@/server/route-guards";
import { getResolvedUser } from "@/server/session";

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const orgId = resolved.orgId;
  const db = getDb().db;

  // Membership-scoped (N06): the list boundary must agree with the detail
  // boundary - a nonmember sees neither titles nor previews of a DM.
  const denied = missingPermission(resolved, "messaging.read");
  if (denied) return denied;

  const rows = await db
    .select({
      id: conversations.id,
      kind: conversations.kind,
      title: conversations.title,
      agentEnabled: conversations.agentEnabled,
      archivedAt: conversations.archivedAt,
      createdByUserId: conversations.createdByUserId,
      joinedAt: conversationMembers.joinedAt,
      lastReadAt: conversationMembers.lastReadAt,
    })
    .from(conversations)
    .innerJoin(
      conversationMembers,
      and(
        eq(conversationMembers.conversationId, conversations.id),
        eq(conversationMembers.userId, resolved.userId),
      ),
    )
    .where(and(eq(conversations.orgId, orgId), isNull(conversations.deletedAt)))
    .orderBy(desc(conversations.createdAt))
    .limit(100);

  const withLast = await Promise.all(
    rows.map(async (c) => {
      const [last, unread] = await Promise.all([
        db
          .select({ createdAt: messages.createdAt, body: messages.body })
          .from(messages)
          .where(and(eq(messages.orgId, orgId), eq(messages.conversationId, c.id), isNull(messages.deletedAt)))
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(1),
        db
          .select({ unreadCount: count(messages.id) })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, c.id),
              eq(messages.orgId, orgId),
              isNull(messages.deletedAt),
              gt(messages.createdAt, c.lastReadAt ?? c.joinedAt),
              or(isNull(messages.senderUserId), ne(messages.senderUserId, resolved.userId)),
            ),
          ),
      ]);
      return {
        id: c.id,
        kind: c.kind,
        title: c.title,
        agentEnabled: c.agentEnabled,
        archivedAt: c.archivedAt?.toISOString() ?? null,
        createdByMe: c.createdByUserId === resolved.userId,
        unreadCount: unread[0]?.unreadCount ?? 0,
        lastMessage: last[0]
          ? { at: last[0].createdAt.toISOString(), body: (last[0].body || "📎 Shared a file").slice(0, 80) }
          : null,
      };
    }),
  );
  return NextResponse.json({ conversations: withLast, me: resolved.userId });
}

const createSchema = z.object({
  title: z.string().min(1).max(80),
  kind: z.enum(["channel", "dm"]).default("channel"),
  agentEnabled: z.boolean().default(false),
});

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId || !hasPermissionFor(resolved, "messaging.write")) {
    return NextResponse.json({ error: "you lack authority over messaging" }, { status: 403 });
  }
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const intentId = typeof raw?.intentId === "string" ? raw.intentId : undefined;
  const body = createSchema.safeParse(raw);
  if (!body.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  // N08: governed creation - the capability inserts the header and the
  // creator's membership in one audited unit instead of two route statements.
  const ctx = actorFromResolved(resolved, { intentId });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const executor = buildExecutor(getDb().db, buildRegistry(getDb().db));
  const result = await executor.execute("messaging.createConversation", ctx, {
    title: body.data.title,
    kind: body.data.kind,
    agentEnabled: body.data.agentEnabled,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  // The shared executor types outputs loosely; the capability's declared
  // schema guarantees this shape (packages/kernel executor.ts).
  const conversationId = (result.data as { conversationId: string }).conversationId;
  return NextResponse.json({ conversationId }, { status: 201 });
}
