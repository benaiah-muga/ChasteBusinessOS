"use client";

import { useCallback, useEffect, useState } from "react";
import { Mail, RotateCcw, Send } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { getApiClient } from "@/lib/api";
import type { EmailOutboxRow, EmailProviderStatus } from "@chaste/api-client";

const STATUS_PILL: Record<string, string> = {
  queued: "",
  sending: "accent",
  sent: "success",
  failed: "danger",
};

const STATUS_FILTERS = ["", "queued", "sending", "sent", "failed"] as const;

export default function EmailPage() {
  const [provider, setProvider] = useState<EmailProviderStatus | null>(null);
  const [emails, setEmails] = useState<EmailOutboxRow[]>([]);
  const [status, setStatus] = useState<string>("");
  const [err, setErr] = useState("");
  const [sending, setSending] = useState(false);
  const [test, setTest] = useState({ to: "", subject: "Test from Chaste", body: "Hello from Chaste BusinessOS." });

  const load = useCallback(async () => {
    const [statusRes, listRes] = await Promise.all([
      getApiClient().getEmailProviderStatus(),
      getApiClient().listEmailOutbox(status ? { status } : {}),
    ]);
    setProvider(statusRes);
    setEmails(listRes.emails);
  }, [status]);

  useEffect(() => {
    load().catch(() => setErr("Failed to load email outbox"));
  }, [load]);

  async function retry(id: string) {
    setErr("");
    try {
      await getApiClient().retryEmail(id);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to requeue email");
    }
  }

  async function sendTest() {
    setErr("");
    if (!test.to || !test.subject) {
      setErr("Recipient and subject are required.");
      return;
    }
    setSending(true);
    try {
      await getApiClient().sendEmail(test);
      setTest((t) => ({ ...t, body: "Hello from Chaste BusinessOS." }));
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to queue email");
    } finally {
      setSending(false);
    }
  }

  return (
    <AppShell subtitle="Outbound email queue and delivery provider.">
      <section className="card stack">
        <div className="section-head">
          <div>
            <h2>Email</h2>
            <p className="muted">Delivered through the configured provider.</p>
          </div>
          <span className={`badge ${provider ? STATUS_PILL[provider.provider] ?? "" : ""}`}>
            <Mail size={14} /> {provider ? provider.provider : "…"}
          </span>
        </div>
        {provider?.from ? <p className="muted small">From: {provider.from}</p> : null}
        {provider?.provider === "console" ? (
          <p className="muted small">
            No SMTP or Resend provider configured — deliveries are logged to the console. Set{" "}
            <code>CHASTE_RESEND_API_KEY</code> or <code>CHASTE_SMTP_HOST</code> in the API/worker environment.
          </p>
        ) : null}
      </section>

      <section className="card stack">
        <div className="section-head">
          <div>
            <h3>Send a test email</h3>
            <p className="muted">Queues via <code>core.email.send</code> — the worker delivers it.</p>
          </div>
        </div>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <span>Recipient</span>
            <input
              placeholder="recipient@example.com"
              value={test.to}
              onChange={(e) => setTest((t) => ({ ...t, to: e.target.value }))}
            />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 180 }}>
            <span>Subject</span>
            <input
              placeholder="Subject"
              value={test.subject}
              onChange={(e) => setTest((t) => ({ ...t, subject: e.target.value }))}
            />
          </div>
          <div className="field" style={{ justifyContent: "flex-end" }}>
            <button className="btn" type="button" onClick={sendTest} disabled={sending}>
              <Send size={15} /> {sending ? "Queuing…" : "Send test"}
            </button>
          </div>
        </div>
      </section>

      <section className="card stack">
        <div className="section-head">
          <div>
            <h3>Outbox</h3>
            <p className="muted">{emails.length} emails in the current filter.</p>
          </div>
          <div className="segmented">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f || "all"}
                className={status === f ? "selected" : ""}
                type="button"
                onClick={() => setStatus(f)}
              >
                {f || "All"}
              </button>
            ))}
          </div>
        </div>
        {err ? <span className="error">{err}</span> : null}
        {emails.length === 0 ? (
          <div className="empty-state">
            <Mail size={26} />
            <p>No emails in this filter yet.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>To</th>
                  <th>Subject</th>
                  <th>Template</th>
                  <th>Status</th>
                  <th>Provider</th>
                  <th>Sent</th>
                  <th>Error</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {emails.map((e) => (
                  <tr key={e.id}>
                    <td>{e.to}</td>
                    <td>{e.subject}</td>
                    <td>{e.template ?? "—"}</td>
                    <td>
                      <span className={`badge ${STATUS_PILL[e.status] ?? ""}`}>{e.status}</span>
                    </td>
                    <td className="muted small">
                      {e.provider ?? "—"}
                      {e.providerMessageId ? (
                        <span className="muted small" title={e.providerMessageId}>
                          {" "}
                          ({e.providerMessageId.slice(0, 8)}…)
                        </span>
                      ) : null}
                    </td>
                    <td className="muted small">{e.sentAt ? new Date(e.sentAt).toLocaleString() : "—"}</td>
                    <td className="muted small" title={e.error ?? undefined}>
                      {e.error ? e.error.slice(0, 40) : "—"}
                    </td>
                    <td>
                      {e.status === "failed" ? (
                        <button className="btn secondary" type="button" onClick={() => retry(e.id)}>
                          <RotateCcw size={14} /> Retry
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </AppShell>
  );
}
