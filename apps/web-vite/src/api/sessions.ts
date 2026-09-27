import { z } from "zod";

const IsoDateSchema = z.string().datetime();

const SessionSchema = z.object({
  id: z.string().min(1),
  title: z.string().nullable(),
  mode: z.string().min(1),
  status: z.string().min(1),
  modelRef: z.string().nullable(),
  createdAt: IsoDateSchema,
});

const SessionListSchema = z.object({ sessions: z.array(SessionSchema) });

const TrajectoryEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  role: z.string().min(1),
  content: z.unknown(),
  at: IsoDateSchema,
});

const SessionEventsSchema = z.object({ events: z.array(TrajectoryEventSchema) }).superRefine(({ events }, context) => {
  for (let index = 1; index < events.length; index += 1) {
    if (events[index - 1]!.seq >= events[index]!.seq) {
      context.addIssue({ code: "custom", message: "Session events must be in strictly increasing sequence order." });
      return;
    }
  }
});

const ReplaySchema = z.object({
  eventCount: z.number().int().nonnegative(),
  finalMessage: z.string(),
  observations: z.array(z.object({
    seq: z.number().int().nonnegative(),
    name: z.string(),
    result: z.string(),
  })),
});

const SessionReplaySchema = z.object({ trace: ReplaySchema });

const DurableRunSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().nullable(),
  goal: z.string(),
  status: z.string().min(1),
  currentStep: z.number().int().nonnegative(),
  modelRef: z.string().nullable(),
  harnessProfileId: z.string().nullable(),
  harnessProfileVersion: z.string().nullable(),
  harnessCompositionDigest: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  startedAt: IsoDateSchema.nullable(),
  finishedAt: IsoDateSchema.nullable(),
});

const DurableRunListSchema = z.object({ runs: z.array(DurableRunSchema) });

const DurableRunDetailSchema = z.object({
  run: DurableRunSchema.extend({
    registryVersion: z.string(),
    contractRevision: z.number().int().nonnegative(),
  }),
  steps: z.array(z.object({
    id: z.string().min(1),
    stepIndex: z.number().int().nonnegative(),
    capabilityId: z.string().nullable(),
    status: z.string().min(1),
    inputHash: z.string().nullable(),
    error: z.string().nullable(),
    receiptId: z.string().nullable(),
    approvalId: z.string().nullable(),
    createdAt: IsoDateSchema,
    startedAt: IsoDateSchema.nullable(),
    finishedAt: IsoDateSchema.nullable(),
  })),
});

const MetricsSchema = z.object({
  totals: z.object({
    sessionsTracked: z.number().int().nonnegative(),
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    cachedInputTokens: z.number().nonnegative(),
    cacheHitRatePct: z.number().min(0).max(100).nullable(),
  }),
  note: z.string(),
});

const ErrorBodySchema = z.object({ error: z.string().optional(), message: z.string().optional() });

export type AgentSession = z.infer<typeof SessionSchema>;
export type TrajectoryEvent = z.infer<typeof TrajectoryEventSchema>;
export type ReplayTrace = z.infer<typeof ReplaySchema>;
export type DurableRun = z.infer<typeof DurableRunSchema>;
export type DurableRunDetail = z.infer<typeof DurableRunDetailSchema>;
export type SessionMetrics = z.infer<typeof MetricsSchema>;

export class SessionsApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "SessionsApiError";
  }
}

function requestSignal(signal?: AbortSignal, timeoutMs = 15_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function parseJson(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new SessionsApiError(response.status, `The ${label} service returned an unreadable response.`);
  }
}

async function errorMessage(response: Response, label: string): Promise<string> {
  const body = ErrorBodySchema.safeParse(await response.json().catch(() => null));
  const serverMessage = body.success ? body.data.error ?? body.data.message : undefined;
  if (response.status === 401) return "Your session has ended. Sign in again to continue.";
  if (response.status === 403) return `You do not have permission to view ${label}.`;
  if (response.status === 404) return "This record is no longer available in the active workspace. Refresh and try again.";
  if (response.status >= 500) return `The ${label} service is unavailable. Try again.`;
  return serverMessage && serverMessage.length <= 240 && !/[{}<>]/.test(serverMessage)
    ? serverMessage
    : `The ${label} request could not be completed. Try again.`;
}

async function getJson(path: string, label: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new SessionsApiError(0, `The ${label} service took too long to load. Try again.`);
    }
    throw new SessionsApiError(0, `Could not reach the ${label} service. Check your connection and try again.`);
  }
  if (!response.ok) throw new SessionsApiError(response.status, await errorMessage(response, label));
  return parseJson(response, label);
}

async function fetchValidated<T>(
  path: string,
  label: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await getJson(path, label, signal);
  const parsed = schema.safeParse(response);
  if (!parsed.success) throw new SessionsApiError(200, `The ${label} service returned data in an unexpected format.`);
  return parsed.data;
}

export async function fetchSessions(signal?: AbortSignal): Promise<AgentSession[]> {
  const response = await fetchValidated("/api/sessions", "sessions", SessionListSchema, signal);
  return response.sessions;
}

export async function fetchSessionEvents(sessionId: string, signal?: AbortSignal): Promise<TrajectoryEvent[]> {
  const response = await fetchValidated(
    `/api/sessions/${encodeURIComponent(sessionId)}`,
    "session replay",
    SessionEventsSchema,
    signal,
  );
  return response.events;
}

export async function fetchSessionReplay(sessionId: string, signal?: AbortSignal): Promise<ReplayTrace> {
  const response = await fetchValidated(
    `/api/sessions/${encodeURIComponent(sessionId)}/replay`,
    "canonical replay",
    SessionReplaySchema,
    signal,
  );
  return response.trace;
}

export async function fetchDurableRuns(signal?: AbortSignal): Promise<DurableRun[]> {
  const response = await fetchValidated("/api/durable-runs", "durable work", DurableRunListSchema, signal);
  return response.runs;
}

export function fetchDurableRunDetail(runId: string, signal?: AbortSignal): Promise<DurableRunDetail> {
  return fetchValidated(
    `/api/durable-runs/${encodeURIComponent(runId)}`,
    "durable run details",
    DurableRunDetailSchema,
    signal,
  );
}

export function fetchSessionMetrics(signal?: AbortSignal): Promise<SessionMetrics> {
  return fetchValidated("/api/metrics", "context metrics", MetricsSchema, signal);
}
