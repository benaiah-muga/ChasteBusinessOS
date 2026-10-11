import { z } from "zod";
import { CrmApiError, importCrmCustomers, readCrmCustomerImportUndo, undoCrmImport, type CrmCustomerImportRow, type CrmTaskRetryScope } from "./crm";
import { importProducts, ProductsApiError, undoProductImport, type ProductImportRetryScope, type ProductImportRow } from "./products";

/**
 * The setup wizard's API seam: bootstrap a workspace, record which setup steps
 * were finished or deferred, and import the two entities a migrating business
 * almost always has a spreadsheet of.
 *
 * Go owns onboarding state and workspace writes. This module validates every
 * payload, turns errors into safe guidance, and treats a 202 as approval-pending
 * rather than success.
 */

/** Mirrors the legacy ONBOARDING_STEPS list; the two must stay identical. */
export const ONBOARDING_STEPS = [
  "business_profile",
  "import_customers",
  "import_products",
  "connect_source",
  "invite_team",
] as const;

export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number];
export type OnboardingStepStatus = "done" | "pending" | "skipped";
export type OnboardingPath = "fresh" | "import" | "connect";
export type OnboardingImportEntity = "customers" | "products";

export interface OnboardingFailure {
  code: string;
  /** Short, calm headline in product language. */
  title: string;
  /** What the user can do about it. */
  hint: string;
  /** Raw method, url, status and payload, for power users to inspect. */
  detail?: string;
  retryAfterSec?: number;
}

export type OnboardingRecovery = "signin" | "dashboard" | "retry" | "none";

export type OnboardingImportRow = Record<string, string>;
export type OnboardingImportScope = { actorId: string; organizationId: string };
export type OnboardingImportIssue = { row: number; field?: string; message: string };
export type OnboardingImportRequest = {
  rows: OnboardingImportRow[];
  rowNumbers: number[];
  currency: string;
  scope: OnboardingImportScope | null;
  errors?: OnboardingImportIssue[];
};
export type OnboardingImportResult = z.infer<typeof ImportResultSchema>;
export type OnboardingUndoResult = { undone: number; remaining: number };

const StepStatusSchema = z.enum(["done", "pending", "skipped"]);
const PathSchema = z.enum(["fresh", "import", "connect"]);

const CreateWorkspaceSchema = z.object({
  orgName: z.string().trim().min(2).max(80),
  businessDescription: z.string().trim().min(20).max(8000),
  baseCurrency: z.string().length(3),
  path: PathSchema,
  deferredSteps: z.array(z.string()).max(20),
  intentId: z.string().min(8).max(100),
}).strict();

const StepUpdateSchema = z.object({
  step: z.enum(ONBOARDING_STEPS),
  status: StepStatusSchema,
}).strict();

const CompleteUpdateSchema = z.object({ complete: z.literal(true) }).strict();

const OnboardingStateSchema = z.object({
  path: PathSchema,
  steps: z.record(z.string(), StepStatusSchema),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
}).passthrough();
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

const CreateWorkspaceResponseSchema = z.object({
  orgId: z.string().uuid(),
  replayed: z.boolean().optional(),
}).strict();
const StateResponseSchema = z.object({ state: OnboardingStateSchema }).strict();
const OnboardingChecklistResponseSchema = z.object({
  state: OnboardingStateSchema.nullable(),
  steps: z.array(z.object({
    key: z.string(),
    status: StepStatusSchema,
  }).strict()),
}).strict();
const ImportRowErrorSchema = z.object({
  row: z.number().int(),
  field: z.string().optional(),
  message: z.string(),
}).strict();
const ImportResultSchema = z.object({
  inserted: z.number().int().nonnegative(),
  skippedDuplicates: z.number().int().nonnegative(),
  skippedDuplicateRows: z.array(z.number().int()).optional(),
  errors: z.array(ImportRowErrorSchema).default([]),
  createdIds: z.array(z.string().uuid()).optional(),
  importIntentId: z.string().uuid().optional(),
}).passthrough();
const UndoResultSchema = z.object({
  undone: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
}).strict();
const ErrorBodySchema = z.object({
  code: z.string().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
  reason: z.string().optional(),
  pendingApproval: z.boolean().optional(),
}).passthrough();

