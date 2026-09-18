import { headers } from "next/headers";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { auth } from "@/server/auth";
import { resolveActorFromAuth, resolveForOrg, type ResolvedUser } from "@/server/kernel";
import { getDb, memberships } from "@chaste/db";

export const ACTIVE_ORG_COOKIE = "chaste_active_org";

export interface SessionUser extends ResolvedUser {
  allOrgIds: string[];
  /**
   * Whether the auth account's mailbox is verified (N03): invitation claims
   * are pre-provisioned identity bindings, so an unverified account must
   * never inherit one.
   */
  emailVerified: boolean;
}

/**
 * Resolves the signed-in user against their *active* organization. Users may
 * belong to several orgs (a bookkeeper with three clients); the active one is
 * a per-session cookie, never a silent default that could route actions to
 * the wrong tenant.
 */
export async function getResolvedUser(): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.email) return null;
  const db = getDb().db;

  const base = await resolveActorFromAuth(session.user.email, session.user.name ?? null, db);
  const emailVerified = session.user.emailVerified === true;

  // N03 verified binding: a password account proves nothing about mailbox
  // ownership. Domain identities are pre-provisioned by SCIM and
  // invitations and bind by email, so an UNVERIFIED session resolves to a
  // bare identity — no memberships surfaced, no permissions — until the
  // address is demonstrated. Creating a brand-new org stays possible (it
  // claims nothing that existed before); pre-provisioned access waits for
  // the verified email or a trusted-IdP assertion.
  if (!emailVerified) {
    return {
      userId: base.userId,
      email: base.email,
      name: base.name,
      orgId: null,
      permissions: new Set<string>(),
      allOrgIds: [],
      emailVerified,
    };
  }

  const rows = await db
    .select({ orgId: memberships.orgId })
    .from(memberships)
    .where(eq(memberships.userId, base.userId));
  const allOrgIds = rows.map((r) => r.orgId);
  if (allOrgIds.length === 0) return { ...base, allOrgIds, emailVerified };

  const cookieStore = await cookies();
  const requested = cookieStore.get(ACTIVE_ORG_COOKIE)?.value;
  const activeOrgId =
    requested && allOrgIds.includes(requested) ? requested : base.orgId ?? allOrgIds[0]!;

  const resolved: ResolvedUser =
    activeOrgId === base.orgId ? base : await resolveForOrg(base.userId, activeOrgId, db);

  return { ...resolved, allOrgIds, emailVerified };
}
