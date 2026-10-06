import { z } from "zod";

const uuid = z.string().uuid();
const stage = z.enum(["lead", "qualified", "proposal", "negotiation", "won", "lost"]);
const contactMethod = z.enum(["email", "phone", "whatsapp", "other"]);

export const CrmDealSchema = z.object({
  id: uuid,
  title: z.string(),
  stage,
  valueMinor: z.number().int(),
  note: z.string().nullable().optional(),
  customerId: uuid.nullable().optional(),
  customerName: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string(),
}).passthrough();
export type CrmDeal = z.infer<typeof CrmDealSchema>;

export const CrmCustomerSchema = z.object({
  id: uuid,
  name: z.string(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  preferredContactMethod: contactMethod.optional(),
  doNotContact: z.boolean().optional(),
  ownerUserId: uuid.nullable().optional(),
  ownerName: z.string().nullable().optional(),
  ownerEmail: z.string().nullable().optional(),
  updatedByName: z.string().nullable().optional(),
  updatedByEmail: z.string().nullable().optional(),
  updatedAt: z.string().optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().nullable().optional(),
  nextStep: z.object({ kind: z.enum(["invoice", "quote", "task"]), summary: z.string(), refId: z.string(), amountMinor: z.number().optional() }).nullable().optional(),
  lastActivityAt: z.string().optional(),
  deactivatedAt: z.string().nullable().optional(),
  mergedRecords: z.array(z.object({ id: uuid, name: z.string(), mergedAt: z.string().nullable() })).optional(),
  purchaseCount: z.number().optional(),
  lifetimeSpendMinor: z.number().optional(),
}).passthrough();
export type CrmCustomer = z.infer<typeof CrmCustomerSchema>;

export const CrmTimelineEntrySchema = z.object({
  kind: z.string(),
  date: z.string(),
  refId: z.string(),
  summary: z.string(),
}).passthrough();
export type CrmTimelineEntry = z.infer<typeof CrmTimelineEntrySchema>;

export const CrmTaskSchema = z.object({
  id: uuid,
  title: z.string(),
  dueAt: z.string().nullable().optional(),
  doneAt: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  refType: z.string().nullable().optional(),
  refId: z.string().nullable().optional(),
  assigneeUserId: uuid.nullable().optional(),
  assigneeName: z.string().nullable().optional(),
  createdAt: z.string().optional(),
}).passthrough();
export type CrmTask = z.infer<typeof CrmTaskSchema>;

export interface CustomerFilter {
  status: "active" | "inactive" | "all";
  owner: "all" | "unassigned" | string;
  staleOnly: boolean;
  duplicateOnly: boolean;
  tag: string;
}
export const SavedCustomerViewSchema = z.object({
  id: uuid,
  name: z.string(),
  filters: z.object({
    status: z.enum(["active", "inactive", "all"]),
    owner: z.string(),
    staleOnly: z.boolean(),
    duplicateOnly: z.boolean(),
    tag: z.string(),
  }),
  isShared: z.boolean().default(false),
  isPinned: z.boolean().default(false),
}).passthrough();
export type SavedCustomerView = z.infer<typeof SavedCustomerViewSchema>;

const requestSignal = (signal?: AbortSignal, timeoutMs = 15_000): AbortSignal => {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
};

export class CrmApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly requestMayHaveReachedServer = false) {
    super(message);
    this.name = "CrmApiError";
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new CrmApiError(response.status, "The CRM service returned an unreadable response.", true);
  }
}

function messageFor(status: number, body: unknown): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") return body.error;
  if (status === 401) return "Your session has expired. Sign in again to continue.";
  if (status === 403) return "Your account does not have access to this CRM information.";
  if (status === 428) return "Finish setting up your workspace to use CRM.";
  return "The CRM service is unavailable. Try again.";
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
    if (error instanceof DOMException && error.name === "TimeoutError") throw new CrmApiError(0, "The CRM service took too long to respond. Check the record before trying again.", true);
    throw new CrmApiError(0, "Could not reach the CRM service. Check your connection and try again.", true);
  }
  const body = await readJson(response);
  return { response, body };
}

async function get<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  const { response, body } = await request(path, {}, signal);
  if (!response.ok) throw new CrmApiError(response.status, messageFor(response.status, body));
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new CrmApiError(response.status, "The CRM service returned data in an unexpected format.");
  return parsed.data;
}

export async function fetchCrmDeals(signal?: AbortSignal): Promise<CrmDeal[]> {
  const result = await get("/api/deals", z.object({ deals: z.array(CrmDealSchema) }), signal);
  return result.deals;
}

export async function fetchCrmCustomers(signal?: AbortSignal): Promise<CrmCustomer[]> {
  const result = await get("/api/customers", z.object({ customers: z.array(CrmCustomerSchema) }), signal);
  return result.customers;
}

