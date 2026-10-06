import { z } from "zod";

const OrderSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().nonnegative(),
  customerId: z.string().min(1),
  status: z.string().min(1),
  backordered: z.boolean(),
  totalMinor: z.number().int(),
  createdAt: z.string().datetime({ offset: true }),
});

const SalesOrdersSchema = z.object({ orders: z.array(OrderSchema) });
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
const DeliverOrderSchema = z.object({ action: z.literal("deliver"), orderId: z.string().uuid() }).strict();
const CancelOrderSchema = z.object({ action: z.literal("cancel"), orderId: z.string().uuid() }).strict();
const SalesOrderWriteSchema = z.discriminatedUnion("action", [CreateOrderSchema, DeliverOrderSchema, CancelOrderSchema]);
const PendingWriteSchema = z.object({
  ok: z.literal(false).optional(),
  pendingApproval: z.literal(true),
  reason: z.string().max(240).optional(),
  error: z.string().max(240).optional(),
  approvalId: z.string().uuid().optional(),
}).passthrough();
const SalesWriteEnvelopeSchema = z.object({ ok: z.literal(true), data: z.unknown() }).strict();
const CreateOrderOutputSchema = z.object({ orderId: z.string().uuid(), orderNumber: z.number().int().positive().safe() }).passthrough();
const DeliverOrderOutputSchema = z.object({
  invoiceId: z.string().uuid(), invoiceNumber: z.number().int().positive().safe(),
  invoiceTotalMinor: z.number().int().nonnegative().safe(), orderStatus: z.enum(["confirmed", "delivered"]),
}).passthrough();
const CancelOrderOutputSchema = z.object({ status: z.literal("cancelled"), releasedThousandths: z.number().int().nonnegative().safe() }).passthrough();
const SalesOrderAttemptPrefix = "chaste:sales-order-write-attempt:";

type SalesRetryScope = { actorId: string | null; organizationId: string | null };
type SalesOrderWrite = z.infer<typeof SalesOrderWriteSchema>;
export type SalesOrderWriteOutcome =
  | { kind: "pending"; reason: string }
  | { kind: "completed"; action: "create"; data: z.infer<typeof CreateOrderOutputSchema> }
  | { kind: "completed"; action: "deliver"; data: z.infer<typeof DeliverOrderOutputSchema> }
  | { kind: "completed"; action: "cancel"; data: z.infer<typeof CancelOrderOutputSchema> };

type SalesOrderAttempt = { storageKey: string; fingerprint: string; intentId: string };

function parseSalesOrderAttempt(value: string | null): { fingerprint: string; intentId: string } | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const attempt = parsed as { fingerprint?: unknown; intentId?: unknown };
    return typeof attempt.fingerprint === "string" && typeof attempt.intentId === "string"
      ? { fingerprint: attempt.fingerprint, intentId: attempt.intentId }
      : null;
  } catch { return null; }
}

async function salesOrderDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createSalesOrderAttempt(action: SalesOrderWrite, retryScope: SalesRetryScope): Promise<SalesOrderAttempt> {
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
  let stored: { fingerprint: string; intentId: string } | null;
  try { stored = parseSalesOrderAttempt(window.localStorage.getItem(storageKey)); }
  catch { throw new SalesApiError(0, "Enable browser storage before changing a sales order so an uncertain action can be retried safely."); }
  if (stored && stored.fingerprint !== fingerprint) {
    throw new SalesApiError(0, "A previous sales order result is unresolved. Retry that exact action or check order history before changing it.");
  }
  if (stored) return { storageKey, fingerprint, intentId: stored.intentId };
  const attempt = { storageKey, fingerprint, intentId: crypto.randomUUID() };
  try {
    window.localStorage.setItem(storageKey, JSON.stringify({ fingerprint, intentId: attempt.intentId }));
    const persisted = parseSalesOrderAttempt(window.localStorage.getItem(storageKey));
    if (!persisted || persisted.fingerprint !== fingerprint) throw new Error("saved attempt did not persist");
    return { ...attempt, intentId: persisted.intentId };
  } catch {
    throw new SalesApiError(0, "Enable browser storage before changing a sales order so an uncertain action can be retried safely.");
  }
}

