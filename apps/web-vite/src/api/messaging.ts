import { z } from "zod";

const IsoTimestampSchema = z.string().datetime();

/** The legacy contract caps one message at five files of five megabytes each. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const MentionSchema = z.object({
  type: z.enum(["user", "agent"]),
  id: z.string().min(1).max(80),
}).strict();

const AttachmentSchema = z.object({
  id: z.string().min(1),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  href: z.string().min(1),
}).strict();

const ReactionSchema = z.object({
  emoji: z.string().min(1),
  count: z.number().int().nonnegative(),
  reactedByMe: z.boolean(),
  names: z.array(z.string()),
}).strict();

export const MessageSchema = z.object({
  id: z.string().min(1),
  senderType: z.string().min(1),
  senderUserId: z.string().nullable(),
  body: z.string(),
  createdAt: IsoTimestampSchema,
  editedAt: IsoTimestampSchema.nullable(),
  parentMessageId: z.string().nullable(),
  pinnedAt: IsoTimestampSchema.nullable(),
  mentions: z.array(MentionSchema).nullable().optional(),
  attachments: z.array(AttachmentSchema),
  reactions: z.array(ReactionSchema),
}).strict();
export type Message = z.infer<typeof MessageSchema>;
export type MessageAttachment = z.infer<typeof AttachmentSchema>;
export type MessageMention = z.infer<typeof MentionSchema>;

const ConversationSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  title: z.string(),
  agentEnabled: z.boolean(),
  archivedAt: IsoTimestampSchema.nullable(),
  createdByMe: z.boolean(),
  unreadCount: z.number().int().nonnegative(),
  lastMessage: z.object({ at: IsoTimestampSchema, body: z.string() }).strict().nullable(),
}).strict();
export type Conversation = z.infer<typeof ConversationSchema>;

const ReaderSchema = z.object({
  userId: z.string().min(1),
  name: z.string(),
  lastReadAt: IsoTimestampSchema.nullable(),
}).strict();
export type MessageReader = z.infer<typeof ReaderSchema>;

const PinnedMessageSchema = z.object({
  id: z.string().min(1),
  body: z.string(),
  pinnedAt: IsoTimestampSchema,
}).strict();
export type PinnedMessage = z.infer<typeof PinnedMessageSchema>;

const PresenceSchema = z.object({
  userId: z.string().min(1),
  name: z.string(),
  typing: z.boolean(),
}).strict();
export type ConversationPresence = z.infer<typeof PresenceSchema>;

const PersonSchema = z.object({
  type: z.enum(["user", "agent"]),
  id: z.string().min(1),
  name: z.string(),
}).strict();
export type Person = z.infer<typeof PersonSchema>;

const SearchResultSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  conversationTitle: z.string(),
  body: z.string(),
  createdAt: IsoTimestampSchema,
  senderType: z.string().min(1),
  senderUserId: z.string().nullable(),
}).strict();
export type MessageSearchResult = z.infer<typeof SearchResultSchema>;

const ConversationsResponseSchema = z.object({
  conversations: z.array(ConversationSchema),
  me: z.string().min(1),
}).strict();

const ConversationThreadSchema = z.object({
  conversation: z.unknown(),
  messages: z.array(MessageSchema),
  me: z.string().min(1),
  readers: z.array(ReaderSchema),
  pinnedMessages: z.array(PinnedMessageSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
}).strict();
export type ConversationThread = z.infer<typeof ConversationThreadSchema>;

const PeopleResponseSchema = z.object({ people: z.array(PersonSchema) }).strict();
const PresenceResponseSchema = z.object({ people: z.array(PresenceSchema) }).strict();
const SearchResponseSchema = z.object({ results: z.array(SearchResultSchema) }).strict();
const CreateConversationSchema = z.object({ conversationId: z.string().min(1) }).strict();
const SendMessageSchema = z.object({ ok: z.literal(true), agentReply: z.string().nullable() }).strict();
export type SendMessageResult = z.infer<typeof SendMessageSchema>;
const GoSendMessageEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: z.object({ messageId: z.string().min(1) }).strict(),
}).strict();

const AttachmentUploadSchema = z.object({
  attachmentId: z.string().min(1),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
}).strict();
export type AttachmentUpload = z.infer<typeof AttachmentUploadSchema>;

const OkEnvelopeSchema = z.object({ ok: z.literal(true), data: z.unknown().optional() }).strict();
const PendingApprovalSchema = z.object({
  ok: z.literal(false).optional(),
  pendingApproval: z.literal(true),
  approvalId: z.string().uuid().optional(),
  hint: z.string().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
}).strict();

const ModuleSwitchboardSchema = z.object({
  catalog: z.array(z.object({ id: z.string().min(1) })),
  enabledModules: z.array(z.string().min(1)),
});
const ErrorSchema = z.object({
  ok: z.literal(false).optional(),
  error: z.string().optional(),
  message: z.string().optional(),
}).strict();

export type MessagingOutcome<T = Record<string, unknown>> =
  | { kind: "completed"; data: T }
  | { kind: "pending"; reason: string };

export class MessagingApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "MessagingApiError";
  }
}

function requestSignal(signal?: AbortSignal, timeoutMs = 15_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function readError(status: number, body: unknown, subject: string): string {
  const parsed = ErrorSchema.safeParse(body);
  const serverMessage = parsed.success ? parsed.data.error ?? parsed.data.message : undefined;
  if (serverMessage?.trim()) return serverMessage.trim();
  if (status === 401) return "Your session has ended. Sign in again to continue.";
  if (status === 403) return "You do not have permission to use Messages.";
  if (status === 404) return "That conversation is no longer available. Refresh and try again.";
  if (status === 428) return "Finish setting up your workspace before using Messages.";
  return `Could not load ${subject}. Check your connection and try again.`;
}

/**
 * Every governed write carries an intent id so a retried request is the same
 * audited intent, not a second one. The legacy routes read it from the JSON
 * body, except the message tombstone which reads it from the query string.
 */
