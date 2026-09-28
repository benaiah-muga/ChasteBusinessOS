import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@chaste/kernel", () => ({ logger: { warn: vi.fn() } }));

import { executeGoApprovalInbox } from "./approval-inbox-bridge";

const input = {
  userId: "64f0d8af-4b2b-48dc-92d1-1c736ca5ef59",
  orgId: "d8d95b2a-451d-4fa1-81d8-f10ee5f1a7d5",
  authSessionId: "better-auth-session-1",
  permissions: new Set(["accounting.post", "iam.admin"]),
  capabilityPermissions: {
    "accounting.recordPayment": "accounting.post",
    "iam.createRole": "iam.admin",
  },
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("executeGoApprovalInbox", () => {
  it("signs the request body, identity, permissions, and complete capability map", async () => {
    vi.stubEnv("GO_INTERNAL_AUTH_SECRET", "a-secure-bridge-secret-that-is-at-least-32-bytes");
    vi.stubEnv("GO_API_INTERNAL_URL", "http://127.0.0.1:8080");
    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
      expect(init.method).toBe("POST");
      const body = JSON.parse(String(init.body)) as { capabilityPermissions: Record<string, string> };
      expect(body.capabilityPermissions).toEqual(input.capabilityPermissions);
      const assertion = new Headers(init.headers).get("X-Chaste-Session-Assertion");
      expect(assertion).toBeTruthy();
      const [encoded] = assertion!.split(".");
      const claims = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8")) as Record<string, unknown>;
      expect(claims).toMatchObject({ aud: "go.approvals.inbox.read", sub: input.userId, org_id: input.orgId, actor_id: input.userId, actor_type: "human", auth_session_id: input.authSessionId });
      expect(claims.permissions).toEqual(["accounting.post", "iam.admin"]);
      return Response.json({ approvals: [], history: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeGoApprovalInbox(input);

    expect(result.kind).toBe("response");
    if (result.kind === "response") expect(await result.response.json()).toEqual({ approvals: [], history: [] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails closed on an invalid Go response", async () => {
    vi.stubEnv("GO_INTERNAL_AUTH_SECRET", "a-secure-bridge-secret-that-is-at-least-32-bytes");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ approvals: "invalid", history: [] })));
    expect(await executeGoApprovalInbox(input)).toEqual({ kind: "unavailable" });
  });
});
