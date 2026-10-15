import { z } from "zod";

const GoSalesOrderSchema = z.object({
  id: z.string().uuid(),
  number: z.number().int().nonnegative().safe(),
  customerId: z.string().uuid(),
  status: z.string().min(1),
  backordered: z.boolean(),
  totalMinor: z.number().int().safe(),
  createdAt: z.string().datetime({ offset: true }),
  lines: z.array(z.object({
    lineId: z.string().uuid(),
    description: z.string().min(1),
    quantityThousandths: z.number().int().positive().safe(),
    deliveredThousandths: z.number().int().nonnegative().safe(),
    deliverableThousandths: z.number().int().nonnegative().safe(),
    unitPriceMinor: z.number().int().nonnegative().safe().optional().default(0),
    taxMinor: z.number().int().nonnegative().safe().optional().default(0),
    sku: z.string().min(1).optional(),
  }).strict()).default([]),
  note: z.string().nullable().optional(),
}).strict();
const GoSalesOrdersSchema = z.object({ orders: z.array(GoSalesOrderSchema) }).strict();
const GoSalesCustomersSchema = z.object({ customers: z.array(z.object({ id: z.string().uuid(), name: z.string().min(1) }).strict()) }).strict();
const GoSalesOrdersEnvelopeSchema = z.object({ ok: z.literal(true), data: z.unknown() }).strict();
const GoSalesOrdersPendingSchema = z.object({
  ok: z.literal(false),
  pendingApproval: z.literal(true),
  reason: z.string().max(240).optional(),
}).strict();
const ModuleSwitchboardSchema = z.object({
  catalog: z.array(z.object({ id: z.string().min(1) })),
  enabledModules: z.array(z.string().min(1)),
});
const ErrorSchema = z.object({ error: z.string().max(240) });
const ConfirmOrderResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    confirmed: z.literal(true),
    backordered: z.boolean(),
    reservedThousandths: z.number().int().safe(),
  }).strict(),
}).strict();
const PendingConfirmOrderSchema = z.object({
  ok: z.literal(false),
  pendingApproval: z.literal(true),
  reason: z.string().max(240).optional(),
  approvalId: z.string().uuid().optional(),
}).strict();
const SalesWriteLineSchema = z.object({
  description: z.string().trim().min(1),
  quantity: z.number().int().positive().safe(),
  unitPriceMinor: z.number().int().nonnegative().safe(),
  taxMinor: z.number().int().nonnegative().safe().optional(),
  sku: z.string().trim().min(1).optional(),
}).strict();
const CreateOrderSchema = z.object({
  action: z.literal("create"),
  customerId: z.string().uuid(),
  note: z.string().optional(),
  lines: z.array(SalesWriteLineSchema).min(1),
}).strict();
const UpdateDraftOrderSchema = z.object({
  action: z.literal("update"), orderId: z.string().uuid(), customerId: z.string().uuid(),
  note: z.string().max(4000).optional(), lines: z.array(SalesWriteLineSchema).min(1).max(100),
}).strict();
const DeliverOrderLineSchema = z.object({ lineId: z.string().uuid(), quantityThousandths: z.number().int().positive().safe() }).strict();
const DeliverOrderSchema = z.object({
  action: z.literal("deliver"), orderId: z.string().uuid(), lines: z.array(DeliverOrderLineSchema).min(1).optional(),
}).strict();
const CancelOrderSchema = z.object({ action: z.literal("cancel"), orderId: z.string().uuid() }).strict();
const SalesOrderWriteSchema = z.discriminatedUnion("action", [CreateOrderSchema, UpdateDraftOrderSchema, DeliverOrderSchema, CancelOrderSchema]);
const PendingWriteSchema = z.object({
  ok: z.literal(false).optional(),
  pendingApproval: z.literal(true),
  reason: z.string().max(240).optional(),
  error: z.string().max(240).optional(),
  approvalId: z.string().uuid().optional(),
}).passthrough();
const SalesWriteEnvelopeSchema = z.object({ ok: z.literal(true), data: z.unknown() }).strict();
const CreateOrderOutputSchema = z.object({ orderId: z.string().uuid(), orderNumber: z.number().int().positive().safe() }).strict();
const DeliverOrderOutputSchema = z.object({
  invoiceId: z.string().uuid(), invoiceNumber: z.number().int().positive().safe(),
  invoiceTotalMinor: z.number().int().nonnegative().safe(), orderStatus: z.enum(["confirmed", "delivered"]),
}).strict();
const CancelOrderOutputSchema = z.object({ status: z.literal("cancelled"), releasedThousandths: z.number().int().nonnegative().safe() }).strict();
const UpdateDraftOrderOutputSchema = z.object({ orderId: z.string().uuid(), before: z.object({ customerId: z.string().uuid(), note: z.string().nullable().optional(), lines: z.array(SalesWriteLineSchema).min(1).max(100) }).strict() }).strict();
const SalesOrderAttemptPrefix = "chaste:sales-order-write-attempt:";

