import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MessagingApiError,
  advanceReadCursor,
  changeConversation,
  checkAttachmentLimits,
  createConversation,
  deleteMessage as deleteMessageRequest,
  deletePendingAttachment,
  editMessage,
  fetchConversationPeople,
  messagingPeopleReadsGoSelected,
  fetchConversationPresence,
  fetchConversationThread,
  fetchConversations,
  fetchMessagingEnabled,
  fetchOlderMessages,
  getPendingMessageDelete,
  getPendingMessageEdit,
  reportConversationPresence,
  searchMessages,
  sendConversationMessage,
  setMessagePin,
  setMessageReaction,
  uploadConversationAttachment,
  type Conversation,
  type ConversationPresence,
  type ConversationThread,
  type Message,
  type MessageMention,
  type MessageReader,
  type MessageSearchResult,
  type MessagingOutcome,
  type PinnedMessage,
  type Person,
} from "../api/messaging";
import "./MessagesPage.css";

/** The legacy contract accepts only these five reactions. */
export const REACTIONS = ["👍", "❤️", "🎉", "✅", "👀"] as const;
export const MESSAGE_EMOJIS = ["😀", "😁", "😂", "😊", "😍", "🙌", "👏", "🙏", "👍", "❤️", "🎉", "✅", "👀", "🔥", "🤔", "✨"] as const;
/** The composer inserts this short alias for the agent; it contains no spaces. */
export const AGENT_ALIAS = "Chaste";

/** Poll cadence from the legacy page: thread + presence, list, presence heartbeat. */
export const THREAD_POLL_MS = 5_000;
export const LIST_POLL_MS = 15_000;
export const HEARTBEAT_MS = 30_000;
export const TYPING_DEBOUNCE_MS = 400;
export const DRAFT_DEBOUNCE_MS = 350;
export const SEARCH_DEBOUNCE_MS = 300;
export const MEMBER_DEBOUNCE_MS = 200;
export const NEAR_BOTTOM_PX = 80;
export const FOCUS_FLASH_MS = 2_500;

export type Notice = { tone: "pending" | "error" | "success"; text: string };
export type ListFilter = "active" | "archived";
export type SearchMode = "conversations" | "messages";
export type DraftStatus = "saving" | "saved" | "unavailable";
export type BubbleTone = "system" | "agent" | "mine" | "colleague";

function messageDeleteScopeIdentity(actorId: string | null, organizationId: string | null): string {
  return JSON.stringify([actorId?.trim() ?? "", organizationId?.trim() ?? ""]);
}

function messageEditScopeIdentity(actorId: string | null, organizationId: string | null, conversationId: string | null): string {
  return JSON.stringify([actorId?.trim() ?? "", organizationId?.trim() ?? "", conversationId?.trim() ?? ""]);
}

export interface PendingAttachment {
  key: string;
  file: File;
  attachmentId?: string;
}

export function personAlias(person: Person): string {
  return person.type === "agent" ? AGENT_ALIAS : person.name.split(" ")[0] ?? person.name;
}

/** Scans a draft for @aliases that resolve to real people or agents. */
export function extractMentions(body: string, people: Person[]): MessageMention[] {
  const lower = body.toLowerCase();
  const seen = new Map<string, MessageMention>();
  for (const person of people) {
    const alias = personAlias(person).toLowerCase();
    if (alias && lower.includes(`@${alias}`) && !seen.has(person.id)) {
      seen.set(person.id, { type: person.type, id: person.id });
    }
  }
  return [...seen.values()];
}

export function sameCalendarDay(a: string, b: string): boolean {
  const left = new Date(a);
  const right = new Date(b);
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

export function dayLabel(value: string, now: Date = new Date()): string {
  const date = new Date(value);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const stamp = (input: Date) => `${input.getFullYear()}-${input.getMonth()}-${input.getDate()}`;
  if (stamp(date) === stamp(now)) return "Today";
  if (stamp(date) === stamp(yesterday)) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(date);
}

export function timeAgo(value: string, now: Date = new Date()): string {
  const seconds = Math.floor((now.getTime() - new Date(value).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function bubbleTone(message: Message, me: string | null): BubbleTone {
  if (message.senderType === "agent") return "agent";
  if (message.senderType === "system") return "system";
  if (me != null && message.senderType === "human" && message.senderUserId === me) return "mine";
  return "colleague";
}

export function senderDisplayName(message: Message, people: Person[], me: string | null): string {
  if (message.senderType === "agent") return AGENT_ALIAS;
  if (message.senderType === "system") return "System";
  if (me != null && message.senderUserId === me) return "You";
  return people.find((person) => person.id === message.senderUserId)?.name ?? "Colleague";
}

/** Consecutive messages from one sender inside five minutes collapse into one block. */
export function isGroupedWith(previous: Message | undefined, message: Message): boolean {
  if (!previous) return false;
  if (message.parentMessageId) return false;
  if (previous.senderType !== message.senderType || previous.senderUserId !== message.senderUserId) return false;
  if (!sameCalendarDay(previous.createdAt, message.createdAt)) return false;
  return new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() < 5 * 60_000;
}

export function seenByReaders(message: Message, readers: MessageReader[], me: string | null): string[] {
  if (bubbleTone(message, me) !== "mine") return [];
  return readers
    .filter((reader) => reader.userId !== me && reader.lastReadAt && Date.parse(reader.lastReadAt) >= Date.parse(message.createdAt))
    .map((reader) => reader.name);
}

export function replyCounts(messages: Message[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (message.parentMessageId) counts.set(message.parentMessageId, (counts.get(message.parentMessageId) ?? 0) + 1);
  }
  return counts;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Detects an @token immediately before the caret; null when there is none. */
export function activeMentionQuery(value: string, caret: number): string | null {
  const match = /@([A-Za-z0-9_.-]*)$/.exec(value.slice(0, caret));
  return match?.[1] ?? null;
}

export function applyMentionAlias(value: string, caret: number, alias: string): { text: string; caret: number } {
  const before = value.slice(0, caret).replace(/@[A-Za-z0-9_.-]*$/, `@${alias} `);
  const text = before + value.slice(caret);
  return { text, caret: before.length };
}

export function insertIntoText(value: string, start: number, end: number, text: string): { text: string; caret: number } {
  const next = `${value.slice(0, start)}${text}${value.slice(end)}`;
  return { text: next, caret: start + text.length };
}

export function conversationCounts(conversations: Conversation[]): Record<ListFilter, number> {
  return {
    active: conversations.filter((conversation) => !conversation.archivedAt).length,
    archived: conversations.filter((conversation) => Boolean(conversation.archivedAt)).length,
  };
}

export function visibleConversations(conversations: Conversation[], filter: ListFilter, query: string): Conversation[] {
  const scoped = conversations.filter((conversation) => (filter === "archived" ? Boolean(conversation.archivedAt) : !conversation.archivedAt));
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return scoped;
  return scoped.filter((conversation) =>
    conversation.title.toLocaleLowerCase().includes(needle) ||
    (conversation.lastMessage?.body.toLocaleLowerCase().includes(needle) ?? false));
}

/** Prepends an older page without duplicating rows the thread already holds. */
export function reconcileOlderMessages(current: Message[], older: Message[]): Message[] {
  const present = new Set(current.map((message) => message.id));
  return [...older.filter((message) => !present.has(message.id)), ...current];
}

/** The thread sticks to the newest message only while the reader is already at the end. */
export function isNearBottom(panel: { scrollHeight: number; scrollTop: number; clientHeight: number }, threshold = NEAR_BOTTOM_PX): boolean {
  return panel.scrollHeight - panel.scrollTop - panel.clientHeight < threshold;
}

export function draftStorageKey(me: string | null, conversationId: string): string {
  return `chaste:message-draft:${me ?? "anonymous"}:${conversationId}`;
}

export function goSendIntentStorageKey(me: string | null, conversationId: string, fingerprint: string): string {
  return `chaste:message-send-intent:${me ?? "anonymous"}:${conversationId}:${fingerprint}`;
}

type GoSendIntent = { storageKey: string; fingerprint: string; intentId: string };
type GoSendIntentRef = { current: GoSendIntent | null };
type PendingCreateIntent = { fingerprint: string; intentId: string; title: string; agentEnabled: boolean };
type PendingConversationUpdate = {
  conversationId: string;
  action: Extract<Parameters<typeof changeConversation>[1], { action: "update" }>;
  fingerprint: string;
  intentId: string;
};
type PendingConversationArchive = {
  conversationId: string;
  action: Extract<Parameters<typeof changeConversation>[1], { action: "archive" }>;
  fingerprint: string;
  intentId: string;
};

function conversationArchiveGoSelected(): boolean {
  return typeof __GO_MESSAGING_CONVERSATION_ARCHIVE__ !== "undefined" && __GO_MESSAGING_CONVERSATION_ARCHIVE__;
}

function createIntentStorageKey(actorId: string, organizationId: string): string {
  return `chaste:conversation-create:${encodeURIComponent(actorId)}:${encodeURIComponent(organizationId)}`;
}

function readPendingCreateIntent(actorId: string, organizationId: string): PendingCreateIntent | null {
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(createIntentStorageKey(actorId, organizationId)) ?? "null") as Partial<PendingCreateIntent> | null;
    if (
      stored == null
      || typeof stored.title !== "string"
      || stored.title.trim().length < 1
      || stored.title.trim().length > 80
      || typeof stored.agentEnabled !== "boolean"
      || typeof stored.fingerprint !== "string"
      || typeof stored.intentId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stored.intentId)
    ) return null;
    const title = stored.title.trim();
    const fingerprint = JSON.stringify([title, stored.agentEnabled]);
    if (stored.fingerprint !== fingerprint) return null;
    return {
      title,
      agentEnabled: stored.agentEnabled,
      intentId: stored.intentId,
      fingerprint: stored.fingerprint,
    };
  } catch {
    return null;
  }
}

function persistPendingCreateIntent(actorId: string | null, organizationId: string | null, intent: PendingCreateIntent): void {
  if (!actorId || !organizationId) return;
  try {
    window.sessionStorage.setItem(createIntentStorageKey(actorId, organizationId), JSON.stringify(intent));
  } catch {
    // The in-memory intent still protects retries for this page session.
  }
}

function clearPendingCreateIntent(actorId: string | null, organizationId: string | null): void {
  if (!actorId || !organizationId) return;
  try {
    window.sessionStorage.removeItem(createIntentStorageKey(actorId, organizationId));
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

function conversationUpdateIntentStorageKey(actorId: string, organizationId: string, conversationId: string): string {
  return `chaste:conversation-update:${encodeURIComponent(actorId)}:${encodeURIComponent(organizationId)}:${encodeURIComponent(conversationId)}`;
}

function conversationUpdateFingerprint(conversationId: string, action: PendingConversationUpdate["action"]): string {
  return JSON.stringify([conversationId, action]);
}

function parsePendingConversationUpdate(value: unknown): PendingConversationUpdate | null {
  if (typeof value !== "object" || value === null) return null;
  const stored = value as Partial<PendingConversationUpdate>;
  if (
    typeof stored.conversationId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stored.conversationId)
    || typeof stored.intentId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stored.intentId)
    || typeof stored.fingerprint !== "string"
    || typeof stored.action !== "object"
    || stored.action === null
    || stored.action.action !== "update"
  ) return null;
  const action = stored.action as PendingConversationUpdate["action"];
  if (
    (action.title !== undefined && (typeof action.title !== "string" || action.title.trim().length < 1 || action.title.trim().length > 80))
    || (action.agentEnabled !== undefined && typeof action.agentEnabled !== "boolean")
    || (action.title === undefined && action.agentEnabled === undefined)
  ) return null;
  if (stored.fingerprint !== conversationUpdateFingerprint(stored.conversationId, action)) return null;
  return { conversationId: stored.conversationId, action, fingerprint: stored.fingerprint, intentId: stored.intentId };
}

function readPendingConversationUpdate(actorId: string, organizationId: string, conversationId: string): PendingConversationUpdate | null {
  try {
    return parsePendingConversationUpdate(JSON.parse(window.sessionStorage.getItem(conversationUpdateIntentStorageKey(actorId, organizationId, conversationId)) ?? "null"));
  } catch {
    return null;
  }
}

function readPendingConversationUpdateForScope(actorId: string, organizationId: string): PendingConversationUpdate | null {
  const prefix = `chaste:conversation-update:${encodeURIComponent(actorId)}:${encodeURIComponent(organizationId)}:`;
  try {
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const pending = parsePendingConversationUpdate(JSON.parse(window.sessionStorage.getItem(key) ?? "null"));
      if (pending) return pending;
    }
  } catch {
    return null;
  }
  return null;
}

function persistPendingConversationUpdate(actorId: string | null, organizationId: string | null, update: PendingConversationUpdate): void {
  if (!actorId || !organizationId) return;
  try {
    window.sessionStorage.setItem(conversationUpdateIntentStorageKey(actorId, organizationId, update.conversationId), JSON.stringify(update));
  } catch {
    // The in-memory intent still protects retries for this page session.
  }
}

function clearPendingConversationUpdate(actorId: string | null, organizationId: string | null, conversationId: string): void {
  if (!actorId || !organizationId) return;
  try {
    window.sessionStorage.removeItem(conversationUpdateIntentStorageKey(actorId, organizationId, conversationId));
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

function conversationArchiveIntentStorageKey(actorId: string, organizationId: string, conversationId: string): string {
  return `chaste:conversation-archive:${encodeURIComponent(actorId)}:${encodeURIComponent(organizationId)}:${encodeURIComponent(conversationId)}`;
}

function conversationArchiveFingerprint(conversationId: string, action: PendingConversationArchive["action"]): string {
  return JSON.stringify([conversationId, action]);
}

function parsePendingConversationArchive(value: unknown): PendingConversationArchive | null {
  if (typeof value !== "object" || value === null) return null;
  const stored = value as Partial<PendingConversationArchive>;
  if (
    typeof stored.conversationId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stored.conversationId)
    || typeof stored.intentId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stored.intentId)
    || typeof stored.fingerprint !== "string"
    || typeof stored.action !== "object"
    || stored.action === null
    || stored.action.action !== "archive"
    || typeof stored.action.archived !== "boolean"
  ) return null;
  const action = stored.action as PendingConversationArchive["action"];
  if (stored.fingerprint !== conversationArchiveFingerprint(stored.conversationId, action)) return null;
  return { conversationId: stored.conversationId, action, fingerprint: stored.fingerprint, intentId: stored.intentId };
}

function readPendingConversationArchiveForScope(actorId: string, organizationId: string): PendingConversationArchive | null {
  const prefix = `chaste:conversation-archive:${encodeURIComponent(actorId)}:${encodeURIComponent(organizationId)}:`;
  try {
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const pending = parsePendingConversationArchive(JSON.parse(window.sessionStorage.getItem(key) ?? "null"));
      if (pending) return pending;
    }
  } catch {
    return null;
  }
  return null;
}

