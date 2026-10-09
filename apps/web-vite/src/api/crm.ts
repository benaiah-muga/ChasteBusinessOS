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
  const path = crmReadsUseGo() ? "/api/crm?deals=1" : "/api/deals";
  const result = await get(path, z.object({ deals: z.array(CrmDealSchema) }), signal);
  return result.deals;
}

export async function fetchCrmCustomers(signal?: AbortSignal): Promise<CrmCustomer[]> {
  const path = crmReadsUseGo() ? "/api/crm?customers=1" : "/api/customers";
  const result = await get(path, z.object({ customers: z.array(CrmCustomerSchema) }), signal);
  return result.customers;
}

export async function fetchCrmTimeline(customerId: string, signal?: AbortSignal): Promise<CrmTimelineEntry[]> {
  if (!uuid.safeParse(customerId).success) throw new CrmApiError(0, "Choose a valid customer to view history.");
  const query = new URLSearchParams({ timeline: customerId });
  const result = await get(`/api/crm?${query}`, z.object({ entries: z.array(CrmTimelineEntrySchema) }), signal);
  return result.entries;
}

export async function fetchCrmTasks(signal?: AbortSignal, options: { openOnly?: boolean } = {}): Promise<CrmTask[]> {
  const query = new URLSearchParams({ tasks: "1" });
  if (options.openOnly) query.set("open", "1");
  const result = await get(`/api/crm?${query}`, z.object({ tasks: z.array(CrmTaskSchema) }), signal);
  return result.tasks;
}

export async function fetchCrmViews(signal?: AbortSignal): Promise<SavedCustomerView[]> {
  const path = crmReadsUseGo() ? "/api/crm?views=1" : "/api/crm/views";
  const result = await get(path, z.object({ views: z.array(SavedCustomerViewSchema) }), signal);
  return result.views;
}

function crmReadsUseGo(): boolean {
  return typeof __GO_CRM_READS__ === "undefined" || __GO_CRM_READS__;
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
    if (error instanceof CrmApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
      await clearCrmDealStageAttempt(attempt.storageKey);
    }
    throw error;
  }
}

