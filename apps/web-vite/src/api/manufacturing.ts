import { z } from "zod";

// The catalog entries carry label, description, href, and protected alongside
// id, so this must not be strict or a real switchboard response is rejected.
const ModuleSwitchboardSchema = z.object({
  catalog: z.array(z.object({ id: z.string().min(1) }).passthrough()),
  enabledModules: z.array(z.string()),
}).passthrough();

const BomEdgeSchema = z.object({
  assemblySku: z.string(),
  componentSku: z.string(),
  componentName: z.string(),
  quantityThousandths: z.number().int().safe(),
  scrapPctThousandths: z.number().int().safe(),
}).strict();

const AssemblySchema = z.object({ sku: z.string(), name: z.string() }).strict();

const WorkOrderSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  assemblySku: z.string(),
  assemblyName: z.string(),
  status: z.string(),
  plannedQtyThousandths: z.number().int().safe(),
  producedQtyThousandths: z.number().int().safe(),
  yieldPctThousandths: z.number().int().safe(),
  expectedGoodThousandths: z.number().int().safe(),
  note: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

const ProductionRunComponentSchema = z.object({
  sku: z.string(),
  quantityThousandths: z.number().int().safe(),
  lotCode: z.string().nullable(),
}).strict();

const ProductionRunSchema = z.object({
  runId: z.string(),
  occurredAt: z.string().datetime({ offset: true }),
  assemblySku: z.string(),
  producedThousandths: z.number().int().safe(),
  unitCostMinor: z.number().int().safe(),
  costTotalMinor: z.number().int().safe(),
  reversed: z.boolean(),
  components: z.array(ProductionRunComponentSchema),
}).strict();

const LotSchema = z.object({
  id: z.string(),
  sku: z.string(),
  lotCode: z.string(),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  balanceThousandths: z.number().int().safe(),
}).strict();

const ManufacturingReportSchema = z.object({
  boms: z.array(BomEdgeSchema).default([]),
  assemblies: z.array(AssemblySchema).default([]),
  workOrders: z.array(WorkOrderSchema).default([]),
  productionRuns: z.array(ProductionRunSchema).default([]),
  lots: z.array(LotSchema).default([]),
}).strict();

// The capability output carries planned and expected-good quantities alongside
// the cost lines; they are declared so the strict envelope stays honest.
const CostPreviewSchema = z.object({
  plannedThousandths: z.number().int().safe().optional(),
  expectedGoodThousandths: z.number().int().safe().optional(),
  producible: z.boolean(),
  lines: z.array(z.object({
    sku: z.string(),
    name: z.string(),
    requiredThousandths: z.number().int().safe(),
    unitCostMinor: z.number().int().safe(),
    costMinor: z.number().int().safe(),
  }).strict()),
  totalCostMinor: z.number().int().safe(),
  resultingAvgFinishedUnitCostMinor: z.number().int().safe(),
}).strict();

const FeasibilitySchema = z.object({
  producible: z.boolean(),
  maxProducibleThousandths: z.number().int().safe(),
  estimatedLeadTimeDays: z.number().nullable(),
  lines: z.array(z.object({
    itemId: z.string(),
    requiredThousandths: z.number().int().safe(),
    onHandThousandths: z.number().int().safe(),
    shortfallThousandths: z.number().int().safe(),
  }).strict()),
}).strict();

const BomReportSchema = z.object({
  producible: z.boolean(),
  totalShortfallThousandths: z.number().int().safe(),
  lines: z.array(z.object({
    sku: z.string(),
    name: z.string(),
    requiredThousandths: z.number().int().safe(),
    onHandThousandths: z.number().int().safe(),
    shortfallThousandths: z.number().int().safe(),
  }).strict()),
}).strict();

