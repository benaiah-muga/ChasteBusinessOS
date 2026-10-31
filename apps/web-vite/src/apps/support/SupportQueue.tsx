import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowDownUp,
  ChevronDown,
  Filter,
  Inbox,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { useSupportDesk } from "./SupportDeskContext";
import {
  SupportAvatar,
  PriorityBadge,
  SlaBadge,
  SupportEmpty,
} from "./SupportBits";
import {
  countByStatus,
  filterConversations,
  relativeTime,
  sortConversations,
  statusLabel,
  statusTone,
  type SupportAssigneeFilter,
  type SupportQueueFilter,
  type SupportSlaFilter,
  type SupportSort,
} from "./support-model";

const FILTERS: Array<{ id: SupportQueueFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "escalated", label: "Awaiting" },
  { id: "resolved", label: "Resolved" },
];

const PRIORITIES = [
  { value: "", label: "Any priority" },
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "normal", label: "Normal" },
  { value: "low", label: "Low" },
];

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function SupportQueue() {
  const {
    actorId,
    conversations,
    conversationsLoading,
    refreshConversations,
    selectedId,
    selectConversation,
  } = useSupportDesk();
  const initialParams = useMemo(
    () => new URLSearchParams(window.location.search),
    [],
  );
  const [query, setQuery] = useState(() => initialParams.get("q") ?? "");
  const [filter, setFilter] = useState<SupportQueueFilter>(() => {
    const value = initialParams.get("status");
    return value === "open" || value === "escalated" || value === "resolved"
      ? value
      : "all";
  });
  const [assignee, setAssignee] = useState<SupportAssigneeFilter>(() => {
    const value = initialParams.get("assignee");
    return value === "mine" || value === "unassigned" ? value : "everyone";
  });
  const [priority, setPriority] = useState(
    () => initialParams.get("priority") ?? "",
  );
  const [sla, setSla] = useState<SupportSlaFilter>(() =>
    initialParams.get("sla") === "breached" ||
    initialParams.get("sla") === "soon"
      ? (initialParams.get("sla") as SupportSlaFilter)
      : "any",
  );
  const [sort, setSort] = useState<SupportSort>("newest");
  const searchRef = useRef<HTMLInputElement>(null);
  const activeRowRef = useRef<HTMLButtonElement | null>(null);
  const now = useNow();

  const counts = useMemo(() => countByStatus(conversations), [conversations]);
  const visible = useMemo(
    () =>
      sortConversations(
        filterConversations(conversations, {
          query,
          status: filter,
          assignee,
          priority,
          sla,
          actorId,
          now,
        }),
        sort,
      ),
    [actorId, assignee, conversations, filter, now, priority, query, sla, sort],
  );
  const activeFilterCount =
    (assignee !== "everyone" ? 1 : 0) +
    (priority ? 1 : 0) +
    (sla !== "any" ? 1 : 0);
  const resultLabel =
    visible.length === conversations.length
      ? `${visible.length} shown`
      : `${visible.length} of ${conversations.length} shown`;

  useEffect(() => {
    if (typeof activeRowRef.current?.scrollIntoView === "function") {
      activeRowRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [selectedId]);

  const move = useCallback(
    (direction: 1 | -1) => {
      if (visible.length === 0) return;
      const index = visible.findIndex(
        (conversation) => conversation.id === selectedId,
      );
      const start =
        index === -1 ? (direction === 1 ? -1 : visible.length) : index;
      const next = Math.max(0, Math.min(visible.length - 1, start + direction));
      selectConversation(visible[next]!.id, { replace: true });
    },
    [selectedId, selectConversation, visible],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        target?.closest(
          'input, textarea, select, [contenteditable="true"], [role="dialog"]',
        )
      ) {
        if (event.key === "Escape" && target === searchRef.current)
          searchRef.current?.blur();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        move(event.key === "j" ? 1 : -1);
        return;
      }
      if (event.key === "Enter" && visible.length > 0 && !selectedId) {
        event.preventDefault();
        selectConversation(visible[0]!.id);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [move, selectConversation, selectedId, visible]);

  function clearFilters() {
    setQuery("");
    setFilter("all");
    setAssignee("everyone");
    setPriority("");
    setSla("any");
  }

  return (
    <aside className="support-queue" aria-label="Conversation queue">
      <div className="support-queue-head">
        <div className="support-queue-title">
          <div>
            <h1>Inbox</h1>
            <p>Every conversation, evidence trail, and handoff.</p>
          </div>
          <span className="support-queue-open">{counts.open} open</span>
          <button
            type="button"
            className="support-icon-button"
            aria-label="Refresh conversations"
            title="Refresh conversations"
            onClick={() => void refreshConversations()}
          >
            {conversationsLoading ? (
              <Loader2 size={14} className="support-spin" aria-hidden="true" />
            ) : (
              <RefreshCw size={14} aria-hidden="true" />
            )}
          </button>
        </div>

        <div className="support-search">
          <Search size={14} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search names, emails, subjects..."
            aria-label="Search conversations"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
            >
              <X size={12} aria-hidden="true" />
            </button>
          ) : (
            <kbd>/</kbd>
          )}
        </div>

        <div
          className="support-queue-filters"
          role="group"
          aria-label="Filter by conversation status"
        >
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="support-filter-chip"
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
              <span>{counts[item.id]}</span>
            </button>
          ))}
        </div>

        <div className="support-queue-tools">
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="support-tool-button"
                aria-label="Filter conversations"
              >
                <Filter size={13} aria-hidden="true" /> Filters
                {activeFilterCount > 0 && (
                  <span className="support-tool-count">
                    {activeFilterCount}
                  </span>
                )}
                <ChevronDown size={11} aria-hidden="true" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="support-filter-popover">
              <div className="support-filter-popover-head">
                <span>Desk filters</span>
                {activeFilterCount > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setAssignee("everyone");
                      setPriority("");
                      setSla("any");
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
              <FilterSection label="Assignment">
                <FilterChoice
                  label="Everyone"
                  active={assignee === "everyone"}
                  onClick={() => setAssignee("everyone")}
                />
                <FilterChoice
                  label="Assigned to me"
                  active={assignee === "mine"}
                  onClick={() => setAssignee("mine")}
                  disabled={!actorId}
                />
                <FilterChoice
                  label="Unassigned"
                  active={assignee === "unassigned"}
                  onClick={() => setAssignee("unassigned")}
                />
              </FilterSection>
              <FilterSection label="Priority">
                {PRIORITIES.map((item) => (
                  <FilterChoice
                    key={item.value || "any"}
                    label={item.label}
                    active={priority === item.value}
                    onClick={() => setPriority(item.value)}
                  />
                ))}
              </FilterSection>
              <FilterSection label="SLA">
                <FilterChoice
                  label="Any SLA state"
                  active={sla === "any"}
                  onClick={() => setSla("any")}
                />
                <FilterChoice
                  label="Breached"
                  active={sla === "breached"}
                  onClick={() => setSla("breached")}
                />
                <FilterChoice
                  label="Due within 4 hours"
                  active={sla === "soon"}
                  onClick={() => setSla("soon")}
                />
              </FilterSection>
            </PopoverContent>
          </Popover>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="support-tool-button"
                aria-label="Sort conversations"
              >
                <ArrowDownUp size={13} aria-hidden="true" />
                {sort === "newest"
                  ? "Newest"
                  : sort === "priority"
                    ? "Priority"
                    : "SLA"}
                <ChevronDown size={11} aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Sort the queue</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setSort("newest")}>
                Newest activity first
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setSort("priority")}>
                Priority first
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setSort("sla")}>
                SLA due first
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="support-live support-live-queue">
            <span className="support-live-dot" aria-hidden="true" /> Live
          </span>
        </div>
      </div>

      <div className="support-queue-list">
        {visible.length === 0 ? (
          <SupportEmpty
            icon={Inbox}
            title={
              conversations.length === 0
                ? "The inbox is quiet."
                : "No conversations match."
            }
            detail={
              conversations.length === 0
                ? "A widget conversation or a new desk conversation will land here."
                : "The desk only hides what you asked it to hide."
            }
            compact
            action={
              conversations.length > 0 ? (
                <button
                  type="button"
                  className="support-text-button"
                  onClick={clearFilters}
                >
                  Clear filters
                </button>
              ) : undefined
            }
          />
        ) : (
          visible.map((conversation) => {
            const active = conversation.id === selectedId;
            const displayName =
              conversation.customerName === "Website visitor" &&
              conversation.customerEmail
                ? conversation.customerEmail
                : conversation.customerName;
            return (
              <button
                key={conversation.id}
                ref={active ? activeRowRef : undefined}
                type="button"
                className={`support-queue-row${active ? " is-active" : ""}`}
                data-conversation-id={conversation.id}
                aria-current={active ? "page" : undefined}
                onClick={() => selectConversation(conversation.id)}
              >
                <SupportAvatar name={displayName} />
                <span className="support-queue-row-main">
                  <span className="support-queue-row-top">
                    <span className="support-queue-name">{displayName}</span>
                    <span
                      className={`support-row-status support-row-status-${statusTone(conversation.status)}`}
                      title={statusLabel(conversation.status)}
                      aria-label={statusLabel(conversation.status)}
                    />
                    {conversation.status === "escalated" && (
                      <span className="support-row-awaiting">Awaiting</span>
                    )}
                    <time
                      className="support-queue-time"
                      dateTime={conversation.lastMessageAt ?? undefined}
                    >
                      {relativeTime(conversation.lastMessageAt, now)}
                    </time>
                  </span>
                  <span className="support-queue-subject">
                    {conversation.subject}
                  </span>
                  <span className="support-queue-preview">
                    {conversation.lastMessagePreview || "No messages yet"}
                  </span>
                  <span className="support-queue-meta">
                    {conversation.ticketNumber ? (
                      <span className="support-queue-ticket">
                        #{conversation.ticketNumber}
                      </span>
                    ) : null}
                    {conversation.priority !== "normal" &&
                    conversation.priority ? (
                      <PriorityBadge priority={conversation.priority} compact />
                    ) : null}
                    {conversation.channel === "widget" ? (
                      <span className="support-queue-channel">widget</span>
                    ) : null}
                    {conversation.assignedUserName ? (
                      <span className="support-queue-assignee">
                        {conversation.assignedUserName}
                      </span>
                    ) : (
                      <span className="support-queue-unassigned">
                        Unassigned
                      </span>
                    )}
                    <SlaBadge
                      dueAt={conversation.slaDueAt}
                      status={conversation.status}
                      now={now}
                    />
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>

      <div className="support-queue-foot">
        <span>{resultLabel}</span>
        <span className="support-key-hints">
          <span>
            <kbd>J</kbd>
            <kbd>K</kbd> move
          </span>
          <span>
            <kbd>Enter</kbd> open
          </span>
          <span>
            <kbd>/</kbd> search
          </span>
        </span>
      </div>
    </aside>
  );
}

function FilterSection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section className="support-filter-section">
      <p>{label}</p>
      {children}
    </section>
  );
}

function FilterChoice({
  label,
  active,
  onClick,
  disabled = false,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="support-filter-choice"
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
    >
      <span>{label}</span>
      {active && (
        <span className="support-filter-check" aria-hidden="true">
          ●
        </span>
      )}
    </button>
  );
}
