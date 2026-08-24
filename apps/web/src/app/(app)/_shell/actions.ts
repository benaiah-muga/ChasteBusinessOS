"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb, memberships } from "@chaste/db";
import { ACTIVE_ORG_COOKIE, getResolvedUser } from "@/server/session";

export async function switchOrgAction(orgId: string) {
  const resolved = await getResolvedUser();
  if (resolved) {
    // Mirror /api/org POST: the cookie is only set for orgs the user actually
    // belongs to. getResolvedUser re-validates on read, but writing a forged
    // tenant hint here would make the two trust boundaries diverge.
    const [member] = await getDb()
      .db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, resolved.userId)))
      .limit(1);
    if (member) {
      const cookieStore = await cookies();
      cookieStore.set(ACTIVE_ORG_COOKIE, orgId, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 90,
      });
    }
  }
  redirect("/");
}