export async function fetchCrmTimeline(customerId: string, signal?: AbortSignal): Promise<CrmTimelineEntry[]> {
  if (!uuid.safeParse(customerId).success) throw new CrmApiError(0, "Choose a valid customer to view history.");
  const query = new URLSearchParams({ timeline: customerId });
  const result = await get(`/api/crm?${query}`, z.object({ entries: z.array(CrmTimelineEntrySchema) }), signal);
  return result.entries;
}

export async function fetchCrmTasks(signal?: AbortSignal): Promise<CrmTask[]> {
  const result = await get("/api/crm?tasks=1", z.object({ tasks: z.array(CrmTaskSchema) }), signal);
  return result.tasks;
}

export async function fetchCrmViews(signal?: AbortSignal): Promise<SavedCustomerView[]> {
  const result = await get("/api/crm/views", z.object({ views: z.array(SavedCustomerViewSchema) }), signal);
  return result.views;
}

export type CrmActionOutcome<T = Record<string, unknown>> =
  | { kind: "completed"; data: T }
  | { kind: "pending"; reason: string };

const SuccessSchema = z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) });
const PendingSchema = z.object({ ok: z.literal(false).optional(), pendingApproval: z.literal(true), reason: z.string().optional(), error: z.string().optional() });
const ImportPendingSchema = z.object({ pendingApproval: z.literal(true), error: z.string() });

export async function submitCrmAction<T extends Record<string, unknown> = Record<string, unknown>>(
  path: "/api/deals" | "/api/customers" | "/api/crm" | "/api/crm/views",
  action: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CrmActionOutcome<T>> {
  const { response, body } = await request(path, { method: "POST", body: JSON.stringify({ ...action, intentId: crypto.randomUUID() }) }, signal);
  return parseCrmActionOutcome<T>(response, body);
}

export async function submitCrmDealStageMove(
  input: { dealId: string; stage: "lead" | "qualified" | "proposal" | "negotiation" | "won" | "lost"; lostReason?: string },
  signal?: AbortSignal,
  useGoOverride?: boolean,
  retryScope?: { actorId: string | null; organizationId: string | null },
): Promise<CrmActionOutcome<{ moved: boolean; stage: string }>> {
  const useGo = useGoOverride ?? (typeof __GO_CRM_DEAL_STAGE_MOVE__ !== "undefined" && __GO_CRM_DEAL_STAGE_MOVE__);
  const action = { action: "move", ...input };
  if (!useGo) return submitCrmAction("/api/deals", action, signal);
  if (!retryScope?.actorId?.trim() || !retryScope.organizationId?.trim()) {
    throw new CrmApiError(0, "CRM is waiting for your account and organization details. Wait for your organization to finish loading, then try again.");
  }

  const attempt = await crmDealStageAttempt(input, retryScope);
  try {
    let { response, body } = await request("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({ capabilityId: "crm.moveDealStage", input, intentId: attempt.intentId }),
    }, signal);
    if (response.status === 404) {
      ({ response, body } = await request("/api/deals", { method: "POST", body: JSON.stringify({ ...action, intentId: attempt.intentId }) }, signal));
    }
    const outcome = parseCrmActionOutcome<{ moved: boolean; stage: string }>(response, body);
    if (outcome.kind === "completed") await clearCrmDealStageAttempt(attempt.storageKey);
    return outcome;
  } catch (error) {
    if (error instanceof CrmApiError && error.status >= 400 && error.status < 500) {
      await clearCrmDealStageAttempt(attempt.storageKey);
    }
    throw error;
  }
}

const CRM_TASK_INTENT_PREFIX = "chaste.crm.task-intent.v1:";
const CRM_CUSTOMER_CREATE_INTENT_PREFIX = "chaste.crm.customer-create-intent.v1:";
const CRM_CUSTOMER_PROFILE_UPDATE_INTENT_PREFIX = "chaste.crm.customer-profile-update-intent.v1:";
const CRM_DEAL_CREATE_INTENT_PREFIX = "chaste.crm.deal-create-intent.v1:";
const CrmTaskAttemptSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  intentId: z.string().uuid(),
  action: z.record(z.string(), z.unknown()),
}).strict();
const CreateTaskOutputSchema = z.object({ taskId: uuid }).strict();
const CompleteTaskOutputSchema = z.object({ completed: z.literal(true) }).strict();
const UpdateTaskDetailsOutputSchema = z.object({
  taskId: uuid,
  previous: z.object({ dueAt: z.string().datetime().nullable(), assigneeUserId: uuid.nullable() }).strict(),
}).strict();

export type CrmTaskMutation =
  | { action: "createTask"; title: string; dueAt?: string; assigneeUserId?: string; refType?: string; refId?: string; note?: string }
  | { action: "completeTask"; taskId: string }
  | { action: "updateTaskDetails"; taskId: string; dueAt?: string | null; assigneeUserId?: string | null };
