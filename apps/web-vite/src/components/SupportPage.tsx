import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./SupportPage.css";
import {
  type SupportChannels,
  type SupportConversation,
  type SupportCustomerOption,
  type SupportLibrary,
  type SupportMessage,
  type SupportTeamMember,
  type SupportWriteAction,
  createSupportCustomer,
  fetchSupportChannels,
  fetchSupportConversations,
  fetchSupportCustomerOptions,
  fetchSupportDraft,
  fetchSupportEnabled,
  fetchSupportLibrary,
  fetchSupportTeamMembers,
  fetchSupportThread,
  submitSupportAction,
  updateSupportChannels,
} from "../api/support";
import "./SupportPage.css";

type Tab = "overview" | "inbox" | "widget" | "library";
type InboxFilter = "all" | "open" | "escalated" | "resolved";
type Notice = { tone: "success" | "pending" | "error"; text: string };
type LoadState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "disabled" }
  | { status: "ready"; conversations: SupportConversation[] };
type TicketDraft = { priority: string; category: string; assigneeUserId: string; slaDueAt: string };

const SENDER_LABEL: Record<string, string> = {
  customer: "Customer",
  staff: "Staff",
  agent: "AI (released)",
  system: "System",
};

const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

const PRIORITY_LABELS: Record<(typeof PRIORITIES)[number], string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};
const FILTERS = ["all", "open", "escalated", "resolved"] as const;

function friendlyError(error: unknown): string {
  return error instanceof Error ? error.message : "The support service is unavailable. Try again.";
}

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function ticketFrom(conversation: SupportConversation): TicketDraft {
  return {
    priority: conversation.priority ?? "normal",
    category: conversation.category ?? "",
    assigneeUserId: conversation.assignedUserId ?? "",
    slaDueAt: conversation.slaDueAt ? conversation.slaDueAt.slice(0, 16) : "",
  };
}