const CRM_TASK_INTENT_PREFIX = "chaste.crm.task-intent.v1:";
const CRM_CUSTOMER_CREATE_INTENT_PREFIX = "chaste.crm.customer-create-intent.v1:";
const CRM_CUSTOMER_DEACTIVATE_INTENT_PREFIX = "chaste.crm.customer-deactivate-intent.v1:";
const CRM_CUSTOMER_MERGE_INTENT_PREFIX = "chaste.crm.customer-merge-intent.v1:";
const CRM_CUSTOMER_MERGE_UNDO_INTENT_PREFIX = "chaste.crm.customer-merge-undo-intent.v1:";
const CRM_CUSTOMER_MERGE_UNDO_STATE_PREFIX = "chaste.crm.customer-merge-undo-state.v1:";
const CRM_CUSTOMER_IMPORT_INTENT_PREFIX = "chaste.crm.customer-import-intent.v1:";
const CRM_CUSTOMER_IMPORT_UNDO_INTENT_PREFIX = "chaste.crm.customer-import-undo-intent.v1:";
const CRM_CUSTOMER_IMPORT_UNDO_STATE_PREFIX = "chaste.crm.customer-import-undo-state.v1:";
const CRM_CUSTOMER_PROFILE_UPDATE_INTENT_PREFIX = "chaste.crm.customer-profile-update-intent.v1:";
const CRM_DEAL_CREATE_INTENT_PREFIX = "chaste.crm.deal-create-intent.v1:";
const CRM_SAVED_VIEW_WRITE_INTENT_PREFIX = "chaste.crm.saved-view-write-intent.v1:";
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
export type CrmSavedViewWriteMutation = {
  action: "saveCustomerView";
  id?: string;
  name: string;
  filters: CustomerFilter;
  isShared: boolean;
  isPinned: boolean;
};
export type CrmCustomerCreateInput = Omit<CrmCustomerCreateMutation, "action">;
type CrmDealCreateMutation = { action: "createDeal"; title: string; valueMinor: number; customerId?: string };
export type CrmDealCreateInput = Omit<CrmDealCreateMutation, "action">;
type CrmCustomerDeactivateMutation = { action: "deactivateCustomer"; customerId: string };
type CrmCustomerImportRow = { rowNumber: number; name: string; email?: string; phone?: string; allowDuplicate: boolean };
type CrmCustomerImportMutation = { action: "importCustomers"; rows: CrmCustomerImportRow[] };
type CrmCustomerImportUndoMutation = { action: "undoCustomerImport"; customerIds: string[]; importIntentId: string };
export type CrmCustomerImportUndoState = { imported: number; skippedDuplicates: number; createdIds: string[]; importIntentId: string };
type CrmCustomerMergeSnapshot = {
  customerId: string;
  email: string | null;
  phone: string | null;
  preferredContactMethod: "email" | "phone" | "whatsapp" | "other";
  doNotContact: boolean;
  reminderOptOut: boolean;
  marketingOptOut: boolean;
  ownerUserId: string | null;
  tags: string[];
  notes: string | null;
  creditLimitMinor: number | null;
  paymentTermDays: number | null;
  deactivatedAt: string | null;
  mergedIntoCustomerId: string | null;
  mergedAt: string | null;
};
export type CrmCustomerMergeResult = {
  survivorCustomerId: string;
  duplicateCustomerId: string;
  previous: CrmCustomerMergeSnapshot[];
  merged?: CrmCustomerMergeSnapshot[];
  mergeIntentId?: string;
};
type CrmCustomerMergeMutation = { action: "mergeCustomers"; survivorCustomerId: string; duplicateCustomerId: string };
type CrmCustomerMergeUndoMutation = { action: "restoreCustomerMerge" } & CrmCustomerMergeResult;
type CrmRetryMutation = CrmTaskMutation | CrmCustomerCreateMutation | CrmCustomerDeactivateMutation | CrmCustomerImportMutation | CrmCustomerImportUndoMutation | CrmCustomerMergeMutation | CrmCustomerMergeUndoMutation | CrmDealCreateMutation | CrmCustomerProfileUpdateMutation | CrmSavedViewWriteMutation;
const CrmCustomerMergeInputSchema = z.object({ survivorCustomerId: uuid, duplicateCustomerId: uuid }).strict().refine((input) => input.survivorCustomerId !== input.duplicateCustomerId);
const CrmCustomerMergeSnapshotSchema = z.object({
  customerId: uuid,
  email: z.string().nullable(),
  phone: z.string().nullable(),
  preferredContactMethod: contactMethod,
  doNotContact: z.boolean(),
  reminderOptOut: z.boolean(),
  marketingOptOut: z.boolean(),
  ownerUserId: uuid.nullable(),
  tags: z.array(z.string().max(40)),
  notes: z.string().nullable(),
  creditLimitMinor: z.number().int().nullable(),
  paymentTermDays: z.number().int().nullable(),
  deactivatedAt: z.string().nullable(),
  mergedIntoCustomerId: uuid.nullable(),
  mergedAt: z.string().nullable(),
}).strict();
const CrmCustomerMergeResultSchema = z.object({
  survivorCustomerId: uuid,
  duplicateCustomerId: uuid,
  previous: z.array(CrmCustomerMergeSnapshotSchema).min(2).max(502),
  merged: z.array(CrmCustomerMergeSnapshotSchema).min(2).max(502).optional(),
  mergeIntentId: uuid.optional(),
}).strict();
const CrmCustomerImportRowSchema = z.object({
  rowNumber: z.number().int().positive(),
  name: z.string().min(1).max(120),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  allowDuplicate: z.boolean(),
}).strict();
const CrmCustomerImportMutationSchema = z.object({
  action: z.literal("importCustomers"),
  rows: z.array(CrmCustomerImportRowSchema).min(1).max(5000).refine((rows) => new Set(rows.map((row) => row.rowNumber)).size === rows.length),
}).strict();
const CrmCustomerImportUndoMutationSchema = z.object({
  action: z.literal("undoCustomerImport"),
  customerIds: z.array(uuid).min(1).max(5000),
  importIntentId: uuid,
}).strict();
const CrmCustomerImportUndoStateSchema = z.object({
  imported: z.number().int().nonnegative(),
  skippedDuplicates: z.number().int().nonnegative(),
  createdIds: z.array(uuid),
  importIntentId: uuid,
}).strict();

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

export async function submitCrmCustomerDeactivate(
  customerId: string,
  signal?: AbortSignal,
  useGoOverride?: boolean,
  retryScope?: CrmTaskRetryScope,
): Promise<CrmActionOutcome<{ deactivated: boolean }>> {
  const useGo = useGoOverride ?? (typeof __GO_CRM_CUSTOMER_DEACTIVATE__ !== "undefined" && __GO_CRM_CUSTOMER_DEACTIVATE__);
  const input = { customerId };
  if (!uuid.safeParse(customerId).success) throw new CrmApiError(0, "Choose a valid customer before deactivating it.");
  const scope = await crmTaskScope(retryScope);
  if (!useGo) {
    const unresolved = await readPendingCrmCustomerDeactivate({ actorId: scope.actorId, organizationId: scope.organizationId }, customerId);
    if (unresolved) throw new CrmApiError(0, "A Go customer deactivation is unresolved. Restore the Go customer route and retry the same customer before using the legacy route.", true);
    return submitCrmAction("/api/customers", { action: "deactivate", ...input }, signal);
  }
  const action: CrmCustomerDeactivateMutation = { action: "deactivateCustomer", customerId };
  const attempt = await crmTaskAttempt(action, scope, `deactivate:${customerId}`, CRM_CUSTOMER_DEACTIVATE_INTENT_PREFIX);
  try {
    const { response, body } = await request("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({ capabilityId: "crm.deactivateCustomer", input, intentId: attempt.intentId }),
    }, signal);
    if (response.status === 404) throw new CrmApiError(response.status, messageFor(response.status, body), true);
    const outcome = parseCrmActionOutcome<Record<string, unknown>>(response, body);
    if (outcome.kind === "pending") return outcome;
    const parsed = z.object({ deactivated: z.literal(true) }).strict().safeParse(outcome.data);
    if (!parsed.success) throw new CrmApiError(response.status, "The CRM service returned an unexpected deactivation result.", true);
    await clearCrmTaskAttempt(attempt.storageKey);
    return { kind: "completed", data: parsed.data };
  } catch (error) {
    if (error instanceof CrmApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429 && !error.requestMayHaveReachedServer) {
      await clearCrmTaskAttempt(attempt.storageKey);
    }
    throw error;
  }
}

