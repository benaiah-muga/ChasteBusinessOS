import { z } from "zod";

const ReservationSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  itemId: z.string().uuid(),
  sku: z.string(),
  quantityThousandths: z.number().int().safe().nonnegative(),
  reason: z.string(),
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  status: z.enum(["open", "released"]),
  createdByActorType: z.string().nullable(),
  createdByActorId: z.string().nullable(),
  releasedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

const ResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ reservations: z.array(ReservationSchema) }).strict(),
}).strict();

const ErrorSchema = z.object({ error: z.string().optional(), message: z.string().optional() });

export type GoInventoryReservation = z.infer<typeof ReservationSchema>;
export type InventoryReservationListItem = Omit<Pick<GoInventoryReservation,
  "id" | "sku" | "quantityThousandths" | "reason" | "status" | "createdAt"
>, "status"> & { status: string };

export class InventoryReservationsApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "InventoryReservationsApiError";
  }
}

export async function fetchInventoryReservations(
  organizationId: string | null | undefined,
  signal?: AbortSignal,
): Promise<InventoryReservationListItem[]> {
  const normalizedOrganizationId = organizationId?.trim();
  if (!normalizedOrganizationId || !z.string().uuid().safeParse(normalizedOrganizationId).success) {
    throw new InventoryReservationsApiError(0, "Wait for the active organization to finish loading before viewing reservations.");
  }

  let response: Response;
  try {
    response = await fetch("/api/capabilities/execute", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "X-Organization-ID": normalizedOrganizationId,
      },
      cache: "no-store",
      body: JSON.stringify({
        capabilityId: "inventory.listReservations",
        input: { openOnly: true },
        intentId: crypto.randomUUID(),
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new InventoryReservationsApiError(0, timedOut
      ? "The Go inventory service took too long to load reservations. Try again."
      : "Could not reach the Go inventory service. Check your connection and try again.");
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsedError = ErrorSchema.safeParse(body);
    const message = parsedError.success ? parsedError.data.message ?? parsedError.data.error : undefined;
    if (message?.trim()) throw new InventoryReservationsApiError(response.status, message);
    if (response.status === 401) throw new InventoryReservationsApiError(401, "Your session has ended. Sign in again to view reservations.");
    if (response.status === 403) throw new InventoryReservationsApiError(403, "You do not have permission to view inventory reservations.");
    throw new InventoryReservationsApiError(response.status, "Could not load inventory reservations. Try again.");
  }

  const parsed = ResponseSchema.safeParse(body);
  if (response.status !== 200 || !parsed.success) {
    throw new InventoryReservationsApiError(response.status, "The Go inventory service returned reservations in an unexpected format.");
  }
  return parsed.data.data.reservations.map(({ id, sku, quantityThousandths, reason, status, createdAt }) => ({
    id,
    sku,
    quantityThousandths,
    reason,
    status,
    createdAt,
  }));
}
