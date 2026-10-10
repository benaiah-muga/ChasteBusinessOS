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
const GoCapabilityEnvelopeSchema = z.object({ ok: z.literal(true), data: z.unknown() }).strict();
const GoReadCursorEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    conversationId: z.string().min(1),
    previousReadAt: IsoTimestampSchema.nullable(),
  }).strict(),
}).strict();
const GoMessageReactionEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: z.object({ previousActive: z.boolean(), active: z.boolean() }).strict(),
}).strict();
const GoMessagePinEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: z.object({ previousPinned: z.boolean(), pinned: z.boolean() }).strict(),
}).strict();

const ConversationThreadSchema = z.object({
  conversation: z.object({
    id: z.string().min(1),
    orgId: z.string().min(1),
    kind: z.string().min(1),
    title: z.string(),
    agentEnabled: z.boolean(),
    createdByUserId: z.string().nullable(),
    createdAt: IsoTimestampSchema,
    archivedAt: IsoTimestampSchema.nullable(),
    deletedAt: IsoTimestampSchema.nullable(),
  }).strict(),
  messages: z.array(MessageSchema),
  me: z.string().min(1),
  readers: z.array(ReaderSchema),
  pinnedMessages: z.array(PinnedMessageSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
}).strict();
export type ConversationThread = z.infer<typeof ConversationThreadSchema>;

const PeopleResponseSchema = z.object({ people: z.array(PersonSchema) }).strict();
const GoPeopleEnvelopeSchema = z.object({ ok: z.literal(true), data: z.unknown() }).strict();
const GoPeopleOutputSchema = z.object({
  people: z.array(z.object({
    type: z.enum(["user", "agent"]),
    id: z.string().min(1).max(80),
    name: z.string(),
  }).strict()),
}).strict();
const PresenceResponseSchema = z.object({ people: z.array(PresenceSchema) }).strict();
const SearchResponseSchema = z.object({ results: z.array(SearchResultSchema) }).strict();
const CreateConversationSchema = z.object({ conversationId: z.string().min(1) }).strict();
const SendMessageSchema = z.object({ ok: z.literal(true), agentReply: z.string().nullable() }).strict();
export type SendMessageResult = z.infer<typeof SendMessageSchema>;
const GoSendMessageEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: z.object({ messageId: z.string().min(1) }).strict(),
}).strict();
const GoDeletePendingAttachmentEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: z.object({ removed: z.literal(true) }).strict(),
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

export type PendingMessageEdit = { messageId: string; conversationId: string | null; body: string; intentId: string };
export type PendingMessageDelete = { messageId: string; conversationId: string | null; intentId: string };

export type MessageRetryScope = { actorId: string | null; organizationId: string | null };
const pendingMessageEditPrefix = "chaste:message-edit-attempt:";
const pendingMessageDeletePrefix = "chaste:message-delete-attempt:";
const GoEditMessageEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    messageId: z.string().min(1),
    body: z.string(),
    expectedBody: z.string(),
    expectedEditedAt: IsoTimestampSchema,
    editedAt: IsoTimestampSchema,
  }).strict(),
}).strict();
const GoDeleteMessageEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    deleted: z.literal(true),
    messageId: z.string().min(1),
    deletedAt: IsoTimestampSchema.nullable(),
    expectedDeletedAt: IsoTimestampSchema,
  }).strict(),
}).strict();

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
  if (typeof __GO_MESSAGING_CONVERSATION_LIST__ !== "undefined" && __GO_MESSAGING_CONVERSATION_LIST__) {
    return fetchGoConversations(signal);
  }
  return getJson("/api/conversations", "your conversations", ConversationsResponseSchema, signal);
}

