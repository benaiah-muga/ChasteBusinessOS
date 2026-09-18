import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * My Work honest-coverage proof: when signals.list returns a failure instead
 * of throwing, the home page still shows the signals-unavailable card rather
 * than a silent empty list that reads as "zero problems". The executor is
 * stubbed at the kernel seam; the route's own queries run against the
 * fixture database like the pilot-ui suite.
 */

const state = vi.hoisted(() => ({
  current: null as {
    userId: string;
    email: string;
    name: string | null;
    orgId: string | null;
    permissions: Set<string>;
  } | null,
}));

vi.mock("@/server/session", () => ({
  getResolvedUser: async () => state.current,
}));

vi.mock("@/server/kernel", () => ({
  buildRegistry: () => ({ get: () => undefined }),
  buildExecutor: () => ({
    execute: async () => ({ ok: false as const, error: "signals producer refused" }),
  }),
  hasPermissionFor: () => true,
}));

const { GET: myWorkGET } = await import("@/app/api/my-work/route");

beforeAll(() => {
  state.current = {
    userId: crypto.randomUUID(),
    email: "coverage@probe.test",
    name: "Coverage Clerk",
    orgId: crypto.randomUUID(),
    permissions: new Set(["signals.read"]),
  };
});

describe("my work signal coverage", () => {
  it("shows signals-unavailable when signals.list fails without throwing", async () => {
    const res = await myWorkGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cards: Array<{ kind: string; id: string; title: string }> };
    const unavailable = body.cards.find((c) => c.id === "signals-unavailable");
    expect(unavailable).toBeTruthy();
    expect(unavailable!.title).toContain("unavailable");
  });
});
