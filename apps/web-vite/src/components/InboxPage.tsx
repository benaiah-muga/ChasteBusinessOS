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
import { fetchExceptions, saveException, type OperationalRecord } from "../api/operations";
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

type ExceptionStatus = "open" | "acknowledged" | "resolved";

type QueueItem = {
  id: string;
  kind: "signal" | "approval" | "exception";
  severity: "red" | "orange" | "green";
  module: string;
  moduleKey: string;
  title: string;
  detail: string;
  href: string;
  actionLabel: string;
  createdAt: string | null;
  capabilityId?: string;
  signalId?: string;
  stableKey?: string;
  evidence?: { refType?: string; refId?: string | null } | null;
  status?: ExceptionStatus;
  stale?: boolean;
  record?: OperationalRecord;
};

type PageState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; signals: Signal[]; approvals: Approval[]; exceptions: OperationalRecord[]; warning: string | null };

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

function moduleRoute(module: string): string {
  const normalized = module.toLowerCase();
  if (normalized === "accounting") return "/accounting";
  if (normalized === "hr") return "/hr";
  if (normalized in MODULE_LABELS) return `/${normalized}`;
  return "/inbox";
}

function exceptionStatus(value: string | undefined): ExceptionStatus {
  return value === "acknowledged" || value === "resolved" ? value : "open";
}

function recordSeverity(record: OperationalRecord): "red" | "orange" | "green" {
  const details = record.details && typeof record.details === "object" ? record.details as Record<string, unknown> : {};
  return details.severity === "red" || details.severity === "green" || details.severity === "orange" ? details.severity : "orange";
}

function recordModule(record: OperationalRecord): string {
  const details = record.details && typeof record.details === "object" ? record.details as Record<string, unknown> : {};
  return typeof details.module === "string" && details.module.trim() ? details.module : "operations";
}

function recordHref(record: OperationalRecord): string {
  const details = record.details && typeof record.details === "object" ? record.details as Record<string, unknown> : {};
  if (typeof details.href === "string" && details.href.startsWith("/") && !details.href.startsWith("//")) return details.href;
  const refType = typeof details.refType === "string" ? details.refType : null;
  if (refType && EVIDENCE_ROUTES[refType]) return EVIDENCE_ROUTES[refType];
  return moduleRoute(recordModule(record));
}

function recordCapability(record: OperationalRecord): string | undefined {
  const details = record.details && typeof record.details === "object" ? record.details as Record<string, unknown> : {};
  return typeof details.capabilityId === "string" ? details.capabilityId : undefined;
}

