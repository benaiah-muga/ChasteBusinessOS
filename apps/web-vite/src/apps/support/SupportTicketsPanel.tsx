import { useCallback, useEffect, useState } from "react";
import { FilePlus2, Loader2 } from "lucide-react";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../ui/dialog";
import { useToast } from "../../ui/toast";
import {
  fetchSupportTickets,
  readPendingSupportTicket,
  submitSupportTicket,
  type PendingSupportTicket,
  type SupportTicket,
} from "../../api/support";
import { useSupportDesk } from "./SupportDeskContext";
import { relativeTime } from "./support-model";

const ORIGIN_LABEL: Record<string, string> = {
  request: "Request",
  bug: "Bug",
  capability_gap: "Capability gap",
};

export function SupportTicketsPanel() {
  const { actorId, organizationId } = useSupportDesk();
  const { toast } = useToast();
  const [tickets, setTickets] = useState<SupportTicket[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<PendingSupportTicket>({
    title: "",
    description: "",
    origin: "request",
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    setLoadError(null);
    try {
      setTickets(await fetchSupportTickets(organizationId));
    } catch (reason) {
      setLoadError(
        reason instanceof Error
          ? reason.message
          : "Team tickets are unavailable.",
      );
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!actorId || !organizationId) return;
    try {
      const pending = readPendingSupportTicket({ actorId, organizationId });
      if (!pending) return;
      setForm(pending);
      setOpen(true);
      setNotice(
        "An unresolved ticket filing was restored. Submit these exact details to recover its result.",
      );
    } catch {
      // The form remains available without retry recovery.
    }
  }, [actorId, organizationId]);

  async function submit() {
    if (!actorId || !organizationId) return;
    const input = {
      ...form,
      title: form.title.trim(),
      description: form.description.trim(),
    };
    if (!input.title || !input.description) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const outcome = await submitSupportTicket(input, {
        actorId,
        organizationId,
      });
      if (outcome.kind === "pending") {
        setNotice(outcome.reason);
        return;
      }
      setForm({ title: "", description: "", origin: "request" });
      setOpen(false);
      toast({
        title: "Ticket filed",
        description: "A person can pick it up from the team ticket list.",
        tone: "success",
      });
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The ticket could not be filed.",
      );
      try {
        const pending = readPendingSupportTicket({ actorId, organizationId });
        if (pending) {
          setForm(pending);
          setNotice(
            "An unresolved ticket filing was restored. Submit these exact details to recover its result.",
          );
        }
      } catch {
        // Keep the original failure visible.
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="support-overview-panel"
      aria-labelledby="support-team-tickets"
    >
      <header className="support-overview-panel-head">
        <div>
          <h2 id="support-team-tickets">Team tickets</h2>
          <p>
            Internal blockers, bugs, and capability gaps for the desk itself.
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setOpen(true);
            setError(null);
            setNotice(null);
          }}
        >
          <FilePlus2 size={13} aria-hidden="true" /> File ticket
        </Button>
      </header>
      {loading && !tickets && (
        <p className="support-panel-note" role="status">
          <Loader2 size={12} className="support-spin" aria-hidden="true" />{" "}
          Loading team tickets...
        </p>
      )}
      {loadError && (
        <div className="support-panel-error" role="alert">
          <span>{loadError}</span>
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {tickets && tickets.length === 0 && (
        <p className="support-panel-note">
          No internal tickets. File one when the desk cannot do something
          honestly.
        </p>
      )}
      {tickets && tickets.length > 0 && (
        <ul className="support-ticket-list">
          {tickets.slice(0, 4).map((ticket) => (
            <li key={ticket.id}>
              <span className="support-ticket-origin">
                {ORIGIN_LABEL[ticket.origin] ?? ticket.origin}
              </span>
              <div>
                <strong>{ticket.title}</strong>
                <p>{ticket.description}</p>
              </div>
              <span className="support-ticket-meta">
                {ticket.status.replaceAll("_", " ")} ·{" "}
                {relativeTime(ticket.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="support-dialog support-dialog-small">
          <DialogTitle>File a team ticket</DialogTitle>
          <DialogDescription>
            Use this for a bug, a capability gap, or an internal request. It
            does not message the customer.
          </DialogDescription>
          {notice && (
            <p className="support-dialog-notice" role="status">
              {notice}
            </p>
          )}
          {error && (
            <p className="support-dialog-error" role="alert">
              {error}
            </p>
          )}
          <label className="support-field">
            <span>Title</span>
            <input
              value={form.title}
              maxLength={200}
              onChange={(event) =>
                setForm({ ...form, title: event.target.value })
              }
              placeholder="Short description of the blocker"
              autoFocus
            />
          </label>
          <label className="support-field">
            <span>Details</span>
            <textarea
              value={form.description}
              rows={4}
              maxLength={8000}
              onChange={(event) =>
                setForm({ ...form, description: event.target.value })
              }
              placeholder="What happened, what you expected, and what the desk could not do."
            />
          </label>
          <label className="support-field">
            <span>Type</span>
            <select
              value={form.origin}
              onChange={(event) =>
                setForm({
                  ...form,
                  origin: event.target.value as PendingSupportTicket["origin"],
                })
              }
            >
              <option value="request">Request</option>
              <option value="bug">Bug</option>
              <option value="capability_gap">Capability gap</option>
            </select>
          </label>
          <div className="support-dialog-actions">
            <Button
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void submit()}
              disabled={
                saving || !form.title.trim() || !form.description.trim()
              }
            >
              {saving ? (
                <Loader2
                  size={13}
                  className="support-spin"
                  aria-hidden="true"
                />
              ) : (
                <FilePlus2 size={13} aria-hidden="true" />
              )}
              {saving ? "Filing..." : "File ticket"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
