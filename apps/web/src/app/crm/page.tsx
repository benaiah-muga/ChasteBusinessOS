import { AppShell } from "@/components/AppShell";
import { CustomersPanel } from "@/components/CustomersPanel";
import { getApiClient } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function CrmPage() {
  const api = getApiClient();
  let customers: Awaited<ReturnType<typeof api.listCustomers>>["items"] = [];
  try {
    customers = (await api.listCustomers()).items;
  } catch {
    /* handled empty */
  }
  return (
    <AppShell subtitle="CRM — customers via POST /api/v1/crm/customers → crm.customer.create">
      <CustomersPanel initialCustomers={customers} />
    </AppShell>
  );
}
