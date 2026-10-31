import { useEffect, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  Inbox,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Users,
  Zap,
} from "lucide-react";
import { Button } from "../../ui/button";
import { navigate } from "../../navigation";
import { useSupportDesk } from "./SupportDeskContext";
import {
  PriorityBadge,
  SlaBadge,
  StatusBadge,
  SupportAvatar,
  SupportEmpty,
} from "./SupportBits";
import { SupportTicketsPanel } from "./SupportTicketsPanel";
import {
  attentionRows,
  countByStatus,
  isSlaBreached,
  relativeTime,
  sortConversations,
} from "./support-model";

const PRIORITIES = ["urgent", "high", "normal", "low"] as const;

export function SupportOverview() {
  const desk = useSupportDesk();
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const counts = useMemo(
    () => countByStatus(desk.conversations),
    [desk.conversations],
  );
  const attention = useMemo(
    () => attentionRows(desk.conversations, now),
    [desk.conversations, now],
  );
  const breached = useMemo(
    () =>
      desk.conversations.filter((conversation) =>
        isSlaBreached(conversation, now),
      ).length,
    [desk.conversations, now],
  );
  const unassigned = useMemo(
    () =>
      desk.conversations.filter(
        (conversation) =>
          conversation.status !== "resolved" && !conversation.assignedUserId,
      ).length,
    [desk.conversations],
  );
  const recent = useMemo(
    () => sortConversations(desk.conversations, "newest").slice(0, 6),
    [desk.conversations],
  );
  const priorityCounts = useMemo(
    () =>
      PRIORITIES.map((priority) => ({
        priority,
        count: desk.conversations.filter(
          (conversation) => (conversation.priority ?? "normal") === priority,
        ).length,
      })),
    [desk.conversations],
  );
  const maxPriority = Math.max(1, ...priorityCounts.map((item) => item.count));
  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  async function refresh() {
    setRefreshing(true);
    await desk.refreshConversations();
    setRefreshing(false);
  }

  return (
    <div className="support-page">
      <header className="support-page-head">
        <div>
          <p className="support-eyebrow">{today} · Desk brief</p>
          <h1>Overview</h1>
          <p>
            What the desk handled, what still needs a person, and where the
            queue is exposed. Every figure comes from the loaded conversations.
          </p>
        </div>
        <div className="support-page-actions">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void refresh()}
            disabled={refreshing}
          >
            {refreshing ? (
              <Loader2 size={13} className="support-spin" aria-hidden="true" />
            ) : (
              <RefreshCw size={13} aria-hidden="true" />
            )}
            {refreshing ? "Refreshing..." : "Refresh"}
          </Button>
          <Button size="sm" onClick={() => navigate("/support/inbox")}>
            Open inbox <ArrowRight size={13} aria-hidden="true" />
          </Button>
        </div>
      </header>

      <div className="support-overview-status">
        <span
          className={`support-status-dot support-status-dot-${counts.escalated > 0 ? "warn" : "open"}`}
          aria-hidden="true"
        />
        <p>
          {counts.all === 0
            ? "The desk is quiet. A new conversation or website widget message will land in the inbox."
            : `${counts.open + counts.escalated} ${counts.open + counts.escalated === 1 ? "conversation is" : "conversations are"} in the active queue, and ${counts.escalated} ${counts.escalated === 1 ? "is" : "are"} waiting on a person.`}
        </p>
        <span className="support-overview-scope">Loaded queue</span>
      </div>

      <div className="support-kpi-grid">
        <KpiCard
          label="Open inquiries"
          value={counts.open}
          detail={
            counts.open === 1
              ? "Conversation in progress"
              : "Conversations in progress"
          }
          icon={Inbox}
          onClick={() => navigate("/support/inbox?status=open")}
        />
        <KpiCard
          label="Awaiting human"
          value={counts.escalated}
          detail="Escalated, out of automatic handling"
          icon={Zap}
          tone={counts.escalated > 0 ? "warn" : "default"}
          onClick={() => navigate("/support/inbox?status=escalated")}
        />
        <KpiCard
          label="SLA breached"
          value={breached}
          detail="Past the due time, still unresolved"
          icon={Clock3}
          tone={breached > 0 ? "danger" : "default"}
          onClick={() => navigate("/support/inbox?sla=breached")}
        />
        <KpiCard
          label="Unassigned"
          value={unassigned}
          detail="No owner on the conversation"
          icon={Users}
          tone={unassigned > 0 ? "warn" : "default"}
          onClick={() => navigate("/support/inbox?assignee=unassigned")}
        />
      </div>

      <div className="support-overview-grid">
        <div className="support-overview-column">
          <section
            className="support-overview-panel support-overview-attention"
            aria-labelledby="support-attention"
          >
            <header className="support-overview-panel-head">
              <div>
                <h2 id="support-attention">Needs you</h2>
                <p>
                  Escalations, breached SLAs, and urgent work without an owner.
                </p>
              </div>
              <span className="support-panel-count">{attention.length}</span>
            </header>
            {attention.length === 0 ? (
              <SupportEmpty
                icon={CheckCircle2}
                title="Nothing needs a person."
                detail="No escalated thread, breached SLA, or urgent unassigned conversation is waiting."
                compact
                action={
                  <button
                    type="button"
                    className="support-text-button"
                    onClick={() => navigate("/support/inbox")}
                  >
                    Open the queue
                  </button>
                }
              />
            ) : (
              <div className="support-attention-list">
                {attention.map((conversation) => {
                  const reason =
                    conversation.status === "escalated"
                      ? "Escalated to a person"
                      : isSlaBreached(conversation, now)
                        ? "SLA breached"
                        : "Urgent and unassigned";
                  return (
                    <button
                      key={conversation.id}
                      type="button"
                      className="support-attention-row"
                      onClick={() => desk.selectConversation(conversation.id)}
                    >
                      <SupportAvatar name={conversation.customerName} />
                      <span className="support-attention-copy">
                        <span className="support-attention-top">
                          <strong>{conversation.customerName}</strong>
                          <StatusBadge status={conversation.status} compact />
                          {conversation.priority !== "normal" &&
                          conversation.priority ? (
                            <PriorityBadge
                              priority={conversation.priority}
                              compact
                            />
                          ) : null}
                          <span className="support-attention-reason">
                            {reason}
                          </span>
                        </span>
                        <span className="support-attention-subject">
                          {conversation.subject}
                        </span>
                        <span className="support-attention-meta">
                          <span>
                            {conversation.assignedUserName ?? "Unassigned"}
                          </span>
                          <span>
                            {relativeTime(conversation.lastMessageAt, now)}
                          </span>
                          <SlaBadge
                            dueAt={conversation.slaDueAt}
                            status={conversation.status}
                            now={now}
                          />
                        </span>
                      </span>
                      <ArrowUpRight
                        size={15}
                        className="support-row-arrow"
                        aria-hidden="true"
                      />
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section
            className="support-overview-panel"
            aria-labelledby="support-workload"
          >
            <header className="support-overview-panel-head">
              <div>
                <h2 id="support-workload">Queue shape</h2>
                <p>From the most recent conversations this desk loaded.</p>
              </div>
            </header>
            <div className="support-workload">
              <div className="support-workload-block">
                <span className="support-workload-label">By status</span>
                <StatusBar
                  label="Open"
                  value={counts.open}
                  total={counts.all}
                  tone="open"
                />
                <StatusBar
                  label="Awaiting human"
                  value={counts.escalated}
                  total={counts.all}
                  tone="warn"
                />
                <StatusBar
                  label="Resolved"
                  value={counts.resolved}
                  total={counts.all}
                  tone="muted"
                />
              </div>
              <div className="support-workload-block">
                <span className="support-workload-label">By priority</span>
                {priorityCounts.map((item) => (
                  <div className="support-priority-bar" key={item.priority}>
                    <span>{item.priority}</span>
                    <span className="support-priority-bar-track">
                      <span
                        style={{
                          width: `${Math.round((item.count / maxPriority) * 100)}%`,
                        }}
                        className={`support-priority-bar-fill support-priority-bar-${item.priority}`}
                      />
                    </span>
                    <strong>{item.count}</strong>
                  </div>
                ))}
              </div>
              <div className="support-workload-block support-workload-foot">
                <span>
                  <CheckCircle2 size={12} aria-hidden="true" />{" "}
                  {counts.resolved} resolved
                </span>
                <span>
                  <Users size={12} aria-hidden="true" /> {unassigned} unassigned
                </span>
              </div>
            </div>
          </section>
        </div>

        <div className="support-overview-column">
          <section
            className="support-overview-panel"
            aria-labelledby="support-recent"
          >
            <header className="support-overview-panel-head">
              <div>
                <h2 id="support-recent">Recent conversations</h2>
                <p>Newest activity across the desk.</p>
              </div>
              <button
                type="button"
                className="support-text-button"
                onClick={() => navigate("/support/inbox")}
              >
                View all <ArrowRight size={11} aria-hidden="true" />
              </button>
            </header>
            {recent.length === 0 ? (
              <SupportEmpty
                icon={Inbox}
                title="No conversations yet."
                detail="Connect the website widget or open a conversation with a customer."
                compact
              />
            ) : (
              <div className="support-recent-list">
                {recent.map((conversation) => (
                  <button
                    key={conversation.id}
                    type="button"
                    className="support-recent-row"
                    onClick={() => desk.selectConversation(conversation.id)}
                  >
                    <SupportAvatar name={conversation.customerName} size="sm" />
                    <span className="support-recent-copy">
                      <span className="support-recent-top">
                        <strong>{conversation.customerName}</strong>
                        <span>
                          {relativeTime(conversation.lastMessageAt, now)}
                        </span>
                      </span>
                      <span>{conversation.subject}</span>
                    </span>
                    <StatusBadge status={conversation.status} compact />
                  </button>
                ))}
              </div>
            )}
          </section>

          <SupportTicketsPanel />
        </div>

        <section
          className="support-overview-panel support-overview-principles"
          aria-labelledby="support-principles"
        >
          <header className="support-overview-panel-head">
            <div>
              <h2 id="support-principles">How this desk works</h2>
              <p>The same governed path as every other Chaste workflow.</p>
            </div>
            <ShieldCheck size={16} aria-hidden="true" />
          </header>
          <ul>
            <li>
              <span>1</span>
              <div>
                <strong>A human sends every customer reply.</strong>
                <small>
                  The copilot drafts from the customer's own record and the
                  knowledge library. A person reviews and releases it.
                </small>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Escalation is explicit.</strong>
                <small>
                  The reason is written to the thread, the conversation leaves
                  the automatic queue, and the wait is visible.
                </small>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>Every change is on the record.</strong>
                <small>
                  Ticket fields, messages, assignments, and handoffs go through
                  the capability kernel and the audit ledger.
                </small>
              </div>
            </li>
          </ul>
          <div className="support-overview-principles-actions">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => navigate("/support/knowledge")}
            >
              Manage knowledge
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/support/channels")}
            >
              Channel settings
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  detail,
  icon: Icon,
  tone = "default",
  onClick,
}: {
  label: string;
  value: number;
  detail: string;
  icon: LucideIcon;
  tone?: "default" | "warn" | "danger";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`support-kpi support-kpi-${tone}`}
      onClick={onClick}
    >
      <span className="support-kpi-icon" aria-hidden="true">
        <Icon size={15} />
      </span>
      <span className="support-kpi-label">{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
      <ArrowUpRight
        size={13}
        className="support-kpi-arrow"
        aria-hidden="true"
      />
    </button>
  );
}

function StatusBar({
  label,
  value,
  total,
  tone,
}: {
  label: string;
  value: number;
  total: number;
  tone: "open" | "warn" | "muted";
}) {
  const width = total === 0 ? 0 : Math.round((value / total) * 100);
  return (
    <div className="support-status-bar">
      <span>{label}</span>
      <span className="support-status-bar-track">
        <span
          className={`support-status-bar-fill support-status-bar-${tone}`}
          style={{ width: `${width}%` }}
        />
      </span>
      <strong>{value}</strong>
    </div>
  );
}
