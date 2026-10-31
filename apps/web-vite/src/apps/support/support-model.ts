import { currencyMinorUnits } from "@chaste/erp-core";
import type {
  SupportConversation,
  SupportMessage,
  SupportOrderStatus,
} from "../../api/support";

export type SupportTabId =
  "inbox" | "overview" | "knowledge" | "channels" | "settings";
export type SupportRoute = {
  tab: SupportTabId | "not-found";
  conversationId: string | null;
};
export type SupportQueueFilter = "all" | "open" | "escalated" | "resolved";
export type SupportSort = "newest" | "priority" | "sla";
export type SupportAssigneeFilter = "everyone" | "mine" | "unassigned";
export type SupportSlaFilter = "any" | "breached" | "soon";
export type SlaTone = "danger" | "warn" | "ok" | "none";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseSupportRoute(pathname: string): SupportRoute {
  if (pathname === "/support" || pathname === "/support/inbox")
    return { tab: "inbox", conversationId: null };
  if (pathname.startsWith("/support/inbox/")) {
    const conversationId = pathname.slice("/support/inbox/".length);
    return {
      tab: "inbox",
      conversationId: UUID.test(conversationId)
        ? conversationId.toLowerCase()
        : null,
    };
  }
  if (pathname === "/support/overview")
    return { tab: "overview", conversationId: null };
  if (pathname === "/support/knowledge")
    return { tab: "knowledge", conversationId: null };
  if (pathname === "/support/channels")
    return { tab: "channels", conversationId: null };
  if (pathname === "/support/settings")
    return { tab: "settings", conversationId: null };
  return { tab: "not-found", conversationId: null };
}

export function statusLabel(status: string): string {
  if (status === "escalated") return "Awaiting human";
  if (status === "resolved") return "Resolved";
  return "Open";
}

export function statusTone(status: string): "open" | "warn" | "muted" {
  if (status === "escalated") return "warn";
  if (status === "resolved") return "muted";
  return "open";
}

export function priorityLabel(priority: string | null | undefined): string {
  if (!priority) return "Normal";
  return priority[0]!.toUpperCase() + priority.slice(1);
}

export function priorityRank(priority: string | null | undefined): number {
  if (priority === "urgent") return 0;
  if (priority === "high") return 1;
  if (priority === "low") return 3;
  return 2;
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0] ?? ""}${words[words.length - 1]![0] ?? ""}`.toUpperCase();
}

export function avatarTone(name: string): string {
  let hash = 0;
  for (const character of name)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return `tone-${(hash % 6) + 1}`;
}

function timestampOf(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function relativeTime(
  iso: string | null | undefined,
  now = Date.now(),
): string {
  if (!iso) return "";
  const time = timestampOf(iso);
  if (time === 0) return "";
  const seconds = Math.round((now - time) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Date(time).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "Unknown";
  const time = timestampOf(iso);
  if (time === 0) return "Unknown";
  return new Date(time).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "Unknown";
  const time = timestampOf(iso);
  if (time === 0) return "Unknown";
  return new Date(time).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatMinor(
  minor: number,
  currency: string | null | undefined,
): string {
  const normalized = (currency ?? "").trim().toUpperCase();
  const units = /^[A-Z]{3}$/.test(normalized)
    ? currencyMinorUnits(normalized)
    : null;
  if (units === null)
    return (minor / 100).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const value = minor / 10 ** units;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: normalized,
    minimumFractionDigits: units,
    maximumFractionDigits: units,
  }).format(value);
}

function compactDuration(milliseconds: number): string {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function slaState(
  slaDueAt: string | null | undefined,
  now = Date.now(),
): { tone: SlaTone; label: string } {
  if (!slaDueAt) return { tone: "none", label: "No SLA" };
  const due = timestampOf(slaDueAt);
  if (due === 0) return { tone: "none", label: "No SLA" };
  const remaining = due - now;
  if (remaining <= 0) return { tone: "danger", label: "SLA breached" };
  if (remaining <= 4 * 3_600_000)
    return { tone: "warn", label: `SLA ${compactDuration(remaining)} left` };
  if (remaining <= 24 * 3_600_000)
    return { tone: "warn", label: `SLA ${compactDuration(remaining)} left` };
  if (remaining <= 7 * 86_400_000)
    return { tone: "ok", label: `SLA ${compactDuration(remaining)} left` };
  return {
    tone: "ok",
    label: `SLA ${new Date(due).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`,
  };
}

export function isSlaBreached(
  conversation: SupportConversation,
  now = Date.now(),
): boolean {
  if (conversation.status === "resolved" || !conversation.slaDueAt)
    return false;
  const due = timestampOf(conversation.slaDueAt);
  return due !== 0 && due <= now;
}

export function filterConversations(
  conversations: SupportConversation[],
  options: {
    query?: string;
    status?: SupportQueueFilter;
    assignee?: SupportAssigneeFilter;
    priority?: string;
    sla?: SupportSlaFilter;
    actorId?: string | null;
    now?: number;
  },
): SupportConversation[] {
  const query = (options.query ?? "").trim().toLowerCase();
  const now = options.now ?? Date.now();
  return conversations.filter((conversation) => {
    if (
      options.status &&
      options.status !== "all" &&
      conversation.status !== options.status
    )
      return false;
    if (
      options.assignee === "mine" &&
      (!options.actorId || conversation.assignedUserId !== options.actorId)
    )
      return false;
    if (options.assignee === "unassigned" && conversation.assignedUserId)
      return false;
    if (options.priority && conversation.priority !== options.priority)
      return false;
    if (options.sla === "breached" && !isSlaBreached(conversation, now))
      return false;
    if (options.sla === "soon") {
      if (conversation.status === "resolved" || !conversation.slaDueAt)
        return false;
      const remaining = timestampOf(conversation.slaDueAt) - now;
      if (remaining <= 0 || remaining > 4 * 3_600_000) return false;
    }
    if (!query) return true;
    const haystack = [
      conversation.customerName,
      conversation.customerEmail,
      conversation.subject,
      conversation.lastMessagePreview,
      conversation.ticketNumber !== null &&
      conversation.ticketNumber !== undefined
        ? `#${conversation.ticketNumber}`
        : "",
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
}

