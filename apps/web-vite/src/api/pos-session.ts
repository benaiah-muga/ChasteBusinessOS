import { z } from "zod";
import { PosApiError } from "./pos";

const uuid = z.string().uuid();
const SALE_INTENT_STORAGE_PREFIX = "chaste.pos.sale-intent.v1:";
const saleRetryIntentByDigest = new Map<string, string>();
const RETURN_INTENT_STORAGE_PREFIX = "chaste.pos.return-intent.v1:";
const returnRetryIntentByDigest = new Map<string, string>();
const RETURN_ACTIVE_ATTEMPT_PREFIX = "chaste.pos.return-active.v1:";
type ReturnAttemptStatus = "uncertain" | "pending";
type ActiveReturnAttempt = { fingerprint: string; intentId: string; action: PosReturnAction; status: ReturnAttemptStatus };
const returnActiveAttemptByScope = new Map<string, ActiveReturnAttempt>();

export const PosRegisterSessionSchema = z.object({
  id: z.string().min(1),
  register: z.string(),
  status: z.string().min(1),
  openingFloatMinor: z.number().int().safe(),
  expectedCashMinor: z.number().int().safe(),
  countedCashMinor: z.number().int().safe().nullable(),
  varianceMinor: z.number().int().safe().nullable(),
  varianceReason: z.string().nullable().optional(),
  openedAt: z.string().datetime({ offset: true }),
  closedAt: z.string().datetime({ offset: true }).nullable(),
}).passthrough();

export const PosSaleLineSchema = z.object({
  id: z.string().min(1),
  itemId: z.string().nullable(),
  description: z.string(),
  quantity: z.number().int().safe(),
  unitPriceMinor: z.number().int().safe(),
  taxMinor: z.number().int().safe(),
  returnedQuantity: z.number().int().safe(),
  stockTracked: z.boolean(),
}).passthrough();

export const PosSaleSchema = z.object({
  id: z.string().min(1),
  number: z.number().int(),
  status: z.string().min(1),
  totalMinor: z.number().int().safe(),
  creditedMinor: z.number().int().safe(),
  memo: z.string().nullable(),
  customerId: z.string().nullable(),
  customerName: z.string().nullable(),
  method: z.string().min(1),
  returnMode: z.enum(["itemized", "legacy-full", "credit-review"]),
  unallocatedCreditMinor: z.number().int().safe(),
  lines: z.array(PosSaleLineSchema),
  createdAt: z.string().datetime({ offset: true }),
}).passthrough();

export const PosCatalogItemSchema = z.object({
  sku: z.string().min(1),
  name: z.string(),
  kind: z.string().min(1),
  unitLabel: z.string().min(1),
  salePriceMinor: z.number().int().safe(),
  barcode: z.string().nullable().optional(),
  availableThousandths: z.number().int().safe(),
  tags: z.array(z.string()).default([]),
}).passthrough();

export const PosCustomerSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  email: z.string().nullable().optional(),
  purchaseCount: z.number().int().nonnegative(),
  lifetimeSpendMinor: z.number().int().safe(),
}).passthrough();

export type PosRegisterSession = z.infer<typeof PosRegisterSessionSchema>;
export type PosSale = z.infer<typeof PosSaleSchema>;
export type PosSaleLine = z.infer<typeof PosSaleLineSchema>;
export type PosCatalogItem = z.infer<typeof PosCatalogItemSchema>;
export type PosCustomer = z.infer<typeof PosCustomerSchema>;

const RegisterStateSchema = z.object({ sessions: z.array(PosRegisterSessionSchema), sales: z.array(PosSaleSchema) }).passthrough();
const CatalogSchema = z.object({ items: z.array(PosCatalogItemSchema) }).passthrough();
const CustomerListSchema = z.object({ customers: z.array(PosCustomerSchema) }).passthrough();
const ModuleSwitchboardSchema = z.object({
  catalog: z.array(z.object({ id: z.string() }).passthrough()),
  enabledModules: z.array(z.string()),
}).passthrough();
const TenderSchema = z.object({ method: z.string().min(1), amountMinor: z.number().int().safe() }).passthrough();
const PendingEnvelopeSchema = z.object({ ok: z.literal(false), pendingApproval: z.literal(true), reason: z.string().optional() }).passthrough();
const SuccessEnvelopeSchema = z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) }).passthrough();
const ErrorBodySchema = z.object({ error: z.string().max(500) }).passthrough();
const ActionErrorSchema = z.object({ ok: z.literal(false), error: z.string().max(500) }).passthrough();

