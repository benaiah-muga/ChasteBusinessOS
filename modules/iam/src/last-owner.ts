import { and, countDistinct, eq, ne } from "drizzle-orm";
import { roles, userRoles, type Database, type Tx } from "@chaste/db";

/**
 * Authority-loss protection (N07): the person who can approve, pay, and
 * reopen the books must never be removable by the same motion that manages
 * everyone else. Every path that strips a member's roles or membership —
 * role reassignment, invitation claim replacement, SCIM deactivation —
 * calls this first. The owner role is identified by its stable key, the
 * same one onboarding seeds (ADR 0053).
 */
export async function assertNotLastOwner(tx: Tx, orgId: string, userId: string): Promise<void> {
  const [held] = await tx
    .select({ id: roles.id })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(userRoles.userId, userId), eq(userRoles.orgId, orgId), eq(roles.key, "owner")))
    .limit(1);
  if (!held) return;

  const [others] = await tx
    .select({ n: countDistinct(userRoles.userId) })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(userRoles.orgId, orgId), eq(roles.key, "owner"), ne(userRoles.userId, userId)));
  if (Number(others?.n ?? 0) === 0) {
    throw new Error(
      "cannot remove the organization's last owner: grant the owner role to someone else first",
    );
  }
}

export type { Database };
