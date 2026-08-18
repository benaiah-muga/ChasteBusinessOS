/**
 * AI observability — Langfuse integration for tracing LLM calls.
 * Records model, latency, token usage, cost, and prompt/completion text.
 */
import { Langfuse } from "langfuse";
import type { AiProvider, CompletionRequest, CompletionResult } from "./providers.js";

export interface TraceMetadata {
  organizationId?: string;
  userId?: string;
  sessionId?: string;
  tier?: "tier1" | "tier2" | "tier3";
  moduleName?: string;
  traceId?: string;
}

export interface AiTracer {
  traceCompletion(
    req: CompletionRequest,
    metadata: TraceMetadata,
    fn: () => Promise<CompletionResult>,
  ): Promise<CompletionResult>;
  shutdown(): Promise<void>;
}

/** No-op tracer — used when Langfuse is not configured. */
export class NoopTracer implements AiTracer {
  async traceCompletion(
    _req: CompletionRequest,
    _metadata: TraceMetadata,
    fn: () => Promise<CompletionResult>,
  ): Promise<CompletionResult> {
    return fn();
  }
  async shutdown(): Promise<void> {}
}

/** Langfuse-backed tracer — records every LLM call as a generation. */
export class LangfuseTracer implements AiTracer {
  private client: Langfuse;
  private enabled: boolean;

  constructor(config: {
    publicKey: string;
    secretKey: string;
    baseUrl?: string;
    enabled?: boolean;
  }) {
    this.enabled = config.enabled ?? true;
    if (this.enabled && config.publicKey && config.secretKey) {
      this.client = new Langfuse({
        publicKey: config.publicKey,
        secretKey: config.secretKey,
        baseUrl: config.baseUrl,
        flushAt: 1,
        flushInterval: 1000,
      });
    } else {
      this.enabled = false;
      this.client = new Langfuse({ publicKey: "disabled", secretKey: "disabled" });
    }
  }

  async traceCompletion(
    req: CompletionRequest,
    metadata: TraceMetadata,
    fn: () => Promise<CompletionResult>,
  ): Promise<CompletionResult> {
    if (!this.enabled) return fn();

    const trace = this.client.trace({
      name: `completion:${metadata.tier ?? "unknown"}`,
      userId: metadata.userId,
      sessionId: metadata.sessionId,
      metadata: {
        organizationId: metadata.organizationId,
        tier: metadata.tier,
        moduleName: metadata.moduleName,
      },
      tags: [
        metadata.tier ?? "unknown",
        metadata.moduleName ?? "general",
      ].filter(Boolean),
    });

    const generation = trace.generation({
      name: "chat-completion",
      model: "unknown",
      input: (req.messages ?? []).map((m) => ({
        role: m.role,
        parts: m.parts.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("\n"),
      })),
      metadata: {
        temperature: req.temperature,
      },
    });

    const start = Date.now();
    try {
      const result = await fn();
      const latencyMs = Date.now() - start;

      generation.end({
        output: result.text,
        usage: {
          input: result.usage?.promptTokens,
          output: result.usage?.completionTokens,
          total: result.usage?.totalTokens,
        },
        metadata: {
          provider: result.provider,
          model: result.model,
          latencyMs,
          tokensPerSecond:
            result.usage?.completionTokens && latencyMs > 0
              ? Math.round((result.usage.completionTokens / latencyMs) * 1000)
              : undefined,
        },
      });

      return result;
    } catch (err) {
      const latencyMs = Date.now() - start;
      generation.end({
        level: "ERROR",
        statusMessage: err instanceof Error ? err.message : String(err),
        metadata: { latencyMs },
      });
      throw err;
    }
  }

  async shutdown(): Promise<void> {
    if (this.enabled) {
      await this.client.shutdownAsync();
    }
  }
}

/** Create a tracer from config. Returns NoopTracer if Langfuse is not configured. */
export function createTracer(config: {
  langfusePublicKey?: string;
  langfuseSecretKey?: string;
  langfuseBaseUrl?: string;
  observabilityEnabled?: boolean;
}): AiTracer {
  if (
    config.observabilityEnabled &&
    config.langfusePublicKey &&
    config.langfuseSecretKey
  ) {
    return new LangfuseTracer({
      publicKey: config.langfusePublicKey,
      secretKey: config.langfuseSecretKey,
      baseUrl: config.langfuseBaseUrl,
      enabled: true,
    });
  }
  return new NoopTracer();
}

/** Wraps an AiProvider to trace all completions. */
export class TracedProvider implements AiProvider {
  readonly id: string;
  readonly toolCalling: boolean;

  constructor(
    private readonly inner: AiProvider,
    private readonly tracer: AiTracer,
  ) {
    this.id = inner.id;
    this.toolCalling = inner.toolCalling === true;
  }

  async complete(
    req: CompletionRequest,
    metadata?: TraceMetadata,
  ): Promise<CompletionResult> {
    return this.tracer.traceCompletion(
      req,
      metadata ?? {},
      () => this.inner.complete(req),
    );
  }

  async shutdown(): Promise<void> {
    await this.tracer.shutdown();
  }
}