const OpenOutputSchema = z.object({ sessionId: z.string().min(1) }).passthrough();
const CreateItemOutputSchema = z.object({ itemId: z.string().min(1) }).passthrough();
const AdjustStockOutputSchema = z.object({ onHandThousandths: z.number().int() }).passthrough();
const SaleOutputSchema = z.object({
  invoiceId: z.string().min(1),
  invoiceNumber: z.number().int(),
  totalMinor: z.number().int().safe(),
  tenderedMinor: z.number().int().safe(),
  changeGivenMinor: z.number().int().safe(),
  tenders: z.array(TenderSchema),
}).passthrough();
const CloseOutputSchema = z.object({
  expectedCashMinor: z.number().int().safe(),
  varianceMinor: z.number().int().safe(),
  flagged: z.boolean(),
}).passthrough();
const ReturnOutputSchema = z.object({
  refundEntryId: z.string().min(1),
  refundMinor: z.number().int().safe(),
  creditedMinor: z.number().int().safe(),
  restockedLines: z.number().int().nonnegative(),
  refundMethod: z.string().min(1),
}).passthrough();

export const PosSaleLinePayloadSchema = z.object({
  description: z.string().trim().min(1).max(200),
  quantity: z.number().int().positive().safe(),
  unitPriceMinor: z.number().int().nonnegative().safe(),
  sku: z.string().trim().min(1).max(80).optional(),
}).strict();
export const PosTenderPayloadSchema = z.object({
  method: z.enum(["cash", "card", "mobile_money"]),
  amountMinor: z.number().int().positive().safe(),
}).strict();

export const PosOpenActionSchema = z.object({
  action: z.literal("open"),
  openingFloatMinor: z.number().int().nonnegative().safe(),
}).strict();
export const PosSaleActionSchema = z.object({
  action: z.literal("sale"),
  sessionId: uuid,
  method: z.enum(["cash", "card"]),
  lines: z.array(PosSaleLinePayloadSchema).min(1).max(100),
  tenders: z.array(PosTenderPayloadSchema).min(1).max(3).optional(),
  customerId: uuid.optional(),
  cashReceivedMinor: z.number().int().nonnegative().safe().optional(),
}).strict();
export const PosCloseActionSchema = z.object({
  action: z.literal("close"),
  sessionId: uuid,
  countedCashMinor: z.number().int().nonnegative().safe(),
  varianceReason: z.string().trim().min(3).max(500).optional(),
}).strict();
export const PosReturnActionSchema = z.object({
  action: z.literal("returnSale"),
  invoiceId: uuid,
  reason: z.string().trim().min(3).max(500),
  refundMethod: z.enum(["cash", "card", "mobile_money"]),
  lines: z.array(z.object({ invoiceLineId: uuid, quantity: z.number().int().positive().safe() }).strict()).min(1).max(100).optional(),
}).strict();

export type PosOpenAction = z.infer<typeof PosOpenActionSchema>;
export type PosSaleAction = z.infer<typeof PosSaleActionSchema>;
export type PosCloseAction = z.infer<typeof PosCloseActionSchema>;
export type PosReturnAction = z.infer<typeof PosReturnActionSchema>;

/**
 * Quick add at the register writes through the same inventory capabilities the
 * Products workspace uses; the POS page never invents its own item shape.
 */
export const PosCreateItemActionSchema = z.object({
  action: z.literal("createItem"),
  sku: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  kind: z.literal("goods").default("goods"),
  unitLabel: z.string().trim().min(1).max(20),
  salePriceMinor: z.number().int().nonnegative().safe(),
  barcode: z.string().trim().min(3).max(64).optional(),
}).strict();
export const PosAdjustStockActionSchema = z.object({
  action: z.literal("adjustStock"),
  sku: z.string().trim().min(1).max(40),
  quantityDelta: z.number().int().positive().safe(),
  note: z.string().trim().min(3).max(200),
}).strict();

export type PosCreateItemAction = z.infer<typeof PosCreateItemActionSchema>;
export type PosAdjustStockAction = z.infer<typeof PosAdjustStockActionSchema>;

