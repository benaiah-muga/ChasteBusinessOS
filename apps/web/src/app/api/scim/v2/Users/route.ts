import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { getDb, invitations, memberships, scimTokens, users } from "@chaste/db";
import { scimAuthLimit, requestIp } from "@/server/rate-limit";

/**
 * SCIM 2.0 user provisioning (groundwork): list, create, and deactivate
 * members under an IdP's control. Auth is a SCIM bearer token scoped to one
 * org; the raw token never leaves creation time, only its SHA-256 persists.
 */

interface ScimUser {
  id?: string;
  userName?: string;
  name?: { givenName?: string; familyName?: string };
  active?: boolean;
  emails?: { value: string; primary?: boolean }[];
}

const scimError = (status: number, detail: string) =>
  NextResponse.json(
    { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: String(status), detail },
    { status },
  );

async function resolveOrg(req: Request): Promise<string | null> {
  const limit = scimAuthLimit(requestIp(req));
  if (!limit.allowed) return null;
  const auth = req.headers.get("authorization") ?? "";
  const raw = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!raw) return null;
  const hash = createHash("sha256").update(raw).digest("hex");
  const [token] = await getDb()
    .db.select()
    .from(scimTokens)
    .where(and(eq(scimTokens.tokenHash, hash), eq(scimTokens.active, true)))
    .limit(1);
  if (!token) return null;
  await getDb()
    .db.update(scimTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(scimTokens.id, token.id));
  return token.orgId;
}

function toScimUser(u: { id: string; email: string; name: string | null }, active: boolean): ScimUser {
  return {
    id: u.id,
    userName: u.email,
    name: { givenName: u.name ?? undefined },
    emails: [{ value: u.email, primary: true }],
    active,
  };
}

export async function GET(req: Request) {
  const orgId = await resolveOrg(req);
  if (!orgId) return scimError(401, "invalid or missing SCIM token");
  const db = getDb().db;
  const filter = new URL(req.url).searchParams.get("filter") ?? "";
  const eqMatch = /userName\s+eq\s+"([^"]+)"/i.exec(filter);

  const rows = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.orgId, orgId));

  const matched = eqMatch ? rows.filter((r) => r.email.toLowerCase() === eqMatch[1]!.toLowerCase()) : rows;
  return NextResponse.json({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: matched.length,
    Resources: matched.map((r) => toScimUser(r, true)),
  });
}

export async function POST(req: Request) {
  const orgId = await resolveOrg(req);
  if (!orgId) return scimError(401, "invalid or missing SCIM token");
  const body = (await req.json().catch(() => null)) as ScimUser | null;
  const email = (body?.emails?.find((e) => e.primary)?.value ?? body?.userName ?? "")
    .trim()
    .toLowerCase();
  if (!email) return scimError(400, "userName or a primary email is required");

  const db = getDb().db;
  // Emails are matched case-insensitively everywhere else in the identity
  // path; normalizing at provisioning prevents split domain identities that
  // would silently detach an account from its memberships and roles.
  let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) {
    [user] = await db
      .insert(users)
      .values({ email, name: body?.name?.givenName ?? null })
      .returning();
  }
  if (!user) return scimError(500, "failed to provision user");

  const existing = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, user.id)))
    .limit(1);

  if (existing.length === 0) {
    // Provisioning grants membership only, role assignment stays a governed,
    // human-approved action (identity class), per standing principle #2.
    await db.insert(memberships).values({ orgId, userId: user!.id }).onConflictDoNothing();
  }

  return NextResponse.json(
    { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], ...toScimUser(user!, true) },
    { status: 201 },
  );
}

/** Deactivation removes org membership but keeps the domain user stable. */
export async function DELETE(req: Request) {
  const orgId = await resolveOrg(req);
  if (!orgId) return scimError(401, "invalid or missing SCIM token");
  const id = new URL(req.url).pathname.split("/").pop() ?? "";
  const [user] = await getDb().db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!user) return scimError(404, "user not found");
  await getDb()
    .db.delete(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, id)));
  await getDb()
    .db.update(invitations)
    .set({ status: "revoked" })
    .where(and(eq(invitations.orgId, orgId), eq(invitations.email, user.email)));
  return NextResponse.json(null, { status: 204 });
}
