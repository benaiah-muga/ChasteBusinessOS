import { z } from "zod";

/**
 * Settings client for the Vite app. Same-origin calls into the legacy
 * `/api/settings` family that the Next page already owns, so no endpoint is
 * invented here. Every governed write carries a fresh `intentId` for
 * idempotency and an HTTP 202 is surfaced as `pending`, never as an error
 * and never as a silent success.
 */

const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 20_000;

export class SettingsApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "SettingsApiError";
  }
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

const ErrorBodySchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
  hint: z.string().optional(),
});

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new SettingsApiError(response.status, "The settings service returned an unreadable response.");
  }
}

function usableServerMessage(raw: unknown): string | undefined {
  const body = ErrorBodySchema.safeParse(raw);
  const message = body.success ? body.data.error ?? body.data.message ?? body.data.hint : undefined;
  if (!message || message.length > 240 || /[{}<>]/.test(message)) return undefined;
  return message;
}

function errorMessage(status: number, raw: unknown): string {
  const serverMessage = usableServerMessage(raw);
  if (status === 401) return "Your session has ended. Sign in again to continue.";
  if (status === 403) {
    return serverMessage?.includes("harness.approve")
      ? "Runtime inspection needs the harness.approve permission."
      : "You do not have permission to change this workspace setting.";
  }
  if (status === 404) return "That setting is no longer available. Refresh and try again.";
  if (status === 409) return "The workspace changed elsewhere. Refresh and try again.";
  if (status >= 500) return "The settings service is unavailable. Try again.";
  return serverMessage ?? "The settings request could not be completed. Check the details and try again.";
}

interface RawResult {
  response: Response;
  body: unknown;
}

async function request(path: string, init: RequestInit, signal?: AbortSignal): Promise<RawResult> {
  let response: Response;
  const method = init.method ?? "GET";
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      signal: requestSignal(signal, method === "GET" ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new SettingsApiError(0, "The settings service took too long to respond. Try again.");
    }
    throw new SettingsApiError(0, "Could not reach the settings service. Check your connection and try again.");
  }
  return { response, body: await readJson(response) };
}

async function read<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const { response, body } = await request(path, init, signal);
  if (!response.ok) throw new SettingsApiError(response.status, errorMessage(response.status, body));
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new SettingsApiError(response.status, "The settings service returned data in an unexpected format.");
  return parsed.data;
}

/* --------------------------------------------------------------- modules -- */

const ModuleInfoSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string(),
  href: z.string().nullable(),
  protected: z.boolean().optional(),
}).strict();

const ModuleSwitchboardSchema = z.object({
  catalog: z.array(ModuleInfoSchema),
  enabledModules: z.array(z.string()),
  usingDefaults: z.boolean(),
}).strict();

/**
 * Platform spine, mirrored from the legacy module catalog so the client can
 * refuse to switch a core module off even if the server ever omits the flag.
 * `settings` has no catalog row at all, which is why it stays reachable no
 * matter how the switchboard is set.
 */
export const PROTECTED_MODULE_IDS = ["iam", "routines", "signals"] as const;

export type ModuleInfo = z.infer<typeof ModuleInfoSchema>;
export type ModuleSwitchboard = z.infer<typeof ModuleSwitchboardSchema>;

export function isProtectedModule(module: ModuleInfo): boolean {
  return module.protected === true || (PROTECTED_MODULE_IDS as readonly string[]).includes(module.id);
}

export function fetchModuleSwitchboard(signal?: AbortSignal): Promise<ModuleSwitchboard> {
  return read("/api/modules", ModuleSwitchboardSchema, {}, signal);
}

const ModuleSettingsReadSchema = z.object({
  module: z.string(),
  settings: z.record(z.string(), z.unknown()),
}).strict();

export type ModuleSettingsRead = z.infer<typeof ModuleSettingsReadSchema>;

const MODULE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;

export async function fetchModuleSettings(module: string, signal?: AbortSignal): Promise<ModuleSettingsRead> {
  if (!MODULE_ID_PATTERN.test(module)) throw new SettingsApiError(0, "That module name is not valid.");
  return read(`/api/module-settings?module=${encodeURIComponent(module)}`, ModuleSettingsReadSchema, {}, signal);
}

