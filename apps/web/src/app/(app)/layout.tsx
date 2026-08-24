import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { approvals, getDb, memberships, organizations } from "@chaste/db";
import { getResolvedUser } from "@/server/session";
import { buildRegistry, hasPermissionFor } from "@/server/kernel";
import { AppShell } from "./app-shell";
import { OrgSwitcher } from "./_shell/org-switcher";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const resolved = await getResolvedUser();
  if (!resolved) redirect("/login");
  if (!resolved.orgId) redirect("/onboarding");

  const db = getDb().db;

  const [orgs, pendingRows] = await Promise.all([
    db
      .select({ id: organizations.id, name: organizations.name })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.orgId))
      .where(eq(memberships.userId, resolved.userId)),
    db
      .select({ capabilityId: approvals.capabilityId })
      .from(approvals)
      .where(and(eq(approvals.orgId, resolved.orgId), eq(approvals.status, "pending")))
      .limit(100),
  ]);

  const registry = buildRegistry(db);
  const pendingApprovals = pendingRows.filter((r) => {
    const cap = registry.get(r.capabilityId);
    return cap ? hasPermissionFor({ permissions: resolved.permissions }, cap.permission) : false;
  }).length;

  return (
    <AppShell
      user={{ name: resolved.name ?? "", email: resolved.email }}
      pendingApprovals={pendingApprovals}
      enabledModules={resolved.enabledModules ?? null}
      orgSwitcher={orgs.length > 1 ? <OrgSwitcher orgs={orgs} activeId={resolved.orgId} /> : undefined}
    >
      {children}
    </AppShell>
  );
}
