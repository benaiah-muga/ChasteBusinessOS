import { z } from "zod";
import { normalizeRetryActorId } from "./retry-scope";

const uuid = z.string().uuid();
const instant = z.string().datetime();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Money is always integer minor units, never a float, on this boundary. */
const SegmentSchema = z.object({
  id: uuid,
  name: z.string(),
  minSpendMinor: count,
  createdAt: instant,
}).strict();

const CampaignSchema = z.object({
  id: uuid,
  segmentId: uuid,
  name: z.string(),
  subject: z.string(),
  body: z.string(),
  /** Set once the campaign was handed to the outbox; still not delivered. */
  queuedAt: instant.nullable(),
  createdAt: instant,
}).strict();

const SendCountSchema = z.object({ campaignId: uuid, count }).strict();

/**
 * One append-only delivery row joined to its outbox message. `status` is the
 * provider's own state and `sentAt` is only present once the provider
 * acknowledged the operation, so nothing here is ever inferred.
 */
const SendLogEntrySchema = z.object({
  id: uuid,
  campaignId: uuid,
  customerName: z.string(),
  customerEmail: z.string().nullable(),
  queuedAt: instant,
  status: z.string(),
  sentAt: instant.nullable(),
}).strict();

const SnapshotSchema = z.object({
  segments: z.array(SegmentSchema),
  campaigns: z.array(CampaignSchema),
  sendCounts: z.array(SendCountSchema),
  recentSends: z.array(SendLogEntrySchema),
}).strict();

const ModuleResponseSchema = z.object({
  catalog: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string(),
    href: z.string().nullable(),
    protected: z.boolean().optional(),
  })),
  enabledModules: z.array(z.string().min(1)),
  usingDefaults: z.boolean(),
});

const CreateSegmentInputSchema = z.object({
  action: z.literal("createSegment"),
  name: z.string().min(1).max(120),
  minSpendMinor: count,
}).strict();
const CreateCampaignInputSchema = z.object({
  action: z.literal("createCampaign"),
  segmentId: uuid,
  name: z.string().min(1).max(120),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10000),
}).strict();
const SendCampaignInputSchema = z.object({
  action: z.literal("sendCampaign"),
  campaignId: uuid,
}).strict();
const CampaignAnalyticsInputSchema = z.object({
  action: z.literal("campaignAnalytics"),
  campaignId: uuid,
}).strict();

export const MarketingActionSchema = z.discriminatedUnion("action", [
  CreateSegmentInputSchema,
  CreateCampaignInputSchema,
  SendCampaignInputSchema,
  CampaignAnalyticsInputSchema,
]);

const MarketingActionOutputSchemas = {
  createSegment: z.object({ segmentId: z.string().min(1) }).strict(),
  createCampaign: z.object({ campaignId: z.string().min(1) }).strict(),
  sendCampaign: z.object({
    recipients: count,
    skippedOptOut: count,
    skippedNoAddress: count,
    alreadySent: count,
  }).strict(),
  campaignAnalytics: z.object({
    campaignName: z.string(),
    sentCount: count,
    queuedAt: instant.nullable(),
  }).strict(),
} as const;

const SuccessSchema = z.object({ ok: z.literal(true), data: z.unknown() }).strict();
const PendingSchema = z.object({
  ok: z.literal(false),
  pendingApproval: z.literal(true),
  reason: z.string().optional(),
  approvalId: uuid.optional(),
}).strict();
const ApiErrorSchema = z.object({ error: z.string().optional(), message: z.string().optional() });
const MarketingAttemptSchema = z.object({ fingerprint: z.string().min(1), intentId: uuid }).strict();

export type MarketingRetryScope = { actorId: string | null; organizationId: string | null };

export type MarketingSegment = z.infer<typeof SegmentSchema>;
export type MarketingCampaign = z.infer<typeof CampaignSchema>;
export type MarketingSendCount = z.infer<typeof SendCountSchema>;
export type MarketingSendLogEntry = z.infer<typeof SendLogEntrySchema>;
export type MarketingSnapshot = z.infer<typeof SnapshotSchema>;
export type MarketingAction = z.infer<typeof MarketingActionSchema>;
export type MarketingActionOutput<Action extends MarketingAction> = z.infer<typeof MarketingActionOutputSchemas[Action["action"]]>;

export type MarketingActionOutcome<Action extends MarketingAction> =
  | { kind: "completed"; data: MarketingActionOutput<Action> }
  | { kind: "pending"; reason: string };

export class MarketingApiError extends Error {
  constructor(readonly status: number, message: string, readonly requestMayHaveReachedServer = false) {
    super(message);
    this.name = "MarketingApiError";
  }
}