export async function readPendingCrmCustomerDeactivate(scope: CrmTaskRetryScope, customerId: string): Promise<boolean> {
  const { scopeHash } = await crmTaskScope(scope);
  const storageKey = `${CRM_CUSTOMER_DEACTIVATE_INTENT_PREFIX}${scopeHash}:deactivate:${customerId}`;
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new CrmApiError(0, "Enable browser storage to check an unresolved customer deactivation."); }
  if (raw === null) return false;
  const stored = parseCrmTaskAttempt(raw);
  const parsed = z.object({ action: z.literal("deactivateCustomer"), customerId: uuid }).strict().safeParse(stored.action);
  if (!parsed.success || parsed.data.customerId !== customerId || await crmTaskFingerprint(parsed.data) !== stored.fingerprint) {
    throw new CrmApiError(0, "An unresolved customer deactivation could not be verified. Contact an administrator before retrying.");
  }
  return true;
}

export async function readPendingCrmCustomerMerge(scope: CrmTaskRetryScope): Promise<Pick<CrmCustomerMergeResult, "survivorCustomerId" | "duplicateCustomerId"> | null> {
  const { scopeHash } = await crmTaskScope(scope);
  const storageKey = `${CRM_CUSTOMER_MERGE_INTENT_PREFIX}${scopeHash}:merge`;
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new CrmApiError(0, "Enable browser storage to check an unresolved customer merge."); }
  if (raw === null) return null;
  const stored = parseCrmTaskAttempt(raw);
  const action = z.object({ action: z.literal("mergeCustomers"), survivorCustomerId: uuid, duplicateCustomerId: uuid }).strict()
    .refine((input) => input.survivorCustomerId !== input.duplicateCustomerId).safeParse(stored.action);
  if (!action.success || await crmTaskFingerprint(action.data) !== stored.fingerprint) {
    throw new CrmApiError(0, "An unresolved customer merge could not be verified. Contact an administrator before retrying.");
  }
  return { survivorCustomerId: action.data.survivorCustomerId, duplicateCustomerId: action.data.duplicateCustomerId };
}

export async function readPendingCrmCustomerMergeUndo(scope: CrmTaskRetryScope): Promise<CrmCustomerMergeResult | null> {
  const { scopeHash } = await crmTaskScope(scope);
  const storageKey = `${CRM_CUSTOMER_MERGE_UNDO_INTENT_PREFIX}${scopeHash}:undo`;
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new CrmApiError(0, "Enable browser storage to check an unresolved customer merge undo."); }
  if (raw === null) return null;
  const stored = parseCrmTaskAttempt(raw);
  const action = z.object({ action: z.literal("restoreCustomerMerge") }).merge(CrmCustomerMergeResultSchema).strict().safeParse(stored.action);
  if (!action.success || await crmTaskFingerprint(action.data) !== stored.fingerprint) {
    throw new CrmApiError(0, "An unresolved customer merge undo could not be verified. Contact an administrator before retrying.");
  }
  return {
    survivorCustomerId: action.data.survivorCustomerId,
    duplicateCustomerId: action.data.duplicateCustomerId,
    previous: action.data.previous,
    ...(action.data.merged ? { merged: action.data.merged } : {}),
    ...(action.data.mergeIntentId ? { mergeIntentId: action.data.mergeIntentId } : {}),
  };
}

export async function readCrmCustomerMergeUndo(scope: CrmTaskRetryScope): Promise<CrmCustomerMergeResult | null> {
  const { scopeHash } = await crmTaskScope(scope);
  const storageKey = `${CRM_CUSTOMER_MERGE_UNDO_STATE_PREFIX}${scopeHash}:undo`;
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new CrmApiError(0, "Enable browser storage to restore the available customer merge undo."); }
  if (raw === null) return null;
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch { throw new CrmApiError(0, "The saved customer merge undo is malformed. Contact an administrator before retrying."); }
  const parsed = CrmCustomerMergeResultSchema.safeParse(decoded);
  if (!parsed.success) throw new CrmApiError(0, "The saved customer merge undo could not be verified. Contact an administrator before retrying.");
  return parsed.data;
}

