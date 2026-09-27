import { z } from "zod";

const MinorUnitsSchema = z.number().int().safe();
const CountSchema = z.number().int().nonnegative().safe();

export const DashboardResponseSchema = z.object({
  signals: z.array(z.object({
    id: z.string().min(1),
    severity: z.enum(["red", "orange", "green"]),
    module: z.string().min(1),
    subject: z.string(),
    detail: z.string(),
  })).optional(),
  money: z.object({
    revenueMinor: MinorUnitsSchema,
    expenseMinor: MinorUnitsSchema,
    netIncomeMinor: MinorUnitsSchema,
    cashMinor: MinorUnitsSchema.nullable(),
    balanced: z.boolean().nullable(),
    assetsMinor: MinorUnitsSchema,
    liabilitiesMinor: MinorUnitsSchema,
    equityMinor: MinorUnitsSchema,
  }),
  workingCapital: z.object({
    arOutstandingMinor: MinorUnitsSchema,
    overdueCount: CountSchema,
    overdueAmountMinor: MinorUnitsSchema,
    apOutstandingMinor: MinorUnitsSchema,
  }),
  pipeline: z.object({
    stages: z.array(z.object({
      stage: z.enum(["lead", "qualified", "proposal", "negotiation", "won", "lost"]),
      count: CountSchema,
      valueMinor: MinorUnitsSchema,
    })),
    openCount: CountSchema,
    weightedForecastMinor: MinorUnitsSchema,
  }),
  ops: z.object({
    headcount: CountSchema,
    pendingLeave: CountSchema,
    posOpen: z.object({ register: z.string() }).nullable(),
    lowStock: z.array(z.object({ sku: z.string(), name: z.string() })),
    pendingApprovals: CountSchema,
    docsParsed: CountSchema,
    docsAwaitingCoding: CountSchema,
  }),
  trend: z.array(z.object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    incomeMinor: MinorUnitsSchema,
    expenseMinor: MinorUnitsSchema,
  })),
  activity: z.array(z.object({
    seq: CountSchema,
    kind: z.string(),
    capabilityId: z.string().nullable(),
    actorType: z.string(),
    occurredAt: z.string().datetime({ offset: true }),
  })),
});

const SetupItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  why: z.string(),
  href: z.string().refine((value) => {
    if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return false;
    try {
      return new URL(value, "https://chaste.invalid").origin === "https://chaste.invalid";
    } catch {
      return false;
    }
  }, "Expected a local path"),
  done: z.boolean(),
});

export const SetupResponseSchema = z.object({
  items: z.array(SetupItemSchema),
  remaining: CountSchema,
});

const LocalPathSchema = z.string().refine((value) => {
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return false;
  try {
    return new URL(value, "https://chaste.invalid").origin === "https://chaste.invalid";
  } catch {
    return false;
  }
}, "Expected a local path");

export const WorkCardSchema = z.object({
  kind: z.enum(["approval", "receipt_remainder", "signal"]),
  id: z.string().min(1),
  title: z.string().min(1),
  detail: z.string(),
  whyItMatters: z.string(),
  actionLabel: z.string().min(1),
  actionHref: LocalPathSchema,
  createdAt: z.string().datetime({ offset: true }).nullable(),
  rank: CountSchema,
});

const MyWorkResponseSchema = z.object({
  cards: z.array(WorkCardSchema).max(30),
  generatedAt: z.string().datetime({ offset: true }),
});

const WorkBriefInputSchema = z.object({
  cards: z.array(z.object({
    kind: z.string().min(1),
    title: z.string().min(1),
    detail: z.string(),
  })).min(1).max(30),
});

const WorkBriefResponseSchema = z.object({
  brief: z.string().min(1),
  model: z.string().optional(),
});

const ApiErrorBodySchema = z.object({
  hint: z.string().optional(),
  error: z.string().optional(),
});

export type DashboardData = z.infer<typeof DashboardResponseSchema>;
export type SetupItem = z.infer<typeof SetupItemSchema>;
export type WorkCard = z.infer<typeof WorkCardSchema>;

export class DashboardApiError extends Error {
  constructor(readonly status: number, message: string, readonly hint?: string) {
    super(message);
    this.name = "DashboardApiError";
  }
}

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const message = response.status === 401
      ? "Your session has expired. Sign in again to continue."
      : response.status === 428
        ? "Finish setting up your workspace to see its dashboard."
        : response.status === 403
          ? "Your account does not have access to this information."
          : "The dashboard service is unavailable. Try again.";
    throw new DashboardApiError(response.status, message, await readApiHint(response));
  }
  try {
    return await response.json();
  } catch {
    throw new DashboardApiError(response.status, "The dashboard service returned an unreadable response.");
  }
}

async function readApiHint(response: Response): Promise<string | undefined> {
  const body = await response.json().catch(() => null);
  const parsed = ApiErrorBodySchema.safeParse(body);
  return parsed.success ? parsed.data.hint : undefined;
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const message = response.status === 401
      ? "Your session has expired. Sign in again to continue."
      : "The work brief is unavailable right now. The ranked list is still available.";
    throw new DashboardApiError(response.status, message, await readApiHint(response));
  }
  try {
    return await response.json();
  } catch {
    throw new DashboardApiError(response.status, "The work brief service returned an unreadable response.");
  }
}

export async function fetchDashboard(signal?: AbortSignal): Promise<DashboardData> {
  const response = await getJson("/api/dashboard", signal);
  const parsed = DashboardResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new DashboardApiError(200, "The dashboard service returned data in an unexpected format.");
  }
  return parsed.data;
}

export async function fetchSetup(signal?: AbortSignal): Promise<SetupItem[]> {
  const response = await getJson("/api/setup", signal);
  const parsed = SetupResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new DashboardApiError(200, "The setup service returned data in an unexpected format.");
  }
  return parsed.data.items;
}

export async function fetchMyWork(signal?: AbortSignal): Promise<WorkCard[]> {
  const response = await getJson("/api/my-work", signal);
  const parsed = MyWorkResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new DashboardApiError(200, "The work queue returned data in an unexpected format.");
  }
  return parsed.data.cards;
}

export async function summarizeWork(cards: WorkCard[]): Promise<string> {
  const request = WorkBriefInputSchema.parse({
    cards: cards.map(({ kind, title, detail }) => ({ kind, title, detail })),
  });
  const response = await postJson("/api/my-work/summarize", request);
  const parsed = WorkBriefResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new DashboardApiError(200, "The work brief service returned data in an unexpected format.");
  }
  return parsed.data.brief;
}
