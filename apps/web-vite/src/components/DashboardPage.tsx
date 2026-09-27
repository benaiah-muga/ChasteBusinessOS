import { useCallback, useEffect, useMemo, useState } from "react";
import { DashboardApiError, fetchDashboard, fetchMyWork, fetchSetup, summarizeWork, type DashboardData, type SetupItem, type WorkCard } from "../api/dashboard";
import { legacyUrl } from "../legacy";
import "./DashboardPage.css";

type PageState =
  | { status: "loading" }
  | { status: "failed"; message: string; onboarding: boolean; login: boolean }
  | { status: "ready"; data: DashboardData; setup: SetupItem[] | null; setupUnavailable: boolean };

const DISMISSED_SETUP_KEY = "chaste-setup-dismissed";
const CURRENCY_PREFERENCES = ["org", "USD", "KES", "EUR", "GBP", "TZS", "UGX"];
type CurrencyStyle = { symbol: string; minorUnits: number };
const CURRENCY_STYLES: Record<string, CurrencyStyle> = {
  USD: { symbol: "$", minorUnits: 2 },
  KES: { symbol: "KSh", minorUnits: 2 },
  EUR: { symbol: "€", minorUnits: 2 },
  GBP: { symbol: "£", minorUnits: 2 },
  TZS: { symbol: "TSh", minorUnits: 0 },
  UGX: { symbol: "USh", minorUnits: 0 },
};
const QUICK_PROMPTS = [
  { label: "Draft an invoice", prompt: "Draft an invoice for a customer. Ask me for the details you need." },
  { label: "Record a bill", prompt: "Help me record a vendor bill we received." },
  { label: "Where is my cash?", prompt: "Give me the cash position: cash balance in, out, and net this month." },
];

function loadDismissed(): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(DISMISSED_SETUP_KEY) ?? "[]");
    return new Set(Array.isArray(value) && value.every((item) => typeof item === "string") ? value : []);
  } catch {
    return new Set();
  }
}

function currencyFor(baseCurrency: string | null): CurrencyStyle {
  let preference: string | null = null;
  try {
    const cookie = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("chaste_display_currency="));
    if (cookie) {
      const value = decodeURIComponent(cookie.slice("chaste_display_currency=".length));
      if (CURRENCY_PREFERENCES.includes(value)) preference = value;
    }
  } catch { /* A blocked cookie leaves the device preference available. */ }
  if (!preference) {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem("chaste-prefs") ?? "null");
      if (stored && typeof stored === "object" && "currency" in stored && typeof stored.currency === "string" && CURRENCY_PREFERENCES.includes(stored.currency)) preference = stored.currency;
    } catch { /* Invalid local preferences fall back to the active organization. */ }
  }
  const code = !preference || preference === "org" ? baseCurrency ?? "USD" : preference;
  return CURRENCY_STYLES[code] ?? { symbol: `${code} `, minorUnits: 2 };
}

function formatMoney(minor: number, currency: CurrencyStyle, whole = false): string {
  const { symbol, minorUnits } = currency;
  const amount = Math.abs(minor) / 10 ** minorUnits;
  const formatted = amount.toLocaleString("en-US", {
    minimumFractionDigits: whole ? 0 : minorUnits,
    maximumFractionDigits: whole ? 0 : minorUnits,
  });
  return `${minor < 0 ? "−" : ""}${symbol}${formatted}`;
}