type CrmCustomerCreateMutation = { action: "createCustomer"; name: string; email?: string; phone?: string; preferredContactMethod: "email" | "phone" | "whatsapp" | "other"; doNotContact: boolean };
export type CrmCustomerProfileUpdateMutation = {
  action: "updateProfile";
  customerIds: string[];
  name?: string;
  ownerUserId?: string | null;
  addTags?: string[];
  removeTags?: string[];
  notes?: string | null;
  phone?: string | null;
  preferredContactMethod?: "email" | "phone" | "whatsapp" | "other";
  doNotContact?: boolean;
};
export type CrmCustomerCreateInput = Omit<CrmCustomerCreateMutation, "action">;
type CrmDealCreateMutation = { action: "createDeal"; title: string; valueMinor: number; customerId?: string };
export type CrmDealCreateInput = Omit<CrmDealCreateMutation, "action">;
type CrmRetryMutation = CrmTaskMutation | CrmCustomerCreateMutation | CrmDealCreateMutation | CrmCustomerProfileUpdateMutation;

const CrmTaskMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("createTask"), title: z.string().min(1).max(200), dueAt: z.string().datetime().optional(),
    assigneeUserId: uuid.optional(), refType: z.string().max(50).optional(), refId: uuid.optional(), note: z.string().max(2000).optional(),
  }).strict(),
  z.object({ action: z.literal("completeTask"), taskId: uuid }).strict(),
  z.object({
    action: z.literal("updateTaskDetails"), taskId: uuid,
    dueAt: z.string().datetime().nullable().optional(), assigneeUserId: uuid.nullable().optional(),
  }).strict().refine((action) => action.dueAt !== undefined || action.assigneeUserId !== undefined),
]);

type CrmTaskRetryScope = { actorId: string | null; organizationId: string | null };

export async function readPendingCrmTaskCreate(scope: CrmTaskRetryScope): Promise<Extract<CrmTaskMutation, { action: "createTask" }> | null> {
  const { scopeHash } = await crmTaskScope(scope);
  const storageKey = `${CRM_TASK_INTENT_PREFIX}${scopeHash}:create`;
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new CrmApiError(0, "Enable browser storage to restore an unresolved CRM task attempt."); }
  if (raw === null) return null;
  const parsed = parseCrmTaskAttempt(raw);
  const action = z.object({
    action: z.literal("createTask"), title: z.string().min(1).max(200), dueAt: z.string().optional(),
    assigneeUserId: uuid.optional(), refType: z.string().max(50).optional(), refId: uuid.optional(), note: z.string().max(2000).optional(),
  }).strict().safeParse(parsed.action);
  if (!action.success) throw new CrmApiError(0, "An unresolved CRM task draft could not be restored. Contact an administrator before creating another task.");
  if (await crmTaskFingerprint(action.data) !== parsed.fingerprint) throw new CrmApiError(0, "An unresolved CRM task draft could not be verified. Contact an administrator before creating another task.");
  return action.data;
}

export async function readPendingCrmTaskDetails(
  scope: CrmTaskRetryScope,
  taskId: string,
): Promise<Extract<CrmTaskMutation, { action: "updateTaskDetails" }> | null> {
  if (!uuid.safeParse(taskId).success) throw new CrmApiError(0, "Choose a valid follow-up task before restoring its details.");
  const { scopeHash } = await crmTaskScope(scope);
  const storageKey = `${CRM_TASK_INTENT_PREFIX}${scopeHash}:details:${taskId}`;
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new CrmApiError(0, "Enable browser storage to restore an unresolved follow-up update."); }
  if (raw === null) return null;
  const parsed = parseCrmTaskAttempt(raw);
  const action = CrmTaskMutationSchema.safeParse(parsed.action);
  if (!action.success || action.data.action !== "updateTaskDetails" || action.data.taskId !== taskId) {
    throw new CrmApiError(0, "An unresolved follow-up update could not be restored. Contact an administrator before retrying.");
  }
  if (await crmTaskFingerprint(action.data) !== parsed.fingerprint) {
    throw new CrmApiError(0, "An unresolved follow-up update could not be verified. Contact an administrator before retrying.");
  }
  return action.data;
}

export async function readPendingCrmTaskDetailsForScope(
  scope: CrmTaskRetryScope,
): Promise<Array<Extract<CrmTaskMutation, { action: "updateTaskDetails" }>>> {
  const { scopeHash } = await crmTaskScope(scope);
  const prefix = `${CRM_TASK_INTENT_PREFIX}${scopeHash}:details:`;
  const pending: Array<Extract<CrmTaskMutation, { action: "updateTaskDetails" }>> = [];
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const storageKey = window.localStorage.key(index);
      if (!storageKey?.startsWith(prefix)) continue;
      const taskId = storageKey.slice(prefix.length);
      if (!uuid.safeParse(taskId).success) throw new CrmApiError(0, "An unresolved follow-up update has an invalid task identity. Contact an administrator before continuing.");
      const raw = window.localStorage.getItem(storageKey);
      if (raw === null) throw new CrmApiError(0, "An unresolved follow-up update changed during recovery. Reload CRM before continuing.");
      const parsed = parseCrmTaskAttempt(raw);
      const action = CrmTaskMutationSchema.safeParse(parsed.action);
      if (!action.success || action.data.action !== "updateTaskDetails" || action.data.taskId !== taskId) {
        throw new CrmApiError(0, "An unresolved follow-up update could not be restored. Contact an administrator before continuing.");
      }
      if (await crmTaskFingerprint(action.data) !== parsed.fingerprint) {
        throw new CrmApiError(0, "An unresolved follow-up update could not be verified. Contact an administrator before continuing.");
      }
      pending.push(action.data);
    }
  } catch (error) {
    if (error instanceof CrmApiError) throw error;
    throw new CrmApiError(0, "Enable browser storage to recover unresolved follow-up updates.");
  }
  return pending;
}

