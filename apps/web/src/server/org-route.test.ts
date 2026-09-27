import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResolvedUser: vi.fn(),
  getDb: vi.fn(),
  setCookie: vi.fn(),
  createGoOrgSwitchAssertion: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: mocks.setCookie }) }));
vi.mock("@chaste/db", () => ({
  getDb: mocks.getDb,
  memberships: { orgId: "memberships.orgId", userId: "memberships.userId" },
  organizations: {
    id: "organizations.id",
    name: "organizations.name",
    baseCurrency: "organizations.baseCurrency",
  },
}));
vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => conditions,
  eq: (left: unknown, right: unknown) => ({ left, right }),
}));
vi.mock("@chaste/kernel", () => ({ hasPermission: vi.fn(), logger: { warn: mocks.loggerWarn } }));
vi.mock("@/server/go-bridge", () => ({ createGoOrgSwitchAssertion: mocks.createGoOrgSwitchAssertion }));
vi.mock("@/server/session", () => ({
  ACTIVE_ORG_COOKIE: "chaste_active_org",
  getResolvedUser: mocks.getResolvedUser,
}));

import { GET, POST } from "../app/api/org/route";

const unverifiedUser = {
  userId: "51d7103b-eac9-4bfb-a86a-a683843e8e7b",
  email: "unverified@example.test",
  name: "Unverified",
  orgId: null,
  permissions: new Set<string>(),
  allOrgIds: [],
  emailVerified: false,
};
const verifiedUser = {
  ...unverifiedUser,
  orgId: "62d994c0-a6d8-4ac2-9ec6-6689ba2bfc12",
  allOrgIds: ["62d994c0-a6d8-4ac2-9ec6-6689ba2bfc12", "21e89f2b-996f-4b18-9078-c0f2f743a5ab"],
  emailVerified: true,
};

function configureMembershipLookup(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  mocks.getDb.mockReturnValue({ db: { select } });
  return { select, from, where, limit };
}

function configureOrganizationList(rows: { id: string; name: string; baseCurrency: string }[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const innerJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ innerJoin }));
  const select = vi.fn(() => ({ from }));
  mocks.getDb.mockReturnValue({ db: { select } });
  return { select, from, innerJoin, where };
}

