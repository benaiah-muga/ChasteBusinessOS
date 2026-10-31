import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Copy,
  ExternalLink,
  Loader2,
  MessageSquareText,
  MoreHorizontal,
  PanelRight,
  RotateCcw,
  Sparkles,
  UserRound,
  Users,
  X,
  Zap,
} from "lucide-react";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { useToast } from "../../ui/toast";
import { navigate } from "../../navigation";
import {
  fetchSupportTeamMembers,
  type SupportMessage,
  type SupportTeamMember,
} from "../../api/support";
import { useSupportDesk } from "./SupportDeskContext";
import {
  PriorityBadge,
  SlaBadge,
  StatusBadge,
  SupportAvatar,
  SupportEmpty,
} from "./SupportBits";
import { SupportComposer } from "./SupportComposer";
import {
  escalationReason,
  relativeTime,
  systemMessageText,
} from "./support-model";

export function SupportThread({
  onOpenDetails,
}: {
  onOpenDetails: () => void;
}) {
  const desk = useSupportDesk();
  const { toast } = useToast();
  const [members, setMembers] = useState<SupportTeamMember[] | null>(null);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [escalateOpen, setEscalateOpen] = useState(false);
  const [escalateReasonText, setEscalateReasonText] = useState("");
  const [nearBottom, setNearBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousConversationRef = useRef<string | null>(null);
  const suppressScrollSyncRef = useRef(false);
  const scrollSyncTimerRef = useRef<number | null>(null);

  const current =
    desk.conversation && desk.conversation.id === desk.selectedId
      ? desk.conversation
      : null;

  useEffect(() => {
    setEscalateOpen(false);
    setEscalateReasonText("");
  }, [desk.selectedId]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !current) return;
    if (previousConversationRef.current !== current.id) {
      previousConversationRef.current = current.id;
      const startAtHandoff = current.status === "escalated";
      suppressScrollSyncRef.current = true;
      if (scrollSyncTimerRef.current !== null) {
        window.clearTimeout(scrollSyncTimerRef.current);
      }
      scrollSyncTimerRef.current = window.setTimeout(() => {
        suppressScrollSyncRef.current = false;
      }, 350);
      element.scrollTop = startAtHandoff ? 0 : element.scrollHeight;
      setNearBottom(
        !startAtHandoff || element.scrollHeight - element.clientHeight <= 24,
      );
      if (startAtHandoff) {
        window.requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = 0;
        });
      }
      return;
    }
    if (nearBottom) element.scrollTop = element.scrollHeight;
  }, [current, desk.messages.length, nearBottom]);

  useEffect(() => {
    function onLatest() {
      const element = scrollRef.current;
      if (element) element.scrollTop = element.scrollHeight;
      setNearBottom(true);
    }
    window.addEventListener("chaste:support-scroll-latest", onLatest);
    return () =>
      window.removeEventListener("chaste:support-scroll-latest", onLatest);
  }, []);

  function loadMembers() {
    if (members || membersLoading) return;
    setMembersLoading(true);
    setMembersError(null);
    void fetchSupportTeamMembers()
      .then((result) => setMembers(result))
      .catch((error: unknown) =>
        setMembersError(
          error instanceof Error
            ? error.message
            : "Team members are unavailable.",
        ),
      )
      .finally(() => setMembersLoading(false));
  }

  async function toggleResolved() {
    if (!current) return;
    const reopening = current.status === "resolved";
    const ok = await desk.setConversationStatus(
      reopening ? "reopen" : "resolve",
    );
    if (!ok) return;
    toast({
      title: reopening ? "Conversation reopened" : "Conversation resolved",
      description: reopening
        ? "It is back in the open queue."
        : "It leaves the active queue and stays searchable with its full record.",
      tone: "success",
    });
  }

  async function assign(userId: string | null) {
    if (!current) return;
    const ok = await desk.updateTicket({ assigneeUserId: userId });
    if (!ok) return;
    const member = userId
      ? members?.find((item) => item.userId === userId)
      : null;
    toast({
      title: userId
        ? `Assigned to ${member?.name || member?.email || "a teammate"}`
        : "Assignment cleared",
      tone: "success",
    });
  }

  function copyText(value: string, label: string) {
    if (!value) return;
    void navigator.clipboard?.writeText(value).then(
      () => toast({ title: `${label} copied`, tone: "success" }),
      () =>
        toast({
          title: `Could not copy the ${label.toLowerCase()}`,
          tone: "danger",
        }),
    );
  }

  async function submitEscalation() {
    if (!current || escalateReasonText.trim().length < 3) return;
    const ok = await desk.escalate(escalateReasonText);
    if (!ok) return;
    setEscalateOpen(false);
    setEscalateReasonText("");
    toast({
      title: "Conversation escalated",
      description:
        "The thread is now waiting on a person, with the reason on its record.",
      tone: "success",
    });
  }

  if (!desk.selectedId) {
    return (
      <section
        className="support-thread support-thread-idle"
        aria-label="Conversation"
      >
        <SupportEmpty
          icon={MessageSquareText}
          title="Choose a conversation."
          detail="The thread, the record behind every reply, and the handoff all live in one place. Use J and K to move through the queue."
          action={
            <div className="support-idle-hints">
              <span>
                <kbd>J</kbd>
                <kbd>K</kbd> move
              </span>
              <span>
                <kbd>Enter</kbd> open
              </span>
            </div>
          }
        />
      </section>
    );
  }

  if (desk.threadStatus === "loading" && !current) {
    return (
      <section
        className="support-thread"
        aria-busy="true"
        aria-label="Loading conversation"
      >
        <div className="support-thread-loading">
          <span className="support-skeleton-line support-skeleton-title" />
          <span className="support-skeleton-bubble" />
          <span className="support-skeleton-bubble support-skeleton-bubble-short" />
          <span className="support-skeleton-bubble" />
        </div>
      </section>
    );
  }

  if (desk.threadStatus === "failed") {
    return (
      <section className="support-thread" aria-label="Conversation">
        <SupportEmpty
          icon={AlertTriangle}
          title="This conversation could not open."
          detail={
            desk.threadError ??
            "The support service did not return the thread. Its record is unchanged."
          }
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void desk.refreshThread()}
            >
              <RotateCcw size={13} aria-hidden="true" /> Try again
            </Button>
          }
        />
      </section>
    );
  }

  if (!current) {
    return (
      <section className="support-thread" aria-label="Conversation">
        <SupportEmpty
          icon={MessageSquareText}
          title="Choose a conversation."
          detail="Pick a thread from the queue."
        />
      </section>
    );
  }

  const reason = escalationReason(desk.messages);
  const assignedName =
    current.assignedUserName ??
    members?.find((member) => member.userId === current.assignedUserId)?.name ??
    null;
  const memberLabel = (member: SupportTeamMember) =>
    member.name || member.email;

  return (
    <section
      className="support-thread"
      aria-label={`Conversation with ${current.customerName}`}
    >
      <header className="support-thread-head">
        <button
          type="button"
          className="support-icon-button support-thread-back"
          onClick={() => desk.selectConversation(null)}
          aria-label="Back to the conversation queue"
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </button>
        <SupportAvatar name={current.customerName} size="lg" />
        <div className="support-thread-identity">
          <div className="support-thread-title">
            <h2>{current.customerName}</h2>
            <StatusBadge status={current.status} />
            {current.priority !== "normal" && current.priority ? (
              <PriorityBadge priority={current.priority} />
            ) : null}
            <SlaBadge dueAt={current.slaDueAt} status={current.status} />
          </div>
          <p className="support-thread-subject">{current.subject}</p>
          <p className="support-thread-meta">
            {current.ticketNumber ? <span>#{current.ticketNumber}</span> : null}
            <span>
              {current.channel === "widget" ? "Website widget" : "Desk"}
            </span>
            <span>
              Opened {relativeTime(current.createdAt ?? current.lastMessageAt)}
            </span>
            <span className="support-assigned-meta">
              {assignedName ? `Assigned to ${assignedName}` : "Unassigned"}
            </span>
            {current.customerName === "Website visitor" &&
            current.customerEmail ? (
              <span>{current.customerEmail}</span>
            ) : null}
          </p>
        </div>
        <div className="support-thread-actions">
          <DropdownMenu
            onOpenChange={(open) => {
              if (open) loadMembers();
            }}
          >
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label={
                  assignedName
                    ? `Assigned to ${assignedName}. Change assignment`
                    : "Assign conversation"
                }
              >
                <Users size={14} aria-hidden="true" />
                <span className="support-action-label">
                  {assignedName ? "Assigned" : "Assign"}
                </span>
                <ChevronDown size={12} aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="support-assign-menu">
              <DropdownMenuLabel>Assign this conversation</DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={() => void assign(desk.actorId)}
                disabled={!desk.actorId}
              >
                Assign to me
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => void assign(null)}
                disabled={!current.assignedUserId}
              >
                Unassign
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {membersLoading && (
                <DropdownMenuItem disabled>
                  Loading teammates...
                </DropdownMenuItem>
              )}
              {membersError && (
                <DropdownMenuItem disabled>
                  Team list unavailable
                </DropdownMenuItem>
              )}
              {members?.map((member) => (
                <DropdownMenuItem
                  key={member.userId}
                  onSelect={() => void assign(member.userId)}
                >
                  {memberLabel(member)}
                  {member.userId === desk.actorId ? " (you)" : ""}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {current.status === "open" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEscalateOpen(true);
                desk.clearActionError();
              }}
              disabled={desk.busy !== null}
            >
              <Zap size={14} aria-hidden="true" />
              <span className="support-action-label">Escalate</span>
            </Button>
          )}
          <Button
            variant={current.status === "resolved" ? "secondary" : "primary"}
            size="sm"
            onClick={() => void toggleResolved()}
            disabled={desk.busy !== null}
          >
            {desk.busy === "resolve" || desk.busy === "reopen" ? (
              <Loader2 size={13} className="support-spin" aria-hidden="true" />
            ) : current.status === "resolved" ? (
              <RotateCcw size={13} aria-hidden="true" />
            ) : (
              <CheckCircle2 size={13} aria-hidden="true" />
            )}
            <span>{current.status === "resolved" ? "Reopen" : "Resolve"}</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="support-context-toggle"
            onClick={onOpenDetails}
            aria-label="Open customer and ticket details"
          >
            <PanelRight size={15} aria-hidden="true" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="More conversation actions"
              >
                <MoreHorizontal size={16} aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Conversation record</DropdownMenuLabel>
              <DropdownMenuItem onSelect={onOpenDetails}>
                <PanelRight size={13} aria-hidden="true" /> Customer and ticket
                details
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => copyText(current.id, "Conversation ID")}
                disabled={!current.id}
              >
                <Copy size={13} aria-hidden="true" /> Copy conversation ID
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => copyText(current.customerEmail ?? "", "Email")}
                disabled={!current.customerEmail}
              >
                <Copy size={13} aria-hidden="true" /> Copy customer email
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => navigate("/ledger")}>
                <ExternalLink size={13} aria-hidden="true" /> Open audit ledger
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {desk.actionError && (
        <div className="support-thread-error" role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{desk.actionError}</span>
          <button
            type="button"
            onClick={desk.clearActionError}
            aria-label="Dismiss error"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      )}

      {desk.threadError && current && (
        <div className="support-thread-error" role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>The thread could not refresh. {desk.threadError}</span>
          <button
            type="button"
            onClick={() => void desk.refreshThread()}
            aria-label="Retry thread refresh"
          >
            <RotateCcw size={12} aria-hidden="true" />
          </button>
        </div>
      )}

      {current.status === "escalated" && (
        <section
          className="support-escalation-card"
          aria-label="Escalation reason"
        >
          <span className="support-escalation-icon" aria-hidden="true">
            <Zap size={15} />
          </span>
          <div className="support-escalation-copy">
            <p className="support-eyebrow">Why this needs a human</p>
            <h3 title={reason ?? undefined}>
              {reason || "The desk stopped this thread for a person."}
            </h3>
            <p>
              The thread is out of the automatic queue and waits on a person.
              Reopen it to return it to the desk when it is ready to move again.
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void desk.setConversationStatus("reopen")}
              disabled={desk.busy !== null}
            >
              <RotateCcw size={13} aria-hidden="true" /> Return to queue
            </Button>
          </div>
        </section>
      )}

      <div className="support-thread-scroll-wrap">
        <div
          className="support-thread-scroll"
          ref={scrollRef}
          onScroll={(event) => {
            if (suppressScrollSyncRef.current) return;
            const element = event.currentTarget;
            setNearBottom(
              element.scrollHeight - element.scrollTop - element.clientHeight <
                24,
            );
          }}
        >
          <div className="support-thread-stream">
            {desk.messages.length === 0 ? (
              <SupportEmpty
                icon={MessageSquareText}
                title="No messages yet."
                detail="This conversation has no recorded messages. Write the first reply, or log what the customer said."
                compact
              />
            ) : (
              desk.messages.map((message) => (
                <SupportMessageRow
                  key={message.id}
                  message={message}
                  customerName={current.customerName}
                  actorId={desk.actorId}
                />
              ))
            )}
          </div>
        </div>
        {!nearBottom && desk.messages.length > 0 && (
          <button
            type="button"
            className="support-jump-latest"
            onClick={() => {
              const element = scrollRef.current;
              if (element) element.scrollTop = element.scrollHeight;
              setNearBottom(true);
            }}
          >
            <ArrowDown size={13} aria-hidden="true" /> Jump to latest
          </button>
        )}
      </div>

      <SupportComposer conversation={current} />

      <Dialog open={escalateOpen} onOpenChange={setEscalateOpen}>
        <DialogContent className="support-dialog support-dialog-small">
          <DialogTitle>Escalate to a human</DialogTitle>
          <DialogDescription>
            The thread moves out of the open queue and waits on a person. The
            reason is written to the customer's record, so the next person does
            not have to reconstruct it.
          </DialogDescription>
          <label className="support-field">
            <span>Why does this need a person?</span>
            <textarea
              value={escalateReasonText}
              onChange={(event) => setEscalateReasonText(event.target.value)}
              rows={4}
              maxLength={4000}
              placeholder="Refund above policy, account ownership, legal request..."
              autoFocus
            />
          </label>
          {desk.actionError && (
            <p className="support-dialog-error" role="alert">
              {desk.actionError}
            </p>
          )}
          <div className="support-dialog-actions">
            <Button
              variant="ghost"
              onClick={() => setEscalateOpen(false)}
              disabled={desk.busy !== null}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void submitEscalation()}
              disabled={
                desk.busy !== null || escalateReasonText.trim().length < 3
              }
            >
              {desk.busy === "escalate" ? (
                <Loader2
                  size={13}
                  className="support-spin"
                  aria-hidden="true"
                />
              ) : (
                <Zap size={13} aria-hidden="true" />
              )}
              {desk.busy === "escalate" ? "Escalating..." : "Escalate"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function SupportMessageRow({
  message,
  customerName,
  actorId,
}: {
  message: SupportMessage;
  customerName: string;
  actorId: string | null;
}) {
  if (message.senderType === "system") {
    return (
      <div className="support-system-line">
        <span aria-hidden="true" />
        <p title={message.body}>{systemMessageText(message.body)}</p>
        <time dateTime={message.createdAt}>
          {relativeTime(message.createdAt)}
        </time>
        <span aria-hidden="true" />
      </div>
    );
  }
  const customer = message.senderType === "customer";
  const agent = message.senderType === "agent";
  const label = customer
    ? customerName
    : agent
      ? "Desk AI"
      : message.senderUserId === actorId
        ? "You"
        : "Support team";
  return (
    <article
      className={`support-message support-message-${message.senderType}`}
    >
      {customer ? (
        <SupportAvatar name={customerName} size="sm" />
      ) : (
        <span
          className={`support-message-icon${agent ? " is-agent" : ""}`}
          aria-hidden="true"
        >
          {agent ? <Sparkles size={13} /> : <UserRound size={13} />}
        </span>
      )}
      <div className="support-message-body">
        <header>
          <strong>{label}</strong>
          {agent && <span className="support-message-tag">AI</span>}
          <time dateTime={message.createdAt}>
            {relativeTime(message.createdAt)}
          </time>
        </header>
        <div className="support-message-bubble">{message.body}</div>
        {agent && (
          <p className="support-message-note">
            AI-authored entry on the thread. A person is still accountable for
            what the customer receives.
          </p>
        )}
      </div>
    </article>
  );
}