type SalesRetryScope = { actorId: string | null; organizationId: string | null };
export type SalesOrderWrite = z.infer<typeof SalesOrderWriteSchema>;
export type RouteLessSalesOrderMarker = { action: SalesOrderWrite["action"]; intentId: string; fingerprint: string };
const StoredSalesOrderAttemptSchema = z.object({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  intentId: z.string().uuid(),
  action: SalesOrderWriteSchema,
  route: z.enum(["go", "legacy"]).optional(),
}).strict();
type StoredSalesOrderAttempt = z.infer<typeof StoredSalesOrderAttemptSchema>;
export type SalesOrderWriteOutcome =
  | { kind: "pending"; reason: string }
  | { kind: "completed"; action: "create"; data: z.infer<typeof CreateOrderOutputSchema> }
  | { kind: "completed"; action: "update"; data: { orderId: string } }
  | { kind: "completed"; action: "deliver"; data: z.infer<typeof DeliverOrderOutputSchema> }
  | { kind: "completed"; action: "cancel"; data: z.infer<typeof CancelOrderOutputSchema> };

type SalesOrderAttempt = { storageKey: string; fingerprint: string; intentId: string; route: "go" | "legacy" };

function routeLessAttemptError(): SalesApiError {
  return new SalesApiError(0, "A saved sales order retry marker predates route tracking or belongs to a retired backend route. Review Sales order history, then use the in-page recovery confirmation to clear that marker before submitting again.");
}

function parseSalesOrderAttempt(value: string | null): StoredSalesOrderAttempt | null {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("saved sales order retry marker is not valid JSON");
  }
  const attempt = StoredSalesOrderAttemptSchema.safeParse(parsed);
  if (!attempt.success) throw new Error("saved sales order retry marker has an invalid shape");
  return attempt.data;
}

function readSalesOrderAttempt(storageKey: string): StoredSalesOrderAttempt | null {
  let raw: string | null;
  try { raw = window.localStorage.getItem(storageKey); }
  catch { throw new SalesApiError(0, "Enable browser storage before changing a sales order so an uncertain action can be retried safely."); }
  try { return parseSalesOrderAttempt(raw); }
  catch { throw new SalesApiError(0, "A saved sales order retry marker is damaged. Verify order history before submitting another change."); }
}

async function salesOrderDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function withSalesOrderMarkerLock<T>(storageKey: string, operation: () => Promise<T>, requireLock = false): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) {
    if (requireLock) throw new SalesApiError(0, "Safe sales order retry protection is unavailable in this browser. Use a browser with Web Locks support before changing sales orders.");
    return operation();
  }
  try {
    return await locks.request(`chaste:sales-order-write-marker-lock:${storageKey}`, { mode: "exclusive" }, operation);
  } catch (error) {
    if (error instanceof SalesApiError) throw error;
    throw new SalesApiError(0, "Could not safely coordinate the sales order retry marker across browser tabs. Close other Sales tabs and try again.");
  }
}

