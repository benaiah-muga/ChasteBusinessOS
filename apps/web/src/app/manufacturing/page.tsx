import { AppShell } from "@/components/AppShell";
import { apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function ManufacturingPage() {
  let data: {
    boms: { id: string; name: string }[];
    workOrders: { number: string; status: string; quantity: number }[];
  } = { boms: [], workOrders: [] };
  try {
    data = await apiFetch("/api/v1/manufacturing");
  } catch {
    /* empty */
  }

  return (
    <AppShell subtitle="Manufacturing — BOMs and work orders">
      <div className="grid">
        <section className="card">
          <h2>Bills of materials</h2>
          {data.boms.length === 0 ? (
            <p className="muted">No BOMs yet. Create via command mfg.bom.create.</p>
          ) : (
            <ul>
              {data.boms.map((b) => (
                <li key={b.id}>{b.name}</li>
              ))}
            </ul>
          )}
        </section>
        <section className="card">
          <h2>Work orders</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Status</th>
                <th>Qty</th>
              </tr>
            </thead>
            <tbody>
              {data.workOrders.map((w) => (
                <tr key={w.number}>
                  <td>{w.number}</td>
                  <td>{w.status}</td>
                  <td>{w.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </AppShell>
  );
}
