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
export type HrPayrollAction = Extract<HrAction, { action: "createPayrollRun" }>;
export type HrHiringAction = Extract<HrAction, { action: "createOpening" | "addApplicant" | "moveApplicant" }>;
export type HrEmployeeHireAction = Extract<HrAction, { action: "hireEmployee" }>;
export type HrLeaveAction =
  | { action: "requestLeave"; employeeId: string; kind: string; startDate: string; endDate: string }
  | { action: "decideLeave"; requestId: string; approve: boolean }
  | { action: "cancelLeave"; requestId: string };
export type HrTimeAction =
  | { action: "log"; employeeId: string; workDate: string; minutes: number; note?: string }
  | { action: "decide"; entryId: string; decision: "approve" | "reject" };
export type HrRetryScope = { actorId: string | null; organizationId: string | null };

export class HrApiError extends Error {
  constructor(readonly status: number, message: string, readonly requestMayHaveReachedServer = false) {
    super(message);
    this.name = "HrApiError";
  }
}

const retryIntentIds = new Map<string, string>();
const GO_HR_LEAVE_ATTEMPT_PREFIX = "chaste:hr:leave:go:attempt:v1:";
const GO_HR_TIME_ATTEMPT_PREFIX = "chaste:hr:time:go:attempt:v1:";
const GO_HR_PAYROLL_ATTEMPT_PREFIX = "chaste:hr:payroll:go:attempt:v1:";
const GO_HR_HIRING_ATTEMPT_PREFIX = "chaste:hr:hiring:go:attempt:v1:";
const GO_HR_EMPLOYEE_ATTEMPT_PREFIX = "chaste:hr:employee:go:attempt:v1:";
const GoLeaveRequestSchema = z.object({ action: z.literal("requestLeave"), employeeId: z.string().uuid(), kind: z.enum(["annual", "sick", "parental", "unpaid", "other"]), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();
const GoLeaveDecisionSchema = z.object({ action: z.literal("decideLeave"), requestId: z.string().uuid(), approve: z.boolean() }).strict();
const GoLeaveCancelSchema = z.object({ action: z.literal("cancelLeave"), requestId: z.string().uuid() }).strict();
const GoLeaveActionSchema = z.discriminatedUnion("action", [GoLeaveRequestSchema, GoLeaveDecisionSchema, GoLeaveCancelSchema]);
const GoLeaveAttemptSchema = z.object({ intentId: z.string().uuid(), fingerprint: z.string().length(64), action: GoLeaveActionSchema }).strict();
const GoLeaveOutputSchemas = {
  requestLeave: z.object({ requestId: z.string().uuid(), calendarDays: z.number().int().safe().positive() }).strict(),
  decideLeave: z.object({ status: z.enum(["approved", "rejected"]) }).strict(),
  cancelLeave: z.object({ cancelled: z.literal(true) }).strict(),
} as const;
const GoTimeLogActionSchema = z.object({ action: z.literal("log"), employeeId: z.string().uuid(), workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), minutes: z.number().int().positive().max(1440), note: z.string().max(300).optional() }).strict();
const GoTimeDecisionActionSchema = z.object({ action: z.literal("decide"), entryId: z.string().uuid(), decision: z.enum(["approve", "reject"]) }).strict();
const GoTimeActionSchema = z.discriminatedUnion("action", [GoTimeLogActionSchema, GoTimeDecisionActionSchema]);
const GoTimeAttemptSchema = z.object({ intentId: z.string().uuid(), fingerprint: z.string().length(64), action: GoTimeActionSchema }).strict();
const GoTimeOutputSchemas = {
  log: z.object({ entryId: z.string().uuid(), status: z.literal("submitted") }).strict(),
  decide: z.object({ entryId: z.string().uuid(), status: z.enum(["approved", "rejected"]) }).strict(),
} as const;
const GoHrPayrollActionSchema = z.object({ action: z.literal("createPayrollRun"), year: z.number().int().min(2020).max(2100), month: z.number().int().min(1).max(12) }).strict();
const GoHrPayrollAttemptSchema = z.object({ intentId: z.string().uuid(), fingerprint: z.string().length(64), action: GoHrPayrollActionSchema }).strict();
const GoHrPayrollOutputSchema = z.object({ runId: z.string().uuid(), headcount: z.number().int().safe().positive(), totalGrossMinor: z.number().int().safe().nonnegative(), totalTaxMinor: z.number().int().safe().nonnegative(), totalNetMinor: z.number().int().safe().nonnegative() }).strict();
const GoHrCreateOpeningActionSchema = z.object({ action: z.literal("createOpening"), title: z.string().min(1).max(120), department: z.string().min(1).max(100).optional(), note: z.string().min(1).max(500).optional() }).strict();
const GoHrAddApplicantActionSchema = z.object({ action: z.literal("addApplicant"), openingId: z.string().uuid(), name: z.string().min(1).max(120), email: z.string().email().optional(), note: z.string().min(1).max(500).optional() }).strict();
const GoHrMoveApplicantActionSchema = z.object({ action: z.literal("moveApplicant"), applicantId: z.string().uuid(), stage: z.enum(["applied", "screening", "interview", "offer", "rejected"]) }).strict();
const GoHrHiringActionSchema = z.discriminatedUnion("action", [GoHrCreateOpeningActionSchema, GoHrAddApplicantActionSchema, GoHrMoveApplicantActionSchema]);
const GoHrHiringAttemptSchema = z.object({ intentId: z.string().uuid(), fingerprint: z.string().length(64), action: GoHrHiringActionSchema }).strict();
const GoHrHiringOutputSchemas = {
  createOpening: z.object({ openingId: z.string().uuid() }).strict(),
  addApplicant: z.object({ applicantId: z.string().uuid() }).strict(),
  moveApplicant: z.object({ moved: z.literal(true), stage: z.enum(["applied", "screening", "interview", "offer", "rejected"]) }).strict(),
} as const;
const GoHrEmployeeHireActionSchema = z.object({
  action: z.literal("hireEmployee"),
  name: z.string().min(1).max(120),
  email: z.string().email().max(254).optional(),
  title: z.string().max(80).optional(),
  monthlySalaryMinor: z.number().int().safe().nonnegative(),
  taxRateBps: z.number().int().safe().min(0).max(5000).optional(),
  annualLeaveDays: z.number().int().safe().min(0).max(365).optional(),
}).strict();
const GoHrEmployeeHireAttemptSchema = z.object({ intentId: z.string().uuid(), fingerprint: z.string().length(64), action: GoHrEmployeeHireActionSchema }).strict();
const GoHrEmployeeHireOutputSchema = z.object({ employeeId: z.string().uuid() }).strict();
const GoPendingEntriesSchema = z.object({
  entries: z.array(z.object({
    id: z.string().uuid(),
    employeeId: z.string().uuid(),
    employeeName: z.string(),
    workDate: z.string().datetime({ offset: true }),
    minutes: z.number().int().positive().max(1440),
    note: z.string().nullable(),
    late: z.boolean(),
  }).strict()),
}).strict();

export function goHrLeaveUseGo(): boolean {
  return typeof __GO_HR_LEAVE__ !== "undefined" && __GO_HR_LEAVE__;
}

export function goHrTimeUseGo(): boolean {
  return typeof __GO_HR_TIME__ !== "undefined" && __GO_HR_TIME__;
}

export function goHrPayrollUseGo(): boolean {
  return typeof __GO_HR_PAYROLL__ !== "undefined" && __GO_HR_PAYROLL__;
}

export function goHrHiringUseGo(): boolean {
  return typeof __GO_HR_HIRING__ !== "undefined" && __GO_HR_HIRING__;
}

export function goHrOverviewReportUseGo(): boolean {
  return typeof __GO_HR_OVERVIEW_REPORT_READS__ !== "undefined" && __GO_HR_OVERVIEW_REPORT_READS__;
}

export function goHrEmployeeWritesUseGo(): boolean {
  return typeof __GO_HR_EMPLOYEE_WRITES__ !== "undefined" && __GO_HR_EMPLOYEE_WRITES__;
}

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

export async function fetchGoHrReport(signal?: AbortSignal): Promise<HrReport> {
  const response = await request("/api/capabilities/execute", {
    method: "POST",
    body: JSON.stringify({ capabilityId: "hr.report", input: {}, intentId: crypto.randomUUID() }),
  }, signal);
  if (!response.ok) throw await apiError(response, "people records");
  const parsed = z.object({ ok: z.literal(true), data: HrReportSchema }).strict().safeParse(await readJson(response));
  if (!parsed.success) throw new HrApiError(response.status, "The Go People service returned data in an unexpected format.");
  return parsed.data.data;
}

export async function readPendingHrLeaveAction(scope: HrRetryScope): Promise<HrLeaveAction | null> {
  const scoped = await hrLeaveScope(scope);
  let raw: string | null;
  try { raw = window.localStorage.getItem(`${GO_HR_LEAVE_ATTEMPT_PREFIX}${scoped.scopeHash}`); }
  catch { throw new HrApiError(0, "Enable browser storage to check for an unresolved leave action."); }
  if (raw === null) return null;
  return parseGoHrLeaveAttempt(raw).action;
}

export async function submitHrLeaveAction(
  action: HrLeaveAction,
  scope: HrRetryScope,
  signal?: AbortSignal,
  useGoOverride?: boolean,
): Promise<HrActionResult> {
  const useGo = useGoOverride ?? goHrLeaveUseGo();
  if (!useGo) {
    if (await readPendingHrLeaveAction(scope)) {
      throw new HrApiError(0, "A Go leave action is unresolved. Restore the Go leave route and retry that exact action before using the legacy route.", true);
    }
    return submitHrAction(action);
  }

  const scoped = await hrLeaveScope(scope);
  const attempt = await goHrLeaveAttempt(action, scoped.scopeHash);
  const { capabilityId, input } = goHrLeaveCapabilityInput(action);
  try {
    const response = await request("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({ capabilityId, input, intentId: attempt.intentId }),
    }, signal);
    const body = await readJson(response);
    if (response.status === 202) {
      const pending = z.object({ pendingApproval: z.literal(true), reason: z.string().optional(), error: z.string().optional() }).safeParse(body);
      if (!pending.success) throw new HrApiError(response.status, "The leave service returned an unexpected approval response.", true);
      return { kind: "pending", data: { reason: pending.data.reason ?? pending.data.error ?? "This leave action is waiting for approval." } };
    }
    if (!response.ok) {
      const mayHaveReachedServer = response.status === 404 || response.status >= 500 || response.status === 408 || response.status === 429;
      const apiFailure = parseError(response.status, body, "The Go leave service could not complete this action.");
      const failure = new HrApiError(response.status, apiFailure.message, mayHaveReachedServer);
      if (!mayHaveReachedServer && response.status < 500) await clearGoHrLeaveAttempt(attempt.storageKey);
      throw failure;
    }
    const parsed = z.object({ ok: z.literal(true), data: GoLeaveOutputSchemas[action.action] }).strict().safeParse(body);
    if (response.status !== 200 || !parsed.success) throw new HrApiError(response.status, "The Go leave service returned an unexpected action response.", true);
    await clearGoHrLeaveAttempt(attempt.storageKey);
    return { kind: "success", data: parsed.data.data };
  } catch (error) {
    if (error instanceof HrApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429 && !error.requestMayHaveReachedServer) {
      await clearGoHrLeaveAttempt(attempt.storageKey);
    }
    throw error;
  }
}

