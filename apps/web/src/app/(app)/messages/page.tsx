"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, ConfirmDialog, Dialog, Notice, Switch } from "@/components/ui";
import { IconBot, IconChevronLeft, IconHash, IconPaperclip, IconPlus, IconSend, IconSettings, IconSmile, IconTrash, IconUser, IconX } from "@/components/icons";
import { cn, timeAgo } from "@/lib/format";
import { callApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";
import { AppFrame } from "../_shell/app-frame";

interface Conversation {
  id: string;
  kind: string;
  title: string;
  agentEnabled: boolean;
  archivedAt: string | null;
  createdByMe: boolean;
  lastMessage: { at: string; body: string } | null;
  unreadCount: number;
}
interface Message {
  id: string;
  senderType: string;
  senderUserId: string | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
  parentMessageId: string | null;
  pinnedAt: string | null;
  mentions?: { type: string; id: string }[] | null;
  attachments: { id: string; filename: string; mimeType: string; sizeBytes: number; href: string }[];
  reactions: { emoji: string; count: number; reactedByMe: boolean; names: string[] }[];
}
interface Person {
  type: "user" | "agent";
  id: string;
  name: string;
}

interface MessageReader {
  userId: string;
  name: string;
  lastReadAt: string | null;
}
interface PinnedMessage {
  id: string;
  body: string;
  pinnedAt: string;
}
interface ConversationPresence {
  userId: string;
  name: string;
  typing: boolean;
}
interface MessageSearchResult {
  id: string;
  conversationId: string;
  conversationTitle: string;
  body: string;
  createdAt: string;
  senderType: string;
  senderUserId: string | null;
}
interface PendingAttachment {
  key: string;
  file: File;
  attachmentId?: string;
}

const REACTIONS = ["👍", "❤️", "🎉", "✅", "👀"] as const;
const MESSAGE_EMOJIS = ["😀", "😁", "😂", "😊", "😍", "🙌", "👏", "🙏", "👍", "❤️", "🎉", "✅", "👀", "🔥", "🤔", "✨"] as const;

function dayLabel(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(date, today)) return "Today";
  if (sameDay(date, yesterday)) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(date);
}

