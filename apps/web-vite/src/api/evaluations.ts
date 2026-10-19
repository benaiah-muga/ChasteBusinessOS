import { z } from "zod";

/**
 * Client for the bounded live evaluation harness. Runs answer every tool call
 * from fixtures on the server, so nothing here touches business records.
 */

const READ_TIMEOUT_MS = 15_000;
const RUN_TIMEOUT_MS = 100_000;

const SafeCountSchema = z.number().int().nonnegative().safe();

const EvaluationScenarioSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  checks: z.array(z.string()),
}).strict();

const EvaluationToolCallSchema = z.object({
  name: z.string().min(1),
  arguments: z.unknown(),
  result: z.unknown(),
}).strict();

const EvaluationCheckResultSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  passed: z.boolean(),
  detail: z.string(),
}).strict();

const EvaluationUsageSchema = z.object({
  input: SafeCountSchema,
  output: SafeCountSchema,
  cachedInput: SafeCountSchema,
}).strict();

const EvaluationRunResultSchema = z.object({
  scenarioId: z.string().min(1),
  status: z.enum(["passed", "failed", "error"]),
  model: z.string(),
  finalAnswer: z.string(),
  durationMs: SafeCountSchema,
  usage: EvaluationUsageSchema,
  toolCalls: z.array(EvaluationToolCallSchema),
  checks: z.array(EvaluationCheckResultSchema),
  error: z.string().default(""),
  persisted: z.boolean().default(false),
  createdAt: z.string().default(""),
}).strict();

const EvaluationCatalogSchema = z.object({
  live: z.boolean(),
  model: z.string(),
  scenarios: z.array(EvaluationScenarioSchema),
  recentRuns: z.array(EvaluationRunResultSchema).default([]),
}).strict();

export type EvaluationScenario = z.infer<typeof EvaluationScenarioSchema>;
export type EvaluationCatalog = z.infer<typeof EvaluationCatalogSchema>;
export type EvaluationToolCall = z.infer<typeof EvaluationToolCallSchema>;
export type EvaluationCheckResult = z.infer<typeof EvaluationCheckResultSchema>;
export type EvaluationUsage = z.infer<typeof EvaluationUsageSchema>;
export type EvaluationRunStatus = z.infer<typeof EvaluationRunResultSchema>["status"];
export type EvaluationRunResult = z.infer<typeof EvaluationRunResultSchema>;

export class EvaluationApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "EvaluationApiError";
  }
}

const ErrorBodySchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
  hint: z.string().optional(),
});

function usableServerMessage(raw: unknown): string | undefined {
  const body = ErrorBodySchema.safeParse(raw);
  const message = body.success ? body.data.error ?? body.data.message ?? body.data.hint : undefined;
  if (!message || message.length > 240 || /[{}<>]/.test(message)) return undefined;
  return message;
}

function errorMessage(status: number, raw: unknown): string {
  if (status === 401) return "Your session has ended. Sign in again to run evaluations.";
  if (status === 403) return "Quality runs are limited to organization admins. Ask an admin to run these checks.";
  if (status === 404) return "That evaluation scenario is no longer available. Refresh and try again.";
  if (status === 429) return "An evaluation is already running. Wait for it to finish and try again.";
  if (status === 503) {
    return "The live evaluation model is not configured. Set DEEPSEEK_API_KEY on the server and try again.";
  }
  if (status >= 500) return "The evaluations service is unavailable. Try again in a moment.";
  return usableServerMessage(raw) ?? "The evaluation request could not be completed. Refresh and try again.";
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function organizationHeader(organizationId: string): Record<string, string> {
  const trimmed = organizationId.trim();
  if (!trimmed) {
    throw new EvaluationApiError(0, "Wait for the active organization to finish loading before running evaluations.");
  }
  return { "X-Organization-ID": trimmed };
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...init.headers,
      },
      signal: requestSignal(signal, timeoutMs),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new EvaluationApiError(0, "The evaluation run took too long. Try again with a shorter scenario.");
    }
    throw new EvaluationApiError(0, "Could not reach the evaluations service. Check your connection and try again.");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new EvaluationApiError(
      response.status,
      response.ok
        ? "The evaluations service returned an unreadable response. Try again."
        : errorMessage(response.status, null),
    );
  }

  if (!response.ok) throw new EvaluationApiError(response.status, errorMessage(response.status, body));

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new EvaluationApiError(response.status, "The evaluations service returned data in an unexpected format.");
  }
  return parsed.data;
}

export async function fetchEvaluations(organizationId: string, signal?: AbortSignal): Promise<EvaluationCatalog> {
  return request(
    "/api/evaluations",
    EvaluationCatalogSchema,
    { method: "GET", headers: organizationHeader(organizationId) },
    signal,
    READ_TIMEOUT_MS,
  );
}

export async function runEvaluation(
  scenarioId: string,
  organizationId: string,
  signal?: AbortSignal,
): Promise<EvaluationRunResult> {
  const id = scenarioId.trim();
  if (!id) throw new EvaluationApiError(0, "Choose an evaluation scenario before running it.");
  return request(
    "/api/evaluations/run",
    EvaluationRunResultSchema,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...organizationHeader(organizationId),
      },
      body: JSON.stringify({ scenarioId: id }),
    },
    signal,
    RUN_TIMEOUT_MS,
  );
}