function newIntentId(): string {
  return crypto.randomUUID();
}

async function send(
  path: string,
  init: RequestInit,
  subject: string,
  signal?: AbortSignal,
): Promise<{ response: Response; body: unknown }> {
  const form = typeof FormData !== "undefined" && init.body instanceof FormData;
  let response: Response;
  try {
    response = await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      ...init,
      headers: form || init.body == null
        ? { accept: "application/json", ...init.headers }
        : { accept: "application/json", "content-type": "application/json", ...init.headers },
      signal: requestSignal(signal, init.method === "POST" ? 20_000 : 15_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new MessagingApiError(0, timedOut
      ? `The messaging service took too long to load ${subject}. Try again.`
      : `Could not reach the messaging service to load ${subject}. Check your connection and try again.`);
  }
  return { response, body: await response.json().catch(() => null) };
}

async function getJson<T>(path: string, subject: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  const { response, body } = await send(path, { method: "GET" }, subject, signal);
  if (!response.ok) throw new MessagingApiError(response.status, readError(response.status, body, subject));
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new MessagingApiError(response.status, `The messaging service returned ${subject} in an unexpected format.`);
  return parsed.data;
}

/** Governed writes answer 202 while an approval is pending: that is neither success nor failure. */
async function governed<T>(
  path: string,
  init: RequestInit,
  action: string,
  schema: z.ZodType<T>,
  pendingReason: string,
  signal?: AbortSignal,
): Promise<MessagingOutcome<T>> {
  const { response, body } = await send(path, init, action, signal);
  if (response.status === 202) {
    const parsed = PendingApprovalSchema.safeParse(body);
    if (!parsed.success) throw new MessagingApiError(202, `The messaging service returned an unexpected approval response to ${action}.`);
    return { kind: "pending", reason: parsed.data.hint ?? parsed.data.reason ?? parsed.data.error ?? pendingReason };
  }
  if (!response.ok) throw new MessagingApiError(response.status, readError(response.status, body, action));
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new MessagingApiError(response.status, `The messaging service returned an unexpected response to ${action}.`);
  return { kind: "completed", data: parsed.data };
}

async function acknowledge(path: string, init: RequestInit, action: string, signal?: AbortSignal): Promise<void> {
  const { response, body } = await send(path, init, action, signal);
  if (!response.ok) throw new MessagingApiError(response.status, readError(response.status, body, action));
  const parsed = OkEnvelopeSchema.safeParse(body);
  if (!parsed.success) throw new MessagingApiError(response.status, `The messaging service returned an unexpected response to ${action}.`);
}

export async function fetchMessagingEnabled(signal?: AbortSignal): Promise<boolean> {
  const body = await getJson("/api/modules", "the Messaging module status", z.unknown(), signal);
  const parsed = ModuleSwitchboardSchema.safeParse(body);
  if (!parsed.success) throw new MessagingApiError(200, "The module switchboard returned data in an unexpected format.");
  const catalogIds = new Set(parsed.data.catalog.map(({ id }) => id));
  if (parsed.data.enabledModules.some((id) => !catalogIds.has(id))) {
    throw new MessagingApiError(200, "The module switchboard returned an invalid Messaging configuration.");
  }
  return catalogIds.has("messaging") && parsed.data.enabledModules.includes("messaging");
}

export function fetchConversations(signal?: AbortSignal): Promise<{ conversations: Conversation[]; me: string }> {
  return getJson("/api/conversations", "your conversations", ConversationsResponseSchema, signal);
}

export function createConversation(
  input: { title: string; agentEnabled: boolean },
  signal?: AbortSignal,
): Promise<MessagingOutcome<{ conversationId: string }>> {
  return governed("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ title: input.title, agentEnabled: input.agentEnabled, intentId: newIntentId() }),
  }, "create this conversation", CreateConversationSchema, "Creating this conversation is waiting for approval.", signal);
}