function persistPendingConversationArchive(actorId: string | null, organizationId: string | null, archive: PendingConversationArchive): void {
  if (!actorId || !organizationId) return;
  try {
    window.sessionStorage.setItem(conversationArchiveIntentStorageKey(actorId, organizationId, archive.conversationId), JSON.stringify(archive));
  } catch {
    // The in-memory intent still protects retries for this page session.
  }
}

function clearPendingConversationArchive(actorId: string | null, organizationId: string | null, conversationId: string): void {
  if (!actorId || !organizationId) return;
  try {
    window.sessionStorage.removeItem(conversationArchiveIntentStorageKey(actorId, organizationId, conversationId));
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

async function messageActionFingerprint(action: {
  conversationId: string;
  body: string;
  mentions: MessageMention[];
  parentMessageId?: string;
  attachmentIds: string[];
}): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(action));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function getGoSendIntent(
  me: string | null,
  action: Parameters<typeof messageActionFingerprint>[0],
  cached: GoSendIntentRef,
): Promise<GoSendIntent> {
  const fingerprint = await messageActionFingerprint(action);
  const storageKey = goSendIntentStorageKey(me, action.conversationId, fingerprint);
  if (cached.current?.storageKey === storageKey && cached.current.fingerprint === fingerprint) return cached.current;

  try {
    const stored = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as { intentId?: unknown } | null;
    if (typeof stored?.intentId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stored.intentId)) {
      const intent = { storageKey, fingerprint, intentId: stored.intentId };
      cached.current = intent;
      return intent;
    }
  } catch {
    // The in-memory copy still protects a retry if browser storage is unavailable.
  }

  const intent = { storageKey, fingerprint, intentId: crypto.randomUUID() };
  cached.current = intent;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify({ intentId: intent.intentId }));
  } catch {
    // The in-memory copy still protects a retry if browser storage is unavailable.
  }
  return intent;
}

function clearGoSendIntent(intent: GoSendIntent, cached: GoSendIntentRef): void {
  if (cached.current?.intentId === intent.intentId) cached.current = null;
  try {
    const stored = JSON.parse(window.localStorage.getItem(intent.storageKey) ?? "null") as { intentId?: unknown } | null;
    if (stored?.intentId === intent.intentId) window.localStorage.removeItem(intent.storageKey);
  } catch {
    // A stale record is harmless because the next action must match its digest.
  }
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof MessagingApiError ? error.message : fallback;
}

/** Pins the thread to the newest message. Direct assignment, not scrollTo, so it works without a layout engine. */
function pinThreadToEnd(panel: HTMLElement | null): void {
  if (panel) panel.scrollTop = panel.scrollHeight;
}

function revealMessage(messageId: string): void {
  document.getElementById(`message-${messageId}`)?.scrollIntoView?.({ behavior: "smooth", block: "center" });
}

function useWideViewport(): boolean {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(min-width: 1024px)").matches);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(min-width: 1024px)");
    const onChange = () => setWide(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return wide;
}

function MessageBody({ body }: { body: string }) {
  const parts = body.split(/(@[A-Za-z0-9_.-]+)/g);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith("@")
          ? <span key={index} className="messages-mention">{part}</span>
          : part)}
    </>
  );
}

function Skeleton({ rows = 5, block, label }: { rows?: number; block?: boolean; label: string }) {
  return (
    <div className="messages-skeleton messages-skeleton-busy" aria-label={label} aria-busy="true">
      {Array.from({ length: rows }, (_, index) => <i key={index} style={block ? { height: 44 } : undefined} />)}
    </div>
  );
}

