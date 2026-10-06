import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResolvedUser: vi.fn(),
  proxyGoOnboardingCreate: vi.fn(),
  completeOnboarding: vi.fn(),
  parseOnboardingState: vi.fn(),
  setOnboardingStep: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));
vi.mock("@chaste/db", () => ({ getDb: mocks.getDb, organizations: { settings: {} } }));
vi.mock("@/server/onboarding", () => ({
  ONBOARDING_STEPS: ["business_profile"],
  completeOnboarding: mocks.completeOnboarding,
  parseOnboardingState: mocks.parseOnboardingState,
  setOnboardingStep: mocks.setOnboardingStep,
}));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/onboarding-go-proxy", () => ({ proxyGoOnboardingCreate: mocks.proxyGoOnboardingCreate }));

import { GET, PATCH, POST } from "./route";

describe("/api/onboarding single-writer routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getResolvedUser.mockResolvedValue(null);
    mocks.proxyGoOnboardingCreate.mockResolvedValue(Response.json({ orgId: "d4d0f18b-d20c-421e-a7fc-78281a97cab4", replayed: false }));
  });

  it("sends POST to the Go session proxy without resolving a user or invoking the TypeScript writer", async () => {
    const request = new Request("http://business.example.test/api/onboarding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orgName: "Northwind Books",
        businessDescription: "A wholesale business importing and selling household goods.",
        intentId: "onboarding-intent-1",
        userId: "untrusted-body-actor",
      }),
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mocks.proxyGoOnboardingCreate).toHaveBeenCalledWith(request);
    expect(mocks.getResolvedUser).not.toHaveBeenCalled();
  });

  it("retains the legacy GET and PATCH handlers during the transition", async () => {
    const get = await GET();
    const patch = await PATCH(new Request("http://business.example.test/api/onboarding", { method: "PATCH", body: "{}" }));

    expect(get.status).toBe(401);
    expect(patch.status).toBe(401);
    expect(mocks.getResolvedUser).toHaveBeenCalledTimes(2);
    expect(mocks.proxyGoOnboardingCreate).not.toHaveBeenCalled();
  });
});