export async function readPendingHrPayrollAction(scope: HrRetryScope): Promise<HrPayrollAction | null> {
  const scoped = await hrPayrollScope(scope);
  let raw: string | null;
  try { raw = window.localStorage.getItem(`${GO_HR_PAYROLL_ATTEMPT_PREFIX}${scoped.scopeHash}`); }
  catch { throw new HrApiError(0, "Enable browser storage to check for an unresolved payroll draft."); }
  if (raw === null) return null;
  return parseGoHrPayrollAttempt(raw).action;
}

export async function submitHrPayrollAction(
  action: HrPayrollAction,
  scope: HrRetryScope,
  signal?: AbortSignal,
  useGoOverride?: boolean,
): Promise<HrActionResult> {
  const useGo = useGoOverride ?? goHrPayrollUseGo();
  if (!useGo) {
    if (await readPendingHrPayrollAction(scope)) {
      throw new HrApiError(0, "A Go payroll draft is unresolved. Restore the Go Payroll route and retry the exact action before using the legacy route.", true);
    }
    return submitHrAction(action);
  }

  const scoped = await hrPayrollScope(scope);
  const attempt = await goHrPayrollAttempt(action, scoped.scopeHash);
  try {
    const response = await request("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({ capabilityId: "hr.createPayrollRun", input: { year: action.year, month: action.month }, intentId: attempt.intentId }),
    }, signal);
    const body = await readJson(response);
    if (response.status === 202) {
      const pending = z.object({ pendingApproval: z.literal(true), reason: z.string().optional(), error: z.string().optional() }).safeParse(body);
      if (!pending.success) throw new HrApiError(response.status, "The payroll service returned an unexpected approval response.", true);
      return { kind: "pending", data: { reason: pending.data.reason ?? pending.data.error ?? "This payroll draft is waiting for approval." } };
    }
    if (!response.ok) {
      const mayHaveReachedServer = response.status === 404 || response.status >= 500 || response.status === 408 || response.status === 429;
      const apiFailure = parseError(response.status, body, "The Go payroll service could not create this draft.");
      const failure = new HrApiError(response.status, apiFailure.message, mayHaveReachedServer);
      if (!mayHaveReachedServer) await clearGoHrPayrollAttempt(attempt.storageKey);
      throw failure;
    }
    const parsed = z.object({ ok: z.literal(true), data: GoHrPayrollOutputSchema }).strict().safeParse(body);
    if (response.status !== 200 || !parsed.success) throw new HrApiError(response.status, "The Go payroll service returned an unexpected draft response.", true);
    await clearGoHrPayrollAttempt(attempt.storageKey);
    return { kind: "success", data: parsed.data.data };
  } catch (error) {
    if (error instanceof HrApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429 && !error.requestMayHaveReachedServer) {
      await clearGoHrPayrollAttempt(attempt.storageKey);
    }
    throw error;
  }
}

