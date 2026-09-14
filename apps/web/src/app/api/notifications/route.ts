import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, isNull, or } from "drizzle-orm";
import { getDb, notificationReads, notifications } from "@chaste/db";
import { getResolvedUser } from "@/server/session";

/**
 * Notifications are immutable events; read state is per recipient (N29).
 * A broadcast read by one person never clears it for anyone else, and
 * marking read is idempotent. Personal rows may still carry a legacy
 * row-level readAt; receipts take precedence.
 */

/** Visible to the user: org broadcasts plus their own notifications. */
function visibleFor(orgId: string, userId: string) {
  return and(
    eq(notifications.orgId, orgId),
    or(isNull(notifications.userId), eq(notifications.userId, userId)),
  );
}

/** Recent feed for the signed-in user plus org-wide broadcasts. */
export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = getDb().db;
  const limitRaw = Number(new URL(req.url).searchParams.get("limit") ?? 30);
  const limit = Number.isFinite(limitRaw) ? Math.floor(Math.max(1, Math.min(limitRaw, 100))) : 30;

  const visible = await db
    .select()
    .from(notifications)
    .where(visibleFor(resolved.orgId, resolved.userId));
  const receipts = await db
    .select({ notificationId: notificationReads.notificationId, readAt: notificationReads.readAt })
    .from(notificationReads)
    .where(
      and(eq(notificationReads.orgId, resolved.orgId), eq(notificationReads.userId, resolved.userId)),
    );
  const receiptByNotification = new Map(receipts.map((r) => [r.notificationId, r.readAt]));

  const effectiveReadAt = (n: (typeof visible)[number]): Date | null =>
    receiptByNotification.get(n.id) ?? (n.userId !== null ? n.readAt : null);

  const rows = [...visible]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);
  const unread = visible.filter((n) => effectiveReadAt(n) === null).length;

  return NextResponse.json({
    notifications: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      href: r.href,
      readAt: effectiveReadAt(r)?.toISOString() ?? null,
      createdAt: r.createdAt,
    })),
    unreadCount: unread,
  });
}

const bodySchema = z.object({ id: z.string().uuid() });

/** Mark one visible notification read for THIS user; idempotent. */
export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const db = getDb().db;

  const [row] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.id, parsed.data.id), visibleFor(resolved.orgId, resolved.userId)))
    .limit(1);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Per-user receipt; the notification row itself is never rewritten, so a
  // broadcast stays unread for everyone else. Repeats are a no-op success.
  await db
    .insert(notificationReads)
    .values({ orgId: resolved.orgId, notificationId: row.id, userId: resolved.userId })
    .onConflictDoNothing();
  return NextResponse.json({ ok: true });
}
