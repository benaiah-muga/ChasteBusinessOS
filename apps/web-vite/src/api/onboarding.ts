import { z } from "zod";

/**
 * The setup wizard's API seam: bootstrap a workspace, record which setup steps
 * were finished or deferred, and import the two entities a migrating business
 * almost always has a spreadsheet of.
 *
 * Go owns onboarding state and workspace writes. This module validates every
 * payload, turns errors into safe guidance, and treats a 202 as approval-pending
 * rather than success.
 */

/** Mirrors the legacy ONBOARDING_STEPS list; the two must stay identical. */
export const ONBOARDING_STEPS = [
  "business_profile",
  "import_customers",
  "import_products",
  "connect_source",
  "invite_team",
] as const;

export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number];
export type OnboardingStepStatus = "done" | "pending" | "skipped";
export type OnboardingPath = "fresh" | "import" | "connect";
export type OnboardingImportEntity = "customers" | "products";

export interface OnboardingFailure {
  code: string;
  /** Short, calm headline in product language. */
  title: string;
  /** What the user can do about it. */
  hint: string;
  /** Raw method, url, status and payload, for power users to inspect. */
  detail?: string;
  retryAfterSec?: number;
}

export type OnboardingRecovery = "signin" | "dashboard" | "retry" | "none";

export type OnboardingImportRow = Record<string, string>;
export type OnboardingImportResult = z.infer<typeof ImportResultSchema>;
export type OnboardingUndoResult = { undone: number; remaining: number };

const StepStatusSchema = z.enum(["done", "pending", "skipped"]);
const PathSchema = z.enum(["fresh", "import", "connect"]);
const ImportEntitySchema = z.enum(["customers", "products"]);

const CreateWorkspaceSchema = z.object({
  orgName: z.string().trim().min(2).max(80),
  businessDescription: z.string().trim().min(20).max(8000),
  baseCurrency: z.string().length(3),
  path: PathSchema,
  deferredSteps: z.array(z.string()).max(20),
  intentId: z.string().min(8).max(100),
}).strict();

const StepUpdateSchema = z.object({
  step: z.enum(ONBOARDING_STEPS),
  status: StepStatusSchema,
}).strict();

const CompleteUpdateSchema = z.object({ complete: z.literal(true) }).strict();

const ImportSchema = z.object({
  entity: ImportEntitySchema,
  rows: z.array(z.record(z.string(), z.string())).min(1).max(5000),
  intentId: z.string().min(8).max(100),
}).strict();

const UndoSchema = z.object({
  entity: ImportEntitySchema,
  action: z.literal("undo"),
  importIds: z.array(z.string().uuid()).min(1).max(5000),
  intentId: z.string().min(8).max(100),
}).strict();

const OnboardingStateSchema = z.object({
  path: PathSchema,
  steps: z.record(z.string(), StepStatusSchema),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
}).passthrough();

const CreateWorkspaceResponseSchema = z.object({
  orgId: z.string().uuid(),
  replayed: z.boolean().optional(),
}).strict();
const StateResponseSchema = z.object({ state: OnboardingStateSchema }).strict();
const ImportRowErrorSchema = z.object({
  row: z.number().int(),
  field: z.string().optional(),
  message: z.string(),
}).strict();
const ImportResultSchema = z.object({
  inserted: z.number().int().nonnegative(),
  skippedDuplicates: z.number().int().nonnegative(),
  skippedDuplicateRows: z.array(z.number().int()).optional(),
  errors: z.array(ImportRowErrorSchema),
  createdIds: z.array(z.string().uuid()).optional(),
}).passthrough();
const UndoResultSchema = z.object({
  undone: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
}).strict();
const ErrorBodySchema = z.object({
  code: z.string().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
  reason: z.string().optional(),
  pendingApproval: z.boolean().optional(),
}).passthrough();

const WRITE_TIMEOUT_MS = 20_000;
/** Creating a workspace seeds accounts, a chart and embeddings, so it waits longer. */
const CREATE_TIMEOUT_MS = 90_000;

export class OnboardingApiError extends Error {
  constructor(readonly status: number, readonly failure: OnboardingFailure) {
    super(`${failure.title}. ${failure.hint}`);
    this.name = "OnboardingApiError";
  }
}

