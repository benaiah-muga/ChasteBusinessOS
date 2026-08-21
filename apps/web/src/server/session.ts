import { headers } from "next/headers";
import { auth } from "@/server/auth";
import { resolveActorFromAuth } from "@/server/kernel";
import { getDb } from "@chaste/db";

export async function getResolvedUser() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.email) return null;
  return resolveActorFromAuth(session.user.email, session.user.name ?? null, getDb().db);
}