describe("organization route verified-email boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    delete process.env.GO_ORG_SWITCH;
    delete process.env.GO_API_INTERNAL_URL;
    delete process.env.GO_INTERNAL_AUTH_SECRET;
    mocks.getDb.mockImplementation(() => {
      throw new Error("database must not be queried for an unverified session");
    });
    mocks.getResolvedUser.mockResolvedValue(unverifiedUser);
    mocks.createGoOrgSwitchAssertion.mockReturnValue("signed-assertion");
  });

  it("does not disclose memberships or active organization to an unverified session", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ activeOrgId: null, orgs: [] });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("does not confirm membership or set the active-org cookie for an unverified session", async () => {
    const response = await POST(new Request("http://localhost/api/org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId: "62d994c0-a6d8-4ac2-9ec6-6689ba2bfc12" }),
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "email verification required" });
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });

  it("continues to reject requests without a session", async () => {
    mocks.getResolvedUser.mockResolvedValue(null);

    const getResponse = await GET();
    const postResponse = await POST(new Request("http://localhost/api/org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId: "62d994c0-a6d8-4ac2-9ec6-6689ba2bfc12" }),
    }));

    expect(getResponse.status).toBe(401);
    expect(postResponse.status).toBe(401);
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });

  it("lists verified memberships with their base currencies", async () => {
    const orgs = [
      { id: verifiedUser.orgId, name: "First workspace", baseCurrency: "UGX" },
      { id: verifiedUser.allOrgIds[1]!, name: "Second workspace", baseCurrency: "KES" },
    ];
    const query = configureOrganizationList(orgs);
    mocks.getResolvedUser.mockResolvedValue(verifiedUser);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ activeOrgId: verifiedUser.orgId, orgs });
    expect(query.where).toHaveBeenCalledOnce();
  });

  it("sets the HttpOnly active-org cookie after confirming membership", async () => {
    const orgId = "21e89f2b-996f-4b18-9078-c0f2f743a5ab";
    configureMembershipLookup([{ orgId, userId: verifiedUser.userId }]);
    mocks.getResolvedUser.mockResolvedValue(verifiedUser);

    const response = await POST(new Request("http://localhost/api/org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.setCookie).toHaveBeenCalledWith("chaste_active_org", orgId, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 90,
    });
  });

  it("denies a verified user who is not a member of the requested organization", async () => {
    configureMembershipLookup([]);
    mocks.getResolvedUser.mockResolvedValue(verifiedUser);

    const response = await POST(new Request("http://localhost/api/org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId: "21e89f2b-996f-4b18-9078-c0f2f743a5ab" }),
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "not a member of that organization" });
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });

  it("rejects an invalid organization id before querying memberships", async () => {
    mocks.getResolvedUser.mockResolvedValue(verifiedUser);

    const response = await POST(new Request("http://localhost/api/org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId: "not-a-uuid" }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid body" });
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });

  it("keeps the legacy membership query and cookie behavior unless Go is explicitly enabled", async () => {
    const orgId = verifiedUser.allOrgIds[1]!;
    const query = configureMembershipLookup([{ orgId, userId: verifiedUser.userId }]);
    mocks.getResolvedUser.mockResolvedValue(verifiedUser);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(new Request("http://localhost/api/org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(query.select).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.setCookie).toHaveBeenCalledWith("chaste_active_org", orgId, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 90,
    });
  });

  it("uses the Go membership boundary and forwards only the validated active-org cookie", async () => {
    const orgId = verifiedUser.allOrgIds[1]!;
    mocks.getResolvedUser.mockResolvedValue(verifiedUser);
    process.env.GO_ORG_SWITCH = "1";
    process.env.GO_INTERNAL_AUTH_SECRET = "0123456789abcdef0123456789abcdef";
    process.env.GO_API_INTERNAL_URL = "http://127.0.0.1:8080";
    mocks.createGoOrgSwitchAssertion.mockReturnValue("signed-target-org-assertion");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Set-Cookie": `chaste_active_org=${orgId}; Path=/; Max-Age=7776000; HttpOnly; SameSite=Lax` },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(new Request("http://localhost/api/org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBe(`chaste_active_org=${orgId}; Path=/; Max-Age=7776000; HttpOnly; SameSite=Lax`);
    expect(mocks.createGoOrgSwitchAssertion).toHaveBeenCalledWith(
      { userId: verifiedUser.userId, orgId },
      process.env.GO_INTERNAL_AUTH_SECRET,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/__go/org/switch");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "X-Chaste-Session-Assertion": "signed-target-org-assertion",
    });
    expect(init.body).toBe(JSON.stringify({ orgId }));
    expect(init.cache).toBe("no-store");
    expect(init.redirect).toBe("error");
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });

  it("preserves a Go membership denial without forwarding a cookie", async () => {
    const orgId = verifiedUser.allOrgIds[1]!;
    mocks.getResolvedUser.mockResolvedValue(verifiedUser);
    process.env.GO_ORG_SWITCH = "1";
    process.env.GO_INTERNAL_AUTH_SECRET = "0123456789abcdef0123456789abcdef";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(
      { error: "not a member of that organization" },
      { status: 403 },
    )));

    const response = await POST(new Request("http://localhost/api/org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId }),
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "not a member of that organization" });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });

  it.each([
    ["a Go service failure", () => Response.json({ error: "internal error" }, { status: 500 })],
    ["a malformed success body", () => new Response("{}", {
      status: 200,
      headers: { "Set-Cookie": "chaste_active_org=target; Path=/; Max-Age=7776000; HttpOnly; SameSite=Lax" },
    })],
    ["a missing active-org cookie", () => Response.json({ ok: true })],
  ])("fails closed for %s without setting a browser cookie", async (_case, responseFactory) => {
    const orgId = verifiedUser.allOrgIds[1]!;
    mocks.getResolvedUser.mockResolvedValue(verifiedUser);
    process.env.GO_ORG_SWITCH = "1";
    process.env.GO_INTERNAL_AUTH_SECRET = "0123456789abcdef0123456789abcdef";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseFactory()));

    const response = await POST(new Request("http://localhost/api/org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId }),
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "organization service unavailable" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mocks.setCookie).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("rejects an unsafe Go API URL before sending the signed assertion", async () => {
    const orgId = verifiedUser.allOrgIds[1]!;
    mocks.getResolvedUser.mockResolvedValue(verifiedUser);
    process.env.GO_ORG_SWITCH = "1";
    process.env.GO_INTERNAL_AUTH_SECRET = "0123456789abcdef0123456789abcdef";
    process.env.GO_API_INTERNAL_URL = "http://untrusted.example";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(new Request("http://localhost/api/org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId }),
    }));

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });
});