function buildItems(signals: Signal[], approvals: Approval[], exceptions: OperationalRecord[]): QueueItem[] {
  const byStableKey = new Map(exceptions.filter((record) => record.kind === "exception").map((record) => [record.stableKey, record]));
  const matched = new Set<string>();
  const signalItems: QueueItem[] = signals.map((signal) => {
    const stableKey = `signal:${signal.id}`.slice(0, 200);
    const record = byStableKey.get(stableKey);
    if (record) matched.add(record.id);
    const status = record ? exceptionStatus(record.status) : "open";
    return {
      id: `signal-${signal.id}`,
      kind: "signal",
      severity: signal.severity,
      module: MODULE_LABELS[signal.module.toLowerCase()] ?? signal.module.replace(/_/g, " "),
      moduleKey: signal.module,
      title: signal.subject,
      detail: signal.detail,
      href: signalRoute(signal),
      actionLabel: `Review in ${MODULE_LABELS[signal.module.toLowerCase()] ?? signal.module.replace(/_/g, " ")}`,
      createdAt: record?.updatedAt ?? null,
      capabilityId: signal.suggestedAction?.capabilityId,
      signalId: signal.id,
      stableKey,
      evidence: signal.evidence,
      status,
      stale: false,
      record,
    };
  });
  const persistedItems: QueueItem[] = exceptions
    .filter((record) => record.kind === "exception" && !matched.has(record.id) && exceptionStatus(record.status) !== "resolved")
    .map((record) => {
      const module = recordModule(record);
      const status = exceptionStatus(record.status);
      return {
        id: `exception-${record.id}`,
        kind: "exception" as const,
        severity: recordSeverity(record),
        module: MODULE_LABELS[module.toLowerCase()] ?? module.replace(/_/g, " "),
        moduleKey: module,
        title: record.title,
        detail: record.summary ?? "The condition is no longer detected. Confirm that this exception is resolved.",
        href: recordHref(record),
        actionLabel: `Review in ${MODULE_LABELS[module.toLowerCase()] ?? module.replace(/_/g, " ")}`,
        createdAt: record.updatedAt,
        capabilityId: recordCapability(record),
        stableKey: record.stableKey,
        status,
        stale: true,
        record,
      };
    });
  const approvalItems: QueueItem[] = approvals.map((approval) => ({
    id: `approval-${approval.id}`,
    kind: "approval",
    severity: approvalSeverity(approval),
    module: "Approval",
    moduleKey: "approval",
    title: approval.rationale || actionName(approval.capabilityId) || "Approval needed",
    detail: `${actionName(approval.capabilityId) ?? "Action"} raised by ${approval.raisedBy.kind === "agent" ? `your workmate for ${approval.raisedBy.name}` : approval.raisedBy.name}.`,
    href: "/approvals",
    actionLabel: "Review approval",
    createdAt: approval.createdAt,
    capabilityId: approval.capabilityId,
  }));
  const rank = { red: 0, orange: 1, green: 2 };
  const statusRank: Record<ExceptionStatus, number> = { open: 0, acknowledged: 1, resolved: 2 };
  return [...approvalItems, ...signalItems, ...persistedItems].sort((left, right) => {
    const bySeverity = rank[left.severity] - rank[right.severity];
    if (bySeverity !== 0) return bySeverity;
    const byStatus = statusRank[left.status ?? "open"] - statusRank[right.status ?? "open"];
    if (byStatus !== 0) return byStatus;
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

export function InboxPage({ organizationId = null, actorId = null }: { organizationId?: string | null; actorId?: string | null }) {
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [brief, setBrief] = useState<string | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const { toast } = useToast();

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ status: "loading" });
    const [signalsResult, approvalsResult, exceptionsResult] = await Promise.allSettled([
      fetchSignals({}, signal), fetchApprovals(organizationId, signal), fetchExceptions(signal),
    ]);
    if (signal?.aborted) return;
    if (signalsResult.status === "rejected" && approvalsResult.status === "rejected" && exceptionsResult.status === "rejected") {
      const reason = approvalsResult.reason instanceof Error ? approvalsResult.reason.message : "The inbox is unavailable. Try again.";
      setState({ status: "failed", message: reason });
      return;
    }
    const warning = signalsResult.status === "rejected"
      ? "The risk feed could not load. Approvals and saved exceptions below are still current."
      : approvalsResult.status === "rejected"
        ? "Approvals could not load. Risks and saved exceptions below are still current."
        : exceptionsResult.status === "rejected"
          ? "Saved exception state could not load. Live risks below can still be acknowledged."
          : null;
    setState({
      status: "ready",
      signals: signalsResult.status === "fulfilled" ? signalsResult.value : [],
      approvals: approvalsResult.status === "fulfilled" ? approvalsResult.value.approvals : [],
      exceptions: exceptionsResult.status === "fulfilled" ? exceptionsResult.value : [],
      warning,
    });
  }, [organizationId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const items = useMemo(() => state.status === "ready" ? buildItems(state.signals, state.approvals, state.exceptions) : [], [state]);
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

  async function updateException(item: QueueItem, status: ExceptionStatus, assignToMe = false) {
    if (!item.stableKey) return;
    if (!actorId || !organizationId) {
      toast({ title: "Sign in to update this exception", description: "Exception ownership and decisions are recorded against your account.", tone: "danger" });
      return;
    }
    setBusyItemId(item.id);
    try {
      const outcome = await saveException({
        stableKey: item.stableKey,
        status,
        title: (item.record?.title ?? item.title).slice(0, 200),
        summary: (item.record?.summary ?? item.detail).slice(0, 2000),
        details: {
          severity: item.severity,
          module: item.moduleKey,
          signalId: item.signalId ?? null,
          refType: item.evidence?.refType ?? null,
          refId: item.evidence?.refId ?? null,
          capabilityId: item.capabilityId ?? null,
          href: item.href,
          stale: item.stale ?? false,
        },
        ...(assignToMe && status === "acknowledged" ? { ownerUserId: actorId } : {}),
      }, { actorId, organizationId });
      if (outcome.kind === "pending") {
        toast({ title: "Exception update waiting for approval", description: outcome.reason, tone: "default" });
        return;
      }
      setState((current) => {
        if (current.status !== "ready") return current;
        const index = current.exceptions.findIndex((record) => record.id === outcome.record.id);
        const exceptions = index >= 0
          ? current.exceptions.map((record) => record.id === outcome.record.id ? outcome.record : record)
          : [...current.exceptions, outcome.record];
        return { ...current, exceptions };
      });
      toast({
        title: status === "resolved" ? "Exception resolved" : status === "acknowledged" ? "Exception acknowledged" : "Exception reopened",
        description: assignToMe ? "It is now assigned to you." : "The decision is recorded in the audit trail and can be reopened.",
        tone: "success",
      });
    } catch (error) {
      toast({
        title: "Could not update the exception",
        description: error instanceof Error ? error.message : "Try again in a moment.",
        tone: "danger",
      });
    } finally {
      setBusyItemId(null);
    }
  }

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
                      {item.stale && <span className="inbox-item-kind">No longer detected</span>}
                      {item.status && item.status !== "open" && (
                        <span className={`inbox-item-status inbox-item-status-${item.status}`}>
                          {item.status === "acknowledged" ? "Acknowledged" : "Resolved"}
                        </span>
                      )}
                      {item.record?.ownerUserId && item.record.ownerUserId === actorId && <span className="inbox-item-owner">Assigned to you</span>}
                      <span>{timeAgo(item.createdAt)}</span>
                    </div>
                    <p className="inbox-item-title">{item.title}</p>
                    <p className="inbox-item-detail">{item.detail}</p>
                    {item.capabilityId && <p className="inbox-item-action">Suggested next step <strong>{actionName(item.capabilityId) ?? item.capabilityId}</strong></p>}
                  </div>
                  <div className="inbox-item-actions">
                    {item.kind !== "approval" && item.status === "open" && (
                      <>
                        <button type="button" className="ui-button ui-button-quiet ui-button-sm" disabled={busyItemId !== null} onClick={() => void updateException(item, "acknowledged")}>
                          Acknowledge
                        </button>
                        {actorId && (
                          <button type="button" className="ui-button ui-button-quiet ui-button-sm" disabled={busyItemId !== null} onClick={() => void updateException(item, "acknowledged", true)}>
                            Take it
                          </button>
                        )}
                      </>
                    )}
                    {item.kind !== "approval" && item.status !== "resolved" && (
                      <button type="button" className="ui-button ui-button-quiet ui-button-sm" disabled={busyItemId !== null} onClick={() => void updateException(item, "resolved")}>
                        Resolve
                      </button>
                    )}
                    {item.kind !== "approval" && item.status === "resolved" && (
                      <button type="button" className="ui-button ui-button-quiet ui-button-sm" disabled={busyItemId !== null} onClick={() => void updateException(item, "open")}>
                        Reopen
                      </button>
                    )}
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