export type PosActionOutcome<T> = { kind: "completed"; data: T } | { kind: "pending"; reason: string };

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function unreachable(error: unknown, timeoutMessage: string): PosApiError {
  if (error instanceof DOMException && error.name === "TimeoutError") return new PosApiError(0, timeoutMessage);
  return new PosApiError(0, "Could not reach the POS service. Check your connection and try again.");
}

function errorMessage(body: unknown): string | null {
  const failure = ActionErrorSchema.safeParse(body);
  if (failure.success) return failure.data.error;
  const plain = ErrorBodySchema.safeParse(body);
  return plain.success ? plain.data.error : null;
}

function readError(status: number, body: unknown, fallback: string): PosApiError {
  const serverMessage = errorMessage(body);
  if (status === 401) return new PosApiError(401, "Your session has ended. Sign in again to continue.");
  if (status === 400) return new PosApiError(400, "The POS service rejected the request. Review the details and try again.");
  if (status === 403) return new PosApiError(403, serverMessage ?? "You do not have permission to complete this register action.");
  if (status === 422) return new PosApiError(422, serverMessage ?? "The POS service refused this register action. Check the current register status.");
  if (serverMessage) return new PosApiError(status, serverMessage);
  return new PosApiError(status, status >= 500 ? "The POS service is unavailable. Try again." : fallback);
}

async function readJson(path: string, signal: AbortSignal | undefined, timeoutMessage: string): Promise<{ status: number; ok: boolean; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: requestSignal(signal, 15_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw unreachable(error, timeoutMessage);
  }
  return { status: response.status, ok: response.ok, body: await response.json().catch(() => null) };
}

/**
 * Reads register sessions and recent sales together: the drawer, the sale
 * list, and the shift summary all key off the same open session.
 */
export async function fetchPosRegisterState(signal?: AbortSignal): Promise<{ sessions: PosRegisterSession[]; sales: PosSale[] }> {
  const result = await readJson("/api/pos", signal, "The POS service took too long to load. Try again.");
  if (!result.ok) throw readError(result.status, result.body, "Could not load register data. Try again.");
  const parsed = RegisterStateSchema.safeParse(result.body);
  if (!parsed.success) throw new PosApiError(result.status, "The POS service returned register data in an unexpected format.");
  return { sessions: parsed.data.sessions, sales: parsed.data.sales };
}

export async function fetchPosCatalog(signal?: AbortSignal): Promise<PosCatalogItem[]> {
  const result = await readJson("/api/inventory", signal, "Product lookup took too long to load. Try again.");
  if (!result.ok) throw readError(result.status, result.body, "Product lookup isn't available for this account.");
  const parsed = CatalogSchema.safeParse(result.body);
  if (!parsed.success) throw new PosApiError(result.status, "Product lookup returned an unexpected format.");
  return parsed.data.items;
}

export async function fetchPosCustomers(signal?: AbortSignal, options: { useGo?: boolean } = {}): Promise<PosCustomer[]> {
  const configuredForGo = typeof __GO_POS_CUSTOMERS_SLICE__ !== "undefined" && __GO_POS_CUSTOMERS_SLICE__;
  const useGo = options.useGo ?? configuredForGo;
  let result: { status: number; ok: boolean; body: unknown };
  if (useGo) {
    result = await readJson("/api/pos/customers", signal, "Customer lookup took too long to load. Try again.");
    if (result.status === 404) {
      result = await readJson("/api/customers", signal, "Customer lookup took too long to load. Try again.");
    }
  } else {
    result = await readJson("/api/customers", signal, "Customer lookup took too long to load. Try again.");
  }
  if (!result.ok) throw readError(result.status, result.body, "Customer lookup is unavailable.");
  const parsed = CustomerListSchema.safeParse(result.body);
  if (!parsed.success) throw new PosApiError(result.status, "Customer lookup returned an unexpected format.");
  return parsed.data.customers;
}

