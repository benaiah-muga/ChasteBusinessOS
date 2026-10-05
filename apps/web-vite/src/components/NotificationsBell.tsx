import { useCallback, useEffect, useRef, useState } from "react";
import { fetchNotifications, markNotificationRead, safeNotificationHref, type Notification } from "../api/notifications";

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

const styles = {
  root: { position: "relative" as const },
  trigger: {
    position: "relative" as const,
    display: "grid",
    width: 40,
    height: 40,
    placeItems: "center",
    border: "1px solid #e7e5e4",
    borderRadius: 12,
    background: "#fff",
    color: "#57534e",
    cursor: "pointer",
  },
  badge: {
    position: "absolute" as const,
    top: -4,
    right: -4,
    display: "grid",
    minWidth: 18,
    height: 18,
    padding: "0 4px",
    placeItems: "center",
    borderRadius: 999,
    background: "#a87817",
    color: "white",
    fontSize: 10,
    fontWeight: 700,
  },
  panel: {
    position: "absolute" as const,
    zIndex: 40,
    top: "calc(100% + 8px)",
    right: 0,
    width: "min(340px, calc(100vw - 24px))",
    overflow: "hidden",
    border: "1px solid #e7e5e4",
    borderRadius: 14,
    background: "white",
    boxShadow: "0 12px 32px rgb(28 25 23 / 14%)",
  },
  heading: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    margin: 0,
    padding: "12px 15px",
    borderBottom: "1px solid #f1f0ee",
    color: "#57534e",
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase" as const,
  },
  list: { maxHeight: 360, overflowY: "auto" as const, margin: 0, padding: 0, listStyle: "none" },
  item: { borderBottom: "1px solid #f5f5f4" },
  link: { display: "block", padding: "12px 15px", color: "inherit", textDecoration: "none" },
  title: { margin: 0, color: "#292524", fontSize: 13, lineHeight: 1.4 },
  time: { margin: "4px 0 0", color: "#78716c", fontSize: 11 },
  muted: { margin: 0, padding: "24px 16px", color: "#78716c", fontSize: 12, textAlign: "center" as const },
  error: { margin: 0, padding: "16px", color: "#9f3528", fontSize: 12, textAlign: "center" as const },
  retry: { marginTop: 8, border: 0, background: "transparent", color: "#784f06", font: "inherit", fontWeight: 650, cursor: "pointer" },
} as const;

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
  const boxRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (boxRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function markRead(row: Notification) {
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

  const panelStyle = align === "left" ? { ...styles.panel, right: "auto", left: 0 } : styles.panel;

  return (
    <div ref={boxRef} style={styles.root}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Notifications${unread > 0 ? `, ${unread} unread` : ""}`}
        aria-expanded={open}
        aria-controls="notifications-menu"
        onClick={() => {
          setOpen((current) => !current);
          void load();
        }}
        style={styles.trigger}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="19" height="19">
          <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" strokeLinecap="round" />
        </svg>
        {unread > 0 && <span aria-hidden="true" style={styles.badge}>{unread > 9 ? "9+" : unread}</span>}
      </button>

      {open && (
        <section id="notifications-menu" aria-label="Recent notifications" style={panelStyle}>
          <h2 style={styles.heading}>Notifications</h2>
          {error ? (
            <p role="alert" style={styles.error}>
              {error}<br />
              <button type="button" style={styles.retry} onClick={() => void load()}>Try again</button>
            </p>
          ) : rows === null ? (
            <p role="status" style={styles.muted}>Loading notifications…</p>
          ) : rows.length === 0 ? (
            <p style={styles.muted}>Nothing new. Recent approvals and updates appear here.</p>
          ) : (
            <ul style={styles.list}>
              {rows.map((row) => {
                const href = safeNotificationHref(row.href);
                const contents = <>
                  <p style={{ ...styles.title, fontWeight: row.readAt ? 450 : 650 }}>{row.title}</p>
                  <p style={styles.time}>{timeAgo(row.createdAt)}</p>
                </>;
                return (
                  <li key={row.id} role="none" style={{ ...styles.item, background: row.readAt ? "white" : "#fbf7ed" }}>
                    {href ? (
                      <a
                        href={href}
                        onClick={(event) => {
                          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                            void markRead(row);
                            return;
                          }
                          event.preventDefault();
                          void markRead(row).then(() => {
                            setOpen(false);
                            if (onNavigate) onNavigate(href);
                            else window.location.assign(href);
                          });
                        }}
                        style={styles.link}
                      >
                        {contents}
                      </a>
                    ) : (
                      <div aria-disabled="true" style={styles.link}>{contents}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
