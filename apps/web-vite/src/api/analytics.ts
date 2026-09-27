import { z } from "zod";

const DatasetSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string(),
});

const DatasetListSchema = z.object({ datasets: z.array(DatasetSchema) });

const DatasetPreviewSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
});

const ChartSchema = z.object({
  type: z.enum(["bar", "line", "area", "pie"]),
  x: z.string().min(1),
  y: z.array(z.string().min(1)).min(1).max(3),
});

const ReportInputSchema = z.object({
  title: z.string().min(1).max(200),
  narrative: z.string().max(6000).optional(),
  sections: z.array(z.object({
    heading: z.string().min(1).max(200),
    datasetId: z.string().regex(/^analytics\.[a-zA-Z]+$/),
    params: z.record(z.string(), z.unknown()),
    ops: z.array(z.never()).max(10),
    chart: ChartSchema.optional(),
  })).min(1).max(8),
});

const ReportSectionSchema = z.object({
  heading: z.string(),
  svg: z.string().nullable(),
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
});

const ReportSchema = z.object({
  region: z.string().nullable(),
  html: z.string(),
  sections: z.array(ReportSectionSchema),
});

const ModuleSwitchboardSchema = z.object({
  catalog: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string(),
    href: z.string().nullable(),
  })),
  enabledModules: z.array(z.string().min(1)),
  usingDefaults: z.boolean(),
});

const ApiErrorBodySchema = z.object({ error: z.string().optional(), message: z.string().optional() });

export type AnalyticsDataset = z.infer<typeof DatasetSchema>;
export type AnalyticsPreview = z.infer<typeof DatasetPreviewSchema>;
export type AnalyticsChartType = z.infer<typeof ChartSchema>["type"];
export type AnalyticsReportInput = z.infer<typeof ReportInputSchema>;
export type AnalyticsReport = z.infer<typeof ReportSchema>;

export class AnalyticsApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "AnalyticsApiError";
  }
}

function requestSignal(signal?: AbortSignal, timeoutMs = 30_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function responseMessage(status: number, raw: unknown): string {
  const body = ApiErrorBodySchema.safeParse(raw);
  const serverMessage = body.success ? body.data.error ?? body.data.message : undefined;
  if (status === 401) return "Your session has ended. Sign in again to continue.";
  if (status === 403) return "You do not have permission to access this analytics data.";
  if (status === 404) return "This analytics dataset is no longer available.";
  if (status >= 500) return "The analytics service is unavailable. Try again.";
  if (serverMessage && serverMessage.length <= 240 && !/[{}<>]/.test(serverMessage)) return serverMessage;
  return "The analytics request could not be completed. Try again.";
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new AnalyticsApiError(response.status, "The analytics service returned an unreadable response.");
  }
}

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new AnalyticsApiError(0, "The analytics service took too long to respond. Try again.");
    }
    throw new AnalyticsApiError(0, "Could not reach the analytics service. Check your connection and try again.");
  }
  const raw = await readJson(response);
  if (!response.ok) throw new AnalyticsApiError(response.status, responseMessage(response.status, raw));
  return raw;
}

function parseResponse<T>(schema: z.ZodType<T>, raw: unknown, name: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AnalyticsApiError(200, `The ${name} returned data in an unexpected format.`);
  return parsed.data;
}

export async function fetchAnalyticsEnabled(signal?: AbortSignal): Promise<boolean> {
  const switchboard = parseResponse(
    ModuleSwitchboardSchema,
    await getJson("/api/modules", signal),
    "module switchboard",
  );
  const catalogIds = new Set(switchboard.catalog.map((module) => module.id));
  if (!catalogIds.has("analytics")) {
    throw new AnalyticsApiError(200, "The module switchboard omitted the analytics module.");
  }
  if (switchboard.enabledModules.some((id) => !catalogIds.has(id))) {
    throw new AnalyticsApiError(200, "The module switchboard returned an unknown module.");
  }
  return switchboard.enabledModules.includes("analytics");
}

export async function fetchAnalyticsDatasets(signal?: AbortSignal): Promise<AnalyticsDataset[]> {
  const parsed = parseResponse(DatasetListSchema, await getJson("/api/analytics", signal), "analytics service");
  return parsed.datasets;
}

export async function fetchAnalyticsPreview(datasetId: string, signal?: AbortSignal): Promise<AnalyticsPreview> {
  const parsedId = z.string().regex(/^analytics\.[a-zA-Z]+$/).safeParse(datasetId);
  if (!parsedId.success) throw new AnalyticsApiError(0, "Choose a valid analytics dataset to preview.");

  const query = new URLSearchParams({ dataset: parsedId.data });
  return parseResponse(
    DatasetPreviewSchema,
    await getJson(`/api/analytics?${query.toString()}`, signal),
    "analytics preview",
  );
}

export async function generateAnalyticsReport(input: AnalyticsReportInput, signal?: AbortSignal): Promise<AnalyticsReport> {
  const parsedInput = ReportInputSchema.safeParse(input);
  if (!parsedInput.success) throw new AnalyticsApiError(0, "The report needs a title and at least one valid section.");

  let response: Response;
  try {
    response = await fetch("/api/analytics", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(parsedInput.data),
      signal: requestSignal(signal, 60_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new AnalyticsApiError(0, "Report generation took too long. Try again.");
    }
    throw new AnalyticsApiError(0, "Could not reach the analytics service. Check your connection and try again.");
  }

  const raw = await readJson(response);
  if (!response.ok) throw new AnalyticsApiError(response.status, responseMessage(response.status, raw));
  return parseResponse(ReportSchema, raw, "analytics report");
}

export function analyticsReportFilename(title: string): string {
  return `${title.trim().replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "report"}.html`;
}
