"use client";

import { useEffect, useState } from "react";
import { BellRing, CheckCheck } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { getApiClient } from "@/lib/api";

type Notification = {
  id: string;
  kind: string;
  title: string;
  body?: string | null;
  read: boolean;
  createdAt: string;
};

export default function NotificationsPage() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [err, setErr] = useState("");

  async function load() {
    const res = await getApiClient().listNotifications(unreadOnly);
    setItems(res.notifications ?? []);
  }

  useEffect(() => {
    load().catch(() => setErr("Failed to load notifications"));
  }, [unreadOnly]);

  async function markRead(id: string) {
    setErr("");
    try {
      await getApiClient().markNotificationRead(id);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to update notification");
    }
  }

  async function markAllRead() {
    setErr("");
    try {
      await getApiClient().markAllNotificationsRead();
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to update notifications");
    }
  }

  const unreadCount = items.filter((n) => !n.read).length;

  return (
    <AppShell subtitle="What has happened while you were away.">
      <section className="card stack">
        <div className="section-head">
          <div>
            <h2>Notifications</h2>
            <p className="muted">
              {unreadCount} unread in the current view.
            </p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <label className="checkbox-label">
              <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
              Unread only
            </label>
            <button className="btn secondary" type="button" onClick={markAllRead} disabled={unreadCount === 0}>
              <CheckCheck size={15} /> Mark all read
            </button>
          </div>
        </div>
        {err ? <span className="error">{err}</span> : null}
        {items.length === 0 ? (
          <div className="empty-state">
            <BellRing size={26} />
            <p>No notifications in this view.</p>
          </div>
        ) : (
          <div className="stack">
            {items.map((n) => (
              <div key={n.id} className={n.read ? "row notif-row" : "row notif-row unread"}>
                <div className="stack" style={{ gap: 2, flex: 1 }}>
                  <div className="row" style={{ gap: 8, alignItems: "center" }}>
                    <span className="badge">{n.kind}</span>
                    <strong>{n.title}</strong>
                  </div>
                  {n.body ? <span className="muted small">{n.body}</span> : null}
                  <span className="muted small">{new Date(n.createdAt).toLocaleString()}</span>
                </div>
                {!n.read ? (
                  <button className="btn secondary" type="button" onClick={() => markRead(n.id)}>
                    Mark read
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>
    </AppShell>
  );
}