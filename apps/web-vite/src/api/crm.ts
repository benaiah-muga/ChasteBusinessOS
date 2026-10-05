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
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "CrmApiError";
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new CrmApiError(response.status, "The CRM service returned an unreadable response.");
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
    if (error instanceof DOMException && error.name === "TimeoutError") throw new CrmApiError(0, "The CRM service took too long to respond. Check the record before trying again.");
    throw new CrmApiError(0, "Could not reach the CRM service. Check your connection and try again.");
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
  if (response.status === 202) {
    const parsed = PendingSchema.safeParse(body);
    if (!parsed.success) throw new CrmApiError(202, "The CRM service returned an unexpected approval response.");
    return { kind: "pending", reason: parsed.data.reason ?? parsed.data.error ?? "This action is waiting for approval." };
  }
  if (!response.ok) throw new CrmApiError(response.status, messageFor(response.status, body));
  const parsed = SuccessSchema.safeParse(body);
  if (!parsed.success) throw new CrmApiError(response.status, "The CRM service returned an unexpected action response.");
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