const WRITE_TIMEOUT_MS = 20_000;
const GO_CAPABILITY_BODY_LIMIT = 64 * 1024;
/** Creating a workspace seeds accounts, a chart and embeddings, so it waits longer. */
const CREATE_TIMEOUT_MS = 90_000;

export class OnboardingApiError extends Error {
  constructor(readonly status: number, readonly failure: OnboardingFailure) {
    super(`${failure.title}. ${failure.hint}`);
    this.name = "OnboardingApiError";
  }
}

const KNOWN_FAILURES: Record<string, { title: string; hint: string }> = {
  unauthorized: { title: "Your session ended", hint: "Sign in again and you'll pick up right here." },
  already_onboarded: { title: "You already have a workspace", hint: "Nothing to set up - your books are open." },
  rate_limited: { title: "Too many attempts", hint: "Wait a moment and try again." },
  not_found: { title: "Set up your workspace first", hint: "This step needs a workspace to attach to." },
  forbidden: { title: "You don't have permission for this", hint: "Ask someone with the right role to perform it." },
  intent_conflict: { title: "This setup already started with different details", hint: "Start the setup again so the books match what you typed." },
};

/**
 * Turns an unsuccessful response into something a person can act on.
 *
 * A server message is only repeated when it reads like a sentence: short, and
 * free of the braces and angle brackets that would leak JSON into the UI.
 */
export function failureFromResponse(
  status: number,
  body: Record<string, unknown>,
  method: string,
  url: string,
): OnboardingFailure {
  const code = String(body.code ?? String(status));
  const message = String(body.error ?? body.message ?? "");
  const known = KNOWN_FAILURES[code];
  const friendly = known ?? {
    title: "That didn't work",
    hint:
      message && message.length <= 160 && !/[{}<>]/.test(message)
        ? message
        : "Nothing was changed. Try again in a moment.",
  };
  return {
    code,
    title: friendly.title,
    // The server's own copy already carries the countdown; don't overwrite it.
    hint: code === "rate_limited" && message ? message : friendly.hint,
    detail: `${method} ${url} => ${status}\n${JSON.stringify(body)}`,
    retryAfterSec: typeof body.retryAfterSec === "number" ? body.retryAfterSec : undefined,
  };
}

export function networkFailure(error: unknown): OnboardingFailure {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return {
      code: "timeout",
      title: "That took too long",
      hint: "The setup service did not answer in time. Nothing was changed, so try again.",
      detail: String(error),
    };
  }
  return {
    code: "network",
    title: "Can't reach the server",
    hint: "Check your connection and try again - nothing has been lost.",
    detail: String(error),
  };
}

/** Which way out the wizard offers for a given failure. */
export function recoveryFor(code: string): OnboardingRecovery {
  if (code === "pending_approval") return "none";
  if (code === "unauthorized") return "signin";
  if (code === "already_onboarded") return "dashboard";
  return "retry";
}

function requestSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface WireResponse {
  status: number;
  body: Record<string, unknown>;
}

async function send(
  url: string,
  method: "POST" | "PATCH",
  body: unknown,
  timeoutMs: number,
): Promise<WireResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: requestSignal(timeoutMs),
    });
  } catch (error) {
    throw new OnboardingApiError(0, networkFailure(error));
  }
  return { status: response.status, body: await readJson(response) };
}

/**
 * 202 is a governed write parked for approval: neither a success nor a
 * failure, so it never reaches the success parsers.
 */
function approved(wire: WireResponse, method: "POST" | "PATCH", url: string): WireResponse {
  if (wire.status === 202) {
    const parsed = ErrorBodySchema.safeParse(wire.body);
    const reason = parsed.success ? parsed.data.reason ?? parsed.data.error : undefined;
    throw new OnboardingApiError(202, {
      code: "pending_approval",
      title: "Waiting for approval",
      hint: reason ?? "This is queued for approval. It lands in the Approvals inbox first.",
      detail: `${method} ${url} => 202\n${JSON.stringify(wire.body)}`,
    });
  }
  if (wire.status < 200 || wire.status >= 300) {
    throw new OnboardingApiError(wire.status, failureFromResponse(wire.status, wire.body, method, url));
  }
  return wire;
}

