import { z } from "zod";

const ModuleSwitchboardSchema = z.object({
  catalog: z.array(z.object({ id: z.string().min(1) })),
  enabledModules: z.array(z.string().min(1)),
});

const EmployeeSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  email: z.string().nullable(),
  title: z.string().nullable(),
  department: z.string().nullable(),
  managerEmployeeId: z.string().nullable(),
  emergencyContactName: z.string().nullable(),
  emergencyContactPhone: z.string().nullable(),
  monthlySalaryMinor: z.number().int().safe(),
  taxRateBps: z.number().int().safe(),
  active: z.boolean(),
});

const LeaveSchema = z.object({
  id: z.string().min(1),
  employeeName: z.string(),
  kind: z.string(),
  startDate: z.string().datetime({ offset: true }),
  endDate: z.string().datetime({ offset: true }),
  calendarDays: z.number().int().safe(),
  status: z.string(),
});

const PayrollRunSchema = z.object({
  id: z.string().min(1),
  year: z.number().int().safe(),
  month: z.number().int().min(1).max(12),
  status: z.string(),
  totalGrossMinor: z.number().int().safe(),
  totalTaxMinor: z.number().int().safe(),
  totalNetMinor: z.number().int().safe(),
  headcount: z.number().int().safe(),
});

const OpeningSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  department: z.string().nullable(),
  note: z.string().nullable(),
  status: z.string(),
  createdAt: z.string().datetime({ offset: true }),
});

const ApplicantSchema = z.object({
  id: z.string().min(1),
  openingId: z.string().min(1),
  name: z.string(),
  stage: z.string(),
  note: z.string().nullable(),
});

const AttendanceSchema = z.object({
  employeeId: z.string().min(1),
  clockedInAt: z.string().datetime({ offset: true }),
  late: z.boolean(),
});

const HrReportSchema = z.object({
  employees: z.array(EmployeeSchema),
  leave: z.array(LeaveSchema),
  runs: z.array(PayrollRunSchema),
  openings: z.array(OpeningSchema),
  applicants: z.array(ApplicantSchema),
  attendance: z.array(AttendanceSchema),
});

const TimeReportSchema = z.object({
  rows: z.array(z.object({
    employeeId: z.string().min(1),
    approvedMinutes: z.number().int().safe(),
    pendingMinutes: z.number().int().safe(),
  })),
});

const PendingEntriesSchema = z.object({
  entries: z.array(z.object({
    id: z.string().min(1),
    employeeId: z.string().min(1),
    employeeName: z.string(),
    workDate: z.string().datetime({ offset: true }),
    minutes: z.number().int().safe(),
    note: z.string().nullable(),
    late: z.boolean(),
  })),
});

export type HrEmployee = z.infer<typeof EmployeeSchema>;
export type HrLeaveRequest = z.infer<typeof LeaveSchema>;
export type HrPayrollRun = z.infer<typeof PayrollRunSchema>;
export type HrOpening = z.infer<typeof OpeningSchema>;
export type HrApplicant = z.infer<typeof ApplicantSchema>;
export type HrAttendance = z.infer<typeof AttendanceSchema>;
export type HrReport = z.infer<typeof HrReportSchema>;
export type HrTimeReport = z.infer<typeof TimeReportSchema>;
export type HrPendingEntry = z.infer<typeof PendingEntriesSchema>["entries"][number];

export type HrAction =
  | { action: "hireEmployee"; name: string; email?: string; title?: string; monthlySalaryMinor: number; taxRateBps?: number; annualLeaveDays?: number }
  | { action: "requestLeave"; employeeId: string; kind: string; startDate: string; endDate: string }
  | { action: "createOpening"; title: string; department?: string; note?: string }
  | { action: "addApplicant"; openingId: string; name: string; email?: string; note?: string }
  | { action: "moveApplicant"; applicantId: string; stage: string }
  | { action: "createPayrollRun"; year: number; month: number }
  | { action: "executePayrollRun"; runId: string; expectedTotalNetMinor: number }
  | { action: "voidPayrollRun"; runId: string }
  | { action: "decideLeave"; requestId: string; approve: boolean }
  | { action: "cancelLeave"; requestId: string }
  | { action: "clockIn" | "clockOut"; employeeId: string };

export type HrActionResult = { kind: "success" | "pending"; data: Record<string, unknown> };

export class HrApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HrApiError";
  }
}

const retryIntentIds = new Map<string, string>();

export async function fetchHrEnabled(signal?: AbortSignal): Promise<boolean> {
  const response = await request("/api/modules", { method: "GET" }, signal);
  if (!response.ok) throw new HrApiError(response.status, "Could not check whether the People module is enabled.");
  const parsed = ModuleSwitchboardSchema.safeParse(await readJson(response));
  if (!parsed.success) throw new HrApiError(response.status, "The module switchboard returned an unexpected response.");
  const ids = new Set(parsed.data.catalog.map((module) => module.id));
  if (!ids.has("hr") || parsed.data.enabledModules.some((id) => !ids.has(id))) {
    throw new HrApiError(response.status, "The module switchboard returned an invalid People module configuration.");
  }
  return parsed.data.enabledModules.includes("hr");
}