export async function submitCrmCustomerMerge(
  input: Pick<CrmCustomerMergeResult, "survivorCustomerId" | "duplicateCustomerId">,
  signal?: AbortSignal,
  useGoOverride?: boolean,
  retryScope?: CrmTaskRetryScope,
): Promise<CrmActionOutcome<CrmCustomerMergeResult>> {
  const useGo = useGoOverride ?? (typeof __GO_CRM_CUSTOMER_MERGE__ !== "undefined" && __GO_CRM_CUSTOMER_MERGE__);
  const parsedInput = CrmCustomerMergeInputSchema.safeParse(input);
  if (!parsedInput.success) throw new CrmApiError(0, "Choose two different valid customers to merge.");
  const scope = await crmTaskScope(retryScope);
  if (!useGo) {
    if (await readPendingCrmCustomerMerge({ actorId: scope.actorId, organizationId: scope.organizationId }) ||
      await readPendingCrmCustomerMergeUndo({ actorId: scope.actorId, organizationId: scope.organizationId })) {
      throw new CrmApiError(0, "A Go customer merge is unresolved. Restore the Go customer route and retry its exact action before using the legacy route.", true);
    }
    const outcome = await submitCrmAction("/api/customers", { action: "merge", ...parsedInput.data }, signal);
    if (outcome.kind === "pending") return outcome;
    const parsedOutput = CrmCustomerMergeResultSchema.safeParse(outcome.data);
    if (!parsedOutput.success || parsedOutput.data.survivorCustomerId !== parsedInput.data.survivorCustomerId || parsedOutput.data.duplicateCustomerId !== parsedInput.data.duplicateCustomerId) {
      throw new CrmApiError(0, "The CRM service returned an unexpected merge result.", true);
    }
    return { kind: "completed", data: parsedOutput.data };
  }
  if (await readPendingCrmCustomerMergeUndo({ actorId: scope.actorId, organizationId: scope.organizationId })) {
    throw new CrmApiError(0, "A Go customer merge undo is unresolved. Retry that exact undo before starting another merge.", true);
  }
  const action: CrmCustomerMergeMutation = { action: "mergeCustomers", ...parsedInput.data };
  const attempt = await crmTaskAttempt(action, scope, "merge", CRM_CUSTOMER_MERGE_INTENT_PREFIX);
  try {
    const { response, body } = await request("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({ capabilityId: "crm.mergeCustomers", input: parsedInput.data, intentId: attempt.intentId }),
    }, signal);
    if (response.status === 404) throw new CrmApiError(response.status, messageFor(response.status, body), true);
    const outcome = parseCrmActionOutcome<Record<string, unknown>>(response, body);
    if (outcome.kind === "pending") return outcome;
    const parsedOutput = CrmCustomerMergeResultSchema.safeParse(outcome.data);
    if (!parsedOutput.success || parsedOutput.data.survivorCustomerId !== parsedInput.data.survivorCustomerId || parsedOutput.data.duplicateCustomerId !== parsedInput.data.duplicateCustomerId ||
      !parsedOutput.data.previous.some((snapshot) => snapshot.customerId === parsedInput.data.survivorCustomerId) || !parsedOutput.data.previous.some((snapshot) => snapshot.customerId === parsedInput.data.duplicateCustomerId)) {
      throw new CrmApiError(response.status, "The CRM service returned an unexpected merge result.", true);
    }
    const completedMerge = { ...parsedOutput.data, mergeIntentId: attempt.intentId };
    await persistCrmCustomerMergeUndo(scope, completedMerge);
    await clearCrmTaskAttempt(attempt.storageKey);
    return { kind: "completed", data: completedMerge };
  } catch (error) {
    if (error instanceof CrmApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429 && !error.requestMayHaveReachedServer) {
      await clearCrmTaskAttempt(attempt.storageKey);
    }
    throw error;
  }
}

