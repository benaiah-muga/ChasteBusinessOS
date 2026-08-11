import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { SettingsHub } from "@/components/settings/SettingsHub";
import { type SessionInfo } from "@/components/settings/GeneralPanel";
import { type RbacOverview } from "@/components/rbac/RbacWorkspace";
import { getApiClient } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const api = getApiClient();
  let session: SessionInfo | null = null;
  let rbac: RbacOverview = {
    roles: [],
    users: [],
    permissionCatalog: [],
  };
  try {
    session = (await api.session()) as unknown as SessionInfo;
  } catch {
    /* empty */
  }
  try {
    rbac = (await api.getRbacOverview()) as RbacOverview;
  } catch {
    /* empty */
  }

  return (
    <AppShell subtitle="Access, branches, data, and audit — workspace administration in one place.">
      <Suspense fallback={<div className="card">Loading settings…</div>}>
        <SettingsHub session={session} rbacInitial={rbac} />
      </Suspense>
    </AppShell>
  );
}
