import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Check, Inbox, RefreshCw, TriangleAlert } from "lucide-react";
import { fetchNotifications, markNotificationRead, safeNotificationHref, type Notification } from "../api/notifications";
import { navigate } from "../navigation";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import "./notifications-bell.css";

const NOTIFICATION_CAPABILITY = /\b(iam|accounting|purchasing|inventory|crm|sales|hr|documents|support|pos|manufacturing|marketing|projects|creator|approval)\.([a-zA-Z0-9]+)\b/g;

function humanizeNotificationTitle(title: string): string {
  return title
    .replace(NOTIFICATION_CAPABILITY, (_match, _domain: string, action: string) => action.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase()))
    .replace(/risk class '([^']+)'/gi, "risk: $1")
    .replace(/ - /g, " · ");
}

function timeAgo(value: string): string {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function NotificationsBell({
  align = "right",
  onNavigate,
}: {
  align?: "left" | "right";
  onNavigate?: (href: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Notification[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pendingReadRef = useRef(new Map<string, Promise<void>>());
  const requestRef = useRef(0);
  const readMutationVersionRef = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    while (pendingReadRef.current.size > 0) {
      await Promise.allSettled([...pendingReadRef.current.values()]);
      if (signal?.aborted) return;
    }
    const mutationVersion = readMutationVersionRef.current;
    const requestId = ++requestRef.current;
    try {
      const result = await fetchNotifications(signal);
      if (signal?.aborted || requestId !== requestRef.current || mutationVersion !== readMutationVersionRef.current) return;
      setRows(result.notifications);
      setUnread(result.unreadCount);
      setError(null);
    } catch (caught) {
      if (signal?.aborted || requestId !== requestRef.current || mutationVersion !== readMutationVersionRef.current) return;
      setError(caught instanceof Error ? caught.message : "Could not load notifications. Try again.");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = window.setInterval(() => void load(controller.signal), 30_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      requestRef.current += 1;
    };
  }, [load]);

  async function markRead(row: Notification): Promise<void> {
    if (row.readAt) return;
    const pending = pendingReadRef.current.get(row.id);
    if (pending) return pending;
    readMutationVersionRef.current += 1;
    setRows((current) => current?.map((item) => item.id === row.id ? { ...item, readAt: new Date().toISOString() } : item) ?? null);
    setUnread((current) => Math.max(0, current - 1));
    let failed = false;
    const request = markNotificationRead(row.id)
      .catch((caught: unknown) => {
        failed = true;
        setError(caught instanceof Error ? caught.message : "Could not update this notification.");
      })
      .finally(() => {
        pendingReadRef.current.delete(row.id);
      });
    pendingReadRef.current.set(row.id, request);
    await request;
    if (failed) void load();
  }

  async function markAllRead() {
    const unreadRows = rows?.filter((row) => !row.readAt) ?? [];
    if (unreadRows.length === 0) return;
    await Promise.all(unreadRows.map((row) => markRead(row)));
  }

  function openHref(href: string) {
    setOpen(false);
    if (onNavigate) onNavigate(href);
    else navigate(href);
  }

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) void load(); }}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className="topbar-icon-button notifications-trigger"
          aria-label={`Notifications${unread > 0 ? `, ${unread} unread` : ""}`}
        >
          <Bell size={16} aria-hidden="true" />
          {unread > 0 && <span className="notifications-badge" aria-hidden="true">{unread > 9 ? "9+" : unread}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={align === "left" ? "start" : "end"}
        className="notifications-panel"
        aria-label="Recent notifications"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef.current?.focus();
        }}
        onKeyDownCapture={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
        }}
      >
        <header className="notifications-head">
          <div>
            <p className="notifications-eyebrow">Workspace activity</p>
            <h2>Notifications</h2>
          </div>
          {unread > 0 && (
            <button type="button" className="notifications-mark-all" onClick={() => void markAllRead()}>
              <Check size={12} aria-hidden="true" /> Mark all read
            </button>
          )}
        </header>

        {error ? (
          <div className="notifications-state" role="alert">
            <span className="notifications-state-icon notifications-state-icon-error"><TriangleAlert size={17} aria-hidden="true" /></span>
            <strong>Could not load notifications</strong>
            <p>{error}</p>
            <button type="button" className="ui-button ui-button-secondary ui-button-sm" onClick={() => void load()}>
              <RefreshCw size={12} aria-hidden="true" /> Try again
            </button>
          </div>
        ) : rows === null ? (
          <div className="notifications-loading" role="status">
            <span /><span /><span />
          </div>
        ) : rows.length === 0 ? (
          <div className="notifications-state">
            <span className="notifications-state-icon"><Bell size={17} aria-hidden="true" /></span>
            <strong>Nothing new</strong>
            <p>Approvals, mentions, and workspace updates land here.</p>
          </div>
        ) : (
          <ul className="notifications-list">
            {rows.map((row) => {
              const href = safeNotificationHref(row.href);
              const contents = (
                <>
                  <span className={`notifications-dot${row.readAt ? "" : " is-unread"}`} aria-hidden="true" />
                  <span className="notifications-copy">
                    <span className="notifications-title">{humanizeNotificationTitle(row.title)}</span>
                    <span className="notifications-time">{timeAgo(row.createdAt)}</span>
                  </span>
                </>
              );
              return (
                <li key={row.id}>
                  {href ? (
                    <a
                      href={href}
                      className={`notifications-item${row.readAt ? "" : " is-unread"}`}
                      onClick={(event) => {
                        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                          void markRead(row);
                          return;
                        }
                        event.preventDefault();
                        void markRead(row).then(() => openHref(href));
                      }}
                    >
                      {contents}
                    </a>
                  ) : (
                    <div className={`notifications-item${row.readAt ? "" : " is-unread"}`} aria-disabled="true">{contents}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <footer className="notifications-footer">
          <a href="/inbox" onClick={(event) => { event.preventDefault(); openHref("/inbox"); }}>
            <Inbox size={13} aria-hidden="true" /> Open your inbox
          </a>
          <button type="button" onClick={() => void load()} aria-label="Refresh notifications">
            <RefreshCw size={13} aria-hidden="true" />
          </button>
        </footer>
      </PopoverContent>
    </Popover>
  );
}
