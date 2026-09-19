import { and, eq, sql } from "drizzle-orm";
import {
  getDb,
  invitations,
  memberships,
  roles,
  userRoles,
  users,
  type Database,
} from "@chaste/db";
import { assertNotLastOwner } from "@chaste/module-iam";

/**
 * Shared identity lifecycle (N07/N03): the one place that turns an
 * invitation into authority and the one place that takes authority away.
 * Both transitions are single transactions with row-locked claims, so two
 * concurrent callers get exactly one winner, and no path can strand the
 * organization without an owner. Routes stay thin adapters; every domain
 * effect lives here where it is testable without HTTP.
 */

export type ClaimInvitationResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "not_found"
        | "expired"
        | "revoked"
        | "already_accepted"
        | "email_mismatch"
        | "unverified_email";
      message: string;
    };

export interface ClaimInvitationInput {
  token: string;
  userId: string;
  /** The authenticated account's address, compared case-insensitively. */
  email: string;
  /**
   * N03: an invitation is a pre-provisioned identity binding. Claiming one
   * with an unverified mailbox would let whoever registers a claimed address
   * inherit its authority, so verification is required.
   */
  emailVerified: boolean;
}

export async function claimInvitation(
  input: ClaimInvitationInput,
  db: Database["db"] = getDb().db,
): Promise<ClaimInvitationResult> {
  return db.transaction(async (tx) => {
    // Row lock: the whole claim serializes on this invitation row, so two
    // concurrent accepts cannot both pass the pending check.
    const [inv] = await tx
      .select()
      .from(invitations)
      .where(eq(invitations.token, input.token))
      .for("update")
      .limit(1);
    if (!inv) return { ok: false, reason: "not_found", message: "invitation is not valid" };
    if (inv.status === "accepted")
      return { ok: false, reason: "already_accepted", message: "invitation was already used" };
    if (inv.status === "revoked")
      return { ok: false, reason: "revoked", message: "invitation was revoked" };
    if (inv.status !== "pending")
      return { ok: false, reason: "not_found", message: "invitation is not valid" };
    if (inv.expiresAt < new Date()) {
      await tx.update(invitations).set({ status: "expired" }).where(eq(invitations.id, inv.id));
      return { ok: false, reason: "expired", message: "invitation expired" };
    }
    if (input.email.toLowerCase() !== inv.email.toLowerCase()) {
      return { ok: false, reason: "email_mismatch", message: `this invitation was sent to ${inv.email}` };
    }
    if (!input.emailVerified) {
      return {
        ok: false,
        reason: "unverified_email",
        message: "verify your email address before accepting invitations",
      };
    }

    // Replacing this member's roles must never strand the org without an
    // owner - a current owner re-claiming a lesser invite is refused here
    // exactly as they would be in iam.assignRole (N07).
    const [targetRole] = await tx
      .select({ key: roles.key })
      .from(roles)
      .where(eq(roles.id, inv.roleId))
      .limit(1);
    if (targetRole?.key !== "owner") {
      await assertNotLastOwner(tx, inv.orgId, input.userId);
    }

    await tx
      .insert(memberships)
      .values({ orgId: inv.orgId, userId: input.userId })
      .onConflictDoNothing();
    await tx
      .delete(userRoles)
      .where(and(eq(userRoles.userId, input.userId), eq(userRoles.orgId, inv.orgId)));
    await tx.insert(userRoles).values({
      userId: input.userId,
      roleId: inv.roleId,
      orgId: inv.orgId,
      assignedBy: inv.invitedByUserId,
    });
    // Compare-and-set against the locked row: the winner writes accepted,
    // and the row lock guarantees the loser never reaches this statement.
    await tx
      .update(invitations)
      .set({ status: "accepted", acceptedAt: new Date() })
      .where(and(eq(invitations.id, inv.id), eq(invitations.status, "pending")));
    return { ok: true };
  });
}

export type DeactivateResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "last_owner"; message: string };

/**
 * N07: deactivation removes ALL authority in one motion - membership, role
 * grants, and pending invitations - so an IdP-driven disable cannot leave a
 * half-live identity behind, and re-provisioning starts from least
 * privilege. Historical attribution is never destroyed.
 */
export async function deactivateMember(
  input: { orgId: string; userId: string },
  db: Database["db"] = getDb().db,
): Promise<DeactivateResult> {
  return db.transaction(async (tx) => {
    const [member] = await tx
      .select({ email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.orgId, input.orgId), eq(memberships.userId, input.userId)))
      .limit(1);
    if (!member) return { ok: false, reason: "not_found", message: "member not found" };
    try {
      await assertNotLastOwner(tx, input.orgId, input.userId);
    } catch {
      return {
        ok: false,
        reason: "last_owner",
        message: "cannot deactivate the organization's last owner",
      };
    }
    await tx
      .delete(memberships)
      .where(and(eq(memberships.orgId, input.orgId), eq(memberships.userId, input.userId)));
    await tx
      .delete(userRoles)
      .where(and(eq(userRoles.orgId, input.orgId), eq(userRoles.userId, input.userId)));
    await tx
      .update(invitations)
      .set({ status: "revoked" })
      .where(
        and(
          eq(invitations.orgId, input.orgId),
          eq(invitations.status, "pending"),
          sql`lower(${invitations.email}) = lower(${member.email})`,
        ),
      );
    return { ok: true };
  });
}
