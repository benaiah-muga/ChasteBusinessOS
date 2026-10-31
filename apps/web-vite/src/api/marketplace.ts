import { z } from "zod";
import { normalizeRetryActorId } from "./retry-scope";

const ListingSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1).max(120),
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(100),
  summary: z.string(),
  status: z.enum(["submitted", "verified", "rejected"]),
  capabilityIds: z.array(z.string().min(1)),
  installedByOrgIds: z.array(z.string().uuid()).nullable(),
  installedHere: z.boolean(),
  updatedAt: z.string().datetime(),
}).strict();

const ListingResponseSchema = z.object({ listings: z.array(ListingSchema) });
const MarketplaceListingsCapabilityResponseSchema = z.object({
  ok: z.literal(true),
  data: ListingResponseSchema,
}).strict();
const VerifyPluginCapabilityResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ valid: z.boolean(), reason: z.string().optional() }).strict(),
}).strict();
const CapabilityPendingActionSchema = z.object({
  ok: z.literal(false),
  pendingApproval: z.literal(true),
  reason: z.string(),
  approvalId: z.string().uuid(),
}).strict();
const ActionSuccessSchemas = {
  publish: z.object({ listingId: z.string().uuid(), slug: z.string(), status: z.literal("verified") }).strict(),
  install: z.object({ installed: z.literal(true), slug: z.string(), version: z.string() }).strict(),
  uninstall: z.object({ uninstalled: z.literal(true) }).strict(),
} as const;
const ModuleResponseSchema = z.object({
  catalog: z.array(z.object({ id: z.string() })),
  enabledModules: z.array(z.string()),
});

const MarketplaceActionInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("publish"),
    manifest: z.record(z.string(), z.unknown()),
    signatureBase64: z.string().trim().min(1),
    publisherPublicKeyBase64: z.string().trim().min(1),
  }).strict(),
  z.object({ action: z.enum(["install", "uninstall"]), listingId: z.string().uuid() }).strict(),
]);

type MarketplaceActionInput = z.infer<typeof MarketplaceActionInputSchema>;
export type MarketplacePublishPayload = Omit<Extract<MarketplaceActionInput, { action: "publish" }>, "action">;
export type MarketplaceRetryScope = { actorId: string | null; organizationId: string | null };

const MARKETPLACE_ATTEMPT_PREFIX = "chaste:marketplace:go:attempt:v1:";
const MarketplaceAttemptSchema = z.object({
  fingerprint: z.string().length(64),
  intentId: z.string().uuid(),
  action: MarketplaceActionInputSchema,
}).strict();
type MarketplaceAttempt = z.infer<typeof MarketplaceAttemptSchema> & { storageKey: string };

export type MarketplaceListing = z.infer<typeof ListingSchema>;

export class MarketplaceApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "MarketplaceApiError";
  }
}

async function marketplaceDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function marketplaceScope(scope: MarketplaceRetryScope): { actorId: string; organizationId: string } {
  const actorId = normalizeRetryActorId(scope.actorId);
  const organizationId = scope.organizationId?.trim() ?? "";
  if (!actorId || !z.string().uuid().safeParse(organizationId).success) {
    throw new MarketplaceApiError(0, "Wait for your account and organization to finish loading before changing Marketplace listings.");
  }
  return { actorId, organizationId };
}

async function withMarketplaceAttemptLock<T>(storageKey: string, action: () => Promise<T>): Promise<T> {
  const lockManager = navigator.locks;
  if (!lockManager) throw new MarketplaceApiError(0, "Marketplace retry protection is unavailable in this browser. Update the browser before changing listings.");
  try {
    return await lockManager.request(`chaste:marketplace-write-marker-lock:${storageKey}`, { mode: "exclusive" }, action);
  } catch (error) {
    if (error instanceof MarketplaceApiError) throw error;
    throw new MarketplaceApiError(0, "The browser could not safely coordinate this Marketplace action across tabs. Close other Marketplace tabs and try again.");
  }
}