export async function submitCrmCustomerMergeUndo(
  input: unknown,
  signal?: AbortSignal,
  useGoOverride?: boolean,
  retryScope?: CrmTaskRetryScope,
): Promise<CrmActionOutcome<CrmCustomerMergeResult>> {
  const useGo = useGoOverride ?? (typeof __GO_CRM_CUSTOMER_MERGE__ !== "undefined" && __GO_CRM_CUSTOMER_MERGE__);
  const parsedInput = CrmCustomerMergeResultSchema.safeParse(input);
  if (!parsedInput.success) throw new CrmApiError(0, "The customer merge snapshot is invalid and cannot be restored.");
  const scope = await crmTaskScope(retryScope);
  if (!useGo) {
    if (await readPendingCrmCustomerMerge({ actorId: scope.actorId, organizationId: scope.organizationId }) ||
      await readPendingCrmCustomerMergeUndo({ actorId: scope.actorId, organizationId: scope.organizationId })) {
      throw new CrmApiError(0, "A Go customer merge is unresolved. Restore the Go customer route and retry its exact action before using the legacy route.", true);
    }
    const outcome = await submitCrmAction("/api/customers", { action: "undoMerge", ...parsedInput.data }, signal);
    if (outcome.kind === "pending") return outcome;
    const parsedOutput = CrmCustomerMergeResultSchema.safeParse(outcome.data);
    if (!parsedOutput.success) throw new CrmApiError(0, "The CRM service returned an unexpected merge undo result.", true);
    await clearCrmCustomerMergeUndo(scope);
    return { kind: "completed", data: parsedOutput.data };
  }
  if (await readPendingCrmCustomerMerge({ actorId: scope.actorId, organizationId: scope.organizationId })) {
    throw new CrmApiError(0, "A Go customer merge is unresolved. Retry that exact merge before undoing it.", true);
  }
  if (!parsedInput.data.mergeIntentId) {
    throw new CrmApiError(0, "The original Go merge receipt is missing, so this merge cannot be restored safely.");
  }
  const action: CrmCustomerMergeUndoMutation = { action: "restoreCustomerMerge", ...parsedInput.data };
  const attempt = await crmTaskAttempt(action, scope, "undo", CRM_CUSTOMER_MERGE_UNDO_INTENT_PREFIX);
  try {
    const { response, body } = await request("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({ capabilityId: "crm.restoreCustomerMerge", input: {
        survivorCustomerId: parsedInput.data.survivorCustomerId,
        duplicateCustomerId: parsedInput.data.duplicateCustomerId,
        mergeIntentId: parsedInput.data.mergeIntentId,
      }, intentId: attempt.intentId }),
    }, signal);
    if (response.status === 404) throw new CrmApiError(response.status, messageFor(response.status, body), true);
    const outcome = parseCrmActionOutcome<Record<string, unknown>>(response, body);
    if (outcome.kind === "pending") return outcome;
    const parsedOutput = CrmCustomerMergeResultSchema.safeParse(outcome.data);
    if (!parsedOutput.success || parsedOutput.data.survivorCustomerId !== parsedInput.data.survivorCustomerId || parsedOutput.data.duplicateCustomerId !== parsedInput.data.duplicateCustomerId) {
      throw new CrmApiError(response.status, "The CRM service returned an unexpected merge undo result.", true);
    }
    await clearCrmCustomerMergeUndo(scope);
    await clearCrmTaskAttempt(attempt.storageKey);
    return { kind: "completed", data: parsedOutput.data };
  } catch (error) {
    if (error instanceof CrmApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429 && !error.requestMayHaveReachedServer) {
      await clearCrmTaskAttempt(attempt.storageKey);
    }
    throw error;
  }
}

async function persistCrmCustomerMergeUndo(scope: { scopeHash: string }, result: CrmCustomerMergeResult): Promise<void> {
  const storageKey = `${CRM_CUSTOMER_MERGE_UNDO_STATE_PREFIX}${scope.scopeHash}:undo`;
  const serialized = JSON.stringify(result);
  try {
    window.localStorage.setItem(storageKey, serialized);
    if (window.localStorage.getItem(storageKey) !== serialized) throw new Error("customer merge undo snapshot did not persist");
  } catch {
    throw new CrmApiError(0, "The merge completed, but its undo snapshot could not be saved. Retry the exact merge before starting another CRM change.", true);
  }
}

async function clearCrmCustomerMergeUndo(scope: { scopeHash: string }): Promise<void> {
  try { window.localStorage.removeItem(`${CRM_CUSTOMER_MERGE_UNDO_STATE_PREFIX}${scope.scopeHash}:undo`); }
  catch { throw new CrmApiError(0, "The merge undo completed, but its saved snapshot could not be cleared. Reload CRM before retrying.", true); }
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

const CrmSavedViewWriteMutationSchema = z.object({
  action: z.literal("saveCustomerView"),
  id: uuid.optional(),
  name: z.string().trim().min(1).max(60),
  filters: z.object({
    status: z.enum(["active", "inactive", "all"]),
    owner: z.string().max(64),
    staleOnly: z.boolean(),
    duplicateOnly: z.boolean(),
    tag: z.string().max(40),
  }).strict(),
  isShared: z.boolean(),
  isPinned: z.boolean(),
}).strict();
const CrmSavedViewPriorStateSchema = z.object({
  id: uuid,
  name: z.string(),
  filters: CrmSavedViewWriteMutationSchema.shape.filters,
  isShared: z.boolean(),
  isPinned: z.boolean(),
  createdByUserId: uuid,
}).strict();
const CrmSavedViewWriteOutputSchema = z.object({
  viewId: uuid,
  previous: CrmSavedViewPriorStateSchema.nullable(),
}).strict();

export async function readPendingCrmSavedViewWrite(scope: CrmTaskRetryScope): Promise<CrmSavedViewWriteMutation | null> {
  const { scopeHash } = await crmTaskScope(scope);
  const storageKey = `${CRM_SAVED_VIEW_WRITE_INTENT_PREFIX}${scopeHash}:save`;
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new CrmApiError(0, "Enable browser storage to restore an unresolved saved-view change."); }
  if (raw === null) return null;
  const attempt = parseCrmTaskAttempt(raw);
  const action = CrmSavedViewWriteMutationSchema.safeParse(attempt.action);
  if (!action.success || await crmTaskFingerprint(action.data) !== attempt.fingerprint) {
    throw new CrmApiError(0, "An unresolved saved-view change could not be verified. Contact an administrator before retrying.");
  }
  return action.data;
}