export async function readPendingCrmCustomerCreate(scope: CrmTaskRetryScope): Promise<CrmCustomerCreateInput | null> {
  const { scopeHash } = await crmTaskScope(scope);
  const storageKey = `${CRM_CUSTOMER_CREATE_INTENT_PREFIX}${scopeHash}:create`;
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new CrmApiError(0, "Enable browser storage to restore an unresolved CRM customer draft."); }
  if (raw === null) return null;
  const parsed = parseCrmTaskAttempt(raw);
  const action = CrmCustomerCreateMutationSchema.safeParse(parsed.action);
  if (!action.success) throw new CrmApiError(0, "An unresolved CRM customer draft could not be restored. Contact an administrator before creating another customer.");
  if (await crmTaskFingerprint(action.data) !== parsed.fingerprint) throw new CrmApiError(0, "An unresolved CRM customer draft could not be verified. Contact an administrator before creating another customer.");
  return {
    name: action.data.name,
    ...(action.data.email ? { email: action.data.email } : {}),
    ...(action.data.phone ? { phone: action.data.phone } : {}),
    preferredContactMethod: action.data.preferredContactMethod,
    doNotContact: action.data.doNotContact,
  };
}

export async function submitCrmTaskMutation(
  action: CrmTaskMutation,
  signal?: AbortSignal,
  useGoOverride?: boolean,
  retryScope?: CrmTaskRetryScope,
): Promise<CrmActionOutcome<{ taskId: string } | { completed: true } | { taskId: string; previous: { dueAt: string | null; assigneeUserId: string | null } }>> {
  const useGo = useGoOverride ?? (typeof __GO_CRM_TASK_WRITES__ !== "undefined" && __GO_CRM_TASK_WRITES__);
  if (!useGo) return submitCrmAction("/api/crm", action, signal);
  if (!CrmTaskMutationSchema.safeParse(action).success) throw new CrmApiError(0, "Review the task details and correct invalid values before submitting.");
  const scope = await crmTaskScope(retryScope);
  const target = action.action === "createTask" ? "create" : action.action === "completeTask" ? `complete:${action.taskId}` : `details:${action.taskId}`;
  const attempt = await crmTaskAttempt(action, scope, target);
  const capabilityId = action.action === "createTask" ? "crm.createTask" : action.action === "completeTask" ? "crm.completeTask" : "crm.updateTaskDetails";
  const outputSchema = action.action === "createTask" ? CreateTaskOutputSchema : action.action === "completeTask" ? CompleteTaskOutputSchema : UpdateTaskDetailsOutputSchema;
  try {
    const { response, body } = await request("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({ capabilityId, input: Object.fromEntries(Object.entries(action).filter(([key]) => key !== "action")), intentId: attempt.intentId }),
    }, signal);
    if (response.status === 404) {
      throw new CrmApiError(404, "The Go CRM task route is unavailable. Ask an administrator to check the Go task route configuration.", true);
    }
    const outcome = parseCrmActionOutcome<Record<string, unknown>>(response, body);
    if (outcome.kind === "pending") return outcome;
    const parsed = outputSchema.safeParse(outcome.data);
    if (!parsed.success) throw new CrmApiError(response.status, "The CRM service returned an unexpected task result.", true);
    if (action.action === "updateTaskDetails" && (!("taskId" in parsed.data) || parsed.data.taskId !== action.taskId)) {
      throw new CrmApiError(response.status, "The CRM service returned an unexpected task result.", true);
    }
    await clearCrmTaskAttempt(attempt.storageKey);
    return { kind: "completed", data: parsed.data };
  } catch (error) {
    if (error instanceof CrmApiError && error.status >= 400 && error.status < 500 && error.status !== 404 && error.status !== 408 && error.status !== 429) {
      await clearCrmTaskAttempt(attempt.storageKey);
    }
    throw error;
  }
}