async function createSalesOrderAttempt(action: SalesOrderWrite, retryScope: SalesRetryScope, route: "go" | "legacy"): Promise<SalesOrderAttempt> {
  const scope = { actorId: retryScope.actorId?.trim() ?? "", organizationId: retryScope.organizationId?.trim() ?? "" };
  if (!scope.actorId || !scope.organizationId) {
    throw new SalesApiError(0, "Wait for your account and organization to finish loading before changing a sales order.");
  }
  let scopeDigest: string;
  let fingerprint: string;
  try {
    scopeDigest = await salesOrderDigest(JSON.stringify(scope));
    fingerprint = await salesOrderDigest(JSON.stringify({ ...scope, action }));
  } catch {
    throw new SalesApiError(0, "Sales order retry protection is unavailable. Check browser security settings and try again.");
  }
  const storageKey = `${SalesOrderAttemptPrefix}${scopeDigest}`;
  return withSalesOrderMarkerLock(storageKey, async () => {
    const stored = readSalesOrderAttempt(storageKey);
    if (stored) {
      let storedFingerprint: string;
      try { storedFingerprint = await salesOrderDigest(JSON.stringify({ ...scope, action: stored.action })); }
      catch { throw new SalesApiError(0, "Sales order retry protection is unavailable. Check browser security settings and try again."); }
      if (storedFingerprint !== stored.fingerprint) {
        throw new SalesApiError(0, "A saved sales order retry marker does not match its action. Verify order history before submitting another change.");
      }
      if (stored.route === undefined) throw routeLessAttemptError();
      if (stored.route !== route) {
        if (stored.route === "legacy") throw routeLessAttemptError();
        throw new SalesApiError(0, "A previous sales order result is unresolved on the Go route. Retry the exact action or check order history before clearing its saved retry marker.");
      }
    }
    if (stored && stored.fingerprint !== fingerprint) {
      throw new SalesApiError(0, "A previous sales order result is unresolved. Retry that exact action or check order history before changing it.");
    }
    if (stored) return { storageKey, fingerprint, intentId: stored.intentId, route };
    const attempt = { storageKey, fingerprint, intentId: crypto.randomUUID(), route };
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({ fingerprint, intentId: attempt.intentId, action, route }));
      const persisted = parseSalesOrderAttempt(window.localStorage.getItem(storageKey));
      if (!persisted || persisted.fingerprint !== fingerprint || persisted.intentId !== attempt.intentId || persisted.route !== route) throw new Error("saved attempt did not persist");
      return attempt;
    } catch {
      throw new SalesApiError(0, "Enable browser storage before changing a sales order so an uncertain action can be retried safely.");
    }
  }, true);
}

async function clearSalesOrderAttempt(attempt: SalesOrderAttempt): Promise<void> {
  try {
    await withSalesOrderMarkerLock(attempt.storageKey, async () => {
      const stored = readSalesOrderAttempt(attempt.storageKey);
      if (stored?.fingerprint === attempt.fingerprint && stored.intentId === attempt.intentId && stored.route === attempt.route) {
        window.localStorage.removeItem(attempt.storageKey);
      }
    }, true);
  } catch { /* Keep the unresolved intent if storage or cross-tab coordination fails. */ }
}

export type SalesOrder = z.infer<typeof GoSalesOrderSchema>;
export type SalesCustomer = z.infer<typeof GoSalesCustomersSchema>["customers"][number];

async function salesRetryStorageKey(retryScope: SalesRetryScope): Promise<{ scope: { actorId: string; organizationId: string }; storageKey: string } | null> {
  const scope = { actorId: retryScope.actorId?.trim() ?? "", organizationId: retryScope.organizationId?.trim() ?? "" };
  if (!scope.actorId || !scope.organizationId) return null;
  try {
    const scopeDigest = await salesOrderDigest(JSON.stringify(scope));
    return { scope, storageKey: `${SalesOrderAttemptPrefix}${scopeDigest}` };
  } catch {
    throw new SalesApiError(0, "Sales order retry protection is unavailable. Check browser security settings and try again.");
  }
}

async function verifySalesOrderAttemptScope(scope: { actorId: string; organizationId: string }, stored: StoredSalesOrderAttempt): Promise<void> {
  let fingerprint: string;
  try { fingerprint = await salesOrderDigest(JSON.stringify({ ...scope, action: stored.action })); }
  catch { throw new SalesApiError(0, "Sales order retry protection is unavailable. Check browser security settings and try again."); }
  if (fingerprint !== stored.fingerprint) {
    throw new SalesApiError(0, "A saved sales order retry marker does not match its action. Verify order history before changing it.");
  }
}

