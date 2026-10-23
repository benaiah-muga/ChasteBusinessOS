import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  BadgeCheck,
  BellRing,
  CircleAlert,
  Clock3,
  Inbox,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  WandSparkles,
} from "lucide-react";
import { fetchApprovals, type Approval } from "../api/approvals";
import { fetchSignals, type Signal } from "../api/signals";
import { summarizeWork } from "../api/dashboard";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/card";
import { BrandLoader } from "../ui/brand-loader";
import { PageHeader } from "../ui/page-header";
import { useToast } from "../ui/toast";
import "./inbox-page.css";

type Filter = "all" | "red" | "orange" | "green" | "approval";

type QueueItem = {
  id: string;
  kind: "signal" | "approval";
  severity: "red" | "orange" | "green";
  module: string;
  title: string;
  detail: string;
  href: string;
  actionLabel: string;
  createdAt: string | null;
  capabilityId?: string;
};

type PageState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; signals: Signal[]; approvals: Approval[]; warning: string | null };

const MODULE_LABELS: Record<string, string> = {
  accounting: "Accounting",
  inventory: "Inventory",
  crm: "CRM",
  hr: "People",
  support: "Support",
  documents: "Documents",
  purchasing: "Purchasing",
  sales: "Sales",
  projects: "Projects",
  manufacturing: "Manufacturing",
  marketing: "Marketing",
};

const EVIDENCE_ROUTES: Record<string, string> = {
  invoice: "/accounting?tab=receivables",
  quote: "/sales",
  bill: "/purchasing?tab=bills",
  vendor: "/purchasing?tab=vendors",
  deal: "/crm?tab=pipeline",
  task: "/crm?tab=tasks",
  customer: "/crm?tab=customers",
  employee: "/hr?tab=people",
  expense_claim: "/hr?tab=expenses",
  item: "/inventory",
  stock_movement: "/inventory",
  support_conversation: "/support",
  document: "/documents",
};

function signalRoute(signal: Signal): string {
  const refType = signal.evidence?.refType;
  if (refType && EVIDENCE_ROUTES[refType]) return EVIDENCE_ROUTES[refType];
  const module = signal.module.toLowerCase();
  if (module in MODULE_LABELS) {
    if (module === "accounting") return "/accounting";
    if (module === "hr") return "/hr";
    return `/${module}`;
  }
  return "/inbox";
}

function actionName(capabilityId: string | undefined): string | null {
  if (!capabilityId) return null;
  const action = capabilityId.split(".").at(-1) ?? capabilityId;
  return action.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}

function approvalSeverity(approval: Approval): "red" | "orange" {
  return /destructive|high|critical/i.test(approval.riskClass) ? "red" : "orange";
}

function timeAgo(value: string | null): string {
  if (!value) return "Now";
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function buildItems(signals: Signal[], approvals: Approval[]): QueueItem[] {
  const signalItems: QueueItem[] = signals.map((signal) => ({
    id: `signal-${signal.id}`,
    kind: "signal",
    severity: signal.severity,
    module: MODULE_LABELS[signal.module.toLowerCase()] ?? signal.module.replace(/_/g, " "),
    title: signal.subject,
    detail: signal.detail,
    href: signalRoute(signal),
    actionLabel: `Review in ${MODULE_LABELS[signal.module.toLowerCase()] ?? signal.module.replace(/_/g, " ")}`,
    createdAt: null,
    capabilityId: signal.suggestedAction?.capabilityId,
  }));
  const approvalItems: QueueItem[] = approvals.map((approval) => ({
    id: `approval-${approval.id}`,
    kind: "approval",
    severity: approvalSeverity(approval),
    module: "Approval",
    title: approval.rationale || actionName(approval.capabilityId) || "Approval needed",
    detail: `${actionName(approval.capabilityId) ?? "Action"} raised by ${approval.raisedBy.kind === "agent" ? `your workmate for ${approval.raisedBy.name}` : approval.raisedBy.name}.`,
    href: "/approvals",
    actionLabel: "Review approval",
    createdAt: approval.createdAt,
    capabilityId: approval.capabilityId,
  }));
  const rank = { red: 0, orange: 1, green: 2 };
  return [...approvalItems, ...signalItems].sort((left, right) => {
    const bySeverity = rank[left.severity] - rank[right.severity];
    if (bySeverity !== 0) return bySeverity;
    return (right.createdAt ?? "").localeCompare(left.createdAt ?? "");
  });
}

function askPrompt(item: QueueItem): string {
  return `Help me resolve this item in my inbox: "${item.title}". ${item.detail}${item.capabilityId ? ` A suggested governed action is ${item.capabilityId}.` : ""} Explain what you recommend, then take the next safe step or prepare a proposal for my approval.`;
}

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "red", label: "Urgent" },
  { id: "orange", label: "Coming up" },
  { id: "green", label: "Opportunities" },
  { id: "approval", label: "Approvals" },
];

