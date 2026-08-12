/**
 * Simple token-based auth resolver.
 * Looks up a user by their auth_token and returns the session user info.
 */
import { createHash } from "node:crypto";
import { eq, or } from "drizzle-orm";
import type { Db } from "./client.js";
import { apiKeys, organizations, users } from "./schema.js";
import { resolveUserPermissions } from "./adapters.js";

/**
 * Tokens are stored hashed at rest (SHA-256). The raw token is returned to the
 * inviter exactly once; the column only ever holds the digest.
 */
export function hashAuthToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Digest for API key secrets. Kept distinct from `hashAuthToken` as a reminder
 * that these are issued/looked-up the same way but represent machine scopes.
 */
export function hashApiKeySecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
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
      tokenExpiresAt: users.tokenExpiresAt,
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
  // F5 — reject expired tokens (null expiry = non-expiring, e.g. bootstrap admin).
  if (row.tokenExpiresAt && new Date(row.tokenExpiresAt).getTime() <= Date.now()) return null;

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

export interface ApiKeyPrincipal {
  apiKeyId: string;
  organizationId: string;
  orgName: string;
  region: string;
  name: string;
  scopes: string[];
  createdByUserId: string;
}

/**
 * Resolve an API key secret to its org-scoped principal. Returns null for an
 * unknown, revoked, or expired key. Honours `lastUsedAt` for audit visibility.
 */
export async function resolveApiKeyBySecret(
  db: Db,
  secret: string,
): Promise<ApiKeyPrincipal | null> {
  const rows = await db
    .select({
      apiKeyId: apiKeys.id,
      organizationId: apiKeys.organizationId,
      orgName: organizations.name,
      region: organizations.region,
      name: apiKeys.name,
      scopes: apiKeys.scopes,
      createdByUserId: apiKeys.createdByUserId,
      status: apiKeys.status,
      expiresAt: apiKeys.expiresAt,
    })
    .from(apiKeys)
    .innerJoin(organizations, eq(apiKeys.organizationId, organizations.id))
    .where(eq(apiKeys.hashedSecret, hashApiKeySecret(secret)))
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0]!;
  if (row.status !== "active") return null;
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) return null;

  // Best-effort last-used stamp (fire-and-forget; a failure here must not fail
  // the authenticated request that just succeeded).
  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, row.apiKeyId))
    .catch(() => {});

  return {
    apiKeyId: row.apiKeyId,
    organizationId: row.organizationId,
    orgName: row.orgName,
    region: row.region,
    name: row.name,
    scopes: row.scopes ?? [],
    createdByUserId: row.createdByUserId,
  };
}
