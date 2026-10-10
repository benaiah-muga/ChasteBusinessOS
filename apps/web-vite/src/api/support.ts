import { z } from "zod";

const uuid = z.string().uuid();

export class SupportApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "SupportApiError";
  }
}

const requestSignal = (signal?: AbortSignal, timeoutMs = 15_000): AbortSignal => {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
};

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new SupportApiError(response.status, "The support service returned an unreadable response.");
  }
}

/**
 * Capability failures arrive as terse server prose ("conversation is resolved;
 * reopen it first"). That is safe to show once the status-specific copy has had
 * its chance, so the domain message survives but the raw wire text never does.
 */
function messageFor(status: number, body: unknown): string {
  if (status === 401) return "Your session has expired. Sign in again to continue.";
  if (status === 403) return "Your account does not have access to customer care. Ask an organization admin for the support permission.";
  if (status === 404) return "Customer care is switched off for this workspace, or that record is gone.";
  if (status === 429) return "Too many drafts in a row. Wait a moment, then try again.";
  if (status >= 500) return "The support service is unavailable. Try again.";
  const serverMessage = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "";
  if (serverMessage && serverMessage.length <= 240 && !/[{}<>]/.test(serverMessage)) {
    return serverMessage.charAt(0).toUpperCase() + serverMessage.slice(1);
  }
  return "The support request could not be completed. Check the details and try again.";
}

async function request(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<{ response: Response; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
      signal: requestSignal(signal, init.method === "POST" ? 20_000 : 15_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") throw new SupportApiError(0, "The support service took too long to respond. Check the thread before trying again.");
    throw new SupportApiError(0, "Could not reach the support service. Check your connection and try again.");
  }
  return { response, body: await readJson(response) };
}

async function get<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  const { response, body } = await request(path, {}, signal);
  if (!response.ok) throw new SupportApiError(response.status, messageFor(response.status, body));
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new SupportApiError(response.status, "The support service returned data in an unexpected format.");
  return parsed.data;
}

/* ── reads ──────────────────────────────────────────────────────────────── */

const ModuleSwitchboardSchema = z.object({
  catalog: z.array(z.object({
    id: z.string().min(1),
    label: z.string(),
    description: z.string(),
    href: z.string().nullable(),
    protected: z.boolean().optional(),
  }).strict()),
  enabledModules: z.array(z.string().min(1)),
  usingDefaults: z.boolean(),
}).strict();

/** Mirrors the module-context guard the legacy page gets from the app shell. */
export async function fetchSupportEnabled(signal?: AbortSignal): Promise<boolean> {
  const { response, body } = await request("/api/modules", {}, signal);
  if (!response.ok) throw new SupportApiError(response.status, "Could not check whether customer care is enabled.");
  const parsed = ModuleSwitchboardSchema.safeParse(body);
  if (!parsed.success) throw new SupportApiError(response.status, "The module switchboard returned data in an unexpected format.");
  const catalogIds = new Set(parsed.data.catalog.map((module) => module.id));
  if (!catalogIds.has("support")) throw new SupportApiError(response.status, "The module switchboard omitted the customer care module.");
  if (parsed.data.enabledModules.some((id) => !catalogIds.has(id))) throw new SupportApiError(response.status, "The module switchboard returned an unknown module.");
  return parsed.data.enabledModules.includes("support");
}

export const SupportConversationSchema = z.object({
  id: uuid,
  customerId: z.string(),
  customerName: z.string(),
  subject: z.string(),
  status: z.string(),
  lastMessageAt: z.string().nullable().optional(),
  // Only the list read carries a preview; the detail read carries ticket fields instead.
  lastMessagePreview: z.string().optional(),
  priority: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  assignedUserId: uuid.nullable().optional(),
  slaDueAt: z.string().nullable().optional(),
}).strict();
export type SupportConversation = z.infer<typeof SupportConversationSchema>;

const ConversationListSchema = z.object({ conversations: z.array(SupportConversationSchema) }).strict();

const GoSupportThreadConversationSchema = SupportConversationSchema.extend({
  customerId: uuid.nullable(),
  customerEmail: z.string().nullable(),
}).strict();
const GoCapabilityEnvelopeSchema = z.object({ ok: z.literal(true), data: z.unknown() }).strict();

export function goSupportInboxReadsUseGo(): boolean {
  return typeof __GO_SUPPORT_INBOX_READS__ !== "undefined" && __GO_SUPPORT_INBOX_READS__;
}

export function goSupportLibraryReadsUseGo(): boolean {
  return typeof __GO_SUPPORT_LIBRARY_READS__ !== "undefined" && __GO_SUPPORT_LIBRARY_READS__;
}

export function goSupportCannedResponseWriteUseGo(): boolean {
  return typeof __GO_SUPPORT_CANNED_RESPONSE_WRITE__ !== "undefined" && __GO_SUPPORT_CANNED_RESPONSE_WRITE__;
}