async function crmTaskScope(scope?: CrmTaskRetryScope): Promise<{ actorId: string; organizationId: string; scopeHash: string }> {
  const actorId = scope?.actorId?.trim();
  const organizationId = scope?.organizationId?.trim();
  if (!actorId || !organizationId || !uuid.safeParse(actorId).success || !uuid.safeParse(organizationId).success) {
    throw new CrmApiError(0, "CRM is waiting for your account and organization details. Wait for your organization to finish loading, then try again.");
  }
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ actorId, organizationId })));
    return { actorId, organizationId, scopeHash: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("") };
  } catch {
    throw new CrmApiError(0, "Could not prepare a durable CRM task retry. Check browser storage and try again.");
  }
}

const CrmCustomerCreateMutationSchema = z.object({
  action: z.literal("createCustomer"),
  name: z.string().min(1).max(120),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  preferredContactMethod: z.enum(["email", "phone", "whatsapp", "other"]),
  doNotContact: z.boolean(),
}).strict();
const CrmCustomerCreateOutputSchema = z.object({ customerId: uuid, duplicateWarning: z.string().nullable() }).strict();
const CrmCustomerProfileUpdateMutationSchema = z.object({
  action: z.literal("updateProfile"),
  customerIds: z.array(uuid).min(1).max(100),
  name: z.string().min(1).max(120).optional(),
  ownerUserId: uuid.nullable().optional(),
  addTags: z.array(z.string().min(1).max(40)).max(20).optional(),
  removeTags: z.array(z.string().min(1).max(40)).max(20).optional(),
  notes: z.string().max(4000).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  preferredContactMethod: z.enum(["email", "phone", "whatsapp", "other"]).optional(),
  doNotContact: z.boolean().optional(),
}).strict().refine((input) => input.name === undefined || input.customerIds.length === 1, "A customer name can only be changed on one record at a time")
  .refine((input) => Object.keys(input).some((key) => key !== "action" && key !== "customerIds"), "Include at least one profile change");
const CrmCustomerProfileSnapshotSchema = z.object({
  customerId: uuid,
  name: z.string().min(1).max(120),
  ownerUserId: uuid.nullable(),
  tags: z.array(z.string()),
  notes: z.string().nullable(),
  phone: z.string().nullable(),
  preferredContactMethod: z.enum(["email", "phone", "whatsapp", "other"]),
  doNotContact: z.boolean(),
}).strict();
const CrmCustomerProfileUpdateOutputSchema = z.object({
  updatedCount: z.number().int().positive().max(100),
  previous: z.array(CrmCustomerProfileSnapshotSchema).min(1).max(100),
}).strict();
const CrmDealCreateMutationSchema = z.object({
  action: z.literal("createDeal"),
  title: z.string().min(1).max(120),
  valueMinor: z.number().int().nonnegative().refine(Number.isSafeInteger),
  customerId: uuid.optional(),
}).strict();
const CrmDealCreateOutputSchema = z.object({ dealId: uuid }).strict();

export async function readPendingCrmDealCreate(scope: CrmTaskRetryScope): Promise<CrmDealCreateInput | null> {
  const { scopeHash } = await crmTaskScope(scope);
  const storageKey = `${CRM_DEAL_CREATE_INTENT_PREFIX}${scopeHash}:create`;
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new CrmApiError(0, "Enable browser storage to restore an unresolved CRM deal draft."); }
  if (raw === null) return null;
  const parsed = parseCrmTaskAttempt(raw);
  const action = CrmDealCreateMutationSchema.safeParse(parsed.action);
  if (!action.success) throw new CrmApiError(0, "An unresolved CRM deal draft could not be restored. Contact an administrator before creating another deal.");
  if (await crmTaskFingerprint(action.data) !== parsed.fingerprint) throw new CrmApiError(0, "An unresolved CRM deal draft could not be verified. Contact an administrator before creating another deal.");
  return {
    title: action.data.title,
    valueMinor: action.data.valueMinor,
    ...(action.data.customerId ? { customerId: action.data.customerId } : {}),
  };
}

export async function submitCrmDealCreate(
  input: CrmDealCreateInput,
  signal?: AbortSignal,
  useGoOverride?: boolean,
  retryScope?: CrmTaskRetryScope,
): Promise<CrmActionOutcome<{ dealId: string }>> {
  const useGo = useGoOverride ?? (typeof __GO_CRM_DEAL_CREATE__ !== "undefined" && __GO_CRM_DEAL_CREATE__);
  const action = { action: "createDeal" as const, ...input };
  const legacyAction = { action: "create", ...input };
  const scope = await crmTaskScope(retryScope);
  if (!useGo) {
    const unresolved = await readPendingCrmDealCreate(scope);
    if (unresolved) {
      throw new CrmApiError(0, "A Go deal creation is unresolved. Restore the Go deal route and retry its exact details before creating another deal.", true);
    }
    return submitCrmAction("/api/deals", legacyAction, signal);
  }
  if (!CrmDealCreateMutationSchema.safeParse(action).success) throw new CrmApiError(0, "Review the deal details and correct invalid values before submitting.");
  const attempt = await crmTaskAttempt(action, scope, "create", CRM_DEAL_CREATE_INTENT_PREFIX);
  try {
    const { response, body } = await request("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({ capabilityId: "crm.createDeal", input, intentId: attempt.intentId }),
    }, signal);
    if (response.status === 404) throw new CrmApiError(response.status, messageFor(response.status, body), true);
    const outcome = parseCrmActionOutcome<Record<string, unknown>>(response, body);
    if (outcome.kind === "pending") return outcome;
    const parsed = CrmDealCreateOutputSchema.safeParse(outcome.data);
    if (!parsed.success) throw new CrmApiError(response.status, "The CRM service returned an unexpected deal result.", true);
    await clearCrmDealCreateAttempt(attempt.storageKey);
    return { kind: "completed", data: parsed.data };
  } catch (error) {
    if (error instanceof CrmApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429 && !error.requestMayHaveReachedServer) {
      await clearCrmDealCreateAttempt(attempt.storageKey);
    }
    throw error;
  }
}

