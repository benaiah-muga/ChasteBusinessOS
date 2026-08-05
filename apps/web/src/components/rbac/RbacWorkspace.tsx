"use client";

import { useEffect, useMemo, useState } from "react";
import {
  KeyRound,
  LayoutDashboard,
  Loader2,
  Shield,
  Users,
} from "lucide-react";
import { BarSeries, ChartCard, DonutChart } from "@/components/ui/Chart";
import { Kpi } from "@/components/ui/Kpi";
import { Tab, TabPanel, Tabs } from "@/components/ui/Tabs";
import { getApiClient } from "@/lib/api";

type RbacRole = {
  id?: string;
  key: string;
  name: string;
  description?: string;
  permissions: string[];
  isSystem?: boolean;
};

type RbacUser = {
  id?: string;
  email: string;
  displayName: string;
  isActive: boolean;
  roleKeys: string[];
  createdAt?: string;
};

type RbacPermission = {
  permission: string;
  module: string;
  description: string;
};

export type RbacOverview = {
  roles: RbacRole[];
  users: RbacUser[];
  permissionCatalog: RbacPermission[];
};

export function RbacWorkspace({ initial }: { initial: RbacOverview }) {
  const [data, setData] = useState<RbacOverview>(initial);
  const [tab, setTab] = useState("overview");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setBusy(true);
    try {
      const next = await getRbacOverview();
      setData(next);
    } catch {
      /* keep existing */
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (initial.roles.length || initial.users.length || initial.permissionCatalog.length) return;
    void refresh();
  }, [initial]);

  const permsByModule = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of data.permissionCatalog) {
      map.set(p.module, (map.get(p.module) ?? 0) + 1);
    }
    return Array.from(map.entries())
      .map(([module, count]) => ({ module, count }))
      .sort((a, b) => b.count - a.count);
  }, [data.permissionCatalog]);

  const rolesDonut = useMemo(
    () =>
      data.roles.map((r) => ({
        name: r.name,
        value: Math.max(r.permissions.length, 1),
      })),
    [data.roles],
  );

  const moduleBars = useMemo(
    () => permsByModule.map((m) => ({ module: m.module, permissions: m.count })),
    [permsByModule],
  );

  return (
    <div className="stack">
      <Tabs defaultValue={tab} onValueChange={setTab}>
        <Tab label="Overview" icon={LayoutDashboard} value="overview" />
        <Tab label="Roles" icon={Shield} value="roles" count={data.roles.length} />
        <Tab label="Team members" icon={Users} value="users" count={data.users.length} />
        <Tab label="Permissions" icon={KeyRound} value="perms" count={data.permissionCatalog.length} />

        <TabPanel value="overview">
          <div className="kpi-grid">
            <Kpi label="Roles" value={data.roles.length} icon={Shield} />
            <Kpi label="Team members" value={data.users.length} icon={Users} />
            <Kpi label="Permissions" value={data.permissionCatalog.length} icon={KeyRound} />
            <Kpi label="Modules covered" value={permsByModule.length} icon={LayoutDashboard} />
          </div>

          <div className="grid">
            <ChartCard
              title="Permissions by module"
              subtitle="Coverage across installed capabilities"
              height={260}
            >
              <BarSeries
                data={moduleBars}
                keys={[{ key: "permissions", label: "Permissions" }]}
                xKey="module"
              />
            </ChartCard>

            <ChartCard
              title="Role composition"
              subtitle="Number of permissions bundled per role"
              height={260}
            >
              <DonutChart data={rolesDonut} />
            </ChartCard>
          </div>

          {busy ? (
            <p className="muted">
              <Loader2 size={14} /> Syncing access control state...
            </p>
          ) : null}
        </TabPanel>

        <TabPanel value="roles">
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
        </TabPanel>

        <TabPanel value="users">
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
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.users.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="muted">
                        No users loaded
                      </td>
                    </tr>
                  ) : (
                    data.users.map((u) => (
                      <tr key={u.email}>
                        <td>{u.displayName}</td>
                        <td>{u.email}</td>
                        <td>{u.roleKeys.join(", ") || "none"}</td>
                        <td>{u.isActive ? "Active" : "Disabled"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </TabPanel>

        <TabPanel value="perms">
          <section className="card stack">
            <div className="section-head">
              <div>
                <h2>Permission catalog</h2>
                <p className="muted">
                  {data.permissionCatalog.length} permissions across {permsByModule.length} modules
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
                  {data.permissionCatalog.map((p) => (
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
        </TabPanel>
      </Tabs>
    </div>
  );
}

async function getRbacOverview(): Promise<RbacOverview> {
  return (await getApiClient().getRbacOverview()) as RbacOverview;
}
