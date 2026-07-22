"use client";

import { useMemo, useState } from "react";
import {
  LayoutDashboard,
  Plus,
  ShoppingCart,
  Truck,
} from "lucide-react";
import { BarSeries, ChartCard, DonutChart } from "@/components/ui/Chart";
import { Kpi } from "@/components/ui/Kpi";
import { Tab, TabPanel, Tabs } from "@/components/ui/Tabs";
import { CreateVendorForm } from "@/components/CreateVendorForm";
import { getApiClient } from "@/lib/api";

type Vendor = { id: string; name: string; email?: string };
type Order = {
  id?: string;
  vendorId?: string;
  number: string;
  status: string;
  total: string;
  currency?: string;
};

export function PurchasingWorkspace({
  initialVendors,
  initialOrders,
}: {
  initialVendors: Vendor[];
  initialOrders: Order[];
}) {
  const [vendors, setVendors] = useState(initialVendors);
  const [orders, setOrders] = useState(initialOrders);
  const [tab, setTab] = useState("overview");
  const [vendorId, setVendorId] = useState(initialVendors[0]?.id ?? "");
  const [poNumber, setPoNumber] = useState(`PO-${Date.now().toString().slice(-5)}`);
  const [poTotal, setPoTotal] = useState("500");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const data = await getApiClient().listPurchasing();
      setVendors(data.vendors);
      setOrders(data.orders);
      if (!vendorId && data.vendors[0]) setVendorId(data.vendors[0].id);
    } catch {
      /* keep */
    }
  }

  const byStatus = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of orders) m.set(o.status, (m.get(o.status) ?? 0) + 1);
    return Array.from(m, ([name, value]) => ({ name, value }));
  }, [orders]);

  const spendByVendor = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of orders) {
      const name = vendors.find((v) => v.id === o.vendorId)?.name ?? "Unknown";
      m.set(name, (m.get(name) ?? 0) + Number(o.total || 0));
    }
    return Array.from(m, ([name, spend]) => ({ name, spend }));
  }, [orders, vendors]);

  const totalSpend = orders.reduce((s, o) => s + Number(o.total || 0), 0);

  async function createPo(e: React.FormEvent) {
    e.preventDefault();
    if (!vendorId) {
      setMsg("Select a vendor first");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await getApiClient().createPurchaseOrder({
        vendorId,
        number: poNumber,
        total: Number(poTotal),
      });
      setMsg(`Created ${poNumber}`);
      setPoNumber(`PO-${Date.now().toString().slice(-5)}`);
      await refresh();
      setTab("orders");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed to create purchase order");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Tabs defaultValue="overview" value={tab} onValueChange={setTab}>
      <Tab label="Overview" icon={LayoutDashboard} value="overview" />
      <Tab label="Vendors" icon={Truck} value="vendors" count={vendors.length} />
      <Tab label="Orders" icon={ShoppingCart} value="orders" count={orders.length} />
      <Tab label="New vendor" icon={Plus} value="vendor" />
      <Tab label="New PO" icon={Plus} value="po" />

      <TabPanel value="overview">
        <div className="stack">
          <div className="kpi-grid">
            <Kpi label="Vendors" value={vendors.length} icon={Truck} />
            <Kpi label="Purchase orders" value={orders.length} icon={ShoppingCart} />
            <Kpi
              label="Spend total"
              value={totalSpend.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              icon={ShoppingCart}
            />
            <Kpi label="Open statuses" value={byStatus.length} icon={LayoutDashboard} />
          </div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <ChartCard title="Orders by status">
              <DonutChart data={byStatus.length ? byStatus : [{ name: "None", value: 1 }]} />
            </ChartCard>
            <ChartCard title="Spend by vendor">
              <BarSeries
                data={spendByVendor.length ? spendByVendor : [{ name: "None", spend: 0 }]}
                xKey="name"
                keys={[{ key: "spend", label: "Spend" }]}
              />
            </ChartCard>
          </div>
        </div>
      </TabPanel>

      <TabPanel value="vendors">
        <section className="card stack">
          <div className="section-head">
            <div>
              <h2>Vendors</h2>
              <p className="muted">Suppliers used for procurement.</p>
            </div>
            <button className="btn secondary" type="button" onClick={refresh}>
              Refresh
            </button>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                </tr>
              </thead>
              <tbody>
                {vendors.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="muted">
                      No vendors yet
                    </td>
                  </tr>
                ) : (
                  vendors.map((v) => (
                    <tr key={v.id}>
                      <td>{v.name}</td>
                      <td>{v.email ?? <span className="placeholder">not set</span>}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </TabPanel>

      <TabPanel value="orders">
        <section className="card stack">
          <div className="section-head">
            <div>
              <h2>Purchase orders</h2>
              <p className="muted">Procurement documents and totals.</p>
            </div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Vendor</th>
                  <th>Status</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {orders.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="muted">
                      No purchase orders yet
                    </td>
                  </tr>
                ) : (
                  orders.map((o) => (
                    <tr key={o.number}>
                      <td>{o.number}</td>
                      <td>{vendors.find((v) => v.id === o.vendorId)?.name ?? "Unknown"}</td>
                      <td>
                        <span className="badge accent">{o.status}</span>
                      </td>
                      <td>
                        {o.total} {o.currency ?? ""}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </TabPanel>

      <TabPanel value="vendor">
        <section className="card stack">
          <h2>Add vendor</h2>
          <CreateVendorForm />
          <button className="btn secondary" type="button" onClick={refresh}>
            Refresh after create
          </button>
        </section>
      </TabPanel>

      <TabPanel value="po">
        <section className="card stack">
          <h2>Create purchase order</h2>
          <form className="stack" onSubmit={createPo}>
            <div className="row">
              <label style={{ flex: 1 }}>
                Vendor
                <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} required>
                  <option value="">Select vendor</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Number
                <input value={poNumber} onChange={(e) => setPoNumber(e.target.value)} required />
              </label>
              <label>
                Total
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={poTotal}
                  onChange={(e) => setPoTotal(e.target.value)}
                  required
                />
              </label>
            </div>
            <button className="btn" type="submit" disabled={busy || vendors.length === 0}>
              {busy ? "Creating..." : "Create purchase order"}
            </button>
          </form>
          {msg ? <p className={msg.startsWith("Created") ? "muted" : "error"}>{msg}</p> : null}
        </section>
      </TabPanel>
    </Tabs>
  );
}