export function goSupportConversationWritesUseGo(): boolean {
  return typeof __GO_SUPPORT_CONVERSATION_WRITES__ !== "undefined" && __GO_SUPPORT_CONVERSATION_WRITES__;
}

export type SupportCannedResponseRetryScope = { actorId: string | null; organizationId: string | null };
export type SupportConversationWriteRetryScope = SupportCannedResponseRetryScope;

const CannedResponseWriteInputSchema = z.object({
  shortcut: z.string().min(1).max(40),
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(4000),
}).strict();
const CannedResponseRetryRecordSchema = z.object({
  version: z.literal(1),
  intentId: uuid,
  input: CannedResponseWriteInputSchema,
  fingerprint: z.string().min(1),
}).strict();
const CANNED_RESPONSE_RETRY_PREFIX = "chaste.support.canned-response-intent.v1:";

function cannedResponseRetryStorageKey(scope: SupportCannedResponseRetryScope): string {
  const actorId = scope.actorId?.trim() ?? "";
  const organizationId = scope.organizationId?.trim() ?? "";
  if (!uuid.safeParse(actorId).success || !uuid.safeParse(organizationId).success) {
    throw new SupportApiError(0, "Wait for your account and organization to finish loading before saving a canned response.");
  }
  return `${CANNED_RESPONSE_RETRY_PREFIX}${encodeURIComponent(actorId)}:${encodeURIComponent(organizationId)}`;
}

function cannedResponseInputFingerprint(input: z.infer<typeof CannedResponseWriteInputSchema>): string {
  return JSON.stringify(input);
}

function readCannedResponseRetryRecord(storageKey: string): z.infer<typeof CannedResponseRetryRecordSchema> | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(storageKey);
  } catch {
    throw new SupportApiError(0, "Canned-response retry protection is unavailable. Enable browser storage before saving.");
  }
  if (raw === null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new SupportApiError(0, "A saved canned-response retry record is unreadable. Verify the library before trying again.");
  }
  const parsed = CannedResponseRetryRecordSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.fingerprint !== cannedResponseInputFingerprint(parsed.data.input)) {
    throw new SupportApiError(0, "A saved canned-response retry record is invalid. Verify the library before trying again.");
  }
  return parsed.data;
}

export function readPendingSupportCannedResponse(scope: SupportCannedResponseRetryScope): z.infer<typeof CannedResponseWriteInputSchema> | null {
  const record = readCannedResponseRetryRecord(cannedResponseRetryStorageKey(scope));
  return record?.input ?? null;
}

async function createSupportCannedResponseAttempt(
  input: z.infer<typeof CannedResponseWriteInputSchema>,
  scope: SupportCannedResponseRetryScope,
): Promise<{ storageKey: string; record: z.infer<typeof CannedResponseRetryRecordSchema> }> {
  const storageKey = cannedResponseRetryStorageKey(scope);
  const fingerprint = cannedResponseInputFingerprint(input);
  const existing = readCannedResponseRetryRecord(storageKey);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new SupportApiError(0, "A previous canned-response save is unresolved. Retry its exact saved details before changing them.");
    }
    return { storageKey, record: existing };
  }
  const record = { version: 1 as const, intentId: crypto.randomUUID(), input, fingerprint };
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(record));
  } catch {
    throw new SupportApiError(0, "Canned-response retry protection could not be saved. Enable browser storage before continuing.");
  }
  const saved = readCannedResponseRetryRecord(storageKey);
  if (!saved || saved.intentId !== record.intentId || saved.fingerprint !== fingerprint) {
    throw new SupportApiError(0, "Canned-response retry protection could not be verified. Check browser storage and try again.");
  }
  return { storageKey, record: saved };
}

async function clearSupportCannedResponseAttempt(storageKey: string, intentId: string): Promise<void> {
  const current = readCannedResponseRetryRecord(storageKey);
  if (current?.intentId !== intentId) return;
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    throw new SupportApiError(0, "The canned response was saved, but its retry record could not be cleared. Retry the same saved details to confirm the result.");
  }
}

async function readGoSupportCapability<T>(
  capabilityId: "support.listConversations" | "support.readConversation" | "support.listLibrary",
  input: Record<string, unknown>,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const { response, body } = await request("/api/capabilities/execute", {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify({ capabilityId, input, intentId: crypto.randomUUID() }),
  }, signal);
  if (!response.ok) throw new SupportApiError(response.status, messageFor(response.status, body));
  const envelope = GoCapabilityEnvelopeSchema.safeParse(body);
  if (!envelope.success) throw new SupportApiError(response.status, "The Go support service returned an unexpected response.");
  const parsed = schema.safeParse(envelope.data.data);
  if (!parsed.success) throw new SupportApiError(response.status, "The Go support service returned data in an unexpected format.");
  return parsed.data;
}