async function clearCrmDealCreateAttempt(storageKey: string): Promise<void> {
  try { window.localStorage.removeItem(storageKey); }
  catch { throw new CrmApiError(0, "The deal was saved, but its retry marker could not be cleared. Reload CRM before submitting another deal.", true); }
}

export async function submitCrmCustomerCreate(
  input: CrmCustomerCreateInput,
  signal?: AbortSignal,
  useGoOverride?: boolean,
  retryScope?: CrmTaskRetryScope,
): Promise<CrmActionOutcome<{ customerId: string; duplicateWarning?: string | null }>> {
  const useGo = useGoOverride ?? (typeof __GO_CRM_CUSTOMER_CREATE__ !== "undefined" && __GO_CRM_CUSTOMER_CREATE__);
  const action = { action: "createCustomer" as const, ...input };
  const scope = await crmTaskScope(retryScope);
  if (!useGo) {
    const unresolved = await readPendingCrmCustomerCreate(scope);
    if (unresolved) {
      throw new CrmApiError(0, "A Go customer creation is unresolved. Restore the Go customer route and retry its exact details before creating another customer.", true);
    }
    return submitCrmAction("/api/customers", { action: "create", ...input }, signal);
  }
  if (!CrmCustomerCreateMutationSchema.safeParse(action).success) throw new CrmApiError(0, "Review the customer details and correct invalid values before submitting.");
  const attempt = await crmTaskAttempt(action, scope, "create", CRM_CUSTOMER_CREATE_INTENT_PREFIX);
  try {
    const { response, body } = await request("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({ capabilityId: "crm.createCustomer", input, intentId: attempt.intentId }),
    }, signal);
    if (response.status === 404) throw new CrmApiError(response.status, messageFor(response.status, body), true);
    const outcome = parseCrmActionOutcome<Record<string, unknown>>(response, body);
    if (outcome.kind === "pending") return outcome;
    const parsed = CrmCustomerCreateOutputSchema.safeParse(outcome.data);
    if (!parsed.success) throw new CrmApiError(response.status, "The CRM service returned an unexpected customer result.", true);
    await clearCrmTaskAttempt(attempt.storageKey);
    return { kind: "completed", data: parsed.data };
  } catch (error) {
    if (error instanceof CrmApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429 && !error.requestMayHaveReachedServer) {
      await clearCrmTaskAttempt(attempt.storageKey);
    }
    throw error;
  }
}

export async function readPendingCrmCustomerProfileUpdate(scope: CrmTaskRetryScope): Promise<CrmCustomerProfileUpdateMutation | null> {
  const { scopeHash } = await crmTaskScope(scope);
  const storageKey = `${CRM_CUSTOMER_PROFILE_UPDATE_INTENT_PREFIX}${scopeHash}:profiles`;
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new CrmApiError(0, "Enable browser storage to restore an unresolved CRM profile update."); }
  if (raw === null) return null;
  const attempt = parseCrmTaskAttempt(raw);
  const action = CrmCustomerProfileUpdateMutationSchema.safeParse(attempt.action);
  if (!action.success || await crmTaskFingerprint(action.data) !== attempt.fingerprint) {
    throw new CrmApiError(0, "An unresolved CRM profile update could not be verified. Contact an administrator before retrying.");
  }
  return action.data;
}

