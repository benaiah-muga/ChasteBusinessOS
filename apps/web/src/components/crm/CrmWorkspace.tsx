"use client";

import { useMemo, useState } from "react";
import {
  DollarSign,
  LayoutDashboard,
  ListFilter,
  Mail,
  MapPin,
  Plus,
  Users,
} from "lucide-react";
import { AreaSeries, BarSeries, ChartCard, DonutChart } from "@/components/ui/Chart";
import { Kpi } from "@/components/ui/Kpi";
import { Tab, TabPanel, Tabs } from "@/components/ui/Tabs";
import type { Customer } from "@chaste/api-client";
import { CustomerCreateFormInline } from "./CustomerCreateForm";
import { getApiClient } from "@/lib/api";

type Props = { initialCustomers: Customer[] };

const STAGE_COLORS: Record<string, string> = {
  lead: "#475569",
  prospect: "#2563eb",
  qualified: "#0f8c86",
  negotiable: "#c27803",
  won: "#15803d",
  lost: "#be123c",
  active: "#15803d",
  churned: "#be123c",
};
const HUMAN_STAGE: Record<string, string> = {
  lead: "Lead",
  prospect: "Prospect",
  qualified: "Qualified",
  negotiable: "In negotiation",
  won: "Won",
  lost: "Lost",
  active: "Active",
  churned: "Churned",
};