const DefineBomSchema = z.object({
  action: z.literal("defineBom"),
  assemblySku: z.string().trim().min(1),
  components: z.array(z.object({
    sku: z.string().trim().min(1),
    quantityThousandths: z.number().int().positive().safe(),
    scrapPctThousandths: z.number().int().nonnegative().safe(),
  }).strict()).min(1),
}).strict();
const DeleteBomSchema = z.object({
  action: z.literal("deleteBom"),
  assemblySku: z.string().trim().min(1),
}).strict();
const ProduceFromBomSchema = z.object({
  action: z.literal("produceFromBom"),
  assemblySku: z.string().trim().min(1),
  quantityThousandths: z.number().int().positive().safe(),
  lotCode: z.string().trim().min(1).optional(),
}).strict();
const ReverseProductionRunSchema = z.object({
  action: z.literal("reverseProductionRun"),
  runId: z.string().trim().min(1),
}).strict();
const CreateWorkOrderSchema = z.object({
  action: z.literal("createWorkOrder"),
  assemblySku: z.string().trim().min(1),
  plannedQtyThousandths: z.number().int().positive().safe(),
  yieldPctThousandths: z.number().int().nonnegative().safe(),
  note: z.string().trim().min(1).optional(),
}).strict();
const ReleaseWorkOrderSchema = z.object({
  action: z.literal("releaseWorkOrder"),
  workOrderId: z.string().trim().min(1),
}).strict();
const CompleteWorkOrderSchema = z.object({
  action: z.literal("completeWorkOrder"),
  workOrderId: z.string().trim().min(1),
  quantityThousandths: z.number().int().positive().safe(),
}).strict();
const CancelWorkOrderSchema = z.object({
  action: z.literal("cancelWorkOrder"),
  workOrderId: z.string().trim().min(1),
}).strict();

const WriteActionSchema = z.discriminatedUnion("action", [
  DefineBomSchema,
  DeleteBomSchema,
  ProduceFromBomSchema,
  ReverseProductionRunSchema,
  CreateWorkOrderSchema,
  ReleaseWorkOrderSchema,
  CompleteWorkOrderSchema,
  CancelWorkOrderSchema,
]);

const EnvelopeSchema = z.object({ ok: z.literal(true), data: z.unknown() }).strict();
const PendingSchema = z.object({
  ok: z.literal(false),
  pendingApproval: z.literal(true),
  reason: z.string().nullable().optional(),
}).strict();
const ErrorSchema = z.object({ error: z.string() }).passthrough();

export type ManufacturingBomEdge = z.infer<typeof BomEdgeSchema>;
export type ManufacturingAssembly = z.infer<typeof AssemblySchema>;
export type ManufacturingWorkOrder = z.infer<typeof WorkOrderSchema>;
export type ManufacturingProductionRun = z.infer<typeof ProductionRunSchema>;
export type ManufacturingLot = z.infer<typeof LotSchema>;
export type ManufacturingReport = z.infer<typeof ManufacturingReportSchema>;
export type ManufacturingCostPreview = z.infer<typeof CostPreviewSchema>;
export type ManufacturingFeasibility = z.infer<typeof FeasibilitySchema>;
export type ManufacturingBomReport = z.infer<typeof BomReportSchema>;
export type ManufacturingWriteAction = z.infer<typeof WriteActionSchema>;
export type ManufacturingActionResult = { kind: "completed" } | { kind: "pending"; reason: string };

export function manufacturingActionRequest(
  action: ManufacturingWriteAction,
  intentId: string,
  useGoDefineBom: boolean,
): { url: string; body: Record<string, unknown> } {
  if (useGoDefineBom && action.action === "defineBom") {
    return {
      url: "/api/capabilities/execute",
      body: {
        capabilityId: "manufacturing.defineBom",
        input: { assemblySku: action.assemblySku, components: action.components },
        intentId,
      },
    };
  }
  return { url: "/api/manufacturing", body: { ...action, intentId } };
}

export class ManufacturingApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ManufacturingApiError";
  }
}

function messageFor(status: number, body: unknown, fallback: string): string {
  const parsed = ErrorSchema.safeParse(body);
  if (parsed.success) return parsed.data.error;
  if (status === 401) return "Your session has ended. Sign in again to continue.";
  if (status === 403) return "You do not have permission to use manufacturing.";
  if (status === 428) return "Finish setting up your workspace before running production.";
  return fallback;
}

async function request(path: string, init: RequestInit, signal?: AbortSignal): Promise<{ response: Response; body: unknown }> {
  const timeout = AbortSignal.timeout(init.method === "POST" ? 20_000 : 15_000);
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new ManufacturingApiError(0, timedOut
      ? "The manufacturing service took too long to respond. Check the record before trying again."
      : "Could not reach the manufacturing service. Check your connection and try again.");
  }
  return { response, body: await response.json().catch(() => null) };
}

export async function fetchManufacturingEnabled(signal?: AbortSignal): Promise<boolean> {
  const { response, body } = await request("/api/modules", {}, signal);
  if (!response.ok) throw new ManufacturingApiError(response.status, "Could not check whether the Manufacturing module is enabled.");
  const parsed = ModuleSwitchboardSchema.safeParse(body);
  if (!parsed.success) throw new ManufacturingApiError(response.status, "The module switchboard returned data in an unexpected format.");
  const catalogIds = new Set(parsed.data.catalog.map((module) => module.id));
  if (!catalogIds.has("manufacturing") || parsed.data.enabledModules.some((id) => !catalogIds.has(id))) {
    throw new ManufacturingApiError(response.status, "The module switchboard returned an invalid manufacturing configuration.");
  }
  return parsed.data.enabledModules.includes("manufacturing");
}

