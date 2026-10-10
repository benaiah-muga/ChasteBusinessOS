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
const GoCostPreviewSchema = CostPreviewSchema.extend({
  plannedThousandths: z.number().int().safe(),
  expectedGoodThousandths: z.number().int().safe(),
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
  lotCode: z.string().trim().min(1).max(40).optional(),
}).strict();
const ReverseProductionRunSchema = z.object({
  action: z.literal("reverseProductionRun"),
  runId: z.string().trim().min(1),
}).strict();
const CreateWorkOrderSchema = z.object({
  action: z.literal("createWorkOrder"),
  assemblySku: z.string().trim().min(1),
  plannedQtyThousandths: z.number().int().positive().safe().max(2_147_483_647),
  yieldPctThousandths: z.number().int().nonnegative().max(1_000_000),
  workCenter: z.string().trim().min(1).max(80).optional(),
  note: z.string().trim().min(1).max(500).optional(),
}).strict();
const ReleaseWorkOrderSchema = z.object({
  action: z.literal("releaseWorkOrder"),
  workOrderId: z.string().uuid(),
}).strict();
const CompleteWorkOrderSchema = z.object({
  action: z.literal("completeWorkOrder"),
  workOrderId: z.string().uuid(),
  quantityThousandths: z.number().int().positive().safe(),
  lotCode: z.string().trim().min(1).max(40).optional(),
}).strict();
const CancelWorkOrderSchema = z.object({
  action: z.literal("cancelWorkOrder"),
  workOrderId: z.string().uuid(),
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
  approvalId: z.string().uuid().optional(),
}).strict();
const ErrorSchema = z.object({ error: z.string() }).passthrough();
const ProductionCostInputSchema = z.object({ assemblySku: z.string().trim().min(1), quantityThousandths: z.number().int().positive().safe() }).strict();
const ProductionFeasibilityInputSchema = z.object({ assemblySku: z.string().trim().min(1), desiredUnitsThousandths: z.number().int().positive().safe() }).strict();
const BomReportInputSchema = z.object({ assemblySku: z.string().trim().min(1), quantityThousandths: z.number().int().positive().safe() }).strict();
const WorkOrderOutputSchemas = {
  createWorkOrder: z.object({ workOrderId: z.string().uuid(), number: z.number().int().positive().safe(), expectedGoodThousandths: z.number().int().nonnegative().safe() }).passthrough(),
  releaseWorkOrder: z.object({ released: z.boolean() }).passthrough(),
  completeWorkOrder: z.object({
    runRef: z.string().min(1), completed: z.boolean(), producedTotalThousandths: z.number().int().nonnegative().safe(),
    status: z.string().min(1), producedThousandths: z.number().int().positive().safe(),
    consumedComponents: z.array(z.object({ sku: z.string(), quantityThousandths: z.number().int().nonnegative().safe() }).passthrough()),
    costRolledUpMinor: z.number().int().nonnegative().safe(),
  }).passthrough(),
  cancelWorkOrder: z.object({ cancelled: z.boolean() }).passthrough(),
} as const;
const ProductionOutputSchemas = {
  produceFromBom: z.object({
    runRef: z.string().uuid(),
    producedThousandths: z.number().int().positive().safe(),
    consumedComponents: z.array(z.object({ sku: z.string().min(1), quantityThousandths: z.number().int().positive().safe() }).strict()),
    costRolledUpMinor: z.number().int().nonnegative().safe(),
  }).strict(),
  reverseProductionRun: z.object({
    reversedMovements: z.number().int().nonnegative().safe(),
    removedFinishedThousandths: z.number().int().nonnegative().safe(),
    restoredComponents: z.array(z.object({ sku: z.string().min(1), quantityThousandths: z.number().int().nonnegative().safe() }).strict()),
    removedProduced: z.array(z.object({ sku: z.string().min(1), quantityThousandths: z.number().int().nonnegative().safe() }).strict()),
  }).strict(),
} as const;

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
  useGoWorkOrder = false,
  useGoProduction = false,
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
  if (useGoWorkOrder && ["createWorkOrder", "releaseWorkOrder", "completeWorkOrder", "cancelWorkOrder"].includes(action.action)) {
    const { action: actionName, ...input } = action;
    return {
      url: "/api/capabilities/execute",
      body: { capabilityId: `manufacturing.${actionName}`, input, intentId },
    };
  }
  if (useGoProduction && action.action === "produceFromBom") {
    const { action: _action, ...input } = action;
    return { url: "/api/capabilities/execute", body: { capabilityId: "manufacturing.produceFromBom", input, intentId } };
  }
  if (useGoProduction && action.action === "reverseProductionRun") {
    return { url: "/api/capabilities/execute", body: { capabilityId: "manufacturing.reverseProductionRun", input: { runRef: action.runId }, intentId } };
  }
  return { url: "/api/manufacturing", body: { ...action, intentId } };
}