export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceSchema>;

export async function readOnboardingState(): Promise<OnboardingState | null> {
  const url = "/api/onboarding";
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: requestSignal(WRITE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new OnboardingApiError(0, networkFailure(error));
  }

  const body = await readJson(response);
  if (!response.ok) {
    throw new OnboardingApiError(response.status, failureFromResponse(response.status, body, "GET", url));
  }
  const parsed = OnboardingChecklistResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new OnboardingApiError(response.status, {
      code: "invalid_response",
      title: "Setup could not be resumed",
      hint: "The setup service replied in a format we did not recognize. Try again in a moment.",
      detail: JSON.stringify(body),
    });
  }
  return parsed.data.state;
}

/**
 * One bootstrap intent per setup attempt (B01/T08): the caller creates the id
 * once and persists it, so a retry after a lost response replays the server's
 * receipt instead of creating a second organization.
 */
export async function createWorkspace(input: CreateWorkspaceInput): Promise<{ orgId: string; replayed: boolean }> {
  const parsed = CreateWorkspaceSchema.safeParse(input);
  if (!parsed.success) {
    throw new OnboardingApiError(0, {
      code: "invalid",
      title: "That doesn't look right",
      hint: "Check the business name, the description and the currency, then try again.",
    });
  }
  const wire = approved(await send("/api/onboarding", "POST", parsed.data, CREATE_TIMEOUT_MS), "POST", "/api/onboarding");
  const result = CreateWorkspaceResponseSchema.safeParse(wire.body);
  if (!result.success) {
    throw new OnboardingApiError(wire.status, {
      code: "invalid_response",
      title: "That didn't work",
      hint: "The setup service replied in a format we did not recognize. Try again in a moment.",
      detail: JSON.stringify(wire.body),
    });
  }
  return { orgId: result.data.orgId, replayed: result.data.replayed === true };
}

export async function markOnboardingStep(step: OnboardingStepKey, status: OnboardingStepStatus): Promise<void> {
  const parsed = StepUpdateSchema.safeParse({ step, status });
  if (!parsed.success) return;
  const url = "/api/onboarding";
  const wire = await send(url, "PATCH", parsed.data, WRITE_TIMEOUT_MS);
  if (!StateResponseSchema.safeParse(approved(wire, "PATCH", url).body).success) {
    throw new OnboardingApiError(wire.status, {
      code: "invalid_response",
      title: "That step was not recorded",
      hint: "The setup service replied in a format we did not recognize. The checklist may offer it again.",
      detail: JSON.stringify(wire.body),
    });
  }
}

export async function completeOnboardingSetup(): Promise<void> {
  const parsed = CompleteUpdateSchema.safeParse({ complete: true });
  if (!parsed.success) return;
  const url = "/api/onboarding";
  const wire = await send(url, "PATCH", parsed.data, WRITE_TIMEOUT_MS);
  if (!StateResponseSchema.safeParse(approved(wire, "PATCH", url).body).success) {
    throw new OnboardingApiError(wire.status, {
      code: "invalid_response",
      title: "Setup was not closed",
      hint: "The setup service replied in a format we did not recognize. Your checklist stays on your dashboard.",
      detail: JSON.stringify(wire.body),
    });
  }
}

/**
 * Governed batch import. One malformed row never cancels the rest: unmatched
 * rows come back in `errors` with their row number, duplicates are skipped
 * rather than duplicated, and `createdIds` is what makes an undo possible.
 */
function importScope(scope: OnboardingImportScope | null): {
  crm: CrmTaskRetryScope;
  products: ProductImportRetryScope;
} {
  if (!scope || !scope.actorId.trim() || !z.string().uuid().safeParse(scope.organizationId).success) {
    throw new OnboardingApiError(0, {
      code: "workspace_loading",
      title: "Your workspace is still opening",
      hint: "Wait for your new workspace to finish opening, then try the import again.",
    });
  }
  return { crm: scope, products: scope };
}