export async function fetchConversationPeople(query?: string, signal?: AbortSignal): Promise<Person[]> {
  const path = query?.trim() ? `/api/conversations/people?q=${encodeURIComponent(query.trim())}` : "/api/conversations/people";
  const result = await getJson(path, "the people you can mention", PeopleResponseSchema, signal);
  return result.people;
}

export function fetchConversationThread(
  conversationId: string,
  options: { aroundId?: string } = {},
  signal?: AbortSignal,
): Promise<ConversationThread> {
  const query = options.aroundId ? `?around=${encodeURIComponent(options.aroundId)}` : "";
  return getJson(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages${query}`,
    "this conversation",
    ConversationThreadSchema,
    signal,
  );
}

export function fetchOlderMessages(conversationId: string, before: string, signal?: AbortSignal): Promise<ConversationThread> {
  return getJson(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages?before=${encodeURIComponent(before)}`,
    "earlier messages",
    ConversationThreadSchema,
    signal,
  );
}

export async function advanceReadCursor(conversationId: string, readAt: string, signal?: AbortSignal): Promise<void> {
  await acknowledge(`/api/conversations/${encodeURIComponent(conversationId)}/read`, {
    method: "POST",
    body: JSON.stringify({ readAt, intentId: newIntentId() }),
  }, "your read position", signal);
}

export async function fetchConversationPresence(conversationId: string, signal?: AbortSignal): Promise<ConversationPresence[]> {
  const result = await getJson(`/api/conversations/${encodeURIComponent(conversationId)}/presence`, "who is online", PresenceResponseSchema, signal);
  return result.people;
}

export async function reportConversationPresence(conversationId: string, typing: boolean, signal?: AbortSignal): Promise<void> {
  await acknowledge(`/api/conversations/${encodeURIComponent(conversationId)}/presence`, {
    method: "POST",
    body: JSON.stringify({ typing, intentId: newIntentId() }),
  }, "your presence", signal);
}

export async function uploadConversationAttachment(conversationId: string, file: File, signal?: AbortSignal): Promise<AttachmentUpload> {
  const form = new FormData();
  form.append("file", file);
  const { response, body } = await send(
    `/api/conversations/${encodeURIComponent(conversationId)}/attachments`,
    { method: "POST", body: form },
    `the upload of ${file.name}`,
    signal,
  );
  if (!response.ok) throw new MessagingApiError(response.status, readError(response.status, body, `the upload of ${file.name}`));
  const parsed = AttachmentUploadSchema.safeParse(body);
  if (!parsed.success) throw new MessagingApiError(response.status, "The messaging service returned an unexpected upload response.");
  return parsed.data;
}

export async function deletePendingAttachment(conversationId: string, attachmentId: string, signal?: AbortSignal): Promise<void> {
  await acknowledge(`/api/conversations/${encodeURIComponent(conversationId)}/attachments`, {
    method: "DELETE",
    body: JSON.stringify({ attachmentId, intentId: newIntentId() }),
  }, "that pending file", signal);
}

export function sendConversationMessage(
  conversationId: string,
  input: { body: string; mentions: MessageMention[]; parentMessageId?: string; attachmentIds: string[] },
  signal?: AbortSignal,
  options?: { allowGo?: boolean; intentId?: string },
): Promise<MessagingOutcome<SendMessageResult>> {
  const useGo = options?.allowGo === true
    && typeof __GO_MESSAGING_SEND_SLICE__ !== "undefined"
    && __GO_MESSAGING_SEND_SLICE__;
  if (useGo) {
    const intentId = options.intentId == null ? newIntentId() : z.string().uuid().parse(options.intentId);
    return sendConversationMessageThroughGo(conversationId, input, intentId, signal);
  }
  return governed(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: "POST",
    body: JSON.stringify({
      body: input.body,
      mentions: input.mentions,
      parentMessageId: input.parentMessageId,
      attachmentIds: input.attachmentIds,
      intentId: newIntentId(),
    }),
  }, "send this message", SendMessageSchema, "Your message is waiting for approval. It is still saved in this composer.", signal);
}