export async function fetchSupportConversations(signal?: AbortSignal): Promise<SupportConversation[]> {
  if (goSupportInboxReadsUseGo()) {
    const parsed = await readGoSupportCapability("support.listConversations", { customerBoundOnly: true, limit: 100 }, ConversationListSchema, signal);
    return parsed.conversations;
  }
  const parsed = await get("/api/support", ConversationListSchema, signal);
  return parsed.conversations;
}

export const SupportMessageSchema = z.object({
  id: uuid,
  orgId: uuid,
  conversationId: uuid,
  senderType: z.string(),
  senderUserId: uuid.nullable(),
  body: z.string(),
  createdAt: z.string(),
}).strict();
export type SupportMessage = z.infer<typeof SupportMessageSchema>;

const GoSupportThreadSchema = z.object({
  conversation: GoSupportThreadConversationSchema,
  messages: z.array(SupportMessageSchema),
}).strict();

const SupportThreadSchema = z.object({
  conversation: SupportConversationSchema,
  messages: z.array(SupportMessageSchema),
}).strict();
export type SupportThread = z.infer<typeof SupportThreadSchema>;

export async function fetchSupportThread(conversationId: string, signal?: AbortSignal): Promise<SupportThread> {
  if (!uuid.safeParse(conversationId).success) throw new SupportApiError(0, "Choose a conversation to read its thread.");
  if (goSupportInboxReadsUseGo()) {
    const parsed = await readGoSupportCapability(
      "support.readConversation",
      { conversationId, limit: 200 },
      GoSupportThreadSchema,
      signal,
    );
    const { customerEmail: _customerEmail, customerId, ...conversation } = parsed.conversation;
    return {
      conversation: SupportConversationSchema.parse({ ...conversation, customerId: customerId ?? "" }),
      messages: parsed.messages,
    };
  }
  const query = new URLSearchParams({ id: conversationId });
  return get(`/api/support?${query.toString()}`, SupportThreadSchema, signal);
}

const SupportLibrarySchema = z.object({
  canned: z.array(z.object({ id: uuid, shortcut: z.string(), title: z.string(), body: z.string() }).strict()),
  articles: z.array(z.object({ id: uuid, title: z.string(), body: z.string(), category: z.string().nullable(), isPublic: z.boolean() }).strict()),
}).strict();
export type SupportLibrary = z.infer<typeof SupportLibrarySchema>;

export async function fetchSupportLibrary(signal?: AbortSignal): Promise<SupportLibrary> {
  if (goSupportLibraryReadsUseGo()) {
    return readGoSupportCapability("support.listLibrary", {}, SupportLibrarySchema, signal);
  }
  return get("/api/support?library=1", SupportLibrarySchema, signal);
}

const SupportChannelsSchema = z.object({
  autoReplyEnabled: z.boolean(),
  greeting: z.string(),
  embedToken: z.string().nullable(),
  canManage: z.boolean(),
}).strict();
export type SupportChannels = z.infer<typeof SupportChannelsSchema>;

export async function fetchSupportChannels(signal?: AbortSignal): Promise<SupportChannels> {
  return get("/api/support/channels", SupportChannelsSchema, signal);
}