async function fetchGoConversations(signal?: AbortSignal): Promise<{ conversations: Conversation[]; me: string }> {
  const { response, body } = await send("/api/capabilities/execute", {
    method: "POST",
    body: JSON.stringify({
      capabilityId: "messaging.listConversations",
      input: { limit: 100 },
      intentId: newIntentId(),
    }),
  }, "your conversations", signal);
  if (!response.ok) throw new MessagingApiError(response.status, readError(response.status, body, "your conversations"));
  const envelope = GoCapabilityEnvelopeSchema.safeParse(body);
  if (!envelope.success) throw new MessagingApiError(response.status, "The messaging service returned conversations in an unexpected format.");
  const parsed = ConversationsResponseSchema.safeParse(envelope.data.data);
  if (!parsed.success) throw new MessagingApiError(response.status, "The messaging service returned conversations in an unexpected format.");
  return parsed.data;
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
  const normalizedQuery = query?.trim() ?? "";
  if (typeof __GO_MESSAGING_PEOPLE_READS__ !== "undefined" && __GO_MESSAGING_PEOPLE_READS__) {
    if (normalizedQuery.length > 80) {
      throw new MessagingApiError(400, "Search team members using 80 characters or fewer.");
    }
    const input = normalizedQuery
      ? { query: normalizedQuery, limit: 30 }
      : { limit: 100 };
    const { response, body } = await send("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({ capabilityId: "messaging.listPeople", input, intentId: newIntentId() }),
    }, "people you can mention", signal);
    if (!response.ok) throw new MessagingApiError(response.status, readError(response.status, body, "people you can mention"));
    const envelope = GoPeopleEnvelopeSchema.safeParse(body);
    if (!envelope.success) throw new MessagingApiError(response.status, "The messaging service returned people in an unexpected format.");
    const output = GoPeopleOutputSchema.safeParse(envelope.data.data);
    if (!output.success) throw new MessagingApiError(response.status, "The messaging service returned people in an unexpected format.");
    const projected = output.data.people.map((person) => ({
      type: person.type === "user" ? "user" as const : "agent" as const,
      id: person.id,
      name: person.name,
    }));
    const parsedPeople = PeopleResponseSchema.safeParse({ people: projected });
    if (!parsedPeople.success) throw new MessagingApiError(response.status, "The messaging service returned people in an unexpected format.");
    return parsedPeople.data.people;
  }
  const path = normalizedQuery ? `/api/conversations/people?q=${encodeURIComponent(normalizedQuery)}` : "/api/conversations/people";
  const result = await getJson(path, "the people you can mention", PeopleResponseSchema, signal);
  return result.people;
}

export function messagingPeopleReadsGoSelected(): boolean {
  return typeof __GO_MESSAGING_PEOPLE_READS__ !== "undefined" && __GO_MESSAGING_PEOPLE_READS__;
}

export function fetchConversationThread(
  conversationId: string,
  options: { aroundId?: string } = {},
  signal?: AbortSignal,
): Promise<ConversationThread> {
  if (
    typeof __GO_MESSAGING_THREAD_READ__ !== "undefined" &&
    __GO_MESSAGING_THREAD_READ__
  ) {
    return fetchGoConversationThread(conversationId, signal, undefined, options.aroundId);
  }
  const query = options.aroundId ? `?around=${encodeURIComponent(options.aroundId)}` : "";
  return getJson(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages${query}`,
    "this conversation",
    ConversationThreadSchema,
    signal,
  );
}

async function fetchGoConversationThread(
  conversationId: string,
  signal?: AbortSignal,
  before?: string,
  around?: string,
): Promise<ConversationThread> {
  const { response, body } = await send("/api/capabilities/execute", {
    method: "POST",
    body: JSON.stringify({
      capabilityId: "messaging.readMessages",
      input: { conversationId, limit: 60, ...(before ? { before } : {}), ...(around ? { around } : {}) },
      intentId: newIntentId(),
    }),
  }, "this conversation", signal);
  if (!response.ok) throw new MessagingApiError(response.status, readError(response.status, body, "this conversation"));
  const envelope = GoCapabilityEnvelopeSchema.safeParse(body);
  if (!envelope.success) throw new MessagingApiError(response.status, "The messaging service returned this conversation in an unexpected format.");
  const parsed = ConversationThreadSchema.safeParse(envelope.data.data);
  if (!parsed.success) throw new MessagingApiError(response.status, "The messaging service returned this conversation in an unexpected format.");
  return parsed.data;
}

export function fetchOlderMessages(conversationId: string, before: string, signal?: AbortSignal): Promise<ConversationThread> {
  if (
    typeof __GO_MESSAGING_THREAD_READ__ !== "undefined" &&
    __GO_MESSAGING_THREAD_READ__
  ) {
    return fetchGoConversationThread(conversationId, signal, before);
  }
  return getJson(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages?before=${encodeURIComponent(before)}`,
    "earlier messages",
    ConversationThreadSchema,
    signal,
  );
}