export async function submitCrmSavedViewWrite(
  input: Omit<CrmSavedViewWriteMutation, "action">,
  signal?: AbortSignal,
  useGoOverride?: boolean,
  retryScope?: CrmTaskRetryScope,
): Promise<CrmActionOutcome<z.infer<typeof CrmSavedViewWriteOutputSchema>>> {
  const action = { action: "saveCustomerView" as const, ...input };
  if (!CrmSavedViewWriteMutationSchema.safeParse(action).success) {
    throw new CrmApiError(0, "Review the saved-view name and filters before saving.");
  }
  const scope = await crmTaskScope(retryScope);
  let storageKey: string | null;
  try { storageKey = window.localStorage.getItem(`${CRM_SAVED_VIEW_WRITE_INTENT_PREFIX}${scope.scopeHash}:save`) === null ? null : `${CRM_SAVED_VIEW_WRITE_INTENT_PREFIX}${scope.scopeHash}:save`; }
  catch { throw new CrmApiError(0, "Enable browser storage to check for an unresolved saved-view change."); }
  const useGo = useGoOverride ?? (typeof __GO_CRM_VIEW_WRITES__ !== "undefined" && __GO_CRM_VIEW_WRITES__);
  if (!useGo) {
    if (storageKey) throw new CrmApiError(0, "A Go saved-view change is unresolved. Re-enable Go saved-view writes and retry its exact details before using legacy writes.", true);
    return submitCrmAction("/api/crm/views", action, signal);
  }
  const attempt = await crmTaskAttempt(action, scope, "save", CRM_SAVED_VIEW_WRITE_INTENT_PREFIX);
  try {
    const { response, body } = await request("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({ capabilityId: "crm.saveCustomerView", input: Object.fromEntries(Object.entries(action).filter(([key]) => key !== "action")), intentId: attempt.intentId }),
    }, signal);
    if (response.status === 404) throw new CrmApiError(404, "The Go CRM saved-view route is unavailable. Check the Go session capability route configuration.", true);
    const outcome = parseCrmActionOutcome<Record<string, unknown>>(response, body);
    if (outcome.kind === "pending") return outcome;
    const parsed = CrmSavedViewWriteOutputSchema.safeParse(outcome.data);
    if (!parsed.success || (action.id && parsed.data.viewId !== action.id)) {
      throw new CrmApiError(response.status, "The CRM service returned an unexpected saved-view result.", true);
    }
    await clearCrmTaskAttempt(attempt.storageKey);
    return { kind: "completed", data: parsed.data };
  } catch (error) {
    if (error instanceof CrmApiError && error.status >= 400 && error.status < 500 && error.status !== 404 && error.status !== 408 && error.status !== 429 && !error.requestMayHaveReachedServer) {
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

export async function readPendingCrmCustomerImport(scope: CrmTaskRetryScope): Promise<CrmCustomerImportRow[] | null> {
  const { scopeHash } = await crmTaskScope(scope);
  const storageKey = `${CRM_CUSTOMER_IMPORT_INTENT_PREFIX}${scopeHash}:import`;
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new CrmApiError(0, "Enable browser storage to check an unresolved customer import."); }
  if (raw === null) return null;
  const stored = parseCrmTaskAttempt(raw);
  const action = CrmCustomerImportMutationSchema.safeParse(stored.action);
  if (!action.success || await crmTaskFingerprint(action.data) !== stored.fingerprint) {
    throw new CrmApiError(0, "An unresolved customer import could not be verified. Contact an administrator before retrying.");
  }
  return action.data.rows;
}

export async function readPendingCrmCustomerImportUndo(scope: CrmTaskRetryScope): Promise<CrmCustomerImportUndoMutation | null> {
  const { scopeHash } = await crmTaskScope(scope);
  const storageKey = `${CRM_CUSTOMER_IMPORT_UNDO_INTENT_PREFIX}${scopeHash}:undo`;
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new CrmApiError(0, "Enable browser storage to check an unresolved customer import undo."); }
  if (raw === null) return null;
  const stored = parseCrmTaskAttempt(raw);
  const action = CrmCustomerImportUndoMutationSchema.safeParse(stored.action);
  if (!action.success || await crmTaskFingerprint(action.data) !== stored.fingerprint) {
    throw new CrmApiError(0, "An unresolved customer import undo could not be verified. Contact an administrator before retrying.");
  }
  return action.data;
}

