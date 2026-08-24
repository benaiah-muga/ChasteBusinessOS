import { NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { getDb, notifications } from "@chaste/db";
import { getResolvedUser } from "@/server/session";

/** Recent feed for the signed-in user plus org-wide broadcasts. */
export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = getDb().db;
  const limitRaw = Number(new URL(req.url).searchParams.get("limit") ?? 30);
  const limit = Number.isFinite(limitRaw) ? Math.floor(Math.max(1, Math.min(limitRaw, 100))) : 30;

  const rows = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.orgId, resolved.orgId),
        or(isNull(notifications.userId), eq(notifications.userId, resolved.userId)),
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(limit);

  const [unreadRow] = await db
    .select({ unread: sql<number>`count(*)` })
    .from(notifications)
    .where(
      and(
        eq(notifications.orgId, resolved.orgId),
        or(isNull(notifications.userId), eq(notifications.userId, resolved.userId)),
        isNull(notifications.readAt),
      ),
    );
  const unread = Number(unreadRow?.unread ?? 0);

  return NextResponse.json({
    notifications: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      href: r.href,
      readAt: r.readAt,
      createdAt: r.createdAt,
    })),
    unreadCount: unread,
  });
}

const bodySchema = z.object({ id: z.string().uuid() });

/** Mark one notification read; scoped to the recipient's view. */
export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const db = getDb().db;
  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, parsed.data.id),
        eq(notifications.orgId, resolved.orgId),
        or(isNull(notifications.userId), eq(notifications.userId, resolved.userId)),
        isNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id });
  if (updated.length === 0) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