function requestSignal(signal?: AbortSignal, timeoutMs = 15_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function errorMessage(status: number, raw: unknown): string {
  const body = ApiErrorSchema.safeParse(raw);
  const serverMessage = body.success ? body.data.error ?? body.data.message : undefined;
  if (status === 401) return "Your session has ended. Sign in again to continue.";
  if (status === 403) return "You do not have permission to view or change marketing.";
  if (status === 404) return "This segment or campaign no longer exists. Reload and try again.";
  if (status === 409) return "This campaign changed elsewhere. Reload the send log before retrying.";
  if (status >= 500) return "The marketing service is unavailable. Try again.";
  if (serverMessage && serverMessage.length <= 240 && !/[{}<>]/.test(serverMessage)) return serverMessage;
  return "The marketing request could not be completed. Check the details and try again.";
}

async function readJson(response: Response, requestMayHaveReachedServer = false): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    const retryableClientStatus = response.status === 408 || response.status === 429;
    const terminalClientError = response.status >= 400 && response.status < 500 && response.status !== 202 && !retryableClientStatus;
    throw new MarketingApiError(response.status, "The marketing service returned an unreadable response.", requestMayHaveReachedServer || (response.status > 0 && !terminalClientError));
  }
}

function organizationHeader(scope?: MarketingRetryScope): Record<string, string> {
  const organizationId = scope?.organizationId?.trim();
  if (!organizationId || !uuid.safeParse(organizationId).success) {
    throw new MarketingApiError(0, "Wait for the active organization to load before viewing marketing.");
  }
  return { "X-Organization-ID": organizationId };
}

async function getJson(path: string, signal?: AbortSignal, scope?: MarketingRetryScope): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      headers: { accept: "application/json", ...organizationHeader(scope) },
      cache: "no-store",
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new MarketingApiError(0, "The marketing service took too long to respond. Try again.");
    }
    throw new MarketingApiError(0, "Could not reach the marketing service. Check your connection and try again.");
  }
  if (!response.ok) throw new MarketingApiError(response.status, errorMessage(response.status, await readJson(response)));
  return readJson(response);
}

export async function fetchMarketingEnabled(signal?: AbortSignal, scope?: MarketingRetryScope): Promise<boolean> {
  const parsed = ModuleResponseSchema.safeParse(await getJson("/api/modules", signal, scope));
  if (!parsed.success) throw new MarketingApiError(200, "The module switchboard returned data in an unexpected format.");
  const catalogIds = new Set(parsed.data.catalog.map((module) => module.id));
  if (!catalogIds.has("marketing")) throw new MarketingApiError(200, "The module switchboard omitted the marketing module.");
  if (parsed.data.enabledModules.some((id) => !catalogIds.has(id))) {
    throw new MarketingApiError(200, "The module switchboard returned an unknown module.");
  }
  return parsed.data.enabledModules.includes("marketing");
}

export async function fetchMarketingSnapshot(signal?: AbortSignal, scope?: MarketingRetryScope): Promise<MarketingSnapshot> {
  const headers = organizationHeader(scope);
  let response: Response;
  try {
    response = await fetch("/api/capabilities/execute", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json", ...headers },
      cache: "no-store",
      body: JSON.stringify({ capabilityId: "marketing.overviewSnapshot", input: {}, intentId: crypto.randomUUID() }),
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new MarketingApiError(0, "The marketing service took too long to respond. Try again.");
    }
    throw new MarketingApiError(0, "Could not reach the marketing service. Check your connection and try again.");
  }
  const responseBody = await readJson(response);
  if (!response.ok) throw new MarketingApiError(response.status, errorMessage(response.status, responseBody));
  const envelope = SuccessSchema.safeParse(responseBody);
  if (!envelope.success) throw new MarketingApiError(response.status, "The marketing service returned an unexpected report response.");
  const raw = envelope.data.data;
  const parsed = SnapshotSchema.safeParse(raw);
  if (!parsed.success) throw new MarketingApiError(200, "The marketing service returned data in an unexpected format.");
  return parsed.data;
}

/**
 * Every marketing write is a governed capability call, so an approval
 * requirement comes back as HTTP 202 with a pending envelope. That outcome is
 * reported as `pending`, never as a completed write and never as an error.
 */