const KNOWN_FAILURES: Record<string, { title: string; hint: string }> = {
  unauthorized: { title: "Your session ended", hint: "Sign in again and you'll pick up right here." },
  already_onboarded: { title: "You already have a workspace", hint: "Nothing to set up - your books are open." },
  rate_limited: { title: "Too many attempts", hint: "Wait a moment and try again." },
  not_found: { title: "Set up your workspace first", hint: "This step needs a workspace to attach to." },
  forbidden: { title: "You don't have permission for this", hint: "Ask someone with the right role to perform it." },
  intent_conflict: { title: "This setup already started with different details", hint: "Start the setup again so the books match what you typed." },
};

/**
 * Turns an unsuccessful response into something a person can act on.
 *
 * A server message is only repeated when it reads like a sentence: short, and
 * free of the braces and angle brackets that would leak JSON into the UI.
 */
export function failureFromResponse(
  status: number,
  body: Record<string, unknown>,
  method: string,
  url: string,
): OnboardingFailure {
  const code = String(body.code ?? String(status));
  const message = String(body.error ?? body.message ?? "");
  const known = KNOWN_FAILURES[code];
  const friendly = known ?? {
    title: "That didn't work",
    hint:
      message && message.length <= 160 && !/[{}<>]/.test(message)
        ? message
        : "Nothing was changed. Try again in a moment.",
  };
  return {
    code,
    title: friendly.title,
    // The server's own copy already carries the countdown; don't overwrite it.
    hint: code === "rate_limited" && message ? message : friendly.hint,
    detail: `${method} ${url} => ${status}\n${JSON.stringify(body)}`,
    retryAfterSec: typeof body.retryAfterSec === "number" ? body.retryAfterSec : undefined,
  };
}

export function networkFailure(error: unknown): OnboardingFailure {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return {
      code: "timeout",
      title: "That took too long",
      hint: "The setup service did not answer in time. Nothing was changed, so try again.",
      detail: String(error),
    };
  }
  return {
    code: "network",
    title: "Can't reach the server",
    hint: "Check your connection and try again - nothing has been lost.",
    detail: String(error),
  };
}

/** Which way out the wizard offers for a given failure. */
export function recoveryFor(code: string): OnboardingRecovery {
  if (code === "pending_approval") return "none";
  if (code === "unauthorized") return "signin";
  if (code === "already_onboarded") return "dashboard";
  return "retry";
}

function requestSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface WireResponse {
  status: number;
  body: Record<string, unknown>;
}

async function send(
  url: string,
  method: "POST" | "PATCH",
  body: unknown,
  timeoutMs: number,
): Promise<WireResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: requestSignal(timeoutMs),
    });
  } catch (error) {
    throw new OnboardingApiError(0, networkFailure(error));
  }
  return { status: response.status, body: await readJson(response) };
}

/**
 * 202 is a governed write parked for approval: neither a success nor a
 * failure, so it never reaches the success parsers.
 */
function approved(wire: WireResponse, method: "POST" | "PATCH", url: string): WireResponse {
  if (wire.status === 202) {
    const parsed = ErrorBodySchema.safeParse(wire.body);
    const reason = parsed.success ? parsed.data.reason ?? parsed.data.error : undefined;
    throw new OnboardingApiError(202, {
      code: "pending_approval",
      title: "Waiting for approval",
      hint: reason ?? "This is queued for approval. It lands in the Approvals inbox first.",
      detail: `${method} ${url} => 202\n${JSON.stringify(wire.body)}`,
    });
  }
  if (wire.status < 200 || wire.status >= 300) {
    throw new OnboardingApiError(wire.status, failureFromResponse(wire.status, wire.body, method, url));
  }
  return wire;
}

export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceSchema>;

/**
 * One bootstrap intent per setup attempt (B01/T08): the caller creates the id
 * once and persists it, so a retry after a lost response replays the server's
 * receipt instead of creating a second organization.
 */
