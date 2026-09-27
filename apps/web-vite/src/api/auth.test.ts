import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CapturedRequest = { path: string; method: string; body: unknown };

function pathnameOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return new URL(input, window.location.origin).pathname;
  if (input instanceof URL) return input.pathname;
  return new URL(input.url).pathname;
}

describe("Better Auth browser client", () => {
  let requests: CapturedRequest[];

  beforeEach(async () => {
    vi.resetModules();
    requests = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
      requests.push({
        path: pathnameOf(input),
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        body,
      });
      if (pathnameOf(input).endsWith("/sign-up/email")) {
        return Response.json({ token: null, user: { id: "user-id" } });
      }
      if (pathnameOf(input).endsWith("/sign-in/email")) {
        return Response.json({ token: "session-token", user: { id: "user-id" } });
      }
      return Response.json({ user: null, session: null });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses Better Auth's session endpoint", async () => {
    const { authClient } = await import("./auth");
    const result = await authClient.getSession();

    expect(result.data?.user).toBeNull();
    expect(requests).toEqual([{ path: "/api/auth/get-session", method: "GET", body: null }]);
  });

  it("uses Better Auth email sign-in with the submitted credentials", async () => {
    const { authClient } = await import("./auth");
    const result = await authClient.signIn.email({ email: "ada@example.test", password: "long-password" });

    expect(result.data?.token).toBe("session-token");
    expect(requests).toEqual([{
      path: "/api/auth/sign-in/email",
      method: "POST",
      body: { email: "ada@example.test", password: "long-password" },
    }]);
  });

  it("uses Better Auth email sign-up and preserves its pending-verification response", async () => {
    const { authClient } = await import("./auth");
    const result = await authClient.signUp.email({
      email: "ada@example.test",
      password: "long-password",
      name: "Ada Lovelace",
    });

    expect(result.data?.token).toBeNull();
    expect(requests).toEqual([{
      path: "/api/auth/sign-up/email",
      method: "POST",
      body: { email: "ada@example.test", password: "long-password", name: "Ada Lovelace" },
    }]);
  });
});
