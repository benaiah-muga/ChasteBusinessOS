/**
 * Simple token-based auth resolver.
 * Looks up a user by their auth_token and returns the session user info.
 */
import { createHash } from "node:crypto";
import { eq, or } from "drizzle-orm";
import type { Db } from "./client.js";
import { organizations, users } from "./schema.js";
import { resolveUserPermissions } from "./adapters.js";

/**
 * Tokens are stored hashed at rest (SHA-256). The raw token is returned to the
 * inviter exactly once; the column only ever holds the digest.
 */
export function hashAuthToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface AuthenticatedUser {
  userId: string;
  organizationId: string;
  email: string;
  displayName: string;
  isActive: boolean;
  permissions: string[];
  autonomy: string;
  orgName: string;
  region: string;
}

export async function resolveUserByToken(
  db: Db,
  authToken: string,
): Promise<AuthenticatedUser | null> {
  const rows = await db
    .select({
      userId: users.id,
      organizationId: users.organizationId,
      email: users.email,
      displayName: users.displayName,
      isActive: users.isActive,
      autonomy: organizations.autonomy,
      orgName: organizations.name,
      region: organizations.region,
    })
    .from(users)
    .innerJoin(organizations, eq(users.organizationId, organizations.id))
    // Match the hashed digest first; fall back to legacy plaintext rows so
    // pre-hashing databases (and dev fixtures) keep authenticating.
    .where(or(eq(users.authToken, hashAuthToken(authToken)), eq(users.authToken, authToken)))
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0]!;
  if (!row.isActive) return null;

  const permissions = await resolveUserPermissions(db, row.userId);

  return {
    userId: row.userId,
    organizationId: row.organizationId,
    email: row.email,
    displayName: row.displayName,
    isActive: row.isActive,
    permissions,
    autonomy: row.autonomy,
    orgName: row.orgName,
    region: row.region,
  };
}
