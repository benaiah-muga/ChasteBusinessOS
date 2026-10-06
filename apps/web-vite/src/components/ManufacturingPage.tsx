import { Fragment, useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { currencyMinorUnits } from "@chaste/erp-core";
import "./ManufacturingPage.css";
import {
  ManufacturingApiError,
  fetchManufacturingBomReport,
  fetchManufacturingEnabled,
  fetchManufacturingReport,
  fetchProductionCostPreview,
  fetchProductionFeasibility,
  submitManufacturingAction,
  type ManufacturingBomEdge,
  type ManufacturingBomReport,
  type ManufacturingCostPreview,
  type ManufacturingFeasibility,
  type ManufacturingLot,
  type ManufacturingProductionRun,
  type ManufacturingReport,
  type ManufacturingWorkOrder,
  type ManufacturingWriteAction,
} from "../api/manufacturing";
import { legacyUrl } from "../legacy";
import "./ManufacturingPage.css";

type Tab = "overview" | "boms" | "production" | "orders" | "runs";
const TABS: readonly Tab[] = ["overview", "boms", "production", "orders", "runs"];
const TAB_LABELS: Record<Tab, string> = { overview: "Overview", boms: "BOMs", production: "Produce", orders: "Work orders", runs: "Runs & lots" };

type PageState =
  | { status: "loading" }
  | { status: "disabled" }
  | { status: "failed"; error: ManufacturingApiError }
  | { status: "ready"; report: ManufacturingReport };

type Notice = { tone: "success" | "pending" | "error"; text: string };
type BomComponentRow = { sku: string; quantityThousandths: string; scrapPct: string };
type BomComponent = { sku: string; quantityThousandths: number; scrapPctThousandths: number };
type BomNode = { sku: string; name: string; quantityPerParentThousandths: number; scrapPctThousandths: number; children: BomNode[] };

const styles = {
  page: { display: "grid", gap: 20, alignContent: "start" },
  header: { display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 16 },
  eyebrow: { margin: "0 0 6px", color: "#84744e", fontSize: 11, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase" },
  heading: { margin: "0 0 6px", fontSize: 26, letterSpacing: "-0.04em" },
  lede: { margin: 0, maxWidth: "58ch", color: "#6e6d65", fontSize: 13, lineHeight: 1.6 },
  fullWorkspace: { color: "#6b5a2e", fontSize: 12, fontWeight: 600 },
  notice: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, border: "1px solid #dedbd2", borderRadius: 10, padding: "10px 14px", fontSize: 13 },
  noticeSuccess: { border: "1px solid #b7d6c1", background: "#f1f8f3" },
  noticePending: { border: "1px solid #e2d3a2", background: "#fbf7ea" },
  noticeError: { border: "1px solid #e5b6ae", background: "#fdf3f1" },
  tabs: { display: "flex", flexWrap: "wrap", gap: 6, borderBottom: "1px solid #e2dfd6", paddingBottom: 10 },
  tab: { border: "1px solid transparent", borderRadius: 8, padding: "6px 12px", background: "transparent", color: "#5f5e57", cursor: "pointer", fontSize: 12, fontWeight: 600 },
  tabActive: { borderColor: "#d9d6cc", background: "#fff", color: "#2f342c" },
  panel: { display: "grid", gap: 12, border: "1px solid #e2dfd6", borderRadius: 14, padding: 18, background: "rgb(255 255 255 / 76%)" },
  panelTitleRow: { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 },
  panelTitle: { margin: 0, fontSize: 15, letterSpacing: "-0.03em" },
  fieldRow: { display: "flex", flexWrap: "wrap", gap: 8 },
  label: { display: "grid", gap: 4, fontSize: 11, fontWeight: 600, color: "#6e6d65" },
  input: { minHeight: 34, border: "1px solid #d9d6cc", borderRadius: 8, padding: "0 10px", background: "#fff", color: "inherit", fontSize: 13 },
  code: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.95em" },
  button: { minHeight: 34, border: "1px solid #d9d6cc", borderRadius: 8, padding: "0 12px", background: "#fff", color: "#343830", cursor: "pointer", fontSize: 12, fontWeight: 600 },
  ghostButton: { minHeight: 30, border: "1px solid transparent", borderRadius: 8, padding: "0 10px", background: "transparent", color: "#4c4f47", cursor: "pointer", fontSize: 12, fontWeight: 600 },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, borderTop: "1px solid #eceae4", paddingTop: 10 },
  hint: { margin: 0, color: "#85847c", fontSize: 11, lineHeight: 1.6 },
  stats: { display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" },
  stat: { display: "grid", gap: 4, border: "1px solid #e2dfd6", borderRadius: 14, padding: 16, background: "rgb(255 255 255 / 76%)", cursor: "pointer", textAlign: "left" },
  statLabel: { color: "#6e6d65", fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" },
  statValue: { fontSize: 22, letterSpacing: "-0.04em" },
  statSub: { color: "#85847c", fontSize: 11 },
  list: { display: "grid", gap: 0, margin: 0, padding: 0, listStyle: "none" },
  listItem: { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8, borderTop: "1px solid #eceae4", padding: "9px 0", fontSize: 13 },
  badge: { display: "inline-block", borderRadius: 99, padding: "2px 8px", fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" },
  badgeNeutral: { background: "#eeece5", color: "#57564f" },
  badgeGreen: { background: "#dff0e4", color: "#2f6b45" },
  badgeRed: { background: "#f8e0dc", color: "#9d382c" },
  badgeAmber: { background: "#f7ecd2", color: "#8a6b1c" },
  badgeBlue: { background: "#dde8f5", color: "#2c5183" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  tableHead: { textAlign: "left", color: "#77766e", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" },
  numeric: { textAlign: "right", fontVariantNumeric: "tabular-nums" },
  inset: { display: "grid", gap: 8, border: "1px solid #e5e3db", borderRadius: 10, padding: 12, background: "#faf9f5" },
  empty: { margin: 0, color: "#6e6d65", fontSize: 13, lineHeight: 1.6 },
} satisfies Record<string, CSSProperties>;

function qty(thousandths: number): string {
  return (thousandths / 1000).toFixed(3);
}

function pct(tenThousandths: number): string {
  return `${(tenThousandths / 10000).toFixed(1)}%`;
}

function formatMoney(minor: number, currency: string): string {
  const minorUnits = currencyMinorUnits(currency) ?? 2;
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    minimumFractionDigits: minorUnits,
    maximumFractionDigits: minorUnits,
  }).format(minor / (10 ** minorUnits));
}

function formatDateTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? "Unknown date" : new Date(timestamp).toLocaleString();
}

/** Units typed by a human into integer thousandths, rejecting empty and negative input. */
function toThousandths(units: string): number | null {
  const value = Number(units);
  if (!Number.isFinite(value) || value <= 0) return null;
  const thousandths = Math.round(value * 1000);
  return Number.isSafeInteger(thousandths) && thousandths > 0 ? thousandths : null;
}

/** A percentage typed by a human into integer hundredths of a percent (10000 = 100%). */
function toTenThousandths(percent: string, fallbackPercent: number): number | null {
  const value = Number(percent.trim() === "" ? fallbackPercent : percent);
  if (!Number.isFinite(value) || value < 0) return null;
  const scaled = Math.round(value * 10000);
  return Number.isSafeInteger(scaled) ? scaled : null;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof ManufacturingApiError ? error.message : fallback;
}

function initialTab(): Tab {
  const requested = new URLSearchParams(window.location.search).get("tab");
  return TABS.includes(requested as Tab) ? (requested as Tab) : "overview";
}

function useTabParam(): [Tab, (tab: Tab) => void] {
  const [tab, setTab] = useState<Tab>(initialTab);
  const select = useCallback((next: Tab) => {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url);
  }, []);
  return [tab, select];
}

/** Flattens the raw BOM edges into the nested tree the legacy page renders client-side. */
function buildBomTree(edges: ManufacturingBomEdge[], assemblySku: string): BomNode[] {
  const byAssembly = new Map<string, ManufacturingBomEdge[]>();
  for (const edge of edges) {
    const list = byAssembly.get(edge.assemblySku) ?? [];
    list.push(edge);
    byAssembly.set(edge.assemblySku, list);
  }
  const walk = (sku: string, path: ReadonlySet<string>): BomNode[] =>
    (byAssembly.get(sku) ?? []).map((edge) => {
      if (path.has(edge.componentSku)) {
        return { sku: edge.componentSku, name: "(cycle)", quantityPerParentThousandths: edge.quantityThousandths, scrapPctThousandths: edge.scrapPctThousandths, children: [] };
      }
      const nextPath = new Set(path);
      nextPath.add(edge.componentSku);
      return {
        sku: edge.componentSku,
        name: edge.componentName,
        quantityPerParentThousandths: edge.quantityThousandths,
        scrapPctThousandths: edge.scrapPctThousandths,
        children: walk(edge.componentSku, nextPath),
      };
    });
  return walk(assemblySku, new Set([assemblySku]));
}

function componentsSummary(run: ManufacturingProductionRun): string {
  return run.components
    .map((component) => `${component.sku}×${qty(component.quantityThousandths)}${component.lotCode ? `[${component.lotCode}]` : ""}`)
    .join(", ");
}

function StatusBadge({ tone, children }: { tone: "neutral" | "green" | "red" | "amber" | "blue"; children: ReactNode }) {
  const toneStyle = { neutral: styles.badgeNeutral, green: styles.badgeGreen, red: styles.badgeRed, amber: styles.badgeAmber, blue: styles.badgeBlue }[tone];
  return <span style={{ ...styles.badge, ...toneStyle }}>{children}</span>;
}

function BomTreeRows({ nodes, depth }: { nodes: BomNode[]; depth: number }) {
  return (
    <>
      {nodes.map((node, index) => (
        <Fragment key={`${node.sku}-${depth}-${index}`}>
          <tr>
            <td style={{ paddingLeft: depth * 20, paddingTop: 4, paddingBottom: 4 }}>
              {depth > 0 && <span style={{ marginRight: 4, opacity: 0.4 }}>↳</span>}
              <span style={styles.code}>{node.sku}</span>
              {node.name && <span style={{ marginLeft: 8, opacity: 0.7 }}>{node.name}</span>}
            </td>
            <td style={styles.numeric}>{qty(node.quantityPerParentThousandths)}</td>
            <td style={styles.numeric}>{node.scrapPctThousandths ? pct(node.scrapPctThousandths) : "-"}</td>
            <td />
            <td />
          </tr>
          <BomTreeRows nodes={node.children} depth={depth + 1} />
        </Fragment>
      ))}
    </>
  );
}

function ShortfallTable({ lines, byItemId }: { lines: Array<{ key?: string; sku: string; name: string; requiredThousandths: number; onHandThousandths: number; shortfallThousandths: number }>; byItemId: boolean }) {
  return (
    <table style={styles.table}>
      <thead>
        <tr style={styles.tableHead}>
          <th scope="col">Component</th>
          <th scope="col" style={styles.numeric}>Required</th>
          <th scope="col" style={styles.numeric}>On hand</th>
          <th scope="col" style={styles.numeric}>Shortfall</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => (
          <tr key={line.key ?? line.sku}>
            <td style={{ paddingTop: 4, paddingBottom: 4 }}>
              <span style={styles.code}>{byItemId ? (line.key ?? line.sku).slice(0, 8) : line.sku}</span>
              {!byItemId && line.name && <span style={{ marginLeft: 6, opacity: 0.7 }}>{line.name}</span>}
            </td>
            <td style={styles.numeric}>{qty(line.requiredThousandths)}</td>
            <td style={styles.numeric}>{qty(line.onHandThousandths)}</td>
            <td style={{ ...styles.numeric, ...(line.shortfallThousandths > 0 ? { color: "#9d382c", fontWeight: 600 } : { opacity: 0.5 }) }}>
              {line.shortfallThousandths > 0 ? qty(line.shortfallThousandths) : "-"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ManufacturingPage({ baseCurrency = null, actorId = null, organizationId = null }: { baseCurrency?: string | null; actorId?: string | null; organizationId?: string | null }) {
  const currency = baseCurrency || "USD";
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useTabParam();

  const [bomAssemblySku, setBomAssemblySku] = useState("");
  const [bomComponents, setBomComponents] = useState<BomComponentRow[]>([{ sku: "", quantityThousandths: "1", scrapPct: "0" }]);
  const [openTree, setOpenTree] = useState<string | null>(null);
  const [unitsInput, setUnitsInput] = useState("1");
  const [feasibility, setFeasibility] = useState<(ManufacturingFeasibility & { assemblySku: string }) | null>(null);
  const [bomReport, setBomReport] = useState<(ManufacturingBomReport & { assemblySku: string }) | null>(null);

  const [produceAssemblySku, setProduceAssemblySku] = useState("");
  const [produceUnits, setProduceUnits] = useState("1");
  const [produceLotCode, setProduceLotCode] = useState("");
  const [preview, setPreview] = useState<ManufacturingCostPreview | null>(null);

  const [woAssemblySku, setWoAssemblySku] = useState("");
  const [woPlannedUnits, setWoPlannedUnits] = useState("10");
  const [woYieldPct, setWoYieldPct] = useState("100");
  const [woNote, setWoNote] = useState("");
  const [woCompletion, setWoCompletion] = useState<Record<string, string>>({});

  const [reverseRunId, setReverseRunId] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const enabled = await fetchManufacturingEnabled(signal);
      if (signal?.aborted) return;
      if (!enabled) {
        setState({ status: "disabled" });
        return;
      }
      const report = await fetchManufacturingReport(signal);
      if (!signal?.aborted) setState({ status: "ready", report });
    } catch (error) {
      if (signal?.aborted) return;
      setState({
        status: "failed",
        error: error instanceof ManufacturingApiError
          ? error
          : new ManufacturingApiError(0, "Could not reach the manufacturing service. Check your connection and try again."),
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshError(null);
    try {
      const report = await fetchManufacturingReport();
      setState({ status: "ready", report });
    } catch (error) {
      setRefreshError(errorText(error, "The action completed, but manufacturing could not refresh. Reload the page to see the latest status."));
    }
  }, []);

  async function run(action: ManufacturingWriteAction, label: string): Promise<boolean> {
    setBusy(true);
    setNotice(null);
    try {
      const result = await submitManufacturingAction(action, undefined, { retryScope: { actorId, organizationId } });
      if (result.kind === "pending") {
        setNotice({ tone: "pending", text: `${label} requires approval. ${result.reason}` });
        return false;
      }
      setNotice({ tone: "success", text: `${label} done.` });
      await refresh();
      return true;
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error, `${label} failed. Try again.`) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function read<T>(work: () => Promise<T>, onSuccess: (result: T) => void, onFailure: () => void, fallback: string) {
    setBusy(true);
    setNotice(null);
    try {
      onSuccess(await work());
    } catch (error) {
      onFailure();
      setNotice({ tone: "error", text: errorText(error, fallback) });
    } finally {
      setBusy(false);
    }
  }

  function saveBom() {
    const assemblySku = bomAssemblySku.trim();
    const components = bomComponents
      .map((row): BomComponent | null => {
        const quantityThousandths = toThousandths(row.quantityThousandths);
        const scrapPctThousandths = toTenThousandths(row.scrapPct, 0);
        if (!row.sku.trim() || quantityThousandths === null || scrapPctThousandths === null) return null;
        return { sku: row.sku.trim(), quantityThousandths, scrapPctThousandths };
      })
      .filter((row): row is BomComponent => row !== null);
    if (!assemblySku || components.length === 0) {
      setNotice({ tone: "error", text: "Enter an assembly SKU and at least one component with a quantity above zero." });
      return;
    }
    void run({ action: "defineBom", assemblySku, components }, `Save BOM for ${assemblySku}`);
  }

  function checkFeasibility(assemblySku: string) {
    const desired = toThousandths(unitsInput);
    if (desired === null) {
      setNotice({ tone: "error", text: "Enter how many units you want to build before checking feasibility." });
      return;
    }
    void read(
      () => fetchProductionFeasibility(assemblySku, desired),
      (result) => setFeasibility({ ...result, assemblySku }),
      () => setFeasibility(null),
      "Could not check production feasibility.",
    );
  }

  function runBomReport(assemblySku: string) {
    const desired = toThousandths(unitsInput);
    if (desired === null) {
      setNotice({ tone: "error", text: "Enter how many units you want to build before running the BOM report." });
      return;
    }
    void read(
      () => fetchManufacturingBomReport(assemblySku, desired),
      (result) => setBomReport({ ...result, assemblySku }),
      () => setBomReport(null),
      "Could not build the BOM report.",
    );
  }

  function previewCost() {
    const quantity = toThousandths(produceUnits);
    if (quantity === null) {
      setNotice({ tone: "error", text: "Enter how many units to build before previewing cost." });
      return;
    }
    void read(
      () => fetchProductionCostPreview(produceAssemblySku.trim(), quantity),
      setPreview,
      () => setPreview(null),
      "Could not preview production cost.",
    );
  }

  function produceNow() {
    const quantity = toThousandths(produceUnits);
    if (quantity === null) {
      setNotice({ tone: "error", text: "Enter how many units to build before producing." });
      return;
    }
    void run({
      action: "produceFromBom",
      assemblySku: produceAssemblySku.trim(),
      quantityThousandths: quantity,
      ...(produceLotCode.trim() ? { lotCode: produceLotCode.trim() } : {}),
    }, `Produce ${produceAssemblySku.trim()}`);
  }

  function createWorkOrder() {
    const planned = toThousandths(woPlannedUnits);
    const yieldPctThousandths = toTenThousandths(woYieldPct, 100);
    if (!woAssemblySku.trim() || planned === null || planned > 2_147_483_647 || yieldPctThousandths === null || yieldPctThousandths > 1_000_000 || woNote.trim().length > 500) {
      setNotice({ tone: "error", text: "Enter an assembly SKU, a supported planned quantity, a yield percent from zero to 100, and a note up to 500 characters." });
      return;
    }
    void run({
      action: "createWorkOrder",
      assemblySku: woAssemblySku.trim(),
      plannedQtyThousandths: planned,
      yieldPctThousandths,
      ...(woNote.trim() ? { note: woNote.trim() } : {}),
    }, `Create WO for ${woAssemblySku.trim()}`).then((created) => {
      if (created) {
        setWoAssemblySku("");
        setWoPlannedUnits("10");
        setWoYieldPct("100");
        setWoNote("");
      }
    });
  }

  function completeWorkOrder(order: ManufacturingWorkOrder) {
    const quantity = toThousandths(woCompletion[order.id] ?? "");
    if (quantity === null) {
      setNotice({ tone: "error", text: `Enter how many units to record on WO #${order.number}.` });
      return;
    }
    void run({ action: "completeWorkOrder", workOrderId: order.id, quantityThousandths: quantity }, `Complete WO #${order.number}`)
      .then((completed) => {
        if (completed) setWoCompletion((current) => ({ ...current, [order.id]: "" }));
      });
  }

  function reverseRun(runId: string, label: string) {
    void run({ action: "reverseProductionRun", runId }, label).then((reversed) => {
      if (reversed && runId === reverseRunId.trim()) setReverseRunId("");
    });
  }

  const report = state.status === "ready" ? state.report : null;
  const boms = report?.boms ?? [];
  const workOrders = report?.workOrders ?? [];
  const productionRuns = report?.productionRuns ?? [];
  const lots = report?.lots ?? [];
  const assembliesWithBoms = useMemo(() => [...new Set(boms.map((edge) => edge.assemblySku))], [boms]);

  if (state.status === "loading") return <main className="manufacturing-page"><p role="status">Loading bills of materials, work orders, and production runs…</p></main>;

  if (state.status === "disabled") {
    return (
      <main className="manufacturing-page">
        <section style={styles.panel} role="status">
          <h1 style={styles.heading}>Manufacturing is turned off</h1>
          <p style={styles.lede}>Ask a workspace administrator to enable the Manufacturing module before planning or recording production.</p>
        </section>
      </main>
    );
  }

  if (state.status === "failed") {
    return (
      <main className="manufacturing-page">
        <section style={{ ...styles.panel, border: "1px solid #e5b6ae" }} role="alert" aria-labelledby="manufacturing-error-title">
          <div>
            <p style={styles.eyebrow}>Manufacturing unavailable</p>
            <h2 id="manufacturing-error-title" style={{ margin: "0 0 6px", fontSize: 18 }}>Could not load manufacturing records</h2>
            <p style={styles.lede}>{state.error.message}</p>
          </div>
          <div style={styles.fieldRow}>
            {state.error.status === 401 && <a href="/login">Sign in again</a>}
            <button type="button" style={styles.button} onClick={() => void load()}>Try again</button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="manufacturing-page">
      <header style={styles.header}>
        <div>
          <p style={styles.eyebrow}>Operations</p>
          <h1 style={styles.heading}>Manufacturing</h1>
          <p style={styles.lede}>Bills of materials, production runs, and work orders.</p>
        </div>
        <a style={styles.fullWorkspace} href={legacyUrl("/manufacturing")}>Open full manufacturing workspace</a>
      </header>

      <nav style={styles.tabs} aria-label="Manufacturing sections">
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            style={{ ...styles.tab, ...(tab === id ? styles.tabActive : {}) }}
            onClick={() => setTab(id)}
          >
            {TAB_LABELS[id]}
            {id === "boms" && assembliesWithBoms.length > 0 && ` (${assembliesWithBoms.length})`}
            {id === "orders" && workOrders.length > 0 && ` (${workOrders.length})`}
          </button>
        ))}
      </nav>

      {notice && (
        <p style={{ ...styles.notice, ...(notice.tone === "success" ? styles.noticeSuccess : notice.tone === "pending" ? styles.noticePending : styles.noticeError) }} role={notice.tone === "error" ? "alert" : "status"}>
          <span>{notice.text}</span>
          <button type="button" style={styles.ghostButton} aria-label="Dismiss notice" onClick={() => setNotice(null)}>×</button>
        </p>
      )}
      {refreshError && <p style={{ ...styles.notice, ...styles.noticeError }} role="alert">{refreshError}</p>}

      {tab === "overview" && report && (
        <ManufacturingOverview
          report={report}
          currency={currency}
          goTo={setTab}
        />
      )}

      {tab === "boms" && (
        <>
          <section style={styles.panel} aria-labelledby="bom-define-title">
            <h2 id="bom-define-title" style={styles.panelTitle}>Define / replace a bill of materials</h2>
            <div style={styles.fieldRow}>
              <label style={styles.label}>
                Assembly SKU
                <input
                  style={{ ...styles.input, width: 220 }}
                  aria-label="Assembly SKU"
                  value={bomAssemblySku}
                  onChange={(event) => setBomAssemblySku(event.target.value)}
                />
              </label>
            </div>
            {bomComponents.map((component, index) => (
              <div key={index} style={styles.fieldRow}>
                <label style={{ ...styles.label, flex: "1 1 220px" }}>
                  Component SKU
                  <input
                    style={{ ...styles.input, width: "100%" }}
                    aria-label={`Component SKU ${index + 1}`}
                    value={component.sku}
                    onChange={(event) => setBomComponents((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, sku: event.target.value } : row))}
                  />
                </label>
                <label style={styles.label}>
                  Qty per unit
                  <input
                    style={{ ...styles.input, width: 110 }}
                    aria-label={`Component ${index + 1} quantity per unit`}
                    inputMode="decimal"
                    value={component.quantityThousandths}
                    onChange={(event) => setBomComponents((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, quantityThousandths: event.target.value } : row))}
                  />
                </label>
                <label style={styles.label}>
                  Scrap %
                  <input
                    style={{ ...styles.input, width: 90 }}
                    aria-label={`Component ${index + 1} scrap percent`}
                    inputMode="decimal"
                    value={component.scrapPct}
                    onChange={(event) => setBomComponents((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, scrapPct: event.target.value } : row))}
                  />
                </label>
                <button
                  type="button"
                  style={styles.ghostButton}
                  aria-label={`Remove component ${index + 1}`}
                  onClick={() => setBomComponents((current) => current.length === 1 ? [{ ...current[0]!, sku: "" }] : current.filter((_, rowIndex) => rowIndex !== index))}
                >
                  Remove
                </button>
              </div>
            ))}
            <div style={styles.fieldRow}>
              <button
                type="button"
                style={styles.ghostButton}
                onClick={() => setBomComponents((current) => [...current, { sku: "", quantityThousandths: "1", scrapPct: "0" }])}
              >
                + Component
              </button>
              <button type="button" style={styles.button} disabled={busy || !bomAssemblySku.trim()} onClick={saveBom}>Save BOM</button>
            </div>
            <p style={styles.hint}>Saving replaces the whole bill. Quantities accept decimals, scrap % is per component.</p>
          </section>

          {assembliesWithBoms.length === 0 ? (
            <section style={styles.panel}>
              <h2 style={styles.panelTitle}>No bills of materials yet</h2>
              <p style={styles.empty}>Define one above so assemblies can be produced.</p>
            </section>
          ) : assembliesWithBoms.map((assemblySku) => {
            const tree = buildBomTree(boms, assemblySku);
            return (
              <section key={assemblySku} style={styles.panel} aria-labelledby={`bom-${assemblySku}`}>
                <div style={styles.panelTitleRow}>
                  <h2 id={`bom-${assemblySku}`} style={styles.panelTitle}>
                    <span style={styles.code}>{assemblySku}</span>
                  </h2>
                  <div style={styles.fieldRow}>
                    <button
                      type="button"
                      style={styles.ghostButton}
                      aria-expanded={openTree === assemblySku}
                      onClick={() => setOpenTree(openTree === assemblySku ? null : assemblySku)}
                    >
                      {openTree === assemblySku ? "Hide tree" : "tree"}
                    </button>
                    <button type="button" style={styles.ghostButton} disabled={busy} onClick={() => void run({ action: "deleteBom", assemblySku }, `Delete BOM ${assemblySku}`)}>
                      Delete BOM
                    </button>
                  </div>
                </div>

                {openTree === assemblySku ? (
                  <table style={styles.table}>
                    <thead>
                      <tr style={styles.tableHead}>
                        <th scope="col">Component</th>
                        <th scope="col" style={styles.numeric}>Qty / parent</th>
                        <th scope="col" style={styles.numeric}>Scrap</th>
                        <th />
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      <BomTreeRows nodes={[{ sku: assemblySku, name: "", quantityPerParentThousandths: 1000, scrapPctThousandths: 0, children: tree }]} depth={0} />
                    </tbody>
                  </table>
                ) : (
                  <ul style={styles.list}>
                    {boms.filter((edge) => edge.assemblySku === assemblySku).map((edge) => (
                      <li key={`${edge.assemblySku}-${edge.componentSku}`} style={styles.listItem}>
                        <span>
                          {edge.componentName} (<span style={styles.code}>{edge.componentSku}</span>) × {qty(edge.quantityThousandths)}
                          {edge.scrapPctThousandths ? ` · scrap ${pct(edge.scrapPctThousandths)}` : ""}
                        </span>
                        {assembliesWithBoms.includes(edge.componentSku) && <StatusBadge tone="blue">sub-assembly</StatusBadge>}
                      </li>
                    ))}
                  </ul>
                )}

                <div style={styles.row}>
                  <label style={styles.label}>
                    Build (units)
                    <input
                      style={{ ...styles.input, width: 90, textAlign: "right" }}
                      aria-label={`Units to build for ${assemblySku}`}
                      inputMode="decimal"
                      value={unitsInput}
                      onChange={(event) => setUnitsInput(event.target.value)}
                    />
                  </label>
                  <button type="button" style={styles.ghostButton} disabled={busy} onClick={() => checkFeasibility(assemblySku)}>Check feasibility</button>
                  <button type="button" style={styles.ghostButton} disabled={busy} onClick={() => runBomReport(assemblySku)}>BOM report</button>
                </div>

                {feasibility?.assemblySku === assemblySku && (
                  <div style={styles.inset}>
                    <div style={styles.fieldRow}>
                      <StatusBadge tone={feasibility.producible ? "green" : "red"}>{feasibility.producible ? "producible now" : "short of parts"}</StatusBadge>
                      <span style={styles.hint}>
                        max producible: {qty(feasibility.maxProducibleThousandths)} units
                        {feasibility.estimatedLeadTimeDays !== null && ` · est. lead time ${feasibility.estimatedLeadTimeDays} d (from past work orders)`}
                      </span>
                    </div>
                    <ShortfallTable
                      byItemId
                      lines={feasibility.lines.map((line) => ({ key: line.itemId, sku: line.itemId, name: "", ...line }))}
                    />
                  </div>
                )}

                {bomReport?.assemblySku === assemblySku && (
                  <div style={styles.inset}>
                    <div style={styles.fieldRow}>
                      <StatusBadge tone={bomReport.producible ? "green" : "red"}>{bomReport.producible ? "producible now" : "short of parts"}</StatusBadge>
                      <span style={styles.hint}>
                        scrap-adjusted requirements for {unitsInput || "0"} unit{unitsInput === "1" ? "" : "s"} · total shortfall {qty(bomReport.totalShortfallThousandths)}
                      </span>
                    </div>
                    <ShortfallTable byItemId={false} lines={bomReport.lines} />
                  </div>
                )}
              </section>
            );
          })}
        </>
      )}

      {tab === "production" && (
        <section style={styles.panel} aria-labelledby="produce-title">
          <h2 id="produce-title" style={styles.panelTitle}>Instant production run</h2>
          <div style={styles.fieldRow}>
            <label style={{ ...styles.label, flex: "1 1 200px" }}>
              Assembly SKU
              <input style={{ ...styles.input, width: "100%" }} aria-label="Produce assembly SKU" value={produceAssemblySku} onChange={(event) => setProduceAssemblySku(event.target.value)} />
            </label>
            <label style={styles.label}>
              Units to build
              <input style={{ ...styles.input, width: 120 }} aria-label="Units to build" inputMode="decimal" value={produceUnits} onChange={(event) => setProduceUnits(event.target.value)} />
            </label>
            <label style={styles.label}>
              Lot code (optional)
              <input style={{ ...styles.input, width: 160 }} aria-label="Lot code" value={produceLotCode} onChange={(event) => setProduceLotCode(event.target.value)} />
            </label>
          </div>
          <div style={styles.fieldRow}>
            <button type="button" style={styles.ghostButton} disabled={busy || !produceAssemblySku.trim()} onClick={previewCost}>Preview cost</button>
            <button type="button" style={styles.button} disabled={busy || !produceAssemblySku.trim()} onClick={produceNow}>Produce now</button>
          </div>

          {preview && (
            <div style={styles.inset}>
              <StatusBadge tone={preview.producible ? "green" : "red"}>{preview.producible ? "producible" : "short of parts"}</StatusBadge>
              <table style={styles.table}>
                <thead>
                  <tr style={styles.tableHead}>
                    <th scope="col">SKU</th>
                    <th scope="col" style={styles.numeric}>Required (incl. scrap)</th>
                    <th scope="col" style={styles.numeric}>Unit cost</th>
                    <th scope="col" style={styles.numeric}>Line cost</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.lines.map((line) => (
                    <tr key={line.sku}>
                      <td style={{ ...styles.code, paddingTop: 4, paddingBottom: 4 }}>{line.sku}</td>
                      <td style={styles.numeric}>{qty(line.requiredThousandths)}</td>
                      <td style={styles.numeric}>{formatMoney(line.unitCostMinor, currency)}</td>
                      <td style={styles.numeric}>{formatMoney(line.costMinor, currency)}</td>
                    </tr>
                  ))}
                  <tr style={{ fontWeight: 600 }}>
                    <td colSpan={3} style={{ ...styles.numeric, paddingTop: 4, paddingBottom: 4 }}>Total material cost</td>
                    <td style={styles.numeric}>{formatMoney(preview.totalCostMinor, currency)}</td>
                  </tr>
                  <tr>
                    <td colSpan={3} style={{ ...styles.numeric, paddingTop: 4, paddingBottom: 4, opacity: 0.7 }}>Finished avg unit cost</td>
                    <td style={{ ...styles.numeric, opacity: 0.7 }}>{formatMoney(preview.resultingAvgFinishedUnitCostMinor, currency)}</td>
                  </tr>
                </tbody>
              </table>
              <p style={styles.hint}>This is what the run would post before anything moves. No ledger entries are written until you produce.</p>
            </div>
          )}
        </section>
      )}

      {tab === "orders" && (
        <>
          <section style={styles.panel} aria-labelledby="wo-create-title">
            <h2 id="wo-create-title" style={styles.panelTitle}>Plan a work order</h2>
            <div style={styles.fieldRow}>
              <label style={styles.label}>
                Assembly SKU
                <input style={{ ...styles.input, width: 180 }} aria-label="Work order assembly SKU" value={woAssemblySku} onChange={(event) => setWoAssemblySku(event.target.value)} />
              </label>
              <label style={styles.label}>
                Planned units
                <input style={{ ...styles.input, width: 110 }} aria-label="Planned units" inputMode="decimal" value={woPlannedUnits} onChange={(event) => setWoPlannedUnits(event.target.value)} />
              </label>
              <label style={styles.label}>
                Yield %
                <input style={{ ...styles.input, width: 90 }} aria-label="Yield percent" inputMode="decimal" value={woYieldPct} onChange={(event) => setWoYieldPct(event.target.value)} />
              </label>
              <label style={{ ...styles.label, flex: "1 1 200px" }}>
                Note (optional)
                <input style={{ ...styles.input, width: "100%" }} aria-label="Work order note" value={woNote} onChange={(event) => setWoNote(event.target.value)} />
              </label>
              <button type="button" style={styles.button} disabled={busy || !woAssemblySku.trim() || !Number(woPlannedUnits)} onClick={createWorkOrder}>Create draft</button>
            </div>
            <p style={styles.hint}>Draft → release → complete in parts. Nothing touches stock until release and completion.</p>
          </section>

          {workOrders.length === 0 ? (
            <section style={styles.panel}>
              <h2 style={styles.panelTitle}>No work orders yet</h2>
              <p style={styles.empty}>Plan one from a BOM above, or produce directly from the Produce tab.</p>
            </section>
          ) : workOrders.map((order) => (
            <section key={order.id} style={styles.panel} aria-labelledby={`wo-${order.id}`}>
              <div style={styles.panelTitleRow}>
                <h2 id={`wo-${order.id}`} style={styles.panelTitle}>
                  WO #{order.number} · <span style={styles.code}>{order.assemblySku}</span>
                </h2>
                <StatusBadge tone={order.status === "completed" ? "green" : order.status === "released" ? "blue" : order.status === "cancelled" ? "red" : "neutral"}>{order.status}</StatusBadge>
              </div>
              <p style={{ ...styles.empty, margin: 0 }}>
                Planned {qty(order.plannedQtyThousandths)} · produced {qty(order.producedQtyThousandths)} · expected good at {pct(order.yieldPctThousandths)} yield ≈ {qty(order.expectedGoodThousandths)}
                {order.note ? ` · ${order.note}` : ""}
              </p>
              <div style={styles.row}>
                {order.status === "draft" && (
                  <button type="button" style={styles.button} disabled={busy} onClick={() => void run({ action: "releaseWorkOrder", workOrderId: order.id }, `Release WO #${order.number}`)}>
                    Release for production
                  </button>
                )}
                {order.status === "released" && (
                  <>
                    <input
                      style={{ ...styles.input, width: 130 }}
                      aria-label={`Units to record on WO #${order.number}`}
                      placeholder={`Complete (${qty(order.plannedQtyThousandths - order.producedQtyThousandths)} left)`}
                      inputMode="decimal"
                      value={woCompletion[order.id] ?? ""}
                      onChange={(event) => setWoCompletion((current) => ({ ...current, [order.id]: event.target.value }))}
                    />
                    <button type="button" style={styles.button} disabled={busy || !Number(woCompletion[order.id])} onClick={() => completeWorkOrder(order)}>Record completion</button>
                    <button type="button" style={styles.ghostButton} disabled={busy} onClick={() => void run({ action: "cancelWorkOrder", workOrderId: order.id }, `Cancel WO #${order.number}`)}>Cancel</button>
                  </>
                )}
              </div>
            </section>
          ))}
        </>
      )}

      {tab === "runs" && (
        <>
          <section style={styles.panel} aria-labelledby="runs-title">
            <h2 id="runs-title" style={styles.panelTitle}>Production history</h2>
            {productionRuns.length === 0 ? (
              <p style={styles.empty}>No runs yet. Completed instant runs and work-order completions appear here.</p>
            ) : (
              <table style={styles.table}>
                <thead>
                  <tr style={styles.tableHead}>
                    <th scope="col">When</th>
                    <th scope="col">Assembly</th>
                    <th scope="col" style={styles.numeric}>Produced</th>
                    <th scope="col" style={styles.numeric}>Cost</th>
                    <th scope="col">Components</th>
                    <th scope="col" style={styles.numeric}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {productionRuns.map((entry) => {
                    const summary = componentsSummary(entry);
                    return (
                      <tr key={entry.runId} style={entry.reversed ? { textDecoration: "line-through", opacity: 0.55 } : undefined}>
                        <td style={{ paddingTop: 5, paddingBottom: 5, whiteSpace: "nowrap", opacity: 0.7 }}>{formatDateTime(entry.occurredAt)}</td>
                        <td style={styles.code}>{entry.assemblySku}</td>
                        <td style={styles.numeric}>{qty(entry.producedThousandths)}</td>
                        <td style={styles.numeric}>{formatMoney(entry.costTotalMinor, currency)}</td>
                        <td style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, opacity: 0.7 }} title={summary}>{summary}</td>
                        <td style={{ ...styles.numeric, whiteSpace: "nowrap" }}>
                          {entry.reversed
                            ? <StatusBadge tone="neutral">reversed</StatusBadge>
                            : <button type="button" style={styles.ghostButton} disabled={busy} onClick={() => reverseRun(entry.runId, "Reverse run")}>Reverse</button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          <section style={styles.panel} aria-labelledby="lots-title">
            <h2 id="lots-title" style={styles.panelTitle}>Batches &amp; lots</h2>
            {lots.length === 0 ? (
              <p style={styles.empty}>Lot-tagged stock appears here once you produce with a lot code or receive tagged batches.</p>
            ) : (
              <ul style={styles.list}>
                {lots.map((lot: ManufacturingLot) => (
                  <li key={lot.id} style={styles.listItem}>
                    <span>
                      <span style={styles.code}>{lot.lotCode}</span> of {lot.sku} - balance {qty(lot.balanceThousandths)}
                      {lot.expiresAt ? ` · expires ${formatDateTime(lot.expiresAt)}` : ""}
                    </span>
                    <a
                      style={{ ...styles.fullWorkspace, textDecoration: "underline" }}
                      href={`/api/manufacturing?sku=${encodeURIComponent(lot.sku)}&lotCode=${encodeURIComponent(lot.lotCode)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      trace upstream
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section style={styles.panel} aria-labelledby="reverse-title">
            <h2 id="reverse-title" style={styles.panelTitle}>Reverse a run manually</h2>
            <div style={styles.fieldRow}>
              <input
                style={{ ...styles.input, flex: "1 1 240px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                aria-label="Run id to reverse"
                placeholder="run id"
                value={reverseRunId}
                onChange={(event) => setReverseRunId(event.target.value)}
              />
              <button type="button" style={styles.button} disabled={busy || !reverseRunId.trim()} onClick={() => reverseRun(reverseRunId.trim(), "Reverse run")}>Reverse</button>
            </div>
            <p style={styles.hint}>Reversal puts consumed components back at their original cost and removes finished units, both sides of the run, not just the output.</p>
          </section>
        </>
      )}
    </main>
  );
}

/* ------------------------------------------------------------------ overview */

function ManufacturingOverview({ report, currency, goTo }: { report: ManufacturingReport; currency: string; goTo: (tab: Tab) => void }) {
  const orders = report.workOrders;
  const drafts = orders.filter((order) => order.status === "draft");
  const released = orders.filter((order) => order.status === "released");
  const completed = orders.filter((order) => order.status === "completed");
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const runsThisMonth = report.productionRuns.filter(
    (entry) => !entry.reversed && Date.parse(entry.occurredAt) >= monthStart.getTime(),
  );
  const producedThisMonth = runsThisMonth.reduce((sum, entry) => sum + entry.producedThousandths, 0);
  const costThisMonth = runsThisMonth.reduce((sum, entry) => sum + entry.costTotalMinor, 0);
  const assembliesWithBoms = new Set(report.boms.map((edge) => edge.assemblySku)).size;
  const expiringSoon = report.lots.filter((lot) => {
    if (!lot.expiresAt) return false;
    return (Date.parse(lot.expiresAt) - Date.now()) / 86_400_000 <= 30;
  });
  const openCount = drafts.length + released.length;

  return (
    <>
      <section style={styles.stats} aria-label="Manufacturing summary">
        <button type="button" style={styles.stat} onClick={() => goTo("orders")}>
          <span style={styles.statLabel}>Open work orders</span>
          <strong style={styles.statValue}>{openCount}</strong>
          <span style={styles.statSub}>{released.length} released</span>
        </button>
        <button type="button" style={styles.stat} onClick={() => goTo("boms")}>
          <span style={styles.statLabel}>Assemblies with BOMs</span>
          <strong style={styles.statValue}>{assembliesWithBoms}</strong>
        </button>
        <button type="button" style={styles.stat} onClick={() => goTo("runs")}>
          <span style={styles.statLabel}>Produced this month</span>
          <strong style={styles.statValue}>{qty(producedThisMonth)}</strong>
          <span style={styles.statSub}>{runsThisMonth.length} run{runsThisMonth.length === 1 ? "" : "s"}</span>
        </button>
        <button type="button" style={styles.stat} onClick={() => goTo("runs")}>
          <span style={styles.statLabel}>Production cost · month</span>
          <strong style={styles.statValue}>{formatMoney(costThisMonth, currency)}</strong>
        </button>
      </section>

      <div style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
        <section style={styles.panel} aria-labelledby="overview-inflight-title">
          <div style={styles.panelTitleRow}>
            <h2 id="overview-inflight-title" style={styles.panelTitle}>Work orders in flight</h2>
            {openCount > 0 && <button type="button" style={styles.ghostButton} onClick={() => goTo("orders")}>All work orders →</button>}
          </div>
          {openCount === 0 ? (
            <p style={styles.empty}>No open work orders. Plan one from a BOM, or produce directly from the Produce tab.</p>
          ) : (
            <ul style={styles.list}>
              {[...released, ...drafts].slice(0, 5).map((order) => (
                <li key={order.id} style={styles.listItem}>
                  <span>
                    WO #{order.number} · <span style={styles.code}>{order.assemblySku}</span>
                  </span>
                  <span style={styles.fieldRow}>
                    <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 12, opacity: 0.7 }}>{qty(order.producedQtyThousandths)}/{qty(order.plannedQtyThousandths)}</span>
                    <StatusBadge tone={order.status === "released" ? "blue" : "neutral"}>{order.status}</StatusBadge>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section style={styles.panel} aria-labelledby="overview-watch-title">
          <h2 id="overview-watch-title" style={styles.panelTitle}>Watch list</h2>
          {completed.length === 0 && expiringSoon.length === 0 ? (
            <p style={styles.empty}>Nothing needs attention on the floor.</p>
          ) : (
            <ul style={styles.list}>
              {expiringSoon.slice(0, 4).map((lot) => (
                <li key={lot.id} style={styles.listItem}>
                  <span>
                    Lot <span style={styles.code}>{lot.lotCode}</span> of {lot.sku}
                  </span>
                  {lot.expiresAt && <StatusBadge tone="amber">expires {formatDateTime(lot.expiresAt)}</StatusBadge>}
                </li>
              ))}
              {completed.length > 0 && (
                <li style={{ ...styles.listItem, fontSize: 12, opacity: 0.7 }}>
                  {completed.length} work order{completed.length === 1 ? "" : "s"} completed all-time · history under Runs &amp; lots
                </li>
              )}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
