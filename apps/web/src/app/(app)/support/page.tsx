"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, EmptyState, LoadingPage, PageHeader } from "@/components/ui";
import { IconAlertTriangle, IconBot, IconChevronLeft, IconPlus, IconSend, IconX } from "@/components/icons";
import { cn, timeAgo } from "@/lib/format";
import { callApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";
import { postApi } from "@/lib/api";

interface ConversationRow {
  id: string;
  customerId: string;
  customerName: string;
  subject: string;
  status: string;
  lastMessageAt: string | null;
  lastMessagePreview: string;
}
interface SupportMessage {
  id: string;
  senderType: string;
  body: string;
  createdAt: string;
}
interface CustomerOption {
  id: string;
  name: string;
  email: string | null;
}

const STATUS_TONE: Record<string, "neutral" | "amber" | "green"> = {
  open: "neutral",
  escalated: "amber",
  resolved: "green",
};

const SENDER_LABEL: Record<string, string> = {
  customer: "Customer",
  staff: "Staff",
  agent: "AI (released)",
  system: "System",
};

export default function SupportPage() {
  const __enabled = useModuleEnabled("support");
  const [convs, setConvs] = useState<ConversationRow[] | null>(null);
  const [showChannels, setShowChannels] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [conv, setConv] = useState<ConversationRow | null>(null);
  const [msgs, setMsgs] = useState<SupportMessage[]>([]);
  const [composer, setComposer] = useState("");
  const [fromCustomer, setFromCustomer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newSubject, setNewSubject] = useState("");
  const [customerOptions, setCustomerOptions] = useState<CustomerOption[]>([]);
  const [newCustomerId, setNewCustomerId] = useState("");
  const [quickCustomer, setQuickCustomer] = useState({ open: false, name: "", email: "" });
  const threadRef = useRef<HTMLDivElement>(null);

  const loadConvs = useCallback(async () => {
    const res = await callApi<{ conversations?: ConversationRow[] }>("/api/support");
    if (!res.ok) {
      setError(res.error?.title ?? "Couldn't load conversations");
      return;
    }
    const list = res.data?.conversations ?? [];
    setConvs(list);
    setActiveId((cur) => cur ?? list[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void loadConvs();
  }, [loadConvs]);

  const loadThread = useCallback(async (id: string) => {
    const res = await callApi<{ conversation: ConversationRow; messages: SupportMessage[] }>(
      `/api/support?id=${id}`,
    );
    if (res.ok && res.data) {
      setConv(res.data.conversation);
      setMsgs(res.data.messages);
    }
  }, []);

  useEffect(() => {
    if (activeId) void loadThread(activeId);
  }, [activeId, loadThread]);

  useEffect(() => {
    requestAnimationFrame(() => threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight }));
  }, [msgs, draft]);

  async function act(body: Record<string, unknown>) {
    setError(null);
    return callApi<{ ok?: boolean; data?: unknown }>("/api/support", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function postMessage() {
    if (!activeId || !composer.trim()) return;
    setBusy(true);
    const res = await act({ action: "message", conversationId: activeId, body: composer.trim(), from: fromCustomer ? "customer" : "staff" });
    setBusy(false);
    if (!res.ok) {
      setError(res.error?.hint ?? res.error?.title ?? "Couldn't add message");
      return;
    }
    setComposer("");
    await loadThread(activeId);
    await loadConvs();
  }

  async function makeDraft() {
    if (!activeId) return;
    setDrafting(true);
    setDraft(null);
    setError(null);
    const res = await act({ action: "draft", conversationId: activeId });
    setDrafting(false);
    if (!res.ok) {
      setError(res.error?.hint ?? res.error?.title ?? "Draft failed");
      return;
    }
    setDraft((res.data as { draft?: string })?.draft ?? "");
  }

  async function sendDraft() {
    if (!activeId || !draft?.trim()) return;
    setBusy(true);
    const res = await act({ action: "send", conversationId: activeId, body: draft.trim() });
    setBusy(false);
    if (!res.ok) {
      setError(res.error?.hint ?? res.error?.title ?? "Couldn't send");
      return;
    }
    setDraft(null);
    await loadThread(activeId);
    await loadConvs();
  }

  async function transition(action: "escalate" | "resolve") {
    if (!activeId) return;
    const reason =
      action === "escalate"
        ? (window.prompt("Why does this need a human owner?") ?? "").trim()
        : undefined;
    if (action === "escalate" && !reason) return;
    setBusy(true);
    const res = await act(
      action === "escalate"
        ? { action, conversationId: activeId, reason }
        : { action, conversationId: activeId },
    );
    setBusy(false);
    if (!res.ok) {
      setError(res.error?.hint ?? res.error?.title ?? "Couldn't update");
      return;
    }
    await loadThread(activeId);
    await loadConvs();
  }

  async function openNewConversation() {
    setNewOpen(true);
    setNewSubject("");
    const res = await callApi<{ customers?: CustomerOption[] }>("/api/customers");
    const options = res.data?.customers ?? [];
    setCustomerOptions(options);
    setNewCustomerId(options[0]?.id ?? "");
  }

  async function createCustomerHere() {
    if (!quickCustomer.name.trim()) return;
    setBusy(true);
    const res = await postApi<{ customerId?: string }>("/api/customers", {
      action: "create",
      name: quickCustomer.name.trim(),
      email: quickCustomer.email.trim() || undefined,
    });
    setBusy(false);
    if (!res.ok || !res.data?.customerId) {
      setError(res.error?.title ?? "Couldn't create the customer");
      return;
    }
    const created: CustomerOption = {
      id: res.data.customerId,
      name: quickCustomer.name.trim(),
      email: quickCustomer.email.trim() || null,
    };
    setCustomerOptions((opts) => [...opts, created]);
    setNewCustomerId(created.id);
    setQuickCustomer({ open: false, name: "", email: "" });
  }

  async function createConversation() {
    if (!newCustomerId || !newSubject.trim()) return;
    setBusy(true);
    const res = await act({ action: "create", customerId: newCustomerId, subject: newSubject.trim() });
    setBusy(false);
    if (!res.ok) {
      setError(res.error?.hint ?? res.error?.title ?? "Couldn't create conversation");
      return;
    }
    const data = res.data as { conversationId?: string };
    setNewOpen(false);
    await loadConvs();
    if (data?.conversationId) setActiveId(data.conversationId);
  }

  if (!convs) return <LoadingPage />;

  if (!__enabled) return <ModuleDisabled label="Customer care" />;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Customer care"
        description="Answer inbound inquiries with AI-drafted replies. Drafts never reach the customer until a human sends them."
        actions={
          <>
            <Button tone={showChannels ? "primary" : "secondary"} onClick={() => setShowChannels((v) => !v)}>
              Website widget
            </Button>
            <Button tone="primary" onClick={openNewConversation}>
              <IconPlus className="size-4" />
              New conversation
            </Button>
          </>
        }
      />

      {showChannels ? (
        <ChannelsPanel />
      ) : (
        <>
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 p-4 pt-0 lg:grid-cols-[320px_1fr]">
        {/* Inbox list */}
        <aside className="min-h-0 overflow-y-auto rounded-xl border border-stone-200 bg-white shadow-xs">
          {convs.length === 0 ? (
            <EmptyState
              icon={<IconAlertTriangle className="size-5" />}
              title="No conversations yet"
              hint="Open one per customer inquiry so every answer stays on the record."
            />
          ) : (
            <ul className="divide-y divide-stone-100">
              {convs.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveId(c.id);
                      setDraft(null);
                    }}
                    className={cn(
                      "w-full cursor-pointer px-4 py-3 text-left transition-colors hover:bg-stone-50",
                      activeId === c.id && "bg-stone-100/80",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-stone-900">{c.customerName}</span>
                      <Badge tone={STATUS_TONE[c.status] ?? "neutral"}>{c.status}</Badge>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-stone-500">{c.subject}</p>
                    <p className="mt-1 truncate text-xs text-stone-400">{c.lastMessagePreview || "\u00A0"}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* Thread */}
        <section className="flex min-h-0 flex-col rounded-xl border border-stone-200 bg-white shadow-xs">
          {!conv ? (
            <div className="flex flex-1 items-center justify-center p-6 text-sm text-stone-400">
              Pick a conversation
            </div>
          ) : (
            <>
              <header className="flex items-center justify-between border-b border-stone-100 px-5 py-3">
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold text-stone-900">
                    {conv.customerName}
                    <span className="ml-2 font-normal text-stone-500">{conv.subject}</span>
                  </h2>
                  <Badge tone={STATUS_TONE[conv.status] ?? "neutral"}>{conv.status}</Badge>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    onClick={makeDraft}
                    loading={drafting}
                    disabled={conv.status === "resolved"}
                    title="AI drafts; you decide"
                  >
                    <IconBot className="size-4" />
                    Draft reply
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => transition("escalate")}
                    disabled={busy || conv.status !== "open"}
                  >
                    Escalate
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => transition("resolve")}
                    disabled={busy || conv.status === "resolved"}
                  >
                    Resolve
                  </Button>
                </div>
              </header>

              {error && (
                <p className="border-b border-red-100 bg-red-50 px-5 py-2 text-xs text-red-700">{error}</p>
              )}

              <div ref={threadRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
                {msgs.map((m) => (
                  <div key={m.id} className={cn("flex", m.senderType === "customer" ? "justify-start" : "justify-end")}>
                    <div className="max-w-[80%]">
                      <div className="mb-0.5 flex items-baseline gap-2 text-[11px] text-stone-400">
                        <span>{SENDER_LABEL[m.senderType] ?? m.senderType}</span>
                        <span>{timeAgo(m.createdAt)}</span>
                      </div>
                      <div
                        className={cn(
                          "rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap",
                          m.senderType === "customer" && "rounded-bl-md bg-stone-100 text-stone-800",
                          m.senderType === "staff" && "rounded-br-md bg-maroon-700 text-white",
                          m.senderType === "agent" && "rounded-br-md bg-maroon-100 text-maroon-950",
                          m.senderType === "system" && "bg-transparent px-0 py-0 text-xs text-stone-400",
                        )}
                      >
                        {m.body}
                      </div>
                    </div>
                  </div>
                ))}
                {draft != null && (
                  <div className="flex justify-end">
                    <div className="w-full max-w-[85%] rounded-xl border border-maroon-200 bg-maroon-50/60 p-3">
                      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-maroon-700">
                        AI draft — review before sending
                      </p>
                      <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        rows={Math.min(8, Math.ceil(draft.length / 60) + 1)}
                        className="w-full resize-none rounded-lg border border-stone-200 bg-white p-2 text-sm outline-none focus:border-maroon-500"
                      />
                      <div className="mt-2 flex justify-end gap-2">
                        <Button size="sm" onClick={() => setDraft(null)}>
                          <IconX className="size-3.5" />
                          Discard
                        </Button>
                        <Button size="sm" tone="primary" onClick={sendDraft} disabled={busy}>
                          <IconSend className="size-3.5" />
                          Send to customer
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <footer className="border-t border-stone-100 p-3">
                <div className="flex items-end gap-2">
                  <label className="flex cursor-pointer items-center gap-1.5 pb-2 text-xs text-stone-500">
                    <input
                      type="checkbox"
                      checked={fromCustomer}
                      onChange={(e) => setFromCustomer(e.target.checked)}
                      className="accent-maroon-700"
                    />
                    Log as customer&apos;s words
                  </label>
                  <textarea
                    value={composer}
                    onChange={(e) => setComposer(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void postMessage();
                      }
                    }}
                    rows={1}
                    placeholder="Log what the customer wrote, or write the staff reply…"
                    className="max-h-32 flex-1 resize-none rounded-xl border border-stone-200 p-2 text-sm outline-none focus:border-maroon-500"
                  />
                  <Button tone="primary" onClick={postMessage} disabled={busy || !composer.trim()}>
                    <IconSend className="size-4" />
                  </Button>
                </div>
              </footer>
            </>
          )}
        </section>
      </div>

      {newOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-lg">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-semibold text-stone-900">New support conversation</h3>
              <button type="button" onClick={() => setNewOpen(false)} className="cursor-pointer text-stone-400 hover:text-stone-700">
                <IconX className="size-4" />
              </button>
            </div>
            <label htmlFor="support-customer" className="label">Customer</label>
            <select
              id="support-customer"
              value={newCustomerId}
              onChange={(e) => setNewCustomerId(e.target.value)}
              className="input mb-2"
            >
              {customerOptions.length === 0 && <option value="">No customers yet</option>}
              {customerOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.email ? ` (${c.email})` : ""}
                </option>
              ))}
            </select>
            {!quickCustomer.open ? (
              <button
                type="button"
                onClick={() => setQuickCustomer({ open: true, name: "", email: "" })}
                className="mb-3 cursor-pointer text-xs font-medium text-maroon-700 underline underline-offset-2 hover:text-maroon-900"
              >
                + New customer
              </button>
            ) : (
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 p-2">
                <input
                  aria-label="New customer name"
                  placeholder="Customer name"
                  className="min-w-32 flex-1 rounded border bg-transparent px-2 py-1.5 text-sm"
                  value={quickCustomer.name}
                  onChange={(e) => setQuickCustomer({ ...quickCustomer, name: e.target.value })}
                />
                <input
                  aria-label="New customer email"
                  placeholder="Email (optional)"
                  className="w-40 rounded border bg-transparent px-2 py-1.5 text-sm"
                  value={quickCustomer.email}
                  onChange={(e) => setQuickCustomer({ ...quickCustomer, email: e.target.value })}
                />
                <Button size="sm" disabled={busy || !quickCustomer.name.trim()} onClick={() => void createCustomerHere()}>
                  Save &amp; use
                </Button>
              </div>
            )}
            <label htmlFor="support-subject" className="label">What is this about?</label>
            <input
              id="support-subject"
              value={newSubject}
              onChange={(e) => setNewSubject(e.target.value)}
              placeholder="Invoice question, refund request…"
              className="input mb-4"
              maxLength={200}
            />
            <div className="flex justify-end gap-2">
              <Button onClick={() => setNewOpen(false)}>
                <IconChevronLeft className="size-4" />
                Cancel
              </Button>
              <Button tone="primary" onClick={createConversation} disabled={busy || !newCustomerId || !newSubject.trim()}>
                Open conversation
              </Button>
            </div>
          </div>
        </div>
      )}
        </>
      )}
    </div>
  );
}

