import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";
import type { ActionContext } from "@chaste/kernel";
import {
  createGoCapabilityExecutionAssertion,
  createGoApprovalDecisionAssertion,
  decideGoApproval,
  executeGoCapability,
  createGoLedgerAssertion,
  createGoOrgSwitchAssertion,
  createGoPolicyAssertion,
} from "./go-bridge";

const secret = "0123456789abcdef0123456789abcdef";
const expected = "eyJhdWQiOiJnby5wb2xpY3kucmVhZCIsInN1YiI6InVzZXItMSIsIm9yZ19pZCI6Im9yZy0xIiwiY2FuX2VkaXQiOnRydWUsImlhdCI6MTAwMCwiZXhwIjoxMDMwfQ.iK5rgaQSDOrRqdmU7ztTuJdHeo1lZMGlhOPQT67UYuM";
const expectedLedger = "eyJhdWQiOiJnby5sZWRnZXIucmVhZCIsInN1YiI6InVzZXItMSIsIm9yZ19pZCI6Im9yZy0xIiwiY2FuX2VkaXQiOmZhbHNlLCJjYW5fcmVhZF9sZWRnZXIiOnRydWUsImlhdCI6MTAwMCwiZXhwIjoxMDMwfQ.L-Mh_GnnjTTh_Gg_Ea3o8U2zHJQ5799UgPi9as7GmHM";
const expectedOrgSwitch = "eyJhdWQiOiJnby5vcmcuc3dpdGNoIiwic3ViIjoidXNlci0xIiwib3JnX2lkIjoib3JnLTEiLCJjYW5fZWRpdCI6ZmFsc2UsImlhdCI6MTAwMCwiZXhwIjoxMDMwfQ.C4hxtrgcukoLLRfAkUFkXtDaUDkXUA8dWVXEioqO2so";

afterEach(() => vi.unstubAllGlobals());

function executionContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    actor: {
      type: "agent",
      id: "agent-7",
      orgId: "org-1",
      permissions: new Set(["sales.write", "crm.read"]),
    },
    sessionId: "agent-session-22",
    intentId: "intent-44",
    now: new Date("2026-01-02T03:04:05Z"),
    services: {},
    ...overrides,
  };
}