export async function findRouteLessSalesOrderAction(retryScope: SalesRetryScope): Promise<RouteLessSalesOrderMarker | null> {
  const scopedKey = await salesRetryStorageKey(retryScope);
  if (!scopedKey) return null;
  const stored = readSalesOrderAttempt(scopedKey.storageKey);
  if (!stored) return null;
  await verifySalesOrderAttemptScope(scopedKey.scope, stored);
  return stored.route !== "go" ? { action: stored.action.action, intentId: stored.intentId, fingerprint: stored.fingerprint } : null;
}

export async function clearRouteLessSalesOrderAttempt(retryScope: SalesRetryScope, expected: RouteLessSalesOrderMarker): Promise<boolean> {
  const scopedKey = await salesRetryStorageKey(retryScope);
  if (!scopedKey) return false;
  return withSalesOrderMarkerLock(scopedKey.storageKey, async () => {
    const stored = readSalesOrderAttempt(scopedKey.storageKey);
    if (!stored || stored.route === "go"
      || stored.intentId !== expected.intentId
      || stored.fingerprint !== expected.fingerprint
      || stored.action.action !== expected.action) return false;
    await verifySalesOrderAttemptScope(scopedKey.scope, stored);

    const current = readSalesOrderAttempt(scopedKey.storageKey);
    if (!current || current.route === "go"
      || current.intentId !== expected.intentId
      || current.fingerprint !== expected.fingerprint
      || current.action.action !== expected.action) return false;
    try {
      window.localStorage.removeItem(scopedKey.storageKey);
      return true;
    } catch {
      throw new SalesApiError(0, "Browser storage could not clear the reviewed route-less sales marker. Check storage settings and try again.");
    }
  }, true);
}

export async function restorePendingSalesOrderAction(retryScope: SalesRetryScope): Promise<SalesOrderWrite | null> {
  const scope = { actorId: retryScope.actorId?.trim() ?? "", organizationId: retryScope.organizationId?.trim() ?? "" };
  if (!scope.actorId || !scope.organizationId) return null;
  let storageKey: string;
  try { storageKey = `${SalesOrderAttemptPrefix}${await salesOrderDigest(JSON.stringify(scope))}`; }
  catch { throw new SalesApiError(0, "Sales order retry protection is unavailable. Check browser security settings and try again."); }
  return withSalesOrderMarkerLock(storageKey, async () => {
    const stored = readSalesOrderAttempt(storageKey);
    if (!stored) return null;
    if (stored.route !== "go") throw routeLessAttemptError();
    await verifySalesOrderAttemptScope(scope, stored);
    return stored.action;
  }, true);
}

export async function restorePendingSalesOrderCreate(retryScope: SalesRetryScope): Promise<Extract<SalesOrderWrite, { action: "create" }> | null> {
  const action = await restorePendingSalesOrderAction(retryScope);
  return action?.action === "create" ? action : null;
}

export class SalesApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "SalesApiError";
  }
}

function salesOrganizationId(organizationId: string | null | undefined): string {
  const normalized = organizationId?.trim() ?? "";
  if (!normalized) throw new SalesApiError(0, "Wait for the active organization to finish loading before loading sales data.");
  return normalized;
}