export async function readPendingHrHiringAction(scope: HrRetryScope): Promise<HrHiringAction | null> {
  const scoped = await hrHiringScope(scope);
  let raw: string | null;
  try { raw = window.localStorage.getItem(`${GO_HR_HIRING_ATTEMPT_PREFIX}${scoped.scopeHash}`); }
  catch { throw new HrApiError(0, "Enable browser storage to check for an unresolved Hiring action."); }
  if (raw === null) return null;
  return parseGoHrHiringAttempt(raw).action;
}

export async function submitHrHiringAction(
  action: HrHiringAction,
  scope: HrRetryScope,
  signal?: AbortSignal,
  useGoOverride?: boolean,
): Promise<HrActionResult> {
  const useGo = useGoOverride ?? goHrHiringUseGo();
  if (!useGo) {
    if (await readPendingHrHiringAction(scope)) {
      throw new HrApiError(0, "A Go Hiring action is unresolved. Restore the Go Hiring route and retry its exact details before using the legacy route.", true);
    }
    return submitHrAction(action);
  }

  const parsedAction = GoHrHiringActionSchema.safeParse(action);
  if (!parsedAction.success) throw new HrApiError(400, "The Hiring action does not match the Go service contract.");
  const scoped = await hrHiringScope(scope);
  const attempt = await goHrHiringAttempt(parsedAction.data, scoped.scopeHash);
  const capability = goHrHiringCapabilityInput(parsedAction.data);
  try {
    const response = await request("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({ ...capability, intentId: attempt.intentId }),
    }, signal);
    const body = await readJson(response);
    if (response.status === 202) {
      const pending = z.object({ pendingApproval: z.literal(true), reason: z.string().optional(), error: z.string().optional() }).safeParse(body);
      if (!pending.success) throw new HrApiError(response.status, "The Hiring service returned an unexpected approval response.", true);
      return { kind: "pending", data: { reason: pending.data.reason ?? pending.data.error ?? "This Hiring action is waiting for approval." } };
    }
    if (!response.ok) {
      const mayHaveReachedServer = response.status === 404 || response.status >= 500 || response.status === 408 || response.status === 429;
      const apiFailure = parseError(response.status, body, "The Go Hiring service could not complete this action.");
      const failure = new HrApiError(response.status, apiFailure.message, mayHaveReachedServer);
      if (!mayHaveReachedServer) await clearGoHrHiringAttempt(attempt.storageKey);
      throw failure;
    }
    const parsed = z.object({ ok: z.literal(true), data: GoHrHiringOutputSchemas[parsedAction.data.action] }).strict().safeParse(body);
    if (response.status !== 200 || !parsed.success) throw new HrApiError(response.status, "The Go Hiring service returned an unexpected action response.", true);
    await clearGoHrHiringAttempt(attempt.storageKey);
    return { kind: "success", data: parsed.data.data };
  } catch (error) {
    if (error instanceof HrApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429 && !error.requestMayHaveReachedServer) {
      await clearGoHrHiringAttempt(attempt.storageKey);
    }
    throw error;
  }
}

