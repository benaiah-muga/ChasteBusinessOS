import { CheckCircle2, XCircle } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { getApiClient } from "@/lib/api";

export const dynamic = "force-dynamic";

function humanizeAction(action: string): string {
  const parts = action.split(".");
  if (parts.length < 2) return action;
  const modulePart = parts[0];
  const verb = parts[parts.length - 1];
  const middle = parts.slice(1, -1).join(" ");
  const nice = `${verb[0]?.toUpperCase()}${verb.slice(1)} ${middle} (${modulePart})`;
  return nice.replace(/\s+/g, " ").trim();
}

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
    <AppShell subtitle="Activity log for every operation across this workspace.">
      {error ? (
        <div className="card part-error">
          Cannot load audit log. {error}
        </div>
      ) : null}
      <section className="card stack">
        <div className="section-head">
          <div>
            <h2>Activity log</h2>
            <p className="muted">The latest 100 actions recorded for this workspace.</p>
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
                    <td title={item.action}>{humanizeAction(item.action)}</td>
                    <td>{item.actorKind}</td>
                    <td>{item.errorCode ? <span className="error">{item.errorCode}</span> : <span className="placeholder">none</span>}</td>
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
