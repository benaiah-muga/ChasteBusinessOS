"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { ClipboardList, Database, GitBranch, KeyRound, Settings2 } from "lucide-react";
import { RbacWorkspace, type RbacOverview } from "@/components/rbac/RbacWorkspace";
import { GeneralPanel, type SessionInfo } from "@/components/settings/GeneralPanel";
import { BranchesPanel } from "@/components/settings/BranchesPanel";
import { DataPanel } from "@/components/settings/DataPanel";
import { AuditPanel } from "@/components/settings/AuditPanel";
import { Tab, TabPanel, Tabs } from "@/components/ui/Tabs";

const TABS = ["general", "access", "branches", "data", "audit"] as const;
type TabId = (typeof TABS)[number];

function readTab(params: URLSearchParams): TabId {
  const t = params.get("tab");
  return (TABS as readonly string[]).includes(t ?? "") ? (t as TabId) : "general";
}

export function SettingsHub({
  session,
  rbacInitial,
}: {
  session: SessionInfo | null;
  rbacInitial: RbacOverview;
}) {
  const params = useSearchParams();
  const router = useRouter();
  const tab = readTab(params);

  function onValueChange(v: string) {
    const sp = new URLSearchParams(params.toString());
    sp.set("tab", v);
    router.replace(`?${sp.toString()}`, { scroll: false });
  }

  return (
    <Tabs value={tab} onValueChange={onValueChange} defaultValue="general">
      <Tab value="general" label="General" icon={Settings2} />
      <Tab value="access" label="Access" icon={KeyRound} />
      <Tab value="branches" label="Branches" icon={GitBranch} />
      <Tab value="data" label="Data" icon={Database} />
      <Tab value="audit" label="Audit" icon={ClipboardList} />

      <TabPanel value="general">
        <GeneralPanel session={session} />
      </TabPanel>
      <TabPanel value="access">
        <RbacWorkspace initial={rbacInitial} />
      </TabPanel>
      <TabPanel value="branches">
        <BranchesPanel />
      </TabPanel>
      <TabPanel value="data">
        <DataPanel />
      </TabPanel>
      <TabPanel value="audit">
        <AuditPanel />
      </TabPanel>
    </Tabs>
  );
}
