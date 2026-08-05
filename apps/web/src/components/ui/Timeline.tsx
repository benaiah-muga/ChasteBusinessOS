"use client";

import {
  CalendarDays,
  Mail,
  MessageSquare,
  PartyPopper,
  Phone,
  Star,
  Trash2,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import type { Interaction } from "@chaste/api-client";

const KIND_META: Record<string, { icon: LucideIcon; label: string }> = {
  created: { icon: Star, label: "Created" },
  status_change: { icon: PartyPopper, label: "Status change" },
  note: { icon: MessageSquare, label: "Note" },
  email: { icon: Mail, label: "Email" },
  call: { icon: Phone, label: "Call" },
  meeting: { icon: CalendarDays, label: "Meeting" },
  contact_added: { icon: UserPlus, label: "Contact added" },
  contact_removed: { icon: Trash2, label: "Contact removed" },
  deleted: { icon: Trash2, label: "Deleted" },
};

export function Timeline({ items }: { items: Interaction[] }) {
  if (items.length === 0) {
    return (
      <div className="empty-state">
        <div className="icon">
          <MessageSquare size={20} />
        </div>
        <h3>No activity yet</h3>
        <p>Log a note, call, or meeting to start the relationship timeline.</p>
      </div>
    );
  }
  return (
    <div className="timeline">
      {items.map((it) => {
        const meta = KIND_META[it.kind] ?? { icon: MessageSquare, label: it.kind };
        const Icon = meta.icon;
        return (
          <div className="timeline-item" key={it.id}>
            <div className="timeline-dot" title={meta.label}>
              <Icon size={14} />
            </div>
            <div className="timeline-panel">
              <div className="timeline-title">{it.summary}</div>
              {it.detail ? <div className="muted timeline-detail">{it.detail}</div> : null}
              <div className="timeline-meta">{new Date(it.createdAt).toLocaleString()}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
