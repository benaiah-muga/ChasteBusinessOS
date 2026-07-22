import { AppShell } from "@/components/AppShell";
import { PurchasingWorkspace } from "@/components/purchasing/PurchasingWorkspace";
import { getApiClient } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function PurchasingPage() {
  const api = getApiClient();
  let vendors: Awaited<ReturnType<typeof api.listPurchasing>>["vendors"] = [];
  let orders: Awaited<ReturnType<typeof api.listPurchasing>>["orders"] = [];
  try {
    const data = await api.listPurchasing();
    vendors = data.vendors;
    orders = data.orders;
  } catch {
    /* empty */
  }

  return (
    <AppShell subtitle="Vendors and purchase orders for procurement.">
      <PurchasingWorkspace initialVendors={vendors} initialOrders={orders} />
    </AppShell>
  );
}