export async function advanceReadCursor(conversationId: string, readAt: string, signal?: AbortSignal): Promise<void> {
  const selectorOverride = (globalThis as typeof globalThis & { __GO_MESSAGING_READ_CURSOR__?: boolean }).__GO_MESSAGING_READ_CURSOR__;
  const goSelected = selectorOverride ?? (typeof __GO_MESSAGING_READ_CURSOR__ !== "undefined" && __GO_MESSAGING_READ_CURSOR__);
  if (goSelected) {
    const { response, body } = await send("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({
        capabilityId: "messaging.advanceReadCursor",
        input: { conversationId, readAt },
        intentId: newIntentId(),
      }),
    }, "your read position", signal);
    if (!response.ok) throw new MessagingApiError(response.status, readError(response.status, body, "your read position"));
    const parsed = GoReadCursorEnvelopeSchema.safeParse(body);
    if (!parsed.success || parsed.data.data.conversationId !== conversationId) {
      throw new MessagingApiError(response.status, "The messaging service returned your read position in an unexpected format.");
    }
    return;
  }
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
  if (typeof __GO_MESSAGING_ATTACHMENT_DELETE__ !== "undefined" && __GO_MESSAGING_ATTACHMENT_DELETE__) {
    z.string().uuid().parse(conversationId);
    const validatedAttachmentId = z.string().uuid().parse(attachmentId);
    const { response, body } = await send("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({
        capabilityId: "messaging.deletePendingAttachment",
        input: { attachmentId: validatedAttachmentId },
        intentId: newIntentId(),
      }),
    }, "that pending file", signal);
    if (!response.ok) throw new MessagingApiError(response.status, readError(response.status, body, "that pending file"));
    const parsed = GoDeletePendingAttachmentEnvelopeSchema.safeParse(body);
    if (!parsed.success) {
      throw new MessagingApiError(response.status, "The messaging service returned an unexpected response while removing that pending file.");
    }
    return;
  }
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

function editMessageLegacy(messageId: string, body: string, signal?: AbortSignal): Promise<MessagingOutcome<{ ok: true }>> {
  return governed(`/api/messages/${encodeURIComponent(messageId)}`, {
    method: "PATCH",
    body: JSON.stringify({ body, intentId: newIntentId() }),
  }, "edit this message", OkEnvelopeSchema, "Your edit is waiting for approval.", signal);
}

export async function editMessage(
  messageId: string,
  body: string,
  signal?: AbortSignal,
  options: { allowGo?: boolean; actorId?: string | null; organizationId?: string | null; conversationId?: string | null } = {},
): Promise<MessagingOutcome<{ ok: true }>> {
  const useGo = options.allowGo === true && typeof __GO_MESSAGING_EDIT_SLICE__ !== "undefined" && __GO_MESSAGING_EDIT_SLICE__;
  if (!useGo) {
    const actorId = options.actorId?.trim();
    const organizationId = options.organizationId?.trim();
    if (!actorId || !organizationId) {
      throw new MessagingApiError(0, "Message editing needs a signed-in actor and active organization so unresolved Go edits can be checked.");
    }
    const pending = await getPendingMessageEdit({ actorId, organizationId });
    if (pending) {
      throw new MessagingApiError(0, "A Go message edit is unresolved. Restore Go message editing to retry the saved edit before starting another edit.");
    }
    return editMessageLegacy(messageId, body, signal);
  }
  return editMessageThroughGo(messageId, body, { actorId: options.actorId ?? null, organizationId: options.organizationId ?? null }, signal, options.conversationId ?? null);
}

