import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("drizzle-orm", () => ({ and: vi.fn(), asc: vi.fn(), eq: vi.fn(), gt: vi.fn() }));
vi.mock("@chaste/db", () => ({
  getDb: mocks.getDb,
  memberships: {},
  supportConversations: {
    id: "conversationId",
    orgId: "orgId",
    status: "status",
    visitorSecretHash: "visitorSecretHash",
  },
  supportMessages: {
    id: "messageId",
    conversationId: "conversationId",
    senderType: "senderType",
    body: "body",
    createdAt: "createdAt",
  },
  supportSettings: { orgId: "orgId", autoReplyEnabled: "autoReplyEnabled", embedToken: "embedToken" },
}));
vi.mock("@/server/kernel", () => ({ buildRegistry: vi.fn() }));
vi.mock("@/server/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/server/support-agent", () => ({
  SupportDraftError: class SupportDraftError {},
  draftSupportReply: vi.fn(),
}));

import { POST } from "./route";

const token = "0123456789abcdef0123456789abcdef";
const conversationId = "3f1b0c6e-2f6a-4a0a-9c9e-6c1a2b3d4e5f";
const secret = "a".repeat(48);
const orgId = "11111111-1111-4111-8111-111111111111";
const messageId = "d6a3b0c1-2f6a-4a0a-9c9e-6c1a2b3d4e5f";

function selectQuery(rows: unknown[]) {
  const query = {
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(async () => rows),
    orderBy: vi.fn(),
  };
  query.from.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  return query;
}

function request(body: unknown) {
  return new Request("http://localhost/api/support/public", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.8, 10.0.0.1" },
    body: JSON.stringify(body),
  });
}

describe("public widget polling POST", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const rows = [
      [{ orgId, autoReply: false }],
      [{ status: "open", visitorSecretHash: createHash("sha256").update(secret).digest("hex") }],
      [{ id: messageId, senderType: "agent", body: "Welcome", createdAt: new Date("2026-09-20T09:30:00.000Z") }],
    ];
    const db = { select: vi.fn(() => selectQuery(rows.shift() ?? [])) };
    mocks.getDb.mockReturnValue({ db });
    mocks.checkRateLimit.mockReturnValue({ allowed: true });
  });

  afterEach(() => vi.restoreAllMocks());

  it("reads a token scoped thread from POST body credentials and keeps the poll limit", async () => {
    const response = await POST(request({ action: "poll", token, conversationId, secret }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "open",
      messages: [{ id: messageId, senderType: "agent", body: "Welcome", createdAt: "2026-09-20T09:30:00.000Z" }],
    });
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(`widget-poll:198.51.100.8:${orgId}`, {
      max: 120,
      windowMs: 60_000,
    });
  });

  it("rejects invalid poll credentials before querying the database", async () => {
    const response = await POST(request({ action: "poll", token, conversationId, secret: "short" }));

    expect(response.status).toBe(400);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
});