export async function submitMarketingAction<Action extends MarketingAction>(
  action: Action,
  intentId: string = crypto.randomUUID(),
  retryScope?: MarketingRetryScope,
): Promise<MarketingActionOutcome<Action>> {
  const parsedAction = MarketingActionSchema.safeParse(action);
  if (!parsedAction.success) throw new MarketingApiError(0, "The marketing action contains invalid details.");
  if (!intentId.trim()) throw new MarketingApiError(0, "The marketing action needs an intent identity. Try again.");

  let attempt: MarketingAttempt | null = null;
  if (parsedAction.data.action === "createCampaign" || parsedAction.data.action === "sendCampaign") {
    attempt = await getMarketingAttempt(parsedAction.data, retryScope);
  } else if (parsedAction.data.action === "createSegment") {
    attempt = await getMarketingSegmentAttempt(parsedAction.data, retryScope);
  }
  const headers = organizationHeader(retryScope);
  const activeIntentId = attempt?.intentId ?? intentId;
  const requestBody: Record<string, unknown> = parsedAction.data.action === "createSegment"
    ? { capabilityId: "marketing.createSegment", input: { name: parsedAction.data.name, minSpendMinor: parsedAction.data.minSpendMinor }, intentId: activeIntentId }
    : parsedAction.data.action === "createCampaign"
      ? { capabilityId: "marketing.createCampaign", input: { segmentId: parsedAction.data.segmentId, name: parsedAction.data.name, subject: parsedAction.data.subject, body: parsedAction.data.body }, intentId: activeIntentId }
      : parsedAction.data.action === "sendCampaign"
        ? { capabilityId: "marketing.sendCampaign", input: { campaignId: parsedAction.data.campaignId }, intentId: activeIntentId }
        : parsedAction.data.action === "campaignAnalytics"
          ? { capabilityId: "marketing.campaignAnalytics", input: { campaignId: parsedAction.data.campaignId }, intentId: activeIntentId }
          : (() => { throw new MarketingApiError(0, "The marketing action is unsupported."); })();

  const send = (path: string, body: Record<string, unknown>) => fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json", ...headers },
    cache: "no-store",
    body: JSON.stringify(body),
    signal: requestSignal(undefined, 20_000),
  });

  let response: Response;
  try {
    response = await send("/api/capabilities/execute", requestBody);
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new MarketingApiError(0, "The marketing action took too long. Check the send log before trying again.", true);
    }
    throw new MarketingApiError(0, "Could not reach the marketing service. Check your connection and try again.", true);
  }

  const retryableStatus = response.status === 408 || response.status === 429;
  const missingGoRoute = response.status === 404;
  const terminalClientError = response.status >= 400 && response.status < 500 && response.status !== 202 && !retryableStatus && !missingGoRoute;
  if (attempt && terminalClientError) clearMarketingAttempt(attempt);
  const raw = await readJson(response, Boolean(attempt && missingGoRoute));
  if (response.status === 202) {
    const pending = PendingSchema.safeParse(raw);
    if (!pending.success) throw new MarketingApiError(response.status, "The marketing service returned an unexpected approval response.", true);
    return { kind: "pending", reason: pending.data.reason ?? "This action is waiting for human approval. It is in the Approvals inbox." };
  }
  if (!response.ok) {
    throw new MarketingApiError(response.status, errorMessage(response.status, raw), Boolean(attempt && (!terminalClientError || missingGoRoute)));
  }

  const envelope = SuccessSchema.safeParse(raw);
  if (!envelope.success) throw new MarketingApiError(response.status, "The marketing service returned an unexpected action response.", Boolean(attempt));
  const output = MarketingActionOutputSchemas[parsedAction.data.action].safeParse(envelope.data.data);
  if (!output.success) throw new MarketingApiError(response.status, "The marketing service returned an unexpected action result.", Boolean(attempt));
  if (attempt) clearMarketingAttempt(attempt);
  return { kind: "completed", data: output.data as MarketingActionOutput<Action> };
}

type MarketingAttempt = { storageKey: string; fingerprint: string; intentId: string };

async function marketingAttemptStorageKey(action: Extract<MarketingAction, { action: "createCampaign" | "sendCampaign" }>, scope?: MarketingRetryScope): Promise<{ storageKey: string; fingerprint: string }> {
  const actorId = normalizeRetryActorId(scope?.actorId);
  const organizationId = scope?.organizationId?.trim();
  if (!actorId || !organizationId || !uuid.safeParse(organizationId).success) {
    throw new MarketingApiError(0, "Wait for the active user and organization to load before changing campaigns.");
  }
  let scopeHash: string;
  let fingerprint: string;
  try {
    const hash = async (value: string) => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    };
    [scopeHash, fingerprint] = await Promise.all([
      hash(JSON.stringify({ actorId, organizationId })),
      hash(JSON.stringify(action)),
    ]);
  } catch {
    throw new MarketingApiError(0, "Could not prepare a durable campaign retry. Check browser storage and try again.");
  }
  const actionTarget = action.action === "createCampaign" ? "create" : `send:${action.campaignId}`;
  const storageKey = `chaste.marketing.campaign-intent.v1:${scopeHash}:${actionTarget}`;
  return { storageKey, fingerprint };
}

