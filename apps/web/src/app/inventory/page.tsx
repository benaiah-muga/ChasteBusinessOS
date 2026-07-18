import { AppShell } from "@/components/AppShell";
import { apiFetch } from "@/lib/api";
import { CreateProductForm } from "@/components/CreateProductForm";

export const dynamic = "force-dynamic";

export default async function InventoryPage() {
  let data: {
    warehouses: { code: string; name: string }[];
    products: { sku: string; name: string }[];
    levels: { quantity: number }[];
  } = { warehouses: [], products: [], levels: [] };
  try {
    data = await apiFetch("/api/v1/inventory/stock");
  } catch {
    /* empty */
  }

  return (
    <AppShell subtitle="Inventory — warehouses, products, stock levels">
      <div className="grid">
        <section className="card stack">
          <h2>Warehouses</h2>
          <ul>
            {data.warehouses.map((w) => (
              <li key={w.code}>
                <span className="mono">{w.code}</span> — {w.name}
              </li>
            ))}
          </ul>
          <h2>Products</h2>
          <CreateProductForm />
          <table className="table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Name</th>
              </tr>
            </thead>
            <tbody>
              {data.products.map((p) => (
                <tr key={p.sku}>
                  <td className="mono">{p.sku}</td>
                  <td>{p.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card">
          <h2>Stock levels</h2>
          <p className="muted">{data.levels.length} stock rows</p>
        </section>
      </div>
    </AppShell>
  );
}
