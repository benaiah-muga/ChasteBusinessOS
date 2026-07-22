"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ClipboardList,
  Factory,
  LayoutDashboard,
  Plus,
} from "lucide-react";
import { BarSeries, ChartCard, DonutChart } from "@/components/ui/Chart";
import { Kpi } from "@/components/ui/Kpi";
import { Tab, TabPanel, Tabs } from "@/components/ui/Tabs";
import { getApiClient } from "@/lib/api";

type Bom = { id: string; productId?: string; name: string; quantity?: number };
type WorkOrder = { id?: string; number: string; status: string; quantity: number };

export function ManufacturingWorkspace({
  initialBoms,
  initialWorkOrders,
}: {
  initialBoms: Bom[];
  initialWorkOrders: WorkOrder[];
}) {
  const [boms, setBoms] = useState(initialBoms);
  const [workOrders, setWorkOrders] = useState(initialWorkOrders);
  const [tab, setTab] = useState("overview");
  const [products, setProducts] = useState<{ id: string; sku: string; name: string }[]>([]);
  const [bomName, setBomName] = useState("");
  const [productId, setProductId] = useState("");
  const [bomQty, setBomQty] = useState("1");
  const [woBomId, setWoBomId] = useState(initialBoms[0]?.id ?? "");
  const [woNumber, setWoNumber] = useState(`WO-${Date.now().toString().slice(-5)}`);
  const [woQty, setWoQty] = useState("1");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const api = getApiClient();
      const [mfg, inv] = await Promise.all([api.listManufacturing(), api.listInventory()]);
      setBoms(mfg.boms);
      setWorkOrders(mfg.workOrders);
      setProducts(inv.products.map((p) => ({ id: p.id, sku: p.sku, name: p.name })));
      if (!productId && inv.products[0]) setProductId(inv.products[0].id);
      if (!woBomId && mfg.boms[0]) setWoBomId(mfg.boms[0].id);
    } catch {
      /* keep */
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const byStatus = useMemo(() => {
    const m = new Map<string, number>();
    for (const w of workOrders) m.set(w.status, (m.get(w.status) ?? 0) + 1);
    return Array.from(m, ([name, value]) => ({ name, value }));
  }, [workOrders]);

  const qtyByStatus = useMemo(() => {
    const m = new Map<string, number>();
    for (const w of workOrders) m.set(w.status, (m.get(w.status) ?? 0) + Number(w.quantity || 0));
    return Array.from(m, ([name, quantity]) => ({ name, quantity }));
  }, [workOrders]);

  async function createBom(e: React.FormEvent) {
    e.preventDefault();
    if (!productId) {
      setMsg("Select a finished product first");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await getApiClient().createBom({
        productId,
        name: bomName,
        quantity: Number(bomQty) || 1,
        components: [],
      });
      setMsg(`Created BOM ${bomName}`);
      setBomName("");
      await refresh();
      setTab("boms");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed to create BOM");
    } finally {
      setBusy(false);
    }
  }

  async function createWo(e: React.FormEvent) {
    e.preventDefault();
    if (!woBomId) {
      setMsg("Select a bill of materials first");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await getApiClient().createWorkOrder({
        bomId: woBomId,
        number: woNumber,
        quantity: Number(woQty) || 1,
      });
      setMsg(`Created work order ${woNumber}`);
      setWoNumber(`WO-${Date.now().toString().slice(-5)}`);
      await refresh();
      setTab("orders");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed to create work order");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Tabs defaultValue="overview" value={tab} onValueChange={setTab}>
      <Tab label="Overview" icon={LayoutDashboard} value="overview" />
      <Tab label="Bills of materials" icon={ClipboardList} value="boms" count={boms.length} />
      <Tab label="Work orders" icon={Factory} value="orders" count={workOrders.length} />
      <Tab label="New BOM" icon={Plus} value="new-bom" />
      <Tab label="New work order" icon={Plus} value="new-wo" />

      <TabPanel value="overview">
        <div className="stack">
          <div className="kpi-grid">
            <Kpi label="BOMs" value={boms.length} icon={ClipboardList} />
            <Kpi label="Work orders" value={workOrders.length} icon={Factory} />
            <Kpi
              label="Units planned"
              value={workOrders.reduce((s, w) => s + Number(w.quantity || 0), 0)}
              icon={Factory}
            />
            <Kpi label="Statuses" value={byStatus.length} icon={LayoutDashboard} />
          </div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <ChartCard title="Work orders by status">
              <DonutChart data={byStatus.length ? byStatus : [{ name: "None", value: 1 }]} />
            </ChartCard>
            <ChartCard title="Planned quantity by status">
              <BarSeries
                data={qtyByStatus.length ? qtyByStatus : [{ name: "None", quantity: 0 }]}
                xKey="name"
                keys={[{ key: "quantity", label: "Units" }]}
              />
            </ChartCard>
          </div>
        </div>
      </TabPanel>

      <TabPanel value="boms">
        <section className="card stack">
          <div className="section-head">
            <div>
              <h2>Bills of materials</h2>
              <p className="muted">Product recipes used to drive production.</p>
            </div>
            <button className="btn secondary" type="button" onClick={refresh}>
              Refresh
            </button>
          </div>
          {boms.length === 0 ? (
            <div className="empty-state">
              <div className="icon">
                <ClipboardList size={20} />
              </div>
              <h3>No bills of materials yet</h3>
              <p>Create a BOM for a finished product to start production planning.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Quantity</th>
                  </tr>
                </thead>
                <tbody>
                  {boms.map((b) => (
                    <tr key={b.id}>
                      <td>{b.name}</td>
                      <td>{b.quantity ?? 1}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </TabPanel>

      <TabPanel value="orders">
        <section className="card stack">
          <div className="section-head">
            <div>
              <h2>Work orders</h2>
              <p className="muted">Production jobs scheduled against BOMs.</p>
            </div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Status</th>
                  <th>Quantity</th>
                </tr>
              </thead>
              <tbody>
                {workOrders.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="muted">
                      No work orders yet
                    </td>
                  </tr>
                ) : (
                  workOrders.map((w) => (
                    <tr key={w.number}>
                      <td>{w.number}</td>
                      <td>
                        <span className="badge accent">{w.status}</span>
                      </td>
                      <td>{w.quantity}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </TabPanel>

      <TabPanel value="new-bom">
        <section className="card stack">
          <h2>Create bill of materials</h2>
          <form className="stack" onSubmit={createBom}>
            <div className="row">
              <label style={{ flex: 1 }}>
                Finished product
                <select value={productId} onChange={(e) => setProductId(e.target.value)} required>
                  <option value="">Select product</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.sku} - {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ flex: 1 }}>
                BOM name
                <input value={bomName} onChange={(e) => setBomName(e.target.value)} required />
              </label>
              <label>
                Output qty
                <input type="number" min="1" value={bomQty} onChange={(e) => setBomQty(e.target.value)} />
              </label>
            </div>
            <button className="btn" type="submit" disabled={busy || products.length === 0}>
              {busy ? "Creating..." : "Create BOM"}
            </button>
          </form>
          {msg ? <p className={msg.startsWith("Created") ? "muted" : "error"}>{msg}</p> : null}
        </section>
      </TabPanel>

      <TabPanel value="new-wo">
        <section className="card stack">
          <h2>Create work order</h2>
          <form className="stack" onSubmit={createWo}>
            <div className="row">
              <label style={{ flex: 1 }}>
                Bill of materials
                <select value={woBomId} onChange={(e) => setWoBomId(e.target.value)} required>
                  <option value="">Select BOM</option>
                  {boms.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Number
                <input value={woNumber} onChange={(e) => setWoNumber(e.target.value)} required />
              </label>
              <label>
                Quantity
                <input type="number" min="1" value={woQty} onChange={(e) => setWoQty(e.target.value)} />
              </label>
            </div>
            <button className="btn" type="submit" disabled={busy || boms.length === 0}>
              {busy ? "Creating..." : "Create work order"}
            </button>
          </form>
          {msg ? <p className={msg.startsWith("Created") ? "muted" : "error"}>{msg}</p> : null}
        </section>
      </TabPanel>
    </Tabs>
  );
}
