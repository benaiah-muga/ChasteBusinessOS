import { AppShell } from "@/components/AppShell";
import { apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function RbacPage() {
  let data: {
    roles: { key: string; name: string; permissions: string[]; isSystem: boolean }[];
    users: { email: string; displayName: string; roleKeys: string[] }[];
    permissionCatalog: { permission: string; module: string; description: string }[];
  } = { roles: [], users: [], permissionCatalog: [] };
  try {
    data = await apiFetch("/api/v1/rbac");
  } catch {
    /* empty */
  }

  return (
    <AppShell subtitle="RBAC — roles, permissions, user assignments (production-grade model)">
      <div className="grid">
        <section className="card stack">
          <h2>Roles</h2>
          {data.roles.map((r) => (
            <div key={r.key} style={{ marginBottom: "1rem" }}>
              <strong>
                {r.name} <span className="mono">({r.key})</span>
              </strong>
              {r.isSystem ? <span className="badge">system</span> : null}
              <div className="mono muted" style={{ fontSize: "0.8rem" }}>
                {r.permissions.slice(0, 12).join(", ")}
                {r.permissions.length > 12 ? ` +${r.permissions.length - 12} more` : ""}
              </div>
            </div>
          ))}
        </section>
        <section className="card stack">
          <h2>Users</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Roles</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.email}>
                  <td>{u.displayName}</td>
                  <td>{u.email}</td>
                  <td className="mono">{u.roleKeys.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2>Permission catalog</h2>
          <p className="muted">{data.permissionCatalog.length} permissions across modules</p>
        </section>
      </div>
    </AppShell>
  );
}
