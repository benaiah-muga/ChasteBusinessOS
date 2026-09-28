import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import { logger } from "@chaste/kernel";

const rowSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  sessionId: z.string().nullable(),
  requestedByUserId: z.string().nullable(),
  capabilityId: z.string(),
  riskClass: z.string(),
  payload: z.unknown(),
  rationale: z.string().nullable(),
  status: z.string(),
  decidedByUserId: z.string().nullable(),
  decisionComment: z.string().nullable(),
  expiresAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
  raisedBy: z.object({ name: z.string(), kind: z.enum(["agent", "human"]) }),
  decidedBy: z.string().nullable(),
  relatedDocuments: z.array(z.object({ id: z.string(), title: z.string() })),
}).passthrough();

const responseSchema = z.object({ approvals: z.array(rowSchema), history: z.array(rowSchema) });
export type GoApprovalInboxResponse = z.infer<typeof responseSchema>;
export type GoApprovalInboxResult = { kind: "response"; response: Response } | { kind: "unavailable" };

export async function executeGoApprovalInbox(input: {
  userId: string;
  orgId: string;
  authSessionId: string;
  permissions: ReadonlySet<string>;
  capabilityPermissions: Record<string, string>;
}): Promise<GoApprovalInboxResult> {
  const secret = process.env.GO_INTERNAL_AUTH_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    logger.warn("Go approvals inbox unavailable: bridge secret is not configured");
    return { kind: "unavailable" };
  }
  try {
    const body = JSON.stringify({ capabilityPermissions: input.capabilityPermissions });
    const issuedAt = Math.floor(Date.now() / 1000);
    const claims = {
      aud: "go.approvals.inbox.read",
      sub: input.userId,
      org_id: input.orgId,
      input_sha256: createHash("sha256").update(body).digest("hex"),
      actor_id: input.userId,
      actor_type: "human",
      permissions: [...input.permissions].sort(),
      auth_session_id: input.authSessionId,
      iat: issuedAt,
      exp: issuedAt + 30,
    };
    const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const assertion = `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
    const baseUrl = new URL(process.env.GO_API_INTERNAL_URL ?? "http://127.0.0.1:8080");
    const host = baseUrl.hostname.replace(/^\[|\]$/g, "");
    const loopbackHttp = baseUrl.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(host);
    if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || baseUrl.pathname !== "/" ||
        (baseUrl.protocol !== "https:" && !loopbackHttp)) {
      logger.warn("Go approvals inbox unavailable: bridge URL must use loopback HTTP or HTTPS");
      return { kind: "unavailable" };
    }
    const response = await fetch(new URL("/__go/approvals/inbox", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", "X-Chaste-Session-Assertion": assertion },
      body,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      logger.warn("Go approvals inbox failed", { status: response.status });
      return { kind: "unavailable" };
    }
    const parsed = responseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      logger.warn("Go approvals inbox returned an invalid response");
      return { kind: "unavailable" };
    }
    return { kind: "response", response: Response.json(parsed.data, { headers: { "Cache-Control": "no-store" } }) };
  } catch {
    logger.warn("Go approvals inbox failed");
    return { kind: "unavailable" };
  }
}
