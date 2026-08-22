import OpenAI from "openai";

export interface ModelRef {
  /** provider id: "nim" | any OpenAI-compatible base URL key */
  provider: string;
  model: string;
}

export const MODELS = {
  primary: () => process.env.MODEL_PRIMARY ?? "moonshotai/kimi-k2.6",
  fast: () => process.env.MODEL_FAST ?? "meta/muse-glimmer-30b",
  reasoning: () => process.env.MODEL_REASONING ?? "nvidia/nemotron-3-ultra-550b-a55b",
  embeddings: () => process.env.MODEL_EMBEDDINGS ?? "nvidia/nv-embedqa-e5-v5",
} as const;

export function nimClient(opts: { apiKey?: string; baseUrl?: string } = {}) {
  const apiKey = opts.apiKey ?? process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY is not set");
  return new OpenAI({
    apiKey,
    baseURL: opts.baseUrl ?? process.env.NIM_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
  });
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
  const client = opts.client ?? nimClient();
  const res = await client.chat.completions.create({
    model: opts.model ?? MODELS.primary(),
    messages: messages.map((m) =>
      m.role === "tool" ? { ...m, tool_call_id: "adhoc" } : m,
    ) as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 4096,
  });
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
  const res = await client.embeddings.create(body as any);
  return res.data.map((d) => d.embedding as number[]);
}
