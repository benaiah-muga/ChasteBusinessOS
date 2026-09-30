import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResolvedUser: vi.fn(),
  actorFromResolved: vi.fn(),
  getDb: vi.fn(),
  executeGoCapability: vi.fn(),
  hasPermission: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("drizzle-orm", () => ({ and: vi.fn(), eq: vi.fn(), sql: vi.fn(() => "sql") }));
vi.mock("@chaste/db", () => ({
  customers: {},
  getDb: mocks.getDb,
  supportCannedResponses: {},
  supportConversations: {},
  supportKbArticles: {},
  supportMessages: {},
}));
vi.mock("@chaste/kernel", () => ({ hasPermission: mocks.hasPermission }));
vi.mock("@/server/kernel", () => ({
  actorFromResolved: mocks.actorFromResolved,
  buildExecutor: vi.fn(),
  buildRegistry: vi.fn(),
  createNotificationSink: vi.fn(),
}));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/server/support-agent", () => ({ SupportDraftError: class SupportDraftError {}, draftSupportReply: vi.fn() }));
vi.mock("@/server/go-bridge", () => ({ executeGoCapability: mocks.executeGoCapability }));

import { GET } from "./route";

const user = {
  userId: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  permissions: new Set(["support.read"]),
  enabledModules: ["support"],
};
const ctx = { actor: { type: "human", id: user.userId, orgId: user.orgId }, intentId: "support-read" };

function request(path = "/api/support") {
  return new Request(`http://localhost${path}`);
}

function selectQuery(rows: unknown[]) {
  const query = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
  };
  query.from.mockReturnValue(query);
  query.innerJoin.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  return query;
}

describe("support conversation list Go bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_SUPPORT_CONVERSATION_READS", "0");
    mocks.getResolvedUser.mockResolvedValue(user);
    mocks.actorFromResolved.mockReturnValue(ctx);
    mocks.hasPermission.mockReturnValue(true);
    mocks.getDb.mockReturnValue({ db: { execute: vi.fn().mockResolvedValue([]), select: vi.fn(() => selectQuery([])) } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("keeps the legacy inbox read as the default", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
    expect(mocks.getDb).toHaveBeenCalledOnce();
  });

  it("dispatches the customer-bound inbox list to Go and preserves its response contract", async () => {
    vi.stubEnv("GO_SUPPORT_CONVERSATION_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({
        ok: true,
        data: {
          conversations: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              customerId: "44444444-4444-4444-8444-444444444444",
              customerName: "Ada Customer",
              subject: "Order question",
              status: "open",
              lastMessageAt: "2026-09-30T08:15:00.000Z",
              lastMessagePreview: "Could you check the delivery?",
            },
            {
              id: "55555555-5555-4555-8555-555555555555",
              customerId: "",
              customerName: "Website visitor",
              subject: "Visitor thread",
              status: "open",
              lastMessageAt: "2026-09-30T08:10:00.000Z",
              lastMessagePreview: "Hello",
            },
          ],
        },
      }),
    });

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ conversations: [{
      id: "33333333-3333-4333-8333-333333333333",
      customerId: "44444444-4444-4444-8444-444444444444",
      customerName: "Ada Customer",
      subject: "Order question",
      status: "open",
      lastMessageAt: "2026-09-30T08:15:00.000Z",
      lastMessagePreview: "Could you check the delivery?",
    }] });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: ctx,
      session: user,
      capabilityId: "support.listConversations",
      input: { limit: 100, customerBoundOnly: true },
    });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("fails closed on malformed Go output without retrying the legacy query", async () => {
    vi.stubEnv("GO_SUPPORT_CONVERSATION_READS", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { conversations: [{ id: "bad" }] } }) });

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("leaves detail and library reads on their existing route paths", async () => {
    vi.stubEnv("GO_SUPPORT_CONVERSATION_READS", "1");

    const detail = await GET(request("/api/support?id=33333333-3333-4333-8333-333333333333"));
    const library = await GET(request("/api/support?library=1"));
    const nonemptyLibraryValue = await GET(request("/api/support?library=true"));
    vi.stubEnv("GO_SUPPORT_CONVERSATION_READS", "0");
    const emptyLibraryValue = await GET(request("/api/support?library="));

    expect(detail.status).toBe(404);
    expect(library.status).toBe(200);
    expect(await library.json()).toEqual({ canned: [], articles: [] });
    expect(nonemptyLibraryValue.status).toBe(200);
    expect(await nonemptyLibraryValue.json()).toEqual({ canned: [], articles: [] });
    expect(emptyLibraryValue.status).toBe(200);
    expect(await emptyLibraryValue.json()).toEqual({ conversations: [] });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });
});