/* ---------------------------------------------------------------- policy -- */

const PolicySchema = z.object({
  maxRiskAutonomous: z.string(),
  moneyThresholdMinor: z.number().int(),
  // The Go policy bridge types this as unknown values; keep the wire loose and
  // hand the editor a clean string list.
  requiresApprovalFor: z.array(z.unknown()).transform((values) => values.filter((value): value is string => typeof value === "string")),
}).strict();

const PolicyReadSchema = z.object({
  policy: PolicySchema,
  canEdit: z.boolean(),
}).strict();

export type Policy = z.infer<typeof PolicySchema>;
export type PolicyRead = z.infer<typeof PolicyReadSchema>;

export const POLICY_RISKS = [
  { id: "read", label: "Read" },
  { id: "write", label: "Write" },
  { id: "money", label: "Money" },
  { id: "identity", label: "Identity" },
  { id: "destructive", label: "Destructive" },
] as const;

export function fetchPolicy(signal?: AbortSignal): Promise<PolicyRead> {
  return read("/api/policy", PolicyReadSchema, {}, signal);
}

/* ---------------------------------------------------------- ai + secrets -- */

const AiModelsSchema = z.object({
  primary: z.string().trim().min(1).max(200),
  fast: z.string().trim().min(1).max(200),
  reasoning: z.string().trim().min(1).max(200),
  embeddings: z.string().trim().min(1).max(200),
}).strict();

/**
 * The public model configuration. The legacy contract only ever carries a
 * short display hint (`keyHint`, at most 12 characters such as `••••1234`);
 * the stored credential itself is encrypted server-side and never crosses
 * the wire. `.strict()` keeps that honest: an unexpected field carrying key
 * material fails the parse instead of reaching a React prop.
 */
const AiConfigSchema = z.object({
  provider: z.string().min(1),
  baseUrl: z.string(),
  models: AiModelsSchema,
  configured: z.boolean(),
  keyHint: z.string().max(12).nullable().optional(),
  source: z.string(),
}).strict();

const AiConfigSaveSchema = AiConfigSchema.extend({ ok: z.literal(true).optional() }).strict();

export type AiModels = z.infer<typeof AiModelsSchema>;
export type AiConfig = z.infer<typeof AiConfigSchema>;
export type AiSaveOutcome =
  | { kind: "completed"; config: AiConfig }
  | { kind: "pending"; reason: string };