function decodeClaims(assertion: string): Record<string, unknown> {
  const [payload] = assertion.split(".");
  return JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("Go session bridge assertion", () => {
  it("matches the Go verifier wire format", () => {
    const assertion = createGoPolicyAssertion(
      { userId: "user-1", orgId: "org-1", canEdit: true },
      secret,
      1_000_000,
    );
    expect(assertion).toBe(expected);
  });

  it("requires a strong shared secret", () => {
    expect(() => createGoPolicyAssertion({ userId: "u", orgId: "o", canEdit: false }, "short", 0)).toThrow(
      "GO_INTERNAL_AUTH_SECRET must be at least 32 bytes",
    );
  });

  it("creates a separately scoped ledger read assertion", () => {
    const assertion = createGoLedgerAssertion(
      { userId: "user-1", orgId: "org-1", canReadLedger: true },
      secret,
      1_000_000,
    );
    expect(assertion).toBe(expectedLedger);
  });

  it("creates an organization switch assertion scoped to the target membership", () => {
    const assertion = createGoOrgSwitchAssertion(
      { userId: "user-1", orgId: "org-1" },
      secret,
      1_000_000,
    );
    expect(assertion).toBe(expectedOrgSwitch);
  });

  it("signs server-resolved capability, actor, permission, and session claims", async () => {
    const assertion = await createGoCapabilityExecutionAssertion(
      {
        actionContext: executionContext(),
        session: { userId: "agent-7", orgId: "org-1", authSessionId: "better-auth-91" },
        capabilityId: "sales.order.create",
        input: { customer: { name: "Chaste", id: 42 }, items: ["a", "b"] },
      },
      secret,
      1_000_000,
    );
    const [payload, signature] = assertion.split(".");
    const canonicalJSON = '{"customer":{"id":42,"name":"Chaste"},"items":["a","b"]}';
    const inputSHA256 = createHash("sha256").update(canonicalJSON).digest("hex");

    expect(decodeClaims(assertion)).toEqual({
      aud: "go.capability.execute",
      sub: "agent-7",
      org_id: "org-1",
      capability_id: "sales.order.create",
      input_sha256: inputSHA256,
      actor_id: "agent-7",
      actor_type: "agent",
      permissions: ["crm.read", "sales.write"],
      auth_session_id: "better-auth-91",
      agent_session_id: "agent-session-22",
      intent_id: "intent-44",
      iat: 1000,
      exp: 1030,
    });
    expect(signature).toBe(createHmac("sha256", secret).update(payload!).digest("base64url"));
  });

  it("uses the kernel canonical input digest regardless of object key order", async () => {
    const session = { userId: "agent-7", orgId: "org-1", authSessionId: "better-auth-91" };
    const first = await createGoCapabilityExecutionAssertion(
      {
        actionContext: executionContext(),
        session,
        capabilityId: "sales.order.create",
        input: { customer: { name: "Chaste", id: 42 }, items: ["a", "b"] },
      },
      secret,
      1_000_000,
    );
    const second = await createGoCapabilityExecutionAssertion(
      {
        actionContext: executionContext(),
        session,
        capabilityId: "sales.order.create",
        input: { items: ["a", "b"], customer: { id: 42, name: "Chaste" } },
      },
      secret,
      1_000_000,
    );
    expect(decodeClaims(first).input_sha256).toBe(decodeClaims(second).input_sha256);
  });

  it("omits absent agent and intent ids for human actions", async () => {
    const assertion = await createGoCapabilityExecutionAssertion(
      {
        actionContext: executionContext({
          actor: {
            type: "human",
            id: "domain-user-1",
            orgId: "org-1",
            permissions: new Set(["crm.read"]),
          },
          sessionId: undefined,
          intentId: undefined,
        }),
        session: { userId: "domain-user-1", orgId: "org-1", authSessionId: "better-auth-91" },
        capabilityId: "crm.customer.read",
        input: {},
      },
      secret,
      1_000_000,
    );
    const claims = decodeClaims(assertion);
    expect(claims.actor_id).toBe("domain-user-1");
    expect(claims.actor_type).toBe("human");
    expect(claims.auth_session_id).toBe("better-auth-91");
    expect(claims).not.toHaveProperty("agent_session_id");
    expect(claims).not.toHaveProperty("intent_id");
  });

  it("rejects unresolved actors and agents without a session", async () => {
    const session = { userId: "agent-7", orgId: "org-1", authSessionId: "better-auth-91" };
    await expect(
      createGoCapabilityExecutionAssertion(
        {
          actionContext: executionContext({ actor: { type: "human", id: null, orgId: "org-1", permissions: new Set() } }),
          session,
          capabilityId: "crm.customer.read",
          input: {},
        },
        secret,
        1_000_000,
      ),
    ).rejects.toThrow("require the resolved domain user as actor");

    await expect(
      createGoCapabilityExecutionAssertion(
        {
          actionContext: executionContext({ sessionId: undefined }),
          session: { ...session, userId: "agent-7" },
          capabilityId: "crm.customer.read",
          input: {},
        },
        secret,
        1_000_000,
      ),
    ).rejects.toThrow("require an agent session for agent actors");
  });

  it("rejects unresolved, mismatched, or system execution context", async () => {
    const session = { userId: "agent-7", orgId: "org-1", authSessionId: "better-auth-91" };
    await expect(
      createGoCapabilityExecutionAssertion(
        {
          actionContext: executionContext(),
          session: { ...session, orgId: "org-2" },
          capabilityId: "sales.order.create",
          input: {},
        },
        secret,
        1_000_000,
      ),
    ).rejects.toThrow("organization does not match the resolved session");

    await expect(
      createGoCapabilityExecutionAssertion(
        {
          actionContext: executionContext({
            actor: { type: "system", id: null, orgId: "org-1", permissions: new Set() },
          }),
          session,
          capabilityId: "sales.order.create",
          input: {},
        },
        secret,
        1_000_000,
      ),
    ).rejects.toThrow("require a human or agent actor");

    await expect(
      createGoCapabilityExecutionAssertion(
        {
          actionContext: executionContext(),
          session: { ...session, authSessionId: "" },
          capabilityId: "sales.order.create",
          input: {},
        },
        secret,
        1_000_000,
      ),
    ).rejects.toThrow("resolved authenticated organization session");
  });

  it("requires a strong secret for capability assertions", async () => {
    await expect(
      createGoCapabilityExecutionAssertion(
        {
          actionContext: executionContext(),
          session: { userId: "agent-7", orgId: "org-1", authSessionId: "better-auth-91" },
          capabilityId: "sales.order.create",
          input: {},
        },
        "short",
        1_000_000,
      ),
    ).rejects.toThrow("GO_INTERNAL_AUTH_SECRET must be at least 32 bytes");
  });

  it("binds an approval decision to the stored capability digest and human session", async () => {
    const actionInput = { invoiceNumber: 2, amountMinor: 50_001, method: "bank_transfer" };
    const assertion = await createGoApprovalDecisionAssertion(
      {
        actionContext: executionContext({
          actor: {
            type: "human",
            id: "domain-user-1",
            orgId: "org-1",
            permissions: new Set(["accounting.post"]),
          },
          sessionId: undefined,
          intentId: undefined,
        }),
        session: { userId: "domain-user-1", orgId: "org-1", authSessionId: "better-auth-91" },
        approvalId: "approval-92",
        capabilityId: "accounting.recordPayment",
        input: actionInput,
        decision: "approve",
        comment: "Reviewed against the bank receipt",
      },
      secret,
      1_000_000,
    );
    const [payload, signature] = assertion.split(".");
    const canonicalJSON = '{"amountMinor":50001,"invoiceNumber":2,"method":"bank_transfer"}';
    const inputSHA256 = createHash("sha256").update(canonicalJSON).digest("hex");
    expect(decodeClaims(assertion)).toEqual({
      aud: "go.approval.decide",
      sub: "domain-user-1",
      org_id: "org-1",
      capability_id: "accounting.recordPayment",
      input_sha256: inputSHA256,
      actor_id: "domain-user-1",
      actor_type: "human",
      permissions: ["accounting.post"],
      auth_session_id: "better-auth-91",
      approval_id: "approval-92",
      decision: "approve",
      comment: "Reviewed against the bank receipt",
      iat: 1000,
      exp: 1030,
    });
    expect(signature).toBe(createHmac("sha256", secret).update(payload!).digest("base64url"));
  });

  it("rejects an agent decision and overlong comments", async () => {
    const base = {
      session: { userId: "agent-7", orgId: "org-1", authSessionId: "better-auth-91" },
      approvalId: "approval-92",
      capabilityId: "accounting.recordPayment",
      input: { invoiceNumber: 1, amountMinor: 50_001, method: "bank_transfer" },
      decision: "approve" as const,
    };
    await expect(
      createGoApprovalDecisionAssertion({ actionContext: executionContext(), ...base }, secret, 1_000_000),
    ).rejects.toThrow("require the resolved human actor");

    await expect(
      createGoApprovalDecisionAssertion(
        {
          actionContext: executionContext({
            actor: {
              type: "human",
              id: "domain-user-1",
              orgId: "org-1",
              permissions: new Set(["accounting.post"]),
            },
            sessionId: undefined,
            intentId: undefined,
          }),
          ...base,
          session: { userId: "domain-user-1", orgId: "org-1", authSessionId: "better-auth-91" },
          comment: "😀".repeat(1001),
        },
        secret,
        1_000_000,
      ),
    ).rejects.toThrow("comment is too long");
  });

  it("posts the signed decision without sending an execution payload", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return Response.json({ ok: true, status: "executed" }, { status: 200 });
    }));
    const input = {
      actionContext: executionContext({
        actor: {
          type: "human",
          id: "domain-user-1",
          orgId: "org-1",
          permissions: new Set(["accounting.post"]),
        },
        sessionId: undefined,
        intentId: undefined,
      }),
      session: { userId: "domain-user-1", orgId: "org-1", authSessionId: "better-auth-91" },
      approvalId: "approval-92",
      capabilityId: "accounting.recordPayment",
      input: { invoiceNumber: 2, amountMinor: 50_001, method: "bank_transfer" },
      decision: "approve" as const,
      comment: "Reviewed",
    };
    const result = await decideGoApproval(input, { secret, baseUrl: "http://127.0.0.1:8080" });
    expect(result.kind).toBe("response");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8080/__go/approval/decide");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = new Headers(calls[0]!.init.headers);
    const assertion = headers.get("X-Chaste-Session-Assertion");
    expect(assertion).toBeTruthy();
    expect(decodeClaims(assertion!)).toMatchObject({
      aud: "go.approval.decide",
      approval_id: "approval-92",
      capability_id: "accounting.recordPayment",
      decision: "approve",
    });
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      approvalId: "approval-92",
      capabilityId: "accounting.recordPayment",
      inputSha256: decodeClaims(assertion!).input_sha256,
      decision: "approve",
      comment: "Reviewed",
    });
    expect(body).not.toHaveProperty("input");
    expect(body).not.toHaveProperty("payload");
  });
});