const ChannelsPatchSchema = z
  .object({
    autoReplyEnabled: z.boolean().optional(),
    greeting: z.string().min(1).max(300).optional(),
    regenerateToken: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => patch.autoReplyEnabled !== undefined || patch.greeting !== undefined || patch.regenerateToken === true, {
    message: "A channel change must say what it changes.",
  });

export async function updateSupportChannels(
  patch: { autoReplyEnabled?: boolean; greeting?: string; regenerateToken?: true },
  signal?: AbortSignal,
): Promise<SupportChannels> {
  const parsedPatch = ChannelsPatchSchema.safeParse(patch);
  if (!parsedPatch.success) throw new SupportApiError(0, "The channel change is missing what it should update.");
  const { response, body } = await request("/api/support/channels", { method: "POST", body: JSON.stringify(parsedPatch.data) }, signal);
  if (!response.ok) throw new SupportApiError(response.status, messageFor(response.status, body));
  const parsed = SupportChannelsSchema.safeParse(body);
  if (!parsed.success) throw new SupportApiError(response.status, "The support service returned unexpected channel settings.");
  return parsed.data;
}

/** Shared team read. The envelope carries roles and a catalog alongside members. */
const TeamMemberSchema = z.object({ userId: z.string().min(1), name: z.string().nullable(), email: z.string() }).passthrough();
export type SupportTeamMember = z.infer<typeof TeamMemberSchema>;

export async function fetchSupportTeamMembers(signal?: AbortSignal): Promise<SupportTeamMember[]> {
  const result = await get("/api/team", z.object({ members: z.array(TeamMemberSchema) }), signal);
  return result.members;
}

/** Shared customer read. Rows carry CRM fields beyond the three the desk needs. */
const CustomerOptionSchema = z.object({ id: uuid, name: z.string(), email: z.string().nullable().optional() }).passthrough();
export type SupportCustomerOption = z.infer<typeof CustomerOptionSchema>;

export async function fetchSupportCustomerOptions(signal?: AbortSignal): Promise<SupportCustomerOption[]> {
  const result = await get("/api/customers", z.object({ customers: z.array(CustomerOptionSchema) }), signal);
  return result.customers;
}

/* ── governed writes ────────────────────────────────────────────────────── */

const CreateConversationInputSchema = z.object({ action: z.literal("create"), customerId: uuid, subject: z.string().min(1).max(200) }).strict();
const PostMessageInputSchema = z.object({
  action: z.literal("message"),
  conversationId: uuid,
  body: z.string().min(1).max(4000),
  from: z.enum(["customer", "staff"]).default("staff"),
}).strict();
const SendDraftInputSchema = z.object({ action: z.literal("send"), conversationId: uuid, body: z.string().min(1).max(4000) }).strict();
const EscalateInputSchema = z.object({ action: z.literal("escalate"), conversationId: uuid, reason: z.string().min(3).max(4000) }).strict();
const ResolveInputSchema = z.object({ action: z.literal("resolve"), conversationId: uuid }).strict();
const ReopenInputSchema = z.object({ action: z.literal("reopen"), conversationId: uuid }).strict();
const UpdateTicketInputSchema = z.object({
  action: z.literal("updateTicket"),
  conversationId: uuid,
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  category: z.string().max(40).optional(),
  assigneeUserId: uuid.optional(),
  slaDueAt: z.string().datetime().optional(),
}).strict();
const SuggestCategoryInputSchema = z.object({ action: z.literal("suggestCategory"), text: z.string().min(1).max(2000) }).strict();
const CreateCannedResponseInputSchema = z.object({
  action: z.literal("createCannedResponse"),
  shortcut: z.string().min(1).max(40),
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(4000),
}).strict();
const CreateKbArticleInputSchema = z.object({
  action: z.literal("createKbArticle"),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(20000),
  category: z.string().max(40).optional(),
  isPublic: z.boolean().optional(),
}).strict();

export const SupportWriteActionSchema = z.discriminatedUnion("action", [
  CreateConversationInputSchema,
  PostMessageInputSchema,
  SendDraftInputSchema,
  EscalateInputSchema,
  ResolveInputSchema,
  ReopenInputSchema,
  UpdateTicketInputSchema,
  SuggestCategoryInputSchema,
  CreateCannedResponseInputSchema,
  CreateKbArticleInputSchema,
]);
export type SupportWriteAction = z.infer<typeof SupportWriteActionSchema>;

const SupportActionOutputSchemas = {
  create: z.object({ conversationId: z.string().min(1) }).strict(),
  message: z.object({ messageId: z.string().min(1), senderType: z.string() }).strict(),
  send: z.object({ messageId: z.string().min(1), senderType: z.string() }).strict(),
  escalate: z.object({ status: z.literal("escalated") }).strict(),
  resolve: z.object({ status: z.literal("resolved") }).strict(),
  reopen: z.object({ status: z.literal("open") }).strict(),
  updateTicket: z.object({ updated: z.literal(true) }).strict(),
  suggestCategory: z.object({ category: z.string(), draft: z.literal(true) }).strict(),
  createCannedResponse: z.object({ cannedResponseId: z.string().min(1) }).strict(),
  createKbArticle: z.object({ articleId: z.string().min(1) }).strict(),
} as const;

export type SupportActionOutput<Action extends SupportWriteAction> = z.infer<typeof SupportActionOutputSchemas[Action["action"]]>;

export type SupportActionOutcome<Output> =
  | { kind: "completed"; data: Output }
  | { kind: "pending"; reason: string };

const SuccessEnvelopeSchema = z.object({ ok: z.literal(true), data: z.unknown() }).strict();
// The gated-write envelope, in both shapes the legacy routes emit:
// { ok: false, pendingApproval: true, reason } and { error, pendingApproval: true }.
// One of the three copy fields is required so a bare flag cannot masquerade as a gate.
const PendingEnvelopeSchema = z
  .object({
    ok: z.literal(false).optional(),
    pendingApproval: z.literal(true),
    reason: z.string().optional(),
    error: z.string().optional(),
    hint: z.string().optional(),
  })
  .strict()
  .refine((pending) => Boolean(pending.reason ?? pending.error ?? pending.hint), {
    message: "An approval-pending answer must say why it is waiting.",
  });

const DEFAULT_PENDING_REASON = "This action is waiting for approval in the Approvals inbox.";

function pendingOutcome(body: unknown, fallback: string): SupportActionOutcome<never> {
  const pending = PendingEnvelopeSchema.safeParse(body);
  if (!pending.success) throw new SupportApiError(202, "The support service returned an unexpected approval response.");
  return { kind: "pending", reason: pending.data.reason ?? pending.data.error ?? pending.data.hint ?? fallback };
}

/**
 * `intentId` is passed only where the legacy page sent one (the library
 * writers and the quick customer create). Thread actions are submitted
 * without one so a retried message stays a distinct intent, matching the
 * oracle rather than silently reconciling two different replies.
 */
export async function submitSupportAction<Action extends SupportWriteAction>(
  action: Action,
  intentId?: string,
  signal?: AbortSignal,
): Promise<SupportActionOutcome<SupportActionOutput<Action>>> {
  const parsedAction = SupportWriteActionSchema.safeParse(action);
  if (!parsedAction.success) throw new SupportApiError(0, "The support action contains invalid details.");
  if (intentId !== undefined && !intentId.trim()) throw new SupportApiError(0, "The support action needs an intent identity. Try again.");

  const { response, body } = await request(
    "/api/support",
    { method: "POST", body: JSON.stringify(intentId ? { ...parsedAction.data, intentId } : parsedAction.data) },
    signal,
  );
  if (response.status === 202) return pendingOutcome(body, DEFAULT_PENDING_REASON);
  // A route that flags the gate without the 202 status is still a gate, not a failure.
  if (PendingEnvelopeSchema.safeParse(body).success) return pendingOutcome(body, DEFAULT_PENDING_REASON);
  if (!response.ok) throw new SupportApiError(response.status, messageFor(response.status, body));

  const envelope = SuccessEnvelopeSchema.safeParse(body);
  if (!envelope.success) throw new SupportApiError(response.status, "The support service returned an unexpected action response.");
  const output = SupportActionOutputSchemas[parsedAction.data.action].safeParse(envelope.data.data);
  if (!output.success) throw new SupportApiError(response.status, "The support service returned an unexpected action result.");
  return { kind: "completed", data: output.data as SupportActionOutput<Action> };
}

const GoSupportConversationInputSchema = z.discriminatedUnion("capabilityId", [
  z.object({ capabilityId: z.literal("support.startConversation"), input: z.object({ customerId: uuid, subject: z.string().min(1).max(200) }).strict() }).strict(),
  z.object({ capabilityId: z.literal("support.postMessage"), input: z.object({ conversationId: uuid, body: z.string().min(1).max(4000), from: z.enum(["customer", "staff"]) }).strict() }).strict(),
  z.object({ capabilityId: z.literal("support.escalateConversation"), input: z.object({ conversationId: uuid, reason: z.string().min(3).max(4000) }).strict() }).strict(),
  z.object({ capabilityId: z.literal("support.resolveConversation"), input: z.object({ conversationId: uuid }).strict() }).strict(),
  z.object({ capabilityId: z.literal("support.reopenConversation"), input: z.object({ conversationId: uuid }).strict() }).strict(),
]);
const GoSupportConversationRetryRecordSchema = z.object({
  version: z.literal(1),
  intentId: uuid,
  capabilityId: z.enum(["support.startConversation", "support.postMessage", "support.escalateConversation", "support.resolveConversation", "support.reopenConversation"]),
  input: z.record(z.string(), z.unknown()),
  fingerprint: z.string().min(1),
}).strict();
const SUPPORT_CONVERSATION_RETRY_PREFIX = "chaste.support.conversation-write-intent.v1:";
const SUPPORT_CONVERSATION_RETRY_KEY = `${SUPPORT_CONVERSATION_RETRY_PREFIX}pending`;

const GoSupportConversationOutputSchemas = {
  "support.startConversation": z.object({ conversationId: uuid }).strict(),
  "support.postMessage": z.object({ messageId: uuid, senderType: z.enum(["customer", "staff", "agent"]) }).strict(),
  "support.escalateConversation": z.object({ status: z.literal("escalated") }).strict(),
  "support.resolveConversation": z.object({ status: z.literal("resolved") }).strict(),
  "support.reopenConversation": z.object({ status: z.literal("open") }).strict(),
} as const;

export type PendingSupportConversationWrite = {
  capabilityId: z.infer<typeof GoSupportConversationInputSchema>["capabilityId"];
  input: Record<string, unknown>;
};

function supportConversationRetryStorageKey(scope: SupportConversationWriteRetryScope): string {
  const actorId = scope.actorId?.trim() ?? "";
  const organizationId = scope.organizationId?.trim() ?? "";
  if (!uuid.safeParse(actorId).success || !uuid.safeParse(organizationId).success) {
    throw new SupportApiError(0, "Wait for your account and organization to finish loading before changing a conversation.");
  }
  return `${SUPPORT_CONVERSATION_RETRY_KEY}:${encodeURIComponent(actorId)}:${encodeURIComponent(organizationId)}`;
}

function supportConversationFingerprint(capabilityId: string, input: Record<string, unknown>): string {
  return JSON.stringify({ capabilityId, input });
}

function readSupportConversationRetryRecord(storageKey: string): z.infer<typeof GoSupportConversationRetryRecordSchema> | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(storageKey);
  } catch {
    throw new SupportApiError(0, "Conversation retry protection is unavailable. Enable browser storage before continuing.");
  }
  if (raw === null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new SupportApiError(0, "A saved conversation retry record is unreadable. Verify the thread before trying again.");
  }
  const parsed = GoSupportConversationRetryRecordSchema.safeParse(decoded);
  const validInput = parsed.success ? GoSupportConversationInputSchema.safeParse({ capabilityId: parsed.data.capabilityId, input: parsed.data.input }) : null;
  if (!parsed.success || !validInput?.success || parsed.data.fingerprint !== supportConversationFingerprint(parsed.data.capabilityId, parsed.data.input)) {
    throw new SupportApiError(0, "A saved conversation retry record is invalid. Verify the thread before trying again.");
  }
  return parsed.data;
}

