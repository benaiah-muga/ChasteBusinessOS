"use client";

import { useMemo, useState } from "react";
import {
  Archive,
  Boxes,
  CheckCircle2,
  Download,
  LayoutDashboard,
  PackageOpen,
  Puzzle,
  Trash2,
} from "lucide-react";
import { BarSeries, ChartCard, DonutChart } from "@/components/ui/Chart";
import { Kpi } from "@/components/ui/Kpi";
import { Tab, TabPanel, Tabs } from "@/components/ui/Tabs";
import { getApiClient } from "@/lib/api";

export type MarketplaceItem = {
  moduleId: string;
  name: string;
  version: string;
  summary: string;
  category: string;
  publisher: string;
  regions: string[];
  kind: "builtin" | "custom";
  archived: boolean;
  installed: boolean;
  enabled: boolean;
};

export function MarketplaceWorkspace({
  initialItems,
  platformRegions,
}: {
  initialItems: MarketplaceItem[];
  platformRegions: string[];
}) {
  const [items, setItems] = useState(initialItems);
  const [tab, setTab] = useState("overview");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function refresh() {
    try {
      const data = (await getApiClient().getMarketplace()) as {
        items: MarketplaceItem[];
        platformRegions?: string[];
      };
      // hide archived always on UI
      setItems((data.items ?? []).filter((i) => !i.archived));
    } catch {
      /* keep */
    }
  }

  const visible = useMemo(() => items.filter((i) => !i.archived), [items]);
  const builtin = visible.filter((i) => i.kind === "builtin");
  const custom = visible.filter((i) => i.kind === "custom");
  const installed = visible.filter((i) => i.installed && i.enabled);
  const available = visible.filter((i) => !i.installed || !i.enabled);

  const byCategory = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of visible) m.set(i.category, (m.get(i.category) ?? 0) + 1);
    return Array.from(m, ([name, value]) => ({ name, value }));
  }, [visible]);

  const byKind = useMemo(
    () => [
      { name: "Built-in", value: builtin.length || 0.01 },
      { name: "Custom", value: custom.length || 0.01 },
    ],
    [builtin.length, custom.length],
  );

  async function install(moduleId: string, version: string) {
    setBusyId(moduleId);
    setMsg(null);
    try {
      await getApiClient().installModule({ moduleId, version });
      setMsg(`Installed ${moduleId}`);
      await refresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Install failed");
    } finally {
      setBusyId(null);
    }
  }

  async function uninstall(moduleId: string) {
    if (!window.confirm(`Uninstall ${moduleId}? Its data remains in the database, but it will leave the workspace apps list.`)) {
      return;
    }
    setBusyId(moduleId);
    setMsg(null);
    try {
      await getApiClient().uninstallModule({ moduleId });
      setMsg(`Uninstalled ${moduleId}`);
      await refresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Uninstall failed");
    } finally {
      setBusyId(null);
    }
  }

  async function archive(moduleId: string) {
    if (!window.confirm(`Archive listing for ${moduleId}? It will no longer appear in the marketplace.`)) {
      return;
    }
    setBusyId(moduleId);
    setMsg(null);
    try {
      await getApiClient().archiveMarketplaceListing({ moduleId, archived: true });
      setMsg(`Archived ${moduleId}`);
      await refresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Archive failed");
    } finally {
      setBusyId(null);
    }
  }

  function ModuleCard({ item }: { item: MarketplaceItem }) {
    const isInstalled = item.installed && item.enabled;
    return (
      <article className="card stack" style={{ display: "flex", flexDirection: "column", minHeight: 220 }}>
        <div className="section-head" style={{ marginBottom: 8 }}>
          <div>
            <h2 style={{ margin: 0 }}>{item.name}</h2>
            <p className="muted" style={{ margin: "4px 0 0" }}>
              v{item.version} · {item.publisher}
            </p>
          </div>
          {isInstalled ? (
            <span className="badge accent">
              <CheckCircle2 size={14} /> Installed
            </span>
          ) : (
            <span className="badge">Available</span>
          )}
        </div>
        <p style={{ flex: 1, margin: 0 }}>{item.summary}</p>
        <div className="row" style={{ gap: 6 }}>
          <span className="badge">{item.category}</span>
          <span className="badge">{item.kind === "builtin" ? "Built-in" : "Custom"}</span>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          {isInstalled ? (
            <button
              className="btn secondary"
              type="button"
              disabled={busyId === item.moduleId}
              onClick={() => uninstall(item.moduleId)}
            >
              <Trash2 size={15} />
              {busyId === item.moduleId ? "Uninstalling..." : "Uninstall"}
            </button>
          ) : (
            <button
              className="btn"
              type="button"
              disabled={busyId === item.moduleId}
              onClick={() => install(item.moduleId, item.version)}
            >
              <Download size={15} />
              {busyId === item.moduleId ? "Installing..." : "Install"}
            </button>
          )}
          {item.kind === "custom" ? (
            <button
              className="btn secondary"
              type="button"
              disabled={busyId === item.moduleId}
              onClick={() => archive(item.moduleId)}
            >
              <Archive size={15} />
              Archive
            </button>
          ) : null}
        </div>
      </article>
    );
  }

  function ModuleGrid({ list }: { list: MarketplaceItem[] }) {
    if (list.length === 0) {
      return (
        <div className="empty-state">
          <div className="icon">
            <PackageOpen size={20} />
          </div>
          <h3>No modules here</h3>
          <p>Nothing matches this filter right now.</p>
        </div>
      );
    }
    return (
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
        {list.map((item) => (
          <ModuleCard key={item.moduleId} item={item} />
        ))}
      </div>
    );
  }

  return (
    <Tabs defaultValue="overview" value={tab} onValueChange={setTab}>
      <Tab label="Overview" icon={LayoutDashboard} value="overview" />
      <Tab label="Built-in" icon={Boxes} value="builtin" count={builtin.length} />
      <Tab label="Custom" icon={Puzzle} value="custom" count={custom.length} />
      <Tab label="Installed" icon={CheckCircle2} value="installed" count={installed.length} />
      <Tab label="Available" icon={Download} value="available" count={available.length} />

      <TabPanel value="overview">
        <div className="stack">
          {msg ? <p className={msg.includes("fail") || msg.includes("Failed") ? "error" : "muted"}>{msg}</p> : null}
          <div className="kpi-grid">
            <Kpi label="Catalog" value={visible.length} icon={Boxes} />
            <Kpi label="Installed" value={installed.length} icon={CheckCircle2} />
            <Kpi label="Built-in" value={builtin.length} icon={Boxes} />
            <Kpi label="Custom" value={custom.length} icon={Puzzle} />
          </div>
          <p className="muted">
            Regions: {platformRegions.join(", ") || "local"}. Archived modules are hidden from this catalog.
          </p>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <ChartCard title="Modules by category">
              <BarSeries
                data={byCategory.length ? byCategory : [{ name: "None", value: 0 }]}
                xKey="name"
                keys={[{ key: "value", label: "Modules" }]}
              />
            </ChartCard>
            <ChartCard title="Built-in vs custom">
              <DonutChart data={byKind} />
            </ChartCard>
          </div>
        </div>
      </TabPanel>

      <TabPanel value="builtin">
        {msg ? <p className="muted">{msg}</p> : null}
        <ModuleGrid list={builtin} />
      </TabPanel>

      <TabPanel value="custom">
        {msg ? <p className="muted">{msg}</p> : null}
        <ModuleGrid list={custom} />
      </TabPanel>

      <TabPanel value="installed">
        {msg ? <p className="muted">{msg}</p> : null}
        <ModuleGrid list={installed} />
      </TabPanel>

      <TabPanel value="available">
        {msg ? <p className="muted">{msg}</p> : null}
        <ModuleGrid list={available} />
      </TabPanel>
    </Tabs>
  );
}
