import { createHmac } from "node:crypto";
import { canonicalInputHash, type ActionContext } from "@chaste/kernel";
import type { SessionUser } from "@/server/session";

export type GoProjectsReadInput = {
  actionContext: ActionContext;
  session: Pick<SessionUser, "userId" | "orgId" | "authSessionId">;
  projectId?: string;
};

export type GoProjectsReadResult =
  | { kind: "response"; response: Response }
  | { kind: "not-dispatched" }
  | { kind: "outcome-unknown" };

function goProjectsBaseUrl(raw: string): URL | null {
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

export async function createGoProjectsReadAssertion(
  input: GoProjectsReadInput,
  secret: string,
  now = Date.now(),
): Promise<string> {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("GO_INTERNAL_AUTH_SECRET must be at least 32 bytes");
  }
  const { actor } = input.actionContext;
  const { session } = input;
  if (actor.type !== "human" || !actor.id || actor.id !== session.userId) {
    throw new Error("Go Projects reads require the resolved human actor");
  }
  if (!session.userId || !session.orgId || !session.authSessionId || actor.orgId !== session.orgId) {
    throw new Error("Go Projects reads require the resolved authenticated organization session");
  }

  const readInput = input.projectId ? { projectId: input.projectId } : {};
  const inputSHA256 = await canonicalInputHash(readInput);
  const issuedAt = Math.floor(now / 1000);
  const claims = {
    aud: "go.projects.read",
    sub: session.userId,
    org_id: actor.orgId,
    capability_id: input.projectId ? "projects.listBoard" : "projects.list",
    input_sha256: inputSHA256,
    actor_id: actor.id,
    actor_type: "human",
    permissions: [...actor.permissions].sort(),
    auth_session_id: session.authSessionId,
    iat: issuedAt,
    exp: issuedAt + 30,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export async function readGoProjects(
  input: GoProjectsReadInput,
  options: { secret?: string; baseUrl?: string; timeoutMs?: number } = {},
): Promise<GoProjectsReadResult> {
  const secret = options.secret ?? process.env.GO_INTERNAL_AUTH_SECRET;
  if (!secret) return { kind: "not-dispatched" };

  const baseUrl = goProjectsBaseUrl(options.baseUrl ?? process.env.GO_API_INTERNAL_URL ?? "http://127.0.0.1:8080");
  if (!baseUrl) return { kind: "not-dispatched" };

  let assertion: string;
  try {
    assertion = await createGoProjectsReadAssertion(input, secret);
  } catch {
    return { kind: "not-dispatched" };
  }

  const url = new URL("/__go/projects", baseUrl);
  if (input.projectId) url.searchParams.set("projectId", input.projectId);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "X-Chaste-Session-Assertion": assertion },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
    });
    const body: unknown = await response.json();
    return {
      kind: "response",
      response: Response.json(body, { status: response.status, headers: { "Cache-Control": "no-store" } }),
    };
  } catch {
    return { kind: "outcome-unknown" };
  }
}
