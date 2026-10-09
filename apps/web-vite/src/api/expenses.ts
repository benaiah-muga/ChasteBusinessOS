import { z } from "zod";

const uuid = z.string().uuid();
const ClaimSchema = z.object({
  id: uuid,
  claimantUserId: z.string().min(1),
  amountMinor: z.number().int().safe().nonnegative(),
  status: z.enum(["submitted", "approved", "rejected", "paid"]),
  memo: z.string(),
});

const PolicySchema = z.object({ category: z.string(), limitMinor: z.number().int().safe().nonnegative() });
const ListClaimsSchema = z.object({ claims: z.array(ClaimSchema) });
const ListPoliciesSchema = z.object({ policies: z.array(PolicySchema) });
const ListSchema = z.object({ claims: z.array(ClaimSchema), policies: z.array(PolicySchema) });
const ErrorSchema = z.object({ error: z.string() });
const PendingSchema = z.object({ pendingApproval: z.literal(true), reason: z.string().optional(), error: z.string().optional() });
const SubmitActionSchema = z.object({ action: z.literal("submit"), amountMinor: z.number().int().safe().positive(), memo: z.string().min(3).max(500), accountCode: z.string().optional() }).strict();
const DecideActionSchema = z.object({ action: z.literal("decide"), claimId: uuid, decision: z.enum(["approved", "rejected"]) }).strict();
const PayActionSchema = z.object({ action: z.literal("pay"), claimId: uuid, amountMinor: z.number().int().safe().positive() }).strict();
const SetPolicyActionSchema = z.object({ action: z.literal("setPolicy"), category: z.string().min(2).max(40), limitMinor: z.number().int().safe().nonnegative() }).strict();
const ExpenseActionSchema = z.discriminatedUnion("action", [SubmitActionSchema, DecideActionSchema, PayActionSchema, SetPolicyActionSchema]);
const AttemptSchema = z.object({ intentId: uuid, fingerprint: z.string().length(64), action: ExpenseActionSchema }).strict();
const ActionSchemas = {
  submit: z.object({ claimId: uuid, status: z.literal("submitted"), category: z.string(), overPolicyLimit: z.boolean(), policyLimitMinor: z.number().nullable() }).strict(),
  decide: z.object({ claimId: uuid, status: z.enum(["approved", "rejected"]) }).strict(),
  pay: z.object({ claimId: uuid, entryId: z.string().min(1), paidMinor: z.number().int().safe().positive() }).strict(),
  setPolicy: z.object({ set: z.literal(true), category: z.string(), limitMinor: z.number().int().safe().nonnegative() }).strict(),
} as const;

export type ExpenseClaim = z.infer<typeof ClaimSchema>;
export type ExpensePolicy = z.infer<typeof PolicySchema>;
export type ExpenseAction =
  | { action: "submit"; amountMinor: number; memo: string; accountCode?: string }
  | { action: "decide"; claimId: string; decision: "approved" | "rejected" }
  | { action: "pay"; claimId: string; amountMinor: number }
  | { action: "setPolicy"; category: string; limitMinor: number };
export type ExpenseRetryScope = { actorId: string | null; organizationId: string | null };
export type ExpenseActionOutcome = { kind: "completed"; data: unknown } | { kind: "pending"; reason: string };

export class ExpensesApiError extends Error {
  constructor(readonly status: number, message: string, readonly requestMayHaveReachedServer = false) {
    super(message);
    this.name = "ExpensesApiError";
  }
}

const EXPENSE_ATTEMPT_PREFIX = "chaste:expenses:go:attempt:v1:";
const legacyRetryIntentIds = new Map<string, string>();

function goExpensesUseGo(): boolean {
  return typeof __GO_HR_EXPENSES__ !== "undefined" && __GO_HR_EXPENSES__;
}

function requestSignal(signal?: AbortSignal, timeout = 15_000): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

async function request(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<{ response: Response; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
      cache: "no-store",
      signal: requestSignal(signal, init.method === "POST" ? 20_000 : 15_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new ExpensesApiError(0, timedOut
      ? "The expense action took too long. Check the claim status before trying again."
      : "Could not reach the expenses service. Check your connection and try again.", true);
  }
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new ExpensesApiError(response.status, "The expenses service returned an unreadable response.", true); }
  return { response, body };
}

function errorMessage(status: number, raw: unknown): string {
  const parsed = ErrorSchema.safeParse(raw);
  if (parsed.success) return parsed.data.error;
  if (status === 401) return "Sign in again to review expenses.";
  if (status === 403) return "Your role does not allow this expense action.";
  return "The expenses service could not complete that request.";
}