export async function fetchManufacturingReport(signal?: AbortSignal): Promise<ManufacturingReport> {
  const { response, body } = await request("/api/manufacturing", {}, signal);
  if (!response.ok) {
    throw new ManufacturingApiError(response.status, messageFor(response.status, body, "Could not load manufacturing records."));
  }
  const parsed = ManufacturingReportSchema.safeParse(body);
  if (!parsed.success) throw new ManufacturingApiError(response.status, "The manufacturing service returned data in an unexpected format.");
  return parsed.data;
}

/**
 * Every governed write carries a fresh intent ID so a retried click reconciles
 * to the same server-side receipt instead of producing twice.
 */
export async function submitManufacturingAction(
  action: ManufacturingWriteAction,
  signal?: AbortSignal,
  options: { useGoDefineBom?: boolean } = {},
): Promise<ManufacturingActionResult> {
  const parsed = WriteActionSchema.safeParse(action);
  if (!parsed.success) throw new ManufacturingApiError(0, "Check the production details and try again.");
  const configuredForGo = typeof __GO_MANUFACTURING_DEFINE_BOM_SLICE__ !== "undefined" && __GO_MANUFACTURING_DEFINE_BOM_SLICE__;
  const useGoDefineBom = (options.useGoDefineBom ?? configuredForGo) && parsed.data.action === "defineBom";
  const intentId = crypto.randomUUID();
  const route = manufacturingActionRequest(parsed.data, intentId, useGoDefineBom);
  let { response, body } = await request(route.url, {
    method: "POST",
    body: JSON.stringify(route.body),
  }, signal);
  if (useGoDefineBom && response.status === 404) {
    const fallback = manufacturingActionRequest(parsed.data, intentId, false);
    ({ response, body } = await request(fallback.url, {
      method: "POST",
      body: JSON.stringify(fallback.body),
    }, signal));
  }
  if (response.status === 202) {
    const pending = PendingSchema.safeParse(body);
    if (!pending.success) throw new ManufacturingApiError(202, "The manufacturing service returned an unexpected approval response.");
    return { kind: "pending", reason: pending.data.reason ?? "This action is waiting for approval." };
  }
  if (!response.ok) {
    throw new ManufacturingApiError(response.status, messageFor(response.status, body, "The production action could not be completed."));
  }
  if (!EnvelopeSchema.safeParse(body).success) {
    throw new ManufacturingApiError(response.status, "The manufacturing service returned an unexpected action response.");
  }
  return { kind: "completed" };
}

async function postRead<T>(payload: Record<string, unknown>, schema: z.ZodType<T>, fallback: string, signal?: AbortSignal): Promise<T> {
  const { response, body } = await request("/api/manufacturing", {
    method: "POST",
    body: JSON.stringify({ ...payload, intentId: crypto.randomUUID() }),
  }, signal);
  if (!response.ok) throw new ManufacturingApiError(response.status, messageFor(response.status, body, fallback));
  const envelope = EnvelopeSchema.safeParse(body);
  if (!envelope.success) throw new ManufacturingApiError(response.status, "The manufacturing service returned an unexpected response.");
  const parsed = schema.safeParse(envelope.data.data);
  if (!parsed.success) throw new ManufacturingApiError(response.status, "The manufacturing service returned data in an unexpected format.");
  return parsed.data;
}

export function fetchProductionCostPreview(assemblySku: string, quantityThousandths: number, signal?: AbortSignal): Promise<ManufacturingCostPreview> {
  return postRead({ action: "costPreview", assemblySku, quantityThousandths }, CostPreviewSchema, "Could not preview production cost.", signal);
}

export function fetchProductionFeasibility(assemblySku: string, desiredUnitsThousandths: number, signal?: AbortSignal): Promise<ManufacturingFeasibility> {
  return postRead({ action: "checkProductionFeasibility", assemblySku, desiredUnitsThousandths }, FeasibilitySchema, "Could not check production feasibility.", signal);
}

export function fetchManufacturingBomReport(assemblySku: string, quantityThousandths: number, signal?: AbortSignal): Promise<ManufacturingBomReport> {
  return postRead({ action: "bomReport", assemblySku, quantityThousandths }, BomReportSchema, "Could not build the BOM report.", signal);
}