async function sendConversationMessageThroughGo(
  conversationId: string,
  input: { body: string; mentions: MessageMention[]; parentMessageId?: string; attachmentIds: string[] },
  intentId: string,
  signal?: AbortSignal,
): Promise<MessagingOutcome<SendMessageResult>> {
  const { response, body } = await send("/api/capabilities/execute", {
    method: "POST",
    body: JSON.stringify({
      capabilityId: "messaging.sendMessage",
      input: {
        conversationId,
        body: input.body,
        mentions: input.mentions,
        parentMessageId: input.parentMessageId,
        attachmentIds: input.attachmentIds,
      },
      intentId,
    }),
  }, "send this message", signal);
  if (response.status === 202) {
    const parsed = PendingApprovalSchema.safeParse(body);
    if (!parsed.success) throw new MessagingApiError(202, "The messaging service returned an unexpected approval response to send this message.");
    return {
      kind: "pending",
      reason: parsed.data.hint ?? parsed.data.reason ?? parsed.data.error ?? "Your message is waiting for approval. It is still saved in this composer.",
    };
  }
  if (!response.ok) throw new MessagingApiError(response.status, readError(response.status, body, "send this message"));
  const parsed = GoSendMessageEnvelopeSchema.safeParse(body);
  if (!parsed.success) throw new MessagingApiError(response.status, "The messaging service returned an unexpected response to send this message.");
  return { kind: "completed", data: { ok: true, agentReply: null } };
}

export type ConversationLifecycleAction =
  | { action: "update"; title?: string; agentEnabled?: boolean }
  | { action: "archive"; archived: boolean }
  | { action: "leave" }
  | { action: "addMember"; userId: string }
  | { action: "delete" };

export function changeConversation(
  conversationId: string,
  action: ConversationLifecycleAction,
  signal?: AbortSignal,
): Promise<MessagingOutcome<{ ok: true }>> {
  return governed(`/api/conversations/${encodeURIComponent(conversationId)}`, {
    method: "PATCH",
    body: JSON.stringify({ ...action, intentId: newIntentId() }),
  }, `apply "${action.action}"`, OkEnvelopeSchema, "This change is waiting for approval.", signal);
}

export async function searchMessages(query: string, signal?: AbortSignal): Promise<MessageSearchResult[]> {
  const result = await getJson(`/api/messages/search?q=${encodeURIComponent(query)}`, "message search results", SearchResponseSchema, signal);
  return result.results;
}

export function editMessage(messageId: string, body: string, signal?: AbortSignal): Promise<MessagingOutcome<{ ok: true }>> {
  return governed(`/api/messages/${encodeURIComponent(messageId)}`, {
    method: "PATCH",
    body: JSON.stringify({ body, intentId: newIntentId() }),
  }, "edit this message", OkEnvelopeSchema, "Your edit is waiting for approval.", signal);
}

export function deleteMessage(messageId: string, signal?: AbortSignal): Promise<MessagingOutcome<{ ok: true }>> {
  // The legacy tombstone route reads the idempotency key from the query string.
  return governed(`/api/messages/${encodeURIComponent(messageId)}?intentId=${newIntentId()}`, {
    method: "DELETE",
  }, "delete this message", OkEnvelopeSchema, "Deleting this message is waiting for approval.", signal);
}

export async function setMessageReaction(messageId: string, emoji: string, active: boolean, signal?: AbortSignal): Promise<void> {
  await acknowledge(`/api/messages/${encodeURIComponent(messageId)}/reactions`, {
    method: "POST",
    body: JSON.stringify({ emoji, active, intentId: newIntentId() }),
  }, "save that reaction", signal);
}

export async function setMessagePin(messageId: string, pinned: boolean, signal?: AbortSignal): Promise<void> {
  await acknowledge(`/api/messages/${encodeURIComponent(messageId)}/pin`, {
    method: "PATCH",
    body: JSON.stringify({ pinned, intentId: newIntentId() }),
  }, "pin that message", signal);
}

/** Mirrors the legacy composer guard: at most five files, each 1 byte to 5 MB. */
export function checkAttachmentLimits(pending: number, files: File[]): string | null {
  if (pending + files.length > MAX_ATTACHMENTS_PER_MESSAGE) return "Add up to five files to one message.";
  const outOfRange = files.find((file) => file.size > MAX_ATTACHMENT_BYTES || file.size === 0);
  return outOfRange ? `${outOfRange.name} must be between 1 byte and 5 MB.` : null;
}