function parseMarketplaceAttempt(raw: string, storageKey: string): MarketplaceAttempt {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch { throw new MarketplaceApiError(0, "A saved Marketplace retry marker is damaged. Check the listing state before submitting another change."); }
  const parsed = MarketplaceAttemptSchema.safeParse(value);
  if (!parsed.success) throw new MarketplaceApiError(0, "A saved Marketplace retry marker is invalid. Check the listing state before submitting another change.");
  return { ...parsed.data, storageKey };
}

async function createMarketplaceAttempt(action: MarketplaceActionInput, scope: MarketplaceRetryScope): Promise<MarketplaceAttempt> {
  const scoped = marketplaceScope(scope);
  let fingerprint: string;
  let scopeHash: string;
  try {
    [scopeHash, fingerprint] = await Promise.all([
      marketplaceDigest(JSON.stringify(scoped)),
      marketplaceDigest(JSON.stringify({ ...scoped, action })),
    ]);
  } catch {
    throw new MarketplaceApiError(0, "Marketplace retry protection is unavailable. Check browser security settings and try again.");
  }
  const storageKey = `${MARKETPLACE_ATTEMPT_PREFIX}${scopeHash}:${fingerprint}`;
  return withMarketplaceAttemptLock(storageKey, async () => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw !== null) {
        const saved = parseMarketplaceAttempt(raw, storageKey);
        if (saved.fingerprint !== fingerprint || JSON.stringify(saved.action) !== JSON.stringify(action)) {
          throw new MarketplaceApiError(0, "A saved Marketplace action does not match this request. Check the listing before trying again.");
        }
        return saved;
      }
      const attempt = { storageKey, fingerprint, intentId: crypto.randomUUID(), action };
      window.localStorage.setItem(storageKey, JSON.stringify({ fingerprint, intentId: attempt.intentId, action }));
      const persisted = parseMarketplaceAttempt(window.localStorage.getItem(storageKey) ?? "", storageKey);
      if (persisted.fingerprint !== fingerprint || persisted.intentId !== attempt.intentId || JSON.stringify(persisted.action) !== JSON.stringify(action)) {
        throw new Error("saved attempt did not persist");
      }
      return persisted;
    } catch (error) {
      if (error instanceof MarketplaceApiError) throw error;
      throw new MarketplaceApiError(0, "Enable browser storage before changing Marketplace listings so an uncertain action can be retried safely.");
    }
  });
}

async function clearMarketplaceAttempt(attempt: MarketplaceAttempt): Promise<void> {
  try {
    await withMarketplaceAttemptLock(attempt.storageKey, async () => {
      const raw = window.localStorage.getItem(attempt.storageKey);
      if (raw === null) return;
      const saved = parseMarketplaceAttempt(raw, attempt.storageKey);
      if (saved.fingerprint === attempt.fingerprint && saved.intentId === attempt.intentId) window.localStorage.removeItem(attempt.storageKey);
    });
  } catch {
    // Keep the marker when storage cannot verify which attempt completed.
  }
}

function definitiveMarketplaceRefusal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null) as Promise<unknown>;
}

export async function fetchMarketplaceEnabled(signal?: AbortSignal): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch("/api/modules", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new MarketplaceApiError(0, "Could not check whether Creator Mode is enabled.");
  }
  const body = await readJson(response);
  if (!response.ok) throw new MarketplaceApiError(response.status, "Could not check whether Creator Mode is enabled.");
  const parsed = ModuleResponseSchema.safeParse(body);
  if (!parsed.success) throw new MarketplaceApiError(response.status, "The module switchboard returned data in an unexpected format.");
  const ids = new Set(parsed.data.catalog.map((module) => module.id));
  if (!ids.has("creator") || parsed.data.enabledModules.some((id) => !ids.has(id))) {
    throw new MarketplaceApiError(response.status, "The module switchboard returned an invalid Creator configuration.");
  }
  return parsed.data.enabledModules.includes("creator");
}