function importFailure(error: unknown): OnboardingApiError {
  if (error instanceof OnboardingApiError) return error;
  const status = error instanceof CrmApiError || error instanceof ProductsApiError ? error.status : 0;
  const message = error instanceof Error ? error.message : "The import could not be completed.";
  const code = status === 202 ? "pending_approval" : status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not_found" : status === 413 ? "payload_too_large" : status === 422 ? "invalid_input" : status === 429 ? "rate_limited" : String(status || "import_error");
  const title = code === "pending_approval" ? "Waiting for approval" : code === "forbidden" ? "You don't have permission for this" : code === "unauthorized" ? "Your session ended" : code === "rate_limited" ? "Too many attempts" : code === "invalid_input" ? "Check the import rows" : code === "payload_too_large" ? "This file is too large for one import" : "The import could not be completed";
  return new OnboardingApiError(status, {
    code,
    title,
    hint: message,
    detail: `${error instanceof Error ? error.name : "Error"}: ${message}`,
  });
}

function creditLimitMinor(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) throw new Error("Credit limits must be converted to non-negative currency minor units.");
  const minor = Number(value);
  if (!Number.isSafeInteger(minor)) throw new Error("That credit limit is too large to import safely.");
  return minor;
}

function paymentTermDays(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[\s,]/g, "");
  if (!/^\d+$/.test(cleaned)) throw new Error("Payment terms must be a non-negative whole number of days.");
  const days = Number(cleaned);
  if (!Number.isSafeInteger(days)) throw new Error("That payment term is too large to import safely.");
  return days;
}

function assertCapabilityImportFits(capabilityId: string, input: unknown): void {
  const bytes = new TextEncoder().encode(JSON.stringify({
    capabilityId,
    input,
    intentId: "00000000-0000-4000-8000-000000000000",
  })).byteLength;
  if (bytes > GO_CAPABILITY_BODY_LIMIT) {
    throw new OnboardingApiError(413, {
      code: "payload_too_large",
      title: "This file is too large for one import",
      hint: "Split the CSV into smaller files. No rows were sent or changed.",
    });
  }
}

function textValue(value: string | undefined): string {
  return value ?? "";
}

