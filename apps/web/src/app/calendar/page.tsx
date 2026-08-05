"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarDays, Clock, Plus, X } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { getApiClient } from "@/lib/api";

type CalendarEvent = {
  id: string;
  title: string;
  description?: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
  branchId?: string | null;
  attendees?: string[];
  status: string;
};

type Branch = { id: string; name: string; code: string; isActiveBranch: boolean };

function startOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7; // Monday first
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export default function CalendarPage() {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchFilter, setBranchFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [form, setForm] = useState({
    title: "",
    startsAt: "",
    endsAt: "",
    timezone: "UTC",
    branchId: "",
  });

  const weekStart = useMemo(() => startOfWeek(new Date()), []);
  const days = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      return d;
    });
  }, [weekStart]);

  async function load() {
    const [ev, br] = await Promise.all([
      getApiClient().listCalendarEvents({
        from: weekStart.toISOString(),
        to: new Date(weekStart.getTime() + 7 * 86_400_000).toISOString(),
        ...(branchFilter ? { branchId: branchFilter } : {}),
      }),
      getApiClient().listBranches(),
    ]);
    setEvents(ev.events ?? []);
    setBranches(br.branches ?? []);
  }

  useEffect(() => {
    load().catch(() => setErr("Failed to load calendar"));
  }, [branchFilter]);

  async function createEvent() {
    setBusy(true);
    setMsg("");
    setErr("");
    try {
      const startsAt = new Date(form.startsAt).toISOString();
      const endsAt = new Date(form.endsAt).toISOString();
      await getApiClient().createCalendarEvent({
        title: form.title,
        startsAt,
        endsAt,
        timezone: form.timezone,
        ...(form.branchId ? { branchId: form.branchId } : {}),
      });
      setForm({ title: "", startsAt: "", endsAt: "", timezone: "UTC", branchId: "" });
      setMsg("Event scheduled.");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create event");
    } finally {
      setBusy(false);
    }
  }

  async function cancelEvent(id: string) {
    setErr("");
    try {
      await getApiClient().cancelCalendarEvent(id);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to cancel event");
    }
  }

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const ev of events) {
      const k = dayKey(new Date(ev.startsAt));
      const list = map.get(k) ?? [];
      list.push(ev);
      map.set(k, list);
    }
    for (const [k, list] of map) {
      list.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      map.set(k, list);
    }
    return map;
  }, [events]);

  const todayKey = dayKey(new Date());

  return (
    <AppShell subtitle="A shared week view for humans and the agent.">
      <section className="card stack">
        <div className="section-head">
          <div>
            <h2>New event</h2>
            <p className="muted">Blocks appear on the shared calendar for the org (or a branch).</p>
          </div>
          <CalendarDays size={18} />
        </div>
        <div className="grid" style={{ gridTemplateColumns: "2fr 1fr 1fr 1fr auto" }}>
          <label>
            Title
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Stock count"
            />
          </label>
          <label>
            Starts
            <input
              type="datetime-local"
              value={form.startsAt}
              onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
            />
          </label>
          <label>
            Ends
            <input
              type="datetime-local"
              value={form.endsAt}
              onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
            />
          </label>
          <label>
            Branch
            <select value={form.branchId} onChange={(e) => setForm({ ...form, branchId: e.target.value })}>
              <option value="">Org-wide</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn"
            type="button"
            disabled={busy || !form.title || !form.startsAt || !form.endsAt}
            onClick={createEvent}
          >
            <Plus size={15} /> Schedule
          </button>
        </div>
        {msg ? <span className="badge accent">{msg}</span> : null}
        {err ? <span className="error">{err}</span> : null}
      </section>

      <section className="card">
        <div className="section-head">
          <div>
            <h2>This week</h2>
            <p className="muted">
              {weekStart.toDateString()} — {days[6]!.toDateString()}
            </p>
          </div>
          <label style={{ minWidth: 180 }}>
            Filter
            <select value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)}>
              <option value="">All branches</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="week-grid">
          {days.map((day) => {
            const key = dayKey(day);
            const list = eventsByDay.get(key) ?? [];
            return (
              <div key={key} className={key === todayKey ? "week-col today" : "week-col"}>
                <div className="week-col-head">
                  <span>{day.toLocaleDateString("en", { weekday: "short" })}</span>
                  <strong>{day.getDate()}</strong>
                </div>
                <div className="week-col-body">
                  {list.length === 0 ? (
                    <p className="muted small">—</p>
                  ) : (
                    list.map((ev) => (
                      <div key={ev.id} className="event-chip">
                        <div className="event-chip-title">
                          <Clock size={12} />
                          <span>{ev.title}</span>
                        </div>
                        <div className="event-chip-meta">
                          {new Date(ev.startsAt).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" })}
                          {" – "}
                          {new Date(ev.endsAt).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" })}
                          {ev.branchId ? " · branch" : ""}
                          <button
                            type="button"
                            className="icon-btn"
                            aria-label={`Cancel ${ev.title}`}
                            onClick={() => cancelEvent(ev.id)}
                          >
                            <X size={12} />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </AppShell>
  );
}