function monthLabel(value: string): string {
  const date = new Date(`${value}-01T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { month: "short" });
}

function friendlyError(error: unknown): string {
  if (error instanceof DashboardApiError) return error.message;
  if (error instanceof DOMException && error.name === "TimeoutError") return "The dashboard took too long to load. Try again.";
  return "Could not reach the dashboard service. Check your connection and try again.";
}

export function DashboardPage({ baseCurrency = null }: { baseCurrency?: string | null }) {
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [expandedSetup, setExpandedSetup] = useState(false);
  const currency = useMemo(() => currencyFor(baseCurrency), [baseCurrency]);

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ status: "loading" });
    const [dashboardResult, setupResult] = await Promise.allSettled([
      fetchDashboard(signal),
      fetchSetup(signal),
    ]);
    if (signal?.aborted) return;
    setDismissed(loadDismissed());
    if (dashboardResult.status === "rejected") {
      const error = dashboardResult.reason;
      setState({
        status: "failed",
        message: friendlyError(error),
        onboarding: error instanceof DashboardApiError && error.status === 428,
        login: error instanceof DashboardApiError && error.status === 401,
      });
      return;
    }
    if (setupResult.status === "rejected" && setupResult.reason instanceof DashboardApiError && setupResult.reason.status === 401) {
      setState({ status: "failed", message: setupResult.reason.message, onboarding: false, login: true });
      return;
    }
    setState({
      status: "ready",
      data: dashboardResult.value,
      setup: setupResult.status === "fulfilled" ? setupResult.value : null,
      setupUnavailable: setupResult.status === "rejected" && !(setupResult.reason instanceof DashboardApiError && setupResult.reason.status === 403),
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const attentionCount = state.status === "ready"
    ? state.data.ops.pendingApprovals + state.data.workingCapital.overdueCount + state.data.ops.lowStock.length + state.data.ops.pendingLeave + (state.data.workingCapital.apOutstandingMinor > 0 ? 1 : 0)
    : 0;

  return (
    <main className="dashboard-page">
      <header className="dashboard-intro">
        <div><p className="section-kicker">Home</p><h1>Your business, at a glance</h1></div>
        <p>A live view of your books, team, and work in motion.</p>
      </header>
      <section className="financial-cover" aria-label="Financial pulse">
        <div className="cover-grain" aria-hidden="true" />
        <div className="cover-topline">
          <p className="cover-date">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</p>
          <div className="quick-actions" aria-label="Ask your workmate">
            <span>Ask</span>
            {QUICK_PROMPTS.map((action) => (
              <a key={action.label} href={legacyUrl(`/?workmatePrompt=${encodeURIComponent(action.prompt)}`)}>{action.label}</a>
            ))}
          </div>
        </div>
        <div className="cover-financials">
          <div className="cover-net">
            <p className="cover-label">Net income · to date</p>
            {state.status === "ready" ? (
              <strong className={state.data.money.netIncomeMinor < 0 ? "net-negative" : undefined}>
                {formatMoney(state.data.money.netIncomeMinor, currency, true)}
              </strong>
            ) : <span className="cover-value-skeleton" aria-hidden="true" />}
            {state.status === "ready" && state.data.money.balanced !== null && (
              <span className={`books-badge ${state.data.money.balanced ? "books-balanced" : "books-unbalanced"}`}>
                {state.data.money.balanced ? "Books balanced" : "Unbalanced · investigate"}
              </span>
            )}
          </div>
          <dl className="cover-stats">
            <Metric label="Revenue" value={state.status === "ready" ? formatMoney(state.data.money.revenueMinor, currency) : undefined} />
            <Metric label="Expenses" value={state.status === "ready" ? formatMoney(state.data.money.expenseMinor, currency) : undefined} />
            <Metric label="Cash" value={state.status === "ready" ? state.data.money.cashMinor === null ? "-" : formatMoney(state.data.money.cashMinor, currency) : undefined} />
          </dl>
        </div>
        {state.status === "ready" && <TrendLine trend={state.data.trend} currency={currency} />}
      </section>

      {state.status === "loading" && <DashboardSkeleton />}
      {state.status === "failed" && (
        <section className="dashboard-error" role="alert">
          <div>
            <p className="section-kicker">Dashboard unavailable</p>
            <p>{state.message}</p>
          </div>
          {state.onboarding
            ? <a className="text-link" href={legacyUrl("/onboarding")}>Finish workspace setup <span aria-hidden="true">↗</span></a>
            : state.login
              ? <a className="text-link" href="/login">Sign in again</a>
              : <button className="quiet-button" type="button" onClick={() => void load()}>Try again</button>}
        </section>
      )}

      {state.status === "ready" && (
        <>
          {state.setup && <SetupChecklist
            items={state.setup}
            dismissed={dismissed}
            expanded={expandedSetup}
            onExpand={setExpandedSetup}
            onDismiss={(id) => {
              const next = new Set(dismissed).add(id);
              setDismissed(next);
              try { localStorage.setItem(DISMISSED_SETUP_KEY, JSON.stringify([...next])); } catch { /* Keep this dismissal for this session. */ }
            }}
          />}
          {state.setupUnavailable && <p className="setup-unavailable" role="status">Workspace setup tips could not load.</p>}
          <div className="dashboard-grid">
            <NeedsYou data={state.data} count={attentionCount} currency={currency} />
            <WorkingCapital data={state.data} currency={currency} />
            <div className="dashboard-side-stack">
              <Operations data={state.data} />
              <ActivityFeed activity={state.data.activity.slice(0, 3)} />
            </div>
          </div>
        </>
      )}
    </main>
  );
}

function Metric({ label, value }: { label: string; value?: string }) {
  return <div><dt>{label}</dt><dd>{value ?? <span className="metric-skeleton" aria-hidden="true" />}</dd></div>;
}

function TrendLine({ trend, currency }: { trend: DashboardData["trend"]; currency: CurrencyStyle }) {
  const chart = useMemo(() => {
    const max = Math.max(1, ...trend.flatMap((month) => [month.incomeMinor, month.expenseMinor]));
    const x = (index: number) => trend.length === 1 ? 300 : 5 + index / (trend.length - 1) * 590;
    const y = (value: number) => 88 - value / max * 72;
    return {
      income: trend.map((point, index) => `${index === 0 ? "M" : "L"} ${x(index).toFixed(1)} ${y(point.incomeMinor).toFixed(1)}`).join(" "),
      expense: trend.map((point, index) => `${index === 0 ? "M" : "L"} ${x(index).toFixed(1)} ${y(point.expenseMinor).toFixed(1)}`).join(" "),
    };
  }, [trend]);
  if (trend.length === 0) return null;
  const latest = trend[trend.length - 1]!;
  return (
    <figure className="trend-chart">
      <svg role="img" aria-label={`Income and expenses over the last ${trend.length} months. Latest month: income ${formatMoney(latest.incomeMinor, currency)}, expenses ${formatMoney(latest.expenseMinor, currency)}.`} viewBox="0 0 600 100" preserveAspectRatio="none">
        {[24, 48, 72].map((line) => <line key={line} x1="0" x2="600" y1={line} y2={line} />)}
        <path className="trend-expense" d={chart.expense} />
        <path className="trend-income" d={chart.income} />
      </svg>
      <figcaption><span><i className="legend-income" />Income</span><span><i className="legend-expense" />Expenses</span><span className="trend-months">{trend.map((point) => <time key={point.month}>{monthLabel(point.month)}</time>)}</span></figcaption>
    </figure>
  );
}

function SetupChecklist({
  items,
  dismissed,
  expanded,
  onExpand,
  onDismiss,
}: {
  items: SetupItem[];
  dismissed: Set<string>;
  expanded: boolean;
  onExpand: (expanded: boolean) => void;
  onDismiss: (id: string) => void;
}) {
  const pending = items.filter((item) => !item.done && !dismissed.has(item.id));
  if (pending.length === 0) return null;
  const visible = expanded ? pending : pending.slice(0, 2);
  const hidden = pending.length - visible.length;
  return (
    <section className="setup-checklist" aria-label="Workspace setup">
      <div className="setup-heading"><p className="section-kicker">Get set up</p><span>{pending.length} step{pending.length === 1 ? "" : "s"} left · a minute each</span></div>
      <ol>
        {visible.map((item) => (
          <li key={item.id}>
            <span className="setup-dot" aria-hidden="true" />
            <span className="setup-copy"><strong>{item.title}</strong><small>{item.why}</small></span>
            <a href={legacyUrl(item.href)}>Take me there <span aria-hidden="true">↗</span></a>
            <button type="button" aria-label={`Hide "${item.title}"`} title="Hide this step" onClick={() => onDismiss(item.id)}>×</button>
          </li>
        ))}
      </ol>
      {hidden > 0 && <button className="setup-expand" type="button" aria-expanded="false" onClick={() => onExpand(true)}>Show {hidden} more step{hidden === 1 ? "" : "s"} ↓</button>}
      {expanded && pending.length > 2 && <button className="setup-expand" type="button" aria-expanded="true" onClick={() => onExpand(false)}>Show fewer steps ↑</button>}
    </section>
  );
}

function NeedsYou({ data, count, currency }: { data: DashboardData; count: number; currency: CurrencyStyle }) {
  const items: { key: string; text: string; href: string; action: string; level: "high" | "medium" | "low" }[] = [];
  const [workCards, setWorkCards] = useState<WorkCard[] | null>(null);
  const [brief, setBrief] = useState<string | null>(null);
  const [briefState, setBriefState] = useState<"idle" | "loading" | "unavailable">("idle");

  useEffect(() => {
    const controller = new AbortController();
    void fetchMyWork(controller.signal)
      .then((cards) => { if (!controller.signal.aborted) setWorkCards(cards); })
      .catch(() => { if (!controller.signal.aborted) setWorkCards([]); });
    return () => controller.abort();
  }, []);

  const summarize = useCallback(async () => {
    if (!workCards?.length) return;
    setBriefState("loading");
    try {
      setBrief(await summarizeWork(workCards));
      setBriefState("idle");
    } catch (error) {
      setBrief(error instanceof DashboardApiError && error.hint
        ? error.hint
        : "The brief is unavailable right now; the ranked list itself is unaffected.");
      setBriefState("unavailable");
    }
  }, [workCards]);

  const receiptRemainderCount = workCards?.filter((card) => card.kind === "receipt_remainder").length ?? 0;
  const queueCount = count + receiptRemainderCount;

  if (data.money.balanced === false) items.push({ key: "balance", text: "Books are unbalanced · treat as corruption", href: "/accounting", action: "Investigate", level: "high" });
  if (data.ops.pendingApprovals > 0) items.push({ key: "approvals", text: `${data.ops.pendingApprovals} action${data.ops.pendingApprovals === 1 ? "" : "s"} waiting on your approval`, href: "/approvals", action: "Review", level: "high" });
  if (data.workingCapital.overdueCount > 0) items.push({ key: "overdue", text: `${data.workingCapital.overdueCount} invoice${data.workingCapital.overdueCount === 1 ? "" : "s"} overdue · ${formatMoney(data.workingCapital.overdueAmountMinor, currency)} outstanding`, href: "/accounting", action: "Chase", level: "high" });
  if (data.workingCapital.apOutstandingMinor > 0) items.push({ key: "bills", text: `Vendor bills due: ${formatMoney(data.workingCapital.apOutstandingMinor, currency)}`, href: "/accounting", action: "Pay", level: "medium" });
  if (data.ops.lowStock.length > 0) items.push({ key: "stock", text: `Low stock: ${data.ops.lowStock.map((item) => item.name || item.sku).join(", ")}`, href: "/inventory", action: "Restock", level: "medium" });
  const modulePaths: Record<string, string> = { inventory: "/inventory", accounting: "/accounting", crm: "/crm", pos: "/pos", hr: "/hr", purchasing: "/purchasing" };
  for (const signal of data.signals ?? []) items.push({
    key: signal.id,
    text: signal.subject,
    href: modulePaths[signal.module] ?? "/",
    action: "Review",
    level: signal.severity === "red" ? "high" : signal.severity === "orange" ? "medium" : "low",
  });
  if (data.ops.pendingLeave > 0) items.push({ key: "leave", text: `${data.ops.pendingLeave} leave request${data.ops.pendingLeave === 1 ? "" : "s"} awaiting decision`, href: "/hr", action: "Decide", level: "low" });
  for (const card of workCards ?? []) {
    if (card.kind !== "receipt_remainder") continue;
    items.push({ key: `remainder-${card.id}`, text: card.title, href: card.actionHref, action: card.actionLabel, level: "medium" });
  }
  return (
    <section className="dashboard-section needs-you" aria-label="Needs you">
      <div className="section-heading">
        <p className="section-kicker">Needs you {queueCount > 0 && <span className="attention-count">{queueCount}</span>}</p>
        <div className="needs-you-actions">
          {items.length === 0 && <span className="quiet-state">All clear</span>}
          <button className="brief-button" type="button" onClick={() => void summarize()} disabled={!workCards || workCards.length === 0 || briefState === "loading"}>
            {briefState === "loading" ? "Summarizing…" : "Brief me"}
          </button>
        </div>
      </div>
      {brief && <p className={`work-brief ${briefState === "unavailable" ? "work-brief-unavailable" : ""}`} role={briefState === "unavailable" ? "status" : undefined}>{brief}</p>}
      {items.length === 0
        ? <div className="empty-attention"><span aria-hidden="true">✳</span><p>Nothing needs you right now.<br />The business is running itself.</p></div>
        : <ol className="attention-list">{items.map((item) => <li key={item.key}><a href={legacyUrl(item.href)}><i className={`attention-dot attention-${item.level}`} /><span>{item.text}</span><strong>{item.action} <span aria-hidden="true">›</span></strong></a></li>)}</ol>}
    </section>
  );
}

function WorkingCapital({ data, currency }: { data: DashboardData; currency: CurrencyStyle }) {
  const total = Math.max(1, data.pipeline.stages.reduce((sum, stage) => sum + stage.count, 0));
  return (
    <section className="dashboard-section working-capital" aria-label="Working capital">
      <div className="section-heading"><p className="section-kicker">Working capital</p><a href={legacyUrl("/accounting")}>Open books <span aria-hidden="true">↗</span></a></div>
      <dl className="capital-card">
        <CapitalRow label="Receivables outstanding" value={formatMoney(data.workingCapital.arOutstandingMinor, currency)} note={data.workingCapital.overdueCount > 0 ? `${data.workingCapital.overdueCount} overdue` : undefined} warning={data.workingCapital.overdueCount > 0} />
        <CapitalRow label="Payables due" value={formatMoney(data.workingCapital.apOutstandingMinor, currency)} />
        <CapitalRow label={`Weighted pipeline · ${data.pipeline.openCount} open`} value={formatMoney(data.pipeline.weightedForecastMinor, currency, true)} />
      </dl>
      <div className="pipeline-card">
        <p className="section-kicker">Pipeline by stage</p>
        <div className="pipeline-bar" aria-label="Pipeline deals by stage">{data.pipeline.stages.map((stage) => stage.count > 0 && <span key={stage.stage} className={`pipeline-${stage.stage}`} style={{ width: `${stage.count / total * 100}%` }} title={`${stage.stage}: ${stage.count}`} />)}</div>
        <ul>{data.pipeline.stages.map((stage) => <li key={stage.stage}><span><i className={`pipeline-dot pipeline-${stage.stage}`} />{stage.stage}</span><b>{stage.count}</b></li>)}</ul>
      </div>
    </section>
  );
}

function CapitalRow({ label, value, note, warning = false }: { label: string; value: string; note?: string; warning?: boolean }) {
  return <div className="capital-row"><dt>{label}</dt><dd>{note && <small className={warning ? "warning-text" : undefined}>{note}</small>}<strong>{value}</strong></dd></div>;
}

function Operations({ data }: { data: DashboardData }) {
  const rows: { label: string; tone: string }[] = [];
  if (data.ops.posOpen) rows.push({ label: `Register “${data.ops.posOpen.register}” is open`, tone: "green" });
  if (data.ops.lowStock.length > 0) rows.push({ label: `${data.ops.lowStock.length} item${data.ops.lowStock.length === 1 ? "" : "s"} at reorder point`, tone: "gold" });
  if (data.ops.docsAwaitingCoding > 0) rows.push({ label: `${data.ops.docsAwaitingCoding} document${data.ops.docsAwaitingCoding === 1 ? "" : "s"} awaiting coding`, tone: "blue" });
  if (data.ops.headcount > 0) rows.push({ label: `${data.ops.headcount} on the team${data.ops.pendingLeave > 0 ? `, ${data.ops.pendingLeave} leave pending` : ""}`, tone: "gray" });
  return <section className="operations" aria-label="Operations"><p className="section-kicker">Operations</p><ul>{rows.length === 0 ? <li className="quiet-state">Quiet across the floor.</li> : rows.map((row) => <li key={row.label}><i className={`operation-dot dot-${row.tone}`} />{row.label}</li>)}</ul></section>;
}

function ActivityFeed({ activity }: { activity: DashboardData["activity"] }) {
  return (
    <section className="activity-feed" aria-label="Recent ledger activity">
      <div className="section-heading"><p className="section-kicker">Ledger · recent</p><a href={legacyUrl("/ledger")}>View all <span aria-hidden="true">↗</span></a></div>
      {activity.length === 0 ? <p className="quiet-state">Nothing recorded yet.</p> : <ol>{activity.map((event, index) => <li key={event.seq}><i className={`actor-dot actor-${event.actorType}`} />{index < activity.length - 1 && <span className="activity-stem" />}<span className="activity-name">{event.capabilityId ?? event.kind}</span>{event.actorType === "agent" && <small>agent</small>}<time dateTime={event.occurredAt}>{timeAgo(event.occurredAt)}</time></li>)}</ol>}
    </section>
  );
}

function timeAgo(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function DashboardSkeleton() {
  return <div className="dashboard-skeleton" role="status" aria-label="Loading dashboard"><span /><div><i /><i /><i /></div><div><i /><i /></div></div>;
}
