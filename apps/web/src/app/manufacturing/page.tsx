import { AppShell } from "@/components/AppShell";
import { ManufacturingWorkspace } from "@/components/manufacturing/ManufacturingWorkspace";
import { getApiClient } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function ManufacturingPage() {
  const api = getApiClient();
  let boms: Awaited<ReturnType<typeof api.listManufacturing>>["boms"] = [];
  let workOrders: Awaited<ReturnType<typeof api.listManufacturing>>["workOrders"] = [];
  try {
    const data = await api.listManufacturing();
    boms = data.boms;
    workOrders = data.workOrders;
  } catch {
    /* empty */
  }

  return (
    <AppShell subtitle="Bills of materials, production orders, and work execution.">
      <ManufacturingWorkspace initialBoms={boms} initialWorkOrders={workOrders} />
    </AppShell>
  );
}
