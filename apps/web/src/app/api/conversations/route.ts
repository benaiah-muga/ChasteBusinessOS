import { NextResponse } from "next/server";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { conversations, conversationMembers, getDb, messages } from "@chaste/db";
import { hasPermissionFor } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = getDb().db;

  const rows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.orgId, resolved.orgId))
    .orderBy(desc(conversations.createdAt));

  const withLast = await Promise.all(
    rows.map(async (c) => {
      const [last] = await db
        .select({ createdAt: messages.createdAt, body: messages.body })
        .from(messages)
        .where(eq(messages.conversationId, c.id))
        .orderBy(desc(messages.createdAt))
        .limit(1);
      return {
        id: c.id,
        kind: c.kind,
        title: c.title,
        agentEnabled: c.agentEnabled,
        lastMessage: last ? { at: last.createdAt.toISOString(), body: last.body.slice(0, 80) } : null,
      };
    }),
  );
  return NextResponse.json({ conversations: withLast });
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
  const body = createSchema.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const db = getDb().db;
  const [conv] = await db
    .insert(conversations)
    .values({
      orgId: resolved.orgId,
      kind: body.data.kind,
      title: body.data.title,
      agentEnabled: body.data.agentEnabled,
      createdByUserId: resolved.userId,
    })
    .returning();
  await db.insert(conversationMembers).values({ conversationId: conv!.id, userId: resolved.userId });
  return NextResponse.json({ conversation: conv });
}
