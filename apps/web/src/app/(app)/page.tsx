import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { getDb, organizations } from "@chaste/db";
import { getResolvedUser } from "@/server/session";
import { HomeDashboard } from "./home-dashboard";

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