export function readPendingSupportConversationWrite(scope: SupportConversationWriteRetryScope): PendingSupportConversationWrite | null {
  const record = readSupportConversationRetryRecord(supportConversationRetryStorageKey(scope));
  return record ? { capabilityId: record.capabilityId, input: record.input } : null;
}

export function supportWriteActionFromPending(pending: PendingSupportConversationWrite): SupportWriteAction {
  const parsed = GoSupportConversationInputSchema.safeParse(pending);
  if (!parsed.success) throw new SupportApiError(0, "The saved conversation action is invalid. Verify the thread before trying again.");
  switch (parsed.data.capabilityId) {
    case "support.startConversation": return { action: "create", ...parsed.data.input };
    case "support.postMessage": return { action: "message", ...parsed.data.input };
    case "support.escalateConversation": return { action: "escalate", ...parsed.data.input };
    case "support.resolveConversation": return { action: "resolve", ...parsed.data.input };
    case "support.reopenConversation": return { action: "reopen", ...parsed.data.input };
  }
}

async function createSupportConversationWriteAttempt(
  capabilityId: PendingSupportConversationWrite["capabilityId"],
  rawInput: Record<string, unknown>,
  scope: SupportConversationWriteRetryScope,
): Promise<{ storageKey: string; record: z.infer<typeof GoSupportConversationRetryRecordSchema> }> {
  const parsedInput = GoSupportConversationInputSchema.safeParse({ capabilityId, input: rawInput });
  if (!parsedInput.success) throw new SupportApiError(0, "The conversation action contains invalid details.");
  const storageKey = supportConversationRetryStorageKey(scope);
  const input = parsedInput.data.input;
  const fingerprint = supportConversationFingerprint(capabilityId, input);
  const existing = readSupportConversationRetryRecord(storageKey);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new SupportApiError(0, "A previous conversation action is unresolved. Retry its exact saved details before changing anything else.");
    }
    return { storageKey, record: existing };
  }
  const record = { version: 1 as const, intentId: crypto.randomUUID(), capabilityId, input, fingerprint };
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(record));
  } catch {
    throw new SupportApiError(0, "Conversation retry protection could not be saved. Enable browser storage before continuing.");
  }
  const saved = readSupportConversationRetryRecord(storageKey);
  if (!saved || saved.intentId !== record.intentId || saved.fingerprint !== fingerprint) {
    throw new SupportApiError(0, "Conversation retry protection could not be verified. Check browser storage and try again.");
  }
  return { storageKey, record: saved };
}