async function messageEditStorageKey(scope: MessageRetryScope): Promise<string> {
  const actorId = scope.actorId?.trim() ?? "";
  const organizationId = scope.organizationId?.trim() ?? "";
  if (!actorId || !organizationId) throw new MessagingApiError(0, "Message editing needs a signed-in actor and active organization.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ actorId, organizationId })));
  const fingerprint = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  return `${pendingMessageEditPrefix}${fingerprint}`;
}

function readPendingMessageEdit(key: string): PendingMessageEdit | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    throw new MessagingApiError(0, "Saved message-edit recovery is unavailable. Check browser storage settings and try again.");
  }
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "messageId" in parsed && typeof parsed.messageId === "string" &&
      "body" in parsed && typeof parsed.body === "string" && "conversationId" in parsed &&
      (typeof parsed.conversationId === "string" || parsed.conversationId === null) && "intentId" in parsed && typeof parsed.intentId === "string" &&
      z.string().uuid().safeParse(parsed.intentId).success) {
      return { messageId: parsed.messageId, conversationId: parsed.conversationId, body: parsed.body, intentId: parsed.intentId };
    }
  } catch {
    // A damaged retry marker must not silently create a second message edit.
  }
  throw new MessagingApiError(0, "A saved message edit could not be verified. Refresh the conversation before editing again.");
}

export async function getPendingMessageEdit(scope: MessageRetryScope): Promise<PendingMessageEdit | null> {
  return readPendingMessageEdit(await messageEditStorageKey(scope));
}

function writePendingMessageEdit(key: string, action: PendingMessageEdit): void {
  try {
    localStorage.setItem(key, JSON.stringify(action));
  } catch {
    throw new MessagingApiError(0, "Message-edit retry protection is unavailable. Check browser storage settings and try again.");
  }
}

function clearPendingMessageEdit(key: string, intentId: string): void {
  try {
    const current = readPendingMessageEdit(key);
    if (current?.intentId === intentId) localStorage.removeItem(key);
  } catch {
    // A completed response is authoritative; a stale marker is harmless and can be cleared on next recovery.
  }
}

export async function editMessageThroughGo(
  messageId: string,
  body: string,
  scope: MessageRetryScope,
  signal?: AbortSignal,
  conversationId: string | null = null,
): Promise<MessagingOutcome<{ ok: true }>> {
  const key = await messageEditStorageKey(scope);
  const pending = readPendingMessageEdit(key);
  if (pending && (pending.messageId !== messageId || pending.body !== body)) {
    throw new MessagingApiError(0, "A message edit is unresolved. Retry the saved edit or refresh the conversation before changing it.");
  }
  if (pending && pending.conversationId !== conversationId) {
    throw new MessagingApiError(0, "A message edit is unresolved. Retry the saved edit or refresh the conversation before changing it.");
  }
  const action = pending ?? { messageId, conversationId, body, intentId: newIntentId() };
  if (!pending) writePendingMessageEdit(key, action);

  const input = { messageId: action.messageId, body: action.body };
  const result = await send("/api/capabilities/execute", {
    method: "POST",
    body: JSON.stringify({ capabilityId: "messaging.editMessage", input, intentId: action.intentId }),
  }, "edit this message", signal);
  if (result.response.status === 202) {
    const parsed = PendingApprovalSchema.safeParse(result.body);
    if (!parsed.success) throw new MessagingApiError(202, "The messaging service returned an unexpected approval response to edit this message.");
    return { kind: "pending", reason: parsed.data.hint ?? parsed.data.reason ?? parsed.data.error ?? "Your edit is waiting for approval." };
  }
  if (!result.response.ok) {
    const terminal = result.response.status >= 400 && result.response.status < 500 && result.response.status !== 404 && result.response.status !== 408 && result.response.status !== 429;
    if (terminal) clearPendingMessageEdit(key, action.intentId);
    throw new MessagingApiError(result.response.status, readError(result.response.status, result.body, "edit this message"));
  }
  const parsed = GoEditMessageEnvelopeSchema.safeParse(result.body);
  if (!parsed.success || parsed.data.data.messageId !== action.messageId || parsed.data.data.expectedBody !== action.body) {
    throw new MessagingApiError(result.response.status, "The messaging service returned an unexpected response to edit this message.");
  }
  clearPendingMessageEdit(key, action.intentId);
  return { kind: "completed", data: { ok: true } };
}