export async function readPendingHrEmployeeHireAction(scope: HrRetryScope): Promise<HrEmployeeHireAction | null> {
  const scoped = await hrEmployeeScope(scope);
  let raw: string | null;
  try { raw = window.localStorage.getItem(`${GO_HR_EMPLOYEE_ATTEMPT_PREFIX}${scoped.scopeHash}`); }
  catch { throw new HrApiError(0, "Enable browser storage to check for an unresolved employee hire."); }
  if (raw === null) return null;
  return parseGoHrEmployeeHireAttempt(raw).action;
}

export async function submitHrEmployeeHireAction(
  action: HrEmployeeHireAction,
  scope: HrRetryScope,
  signal?: AbortSignal,
  useGoOverride?: boolean,
): Promise<HrActionResult> {
  const useGo = useGoOverride ?? goHrEmployeeWritesUseGo();
  if (!useGo) {
    if (await readPendingHrEmployeeHireAction(scope)) {
      throw new HrApiError(0, "A Go employee hire is unresolved. Restore the Go employee route and retry its exact details before using the legacy route.", true);
    }
    return submitHrAction(action);
  }

  const parsedAction = GoHrEmployeeHireActionSchema.safeParse(action);
  if (!parsedAction.success) throw new HrApiError(400, "The employee hire does not match the Go service contract.");
  const scoped = await hrEmployeeScope(scope);
  const attempt = await goHrEmployeeHireAttempt(parsedAction.data, scoped.scopeHash);
  try {
    const response = await request("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({ capabilityId: "hr.hireEmployee", input: hrEmployeeHireCapabilityInput(parsedAction.data), intentId: attempt.intentId }),
    }, signal);
    const body = await readJson(response);
    if (response.status === 202) {
      const pending = z.object({ pendingApproval: z.literal(true), reason: z.string().optional(), error: z.string().optional() }).safeParse(body);
      if (!pending.success) throw new HrApiError(response.status, "The Go People service returned an unexpected approval response.", true);
      return { kind: "pending", data: { reason: pending.data.reason ?? pending.data.error ?? "This employee hire is waiting for approval." } };
    }
    if (!response.ok) {
      const mayHaveReachedServer = response.status === 404 || response.status >= 500 || response.status === 408 || response.status === 429;
      const apiFailure = parseError(response.status, body, "The Go People service could not hire this employee.");
      const failure = new HrApiError(response.status, apiFailure.message, mayHaveReachedServer);
      if (!mayHaveReachedServer) await clearGoHrEmployeeHireAttempt(attempt.storageKey);
      throw failure;
    }
    const parsed = z.object({ ok: z.literal(true), data: GoHrEmployeeHireOutputSchema }).strict().safeParse(body);
    if (response.status !== 200 || !parsed.success) throw new HrApiError(response.status, "The Go People service returned an unexpected employee hire response.", true);
    await clearGoHrEmployeeHireAttempt(attempt.storageKey);
    return { kind: "success", data: parsed.data.data };
  } catch (error) {
    if (error instanceof HrApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429 && !error.requestMayHaveReachedServer) {
      await clearGoHrEmployeeHireAttempt(attempt.storageKey);
    }
    throw error;
  }
}

function hrEmployeeHireCapabilityInput(action: HrEmployeeHireAction): Omit<HrEmployeeHireAction, "action"> {
  const { action: _action, ...input } = action;
  return input;
}

