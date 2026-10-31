import { useEffect, useMemo, useState } from "react";
import {
  ExternalLink,
  History,
  Loader2,
  ReceiptText,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Button } from "../../ui/button";
import { navigate } from "../../navigation";
import {
  fetchSupportOrderStatus,
  submitSupportAction,
  type SupportConversation,
  type SupportMessage,
  type SupportOrderStatus,
} from "../../api/support";
import { useSupportDesk } from "./SupportDeskContext";
import {
  CopyButton,
  PriorityBadge,
  SlaBadge,
  StatusBadge,
  SupportAvatar,
} from "./SupportBits";
import {
  customerHistory,
  formatDateTime,
  formatMinor,
  relativeTime,
  supportActivity,
} from "./support-model";

type TicketForm = {
  priority: "low" | "normal" | "high" | "urgent";
  category: string;
  slaDueAt: string;
};

function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formFrom(conversation: SupportConversation): TicketForm {
  const priority = conversation.priority;
  return {
    priority:
      priority === "low" || priority === "high" || priority === "urgent"
        ? priority
        : "normal",
    category: conversation.category ?? "",
    slaDueAt: toLocalInput(conversation.slaDueAt),
  };
}

function sameForm(left: TicketForm, right: TicketForm): boolean {
  return (
    left.priority === right.priority &&
    left.category.trim() === right.category.trim() &&
    left.slaDueAt === right.slaDueAt
  );
}

