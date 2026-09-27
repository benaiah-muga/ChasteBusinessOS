import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalInputHash, type ActionContext } from "@chaste/kernel";
import { readGoProjects } from "./projects-bridge";

const secret = "projects-read-bridge-secret-0123456789";
const session = {
  userId: "64f0d8af-4b2b-48dc-92d1-1c736ca5ef59",
  orgId: "d8d95b2a-451d-4fa1-81d8-f10ee5f1a7d5",
  authSessionId: "better-auth-session-1",
};
const actionContext: ActionContext = {
  actor: {
    type: "human",
    id: session.userId,
    orgId: session.orgId,
    permissions: new Set(["projects.read", "accounting.read"]),
  },
  now: new Date("2026-09-27T00:00:00.000Z"),
  services: {},
};

function assertionClaims(assertion: string): Record<string, unknown> {
  const payload = assertion.split(".")[0];
  if (!payload) throw new Error("assertion payload is missing");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Go Projects read bridge", () => {
  it("signs the exact unaudited collection input and sends a bodyless private GET", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return Response.json({ projects: [] });
    }));

    const result = await readGoProjects({ actionContext, session }, { secret, baseUrl: "http://127.0.0.1:8080" });

    expect(result.kind).toBe("response");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8080/__go/projects");
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.body).toBeUndefined();
    expect(calls[0]!.init.cache).toBe("no-store");
    expect(calls[0]!.init.credentials).toBe("omit");
    const headers = new Headers(calls[0]!.init.headers);
    const token = headers.get("X-Chaste-Session-Assertion");
    expect(token).toBeTruthy();
    expect(assertionClaims(token!)).toMatchObject({
      aud: "go.projects.read",
      sub: session.userId,
      org_id: session.orgId,
      actor_id: session.userId,
      actor_type: "human",
      permissions: ["accounting.read", "projects.read"],
      auth_session_id: session.authSessionId,
      capability_id: "projects.list",
      input_sha256: await canonicalInputHash({}),
    });
    if (result.kind === "response") expect(result.response.headers.get("cache-control")).toBe("no-store");
  });

  it("binds the board query value in both URL and signed digest", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return Response.json({ columns: [] });
    }));
    const projectId = "f3c65071-356d-48e4-b5cb-cccd4fc06f6d";

    const result = await readGoProjects({ actionContext, session, projectId }, { secret, baseUrl: "http://127.0.0.1:8080" });

    expect(result.kind).toBe("response");
    expect(calls[0]!.url).toBe(`http://127.0.0.1:8080/__go/projects?projectId=${projectId}`);
    const token = new Headers(calls[0]!.init.headers).get("X-Chaste-Session-Assertion");
    expect(token).toBeTruthy();
    expect(assertionClaims(token!)).toMatchObject({
      aud: "go.projects.read",
      capability_id: "projects.listBoard",
      input_sha256: await canonicalInputHash({ projectId }),
    });
  });

  it("does not sign a mismatched actor or organization and refuses a short secret", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const wrongActor = await readGoProjects(
      { actionContext: { ...actionContext, actor: { ...actionContext.actor, id: "other-user" } }, session },
      { secret, baseUrl: "http://127.0.0.1:8080" },
    );
    const shortSecret = await readGoProjects({ actionContext, session }, { secret: "short", baseUrl: "http://127.0.0.1:8080" });

    expect(wrongActor).toEqual({ kind: "not-dispatched" });
    expect(shortSecret).toEqual({ kind: "not-dispatched" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed when the response is unreadable or the network outcome is unknown", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("not json", { status: 200 })).mockRejectedValueOnce(new Error("timeout")));

    const unreadable = await readGoProjects({ actionContext, session }, { secret, baseUrl: "http://127.0.0.1:8080" });
    const unavailable = await readGoProjects({ actionContext, session }, { secret, baseUrl: "http://127.0.0.1:8080" });

    expect(unreadable).toEqual({ kind: "outcome-unknown" });
    expect(unavailable).toEqual({ kind: "outcome-unknown" });
  });
});
