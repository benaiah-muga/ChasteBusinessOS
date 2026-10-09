import { z } from "zod";
import type { InventoryTransfer } from "./inventory";

const successEnvelope = z.object({ ok: z.literal(true), data: z.unknown() }).strict();
const createTransferOutput = z.object({
  transferId: z.string().uuid(),
  number: z.number().int().positive().safe(),
  status: z.literal("pending"),
}).strict();
const confirmTransferOutput = z.object({
  transferId: z.string().uuid(),
  status: z.enum(["partial", "confirmed"]),
  confirmedNowThousandths: z.number().int().nonnegative().safe(),
}).strict();
const pendingEnvelope = z.object({
  ok: z.literal(false),
  pendingApproval: z.literal(true),
  reason: z.string().optional(),
}).passthrough();
const failureEnvelope = z.object({ ok: z.literal(false), error: z.string() }).passthrough();
const legacyFailure = z.object({ error: z.string() }).passthrough();
const TransferAttemptSchema = z.object({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/i),
  intentId: z.string().uuid(),
  route: z.enum(["go", "legacy"]).optional(),
}).strict();

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

export interface InventoryTransferRetryScope {
  actorId: string | null;
  organizationId: string | null;
}

type InventoryTransferAttempt = { storageKey: string; fingerprint: string; intentId: string; route: "go" | "legacy" };
const transferAttemptPrefix = "chaste:inventory-transfer-attempt:";

function parseTransferAttempt(value: string | null): { fingerprint: string; intentId: string; route?: "go" | "legacy" } | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const attempt = TransferAttemptSchema.safeParse(parsed);
    if (attempt.success) return attempt.data;
  } catch {
    // A nonempty marker can represent a request whose outcome is unknown.
  }
  throw new InventoryTransferApiError(0, "A saved stock transfer retry marker is malformed. Check transfer history before trying again.");
}

async function transferDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function transferScopeStorageKey(retryScope: InventoryTransferRetryScope): Promise<string> {
  const scope = { actorId: retryScope.actorId?.trim() ?? "", organizationId: retryScope.organizationId?.trim() ?? "" };
  if (!scope.actorId || !scope.organizationId) {
    throw new InventoryTransferApiError(0, "Wait for your account and organization to finish loading before changing a stock transfer.");
  }
  try {
    return `${transferAttemptPrefix}${await transferDigest(JSON.stringify(scope))}`;
  } catch {
    throw new InventoryTransferApiError(0, "Transfer retry protection is unavailable. Check browser security settings and try again.");
  }
}

export async function hasUnroutedInventoryTransferAttempt(retryScope: InventoryTransferRetryScope): Promise<boolean> {
  const storageKey = await transferScopeStorageKey(retryScope);
  try {
    const stored = parseTransferAttempt(window.localStorage.getItem(storageKey));
    return Boolean(stored && !stored.route);
  } catch (error) {
    if (error instanceof InventoryTransferApiError) throw error;
    throw new InventoryTransferApiError(0, "Enable browser storage to check for an unresolved stock transfer.");
  }
}

export async function resolveUnroutedInventoryTransferAttempt(retryScope: InventoryTransferRetryScope): Promise<boolean> {
  const storageKey = await transferScopeStorageKey(retryScope);
  try {
    const stored = parseTransferAttempt(window.localStorage.getItem(storageKey));
    if (!stored || stored.route) return false;
    window.localStorage.removeItem(storageKey);
    return true;
  } catch (error) {
    if (error instanceof InventoryTransferApiError) throw error;
    throw new InventoryTransferApiError(0, "The unresolved transfer marker could not be cleared. Keep the history open and try again.");
  }
}