function deleteMessageLegacy(messageId: string, signal?: AbortSignal, intentId = newIntentId()): Promise<MessagingOutcome<{ ok: true }>> {
  // The legacy tombstone route reads the idempotency key from the query string.
  return governed(`/api/messages/${encodeURIComponent(messageId)}?intentId=${intentId}`, {
    method: "DELETE",
  }, "delete this message", OkEnvelopeSchema, "Deleting this message is waiting for approval.", signal);
}

export async function deleteMessage(
  messageId: string,
  signal?: AbortSignal,
  options: { allowGo?: boolean; actorId?: string | null; organizationId?: string | null; conversationId?: string | null } = {},
): Promise<MessagingOutcome<{ ok: true }>> {
  const actorId = options.actorId?.trim();
  const organizationId = options.organizationId?.trim();
  if (!actorId || !organizationId) {
    throw new MessagingApiError(0, "Message deletion needs a signed-in actor and active organization.");
  }
  const useGo = options.allowGo === true && typeof __GO_MESSAGING_DELETE_SLICE__ !== "undefined" && __GO_MESSAGING_DELETE_SLICE__;
  if (!useGo) {
    const pending = await getPendingMessageDelete({ actorId, organizationId });
    if (pending) {
      throw new MessagingApiError(0, "A Go message deletion is unresolved. Restore Go message deletion to retry the saved deletion before starting another deletion.");
    }
    return deleteMessageLegacy(messageId, signal);
  }
  return deleteMessageThroughGo(messageId, {
    actorId,
    organizationId,
    conversationId: options.conversationId ?? null,
  }, signal);
}

async function messageDeleteStorageKey(scope: MessageRetryScope): Promise<string> {
  const actorId = scope.actorId?.trim() ?? "";
  const organizationId = scope.organizationId?.trim() ?? "";
  if (!actorId || !organizationId) throw new MessagingApiError(0, "Message deletion needs a signed-in actor and active organization.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ actorId, organizationId })));
  const fingerprint = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  return `${pendingMessageDeletePrefix}${fingerprint}`;
}

function readPendingMessageDelete(key: string): PendingMessageDelete | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    throw new MessagingApiError(0, "Saved message-deletion recovery is unavailable. Check browser storage settings and try again.");
  }
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "messageId" in parsed && typeof parsed.messageId === "string" &&
      "conversationId" in parsed && (typeof parsed.conversationId === "string" || parsed.conversationId === null) &&
      "intentId" in parsed && typeof parsed.intentId === "string" && z.string().uuid().safeParse(parsed.intentId).success) {
      return { messageId: parsed.messageId, conversationId: parsed.conversationId, intentId: parsed.intentId };
    }
  } catch {
    // A damaged retry marker must not silently issue another tombstone.
  }
  throw new MessagingApiError(0, "A saved message deletion could not be verified. Refresh the conversation before deleting again.");
}

export async function getPendingMessageDelete(scope: MessageRetryScope): Promise<PendingMessageDelete | null> {
  return readPendingMessageDelete(await messageDeleteStorageKey(scope));
}

function clearPendingMessageDelete(key: string, intentId: string): void {
  try {
    if (readPendingMessageDelete(key)?.intentId === intentId) localStorage.removeItem(key);
  } catch {
    // A completed response is authoritative; a stale marker is safe to retry.
  }
}

