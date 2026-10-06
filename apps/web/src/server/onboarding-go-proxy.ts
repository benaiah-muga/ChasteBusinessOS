import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { z } from "zod";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
const PROXY_TIMEOUT_MS = 20_000;

const createInputSchema = z.object({
  orgName: z.string().min(2).max(80),
  businessDescription: z.string().min(20).max(8000),
  baseCurrency: z.string().length(3).optional(),
  path: z.enum(["fresh", "import", "connect"]).optional(),
  deferredSteps: z.array(z.string().max(128)).max(100).optional(),
  intentId: z.string().min(8).max(100),
}).strict();

const successSchema = z.object({ orgId: z.string().uuid(), replayed: z.boolean() }).strict();
const errorSchema = z.object({
  error: z.string().min(1).max(300),
  code: z.enum(["unauthorized", "email_not_verified", "forbidden", "invalid", "already_onboarded", "intent_conflict", "rate_limited", "server_error"]),
  field: z.string().max(80).optional(),
  detail: z.string().max(1000).optional(),
  retryAfterSec: z.number().int().min(0).max(3600).optional(),
}).strict();

type ProxyOptions = {
  baseUrl?: string;
  timeoutMs?: number;
};

type UpstreamResponse = {
  status: number;
  body: Buffer;
};

function unavailable(): Response {
  return Response.json(
    { error: "Workspace setup is unavailable. Try again in a moment.", code: "server_error" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

export function internalApiUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const loopbackHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
        (url.protocol !== "https:" && !loopbackHttp)) return null;
    return url;
  } catch {
    return null;
  }
}

async function readBoundedBody(request: Request): Promise<Buffer | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_REQUEST_BYTES)) return null;
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      size += chunk.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function requestUpstream(
  request: Request,
  target: URL,
  body: Buffer,
  timeoutMs: number,
): Promise<UpstreamResponse> {
  const externalUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  const host = request.headers.get("host") ?? externalUrl.host;
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const requestHeaders: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "content-length": String(body.byteLength),
    host,
    ...(origin ? { origin } : {}),
    ...(request.headers.get("cookie") ? { cookie: request.headers.get("cookie")! } : {}),
    ...(request.headers.get("authorization") ? { authorization: request.headers.get("authorization")! } : {}),
    ...(forwardedProto && /^(http|https)$/.test(forwardedProto) ? { "x-forwarded-proto": forwardedProto } :
      { "x-forwarded-proto": externalUrl.protocol.slice(0, -1) }),
  };
  const transport = target.protocol === "https:" ? requestHttps : requestHttp;
  return new Promise((resolve, reject) => {
    const outgoing = transport({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: "POST",
      path: `/api/onboarding${externalUrl.search}`,
      headers: requestHeaders,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          outgoing.destroy(new Error("Go onboarding response exceeded the size limit"));
          return;
        }
        chunks.push(buffer);
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks, size) }));
      response.on("error", reject);
    });
    const timer = setTimeout(() => outgoing.destroy(new Error("Go onboarding request timed out")), timeoutMs);
    outgoing.on("close", () => clearTimeout(timer));
    outgoing.on("error", reject);
    if (request.signal.aborted) {
      outgoing.destroy(new Error("Onboarding request was cancelled"));
      return;
    }
    const abort = () => outgoing.destroy(new Error("Onboarding request was cancelled"));
    request.signal.addEventListener("abort", abort, { once: true });
    outgoing.on("close", () => request.signal.removeEventListener("abort", abort));
    outgoing.end(body);
  });
}

function responseFromUpstream(upstream: UpstreamResponse): Response {
  const bodyText = upstream.body.toString("utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return unavailable();
  }
  if (upstream.status === 200) {
    const parsed = successSchema.safeParse(raw);
    return parsed.success
      ? Response.json(parsed.data, { status: 200, headers: { "Cache-Control": "no-store" } })
      : unavailable();
  }
  if (![400, 401, 403, 409, 422, 429].includes(upstream.status)) return unavailable();
  const parsed = errorSchema.safeParse(raw);
  if (!parsed.success) return unavailable();
  const statusMatchesCode =
    (upstream.status === 400 && parsed.data.code === "invalid") ||
    (upstream.status === 401 && parsed.data.code === "unauthorized") ||
    (upstream.status === 403 && ["email_not_verified", "forbidden"].includes(parsed.data.code)) ||
    (upstream.status === 409 && ["already_onboarded", "intent_conflict"].includes(parsed.data.code)) ||
    (upstream.status === 422 && parsed.data.code === "invalid") ||
    (upstream.status === 429 && parsed.data.code === "rate_limited");
  return statusMatchesCode
    ? Response.json(parsed.data, { status: upstream.status, headers: { "Cache-Control": "no-store" } })
    : unavailable();
}

/** The legacy app is only a same-origin transport adapter; Go resolves the live session and actor. */
export async function proxyGoOnboardingCreate(request: Request, options: ProxyOptions = {}): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed", code: "invalid" }, {
      status: 405,
      headers: { "Allow": "POST", "Cache-Control": "no-store" },
    });
  }

  const body = await readBoundedBody(request);
  if (!body) {
    return Response.json({ error: "Could not read that request.", code: "invalid" }, {
      status: 413,
      headers: { "Cache-Control": "no-store" },
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body.toString("utf8"));
  } catch {
    return Response.json({ error: "Could not read that request.", code: "invalid" }, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (!createInputSchema.safeParse(raw).success) {
    return Response.json({ error: "That doesn't look right.", code: "invalid" }, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const target = internalApiUrl(options.baseUrl ?? process.env.GO_API_INTERNAL_URL ?? "http://127.0.0.1:8080");
  if (!target) return unavailable();
  try {
    return responseFromUpstream(await requestUpstream(request, target, body, options.timeoutMs ?? PROXY_TIMEOUT_MS));
  } catch {
    return unavailable();
  }
}
