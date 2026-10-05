import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb, memberships, scimTokens, users } from "@chaste/db";
import { deactivateMember } from "@/server/identity-lifecycle";
import { requestIp, scimAuthLimit } from "@/server/rate-limit";

const scimError = (status: number, detail: string) =>
  NextResponse.json(
    { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: String(status), detail },
    { status },
  );

async function resolveScimToken(req: NextRequest) {
  if (!scimAuthLimit(requestIp(req)).allowed) return null;
  const auth = req.headers.get("authorization") ?? "";
  const raw = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!raw) return null;
  const hash = createHash("sha256").update(raw).digest("hex");
  const [token] = await getDb()
    .db.select()
    .from(scimTokens)
    .where(and(eq(scimTokens.tokenHash, hash), eq(scimTokens.active, true)))
    .limit(1);
  if (!token || (token.expiresAt && token.expiresAt.getTime() <= Date.now())) return null;
  await getDb().db.update(scimTokens).set({ lastUsedAt: new Date() }).where(eq(scimTokens.id, token.id));
  return token;
}

/** SCIM 2.0 single-user resource: DELETE deactivates (removes all authority). */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = await resolveScimToken(req);
  if (!token) return scimError(401, "invalid or missing SCIM token");

  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return scimError(404, "user not found");
  }
  const [user] = await getDb().db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!user) return scimError(404, "user not found");

  // One transaction removes membership, role grants, and pending invitations
  // (N07) - an IdP disable can no longer leave a half-live identity, and the
  // org's last owner is protected rather than silently deprovisioned.
  const result = await deactivateMember({ orgId: token.orgId, userId: id });
  if (!result.ok) {
    return result.reason === "last_owner"
      ? scimError(409, result.message)
      : scimError(404, "user not found");
  }
  return new NextResponse(null, { status: 204 });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = await resolveScimToken(req);
  if (!token) return scimError(401, "invalid or missing SCIM token");
  const { id } = await params;
  const [user] = await getDb()
    .db.select({ id: users.id, email: users.email, name: users.name })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, token.orgId), eq(users.id, id)))
    .limit(1);
  if (!user) return scimError(404, "user not found");
  return NextResponse.json({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: user.id,
    userName: user.email,
    name: { givenName: user.name ?? undefined },
    emails: [{ value: user.email, primary: true }],
    active: true,
  });
}