export async function importOnboardingRows(
  entity: OnboardingImportEntity,
  request: OnboardingImportRequest,
): Promise<OnboardingImportResult> {
  const { rows, rowNumbers } = request;
  if (rows.length < 1 || rows.length > 5000 || rows.length !== rowNumbers.length || new Set(rowNumbers).size !== rowNumbers.length || rowNumbers.some((number) => !Number.isSafeInteger(number) || number < 1) || !/^[A-Z]{3}$/.test(request.currency)) {
    throw new OnboardingApiError(0, {
      code: "invalid",
      title: "That file isn't ready to import",
      hint: "Check the preview: every row needs the fields the importer asked for.",
    });
  }
  const retryScope = importScope(request.scope);
  const errors = request.errors ?? [];
  try {
    if (entity === "products") {
      const productRows: ProductImportRow[] = rows.map((row, index) => ({
        rowNumber: rowNumbers[index]!,
        name: textValue(row.name),
        sku: textValue(row.sku) || undefined,
        type: ["service", "services"].includes((row.type ?? "product").trim().toLowerCase()) ? "service" : "goods",
        unit: row.unitLabel,
        salePrice: textValue(row.salePrice),
        ...(row.salePriceMinor !== undefined ? { salePriceMinor: Number(row.salePriceMinor) } : {}),
        barcode: textValue(row.barcode) || undefined,
        tags: [],
      }));
      if (productRows.length === 0) {
        throw new OnboardingApiError(0, { code: "invalid_rows", title: "No rows are ready to import", hint: "Fix the row errors in your file and try again." });
      }
      assertCapabilityImportFits("inventory.importItems", { rows: productRows.map((row) => ({
        rowNumber: row.rowNumber, name: row.name, sku: row.sku, kind: row.type === "service" ? "service" : "goods",
        unitLabel: row.unit, salePriceMinor: row.salePriceMinor, reorderPointThousandths: 0,
        barcode: row.barcode ?? null, tags: [],
      })) });
      const result = await importProducts(productRows, undefined, retryScope.products, true);
      return ImportResultSchema.parse({
        inserted: result.inserted,
        skippedDuplicates: result.skippedDuplicates,
        skippedDuplicateRows: result.skippedDuplicateRows,
        errors: [
          ...errors,
          ...result.errors,
          ...(result.skippedDuplicateRows ?? []).map((row) => ({ row, message: "A matching product already exists, so this row was skipped." })),
        ],
        createdIds: result.createdIds ?? [],
      });
    }

    const customerRows: CrmCustomerImportRow[] = rows.map((row, index) => ({
      rowNumber: rowNumbers[index]!,
      name: textValue(row.name),
      ...(textValue(row.email) ? { email: textValue(row.email) } : {}),
      ...(textValue(row.phone) ? { phone: textValue(row.phone) } : {}),
      ...(row.creditLimitMinor !== undefined ? { creditLimitMinor: creditLimitMinor(row.creditLimitMinor) } : {}),
      ...(row.paymentTermDays !== undefined ? { paymentTermDays: paymentTermDays(row.paymentTermDays) } : {}),
      allowDuplicate: false,
    }));
    if (customerRows.length === 0) {
      return ImportResultSchema.parse({ inserted: 0, skippedDuplicates: 0, errors, createdIds: [] });
    }
    assertCapabilityImportFits("crm.importCustomers", { rows: customerRows });
    const outcome = await importCrmCustomers(customerRows, undefined, true, retryScope.crm);
    if (outcome.kind === "pending") throw new OnboardingApiError(202, { code: "pending_approval", title: "Waiting for approval", hint: outcome.reason });
    const undoState = await readCrmCustomerImportUndo(retryScope.crm);
    if (!undoState || undoState.imported !== outcome.data.inserted || undoState.createdIds.length !== outcome.data.createdIds.length || !undoState.createdIds.every((id, index) => id === outcome.data.createdIds[index])) {
      throw new OnboardingApiError(200, {
        code: "invalid_response",
        title: "The import returned something unexpected",
        hint: "Nothing was confirmed as imported. Check the records before importing again.",
      });
    }
    return ImportResultSchema.parse({
      inserted: outcome.data.inserted,
      skippedDuplicates: outcome.data.skippedDuplicates,
      skippedDuplicateRows: outcome.data.skippedDuplicateRows,
      errors: [
        ...errors,
        ...(outcome.data.skippedDuplicateRows ?? []).map((row) => ({ row, message: "A matching customer already exists, so this row was skipped." })),
      ],
      createdIds: outcome.data.createdIds,
      importIntentId: undoState.importIntentId,
    });
  } catch (error) {
    throw importFailure(error);
  }
}

export async function undoOnboardingImport(
  entity: OnboardingImportEntity,
  importIds: string[],
  scope: OnboardingImportScope | null,
  importIntentId?: string,
): Promise<OnboardingUndoResult> {
  if (importIds.length < 1 || importIds.length > 5000 || new Set(importIds).size !== importIds.length || importIds.some((id) => !z.string().uuid().safeParse(id).success)) {
    throw new OnboardingApiError(0, {
      code: "invalid",
      title: "This import cannot be undone",
      hint: "There is no recent import to reverse here. Review the imported records instead.",
    });
  }
  const retryScope = importScope(scope);
  try {
    if (entity === "products") {
      const result = await undoProductImport(importIds, undefined, retryScope.products, true);
      if (result.kind === "pending") throw new OnboardingApiError(202, { code: "pending_approval", title: "Waiting for approval", hint: result.reason });
      return UndoResultSchema.parse({ undone: result.undone, remaining: result.remaining });
    }
    const result = await undoCrmImport(importIds, undefined, true, retryScope.crm, importIntentId);
    if (result.kind === "pending") throw new OnboardingApiError(202, { code: "pending_approval", title: "Waiting for approval", hint: result.reason });
    return UndoResultSchema.parse(result.data);
  } catch (error) {
    throw importFailure(error);
  }
}

/** Normalises anything thrown by this module into one renderable failure. */
export function failureOf(error: unknown): OnboardingFailure {
  if (error instanceof OnboardingApiError) return error.failure;
  return networkFailure(error);
}