async function deleteMessageThroughGo(
  messageId: string,
  scope: MessageRetryScope & { conversationId: string | null },
  signal?: AbortSignal,
): Promise<MessagingOutcome<{ ok: true }>> {
  const key = await messageDeleteStorageKey(scope);
  const pending = readPendingMessageDelete(key);
  if (pending && (pending.messageId !== messageId || pending.conversationId !== scope.conversationId)) {
    throw new MessagingApiError(0, "A message deletion is unresolved. Retry the saved deletion or refresh the conversation before deleting another message.");
  }
  const action = pending ?? { messageId, conversationId: scope.conversationId, intentId: newIntentId() };
  if (!pending) {
    try {
      localStorage.setItem(key, JSON.stringify(action));
    } catch {
      throw new MessagingApiError(0, "Message-deletion retry protection is unavailable. Check browser storage settings and try again.");
    }
  }

  const result = await send("/api/capabilities/execute", {
    method: "POST",
    body: JSON.stringify({ capabilityId: "messaging.deleteMessage", input: { messageId: action.messageId }, intentId: action.intentId }),
  }, "delete this message", signal);
  if (result.response.status === 202) {
    const parsed = PendingApprovalSchema.safeParse(result.body);
    if (!parsed.success) throw new MessagingApiError(202, "The messaging service returned an unexpected approval response to delete this message.");
    return { kind: "pending", reason: parsed.data.hint ?? parsed.data.reason ?? parsed.data.error ?? "Deleting this message is waiting for approval." };
  }
  if (!result.response.ok) {
    const terminal = result.response.status >= 400 && result.response.status < 500 && result.response.status !== 404 && result.response.status !== 408 && result.response.status !== 429;
    if (terminal) clearPendingMessageDelete(key, action.intentId);
    throw new MessagingApiError(result.response.status, readError(result.response.status, result.body, "delete this message"));
  }
  const parsed = GoDeleteMessageEnvelopeSchema.safeParse(result.body);
  if (!parsed.success || parsed.data.data.messageId !== action.messageId) {
    throw new MessagingApiError(result.response.status, "The messaging service returned an unexpected response to delete this message.");
  }
  clearPendingMessageDelete(key, action.intentId);
  return { kind: "completed", data: { ok: true } };
}

export async function setMessageReaction(messageId: string, emoji: string, active: boolean, signal?: AbortSignal): Promise<void> {
  const selectorOverride = (globalThis as typeof globalThis & { __GO_MESSAGING_REACTIONS__?: boolean }).__GO_MESSAGING_REACTIONS__;
  const goSelected = selectorOverride ?? (typeof __GO_MESSAGING_REACTIONS__ !== "undefined" && __GO_MESSAGING_REACTIONS__);
  if (goSelected) {
    const validatedMessageId = z.string().uuid().parse(messageId);
    const { response, body } = await send("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({
        capabilityId: "messaging.setMessageReaction",
        input: { messageId: validatedMessageId, emoji, active },
        intentId: newIntentId(),
      }),
    }, "save that reaction", signal);
    if (!response.ok) throw new MessagingApiError(response.status, readError(response.status, body, "save that reaction"));
    const parsed = GoMessageReactionEnvelopeSchema.safeParse(body);
    if (!parsed.success || parsed.data.data.active !== active) {
      throw new MessagingApiError(response.status, "The messaging service returned that reaction in an unexpected format.");
    }
    return;
  }
  await acknowledge(`/api/messages/${encodeURIComponent(messageId)}/reactions`, {
    method: "POST",
    body: JSON.stringify({ emoji, active, intentId: newIntentId() }),
  }, "save that reaction", signal);
}

export async function setMessagePin(messageId: string, pinned: boolean, signal?: AbortSignal): Promise<void> {
  const selectorOverride = (globalThis as typeof globalThis & { __GO_MESSAGING_PINS__?: boolean }).__GO_MESSAGING_PINS__;
  const goSelected = selectorOverride ?? (typeof __GO_MESSAGING_PINS__ !== "undefined" && __GO_MESSAGING_PINS__);
  if (goSelected) {
    const validatedMessageId = z.string().uuid().parse(messageId);
    const { response, body } = await send("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({
        capabilityId: "messaging.setMessagePin",
        input: { messageId: validatedMessageId, pinned },
        intentId: newIntentId(),
      }),
    }, "pin that message", signal);
    if (!response.ok) throw new MessagingApiError(response.status, readError(response.status, body, "pin that message"));
    const parsed = GoMessagePinEnvelopeSchema.safeParse(body);
    if (!parsed.success || parsed.data.data.pinned !== pinned) {
      throw new MessagingApiError(response.status, "The messaging service returned that pin in an unexpected format.");
    }
    return;
  }
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
