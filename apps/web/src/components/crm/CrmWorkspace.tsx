"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  DollarSign,
  Eye,
  LayoutDashboard,
  ListFilter,
  Mail,
  MapPin,
  Pencil,
  Plus,
  Trash2,
  Users,
} from "lucide-react";
import { AreaSeries, BarSeries, ChartCard, DonutChart } from "@/components/ui/Chart";
import { Kpi } from "@/components/ui/Kpi";
import { Tab, TabPanel, Tabs } from "@/components/ui/Tabs";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type { Customer } from "@chaste/api-client";
import { getApiClient } from "@/lib/api";
import { CustomerForm } from "./CustomerForm";

type Props = { initialCustomers: Customer[] };

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

const FILTER_OPTIONS = ["all", "lead", "prospect", "qualified", "negotiable", "won", "active", "churned", "lost"] as const;

export function CrmWorkspace({ initialCustomers }: Props) {
  const [customers, setCustomers] = useState(initialCustomers);
  const [tab, setTab] = useState("overview");
  const [filter, setFilter] = useState<string>("all");

  async function refresh() {
    try {
      const res = await getApiClient().listCustomers();
      setCustomers(res.items);
    } catch {
      /* keep */
    }
  }

  const visible = useMemo(
    () => (filter === "all" ? customers : customers.filter((c) => c.status === filter)),
    [customers, filter],
  );

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
        <CustomerTable customers={visible} allCount={total} filter={filter} onFilterChange={setFilter} onRefresh={refresh} />
      </TabPanel>

      <TabPanel value="pipeline">
        <div className="stack">
          <ChartCard title="Pipeline stages" subtitle="Distribution across funnel" height={280}>
            <BarSeries data={stageCounts} xKey="name" keys={[{ key: "value", label: "Count" }]} />
          </ChartCard>
          <CustomerTable customers={visible} allCount={total} filter={filter} onFilterChange={setFilter} onRefresh={refresh} />
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
          <CustomerForm
            mode="create"
            onDone={async () => {
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
  allCount,
  filter,
  onFilterChange,
  onRefresh,
}: {
  customers: Customer[];
  allCount: number;
  filter: string;
  onFilterChange: (f: string) => void;
  onRefresh: () => void;
}) {
  const [q, setQ] = useState("");
  const [editTarget, setEditTarget] = useState<Customer | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Customer | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setErr(null);
    try {
      await getApiClient().deleteCustomer(deleteTarget.id);
      setDeleteTarget(null);
      await onRefresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to delete customer");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="card stack">
      <div className="toolbar">
        <div className="page-title-block" style={{ flex: 1 }}>
          <h2 style={{ margin: 0 }}>Customers</h2>
        </div>
        <select
          className="search"
          style={{ width: "auto" }}
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          aria-label="Filter by status"
        >
          {FILTER_OPTIONS.map((f) => (
            <option key={f} value={f}>
              {f === "all" ? `All statuses (${allCount})` : `${HUMAN_STAGE[f] ?? f}`}
            </option>
          ))}
        </select>
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
      {err ? <p className="error">{err}</p> : null}
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
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`/crm/customers/${c.id}`} className="clickable">
                      {c.name}
                    </Link>
                  </td>
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
                    <StatusBadge status={c.status ?? "lead"} />
                  </td>
                  <td>
                    <div className="row-actions">
                      <Link
                        className="icon-btn tip"
                        data-tip="View"
                        href={`/crm/customers/${c.id}`}
                        aria-label="View customer"
                      >
                        <Eye size={14} />
                      </Link>
                      <button
                        className="icon-btn tip"
                        data-tip="Edit"
                        type="button"
                        aria-label="Edit customer"
                        onClick={() => setEditTarget(c)}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        className="icon-btn tip"
                        data-tip="Delete"
                        type="button"
                        aria-label="Delete customer"
                        onClick={() => setDeleteTarget(c)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={!!editTarget}
        onClose={() => setEditTarget(null)}
        title="Edit customer"
      >
        {editTarget ? (
          <CustomerForm
            mode="edit"
            customer={editTarget}
            onDone={async () => {
              setEditTarget(null);
              await onRefresh();
            }}
            onCancel={() => setEditTarget(null)}
          />
        ) : null}
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete customer"
        message={`Archive "${deleteTarget?.name ?? ""}"? History is preserved but the customer is hidden from lists.`}
        confirmLabel="Archive"
        busy={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </section>
  );
}