export class ManufacturingApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ManufacturingApiError";
  }
}

type ManufacturingRetryScope = { actorId: string | null; organizationId: string | null };
type ManufacturingAttempt = { storageKey: string; fingerprint: string; intentId: string };
const workOrderActions = new Set(["createWorkOrder", "releaseWorkOrder", "completeWorkOrder", "cancelWorkOrder"]);
const productionActions = new Set(["produceFromBom", "reverseProductionRun"]);
const exactGoWriteActions = new Set(["defineBom", ...workOrderActions, ...productionActions]);
const manufacturingAttemptPrefix = "chaste:manufacturing-work-order-attempt:";

function parseManufacturingAttempt(value: string | null): { fingerprint: string; intentId: string } | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid saved manufacturing attempt");
    const attempt = parsed as { fingerprint?: unknown; intentId?: unknown };
    if (
      typeof attempt.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(attempt.fingerprint) ||
      typeof attempt.intentId !== "string" || !z.string().uuid().safeParse(attempt.intentId).success
    ) throw new Error("invalid saved manufacturing attempt");
    return { fingerprint: attempt.fingerprint, intentId: attempt.intentId };
  } catch { throw new Error("invalid saved manufacturing attempt"); }
}

async function manufacturingDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createManufacturingAttempt(action: ManufacturingWriteAction, scope: ManufacturingRetryScope): Promise<ManufacturingAttempt> {
  const canonicalScope = { actorId: scope.actorId?.trim() ?? "", organizationId: scope.organizationId?.trim() ?? "" };
  if (!canonicalScope.actorId || !canonicalScope.organizationId) {
    throw new ManufacturingApiError(0, "Wait for your account and organization to finish loading before submitting a manufacturing change.");
  }
  let scopeDigest: string;
  let fingerprint: string;
  try {
    scopeDigest = await manufacturingDigest(JSON.stringify(canonicalScope));
    fingerprint = await manufacturingDigest(JSON.stringify({ ...canonicalScope, action }));
  } catch {
    throw new ManufacturingApiError(0, "Manufacturing retry protection is unavailable. Check browser security settings and try again.");
  }
  const storageKey = `${manufacturingAttemptPrefix}${scopeDigest}`;
  let stored: { fingerprint: string; intentId: string } | null;
  try { stored = parseManufacturingAttempt(window.localStorage.getItem(storageKey)); }
  catch { throw new ManufacturingApiError(0, "Enable browser storage before changing manufacturing data so an uncertain action can be retried safely."); }
  if (stored && stored.fingerprint !== fingerprint) {
    throw new ManufacturingApiError(0, "A previous manufacturing result is unresolved. Retry that exact action or check production history before changing it.");
  }
  if (stored) return { storageKey, fingerprint, intentId: stored.intentId };
  const attempt = { storageKey, fingerprint, intentId: crypto.randomUUID() };
  try {
    window.localStorage.setItem(storageKey, JSON.stringify({ fingerprint, intentId: attempt.intentId }));
    const persisted = parseManufacturingAttempt(window.localStorage.getItem(storageKey));
    if (!persisted || persisted.fingerprint !== fingerprint) throw new Error("saved attempt did not persist");
    return { ...attempt, intentId: persisted.intentId };
  } catch {
    throw new ManufacturingApiError(0, "Enable browser storage before changing manufacturing data so an uncertain action can be retried safely.");
  }
}

