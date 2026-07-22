"use client";

import { useMemo, useState } from "react";
import {
  Boxes,
  LayoutDashboard,
  Package,
  Plus,
  Warehouse,
} from "lucide-react";
import { BarSeries, ChartCard, DonutChart } from "@/components/ui/Chart";
import { Kpi } from "@/components/ui/Kpi";
import { Tab, TabPanel, Tabs } from "@/components/ui/Tabs";
import { CreateProductForm } from "@/components/CreateProductForm";
import { getApiClient } from "@/lib/api";

type WarehouseRow = { id?: string; code: string; name: string; city?: string };
type Product = {
  id?: string;
  sku: string;
  name: string;
  uom?: string;
  reorderLevel?: number;
};
type Level = { warehouseId?: string; productId?: string; quantity: number };

export function InventoryWorkspace({
  initialWarehouses,
  initialProducts,
  initialLevels,
}: {
  initialWarehouses: WarehouseRow[];
  initialProducts: Product[];
  initialLevels: Level[];
}) {
  const [warehouses, setWarehouses] = useState(initialWarehouses);
  const [products, setProducts] = useState(initialProducts);
  const [levels, setLevels] = useState(initialLevels);
  const [tab, setTab] = useState("overview");

  async function refresh() {
    try {
      const data = await getApiClient().listInventory();
      setWarehouses(data.warehouses);
      setProducts(data.products);
      setLevels(data.levels);
    } catch {
      /* keep */
    }
  }

  const totalQty = levels.reduce((s, l) => s + Number(l.quantity || 0), 0);
  const lowStock = products.filter((p) => {
    const qty = levels
      .filter((l) => l.productId === p.id)
      .reduce((s, l) => s + Number(l.quantity || 0), 0);
    return (p.reorderLevel ?? 0) > 0 && qty <= (p.reorderLevel ?? 0);
  }).length;

  const stockByWarehouse = useMemo(() => {
    return warehouses.map((w) => ({
      name: w.code,
      quantity: levels
        .filter((l) => l.warehouseId === w.id)
        .reduce((s, l) => s + Number(l.quantity || 0), 0),
    }));
  }, [warehouses, levels]);

  const productMix = useMemo(() => {
    return products.slice(0, 8).map((p) => ({
      name: p.sku,
      quantity: levels
        .filter((l) => l.productId === p.id)
        .reduce((s, l) => s + Number(l.quantity || 0), 0),
    }));
  }, [products, levels]);

  return (
    <Tabs defaultValue="overview" value={tab} onValueChange={setTab}>
      <Tab label="Overview" icon={LayoutDashboard} value="overview" />
      <Tab label="Warehouses" icon={Warehouse} value="warehouses" count={warehouses.length} />
      <Tab label="Products" icon={Package} value="products" count={products.length} />
      <Tab label="Stock" icon={Boxes} value="stock" count={levels.length} />
      <Tab label="Add product" icon={Plus} value="add" />

      <TabPanel value="overview">
        <div className="stack">
          <div className="kpi-grid">
            <Kpi label="Warehouses" value={warehouses.length} icon={Warehouse} />
            <Kpi label="Products" value={products.length} icon={Package} />
            <Kpi label="On-hand units" value={totalQty} icon={Boxes} />
            <Kpi label="Low stock SKUs" value={lowStock} icon={Package} hint="At or below reorder" />
          </div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <ChartCard title="Stock by warehouse">
              <BarSeries
                data={stockByWarehouse.length ? stockByWarehouse : [{ name: "None", quantity: 0 }]}
                xKey="name"
                keys={[{ key: "quantity", label: "Units" }]}
              />
            </ChartCard>
            <ChartCard title="Top products on hand">
              <DonutChart
                data={
                  productMix.length
                    ? productMix.map((p) => ({ name: p.name, value: Math.max(p.quantity, 0) || 0.01 }))
                    : [{ name: "None", value: 1 }]
                }
              />
            </ChartCard>
          </div>
        </div>
      </TabPanel>

      <TabPanel value="warehouses">
        <section className="card stack">
          <div className="section-head">
            <div>
              <h2>Warehouses</h2>
              <p className="muted">Storage locations used for stock tracking.</p>
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
                  <th>City</th>
                </tr>
              </thead>
              <tbody>
                {warehouses.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="muted">
                      No warehouses yet
                    </td>
                  </tr>
                ) : (
                  warehouses.map((w) => (
                    <tr key={w.code}>
                      <td className="mono">{w.code}</td>
                      <td>{w.name}</td>
                      <td>{w.city ?? <span className="placeholder">not set</span>}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </TabPanel>

      <TabPanel value="products">
        <section className="card stack">
          <div className="section-head">
            <div>
              <h2>Products</h2>
              <p className="muted">SKUs available for stock and manufacturing.</p>
            </div>
            <button className="btn secondary" type="button" onClick={refresh}>
              Refresh
            </button>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Name</th>
                  <th>UoM</th>
                  <th>Reorder</th>
                </tr>
              </thead>
              <tbody>
                {products.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="muted">
                      No products yet
                    </td>
                  </tr>
                ) : (
                  products.map((p) => (
                    <tr key={p.sku}>
                      <td className="mono">{p.sku}</td>
                      <td>{p.name}</td>
                      <td>{p.uom ?? "ea"}</td>
                      <td>{p.reorderLevel ?? 0}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </TabPanel>

      <TabPanel value="stock">
        <section className="card stack">
          <div className="section-head">
            <div>
              <h2>Stock levels</h2>
              <p className="muted">{levels.length} stock rows across warehouses.</p>
            </div>
          </div>
          {levels.length === 0 ? (
            <div className="empty-state">
              <div className="icon">
                <Boxes size={20} />
              </div>
              <h3>No stock rows yet</h3>
              <p>Create products and adjust stock to populate levels.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Warehouse</th>
                    <th>Product</th>
                    <th>Quantity</th>
                  </tr>
                </thead>
                <tbody>
                  {levels.map((l, idx) => {
                    const wh = warehouses.find((w) => w.id === l.warehouseId);
                    const prod = products.find((p) => p.id === l.productId);
                    return (
                      <tr key={idx}>
                        <td>{wh?.name ?? wh?.code ?? "Unknown"}</td>
                        <td>{prod?.name ?? prod?.sku ?? "Unknown"}</td>
                        <td>{l.quantity}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </TabPanel>

      <TabPanel value="add">
        <section className="card stack">
          <h2>Add product</h2>
          <p className="muted">Register a new SKU for inventory tracking.</p>
          <CreateProductForm />
          <button className="btn secondary" type="button" onClick={refresh}>
            Refresh after create
          </button>
        </section>
      </TabPanel>
    </Tabs>
  );
}