async function hrEmployeeScope(scope: HrRetryScope): Promise<{ actorId: string; organizationId: string; scopeHash: string }> {
  const actorId = scope.actorId?.trim() ?? "";
  const organizationId = scope.organizationId?.trim() ?? "";
  if (!z.string().uuid().safeParse(actorId).success || !z.string().uuid().safeParse(organizationId).success) {
    throw new HrApiError(0, "Employee hires need your account and organization details before they can be submitted.");
  }
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ actorId, organizationId })));
    return { actorId, organizationId, scopeHash: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("") };
  } catch {
    throw new HrApiError(0, "Could not prepare a durable employee hire retry.");
  }
}

async function goHrEmployeeHireAttempt(action: HrEmployeeHireAction, scopeHash: string): Promise<{ storageKey: string; intentId: string }> {
  const storageKey = `${GO_HR_EMPLOYEE_ATTEMPT_PREFIX}${scopeHash}`;
  const fingerprint = await goHrEmployeeHireFingerprint(action);
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new HrApiError(0, "Enable browser storage before hiring so uncertain actions can be retried safely."); }
  if (raw !== null) {
    const stored = parseGoHrEmployeeHireAttempt(raw);
    if (stored.fingerprint !== fingerprint) throw new HrApiError(0, "A previous employee hire is unresolved. Retry its exact details before starting another hire.", true);
    return { storageKey, intentId: stored.intentId };
  }
  const attempt = { fingerprint, intentId: crypto.randomUUID(), action };
  const serialized = JSON.stringify(attempt);
  try {
    window.localStorage.setItem(storageKey, serialized);
    if (window.localStorage.getItem(storageKey) !== serialized) throw new Error("employee hire retry did not persist");
  } catch {
    throw new HrApiError(0, "Enable browser storage before hiring so uncertain actions can be retried safely.");
  }
  return { storageKey, intentId: attempt.intentId };
}

async function goHrEmployeeHireFingerprint(action: HrEmployeeHireAction): Promise<string> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJSON(action)));
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  } catch {
    throw new HrApiError(0, "Could not prepare a durable employee hire retry.");
  }
}

function parseGoHrEmployeeHireAttempt(raw: string): z.infer<typeof GoHrEmployeeHireAttemptSchema> {
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch { throw new HrApiError(0, "An unresolved employee hire marker is malformed. Contact an administrator before retrying.", true); }
  const parsed = GoHrEmployeeHireAttemptSchema.safeParse(decoded);
  if (!parsed.success) throw new HrApiError(0, "An unresolved employee hire marker is malformed. Contact an administrator before retrying.", true);
  return parsed.data;
}

async function clearGoHrEmployeeHireAttempt(storageKey: string): Promise<void> {
  try { window.localStorage.removeItem(storageKey); }
  catch { throw new HrApiError(0, "The employee hire completed, but its retry marker could not be cleared. Reload before another hire.", true); }
}

function goHrHiringCapabilityInput(action: HrHiringAction): { capabilityId: string; input: Record<string, unknown> } {
  switch (action.action) {
    case "createOpening": {
      const { action: _action, ...input } = action;
      return { capabilityId: "hr.createOpening", input };
    }
    case "addApplicant": {
      const { action: _action, ...input } = action;
      return { capabilityId: "hr.addApplicant", input };
    }
    case "moveApplicant": {
      const { action: _action, ...input } = action;
      return { capabilityId: "hr.moveApplicant", input };
    }
  }
}

async function hrHiringScope(scope: HrRetryScope): Promise<{ actorId: string; organizationId: string; scopeHash: string }> {
  const actorId = scope.actorId?.trim() ?? "";
  const organizationId = scope.organizationId?.trim() ?? "";
  if (!z.string().uuid().safeParse(actorId).success || !z.string().uuid().safeParse(organizationId).success) {
    throw new HrApiError(0, "Hiring actions need your account and organization details before they can be submitted.");
  }
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ actorId, organizationId })));
    return { actorId, organizationId, scopeHash: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("") };
  } catch {
    throw new HrApiError(0, "Could not prepare a durable Hiring retry.");
  }
}

async function goHrHiringAttempt(action: HrHiringAction, scopeHash: string): Promise<{ storageKey: string; intentId: string }> {
  const storageKey = `${GO_HR_HIRING_ATTEMPT_PREFIX}${scopeHash}`;
  const fingerprint = await goHrHiringFingerprint(action);
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new HrApiError(0, "Enable browser storage before changing Hiring so uncertain actions can be retried safely."); }
  if (raw !== null) {
    const stored = parseGoHrHiringAttempt(raw);
    if (stored.fingerprint !== fingerprint) throw new HrApiError(0, "A previous Hiring action is unresolved. Retry its exact details before starting another action.", true);
    return { storageKey, intentId: stored.intentId };
  }
  const attempt = { fingerprint, intentId: crypto.randomUUID(), action };
  const serialized = JSON.stringify(attempt);
  try {
    window.localStorage.setItem(storageKey, serialized);
    if (window.localStorage.getItem(storageKey) !== serialized) throw new Error("Hiring retry did not persist");
  } catch {
    throw new HrApiError(0, "Enable browser storage before changing Hiring so uncertain actions can be retried safely.");
  }
  return { storageKey, intentId: attempt.intentId };
}

