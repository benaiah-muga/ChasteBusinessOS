import { createHmac } from "node:crypto";
import { z } from "zod";
import { canonicalInputHash, type ActionContext } from "@chaste/kernel";
import type { SessionUser } from "@/server/session";

const goCapabilityResponseSchemas = new Map<number, z.ZodType>([
  [200, z.object({ ok: z.literal(true), data: z.unknown(), replayed: z.boolean().optional() })],
  [202, z.object({ ok: z.literal(false), pendingApproval: z.literal(true), reason: z.string(), approvalId: z.string().optional() })],
  [400, z.object({ error: z.string() })],
  [401, z.object({ error: z.string() })],
  [403, z.object({ error: z.string() })],
  [422, z.object({ ok: z.literal(false), error: z.string() })],
  [500, z.object({ error: z.string() })],
  [503, z.object({ error: z.string() })],
]);

const goApprovalResponseSchema = z.object({
  ok: z.boolean(),
  status: z.string().optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

export type GoCapabilityBridgeResult =
  | { kind: "response"; response: Response }
  | { kind: "not-dispatched" }
  | { kind: "outcome-unknown" };

export type GoApprovalDecisionBridgeResult =
  | { kind: "response"; response: Response }
  | { kind: "not-dispatched" }
  | { kind: "outcome-unknown" };

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

/** Calls the private Go executor with a one-use signed assertion, never browser cookies. */
export async function executeGoCapability(
  input: GoCapabilityExecutionAssertionInput,
  options: { secret?: string; baseUrl?: string; timeoutMs?: number } = {},
): Promise<GoCapabilityBridgeResult> {
  const secret = options.secret ?? process.env.GO_INTERNAL_AUTH_SECRET;
  if (!secret) return { kind: "not-dispatched" };

  const baseUrl = goInternalBaseUrl(options.baseUrl ?? process.env.GO_API_INTERNAL_URL ?? "http://127.0.0.1:8080");
  if (!baseUrl) return { kind: "not-dispatched" };

  let assertion: string;
  let body: string;
  try {
    assertion = await createGoCapabilityExecutionAssertion(input, secret);
    body = JSON.stringify({ capabilityId: input.capabilityId, input: input.input });
    if (Buffer.byteLength(body, "utf8") > 65536) return { kind: "not-dispatched" };
  } catch {
    return { kind: "not-dispatched" };
  }

  try {
    const response = await fetch(new URL("/__go/capability/execute", baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Chaste-Session-Assertion": assertion,
      },
      body,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
    });
    const schema = goCapabilityResponseSchemas.get(response.status);
    if (!schema) return { kind: "outcome-unknown" };
    const parsed = schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return { kind: "outcome-unknown" };
    return {
      kind: "response",
      response: Response.json(parsed.data, { status: response.status, headers: { "Cache-Control": "no-store" } }),
    };
  } catch {
    return { kind: "outcome-unknown" };
  }
}

/** Sends one signed internal approval decision; callers never supply an execution payload. */
export async function decideGoApproval(
  input: GoApprovalDecisionAssertionInput,
  options: { secret?: string; baseUrl?: string; timeoutMs?: number } = {},
): Promise<GoApprovalDecisionBridgeResult> {
  const secret = options.secret ?? process.env.GO_INTERNAL_AUTH_SECRET;
  if (!secret) return { kind: "not-dispatched" };

  const baseUrl = goInternalBaseUrl(options.baseUrl ?? process.env.GO_API_INTERNAL_URL ?? "http://127.0.0.1:8080");
  if (!baseUrl) return { kind: "not-dispatched" };

  let assertion: string;
  let body: string;
  try {
    assertion = await createGoApprovalDecisionAssertion(input, secret);
    const inputSHA256 = await canonicalInputHash(input.input);
    body = JSON.stringify({
      approvalId: input.approvalId,
      capabilityId: input.capabilityId,
      inputSha256: inputSHA256,
      decision: input.decision,
      ...(input.comment === undefined ? {} : { comment: input.comment }),
    });
    if (Buffer.byteLength(body, "utf8") > 16384) return { kind: "not-dispatched" };
  } catch {
    return { kind: "not-dispatched" };
  }

  try {
    const response = await fetch(new URL("/__go/approval/decide", baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Chaste-Session-Assertion": assertion,
      },
      body,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
    });
    const parsed = goApprovalResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return { kind: "outcome-unknown" };
    return {
      kind: "response",
      response: Response.json(parsed.data, { status: response.status, headers: { "Cache-Control": "no-store" } }),
    };
  } catch {
    return { kind: "outcome-unknown" };
  }
}

export type GoPolicyAssertionInput = {
  userId: string;
  orgId: string;
  canEdit: boolean;
};