async function executeRead<T>(capabilityId: string, input: Record<string, never>, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  const { response, body } = await request("/api/capabilities/execute", {
    method: "POST",
    body: JSON.stringify({ capabilityId, input, intentId: crypto.randomUUID() }),
  }, signal);
  if (!response.ok) throw new ExpensesApiError(response.status, errorMessage(response.status, body));
  const parsed = z.object({ ok: z.literal(true), data: schema }).strict().safeParse(body);
  if (!parsed.success) throw new ExpensesApiError(response.status, "The expenses service returned data in an unexpected format.");
  return parsed.data.data;
}

export async function fetchExpenses(signal?: AbortSignal): Promise<{ claims: ExpenseClaim[]; policies: ExpensePolicy[] }> {
  if (goExpensesUseGo()) {
    const [claims, policies] = await Promise.all([
      executeRead("accounting.listExpenseClaims", {}, ListClaimsSchema, signal),
      executeRead("accounting.listExpensePolicies", {}, ListPoliciesSchema, signal),
    ]);
    return { claims: claims.claims, policies: policies.policies };
  }

  const { response, body } = await request("/api/expenses", { method: "GET" }, signal);
  if (!response.ok) throw new ExpensesApiError(response.status, errorMessage(response.status, body));
  const parsed = ListSchema.safeParse(body);
  if (!parsed.success) throw new ExpensesApiError(response.status, "The expenses service returned data in an unexpected format.");
  return parsed.data;
}

export async function readPendingExpenseAction(scope: ExpenseRetryScope): Promise<ExpenseAction | null> {
  const scoped = await expenseScope(scope);
  const storageKey = `${EXPENSE_ATTEMPT_PREFIX}${scoped.scopeHash}`;
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new ExpensesApiError(0, "Enable browser storage to check for an unresolved expense action."); }
  if (raw === null) return null;
  const attempt = parseAttempt(raw);
  return attempt.action;
}

export async function submitExpenseAction(
  action: ExpenseAction,
  signal?: AbortSignal,
  retryScope?: ExpenseRetryScope,
  useGoOverride?: boolean,
): Promise<ExpenseActionOutcome> {
  if (!ExpenseActionSchema.safeParse(action).success) {
    const message = action.action === "submit"
      ? "Expense explanation must contain between 3 and 500 characters."
      : action.action === "setPolicy"
        ? "Expense category must contain between 2 and 40 characters."
        : "The expense action is invalid.";
    throw new ExpensesApiError(0, message);
  }
  const useGo = useGoOverride ?? goExpensesUseGo();
  if (!useGo) {
    if (retryScope?.actorId && retryScope.organizationId) {
      const unresolved = await readPendingExpenseAction(retryScope);
      if (unresolved) throw new ExpensesApiError(0, "A Go expense action is unresolved. Restore the Go expense route and retry that exact action before using the legacy route.", true);
    }
    const retryKey = canonicalJSON(action);
    const intentId = legacyRetryIntentIds.get(retryKey) ?? crypto.randomUUID();
    try {
      const { response, body } = await request("/api/expenses", {
        method: "POST",
        body: JSON.stringify({ ...action, intentId }),
      }, signal);
      const outcome = parseLegacyActionOutcome(response, body, action.action);
      legacyRetryIntentIds.delete(retryKey);
      return outcome;
    } catch (error) {
      if (error instanceof ExpensesApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) legacyRetryIntentIds.delete(retryKey);
      else legacyRetryIntentIds.set(retryKey, intentId);
      throw error;
    }
  }

  const scope = await expenseScope(retryScope);
  const attempt = await expenseAttempt(action, scope);
  const { capabilityId, input } = capabilityRequest(action);
  try {
    const { response, body } = await request("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({ capabilityId, input, intentId: attempt.intentId }),
    }, signal);
    if (response.status === 202) {
      const pending = PendingSchema.safeParse(body);
      if (!pending.success) throw new ExpensesApiError(response.status, "The expenses service returned an unexpected approval response.", true);
      return { kind: "pending", reason: pending.data.reason ?? pending.data.error ?? "This action is waiting for approval." };
    }
    if (!response.ok) {
      const mayHaveReachedServer = response.status === 404 || response.status >= 500 || response.status === 408 || response.status === 429;
      const apiError = new ExpensesApiError(response.status, errorMessage(response.status, body), mayHaveReachedServer);
      if (!mayHaveReachedServer && response.status < 500) await clearExpenseAttempt(attempt.storageKey);
      throw apiError;
    }
    const schema = ActionSchemas[action.action];
    const parsed = z.object({ ok: z.literal(true), data: schema }).strict().safeParse(body);
    if (response.status !== 200 || !parsed.success) throw new ExpensesApiError(response.status, "The expenses service returned an unexpected action response.", true);
    await clearExpenseAttempt(attempt.storageKey);
    return { kind: "completed", data: parsed.data.data };
  } catch (error) {
    if (error instanceof ExpensesApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429 && !error.requestMayHaveReachedServer) {
      await clearExpenseAttempt(attempt.storageKey);
    }
    throw error;
  }
}

