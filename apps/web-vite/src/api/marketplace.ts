import { z } from "zod";

const ListingSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  version: z.string(),
  summary: z.string(),
  status: z.string(),
  capabilityIds: z.array(z.unknown()),
  installedByOrgIds: z.unknown().refine((value) => value !== undefined),
  installedHere: z.boolean(),
  updatedAt: z.string(),
});

const ListingResponseSchema = z.object({ listings: z.array(ListingSchema) });
const PendingActionSchema = z.object({
  ok: z.literal(false),
  pendingApproval: z.literal(true),
  reason: z.string(),
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

export type MarketplaceListing = z.infer<typeof ListingSchema>;

export class MarketplaceApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "MarketplaceApiError";
  }
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
    response = await fetch("/api/marketplace", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new MarketplaceApiError(0, "Could not reach the marketplace service.");
  }
  const body = await readJson(response);
  if (!response.ok) throw new MarketplaceApiError(response.status, "Could not load marketplace listings.");
  const parsed = ListingResponseSchema.safeParse(body);
  if (!parsed.success) throw new MarketplaceApiError(response.status, "The marketplace returned data in an unexpected format.");
  return parsed.data.listings;
}

export async function submitMarketplaceAction(input: Record<string, unknown>, signal?: AbortSignal): Promise<{
  kind: "completed";
} | { kind: "pending"; reason: string }> {
  let response: Response;
  try {
    response = await fetch("/api/marketplace", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ ...input, intentId: crypto.randomUUID() }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new MarketplaceApiError(0, "Could not reach the marketplace service.");
  }
  const body: unknown = await readJson(response);
  if (response.status === 202) {
    const parsed = PendingActionSchema.safeParse(body);
    if (!parsed.success) throw new MarketplaceApiError(response.status, "The marketplace returned an unexpected approval response.");
    return { kind: "pending", reason: parsed.data.reason };
  }
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : "The marketplace could not complete that action.";
    throw new MarketplaceApiError(response.status, message);
  }
  const action = typeof input.action === "string" ? input.action : undefined;
  if (response.status !== 200 || !action || !Object.hasOwn(ActionSuccessSchemas, action)) {
    throw new MarketplaceApiError(response.status, "The marketplace returned an unexpected action response.");
  }
  const dataSchema = ActionSuccessSchemas[action as keyof typeof ActionSuccessSchemas];
  const parsed = z.object({ ok: z.literal(true), data: dataSchema }).strict().safeParse(body);
  if (!parsed.success) throw new MarketplaceApiError(response.status, "The marketplace returned an unexpected action response.");
  return { kind: "completed" };
}

export async function verifyMarketplaceListing(input: Record<string, unknown>, signal?: AbortSignal): Promise<{
  valid: boolean;
  reason?: string;
}> {
  let response: Response;
  try {
    response = await fetch("/api/marketplace", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(input),
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new MarketplaceApiError(0, "Could not reach the marketplace service.");
  }
  const body: unknown = await readJson(response);
  if (!response.ok && response.status !== 422) {
    const failure = z.object({ ok: z.literal(false), error: z.string() }).safeParse(body);
    throw new MarketplaceApiError(response.status, failure.success ? failure.data.error : "The marketplace could not verify this listing.");
  }
  const parsed = z.object({ valid: z.boolean(), reason: z.string().optional(), problems: z.array(z.string()).optional() }).safeParse(body);
  if (!parsed.success || ![200, 422].includes(response.status)) {
    throw new MarketplaceApiError(response.status, "The marketplace returned an unexpected verification response.");
  }
  return {
    valid: parsed.data.valid,
    ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
    ...(parsed.data.problems?.length ? { reason: parsed.data.problems.join("; ") } : {}),
  };
}
