import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  BookOpenCheck,
  Clipboard,
  Command as CommandIcon,
  CornerDownLeft,
  FileText,
  Landmark,
  Paperclip,
  Plus,
  Search,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  SquarePen,
  TrendingUp,
  Users,
  X,
} from "lucide-react";
import {
  chatStore,
  refreshChatCreatorAvailability,
  resetChat,
  resumeChat,
  restoreChatSession,
  setChatCreator,
  useChat,
} from "../chat-store";
import { CHAT_MESSAGE_MAX_UNITS, type ChatAttachment } from "../api/chat";
import { searchRecords, type RecordSearchGroup } from "../api/search";
import { createIngestedDocument, DocumentsIngestApiError } from "../api/documents-ingest";
import { fetchSessions, type AgentSession } from "../api/sessions";
import { ChatComposer, MessageList, formatTokens, formatToolName, useAutoScroll } from "./ChatTranscript";
import { BrandMark } from "../ui/brand-mark";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Kbd } from "../ui/page-header";
import { useToast } from "../ui/toast";
import "./ChatPage.css";

/** Dashboard shortcuts arrive as ?prompt=; mirror MessagesPage's single-param rule. */
function readChatPrompt(): string | null {
  const prompts = new URLSearchParams(window.location.search).getAll("prompt");
  if (prompts.length !== 1) return null;
  const prompt = prompts[0] ?? "";
  return prompt.trim().length > 0 && prompt.length <= CHAT_MESSAGE_MAX_UNITS ? prompt : null;
}

const CHAT_SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Workmate continuation arrives as ?session=; mirror the single-param rule. */
function readChatSessionParam(): string | null {
  const ids = new URLSearchParams(window.location.search).getAll("session");
  if (ids.length !== 1) return null;
  const id = ids[0]?.trim() ?? "";
  return CHAT_SESSION_UUID.test(id) ? id : null;
}

function clearChatSessionParam() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("session");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // A blocked URL update still leaves the resumed conversation open.
  }
}

function clearChatPromptFromUrl() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("prompt");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // The param stays; the applied guard below still prevents a resend.
  }
}

type StarterPrompt = { icon: typeof Landmark; label: string; prompt: string; group: string };

const STARTER_PROMPTS: StarterPrompt[] = [
  { icon: Landmark, label: "Cash and runway", prompt: "Give me the cash position, the 13-week forecast, and the three largest risks to runway.", group: "Money" },
  { icon: TrendingUp, label: "What changed this month?", prompt: "Explain what changed in revenue and expenses this month, with the exact invoices and bills behind the biggest movements.", group: "Money" },
  { icon: FileText, label: "Draft an invoice", prompt: "Draft an invoice. Ask me for the customer, line items, and due date you need.", group: "Sales" },
  { icon: Clipboard, label: "Catch me up", prompt: "Give me a short brief of what needs my attention today, what changed since yesterday, and what you recommend I do first.", group: "Work" },
  { icon: Users, label: "Who is waiting?", prompt: "Review open support tickets and people requests. Tell me who is waiting on a decision and what I should do next.", group: "People" },
  { icon: RotateCcw, label: "Reorder low stock", prompt: "Review stock at or below its reorder point and prepare a replenishment plan for my approval.", group: "Inventory" },
];

const COMMANDS: { command: string; label: string; prompt: string }[] = [
  { command: "/invoice", label: "Draft an invoice", prompt: "Draft an invoice. Ask me for the customer, line items, and due date you need." },
  { command: "/bill", label: "Record a supplier bill", prompt: "Help me record a supplier bill we received. Ask for the supplier, amount, and due date." },
  { command: "/cash", label: "Cash position and forecast", prompt: "Give me the cash position, the 13-week forecast, and the three largest risks to runway." },
  { command: "/report", label: "Explain a change", prompt: "Explain what changed in revenue and expenses this month, with the biggest contributing invoices and bills." },
  { command: "/brief", label: "Brief me on my queue", prompt: "Give me a short brief of what needs my attention today and what you recommend I do first." },
  { command: "/reorder", label: "Prepare a reorder plan", prompt: "Review stock at or below its reorder point and prepare a replenishment plan for my approval." },
  { command: "/approvals", label: "Summarize pending approvals", prompt: "Summarize the approvals waiting on me, the risk, and your recommendation for each." },
  { command: "/notifications", label: "Review notifications", prompt: "Review my recent notifications, unread first, and tell me what actually needs a response." },
  { command: "/views", label: "Review saved views", prompt: "Show my saved customer views and explain what each one filters." },
];