export async function submitCrmCustomerProfileUpdate(
  input: CrmCustomerProfileUpdateMutation,
  signal?: AbortSignal,
  useGoOverride?: boolean,
  retryScope?: CrmTaskRetryScope,
): Promise<CrmActionOutcome<z.infer<typeof CrmCustomerProfileUpdateOutputSchema>>> {
  const useGo = useGoOverride ?? (typeof __GO_CRM_CUSTOMER_PROFILE_UPDATE__ !== "undefined" && __GO_CRM_CUSTOMER_PROFILE_UPDATE__);
  if (!useGo) return submitCrmAction("/api/customers", input, signal);
  if (!CrmCustomerProfileUpdateMutationSchema.safeParse(input).success) {
    throw new CrmApiError(0, "Review the customer profile changes and correct invalid values before submitting.");
  }
  const scope = await crmTaskScope(retryScope);
  const attempt = await crmTaskAttempt(input, scope, "profiles", CRM_CUSTOMER_PROFILE_UPDATE_INTENT_PREFIX);
  try {
    const { response, body } = await request("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({ capabilityId: "crm.updateCustomerProfiles", input: Object.fromEntries(Object.entries(input).filter(([key]) => key !== "action")), intentId: attempt.intentId }),
    }, signal);
    if (response.status === 404) throw new CrmApiError(response.status, messageFor(response.status, body), true);
    const outcome = parseCrmActionOutcome<Record<string, unknown>>(response, body);
    if (outcome.kind === "pending") return outcome;
    const parsed = CrmCustomerProfileUpdateOutputSchema.safeParse(outcome.data);
    if (!parsed.success || parsed.data.updatedCount !== input.customerIds.length || parsed.data.previous.length !== input.customerIds.length) {
      throw new CrmApiError(response.status, "The CRM service returned an unexpected profile update result.", true);
    }
    await clearCrmTaskAttempt(attempt.storageKey);
    return { kind: "completed", data: parsed.data };
  } catch (error) {
    if (error instanceof CrmApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429 && !error.requestMayHaveReachedServer) {
      await clearCrmTaskAttempt(attempt.storageKey);
    }
    throw error;
  }
}

async function crmTaskAttempt(action: CrmRetryMutation, scope: { scopeHash: string }, target: string, prefix = CRM_TASK_INTENT_PREFIX): Promise<{ storageKey: string; intentId: string }> {
  const storageKey = `${prefix}${scope.scopeHash}:${target}`;
  const fingerprint = await crmTaskFingerprint(action);
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new CrmApiError(0, "Enable browser storage before changing CRM data so an uncertain result can be retried safely."); }
  if (raw !== null) {
    const stored = parseCrmTaskAttempt(raw);
    if (stored.fingerprint !== fingerprint) throw new CrmApiError(0, "A previous CRM result is unresolved. Retry its exact action details before starting another action.");
    return { storageKey, intentId: stored.intentId };
  }
  const attempt = { fingerprint, intentId: crypto.randomUUID(), action };
  const serialized = JSON.stringify(attempt);
  try {
    window.localStorage.setItem(storageKey, serialized);
    if (window.localStorage.getItem(storageKey) !== serialized) throw new Error("CRM task retry did not persist");
  } catch {
    throw new CrmApiError(0, "Enable browser storage before changing CRM data so an uncertain result can be retried safely.");
  }
  return { storageKey, intentId: attempt.intentId };
}

async function crmTaskFingerprint(action: CrmRetryMutation): Promise<string> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalCrmTaskJSON(action)));
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  } catch {
    throw new CrmApiError(0, "Could not prepare a durable CRM task retry. Check browser security settings and try again.");
  }
}

function canonicalCrmTaskJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalCrmTaskJSON).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalCrmTaskJSON(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function parseCrmTaskAttempt(raw: string): z.infer<typeof CrmTaskAttemptSchema> {
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch { throw new CrmApiError(0, "An unresolved CRM task retry marker is malformed. Contact an administrator before retrying."); }
  const parsed = CrmTaskAttemptSchema.safeParse(decoded);
  if (!parsed.success) throw new CrmApiError(0, "An unresolved CRM task retry marker is malformed. Contact an administrator before retrying.");
  return { ...parsed.data, action: parsed.data.action };
}

async function clearCrmTaskAttempt(storageKey: string): Promise<void> {
  try { window.localStorage.removeItem(storageKey); }
  catch { throw new CrmApiError(0, "The task was saved, but its retry marker could not be cleared. Reload CRM before submitting another task.", true); }
}

const crmDealStageIntents = new Map<string, string>();

async function crmDealStageAttempt(input: { dealId: string; stage: string; lostReason?: string }, scope?: { actorId: string | null; organizationId: string | null }): Promise<{ storageKey: string; intentId: string }> {
  const canonical = JSON.stringify({
    actorId: scope?.actorId ?? null,
    organizationId: scope?.organizationId ?? null,
    dealId: input.dealId,
    stage: input.stage,
    lostReason: input.lostReason?.trim() || null,
  });
  const canPersist = Boolean(scope?.actorId && scope.organizationId);
  let fingerprint: string | null = null;
  if (canPersist) {
    try {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
      fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    } catch {
      // Use an in-memory attempt if WebCrypto is unavailable.
    }
  }
  const storageKey = fingerprint ? `chaste.crm.deal-stage.intent.v1:${fingerprint}` : `memory:${canonical}`;
  let intentId: string | null = null;
  if (fingerprint) {
    try {
      intentId = sessionStorage.getItem(storageKey);
    } catch {
      // The in-memory copy remains available for this page.
    }
  }
  intentId ??= crmDealStageIntents.get(storageKey) ?? crypto.randomUUID();
  crmDealStageIntents.set(storageKey, intentId);
  if (fingerprint) {
    try {
      sessionStorage.setItem(storageKey, intentId);
    } catch {
      // The in-memory copy still keeps retries on the same attempt.
    }
  }
  return { storageKey, intentId };
}

async function clearCrmDealStageAttempt(storageKey: string): Promise<void> {
  crmDealStageIntents.delete(storageKey);
  if (!storageKey.startsWith("chaste.crm.deal-stage.intent.v1:")) return;
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    // The terminal result is still cleared in memory.
  }
}