async function goHrHiringFingerprint(action: HrHiringAction): Promise<string> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJSON(action)));
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  } catch {
    throw new HrApiError(0, "Could not prepare a durable Hiring retry.");
  }
}

function parseGoHrHiringAttempt(raw: string): z.infer<typeof GoHrHiringAttemptSchema> {
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch { throw new HrApiError(0, "An unresolved Hiring action marker is malformed. Contact an administrator before retrying.", true); }
  const parsed = GoHrHiringAttemptSchema.safeParse(decoded);
  if (!parsed.success) throw new HrApiError(0, "An unresolved Hiring action marker is malformed. Contact an administrator before retrying.", true);
  return parsed.data;
}

async function clearGoHrHiringAttempt(storageKey: string): Promise<void> {
  try { window.localStorage.removeItem(storageKey); }
  catch { throw new HrApiError(0, "The Hiring action completed, but its retry marker could not be cleared. Reload before another action.", true); }
}

async function hrPayrollScope(scope: HrRetryScope): Promise<{ actorId: string; organizationId: string; scopeHash: string }> {
  const actorId = scope.actorId?.trim() ?? "";
  const organizationId = scope.organizationId?.trim() ?? "";
  if (!z.string().uuid().safeParse(actorId).success || !z.string().uuid().safeParse(organizationId).success) {
    throw new HrApiError(0, "Payroll drafts need your account and organization details before they can be submitted.");
  }
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ actorId, organizationId })));
    return { actorId, organizationId, scopeHash: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("") };
  } catch {
    throw new HrApiError(0, "Could not prepare a durable payroll retry.");
  }
}

async function goHrPayrollAttempt(action: HrPayrollAction, scopeHash: string): Promise<{ storageKey: string; intentId: string }> {
  const storageKey = `${GO_HR_PAYROLL_ATTEMPT_PREFIX}${scopeHash}`;
  const parsedAction = GoHrPayrollActionSchema.safeParse(action);
  if (!parsedAction.success) throw new HrApiError(400, "The payroll draft does not match the Go service contract.");
  const fingerprint = await goHrPayrollFingerprint(parsedAction.data);
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new HrApiError(0, "Enable browser storage before creating payroll so uncertain drafts can be retried safely."); }
  if (raw !== null) {
    const stored = parseGoHrPayrollAttempt(raw);
    if (stored.fingerprint !== fingerprint) throw new HrApiError(0, "A previous payroll draft is unresolved. Retry its exact period before starting another draft.", true);
    return { storageKey, intentId: stored.intentId };
  }
  const attempt = { fingerprint, intentId: crypto.randomUUID(), action: parsedAction.data };
  const serialized = JSON.stringify(attempt);
  try {
    window.localStorage.setItem(storageKey, serialized);
    if (window.localStorage.getItem(storageKey) !== serialized) throw new Error("payroll retry did not persist");
  } catch {
    throw new HrApiError(0, "Enable browser storage before creating payroll so uncertain drafts can be retried safely.");
  }
  return { storageKey, intentId: attempt.intentId };
}

async function goHrPayrollFingerprint(action: HrPayrollAction): Promise<string> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJSON(action)));
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  } catch {
    throw new HrApiError(0, "Could not prepare a durable payroll retry.");
  }
}

function parseGoHrPayrollAttempt(raw: string): z.infer<typeof GoHrPayrollAttemptSchema> {
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch { throw new HrApiError(0, "An unresolved payroll draft marker is malformed. Contact an administrator before retrying.", true); }
  const parsed = GoHrPayrollAttemptSchema.safeParse(decoded);
  if (!parsed.success) throw new HrApiError(0, "An unresolved payroll draft marker is malformed. Contact an administrator before retrying.", true);
  return parsed.data;
}

async function clearGoHrPayrollAttempt(storageKey: string): Promise<void> {
  try { window.localStorage.removeItem(storageKey); }
  catch { throw new HrApiError(0, "The payroll draft completed, but its retry marker could not be cleared. Reload before another draft.", true); }
}

async function hrLeaveScope(scope: HrRetryScope): Promise<{ actorId: string; organizationId: string; scopeHash: string }> {
  const actorId = scope.actorId?.trim() ?? "";
  const organizationId = scope.organizationId?.trim() ?? "";
  if (!z.string().uuid().safeParse(actorId).success || !z.string().uuid().safeParse(organizationId).success) {
    throw new HrApiError(0, "Leave actions are waiting for your account and organization details. Wait for your organization to finish loading, then try again.");
  }
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ actorId, organizationId })));
    return { actorId, organizationId, scopeHash: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("") };
  } catch {
    throw new HrApiError(0, "Could not prepare a durable leave retry. Check browser security settings and try again.");
  }
}

