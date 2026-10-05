import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  deactivateMember: vi.fn(),
  scimTokens: { id: "token.id", tokenHash: "token.hash", active: "token.active" },
  users: { id: "user.id" },
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) },
}));
vi.mock("drizzle-orm", () => ({ and: vi.fn(), eq: vi.fn() }));
vi.mock("@chaste/db", () => ({ getDb: mocks.getDb, memberships: {}, scimTokens: mocks.scimTokens, users: mocks.users }));
vi.mock("@/server/identity-lifecycle", () => ({ deactivateMember: mocks.deactivateMember }));
vi.mock("@/server/rate-limit", () => ({ scimAuthLimit: () => ({ allowed: true }), requestIp: () => "127.0.0.1" }));

import { DELETE } from "./route";

const token = { id: "token-id", orgId: "org-id", expiresAt: null };
const user = { id: "00000000-0000-4000-8000-000000000001", email: "user@example.test" };

function setupDB(foundUser: boolean) {
  let source: unknown;
  const builder: Record<string, (...args: unknown[]) => unknown> = {};
  builder.from = vi.fn((table: unknown) => { source = table; return builder; });
  builder.where = vi.fn(() => builder);
  builder.limit = vi.fn(async () => source === mocks.scimTokens ? [token] : (foundUser ? [user] : []));
  mocks.getDb.mockReturnValue({
    db: {
      select: vi.fn(() => ({ ...builder })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
    },
  });
}

function request(id: string) {
  return DELETE(new Request(`http://localhost/api/scim/v2/Users/${id}`, { headers: { authorization: "Bearer fixture" } }) as never, {
    params: Promise.resolve({ id }),
  });
}

describe("DELETE /api/scim/v2/Users/[id] 404 parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDB(false);
    mocks.deactivateMember.mockResolvedValue({ ok: false, reason: "not_found" });
  });

  it("returns the SCIM error envelope for malformed identifiers", async () => {
    const response = await request("not-a-uuid");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "404",
      detail: "user not found",
    });
    expect(mocks.deactivateMember).not.toHaveBeenCalled();
  });

  it("returns the same SCIM error for missing and foreign memberships", async () => {
    const missing = await request(user.id);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "404" });

    setupDB(true);
    mocks.deactivateMember.mockResolvedValueOnce({ ok: false, reason: "not_found" });
    const foreign = await request(user.id);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "404",
      detail: "user not found",
    });
  });
});