async function clearSupportConversationWriteAttempt(storageKey: string, intentId: string): Promise<void> {
  const current = readSupportConversationRetryRecord(storageKey);
  if (current?.intentId !== intentId) return;
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    throw new SupportApiError(0, "The conversation action was saved, but its retry record could not be cleared. Retry the exact saved details to confirm the result.");
  }
}

function capabilityForSupportAction(action: SupportWriteAction): PendingSupportConversationWrite["capabilityId"] | null {
  switch (action.action) {
    case "create": return "support.startConversation";
    case "message":
    case "send": return "support.postMessage";
    case "escalate": return "support.escalateConversation";
    case "resolve": return "support.resolveConversation";
    case "reopen": return "support.reopenConversation";
    default: return null;
  }
}

function inputForSupportCapability(action: SupportWriteAction): Record<string, unknown> {
  switch (action.action) {
    case "create": return { customerId: action.customerId, subject: action.subject };
    case "message": return { conversationId: action.conversationId, body: action.body, from: action.from };
    case "send": return { conversationId: action.conversationId, body: action.body, from: "staff" };
    case "escalate": return { conversationId: action.conversationId, reason: action.reason };
    case "resolve":
    case "reopen": return { conversationId: action.conversationId };
    default: return {};
  }
}

export async function submitSupportConversationAction<Action extends SupportWriteAction>(
  action: Action,
  scope: SupportConversationWriteRetryScope,
  signal?: AbortSignal,
): Promise<SupportActionOutcome<SupportActionOutput<Action>>> {
  const parsedAction = SupportWriteActionSchema.safeParse(action);
  if (!parsedAction.success) throw new SupportApiError(0, "The support action contains invalid details.");
  const capabilityId = capabilityForSupportAction(parsedAction.data);
  if (!capabilityId) return submitSupportAction(parsedAction.data, undefined, signal) as Promise<SupportActionOutcome<SupportActionOutput<Action>>>;
  const input = inputForSupportCapability(parsedAction.data);
  const useGo = goSupportConversationWritesUseGo();
  if (!useGo) {
    try {
      const actorId = scope.actorId?.trim() ?? "";
      const organizationId = scope.organizationId?.trim() ?? "";
      if (uuid.safeParse(actorId).success && uuid.safeParse(organizationId).success) {
        if (readSupportConversationRetryRecord(supportConversationRetryStorageKey(scope))) {
          throw new SupportApiError(0, "A Go conversation action is unresolved. Restore Go conversation writes and retry those exact details before using the legacy route.");
        }
      } else {
        for (let index = 0; index < window.localStorage.length; index += 1) {
          if (window.localStorage.key(index)?.startsWith(SUPPORT_CONVERSATION_RETRY_PREFIX)) {
            throw new SupportApiError(0, "A Go conversation action is unresolved. Restore Go conversation writes and retry those exact details before using the legacy route.");
          }
        }
      }
    } catch (error) {
      if (error instanceof SupportApiError) throw error;
      throw new SupportApiError(0, "A saved conversation retry record could not be checked. Restore Go conversation writes before continuing.");
    }
    return submitSupportAction(parsedAction.data, undefined, signal) as Promise<SupportActionOutcome<SupportActionOutput<Action>>>;
  }

  const attempt = await createSupportConversationWriteAttempt(capabilityId, input, scope);
  let response: Response;
  let body: unknown;
  try {
    ({ response, body } = await request("/api/capabilities/execute", {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify({ capabilityId: attempt.record.capabilityId, input: attempt.record.input, intentId: attempt.record.intentId }),
    }, signal));
  } catch {
    throw new SupportApiError(0, "The Go support service could not confirm this conversation action. Retry its exact saved details to recover the result.");
  }
  if (response.status === 202 || PendingEnvelopeSchema.safeParse(body).success) return pendingOutcome(body, DEFAULT_PENDING_REASON);
  if (!response.ok) throw new SupportApiError(response.status, messageFor(response.status, body));
  const envelope = GoCapabilityEnvelopeSchema.safeParse(body);
  const outputSchema = GoSupportConversationOutputSchemas[capabilityId];
  const output = envelope.success ? outputSchema.safeParse(envelope.data.data) : null;
  if (response.status !== 200 || !output?.success) {
    throw new SupportApiError(response.status, "The Go support service returned an unexpected conversation result.");
  }
  await clearSupportConversationWriteAttempt(attempt.storageKey, attempt.record.intentId);
  return { kind: "completed", data: output.data as SupportActionOutput<Action> };
}