export function InboxPage({ organizationId = null }: { organizationId?: string | null }) {
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [brief, setBrief] = useState<string | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);
  const { toast } = useToast();

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ status: "loading" });
    const [signalsResult, approvalsResult] = await Promise.allSettled([fetchSignals({}, signal), fetchApprovals(organizationId, signal)]);
    if (signal?.aborted) return;
    if (signalsResult.status === "rejected" && approvalsResult.status === "rejected") {
      const reason = approvalsResult.reason instanceof Error ? approvalsResult.reason.message : "The inbox is unavailable. Try again.";
      setState({ status: "failed", message: reason });
      return;
    }
    const warning = signalsResult.status === "rejected"
      ? "The risk feed could not load. Approvals below are still current."
      : approvalsResult.status === "rejected"
        ? "Approvals could not load. Risks and opportunities below are still current."
        : null;
    setState({
      status: "ready",
      signals: signalsResult.status === "fulfilled" ? signalsResult.value : [],
      approvals: approvalsResult.status === "fulfilled" ? approvalsResult.value.approvals : [],
      warning,
    });
  }, [organizationId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const items = useMemo(() => state.status === "ready" ? buildItems(state.signals, state.approvals) : [], [state]);
  const counts = useMemo(() => ({
    all: items.length,
    red: items.filter((item) => item.severity === "red").length,
    orange: items.filter((item) => item.severity === "orange").length,
    green: items.filter((item) => item.severity === "green").length,
    approval: items.filter((item) => item.kind === "approval").length,
  }), [items]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      if (filter === "approval" && item.kind !== "approval") return false;
      if (filter !== "all" && filter !== "approval" && item.severity !== filter) return false;
      if (!needle) return true;
      return `${item.title} ${item.detail} ${item.module} ${item.capabilityId ?? ""}`.toLowerCase().includes(needle);
    });
  }, [filter, items, query]);

  async function makeBrief() {
    if (items.length === 0) return;
    setBriefBusy(true);
    try {
      const cards = items.slice(0, 12).map((item, index) => ({
        kind: item.kind === "approval" ? "approval" as const : "signal" as const,
        id: item.id,
        title: item.title,
        detail: item.detail,
        whyItMatters: item.detail,
        actionLabel: item.actionLabel,
        actionHref: item.href,
        createdAt: item.createdAt,
        rank: index,
      }));
      const text = await summarizeWork(cards);
      setBrief(text);
      toast({ title: "Brief ready", description: "Your queue is summarized below.", tone: "success" });
    } catch (error) {
      toast({ title: "Could not build the brief", description: error instanceof Error ? error.message : "Try again in a moment.", tone: "danger" });
    } finally {
      setBriefBusy(false);
    }
  }

  return (
    <main className="inbox-page">
      <PageHeader
        eyebrow="Your attention"
        title="Inbox"
        description="Approvals, risks, and opportunities from every part of the business, ranked by what needs you first."
        meta={
          <>
            <Badge tone="ink"><ShieldCheck size={11} aria-hidden="true" /> Governed actions only</Badge>
            {state.status === "ready" && <span className="inbox-meta-note">Live from accounting, inventory, CRM, people, documents, and support</span>}
          </>
        }
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => void load()}><RefreshCw size={13} aria-hidden="true" /> Refresh</Button>
            <Button variant="primary" size="sm" onClick={() => void makeBrief()} disabled={briefBusy || items.length === 0}>
              <WandSparkles size={14} aria-hidden="true" /> {briefBusy ? "Summarizing…" : "Brief me"}
            </Button>
          </>
        }
      />

      {state.status === "loading" && (
        <section className="inbox-loading" aria-label="Loading inbox">
          <BrandLoader label="Reading the business" detail="Ranking approvals, risks, and opportunities." />
          <div className="inbox-skeleton-row" />
          <div className="inbox-skeleton-row" />
          <div className="inbox-skeleton-row" />
        </section>
      )}

      {state.status === "failed" && (
        <div className="inbox-error" role="alert">
          <span className="inbox-error-icon"><TriangleAlert size={19} aria-hidden="true" /></span>
          <div>
            <strong>The inbox could not load.</strong>
            <p>{state.message}</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void load()}>Try again</Button>
        </div>
      )}

      {state.status === "ready" && (
        <>
          {state.warning && <p className="inbox-warning" role="status">{state.warning}</p>}

          <section className="inbox-summary" aria-label="Inbox summary">
            <div className="inbox-stat inbox-stat-primary">
              <span className="inbox-stat-icon"><BellRing size={17} aria-hidden="true" /></span>
              <div><span className="inbox-stat-label">Waiting on you</span><strong>{counts.all}</strong></div>
              <span className="inbox-stat-detail">across {new Set(items.map((item) => item.module)).size} {new Set(items.map((item) => item.module)).size === 1 ? "area" : "areas"}</span>
            </div>
            <div className="inbox-stat">
              <span className="inbox-stat-icon inbox-stat-icon-red"><CircleAlert size={16} aria-hidden="true" /></span>
              <div><span className="inbox-stat-label">Urgent</span><strong>{counts.red}</strong></div>
              <span className="inbox-stat-detail">needs a decision today</span>
            </div>
            <div className="inbox-stat">
              <span className="inbox-stat-icon inbox-stat-icon-gold"><Clock3 size={16} aria-hidden="true" /></span>
              <div><span className="inbox-stat-label">Coming up</span><strong>{counts.orange}</strong></div>
              <span className="inbox-stat-detail">{counts.approval} awaiting approval</span>
            </div>
            <div className="inbox-stat">
              <span className="inbox-stat-icon inbox-stat-icon-green"><BadgeCheck size={16} aria-hidden="true" /></span>
              <div><span className="inbox-stat-label">Opportunities</span><strong>{counts.green}</strong></div>
              <span className="inbox-stat-detail">improve or protect the business</span>
            </div>
          </section>

          {brief && (
            <section className="inbox-brief" aria-label="Your briefing">
              <div className="inbox-brief-head">
                <span><Sparkles size={14} aria-hidden="true" /> Your brief</span>
                <button type="button" onClick={() => setBrief(null)}>Dismiss</button>
              </div>
              <p>{brief}</p>
            </section>
          )}

          <div className="inbox-toolbar">
            <div className="inbox-filters" role="tablist" aria-label="Filter inbox">
              {FILTERS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === entry.id}
                  className={`inbox-filter${filter === entry.id ? " is-active" : ""}`}
                  onClick={() => setFilter(entry.id)}
                >
                  {entry.label}
                  <span>{counts[entry.id]}</span>
                </button>
              ))}
            </div>
            <div className="inbox-search">
              <Search size={14} aria-hidden="true" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search this inbox" aria-label="Search this inbox" />
            </div>
          </div>

          {visible.length === 0 ? (
            <EmptyState
              icon={<Inbox size={18} aria-hidden="true" />}
              title={items.length === 0 ? "Inbox zero" : "Nothing matches that view"}
              detail={items.length === 0 ? "The workmate is within policy and no risks need your authority. We will surface anything new here." : "Clear the filter or search for something else."}
              action={items.length === 0
                ? <Button variant="secondary" size="sm" onClick={() => navigateTo("/chat")}>Ask the workmate what changed</Button>
                : <Button variant="secondary" size="sm" onClick={() => { setFilter("all"); setQuery(""); }}>Clear filters</Button>}
            />
          ) : (
            <ul className="inbox-list">
              {visible.map((item) => (
                <li key={item.id} className={`inbox-item inbox-item-${item.severity}`}>
                  <span className={`inbox-severity inbox-severity-${item.severity}`} aria-label={`${item.severity} priority`}>
                    {item.severity === "red" ? <CircleAlert size={16} aria-hidden="true" /> : item.severity === "orange" ? <Clock3 size={16} aria-hidden="true" /> : <BadgeCheck size={16} aria-hidden="true" />}
                  </span>
                  <div className="inbox-item-copy">
                    <div className="inbox-item-meta">
                      <span className="inbox-item-module">{item.module}</span>
                      {item.kind === "approval" && <span className="inbox-item-kind">Approval</span>}
                      <span>{timeAgo(item.createdAt)}</span>
                    </div>
                    <p className="inbox-item-title">{item.title}</p>
                    <p className="inbox-item-detail">{item.detail}</p>
                    {item.capabilityId && <p className="inbox-item-action">Suggested next step <strong>{actionName(item.capabilityId) ?? item.capabilityId}</strong></p>}
                  </div>
                  <div className="inbox-item-actions">
                    <a className="ui-button ui-button-secondary ui-button-sm" href={item.href}>
                      {item.actionLabel} <ArrowRight size={13} aria-hidden="true" />
                    </a>
                    <a className="ui-button ui-button-quiet ui-button-sm" href={`/chat?prompt=${encodeURIComponent(askPrompt(item))}`}>
                      <Sparkles size={13} aria-hidden="true" /> Ask Workmate
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}

function navigateTo(path: string) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