function sameCalendarDay(a: string, b: string): boolean {
  const left = new Date(a);
  const right = new Date(b);
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

/** The composer inserts this short alias for the agent; it contains no spaces. */
const AGENT_ALIAS = "Chaste";

function personAlias(p: Person): string {
  return p.type === "agent" ? AGENT_ALIAS : p.name.split(" ")[0] ?? p.name;
}

/** Scans a draft for @aliases that resolve to real people/agents. */
function extractMentions(body: string, people: Person[]): { type: "user" | "agent"; id: string }[] {
  const lower = body.toLowerCase();
  const seen = new Map<string, { type: "user" | "agent"; id: string }>();
  for (const p of people) {
    const alias = personAlias(p).toLowerCase();
    if (alias && lower.includes(`@${alias}`) && !seen.has(p.id)) {
      seen.set(p.id, { type: p.type, id: p.id });
    }
  }
  return [...seen.values()];
}

/** Renders a message body with @mentions accented. */
function Body({ body }: { body: string }) {
  const parts = body.split(/(@[A-Za-z0-9_.-]+)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("@") ? (
          <span key={i} className="font-medium text-gold-700 underline decoration-gold-300 underline-offset-2">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

export default function MessagesPage() {
  const __enabled = useModuleEnabled("messaging");
  const [convs, setConvs] = useState<Conversation[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [readers, setReaders] = useState<MessageReader[]>([]);
  const [pinnedMessages, setPinnedMessages] = useState<PinnedMessage[]>([]);
  const [presence, setPresence] = useState<ConversationPresence[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [draftStatus, setDraftStatus] = useState<"saving" | "saved" | "unavailable">("saved");
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [reactionMenuId, setReactionMenuId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newAgent, setNewAgent] = useState(true);
  const [composerOpen, setComposerOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null);
  const [listFilter, setListFilter] = useState<"active" | "archived">("active");
  const [searchMode, setSearchMode] = useState<"conversations" | "messages">("conversations");
  const [searchText, setSearchText] = useState("");
  const [messageSearchResults, setMessageSearchResults] = useState<MessageSearchResult[]>([]);
  const [messageSearchBusy, setMessageSearchBusy] = useState(false);
  const [messageSearchError, setMessageSearchError] = useState<string | null>(null);
  const [memberQuery, setMemberQuery] = useState("");
  const [memberSearchResults, setMemberSearchResults] = useState<Person[]>([]);
  const [mobileListVisible, setMobileListVisible] = useState(true);
  const threadRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const autoScrollRef = useRef(false);
  const draftOwnerRef = useRef<string | null>(null);
  const aroundTargetRef = useRef<string | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [me, setMe] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [addUserId, setAddUserId] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState("");
  const [confirmDeleteConv, setConfirmDeleteConv] = useState(false);
  const [confirmDeleteMsg, setConfirmDeleteMsg] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const mentionCandidates =
    mentionQuery == null
      ? []
      : people.filter((p) => personAlias(p).toLowerCase().startsWith(mentionQuery.toLowerCase()));

  useEffect(() => {
    void callApi<{ people?: Person[] }>("/api/conversations/people").then((res) => {
      if (res.data?.people) setPeople(res.data.people);
    });
  }, []);

  /** Detects an @token immediately before the caret and opens the picker. */
  function syncMentionQuery() {
    const el = composerRef.current;
    if (!el) return;
    const upto = el.value.slice(0, el.selectionStart ?? el.value.length);
    const m = /@([A-Za-z0-9_.-]*)$/.exec(upto);
    if (m?.[1] != null) {
      setMentionQuery(m[1]);
      setMentionIndex(0);
    } else {
      setMentionQuery(null);
    }
  }

  function pickMention(p: Person) {
    const el = composerRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, caret).replace(/@[A-Za-z0-9_.-]*$/, `@${personAlias(p)} `);
    setDraft(before + el.value.slice(caret));
    setMentionQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      const pos = before.length;
      el.setSelectionRange(pos, pos);
    });
  }

  function insertEmoji(emoji: string) {
    const el = composerRef.current;
    if (!el) return;
    const start = el.selectionStart ?? draft.length;
    const end = el.selectionEnd ?? start;
    const next = `${el.value.slice(0, start)}${emoji}${el.value.slice(end)}`;
    const caret = start + emoji.length;
    setDraft(next);
    setMentionQuery(null);
    setEmojiPickerOpen(false);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }

  const activeConv = convs?.find((c) => c.id === activeId) ?? null;
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const draftStorageKey = useCallback((conversationId: string) => `chaste:message-draft:${me ?? "anonymous"}:${conversationId}`, [me]);

  const loadConvs = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await callApi<{ conversations?: Conversation[]; me?: string }>("/api/conversations");
      if (!res.ok) {
        setLoadError(res.error?.title ?? "Couldn't load conversations");
        setConvs(null);
        return;
      }
      const conversations = res.data?.conversations ?? [];
      setConvs(conversations);
      if (res.data?.me) setMe(res.data.me);
      setActiveId((cur) => {
        if (cur || !window.matchMedia("(min-width: 1024px)").matches) return cur;
        return conversations.find((c) => !c.archivedAt)?.id ?? null;
      });
    } catch {
      setLoadError("Couldn't connect to Messages");
      setConvs(null);
    }
  }, []);

  useEffect(() => {
    void loadConvs();
  }, [loadConvs]);

  const refreshThread = useCallback(async (
    conversationId: string,
    options: { aroundId?: string; showLoading?: boolean; scrollToBottom?: boolean; markRead?: boolean } = {},
  ) => {
    if (options.showLoading) setThreadLoading(true);
    try {
      const query = options.aroundId ? `?around=${encodeURIComponent(options.aroundId)}` : "";
      const response = await fetch(`/api/conversations/${conversationId}/messages${query}`, { cache: "no-store" });
      const data = (await response.json().catch(() => ({}))) as {
        messages?: Message[];
        readers?: MessageReader[];
        pinnedMessages?: PinnedMessage[];
        me?: string;
        hasMore?: boolean;
        nextCursor?: string | null;
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "Couldn't load this conversation");
      setMsgs(data.messages ?? []);
      setReaders(data.readers ?? []);
      setPinnedMessages(data.pinnedMessages ?? []);
      setHasOlder(Boolean(data.hasMore));
      setOlderCursor(data.nextCursor ?? null);
      setThreadError(null);
      if (options.scrollToBottom) autoScrollRef.current = true;
      const latestAt = data.messages?.at(-1)?.createdAt;
      const ownReadAt = data.readers?.find((reader) => reader.userId === data.me)?.lastReadAt;
      if (options.markRead && latestAt && (!ownReadAt || Date.parse(latestAt) > Date.parse(ownReadAt))) {
        void fetch(`/api/conversations/${conversationId}/read`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ readAt: latestAt }),
        }).then((response) => {
          if (response.ok) void loadConvs();
        }).catch(() => undefined);
      }
      return true;
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : "Couldn't load this conversation");
      return false;
    } finally {
      if (options.showLoading) setThreadLoading(false);
    }
  }, [loadConvs]);

  useEffect(() => {
    if (!activeId) {
      setMsgs([]);
      setReaders([]);
      setPinnedMessages([]);
      setPresence([]);
      setThreadLoading(false);
      setThreadError(null);
      return;
    }
    const aroundId = aroundTargetRef.current ?? undefined;
    aroundTargetRef.current = null;
    void refreshThread(activeId, { aroundId, showLoading: true, scrollToBottom: !aroundId, markRead: true });
    setMobileListVisible(false);
  }, [activeId, loadConvs, refreshThread]);

  useEffect(() => {
    if (!autoScrollRef.current) return;
    autoScrollRef.current = false;
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [msgs]);

  useEffect(() => {
    if (!activeId) {
      draftOwnerRef.current = null;
      setDraft("");
      return;
    }
    draftOwnerRef.current = activeId;
    try {
      setDraft(window.localStorage.getItem(draftStorageKey(activeId)) ?? "");
      setDraftStatus("saved");
    } catch {
      setDraftStatus("unavailable");
    }
  }, [activeId, draftStorageKey]);

  useEffect(() => {
    if (!activeId || draftOwnerRef.current !== activeId) return;
    setDraftStatus("saving");
    const timer = window.setTimeout(() => {
      try {
        if (draft.trim()) window.localStorage.setItem(draftStorageKey(activeId), draft);
        else window.localStorage.removeItem(draftStorageKey(activeId));
        setDraftStatus("saved");
      } catch {
        setDraftStatus("unavailable");
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [activeId, draft, draftStorageKey]);

  useEffect(() => {
    const textarea = composerRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 176)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 176 ? "auto" : "hidden";
  }, [draft]);

  useEffect(() => {
    if (!activeId) return;
    const timer = window.setTimeout(() => {
      void fetch(`/api/conversations/${activeId}/presence`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ typing: draft.trim().length > 0 }),
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [activeId, draft]);

  useEffect(() => {
    if (searchMode !== "messages" || searchText.trim().length < 2) {
      setMessageSearchResults([]);
      setMessageSearchError(null);
      setMessageSearchBusy(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setMessageSearchBusy(true);
      setMessageSearchError(null);
      fetch(`/api/messages/search?q=${encodeURIComponent(searchText.trim())}`, { cache: "no-store" })
        .then(async (response) => {
          const data = (await response.json().catch(() => ({}))) as { results?: MessageSearchResult[]; error?: string };
          if (!response.ok) throw new Error(data.error ?? "Message search failed");
          setMessageSearchResults(data.results ?? []);
        })
        .catch((error: unknown) => setMessageSearchError(error instanceof Error ? error.message : "Message search failed"))
        .finally(() => setMessageSearchBusy(false));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchMode, searchText]);

  useEffect(() => {
    if (!settingsOpen || !memberQuery.trim()) {
      setMemberSearchResults([]);
      return;
    }
    const timer = window.setTimeout(() => {
      fetch(`/api/conversations/people?q=${encodeURIComponent(memberQuery.trim())}`, { cache: "no-store" })
        .then((response) => response.json())
        .then((data: { people?: Person[] }) => setMemberSearchResults((data.people ?? []).filter((person) => person.type === "user")))
        .catch(() => setMemberSearchResults([]));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [memberQuery, settingsOpen]);

  useEffect(() => {
    if (!activeId) return;
    let stopped = false;
    const refreshPresence = async () => {
      if (document.visibilityState !== "visible") return;
      const response = await fetch(`/api/conversations/${activeId}/presence`, { cache: "no-store" }).catch(() => null);
      if (!response?.ok || stopped) return;
      const data = (await response.json().catch(() => ({}))) as { people?: ConversationPresence[] };
      setPresence(data.people ?? []);
    };
    const heartbeat = () => {
      if (document.visibilityState === "visible") {
        void fetch(`/api/conversations/${activeId}/presence`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ typing: false }),
        });
      }
    };
    void refreshPresence();
    heartbeat();
    const threadTimer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const panel = threadRef.current;
      const atBottom = Boolean(panel && panel.scrollHeight - panel.scrollTop - panel.clientHeight < 80);
      if (atBottom) autoScrollRef.current = true;
      void refreshThread(activeId, { markRead: atBottom });
      void refreshPresence();
    }, 5_000);
    const heartbeatTimer = window.setInterval(heartbeat, 30_000);
    const conversationsTimer = window.setInterval(() => void loadConvs(), 15_000);
    return () => {
      stopped = true;
      window.clearInterval(threadTimer);
      window.clearInterval(heartbeatTimer);
      window.clearInterval(conversationsTimer);
    };
  }, [activeId, loadConvs, refreshThread]);

  useEffect(() => {
    if (!focusedMessageId || !msgs.some((message) => message.id === focusedMessageId)) return;
    document.getElementById(`message-${focusedMessageId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    const timer = window.setTimeout(() => setFocusedMessageId(null), 2_500);
    return () => window.clearTimeout(timer);
  }, [focusedMessageId, msgs]);

  function saveDraftNow() {
    if (!activeId || draftOwnerRef.current !== activeId) return;
    try {
      if (draft.trim()) window.localStorage.setItem(draftStorageKey(activeId), draft);
      else window.localStorage.removeItem(draftStorageKey(activeId));
    } catch {
      setDraftStatus("unavailable");
    }
  }

  async function loadOlderMessages() {
    if (!activeId || !olderCursor || loadingOlder) return;
    const panel = threadRef.current;
    const oldHeight = panel?.scrollHeight ?? 0;
    setLoadingOlder(true);
    try {
      const response = await fetch(`/api/conversations/${activeId}/messages?before=${encodeURIComponent(olderCursor)}`, { cache: "no-store" });
      const data = (await response.json().catch(() => ({}))) as { messages?: Message[]; hasMore?: boolean; nextCursor?: string | null };
      if (!response.ok) throw new Error("Couldn't load older messages");
      const olderMessages = data.messages ?? [];
      setMsgs((current) => {
        const present = new Set(current.map((message) => message.id));
        return [...olderMessages.filter((message) => !present.has(message.id)), ...current];
      });
      setHasOlder(Boolean(data.hasMore));
      setOlderCursor(data.nextCursor ?? null);
      requestAnimationFrame(() => {
        if (panel) panel.scrollTop = panel.scrollHeight - oldHeight;
      });
    } catch {
      setThreadError("Couldn't load older messages. Scroll to the top to retry.");
    } finally {
      setLoadingOlder(false);
    }
  }

  async function send() {
    if (!activeId || sending || (!draft.trim() && pendingAttachments.length === 0)) return;
    setSending(true);
    setComposerError(null);
    try {
      const attachmentIds: string[] = [];
      for (const attachment of pendingAttachments) {
        if (attachment.attachmentId) {
          attachmentIds.push(attachment.attachmentId);
          continue;
        }
        const form = new FormData();
        form.append("file", attachment.file);
        const uploaded = await fetch(`/api/conversations/${activeId}/attachments`, { method: "POST", body: form });
        const uploadedData = (await uploaded.json().catch(() => ({}))) as { attachmentId?: string; error?: string };
        if (!uploaded.ok || !uploadedData.attachmentId) throw new Error(uploadedData.error ?? `Couldn't upload ${attachment.file.name}`);
        attachmentIds.push(uploadedData.attachmentId);
        setPendingAttachments((current) => current.map((item) => item.key === attachment.key ? { ...item, attachmentId: uploadedData.attachmentId } : item));
      }
      const body = draft.trim();
      const response = await fetch(`/api/conversations/${activeId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          body,
          mentions: extractMentions(body, people),
          parentMessageId: replyTo?.id,
          attachmentIds,
        }),
      });
      const responseData = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(responseData.error ?? "Couldn't send message");
      if (response.status === 202) throw new Error("Your message is waiting for approval. It is still saved in this composer.");
      setDraft("");
      setPendingAttachments([]);
      setReplyTo(null);
      try {
        window.localStorage.removeItem(draftStorageKey(activeId));
      } catch {
        setDraftStatus("unavailable");
      }
      autoScrollRef.current = true;
      await refreshThread(activeId, { scrollToBottom: true });
      void loadConvs();
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : "Couldn't send message. Your draft is still here.");
    } finally {
      setSending(false);
    }
  }

  /** Conversation lifecycle (rename, archive, leave, delete, add member). */
  async function convAction(action: string, extra: Record<string, unknown> = {}) {
    if (!activeId) return null;
    const res = await fetch(`/api/conversations/${activeId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
    });
    const d = (await res.json().catch(() => ({}))) as { error?: string; pendingApproval?: boolean };
    if (!res.ok) {
      setActionNotice(d.error ?? "That didn't work.");
      return null;
    }
    setActionNotice(null);
    await loadConvs();
    return d;
  }

  async function saveEdit() {
    if (!editingId || !editingBody.trim()) return;
    const res = await fetch(`/api/messages/${editingId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: editingBody.trim() }),
    });
    if (res.ok && activeId) await refreshThread(activeId);
    setEditingId(null);
  }

  async function deleteMessage(messageId: string) {
    const res = await fetch(`/api/messages/${messageId}`, { method: "DELETE" });
    if (res.ok && activeId) await refreshThread(activeId);
    setConfirmDeleteMsg(null);
  }

  function selectConversation(conversationId: string) {
    saveDraftNow();
    setActiveId(conversationId);
    setMobileListVisible(false);
  }

  async function openSearchResult(result: MessageSearchResult) {
    saveDraftNow();
    setSearchText("");
    setSearchMode("conversations");
    setFocusedMessageId(result.id);
    setMobileListVisible(false);
    if (activeId === result.conversationId) {
      await refreshThread(result.conversationId, { aroundId: result.id, showLoading: true, markRead: true });
    } else {
      aroundTargetRef.current = result.id;
      setActiveId(result.conversationId);
    }
  }

  async function changeReaction(messageId: string, emoji: string, active: boolean) {
    const response = await fetch(`/api/messages/${messageId}/reactions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emoji, active }),
    });
    if (response.ok && activeId) await refreshThread(activeId);
  }

  async function changePin(messageId: string, pinned: boolean) {
    const response = await fetch(`/api/messages/${messageId}/pin`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned }),
    });
    if (response.ok && activeId) await refreshThread(activeId);
  }

  function addFiles(fileList: FileList | null) {
    if (!fileList) return;
    const additions = Array.from(fileList);
    if (pendingAttachments.length + additions.length > 5) {
      setComposerError("Add up to five files to one message.");
      return;
    }
    const tooLarge = additions.find((file) => file.size > 5 * 1024 * 1024 || file.size === 0);
    if (tooLarge) {
      setComposerError(`${tooLarge.name} must be between 1 byte and 5 MB.`);
      return;
    }
    setComposerError(null);
    setPendingAttachments((current) => [
      ...current,
      ...additions.map((file) => ({ key: `${file.name}-${file.size}-${crypto.randomUUID()}`, file })),
    ]);
  }

  async function removeAttachment(attachment: PendingAttachment) {
    if (attachment.attachmentId && activeId) {
      await fetch(`/api/conversations/${activeId}/attachments`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attachmentId: attachment.attachmentId }),
      });
    }
    setPendingAttachments((current) => current.filter((item) => item.key !== attachment.key));
  }

  async function createConv(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    const res = await fetch("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: newTitle.trim(), agentEnabled: newAgent }),
    });
    if (res.ok) {
      setNewTitle("");
      setComposerOpen(false);
      const data = await res.json();
      await loadConvs();
      setActiveId(data.conversationId);
      setMobileListVisible(false);
    }
  }

  const filteredConvs = (convs ?? []).filter((conversation) =>
    listFilter === "archived" ? Boolean(conversation.archivedAt) : !conversation.archivedAt,
  );
  const visibleConvs = filteredConvs.filter((conversation) => {
    if (searchMode !== "conversations" || !searchText.trim()) return true;
    const query = searchText.trim().toLocaleLowerCase();
    return conversation.title.toLocaleLowerCase().includes(query) ||
      (conversation.lastMessage?.body.toLocaleLowerCase().includes(query) ?? false);
  });
  const typingNames = presence.filter((person) => person.typing).map((person) => person.name);
  const replyCounts = new Map<string, number>();
  for (const message of msgs) {
    if (message.parentMessageId) replyCounts.set(message.parentMessageId, (replyCounts.get(message.parentMessageId) ?? 0) + 1);
  }

  if (!__enabled) return <ModuleDisabled label="Messages" />;

  return (
      <AppFrame
      appId="messaging"
      description="Team channels and DMs. Conversations with Chaste enabled let your AI workmate read the thread and act when colleagues ask."
    >
      <div className="grid h-[calc(100dvh-220px)] min-h-[460px] gap-3 lg:grid-cols-[310px_1fr]">
        {/* Conversation list */}
        <aside
          className={cn(
            "card flex min-h-0 flex-col overflow-hidden p-0",
            !mobileListVisible && activeId && "hidden lg:flex",
          )}
        >
          <div className="flex items-center justify-between border-b border-stone-100 px-4 py-2.5">
            <h2 className="section-title">Conversations</h2>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="Create a conversation"
                title="Create a conversation"
                onClick={() => setComposerOpen((v) => !v)}
                className="icon-btn size-7"
              >
                {composerOpen ? <IconX className="size-3.5" /> : <IconPlus className="size-4" />}
              </button>
            </div>
          </div>

          <div className="space-y-2 border-b border-stone-100 p-3">
            <div className="grid grid-cols-2 rounded-lg bg-stone-100 p-0.5 text-xs">
              {(["conversations", "messages"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={searchMode === mode}
                  onClick={() => setSearchMode(mode)}
                  className={cn("rounded-md px-2 py-1.5 capitalize", searchMode === mode ? "bg-white font-medium text-stone-900 shadow-sm" : "text-stone-500")}
                >
                  {mode === "messages" ? "All messages" : "Conversations"}
                </button>
              ))}
            </div>
            <input
              type="search"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              aria-label={searchMode === "messages" ? "Search all messages" : "Search conversations"}
              placeholder={searchMode === "messages" ? "Search message history…" : "Find a conversation…"}
              className="input h-9 text-xs"
            />
            {searchMode === "conversations" && (
              <div className="flex rounded-lg border border-stone-200 p-0.5 text-xs">
                {(["active", "archived"] as const).map((view) => {
                  const count = (convs ?? []).filter((conversation) => view === "archived" ? Boolean(conversation.archivedAt) : !conversation.archivedAt).length;
                  return (
                    <button
                      key={view}
                      type="button"
                      aria-pressed={listFilter === view}
                      onClick={() => setListFilter(view)}
                      className={cn("flex-1 rounded-md px-2 py-1.5 capitalize", listFilter === view ? "bg-stone-900 text-white" : "text-stone-500 hover:bg-stone-50")}
                    >
                      {view} <span className="opacity-70">{count}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {composerOpen && (
            <form onSubmit={createConv} className="space-y-2.5 border-b border-stone-100 bg-stone-50/60 p-3">
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Channel name…"
                aria-label="New channel name"
                className="input h-8 text-xs"
              />
              <label className="flex cursor-pointer items-center gap-2 text-xs text-stone-600">
                <input type="checkbox" checked={newAgent} onChange={(e) => setNewAgent(e.target.checked)} className="accent-gold-700" />
                Include Chaste (AI workmate)
              </label>
              <Button type="submit" size="sm" className="w-full" disabled={!newTitle.trim()}>
                Create
              </Button>
            </form>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Conversations">
            {convs === null ? (
              loadError ? (
                <div className="space-y-2 p-4" role="alert">
                  <p className="text-sm font-medium text-stone-800">{loadError}</p>
                  <p className="text-xs text-stone-500">Your channels could not be reached.</p>
                  <Button tone="secondary" size="sm" onClick={() => void loadConvs()}>Retry</Button>
                </div>
              ) : (
                <div className="space-y-2 p-3" aria-label="Loading conversations" aria-busy="true">
                  {Array.from({ length: 6 }, (_, index) => (
                    <div key={index} className="animate-pulse rounded-lg px-2 py-3">
                      <div className="h-3 w-2/3 rounded bg-stone-200" />
                      <div className="mt-2 h-2.5 w-4/5 rounded bg-stone-100" />
                    </div>
                  ))}
                </div>
              )
            ) : searchMode === "messages" ? (
              <div className="divide-y divide-stone-100">
                {searchText.trim().length < 2 ? (
                  <p className="p-4 text-xs leading-relaxed text-stone-500">Enter at least two characters to search the full message history.</p>
                ) : messageSearchBusy ? (
                  <div className="space-y-3 p-4" aria-label="Searching messages" aria-busy="true">
                    {Array.from({ length: 4 }, (_, index) => <div key={index} className="h-12 animate-pulse rounded-lg bg-stone-100" />)}
                  </div>
                ) : messageSearchError ? (
                  <p className="p-4 text-sm text-red-700" role="alert">{messageSearchError}</p>
                ) : messageSearchResults.length === 0 ? (
                  <p className="p-4 text-sm text-stone-500">No messages match “{searchText.trim()}”.</p>
                ) : messageSearchResults.map((result) => (
                  <button
                    key={result.id}
                    type="button"
                    onClick={() => void openSearchResult(result)}
                    className="block w-full px-4 py-3 text-left hover:bg-gold-50/60"
                  >
                    <span className="block truncate text-xs font-semibold text-stone-800">#{result.conversationTitle}</span>
                    <span className="mt-1 block line-clamp-3 text-xs leading-relaxed text-stone-500">{result.body}</span>
                    <span className="mt-1 block text-[10px] text-stone-400">{timeAgo(result.createdAt)}</span>
                  </button>
                ))}
              </div>
            ) : convs.length === 0 && listFilter === "active" ? (
              <div className="p-5">
                <div className="mb-4 flex size-10 items-center justify-center rounded-xl bg-gold-50 text-gold-700"><IconHash className="size-5" /></div>
                <h3 className="text-sm font-semibold text-stone-900">Create your first channel</h3>
                <p className="mt-1 text-xs leading-relaxed text-stone-500">Give your team a shared place for updates, questions, and decisions.</p>
                <Button className="mt-4 w-full" size="sm" onClick={() => setComposerOpen(true)}>Create your first channel</Button>
                <p className="mt-5 text-[10px] font-semibold tracking-wide text-stone-400 uppercase">Start with a suggestion</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {["general", "operations", "announcements"].map((name) => (
                    <button key={name} type="button" onClick={() => { setNewTitle(name); setComposerOpen(true); }} className="rounded-full border border-stone-200 px-2.5 py-1 text-xs text-stone-600 hover:border-gold-400 hover:text-gold-800">#{name}</button>
                  ))}
                </div>
              </div>
            ) : visibleConvs.length === 0 ? (
              <p className="p-4 text-sm text-stone-500">{listFilter === "archived" ? "No archived conversations." : searchText.trim() ? "No conversations match your search." : "No active conversations."}</p>
            ) : visibleConvs.map((c) => (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={activeId === c.id}
                onClick={() => selectConversation(c.id)}
                className={cn(
                  "block w-full border-b border-stone-50 px-4 py-3 text-left transition-colors duration-75",
                  activeId === c.id ? "bg-gold-50/70" : "hover:bg-stone-50",
                )}
              >
                <div className="flex items-center gap-2">
                  {c.kind === "dm" ? <IconBot className={cn("size-3.5 shrink-0", activeId === c.id ? "text-gold-700" : "text-stone-400")} /> : <IconHash className={cn("size-3.5 shrink-0", activeId === c.id ? "text-gold-700" : "text-stone-400")} />}
                  <span className={cn("truncate text-sm font-medium text-stone-800", c.archivedAt && "text-stone-400 line-through")}>{c.title}</span>
                  {c.unreadCount > 0 && <span className="ml-auto flex min-w-5 items-center justify-center rounded-full bg-gold-700 px-1.5 py-0.5 text-[10px] font-semibold text-white">{c.unreadCount > 99 ? "99+" : c.unreadCount}</span>}
                  {c.archivedAt ? <Badge tone="neutral" className="ml-auto shrink-0">archived</Badge> : c.agentEnabled && <Badge tone="violet" className="ml-auto shrink-0">chaste</Badge>}
                </div>
                {c.lastMessage && <p className="mt-1 truncate text-xs text-stone-400">{c.lastMessage.body}</p>}
              </button>
            ))}
          </div>
        </aside>

        {/* Thread */}
        <section className={cn("card flex min-h-0 flex-col overflow-hidden p-0", !activeId || mobileListVisible ? "hidden lg:flex" : "flex")}>
          {activeConv ? (
            <>
              <header className="flex items-center gap-2 border-b border-stone-100 px-4 py-2.5">
                <button
                  type="button"
                  onClick={() => {
                    saveDraftNow();
                    setActiveId(null);
                    setMobileListVisible(true);
                  }}
                  aria-label="Back to conversations"
                  className="icon-btn lg:hidden"
                >
                  <IconChevronLeft className="size-4" />
                </button>
                <h2 className="truncate text-sm font-semibold text-stone-800">
                  {activeConv.kind === "dm" ? "" : "#"}
                  {activeConv.title}
                </h2>
                {activeConv.archivedAt && <Badge tone="neutral">archived</Badge>}
                {activeConv.agentEnabled && (
                  <Badge tone="violet">
                    <IconBot className="size-3" /> Chaste reads & acts here
                  </Badge>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setRenameValue(activeConv.title);
                    setAddUserId("");
                    setMemberQuery("");
                    setActionNotice(null);
                    setSettingsOpen(true);
                  }}
                  aria-label="Conversation settings"
                  title="Rename, members, archive"
                  className="icon-btn ml-auto"
                >
                  <IconSettings className="size-4" />
                </button>
              </header>

              {(typingNames.length > 0 || presence.length > 0) && (
                <div className="flex min-h-7 items-center gap-2 border-b border-stone-50 px-4 text-[11px] text-stone-400">
                  {typingNames.length > 0 ? `${typingNames.join(", ")} ${typingNames.length === 1 ? "is" : "are"} typing…` : `${presence.length} ${presence.length === 1 ? "colleague" : "colleagues"} online`}
                </div>
              )}

              {pinnedMessages.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    const pinned = pinnedMessages[0];
                    if (!pinned) return;
                    if (msgs.some((message) => message.id === pinned.id)) {
                      document.getElementById(`message-${pinned.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
                    } else {
                      void refreshThread(activeConv.id, { aroundId: pinned.id, showLoading: true });
                    }
                  }}
                  className="flex items-center gap-2 border-b border-gold-100 bg-gold-50/60 px-4 py-2 text-left text-xs text-gold-900"
                >
                  <span aria-hidden="true">📌</span>
                  <span className="font-semibold">Pinned</span>
                  <span className="truncate">{pinnedMessages[0]!.body || "Open pinned message"}</span>
                  {pinnedMessages.length > 1 && <span className="ml-auto shrink-0">+{pinnedMessages.length - 1}</span>}
                </button>
              )}

              {threadError && (
                <div className="flex items-center justify-between gap-2 border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-800" role="alert">
                  <span>{threadError}</span>
                  <Button size="sm" tone="secondary" onClick={() => void refreshThread(activeConv.id, { showLoading: true })}>Retry</Button>
                </div>
              )}

              {threadLoading ? (
                <div className="min-h-0 flex-1 space-y-5 overflow-hidden p-4 sm:p-5" aria-label="Loading messages" aria-busy="true">
                  {Array.from({ length: 6 }, (_, index) => (
                    <div key={index} className={cn("flex animate-pulse gap-3", index % 2 === 1 && "flex-row-reverse")}>
                      <div className="size-7 shrink-0 rounded-lg bg-stone-200" />
                      <div className="w-3/4 space-y-2"><div className="h-2.5 w-1/4 rounded bg-stone-200" /><div className="h-12 rounded-xl bg-stone-100" /></div>
                    </div>
                  ))}
                </div>
              ) : (
                <div
                  ref={threadRef}
                  onScroll={(event) => {
                    if (event.currentTarget.scrollTop < 28 && hasOlder && !loadingOlder) void loadOlderMessages();
                  }}
                  className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 sm:p-5"
                  aria-label={`Messages in ${activeConv.title}`}
                >
                  {loadingOlder && <p className="py-2 text-center text-[11px] text-stone-400">Loading earlier messages…</p>}
                  {msgs.length === 0 && <p className="pt-10 text-center text-sm text-stone-400">No messages yet. Start the conversation below.</p>}
                  {msgs.map((message, index) => {
                    const previous = msgs[index - 1];
                    const isAgent = message.senderType === "agent";
                    const mine = message.senderType === "human" && me != null && message.senderUserId === me;
                    const senderName = isAgent ? "Chaste" : mine ? "You" : people.find((person) => person.id === message.senderUserId)?.name ?? "Colleague";
                    const grouped = Boolean(previous && previous.senderType === message.senderType && previous.senderUserId === message.senderUserId && sameCalendarDay(previous.createdAt, message.createdAt) && new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() < 5 * 60_000 && !message.parentMessageId);
                    const seenBy = mine ? readers.filter((reader) => reader.userId !== me && reader.lastReadAt && Date.parse(reader.lastReadAt) >= Date.parse(message.createdAt)).map((reader) => reader.name) : [];
                    const messageReactions = message.reactions ?? [];
                    return (
                      <Fragment key={message.id}>
                        {(!previous || !sameCalendarDay(previous.createdAt, message.createdAt)) && (
                          <div className="flex items-center gap-3 py-2 text-[10px] font-medium text-stone-400"><span className="h-px flex-1 bg-stone-100" /><span>{dayLabel(message.createdAt)}</span><span className="h-px flex-1 bg-stone-100" /></div>
                        )}
                        <div id={`message-${message.id}`} className={cn("group flex gap-2.5 rounded-xl transition-colors", message.parentMessageId && "ml-7 border-l-2 border-stone-100 pl-3", focusedMessageId === message.id && "bg-gold-50 ring-2 ring-gold-300", grouped && "pt-0.5")}>
                          {!grouped && (isAgent ? (
                            <span aria-hidden="true" className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-lg bg-violet-600 text-white [&_svg]:size-3.5"><IconBot /></span>
                          ) : (
                            <span aria-hidden="true" className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-lg bg-stone-200 text-[9px] font-bold text-stone-600 uppercase">{senderName.slice(0, 2)}</span>
                          ))}
                          {grouped && <span className="w-7 shrink-0" aria-hidden="true" />}
                          <div className="min-w-0 flex-1">
                            {!grouped && <p className="mb-1 text-[11px] font-semibold text-stone-700">{senderName}<span className="ml-2 font-normal text-stone-400">{timeAgo(message.createdAt)}{message.editedAt && " · edited"}</span></p>}
                            {editingId === message.id ? (
                              <div className="max-w-[90%] space-y-1.5">
                                <textarea value={editingBody} onChange={(event) => setEditingBody(event.target.value)} rows={2} aria-label="Edit message" className="textarea text-sm" autoFocus />
                                <div className="flex gap-1.5"><Button size="sm" onClick={() => void saveEdit()} disabled={!editingBody.trim()}>Save</Button><Button size="sm" tone="ghost" onClick={() => setEditingId(null)}>Cancel</Button></div>
                              </div>
                            ) : (
                              <>
                                {message.body && <div className={cn("w-fit max-w-[min(90%,680px)] rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap", isAgent ? "bg-violet-50 text-violet-950" : mine ? "bg-gold-50 text-stone-800" : "bg-stone-100 text-stone-800")}><Body body={message.body} /></div>}
                                {message.attachments?.length > 0 && <div className="mt-2 flex max-w-xl flex-wrap gap-2">{message.attachments.map((attachment) => <a key={attachment.id} href={attachment.href} download className="flex max-w-full items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2 text-xs text-stone-700 hover:border-gold-400"><span aria-hidden="true">📎</span><span className="truncate">{attachment.filename}</span><span className="shrink-0 text-stone-400">{(attachment.sizeBytes / 1024).toFixed(0)} KB</span></a>)}</div>}
                                {messageReactions.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1">{messageReactions.map((reaction) => <button key={reaction.emoji} type="button" aria-label={`${reaction.emoji}, ${reaction.count} reactions${reaction.names.length ? `, ${reaction.names.join(", ")}` : ""}`} aria-pressed={reaction.reactedByMe} onClick={() => void changeReaction(message.id, reaction.emoji, !reaction.reactedByMe)} className={cn("rounded-full border px-2 py-0.5 text-xs", reaction.reactedByMe ? "border-gold-400 bg-gold-50" : "border-stone-200 bg-white")}>{reaction.emoji} {reaction.count}</button>)}</div>}
                                {reactionMenuId === message.id && <div className="mt-1 flex gap-1">{REACTIONS.map((emoji) => <button key={emoji} type="button" aria-label={`React ${emoji}`} onClick={() => { void changeReaction(message.id, emoji, true); setReactionMenuId(null); }} className="rounded-md border border-stone-200 bg-white px-2 py-1 text-sm hover:bg-gold-50">{emoji}</button>)}</div>}
                                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-stone-400">
                                  {grouped && <span>{timeAgo(message.createdAt)}{message.editedAt && " · edited"}</span>}
                                  <button type="button" onClick={() => setReplyTo(message)} className="hover:text-gold-800">Reply{(replyCounts.get(message.id) ?? 0) > 0 ? ` · ${replyCounts.get(message.id)} replies` : ""}</button>
                                  <button type="button" onClick={() => setReactionMenuId(reactionMenuId === message.id ? null : message.id)} className="hover:text-gold-800">React</button>
                                  <button type="button" onClick={() => void changePin(message.id, !message.pinnedAt)} className="hover:text-gold-800">{message.pinnedAt ? "Unpin" : "Pin"}</button>
                                  {mine && <><button type="button" aria-label="Edit message" onClick={() => { setEditingId(message.id); setEditingBody(message.body); }} className="hover:text-gold-800">Edit</button><button type="button" aria-label="Delete message" onClick={() => setConfirmDeleteMsg(message.id)} className="hover:text-red-700">Delete</button></>}
                                  {seenBy.length > 0 && <span className="ml-auto text-stone-400">Seen by {seenBy.slice(0, 3).join(", ")}{seenBy.length > 3 ? ` +${seenBy.length - 3}` : ""}</span>}
                                </div>
                              </>
                            )}
                          </div>
                        </div>
                      </Fragment>
                    );
                  })}
                  {typingNames.length > 0 && <p className="pl-10 text-[11px] text-stone-400" aria-live="polite">{typingNames.join(", ")} {typingNames.length === 1 ? "is" : "are"} typing…</p>}
                </div>
              )}

              <form onSubmit={(event) => { event.preventDefault(); void send(); }} className="relative border-t border-stone-100 p-3">
                {replyTo && <div className="mb-2 flex items-center gap-2 rounded-lg bg-stone-50 px-2.5 py-1.5 text-xs text-stone-600"><span className="font-semibold">Replying to {replyTo.senderUserId === me ? "yourself" : people.find((person) => person.id === replyTo.senderUserId)?.name ?? "message"}</span><span className="min-w-0 flex-1 truncate text-stone-400">{replyTo.body || replyTo.attachments[0]?.filename}</span><button type="button" aria-label="Cancel reply" onClick={() => setReplyTo(null)} className="icon-btn size-6"><IconX className="size-3" /></button></div>}
                {composerError && <p className="mb-2 text-xs text-red-700" role="alert">{composerError}</p>}
                {mentionQuery != null && mentionCandidates.length > 0 && (
                  <ul
                    role="listbox"
                    aria-label="Mention someone"
                    className="absolute bottom-full left-3 z-10 mb-1 w-64 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-lg"
                  >
                    {mentionCandidates.map((p, i) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={i === mentionIndex}
                          onMouseEnter={() => setMentionIndex(i)}
                          onClick={() => pickMention(p)}
                          className={cn(
                            "flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm",
                            i === mentionIndex ? "bg-gold-50 text-gold-900" : "text-stone-700 hover:bg-stone-50",
                          )}
                        >
                          {p.type === "agent" ? (
                            <IconBot className="size-3.5 shrink-0 text-violet-600" />
                          ) : (
                            <IconUser className="size-3.5 shrink-0 text-stone-400" />
                          )}
                          <span className="truncate">
                            @{personAlias(p)}
                            <span className="ml-1.5 text-xs font-normal text-stone-400">
                              {p.type === "agent" ? "pulls the AI in" : p.name}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="relative rounded-xl border border-stone-200 bg-white shadow-xs transition-colors focus-within:border-gold-500 focus-within:ring-2 focus-within:ring-gold-100">
                  {pendingAttachments.length > 0 && <div className="flex flex-wrap gap-1.5 px-3 pt-3">{pendingAttachments.map((attachment) => <span key={attachment.key} className="flex max-w-full items-center gap-1.5 rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-[11px] text-stone-600"><IconPaperclip className="size-3 shrink-0" /><span className="max-w-40 truncate">{attachment.file.name}</span>{attachment.attachmentId && <span className="text-green-700">Ready</span>}<button type="button" aria-label={`Remove ${attachment.file.name}`} onClick={() => void removeAttachment(attachment)} className="text-stone-400 hover:text-red-700">×</button></span>)}</div>}
                  <textarea
                    ref={composerRef}
                    value={draft}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      syncMentionQuery();
                    }}
                    onKeyDown={(e) => {
                      if (mentionQuery != null && mentionCandidates.length > 0) {
                        if (e.key === "ArrowDown") {
                          e.preventDefault();
                          setMentionIndex((i) => Math.min(i + 1, mentionCandidates.length - 1));
                          return;
                        }
                        if (e.key === "ArrowUp") {
                          e.preventDefault();
                          setMentionIndex((i) => Math.max(i - 1, 0));
                          return;
                        }
                        if (e.key === "Enter" || e.key === "Tab") {
                          e.preventDefault();
                          pickMention(mentionCandidates[mentionIndex]!);
                          return;
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setMentionQuery(null);
                          return;
                        }
                      }
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                    rows={1}
                    aria-label={`Message ${activeConv.title}`}
                    placeholder="Write a message… type @ to mention a colleague or the agent"
                    className="max-h-44 min-h-10 w-full resize-none bg-transparent px-3 py-2 text-sm leading-relaxed text-stone-900 outline-none placeholder:text-stone-400 focus:ring-0 disabled:cursor-not-allowed disabled:text-stone-400"
                    disabled={sending}
                  />
                  <div className="flex min-h-12 items-center gap-1.5 border-t border-stone-100 px-2 py-1.5">
                    <input ref={attachmentInputRef} type="file" multiple className="hidden" onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} />
                    <button type="button" title="Attach files" aria-label="Attach files" onClick={() => attachmentInputRef.current?.click()} disabled={sending || pendingAttachments.length >= 5} className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900 disabled:opacity-40"><IconPaperclip className="size-4" /></button>
                    <div className="relative shrink-0">
                      <button type="button" title="Add emoji" aria-label="Add emoji" aria-expanded={emojiPickerOpen} aria-controls="message-emoji-picker" onMouseDown={(event) => event.preventDefault()} onClick={() => setEmojiPickerOpen((open) => !open)} className="inline-flex size-9 items-center justify-center rounded-lg text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900"><IconSmile className="size-4" /></button>
                      {emojiPickerOpen && <div id="message-emoji-picker" role="group" aria-label="Choose an emoji" className="absolute bottom-full left-0 z-20 mb-2 grid w-52 grid-cols-8 gap-1 rounded-xl border border-stone-200 bg-white p-2 shadow-lg">{MESSAGE_EMOJIS.map((emoji) => <button key={emoji} type="button" aria-label={emoji} title={emoji} onMouseDown={(event) => event.preventDefault()} onClick={() => insertEmoji(emoji)} className="flex size-7 items-center justify-center rounded-md text-base hover:bg-gold-50 focus-visible:outline-2 focus-visible:outline-gold-600">{emoji}</button>)}</div>}
                    </div>
                    <span className="min-w-0 truncate pl-1 text-[10px] text-stone-400" aria-live="polite">{draftStatus === "saving" ? "Saving draft…" : draftStatus === "unavailable" ? "Draft saving unavailable" : "Draft saved"}</span>
                    <span className="ml-auto hidden whitespace-nowrap text-[10px] text-stone-400 lg:inline">Enter to send · Shift+Enter for a new line</span>
                    <button type="submit" disabled={sending || (!draft.trim() && pendingAttachments.length === 0)} aria-label={sending ? "Sending message" : "Send message"} className="ml-auto flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-gold-700 px-3 text-xs font-medium text-white transition-colors duration-150 hover:bg-gold-800 disabled:pointer-events-none disabled:opacity-45">{sending ? "Sending…" : <><IconSend className="size-4" /><span className="hidden sm:inline">Send</span></>}</button>
                  </div>
                </div>
              </form>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-6 text-sm text-stone-400">
              Select a conversation to read it.
            </div>
          )}
        </section>
      </div>

      {activeConv && (
        <Dialog
          open={settingsOpen}
          onClose={closeSettings}
          title={activeConv.kind === "dm" ? "Conversation" : `#${activeConv.title}`}
          description="Membership and lifecycle for this conversation."
        >
          <div className="space-y-4">
            {actionNotice && <Notice tone="error">{actionNotice}</Notice>}

            {activeConv.kind === "channel" && (
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-medium text-stone-700">Name</span>
                <div className="flex gap-2">
                  <input
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    aria-label="Channel name"
                    className="input"
                  />
                  <Button
                    size="sm"
                    disabled={!renameValue.trim() || renameValue.trim() === activeConv.title}
                    onClick={async () => {
                      const r = await convAction("update", { title: renameValue.trim() });
                      if (r) setActionNotice(null);
                    }}
                  >
                    Rename
                  </Button>
                </div>
              </label>
            )}

            <div className="flex items-center justify-between gap-3 rounded-xl border border-stone-200 px-3 py-2.5">
              <div>
                <p className="text-[13px] font-medium text-stone-900">Chaste participates</p>
                <p className="text-[11px] leading-snug text-stone-400">
                  The workmate reads this thread and acts when colleagues ask.
                </p>
              </div>
              <Switch
                checked={activeConv.agentEnabled}
                onChange={(v) => void convAction("update", { agentEnabled: v })}
                label=""
              />
            </div>

            {activeConv.kind === "channel" && (
              <div className="block">
                <label htmlFor="message-member-search" className="mb-1.5 block text-[13px] font-medium text-stone-700">Find a colleague by name</label>
                <div className="flex gap-2">
                  <input id="message-member-search" value={memberQuery} onChange={(event) => { setMemberQuery(event.target.value); setAddUserId(""); }} placeholder="Search team members…" className="input" autoComplete="off" />
                  <Button
                    size="sm"
                    disabled={!addUserId}
                    onClick={async () => {
                      const r = await convAction("addMember", { userId: addUserId });
                      if (r) { setAddUserId(""); setMemberQuery(""); setMemberSearchResults([]); }
                    }}
                  >
                    Add
                  </Button>
                </div>
                {memberQuery.trim() && (
                  <div className="mt-1 max-h-36 overflow-y-auto rounded-lg border border-stone-200 bg-white">
                    {memberSearchResults.length === 0 ? <p className="px-3 py-2 text-xs text-stone-400">No matching team members.</p> : memberSearchResults.map((person) => (
                      <button key={person.id} type="button" onClick={() => { setAddUserId(person.id); setMemberQuery(person.name); setMemberSearchResults([]); }} className={cn("block w-full px-3 py-2 text-left text-xs hover:bg-gold-50", addUserId === person.id && "bg-gold-50")}>
                        <span className="block font-medium text-stone-800">{person.name}</span>
                        <span className="text-stone-400">Select this person to add</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t border-stone-100 pt-3">
              {activeConv.kind === "channel" && (
                <Button
                  size="sm"
                  tone="secondary"
                  onClick={async () => {
                    const r = await convAction("archive", { archived: !activeConv.archivedAt });
                    if (r) setSettingsOpen(false);
                  }}
                >
                  {activeConv.archivedAt ? "Restore" : "Archive"}
                </Button>
              )}
              <Button
                size="sm"
                tone="secondary"
                onClick={async () => {
                  const r = await convAction("leave");
                  if (r) {
                    setSettingsOpen(false);
                    setActiveId(null);
                  }
                }}
              >
                Leave
              </Button>
              {activeConv.kind === "channel" && activeConv.createdByMe && (
                <Button size="sm" tone="danger" onClick={() => setConfirmDeleteConv(true)}>
                  <IconTrash className="size-3.5" />
                  Delete channel
                </Button>
              )}
            </div>
          </div>
        </Dialog>
      )}

      <ConfirmDialog
        open={confirmDeleteConv}
        onClose={() => setConfirmDeleteConv(false)}
        onConfirm={async () => {
          const r = await convAction("delete");
          setConfirmDeleteConv(false);
          if (r) {
            setSettingsOpen(false);
            setActiveId(null);
          }
        }}
        title={`Delete #${activeConv?.title ?? ""}?`}
        body="It disappears from everyone's list. The audit trail keeps the record; this cannot be undone from the UI."
        confirmLabel="Delete channel"
      />

      <ConfirmDialog
        open={confirmDeleteMsg != null}
        onClose={() => setConfirmDeleteMsg(null)}
        onConfirm={() => confirmDeleteMsg && void deleteMessage(confirmDeleteMsg)}
        title="Delete this message?"
        body="It is replaced by a deletion marker for everyone. The audit trail keeps the original."
        confirmLabel="Delete message"
      />
    </AppFrame>
  );
}