export async function fetchHrReport(signal?: AbortSignal): Promise<HrReport> {
  const response = await request("/api/hr", { method: "GET" }, signal);
  if (!response.ok) throw await apiError(response, "people records");
  const parsed = HrReportSchema.safeParse(await readJson(response));
  if (!parsed.success) throw new HrApiError(response.status, "The People service returned data in an unexpected format.");
  return parsed.data;
}

export async function fetchHrTime(from: string, to: string, signal?: AbortSignal): Promise<HrTimeReport> {
  const query = new URLSearchParams({ from, to });
  const response = await request(`/api/time?${query.toString()}`, { method: "GET" }, signal);
  if (!response.ok) throw await apiError(response, "time report");
  const parsed = TimeReportSchema.safeParse(await readJson(response));
  if (!parsed.success) throw new HrApiError(response.status, "The time service returned data in an unexpected format.");
  return parsed.data;
}

export async function fetchHrPendingEntries(signal?: AbortSignal): Promise<HrPendingEntry[]> {
  const response = await request("/api/time?pending=1", { method: "GET" }, signal);
  if (!response.ok) throw await apiError(response, "pending time entries");
  const parsed = PendingEntriesSchema.safeParse(await readJson(response));
  if (!parsed.success) throw new HrApiError(response.status, "The time service returned pending entries in an unexpected format.");
  return parsed.data.entries;
}

export async function submitHrAction(action: HrAction): Promise<HrActionResult> {
  const result = await submit("/api/hr", action);
  const pending = z.object({ ok: z.literal(false), pendingApproval: z.literal(true), reason: z.string() }).safeParse(result.body);
  if (pending.success || result.response.status === 202) {
    if (!pending.success) throw new HrApiError(result.response.status, "The action needs approval, but the People service returned an invalid approval response.");
    retryIntentIds.delete(result.retryKey);
    return { kind: "pending", data: { reason: pending.data.reason } };
  }
  if (!result.response.ok) {
    if (result.response.status < 500) retryIntentIds.delete(result.retryKey);
    throw parseError(result.response.status, result.body, "The People service could not complete this action.");
  }
  const parsed = z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) }).safeParse(result.body);
  if (!parsed.success) throw new HrApiError(result.response.status, "The People service returned an unexpected action response.");
  retryIntentIds.delete(result.retryKey);
  return { kind: "success", data: parsed.data.data };
}

export async function submitHrTimeAction(action: { action: "log"; employeeId: string; workDate: string; minutes: number; note?: string } | { action: "decide"; entryId: string; decision: "approve" | "reject" }): Promise<HrActionResult> {
  const result = await submit("/api/time", action);
  const pending = z.object({ ok: z.literal(false), pendingApproval: z.literal(true), reason: z.string() }).safeParse(result.body);
  if (pending.success || result.response.status === 202) {
    if (!pending.success) throw new HrApiError(result.response.status, "The time action needs approval, but the service returned an invalid approval response.");
    retryIntentIds.delete(result.retryKey);
    return { kind: "pending", data: { reason: pending.data.reason } };
  }
  if (!result.response.ok) {
    if (result.response.status < 500) retryIntentIds.delete(result.retryKey);
    throw parseError(result.response.status, result.body, "The time service could not complete this action.");
  }
  const parsed = z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) }).safeParse(result.body);
  if (!parsed.success) throw new HrApiError(result.response.status, "The time service returned an unexpected action response.");
  retryIntentIds.delete(result.retryKey);
  return { kind: "success", data: parsed.data.data };
}

async function request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new HrApiError(0, timedOut
      ? "The People service timed out. The action may have completed, so check People records before retrying."
      : "The People action could not be confirmed. Check People records before retrying.");
  }
}

async function submit(path: string, body: unknown): Promise<{ response: Response; body: unknown; retryKey: string }> {
  const retryKey = `${path}:${JSON.stringify(body)}`;
  const intentId = retryIntentIds.get(retryKey) ?? crypto.randomUUID();
  let response: Response;
  try {
    response = await request(path, { method: "POST", body: JSON.stringify({ ...body as Record<string, unknown>, intentId }) });
  } catch (error) {
    rememberRetryIntent(retryKey, intentId);
    throw error;
  }
  rememberRetryIntent(retryKey, intentId);
  return { response, body: await readJson(response), retryKey };
}

function rememberRetryIntent(key: string, intentId: string): void {
  retryIntentIds.set(key, intentId);
  while (retryIntentIds.size > 100) {
    const oldest = retryIntentIds.keys().next().value;
    if (oldest === undefined) break;
    retryIntentIds.delete(oldest);
  }
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

async function apiError(response: Response, label: string): Promise<HrApiError> {
  const body = await readJson(response);
  return parseError(response.status, body, `The People service could not load ${label}.`);
}

function parseError(status: number, body: unknown, fallback: string): HrApiError {
  const parsed = z.object({ error: z.string().optional(), reason: z.string().optional() }).safeParse(body);
  if (status === 401) return new HrApiError(status, "Your session has ended. Sign in again to continue.");
  if (status === 403) return new HrApiError(status, parsed.success ? parsed.data.error ?? "You do not have permission to use this People feature." : "You do not have permission to use this People feature.");
  return new HrApiError(status, parsed.success ? parsed.data.error ?? parsed.data.reason ?? fallback : fallback);
}
