"use client";

import { useCallback, useEffect, useMemo, useState, Fragment } from "react";
import {
  ActionNotice,
  Badge,
  Button,
  Card,
  CardTitle,
  EmptyState,
  LoadingPage,
  StatCard,
  type ActionNoticeState,
} from "@/components/ui";
import { formatDateTime, formatMoney } from "@/lib/format";
import { IconChevronDown, IconListTree } from "@/components/icons";
import { callApi, postApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";
import { AppFrame } from "../_shell/app-frame";

type Tab = "overview" | "boms" | "production" | "orders" | "runs";

interface BomEdge {
  assemblySku: string;
  componentSku: string;
  componentName: string;
  quantityThousandths: number;
  scrapPctThousandths: number;
}
interface WorkOrder {
  id: string;
  number: number;
  assemblySku: string;
  assemblyName: string;
  status: string;
  plannedQtyThousandths: number;
  producedQtyThousandths: number;
  yieldPctThousandths: number;
  expectedGoodThousandths: number;
  note: string | null;
  createdAt: string;
  completedAt: string | null;
}
interface ProductionRun {
  runId: string;
  occurredAt: string;
  assemblySku: string;
  producedThousandths: number;
  unitCostMinor: number;
  costTotalMinor: number;
  reversed: boolean;
  components: { sku: string; quantityThousandths: number; lotCode: string | null }[];
}
interface Lot {
  id: string;
  sku: string;
  lotCode: string;
  expiresAt: string | null;
  balanceThousandths: number;
}
interface Payload {
  boms?: BomEdge[];
  assemblies?: { sku: string; name: string }[];
  workOrders?: WorkOrder[];
  productionRuns?: ProductionRun[];
  lots?: Lot[];
}
interface BomNode {
  sku: string;
  name: string;
  quantityPerParentThousandths: number;
  scrapPctThousandths: number;
  children: BomNode[];
}
interface CostPreview {
  producible: boolean;
  lines: { sku: string; name: string; requiredThousandths: number; unitCostMinor: number; costMinor: number }[];
  totalCostMinor: number;
  resultingAvgFinishedUnitCostMinor: number;
}
const qty = (t: number) => (t / 1000).toFixed(3);
const pct = (t: number) => `${(t / 10000).toFixed(1)}%`;

export default function ManufacturingPage() {
  const __enabled = useModuleEnabled("manufacturing");
  const [data, setData] = useState<Payload | null>(null);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");

  const [bomForm, setBomForm] = useState({
    assemblySku: "",
    components: [{ sku: "", quantityThousandths: "1000", scrapPct: "0" }],
  });
  const [openTree, setOpenTree] = useState<string | null>(null);

  const [produce, setProduce] = useState({ assemblySku: "", qtyThousandths: "1000", lotCode: "" });
  const [preview, setPreview] = useState<CostPreview | null>(null);
  const [reverseRunId, setReverseRunId] = useState("");

  const [woForm, setWoForm] = useState({ assemblySku: "", plannedQty: "10", yieldPct: "100", note: "" });
  const [woCompletion, setWoCompletion] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const res = await callApi<Payload>("/api/manufacturing");
    setData(res.data ?? {});
    if (res.error) setNotice({ tone: "error", error: res.error });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(payload: Record<string, unknown>, label: string) {
    setBusy(true);
    try {
      const res = await postApi("/api/manufacturing", payload);
      if (res.status === 202) {
        setNotice({ tone: "pending", text: `${label} requires approval.` });
      } else if (!res.ok) {
        setNotice({ tone: "error", error: res.error ?? { title: `${label} failed`, hint: "Try again." } });
      } else {
        setNotice({ tone: "success", text: `${label} done.` });
        await load();
        return true;
      }
    } finally {
      setBusy(false);
    }
    return false;
  }

  async function checkPreview() {
    const res = await postApi<{ data?: CostPreview }>("/api/manufacturing", {
      action: "costPreview",
      assemblySku: produce.assemblySku,
      quantityThousandths: Number(produce.qtyThousandths || "0"),
    });
    if (!res.ok) {
      setNotice({ tone: "error", error: res.error! });
      setPreview(null);
    } else {
      setPreview(res.data?.data ?? null);
    }
  }

  /** Builds the nested tree for an assembly from flat edges (client-side). */
  function treeFor(assemblySku: string): BomNode[] {
    const byAssembly = new Map<string, BomEdge[]>();
    for (const e of data?.boms ?? []) {
      const list = byAssembly.get(e.assemblySku) ?? [];
      list.push(e);
      byAssembly.set(e.assemblySku, list);
    }
    const walk = (sku: string, path: Set<string>): BomNode[] =>
      (byAssembly.get(sku) ?? []).map((e): BomNode => {
        if (path.has(e.componentSku)) {
          return { sku: e.componentSku, name: "(cycle)", quantityPerParentThousandths: e.quantityThousandths, scrapPctThousandths: e.scrapPctThousandths, children: [] };
        }
        const nextPath = new Set(path);
        nextPath.add(e.componentSku);
        return {
          sku: e.componentSku,
          name: e.componentName,
          quantityPerParentThousandths: e.quantityThousandths,
          scrapPctThousandths: e.scrapPctThousandths,
          children: walk(e.componentSku, nextPath),
        };
      });
    return walk(assemblySku, new Set([assemblySku]));
  }

  const assembliesWithBoms = useMemo(() => {
    const set = new Set<string>();
    for (const e of data?.boms ?? []) set.add(e.assemblySku);
    return [...set];
  }, [data]);

  if (!data) return <LoadingPage />;
  if (!__enabled) return <ModuleDisabled label="Manufacturing" />;

  const TreeNodes = ({ nodes, depth }: { nodes: BomNode[]; depth: number }) => (
    <>
      {nodes.map((n) => (
        <Fragment key={n.sku}>
          <tr className="border-t border-stone-200">
            <td className="py-1" style={{ paddingLeft: depth * 20 }}>
              {depth > 0 && <span className="mr-1 opacity-40">↳</span>}
              <span className="font-mono">{n.sku}</span>
              <span className="ml-2 opacity-70">{n.name}</span>
            </td>
            <td className="text-right tabular-nums">{qty(n.quantityPerParentThousandths)}</td>
            <td className="text-right tabular-nums">{n.scrapPctThousandths ? pct(n.scrapPctThousandths) : "—"}</td>
            <td />
            <td />
          </tr>
          <TreeNodes nodes={n.children} depth={depth + 1} />
        </Fragment>
      ))}
    </>
  );

  return (
    <AppFrame
      appId="manufacturing"
      description="Bills of materials, production runs, and work orders"
      persistKey="manufacturing"
      tabs={[
        { id: "overview", label: "Overview" },
        { id: "boms", label: "BOMs", count: assembliesWithBoms.length || undefined },
        { id: "production", label: "Produce" },
        { id: "orders", label: "Work orders", count: (data.workOrders ?? []).length || undefined },
        { id: "runs", label: "Runs & lots" },
      ]}
      activeTab={tab}
      onTabChange={(id) => setTab(id as Tab)}
    >
      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}

      {tab === "overview" && (
        <ManufacturingOverview data={data} busy={busy} goTo={setTab} />
      )}

      {tab === "boms" && (
        <>
          <Card>
            <CardTitle>Define / replace a bill of materials</CardTitle>
            <div className="space-y-2 text-sm">
              <input
                className="w-64 rounded border bg-transparent px-2 py-1.5"
                placeholder="Assembly SKU"
                value={bomForm.assemblySku}
                onChange={(e) => setBomForm({ ...bomForm, assemblySku: e.target.value })}
              />
              {bomForm.components.map((c, idx) => (
                <div key={idx} className="flex flex-wrap gap-2">
                  <input
                    className="flex-1 rounded border bg-transparent px-2 py-1.5"
                    placeholder="Component SKU"
                    value={c.sku}
                    onChange={(e) => {
                      const next = [...bomForm.components];
                      next[idx] = { ...c, sku: e.target.value };
                      setBomForm({ ...bomForm, components: next });
                    }}
                  />
                  <input
                    className="w-28 rounded border bg-transparent px-2 py-1.5"
                    placeholder="Qty"
                    value={c.quantityThousandths}
                    onChange={(e) => {
                      const next = [...bomForm.components];
                      next[idx] = { ...c, quantityThousandths: String(Math.round(Number(e.target.value || "0") * 1000)) };
                      setBomForm({ ...bomForm, components: next });
                    }}
                  />
                  <input
                    className="w-24 rounded border bg-transparent px-2 py-1.5"
                    placeholder="Scrap %"
                    value={c.scrapPct}
                    onChange={(e) => {
                      const next = [...bomForm.components];
                      next[idx] = { ...c, scrapPct: e.target.value };
                      setBomForm({ ...bomForm, components: next });
                    }}
                  />
                </div>
              ))}
              <div className="flex gap-2">
                <Button
                  tone="ghost"
                  onClick={() => setBomForm({ ...bomForm, components: [...bomForm.components, { sku: "", quantityThousandths: "1000", scrapPct: "0" }] })}
                >
                  + Component
                </Button>
                <Button
                  disabled={busy || !bomForm.assemblySku}
                  onClick={() =>
                    void post(
                      {
                        action: "defineBom",
                        assemblySku: bomForm.assemblySku,
                        components: bomForm.components
                          .filter((c) => c.sku)
                          .map((c) => ({
                            sku: c.sku,
                            quantityThousandths: Number(c.quantityThousandths || "0"),
                            scrapPctThousandths: Math.round(Number(c.scrapPct || "0") * 10000),
                          })),
                      },
                      `Save BOM for ${bomForm.assemblySku}`,
                    )
                  }
                >
                  Save BOM
                </Button>
              </div>
              <p className="text-xs opacity-50">Saving replaces the whole bill; quantities accept decimals, scrap % is per component.</p>
            </div>
          </Card>

          {assembliesWithBoms.length === 0 ? (
            <EmptyState icon={<IconListTree />} title="No bills of materials yet" hint="Define one above so assemblies can be produced." />
          ) : (
            assembliesWithBoms.map((asm) => (
              <Card key={asm}>
                <CardTitle
                  right={
                    <div className="flex items-center gap-2">
                      <button
                        className="inline-flex cursor-pointer items-center gap-0.5 text-xs opacity-60 hover:opacity-100"
                        onClick={() => setOpenTree(openTree === asm ? null : asm)}
                      >
                        <IconChevronDown className={openTree === asm ? "rotate-180 transition-transform" : "transition-transform"} width={12} height={12} />
                        tree
                      </button>
                      <Button
                        tone="ghost"
                        disabled={busy}
                        onClick={() => void post({ action: "deleteBom", assemblySku: asm }, `Delete BOM ${asm}`)}
                      >
                        Delete BOM
                      </Button>
                    </div>
                  }
                >
                  <span className="font-mono">{asm}</span>
                </CardTitle>
                {openTree === asm ? (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left opacity-60">
                        <th className="py-1.5">Component</th>
                        <th className="text-right">Qty / parent</th>
                        <th className="text-right">Scrap</th>
                        <th />
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      <TreeNodes nodes={[{ sku: asm, name: "", quantityPerParentThousandths: 1000, scrapPctThousandths: 0, children: treeFor(asm) }]} depth={0} />
                    </tbody>
                  </table>
                ) : (
                  <ul className="text-sm opacity-80">
                    {(data.boms ?? [])
                      .filter((e) => e.assemblySku === asm)
                      .map((e) => (
                        <li key={`${e.assemblySku}-${e.componentSku}`}>
                          {e.componentName} ({e.componentSku}) × {qty(e.quantityThousandths)}
                          {e.scrapPctThousandths ? ` · scrap ${pct(e.scrapPctThousandths)}` : ""}
                          {assembliesWithBoms.includes(e.componentSku) && <Badge tone="violet">sub-assembly</Badge>}
                        </li>
                      ))}
                  </ul>
                )}
              </Card>
            ))
          )}
        </>
      )}

      {tab === "production" && (
        <Card>
          <CardTitle>Instant production run</CardTitle>
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-2">
              <input className="flex-1 rounded border bg-transparent px-2 py-1.5" placeholder="Assembly SKU" value={produce.assemblySku} onChange={(e) => setProduce({ ...produce, assemblySku: e.target.value })} />
              <input className="w-32 rounded border bg-transparent px-2 py-1.5" placeholder="Units to build" value={produce.qtyThousandths} onChange={(e) => setProduce({ ...produce, qtyThousandths: String(Math.round(Number(e.target.value || "0") * 1000)) })} />
              <input className="w-40 rounded border bg-transparent px-2 py-1.5" placeholder="Lot code (optional)" value={produce.lotCode} onChange={(e) => setProduce({ ...produce, lotCode: e.target.value })} />
            </div>
            <div className="flex gap-2">
              <Button tone="ghost" disabled={!produce.assemblySku || busy} onClick={() => void checkPreview()}>
                Preview cost
              </Button>
              <Button
                disabled={busy || !produce.assemblySku}
                onClick={() =>
                  void post(
                    {
                      action: "produceFromBom",
                      assemblySku: produce.assemblySku,
                      quantityThousandths: Number(produce.qtyThousandths || "0"),
                      ...(produce.lotCode ? { lotCode: produce.lotCode } : {}),
                    },
                    `Produce ${produce.assemblySku}`,
                  )
                }
              >
                Produce now
              </Button>
            </div>

            {preview && (
              <div className="rounded border p-3">
                <Badge tone={preview.producible ? "green" : "red"}>
                  {preview.producible ? "producible" : "short of parts"}
                </Badge>
                <table className="mt-2 w-full">
                  <thead>
                    <tr className="text-left opacity-60">
                      <th>SKU</th>
                      <th className="text-right">Required (incl. scrap)</th>
                      <th className="text-right">Unit cost</th>
                      <th className="text-right">Line cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.lines.map((l) => (
                      <tr key={l.sku} className="border-t">
                        <td className="py-1 font-mono">{l.sku}</td>
                        <td className="text-right tabular-nums">{qty(l.requiredThousandths)}</td>
                        <td className="text-right tabular-nums">{formatMoney(l.unitCostMinor)}</td>
                        <td className="text-right tabular-nums">{formatMoney(l.costMinor)}</td>
                      </tr>
                    ))}
                    <tr className="border-t font-medium">
                      <td colSpan={3} className="py-1 text-right">Total material cost</td>
                      <td className="text-right tabular-nums">{formatMoney(preview.totalCostMinor)}</td>
                    </tr>
                    <tr>
                      <td colSpan={3} className="py-1 text-right opacity-70">Finished avg unit cost</td>
                      <td className="text-right tabular-nums opacity-70">{formatMoney(preview.resultingAvgFinishedUnitCostMinor)}</td>
                    </tr>
                  </tbody>
                </table>
                <p className="mt-1 text-xs opacity-50">
                  This is what the run would post before anything moves — no ledger entries are written until you produce.
                </p>
              </div>
            )}
          </div>
        </Card>
      )}

      {tab === "orders" && (
        <>
          <Card>
            <CardTitle>Plan a work order</CardTitle>
            <div className="flex flex-wrap gap-2 text-sm">
              <input className="w-40 rounded border bg-transparent px-2 py-1.5" placeholder="Assembly SKU" value={woForm.assemblySku} onChange={(e) => setWoForm({ ...woForm, assemblySku: e.target.value })} />
              <input className="w-28 rounded border bg-transparent px-2 py-1.5" placeholder="Planned units" value={woForm.plannedQty} onChange={(e) => setWoForm({ ...woForm, plannedQty: e.target.value })} />
              <input className="w-24 rounded border bg-transparent px-2 py-1.5" placeholder="Yield %" value={woForm.yieldPct} onChange={(e) => setWoForm({ ...woForm, yieldPct: e.target.value })} />
              <input className="flex-1 rounded border bg-transparent px-2 py-1.5" placeholder="Note (optional)" value={woForm.note} onChange={(e) => setWoForm({ ...woForm, note: e.target.value })} />
              <Button
                disabled={busy || !woForm.assemblySku || !Number(woForm.plannedQty)}
                onClick={() =>
                  void post(
                    {
                      action: "createWorkOrder",
                      assemblySku: woForm.assemblySku,
                      plannedQtyThousandths: Math.round(Number(woForm.plannedQty || "0") * 1000),
                      yieldPctThousandths: Math.round(Number(woForm.yieldPct || "100") * 10000),
                      ...(woForm.note ? { note: woForm.note } : {}),
                    },
                    `Create WO for ${woForm.assemblySku}`,
                  ).then((ok) => ok && setWoForm({ assemblySku: "", plannedQty: "10", yieldPct: "100", note: "" }))
                }
              >
                Create draft
              </Button>
            </div>
            <p className="mt-1 text-xs opacity-50">Draft → release → complete in parts. Nothing touches stock until release and completion.</p>
          </Card>

          {(data.workOrders ?? []).map((w) => (
            <Card key={w.id}>
              <CardTitle right={<Badge tone={w.status === "completed" ? "green" : w.status === "released" ? "blue" : w.status === "cancelled" ? "red" : "neutral"}>{w.status}</Badge>}>
                WO #{w.number} · <span className="font-mono">{w.assemblySku}</span>
              </CardTitle>
              <p className="text-sm opacity-80">
                Planned {qty(w.plannedQtyThousandths)} · produced {qty(w.producedQtyThousandths)} · expected good at {pct(w.yieldPctThousandths)} yield ≈ {qty(w.expectedGoodThousandths)}
                {w.note ? ` · ${w.note}` : ""}
              </p>
              <div className="mt-2 flex flex-wrap gap-2 text-sm">
                {w.status === "draft" && (
                  <Button disabled={busy} onClick={() => void post({ action: "releaseWorkOrder", workOrderId: w.id }, `Release WO #${w.number}`)}>
                    Release for production
                  </Button>
                )}
                {w.status === "released" && (
                  <>
                    <input
                      className="w-28 rounded border bg-transparent px-2 py-1"
                      placeholder={`Complete (${qty(w.plannedQtyThousandths - w.producedQtyThousandths)} left)`}
                      value={woCompletion[w.id] ?? ""}
                      onChange={(e) => setWoCompletion({ ...woCompletion, [w.id]: e.target.value })}
                    />
                    <Button
                      disabled={busy || !Number(woCompletion[w.id])}
                      onClick={() =>
                        void post(
                          {
                            action: "completeWorkOrder",
                            workOrderId: w.id,
                            quantityThousandths: Math.round(Number(woCompletion[w.id] || "0") * 1000),
                          },
                          `Complete WO #${w.number}`,
                        ).then(() => setWoCompletion((prev) => ({ ...prev, [w.id]: "" })))
                      }
                    >
                      Record completion
                    </Button>
                    <Button tone="ghost" disabled={busy} onClick={() => void post({ action: "cancelWorkOrder", workOrderId: w.id }, `Cancel WO #${w.number}`)}>
                      Cancel
                    </Button>
                  </>
                )}
              </div>
            </Card>
          ))}
        </>
      )}

      {tab === "runs" && (
        <>
          <Card>
            <CardTitle>Production history</CardTitle>
            {(data.productionRuns ?? []).length === 0 ? (
              <EmptyState icon={<IconListTree />} title="No runs yet" hint="Completed instant runs and work-order completions appear here." />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left opacity-60">
                    <th className="py-1.5">When</th>
                    <th>Assembly</th>
                    <th className="text-right">Produced</th>
                    <th className="text-right">Cost</th>
                    <th>Components</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(data.productionRuns ?? []).map((r) => (
                    <tr key={r.runId} className={`border-t ${r.reversed ? "line-through opacity-50" : ""}`}>
                      <td className="whitespace-nowrap py-1.5 opacity-70">{formatDateTime(r.occurredAt)}</td>
                      <td className="font-mono">{r.assemblySku}</td>
                      <td className="text-right tabular-nums">{qty(r.producedThousandths)}</td>
                      <td className="text-right tabular-nums">{formatMoney(r.costTotalMinor)}</td>
                      <td className="max-w-72 truncate text-xs opacity-70" title={r.components.map((c) => `${c.sku}×${qty(c.quantityThousandths)}${c.lotCode ? `[${c.lotCode}]` : ""}`).join(", ")}>
                        {r.components.map((c) => `${c.sku}×${qty(c.quantityThousandths)}${c.lotCode ? `[${c.lotCode}]` : ""}`).join(", ")}
                      </td>
                      <td className="text-right whitespace-nowrap">
                        {r.reversed ? <Badge tone="neutral">reversed</Badge> : (
                          <Button tone="ghost" disabled={busy} onClick={() => void post({ action: "reverseProductionRun", runId: r.runId }, "Reverse run")}>
                            Reverse
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card>
            <CardTitle>Batches & lots</CardTitle>
            {(data.lots ?? []).length === 0 ? (
              <p className="text-sm opacity-60">Lot-tagged stock appears here once you produce with a lot code or receive tagged batches.</p>
            ) : (
              <ul className="divide-y text-sm">
                {(data.lots ?? []).map((l) => (
                  <li key={l.id} className="flex items-center justify-between py-1.5">
                    <span>
                      <span className="font-mono">{l.lotCode}</span> of {l.sku} — balance {qty(l.balanceThousandths)}
                      {l.expiresAt ? ` · expires ${formatDateTime(l.expiresAt)}` : ""}
                    </span>
                    <a
                      className="cursor-pointer text-xs underline opacity-60 hover:opacity-100"
                      href={`/api/manufacturing?sku=${encodeURIComponent(l.sku)}&lotCode=${encodeURIComponent(l.lotCode)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      trace upstream
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardTitle>Reverse a run manually</CardTitle>
            <div className="flex gap-2 text-sm">
              <input className="flex-1 rounded border bg-transparent px-2 py-1.5 font-mono" placeholder="run id" value={reverseRunId} onChange={(e) => setReverseRunId(e.target.value)} />
              <Button disabled={busy || !reverseRunId} onClick={() => void post({ action: "reverseProductionRun", runId: reverseRunId }, "Reverse run").then((ok) => ok && setReverseRunId(""))}>
                Reverse
              </Button>
            </div>
            <p className="mt-1 text-xs opacity-50">
              Reversal puts consumed components back at their original cost and removes finished units — both sides of the run, not just the output.
            </p>
          </Card>
        </>
      )}
    </AppFrame>
  );
}

/* -------------------------------------------------------------- overview --- */

function ManufacturingOverview({
  data,
  busy,
  goTo,
}: {
  data: Payload;
  busy: boolean;
  goTo: (tab: Tab) => void;
}) {
  void busy;
  const orders = data.workOrders ?? [];
  const drafts = orders.filter((w) => w.status === "draft");
  const released = orders.filter((w) => w.status === "released");
  const completed = orders.filter((w) => w.status === "completed");
  const runs = data.productionRuns ?? [];
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const runsThisMonth = runs.filter((r) => new Date(r.occurredAt).getTime() >= monthStart.getTime() && !r.reversed);
  const producedThisMonth = runsThisMonth.reduce((s, r) => s + r.producedThousandths, 0);
  const costThisMonth = runsThisMonth.reduce((s, r) => s + r.costTotalMinor, 0);
  const lots = data.lots ?? [];
  const expiringSoon = lots.filter((l) => {
    if (!l.expiresAt) return false;
    const days = (new Date(l.expiresAt).getTime() - Date.now()) / 86400000;
    return days <= 30;
  });

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Open work orders" value={drafts.length + released.length} sub={`${released.length} released`} />
        <StatCard label="Assemblies with BOMs" value={(data.boms ? new Set(data.boms.map((b) => b.assemblySku)).size : 0)} />
        <StatCard label="Produced this month" value={qty(producedThisMonth)} sub={`${runsThisMonth.length} run${runsThisMonth.length === 1 ? "" : "s"}`} />
        <StatCard label="Production cost · month" value={formatMoney(costThisMonth)} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle
            right={
              drafts.length + released.length > 0 ? (
                <Button tone="ghost" onClick={() => goTo("orders")}>
                  All work orders →
                </Button>
              ) : undefined
            }
          >
            Work orders in flight
          </CardTitle>
          {drafts.length + released.length === 0 ? (
            <EmptyState
              icon={<IconListTree />}
              title="No open work orders"
              hint="Plan one from a BOM, or produce directly from the Produce tab."
            />
          ) : (
            <ul className="divide-y text-sm">
              {[...released, ...drafts].slice(0, 5).map((w) => (
                <li key={w.id} className="flex items-center justify-between gap-2 py-2">
                  <span>
                    WO #{w.number} · <span className="font-mono text-xs">{w.assemblySku}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums text-xs opacity-70">
                      {qty(w.producedQtyThousandths)}/{qty(w.plannedQtyThousandths)}
                    </span>
                    <Badge tone={w.status === "released" ? "blue" : "neutral"}>{w.status}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardTitle>Watch list</CardTitle>
          {completed.length === 0 && expiringSoon.length === 0 ? (
            <p className="text-sm opacity-60">Nothing needs attention on the floor.</p>
          ) : (
            <ul className="divide-y text-sm">
              {expiringSoon.slice(0, 4).map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-2 py-2">
                  <span>
                    Lot <span className="font-mono text-xs">{l.lotCode}</span> of {l.sku}
                  </span>
                  <Badge tone="amber">expires {formatDateTime(l.expiresAt!)}</Badge>
                </li>
              ))}
              {completed.length > 0 && (
                <li className="flex items-center justify-between gap-2 py-2 text-xs opacity-60">
                  {completed.length} work order{completed.length === 1 ? "" : "s"} completed all-time · history under Runs &amp; lots
                </li>
              )}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