/** Module gates mirror the Next shell context, which resolves them per org. */
export async function fetchPosModules(signal?: AbortSignal): Promise<{ pos: boolean; inventory: boolean }> {
  let response: Response;
  try {
    response = await fetch("/api/modules", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: requestSignal(signal, 15_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw unreachable(error, "The module switchboard took too long to respond. Try again.");
  }
  const body: unknown = await response.json().catch(() => null);
  const parsed = ModuleSwitchboardSchema.safeParse(body);
  if (!response.ok || !parsed.success) throw new PosApiError(response.status, "The module switchboard returned data in an unexpected format.");
  const catalog = new Set(parsed.data.catalog.map((module) => module.id));
  if (!catalog.has("pos") || !catalog.has("inventory") || parsed.data.enabledModules.some((id) => !catalog.has(id))) {
    throw new PosApiError(response.status, "The module switchboard returned an invalid module configuration.");
  }
  return { pos: parsed.data.enabledModules.includes("pos"), inventory: parsed.data.enabledModules.includes("inventory") };
}

async function postPosAction(
  action: Record<string, unknown>,
  intentId: string,
  signal: AbortSignal | undefined,
  path = "/api/pos",
): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
      signal: requestSignal(signal, 20_000),
      body: JSON.stringify({ ...action, intentId }),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw unreachable(error, "The POS service took too long to respond. Check the register before trying again.");
  }
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function postGoPosCapability(
  capabilityId: "pos.openSession" | "pos.closeSession" | "pos.completeSale" | "pos.returnSale",
  input: Record<string, unknown>,
  intentId: string,
  signal?: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch("/api/capabilities/execute", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
      signal: requestSignal(signal, 20_000),
      body: JSON.stringify({
        capabilityId,
        input,
        intentId,
      }),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw unreachable(error, "The POS service took too long to respond. Check the register before trying again.");
  }
  return { status: response.status, body: await response.json().catch(() => null) };
}

/**
 * Every governed write lands on the same 202 approval envelope as CRM: the
 * outcome stays `pending` with its reason so the page can surface it instead of
 * pretending the action posted.
 */
function interpret<T>(result: { status: number; body: unknown }, schema: z.ZodType<T>, fallback: string): PosActionOutcome<T> {
  if (result.status === 202) {
    const pending = PendingEnvelopeSchema.safeParse(result.body);
    if (!pending.success) throw new PosApiError(202, "The POS service returned an unexpected approval response.");
    return { kind: "pending", reason: pending.data.reason ?? "This action is waiting for approval." };
  }
  if (result.status < 200 || result.status >= 300) throw readError(result.status, result.body, fallback);
  const envelope = SuccessEnvelopeSchema.safeParse(result.body);
  const output = schema.safeParse(envelope.success ? envelope.data.data : result.body);
  if (!output.success) throw new PosApiError(result.status, "The POS service returned an unexpected action response.");
  return { kind: "completed", data: output.data };
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PosApiError(0, message);
  return parsed.data;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonicalValue(child)]));
  }
  return value;
}

async function saleIntentStorageKey(action: PosSaleAction, scopeId: string | null): Promise<string> {
  const canonical = JSON.stringify(canonicalValue({ scopeId, action }));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const hexDigest = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${SALE_INTENT_STORAGE_PREFIX}${hexDigest}`;
}

function rememberSaleIntent(storageKey: string, intentId: string): void {
  saleRetryIntentByDigest.set(storageKey, intentId);
  try {
    window.localStorage.setItem(storageKey, JSON.stringify({ intentId }));
  } catch {
    // The in-memory record still protects retries until the current page closes.
  }
}

function readSaleIntent(storageKey: string): string | null {
  const inMemory = saleRetryIntentByDigest.get(storageKey);
  if (inMemory) return inMemory;
  try {
    const record: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
    if (record !== null && typeof record === "object" && "intentId" in record && typeof record.intentId === "string" && uuid.safeParse(record.intentId).success) {
      saleRetryIntentByDigest.set(storageKey, record.intentId);
      return record.intentId;
    }
  } catch {
    return null;
  }
  return null;
}

function clearSaleIntent(storageKey: string, intentId: string): void {
  if (saleRetryIntentByDigest.get(storageKey) === intentId) saleRetryIntentByDigest.delete(storageKey);
  try {
    const record: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
    if (record !== null && typeof record === "object" && "intentId" in record && record.intentId === intentId) {
      window.localStorage.removeItem(storageKey);
    }
  } catch {
    // A malformed or unavailable storage entry cannot change the server result.
  }
}

async function returnIntentStorageKey(action: PosReturnAction, scopeId: string | null): Promise<string> {
  const canonical = JSON.stringify(canonicalValue({ scopeId, action }));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const hexDigest = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${RETURN_INTENT_STORAGE_PREFIX}${hexDigest}`;
}

