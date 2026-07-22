import { KeyRound, Shield, Users } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { Kpi } from "@/components/ui/Kpi";
import { getApiClient } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function RbacPage() {
  const api = getApiClient();
  let data: Awaited<ReturnType<typeof api.getRbacOverview>> = {
    roles: [],
    users: [],
    permissionCatalog: [],
  };
  try {
    data = await api.getRbacOverview();
  } catch {
    /* empty */
  }

  const permsByModule = new Map<string, number>();
  for (const p of data.permissionCatalog) {
    permsByModule.set(p.module, (permsByModule.get(p.module) ?? 0) + 1);
  }

  return (
    <AppShell subtitle="Roles, permissions, and team member assignments.">
      <div className="stack">
        <div className="kpi-grid">
          <Kpi label="Roles" value={data.roles.length} icon={Shield} />
          <Kpi label="Users" value={data.users.length} icon={Users} />
          <Kpi label="Permissions" value={data.permissionCatalog.length} icon={KeyRound} />
          <Kpi label="Modules covered" value={permsByModule.size} icon={KeyRound} />
        </div>

        <div className="grid">
          <section className="card stack">
            <div className="section-head">
              <div>
                <h2>Roles</h2>
                <p className="muted">Access bundles assigned to people in this workspace.</p>
              </div>
            </div>
            {data.roles.length === 0 ? (
              <p className="muted">No roles loaded.</p>
            ) : (
              data.roles.map((r) => (
                <div key={r.key} style={{ marginBottom: "1rem" }}>
                  <div className="row" style={{ gap: 8 }}>
                    <strong>{r.name}</strong>
                    {r.isSystem ? <span className="badge">system</span> : null}
                  </div>
                  <div className="muted" style={{ fontSize: "0.84rem", marginTop: 4 }}>
                    {r.permissions.length} permissions
                    {r.description ? ` · ${r.description}` : ""}
                  </div>
                </div>
              ))
            )}
          </section>

          <section className="card stack">
            <div className="section-head">
              <div>
                <h2>Team members</h2>
                <p className="muted">People with access to this workspace.</p>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Roles</th>
                  </tr>
                </thead>
                <tbody>
                  {data.users.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="muted">
                        No users loaded
                      </td>
                    </tr>
                  ) : (
                    data.users.map((u) => (
                      <tr key={u.email}>
                        <td>{u.displayName}</td>
                        <td>{u.email}</td>
                        <td>{u.roleKeys.join(", ") || "none"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <section className="card stack">
          <div className="section-head">
            <div>
              <h2>Permission catalog</h2>
              <p className="muted">
                {data.permissionCatalog.length} permissions across {permsByModule.size} modules
              </p>
            </div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Module</th>
                  <th>Permission</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {data.permissionCatalog.slice(0, 40).map((p) => (
                  <tr key={p.permission}>
                    <td>{p.module}</td>
                    <td className="mono">{p.permission}</td>
                    <td>{p.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