async function goHrLeaveAttempt(action: HrLeaveAction, scopeHash: string): Promise<{ storageKey: string; intentId: string }> {
  const storageKey = `${GO_HR_LEAVE_ATTEMPT_PREFIX}${scopeHash}`;
  const fingerprint = await goHrLeaveFingerprint(action);
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new HrApiError(0, "Enable browser storage before changing leave so uncertain actions can be retried safely."); }
  if (raw !== null) {
    const stored = parseGoHrLeaveAttempt(raw);
    if (stored.fingerprint !== fingerprint) throw new HrApiError(0, "A previous leave action is unresolved. Retry its exact details before starting another action.", true);
    return { storageKey, intentId: stored.intentId };
  }
  const attempt = { fingerprint, intentId: crypto.randomUUID(), action };
  const serialized = JSON.stringify(attempt);
  try {
    window.localStorage.setItem(storageKey, serialized);
    if (window.localStorage.getItem(storageKey) !== serialized) throw new Error("leave retry did not persist");
  } catch {
    throw new HrApiError(0, "Enable browser storage before changing leave so uncertain actions can be retried safely.");
  }
  return { storageKey, intentId: attempt.intentId };
}

async function goHrLeaveFingerprint(action: HrLeaveAction): Promise<string> {
  try {
    const canonical = canonicalJSON(action);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  } catch {
    throw new HrApiError(0, "Could not prepare a durable leave retry. Check browser security settings and try again.");
  }
}

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJSON(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function parseGoHrLeaveAttempt(raw: string): z.infer<typeof GoLeaveAttemptSchema> {
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch { throw new HrApiError(0, "An unresolved leave action marker is malformed. Contact an administrator before retrying.", true); }
  const parsed = GoLeaveAttemptSchema.safeParse(decoded);
  if (!parsed.success) throw new HrApiError(0, "An unresolved leave action marker is malformed. Contact an administrator before retrying.", true);
  return parsed.data;
}

async function clearGoHrLeaveAttempt(storageKey: string): Promise<void> {
  try { window.localStorage.removeItem(storageKey); }
  catch { throw new HrApiError(0, "The leave action completed, but its retry marker could not be cleared. Reload the page before another action.", true); }
}

function goHrLeaveCapabilityInput(action: HrLeaveAction): { capabilityId: string; input: Record<string, unknown> } {
  switch (action.action) {
    case "requestLeave": {
      const { action: _action, ...input } = action;
      return { capabilityId: "hr.requestLeave", input };
    }
    case "decideLeave": {
      const { action: _action, ...input } = action;
      return { capabilityId: "hr.decideLeave", input };
    }
    case "cancelLeave": {
      const { action: _action, ...input } = action;
      return { capabilityId: "hr.cancelLeave", input };
    }
  }
}

export async function fetchHrTime(from: string, to: string, signal?: AbortSignal): Promise<HrTimeReport> {
  if (goHrTimeUseGo()) {
    const response = await request("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({ capabilityId: "hr.timeReport", input: { from, to }, intentId: crypto.randomUUID() }),
    }, signal);
    if (!response.ok) throw await apiError(response, "time report");
    const parsed = z.object({ ok: z.literal(true), data: TimeReportSchema }).strict().safeParse(await readJson(response));
    if (!parsed.success) throw new HrApiError(response.status, "The Go time service returned data in an unexpected format.");
    return parsed.data.data;
  }
  const query = new URLSearchParams({ from, to });
  const response = await request(`/api/time?${query.toString()}`, { method: "GET" }, signal);
  if (!response.ok) throw await apiError(response, "time report");
  const parsed = TimeReportSchema.safeParse(await readJson(response));
  if (!parsed.success) throw new HrApiError(response.status, "The time service returned data in an unexpected format.");
  return parsed.data;
}

export async function fetchHrPendingEntries(signal?: AbortSignal): Promise<HrPendingEntry[]> {
  if (goHrTimeUseGo()) {
    const response = await request("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({ capabilityId: "hr.pendingTimeEntries", input: {}, intentId: crypto.randomUUID() }),
    }, signal);
    if (!response.ok) throw await apiError(response, "pending time entries");
    const parsed = GoPendingEntriesSchema.safeParse(await parseCapabilityData(response));
    if (!parsed.success) throw new HrApiError(response.status, "The Go time service returned pending entries in an unexpected format.");
    return parsed.data.entries;
  }
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

export async function readPendingHrTimeAction(scope: HrRetryScope): Promise<HrTimeAction | null> {
  const scoped = await hrTimeScope(scope);
  let raw: string | null;
  try { raw = window.localStorage.getItem(`${GO_HR_TIME_ATTEMPT_PREFIX}${scoped.scopeHash}`); }
  catch { throw new HrApiError(0, "Enable browser storage to check for an unresolved time action."); }
  if (raw === null) return null;
  return parseGoHrTimeAttempt(raw).action;
}

