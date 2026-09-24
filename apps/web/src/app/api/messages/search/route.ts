import { NextResponse } from "next/server";
import { and, desc, eq, ilike, isNull } from "drizzle-orm";
import { conversationMembers, conversations, getDb, messages } from "@chaste/db";
import { missingPermission } from "@/server/route-guards";
import { getResolvedUser } from "@/server/session";

export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const denied = missingPermission(resolved, "messaging.read");
  if (denied) return denied;

  const query = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (query.length < 2) return NextResponse.json({ results: [] });
  if (query.length > 100) return NextResponse.json({ error: "search text is too long" }, { status: 400 });
  const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  const rows = await getDb()
    .db.select({
      id: messages.id,
      conversationId: messages.conversationId,
      conversationTitle: conversations.title,
      body: messages.body,
      senderType: messages.senderType,
      senderUserId: messages.senderUserId,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(
      conversationMembers,
      and(
        eq(conversationMembers.conversationId, messages.conversationId),
        eq(conversationMembers.userId, resolved.userId),
      ),
    )
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messages.orgId, resolved.orgId),
        eq(conversations.orgId, resolved.orgId),
        isNull(conversations.deletedAt),
        isNull(messages.deletedAt),
        ilike(messages.body, pattern),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(50);
  const lowerQuery = query.toLocaleLowerCase();
  return NextResponse.json({
    results: rows.map((row) => {
      const index = row.body.toLocaleLowerCase().indexOf(lowerQuery);
      const start = Math.max(index - 65, 0);
      const end = Math.min(index + query.length + 95, row.body.length);
      return {
        id: row.id,
        conversationId: row.conversationId,
        conversationTitle: row.conversationTitle,
        body: row.body.slice(start, end),
        createdAt: row.createdAt.toISOString(),
        senderType: row.senderType,
        senderUserId: row.senderUserId,
      };
    }),
  });
}