function parseCrmActionOutcome<T extends Record<string, unknown>>(
  response: Response,
  body: unknown,
): CrmActionOutcome<T> {
  if (response.status === 202) {
    const parsed = PendingSchema.safeParse(body);
    if (!parsed.success) throw new CrmApiError(202, "The CRM service returned an unexpected approval response.", true);
    return { kind: "pending", reason: parsed.data.reason ?? parsed.data.error ?? "This action is waiting for approval." };
  }
  if (!response.ok) throw new CrmApiError(response.status, messageFor(response.status, body));
  const parsed = SuccessSchema.safeParse(body);
  if (!parsed.success) throw new CrmApiError(response.status, "The CRM service returned an unexpected action response.", true);
  return { kind: "completed", data: parsed.data.data as T };
}

const ImportResponseSchema = z.object({
  inserted: z.number().int().nonnegative(),
  skippedDuplicates: z.number().int().nonnegative(),
  createdIds: z.array(uuid),
  errors: z.array(z.object({ row: z.number().int(), message: z.string() })).optional(),
});
export type CrmImportResult = z.infer<typeof ImportResponseSchema>;

export async function importCrmCustomers(rows: Array<{ rowNumber: number; name: string; email?: string; phone?: string; allowDuplicate: boolean }>, signal?: AbortSignal): Promise<CrmActionOutcome<CrmImportResult>> {
  const { response, body } = await request("/api/import", { method: "POST", body: JSON.stringify({ entity: "customers", rows }) }, signal);
  if (response.status === 202) {
    const parsed = ImportPendingSchema.safeParse(body);
    if (!parsed.success) throw new CrmApiError(202, "The import service returned an unexpected approval response.");
    return { kind: "pending", reason: parsed.data.error };
  }
  if (!response.ok) throw new CrmApiError(response.status, messageFor(response.status, body));
  const parsed = ImportResponseSchema.safeParse(body);
  if (!parsed.success) throw new CrmApiError(response.status, "The import service returned an unexpected result.");
  return { kind: "completed", data: parsed.data };
}

export async function undoCrmImport(importIds: string[], signal?: AbortSignal): Promise<CrmActionOutcome<{ undone: number; remaining: number }>> {
  const { response, body } = await request("/api/import", { method: "POST", body: JSON.stringify({ entity: "customers", action: "undo", importIds }) }, signal);
  if (response.status === 202) {
    const parsed = ImportPendingSchema.safeParse(body);
    if (!parsed.success) throw new CrmApiError(202, "The import service returned an unexpected undo approval response.");
    return { kind: "pending", reason: parsed.data.error };
  }
  if (!response.ok) throw new CrmApiError(response.status, messageFor(response.status, body));
  const parsed = z.object({ undone: z.number().int().nonnegative(), remaining: z.number().int().nonnegative() }).safeParse(body);
  if (!parsed.success) throw new CrmApiError(response.status, "The import service returned an unexpected undo result.");
  return { kind: "completed", data: parsed.data };
}

export async function fetchCrmTeamMembers(signal?: AbortSignal): Promise<Array<{ userId: string; name: string | null; email: string }>> {
  const member = z.object({ userId: uuid, name: z.string().nullable(), email: z.string() }).passthrough();
  const result = await get("/api/team", z.object({ members: z.array(member) }), signal);
  return result.members;
}

export const CrmFollowUpDraftSchema = z.object({
  draft: z.string().min(1),
  sources: z.array(z.object({
    kind: z.enum(["invoice", "quote", "task"]),
    date: z.string(),
    refId: z.string(),
    summary: z.string(),
  })),
});
export type CrmFollowUpDraft = z.infer<typeof CrmFollowUpDraftSchema>;

export async function fetchCrmFollowUpDraft(customerId: string, signal?: AbortSignal): Promise<CrmFollowUpDraft> {
  if (!uuid.safeParse(customerId).success) throw new CrmApiError(0, "Choose a valid customer before drafting a follow-up.");
  const { response, body } = await request("/api/crm", { method: "POST", body: JSON.stringify({ action: "draftFollowUp", customerId }) }, signal);
  if (!response.ok) throw new CrmApiError(response.status, messageFor(response.status, body));
  const parsed = CrmFollowUpDraftSchema.safeParse(body);
  if (!parsed.success) throw new CrmApiError(response.status, "The CRM service returned an unexpected follow-up draft.");
  return parsed.data;
}
