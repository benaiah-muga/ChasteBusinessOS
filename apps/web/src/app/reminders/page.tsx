"use client";

import { useEffect, useState } from "react";
import { Bell, Plus } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { getApiClient } from "@/lib/api";

type Reminder = {
  id: string;
  title: string;
  body?: string | null;
  fireAt: string;
  timezone: string;
  status: string;
};

export default function RemindersPage() {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [form, setForm] = useState({ title: "", body: "", fireAt: "" });

  async function load() {
    const res = await getApiClient().listReminders();
    setReminders(res.reminders ?? []);
  }

  useEffect(() => {
    load().catch(() => setErr("Failed to load reminders"));
  }, []);

  async function createReminder() {
    setBusy(true);
    setMsg("");
    setErr("");
    try {
      await getApiClient().createReminder({
        title: form.title,
        body: form.body,
        fireAt: new Date(form.fireAt).toISOString(),
      });
      setForm({ title: "", body: "", fireAt: "" });
      setMsg("Reminder set.");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create reminder");
    } finally {
      setBusy(false);
    }
  }

  async function cancelReminder(id: string) {
    setErr("");
    try {
      await getApiClient().cancelReminder(id);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to cancel reminder");
    }
  }

  const sorted = [...reminders].sort((a, b) => a.fireAt.localeCompare(b.fireAt));
  const upcoming = sorted.filter((r) => r.status === "scheduled");
  const past = sorted.filter((r) => r.status !== "scheduled");

  return (
    <AppShell subtitle="Self-set reminders surface as emails when the time arrives.">
      <section className="card stack">
        <div className="section-head">
          <div>
            <h2>New reminder</h2>
            <p className="muted">We will email you at the chosen time. No account-level settings required.</p>
          </div>
          <Bell size={18} />
        </div>
        <div className="grid" style={{ gridTemplateColumns: "1fr 2fr 1fr auto" }}>
          <label>
            Title
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Invoice review" />
          </label>
          <label>
            Body
            <input value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="Optional note" />
          </label>
          <label>
            Fire at
            <input type="datetime-local" value={form.fireAt} onChange={(e) => setForm({ ...form, fireAt: e.target.value })} />
          </label>
          <button className="btn" type="button" disabled={busy || !form.title || !form.fireAt} onClick={createReminder}>
            <Plus size={15} /> Set
          </button>
        </div>
        {msg ? <span className="badge accent">{msg}</span> : null}
        {err ? <span className="error">{err}</span> : null}
      </section>

      <section className="card stack">
        <div className="section-head">
          <div>
            <h2>Upcoming</h2>
            <p className="muted">Still scheduled and not yet fired.</p>
          </div>
        </div>
        {upcoming.length === 0 ? (
          <div className="empty-state">
            <p>No upcoming reminders.</p>
          </div>
        ) : (
          <div className="stack">
            {upcoming.map((r) => (
              <div key={r.id} className="row between">
                <div className="stack" style={{ gap: 2 }}>
                  <strong>{r.title}</strong>
                  {r.body ? <span className="muted small">{r.body}</span> : null}
                  <span className="muted small">
                    {new Date(r.fireAt).toLocaleString()} ({r.timezone})
                  </span>
                </div>
                <button className="btn secondary" type="button" onClick={() => cancelReminder(r.id)}>
                  Cancel
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {past.length > 0 ? (
        <section className="card stack">
          <div className="section-head">
            <div>
              <h2>Fired</h2>
              <p className="muted">Past reminders.</p>
            </div>
          </div>
          <div className="stack">
            {past.map((r) => (
              <div key={r.id} className="row between">
                <div className="stack" style={{ gap: 2 }}>
                  <strong>{r.title}</strong>
                  <span className="muted small">
                    {new Date(r.fireAt).toLocaleString()} · {r.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </AppShell>
  );
}