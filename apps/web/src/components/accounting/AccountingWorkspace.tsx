"use client";

import { useMemo, useState } from "react";
import {
  BookOpen,
  FileText,
  LayoutDashboard,
  Plus,
  Wallet,
} from "lucide-react";
import { AreaSeries, BarSeries, ChartCard, DonutChart } from "@/components/ui/Chart";
import { Kpi } from "@/components/ui/Kpi";
import { Tab, TabPanel, Tabs } from "@/components/ui/Tabs";
import { CreateInvoiceForm } from "@/components/CreateInvoiceForm";
import { getApiClient } from "@/lib/api";

type Account = { id?: string; code: string; name: string; type: string; isActive?: boolean };
type Invoice = {
  id?: string;
  number: string;
  total: string;
  status: string;
  currency: string;
  createdAt?: string;
};

export function AccountingWorkspace({
  initialAccounts,
  initialInvoices,
}: {
  initialAccounts: Account[];
  initialInvoices: Invoice[];
}) {
  const [accounts, setAccounts] = useState(initialAccounts);
  const [invoices, setInvoices] = useState(initialInvoices);
  const [tab, setTab] = useState("overview");

  async function refresh() {
    const api = getApiClient();
    try {
      const [a, i] = await Promise.all([api.listAccounts(), api.listInvoices()]);
      setAccounts(a.items);
      setInvoices(i.items);
    } catch {
      /* keep */
    }
  }

  const byType = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of accounts) m.set(a.type, (m.get(a.type) ?? 0) + 1);
    return Array.from(m, ([name, value]) => ({ name, value }));
  }, [accounts]);

  const byStatus = useMemo(() => {
    const m = new Map<string, number>();
    for (const inv of invoices) m.set(inv.status, (m.get(inv.status) ?? 0) + 1);
    return Array.from(m, ([name, value]) => ({ name, value }));
  }, [invoices]);

  const invoiceTrend = useMemo(() => {
    const months: { month: string; amount: number; count: number }[] = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.toLocaleString("en", { month: "short" });
      const monthInvs = invoices.filter((inv) => {
        if (!inv.createdAt) return false;
        const c = new Date(inv.createdAt);
        return c.getFullYear() === d.getFullYear() && c.getMonth() === d.getMonth();
      });
      months.push({
        month: key,
        amount: monthInvs.reduce((s, inv) => s + Number(inv.total || 0), 0),
        count: monthInvs.length,
      });
    }
    return months;
  }, [invoices]);

  const totalInvoiced = invoices.reduce((s, inv) => s + Number(inv.total || 0), 0);
  const draftCount = invoices.filter((i) => i.status === "draft").length;

  return (
    <Tabs defaultValue="overview" value={tab} onValueChange={setTab}>
      <Tab label="Overview" icon={LayoutDashboard} value="overview" />
      <Tab label="Chart of accounts" icon={BookOpen} value="accounts" count={accounts.length} />
      <Tab label="Invoices" icon={FileText} value="invoices" count={invoices.length} />
      <Tab label="New invoice" icon={Plus} value="create" />

      <TabPanel value="overview">
        <div className="stack">
          <div className="kpi-grid">
            <Kpi label="Accounts" value={accounts.length} icon={BookOpen} />
            <Kpi label="Invoices" value={invoices.length} icon={FileText} />
            <Kpi
              label="Invoiced total"
              value={totalInvoiced.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              icon={Wallet}
              hint="All statuses"
            />
            <Kpi label="Draft invoices" value={draftCount} icon={FileText} />
          </div>
          <div className="grid" style={{ gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr)" }}>
            <ChartCard title="Invoice volume" subtitle="Last 6 months by amount">
              <AreaSeries
                data={invoiceTrend}
                xKey="month"
                keys={[{ key: "amount", label: "Amount" }]}
              />
            </ChartCard>
            <ChartCard title="Accounts by type">
              <DonutChart data={byType.length ? byType : [{ name: "None", value: 1 }]} />
            </ChartCard>
          </div>
          <ChartCard title="Invoices by status" height={240}>
            <BarSeries
              data={byStatus.length ? byStatus : [{ name: "None", value: 0 }]}
              xKey="name"
              keys={[{ key: "value", label: "Count" }]}
            />
          </ChartCard>
        </div>
      </TabPanel>

      <TabPanel value="accounts">
        <section className="card stack">
          <div className="section-head">
            <div>
              <h2>Chart of accounts</h2>
              <p className="muted">Ledger structure used for journals and reporting.</p>
            </div>
            <button className="btn secondary" type="button" onClick={refresh}>
              Refresh
            </button>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {accounts.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="muted">
                      No accounts yet
                    </td>
                  </tr>
                ) : (
                  accounts.map((a) => (
                    <tr key={a.code}>
                      <td className="mono">{a.code}</td>
                      <td>{a.name}</td>
                      <td>
                        <span className="badge">{a.type}</span>
                      </td>
                      <td>{a.isActive === false ? "Inactive" : "Active"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </TabPanel>

      <TabPanel value="invoices">
        <section className="card stack">
          <div className="section-head">
            <div>
              <h2>Invoices</h2>
              <p className="muted">Customer billing documents and their status.</p>
            </div>
            <button className="btn secondary" type="button" onClick={refresh}>
              Refresh
            </button>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Total</th>
                  <th>Currency</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {invoices.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="muted">
                      No invoices yet
                    </td>
                  </tr>
                ) : (
                  invoices.map((inv) => (
                    <tr key={inv.number}>
                      <td>{inv.number}</td>
                      <td>{inv.total}</td>
                      <td>{inv.currency}</td>
                      <td>
                        <span className="badge accent">{inv.status}</span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </TabPanel>

      <TabPanel value="create">
        <section className="card stack">
          <h2>Create invoice</h2>
          <p className="muted">Draft a customer invoice. It routes through the same command bus as the agent.</p>
          <CreateInvoiceForm
            onCreated={async () => {
              await refresh();
              setTab("invoices");
            }}
          />
        </section>
      </TabPanel>
    </Tabs>
  );
}