async function expenseScope(scope?: ExpenseRetryScope): Promise<{ actorId: string; organizationId: string; scopeHash: string }> {
  const actorId = scope?.actorId?.trim() ?? "";
  const organizationId = scope?.organizationId?.trim() ?? "";
  if (!uuid.safeParse(actorId).success || !uuid.safeParse(organizationId).success) {
    throw new ExpensesApiError(0, "Expenses are waiting for your account and organization details. Wait for your organization to finish loading, then try again.");
  }
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ actorId, organizationId })));
    return { actorId, organizationId, scopeHash: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("") };
  } catch {
    throw new ExpensesApiError(0, "Could not prepare an expense retry. Check browser security settings and try again.");
  }
}

async function expenseAttempt(action: ExpenseAction, scope: { scopeHash: string }): Promise<{ storageKey: string; intentId: string }> {
  const storageKey = `${EXPENSE_ATTEMPT_PREFIX}${scope.scopeHash}`;
  const fingerprint = await expenseFingerprint(action);
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new ExpensesApiError(0, "Enable browser storage before changing expenses so an uncertain result can be retried safely."); }
  if (raw !== null) {
    const stored = parseAttempt(raw);
    if (stored.fingerprint !== fingerprint) throw new ExpensesApiError(0, "A previous expense action is unresolved. Retry its exact details before starting another action.", true);
    return { storageKey, intentId: stored.intentId };
  }
  const attempt = { fingerprint, intentId: crypto.randomUUID(), action };
  const serialized = JSON.stringify(attempt);
  try {
    window.localStorage.setItem(storageKey, serialized);
    if (window.localStorage.getItem(storageKey) !== serialized) throw new Error("expense retry did not persist");
  } catch {
    throw new ExpensesApiError(0, "Enable browser storage before changing expenses so an uncertain result can be retried safely.");
  }
  return { storageKey, intentId: attempt.intentId };
}

async function expenseFingerprint(action: ExpenseAction): Promise<string> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJSON(action)));
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  } catch {
    throw new ExpensesApiError(0, "Could not prepare an expense retry. Check browser security settings and try again.");
  }
}

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJSON(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function parseAttempt(raw: string): z.infer<typeof AttemptSchema> {
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch { throw new ExpensesApiError(0, "An unresolved expense action marker is malformed. Contact an administrator before retrying.", true); }
  const parsed = AttemptSchema.safeParse(decoded);
  if (!parsed.success) throw new ExpensesApiError(0, "An unresolved expense action marker is malformed. Contact an administrator before retrying.", true);
  return parsed.data;
}

async function clearExpenseAttempt(storageKey: string): Promise<void> {
  try { window.localStorage.removeItem(storageKey); }
  catch { throw new ExpensesApiError(0, "The expense action completed, but its retry marker could not be cleared. Reload the page before another action.", true); }
}

function capabilityRequest(action: ExpenseAction): { capabilityId: string; input: Record<string, unknown> } {
  switch (action.action) {
    case "submit": {
      const { action: _action, ...input } = action;
      return { capabilityId: "accounting.submitExpenseClaim", input };
    }
    case "decide": {
      const { action: _action, ...input } = action;
      return { capabilityId: "accounting.decideExpenseClaim", input };
    }
    case "pay": {
      const { action: _action, ...input } = action;
      return { capabilityId: "accounting.payExpenseClaim", input };
    }
    case "setPolicy": {
      const { action: _action, ...input } = action;
      return { capabilityId: "accounting.setExpensePolicy", input };
    }
  }
}

function parseLegacyActionOutcome(response: Response, body: unknown, action: ExpenseAction["action"]): ExpenseActionOutcome {
  if (response.status === 202) {
    const pending = PendingSchema.safeParse(body);
    if (!pending.success) throw new ExpensesApiError(response.status, "The expenses service returned an unexpected approval response.");
    return { kind: "pending", reason: pending.data.reason ?? pending.data.error ?? "This action is waiting for approval." };
  }
  if (!response.ok) throw new ExpensesApiError(response.status, errorMessage(response.status, body));
  const parsed = z.object({ ok: z.literal(true), data: ActionSchemas[action] }).safeParse(body);
  if (response.status !== 200 || !parsed.success) throw new ExpensesApiError(response.status, "The expenses service returned an unexpected action response.");
  return { kind: "completed", data: parsed.data.data };
}