describe("Go capability BFF bridge", () => {
  const input = {
    actionContext: executionContext({
      actor: {
        type: "human" as const,
        id: "domain-user-1",
        orgId: "org-1",
        permissions: new Set(["crm.write"]),
      },
      sessionId: undefined,
    }),
    session: { userId: "domain-user-1", orgId: "org-1", authSessionId: "better-auth-91" },
    capabilityId: "crm.createCustomer",
    input: { name: "Chaste" },
  };
  const options = { secret, baseUrl: "http://127.0.0.1:8080" };

  it("posts only the capability request and signed assertion to the validated Go origin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: { customerId: "c-1" } }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await executeGoCapability(input, options);

    expect(response?.kind).toBe("response");
    if (response?.kind !== "response") throw new Error("expected Go response");
    expect(response.response.status).toBe(200);
    expect(await response.response.json()).toEqual({ ok: true, data: { customerId: "c-1" } });
    expect(response.response.headers.get("cache-control")).toBe("no-store");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("http://127.0.0.1:8080/__go/capability/execute");
    expect(init).toMatchObject({ method: "POST", cache: "no-store", credentials: "omit", redirect: "error" });
    expect(new Headers(init.headers).get("x-chaste-session-assertion")).toMatch(/^[^.]+\.[^.]+$/);
    expect(new Headers(init.headers).has("cookie")).toBe(false);
    expect(JSON.parse(String(init.body))).toEqual({ capabilityId: "crm.createCustomer", input: { name: "Chaste" } });
  });

  it.each([
    [202, { ok: false, pendingApproval: true, reason: "pending human approval" }],
    [422, { ok: false, error: "module disabled" }],
    [401, { error: "unauthorized" }],
    [403, { error: "forbidden" }],
  ])("preserves a validated Go %i result status", async (status, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body, { status })));

    const response = await executeGoCapability(input, options);

    expect(response?.kind).toBe("response");
    if (response?.kind !== "response") throw new Error("expected Go response");
    expect(response.response.status).toBe(status);
    expect(await response.response.json()).toEqual(body);
  });

  it("fails closed for unsafe bridge origins and malformed or unavailable responses", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await executeGoCapability(input, { ...options, baseUrl: "http://example.com" })).toEqual({ kind: "not-dispatched" });
    expect(await executeGoCapability(input, { ...options, baseUrl: "https://internal.example/path" })).toEqual({ kind: "not-dispatched" });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(Response.json({ ok: true, data: null }, { status: 500 }));
    expect(await executeGoCapability(input, options)).toEqual({ kind: "outcome-unknown" });
    fetchMock.mockResolvedValueOnce(Response.json({ ok: "yes", data: null }));
    expect(await executeGoCapability(input, options)).toEqual({ kind: "outcome-unknown" });
    fetchMock.mockRejectedValueOnce(new Error("upstream unavailable"));
    expect(await executeGoCapability(input, options)).toEqual({ kind: "outcome-unknown" });
  });
});