export async function submitSupportCannedResponse(
  action: Extract<SupportWriteAction, { action: "createCannedResponse" }>,
  scope: SupportCannedResponseRetryScope,
  signal?: AbortSignal,
): Promise<SupportActionOutcome<SupportActionOutput<Extract<SupportWriteAction, { action: "createCannedResponse" }>>>> {
  const parsed = CreateCannedResponseInputSchema.safeParse(action);
  if (!parsed.success) throw new SupportApiError(0, "The canned response contains invalid details.");
  const { action: _action, ...rawInput } = parsed.data;
  const input = CannedResponseWriteInputSchema.parse(rawInput);
  const useGo = goSupportCannedResponseWriteUseGo();
  if (!useGo) {
    try {
      const actorId = scope.actorId?.trim() ?? "";
      const organizationId = scope.organizationId?.trim() ?? "";
      if (uuid.safeParse(actorId).success && uuid.safeParse(organizationId).success) {
        if (readCannedResponseRetryRecord(cannedResponseRetryStorageKey(scope))) {
          throw new SupportApiError(0, "A Go canned-response save is unresolved. Restore Go canned-response writes and retry those exact details before using the legacy route.");
        }
      } else {
        for (let index = 0; index < window.localStorage.length; index += 1) {
          if (window.localStorage.key(index)?.startsWith(CANNED_RESPONSE_RETRY_PREFIX)) {
            throw new SupportApiError(0, "A Go canned-response save is unresolved. Restore Go canned-response writes and retry those exact details before using the legacy route.");
          }
        }
      }
    } catch (error) {
      if (error instanceof SupportApiError) throw error;
      throw new SupportApiError(0, "A saved canned-response retry record could not be checked. Restore Go canned-response writes before continuing.");
    }
    return submitSupportAction(parsed.data, crypto.randomUUID(), signal);
  }

  const attempt = await createSupportCannedResponseAttempt(input, scope);
  let response: Response;
  let body: unknown;
  try {
    ({ response, body } = await request("/api/capabilities/execute", {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify({ capabilityId: "support.createCannedResponse", input: attempt.record.input, intentId: attempt.record.intentId }),
    }, signal));
  } catch {
    throw new SupportApiError(0, "The Go support service could not confirm this canned-response save. Retry the exact saved details to recover its result.");
  }
  if (response.status === 202 || PendingEnvelopeSchema.safeParse(body).success) {
    return pendingOutcome(body, DEFAULT_PENDING_REASON);
  }
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500 && response.status !== 404 && response.status !== 408 && response.status !== 422 && response.status !== 429) {
      await clearSupportCannedResponseAttempt(attempt.storageKey, attempt.record.intentId);
    }
    throw new SupportApiError(response.status, messageFor(response.status, body));
  }
  const envelope = GoCapabilityEnvelopeSchema.safeParse(body);
  const output = envelope.success ? SupportActionOutputSchemas.createCannedResponse.safeParse(envelope.data.data) : null;
  if (response.status !== 200 || !output?.success) {
    throw new SupportApiError(response.status, "The Go support service returned an unexpected canned-response result.");
  }
  await clearSupportCannedResponseAttempt(attempt.storageKey, attempt.record.intentId);
  return { kind: "completed", data: output.data };
}