export function sortConversations(
  conversations: SupportConversation[],
  sort: SupportSort,
): SupportConversation[] {
  const newest = (left: SupportConversation, right: SupportConversation) =>
    timestampOf(right.lastMessageAt ?? right.updatedAt ?? right.createdAt) -
    timestampOf(left.lastMessageAt ?? left.updatedAt ?? left.createdAt);
  return [...conversations].sort((left, right) => {
    if (sort === "priority") {
      const byPriority =
        priorityRank(left.priority) - priorityRank(right.priority);
      if (byPriority !== 0) return byPriority;
      return newest(left, right);
    }
    if (sort === "sla") {
      const leftDue = timestampOf(left.slaDueAt) || Number.MAX_SAFE_INTEGER;
      const rightDue = timestampOf(right.slaDueAt) || Number.MAX_SAFE_INTEGER;
      if (leftDue !== rightDue) return leftDue - rightDue;
      return newest(left, right);
    }
    return newest(left, right);
  });
}

export function systemMessageText(body: string): string {
  const trimmed = body.trim();
  if (trimmed.startsWith("Conversation opened about "))
    return "Conversation opened";
  if (trimmed.startsWith("Escalated by ")) return "Escalated to a person";
  if (trimmed.startsWith("Resolved by ")) return "Resolved";
  if (trimmed.startsWith("Reopened by ")) return "Reopened";
  return trimmed;
}

export function escalationReason(messages: SupportMessage[]): string | null {
  const escalation = [...messages]
    .reverse()
    .find(
      (message) =>
        message.senderType === "system" &&
        message.body.trim().toLowerCase().startsWith("escalated by "),
    );
  if (!escalation) return null;
  const separator = escalation.body.indexOf(": ");
  if (separator === -1) return escalation.body.trim();
  const reason = escalation.body.slice(separator + 2).trim();
  return reason.length > 0 ? reason : escalation.body.trim();
}

export function supportActivity(messages: SupportMessage[]): SupportMessage[] {
  return [...messages]
    .filter(
      (message) =>
        message.senderType === "system" || message.senderType === "agent",
    )
    .sort(
      (left, right) =>
        timestampOf(right.createdAt) - timestampOf(left.createdAt),
    )
    .slice(0, 5);
}

export function customerHistory(
  conversations: SupportConversation[],
  customerId: string | null | undefined,
  excludeId: string | null | undefined,
): SupportConversation[] {
  if (!customerId) return [];
  return conversations
    .filter(
      (conversation) =>
        conversation.customerId === customerId && conversation.id !== excludeId,
    )
    .sort(
      (left, right) =>
        timestampOf(right.lastMessageAt ?? right.updatedAt) -
        timestampOf(left.lastMessageAt ?? left.updatedAt),
    )
    .slice(0, 5);
}

export function attentionRows(
  conversations: SupportConversation[],
  now = Date.now(),
): SupportConversation[] {
  return conversations
    .filter(
      (conversation) =>
        conversation.status !== "resolved" &&
        (conversation.status === "escalated" ||
          isSlaBreached(conversation, now) ||
          (conversation.priority === "urgent" && !conversation.assignedUserId)),
    )
    .sort((left, right) => {
      const leftScore =
        (left.status === "escalated" ? 0 : 1) +
        (isSlaBreached(left, now) ? 0 : 1) +
        priorityRank(left.priority) / 10;
      const rightScore =
        (right.status === "escalated" ? 0 : 1) +
        (isSlaBreached(right, now) ? 0 : 1) +
        priorityRank(right.priority) / 10;
      return leftScore - rightScore;
    })
    .slice(0, 6);
}

export function countByStatus(
  conversations: SupportConversation[],
): Record<SupportQueueFilter, number> {
  return {
    all: conversations.length,
    open: conversations.filter((conversation) => conversation.status === "open")
      .length,
    escalated: conversations.filter(
      (conversation) => conversation.status === "escalated",
    ).length,
    resolved: conversations.filter(
      (conversation) => conversation.status === "resolved",
    ).length,
  };
}

export function orderStatusSummary(status: SupportOrderStatus | null): string {
  if (!status || status.invoices.length === 0) return "No invoices on record";
  if (status.totalOutstandingMinor <= 0) return "Nothing outstanding";
  return `${formatMinor(status.totalOutstandingMinor, null)} outstanding`;
}

export function pendingActionDescription(
  capabilityId: string,
  input: Record<string, unknown>,
): string {
  const body = typeof input.body === "string" ? input.body : "";
  const subject = typeof input.subject === "string" ? input.subject : "";
  const reason = typeof input.reason === "string" ? input.reason : "";
  switch (capabilityId) {
    case "support.startConversation":
      return `Open a conversation${subject ? ` about "${subject}"` : ""}`;
    case "support.postMessage":
      return `Record this message: "${body.length > 140 ? `${body.slice(0, 137)}...` : body}"`;
    case "support.escalateConversation":
      return `Escalate this conversation${reason ? `: "${reason}"` : ""}`;
    case "support.resolveConversation":
      return "Resolve this conversation";
    case "support.reopenConversation":
      return "Reopen this conversation";
    case "support.updateTicket":
      return "Save the ticket fields";
    default:
      return capabilityId.replaceAll(".", " ");
  }
}