export async function submitHrTimeAction(
  action: HrTimeAction,
  scope?: HrRetryScope,
  signal?: AbortSignal,
  useGoOverride?: boolean,
): Promise<HrActionResult> {
  const useGo = useGoOverride ?? goHrTimeUseGo();
  if (!useGo) {
    if (scope && await readPendingHrTimeAction(scope)) {
      throw new HrApiError(0, "A Go time action is unresolved. Restore the Go time route and retry that exact action before using the legacy route.", true);
    }
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

  if (!scope) throw new HrApiError(0, "Time actions need your account and organization details before they can be submitted.");
  const scoped = await hrTimeScope(scope);
  const attempt = await goHrTimeAttempt(action, scoped.scopeHash);
  const { capabilityId, input } = goHrTimeCapabilityInput(action);
  try {
    const response = await request("/api/capabilities/execute", {
      method: "POST",
      body: JSON.stringify({ capabilityId, input, intentId: attempt.intentId }),
    }, signal);
    const body = await readJson(response);
    if (response.status === 202) {
      const pending = z.object({ pendingApproval: z.literal(true), reason: z.string().optional(), error: z.string().optional() }).safeParse(body);
      if (!pending.success) throw new HrApiError(response.status, "The time action returned an unexpected approval response.", true);
      return { kind: "pending", data: { reason: pending.data.reason ?? pending.data.error ?? "This time action is waiting for approval." } };
    }
    if (!response.ok) {
      const mayHaveReachedServer = response.status === 404 || response.status >= 500 || response.status === 408 || response.status === 429;
      const apiFailure = parseError(response.status, body, "The Go time service could not complete this action.");
      const failure = new HrApiError(response.status, apiFailure.message, mayHaveReachedServer);
      if (!mayHaveReachedServer) await clearGoHrTimeAttempt(attempt.storageKey);
      throw failure;
    }
    const parsed = z.object({ ok: z.literal(true), data: GoTimeOutputSchemas[action.action] }).strict().safeParse(body);
    if (response.status !== 200 || !parsed.success) throw new HrApiError(response.status, "The Go time service returned an unexpected action response.", true);
    await clearGoHrTimeAttempt(attempt.storageKey);
    return { kind: "success", data: parsed.data.data };
  } catch (error) {
    if (error instanceof HrApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429 && !error.requestMayHaveReachedServer) {
      await clearGoHrTimeAttempt(attempt.storageKey);
    }
    throw error;
  }
}

async function parseCapabilityData(response: Response): Promise<unknown> {
  const parsed = z.object({ ok: z.literal(true), data: z.unknown() }).strict().safeParse(await readJson(response));
  if (!parsed.success) throw new HrApiError(response.status, "The Go time service returned an unexpected response.");
  return parsed.data.data;
}

async function hrTimeScope(scope: HrRetryScope): Promise<{ actorId: string; organizationId: string; scopeHash: string }> {
  const actorId = scope.actorId?.trim() ?? "";
  const organizationId = scope.organizationId?.trim() ?? "";
  if (!z.string().uuid().safeParse(actorId).success || !z.string().uuid().safeParse(organizationId).success) {
    throw new HrApiError(0, "Time actions are waiting for your account and organization details. Wait for your organization to finish loading, then try again.");
  }
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ actorId, organizationId })));
    return { actorId, organizationId, scopeHash: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("") };
  } catch {
    throw new HrApiError(0, "Could not prepare a durable time retry. Check browser security settings and try again.");
  }
}

async function goHrTimeAttempt(action: HrTimeAction, scopeHash: string): Promise<{ storageKey: string; intentId: string }> {
  const storageKey = `${GO_HR_TIME_ATTEMPT_PREFIX}${scopeHash}`;
  const parsedAction = GoTimeActionSchema.safeParse(action);
  if (!parsedAction.success) throw new HrApiError(400, "The time action does not match the Go service contract.");
  const fingerprint = await goHrTimeFingerprint(parsedAction.data);
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new HrApiError(0, "Enable browser storage before changing time so uncertain actions can be retried safely."); }
  if (raw !== null) {
    const stored = parseGoHrTimeAttempt(raw);
    if (stored.fingerprint !== fingerprint) throw new HrApiError(0, "A previous time action is unresolved. Retry its exact details before starting another action.", true);
    return { storageKey, intentId: stored.intentId };
  }
  const attempt = { fingerprint, intentId: crypto.randomUUID(), action: parsedAction.data };
  const serialized = JSON.stringify(attempt);
  try {
    window.localStorage.setItem(storageKey, serialized);
    if (window.localStorage.getItem(storageKey) !== serialized) throw new Error("time retry did not persist");
  } catch {
    throw new HrApiError(0, "Enable browser storage before changing time so uncertain actions can be retried safely.");
  }
  return { storageKey, intentId: attempt.intentId };
}

async function goHrTimeFingerprint(action: HrTimeAction): Promise<string> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJSON(action)));
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  } catch {
    throw new HrApiError(0, "Could not prepare a durable time retry. Check browser security settings and try again.");
  }
}

function parseGoHrTimeAttempt(raw: string): z.infer<typeof GoTimeAttemptSchema> {
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch { throw new HrApiError(0, "An unresolved time action marker is malformed. Contact an administrator before retrying.", true); }
  const parsed = GoTimeAttemptSchema.safeParse(decoded);
  if (!parsed.success) throw new HrApiError(0, "An unresolved time action marker is malformed. Contact an administrator before retrying.", true);
  return parsed.data;
}

async function clearGoHrTimeAttempt(storageKey: string): Promise<void> {
  try { window.localStorage.removeItem(storageKey); }
  catch { throw new HrApiError(0, "The time action completed, but its retry marker could not be cleared. Reload the page before another action.", true); }
}

function goHrTimeCapabilityInput(action: HrTimeAction): { capabilityId: string; input: Record<string, unknown> } {
  if (action.action === "log") {
    const { action: _action, ...input } = action;
    return { capabilityId: "hr.logTime", input };
  }
  return { capabilityId: "hr.decideTimeEntry", input: { entryId: action.entryId, decision: action.decision === "approve" ? "approved" : "rejected" } };
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
