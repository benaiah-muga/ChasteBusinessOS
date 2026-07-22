import { AppShell } from "@/components/AppShell";
import { WorkflowsWorkspace } from "@/components/workflows/WorkflowsWorkspace";
import { getApiClient } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function WorkflowsPage() {
  const api = getApiClient();
  let workflows: Awaited<ReturnType<typeof api.listWorkflows>>["items"] = [];
  try {
    workflows = (await api.listWorkflows()).items;
  } catch {
    /* empty */
  }

  return (
    <AppShell subtitle="Design, run, and monitor multi-step business processes.">
      <WorkflowsWorkspace initialWorkflows={workflows} />
    </AppShell>
  );
}
