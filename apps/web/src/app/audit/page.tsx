import { CheckCircle2, XCircle } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { getApiClient } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const api = getApiClient();
  let items: Awaited<ReturnType<typeof api.listAudit>>["items"] = [];
  let error: string | null = null;
  try {
    items = (await api.listAudit()).items;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load audit log";
  }

  return (
    <AppShell subtitle="Audit trail for command and query execution.">
      {error ? (
        <div className="card part-error">
          Cannot load audit log. {error}
        </div>
      ) : null}
      <section className="card stack">
        <div className="section-head">
          <div>
            <h2>Audit log</h2>
            <p className="muted">The latest 100 backend audit entries for this organization.</p>
          </div>
          <span className="badge accent">{items.length} entries</span>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Action</th>
                <th>Actor</th>
                <th>Error</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    {error ? "Unavailable while API is offline." : "No audit events yet."}
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <span className={item.success ? "badge" : "badge danger"}>
                        {item.success ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                        {item.success ? "Success" : "Failed"}
                      </span>
                    </td>
                    <td className="mono">{item.action}</td>
                    <td>{item.actorKind}</td>
                    <td>{item.errorCode ?? "—"}</td>
                    <td>{new Date(item.at).toLocaleString()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}
