import { AppShell } from "@/components/AppShell";
import { InventoryWorkspace } from "@/components/inventory/InventoryWorkspace";
import { getApiClient } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function InventoryPage() {
  const api = getApiClient();
  let warehouses: Awaited<ReturnType<typeof api.listInventory>>["warehouses"] = [];
  let products: Awaited<ReturnType<typeof api.listInventory>>["products"] = [];
  let levels: Awaited<ReturnType<typeof api.listInventory>>["levels"] = [];
  try {
    const data = await api.listInventory();
    warehouses = data.warehouses;
    products = data.products;
    levels = data.levels;
  } catch {
    /* empty */
  }

  return (
    <AppShell subtitle="Warehouses, products, and stock levels across locations.">
      <InventoryWorkspace
        initialWarehouses={warehouses}
        initialProducts={products}
        initialLevels={levels}
      />
    </AppShell>
  );
}
