import { createOpenAI } from "@ai-sdk/openai";

export interface NvidiaNimConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export interface NvidiaProvider {
  provider: ReturnType<typeof createOpenAI>;
  model: (modelId?: string) => ReturnType<ReturnType<typeof createOpenAI>>;
}

export function createNvidiaProvider(cfg: NvidiaNimConfig): NvidiaProvider {
  const base = cfg.baseUrl ?? "https://integrate.api.nvidia.com/v1";

  const provider = createOpenAI({
    apiKey: cfg.apiKey,
    baseURL: base,
    name: "nvidia-nim",
  });

  return {
    provider,
    model: (modelId?: string) =>
      provider(modelId ?? cfg.model ?? "nvidia/llama-3.3-nemotron-super-49b-v1.5"),
  };
}
