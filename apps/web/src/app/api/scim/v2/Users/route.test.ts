import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  rows: [] as { id: string; email: string; name: string | null }[],
  scimTokens: { id: "token.id", tokenHash: "token.hash", active: "token.active" },
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("drizzle-orm", () => ({ and: vi.fn(), eq: vi.fn() }));
vi.mock("@chaste/db", () => ({
  getDb: mocks.getDb,
  invitations: { id: "invitation.id" },
  memberships: { orgId: "membership.orgId", userId: "membership.userId" },
  scimTokens: mocks.scimTokens,
  users: { id: "user.id", email: "user.email", name: "user.name" },
}));
vi.mock("@/server/rate-limit", () => ({ scimAuthLimit: () => ({ allowed: true }), requestIp: () => "127.0.0.1" }));

import { GET } from "./route";

const token = { id: "token-id", orgId: "org-id", expiresAt: null };

function setupDB() {
  const builder: Record<string, (...args: unknown[]) => unknown> = {};
  let source: unknown;
  builder.from = vi.fn((table: unknown) => { source = table; return builder; });
  builder.innerJoin = vi.fn(() => builder);
  builder.where = vi.fn(() => builder);
  builder.limit = vi.fn(async () => source === mocks.scimTokens ? [token] : []);
  builder.then = (...args: unknown[]) => (args[0] as (value: unknown) => unknown)(mocks.rows);
  mocks.getDb.mockReturnValue({
    db: {
      select: vi.fn(() => ({ ...builder })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
    },
  });
}

function request(query = "") {
  return GET(new Request(`http://localhost/api/scim/v2/Users${query}`, { headers: { authorization: "Bearer fixture" } }));
}

describe("GET /api/scim/v2/Users pagination parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rows = Array.from({ length: 205 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      email: `person-${String(index + 1).padStart(3, "0")}@example.test`,
      name: null,
    }));
    setupDB();
  });

  it("returns a bounded default page with explicit metadata for large organizations", async () => {
    const response = await request();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ totalResults: 205, startIndex: 1, itemsPerPage: 100 });
    expect(body.Resources).toHaveLength(100);
  });

  it("caps count and keeps page boundaries stable", async () => {
    const first = await (await request("?startIndex=1&count=201")).json();
    const second = await (await request("?startIndex=201&count=201")).json();
    expect(first).toMatchObject({ totalResults: 205, startIndex: 1, itemsPerPage: 200 });
    expect(first.Resources).toHaveLength(200);
    expect(second).toMatchObject({ totalResults: 205, startIndex: 201, itemsPerPage: 5 });
    expect(second.Resources).toHaveLength(5);
    expect(first.Resources.at(-1).id).not.toBe(second.Resources[0].id);
  });

  it.each(["?startIndex=0", "?count=-1", "?count=wat"])('rejects invalid pagination query %s with the shared SCIM error', async (query) => {
    const response = await request(query);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "400",
      detail: "startIndex and count must be non-negative integers; startIndex must be at least 1",
    });
  });

  it("rejects filters outside the supported userName equality contract", async () => {
    const response = await request("?filter=displayName%20eq%20%22Person%22");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ status: "400", detail: "unsupported SCIM filter" });
  });

  it("preserves whitespace inside a quoted userName filter operand", async () => {
    const response = await request("?filter=userName%20eq%20%22%20person-001%40example.test%20%22");
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ totalResults: 0, startIndex: 1, itemsPerPage: 0 });
    expect(body.Resources).toEqual([]);
  });
});