async function assertNoUnresolvedManufacturingAttempt(scope?: ManufacturingRetryScope): Promise<void> {
  const actorId = scope?.actorId?.trim() ?? "";
  const organizationId = scope?.organizationId?.trim() ?? "";
  try {
    if (actorId && organizationId) {
      const scopeDigest = await manufacturingDigest(JSON.stringify({ actorId, organizationId }));
      if (parseManufacturingAttempt(window.localStorage.getItem(`${manufacturingAttemptPrefix}${scopeDigest}`))) {
        throw new ManufacturingApiError(0, "A previous manufacturing result is unresolved. Restore Go manufacturing writes and retry that exact action before using the legacy route.");
      }
      return;
    }

    let hasUnscopedMarker = false;
    for (let index = 0; index < window.localStorage.length; index += 1) {
      if (window.localStorage.key(index)?.startsWith(manufacturingAttemptPrefix)) {
        hasUnscopedMarker = true;
        break;
      }
    }
    if (hasUnscopedMarker) {
      throw new ManufacturingApiError(0, "A previous manufacturing result may be unresolved. Wait for your account and organization to load, then restore Go manufacturing writes and retry it.");
    }
  } catch (error) {
    if (error instanceof ManufacturingApiError) throw error;
    throw new ManufacturingApiError(0, "Enable browser storage before changing manufacturing data so an uncertain action cannot be routed through the legacy service.");
  }
}

function clearManufacturingAttempt(attempt: ManufacturingAttempt): void {
  try {
    const stored = parseManufacturingAttempt(window.localStorage.getItem(attempt.storageKey));
    if (stored?.fingerprint === attempt.fingerprint && stored.intentId === attempt.intentId) window.localStorage.removeItem(attempt.storageKey);
  } catch { /* Keep an unresolved identity when storage cannot confirm its value. */ }
}

function messageFor(status: number, body: unknown, fallback: string): string {
  if (status === 401) return "Your session has ended. Sign in again to continue.";
  if (status === 403) return "You do not have permission to use manufacturing.";
  if (status === 428) return "Finish setting up your workspace before running production.";
  const parsed = ErrorSchema.safeParse(body);
  if (parsed.success) return parsed.data.error;
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
  options: { useGoDefineBom?: boolean; useGoWorkOrders?: boolean; useGoProductionActions?: boolean; retryScope?: ManufacturingRetryScope } = {},
): Promise<ManufacturingActionResult> {
  const parsed = WriteActionSchema.safeParse(action);
  if (!parsed.success) throw new ManufacturingApiError(0, "Check the production details and try again.");
  const configuredForGo = typeof __GO_MANUFACTURING_DEFINE_BOM_SLICE__ !== "undefined" && __GO_MANUFACTURING_DEFINE_BOM_SLICE__;
  const useGoDefineBom = (options.useGoDefineBom ?? configuredForGo) && parsed.data.action === "defineBom";
  const configuredWorkOrders = typeof __GO_MANUFACTURING_WORK_ORDER_WRITES__ !== "undefined" && __GO_MANUFACTURING_WORK_ORDER_WRITES__;
  const useGoWorkOrders = (options.useGoWorkOrders ?? configuredWorkOrders) && workOrderActions.has(parsed.data.action);
  const configuredProductionActions = typeof __GO_MANUFACTURING_PRODUCTION_WRITES__ !== "undefined" && __GO_MANUFACTURING_PRODUCTION_WRITES__;
  const useGoProductionActions = (options.useGoProductionActions ?? configuredProductionActions) && productionActions.has(parsed.data.action);
  const useGoExactWrite = useGoDefineBom || useGoWorkOrders || useGoProductionActions;
  if (!useGoExactWrite && exactGoWriteActions.has(parsed.data.action)) {
    await assertNoUnresolvedManufacturingAttempt(options.retryScope);
  }
  if (useGoProductionActions && parsed.data.action === "reverseProductionRun" && !z.string().uuid().safeParse(parsed.data.runId).success) {
    throw new ManufacturingApiError(0, "Select a production run with a valid ID before reversing it.");
  }
  const attempt = useGoExactWrite
    ? await createManufacturingAttempt(parsed.data, options.retryScope ?? { actorId: null, organizationId: null })
    : null;
  const intentId = attempt?.intentId ?? crypto.randomUUID();
  const route = manufacturingActionRequest(parsed.data, intentId, useGoDefineBom, useGoWorkOrders, useGoProductionActions);
  const { response, body } = await request(route.url, {
    method: "POST",
    body: JSON.stringify(route.body),
  }, signal);
  const goResponse = useGoExactWrite;
  if (response.status === 202) {
    const pending = PendingSchema.safeParse(body);
    if (!pending.success) throw new ManufacturingApiError(202, "The manufacturing service returned an unexpected approval response.");
    return { kind: "pending", reason: pending.data.reason ?? "This action is waiting for approval." };
  }
  if (!response.ok) {
    const error = new ManufacturingApiError(response.status, messageFor(response.status, body, "The production action could not be completed."));
    if (attempt && response.status >= 400 && response.status < 500 && response.status !== 404 && response.status !== 408 && response.status !== 429) clearManufacturingAttempt(attempt);
    throw error;
  }
  const envelope = EnvelopeSchema.safeParse(body);
  if (!envelope.success) {
    throw new ManufacturingApiError(response.status, "The manufacturing service returned an unexpected action response.");
  }
  if (useGoWorkOrders && !(WorkOrderOutputSchemas[parsed.data.action as keyof typeof WorkOrderOutputSchemas]?.safeParse(envelope.data.data).success ?? false)) {
    throw new ManufacturingApiError(response.status, "The manufacturing service returned an unexpected work order response.");
  }
  if (goResponse && useGoProductionActions && !(ProductionOutputSchemas[parsed.data.action as keyof typeof ProductionOutputSchemas]?.safeParse(envelope.data.data).success ?? false)) {
    throw new ManufacturingApiError(response.status, "The manufacturing service returned an unexpected production response.");
  }
  if (attempt) clearManufacturingAttempt(attempt);
  return { kind: "completed" };
}

