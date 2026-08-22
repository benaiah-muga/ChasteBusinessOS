import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { cookies } from "next/headers";
import { memberships, organizations } from "@chaste/db";
import { ACTIVE_ORG_COOKIE, getResolvedUser } from "@/server/session";
import { getDb } from "@chaste/db";

/** Orgs the signed-in user belongs to. */
export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const all = await getDb()
    .db.select({ id: organizations.id, name: organizations.name })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(eq(memberships.userId, resolved.userId));

  return NextResponse.json({ activeOrgId: resolved.orgId, orgs: all });
}

const bodySchema = z.object({ orgId: z.string().uuid() });

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = bodySchema.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const db = getDb().db;
  const [m] = await db
    .select()
    .from(memberships)
    .where(
      and(eq(memberships.orgId, body.data.orgId), eq(memberships.userId, resolved.userId)),
    )
    .limit(1);
  if (!m) return NextResponse.json({ error: "not a member of that organization" }, { status: 403 });

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_ORG_COOKIE, body.data.orgId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 90,
  });
  return NextResponse.json({ ok: true });
}
