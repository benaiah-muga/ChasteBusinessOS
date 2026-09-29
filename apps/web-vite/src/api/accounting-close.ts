import { z } from "zod";

const SwitchboardSchema = z.object({
  catalog: z.array(z.object({ id: z.string().min(1) })),
  enabledModules: z.array(z.string().min(1)),
});

const CloseTaskSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  detail: z.string(),
  completed: z.boolean(),
  note: z.string().nullable(),
  blocking: z.boolean(),
  status: z.string().min(1),
}).strict();

const CloseReadinessSchema = z.object({
  year: z.number().int().safe().min(2000).max(2100),
  month: z.number().int().safe().min(1).max(12),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  tasks: z.array(CloseTaskSchema),
  blockers: z.array(z.string().min(1)),
  readyToClose: z.boolean(),
  unmatchedLineCount: z.number().int().safe().nonnegative(),
  currenciesWithExposure: z.array(z.string().regex(/^[A-Z]{3}$/)),
}).strict().superRefine((readiness, context) => {
  const keys = readiness.tasks.map((task) => task.key);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", path: ["tasks"], message: "Close task keys must be unique." });
  }
  const blockingKeys = readiness.tasks.filter((task) => task.blocking).map((task) => task.key);
  if (readiness.blockers.length !== blockingKeys.length || readiness.blockers.some((key, index) => key !== blockingKeys[index])) {
    context.addIssue({ code: "custom", path: ["blockers"], message: "Close blockers must match the blocking tasks." });
  }
  if (readiness.readyToClose !== (readiness.blockers.length === 0)) {
    context.addIssue({ code: "custom", path: ["readyToClose"], message: "Readiness must match the blocker list." });
  }
});

const CloseResponseSchema = z.object({
  ok: z.literal(true),
  data: CloseReadinessSchema,
}).strict();

const ErrorResponseSchema = z.object({ error: z.string().optional(), message: z.string().optional() });

export type AccountingCloseTask = z.infer<typeof CloseTaskSchema>;
export type AccountingCloseReadiness = z.infer<typeof CloseReadinessSchema>;

export class AccountingCloseApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "AccountingCloseApiError";
  }
}

function signalWithTimeout(signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
}

async function getJson(path: string, signal?: AbortSignal): Promise<{ response: Response; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: signalWithTimeout(signal),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new AccountingCloseApiError(0, timedOut
      ? "The Accounting service took too long to respond. Try again."
      : "Could not reach the Accounting service. Check your connection and try again.");
  }
  return { response, body: await response.json().catch(() => null) };
}

function errorMessage(status: number, body: unknown, context: string): string {
  const parsed = ErrorResponseSchema.safeParse(body);
  const message = parsed.success ? parsed.data.message ?? parsed.data.error : undefined;
  if (status === 401) return "Your session has ended. Sign in again to continue.";
  if (status === 403 || status === 422) return message ?? "You do not have permission to view period-close readiness.";
  if (status >= 500) return "The Accounting service is unavailable. Try again.";
  return message ?? `Could not load ${context}. Try again.`;
}

export async function fetchAccountingCloseEnabled(signal?: AbortSignal): Promise<boolean> {
  const { response, body } = await getJson("/api/modules", signal);
  if (!response.ok) {
    throw new AccountingCloseApiError(response.status, errorMessage(response.status, body, "Accounting module status"));
  }
  const parsed = SwitchboardSchema.safeParse(body);
  if (!parsed.success) {
    throw new AccountingCloseApiError(response.status, "The module switchboard returned data in an unexpected format.");
  }
  const catalogIds = new Set(parsed.data.catalog.map((module) => module.id));
  if (!catalogIds.has("accounting") || parsed.data.enabledModules.some((id) => !catalogIds.has(id))) {
    throw new AccountingCloseApiError(response.status, "The module switchboard returned an invalid Accounting configuration.");
  }
  return parsed.data.enabledModules.includes("accounting");
}

export async function fetchAccountingCloseReadiness(
  year: number,
  month: number,
  signal?: AbortSignal,
): Promise<AccountingCloseReadiness> {
  if (!Number.isSafeInteger(year) || year < 2000 || year > 2100 || !Number.isSafeInteger(month) || month < 1 || month > 12) {
    throw new AccountingCloseApiError(400, "Choose a valid close period.");
  }
  const query = new URLSearchParams({ year: String(year), month: String(month) });
  const { response, body } = await getJson(`/api/accounting/close?${query.toString()}`, signal);
  if (!response.ok) {
    throw new AccountingCloseApiError(response.status, errorMessage(response.status, body, "period-close readiness"));
  }
  const parsed = CloseResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new AccountingCloseApiError(response.status, "The Accounting service returned period-close readiness in an unexpected format.");
  }
  const expectedStart = new Date(Date.UTC(year, month - 1, 1)).toISOString();
  const expectedEnd = new Date(Date.UTC(year, month, 1) - 1).toISOString();
  if (parsed.data.data.year !== year || parsed.data.data.month !== month
    || new Date(parsed.data.data.start).toISOString() !== expectedStart
    || new Date(parsed.data.data.end).toISOString() !== expectedEnd) {
    throw new AccountingCloseApiError(response.status, "The Accounting service returned readiness for a different close period.");
  }
  return parsed.data.data;
}
