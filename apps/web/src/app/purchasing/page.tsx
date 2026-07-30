import { AppShell } from "@/components/AppShell";
import { apiFetch } from "@/lib/api";
import { CreateVendorForm } from "@/components/CreateVendorForm";

export const dynamic = "force-dynamic";

export default async function PurchasingPage() {
  let data: {
    vendors: { id: string; name: string }[];
    orders: { number: string; status: string; total: string }[];
  } = { vendors: [], orders: [] };
  try {
    data = await apiFetch("/api/v1/purchasing");
  } catch {
    /* empty */
  }

  return (
    <AppShell subtitle="Purchasing — vendors and purchase orders">
      <div className="grid">
        <section className="card stack">
          <h2>Vendors</h2>
          <CreateVendorForm />
          <ul>
            {data.vendors.map((v) => (
              <li key={v.id}>{v.name}</li>
            ))}
          </ul>
        </section>
        <section className="card stack">
          <h2>Purchase orders</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Status</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {data.orders.map((o) => (
                <tr key={o.number}>
                  <td>{o.number}</td>
                  <td>{o.status}</td>
                  <td>{o.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </AppShell>
  );
}