export async function fetchSalesCustomers(organizationId: string | null | undefined, signal?: AbortSignal): Promise<SalesCustomer[]> {
  const orgId = organizationId?.trim() ?? "";
  if (!z.string().uuid().safeParse(orgId).success) {
    throw new SalesApiError(0, "Wait for the active organization to finish loading before loading customers.");
  }
  let response: Response;
  try {
    response = await fetch("/api/sales/customers", {
      credentials: "same-origin",
      headers: { accept: "application/json", "X-Organization-ID": orgId },
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new SalesApiError(0, timedOut
      ? "Customer lookup took too long to load. Try again."
      : "Could not reach the sales service. Check your connection and try again.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = ErrorSchema.safeParse(body);
    if (response.status === 401) throw new SalesApiError(401, "Your session has ended. Sign in again to continue.");
    if (response.status === 403) throw new SalesApiError(403, parsed.success ? parsed.data.error : "You do not have permission to view sales customers.");
    throw new SalesApiError(response.status, response.status >= 500
      ? "The sales service is unavailable. Try again."
      : parsed.success ? parsed.data.error : "The customer lookup request could not be completed. Try again.");
  }
  const parsed = GoSalesCustomersSchema.safeParse(body);
  if (!parsed.success) throw new SalesApiError(response.status, "The sales service returned customer data in an unexpected format.");
  return parsed.data.customers;
}

export async function fetchSalesEnabled(organizationId: string | null | undefined, signal?: AbortSignal): Promise<boolean> {
  const orgId = salesOrganizationId(organizationId);
  let response: Response;
  try {
    response = await fetch("/api/modules", {
      credentials: "same-origin",
      headers: { accept: "application/json", "X-Organization-ID": orgId },
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new SalesApiError(0, "Could not check whether the sales module is enabled. Try again.");
  }

  if (!response.ok) throw new SalesApiError(response.status, "Could not check whether the sales module is enabled. Try again.");
  const parsed = ModuleSwitchboardSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new SalesApiError(response.status, "The module switchboard returned data in an unexpected format.");
  const catalogIds = new Set(parsed.data.catalog.map((module) => module.id));
  if (!catalogIds.has("sales") || parsed.data.enabledModules.some((id) => !catalogIds.has(id))) {
    throw new SalesApiError(response.status, "The module switchboard returned an invalid sales configuration.");
  }
  return parsed.data.enabledModules.includes("sales");
}

export async function fetchSalesOrders(organizationId: string | null | undefined, signal?: AbortSignal): Promise<SalesOrder[]> {
  const orgId = salesOrganizationId(organizationId);
  let response: Response;
  try {
    response = await fetch("/api/capabilities/execute", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json", "X-Organization-ID": orgId },
      body: JSON.stringify({ capabilityId: "sales.listOrders", input: {}, intentId: crypto.randomUUID() }),
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new SalesApiError(0, timedOut
      ? "The sales service took too long to load. Try again."
      : "Could not reach the sales service. Check your connection and try again.");
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = ErrorSchema.safeParse(body);
    if (response.status === 401) throw new SalesApiError(401, "Your session has ended. Sign in again to continue.");
    if (response.status === 202 || GoSalesOrdersPendingSchema.safeParse(body).success) {
      throw new SalesApiError(response.status, "The sales service returned an unexpected pending response while loading orders.");
    }
    if (response.status === 403 || response.status === 422) {
      throw new SalesApiError(response.status, parsed.success ? parsed.data.error : "You do not have permission to view sales orders.");
    }
    throw new SalesApiError(response.status, response.status >= 500
      ? "The sales service is unavailable. Try again."
      : parsed.success ? parsed.data.error : "The sales request could not be completed. Try again.");
  }

  const envelope = GoSalesOrdersEnvelopeSchema.safeParse(body);
  if (!envelope.success) throw new SalesApiError(response.status, "The sales service returned an unexpected response while loading orders.");
  const parsedGo = GoSalesOrdersSchema.safeParse(envelope.data.data);
  if (!parsedGo.success) throw new SalesApiError(response.status, "The sales service returned data in an unexpected format.");
  return parsedGo.data.orders;
}

export type ConfirmSalesOrderResult =
  | { kind: "confirmed"; backordered: boolean }
  | { kind: "pending"; reason: string };

export async function confirmSalesOrder(orderId: string, intentId: string, organizationId: string | null | undefined, allowBackorder = false): Promise<ConfirmSalesOrderResult> {
  const orgId = salesOrganizationId(organizationId);
  const parsedOrderId = z.string().uuid().safeParse(orderId);
  const parsedIntentId = z.string().uuid().safeParse(intentId);
  if (!parsedOrderId.success || !parsedIntentId.success) {
    throw new SalesApiError(0, "The order confirmation request is invalid. Reload and try again.");
  }

  let response: Response;
  try {
    response = await fetch("/api/capabilities/execute", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json", "X-Organization-ID": orgId },
      cache: "no-store",
      body: JSON.stringify({
        capabilityId: "sales.confirmOrder",
        input: { orderId: parsedOrderId.data, ...(allowBackorder ? { allowBackorder: true } : {}) },
        intentId: parsedIntentId.data,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new SalesApiError(0, "The confirmation result is unknown. Check the order status before trying again.");
  }

  const body: unknown = await response.json().catch(() => null);
  const pending = PendingConfirmOrderSchema.safeParse(body);
  if (response.status === 202 && pending.success) {
    return { kind: "pending", reason: pending.data.reason ?? "Order confirmation is waiting for approval." };
  }
  if (response.ok) {
    const confirmed = ConfirmOrderResponseSchema.safeParse(body);
    if (!confirmed.success) throw new SalesApiError(response.status, "The sales service returned an unexpected confirmation response.");
    return { kind: "confirmed", backordered: confirmed.data.data.backordered };
  }

  const error = z.object({ error: z.string().max(240) }).safeParse(body);
  if (response.status === 401) throw new SalesApiError(401, "Your session has ended. Sign in again to continue.");
  if (response.status === 403 || response.status === 422) {
    throw new SalesApiError(response.status, error.success ? error.data.error : "You do not have permission to confirm this order.");
  }
  throw new SalesApiError(response.status, response.status >= 500
    ? "The sales service is unavailable. Check the order status before trying again."
    : error.success ? error.data.error : "The order confirmation could not be completed.");
}

function salesOrderWriteRequest(action: SalesOrderWrite, intentId: string): { url: string; body: Record<string, unknown> } {
  const capabilityId = action.action === "create" ? "sales.createOrder"
    : action.action === "update" ? "sales.updateDraftOrder"
    : action.action === "deliver" ? "sales.deliverOrder" : "sales.cancelOrder";
  const { action: _action, ...input } = action;
  return { url: "/api/capabilities/execute", body: { capabilityId, input, intentId } };
}

export async function submitSalesOrderWrite(
  action: SalesOrderWrite,
  retryScope: SalesRetryScope,
  signal?: AbortSignal,
): Promise<SalesOrderWriteOutcome> {
  const parsedAction = SalesOrderWriteSchema.safeParse(action);
  if (!parsedAction.success) throw new SalesApiError(0, "Check the sales order details and try again.");
  const orgId = salesOrganizationId(retryScope.organizationId);
  const attempt = await createSalesOrderAttempt(parsedAction.data, retryScope, "go");
  const route = salesOrderWriteRequest(parsedAction.data, attempt.intentId);
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(route.url, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json", "X-Organization-ID": orgId },
      cache: "no-store",
      body: JSON.stringify(route.body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
    body = await response.json().catch(() => null);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new SalesApiError(0, "The sales order result is unknown. Retry the same details or check order history before changing them.");
  }

  const pending = PendingWriteSchema.safeParse(body);
  if (response.status === 202 && pending.success) {
    return { kind: "pending", reason: pending.data.reason ?? pending.data.error ?? "This sales order action is waiting for approval." };
  }
  if (!response.ok) {
    const error = ErrorSchema.safeParse(body);
    const failure = new SalesApiError(response.status, error.success ? error.data.error : "The sales order action could not be completed.");
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429 && response.status !== 404) {
      await clearSalesOrderAttempt(attempt);
    }
    throw failure;
  }
  const envelope = SalesWriteEnvelopeSchema.safeParse(body);
  if (!envelope.success) throw new SalesApiError(response.status, "The sales service returned an unexpected order response.");
  switch (parsedAction.data.action) {
    case "create": {
      const output = CreateOrderOutputSchema.safeParse(envelope.data.data);
      if (!output.success) throw new SalesApiError(response.status, "The sales service returned an unexpected order response.");
      await clearSalesOrderAttempt(attempt);
      return { kind: "completed", action: "create", data: output.data };
    }
    case "deliver": {
      const output = DeliverOrderOutputSchema.safeParse(envelope.data.data);
      if (!output.success) throw new SalesApiError(response.status, "The sales service returned an unexpected order response.");
      await clearSalesOrderAttempt(attempt);
      return { kind: "completed", action: "deliver", data: output.data };
    }
    case "update": {
      const output = UpdateDraftOrderOutputSchema.safeParse(envelope.data.data);
      if (!output.success) throw new SalesApiError(response.status, "The sales service returned an unexpected draft update response.");
      await clearSalesOrderAttempt(attempt);
      return { kind: "completed", action: "update", data: { orderId: output.data.orderId } };
    }
    case "cancel": {
      const output = CancelOrderOutputSchema.safeParse(envelope.data.data);
      if (!output.success) throw new SalesApiError(response.status, "The sales service returned an unexpected order response.");
      await clearSalesOrderAttempt(attempt);
      return { kind: "completed", action: "cancel", data: output.data };
    }
  }
}
