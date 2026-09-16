import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { organizations, roles, invitations, getDb } from "@chaste/db";
import { getResolvedUser } from "@/server/session";
import { claimInvitation } from "@/server/identity-lifecycle";
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

/** Accept: must be signed in as the invited email, mailbox verified. */
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

  // The whole claim is one row-locked transaction in the shared identity
  // lifecycle (N07): membership, role grant, and the accepted transition
  // commit together; a concurrent claimer gets exactly one winner.
  const result = await claimInvitation({
    token,
    userId: resolved.userId,
    email: resolved.email,
    emailVerified: resolved.emailVerified,
  });
  if (!result.ok) {
    const status =
      result.reason === "expired"
        ? 410
        : result.reason === "not_found" || result.reason === "revoked" || result.reason === "already_accepted"
          ? 404
          : 403;
    return NextResponse.json({ error: result.message }, { status });
  }
  return NextResponse.json({ ok: true });
}