export function SupportPage() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [tab, setTab] = useState<Tab>("overview");
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>("all");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<SupportConversation | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [composer, setComposer] = useState("");
  const [fromCustomer, setFromCustomer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [escalateOpen, setEscalateOpen] = useState(false);
  const [escalateReason, setEscalateReason] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [newSubject, setNewSubject] = useState("");
  const [customerOptions, setCustomerOptions] = useState<SupportCustomerOption[]>([]);
  const [newCustomerId, setNewCustomerId] = useState("");
  const [quickCustomer, setQuickCustomer] = useState({ open: false, name: "", email: "" });
  const quickCustomerIntent = useRef({ signature: "", id: crypto.randomUUID() });
  const [showTicket, setShowTicket] = useState(false);
  const [members, setMembers] = useState<SupportTeamMember[]>([]);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [ticket, setTicket] = useState<TicketDraft>({ priority: "normal", category: "", assigneeUserId: "", slaDueAt: "" });
  const [ticketSaved, setTicketSaved] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const enabled = await fetchSupportEnabled(signal);
      if (signal?.aborted) return;
      if (!enabled) {
        setState({ status: "disabled" });
        return;
      }
      const conversations = await fetchSupportConversations(signal);
      if (signal?.aborted) return;
      setState({ status: "ready", conversations });
      setActiveId((current) => current ?? conversations[0]?.id ?? null);
    } catch (error) {
      if (!signal?.aborted) setState({ status: "failed", message: friendlyError(error) });
    }
  }, []);

  /** Post-mutation refresh: a failed read must not tear down a working desk. */
  const refresh = useCallback(async () => {
    try {
      const conversations = await fetchSupportConversations();
      setState((current) => (current.status === "ready" ? { status: "ready", conversations } : current));
    } catch (error) {
      setNotice({ tone: "error", text: friendlyError(error) });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (state.status !== "ready" || tab !== "inbox" || members.length > 0 || membersError) return;
    const controller = new AbortController();
    void fetchSupportTeamMembers(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setMembers(result);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setMembersError(friendlyError(reason));
      });
    return () => controller.abort();
  }, [state.status, tab, members.length, membersError]);

  useEffect(() => {
    setEscalateOpen(false);
    setEscalateReason("");
    setTicketSaved(false);
    if (!activeId) {
      setConversation(null);
      setMessages([]);
      return;
    }
    const controller = new AbortController();
    setThreadError(null);
    void fetchSupportThread(activeId, controller.signal)
      .then((thread) => {
        if (controller.signal.aborted) return;
        setConversation(thread.conversation);
        setMessages(thread.messages);
        setTicket(ticketFrom(thread.conversation));
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setThreadError(friendlyError(reason));
      });
    return () => controller.abort();
  }, [activeId]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const node = threadRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, draft]);

  const conversations = state.status === "ready" ? state.conversations : [];
  const openCount = conversations.filter((item) => item.status === "open").length;
  const escalatedCount = conversations.filter((item) => item.status === "escalated").length;
  const resolvedCount = conversations.filter((item) => item.status === "resolved").length;
  const visibleConversations = conversations.filter((item) => inboxFilter === "all" || item.status === inboxFilter);
  const latestActivity = useMemo(
    () => [...conversations].sort((left, right) => (right.lastMessageAt ?? "").localeCompare(left.lastMessageAt ?? "")).slice(0, 5),
    [conversations],
  );

  function openInbox(filter: InboxFilter) {
    setTab("inbox");
    setInboxFilter(filter);
    setDraft(null);
    const next = filter === "all" ? conversations[0] : conversations.find((item) => item.status === filter);
    setActiveId(next?.id ?? null);
  }

  const refreshThread = useCallback(async (id: string) => {
    try {
      const thread = await fetchSupportThread(id);
      setConversation(thread.conversation);
      setMessages(thread.messages);
      setTicket(ticketFrom(thread.conversation));
    } catch (error) {
      setThreadError(friendlyError(error));
    }
  }, []);

  /**
   * Every governed write funnels through here so an approval-pending answer
   * stays a pending notice instead of being reported as a failure or a save.
   */
  const run = useCallback(
    async (action: SupportWriteAction, intentId?: string): Promise<Record<string, unknown> | null> => {
      setBusy(true);
      setNotice(null);
      try {
        const outcome = await submitSupportAction(action, intentId);
        if (outcome.kind === "pending") {
          setNotice({ tone: "pending", text: outcome.reason });
          return null;
        }
        setNotice({ tone: "success", text: "Support changes saved." });
        if (activeId) await refreshThread(activeId);
        await refresh();
        return outcome.data as Record<string, unknown>;
      } catch (error) {
        setNotice({ tone: "error", text: friendlyError(error) });
        return null;
      } finally {
        setBusy(false);
      }
    },
    [activeId, refresh, refreshThread],
  );

  async function postMessage() {
    if (!activeId || !composer.trim()) return;
    const accepted = await run({
      action: "message",
      conversationId: activeId,
      body: composer.trim(),
      from: fromCustomer ? "customer" : "staff",
    });
    if (accepted) setComposer("");
  }

  async function makeDraft() {
    if (!activeId) return;
    setDrafting(true);
    setDraft(null);
    setNotice(null);
    try {
      setDraft((await fetchSupportDraft(activeId)).draft);
    } catch (error) {
      setNotice({ tone: "error", text: friendlyError(error) });
    } finally {
      setDrafting(false);
    }
  }

  async function sendDraft() {
    if (!activeId || !draft?.trim()) return;
    const accepted = await run({ action: "send", conversationId: activeId, body: draft.trim() });
    if (accepted) setDraft(null);
  }

  async function transition(action: "escalate" | "resolve" | "reopen") {
    if (!activeId) return;
    const reason = escalateReason.trim();
    if (action === "escalate" && reason.length < 3) return;
    const accepted = await run(
      action === "escalate" ? { action, conversationId: activeId, reason } : { action, conversationId: activeId },
    );
    if (accepted && action === "escalate") {
      setEscalateOpen(false);
      setEscalateReason("");
    }
  }

  async function saveTicket() {
    if (!activeId) return;
    const accepted = await run({
      action: "updateTicket",
      conversationId: activeId,
      priority: PRIORITIES.includes(ticket.priority as (typeof PRIORITIES)[number]) ? (ticket.priority as (typeof PRIORITIES)[number]) : "normal",
      ...(ticket.category.trim() ? { category: ticket.category.trim() } : {}),
      ...(ticket.assigneeUserId ? { assigneeUserId: ticket.assigneeUserId } : {}),
      ...(ticket.slaDueAt ? { slaDueAt: new Date(ticket.slaDueAt).toISOString() } : {}),
    });
    if (accepted) setTicketSaved(true);
  }

  async function suggestCategory() {
    const lastCustomer = [...messages].reverse().find((message) => message.senderType === "customer");
    const text = lastCustomer?.body ?? conversation?.subject ?? "";
    if (!text) return;
    setBusy(true);
    setNotice(null);
    try {
      const outcome = await submitSupportAction({ action: "suggestCategory", text });
      if (outcome.kind === "pending") {
        setNotice({ tone: "pending", text: outcome.reason });
        return;
      }
      setTicket((current) => ({ ...current, category: outcome.data.category }));
    } catch (error) {
      setNotice({ tone: "error", text: friendlyError(error) });
    } finally {
      setBusy(false);
    }
  }

  async function openNewConversation() {
    setNewOpen(true);
    setNewSubject("");
    setNotice(null);
    try {
      const options = await fetchSupportCustomerOptions();
      setCustomerOptions(options);
      setNewCustomerId(options[0]?.id ?? "");
    } catch (error) {
      setNotice({ tone: "error", text: friendlyError(error) });
    }
  }

  async function createCustomerHere() {
    const name = quickCustomer.name.trim();
    if (!name) return;
    const email = quickCustomer.email.trim();
    const signature = JSON.stringify([name, email]);
    if (quickCustomerIntent.current.signature !== signature) {
      quickCustomerIntent.current = { signature, id: crypto.randomUUID() };
    }
    setBusy(true);
    setNotice(null);
    try {
      const outcome = await createSupportCustomer({ name, ...(email ? { email } : {}) }, quickCustomerIntent.current.id);
      if (outcome.kind === "pending") {
        setNotice({ tone: "pending", text: outcome.reason });
        return;
      }
      const created: SupportCustomerOption = { id: outcome.data.customerId, name, email: email || null };
      setCustomerOptions((options) => [...options, created]);
      setNewCustomerId(created.id);
      setQuickCustomer({ open: false, name: "", email: "" });
      quickCustomerIntent.current = { signature: "", id: crypto.randomUUID() };
      if (outcome.data.duplicateWarning) setNotice({ tone: "success", text: `Customer created. ${outcome.data.duplicateWarning}` });
    } catch (error) {
      setNotice({ tone: "error", text: friendlyError(error) });
    } finally {
      setBusy(false);
    }
  }

  async function createConversation() {
    if (!newCustomerId || !newSubject.trim()) return;
    const created = await run({ action: "create", customerId: newCustomerId, subject: newSubject.trim() });
    if (!created) return;
    setNewOpen(false);
    const conversationId = created.conversationId;
    if (typeof conversationId === "string") setActiveId(conversationId);
  }

  const tabButton = (id: Tab, label: string, count?: number) => (
    <button type="button" className={`support-tab${tab === id ? " is-active" : ""}`} aria-pressed={tab === id} onClick={() => setTab(id)}>
      {label}{count !== undefined && <span>{count}</span>}
    </button>
  );

  const filterCount = (filter: InboxFilter) => (filter === "all" ? conversations.length : conversations.filter((item) => item.status === filter).length);
  const filterLabel = (filter: InboxFilter) => (filter[0]!.toUpperCase() + filter.slice(1));

  return (
    <main className="support-page">
      <SupportStyles />
      {state.status === "loading" && <p role="status">Checking customer care and loading the inbox…</p>}
      {state.status === "failed" && (
        <section role="alert">
          <p>{state.message}</p>
          <button className="shell-button" type="button" onClick={() => void load()}>Try again</button>
        </section>
      )}
      {state.status === "disabled" && <p>Customer care is switched off for this organization. An org admin can enable it in Settings under Modules.</p>}
      {state.status === "ready" && (
        <>
          <SupportHeader />
          {notice && (
            <div className={`support-notice support-notice-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
              <span>{notice.text}</span>
              <button type="button" aria-label="Dismiss notice" onClick={() => setNotice(null)}>×</button>
            </div>
          )}
          <nav className="support-tabs" aria-label="Customer care sections">
            {tabButton("overview", "Overview")}
            {tabButton("inbox", "Inbox", openCount + escalatedCount)}
            {tabButton("widget", "Website widget")}
            {tabButton("library", "Library")}
          </nav>

          {tab === "overview" && (
            <section aria-label="Customer care overview">
              <div className="support-kpis">
                <button type="button" onClick={() => openInbox("open")}>
                  <span>Open inquiries</span><strong>{openCount}</strong>
                  <small>{openCount > 0 ? "Open inquiries awaiting a reply" : "Nothing waiting"}</small>
                </button>
                <button type="button" onClick={() => openInbox("escalated")}>
                  <span>Escalated</span><strong>{escalatedCount}</strong>
                  <small>Review escalated conversations</small>
                </button>
                <button type="button" onClick={() => openInbox("resolved")}>
                  <span>Resolved</span><strong>{resolvedCount}</strong>
                  <small>Review resolved conversations</small>
                </button>
                <button type="button" onClick={() => openInbox("all")}>
                  <span>Conversations</span><strong>{conversations.length}</strong>
                  <small>Open all conversations</small>
                </button>
              </div>
              <div className="support-overview-grid">
                <section className="support-panel">
                  <header><h2>Latest activity</h2></header>
                  {latestActivity.length === 0 ? (
                    <p className="support-muted">No conversations yet. Open one per customer inquiry so every answer stays on the record.</p>
                  ) : (
                    <ul className="support-rows">
                      {latestActivity.map((item) => (
                        <li key={item.id}>
                          <span className="support-row-copy">
                            <strong>{item.subject}</strong>
                            <small>{item.customerName} · {item.lastMessageAt ? timeAgo(item.lastMessageAt) : "no messages"}</small>
                          </span>
                          <span className={`support-badge support-badge-${item.status}`}>{item.status}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <section className="support-panel">
                  <header><h2>How care works here</h2></header>
                  <ul className="support-principles">
                    <li>The workmate drafts replies from the customer's own order history, nothing else.</li>
                    <li>A human sends every draft; the model never talks to customers directly.</li>
                    <li>The website widget routes visitors into the same governed inbox.</li>
                  </ul>
                  <div className="support-actions">
                    <button className="shell-button" type="button" onClick={() => openInbox("all")}>Open inbox</button>
                    <button className="shell-button shell-button-secondary" type="button" onClick={() => setTab("widget")}>Website widget</button>
                  </div>
                </section>
              </div>
            </section>
          )}

          {tab === "widget" && <SupportWidgetPanel onNotice={setNotice} />}

          {tab === "library" && <SupportLibraryPanel onNotice={setNotice} />}

          {tab === "inbox" && (
            <section className="support-inbox" aria-label="Support inbox">
              <aside className="support-panel support-inbox-list">
                <div role="group" aria-label="Filter conversations" className="support-filters">
                  {FILTERS.map((filter) => (
                    <button key={filter} type="button" aria-pressed={inboxFilter === filter} onClick={() => openInbox(filter)}>
                      {filterLabel(filter)} {filterCount(filter)}
                    </button>
                  ))}
                </div>
                {visibleConversations.length === 0 ? (
                  <div>
                    <p className="support-muted">
                      {conversations.length === 0
                        ? "No conversations yet. Open one per customer inquiry so every answer stays on the record."
                        : `No ${inboxFilter} conversations.`}
                    </p>
                    {conversations.length > 0 && inboxFilter !== "all" && (
                      <button className="shell-button shell-button-secondary" type="button" onClick={() => openInbox("all")}>Show all conversations</button>
                    )}
                  </div>
                ) : (
                  <ul>
                    {visibleConversations.map((item) => (
                      <li key={item.id}>
                        <button type="button" aria-current={activeId === item.id ? "true" : undefined} onClick={() => { setActiveId(item.id); setDraft(null); }}>
                          <span className="support-inbox-row">
                            <span className="support-inbox-customer">{item.customerName}</span>
                            <span className={`support-badge support-badge-${item.status}`}>{item.status}</span>
                          </span>
                          <span className="support-inbox-line">{item.subject}</span>
                          <span className="support-inbox-line support-inbox-preview">{item.lastMessagePreview || " "}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="support-inbox-actions">
                  <button className="shell-button" type="button" onClick={() => void openNewConversation()}>New conversation</button>
                </div>
              </aside>

              <section className="support-panel support-thread">
                {!conversation ? (
                  <p className="support-muted">Pick a conversation</p>
                ) : (
                  <>
                    <header className="support-thread-header">
                      <div>
                        <h2>{conversation.customerName}</h2>
                        <p>{conversation.subject}</p>
                        <span className={`support-badge support-badge-${conversation.status}`}>{conversation.status}</span>
                      </div>
                      <div className="support-actions">
                        <button type="button" disabled={drafting || conversation.status === "resolved"} onClick={() => void makeDraft()} title="AI drafts; you decide">
                          {drafting ? "Drafting…" : "Draft reply"}
                        </button>
                        <button type="button" aria-pressed={showTicket} onClick={() => setShowTicket((open) => !open)} title="Priority, category, assignee, SLA">Ticket</button>
                        <button type="button" disabled={busy || conversation.status !== "open"} onClick={() => setEscalateOpen(true)}>Escalate</button>
                        <button type="button" disabled={busy || conversation.status === "resolved"} onClick={() => void transition("resolve")}>Resolve</button>
                        {conversation.status !== "open" && <button type="button" disabled={busy} onClick={() => void transition("reopen")}>Reopen</button>}
                      </div>
                    </header>

                    {escalateOpen && conversation.status === "open" && (
                      <form
                        className="support-escalate"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void transition("escalate");
                        }}
                      >
                        <label htmlFor="support-escalate-reason">Why does this need a human owner?</label>
                        <div className="support-actions">
                          <input
                            id="support-escalate-reason"
                            value={escalateReason}
                            onChange={(event) => setEscalateReason(event.target.value)}
                            placeholder="Customer asked for a refund above policy"
                          />
                          <button type="submit" disabled={busy || escalateReason.trim().length < 3}>Confirm escalation</button>
                          <button type="button" onClick={() => setEscalateOpen(false)}>Cancel</button>
                        </div>
                      </form>
                    )}

                    {showTicket && (
                      <div className="support-ticket">
                        {membersError && <p role="alert">{membersError}</p>}
                        <div className="support-ticket-grid">
                          <label>Priority
                            <select value={ticket.priority} onChange={(event) => setTicket({ ...ticket, priority: event.target.value as typeof ticket.priority })}>
                              {PRIORITIES.map((priority) => <option key={priority} value={priority}>{PRIORITY_LABELS[priority]}</option>)}
                            </select>
                          </label>
                          <label>Category
                            <span className="support-inline-field">
                              <input value={ticket.category} onChange={(event) => setTicket({ ...ticket, category: event.target.value })} placeholder="e.g. billing" />
                              <button type="button" disabled={busy} onClick={() => void suggestCategory()} title="Rule-based suggestion from the thread">Suggest</button>
                            </span>
                          </label>
                          <label>Assignee
                            <select value={ticket.assigneeUserId} onChange={(event) => setTicket({ ...ticket, assigneeUserId: event.target.value })}>
                              <option value="">Unassigned</option>
                              {members.map((member) => <option key={member.userId} value={member.userId}>{member.name ?? member.email}</option>)}
                            </select>
                          </label>
                          <label>SLA due
                            <input type="datetime-local" value={ticket.slaDueAt} onChange={(event) => setTicket({ ...ticket, slaDueAt: event.target.value })} />
                          </label>
                          <div className="support-actions">
                            <button type="button" disabled={busy} onClick={() => void saveTicket()}>Save</button>
                            {ticketSaved && <small className="support-saved">saved</small>}
                          </div>
                        </div>
                      </div>
                    )}

                    {threadError && <p className="support-error" role="alert">{threadError}</p>}

                    <div className="support-messages" ref={threadRef}>
                      {messages.map((message) => (
                        <div key={message.id} className={`support-message support-message-${message.senderType === "customer" ? "in" : "out"}`}>
                          <div className="support-message-inner">
                            <p className="support-message-meta">
                              <span>{SENDER_LABEL[message.senderType] ?? message.senderType}</span>
                              <time dateTime={message.createdAt}>{timeAgo(message.createdAt)}</time>
                            </p>
                            <div className={`support-bubble support-bubble-${message.senderType}`}>{message.body}</div>
                          </div>
                        </div>
                      ))}
                      {draft != null && (
                        <div className="support-message support-message-out">
                          <div className="support-draft">
                            <p className="support-draft-label">AI draft, review before sending</p>
                            <textarea
                              aria-label="AI draft reply"
                              value={draft}
                              onChange={(event) => setDraft(event.target.value)}
                              rows={Math.min(8, Math.ceil(draft.length / 60) + 1)}
                            />
                            <div className="support-actions">
                              <button type="button" onClick={() => setDraft(null)}>Discard</button>
                              <button className="shell-button" type="button" disabled={busy} onClick={() => void sendDraft()}>Send to customer</button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>

                    <footer className="support-composer">
                      <label className="support-check">
                        <input type="checkbox" checked={fromCustomer} onChange={(event) => setFromCustomer(event.target.checked)} />
                        Log as customer's words
                      </label>
                      <textarea
                        aria-label="Reply or logged message"
                        value={composer}
                        onChange={(event) => setComposer(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            void postMessage();
                          }
                        }}
                        rows={2}
                        placeholder="Log what the customer wrote, or write the staff reply…"
                      />
                      <button className="shell-button" type="button" onClick={() => void postMessage()} disabled={busy || !composer.trim()}>Send</button>
                    </footer>
                  </>
                )}
              </section>
            </section>
          )}

          {newOpen && (
            <div className="support-modal-backdrop">
              <section className="support-modal" role="dialog" aria-modal="true" aria-labelledby="support-new-title">
                <header>
                  <h2 id="support-new-title">New support conversation</h2>
                  <button type="button" aria-label="Close new conversation" onClick={() => setNewOpen(false)}>×</button>
                </header>
                <label htmlFor="support-customer">Customer</label>
                <select id="support-customer" value={newCustomerId} onChange={(event) => setNewCustomerId(event.target.value)}>
                  {customerOptions.length === 0 && <option value="">No customers yet</option>}
                  {customerOptions.map((option) => <option key={option.id} value={option.id}>{option.name}{option.email ? ` (${option.email})` : ""}</option>)}
                </select>
                {!quickCustomer.open ? (
                  <button className="support-link" type="button" onClick={() => setQuickCustomer({ open: true, name: "", email: "" })}>+ New customer</button>
                ) : (
                  <div className="support-quick-customer">
                    <input aria-label="New customer name" placeholder="Customer name" value={quickCustomer.name} onChange={(event) => setQuickCustomer({ ...quickCustomer, name: event.target.value })} />
                    <input aria-label="New customer email" placeholder="Email (optional)" value={quickCustomer.email} onChange={(event) => setQuickCustomer({ ...quickCustomer, email: event.target.value })} />
                    <button type="button" disabled={busy || !quickCustomer.name.trim()} onClick={() => void createCustomerHere()}>Save and use</button>
                  </div>
                )}
                <label htmlFor="support-subject">What is this about?</label>
                <input id="support-subject" value={newSubject} onChange={(event) => setNewSubject(event.target.value)} placeholder="Invoice question, refund request…" maxLength={200} />
                <footer className="support-actions">
                  <button type="button" onClick={() => setNewOpen(false)}>Cancel</button>
                  <button className="shell-button" type="button" disabled={busy || !newCustomerId || !newSubject.trim()} onClick={() => void createConversation()}>Open conversation</button>
                </footer>
              </section>
            </div>
          )}
        </>
      )}
    </main>
  );
}

function SupportHeader() {
  return (
    <header className="support-header">
      <p className="shell-kicker">Customer care</p>
      <h1>Support</h1>
      <p>Answer inbound inquiries with AI-drafted replies. Drafts never reach the customer until a human sends them.</p>
    </header>
  );
}

function SupportWidgetPanel({ onNotice }: { onNotice: (notice: Notice) => void }) {
  const [channels, setChannels] = useState<SupportChannels | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [greeting, setGreeting] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetchSupportChannels(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setChannels(result);
        setGreeting(result.greeting);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setLoadError(friendlyError(reason));
      });
    return () => controller.abort();
  }, []);

  async function patch(update: { autoReplyEnabled?: boolean; greeting?: string; regenerateToken?: true }) {
    setBusy(true);
    try {
      setChannels(await updateSupportChannels(update));
    } catch (error) {
      onNotice({ tone: "error", text: friendlyError(error) });
    } finally {
      setBusy(false);
    }
  }

  function copy(text: string, label: string) {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(label);
        setTimeout(() => setCopied(null), 1600);
      })
      .catch(() => onNotice({ tone: "error", text: "Could not copy. Select the text and copy it manually." }));
  }

  if (loadError) return <p role="alert">{loadError}</p>;
  if (!channels) return <p role="status">Loading channel settings…</p>;

  const origin = window.location.origin;
  const snippet = channels.embedToken ? `<script src="${origin}/widget.js" data-chaste="${channels.embedToken}" async></script>` : null;
  const link = channels.embedToken ? `${origin}/widget/${channels.embedToken}` : null;

  return (
    <section className="support-stack" aria-label="Website widget">
      <section className="support-panel">
        <header><h2>Put chat on your website</h2></header>
        <p>Paste this before the closing body tag. A floating chat bubble appears, and conversations land in this inbox as customers.</p>
        {snippet ? (
          <>
            <pre>{snippet}</pre>
            <div className="support-actions">
              <button className="shell-button shell-button-secondary" type="button" onClick={() => copy(snippet, "snippet")}>{copied === "snippet" ? "Copied" : "Copy snippet"}</button>
              {channels.canManage && <button className="shell-button shell-button-secondary" type="button" disabled={busy} onClick={() => void patch({ regenerateToken: true })}>Regenerate token</button>}
            </div>
          </>
        ) : (
          <p className="support-muted">
            {channels.canManage
              ? "No embed token yet. Save your channel settings below to generate one."
              : "The website channel is not configured yet. An organization admin can generate its embed token here."}
          </p>
        )}
        <p className="support-help">
          Prefer a plain link?{" "}
          {link && <button className="support-link" type="button" onClick={() => copy(link, "link")}>{copied === "link" ? "copied" : "Share the standalone chat page"}</button>}
          {" "}anywhere: email signatures, social bios, help docs.
        </p>
      </section>

      <section className="support-panel">
        <header><h2>AI behavior</h2></header>
        <label className="support-check support-check-block">
          <input
            type="checkbox"
            checked={channels.autoReplyEnabled}
            disabled={busy || !channels.canManage}
            onChange={(event) => void patch({ autoReplyEnabled: event.target.checked })}
          />
          <span><strong>Answer visitors automatically.</strong> Replies are grounded in your knowledge base and order history. When you turn this off, or a visitor asks for a human, the thread waits for staff.</span>
        </label>
        <label className="support-label" htmlFor="support-widget-greeting">First message visitors see</label>
        <textarea
          id="support-widget-greeting"
          rows={2}
          maxLength={300}
          value={greeting}
          disabled={!channels.canManage}
          onChange={(event) => setGreeting(event.target.value)}
        />
        <div className="support-actions">
          <button
            className="shell-button shell-button-secondary"
            type="button"
            disabled={busy || !channels.canManage || !greeting.trim() || greeting === channels.greeting}
            onClick={() => void patch({ greeting: greeting.trim() })}
          >
            Save greeting
          </button>
        </div>
      </section>

      <section className="support-panel">
        <header><h2>What the AI can reach</h2></header>
        <ul className="support-principles">
          <li>Your knowledge base (Documents app)</li>
          <li>The asking customer's own order status, nothing about other customers</li>
          <li>Nothing else. Escalated threads are answered only by people.</li>
        </ul>
      </section>
    </section>
  );
}

function SupportLibraryPanel({ onNotice }: { onNotice: (notice: Notice) => void }) {
  const [library, setLibrary] = useState<SupportLibrary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cannedForm, setCannedForm] = useState({ shortcut: "", title: "", body: "" });
  const [articleForm, setArticleForm] = useState({ title: "", body: "", category: "", isPublic: false });

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await fetchSupportLibrary(signal);
      if (!signal?.aborted) setLibrary(result);
    } catch (error) {
      if (!signal?.aborted) setLoadError(friendlyError(error));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /** The legacy library writers carried an intentId, so a retried publish reconciles. */
  async function save(action: SupportWriteAction, reset: () => void) {
    setBusy(true);
    try {
      const outcome = await submitSupportAction(action, crypto.randomUUID());
      if (outcome.kind === "pending") {
        onNotice({ tone: "pending", text: outcome.reason });
        return;
      }
      reset();
      await load();
    } catch (error) {
      onNotice({ tone: "error", text: friendlyError(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="support-stack" aria-label="Support library">
      {loadError && <p className="support-error" role="alert">{loadError}</p>}

      <section className="support-panel">
        <header><h2>Save a canned response</h2></header>
        <div className="support-form-grid">
          <label>Canned shortcut<input value={cannedForm.shortcut} onChange={(event) => setCannedForm({ ...cannedForm, shortcut: event.target.value })} placeholder="/refund" /></label>
          <label>Canned response title<input value={cannedForm.title} onChange={(event) => setCannedForm({ ...cannedForm, title: event.target.value })} placeholder="Refund policy answer" /></label>
        </div>
        <label className="support-label">Reply body
          <textarea rows={3} value={cannedForm.body} onChange={(event) => setCannedForm({ ...cannedForm, body: event.target.value })} />
        </label>
        <div className="support-actions">
          <button
            className="shell-button"
            type="button"
            disabled={busy || !cannedForm.shortcut.trim() || !cannedForm.title.trim() || !cannedForm.body.trim()}
            onClick={() => void save(
              { action: "createCannedResponse", shortcut: cannedForm.shortcut.trim(), title: cannedForm.title.trim(), body: cannedForm.body.trim() },
              () => setCannedForm({ shortcut: "", title: "", body: "" }),
            )}
          >
            Save response
          </button>
        </div>
      </section>

      <section className="support-panel">
        <header><h2>Canned responses</h2><span>{library?.canned.length ?? 0}</span></header>
        {library === null ? (
          <p className="support-muted">Loading…</p>
        ) : library.canned.length === 0 ? (
          <p className="support-muted">No canned responses yet. Save the replies you type twice or more.</p>
        ) : (
          <ul className="support-rows">
            {library.canned.map((entry) => (
              <li key={entry.id}>
                <span className="support-row-copy">
                  <span><span className="support-badge support-badge-neutral">{entry.shortcut}</span> <strong>{entry.title}</strong></span>
                  <small>{entry.body}</small>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="support-panel">
        <header><h2>Author a knowledge-base article</h2></header>
        <div className="support-form-grid">
          <label>Article title<input value={articleForm.title} onChange={(event) => setArticleForm({ ...articleForm, title: event.target.value })} placeholder="How returns work" /></label>
          <label>Article category (optional)<input value={articleForm.category} onChange={(event) => setArticleForm({ ...articleForm, category: event.target.value })} placeholder="shipping" /></label>
        </div>
          <label className="support-label">Article body
            <textarea rows={5} value={articleForm.body} onChange={(event) => setArticleForm({ ...articleForm, body: event.target.value })} placeholder="Answer the question once, publicly, so it stops arriving twice a week." />
          </label>
        <label className="support-label">
          <input type="checkbox" checked={articleForm.isPublic} onChange={(event) => setArticleForm({ ...articleForm, isPublic: event.target.checked })} />
          Make this article available to public support replies
        </label>
        <div className="support-actions">
          <button
            className="shell-button"
            type="button"
            disabled={busy || !articleForm.title.trim() || !articleForm.body.trim()}
            onClick={() => void save(
              {
                action: "createKbArticle",
                title: articleForm.title.trim(),
                body: articleForm.body.trim(),
                isPublic: articleForm.isPublic,
                ...(articleForm.category.trim() ? { category: articleForm.category.trim() } : {}),
              },
              () => setArticleForm({ title: "", body: "", category: "", isPublic: false }),
            )}
          >
            {articleForm.isPublic ? "Publish article" : "Save internal article"}
          </button>
        </div>
      </section>

      <section className="support-panel">
        <header><h2>Knowledge base</h2><span>{library?.articles.length ?? 0}</span></header>
        {library === null ? (
          <p className="support-muted">Loading…</p>
        ) : library.articles.length === 0 ? (
          <p className="support-muted">No articles yet. The website widget's AI answers are grounded in these.</p>
        ) : (
          <ul className="support-rows">
            {library.articles.map((article) => (
              <li key={article.id}>
                <span className="support-row-copy">
                  <span><strong>{article.title}</strong> <span className="support-badge support-badge-neutral">{article.isPublic ? "Public" : "Internal"}</span>{article.category && <> <span className="support-badge support-badge-neutral">{article.category}</span></>}</span>
                  <small>{article.body}</small>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function SupportStyles() {
  return <style>{SUPPORT_PAGE_CSS}</style>;
}

const SUPPORT_PAGE_CSS = `
.support-page { display: grid; gap: 1rem; max-width: 78rem; margin: 0 auto; padding: 1.5rem; }
.support-header h1 { margin: .2rem 0 .4rem; font-size: 1.65rem; letter-spacing: -.035em; }
.support-header > p:last-child { margin: 0; max-width: 46rem; color: #6b7269; font-size: .85rem; line-height: 1.6; }
.support-tabs { display: flex; flex-wrap: wrap; gap: .4rem; }
.support-tab { border: 1px solid #dfe5df; border-radius: 999px; padding: .4rem .85rem; background: #fff; color: #5c655d; cursor: pointer; font-size: .8rem; font-weight: 600; }
.support-tab.is-active { border-color: #b7c6ba; background: #eef3ee; color: #24402f; }
.support-tab span { margin-left: .4rem; color: #8b938a; font-size: .72rem; }
.support-notice { display: flex; align-items: center; justify-content: space-between; gap: 1rem; border: 1px solid #d6e0d9; border-radius: .65rem; padding: .7rem .9rem; background: #f7faf7; font-size: .84rem; }
.support-notice button { border: 0; background: none; color: inherit; cursor: pointer; font-size: 1rem; }
.support-notice-pending { border-color: #ecdcb0; background: #fffaec; color: #775d23; }
.support-notice-error { border-color: #e9c6bd; background: #fff7f4; color: #994838; }
.support-panel { display: grid; gap: .75rem; padding: 1.1rem; border: 1px solid #e3e6e1; border-radius: .9rem; background: #fff; box-shadow: 0 8px 24px rgb(23 38 31 / 4%); }
.support-panel > header { display: flex; align-items: baseline; justify-content: space-between; gap: .75rem; }
.support-panel h2 { margin: 0; font-size: 1rem; }
.support-panel > p { margin: 0; color: #6b7269; font-size: .85rem; line-height: 1.6; }
.support-panel > header > span { color: #8b938a; font-size: .78rem; }
.support-stack { display: grid; gap: 1rem; }
.support-kpis { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); }
.support-kpis button { display: grid; gap: .2rem; border: 1px solid #e3e6e1; border-radius: .9rem; padding: 1rem; background: #fff; cursor: pointer; text-align: left; }
.support-kpis span { color: #7d847b; font-size: .72rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.support-kpis strong { font-size: 1.7rem; letter-spacing: -.03em; }
.support-kpis small { color: #8b938a; font-size: .72rem; }
.support-overview-grid { display: grid; gap: 1rem; grid-template-columns: 1fr; margin-top: 1rem; }
.support-rows { display: grid; margin: 0; padding: 0; list-style: none; }
.support-rows li { display: flex; align-items: center; justify-content: space-between; gap: .75rem; border-top: 1px solid #f0f1ee; padding: .6rem 0; font-size: .84rem; }
.support-rows li:first-child { border-top: 0; }
.support-row-copy { display: grid; min-width: 0; gap: .15rem; }
.support-row-copy small { overflow: hidden; color: #8b938a; font-size: .76rem; text-overflow: ellipsis; white-space: nowrap; }
.support-principles { display: grid; gap: .5rem; margin: 0; padding-left: 1.1rem; color: #5c655d; font-size: .84rem; line-height: 1.6; }
.support-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.support-actions button:not(.shell-button) { border: 1px solid #dfe5df; border-radius: 7px; padding: .35rem .7rem; background: #fff; color: #35423a; cursor: pointer; font-size: .78rem; font-weight: 600; }
.support-actions button:disabled { cursor: not-allowed; opacity: .5; }
.support-link { border: 0; padding: 0; background: none; color: #2f6b4a; cursor: pointer; font-size: .78rem; font-weight: 600; text-decoration: underline; }
.support-muted { color: #7d847b; font-size: .85rem; }
.support-error { margin: 0; color: #994838; font-size: .8rem; }
.support-help { color: #7d847b; font-size: .78rem; }
.support-badge { border-radius: 999px; padding: .15rem .5rem; background: #eef1ed; color: #4a544c; font-size: .7rem; font-weight: 700; }
.support-badge-open { background: #e6f2fb; color: #315d7a; }
.support-badge-escalated { background: #fdf0dc; color: #8a5a16; }
.support-badge-resolved { background: #e5f5eb; color: #276047; }
.support-inbox { display: grid; gap: 1rem; grid-template-columns: 1fr; }
.support-inbox-list { align-content: start; }
.support-filters { display: flex; flex-wrap: wrap; gap: .3rem; }
.support-filters button { border: 1px solid #e3e6e1; border-radius: 999px; padding: .25rem .65rem; background: #fff; color: #6b7269; cursor: pointer; font-size: .72rem; }
.support-filters button[aria-pressed="true"] { border-color: #b7c6ba; background: #eef3ee; color: #24402f; font-weight: 700; }
.support-inbox-list ul { display: grid; margin: 0; padding: 0; list-style: none; }
.support-inbox-list li { border-top: 1px solid #f0f1ee; }
.support-inbox-list li button { display: grid; width: 100%; gap: .2rem; border: 0; padding: .65rem .25rem; background: none; cursor: pointer; text-align: left; }
.support-inbox-list li button[aria-current="true"] { background: #f4f7f4; }
.support-inbox-row { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
.support-inbox-customer { overflow: hidden; font-size: .84rem; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.support-inbox-line { overflow: hidden; color: #7d847b; font-size: .76rem; text-overflow: ellipsis; white-space: nowrap; }
.support-inbox-preview { color: #9aa198; }
.support-inbox-actions { border-top: 1px solid #f0f1ee; padding-top: .6rem; }
.support-thread { gap: .6rem; }
.support-thread-header { display: flex; flex-wrap: wrap; align-items: start; justify-content: space-between; gap: .75rem; border-bottom: 1px solid #f0f1ee; padding-bottom: .6rem; }
.support-thread-header h2 { margin: 0; font-size: .95rem; }
.support-thread-header p { margin: .1rem 0 .3rem; color: #7d847b; font-size: .78rem; }
.support-ticket, .support-escalate { display: grid; gap: .6rem; border: 1px solid #e3e6e1; border-radius: .7rem; padding: .75rem; background: #fafbf9; }
.support-escalate label { font-size: .8rem; font-weight: 600; }
.support-escalate input { flex: 1; min-width: 12rem; }
.support-ticket-grid, .support-form-grid { display: grid; gap: .6rem; grid-template-columns: 1fr; }
.support-ticket label, .support-form-grid label { display: grid; gap: .25rem; color: #4a544c; font-size: .76rem; font-weight: 600; }
.support-ticket select, .support-ticket input, .support-escalate input, .support-modal input, .support-modal select, .support-form-grid input, .support-label textarea, .support-widget textarea { box-sizing: border-box; width: 100%; border: 1px solid #cbd5cf; border-radius: .55rem; padding: .45rem .6rem; background: #fff; color: #18221e; font: inherit; font-size: .82rem; font-weight: 400; }
.support-inline-field { display: flex; gap: .35rem; }
.support-inline-field input { flex: 1; min-width: 0; }
.support-inline-field button { flex: 0 0 auto; border: 1px solid #dfe5df; border-radius: 7px; padding: .3rem .6rem; background: #fff; cursor: pointer; font-size: .76rem; font-weight: 600; }
.support-label { display: grid; gap: .25rem; color: #4a544c; font-size: .76rem; font-weight: 600; }
.support-saved { color: #276047; font-size: .74rem; font-weight: 700; }
.support-messages { display: flex; max-height: 26rem; min-height: 12rem; flex-direction: column; gap: .6rem; overflow-y: auto; padding: .25rem; }
.support-message { display: flex; }
.support-message-in { justify-content: flex-start; }
.support-message-out { justify-content: flex-end; }
.support-message-inner { max-width: 80%; }
.support-message-meta { display: flex; gap: .5rem; margin: 0 0 .15rem; color: #9aa198; font-size: .68rem; }
.support-bubble { border-radius: 14px; padding: .5rem .7rem; font-size: .82rem; line-height: 1.5; white-space: pre-wrap; }
.support-bubble-customer { border-bottom-left-radius: 4px; background: #f1f2ee; color: #3d453e; }
.support-bubble-staff { border-bottom-right-radius: 4px; background: #24402f; color: #fff; }
.support-bubble-agent { border-bottom-right-radius: 4px; background: #eef3ee; color: #24402f; }
.support-bubble-system { padding: 0; background: none; color: #9aa198; font-size: .72rem; }
.support-draft { width: 100%; max-width: 32rem; border: 1px solid #cfe0d2; border-radius: .8rem; padding: .7rem; background: #f7fbf7; }
.support-draft-label { margin: 0 0 .35rem; color: #2f6b4a; font-size: .68rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
.support-draft textarea { box-sizing: border-box; width: 100%; resize: vertical; border: 1px solid #cbd5cf; border-radius: .55rem; padding: .5rem; background: #fff; font: inherit; font-size: .82rem; }
.support-composer { display: flex; flex-wrap: wrap; align-items: end; gap: .5rem; border-top: 1px solid #f0f1ee; padding-top: .6rem; }
.support-composer textarea { flex: 1; min-width: 12rem; max-height: 8rem; resize: vertical; border: 1px solid #cbd5cf; border-radius: .7rem; padding: .5rem; font: inherit; font-size: .82rem; }
.support-check { display: flex; align-items: center; gap: .4rem; color: #5c655d; font-size: .76rem; }
.support-check-block { align-items: start; line-height: 1.55; }
.support-modal-backdrop { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: 1rem; background: rgb(28 32 27 / 45%); }
.support-modal { display: grid; gap: .5rem; width: min(100%, 26rem); border-radius: .9rem; padding: 1.1rem; background: #fff; }
.support-modal > header { display: flex; align-items: center; justify-content: space-between; }
.support-modal > header h2 { margin: 0; font-size: 1rem; }
.support-modal > header button { border: 0; background: none; color: #8b938a; cursor: pointer; font-size: 1.1rem; }
.support-modal > label { color: #4a544c; font-size: .76rem; font-weight: 600; }
.support-quick-customer { display: grid; gap: .4rem; border: 1px solid #e3e6e1; border-radius: .6rem; padding: .5rem; background: #fafbf9; }
.support-quick-customer input { border: 1px solid #cbd5cf; border-radius: .5rem; padding: .4rem .55rem; font: inherit; font-size: .8rem; }
.support-quick-customer button { justify-self: start; border: 1px solid #dfe5df; border-radius: 7px; padding: .35rem .7rem; background: #fff; cursor: pointer; font-size: .78rem; font-weight: 600; }
.support-widget pre { overflow-x: auto; margin: 0; border-radius: .55rem; padding: .7rem; background: #1d2320; color: #e8efe9; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .74rem; }
@media (min-width: 62rem) {
  .support-page { padding: 2rem; }
  .support-overview-grid { grid-template-columns: 1.4fr 1fr; }
  .support-inbox { grid-template-columns: 20rem minmax(0, 1fr); }
  .support-ticket-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .support-form-grid { grid-template-columns: 12rem minmax(0, 1fr); }
}
`;
