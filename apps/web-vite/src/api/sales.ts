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
}).strict();

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