function clearSalesOrderAttempt(attempt: SalesOrderAttempt): void {
  try {
    const stored = parseSalesOrderAttempt(window.localStorage.getItem(attempt.storageKey));
    if (stored?.fingerprint === attempt.fingerprint && stored.intentId === attempt.intentId) window.localStorage.removeItem(attempt.storageKey);
  } catch { /* Keep the unresolved intent if storage cannot verify it. */ }
}

export type SalesOrder = z.infer<typeof OrderSchema>;

export class SalesApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "SalesApiError";
  }
}

export async function fetchSalesEnabled(signal?: AbortSignal): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch("/api/modules", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
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

export async function fetchSalesOrders(signal?: AbortSignal): Promise<SalesOrder[]> {
  let response: Response;
  try {
    response = await fetch("/api/sales", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
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
    if (response.status === 403 || response.status === 422) {
      throw new SalesApiError(response.status, parsed.success ? parsed.data.error : "You do not have permission to view sales orders.");
    }
    throw new SalesApiError(response.status, response.status >= 500
      ? "The sales service is unavailable. Try again."
      : parsed.success ? parsed.data.error : "The sales request could not be completed. Try again.");
  }

  const parsed = SalesOrdersSchema.safeParse(body);
  if (!parsed.success) throw new SalesApiError(response.status, "The sales service returned data in an unexpected format.");
  return parsed.data.orders;
}

export type ConfirmSalesOrderResult =
  | { kind: "confirmed"; backordered: boolean }
  | { kind: "pending"; reason: string };

export async function confirmSalesOrder(orderId: string, intentId: string, allowBackorder = false): Promise<ConfirmSalesOrderResult> {
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
      headers: { accept: "application/json", "content-type": "application/json" },
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

function salesOrderWriteRequest(action: SalesOrderWrite, intentId: string, useGo: boolean): { url: string; body: Record<string, unknown> } {
  if (!useGo) return { url: "/api/sales", body: { ...action, intentId } };
  const capabilityId = action.action === "create" ? "sales.createOrder"
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
  const attempt = await createSalesOrderAttempt(parsedAction.data, retryScope);
  const useGo = typeof __GO_SALES_ORDER_WRITES__ !== "undefined" && __GO_SALES_ORDER_WRITES__;
  let route = salesOrderWriteRequest(parsedAction.data, attempt.intentId, useGo);
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(route.url, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(route.body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
    body = await response.json().catch(() => null);
    if (useGo && response.status === 404) {
      route = salesOrderWriteRequest(parsedAction.data, attempt.intentId, false);
      response = await fetch(route.url, {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(route.body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      });
      body = await response.json().catch(() => null);
    }
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
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) clearSalesOrderAttempt(attempt);
    throw failure;
  }
  const envelope = SalesWriteEnvelopeSchema.safeParse(body);
  if (!envelope.success) throw new SalesApiError(response.status, "The sales service returned an unexpected order response.");
  switch (parsedAction.data.action) {
    case "create": {
      const output = CreateOrderOutputSchema.safeParse(envelope.data.data);
      if (!output.success) throw new SalesApiError(response.status, "The sales service returned an unexpected order response.");
      clearSalesOrderAttempt(attempt);
      return { kind: "completed", action: "create", data: output.data };
    }
    case "deliver": {
      const output = DeliverOrderOutputSchema.safeParse(envelope.data.data);
      if (!output.success) throw new SalesApiError(response.status, "The sales service returned an unexpected order response.");
      clearSalesOrderAttempt(attempt);
      return { kind: "completed", action: "deliver", data: output.data };
    }
    case "cancel": {
      const output = CancelOrderOutputSchema.safeParse(envelope.data.data);
      if (!output.success) throw new SalesApiError(response.status, "The sales service returned an unexpected order response.");
      clearSalesOrderAttempt(attempt);
      return { kind: "completed", action: "cancel", data: output.data };
    }
  }
}
