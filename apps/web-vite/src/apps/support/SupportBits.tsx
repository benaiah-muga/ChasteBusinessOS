import type { ReactNode } from "react";
import { Check, Copy, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { useToast } from "../../ui/toast";
import { Kbd } from "../../ui/page-header";
import {
  avatarTone,
  initials,
  priorityLabel,
  slaState,
  statusLabel,
  statusTone,
} from "./support-model";

export function SupportAvatar({
  name,
  size = "md",
}: {
  name: string;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <span
      className={`support-avatar support-avatar-${size} ${avatarTone(name)}`}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

export function StatusBadge({
  status,
  compact = false,
}: {
  status: string;
  compact?: boolean;
}) {
  return (
    <span
      className={`support-status support-status-${statusTone(status)}${compact ? " support-status-compact" : ""}`}
    >
      <span className="support-status-dot" aria-hidden="true" />
      {statusLabel(status)}
    </span>
  );
}

export function PriorityBadge({
  priority,
  compact = false,
}: {
  priority: string | null | undefined;
  compact?: boolean;
}) {
  const value = priority ?? "normal";
  return (
    <span
      className={`support-priority support-priority-${value}${compact ? " support-priority-compact" : ""}`}
    >
      {priorityLabel(value)}
    </span>
  );
}

export function SlaBadge({
  dueAt,
  status,
  now,
}: {
  dueAt: string | null | undefined;
  status: string;
  now?: number;
}) {
  if (status === "resolved") return null;
  const sla = slaState(dueAt, now);
  if (sla.tone === "none") return null;
  return (
    <span className={`support-sla support-sla-${sla.tone}`}>{sla.label}</span>
  );
}

export function SupportEmpty({
  icon: Icon,
  title,
  detail,
  action,
  compact = false,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`support-empty${compact ? " support-empty-compact" : ""}`}>
      <span className="support-empty-icon" aria-hidden="true">
        <Icon size={20} />
      </span>
      <h3>{title}</h3>
      <p>{detail}</p>
      {action && <div className="support-empty-action">{action}</div>}
    </div>
  );
}

export function SupportKeyHints({
  items,
}: {
  items: Array<{ keys: string; label: string }>;
}) {
  return (
    <span className="support-key-hints">
      {items.map((item) => (
        <span key={item.keys}>
          <Kbd>{item.keys}</Kbd> {item.label}
        </span>
      ))}
    </span>
  );
}

export function CopyButton({
  value,
  label = "Copy",
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  function copy() {
    if (!value) return;
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => {
        toast({
          title: `Could not copy the ${label.toLowerCase()}`,
          description: "Select the text and copy it manually.",
          tone: "danger",
        });
      });
  }

  return (
    <button
      type="button"
      className={`support-copy-button${className ? ` ${className}` : ""}`}
      onClick={copy}
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
    >
      {copied ? (
        <Check size={12} aria-hidden="true" />
      ) : (
        <Copy size={12} aria-hidden="true" />
      )}
      <span>{copied ? "Copied" : label}</span>
    </button>
  );
}