function relativeTime(value: string): string {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const CHAT_NEW_EVENT = "chaste:new-conversation";

export function ChatPage({ organizationId = null, actorId = null, userName = null }: { organizationId?: string | null; actorId?: string | null; userName?: string | null }) {
  const { messages, busy, creator, creatorAvailable, queue, step, lastTool, sessionUsage, sessionId, sessionTitle, resumed } = useChat();
  const [input, setInput] = useState("");
  const [sources, setSources] = useState<ChatAttachment[]>([]);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceQuery, setSourceQuery] = useState("");
  const [sourceGroups, setSourceGroups] = useState<RecordSearchGroup[]>([]);
  const [sourceState, setSourceState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [sourceUploading, setSourceUploading] = useState(false);
  const [sourceUploadError, setSourceUploadError] = useState<string | null>(null);
  const [confirmNew, setConfirmNew] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [recentRuns, setRecentRuns] = useState<AgentSession[] | null>(null);
  const [recentRunsError, setRecentRunsError] = useState(false);
  const [sessionReady, setSessionReady] = useState(!organizationId || !actorId);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const promptAppliedRef = useRef(false);
  const scrollRef = useAutoScroll(messages);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    void refreshChatCreatorAvailability();
  }, []);

  useEffect(() => {
    if (!organizationId || !actorId) {
      setSessionReady(true);
      return;
    }
    let cancelled = false;
    const requested = readChatSessionParam();
    setSessionReady(false);
    setResumeError(null);
    const restore = requested
      ? resumeChat(requested, { organizationId, userId: actorId }).then(() => { clearChatSessionParam(); })
      : restoreChatSession(organizationId, actorId).then(() => undefined);
    void restore.catch(() => {
      if (cancelled) return;
      setResumeError(requested ? "That conversation could not be reopened. Start a new one or open Agent runs to replay it." : null);
    }).finally(() => {
      if (!cancelled) setSessionReady(true);
    });
    return () => { cancelled = true; };
  }, [actorId, organizationId]);

  useEffect(() => {
    if (!organizationId) return;
    const controller = new AbortController();
    setRecentRuns(null);
    setRecentRunsError(false);
    void fetchSessions(controller.signal)
      .then((sessions) => { if (!controller.signal.aborted) setRecentRuns(sessions.slice(0, 4)); })
      .catch(() => { if (!controller.signal.aborted) setRecentRunsError(true); });
    return () => controller.abort();
  }, [organizationId]);

  useEffect(() => {
    if (!sessionReady || promptAppliedRef.current) return;
    const prompt = readChatPrompt();
    if (!prompt) return;
    promptAppliedRef.current = true;
    clearChatPromptFromUrl();
    const current = chatStore.getState();
    if (!current.busy && current.messages.length === 1) {
      void chatStore.send(prompt);
    } else {
      setInput(prompt);
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".chat-composer textarea")?.focus());
    }
  }, [sessionReady]);

  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    function onNewConversation() {
      if (messagesRef.current.length > 1) setConfirmNew(true);
      else resetChat();
    }
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.key.toLowerCase() === "n" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        if (messagesRef.current.length > 1) setConfirmNew(true);
        else resetChat();
      }
    }
    window.addEventListener(CHAT_NEW_EVENT, onNewConversation);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener(CHAT_NEW_EVENT, onNewConversation);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    const element = document.querySelector<HTMLTextAreaElement>(".chat-composer textarea");
    inputRef.current = element;
  }, []);

  useEffect(() => {
    if (!sourceOpen || sourceQuery.trim().length < 2) {
      setSourceGroups([]);
      setSourceState("idle");
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSourceState("loading");
      void searchRecords(sourceQuery, controller.signal)
        .then((groups) => {
          if (controller.signal.aborted) return;
          setSourceGroups(groups);
          setSourceState("ready");
        })
        .catch(() => {
          if (!controller.signal.aborted) setSourceState("failed");
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [sourceOpen, sourceQuery]);

  function addSource(type: string, id: string, title: string) {
    if (!["customer", "vendor", "item", "invoice", "bill", "document", "project"].includes(type)) return;
    setSources((current) => current.some((source) => source.type === type && source.id === id) || current.length >= 5
      ? current
      : [...current, { type: type as ChatAttachment["type"], id, title }]);
    setSourceQuery("");
    setSourceGroups([]);
    setSourceState("idle");
  }

  async function uploadSource(file: File) {
    if (!actorId || !organizationId) {
      setSourceUploadError("Wait for your account and organization to finish loading before attaching a file.");
      return;
    }
    setSourceUploading(true);
    setSourceUploadError(null);
    try {
      const outcome = await createIngestedDocument({ title: file.name, file }, { actorId, organizationId });
      if (outcome.kind === "completed") {
        addSource("document", outcome.documentId, file.name);
      } else {
        setSourceUploadError(outcome.hint);
      }
    } catch (error) {
      setSourceUploadError(error instanceof DocumentsIngestApiError ? error.message : "The file could not be attached.");
    } finally {
      setSourceUploading(false);
    }
  }

  function submit() {
    const text = input.trim();
    if (!text) return;
    const exactCommand = COMMANDS.find((command) => command.command === text.toLowerCase());
    const attached = sources;
    setInput("");
    setSources([]);
    setCommandsOpen(false);
    setSourceOpen(false);
    void chatStore.send(exactCommand ? exactCommand.prompt : text, attached);
  }

  function startNewConversation() {
    resetChat();
    clearChatSessionParam();
    setConfirmNew(false);
    setInput("");
    setResumeError(null);
    toast({ title: "New conversation", description: "The previous thread remains available in Agent runs.", tone: "success" });
  }

  function usePrompt(prompt: string) {
    setInput(prompt);
    setCommandsOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function copyTranscript() {
    const transcript = messages
      .map((message) => `${message.role === "user" ? "You" : "Workmate"}: ${message.text}`)
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(transcript);
      toast({ title: "Transcript copied", description: "The visible conversation is on your clipboard.", tone: "success" });
    } catch {
      toast({ title: "Could not copy", description: "Clipboard access was blocked by the browser.", tone: "danger" });
    }
  }

  const sessionTokens = sessionUsage.input + sessionUsage.output;
  const showUsageFooter = sessionTokens > 0 || sessionUsage.cachedInput > 0;
  const empty = !sessionId && messages.length <= 1;
  const commandQuery = input.startsWith("/") && !input.includes(" ") ? input.toLowerCase() : "";
  const matchingCommands = commandQuery ? COMMANDS.filter((command) => command.command.startsWith(commandQuery)) : COMMANDS;
  const showCommandMenu = commandsOpen || (commandQuery.length > 0 && matchingCommands.length > 0);

  return (
    <main className="chat-page">
      <div className="chat-shell">
        <section className="chat-page-panel" aria-label="Workmate conversation">
          <header className="chat-page-head">
            <div className="chat-head-identity">
              <BrandMark variant="gold" size="sm" />
              <div>
                <p className="section-kicker">Your workmate</p>
                <h1>Workmate</h1>
                <p className="chat-page-copy">Ask about the books, plan a change, or tell me what to do. Every action is governed and reversible.</p>
              </div>
            </div>
            <div className="chat-page-controls">
              {creatorAvailable && (
                <button
                  type="button"
                  role="switch"
                  aria-label="Creator mode"
                  aria-checked={creator}
                  className={`chat-creator-switch${creator ? " chat-creator-switch-on" : ""}`}
                  title="Let the workmate propose new capabilities, not just use existing ones"
                  onClick={() => setChatCreator(!creator)}
                >
                  <span className="chat-creator-track" aria-hidden="true"><span className="chat-creator-thumb" /></span>
                  Creator
                </button>
              )}
              <Button variant="ghost" size="sm" onClick={() => void copyTranscript()} disabled={messages.length <= 1} title="Copy the visible conversation">
                <Clipboard size={13} aria-hidden="true" /> Copy
              </Button>
              <Button variant="secondary" size="sm" onClick={() => messages.length > 1 ? setConfirmNew(true) : startNewConversation()}>
                <SquarePen size={13} aria-hidden="true" /> New
              </Button>
            </div>
          </header>

          <div className="chat-context-bar">
            <span className="chat-context-pill"><ShieldCheck size={12} aria-hidden="true" /> Governed path</span>
            <span className="chat-context-pill"><span className={`chat-live-dot${busy ? " is-busy" : ""}`} aria-hidden="true" /> {busy ? "Working" : "Ready"}</span>
            {sessionTokens > 0 && <button type="button" className="chat-context-pill chat-context-button" onClick={() => setShowContext((current) => !current)}><Sparkles size={12} aria-hidden="true" /> {formatTokens(sessionTokens)} tokens</button>}
            <span className="chat-context-spacer" />
            {busy && step && <span className="chat-step-pill">step {step.step}/{step.maxSteps}{lastTool ? ` · ${formatToolName(lastTool)}` : ""}</span>}
          </div>

          {resumeError && (
            <div className="chat-resume-bar chat-resume-bar-error" role="alert">
              <RotateCcw size={13} aria-hidden="true" />
              <span>{resumeError}</span>
              <a href="/sessions">Agent runs</a>
            </div>
          )}
          {sessionId && resumed && !resumeError && (
            <div className="chat-resume-bar" role="status">
              <RotateCcw size={13} aria-hidden="true" />
              <span>Continuing <strong>{sessionTitle || "saved conversation"}</strong></span>
              <a href={`/sessions?session=${encodeURIComponent(sessionId)}`}>View replay</a>
              <button type="button" onClick={() => messages.length > 1 ? setConfirmNew(true) : startNewConversation()}>Start new</button>
            </div>
          )}

          {showContext && (
            <div className="chat-context-panel">
              <div><span>Session context</span><strong>{formatTokens(sessionUsage.input)} in · {formatTokens(sessionUsage.output)} out</strong></div>
              {sessionUsage.cachedInput > 0 && <div><span>Provider cache</span><strong>{formatTokens(sessionUsage.cachedInput)} cached</strong></div>}
              <a href="/ledger">Every tool call is in the ledger <ArrowUpRight size={11} aria-hidden="true" /></a>
            </div>
          )}

          <div ref={scrollRef} className="chat-page-scroll">
            {empty ? (
              <div className="chat-welcome">
                <div className="chat-welcome-mark"><BrandMark variant="gold" size="lg" /></div>
                <p className="chat-welcome-eyebrow">Good to see you{userName ? `, ${userName.split(" ")[0]}` : ""}</p>
                <h2>What should we move forward?</h2>
                <p className="chat-welcome-copy">Hi, I'm your business workmate. Ask about the books, start a plan, or hand me a job. I show the evidence and stop for your authority when it matters.</p>
                <div className="chat-starters" aria-label="Suggested prompts">
                  {STARTER_PROMPTS.map((starter) => {
                    const Icon = starter.icon;
                    return (
                      <button key={starter.label} type="button" className="chat-starter" onClick={() => usePrompt(starter.prompt)}>
                        <span className="chat-starter-icon"><Icon size={15} aria-hidden="true" /></span>
                        <span className="chat-starter-copy"><span>{starter.group}</span><strong>{starter.label}</strong></span>
                        <ArrowUpRight size={13} className="chat-starter-arrow" aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
                <div className="chat-welcome-foot">
                  <span><ShieldCheck size={12} aria-hidden="true" /> Human approval above policy</span>
                  <span><BookOpenCheck size={12} aria-hidden="true" /> Full audit trail</span>
                  <span><RotateCcw size={12} aria-hidden="true" /> Reversible corrections</span>
                </div>
              </div>
            ) : (
              <MessageList messages={messages} busy={busy} organizationId={organizationId} />
            )}
          </div>

          {busy && (
            <div className="chat-console-strip" role="status">
              <span className="chat-strip-light" aria-hidden="true" />
              <span className="chat-strip-working">working</span>
              {step && <span>step {step.step}/{step.maxSteps}</span>}
              {lastTool && <span className="chat-strip-tool">{formatToolName(lastTool)}</span>}
              <span className="chat-strip-tokens">{formatTokens(sessionTokens)} tok</span>
            </div>
          )}

          {queue.length > 0 && (
            <div className="chat-queue" aria-label="Queued messages">
              <span className="chat-queue-label">queued</span>
              {queue.map((queued, index) => (
                <span key={`${index}:${queued}`} className="chat-queue-chip">
                  <span className="chat-queue-text">{queued}</span>
                  <button type="button" onClick={() => chatStore.removeQueued(index)} aria-label={`Remove queued message: ${queued}`}>×</button>
                </span>
              ))}
            </div>
          )}

          <div className="chat-page-composer">
            {showCommandMenu && (
              <div className="chat-command-menu" role="listbox" aria-label="Workmate commands">
                <div className="chat-command-head"><CommandIcon size={12} aria-hidden="true" /> Commands <span>Type to filter</span></div>
                {matchingCommands.length === 0 ? (
                  <p className="chat-command-empty">No command matches “{input}”. Press Enter to send it as a message.</p>
                ) : matchingCommands.map((command) => (
                  <button
                    key={command.command}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="chat-command-item"
                    onClick={() => usePrompt(command.prompt)}
                  >
                    <code>{command.command}</code><span>{command.label}</span><CornerDownLeft size={12} aria-hidden="true" />
                  </button>
                ))}
              </div>
            )}
            {(sources.length > 0 || sourceOpen) && (
              <div className="chat-source-panel">
                <div className="chat-source-panel-head">
                  <strong><Paperclip size={11} aria-hidden="true" /> Sources</strong>
                  <span>{sources.length}/5 attached for this turn</span>
                  <button type="button" aria-label="Close sources" onClick={() => { setSourceOpen(false); setSourceQuery(""); }}><X size={12} /></button>
                </div>
                {sources.length > 0 && (
                  <div className="chat-source-selected">
                    {sources.map((source) => (
                      <span key={`${source.type}:${source.id}`}>
                        {source.title}
                        <button type="button" aria-label={`Remove ${source.title}`} onClick={() => setSources((current) => current.filter((item) => !(item.type === source.type && item.id === source.id)))}><X size={10} /></button>
                      </span>
                    ))}
                  </div>
                )}
                <label className="chat-source-search">
                  <Search size={12} aria-hidden="true" />
                  <span className="sr-only">Search records to attach</span>
                  <input
                    autoFocus
                    value={sourceQuery}
                    onChange={(event) => setSourceQuery(event.currentTarget.value)}
                    placeholder="Search customers, invoices, documents…"
                    maxLength={120}
                  />
                </label>
                <label className="chat-source-upload">
                  <input
                    type="file"
                    accept="application/pdf,image/*"
                    disabled={sourceUploading}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (file) void uploadSource(file);
                    }}
                  />
                  {sourceUploading ? "Adding file to documents…" : "Attach a PDF or image"}
                </label>
                {sourceUploadError && <p className="chat-source-empty" role="alert">{sourceUploadError}</p>}
                {sourceState === "loading" && <p className="chat-source-empty" role="status">Searching records…</p>}
                {sourceState === "failed" && <p className="chat-source-empty" role="alert">Record search is unavailable. Try again.</p>}
                {sourceState === "ready" && sourceGroups.length === 0 && <p className="chat-source-empty">No matching records. Try a name, number, or document title.</p>}
                {sourceGroups.length > 0 && (
                  <div className="chat-source-results">
                    {sourceGroups.map((group) => (
                      <div key={group.type}>
                        <span>{group.label}</span>
                        {group.items.slice(0, 4).map((item) => (
                          <button type="button" key={item.id} onClick={() => addSource(group.type, item.id, item.title)}>
                            <strong>{item.title}</strong>
                            {item.subtitle && <small>{item.subtitle}</small>}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <ChatComposer
              value={input}
              onChange={setInput}
              onSend={submit}
              onStop={() => chatStore.stop()}
              busy={busy}
              autoFocus
            />
            <div className="chat-page-composer-meta">
              <span className="chat-key-hint">
                <button type="button" className="chat-command-trigger" onClick={() => { setCommandsOpen((open) => !open); setInput((current) => current || "/"); }}>
                  <CommandIcon size={11} aria-hidden="true" /> Commands
                </button>
                <button type="button" className={`chat-command-trigger${sourceOpen ? " is-active" : ""}`} onClick={() => setSourceOpen((open) => !open)} aria-expanded={sourceOpen}>
                  <Paperclip size={11} aria-hidden="true" /> Sources{sources.length > 0 ? ` · ${sources.length}` : ""}
                </button>
                <span><Kbd>⏎</Kbd> send · <Kbd>⇧⏎</Kbd> newline</span>
              </span>
              {showUsageFooter && (
                <span className="chat-usage-footer" aria-label="Session token usage">
                  <span className="chat-usage-live" aria-hidden="true" /> this session: in {formatTokens(sessionUsage.input)} · out {formatTokens(sessionUsage.output)}
                  {sessionUsage.cachedInput > 0 && ` · ${Math.min(100, Math.round((sessionUsage.cachedInput / Math.max(1, sessionUsage.input)) * 100))}% cached`}
                </span>
              )}
            </div>
          </div>
        </section>

        <aside className="chat-side" aria-label="Workmate context">
          <section className="chat-side-card chat-side-session">
            <div className="chat-side-head"><span>Session</span><span className={`chat-live-dot${busy ? " is-busy" : ""}`} aria-hidden="true" /></div>
            <dl>
              <div><dt>Mode</dt><dd>{creator ? "Creator" : "Assist"}</dd></div>
              <div><dt>Thread</dt><dd>{resumed ? "Continued" : "New"}</dd></div>
              <div><dt>Authority</dt><dd>Governed</dd></div>
              <div><dt>Context used</dt><dd>{formatTokens(sessionTokens) || "0"}</dd></div>
            </dl>
            <div className="chat-side-actions">
              <a href="/approvals">Approvals <ArrowUpRight size={11} aria-hidden="true" /></a>
              <a href="/sessions">Agent runs <ArrowUpRight size={11} aria-hidden="true" /></a>
            </div>
          </section>
          <section className="chat-side-card">
            <div className="chat-side-head"><span>Try next</span></div>
            <div className="chat-side-links">
              {STARTER_PROMPTS.slice(0, 4).map((starter) => (
                <button key={starter.label} type="button" onClick={() => usePrompt(starter.prompt)}>{starter.label}<ArrowUpRight size={11} aria-hidden="true" /></button>
              ))}
            </div>
          </section>
          <section className="chat-side-card">
            <div className="chat-side-head"><span>Recent runs</span><a href="/sessions">All runs</a></div>
            {recentRuns === null && !recentRunsError ? (
              <div className="chat-recent-skeleton" aria-hidden="true"><span /><span /><span /></div>
            ) : recentRunsError ? (
              <p className="chat-recent-empty">Run history is unavailable.</p>
            ) : recentRuns && recentRuns.length === 0 ? (
              <p className="chat-recent-empty">Your first run will appear here.</p>
            ) : (
              <div className="chat-recent-runs">
                {recentRuns?.map((run) => (
                  <a
                    key={run.id}
                    className="chat-recent-run"
                    href={`/chat?session=${encodeURIComponent(run.id)}`}
                    title="Continue this conversation"
                  >
                    <span className="chat-recent-run-title">{run.title || "Untitled run"}</span>
                    <span className="chat-recent-run-meta">{run.status.replace(/_/g, " ")} · {relativeTime(run.createdAt)} · continue</span>
                  </a>
                ))}
              </div>
            )}
          </section>
          <section className="chat-side-note">
            <ShieldCheck size={15} aria-hidden="true" />
            <p><strong>You stay in control.</strong> The workmate can read and propose on its own. Money above your threshold, identity changes, and destructive actions wait for a person.</p>
          </section>
        </aside>
      </div>

      <Dialog open={confirmNew} onOpenChange={setConfirmNew}>
        <DialogContent>
          <DialogTitle>Start a new conversation?</DialogTitle>
          <DialogDescription>This clears the current thread from the screen. It stays available in Agent runs with its full trajectory.</DialogDescription>
          <div className="chat-confirm-actions">
            <Button variant="secondary" onClick={() => setConfirmNew(false)}>Keep this thread</Button>
            <Button variant="primary" onClick={startNewConversation}><Plus size={14} aria-hidden="true" /> Start new</Button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