export async function createWorkspace(input: CreateWorkspaceInput): Promise<{ orgId: string; replayed: boolean }> {
  const parsed = CreateWorkspaceSchema.safeParse(input);
  if (!parsed.success) {
    throw new OnboardingApiError(0, {
      code: "invalid",
      title: "That doesn't look right",
      hint: "Check the business name, the description and the currency, then try again.",
    });
  }
  const wire = approved(await send("/api/onboarding", "POST", parsed.data, CREATE_TIMEOUT_MS), "POST", "/api/onboarding");
  const result = CreateWorkspaceResponseSchema.safeParse(wire.body);
  if (!result.success) {
    throw new OnboardingApiError(wire.status, {
      code: "invalid_response",
      title: "That didn't work",
      hint: "The setup service replied in a format we did not recognize. Try again in a moment.",
      detail: JSON.stringify(wire.body),
    });
  }
  return { orgId: result.data.orgId, replayed: result.data.replayed === true };
}

export async function markOnboardingStep(step: OnboardingStepKey, status: OnboardingStepStatus): Promise<void> {
  const parsed = StepUpdateSchema.safeParse({ step, status });
  if (!parsed.success) return;
  const url = "/api/onboarding";
  const wire = await send(url, "PATCH", parsed.data, WRITE_TIMEOUT_MS);
  if (!StateResponseSchema.safeParse(approved(wire, "PATCH", url).body).success) {
    throw new OnboardingApiError(wire.status, {
      code: "invalid_response",
      title: "That step was not recorded",
      hint: "The setup service replied in a format we did not recognize. The checklist may offer it again.",
      detail: JSON.stringify(wire.body),
    });
  }
}

export async function completeOnboardingSetup(): Promise<void> {
  const parsed = CompleteUpdateSchema.safeParse({ complete: true });
  if (!parsed.success) return;
  const url = "/api/onboarding";
  const wire = await send(url, "PATCH", parsed.data, WRITE_TIMEOUT_MS);
  if (!StateResponseSchema.safeParse(approved(wire, "PATCH", url).body).success) {
    throw new OnboardingApiError(wire.status, {
      code: "invalid_response",
      title: "Setup was not closed",
      hint: "The setup service replied in a format we did not recognize. Your checklist stays on your dashboard.",
      detail: JSON.stringify(wire.body),
    });
  }
}

/**
 * Governed batch import. One malformed row never cancels the rest: unmatched
 * rows come back in `errors` with their row number, duplicates are skipped
 * rather than duplicated, and `createdIds` is what makes an undo possible.
 */
export async function importOnboardingRows(
  entity: OnboardingImportEntity,
  rows: OnboardingImportRow[],
  intentId: string = crypto.randomUUID(),
): Promise<OnboardingImportResult> {
  const parsed = ImportSchema.safeParse({ entity, rows, intentId });
  if (!parsed.success) {
    throw new OnboardingApiError(0, {
      code: "invalid",
      title: "That file isn't ready to import",
      hint: "Check the preview: every row needs the fields the importer asked for.",
    });
  }
  const url = "/api/import";
  const wire = approved(await send(url, "POST", parsed.data, WRITE_TIMEOUT_MS), "POST", url);
  const result = ImportResultSchema.safeParse(wire.body);
  if (!result.success) {
    throw new OnboardingApiError(wire.status, {
      code: "invalid_response",
      title: "The import returned something unexpected",
      hint: "Nothing was confirmed as imported. Check the records before importing again.",
      detail: JSON.stringify(wire.body),
    });
  }
  return result.data;
}

export async function undoOnboardingImport(
  entity: OnboardingImportEntity,
  importIds: string[],
  intentId: string = crypto.randomUUID(),
): Promise<OnboardingUndoResult> {
  const parsed = UndoSchema.safeParse({ entity, action: "undo", importIds, intentId });
  if (!parsed.success) {
    throw new OnboardingApiError(0, {
      code: "invalid",
      title: "This import cannot be undone",
      hint: "There is no recent import to reverse here. Review the imported records instead.",
    });
  }
  const url = "/api/import";
  const wire = approved(await send(url, "POST", parsed.data, WRITE_TIMEOUT_MS), "POST", url);
  const result = UndoResultSchema.safeParse(wire.body);
  if (!result.success) {
    throw new OnboardingApiError(wire.status, {
      code: "invalid_response",
      title: "The undo returned something unexpected",
      hint: "The imported records are unchanged. Check them before trying again.",
      detail: JSON.stringify(wire.body),
    });
  }
  return result.data;
}

/** Normalises anything thrown by this module into one renderable failure. */
export function failureOf(error: unknown): OnboardingFailure {
  if (error instanceof OnboardingApiError) return error.failure;
  return networkFailure(error);
}
