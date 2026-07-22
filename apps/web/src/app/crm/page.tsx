import { AppShell } from "@/components/AppShell";
import { CrmWorkspace } from "@/components/crm/CrmWorkspace";
import { getApiClient } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function CrmPage() {
  const api = getApiClient();
  let customers: Awaited<ReturnType<typeof api.listCustomers>>["items"] = [];
  try {
    customers = (await api.listCustomers()).items;
  } catch {
    /* empty */
  }
  return (
    <AppShell subtitle="Manage customer relationships, contacts, and the sales pipeline.">
      <CrmWorkspace initialCustomers={customers} />
    </AppShell>
  );
}
