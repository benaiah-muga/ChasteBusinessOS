"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { callApi } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/format";

interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  href: string | null;
  readAt: string | null;
  createdAt: string;
}

/**
 * In-app notification bell: unread count + recent feed. Backed by the
 * notifications table that every governed event (approvals, escalations)
 * mirrors into via the NotificationSink.
 */
export function NotificationsBell({ align = "right" }: { align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<NotificationRow[] | null>(null);
  const [unread, setUnread] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const res = await callApi<{ notifications?: NotificationRow[]; unreadCount?: number }>(
      "/api/notifications?limit=20",
    );
    if (res.ok && res.data) {
      setRows(res.data.notifications ?? []);
      setUnread(res.data.unreadCount ?? 0);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  async function markRead(id: string) {
    setRows((cur) => cur?.map((r) => (r.id === id ? { ...r, readAt: new Date().toISOString() } : r)) ?? cur);
    setUnread((u) => Math.max(0, u - 1));
    await callApi("/api/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
  }

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
        onClick={() => {
          setOpen((v) => !v);
          void load();
        }}
        className="icon-btn relative"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-4.5">
          <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" strokeLinecap="round" />
        </svg>
        {unread > 0 && (
          <span className="absolute top-0.5 right-0.5 flex size-3.5 items-center justify-center rounded-full bg-maroon-700 text-[8px] font-bold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          className={cn(
            "absolute z-40 mt-2 w-80 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-lg",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          <p className="border-b border-stone-100 px-4 py-2.5 text-xs font-semibold tracking-wide text-stone-500 uppercase">
            Notifications
          </p>
          <ul className="max-h-80 divide-y divide-stone-100 overflow-y-auto">
            {!rows ? (
              <li className="px-4 py-6 text-center text-xs text-stone-400">Loading…</li>
            ) : rows.length === 0 ? (
              <li className="px-4 py-6 text-center text-xs text-stone-400">
                Nothing yet — approvals and escalations land here.
              </li>
            ) : (
              rows.map((n) => (
                <li key={n.id}>
                  <a
                    href={n.href ?? "#"}
                    onClick={() => !n.readAt && void markRead(n.id)}
                    className={cn(
                      "block cursor-pointer px-4 py-2.5 transition-colors hover:bg-stone-50",
                      !n.readAt && "bg-maroon-50/50",
                    )}
                  >
                    <p className={cn("text-[13px] leading-snug", !n.readAt ? "font-medium text-stone-900" : "text-stone-600")}>
                      {n.title}
                    </p>
                    <p className="mt-0.5 text-[11px] text-stone-400">{timeAgo(n.createdAt)}</p>
                  </a>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