function ThreadMessage({
  message,
  previous,
  people,
  me,
  readers,
  replies,
  editing,
  editingBody,
  editLocked,
  focused,
  reactionMenuOpen,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onEditBody,
  onReply,
  onToggleReactionMenu,
  onReact,
  onTogglePin,
  onRequestDelete,
}: {
  message: Message;
  previous: Message | undefined;
  people: Person[];
  me: string | null;
  readers: MessageReader[];
  replies: number;
  editing: boolean;
  editingBody: string;
  editLocked: boolean;
  focused: boolean;
  reactionMenuOpen: boolean;
  onStartEdit: (message: Message) => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onEditBody: (value: string) => void;
  onReply: (message: Message) => void;
  onToggleReactionMenu: (id: string) => void;
  onReact: (emoji: string, active: boolean) => void;
  onTogglePin: () => void;
  onRequestDelete: (id: string) => void;
}) {
  const tone = bubbleTone(message, me);
  const senderName = senderDisplayName(message, people, me);
  const grouped = isGroupedWith(previous, message);
  const seenBy = seenByReaders(message, readers, me);
  const stamp = `${timeAgo(message.createdAt)}${message.editedAt ? " · edited" : ""}`;
  const initials = tone === "system" ? "•" : tone === "agent" ? "✦" : senderName.slice(0, 2);

  const className = [
    "messages-message",
    message.parentMessageId ? "messages-message-reply" : "",
    grouped ? "messages-message-grouped" : "",
    focused ? "messages-message-focused" : "",
  ].filter(Boolean).join(" ");

  return (
    <>
      {(!previous || !sameCalendarDay(previous.createdAt, message.createdAt)) && (
        <p className="messages-day-divider">{dayLabel(message.createdAt)}</p>
      )}
      <div className={className} id={`message-${message.id}`}>
        {grouped ? <span className="messages-avatar-gap" aria-hidden="true" /> : (
          <span aria-hidden="true" className={`messages-avatar messages-avatar-${tone}`}>{initials}</span>
        )}
        <div className="messages-message-main">
          {!grouped && (
            <p className="messages-message-author">
              <strong>{senderName}</strong>
              <time dateTime={message.createdAt}>{stamp}</time>
            </p>
          )}
          {editing ? (
            <div className="messages-edit-form">
              <textarea
                value={editingBody}
                onChange={(event) => onEditBody(event.target.value)}
                rows={2}
                aria-label="Edit message"
                readOnly={editLocked}
              />
              <div className="messages-edit-actions">
                <button type="button" className="messages-button messages-button-primary" onClick={onSaveEdit} disabled={!editingBody.trim()}>Save</button>
                <button type="button" className="messages-button messages-button-quiet" onClick={onCancelEdit} disabled={editLocked}>Cancel</button>
              </div>
            </div>
          ) : (
            <>
              {message.body && (
                <div className={`messages-bubble messages-bubble-${tone}`}><MessageBody body={message.body} /></div>
              )}
              {message.attachments.length > 0 && (
                <div className="messages-attachments">
                  {message.attachments.map((attachment) => (
                    <a key={attachment.id} href={attachment.href} download className="messages-attachment">
                      <span aria-hidden="true">📎</span>
                      <span>{attachment.filename}</span>
                      <em>{formatFileSize(attachment.sizeBytes)}</em>
                    </a>
                  ))}
                </div>
              )}
              {message.reactions.length > 0 && (
                <div className="messages-reactions">
                  {message.reactions.map((reaction) => (
                    <button
                      key={reaction.emoji}
                      type="button"
                      className="messages-reaction"
                      aria-pressed={reaction.reactedByMe}
                      aria-label={`${reaction.emoji}, ${reaction.count} reactions${reaction.names.length ? `, ${reaction.names.join(", ")}` : ""}`}
                      onClick={() => onReact(reaction.emoji, !reaction.reactedByMe)}
                    >
                      {reaction.emoji} {reaction.count}
                    </button>
                  ))}
                </div>
              )}
              {reactionMenuOpen && (
                <div className="messages-reaction-picker">
                  {REACTIONS.map((emoji) => (
                    <button key={emoji} type="button" aria-label={`React ${emoji}`} onClick={() => onReact(emoji, true)}>{emoji}</button>
                  ))}
                </div>
              )}
              <div className="messages-message-actions">
                {grouped && <span className="messages-message-time">{stamp}</span>}
                <button type="button" className="messages-message-action" onClick={() => onReply(message)}>Reply{replies > 0 ? ` · ${replies}` : ""}</button>
                <button type="button" className="messages-message-action" aria-expanded={reactionMenuOpen} onClick={() => onToggleReactionMenu(message.id)}>React</button>
                <button type="button" className="messages-message-action" onClick={onTogglePin}>{message.pinnedAt ? "Unpin" : "Pin"}</button>
                {tone === "mine" && (
                  <>
                    <button type="button" className="messages-message-action" aria-label="Edit message" onClick={() => onStartEdit(message)}>Edit</button>
                    <button type="button" className="messages-message-action messages-message-action-danger" aria-label="Delete message" onClick={() => onRequestDelete(message.id)}>Delete</button>
                  </>
                )}
                {seenBy.length > 0 && (
                  <span className="messages-seen-by">Seen by {seenBy.slice(0, 3).join(", ")}{seenBy.length > 3 ? ` +${seenBy.length - 3}` : ""}</span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function Dialog({ open, title, description, onClose, children }: { open: boolean; title: string; description: string; onClose: () => void; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="messages-dialog-backdrop" role="presentation" onClick={onClose}>
      <div className="messages-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <header className="messages-dialog-header">
          <div>
            <p className="messages-eyebrow">Conversation settings</p>
            <h2>{title}</h2>
            <p>{description}</p>
          </div>
          <button type="button" className="messages-icon-button" aria-label="Close conversation settings" onClick={onClose}>×</button>
        </header>
        {children}
      </div>
    </div>
  );
}

function ConfirmDialog({ open, title, body, confirmLabel, onClose, onConfirm, actionsDisabled = false, cancelDisabled = false, dismissDisabled = false }: { open: boolean; title: string; body: string; confirmLabel: string; onClose: () => void; onConfirm: () => void; actionsDisabled?: boolean; cancelDisabled?: boolean; dismissDisabled?: boolean }) {
  if (!open) return null;
  return (
    <div className="messages-dialog-backdrop" role="presentation" onClick={() => { if (!actionsDisabled && !dismissDisabled) onClose(); }}>
      <div className="messages-dialog messages-dialog-narrow" role="alertdialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <header className="messages-dialog-header">
          <h2>{title}</h2>
        </header>
        <p className="messages-dialog-body">{body}</p>
        <footer className="messages-dialog-footer">
          <button type="button" className="messages-button messages-button-quiet" onClick={onClose} disabled={actionsDisabled || cancelDisabled}>Cancel</button>
          <button type="button" className="messages-button messages-button-danger" onClick={onConfirm} disabled={actionsDisabled}>{confirmLabel}</button>
        </footer>
      </div>
    </div>
  );
}

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="messages-switch"
      onClick={() => onChange(!checked)}
    />
  );
}

type ModuleState =
  | { status: "checking" }
  | { status: "ready" }
  | { status: "disabled" }
  | { status: "failed"; message: string };

function ChannelName({ conversation }: { conversation: Conversation }) {
  return <>{conversation.kind === "dm" ? "" : "#"}{conversation.title}</>;
}

export function MessagesPage({ actorId = null, organizationId = null }: { actorId?: string | null; organizationId?: string | null } = {}) {
  const wide = useWideViewport();
  const [moduleState, setModuleState] = useState<ModuleState>({ status: "checking" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [readers, setReaders] = useState<MessageReader[]>([]);
  const [pinnedMessages, setPinnedMessages] = useState<PinnedMessage[]>([]);
  const [presence, setPresence] = useState<ConversationPresence[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadForId, setThreadForId] = useState<string | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null);
  const [listFilter, setListFilter] = useState<ListFilter>("active");
  const [searchMode, setSearchMode] = useState<SearchMode>("conversations");
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<MessageSearchResult[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [mobileListVisible, setMobileListVisible] = useState(true);
  const [draft, setDraft] = useState("");
  const [draftStatus, setDraftStatus] = useState<DraftStatus>("saved");
  const [sending, setSending] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [composerPending, setComposerPending] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [reactionMenuId, setReactionMenuId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState("");
  const [editingScope, setEditingScope] = useState<string | null>(null);
  const [editLocked, setEditLocked] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [composerOpen, setComposerOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newAgent, setNewAgent] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [memberQuery, setMemberQuery] = useState("");
  const [memberResults, setMemberResults] = useState<Person[]>([]);
  const [addUserId, setAddUserId] = useState("");
  const [dialogNotice, setDialogNotice] = useState<Notice | null>(null);
  const [pendingConversationUpdate, setPendingConversationUpdate] = useState<PendingConversationUpdate | null>(null);
  const [pendingConversationArchive, setPendingConversationArchive] = useState<PendingConversationArchive | null>(null);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [confirmDeleteConversation, setConfirmDeleteConversation] = useState(false);
  const [confirmDeleteMessageId, setConfirmDeleteMessageId] = useState<string | null>(null);
  const [confirmDeleteMessageScope, setConfirmDeleteMessageScope] = useState<string | null>(null);
  const [confirmDeleteLocked, setConfirmDeleteLocked] = useState(false);

  const threadRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const autoScrollRef = useRef(false);
  const draftOwnerRef = useRef<string | null>(null);
  const createIntentRef = useRef<PendingCreateIntent | null>(null);
  const creatingRef = useRef(false);
  const lifecycleBusyRef = useRef(false);
  const pendingConversationUpdateRef = useRef<PendingConversationUpdate | null>(null);
  const pendingConversationArchiveRef = useRef<PendingConversationArchive | null>(null);
  const goSendIntentRef = useRef<GoSendIntent | null>(null);
  const aroundTargetRef = useRef<string | null>(null);
  const wideRef = useRef(wide);
  const messageEditScopeRef = useRef(messageEditScopeIdentity(actorId, organizationId, activeId));
  const messageDeleteScopeRef = useRef(messageDeleteScopeIdentity(actorId, organizationId));
  wideRef.current = wide;
  messageEditScopeRef.current = messageEditScopeIdentity(actorId, organizationId, activeId);
  messageDeleteScopeRef.current = messageDeleteScopeIdentity(actorId, organizationId);

  useEffect(() => {
    createIntentRef.current = null;
    setNewTitle("");
    setNewAgent(true);
    setComposerOpen(false);
    setNotice(null);
    if (!actorId || !organizationId) return;
    const pending = readPendingCreateIntent(actorId, organizationId);
    if (!pending) return;
    createIntentRef.current = pending;
    setNewTitle(pending.title);
    setNewAgent(pending.agentEnabled);
    setComposerOpen(true);
    setNotice({ tone: "pending", text: "An earlier channel creation is unresolved. Submit the saved details to check the same request." });
  }, [actorId, organizationId]);

  useEffect(() => {
    pendingConversationArchiveRef.current = null;
    setPendingConversationArchive(null);
    if (!actorId || !organizationId) return;
    const pending = readPendingConversationArchiveForScope(actorId, organizationId);
    if (!pending) return;
    pendingConversationArchiveRef.current = pending;
    setPendingConversationArchive(pending);
    setActiveId(pending.conversationId);
    setSettingsOpen(true);
    setDialogNotice({ tone: "pending", text: "An earlier archive change is unresolved. Retry the saved action to check the same request." });
  }, [actorId, organizationId]);

  useEffect(() => {
    pendingConversationUpdateRef.current = null;
    setPendingConversationUpdate(null);
    if (!actorId || !organizationId) return;
    const pending = readPendingConversationUpdateForScope(actorId, organizationId);
    if (!pending) return;
    pendingConversationUpdateRef.current = pending;
    setPendingConversationUpdate(pending);
    setActiveId(pending.conversationId);
    setRenameValue(pending.action.title ?? "");
    setSettingsOpen(true);
    setDialogNotice({ tone: "pending", text: "An earlier conversation update is unresolved. Retry the saved change to check the same request." });
  }, [actorId, organizationId]);

  const activeConv = conversations?.find((conversation) => conversation.id === activeId) ?? null;
  const counts = conversationCounts(conversations ?? []);
  const visible = visibleConversations(conversations ?? [], listFilter, searchMode === "conversations" ? searchText : "");
  const typingNames = presence.filter((person) => person.typing).map((person) => person.name);
  const replies = useMemo(() => replyCounts(messages), [messages]);
  const mentionCandidates = useMemo(
    () => (mentionQuery == null
      ? []
      : people.filter((person) => personAlias(person).toLocaleLowerCase().startsWith(mentionQuery.toLocaleLowerCase()))),
    [mentionQuery, people],
  );

  useEffect(() => {
    if (!actorId || !organizationId) return;
    let current = true;
    void getPendingMessageEdit({ actorId, organizationId }).then((pending) => {
      if (!current || !pending) return;
      if (pending.conversationId) setActiveId(pending.conversationId);
      setEditingId(pending.messageId);
      setEditingBody(pending.body);
      setEditingScope(messageEditScopeIdentity(actorId, organizationId, pending.conversationId));
      setEditLocked(true);
      setNotice({ tone: "pending", text: "An earlier message edit is unresolved. Retry the restored edit to check its result." });
    }).catch((error: unknown) => {
      if (current) setNotice({ tone: "error", text: errorText(error, "Could not restore the pending message edit.") });
    });
    return () => { current = false; };
  }, [actorId, organizationId]);

  useEffect(() => {
    if (!actorId || !organizationId) return;
    let current = true;
    void getPendingMessageDelete({ actorId, organizationId }).then((pending) => {
      if (!current || !pending) return;
      if (pending.conversationId) setActiveId(pending.conversationId);
      setConfirmDeleteMessageScope(messageDeleteScopeIdentity(actorId, organizationId));
      setConfirmDeleteMessageId(pending.messageId);
      setConfirmDeleteLocked(true);
      setNotice({ tone: "pending", text: "An earlier message deletion is unresolved. Confirm the saved deletion to check its result." });
    }).catch((error: unknown) => {
      if (current) setNotice({ tone: "error", text: errorText(error, "Could not restore the pending message deletion.") });
    });
    return () => { current = false; };
  }, [actorId, organizationId]);

  useEffect(() => {
    if (confirmDeleteMessageId == null) return;
    const currentScope = messageDeleteScopeIdentity(actorId, organizationId);
    if (confirmDeleteMessageScope !== currentScope) {
      setConfirmDeleteMessageId(null);
      setConfirmDeleteMessageScope(null);
      setConfirmDeleteLocked(false);
    }
  }, [actorId, confirmDeleteMessageId, confirmDeleteMessageScope, organizationId]);

  const loadConversations = useCallback(async (signal?: AbortSignal) => {
    setLoadError(null);
    try {
      const result = await fetchConversations(signal);
      if (signal?.aborted) return;
      setConversations(result.conversations);
      setMe(result.me);
      // The legacy page auto-opens the first channel on a wide screen only, so a
      // narrow reader always lands on the conversation list first.
      setActiveId((current) => current ?? (wideRef.current ? result.conversations.find((conversation) => !conversation.archivedAt)?.id ?? null : null));
    } catch (error) {
      if (signal?.aborted) return;
      setLoadError(errorText(error, "Could not connect to Messages."));
      setConversations(null);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setModuleState({ status: await fetchMessagingEnabled(controller.signal) ? "ready" : "disabled" });
      } catch (error) {
        if (controller.signal.aborted) return;
        setModuleState({ status: "failed", message: errorText(error, "Could not reach the messaging service.") });
      }
      if (controller.signal.aborted) return;
      void loadConversations(controller.signal);
      try {
        setPeople(await fetchConversationPeople(undefined, controller.signal));
      } catch (error) {
        if (!controller.signal.aborted) {
          setPeople([]);
          if (messagingPeopleReadsGoSelected()) {
            setNotice({ tone: "error", text: errorText(error, "Could not load people for mentions.") });
          }
        }
      }
    })();
    return () => controller.abort();
  }, [loadConversations]);

  const applyThread = useCallback((result: ConversationThread) => {
    setMessages(result.messages);
    setReaders(result.readers);
    setPinnedMessages(result.pinnedMessages);
    setHasOlder(result.hasMore);
    setOlderCursor(result.nextCursor);
    setThreadError(null);
  }, []);

  const refreshThread = useCallback(async (
    conversationId: string,
    options: { aroundId?: string; showLoading?: boolean; scrollToBottom?: boolean; markRead?: boolean } = {},
  ): Promise<boolean> => {
    if (options.showLoading) setThreadLoading(true);
    try {
      const result = await fetchConversationThread(conversationId, options.aroundId ? { aroundId: options.aroundId } : {});
      applyThread(result);
      setThreadForId(conversationId);
      if (options.scrollToBottom) autoScrollRef.current = true;
      const latestAt = result.messages.at(-1)?.createdAt;
      const ownReadAt = result.readers.find((reader) => reader.userId === result.me)?.lastReadAt ?? null;
      if (options.markRead && latestAt && (!ownReadAt || Date.parse(latestAt) > Date.parse(ownReadAt))) {
        void advanceReadCursor(conversationId, latestAt)
          .then(() => loadConversations())
          .catch(() => undefined);
      }
      return true;
    } catch (error) {
      setThreadError(errorText(error, "Could not load this conversation."));
      return false;
    } finally {
      if (options.showLoading) setThreadLoading(false);
    }
  }, [applyThread, loadConversations]);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      setReaders([]);
      setPinnedMessages([]);
      setPresence([]);
      setThreadLoading(false);
      setThreadForId(null);
      setThreadError(null);
      return;
    }
    const aroundId = aroundTargetRef.current ?? undefined;
    aroundTargetRef.current = null;
    void refreshThread(activeId, { aroundId, showLoading: true, scrollToBottom: !aroundId, markRead: true });
    setMobileListVisible(false);
  }, [activeId, refreshThread]);

  useEffect(() => {
    if (!autoScrollRef.current) return;
    autoScrollRef.current = false;
    pinThreadToEnd(threadRef.current);
  }, [messages]);

  useEffect(() => {
    if (!activeId) {
      draftOwnerRef.current = null;
      setDraft("");
      return;
    }
    draftOwnerRef.current = activeId;
    try {
      setDraft(window.localStorage.getItem(draftStorageKey(me, activeId)) ?? "");
      setDraftStatus("saved");
    } catch {
      setDraftStatus("unavailable");
    }
  }, [activeId, me]);

  useEffect(() => {
    if (!activeId || draftOwnerRef.current !== activeId) return;
    setDraftStatus("saving");
    const timer = window.setTimeout(() => {
      try {
        const key = draftStorageKey(me, activeId);
        if (draft.trim()) window.localStorage.setItem(key, draft);
        else window.localStorage.removeItem(key);
        setDraftStatus("saved");
      } catch {
        setDraftStatus("unavailable");
      }
    }, DRAFT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [activeId, draft, me]);

  useEffect(() => {
    const textarea = composerRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 176)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 176 ? "auto" : "hidden";
  }, [draft, activeId]);

  useEffect(() => {
    if (!activeId) return;
    const timer = window.setTimeout(() => {
      void reportConversationPresence(activeId, draft.trim().length > 0).catch(() => undefined);
    }, TYPING_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [activeId, draft]);

  useEffect(() => {
    if (searchMode !== "messages" || searchText.trim().length < 2) {
      setSearchResults([]);
      setSearchError(null);
      setSearchBusy(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setSearchBusy(true);
      setSearchError(null);
      void searchMessages(searchText.trim())
        .then(setSearchResults)
        .catch((error: unknown) => setSearchError(errorText(error, "Message search failed.")))
        .finally(() => setSearchBusy(false));
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchMode, searchText]);

  useEffect(() => {
    if (!settingsOpen || !memberQuery.trim()) {
      setMemberResults([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void fetchConversationPeople(memberQuery.trim())
        .then((found) => setMemberResults(found.filter((person) => person.type === "user")))
        .catch((error: unknown) => {
          setMemberResults([]);
          if (messagingPeopleReadsGoSelected()) {
            setDialogNotice({ tone: "error", text: errorText(error, "Could not search team members.") });
          }
        });
    }, MEMBER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [memberQuery, settingsOpen]);

  useEffect(() => {
    if (!activeId) return;
    let stopped = false;
    const refreshPresence = () => {
      if (document.visibilityState !== "visible") return;
      void fetchConversationPresence(activeId)
        .then((people) => { if (!stopped) setPresence(people); })
        .catch(() => undefined);
    };
    const heartbeat = () => {
      if (document.visibilityState !== "visible") return;
      void reportConversationPresence(activeId, false).catch(() => undefined);
    };
    refreshPresence();
    heartbeat();
    const threadTimer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const panel = threadRef.current;
      const atBottom = panel ? isNearBottom(panel) : true;
      if (atBottom) autoScrollRef.current = true;
      void refreshThread(activeId, { markRead: atBottom });
      refreshPresence();
    }, THREAD_POLL_MS);
    const heartbeatTimer = window.setInterval(heartbeat, HEARTBEAT_MS);
    const conversationsTimer = window.setInterval(() => { void loadConversations(); }, LIST_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(threadTimer);
      window.clearInterval(heartbeatTimer);
      window.clearInterval(conversationsTimer);
    };
  }, [activeId, loadConversations, refreshThread]);

  useEffect(() => {
    if (!focusedMessageId || !messages.some((message) => message.id === focusedMessageId)) return;
    revealMessage(focusedMessageId);
    const timer = window.setTimeout(() => setFocusedMessageId(null), FOCUS_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [focusedMessageId, messages]);

  const saveDraftNow = useCallback(() => {
    if (!activeId || draftOwnerRef.current !== activeId) return;
    try {
      const key = draftStorageKey(me, activeId);
      if (draft.trim()) window.localStorage.setItem(key, draft);
      else window.localStorage.removeItem(key);
    } catch {
      setDraftStatus("unavailable");
    }
  }, [activeId, draft, me]);

  const selectConversation = useCallback((conversationId: string) => {
    saveDraftNow();
    setActiveId(conversationId);
    setMobileListVisible(false);
    setNotice(null);
  }, [saveDraftNow]);

  /** Governed writes answer 202 while an approval is pending: neither success nor failure. */
  const report = useCallback((outcome: MessagingOutcome<unknown>, pendingFallback: string): boolean => {
    if (outcome.kind === "pending") {
      setNotice({ tone: "pending", text: outcome.reason || pendingFallback });
      return false;
    }
    return true;
  }, []);

  const loadOlder = useCallback(async () => {
    if (!activeId || !olderCursor || loadingOlder) return;
    const panel = threadRef.current;
    const previousHeight = panel?.scrollHeight ?? 0;
    setLoadingOlder(true);
    try {
      const result = await fetchOlderMessages(activeId, olderCursor);
      setMessages((current) => reconcileOlderMessages(current, result.messages));
      setHasOlder(result.hasMore);
      setOlderCursor(result.nextCursor);
      window.requestAnimationFrame(() => {
        if (panel) panel.scrollTop = panel.scrollHeight - previousHeight;
      });
    } catch {
      setThreadError("Could not load older messages. Scroll to the top to retry.");
    } finally {
      setLoadingOlder(false);
    }
  }, [activeId, loadingOlder, olderCursor]);

  const send = useCallback(async () => {
    if (!activeId || sending || (!draft.trim() && pendingAttachments.length === 0)) return;
    setSending(true);
    setComposerError(null);
    setComposerPending(null);
    let goSendIntent: GoSendIntent | null = null;
    try {
      const attachmentIds: string[] = [];
      for (const attachment of pendingAttachments) {
        if (attachment.attachmentId) {
          attachmentIds.push(attachment.attachmentId);
          continue;
        }
        const uploaded = await uploadConversationAttachment(activeId, attachment.file);
        attachmentIds.push(uploaded.attachmentId);
        setPendingAttachments((current) => current.map((item) => item.key === attachment.key ? { ...item, attachmentId: uploaded.attachmentId } : item));
      }
      const body = draft.trim();
      const mentions = extractMentions(body, people);
      const goFlagEnabled = typeof __GO_MESSAGING_SEND_SLICE__ !== "undefined" && __GO_MESSAGING_SEND_SLICE__;
      const allowGo = goFlagEnabled && activeConv != null && !activeConv.agentEnabled && !mentions.some((mention) => mention.type === "agent");
      const action = {
        conversationId: activeId,
        body,
        mentions,
        ...(replyTo ? { parentMessageId: replyTo.id } : {}),
        attachmentIds,
      };
      if (allowGo) goSendIntent = await getGoSendIntent(me, action, goSendIntentRef);
      const outcome = await sendConversationMessage(activeId, {
        body,
        mentions,
        parentMessageId: replyTo?.id,
        attachmentIds,
      }, undefined, { allowGo, intentId: goSendIntent?.intentId });
      if (outcome.kind === "pending") {
        setComposerPending(outcome.reason);
        return;
      }
      if (goSendIntent) clearGoSendIntent(goSendIntent, goSendIntentRef);
      setDraft("");
      setPendingAttachments([]);
      setReplyTo(null);
      setComposerPending(null);
      try {
        window.localStorage.removeItem(draftStorageKey(me, activeId));
        setDraftStatus("saved");
      } catch {
        setDraftStatus("unavailable");
      }
      autoScrollRef.current = true;
      await refreshThread(activeId, { scrollToBottom: true });
      void loadConversations();
    } catch (error) {
      if (goSendIntent && error instanceof MessagingApiError && [400, 401, 403, 404, 409, 413, 422, 428, 429].includes(error.status)) {
        clearGoSendIntent(goSendIntent, goSendIntentRef);
      }
      setComposerError(errorText(error, "Could not send the message. Your draft is still here."));
    } finally {
      setSending(false);
    }
  }, [activeConv, activeId, draft, loadConversations, me, pendingAttachments, people, refreshThread, replyTo, sending]);

  const addFiles = useCallback((fileList: FileList | null) => {
    if (!fileList) return;
    const files = Array.from(fileList);
    const problem = checkAttachmentLimits(pendingAttachments.length, files);
    if (problem) {
      setComposerError(problem);
      return;
    }
    setComposerError(null);
    setPendingAttachments((current) => [
      ...current,
      ...files.map((file) => ({ key: `${file.name}-${file.size}-${crypto.randomUUID()}`, file })),
    ]);
  }, [pendingAttachments.length]);

  const removeAttachment = useCallback(async (attachment: PendingAttachment) => {
    if (attachment.attachmentId) {
      if (!activeId) {
        setComposerError("Could not remove the uploaded attachment because no conversation is selected.");
        return;
      }
      try {
        await deletePendingAttachment(activeId, attachment.attachmentId);
      } catch (error) {
        setComposerError(errorText(error, "Could not remove the uploaded attachment. Please try again."));
        return;
      }
    }
    setPendingAttachments((current) => current.filter((item) => item.key !== attachment.key));
  }, [activeId]);

  const pickMention = useCallback((person: Person) => {
    const element = composerRef.current;
    if (!element) return;
    const caret = element.selectionStart ?? element.value.length;
    const next = applyMentionAlias(element.value, caret, personAlias(person));
    setDraft(next.text);
    setMentionQuery(null);
    window.requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(next.caret, next.caret);
    });
  }, []);

  const insertEmoji = useCallback((emoji: string) => {
    const element = composerRef.current;
    const caret = element ? element.selectionStart ?? draft.length : draft.length;
    const next = insertIntoText(draft, caret, element?.selectionEnd ?? caret, emoji);
    setDraft(next.text);
    setMentionQuery(null);
    setEmojiPickerOpen(false);
    window.requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(next.caret, next.caret);
    });
  }, [draft]);

  const openSearchResult = useCallback(async (result: MessageSearchResult) => {
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
  }, [activeId, refreshThread, saveDraftNow]);

  const runLifecycle = useCallback(async (action: Parameters<typeof changeConversation>[1]): Promise<boolean> => {
    if (!activeId) return false;
    if (lifecycleBusyRef.current) return false;
    lifecycleBusyRef.current = true;
    setLifecycleBusy(true);
    setDialogNotice(null);
    const goUpdateEnabled = typeof __GO_MESSAGING_CONVERSATION_UPDATE__ !== "undefined" && __GO_MESSAGING_CONVERSATION_UPDATE__;
    const goArchiveEnabled = conversationArchiveGoSelected();
    let updateIntent: PendingConversationUpdate | null = null;
    let archiveIntent: PendingConversationArchive | null = null;
    try {
      if (goUpdateEnabled && action.action === "update") {
        if (!actorId?.trim() || !organizationId?.trim()) {
          setDialogNotice({ tone: "error", text: "Conversation updates are paused until the actor and organization are resolved." });
          return false;
        }
        const fingerprint = conversationUpdateFingerprint(activeId, action);
        const retained = pendingConversationUpdateRef.current?.conversationId === activeId
          ? pendingConversationUpdateRef.current
          : readPendingConversationUpdate(actorId, organizationId, activeId);
        if (retained && retained.fingerprint !== fingerprint) {
          pendingConversationUpdateRef.current = retained;
          setPendingConversationUpdate(retained);
          setDialogNotice({ tone: "pending", text: "An earlier conversation update is unresolved. Retry the saved change before starting another update." });
          return false;
        }
        updateIntent = retained ?? {
          conversationId: activeId,
          action,
          fingerprint,
          intentId: crypto.randomUUID(),
        };
        pendingConversationUpdateRef.current = updateIntent;
        setPendingConversationUpdate(updateIntent);
        persistPendingConversationUpdate(actorId, organizationId, updateIntent);
      }
      if (action.action === "archive") {
        const retained = actorId?.trim() && organizationId?.trim()
          ? pendingConversationArchiveRef.current ?? readPendingConversationArchiveForScope(actorId, organizationId)
          : null;
        if (goArchiveEnabled || retained) {
          if (!actorId?.trim() || !organizationId?.trim()) {
            setDialogNotice({ tone: "error", text: "Conversation archive changes are paused until the actor and organization are resolved." });
            return false;
          }
          const fingerprint = conversationArchiveFingerprint(activeId, action);
          if (retained && retained.conversationId !== activeId) {
            pendingConversationArchiveRef.current = retained;
            setPendingConversationArchive(retained);
            setDialogNotice({ tone: "pending", text: "An earlier archive change is unresolved. Retry the saved action before changing another conversation." });
            return false;
          }
          if (retained && retained.fingerprint !== fingerprint) {
            pendingConversationArchiveRef.current = retained;
            setPendingConversationArchive(retained);
            setDialogNotice({ tone: "pending", text: "An earlier archive change is unresolved. Retry the saved action before starting another archive change." });
            return false;
          }
          archiveIntent = retained ?? {
            conversationId: activeId,
            action,
            fingerprint,
            intentId: crypto.randomUUID(),
          };
          pendingConversationArchiveRef.current = archiveIntent;
          setPendingConversationArchive(archiveIntent);
          persistPendingConversationArchive(actorId, organizationId, archiveIntent);
        }
      }
      const selectedIntent = updateIntent ?? archiveIntent;
      const outcome = selectedIntent
        ? await changeConversation(activeId, action, undefined, { intentId: selectedIntent.intentId, ...(archiveIntent ? { forceGo: true } : {}) })
        : await changeConversation(activeId, action);
      if (outcome.kind === "pending") {
        setDialogNotice({ tone: "pending", text: outcome.reason });
        return false;
      }
      if (updateIntent) {
        clearPendingConversationUpdate(actorId, organizationId, activeId);
        pendingConversationUpdateRef.current = null;
        setPendingConversationUpdate(null);
      }
      if (archiveIntent) {
        clearPendingConversationArchive(actorId, organizationId, activeId);
        pendingConversationArchiveRef.current = null;
        setPendingConversationArchive(null);
      }
      setDialogNotice(null);
      await loadConversations();
      return true;
    } catch (error) {
      setDialogNotice({ tone: "error", text: errorText(error, "That change did not go through.") });
      return false;
    } finally {
      lifecycleBusyRef.current = false;
      setLifecycleBusy(false);
    }
  }, [activeId, actorId, loadConversations, organizationId]);

  const saveEdit = useCallback(async () => {
    if (!editingId || !editingBody.trim()) return;
    const goEditEnabled = typeof __GO_MESSAGING_EDIT_SLICE__ !== "undefined" && __GO_MESSAGING_EDIT_SLICE__;
    const retainDraft = goEditEnabled;
    const requestScope = messageEditScopeIdentity(actorId, organizationId, activeId);
    if (!actorId?.trim() || !organizationId?.trim()) {
      setNotice({ tone: "error", text: "Message editing is paused until the actor and organization are resolved." });
      return;
    }
    if (editLocked && !goEditEnabled) {
      setNotice({ tone: "error", text: "This Go edit is unresolved. Restore Go message editing to retry the saved edit." });
      return;
    }
    if (goEditEnabled && (!actorId?.trim() || !organizationId?.trim() || !activeId?.trim())) {
      setNotice({ tone: "error", text: "Message editing is paused until the actor, organization, and conversation are resolved." });
      return;
    }
    if (goEditEnabled && editingScope !== requestScope) {
      setNotice({ tone: "error", text: "This edit belongs to another workspace. Reopen the message in the active workspace before editing." });
      return;
    }
    let keepEditing = false;
    try {
      const outcome = await editMessage(editingId, editingBody.trim(), undefined, {
        allowGo: goEditEnabled,
        actorId,
        organizationId,
        conversationId: activeId,
      });
      if (messageEditScopeRef.current !== requestScope) return;
      if (report(outcome, "Your edit is waiting for approval.")) {
        if (activeId && messageEditScopeRef.current === requestScope) await refreshThread(activeId);
        if (messageEditScopeRef.current !== requestScope) return;
        setNotice({ tone: "success", text: "Message updated." });
      } else {
        keepEditing = retainDraft;
        if (retainDraft) setEditLocked(true);
      }
    } catch (error) {
      if (messageEditScopeRef.current !== requestScope) return;
      setNotice({ tone: "error", text: errorText(error, "Could not update the message.") });
      keepEditing = retainDraft;
      if (retainDraft) {
        const status = error instanceof MessagingApiError ? error.status : 0;
        const safeToCorrect = status >= 400 && status < 500 && status !== 404 && status !== 408 && status !== 429;
        setEditLocked(!safeToCorrect);
      }
    } finally {
      if (messageEditScopeRef.current === requestScope && !keepEditing) {
        setEditingId(null);
        setEditingBody("");
        setEditingScope(null);
        setEditLocked(false);
      }
    }
  }, [activeId, actorId, editLocked, editingBody, editingId, editingScope, organizationId, refreshThread, report]);

  const removeMessage = useCallback(async (messageId: string) => {
    const goDeleteEnabled = typeof __GO_MESSAGING_DELETE_SLICE__ !== "undefined" && __GO_MESSAGING_DELETE_SLICE__;
    const currentDeleteScope = messageDeleteScopeIdentity(actorId, organizationId);
    if (confirmDeleteLocked && !goDeleteEnabled) {
      setNotice({ tone: "error", text: "This Go deletion is unresolved. Restore Go message deletion to retry the saved deletion." });
      return;
    }
    if (goDeleteEnabled && confirmDeleteMessageScope !== currentDeleteScope) {
      setConfirmDeleteMessageId(null);
      setConfirmDeleteMessageScope(null);
      setConfirmDeleteLocked(false);
      setNotice({ tone: "error", text: "The active workspace changed. Reopen the deletion confirmation for this message." });
      return;
    }
    if (!actorId?.trim() || !organizationId?.trim() || (goDeleteEnabled && !activeId?.trim())) {
      setConfirmDeleteMessageId(null);
      setConfirmDeleteMessageScope(null);
      setConfirmDeleteLocked(false);
      setNotice({
        tone: "error",
        text: goDeleteEnabled
          ? "Message deletion is paused until the actor, organization, and conversation are resolved."
          : "Message deletion is paused until the actor and organization are resolved.",
      });
      return;
    }
    setConfirmDeleteMessageId(null);
    setConfirmDeleteMessageScope(null);
    setConfirmDeleteLocked(false);
    const retainConfirmation = goDeleteEnabled;
    try {
      const outcome = await deleteMessageRequest(messageId, undefined, {
        allowGo: goDeleteEnabled,
        actorId,
        organizationId,
        conversationId: activeId,
      });
      if (messageDeleteScopeRef.current !== currentDeleteScope) return;
      if (report(outcome, "Deleting this message is waiting for approval.")) {
        if (activeId) await refreshThread(activeId);
        if (messageDeleteScopeRef.current !== currentDeleteScope) return;
        setNotice({ tone: "success", text: "Message deleted." });
      } else if (retainConfirmation) {
        setConfirmDeleteMessageScope(currentDeleteScope);
        setConfirmDeleteMessageId(messageId);
        setConfirmDeleteLocked(true);
      }
    } catch (error) {
      if (messageDeleteScopeRef.current !== currentDeleteScope) return;
      setNotice({ tone: "error", text: errorText(error, "Could not delete the message.") });
      if (retainConfirmation) {
        setConfirmDeleteMessageScope(currentDeleteScope);
        setConfirmDeleteMessageId(messageId);
        const status = error instanceof MessagingApiError ? error.status : 0;
        const safeToRetry = status >= 400 && status < 500 && status !== 404 && status !== 408 && status !== 429;
        setConfirmDeleteLocked(!safeToRetry);
      }
    }
  }, [activeId, actorId, confirmDeleteLocked, confirmDeleteMessageScope, organizationId, refreshThread, report]);

  const changeReaction = useCallback(async (messageId: string, emoji: string, active: boolean) => {
    try {
      await setMessageReaction(messageId, emoji, active);
      if (activeId) await refreshThread(activeId);
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error, "Could not save that reaction.") });
    }
  }, [activeId, refreshThread]);

  const togglePin = useCallback(async (message: Message) => {
    try {
      await setMessagePin(message.id, !message.pinnedAt);
      if (activeId) await refreshThread(activeId);
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error, "Could not pin that message.") });
    }
  }, [activeId, refreshThread]);

  const createConversationFromForm = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (!newTitle.trim() || creatingRef.current) return;
    const title = newTitle.trim();
    const fingerprint = JSON.stringify([title, newAgent]);
    if (createIntentRef.current?.fingerprint !== fingerprint) {
      createIntentRef.current = { fingerprint, intentId: crypto.randomUUID(), title, agentEnabled: newAgent };
      persistPendingCreateIntent(actorId, organizationId, createIntentRef.current);
    }
    const intentId = createIntentRef.current.intentId;
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const outcome = await createConversation({ title, agentEnabled: newAgent }, undefined, { intentId });
      if (outcome.kind === "pending") {
        setNotice({
          tone: "pending",
          text: `${outcome.reason} Your channel details are saved. Submit again after approval to check the same request.`,
        });
        void loadConversations();
        return;
      }
      createIntentRef.current = null;
      clearPendingCreateIntent(actorId, organizationId);
      setNotice(null);
      setNewTitle("");
      setComposerOpen(false);
      await loadConversations();
      setActiveId(outcome.data.conversationId);
      setMobileListVisible(false);
    } catch (error) {
      setNotice(null);
      setCreateError(errorText(error, "Could not create the conversation."));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }, [actorId, loadConversations, newAgent, newTitle, organizationId]);

  const updateNewTitle = useCallback((value: string) => {
    if (value.trim() !== newTitle.trim()) {
      createIntentRef.current = null;
      clearPendingCreateIntent(actorId, organizationId);
    }
    setNewTitle(value);
  }, [actorId, newTitle, organizationId]);

  const updateNewAgent = useCallback((value: boolean) => {
    if (value !== newAgent) {
      createIntentRef.current = null;
      clearPendingCreateIntent(actorId, organizationId);
    }
    setNewAgent(value);
  }, [actorId, newAgent, organizationId]);

  const leaveConversation = useCallback(async () => {
    if (await runLifecycle({ action: "leave" })) {
      setSettingsOpen(false);
      setActiveId(null);
    }
  }, [runLifecycle]);

  const destroyConversation = useCallback(async () => {
    const finished = await runLifecycle({ action: "delete" });
    setConfirmDeleteConversation(false);
    if (finished) {
      setSettingsOpen(false);
      setActiveId(null);
    }
  }, [runLifecycle]);

  if (moduleState.status === "checking") {
    return <div className="messages-page"><div className="messages-loading" aria-label="Checking the Messaging module" aria-busy="true">Checking Messages…</div></div>;
  }
  if (moduleState.status === "disabled") {
    return (
      <div className="messages-page">
        <div className="messages-disabled">
          <span aria-hidden="true">#</span>
          <h1>Messages is turned off</h1>
          <p>Your workspace has not enabled the Messaging module yet. An owner can switch it on from Modules; the channels and drafts here stay where they are.</p>
        </div>
      </div>
    );
  }
  if (moduleState.status === "failed") {
    return (
      <div className="messages-page">
        <div className="messages-notice messages-notice-error" role="alert">
          <span>{moduleState.message}</span>
        </div>
      </div>
    );
  }

  const listHidden = Boolean(activeId) && !mobileListVisible;
  const threadHidden = !activeId || mobileListVisible;
  // Hold the skeleton until the thread on screen belongs to the selected conversation,
  // so switching channels never flashes the previous thread or an empty pane.
  const threadBusy = threadLoading || (activeId != null && threadForId !== activeId);

  return (
    <div className="messages-page">
      <header className="messages-header">
        <p className="messages-eyebrow">Messaging</p>
        <h1>Team channels and DMs</h1>
        <p>Conversations with Chaste enabled let your AI workmate read the thread and act when colleagues ask.</p>
      </header>

      {notice && (
        <div className={`messages-notice messages-notice-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
          <span>{notice.text}</span>
          <button type="button" className="messages-notice-close" aria-label="Dismiss notice" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <div className="messages-layout">
        <aside className="messages-list-panel" data-hidden={listHidden} aria-label="Conversations">
          <div className="messages-list-heading">
            <h2>Conversations</h2>
            <button
              type="button"
              className="messages-icon-button"
              aria-label={composerOpen ? "Cancel creating a conversation" : "Create a conversation"}
              aria-expanded={composerOpen}
              onClick={() => setComposerOpen((open) => !open)}
            >
              {composerOpen ? "×" : "+"}
            </button>
          </div>

          <div className="messages-list-controls">
            <div className="messages-mode-toggle" role="group" aria-label="What to search">
              {(["conversations", "messages"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className="messages-mode-button"
                  aria-pressed={searchMode === mode}
                  onClick={() => setSearchMode(mode)}
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
              placeholder={searchMode === "messages" ? "Search message history" : "Find a conversation"}
            />
            {searchMode === "conversations" && (
              <div className="messages-filter-toggle" role="group" aria-label="Conversation filter">
                {(["active", "archived"] as const).map((view) => (
                  <button
                    key={view}
                    type="button"
                    className="messages-filter-button"
                    aria-pressed={listFilter === view}
                    onClick={() => setListFilter(view)}
                  >
                    {view} <span>{counts[view]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {composerOpen && (
            <form className="messages-create-form" onSubmit={createConversationFromForm}>
              <input
                type="text"
                value={newTitle}
                onChange={(event) => updateNewTitle(event.target.value)}
                placeholder="Channel name"
                aria-label="New channel name"
              />
              <label>
                <input type="checkbox" checked={newAgent} onChange={(event) => updateNewAgent(event.target.checked)} />
                Include Chaste (AI workmate)
              </label>
              {createError && <p className="messages-composer-error" role="alert">{createError}</p>}
              <button type="submit" className="messages-button messages-button-primary messages-button-block" disabled={!newTitle.trim() || creating}>
                {creating ? "Creating" : "Create"}
              </button>
            </form>
          )}

          <div className="messages-list-scroll" role="listbox" aria-label="Conversations">
            {conversations === null ? (
              loadError ? (
                <div className="messages-list-error" role="alert">
                  <p>{loadError}</p>
                  <span>Your channels could not be reached.</span>
                  <button type="button" className="messages-button messages-button-quiet" onClick={() => { void loadConversations(); }}>Retry</button>
                </div>
              ) : <Skeleton rows={6} label="Loading conversations" />
            ) : searchMode === "messages" ? (
              searchText.trim().length < 2 ? (
                <p className="messages-list-empty">Enter at least two characters to search the full message history.</p>
              ) : searchBusy ? (
                <Skeleton rows={4} block label="Searching messages" />
              ) : searchError ? (
                <p className="messages-list-empty" role="alert">{searchError}</p>
              ) : searchResults.length === 0 ? (
                <p className="messages-list-empty">No messages match &ldquo;{searchText.trim()}&rdquo;.</p>
              ) : searchResults.map((result) => (
                <button key={result.id} type="button" className="messages-search-result" onClick={() => { void openSearchResult(result); }}>
                  <strong>#{result.conversationTitle}</strong>
                  <span>{result.body}</span>
                  <time dateTime={result.createdAt}>{timeAgo(result.createdAt)}</time>
                </button>
              ))
            ) : conversations.length === 0 && listFilter === "active" ? (
              <div className="messages-first-channel">
                <span aria-hidden="true">#</span>
                <h3>Create your first channel</h3>
                <p>Give your team a shared place for updates, questions, and decisions.</p>
                <button type="button" className="messages-button messages-button-primary messages-button-block" onClick={() => setComposerOpen(true)}>Create your first channel</button>
                <p className="messages-suggestion-label">Start with a suggestion</p>
                <div className="messages-suggestions">
                  {["general", "operations", "announcements"].map((name) => (
                    <button key={name} type="button" className="messages-suggestion" onClick={() => { setNewTitle(name); setComposerOpen(true); }}>#{name}</button>
                  ))}
                </div>
              </div>
            ) : visible.length === 0 ? (
              <p className="messages-list-empty">
                {listFilter === "archived" ? "No archived conversations." : searchText.trim() ? "No conversations match your search." : "No active conversations."}
              </p>
            ) : visible.map((conversation) => (
              <button
                key={conversation.id}
                type="button"
                role="option"
                className="messages-list-item"
                aria-selected={activeId === conversation.id}
                onClick={() => selectConversation(conversation.id)}
              >
                <span className="messages-list-row">
                  <span className="messages-list-mark" aria-hidden="true">{conversation.kind === "dm" ? "◑" : "#"}</span>
                  <span className={`messages-list-title${conversation.archivedAt ? " messages-list-title-archived" : ""}`}>
                    <ChannelName conversation={conversation} />
                  </span>
                  {conversation.unreadCount > 0 && (
                    <span className="messages-unread-badge">{conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}</span>
                  )}
                  {conversation.archivedAt
                    ? <span className="messages-pill messages-pill-archived">archived</span>
                    : conversation.agentEnabled && <span className="messages-pill messages-pill-agent">chaste</span>}
                </span>
                {conversation.lastMessage && <p className="messages-list-preview">{conversation.lastMessage.body}</p>}
              </button>
            ))}
          </div>
        </aside>

        <section className="messages-thread-panel" data-hidden={threadHidden} aria-label="Conversation thread">
          {!activeConv ? (
            <div className="messages-thread-placeholder">Select a conversation to read it.</div>
          ) : (
            <>
              <header className="messages-thread-heading">
                <button
                  type="button"
                  className="messages-icon-button messages-back-button"
                  aria-label="Back to conversations"
                  onClick={() => { saveDraftNow(); setActiveId(null); setMobileListVisible(true); }}
                >
                  ‹
                </button>
                <h2 className="messages-thread-title"><ChannelName conversation={activeConv} /></h2>
                {activeConv.archivedAt && <span className="messages-pill messages-pill-archived">archived</span>}
                {activeConv.agentEnabled && (
                  <span className="messages-pill messages-pill-agent">
                    <span aria-hidden="true">✦ </span>Chaste reads and acts here
                  </span>
                )}
                <div className="messages-thread-actions">
                  <button
                    type="button"
                    className="messages-icon-button"
                    aria-label="Conversation settings"
                    title="Rename, members, archive"
                    onClick={() => {
                      setRenameValue(activeConv.title);
                      setAddUserId("");
                      setMemberQuery("");
                      setMemberResults([]);
                      setDialogNotice(null);
                      setSettingsOpen(true);
                    }}
                  >
                    ⚙
                  </button>
                </div>
              </header>

              {presence.length > 0 && (
                <div className="messages-presence-bar" aria-live="polite">
                  <span className={typingNames.length > 0 ? "messages-typing-dot" : "messages-presence-dot"} aria-hidden="true" />
                  {typingNames.length > 0
                    ? `${typingNames.join(", ")} ${typingNames.length === 1 ? "is" : "are"} typing`
                    : `${presence.length} ${presence.length === 1 ? "colleague" : "colleagues"} online`}
                </div>
              )}

              {pinnedMessages.length > 0 && (
                <button
                  type="button"
                  className="messages-pinned-bar"
                  onClick={() => {
                    const target = pinnedMessages[0];
                    if (!target) return;
                    if (messages.some((message) => message.id === target.id)) {
                      revealMessage(target.id);
                    } else {
                      void refreshThread(activeConv.id, { aroundId: target.id, showLoading: true });
                    }
                  }}
                >
                  <strong>Pinned</strong>
                  <span>{pinnedMessages[0]!.body || "Open pinned message"}</span>
                  {pinnedMessages.length > 1 && <em>+{pinnedMessages.length - 1}</em>}
                </button>
              )}

              {threadError && (
                <div className="messages-thread-error" role="alert">
                  <span>{threadError}</span>
                  <button type="button" className="messages-button messages-button-quiet" onClick={() => { void refreshThread(activeConv.id, { showLoading: true }); }}>Retry</button>
                </div>
              )}

              {threadBusy ? (
                <Skeleton rows={6} block label="Loading messages" />
              ) : (
                <div
                  ref={threadRef}
                  className="messages-thread-scroll"
                  aria-label={`Messages in ${activeConv.title}`}
                  onScroll={(event) => {
                    if (event.currentTarget.scrollTop < 28 && hasOlder && !loadingOlder) void loadOlder();
                  }}
                >
                  {loadingOlder && <p className="messages-older-loading">Loading earlier messages</p>}
                  {messages.length === 0 && <p className="messages-list-empty">No messages yet. Start the conversation below.</p>}
                  {messages.map((message, index) => (
                    <ThreadMessage
                      key={message.id}
                      message={message}
                      previous={messages[index - 1]}
                      people={people}
                      me={me}
                      readers={readers}
                      replies={replies.get(message.id) ?? 0}
                      editing={editingId === message.id && (
                        typeof __GO_MESSAGING_EDIT_SLICE__ === "undefined" || !__GO_MESSAGING_EDIT_SLICE__ ||
                        editingScope === messageEditScopeIdentity(actorId, organizationId, activeId)
                      )}
                      editingBody={editingBody}
                      editLocked={editLocked}
                      focused={focusedMessageId === message.id}
                      reactionMenuOpen={reactionMenuId === message.id}
                      onStartEdit={(target) => {
                        setEditingId(target.id);
                        setEditingBody(target.body);
                        setEditingScope(messageEditScopeIdentity(actorId, organizationId, activeId));
                        setEditLocked(false);
                      }}
                      onCancelEdit={() => { setEditingId(null); setEditingBody(""); setEditingScope(null); setEditLocked(false); }}
                      onSaveEdit={() => { void saveEdit(); }}
                      onEditBody={setEditingBody}
                      onReply={(target) => { setReplyTo(target); composerRef.current?.focus(); }}
                      onToggleReactionMenu={(id) => setReactionMenuId((current) => (current === id ? null : id))}
                      onReact={(emoji, active) => { setReactionMenuId(null); void changeReaction(message.id, emoji, active); }}
                      onTogglePin={() => { void togglePin(message); }}
                      onRequestDelete={(id) => {
                        setConfirmDeleteMessageScope(messageDeleteScopeIdentity(actorId, organizationId));
                        setConfirmDeleteMessageId(id);
                      }}
                    />
                  ))}
                  {typingNames.length > 0 && (
                    <p className="messages-typing-line" aria-live="polite">
                      <span className="messages-typing-dot" aria-hidden="true" />
                      {typingNames.join(", ")} {typingNames.length === 1 ? "is" : "are"} typing
                    </p>
                  )}
                </div>
              )}

              <form
                className="messages-composer"
                onSubmit={(event) => { event.preventDefault(); void send(); }}
              >
                {replyTo && (
                  <div className="messages-reply-banner">
                    <strong>Replying to {replyTo.senderUserId === me ? "yourself" : people.find((person) => person.id === replyTo.senderUserId)?.name ?? "message"}</strong>
                    <span>{replyTo.body || replyTo.attachments[0]?.filename}</span>
                    <button type="button" className="messages-icon-button" aria-label="Cancel reply" onClick={() => setReplyTo(null)}>×</button>
                  </div>
                )}
                {composerError && <p className="messages-composer-error" role="alert">{composerError}</p>}
                {composerPending && <p className="messages-composer-pending" role="status">{composerPending} Your draft is still in this composer.</p>}

                {mentionQuery != null && mentionCandidates.length > 0 && (
                  <div className="messages-mention-menu">
                    <ul role="listbox" aria-label="Mention someone">
                      {mentionCandidates.map((person, index) => (
                        <li key={person.id}>
                          <button
                            type="button"
                            role="option"
                            className="messages-mention-option"
                            aria-selected={index === mentionIndex}
                            onMouseEnter={() => setMentionIndex(index)}
                            onClick={() => pickMention(person)}
                          >
                            <span aria-hidden="true">{person.type === "agent" ? "✦" : "◎"}</span>
                            <span>@{personAlias(person)}</span>
                            <em>{person.type === "agent" ? "pulls the AI in" : person.name}</em>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="messages-composer-surface">
                  {pendingAttachments.length > 0 && (
                    <div className="messages-pending-attachments">
                      {pendingAttachments.map((attachment) => (
                        <span key={attachment.key} className="messages-pending-attachment">
                          <span aria-hidden="true">📎 </span>
                          <span>{attachment.file.name}</span>
                          {attachment.attachmentId && <em>ready</em>}
                          <button
                            type="button"
                            className="messages-pending-remove"
                            aria-label={`Remove ${attachment.file.name}`}
                            onClick={() => { void removeAttachment(attachment); }}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <textarea
                    ref={composerRef}
                    className="messages-composer-input"
                    value={draft}
                    onChange={(event) => {
                      setDraft(event.target.value);
                      const element = event.currentTarget;
                      const query = activeMentionQuery(element.value, element.selectionStart ?? element.value.length);
                      setMentionQuery(query);
                      if (query != null) setMentionIndex(0);
                    }}
                    onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                      if (mentionQuery != null && mentionCandidates.length > 0) {
                        const chosen = mentionCandidates[mentionIndex];
                        if (event.key === "ArrowDown") { event.preventDefault(); setMentionIndex((i) => Math.min(i + 1, mentionCandidates.length - 1)); return; }
                        if (event.key === "ArrowUp") { event.preventDefault(); setMentionIndex((i) => Math.max(i - 1, 0)); return; }
                        if ((event.key === "Enter" || event.key === "Tab") && chosen) { event.preventDefault(); pickMention(chosen); return; }
                        if (event.key === "Escape") { event.preventDefault(); setMentionQuery(null); return; }
                      }
                      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
                    }}
                    rows={1}
                    aria-label={`Message ${activeConv.title}`}
                    placeholder="Write a message, type @ to mention a colleague or the agent"
                    disabled={sending}
                  />
                  <div className="messages-composer-row">
                    <input
                      ref={attachmentInputRef}
                      type="file"
                      multiple
                      className="sr-only"
                      aria-label="Attach files"
                      onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }}
                    />
                    <button
                      type="button"
                      className="messages-composer-tool"
                      title="Attach files"
                      aria-label="Attach files"
                      disabled={sending || pendingAttachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
                      onClick={() => attachmentInputRef.current?.click()}
                    >
                      📎
                    </button>
                    <button
                      type="button"
                      className="messages-composer-tool"
                      title="Add emoji"
                      aria-label="Add emoji"
                      aria-expanded={emojiPickerOpen}
                      aria-controls="messages-emoji-picker"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => setEmojiPickerOpen((open) => !open)}
                    >
                      ☺
                    </button>
                    {emojiPickerOpen && (
                      <div id="messages-emoji-picker" className="messages-emoji-picker" role="group" aria-label="Choose an emoji">
                        {MESSAGE_EMOJIS.map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            className="messages-emoji-option"
                            aria-label={emoji}
                            title={emoji}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => insertEmoji(emoji)}
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    )}
                    <span className={`messages-draft-status messages-draft-status-${draftStatus}`} aria-live="polite">
                      {draftStatus === "saving" ? "Saving draft" : draftStatus === "unavailable" ? "Draft saving unavailable" : "Draft saved"}
                    </span>
                    <span className="messages-composer-hint">Enter to send, Shift+Enter for a new line</span>
                    <button
                      type="submit"
                      className="messages-send-button"
                      disabled={sending || (!draft.trim() && pendingAttachments.length === 0)}
                      aria-label={sending ? "Sending message" : "Send message"}
                    >
                      {sending ? "Sending" : "Send"}
                    </button>
                  </div>
                </div>
              </form>
            </>
          )}
        </section>
      </div>

      {activeConv && (
        <Dialog
          open={settingsOpen}
          title={activeConv.kind === "dm" ? "Conversation" : `#${activeConv.title}`}
          description="Membership and lifecycle for this conversation."
          onClose={() => setSettingsOpen(false)}
        >
          {dialogNotice && (
            <p className={dialogNotice.tone === "error" ? "messages-composer-error" : "messages-composer-pending"} role={dialogNotice.tone === "error" ? "alert" : "status"}>
              {dialogNotice.text}
            </p>
          )}

          {pendingConversationUpdate?.conversationId === activeConv.id && (
            <div className="messages-dialog-section">
              <button
                type="button"
                className="messages-button messages-button-primary"
                disabled={lifecycleBusy}
                onClick={() => { void runLifecycle(pendingConversationUpdate.action); }}
              >
                {lifecycleBusy ? "Checking update…" : "Retry update"}
              </button>
            </div>
          )}

          {activeConv.kind === "channel" && (
            <div className="messages-dialog-section">
              <span className="messages-dialog-field">
                Name
                <span className="messages-dialog-row">
                  <input
                    type="text"
                    value={pendingConversationUpdate?.conversationId === activeConv.id && pendingConversationUpdate.action.title
                      ? pendingConversationUpdate.action.title
                      : renameValue}
                    disabled={pendingConversationUpdate?.conversationId === activeConv.id}
                    onChange={(event) => setRenameValue(event.target.value)}
                    aria-label="Channel name"
                  />
                  <button
                    type="button"
                    className="messages-button messages-button-primary"
                    disabled={lifecycleBusy || pendingConversationUpdate?.conversationId === activeConv.id || !renameValue.trim() || renameValue.trim() === activeConv.title}
                    onClick={() => { void runLifecycle({ action: "update", title: renameValue.trim() }); }}
                  >
                    Rename
                  </button>
                </span>
              </span>
            </div>
          )}

          <div className="messages-toggle-row">
            <span>
              <p>Chaste participates</p>
              <span>The workmate reads this thread and acts when colleagues ask.</span>
            </span>
            <Toggle
              label="Chaste participates"
              checked={pendingConversationUpdate?.conversationId === activeConv.id && pendingConversationUpdate.action.agentEnabled !== undefined
                ? pendingConversationUpdate.action.agentEnabled
                : activeConv.agentEnabled}
              onChange={(next) => { void runLifecycle({ action: "update", agentEnabled: next }); }}
            />
          </div>

          {activeConv.kind === "channel" && (
            <div className="messages-dialog-section messages-dialog-section-spaced">
              <span className="messages-dialog-field">
                Find a colleague by name
                <span className="messages-dialog-row">
                  <input
                    type="text"
                    value={memberQuery}
                    onChange={(event) => { setMemberQuery(event.target.value); setAddUserId(""); setDialogNotice(null); }}
                    placeholder="Search team members"
                    aria-label="Find a colleague by name"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="messages-button messages-button-primary"
                    disabled={lifecycleBusy || !addUserId}
                    onClick={async () => {
                      if (await runLifecycle({ action: "addMember", userId: addUserId })) {
                        setAddUserId("");
                        setMemberQuery("");
                        setMemberResults([]);
                      }
                    }}
                  >
                    Add
                  </button>
                </span>
              </span>
              {memberQuery.trim() && (
                <div className="messages-member-results">
                  {memberResults.length === 0
                    ? <p className="messages-dialog-empty">No matching team members.</p>
                    : memberResults.map((person) => (
                      <button
                        key={person.id}
                        type="button"
                        className="messages-member-option"
                        aria-selected={addUserId === person.id}
                        onClick={() => { setAddUserId(person.id); setMemberQuery(person.name); setMemberResults([]); }}
                      >
                        <strong>{person.name}</strong>
                        <span>Select this person to add</span>
                      </button>
                    ))}
                </div>
              )}
            </div>
          )}

          <div className="messages-dialog-actions">
            {activeConv.kind === "channel" && (
              <button
                type="button"
                className="messages-button messages-button-quiet"
                disabled={lifecycleBusy}
                onClick={async () => {
                  const retained = pendingConversationArchive?.conversationId === activeConv.id ? pendingConversationArchive : null;
                  const action = retained?.action ?? { action: "archive" as const, archived: !activeConv.archivedAt };
                  if (await runLifecycle(action)) setSettingsOpen(false);
                }}
              >
                {pendingConversationArchive?.conversationId === activeConv.id
                  ? `Retry ${pendingConversationArchive.action.archived ? "archive" : "restore"}`
                  : activeConv.archivedAt ? "Restore" : "Archive"}
              </button>
            )}
            <button type="button" className="messages-button messages-button-quiet" disabled={lifecycleBusy} onClick={() => { void leaveConversation(); }}>Leave</button>
            {activeConv.kind === "channel" && activeConv.createdByMe && (
              <button type="button" className="messages-button messages-button-danger" onClick={() => setConfirmDeleteConversation(true)}>Delete channel</button>
            )}
          </div>
        </Dialog>
      )}

      <ConfirmDialog
        open={confirmDeleteConversation}
        title={`Delete #${activeConv?.title ?? ""}?`}
        body="It disappears from everyone's list. The audit trail keeps the record; this cannot be undone from the UI."
        confirmLabel="Delete channel"
        onClose={() => setConfirmDeleteConversation(false)}
        onConfirm={() => { void destroyConversation(); }}
      />

      <ConfirmDialog
        open={confirmDeleteMessageId != null && (
          typeof __GO_MESSAGING_DELETE_SLICE__ === "undefined" || !__GO_MESSAGING_DELETE_SLICE__ ||
          confirmDeleteMessageScope === messageDeleteScopeIdentity(actorId, organizationId)
        )}
        title="Delete this message?"
        body="It is replaced by a deletion marker for everyone. The audit trail keeps the original."
        confirmLabel="Delete message"
        onClose={() => {
          setConfirmDeleteMessageId(null);
          setConfirmDeleteMessageScope(null);
          setConfirmDeleteLocked(false);
        }}
        onConfirm={() => { if (confirmDeleteMessageId) void removeMessage(confirmDeleteMessageId); }}
        actionsDisabled={confirmDeleteLocked && !(typeof __GO_MESSAGING_DELETE_SLICE__ !== "undefined" && __GO_MESSAGING_DELETE_SLICE__)}
        cancelDisabled={confirmDeleteLocked}
        dismissDisabled={confirmDeleteLocked}
      />
    </div>
  );
}
