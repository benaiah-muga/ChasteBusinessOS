import { and, eq } from "drizzle-orm";
import { roles, userRoles, type Database, type Tx } from "@chaste/db";

/**
 * Authority-loss protection (N07): the person who can approve, pay, and
 * reopen the books must never be removable by the same motion that manages
 * everyone else. Every path that strips a member's roles or membership -
 * role reassignment, invitation claim replacement, SCIM deactivation -
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

  // The decision serializes on the owner grants themselves: the rows are
  // locked before counting, so two concurrent removals of the last two
  // owners cannot both observe "one other" - the loser blocks, then
  // recounts against the winner's commit and refuses. (FOR UPDATE with an
  // aggregate is rejected by Postgres, hence select-then-count in code.)
  const ownerGrants = await tx
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(userRoles.orgId, orgId), eq(roles.key, "owner")))
    .for("update");
  const others = ownerGrants.filter((g) => g.userId !== userId);
  if (others.length === 0) {
    throw new Error(
      "cannot remove the organization's last owner: grant the owner role to someone else first",
    );
  }
}

export type { Database };
