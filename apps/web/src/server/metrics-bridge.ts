import { createHmac } from "node:crypto";
import { z } from "zod";

const metricsNote = "cachedInputTokens reflects provider-reported cache reads when available; null hit rate means no usage recorded yet.";

const goMetricsResponseSchema = z.object({
  totals: z.object({
    sessionsTracked: z.number().int(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cachedInputTokens: z.number(),
    cacheHitRatePct: z.number().int().nullable(),
  }).strict(),
  note: z.literal(metricsNote),
}).strict();

export type GoMetricsPayload = z.infer<typeof goMetricsResponseSchema>;

export type GoMetricsAssertionInput = {
  userId: string;
  orgId: string;
};

function goInternalBaseUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const loopbackHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(hostname);
    if (
      url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !loopbackHttp)
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export function createGoMetricsAssertion(input: GoMetricsAssertionInput, secret: string, now = Date.now()): string {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("GO_INTERNAL_AUTH_SECRET must be at least 32 bytes");
  }
  if (!z.string().uuid().safeParse(input.userId).success || !z.string().uuid().safeParse(input.orgId).success) {
    throw new Error("Go metrics assertions require valid user and organization UUIDs");
  }

  const issuedAt = Math.floor(now / 1000);
  const claims = {
    aud: "go.metrics.read",
    sub: input.userId,
    org_id: input.orgId,
    iat: issuedAt,
    exp: issuedAt + 30,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export async function readGoMetrics(
  input: GoMetricsAssertionInput,
  options: { secret?: string; baseUrl?: string; timeoutMs?: number } = {},
): Promise<GoMetricsPayload | null> {
  const secret = options.secret ?? process.env.GO_INTERNAL_AUTH_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) return null;

  const baseUrl = goInternalBaseUrl(options.baseUrl ?? process.env.GO_API_INTERNAL_URL ?? "http://127.0.0.1:8080");
  if (!baseUrl) return null;

  try {
    const assertion = createGoMetricsAssertion(input, secret);
    const response = await fetch(new URL("/__go/metrics", baseUrl), {
      method: "GET",
      headers: { "X-Chaste-Session-Assertion": assertion },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
    });
    if (!response.ok) return null;
    const parsed = goMetricsResponseSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