async function returnActiveAttemptStorageKey(scopeId: string | null): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ scopeId })));
  const hexDigest = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${RETURN_ACTIVE_ATTEMPT_PREFIX}${hexDigest}`;
}

function readReturnActiveAttempt(storageKey: string): ActiveReturnAttempt | null {
  const inMemory = returnActiveAttemptByScope.get(storageKey);
  if (inMemory) return inMemory;
  try {
    const record: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
    if (record !== null && typeof record === "object" && "fingerprint" in record && typeof record.fingerprint === "string"
      && "intentId" in record && typeof record.intentId === "string" && uuid.safeParse(record.intentId).success
      && "status" in record && (record.status === "uncertain" || record.status === "pending")
      && "action" in record) {
      const action = PosReturnActionSchema.safeParse(record.action);
      if (!action.success) return null;
      const status: ReturnAttemptStatus = record.status === "pending" ? "pending" : "uncertain";
      const attempt: ActiveReturnAttempt = { fingerprint: record.fingerprint, intentId: record.intentId, action: action.data, status };
      returnActiveAttemptByScope.set(storageKey, attempt);
      return attempt;
    }
  } catch {
    return null;
  }
  return null;
}

function rememberReturnActiveAttempt(storageKey: string, fingerprint: string, intentId: string, action: PosReturnAction, status: ReturnAttemptStatus): void {
  const attempt = { fingerprint, intentId, action, status };
  returnActiveAttemptByScope.set(storageKey, attempt);
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(attempt));
  } catch {
    // The in-memory copy still protects the active attempt until the page closes.
  }
}

function clearReturnActiveAttempt(storageKey: string, fingerprint: string, intentId: string): void {
  const active = returnActiveAttemptByScope.get(storageKey);
  if (active?.fingerprint === fingerprint && active.intentId === intentId) returnActiveAttemptByScope.delete(storageKey);
  try {
    const record: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
    if (record !== null && typeof record === "object" && "fingerprint" in record && record.fingerprint === fingerprint
      && "intentId" in record && record.intentId === intentId) window.localStorage.removeItem(storageKey);
  } catch {
    // A malformed or unavailable storage entry cannot change the server result.
  }
}

export async function restorePosReturnAttempt(
  scopeId: string,
): Promise<{ action: PosReturnAction; intentId: string; status: ReturnAttemptStatus } | null> {
  const storageKey = await returnActiveAttemptStorageKey(scopeId);
  const attempt = readReturnActiveAttempt(storageKey);
  if (!attempt) return null;
  const expected = await returnIntentStorageKey(attempt.action, scopeId);
  if (attempt.fingerprint !== expected.slice(RETURN_INTENT_STORAGE_PREFIX.length)) return null;
  return { action: attempt.action, intentId: attempt.intentId, status: attempt.status };
}

function rememberReturnIntent(storageKey: string, intentId: string): void {
  returnRetryIntentByDigest.set(storageKey, intentId);
  try {
    window.localStorage.setItem(storageKey, JSON.stringify({ intentId }));
  } catch {
    // The in-memory copy still protects retries if storage is unavailable.
  }
}

function readReturnIntent(storageKey: string): string | null {
  const inMemory = returnRetryIntentByDigest.get(storageKey);
  if (inMemory) return inMemory;
  try {
    const record: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
    if (record !== null && typeof record === "object" && "intentId" in record && typeof record.intentId === "string" && uuid.safeParse(record.intentId).success) {
      returnRetryIntentByDigest.set(storageKey, record.intentId);
      return record.intentId;
    }
  } catch {
    return null;
  }
  return null;
}

function clearReturnIntent(storageKey: string, intentId: string): void {
  if (returnRetryIntentByDigest.get(storageKey) === intentId) returnRetryIntentByDigest.delete(storageKey);
  try {
    const record: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
    if (record !== null && typeof record === "object" && "intentId" in record && record.intentId === intentId) window.localStorage.removeItem(storageKey);
  } catch {
    // A malformed or unavailable storage entry cannot change the server result.
  }
}

export async function openPosSession(
  action: PosOpenAction,
  signal?: AbortSignal,
  options: { useGo?: boolean } = {},
): Promise<PosActionOutcome<z.infer<typeof OpenOutputSchema>>> {
  const payload = parseOrThrow(PosOpenActionSchema, action, "Check the opening float and try again.");
  const intentId = crypto.randomUUID();
  const configuredForGo = typeof __GO_POS_OPEN_SESSION_SLICE__ !== "undefined" && __GO_POS_OPEN_SESSION_SLICE__;
  const useGo = options.useGo ?? configuredForGo;
  if (!useGo) return interpret(await postPosAction(payload, intentId, signal), OpenOutputSchema, "Could not open the register.");

  const result = await postGoPosCapability("pos.openSession", { openingFloatMinor: payload.openingFloatMinor }, intentId, signal);
  if (result.status === 404) {
    return interpret(await postPosAction(payload, intentId, signal), OpenOutputSchema, "Could not open the register.");
  }
  return interpret(result, OpenOutputSchema, "Could not open the register.");
}

/**
 * `intentId` is the client action identity: a queued offline sale is retried
 * with the original identity so the server reconciles to one receipt instead of
 * charging twice.
 */
export async function submitPosSale(
  action: PosSaleAction,
  intentId?: string,
  signal?: AbortSignal,
  options: { useGo?: boolean; scopeId?: string | null; persistRetryIntent?: boolean } = {},
): Promise<PosActionOutcome<z.infer<typeof SaleOutputSchema>>> {
  const payload = parseOrThrow(PosSaleActionSchema, action, "Check the sale lines and payment amounts before submitting.");
  const configuredForGo = typeof __GO_POS_COMPLETE_SALE_SLICE__ !== "undefined" && __GO_POS_COMPLETE_SALE_SLICE__;
  const useGo = options.useGo ?? configuredForGo;
  let storageKey: string | null = null;
  let stableIntentId = intentId ?? crypto.randomUUID();
  if (useGo || options.persistRetryIntent === true) {
    storageKey = await saleIntentStorageKey(payload, options.scopeId ?? null);
    stableIntentId = intentId ?? readSaleIntent(storageKey) ?? crypto.randomUUID();
    rememberSaleIntent(storageKey, stableIntentId);
  }

  let result: { status: number; body: unknown };
  if (useGo) {
    const { action: _action, ...input } = payload;
    result = await postGoPosCapability("pos.completeSale", input, stableIntentId, signal);
    if (result.status === 404) result = await postPosAction(payload, stableIntentId, signal);
  } else {
    result = await postPosAction(payload, stableIntentId, signal);
  }

  if (storageKey && result.status >= 400 && result.status < 500 && result.status !== 408) clearSaleIntent(storageKey, stableIntentId);
  const outcome = interpret(result, SaleOutputSchema, "The sale could not be posted.");
  if (storageKey && outcome.kind === "completed") clearSaleIntent(storageKey, stableIntentId);
  return outcome;
}

export async function clearPosSaleRetryIntent(action: PosSaleAction, scopeId: string | null, expectedIntentId?: string): Promise<void> {
  const payload = parseOrThrow(PosSaleActionSchema, action, "The current sale could not be identified for retry cleanup.");
  const storageKey = await saleIntentStorageKey(payload, scopeId);
  const intentId = readSaleIntent(storageKey);
  if (intentId && (expectedIntentId === undefined || expectedIntentId === intentId)) clearSaleIntent(storageKey, intentId);
}

export async function closePosSession(
  action: PosCloseAction,
  signal?: AbortSignal,
  options: { useGo?: boolean } = {},
): Promise<PosActionOutcome<z.infer<typeof CloseOutputSchema>>> {
  const payload = parseOrThrow(PosCloseActionSchema, action, "Check the counted cash and the variance note before closing.");
  const intentId = crypto.randomUUID();
  const configuredForGo = typeof __GO_POS_CLOSE_SESSION_SLICE__ !== "undefined" && __GO_POS_CLOSE_SESSION_SLICE__;
  const useGo = options.useGo ?? configuredForGo;
  if (!useGo) return interpret(await postPosAction(payload, intentId, signal), CloseOutputSchema, "The register session could not be closed.");

  const input = {
    sessionId: payload.sessionId,
    countedCashMinor: payload.countedCashMinor,
    ...(payload.varianceReason === undefined ? {} : { varianceReason: payload.varianceReason }),
  };
  const result = await postGoPosCapability("pos.closeSession", input, intentId, signal);
  if (result.status === 404) {
    return interpret(await postPosAction(payload, intentId, signal), CloseOutputSchema, "The register session could not be closed.");
  }
  return interpret(result, CloseOutputSchema, "The register session could not be closed.");
}

export async function requestPosReturn(
  action: PosReturnAction,
  signal?: AbortSignal,
  options: { useGo?: boolean; scopeId?: string | null; intentId?: string } = {},
): Promise<PosActionOutcome<z.infer<typeof ReturnOutputSchema>>> {
  const payload = parseOrThrow(PosReturnActionSchema, action, "Check the return quantities and reason before submitting.");
  const configuredForGo = typeof __GO_POS_RETURN_SALE_SLICE__ !== "undefined" && __GO_POS_RETURN_SALE_SLICE__;
  const useGo = options.useGo ?? configuredForGo;
  const persistAttempt = options.scopeId !== undefined && options.scopeId !== null;
  const storageKey = persistAttempt ? await returnIntentStorageKey(payload, options.scopeId ?? null) : null;
  const activeAttemptKey = persistAttempt ? await returnActiveAttemptStorageKey(options.scopeId ?? null) : null;
  const fingerprint = storageKey?.slice(RETURN_INTENT_STORAGE_PREFIX.length) ?? null;
  const activeAttempt = activeAttemptKey ? readReturnActiveAttempt(activeAttemptKey) : null;
  if (activeAttempt && activeAttempt.fingerprint !== fingerprint) {
    throw new PosApiError(0, "A previous return result is still unknown. Retry the exact return or verify the sale before starting another return.");
  }
  if (activeAttempt && options.intentId && options.intentId !== activeAttempt.intentId) {
    throw new PosApiError(0, "This return must keep its saved attempt identity until its result is resolved.");
  }
  const intentId = options.intentId ?? (storageKey ? readReturnIntent(storageKey) : null) ?? activeAttempt?.intentId ?? crypto.randomUUID();
  if (storageKey) rememberReturnIntent(storageKey, intentId);
  if (activeAttemptKey && fingerprint) rememberReturnActiveAttempt(activeAttemptKey, fingerprint, intentId, payload, activeAttempt?.status ?? "uncertain");

  let result: { status: number; body: unknown };
  if (useGo) {
    const { action: _action, ...input } = payload;
    result = await postGoPosCapability("pos.returnSale", input, intentId, signal);
    if (result.status === 404) result = await postPosAction(payload, intentId, signal);
  } else {
    result = await postPosAction(payload, intentId, signal);
  }

  if (storageKey && result.status >= 400 && result.status < 500 && result.status !== 408) clearReturnIntent(storageKey, intentId);
  if (activeAttemptKey && fingerprint && result.status >= 400 && result.status < 500 && result.status !== 408) clearReturnActiveAttempt(activeAttemptKey, fingerprint, intentId);
  const outcome = interpret(result, ReturnOutputSchema, "The return could not be submitted.");
  if (outcome.kind === "pending" && activeAttemptKey && fingerprint) rememberReturnActiveAttempt(activeAttemptKey, fingerprint, intentId, payload, "pending");
  if (storageKey && outcome.kind === "completed") clearReturnIntent(storageKey, intentId);
  if (activeAttemptKey && fingerprint && outcome.kind === "completed") clearReturnActiveAttempt(activeAttemptKey, fingerprint, intentId);
  return outcome;
}

export async function createPosQuickProduct(action: PosCreateItemAction, signal?: AbortSignal): Promise<PosActionOutcome<z.infer<typeof CreateItemOutputSchema>>> {
  const payload = parseOrThrow(PosCreateItemActionSchema, action, "Check the product name, SKU, and price before saving.");
  return interpret(await postPosAction(payload, crypto.randomUUID(), signal, "/api/inventory"), CreateItemOutputSchema, "Could not add the product.");
}

export async function adjustPosItemStock(action: PosAdjustStockAction, signal?: AbortSignal): Promise<PosActionOutcome<z.infer<typeof AdjustStockOutputSchema>>> {
  const payload = parseOrThrow(PosAdjustStockActionSchema, action, "Check the opening stock quantity before recording it.");
  return interpret(await postPosAction(payload, crypto.randomUUID(), signal, "/api/inventory"), AdjustStockOutputSchema, "Could not record the opening stock.");
}
