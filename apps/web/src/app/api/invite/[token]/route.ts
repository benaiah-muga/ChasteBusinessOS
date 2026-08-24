import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  invitations,
  memberships,
  organizations,
  roles,
  userRoles,
} from "@chaste/db";
import { getResolvedUser } from "@/server/session";
import { inviteAttemptLimit, requestIp } from "@/server/rate-limit";

type Params = { params: Promise<{ token: string }> };

/** Preview what accepting this invitation means. */
export async function GET(req: Request, { params }: Params) {
  const limit = inviteAttemptLimit(requestIp(req));
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "too many requests" },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSec) } },
    );
  }
  const { token } = await params;
  const db = getDb().db;
  const [inv] = await db.select().from(invitations).where(eq(invitations.token, token)).limit(1);
  if (!inv || inv.status !== "pending" || inv.expiresAt < new Date()) {
    return NextResponse.json({ error: "invitation is not valid" }, { status: 404 });
  }
  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, inv.orgId))
    .limit(1);
  const [role] = await db.select({ name: roles.name }).from(roles).where(eq(roles.id, inv.roleId)).limit(1);
  return NextResponse.json({
    email: inv.email,
    orgName: org?.name ?? "Unknown organization",
    roleName: role?.name ?? "Member",
    expiresAt: inv.expiresAt.toISOString(),
  });
}

/** Accept: must be signed in as the invited email. Grants the role directly. */
export async function POST(req: Request, { params }: Params) {
  const limit = inviteAttemptLimit(requestIp(req));
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "too many requests" },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSec) } },
    );
  }
  const resolved = await getResolvedUser();
  if (!resolved) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const { token } = await params;
  const db = getDb().db;

  const [inv] = await db.select().from(invitations).where(eq(invitations.token, token)).limit(1);
  if (!inv || inv.status !== "pending") {
    return NextResponse.json({ error: "invitation is not valid" }, { status: 404 });
  }
  if (inv.expiresAt < new Date()) {
    await db.update(invitations).set({ status: "expired" }).where(eq(invitations.id, inv.id));
    return NextResponse.json({ error: "invitation expired" }, { status: 410 });
  }
  // Case-insensitive on both sides: invitations are stored lowercased, but
  // the authenticated address keeps whatever case the IdP returned.
  if (resolved.email.toLowerCase() !== inv.email.toLowerCase()) {
    return NextResponse.json({ error: `this invitation was sent to ${inv.email}` }, { status: 403 });
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(memberships)
      .values({ orgId: inv.orgId, userId: resolved.userId })
      .onConflictDoNothing();
    await tx
      .delete(userRoles)
      .where(and(eq(userRoles.userId, resolved.userId), eq(userRoles.orgId, inv.orgId)));
    await tx.insert(userRoles).values({
      userId: resolved.userId,
      roleId: inv.roleId,
      orgId: inv.orgId,
      assignedBy: inv.invitedByUserId,
    });
    await tx
      .update(invitations)
      .set({ status: "accepted", acceptedAt: new Date() })
      .where(eq(invitations.id, inv.id));
  });

  return NextResponse.json({ ok: true });
}