export async function fetchMarketplaceListings(signal?: AbortSignal): Promise<MarketplaceListing[]> {
  let response: Response;
  try {
    response = await fetch("/api/capabilities/execute", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        capabilityId: "creator.listMarketplace",
        input: {},
        intentId: crypto.randomUUID(),
      }),
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new MarketplaceApiError(0, "Could not reach the marketplace service.");
  }
  const body = await readJson(response);
  if (!response.ok) throw new MarketplaceApiError(response.status, "Could not load marketplace listings.");
  const parsed = MarketplaceListingsCapabilityResponseSchema.safeParse(body);
  if (!parsed.success) throw new MarketplaceApiError(response.status, "The marketplace returned data in an unexpected format.");
  return parsed.data.data.listings;
}

export async function submitMarketplaceAction(input: MarketplaceActionInput, scope: MarketplaceRetryScope, signal?: AbortSignal): Promise<{
  kind: "completed";
} | { kind: "pending"; reason: string }> {
  const parsedInput = MarketplaceActionInputSchema.safeParse(input);
  if (!parsedInput.success) throw new MarketplaceApiError(400, "Provide a valid Marketplace action.");
  const actionInput = parsedInput.data;
  const action = actionInput.action;
  const isPublish = action === "publish";
  const capabilityId = isPublish ? "creator.publishListing" : action === "install" ? "creator.installListing" : "creator.uninstallListing";
  const capabilityInput = actionInput.action === "publish" ? {
    manifest: actionInput.manifest,
    signatureBase64: actionInput.signatureBase64,
    publisherPublicKeyBase64: actionInput.publisherPublicKeyBase64,
  } : { listingId: actionInput.listingId };
  const attempt = await createMarketplaceAttempt(actionInput, scope);
  let response: Response;
  try {
    response = await fetch("/api/capabilities/execute", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        capabilityId,
        input: capabilityInput,
        intentId: attempt.intentId,
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new MarketplaceApiError(0, "Could not reach the marketplace service.");
  }
  const body: unknown = await readJson(response);
  if (response.status === 202) {
    const parsed = CapabilityPendingActionSchema.safeParse(body);
    if (!parsed.success) throw new MarketplaceApiError(response.status, "The marketplace returned an unexpected approval response.");
    return { kind: "pending", reason: parsed.data.reason };
  }
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : "The marketplace could not complete that action.";
    if (definitiveMarketplaceRefusal(response.status)) await clearMarketplaceAttempt(attempt);
    throw new MarketplaceApiError(response.status, message);
  }
  if (response.status !== 200 || !Object.hasOwn(ActionSuccessSchemas, action)) {
    throw new MarketplaceApiError(response.status, "The marketplace returned an unexpected action response.");
  }
  const dataSchema = ActionSuccessSchemas[action as keyof typeof ActionSuccessSchemas];
  const parsed = z.object({ ok: z.literal(true), data: dataSchema }).strict().safeParse(body);
  if (!parsed.success) throw new MarketplaceApiError(response.status, "The marketplace returned an unexpected action response.");
  await clearMarketplaceAttempt(attempt);
  return { kind: "completed" };
}

export async function verifyMarketplaceListing(input: Record<string, unknown>, signal?: AbortSignal): Promise<{
  valid: boolean;
  reason?: string;
}> {
  const verifyInput = {
    manifest: input.manifest,
    signatureBase64: input.signatureBase64,
    publisherPublicKeyBase64: input.publisherPublicKeyBase64,
  };
  let response: Response;
  try {
    response = await fetch("/api/capabilities/execute", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        capabilityId: "creator.verifyPlugin",
        input: verifyInput,
        intentId: crypto.randomUUID(),
      }),
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new MarketplaceApiError(0, "Could not reach the marketplace service.");
  }
  const body: unknown = await readJson(response);
  if (!response.ok) {
    const failure = z.object({ ok: z.literal(false), error: z.string() }).strict().safeParse(body);
    throw new MarketplaceApiError(response.status, failure.success ? failure.data.error : "The marketplace could not verify this listing.");
  }
  const parsed = VerifyPluginCapabilityResponseSchema.safeParse(body);
  if (!parsed.success || response.status !== 200) {
    throw new MarketplaceApiError(response.status, "The marketplace returned an unexpected verification response.");
  }
  return {
    valid: parsed.data.data.valid,
    ...(parsed.data.data.reason ? { reason: parsed.data.data.reason } : {}),
  };
}
