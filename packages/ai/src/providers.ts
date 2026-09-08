import OpenAI from "openai";

/**
 * Model providers and routing. Started life as "nim.ts" when NVIDIA NIM was
 * the only provider; every OpenAI-compatible provider (NIM, OpenRouter,
 * Groq, Mistral, Z.ai) now lives here behind one resolveClient seam.
 */

export interface ModelRef {
  /** provider id: "nim" | any OpenAI-compatible base URL key */
  provider: string;
  model: string;
}

/** Strip a provider prefix so NIM-side callers never see "openrouter/x", "groq/x", "mistral/x" or "zai/x". */
export function stripProviderPrefix(model: string): string {
  for (const p of ["openrouter/", "groq/", "mistral/", "zai/"]) {
    if (model.startsWith(p)) return model.slice(p.length);
  }
  return model;
}

export const MODELS = {
  primary: () => stripProviderPrefix(process.env.MODEL_PRIMARY ?? "moonshotai/kimi-k2.6"),
  fast: () => stripProviderPrefix(process.env.MODEL_FAST ?? "meta/muse-glimmer-30b"),
  reasoning: () => stripProviderPrefix(process.env.MODEL_REASONING ?? "nvidia/nemotron-3-ultra-550b-a55b"),
  embeddings: () => stripProviderPrefix(process.env.MODEL_EMBEDDINGS ?? "nvidia/nv-embedqa-e5-v5"),
} as const;

export function nimClient(opts: { apiKey?: string; baseUrl?: string } = {}) {
  const apiKey = opts.apiKey ?? process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY is not set");
  return new OpenAI({
    apiKey,
    baseURL: opts.baseUrl ?? process.env.NIM_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
  });
}

/** Any OpenAI-compatible endpoint; used for OpenRouter etc. */
export function compatClient(opts: { apiKey?: string; baseUrl?: string } = {}) {
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  return new OpenAI({
    apiKey,
    baseURL: opts.baseUrl ?? "https://openrouter.ai/api/v1",
    defaultHeaders: { "X-Title": "ChasteBusinessOS" },
  });
}

/** Groq client; uses their OpenAI-compatible endpoint. */
export function groqClient(opts: { apiKey?: string; baseUrl?: string } = {}) {
  const apiKey = opts.apiKey ?? process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");
  return new OpenAI({
    apiKey,
    baseURL: opts.baseUrl ?? "https://api.groq.com/openai/v1",
  });
}

/** Mistral client; uses their OpenAI-compatible endpoint. */
export function mistralClient(opts: { apiKey?: string; baseUrl?: string } = {}) {
  const apiKey = opts.apiKey ?? process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error("MISTRAL_API_KEY is not set");
  return new OpenAI({
    apiKey,
    baseURL: opts.baseUrl ?? "https://api.mistral.ai/v1",
  });
}

/** Z.ai (Zhipu) GLM models via their OpenAI-compatible endpoint. */
export function zaiClient(opts: { apiKey?: string; baseUrl?: string } = {}) {
  const apiKey = opts.apiKey ?? process.env.ZAI_API_KEY;
  if (!apiKey) throw new Error("ZAI_API_KEY is not set");
  return new OpenAI({
    apiKey,
    baseURL: opts.baseUrl ?? process.env.ZAI_BASE_URL ?? "https://api.z.ai/api/paas/v4",
  });
}

/**
 * Provider selection: MODEL_PROVIDER=openrouter routes through
 * OPENROUTER_API_KEY (e.g. stealth/ox-alpha); MODEL_PROVIDER=groq routes
 * through GROQ_API_KEY; MODEL_PROVIDER=mistral routes through
 * MISTRAL_API_KEY; MODEL_PROVIDER=zai routes through ZAI_API_KEY (GLM
 * models); default is NVIDIA NIM. A "provider/" model prefix overrides the
 * env for that call.
 */
export function resolveClient(model?: string): OpenAI {
  const m = model ?? "";
  const provider = process.env.MODEL_PROVIDER ?? "";
  // An explicit "provider/" model prefix wins over the env default; the env
  // provider only applies to unprefixed models.
  const prefix = ["openrouter", "groq", "mistral", "zai"].find((p) => m.startsWith(`${p}/`));
  const chosen = prefix ?? ["openrouter", "groq", "mistral", "zai"].find((p) => provider === p);
  switch (chosen) {
    case "openrouter":
      return compatClient();
    case "groq":
      return groqClient();
    case "mistral":
      return mistralClient();
    case "zai":
      return zaiClient();
    default:
      return nimClient();
  }
}

