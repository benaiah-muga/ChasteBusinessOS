import { z } from "zod";
import type { InventoryTransfer } from "./inventory";

const successEnvelope = z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) }).strict();
const pendingEnvelope = z.object({
  ok: z.literal(false),
  pendingApproval: z.literal(true),
  reason: z.string().optional(),
}).passthrough();
const failureEnvelope = z.object({ ok: z.literal(false), error: z.string() }).passthrough();
const legacyFailure = z.object({ error: z.string() }).passthrough();

export class InventoryTransferApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "InventoryTransferApiError";
  }
}

export type InventoryTransferActionResult =
  | { kind: "completed" }
  | { kind: "pending"; reason: string };

export interface CreateInventoryTransferInput {
  fromLocationCode: string;
  toLocationCode: string;
  sku: string;
  quantityThousandths: number;
  note?: string;
}

export interface PartialTransferLine {
  lineId: string;
  quantityThousandths: number;
}

type InventoryTransferAction =
  | {
    action: "createTransfer";
    fromLocationCode: string;
    toLocationCode: string;
    lines: Array<{ sku: string; quantityThousandths: number }>;
    note?: string;
  }
  | { action: "confirmTransfer"; transferId: string; lines?: PartialTransferLine[] };

export async function createInventoryTransfer(input: CreateInventoryTransferInput): Promise<InventoryTransferActionResult> {
  return submit({
    action: "createTransfer",
    fromLocationCode: input.fromLocationCode,
    toLocationCode: input.toLocationCode,
    lines: [{ sku: input.sku, quantityThousandths: input.quantityThousandths }],
    ...(input.note ? { note: input.note } : {}),
  }, "Could not draft this stock transfer.");
}

export async function confirmInventoryTransfer(
  transferId: string,
  lines?: PartialTransferLine[],
): Promise<InventoryTransferActionResult> {
  return submit({
    action: "confirmTransfer",
    transferId,
    ...(lines?.length ? { lines } : {}),
  }, "Could not confirm this stock transfer.");
}

export function supportsPartialConfirmation(transfer: InventoryTransferWithLineIds): boolean {
  return transfer.lines
    .filter((line) => line.confirmedThousandths < line.quantityThousandths)
    .every((line) => typeof line.lineId === "string" && line.lineId.length > 0);
}

export type InventoryTransferWithLineIds = Omit<InventoryTransfer, "lines"> & {
  lines: Array<InventoryTransfer["lines"][number] & { lineId?: string }>;
};

async function submit(payload: InventoryTransferAction, fallback: string): Promise<InventoryTransferActionResult> {
  const intentId = crypto.randomUUID();
  const useGo = typeof __GO_INVENTORY_TRANSFER_WRITES__ !== "undefined" && __GO_INVENTORY_TRANSFER_WRITES__;
  const { action, ...input } = payload;
  const request = !useGo
    ? { url: "/api/inventory", body: { ...payload, intentId } }
    : {
      url: "/api/capabilities/execute",
      body: {
        capabilityId: action === "createTransfer" ? "inventory.createTransfer" : "inventory.confirmTransfer",
        input,
        intentId,
      },
    };

  let response: Response;
  try {
    response = await fetch(request.url, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new InventoryTransferApiError(0, timedOut
      ? "The transfer request timed out. Check transfer history before retrying to avoid moving stock twice."
      : "Could not confirm whether the transfer completed. Check transfer history before retrying.");
  }

  const body: unknown = await response.json().catch(() => null);
  if (response.status === 202) {
    const pending = pendingEnvelope.safeParse(body);
    if (!pending.success) throw new InventoryTransferApiError(202, "The inventory service returned an unexpected approval response.");
    return { kind: "pending", reason: pending.data.reason ?? "This transfer requires approval." };
  }
  if (!response.ok) {
    const failure = failureEnvelope.safeParse(body);
    const legacy = legacyFailure.safeParse(body);
    const message = failure.success ? failure.data.error : legacy.success ? legacy.data.error : fallback;
    throw new InventoryTransferApiError(response.status, message);
  }
  if (!successEnvelope.safeParse(body).success) {
    throw new InventoryTransferApiError(response.status, "The inventory service returned an unexpected transfer response.");
  }
  return { kind: "completed" };
}