async function createTransferAttempt(payload: InventoryTransferAction, retryScope: InventoryTransferRetryScope, selectedGo: boolean): Promise<InventoryTransferAttempt> {
  const scope = { actorId: retryScope.actorId?.trim() ?? "", organizationId: retryScope.organizationId?.trim() ?? "" };
  if (!scope.actorId || !scope.organizationId) {
    throw new InventoryTransferApiError(0, "Wait for your account and organization to finish loading before changing a stock transfer.");
  }
  let storageKey: string;
  let fingerprint: string;
  try {
    storageKey = await transferScopeStorageKey(retryScope);
    fingerprint = await transferDigest(JSON.stringify({ ...scope, payload }));
  } catch {
    throw new InventoryTransferApiError(0, "Transfer retry protection is unavailable. Check browser security settings and try again.");
  }
  let stored: { fingerprint: string; intentId: string; route?: "go" | "legacy" } | null;
  try {
    stored = parseTransferAttempt(window.localStorage.getItem(storageKey));
  } catch (error) {
    if (error instanceof InventoryTransferApiError) throw error;
    throw new InventoryTransferApiError(0, "Enable browser storage before changing a stock transfer so an uncertain action can be retried safely.");
  }
  if (stored && stored.fingerprint !== fingerprint) {
    throw new InventoryTransferApiError(0, "A previous stock transfer result is unresolved. Retry that exact action or check transfer history before changing it.");
  }
  if (stored) {
    if (!stored.route) throw new InventoryTransferApiError(0, "An unresolved stock transfer has no recorded route, so its result cannot be retried safely. Check transfer history and contact an administrator before retrying.");
    return { storageKey, fingerprint, intentId: stored.intentId, route: stored.route };
  }

  const attempt = { storageKey, fingerprint, intentId: crypto.randomUUID(), route: selectedGo ? "go" as const : "legacy" as const };
  try {
    window.localStorage.setItem(storageKey, JSON.stringify({ fingerprint, intentId: attempt.intentId, route: attempt.route }));
    const persisted = parseTransferAttempt(window.localStorage.getItem(storageKey));
    if (!persisted || persisted.fingerprint !== fingerprint || persisted.route !== attempt.route) throw new Error("saved attempt did not persist");
    return { ...attempt, intentId: persisted.intentId };
  } catch {
    throw new InventoryTransferApiError(0, "Enable browser storage before changing a stock transfer so an uncertain action can be retried safely.");
  }
}

function clearTransferAttempt(attempt: InventoryTransferAttempt): void {
  try {
    const stored = parseTransferAttempt(window.localStorage.getItem(attempt.storageKey));
    if (stored?.fingerprint === attempt.fingerprint && stored.intentId === attempt.intentId) {
      window.localStorage.removeItem(attempt.storageKey);
    }
  } catch {
    // Keep the unresolved intent if storage cannot verify it.
  }
}

export async function createInventoryTransfer(input: CreateInventoryTransferInput, retryScope: InventoryTransferRetryScope): Promise<InventoryTransferActionResult> {
  return submit({
    action: "createTransfer",
    fromLocationCode: input.fromLocationCode,
    toLocationCode: input.toLocationCode,
    lines: [{ sku: input.sku, quantityThousandths: input.quantityThousandths }],
    ...(input.note ? { note: input.note } : {}),
  }, "Could not draft this stock transfer.", retryScope);
}

export async function confirmInventoryTransfer(
  transferId: string,
  retryScope: InventoryTransferRetryScope,
  lines?: PartialTransferLine[],
): Promise<InventoryTransferActionResult> {
  return submit({
    action: "confirmTransfer",
    transferId,
    ...(lines?.length ? { lines } : {}),
  }, "Could not confirm this stock transfer.", retryScope);
}

export function supportsPartialConfirmation(transfer: InventoryTransferWithLineIds): boolean {
  return transfer.lines
    .filter((line) => line.confirmedThousandths < line.quantityThousandths)
    .every((line) => typeof line.lineId === "string" && line.lineId.length > 0);
}

export type InventoryTransferWithLineIds = Omit<InventoryTransfer, "lines"> & {
  lines: Array<InventoryTransfer["lines"][number] & { lineId?: string }>;
};

async function submit(payload: InventoryTransferAction, fallback: string, retryScope: InventoryTransferRetryScope): Promise<InventoryTransferActionResult> {
  const selectedGo = typeof __GO_INVENTORY_TRANSFER_WRITES__ !== "undefined" && __GO_INVENTORY_TRANSFER_WRITES__;
  const attempt = await createTransferAttempt(payload, retryScope, selectedGo);
  const useGo = attempt.route === "go";
  const { action, ...input } = payload;
  const request = !useGo
    ? { url: "/api/inventory", body: { ...payload, intentId: attempt.intentId } }
    : {
      url: "/api/capabilities/execute",
      body: {
        capabilityId: action === "createTransfer" ? "inventory.createTransfer" : "inventory.confirmTransfer",
        input,
        intentId: attempt.intentId,
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
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429 && !(useGo && response.status === 404)) {
      clearTransferAttempt(attempt);
    }
    throw new InventoryTransferApiError(response.status, message);
  }
  const envelope = successEnvelope.safeParse(body);
  const output = envelope.success
    ? action === "createTransfer"
      ? createTransferOutput.safeParse(envelope.data.data)
      : confirmTransferOutput.safeParse(envelope.data.data)
    : null;
  if (!output?.success) {
    throw new InventoryTransferApiError(response.status, "The inventory service returned an unexpected transfer response.");
  }
  clearTransferAttempt(attempt);
  return { kind: "completed" };
}
