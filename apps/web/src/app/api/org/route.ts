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

const soulSchema = z.object({ agentSoul: z.string().max(8000) });

/**
 * Updates the org's standing agent persona (SOUL). Admin-gated: this text
 * steers every agent turn for the whole organization.
 */
export async function PATCH(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!resolved.permissions.has("iam.admin") && !resolved.permissions.has("*")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = soulSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const db = getDb().db;
  await db
    .update(organizations)
    .set({ agentSoul: body.data.agentSoul.trim() || null })
    .where(eq(organizations.id, resolved.orgId));
  return NextResponse.json({ ok: true });
}

/** Returns the org's current SOUL text for the settings editor. */
export async function PUT() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const [org] = await getDb()
    .db.select({ agentSoul: organizations.agentSoul })
    .from(organizations)
    .where(eq(organizations.id, resolved.orgId))
    .limit(1);
  return NextResponse.json({ agentSoul: org?.agentSoul ?? "" });
}
