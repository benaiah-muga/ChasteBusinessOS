import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResolvedUser: vi.fn(),
  getDb: vi.fn(),
  runtimeAiConfig: vi.fn(),
  resolveClient: vi.fn(),
  stripProviderPrefix: vi.fn(),
  generateWithCodingPlanText: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("@chaste/ai", () => ({ resolveClient: mocks.resolveClient, stripProviderPrefix: mocks.stripProviderPrefix }));
vi.mock("@chaste/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/server/ai-settings", () => ({ runtimeAiConfig: mocks.runtimeAiConfig }));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/coding-agent-adapter", () => ({ generateWithCodingPlanText: mocks.generateWithCodingPlanText }));

import { POST } from "./route";

const user = {
  orgId: "22222222-2222-4222-8222-222222222222",
  userId: "11111111-1111-4111-8111-111111111111",
};

function request(body: string) {
  return new Request("http://localhost/api/my-work/summarize", { method: "POST", body });
}

function boundaryCards(lastDetailUnits: number) {
  return Array.from({ length: 8 }, (_, index) => ({
    kind: "x",
    title: "x",
    detail: "x".repeat(index === 7 ? lastDetailUnits : 3988),
  }));
}

describe("POST /api/my-work/summarize request bounds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getResolvedUser.mockResolvedValue(user);
    mocks.getDb.mockReturnValue({ db: {} });
  });

  it("returns 413 for a request body over 1 MiB before loading workspace config", async () => {
    const response = await POST(request("x".repeat((1 << 20) + 1)));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request body too large" });
    expect(mocks.runtimeAiConfig).not.toHaveBeenCalled();
  });

  it("rejects a card field over 4,096 UTF-16 units before loading workspace config", async () => {
    const response = await POST(request(JSON.stringify({ cards: [{ kind: "signal", title: "Review", detail: "x".repeat(4097) }] })));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "card text is too long" });
    expect(mocks.runtimeAiConfig).not.toHaveBeenCalled();
  });

  it("rejects combined prompt text over 32,000 units before loading workspace config", async () => {
    const cards = Array.from({ length: 9 }, () => ({ kind: "signal", title: "Review", detail: "x".repeat(4000) }));
    const response = await POST(request(JSON.stringify({ cards })));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "card text is too long" });
    expect(mocks.runtimeAiConfig).not.toHaveBeenCalled();
  });

  it("counts the exact prompt framing at the 32,000-unit boundary", async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: "A bounded summary." } }] });
    mocks.runtimeAiConfig.mockResolvedValue({ runtime: { apiKey: "server-key" }, models: { fast: "fast", primary: "primary" } });
    mocks.resolveClient.mockReturnValue({ chat: { completions: { create } } });
    mocks.stripProviderPrefix.mockImplementation((model: string) => model);
    const cards = boundaryCards(3991);
    const response = await POST(request(JSON.stringify({ cards })));

    expect(response.status).toBe(200);
    const messages = create.mock.calls[0]?.[0].messages as Array<{ content: string }>;
    expect(messages[1]?.content).toHaveLength(32_000);
    expect(messages[1]?.content).toBe(`Pending work:\n${cards.map((card) => `- [${card.kind}] ${card.title}: ${card.detail}`).join("\n")}`);

    vi.clearAllMocks();
    mocks.getResolvedUser.mockResolvedValue(user);
    const overLimit = await POST(request(JSON.stringify({ cards: boundaryCards(3992) })));
    expect(overLimit.status).toBe(400);
    expect(await overLimit.json()).toEqual({ error: "card text is too long" });
    expect(mocks.runtimeAiConfig).not.toHaveBeenCalled();
  });

  it("rejects malformed UTF-8 before loading workspace config", async () => {
    const prefix = new TextEncoder().encode('{"cards":[{"kind":"signal","title":"Review","detail":"');
    const suffix = new TextEncoder().encode('"}]}');
    const body = new Uint8Array(prefix.length + 1 + suffix.length);
    body.set(prefix);
    body[prefix.length] = 0xff;
    body.set(suffix, prefix.length + 1);
    const response = await POST(new Request("http://localhost/api/my-work/summarize", { method: "POST", body }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "cards are required" });
    expect(mocks.runtimeAiConfig).not.toHaveBeenCalled();
  });
});