async function marketingSegmentScopeStorageKey(scope?: MarketingRetryScope): Promise<string> {
  const actorId = normalizeRetryActorId(scope?.actorId);
  const organizationId = scope?.organizationId?.trim();
  if (!actorId || !organizationId || !uuid.safeParse(organizationId).success) {
    throw new MarketingApiError(0, "Wait for the active user and organization to load before creating a segment.");
  }
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ actorId, organizationId })));
    const scopeHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `chaste.marketing.segment-intent.v1:${scopeHash}:create`;
  } catch {
    throw new MarketingApiError(0, "Could not prepare a durable segment retry. Check browser storage and try again.");
  }
}

async function marketingSegmentAttemptStorageKey(action: Extract<MarketingAction, { action: "createSegment" }>, scope?: MarketingRetryScope): Promise<{ storageKey: string; fingerprint: string }> {
  const storageKey = await marketingSegmentScopeStorageKey(scope);
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(action)));
    const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return { storageKey, fingerprint };
  } catch {
    throw new MarketingApiError(0, "Could not prepare a durable segment retry. Check browser storage and try again.");
  }
}

async function withMarketingReservationLock<T>(storageKey: string, reserve: () => Promise<T>): Promise<T> {
  const lockManager = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!lockManager) {
    throw new MarketingApiError(0, "This browser cannot safely reserve a Marketing action. Open it in a browser with Web Locks enabled before submitting the change.");
  }
  try {
    return await lockManager.request(storageKey, { mode: "exclusive" }, reserve);
  } catch (error) {
    if (error instanceof MarketingApiError) throw error;
    throw new MarketingApiError(0, "The browser could not reserve this Marketing action safely. Retry after closing other Marketing tabs.");
  }
}

async function getMarketingSegmentAttempt(action: Extract<MarketingAction, { action: "createSegment" }>, scope?: MarketingRetryScope): Promise<MarketingAttempt> {
  const { storageKey, fingerprint } = await marketingSegmentAttemptStorageKey(action, scope);
  return withMarketingReservationLock(storageKey, async () => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw !== null) {
        let decoded: unknown;
        try {
          decoded = JSON.parse(raw);
        } catch {
          throw new Error("segment retry marker is malformed");
        }
        const stored = MarketingAttemptSchema.safeParse(decoded);
        if (!stored.success || stored.data.fingerprint !== fingerprint) throw new Error("another segment payload is unresolved");
        return { storageKey, fingerprint, intentId: stored.data.intentId };
      }
      const intent = { fingerprint, intentId: crypto.randomUUID() };
      const serialized = JSON.stringify(intent);
      window.localStorage.setItem(storageKey, serialized);
      if (window.localStorage.getItem(storageKey) !== serialized) throw new Error("segment retry did not persist");
      return { storageKey, fingerprint, intentId: intent.intentId };
    } catch {
      throw new MarketingApiError(0, "A previous segment attempt is unresolved or browser storage could not retain this retry. Restore the exact draft or resolve the earlier attempt before changing it.");
    }
  });
}

async function getMarketingAttempt(action: Extract<MarketingAction, { action: "createCampaign" | "sendCampaign" }>, scope?: MarketingRetryScope): Promise<MarketingAttempt> {
  const { storageKey, fingerprint } = await marketingAttemptStorageKey(action, scope);
  return withMarketingReservationLock(storageKey, async () => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw !== null) {
        let decoded: unknown;
        try {
          decoded = JSON.parse(raw);
        } catch {
          throw new Error("campaign retry marker is malformed");
        }
        const stored = MarketingAttemptSchema.safeParse(decoded);
        if (!stored.success || stored.data.fingerprint !== fingerprint) throw new Error("another campaign payload is unresolved");
        return { storageKey, fingerprint, intentId: stored.data.intentId };
      }
      const intent = { fingerprint, intentId: crypto.randomUUID() };
      const serialized = JSON.stringify(intent);
      window.localStorage.setItem(storageKey, serialized);
      if (window.localStorage.getItem(storageKey) !== serialized) throw new Error("campaign retry did not persist");
      return { storageKey, fingerprint, intentId: intent.intentId };
    } catch {
      throw new MarketingApiError(0, "A previous campaign attempt is still unresolved or browser storage could not retain this retry. Restore the exact draft or resolve the earlier attempt before changing it.");
    }
  });
}

function clearMarketingAttempt(attempt: MarketingAttempt): void {
  try {
    const stored = MarketingAttemptSchema.safeParse(JSON.parse(window.localStorage.getItem(attempt.storageKey) ?? "null"));
    if (stored.success && stored.data.fingerprint === attempt.fingerprint && stored.data.intentId === attempt.intentId) {
      window.localStorage.removeItem(attempt.storageKey);
    }
  } catch {
    // A saved marker cannot change the server result, so resolution continues.
  }
}
