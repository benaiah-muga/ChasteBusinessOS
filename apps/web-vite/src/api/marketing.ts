import { z } from "zod";

const uuid = z.string().uuid();
const instant = z.string().datetime();
const count = z.number().int().nonnegative();

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
    queuedAt: z.string().nullable(),
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
  constructor(readonly status: number, message: string) {
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

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new MarketingApiError(response.status, "The marketing service returned an unreadable response.");
  }
}

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
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

export async function fetchMarketingEnabled(signal?: AbortSignal): Promise<boolean> {
  const parsed = ModuleResponseSchema.safeParse(await getJson("/api/modules", signal));
  if (!parsed.success) throw new MarketingApiError(200, "The module switchboard returned data in an unexpected format.");
  const catalogIds = new Set(parsed.data.catalog.map((module) => module.id));
  if (!catalogIds.has("marketing")) throw new MarketingApiError(200, "The module switchboard omitted the marketing module.");
  if (parsed.data.enabledModules.some((id) => !catalogIds.has(id))) {
    throw new MarketingApiError(200, "The module switchboard returned an unknown module.");
  }
  return parsed.data.enabledModules.includes("marketing");
}

export async function fetchMarketingSnapshot(signal?: AbortSignal): Promise<MarketingSnapshot> {
  const parsed = SnapshotSchema.safeParse(await getJson("/api/marketing", signal));
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
): Promise<MarketingActionOutcome<Action>> {
  const parsedAction = MarketingActionSchema.safeParse(action);
  if (!parsedAction.success) throw new MarketingApiError(0, "The marketing action contains invalid details.");
  if (!intentId.trim()) throw new MarketingApiError(0, "The marketing action needs an intent identity. Try again.");

  const useGo = parsedAction.data.action === "createSegment"
    && typeof __GO_MARKETING_SEGMENT_SLICE__ !== "undefined"
    && __GO_MARKETING_SEGMENT_SLICE__;
  const legacyBody = { ...parsedAction.data, intentId };
  const requestPath = useGo ? "/api/capabilities/execute" : "/api/marketing";
  const requestBody: Record<string, unknown> = useGo && parsedAction.data.action === "createSegment"
    ? {
      capabilityId: "marketing.createSegment",
      input: { name: parsedAction.data.name, minSpendMinor: parsedAction.data.minSpendMinor },
      intentId,
    }
    : legacyBody;

  const send = (path: string, body: Record<string, unknown>) => fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(body),
    signal: requestSignal(undefined, 20_000),
  });

  let response: Response;
  try {
    response = await send(requestPath, requestBody);
    // The proxy and API mount flags are paired, but keep local development
    // usable when only the Go proxy is configured and that API mount is absent.
    if (useGo && response.status === 404) response = await send("/api/marketing", legacyBody);
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new MarketingApiError(0, "The marketing action took too long. Check the send log before trying again.");
    }
    throw new MarketingApiError(0, "Could not reach the marketing service. Check your connection and try again.");
  }

  const raw = await readJson(response);
  if (response.status === 202) {
    const pending = PendingSchema.safeParse(raw);
    if (!pending.success) throw new MarketingApiError(response.status, "The marketing service returned an unexpected approval response.");
    return { kind: "pending", reason: pending.data.reason ?? "This action is waiting for human approval. It is in the Approvals inbox." };
  }
  if (!response.ok) throw new MarketingApiError(response.status, errorMessage(response.status, raw));

  const envelope = SuccessSchema.safeParse(raw);
  if (!envelope.success) throw new MarketingApiError(response.status, "The marketing service returned an unexpected action response.");
  const output = MarketingActionOutputSchemas[parsedAction.data.action].safeParse(envelope.data.data);
  if (!output.success) throw new MarketingApiError(response.status, "The marketing service returned an unexpected action result.");
  return { kind: "completed", data: output.data as MarketingActionOutput<Action> };
}
