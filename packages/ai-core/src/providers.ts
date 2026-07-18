import type { AppConfig } from "@chaste/config";

/**
 * LLM provider abstraction.
 * Credentials always come from config (env/secret manager) — never from client.
 */
export interface CompletionRequest {
  system: string;
  user: string;
  temperature?: number;
}

export interface CompletionResult {
  text: string;
  provider: string;
  model: string;
}

export interface AiProvider {
  readonly id: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export class NoneProvider implements AiProvider {
  readonly id = "none";
  async complete(): Promise<CompletionResult> {
    return {
      text: "",
      provider: "none",
      model: "rules",
    };
  }
}

/** OpenAI or OpenAI-compatible HTTP API (including some local gateways). */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly id: string;
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl: string,
    id = "openai_compatible",
  ) {
    this.id = id;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: req.temperature ?? 0,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`AI provider error ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return {
      text: json.choices?.[0]?.message?.content ?? "",
      provider: this.id,
      model: this.model,
    };
  }
}

/** Local Ollama HTTP API (no API key required). */
export class OllamaProvider implements AiProvider {
  readonly id = "ollama";
  constructor(
    private readonly model: string,
    private readonly baseUrl: string,
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama error ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as { message?: { content?: string } };
    return {
      text: json.message?.content ?? "",
      provider: this.id,
      model: this.model,
    };
  }
}

export function createAiProvider(cfg: AppConfig["ai"]): AiProvider {
  switch (cfg.provider) {
    case "none":
      return new NoneProvider();
    case "ollama":
      return new OllamaProvider(cfg.model, cfg.baseUrl ?? "http://127.0.0.1:11434");
    case "openai":
      if (!cfg.apiKey) return new NoneProvider();
      return new OpenAiCompatibleProvider(
        cfg.apiKey,
        cfg.model,
        cfg.baseUrl ?? "https://api.openai.com/v1",
        "openai",
      );
    case "openai_compatible":
      if (!cfg.apiKey) return new NoneProvider();
      return new OpenAiCompatibleProvider(
        cfg.apiKey,
        cfg.model,
        cfg.baseUrl ?? "http://127.0.0.1:8080/v1",
        "openai_compatible",
      );
    case "nvidia_nim": {
      const key = cfg.nvidiaApiKey ?? cfg.apiKey;
      if (!key) return new NoneProvider();
      return new OpenAiCompatibleProvider(
        key,
        cfg.model,
        cfg.nvidiaBaseUrl ?? "https://integrate.api.nvidia.com/v1",
        "nvidia_nim",
      );
    }
    default:
      return new NoneProvider();
  }
}
