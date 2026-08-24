import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb, invitations, memberships, scimTokens, users } from "@chaste/db";

/** SCIM 2.0 single-user resource: DELETE deactivates (removes membership). */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get("authorization") ?? "";
  const raw = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const hash = createHash("sha256").update(raw).digest("hex");
  const [token] = await getDb()
    .db.select()
    .from(scimTokens)
    .where(and(eq(scimTokens.tokenHash, hash), eq(scimTokens.active, true)))
    .limit(1);
  if (!token) {
    return NextResponse.json(
      { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "401", detail: "invalid or missing SCIM token" },
      { status: 401 },
    );
  }
  await getDb().db.update(scimTokens).set({ lastUsedAt: new Date() }).where(eq(scimTokens.id, token.id));

  const { id } = await params;
  const db = getDb().db;
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!user) return NextResponse.json({ status: "404" }, { status: 404 });

  await db.delete(memberships).where(and(eq(memberships.orgId, token.orgId), eq(memberships.userId, id)));
  await db
    .update(invitations)
    .set({ status: "revoked" })
    .where(and(eq(invitations.orgId, token.orgId), eq(invitations.email, user.email)));
  return new NextResponse(null, { status: 204 });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get("authorization") ?? "";
  const raw = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const hash = createHash("sha256").update(raw).digest("hex");
  const [token] = await getDb()
    .db.select()
    .from(scimTokens)
    .where(and(eq(scimTokens.tokenHash, hash), eq(scimTokens.active, true)))
    .limit(1);
  if (!token) {
    return NextResponse.json({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "401" }, { status: 401 });
  }
  const { id } = await params;
  const [user] = await getDb()
    .db.select({ id: users.id, email: users.email, name: users.name })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, token.orgId), eq(users.id, id)))
    .limit(1);
  if (!user) return NextResponse.json({ status: "404" }, { status: 404 });
  return NextResponse.json({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: user.id,
    userName: user.email,
    name: { givenName: user.name ?? undefined },
    emails: [{ value: user.email, primary: true }],
    active: true,
  });
}