export function CrmWorkspace({ initialCustomers }: Props) {
  const [customers, setCustomers] = useState(initialCustomers);
  const [tab, setTab] = useState("overview");

  async function refresh() {
    try {
      const res = await getApiClient().listCustomers();
      setCustomers(res.items);
    } catch {
      /* keep */
    }
  }

  const stageCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of customers) {
      const key = (c.status ?? "lead") as string;
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return Array.from(m, ([name, value]) => ({ name: HUMAN_STAGE[name] ?? name, value }));
  }, [customers]);

  const cityCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of customers) {
      const k = (c.city ?? "unspecified").toString();
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return Array.from(m, ([city, count]) => ({ city, count }));
  }, [customers]);

  const monthSignups = useMemo(() => {
    const buckets = new Map<string, number>();
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.toLocaleString("en", { month: "short" })} ${String(d.getFullYear()).slice(-2)}`;
      buckets.set(key, 0);
    }
    const keys = Array.from(buckets.keys());
    for (const c of customers) {
      const created = new Date(c.createdAt);
      for (let i = 0; i < keys.length; i++) {
        const yrNow = now.getFullYear();
        const yrC = created.getFullYear();
        const monNow = now.getMonth();
        const monC = created.getMonth();
        const monthsBack = (yrNow - yrC) * 12 + (monNow - monC);
        if (monthsBack >= 0 && monthsBack < 12) {
          buckets.set(keys[11 - monthsBack], (buckets.get(keys[11 - monthsBack]) ?? 0) + 1);
          break;
        }
      }
    }
    return keys.map((key) => ({ month: key, signups: buckets.get(key) ?? 0 }));
  }, [customers]);

  const total = customers.length;
  const withEmail = customers.filter((c) => !!c.email).length;
  const countriesSet = new Set(customers.map((c) => c.country).filter(Boolean));

  return (
    <Tabs defaultValue="overview" value={tab} onValueChange={setTab}>
      <Tab label="Overview" icon={LayoutDashboard} value="overview" />
      <Tab label="Customers" icon={Users} value="customers" count={total} />
      <Tab label="Pipeline" icon={ListFilter} value="pipeline" />
      <Tab label="Geography" icon={MapPin} value="geo" />
      <Tab label="Add customer" icon={Plus} value="add" />

      <TabPanel value="overview">
        <div className="stack">
          <div className="kpi-grid" style={{ marginBottom: 14 }}>
            <Kpi label="Total customers" value={total} icon={Users} hint={`${withEmail} with email`} />
            <Kpi label="Countries reached" value={countriesSet.size} icon={MapPin} />
            <Kpi label="Cities" value={cityCounts.length} icon={MapPin} />
            <Kpi label="Active" value={customers.filter((c) => (c.status ?? "active") === "active").length} icon={DollarSign} />
          </div>
          <div className="grid" style={{ gridTemplateColumns: "minmax(0,2fr) minmax(0,1fr)" }}>
            <ChartCard title="New customers" subtitle="Trailing 12 months">
              <AreaSeries data={monthSignups} xKey="month" keys={[{ key: "signups", label: "New customers" }]} />
            </ChartCard>
            <ChartCard title="By stage" subtitle="Current pipeline distribution">
              <DonutChart data={stageCounts} />
            </ChartCard>
          </div>
          <ChartCard title="Top cities" subtitle="By customer count" height={240}>
            <BarSeries
              data={cityCounts.slice(0, 8)}
              xKey="city"
              keys={[{ key: "count", label: "Customers" }]}
            />
          </ChartCard>
        </div>
      </TabPanel>

      <TabPanel value="customers">
        <CustomerTable customers={customers} onRefresh={refresh} />
      </TabPanel>

      <TabPanel value="pipeline">
        <div className="stack">
          <ChartCard title="Pipeline stages" subtitle="Distribution across funnel" height={280}>
            <BarSeries data={stageCounts} xKey="name" keys={[{ key: "value", label: "Count" }]} />
          </ChartCard>
          <CustomerTable customers={customers} onRefresh={refresh} />
        </div>
      </TabPanel>

      <TabPanel value="geo">
        <ChartCard title="Customers by city" subtitle={`${cityCounts.length} unique locations`} height={320}>
          <BarSeries data={cityCounts} xKey="city" keys={[{ key: "count", label: "Customers" }]} />
        </ChartCard>
      </TabPanel>

      <TabPanel value="add">
        <section className="card stack">
          <h2>Add a customer</h2>
          <CustomerCreateFormInline
            onCreated={async () => {
              await refresh();
              setTab("customers");
            }}
          />
        </section>
      </TabPanel>
    </Tabs>
  );
}

function CustomerTable({
  customers,
  onRefresh,
}: {
  customers: Customer[];
  onRefresh: () => void;
}) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    if (!q.trim()) return customers;
    const term = q.toLowerCase();
    return customers.filter(
      (c) =>
        c.name.toLowerCase().includes(term) ||
        (c.email ?? "").toLowerCase().includes(term) ||
        (c.city ?? "").toLowerCase().includes(term) ||
        (c.country ?? "").toLowerCase().includes(term),
    );
  }, [q, customers]);

  return (
    <section className="card stack">
      <div className="toolbar">
        <div className="page-title-block" style={{ flex: 1 }}>
          <h2 style={{ margin: 0 }}>Customers</h2>
        </div>
        <input
          className="search"
          type="search"
          placeholder="Search by name, email, location"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="btn secondary" type="button" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="icon"><Users size={20} /></div>
          <h3>No customers yet</h3>
          <p>Add one in the “Add customer” tab to start tracking.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>City</th>
                <th>Country</th>
                <th>Stage</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const stage = c.status ?? "lead";
                return (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td>
                      {c.email ? (
                        <span className="row" style={{ gap: 4 }}>
                          <Mail size={12} /> {c.email}
                        </span>
                      ) : (
                        <span className="placeholder">not set</span>
                      )}
                    </td>
                    <td>{c.city ?? <span className="placeholder">not set</span>}</td>
                    <td>{c.country ?? <span className="placeholder">not set</span>}</td>
                    <td>
                      <span
                        className="badge"
                        style={{
                          background: `${STAGE_COLORS[stage] ?? "#475569"}1f`,
                          color: STAGE_COLORS[stage] ?? "#475569",
                          borderColor: `${STAGE_COLORS[stage] ?? "#475569"}55`,
                        }}
                      >
                        {HUMAN_STAGE[stage] ?? stage}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