export const AI_PROVIDER_IDS = ["nvidia", "openrouter", "groq", "mistral", "zai", "openai", "custom"] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export const AI_PROVIDER_OPTIONS: ReadonlyArray<{ id: AiProviderId; label: string; baseUrl: string }> = [
  { id: "nvidia", label: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1" },
  { id: "zai", label: "Z.ai (GLM)", baseUrl: "https://api.z.ai/api/paas/v4" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { id: "custom", label: "Custom OpenAI-compatible", baseUrl: "" },
];

export const DEFAULT_AI_MODELS: AiModels = {
  primary: "moonshotai/kimi-k2.6",
  fast: "meta/muse-glimmer-30b",
  reasoning: "nvidia/nemotron-3-ultra-550b-a55b",
  embeddings: "nvidia/nv-embedqa-e5-v5",
};

export function isAiProviderId(value: string): value is AiProviderId {
  return (AI_PROVIDER_IDS as readonly string[]).includes(value);
}

export function fetchAiConfig(signal?: AbortSignal): Promise<AiConfig> {
  return read("/api/ai-config", AiConfigSchema, {}, signal);
}

const AiSaveBodySchema = z.object({
  provider: z.string().min(1),
  // Mirrors the route: a custom provider still needs a concrete endpoint.
  baseUrl: z.string().url().max(500),
  models: AiModelsSchema,
  apiKey: z.string().trim().min(1).max(1000).optional(),
  clearApiKey: z.boolean().optional(),
}).strict();

export type AiSaveInput = z.infer<typeof AiSaveBodySchema>;

/**
 * Saves the model configuration. The legacy route owns the credential: the
 * browser sends a plaintext key exactly once, the server encrypts it and
 * answers with the public config. No `intentId` here because the route does
 * not plumb one into the capability; sending one would be silently dropped.
 */
export async function saveAiConfig(input: AiSaveInput, signal?: AbortSignal): Promise<AiSaveOutcome> {
  const parsed = AiSaveBodySchema.safeParse(input);
  if (!parsed.success) throw new SettingsApiError(0, "The model configuration contains invalid details.");
  const { response, body } = await request("/api/ai-config", { method: "POST", body: JSON.stringify(parsed.data) }, signal);
  if (response.status === 202) {
    const pending = PendingApprovalSchema.safeParse(body);
    if (!pending.success) throw new SettingsApiError(202, "The settings service returned an unexpected approval response.");
    return { kind: "pending", reason: pendingReason(pending.data) };
  }
  if (!response.ok) throw new SettingsApiError(response.status, errorMessage(response.status, body));
  const config = AiConfigSaveSchema.safeParse(body);
  if (!config.success) throw new SettingsApiError(response.status, "The settings service returned an unexpected action response.");
  return { kind: "completed", config: config.data };
}

/* --------------------------------------------------------------- governed -- */

const PendingApprovalSchema = z.object({
  pendingApproval: z.literal(true),
  hint: z.string().optional(),
  reason: z.string().optional(),
  error: z.string().nullable().optional(),
}).strict();

const CompletedRecordSchema = z.record(z.string(), z.unknown());

export type GovernedOutcome =
  | { kind: "completed"; data: Record<string, unknown> }
  | { kind: "pending"; reason: string };

export type GovernedPath =
  | "/api/modules"
  | "/api/module-settings"
  | "/api/policy"
  | "/api/branding"
  | "/api/routines"
  | "/api/memory";

function pendingReason(body: z.infer<typeof PendingApprovalSchema>): string {
  return body.hint ?? body.reason ?? body.error ?? "This change is waiting for approval.";
}

/**
 * Every governed write in one place: a fresh `intentId` for idempotency,
 * HTTP 202 preserved as a pending outcome, and the raw success body handed
 * back because these routes answer with different envelopes.
 */
export async function submitGoverned(
  path: GovernedPath,
  action: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<GovernedOutcome> {
  const { response, body } = await request(
    path,
    { method: "POST", body: JSON.stringify({ ...action, intentId: crypto.randomUUID() }) },
    signal,
  );
  if (response.status === 202) {
    const pending = PendingApprovalSchema.safeParse(body);
    if (!pending.success) throw new SettingsApiError(202, "The settings service returned an unexpected approval response.");
    return { kind: "pending", reason: pendingReason(pending.data) };
  }
  if (!response.ok) throw new SettingsApiError(response.status, errorMessage(response.status, body));
  const completed = CompletedRecordSchema.safeParse(body);
  if (!completed.success) throw new SettingsApiError(response.status, "The settings service returned an unexpected action response.");
  return { kind: "completed", data: completed.data };
}

/* --------------------------------------------------------------- branding -- */

const BrandingSchema = z.object({
  logoDataUrl: z.string().nullable(),
  accentColor: z.string().nullable(),
  invoiceFooter: z.string().nullable(),
  layout: z.string(),
}).strict();

const BrandingReadSchema = z.object({
  branding: BrandingSchema.nullable(),
  canEdit: z.boolean(),
}).strict();

export type Branding = z.infer<typeof BrandingSchema>;
export type BrandingRead = z.infer<typeof BrandingReadSchema>;

export function fetchBranding(signal?: AbortSignal): Promise<BrandingRead> {
  return read("/api/branding", BrandingReadSchema, {}, signal);
}

/* ------------------------------------------------------------------ email -- */

const EmailStatusSchema = z.object({
  configured: z.boolean(),
  from: z.string().nullable(),
}).strict();

export type EmailStatus = z.infer<typeof EmailStatusSchema>;

export function fetchEmailStatus(signal?: AbortSignal): Promise<EmailStatus> {
  return read("/api/email", EmailStatusSchema, {}, signal);
}

/** SMTP proof send. Not a capability, so it never parks for approval. */
export async function sendEmailTest(to: string, signal?: AbortSignal): Promise<void> {
  const recipient = to.trim();
  if (!/.+@.+\..+/.test(recipient)) throw new SettingsApiError(0, "Enter a valid email address first.");
  const { response, body } = await request(
    "/api/email",
    { method: "POST", body: JSON.stringify({ action: "test", to: recipient, intentId: crypto.randomUUID() }) },
    signal,
  );
  if (!response.ok) throw new SettingsApiError(response.status, errorMessage(response.status, body));
}

/* --------------------------------------------------------------- routines -- */

const RoutineSchema = z.object({
  id: z.string(),
  name: z.string(),
  scheduleLabel: z.string(),
  triggerType: z.string(),
  enabled: z.boolean(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastStatus: z.string().nullable(),
  lastError: z.string().nullable(),
  webhookUrl: z.string().nullable(),
}).strict();

const RoutinesReadSchema = z.object({ routines: z.array(RoutineSchema) }).strict();

export type Routine = z.infer<typeof RoutineSchema>;

export function fetchRoutines(signal?: AbortSignal): Promise<Routine[]> {
  return read("/api/routines", RoutinesReadSchema, {}, signal).then((data) => data.routines);
}

/* ----------------------------------------------------------------- memory -- */

const MemoryEntrySchema = z.object({
  id: z.string(),
  kind: z.string(),
  source: z.string().nullable(),
  content: z.string(),
  preview: z.string(),
  createdAt: z.string(),
}).strict();

const MemoryReadSchema = z.object({
  memories: z.array(MemoryEntrySchema),
  total: z.number().int(),
  canEdit: z.boolean(),
}).strict();

export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;
export type MemoryRead = z.infer<typeof MemoryReadSchema>;

export function fetchMemory(query: string, signal?: AbortSignal): Promise<MemoryRead> {
  const trimmed = query.trim();
  const path = trimmed ? `/api/memory?q=${encodeURIComponent(trimmed)}` : "/api/memory";
  return read(path, MemoryReadSchema, {}, signal);
}

/* ---------------------------------------------------------------- runtime -- */

const CompositionInspectionSchema = z.object({
  profile: z.object({
    id: z.string(),
    version: z.string(),
    environment: z.string(),
  }).strict(),
  profileDigest: z.string(),
  compositionDigest: z.string(),
  bundles: z.array(z.object({
    id: z.string(),
    version: z.string(),
    serviceIds: z.array(z.string()),
    requiredBundleIds: z.array(z.string()).optional(),
  }).strict()),
  patches: z.array(z.object({
    id: z.string(),
    version: z.string(),
    configKeys: z.array(z.string()),
  }).strict()),
}).strict();

const CompositionsReadSchema = z.object({
  compositions: z.array(z.object({
    id: z.string(),
    createdAt: z.string(),
    inspection: CompositionInspectionSchema,
  }).strict()),
}).strict();

export type CompositionInspection = z.infer<typeof CompositionInspectionSchema>;
export type CompositionRow = z.infer<typeof CompositionsReadSchema>["compositions"][number];

export function fetchCompositions(signal?: AbortSignal): Promise<CompositionRow[]> {
  return read("/api/harness/compositions", CompositionsReadSchema, {}, signal).then((data) => data.compositions);
}

/* ------------------------------------------------------------ agent soul -- */

const SoulSchema = z.object({ agentSoul: z.string() }).strict();
const SoulSavedSchema = z.object({ ok: z.literal(true) }).strict();

/** The soul editor reads with PUT on the legacy `/api/org` route. */
export function fetchAgentSoul(signal?: AbortSignal): Promise<string> {
  return read("/api/org", SoulSchema, { method: "PUT" }, signal).then((data) => data.agentSoul);
}

export async function saveAgentSoul(agentSoul: string, signal?: AbortSignal): Promise<void> {
  const { response, body } = await request(
    "/api/org",
    { method: "PATCH", body: JSON.stringify({ agentSoul }) },
    signal,
  );
  if (!response.ok) throw new SettingsApiError(response.status, errorMessage(response.status, body));
  const saved = SoulSavedSchema.safeParse(body);
  if (!saved.success) throw new SettingsApiError(response.status, "The settings service returned an unexpected save response.");
}
