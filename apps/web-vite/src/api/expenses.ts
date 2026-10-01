import { z } from "zod";

const ClaimSchema = z.object({
  id: z.string().uuid(),
  claimantUserId: z.string().min(1),
  amountMinor: z.number().int().safe().nonnegative(),
  status: z.enum(["submitted", "approved", "rejected", "paid"]),
  memo: z.string(),
});

const PolicySchema = z.object({ category: z.string(), limitMinor: z.number().int().safe().nonnegative() });
const ListSchema = z.object({ claims: z.array(ClaimSchema), policies: z.array(PolicySchema) });
const ErrorSchema = z.object({ error: z.string() });
const PendingSchema = z.object({ error: z.string(), pendingApproval: z.literal(true) });
const ActionSchemas = {
  submit: z.object({ claimId: z.string(), status: z.literal("submitted"), category: z.string(), overPolicyLimit: z.boolean(), policyLimitMinor: z.number().nullable() }),
  decide: z.object({ claimId: z.string(), status: z.enum(["approved", "rejected"]) }),
  pay: z.object({ claimId: z.string(), entryId: z.string(), paidMinor: z.number().int().safe().positive() }),
  setPolicy: z.object({ set: z.literal(true), category: z.string(), limitMinor: z.number().int().safe().nonnegative() }),
} as const;

export type ExpenseClaim = z.infer<typeof ClaimSchema>;
export type ExpensePolicy = z.infer<typeof PolicySchema>;
export type ExpenseAction =
  | { action: "submit"; amountMinor: number; memo: string; accountCode?: string }
  | { action: "decide"; claimId: string; decision: "approved" | "rejected" }
  | { action: "pay"; claimId: string; amountMinor: number }
  | { action: "setPolicy"; category: string; limitMinor: number };

export class ExpensesApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ExpensesApiError";
  }
}

const retryIntentIds = new Map<string, string>();

function rememberRetryIntent(key: string, intentId: string): void {
  retryIntentIds.set(key, intentId);
  while (retryIntentIds.size > 100) {
    const oldest = retryIntentIds.keys().next().value;
    if (oldest === undefined) break;
    retryIntentIds.delete(oldest);
  }
}

function requestSignal(signal?: AbortSignal, timeout = 15_000): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function errorMessage(status: number, raw: unknown): string {
  const parsed = ErrorSchema.safeParse(raw);
  if (parsed.success) return parsed.data.error;
  if (status === 401) return "Sign in again to review expenses.";
  if (status === 403) return "Your role does not allow this expense action.";
  return "The expenses service could not complete that request.";
}

export async function fetchExpenses(signal?: AbortSignal): Promise<{ claims: ExpenseClaim[]; policies: ExpensePolicy[] }> {
  let response: Response;
  try {
    response = await fetch("/api/expenses", {
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new ExpensesApiError(0, timedOut
      ? "Loading expenses took too long. Try again."
      : "Could not reach the expenses service. Check your connection and try again.");
  }
  const body = await readJson(response);
  if (!response.ok) throw new ExpensesApiError(response.status, errorMessage(response.status, body));
  const parsed = ListSchema.safeParse(body);
  if (!parsed.success) throw new ExpensesApiError(response.status, "The expenses service returned data in an unexpected format.");
  return parsed.data;
}

export async function submitExpenseAction(action: ExpenseAction, signal?: AbortSignal): Promise<{ kind: "completed"; data: unknown } | { kind: "pending"; reason: string }> {
  const retryKey = JSON.stringify(action);
  const intentId = retryIntentIds.get(retryKey) ?? crypto.randomUUID();
  let response: Response;
  try {
    response = await fetch("/api/expenses", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ ...action, intentId }),
      signal: requestSignal(signal, 20_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    rememberRetryIntent(retryKey, intentId);
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new ExpensesApiError(0, timedOut
      ? "The expense action took too long. Check the claim status before trying again."
      : "Could not reach the expenses service. Check the claim status before trying again.");
  }

  const body = await readJson(response);
  rememberRetryIntent(retryKey, intentId);
  if (response.status === 202) {
    const pending = PendingSchema.safeParse(body);
    if (!pending.success) throw new ExpensesApiError(response.status, "The expenses service returned an unexpected approval response.");
    retryIntentIds.delete(retryKey);
    return { kind: "pending", reason: pending.data.error };
  }
  if (!response.ok) {
    if (response.status < 500) retryIntentIds.delete(retryKey);
    throw new ExpensesApiError(response.status, errorMessage(response.status, body));
  }

  const actionSchema = ActionSchemas[action.action];
  const parsed = z.object({ ok: z.literal(true), data: actionSchema }).safeParse(body);
  if (response.status !== 200 || !parsed.success) {
    throw new ExpensesApiError(response.status, "The expenses service returned an unexpected action response.");
  }
  retryIntentIds.delete(retryKey);
  return { kind: "completed", data: parsed.data.data };
}