export function SupportContextPanel({
  conversation,
  messages,
}: {
  conversation: SupportConversation;
  messages: SupportMessage[];
}) {
  const desk = useSupportDesk();
  const [form, setForm] = useState<TicketForm>(() => formFrom(conversation));
  const [baseline, setBaseline] = useState<TicketForm>(() =>
    formFrom(conversation),
  );
  const [ticketError, setTicketError] = useState<string | null>(null);
  const [ticketSaved, setTicketSaved] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [billing, setBilling] = useState<{
    status: "loading" | "ready" | "failed";
    data?: SupportOrderStatus;
    message?: string;
  }>({ status: "loading" });
  const history = useMemo(
    () =>
      customerHistory(
        desk.conversations,
        conversation.customerId,
        conversation.id,
      ),
    [conversation.customerId, conversation.id, desk.conversations],
  );
  const activity = useMemo(() => supportActivity(messages), [messages]);
  const dirty = !sameForm(form, baseline);
  const assignedName = conversation.assignedUserName ?? null;
  const outstandingCurrency = desk.baseCurrency ?? "";

  useEffect(() => {
    const controller = new AbortController();
    setBilling({ status: "loading" });
    void fetchSupportOrderStatus(
      conversation.id,
      desk.organizationId,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) setBilling({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setBilling({
            status: "failed",
            message:
              error instanceof Error
                ? error.message
                : "Billing context is unavailable.",
          });
        }
      });
    return () => controller.abort();
  }, [conversation.id, desk.organizationId]);

  async function saveTicket() {
    setTicketError(null);
    setTicketSaved(false);
    const saved: TicketForm = {
      priority: form.priority,
      category: form.category.trim(),
      slaDueAt: form.slaDueAt,
    };
    const ok = await desk.updateTicket({
      priority: saved.priority,
      category: saved.category || null,
      slaDueAt: saved.slaDueAt ? new Date(saved.slaDueAt).toISOString() : null,
    });
    if (!ok) {
      setTicketError(
        desk.actionError ?? "The ticket fields could not be saved.",
      );
      return;
    }
    setBaseline(saved);
    setForm(saved);
    setTicketSaved(true);
  }

  async function suggestCategory() {
    const text =
      [...messages]
        .reverse()
        .find((message) => message.senderType === "customer")?.body ??
      conversation.subject;
    if (!text || !desk.organizationId) return;
    setSuggesting(true);
    setTicketError(null);
    try {
      const outcome = await submitSupportAction(
        { action: "suggestCategory", text },
        undefined,
        undefined,
        desk.organizationId,
      );
      if (outcome.kind === "pending") {
        setTicketError(outcome.reason);
        return;
      }
      setForm((current) => ({ ...current, category: outcome.data.category }));
    } catch (error) {
      setTicketError(
        error instanceof Error ? error.message : "Category suggestion failed.",
      );
    } finally {
      setSuggesting(false);
    }
  }

  async function assignToMe() {
    if (!desk.actorId) return;
    await desk.updateTicket({ assigneeUserId: desk.actorId });
  }

  async function unassign() {
    await desk.updateTicket({ assigneeUserId: null });
  }

  return (
    <div className="support-context">
      <div className="support-context-scroll">
        <section
          className="support-context-section"
          aria-labelledby="support-context-customer"
        >
          <p className="support-eyebrow" id="support-context-customer">
            Customer
          </p>
          <div className="support-customer-card">
            <SupportAvatar name={conversation.customerName} size="lg" />
            <div>
              <strong>{conversation.customerName}</strong>
              {conversation.customerEmail ? (
                <span>{conversation.customerEmail}</span>
              ) : (
                <span>No email on record</span>
              )}
            </div>
            {conversation.customerEmail && (
              <CopyButton
                value={conversation.customerEmail}
                label="Copy email"
              />
            )}
          </div>
          <p className="support-context-note">
            {history.length === 0
              ? "No earlier conversations with this customer."
              : `${history.length} earlier ${history.length === 1 ? "conversation" : "conversations"} on record.`}
          </p>
        </section>

        <section
          className="support-context-section"
          aria-labelledby="support-context-ticket"
        >
          <div className="support-context-heading">
            <p className="support-eyebrow" id="support-context-ticket">
              Ticket
            </p>
            <span>
              {conversation.ticketNumber
                ? `#${conversation.ticketNumber}`
                : "No number"}
            </span>
          </div>
          <div className="support-ticket-subject">
            <span>Subject</span>
            <strong>{conversation.subject}</strong>
          </div>
          <div className="support-ticket-facts">
            <div>
              <span>Status</span>
              <StatusBadge status={conversation.status} />
            </div>
            <div>
              <span>Priority</span>
              <PriorityBadge priority={conversation.priority} />
            </div>
            <div>
              <span>SLA</span>
              <SlaBadge
                dueAt={conversation.slaDueAt}
                status={conversation.status}
              />
            </div>
            <div>
              <span>Assigned</span>
              <strong>{assignedName ?? "Unassigned"}</strong>
            </div>
          </div>
          <div className="support-ticket-form">
            <label className="support-field">
              <span>Priority</span>
              <select
                value={form.priority}
                onChange={(event) => {
                  setTicketSaved(false);
                  setForm({
                    ...form,
                    priority: event.target.value as TicketForm["priority"],
                  });
                }}
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </label>
            <label className="support-field">
              <span>Category</span>
              <div className="support-inline-control">
                <input
                  value={form.category}
                  maxLength={40}
                  placeholder="billing, shipping, api..."
                  onChange={(event) => {
                    setTicketSaved(false);
                    setForm({ ...form, category: event.target.value });
                  }}
                />
                <button
                  type="button"
                  onClick={() => void suggestCategory()}
                  disabled={suggesting || desk.busy !== null}
                  title="Rule-based suggestion from the thread"
                >
                  {suggesting ? (
                    <Loader2
                      size={12}
                      className="support-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Sparkles size={12} aria-hidden="true" />
                  )}
                  Suggest
                </button>
              </div>
            </label>
            <label className="support-field">
              <span>SLA due</span>
              <input
                type="datetime-local"
                value={form.slaDueAt}
                onChange={(event) => {
                  setTicketSaved(false);
                  setForm({ ...form, slaDueAt: event.target.value });
                }}
              />
            </label>
            {ticketError && (
              <p className="support-field-error" role="alert">
                {ticketError}
              </p>
            )}
            {ticketSaved && !dirty && (
              <p className="support-field-saved" role="status">
                Ticket fields saved.
              </p>
            )}
            <div className="support-ticket-form-actions">
              <Button
                size="sm"
                onClick={() => void saveTicket()}
                disabled={!dirty || desk.busy !== null}
              >
                {desk.busy === "ticket" ? (
                  <Loader2
                    size={12}
                    className="support-spin"
                    aria-hidden="true"
                  />
                ) : null}
                {desk.busy === "ticket" ? "Saving..." : "Save ticket"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setForm(baseline);
                  setTicketError(null);
                  setTicketSaved(false);
                }}
                disabled={!dirty || desk.busy !== null}
              >
                Reset
              </Button>
            </div>
            <div className="support-ticket-assign">
              {conversation.assignedUserId === desk.actorId ? (
                <button
                  type="button"
                  className="support-text-button"
                  onClick={() => void unassign()}
                  disabled={desk.busy !== null}
                >
                  Unassign me
                </button>
              ) : (
                <button
                  type="button"
                  className="support-text-button"
                  onClick={() => void assignToMe()}
                  disabled={desk.busy !== null || !desk.actorId}
                >
                  Assign to me
                </button>
              )}
              <span>Use Assign in the thread to choose a teammate.</span>
            </div>
          </div>
        </section>

        <section
          className="support-context-section"
          aria-labelledby="support-context-billing"
        >
          <div className="support-context-heading">
            <p className="support-eyebrow" id="support-context-billing">
              Billing context
            </p>
            <ReceiptText size={13} aria-hidden="true" />
          </div>
          {billing.status === "loading" && (
            <p className="support-context-note" role="status">
              <Loader2 size={12} className="support-spin" aria-hidden="true" />{" "}
              Reading this customer's invoices...
            </p>
          )}
          {billing.status === "failed" && (
            <p className="support-context-note support-context-note-danger">
              {billing.message ?? "Billing context is unavailable."}
            </p>
          )}
          {billing.status === "ready" &&
            billing.data &&
            billing.data.invoices.length === 0 && (
              <p className="support-context-note">
                No invoices on record for this customer.
              </p>
            )}
          {billing.status === "ready" &&
            billing.data &&
            billing.data.invoices.length > 0 && (
              <>
                <div className="support-billing-total">
                  <span>Outstanding</span>
                  <strong>
                    {formatMinor(
                      billing.data.totalOutstandingMinor,
                      outstandingCurrency,
                    )}
                  </strong>
                  <small>
                    {outstandingCurrency
                      ? `in ${outstandingCurrency}`
                      : "in the workspace currency"}
                  </small>
                </div>
                <ul className="support-billing-list">
                  {billing.data.invoices.slice(0, 3).map((invoice) => (
                    <li key={invoice.number}>
                      <span>#{invoice.number}</span>
                      <span
                        className={`support-invoice-status support-invoice-status-${invoice.status}`}
                      >
                        {invoice.status}
                      </span>
                      <strong>
                        {formatMinor(
                          invoice.outstandingMinor,
                          outstandingCurrency,
                        )}
                      </strong>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="support-text-button"
                  onClick={() => navigate("/accounting/invoices")}
                >
                  Open invoices <ExternalLink size={11} aria-hidden="true" />
                </button>
              </>
            )}
        </section>

        <section
          className="support-context-section"
          aria-labelledby="support-context-history"
        >
          <div className="support-context-heading">
            <p className="support-eyebrow" id="support-context-history">
              History
            </p>
            <History size={13} aria-hidden="true" />
          </div>
          {history.length === 0 ? (
            <p className="support-context-note">No earlier conversations.</p>
          ) : (
            <div className="support-history-list">
              {history.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => desk.selectConversation(item.id)}
                  className="support-history-row"
                >
                  <span
                    className={`support-history-dot support-history-dot-${item.status}`}
                    aria-hidden="true"
                  />
                  <span className="support-history-copy">
                    <strong>{item.subject}</strong>
                    <small>
                      {item.status === "escalated"
                        ? "Awaiting human"
                        : item.status}{" "}
                      · {relativeTime(item.lastMessageAt)}
                    </small>
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section
          className="support-context-section"
          aria-labelledby="support-context-record"
        >
          <p className="support-eyebrow" id="support-context-record">
            Conversation
          </p>
          <dl className="support-record-list">
            <div>
              <dt>Opened</dt>
              <dd>{formatDateTime(conversation.createdAt)}</dd>
            </div>
            <div>
              <dt>Channel</dt>
              <dd>
                {conversation.channel === "widget" ? "Website widget" : "Desk"}
              </dd>
            </div>
            <div>
              <dt>Assigned</dt>
              <dd>{assignedName ?? "Unassigned"}</dd>
            </div>
            <div>
              <dt>Ticket</dt>
              <dd>
                {conversation.ticketNumber
                  ? `#${conversation.ticketNumber}`
                  : "No number"}
              </dd>
            </div>
            <div>
              <dt>Conversation ID</dt>
              <dd>
                <CopyButton
                  value={conversation.id}
                  label="Copy ID"
                  className="support-copy-compact"
                />
              </dd>
            </div>
          </dl>
        </section>

        <section
          className="support-context-section"
          aria-labelledby="support-context-activity"
        >
          <div className="support-context-heading">
            <p className="support-eyebrow" id="support-context-activity">
              Activity
            </p>
            <span>{activity.length}</span>
          </div>
          {activity.length === 0 ? (
            <p className="support-context-note">
              No system or agent activity yet.
            </p>
          ) : (
            <ul className="support-activity-list">
              {activity.map((event) => (
                <li key={event.id}>
                  <span
                    className={`support-activity-dot support-activity-dot-${event.senderType}`}
                    aria-hidden="true"
                  />
                  <span>{event.body}</span>
                  <time dateTime={event.createdAt}>
                    {relativeTime(event.createdAt)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <footer className="support-context-foot">
        <span>
          <ShieldCheck size={11} aria-hidden="true" /> Organization scoped ·
          evidence preserved
        </span>
        <button type="button" onClick={() => navigate("/ledger")}>
          Audit ledger
        </button>
      </footer>
    </div>
  );
}
