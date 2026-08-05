import { AppShell } from "@/components/AppShell";
import { RbacWorkspace, type RbacOverview } from "@/components/rbac/RbacWorkspace";
import { getApiClient } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function RbacPage() {
  const api = getApiClient();
  let data: RbacOverview = {
    roles: [],
    users: [],
    permissionCatalog: [],
  };
  try {
    data = (await api.getRbacOverview()) as RbacOverview;
  } catch {
    /* empty */
  }

  return (
    <AppShell subtitle="Roles, permissions, and team member assignments.">
      <RbacWorkspace initial={data} />
    </AppShell>
  );
}
