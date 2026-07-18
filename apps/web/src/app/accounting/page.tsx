import { AppShell } from "@/components/AppShell";
import { apiFetch } from "@/lib/api";
import { CreateInvoiceForm } from "@/components/CreateInvoiceForm";

export const dynamic = "force-dynamic";

export default async function AccountingPage() {
  let accounts: { code: string; name: string; type: string }[] = [];
  let invoices: { number: string; total: string; status: string; currency: string }[] = [];
  try {
    const a = await apiFetch<{ items: typeof accounts }>("/api/v1/accounting/accounts");
    const i = await apiFetch<{ items: typeof invoices }>("/api/v1/accounting/invoices");
    accounts = a.items;
    invoices = i.items;
  } catch {
    /* empty */
  }

  return (
    <AppShell subtitle="Accounting — chart of accounts, invoices, balanced journals">
      <div className="grid">
        <section className="card stack">
          <h2>Chart of accounts</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.code}>
                  <td className="mono">{a.code}</td>
                  <td>{a.name}</td>
                  <td>{a.type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card stack">
          <h2>Invoices</h2>
          <CreateInvoiceForm />
          <table className="table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Total</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.number}>
                  <td>{inv.number}</td>
                  <td>
                    {inv.total} {inv.currency}
                  </td>
                  <td>{inv.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </AppShell>
  );
}
