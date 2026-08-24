"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, EmptyState, LoadingPage, PageHeader } from "@/components/ui";
import { IconAlertTriangle, IconBot, IconChevronLeft, IconPlus, IconSend, IconX } from "@/components/icons";
import { cn, timeAgo } from "@/lib/format";
import { callApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";

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
          <Button tone="primary" onClick={openNewConversation}>
            <IconPlus className="size-4" />
            New conversation
          </Button>
        }
      />

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
              className="input mb-3"
            >
              {customerOptions.length === 0 && <option value="">No customers yet</option>}
              {customerOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.email ? ` (${c.email})` : ""}
                </option>
              ))}
            </select>
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
    </div>
  );
}