export async function readCrmCustomerImportUndo(scope: CrmTaskRetryScope): Promise<CrmCustomerImportUndoState | null> {
  const { scopeHash } = await crmTaskScope(scope);
  const storageKey = `${CRM_CUSTOMER_IMPORT_UNDO_STATE_PREFIX}${scopeHash}:undo`;
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new CrmApiError(0, "Enable browser storage to restore the saved customer import undo."); }
  if (raw === null) return null;
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch { throw new CrmApiError(0, "The saved customer import undo is malformed. Contact an administrator before retrying."); }
  const parsed = CrmCustomerImportUndoStateSchema.safeParse(decoded);
  if (!parsed.success) throw new CrmApiError(0, "The saved customer import undo could not be verified. Contact an administrator before retrying.");
  return parsed.data;
}

async function persistCrmCustomerImportUndo(scope: { scopeHash: string }, result: CrmImportResult, importIntentId: string): Promise<void> {
  const storageKey = `${CRM_CUSTOMER_IMPORT_UNDO_STATE_PREFIX}${scope.scopeHash}:undo`;
  const state: CrmCustomerImportUndoState = {
    imported: result.inserted,
    skippedDuplicates: result.skippedDuplicates,
    createdIds: result.createdIds,
    importIntentId,
  };
  const serialized = JSON.stringify(state);
  try {
    window.localStorage.setItem(storageKey, serialized);
    if (window.localStorage.getItem(storageKey) !== serialized) throw new Error("customer import undo state did not persist");
  } catch {
    throw new CrmApiError(0, "The import completed, but its undo IDs could not be saved. Retry the exact import before starting another CRM change.", true);
  }
}

async function clearCrmCustomerImportUndo(scope: { scopeHash: string }): Promise<void> {
  try { window.localStorage.removeItem(`${CRM_CUSTOMER_IMPORT_UNDO_STATE_PREFIX}${scope.scopeHash}:undo`); }
  catch { throw new CrmApiError(0, "The import undo completed, but its saved IDs could not be cleared. Reload CRM before retrying.", true); }
}

export async function importCrmCustomers(
  rows: CrmCustomerImportRow[],
  signal?: AbortSignal,
  useGoOverride?: boolean,
  retryScope?: CrmTaskRetryScope,
): Promise<CrmActionOutcome<CrmImportResult>> {
  const useGo = useGoOverride ?? (typeof __GO_CRM_CUSTOMER_IMPORT__ !== "undefined" && __GO_CRM_CUSTOMER_IMPORT__);
  const parsedRows = z.array(CrmCustomerImportRowSchema).min(1).max(5000).refine((items) => new Set(items.map((row) => row.rowNumber)).size === items.length).safeParse(rows);
  if (!parsedRows.success) throw new CrmApiError(0, "Review the customer import rows and correct invalid values before submitting.");
  const scope = await crmTaskScope(retryScope);
  if (!useGo) {
    if (await readPendingCrmCustomerImport(scope) || await readPendingCrmCustomerImportUndo(scope)) {
      throw new CrmApiError(0, "A Go customer import is unresolved. Restore the Go customer route and retry its exact action before using the legacy import route.", true);
    }
    const { response, body } = await request("/api/import", { method: "POST", body: JSON.stringify({ entity: "customers", rows: parsedRows.data }) }, signal);
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
  if (await readPendingCrmCustomerImportUndo(scope)) {
    throw new CrmApiError(0, "A Go customer import undo is unresolved. Retry that exact undo before starting another import.", true);
  }
  const action: CrmCustomerImportMutation = { action: "importCustomers", rows: parsedRows.data };
  const attempt = await crmTaskAttempt(action, scope, "import", CRM_CUSTOMER_IMPORT_INTENT_PREFIX);
  try {
    const { response, body } = await request("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({ capabilityId: "crm.importCustomers", input: { rows: parsedRows.data }, intentId: attempt.intentId }),
    }, signal);
    if (response.status === 404) throw new CrmApiError(response.status, messageFor(response.status, body), true);
    const outcome = parseCrmActionOutcome<Record<string, unknown>>(response, body);
    if (outcome.kind === "pending") return outcome;
    const submittedRowNumbers = new Set(parsedRows.data.map((row) => row.rowNumber));
    const parsed = z.object({ createdIds: z.array(uuid).max(5000), imported: z.number().int().nonnegative(), skippedDuplicateRows: z.array(z.number().int().positive()).max(5000) }).strict().safeParse(outcome.data);
    const skippedRowNumbers = parsed.success ? parsed.data.skippedDuplicateRows : [];
    const skippedRowsAreValid = parsed.success
      && new Set(skippedRowNumbers).size === skippedRowNumbers.length
      && skippedRowNumbers.every((rowNumber) => submittedRowNumbers.has(rowNumber));
    if (!parsed.success || !skippedRowsAreValid || parsed.data.imported !== parsed.data.createdIds.length || new Set(parsed.data.createdIds).size !== parsed.data.createdIds.length || parsed.data.imported + skippedRowNumbers.length !== parsedRows.data.length) {
      throw new CrmApiError(response.status, "The CRM service returned an unexpected import result.", true);
    }
    const result: CrmImportResult = {
      inserted: parsed.data.imported,
      skippedDuplicates: parsed.data.skippedDuplicateRows.length,
      createdIds: parsed.data.createdIds,
    };
    await persistCrmCustomerImportUndo(scope, result, attempt.intentId);
    await clearCrmTaskAttempt(attempt.storageKey);
    return { kind: "completed", data: result };
  } catch (error) {
    if (error instanceof CrmApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429 && !error.requestMayHaveReachedServer) {
      await clearCrmTaskAttempt(attempt.storageKey);
    }
    throw error;
  }
}