/** Provider-aware client for chat-side calls; embeddings stay on NIM. */
export function chatClient(): OpenAI {
  return resolveClient();
}

export function resolveModel(): string {
  return stripProviderPrefix(process.env.MODEL_PRIMARY ?? "moonshotai/kimi-k2.6");
}

/**
 * Provider error that keeps the HTTP status and retry hint. The previous
 * implementation re-wrapped 429s as generic Errors, destroying the only
 * signal callers needed to classify retryability.
 */
export class ModelProviderError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly retryAfterMs: number | undefined,
    message: string,
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = "ModelProviderError";
  }
}

function statusOf(err: unknown): number | undefined {
  return (err as { status?: number } | null)?.status;
}

/** True for transient failures worth retrying with backoff. */
export function isRetryableModelError(err: unknown): boolean {
  const status = statusOf(err);
  if (status === 429) return true;
  if (status !== undefined && status >= 500 && status < 600) return true;
  const code = (err as { code?: string } | null)?.code;
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EAI_AGAIN";
}

export interface RetryOptions {
  /** Total attempts including the first; default 3. */
  attempts?: number;
  /** Base delay for exponential backoff; default 500ms. */
  baseDelayMs?: number;
}

/**
 * Retry with exponential backoff + jitter around provider calls. The last
 * error is rethrown as-is (typed when it came from withRateLimitHint), so
 * callers can still branch on status.
 */
export async function withRetry<T>(call: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 500;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await call();
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isRetryableModelError(err)) throw err;
      const hintMs = (err as { retryAfterMs?: number }).retryAfterMs;
      const backoff = Math.min(base * 2 ** (attempt - 1), 8_000);
      const jitter = Math.random() * backoff * 0.25;
      await new Promise((r) => setTimeout(r, hintMs ?? backoff + jitter));
    }
  }
  throw lastError;
}

/** Wraps provider errors in ModelProviderError, keeping status + reset hint. */
export async function withRateLimitHint<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    const e = err as { status?: number; headers?: Record<string, unknown>; message?: string };
    const status = e?.status;
    if (status === 429 || (status !== undefined && status >= 500)) {
      const h = e?.headers ?? {};
      const raw = h["x-ratelimit-reset"] ?? h["retry-after"];
      const seconds = typeof raw === "string" ? Number(raw) : undefined;
      const retryAfterMs =
        seconds !== undefined && Number.isFinite(seconds)
          ? // retry-after is seconds unless clearly milliseconds already
            seconds > 10_000 ? seconds : seconds * 1000
          : undefined;
      throw new ModelProviderError(
        status,
        retryAfterMs,
        `model provider rate limit hit${raw ? `, retry after ${String(raw)}` : ", try again shortly"}`,
        err,
      );
    }
    throw err;
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export async function chat(
  input: string | ChatMessage[],
  opts: { model?: string; client?: OpenAI; temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  const messages: ChatMessage[] =
    typeof input === "string" ? [{ role: "user", content: input }] : input;
  const client = opts.client ?? chatClient();
  const res = await withRetry(() =>
    withRateLimitHint(() =>
      client.chat.completions.create({
        model: opts.model ?? MODELS.primary(),
        messages: messages.map((m) =>
          m.role === "tool" ? { ...m, tool_call_id: "adhoc" } : m,
        ) as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 4096,
      }),
    ),
  );
  // NIM reasoning models return content in a nonstandard field.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m: any = res.choices[0]?.message;
  return m?.content || m?.reasoning_content || "";
}

/** Embed texts for retrieval. NVIDIA embed models require input_type per call. */
export async function embed(
  inputs: string[],
  opts: { inputType?: "query" | "passage"; client?: OpenAI; model?: string } = {},
): Promise<number[][]> {
  const client = opts.client ?? nimClient();
  const model = opts.model ?? MODELS.embeddings();
  const body: Record<string, unknown> = {
    input: inputs,
    model,
    encoding_format: "float",
    ...(model.includes("embedqa") || model.includes("nv-embed") || model.includes("nemotron-3-embed")
      ? { input_type: opts.inputType ?? "passage", truncate: "END" }
      : {}),
  };
  // NIM requires provider-specific params absent from the SDK's types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await withRetry(() => withRateLimitHint(() => client.embeddings.create(body as any)));
  return res.data.map((d) => d.embedding as number[]);
}
