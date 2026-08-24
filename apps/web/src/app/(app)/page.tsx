import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { getDb, organizations } from "@chaste/db";
import { getResolvedUser } from "@/server/session";
import { HomeDashboard } from "./home-dashboard";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = { title: "Home" };

export default async function HomePage() {
  const resolved = await getResolvedUser();
  let orgName = "";
  if (resolved?.orgId) {
    const [org] = await getDb()
      .db.select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, resolved.orgId))
      .limit(1);
    orgName = org?.name ?? "";
  }
  return <HomeDashboard orgName={orgName} />;
}