export function createGoPolicyAssertion(input: GoPolicyAssertionInput, secret: string, now = Date.now()): string {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("GO_INTERNAL_AUTH_SECRET must be at least 32 bytes");
  }
  const issuedAt = Math.floor(now / 1000);
  const claims = {
    aud: "go.policy.read",
    sub: input.userId,
    org_id: input.orgId,
    can_edit: input.canEdit,
    iat: issuedAt,
    exp: issuedAt + 30,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export type GoLedgerAssertionInput = {
  userId: string;
  orgId: string;
  canReadLedger: boolean;
};

export function createGoLedgerAssertion(input: GoLedgerAssertionInput, secret: string, now = Date.now()): string {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("GO_INTERNAL_AUTH_SECRET must be at least 32 bytes");
  }
  const issuedAt = Math.floor(now / 1000);
  const claims = {
    aud: "go.ledger.read",
    sub: input.userId,
    org_id: input.orgId,
    can_edit: false,
    can_read_ledger: input.canReadLedger,
    iat: issuedAt,
    exp: issuedAt + 30,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export type GoOrgSwitchAssertionInput = {
  userId: string;
  orgId: string;
};

export function createGoOrgSwitchAssertion(input: GoOrgSwitchAssertionInput, secret: string, now = Date.now()): string {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("GO_INTERNAL_AUTH_SECRET must be at least 32 bytes");
  }
  const issuedAt = Math.floor(now / 1000);
  const claims = {
    aud: "go.org.switch",
    sub: input.userId,
    org_id: input.orgId,
    can_edit: false,
    iat: issuedAt,
    exp: issuedAt + 30,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export type GoCapabilityExecutionAssertionInput = {
  actionContext: ActionContext;
  session: Pick<SessionUser, "userId" | "orgId" | "authSessionId">;
  capabilityId: string;
  input: unknown;
};

export type GoApprovalDecisionAssertionInput = {
  actionContext: ActionContext;
  session: Pick<SessionUser, "userId" | "orgId" | "authSessionId">;
  approvalId: string;
  capabilityId: string;
  input: unknown;
  decision: "approve" | "reject";
  comment?: string;
};

/** Signs one human decision while binding it to the stored capability input. */
export async function createGoApprovalDecisionAssertion(
  input: GoApprovalDecisionAssertionInput,
  secret: string,
  now = Date.now(),
): Promise<string> {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("GO_INTERNAL_AUTH_SECRET must be at least 32 bytes");
  }
  const { actionContext, session } = input;
  const actor = actionContext.actor;
  if (actor.type !== "human" || !actor.id || actor.id !== session.userId) {
    throw new Error("Go approval decisions require the resolved human actor");
  }
  if (!session.userId || !session.orgId || !session.authSessionId || actor.orgId !== session.orgId) {
    throw new Error("Go approval decisions require the resolved authenticated organization session");
  }
  if (!input.approvalId || !input.capabilityId || !["approve", "reject"].includes(input.decision)) {
    throw new Error("Go approval decision assertion is incomplete");
  }
  if (input.comment !== undefined && [...input.comment].reduce((count, char) => count + (char.length === 2 ? 2 : 1), 0) > 2000) {
    throw new Error("Go approval decision comment is too long");
  }

  const inputSHA256 = await canonicalInputHash(input.input);
  const issuedAt = Math.floor(now / 1000);
  const claims = {
    aud: "go.approval.decide",
    sub: session.userId,
    org_id: actor.orgId,
    capability_id: input.capabilityId,
    input_sha256: inputSHA256,
    actor_id: actor.id,
    actor_type: "human",
    permissions: [...actor.permissions].sort(),
    auth_session_id: session.authSessionId,
    approval_id: input.approvalId,
    decision: input.decision,
    ...(input.comment === undefined ? {} : { comment: input.comment }),
    iat: issuedAt,
    exp: issuedAt + 30,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

/** Signs server-resolved actor and auth context for one validated capability input. */
export async function createGoCapabilityExecutionAssertion(
  input: GoCapabilityExecutionAssertionInput,
  secret: string,
  now = Date.now(),
): Promise<string> {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("GO_INTERNAL_AUTH_SECRET must be at least 32 bytes");
  }

  const { actionContext, session } = input;
  const actor = actionContext.actor;
  if (actor.type !== "human" && actor.type !== "agent") {
    throw new Error("Go capability execution assertions require a human or agent actor");
  }
  if (!actor.id || actor.id !== session.userId) {
    throw new Error("Go capability execution assertions require the resolved domain user as actor");
  }
  if (actor.type === "agent" && !actionContext.sessionId) {
    throw new Error("Go capability execution assertions require an agent session for agent actors");
  }
  if (!session.userId || !session.authSessionId || !session.orgId) {
    throw new Error("Go capability execution assertions require a resolved authenticated organization session");
  }
  if (session.orgId !== actor.orgId) {
    throw new Error("Go capability execution assertion organization does not match the resolved session");
  }
  if (!input.capabilityId) {
    throw new Error("Go capability execution assertion requires a capability id");
  }

  const inputSHA256 = await canonicalInputHash(input.input);
  const issuedAt = Math.floor(now / 1000);
  const claims = {
    aud: "go.capability.execute",
    sub: session.userId,
    org_id: actor.orgId,
    capability_id: input.capabilityId,
    input_sha256: inputSHA256,
    actor_id: actor.id,
    actor_type: actor.type,
    permissions: [...actor.permissions].sort(),
    auth_session_id: session.authSessionId,
    ...(actionContext.sessionId ? { agent_session_id: actionContext.sessionId } : {}),
    ...(actionContext.intentId ? { intent_id: actionContext.intentId } : {}),
    iat: issuedAt,
    exp: issuedAt + 30,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}