export async function undoCrmImport(
  importIds: string[],
  signal?: AbortSignal,
  useGoOverride?: boolean,
  retryScope?: CrmTaskRetryScope,
  importIntentId?: string,
): Promise<CrmActionOutcome<{ undone: number; remaining: number }>> {
  const useGo = useGoOverride ?? (typeof __GO_CRM_CUSTOMER_IMPORT__ !== "undefined" && __GO_CRM_CUSTOMER_IMPORT__);
  const parsedIds = z.array(uuid).min(1).max(5000).safeParse(importIds);
  if (!parsedIds.success) throw new CrmApiError(0, "The customer import undo IDs are invalid.");
  const scope = await crmTaskScope(retryScope);
  if (!useGo) {
    if (importIntentId) throw new CrmApiError(0, "This import was performed by Go. Restore the Go CRM import route to undo it safely.", true);
    if (await readPendingCrmCustomerImport(scope) || await readPendingCrmCustomerImportUndo(scope)) {
      throw new CrmApiError(0, "A Go customer import is unresolved. Restore the Go customer route and retry its exact action before using the legacy import route.", true);
    }
    const { response, body } = await request("/api/import", { method: "POST", body: JSON.stringify({ entity: "customers", action: "undo", importIds: parsedIds.data }) }, signal);
    if (response.status === 202) {
      const parsed = ImportPendingSchema.safeParse(body);
      if (!parsed.success) throw new CrmApiError(202, "The import service returned an unexpected undo approval response.");
      return { kind: "pending", reason: parsed.data.error };
    }
    if (!response.ok) throw new CrmApiError(response.status, messageFor(response.status, body));
    const parsed = z.object({ undone: z.number().int().nonnegative(), remaining: z.number().int().nonnegative() }).safeParse(body);
    if (!parsed.success) throw new CrmApiError(response.status, "The import service returned an unexpected undo result.");
    await clearCrmCustomerImportUndo(scope);
    return { kind: "completed", data: parsed.data };
  }
  if (await readPendingCrmCustomerImport(scope)) {
    throw new CrmApiError(0, "A Go customer import is unresolved. Retry that exact import before undoing it.", true);
  }
  if (!importIntentId || !uuid.safeParse(importIntentId).success) {
    throw new CrmApiError(0, "The successful Go import receipt reference is missing. Retry or refresh the import before undoing it.", true);
  }
  const action: CrmCustomerImportUndoMutation = { action: "undoCustomerImport", customerIds: parsedIds.data, importIntentId };
  const attempt = await crmTaskAttempt(action, scope, "undo", CRM_CUSTOMER_IMPORT_UNDO_INTENT_PREFIX);
  try {
    const { response, body } = await request("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({ capabilityId: "crm.undoCustomerImport", input: { customerIds: parsedIds.data, importIntentId }, intentId: attempt.intentId }),
    }, signal);
    if (response.status === 404) throw new CrmApiError(response.status, messageFor(response.status, body), true);
    const outcome = parseCrmActionOutcome<Record<string, unknown>>(response, body);
    if (outcome.kind === "pending") return outcome;
    const parsed = z.object({ customerIds: z.array(uuid).max(5000), deactivated: z.number().int().nonnegative(), importIntentId: uuid, undoIntentId: uuid }).strict().safeParse(outcome.data);
    const requestedIds = new Set(parsedIds.data);
    const returnedIdsMatchRequest = parsed.success
      && parsed.data.customerIds.length === requestedIds.size
      && parsed.data.customerIds.every((id) => requestedIds.has(id));
    if (!parsed.success || parsed.data.importIntentId !== importIntentId || parsed.data.undoIntentId !== attempt.intentId || parsed.data.deactivated !== parsedIds.data.length || !returnedIdsMatchRequest || new Set(parsed.data.customerIds).size !== parsed.data.customerIds.length) {
      throw new CrmApiError(response.status, "The CRM service returned an unexpected import undo result.", true);
    }
    await clearCrmCustomerImportUndo(scope);
    await clearCrmTaskAttempt(attempt.storageKey);
    return { kind: "completed", data: { undone: parsed.data.deactivated, remaining: parsedIds.data.length - parsed.data.deactivated } };
  } catch (error) {
    if (error instanceof CrmApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429 && !error.requestMayHaveReachedServer) {
      await clearCrmTaskAttempt(attempt.storageKey);
    }
    throw error;
  }
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