async function postRead<TInput extends object, T>(
  action: "costPreview" | "checkProductionFeasibility" | "bomReport",
  payload: unknown,
  inputSchema: z.ZodType<TInput>,
  schema: z.ZodType<T>,
  fallback: string,
  signal?: AbortSignal,
  goSchema?: z.ZodType<T>,
): Promise<T> {
  const input = inputSchema.safeParse(payload);
  if (!input.success) throw new ManufacturingApiError(0, "Check the production details and try again.");
  const useGo = typeof __GO_MANUFACTURING_PLANNING_READS__ !== "undefined" && __GO_MANUFACTURING_PLANNING_READS__;
  const path = useGo ? "/api/capabilities/execute" : "/api/manufacturing";
  const requestBody = useGo
    ? { capabilityId: `manufacturing.${action}`, input: input.data, intentId: crypto.randomUUID() }
    : { action, ...input.data, intentId: crypto.randomUUID() };
  const { response, body } = await request(path, {
    method: "POST",
    body: JSON.stringify(requestBody),
  }, signal);
  if (response.status === 202) {
    throw new ManufacturingApiError(202, "The manufacturing planning read unexpectedly requires approval. No result was returned.");
  }
  if (!response.ok) throw new ManufacturingApiError(response.status, messageFor(response.status, body, fallback));
  const envelope = EnvelopeSchema.safeParse(body);
  if (!envelope.success) throw new ManufacturingApiError(response.status, "The manufacturing service returned an unexpected response.");
  const outputSchema = useGo && action === "costPreview" && goSchema ? goSchema : schema;
  const parsed = outputSchema.safeParse(envelope.data.data);
  if (!parsed.success) throw new ManufacturingApiError(response.status, "The manufacturing service returned data in an unexpected format.");
  return parsed.data;
}

export function fetchProductionCostPreview(assemblySku: string, quantityThousandths: number, signal?: AbortSignal): Promise<ManufacturingCostPreview> {
  return postRead("costPreview", { assemblySku, quantityThousandths }, ProductionCostInputSchema, CostPreviewSchema, "Could not preview production cost.", signal, GoCostPreviewSchema);
}

export function fetchProductionFeasibility(assemblySku: string, desiredUnitsThousandths: number, signal?: AbortSignal): Promise<ManufacturingFeasibility> {
  return postRead("checkProductionFeasibility", { assemblySku, desiredUnitsThousandths }, ProductionFeasibilityInputSchema, FeasibilitySchema, "Could not check production feasibility.", signal);
}

export function fetchManufacturingBomReport(assemblySku: string, quantityThousandths: number, signal?: AbortSignal): Promise<ManufacturingBomReport> {
  return postRead("bomReport", { assemblySku, quantityThousandths }, BomReportInputSchema, BomReportSchema, "Could not build the BOM report.", signal);
}