/**
 * Zero-step setup for the website channel: the embed token is provisioned
 * on first load, the snippet is copyable, and AI behavior is one toggle.
 */
function ChannelsPanel() {
  const [state, setState] = useState<{ autoReplyEnabled: boolean; greeting: string; embedToken: string } | null>(null);
  const [greeting, setGreeting] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await callApi<{ autoReplyEnabled: boolean; greeting: string; embedToken: string }>("/api/support/channels");
      if (res.data) {
        setState(res.data);
        setGreeting(res.data.greeting);
      }
    })();
  }, []);

  if (!state) return <div className="p-4 text-sm text-stone-400">Loading channel settings…</div>;

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const snippet = `<script src="${origin}/widget.js" data-chaste="${state.embedToken}" async></script>`;
  const link = `${origin}/widget/${state.embedToken}`;

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    const res = await postApi<typeof state>("/api/support/channels", body);
    setBusy(false);
    if (res.ok && res.data) setState(res.data);
  }

  function copy(text: string, label: string) {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1600);
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 overflow-y-auto p-4">
      <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-xs">
        <h2 className="text-sm font-semibold text-stone-900">Put chat on your website</h2>
        <p className="mt-1 text-sm text-stone-500">
          Paste this into your marketing site before <code className="rounded bg-stone-100 px-1">&lt;/body&gt;</code>. A
          floating &ldquo;Chat with us&rdquo; bubble appears; conversations land in this inbox as customers.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-stone-950 p-3 text-[12px] leading-relaxed text-stone-100">{snippet}</pre>
        <div className="mt-2 flex items-center gap-2">
          <Button tone="secondary" size="sm" onClick={() => copy(snippet, "snippet")}>{copied === "snippet" ? "Copied ✓" : "Copy snippet"}</Button>
          <Button tone="ghost" size="sm" onClick={() => void patch({ regenerateToken: true })} disabled={busy}>
            Regenerate token…
          </Button>
        </div>
        <p className="mt-3 text-xs text-stone-500">
          Prefer a plain link? Share{" "}
          <button type="button" onClick={() => copy(link, "link")} className="font-medium text-maroon-700 underline underline-offset-2">
            {copied === "link" ? "copied ✓" : "the standalone chat page"}
          </button>{" "}
          anywhere — email signatures, social bios, help docs.
        </p>
      </section>

      <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-xs">
        <h2 className="text-sm font-semibold text-stone-900">AI behavior</h2>
        <label className="mt-3 flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={state.autoReplyEnabled}
            onChange={(e) => void patch({ autoReplyEnabled: e.target.checked })}
            disabled={busy}
            className="mt-0.5 size-4 accent-[#9b1313]"
          />
          <span className="text-sm text-stone-700">
            <strong className="font-medium">Answer visitors automatically.</strong>{" "}
            <span className="text-stone-500">
              Replies are grounded in your knowledge base and order history. When you turn this off — or a visitor asks
              for a human — the thread waits for staff and shows as needing you.
            </span>
          </span>
        </label>
        <label htmlFor="widget-greeting" className="mt-4 block text-sm font-medium text-stone-700">
          First message visitors see
        </label>
        <textarea
          id="widget-greeting"
          rows={2}
          value={greeting}
          maxLength={300}
          onChange={(e) => setGreeting(e.target.value)}
          className="mt-1 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm outline-none focus:border-stone-400"
        />
        <Button tone="secondary" size="sm" disabled={busy || !greeting.trim() || greeting === state.greeting} onClick={() => void patch({ greeting })} className="mt-2">
          Save greeting
        </Button>
      </section>

      <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-xs">
        <h2 className="text-sm font-semibold text-stone-900">What the AI can reach</h2>
        <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-stone-500">
          <li>Your knowledge base (Documents app)</li>
          <li>The asking customer&apos;s own order status — nothing about other customers</li>
          <li>Nothing else. Escalated threads are answered only by people.</li>
        </ul>
      </section>
    </div>
  );
}