const CustomerCreateSchema = z.object({
  action: z.literal("create"),
  name: z.string().min(1).max(120),
  email: z.string().email().optional(),
}).strict();
const CustomerCreateOutputSchema = z.object({ customerId: uuid, duplicateWarning: z.string().nullable() }).strict();

export type SupportCustomerCreated = z.infer<typeof CustomerCreateOutputSchema>;

export async function createSupportCustomer(
  input: { name: string; email?: string },
  intentId: string = crypto.randomUUID(),
  signal?: AbortSignal,
): Promise<SupportActionOutcome<SupportCustomerCreated>> {
  const parsedInput = CustomerCreateSchema.safeParse({ action: "create", ...input });
  if (!parsedInput.success) throw new SupportApiError(0, "A customer name is required.");

  const { response, body } = await request("/api/customers", { method: "POST", body: JSON.stringify({ ...parsedInput.data, intentId }) }, signal);
  if (response.status === 202) return pendingOutcome(body, "Creating this customer is waiting for approval in the Approvals inbox.");
  if (PendingEnvelopeSchema.safeParse(body).success) return pendingOutcome(body, "Creating this customer is waiting for approval in the Approvals inbox.");
  if (!response.ok) throw new SupportApiError(response.status, messageFor(response.status, body));
  const envelope = SuccessEnvelopeSchema.safeParse(body);
  const output = CustomerCreateOutputSchema.safeParse(envelope.success ? envelope.data.data : body);
  if (!output.success) throw new SupportApiError(response.status, "The customer service returned an unexpected creation result.");
  return { kind: "completed", data: output.data };
}

/**
 * Drafting is read-class: the model reads the thread, and the reply only
 * reaches the customer when a human releases it through the send action.
 */
const SupportDraftSchema = z.object({
  draft: z.string(),
  sessionId: z.string().optional(),
  steps: z.number().int().optional(),
}).strict();
export type SupportDraft = z.infer<typeof SupportDraftSchema>;

export async function fetchSupportDraft(conversationId: string, signal?: AbortSignal): Promise<SupportDraft> {
  if (!uuid.safeParse(conversationId).success) throw new SupportApiError(0, "Choose a conversation before drafting a reply.");
  const { response, body } = await request("/api/support", { method: "POST", body: JSON.stringify({ action: "draft", conversationId }) }, signal);
  if (response.status === 202 || PendingEnvelopeSchema.safeParse(body).success) {
    throw new SupportApiError(response.status, "Drafting is waiting for approval in the Approvals inbox.");
  }
  if (!response.ok) throw new SupportApiError(response.status, messageFor(response.status, body));
  const parsed = SupportDraftSchema.safeParse(body);
  if (!parsed.success) throw new SupportApiError(response.status, "The support service returned an unexpected draft.");
  return parsed.data;
}
