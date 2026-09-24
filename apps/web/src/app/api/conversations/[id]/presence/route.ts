import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { conversationMembers, conversationPresence, conversations, getDb, users, withOrgContext } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

type Params = { params: Promise<{ id: string }> };

async function memberConversation(id: string, orgId: string, userId: string) {
  const [row] = await getDb().db
    .select({ id: conversations.id })
    .from(conversations)
    .innerJoin(
      conversationMembers,
      and(eq(conversationMembers.conversationId, conversations.id), eq(conversationMembers.userId, userId)),
    )
    .where(and(eq(conversations.id, id), eq(conversations.orgId, orgId), isNull(conversations.deletedAt)))
    .limit(1);
  return row;
}

export async function GET(_req: Request, { params }: Params) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const orgId = resolved.orgId;
  const { id } = await params;
  if (!(await memberConversation(id, resolved.orgId, resolved.userId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const now = new Date();
  const db = getDb().db;
  const rows = await withOrgContext(db, orgId, async (tx) =>
    await tx
      .select({ userId: conversationPresence.userId, name: users.name, email: users.email, lastSeenAt: conversationPresence.lastSeenAt, typingUntil: conversationPresence.typingUntil })
      .from(conversationPresence)
      .innerJoin(users, eq(users.id, conversationPresence.userId))
      .innerJoin(
        conversationMembers,
        and(
          eq(conversationMembers.conversationId, conversationPresence.conversationId),
          eq(conversationMembers.userId, conversationPresence.userId),
        ),
      )
      .where(and(eq(conversationPresence.orgId, orgId), eq(conversationPresence.conversationId, id))),
  );
  return NextResponse.json(
    {
      people: rows
        .filter((row) => row.userId !== resolved.userId && row.lastSeenAt.getTime() > now.getTime() - 45_000)
        .map((row) => ({
          userId: row.userId,
          name: row.name ?? row.email,
          typing: row.typingUntil !== null && row.typingUntil.getTime() > now.getTime(),
        })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request, { params }: Params) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const raw = (await req.json().catch(() => null)) as { typing?: unknown } | null;
  if (typeof raw?.typing !== "boolean") return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const db = getDb().db;
  const result = await buildExecutor(db, buildRegistry(db)).execute("messaging.updateConversationPresence", ctx, {
    conversationId: id,
    typing: raw.typing,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 });
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
